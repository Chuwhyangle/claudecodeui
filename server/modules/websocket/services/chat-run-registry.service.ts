import { randomUUID } from 'node:crypto';

import { installChatRunRegistryPort } from '@/shared/ports/chat-run-registry.port.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  sessionDigestProducer,
  type SessionTurnEndEvent,
} from '@/modules/observation/index.js';
import { listProcessingSessions, readSessionProcessing } from '@/modules/providers/index.js';
import { BOOT_ID } from '@/modules/websocket/services/activity-heartbeat.service.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  ChatRunLookupMiss,
  ChatRunSource,
  ChatRunSummary,
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';
// THE S2 SWITCH, shared with the resident driver (`claude-host-driver.provider.ts`).
//
// `RESIDENT_RUN_IS_TURN` turns on SPEC §6: a resident session's run IS its turn —
// minted when the CLI announces one (`system/init`, through the host layer's
// `openTurn`) instead of once per `chat.send`, with folded and queue-drained
// deliveries sharing the one run, and with `supersedeRunning` retired on the
// websocket dispatch path. It ships **off**: with it off every reading here and
// in `chat-websocket.service.ts` is the behaviour those files had before it
// existed, so the existing criteria (AC-235, AC-231, …) keep passing on their
// own terms and the rollback is "turn it off".
//
// The predicate itself is the shared evaluation leaf in `@/shared/utils.js` — the
// one place the flag is spelled, read at call time so a criterion can state the
// variable in its own body after this module has been evaluated. It used to be a
// local export here with a second copy in the driver; the leaf replaces both,
// because the driver cannot import this module (the edge would close the cycle
// the driver's header states).
import { residentRunIsTurn } from '@/shared/utils.js';

// The run-addressing vocabulary's constituents live in `@/shared/types.js` (the
// tool packages' leaf) and are re-exported here so the websocket barrel keeps
// its public surface. The union itself is declared HERE, at the point the
// registry's `getRunById` returns it: AC-253's criterion reads the union off
// this module (`mcp-gateway-wiring.test.ts`, reading (b)) to prove consuming the
// union consumes its constituents, and a bare re-export would make it invisible
// to that reading.
export type { ChatRunSummary, ChatRunLookupMiss };
export type ChatRunLookupResult = ChatRunSummary | ChatRunLookupMiss;


/**
 * Lifecycle of one tracked run.
 *
 * `aborted` is a terminal state of its own, not a synonym for `completed`: a
 * cancelled turn's terminal event carries `aborted: true`, and the registry
 * reports that fact back as `aborted` so a caller addressing the run by id can
 * tell "the user cancelled it" from "it ran to its own end".
 */
type ChatRunStatus = 'running' | 'completed' | 'aborted';

/**
 * What opened a run: a delivery somebody sent, or a turn the CLI began on its
 * own (SPEC §4.1).
 *
 * `unattended` is not "no source" — it is the positive fact that nothing on this
 * side pushed the turn's opener, which is why no delivery is ever bound to it
 * (`deliveryIds` is empty). The distinction is what an unattended turn's report
 * is built on, and it is stated here rather than re-derived from a connection's
 * absence, which the `scheduled` source shares.
 */
type ChatRunKind = 'delivered' | 'unattended';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing). It is
 *   also what a run read back by id reports — `running` until the terminal
 *   `complete`, then `completed` or, when that event was an abort, `aborted`.
 * - `runId`: opaque identity for this run, minted once in `startRun`. `seq` is
 *   numbered per run, so it is the `runId` that tells a reconnecting client
 *   whether its cursor still belongs to the run now in flight: the same id
 *   means `seq > lastSeq`, a different one means the cursor predates this run
 *   and replay must start at its first event.
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 * - `source`: who asked for the run. Fixed at `startRun` and never rewritten,
 *   because it describes an origin that existed before the run did; it is what
 *   lets a run opened by the host layer (`unattended`) be told apart from one
 *   a timer fired (`scheduled`) even though neither has a socket attached.
 * - `bootId`: the identity of the process the run was created under, read once
 *   in `startRun` from the registry's injected boot reader (the activity
 *   protocol's `BOOT_ID` by default). A run record can outlive the process that
 *   made it only in the sense that a *later* boot can no longer tell whether an
 *   id it is handed belongs to it — this field is how the MCP gateway's
 *   `run_get` (AC-248) reports "服务已重启" instead of inventing a run.
 */
type ChatRun = {
  appSessionId: string;
  runId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  source: ChatRunSource;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
  bootId: string;
  /**
   * What this run IS (SPEC §6.1): the turn a delivered send opened, or a turn
   * the CLI began by itself.
   *
   * Meaningful from `openTurn` on, and read by the criteria that judge run=turn
   * semantics; `openUnattendedRun` states `unattended` because that is the whole
   * of what it adds over `startRun` (`source` already says so, and the two are
   * written together so they cannot drift). Not part of {@link ChatRunSummary}:
   * that projection is pinned to its exact field set by this module's own
   * criterion, and no by-id consumer asks what kind of turn a run was.
   */
  kind: ChatRunKind;
  /**
   * The deliveries whose work this run is executing, in the order they were
   * bound (SPEC §4.2, §6.1).
   *
   * On the run=turn path this is the turn's deliveries: the opener plus every
   * command folded into the turn (`next`) or drained into it (`later`) — all of
   * them share the ONE run, which is the whole point of run=turn. An unattended
   * turn is bound by nothing, so its list stays empty. Deliberately mutable and
   * appended by `openTurn`: a turn's delivery set is only complete once the CLI
   * has stated every `started`, which happens after the run exists.
   */
  deliveryIds: string[];
  /**
   * The opaque correlation label the caller that opened this run attached, or
   * `null` when it attached none (AC-337).
   *
   * Written by the caller after `startRun` returns, through
   * {@link setRunCorrelationId} — the registry itself never interprets the
   * value, and nothing in this module reads it except `listRunningRuns`, which
   * hands it back so the MCP gateway's `sessions_list` can narrow to the
   * sessions whose CURRENT run carries one. Deliberately not part of
   * {@link ChatRunSummary}: that projection is pinned to its exact field set,
   * and no by-id consumer reads a label.
   */
  correlationId: string | null;
  /**
   * The OPEN sockets currently watching this run, kept alongside the writer's
   * own set (which `ChatSessionWriter` holds privately).
   *
   * The registry hands each socket to the writer and records it here too, so a
   * caller that needs to READ back "how many sockets is this run's writer
   * actually holding" — the lifecycle-forward log below is the one such caller —
   * has a number to print without reaching into the writer. Entries are a
   * SUPERSET of the writer's live set: a socket that closed is still listed
   * until a reader counts, so every count goes through
   * {@link countOpenConnections} which skips anything not `OPEN`.
   */
  connections: Set<RealtimeClientConnection>;
  /**
   * The last `error` frame this run forwarded, or `null` when it forwarded none.
   *
   * The transcript records what a turn did, not whether the run failed, so the observation
   * layer's session digest reads the failure off THIS fact — the registry saw the error frame
   * go by. Kept off {@link ChatRunSummary} because no by-id consumer reads it.
   */
  lastError: string | null;
};

/**
 * One `command_lifecycle` frame the registry forwarded, as the log seam reads it.
 *
 * THE READING THE 2026-10-14 DEFECT NEEDED AND DID NOT HAVE. The host read the
 * CLI's dequeue (`status injected … queued=0`), so the break was provably
 * between the host's writer and the browser — but nothing recorded WHICH run's
 * writer a lifecycle frame was handed to, nor how many sockets that writer
 * held, so the next measurement could not be taken from the log. This is that
 * line: the frame's own identity (uuid, state), the run it was written through,
 * and the number of OPEN sockets that run's writer held at that instant.
 *
 * `connections` is the writer's own live audience, the number that answers
 * "did anyone receive it". It is deliberately NOT the session-level audience
 * (a superseding run inherits that separately): a run whose own writer holds
 * nobody is exactly the shape the defect took, and only this number names it.
 * A reader compares it against `runId` — the run the CLI's frame was routed to.
 *
 * `appSessionId` is the SESSION the run belongs to, and it is the field
 * SPEC §10.2 adds: the three fields above name a frame and a run but not the
 * conversation, so attributing a line to a session meant cross-referencing the
 * transcript by timestamp (附录 C). The run record already carries it; this line
 * is where a reader can see it.
 */
export type ChatRunLifecycleForwardLog = {
  /** The CLI's `command_uuid` the frame is about. */
  commandUuid: string;
  /** The lifecycle state the frame reports (`queued`/`started`/`completed`/…). */
  commandState: string;
  /** The run whose writer the frame was written through, as the registry minted it. */
  runId: string;
  /** The OPEN sockets that run's writer held when the frame was forwarded. */
  connections: number;
  /** The application session id the run was opened for — §10.2's `session=`. */
  appSessionId: string;
};

/**
 * How long a terminal run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 *
 * This is only the default: `createChatRunRegistry` accepts a `retentionMs`
 * override (today, the criterion uses it to move a fake clock past the window
 * without a real wait).
 *
 * Exported because it is no longer only this registry's number: the delivery
 * state channel keeps a terminal delivery for the same span (SPEC §7.1 —「终态条目
 * 保留与 run 相同的窗口」), and the projection that does so lives in the providers
 * module, which cannot import this one. The two are held equal by the criterion
 * that reads both, rather than by a shared binding the module edge forbids.
 */
export const DEFAULT_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * How many delivery-addressed `correlationId` labels the registry remembers.
 *
 * The delivery id space is minted, never reused, so this map has no natural
 * eviction — a bounded ring is what keeps a long-lived process from growing one
 * entry per send forever. The labels a live reader can still ask about belong to
 * deliveries inside the run retention window (a few per session), so a bound
 * well above that costs nothing and drops only the ancient.
 */
const DELIVERY_CORRELATION_LIMIT = 1000;

/**
 * Resolves the retention window from the explicit option or the environment.
 *
 * Precedence: a positive finite `explicit` wins; otherwise
 * `CHAT_RUN_RETENTION_MS` when it parses to a positive integer; otherwise the
 * 5-minute default. Anything else falls back rather than producing a zero or
 * `NaN` window that would evict every run instantly.
 */
function resolveRetentionMs(explicit: number | undefined): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const fromEnv = Number(process.env.CHAT_RUN_RETENTION_MS);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RUN_RETENTION_MS;
}

/**
 * Builds one run registry with its own maps, retention window and clock.
 *
 * Consumers: the module-level singleton `chatRunRegistry` (below) is the
 * process-wide instance `server/index.ts` and the websocket gateway use; this
 * module's criterion (`server/modules/websocket/tests/chat-run-by-id.test.ts`)
 * builds an isolated instance with an injected clock and retention so it can
 * advance time past the retention window without a real wait. That is why
 * every timestamp the registry records (`startedAt`, `completedAt`) and its
 * expiry decision go through `now()` rather than `Date.now()` directly —
 * otherwise a fake clock would not move the readings.
 */
export function createChatRunRegistry(options?: {
  retentionMs?: number;
  now?: () => number;
  /**
   * The process identity stamped onto every run this registry opens. Defaults to
   * the activity heartbeat's process `BOOT_ID`, which is the same value the
   * activity protocol's snapshots carry — so a run's boot and the boot a reader
   * compares it against come from one source. A criterion flips this reader's
   * return between two `run_get` calls to exercise the "服务已重启" reading
   * (AC-248) inside one process.
   */
  bootId?: () => string;
  /**
   * Whether a run started for a session inherits the sockets already watching
   * that session (default `true`).
   *
   * A run's writer is otherwise built from the single connection its caller
   * passed, and a caller that binds no socket — a `session_send` from the voice
   * surface or the MCP gateway, both `connection: null` — would open a run whose
   * audience is empty. That is invisible for a fresh send (the browser subscribes
   * after) but not for the resident-session supersede: the spoken sentence that
   * arrives mid-turn replaces the running run, and the frames that follow the
   * queued command run through the new writer. Without the carry those frames,
   * its `command_lifecycle` `completed` above all, are written to nobody, and the
   * voice bar's withdraw row can never resolve (2026-10-13).
   *
   * The invariant is that the audience belongs to the SESSION, not to one run's
   * incarnation of it: whoever is watching the session keeps watching whatever
   * run currently holds the session's slot. Set `false` only to reproduce the
   * pre-fix shape — this module's criterion uses it as its false form.
   */
  carryAudience?: boolean;
  /**
   * Where each forwarded `command_lifecycle` frame is logged, one line per
   * frame, as {@link ChatRunLifecycleForwardLog}. Defaults to nothing (the
   * registry is started by every `chat.send`, and a no-op keeps a normal run
   * from printing a line per queue event).
   *
   * Injected rather than called on `console` directly so the forwarding reading
   * is DRIVABLE: this module's criterion supplies its own collector and asserts
   * the four fields, which a hard-coded logger could not offer. Production wires
   * the process logger here — this module's singleton does, and an isolated
   * instance (the criterion) leaves it undefined unless it wants the line.
   */
  lifecycleLog?: (line: ChatRunLifecycleForwardLog) => void;
  /**
   * The process-wide observation hook fired once per run, when its terminal `complete` event is
   * recorded (SPEC's turn-end point). Defaults to the session-digest producer, which reads that
   * session's transcript and writes one observation revision; the producer swallows its own
   * failures, so an observation problem can never break a chat turn.
   *
   * Injected so a criterion can observe the event shape itself without touching the database.
   */
  onTurnEnd?: (event: SessionTurnEndEvent) => void;
}) {
  const retentionMs = resolveRetentionMs(options?.retentionMs);
  const now = options?.now ?? (() => Date.now());
  const bootId = options?.bootId ?? (() => BOOT_ID);
  const carryAudience = options?.carryAudience ?? true;
  const lifecycleLog = options?.lifecycleLog;
  const onTurnEnd =
    options?.onTurnEnd ??
    ((event: SessionTurnEndEvent) => {
      // Fire-and-forget: the producer answers a promise and never rejects (it catches its own
      // failures), and the chat path must not wait on a transcript read.
      void sessionDigestProducer.handleTurnEnd(event);
    });

  /**
   * Active and recently-completed runs keyed by app session id.
   *
   * This map is the single in-memory source of truth for "is something running
   * for this session" — the chat websocket handler, abort path, and subscribe
   * path all consult it instead of asking each provider runtime individually.
   */
  const runs = new Map<string, ChatRun>();

  /**
   * Every tracked run keyed by its own run id, alongside the session-keyed map
   * above rather than instead of it.
   *
   * The two answer different questions and diverge the moment a resident
   * session's busy send supersedes a running turn: `runs` follows the session and
   * holds whichever run is *current*, while this index keeps the run that was
   * superseded reachable by the id it was already handed out under. A run stays
   * here after it is superseded and after it reaches a terminal state, until the
   * retention timer evicts it.
   */
  const runsById = new Map<string, ChatRun>();

  /**
   * Every socket that has subscribed to a session, kept at the SESSION level
   * rather than on the run that happened to be current when it subscribed.
   *
   * A run's own writer holds its audience, but a run is replaced while the
   * session stays open (a resident session's busy send supersedes the turn in
   * flight), and the replacement is opened with `connection: null` because the
   * new turn was asked for over MCP, not over that socket. Keeping the audience
   * here lets `startRun` hand it to the new writer, so a person watching a
   * session keeps receiving its frames across the run change.
   *
   * Entries are dropped as they are found closed (`readyState`), so a refreshed
   * page's abandoned socket — which `ChatSessionWriter` would only notice on its
   * next send — cannot resurrect into a later run.
   */
  const sessionAudience = new Map<string, Set<RealtimeClientConnection>>();

  /**
   * The opaque `correlationId` labels addressed by DELIVERY id (SPEC §6.1, AC-337
   * moved to the delivery by S3).
   *
   * A label belongs to the delivery it was attached to, not to whatever run
   * happened to hold the session's slot: under run=turn the run IS the turn, but
   * the caller stamps the label the moment the send answers — which, for a
   * resident session, is BEFORE the turn exists (the send states the delivery id
   * and backfills `runId` with it). Addressing the label by the delivery id is
   * therefore the only write this layer can make at that instant, and
   * {@link listRunningRuns} resolves it back to a run through the run's OWNER
   * delivery ({@link ChatRun.deliveryIds}[0]).
   *
   * Insertion-ordered and bounded: a label is small, but the map is keyed by an
   * id space the process never reuses, so the oldest entries are dropped once
   * {@link DELIVERY_CORRELATION_LIMIT} is reached rather than allowed to grow for
   * the life of the process.
   */
  const deliveryCorrelationIds = new Map<string, string>();

  /**
   * The still-open sockets watching `appSessionId`, pruning any that closed
   * since they subscribed. Returned as an array so callers add to a fresh
   * writer's own set without mutating the registry's.
   */
  function liveSessionAudience(appSessionId: string): RealtimeClientConnection[] {
    const watching = sessionAudience.get(appSessionId);
    if (!watching) {
      return [];
    }

    const live: RealtimeClientConnection[] = [];
    for (const connection of watching) {
      if (connection.readyState === WS_OPEN_STATE) {
        live.push(connection);
      } else {
        watching.delete(connection);
      }
    }
    return live;
  }

  /**
   * How many sockets a run's writer currently holds OPEN — the number the
   * lifecycle-forward log prints as `connections`.
   *
   * Reads {@link ChatRun.connections}, which the registry maintains as a
   * superset of the writer's own (private) set and prunes here as it counts, the
   * same way {@link liveSessionAudience} prunes the session-level map: a socket
   * that closed since it was handed over must not keep counting.
   */
  function countOpenConnections(run: ChatRun): number {
    let open = 0;
    for (const connection of run.connections) {
      if (connection.readyState === WS_OPEN_STATE) {
        open += 1;
      } else {
        run.connections.delete(connection);
      }
    }
    return open;
  }

  function evictRunLater(appSessionId: string): void {
    const timer = setTimeout(() => {
      const run = runs.get(appSessionId);
      // A terminal run — completed or aborted — is what the retention window
      // is for. A run still `running` in its slot is never dropped: its own
      // writer has not sent its terminal event yet.
      if (run && run.status !== 'running') {
        runs.delete(appSessionId);
        runsById.delete(run.runId);
      }
    }, retentionMs);

    // Never keep the process alive just to evict a buffered run.
    timer.unref?.();
  }

  /**
   * The opaque label a run's OWNER delivery carries, or the run's own label.
   *
   * SPEC §6.1 moves `correlationId` onto the delivery, and a run=turn run's
   * owner delivery is the first command bound to the turn (`deliveryIds[0]`).
   * Reading it here is the compatibility backfill the running-sessions entry and
   * `sessions_list`'s narrowing are stated against: a caller that stamped its
   * label by delivery id (the only id it held when the send answered) is found
   * by exactly the same query it always was. The run-level field stays the
   * fallback — it is where every label stamped before the delivery-addressed
   * write existed lives, and where a run with no deliveries at all keeps what it
   * was given.
   */
  function ownerCorrelationId(run: ChatRun): string | null {
    const owner = run.deliveryIds[0];
    if (owner !== undefined) {
      const label = deliveryCorrelationIds.get(owner);
      if (label !== undefined) {
        return label;
      }
    }
    return run.correlationId;
  }

  /** Projects the internal record onto the read-only summary handed to callers. */
  function summarize(run: ChatRun): ChatRunSummary {
    return {
      runId: run.runId,
      sessionId: run.appSessionId,
      source: run.source,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      lastSeq: run.lastSeq,
    };
  }

  /**
   * Decorates one outbound live event for a run and records it in the event log.
   *
   * Responsibilities:
   * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
   *    app session id — provider-native ids never leave the backend.
   * 2. Assign the next `seq` so clients can detect/replay gaps, and stamp the
   *    run's `runId` so a client can tell which run that `seq` belongs to.
   * 3. Buffer the event for `chat.subscribe` replay.
   * 4. Flip the run to `completed` — or `aborted` when the terminal event says
   *    the run was cancelled — when that event passes by.
   */
  function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
    // Exactly-one-terminal contract: when a run is aborted the chat handler
    // emits the terminal `complete` immediately, but the killed runtime may
    // still emit its own `complete` from its exit handler moments later.
    // Whichever arrives first wins; every later terminal event is dropped once
    // the run is no longer `running` — whether it ended `completed` or
    // `aborted`. Narrowing this guard to `completed` would let a late
    // `complete` overwrite a run that already ended in `aborted`.
    if (message.kind === 'complete' && run.status !== 'running') {
      return null;
    }

    // The observation layer's session digest reads a failed turn off the error frame the registry
    // forwarded, because the transcript cannot tell a failed run from a quiet one. Recorded
    // before the terminal flip below, so the `complete` that follows carries it.
    if (message.kind === 'error') {
      const text = message.text ?? message.content ?? message.reason ?? '';
      run.lastError = typeof text === 'string' && text.trim() !== '' ? text.trim() : 'turn failed';
    }

    // THE TRANSITION WINDOW (SPEC §7.3). Under run=turn the CLI's own
    // `command_lifecycle` rows keep going out, but as SESSION-LEVEL frames: the
    // run such a row used to ride was the superseding run S2 retires, and a frame
    // that still carried a `seq` would move a reconnecting client's cursor for a
    // run the row is no longer about — a cursor is per run, and the frame has
    // stopped being the run's. So the frame loses its `runId` and its `seq`, and
    // the load-bearing half is that it is not recorded either: it never enters a
    // run's event log, so replay cannot replay it, and `lastSeq` does not move for
    // it. What a client learns from the row — which command, and where it is now —
    // travels on the activity snapshot instead, which is idempotent and needs no
    // replay at all (`id-relations` B-7).
    //
    // Off the flag this branch is unreachable, and everything below — the `seq`,
    // the `runId`, the buffer, the forwarding log — is exactly what it was before
    // the state channel existed.
    if (message.kind === 'command_lifecycle' && residentRunIsTurn()) {
      return { ...message, sessionId: run.appSessionId };
    }

    run.lastSeq += 1;

    const outbound: NormalizedMessage = {
      ...message,
      sessionId: run.appSessionId,
      seq: run.lastSeq,
      runId: run.runId,
    };

    if (message.kind === 'complete') {
      // The provider may report its own id here; the frontend only ever knows
      // the app id, so the "actual" id is by definition the app id as well.
      outbound.actualSessionId = run.appSessionId;
      // `aborted` is the provider's own fact (see `createCompleteMessage`), not
      // a flag invented here: a cancelled turn must read back as `aborted`
      // rather than be flattened into a run that completed.
      run.status = message.aborted === true ? 'aborted' : 'completed';
      run.completedAt = now();
      onTurnEnd({
        appSessionId: run.appSessionId,
        runId: run.runId,
        status: run.status,
        completedAt: run.completedAt,
        error: run.lastError,
      });
      evictRunLater(run.appSessionId);
    }

    run.events.push(outbound);
    if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
      run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
    }

    // One line per forwarded command_lifecycle, so the NEXT live test can answer
    // "which run got the frame, and how many sockets did that run's writer hold"
    // from the log alone — the reading the 2026-10-14 defect was missing when the
    // host had read the dequeue and the browser still showed the row (see
    // {@link ChatRunLifecycleForwardLog}). Read AFTER the event is buffered, so
    // `connections` is the audience as it stands for the frame now going out.
    if (outbound.kind === 'command_lifecycle' && lifecycleLog) {
      const commandUuid = typeof outbound.commandUuid === 'string' ? outbound.commandUuid : '';
      const commandState = typeof outbound.commandState === 'string' ? outbound.commandState : '';
      lifecycleLog({
        commandUuid,
        commandState,
        runId: run.runId,
        connections: countOpenConnections(run),
        appSessionId: run.appSessionId,
      });
    }

    return outbound;
  }

  /**
   * Records the provider-native session id for a run and persists the
   * app-id-to-provider-id mapping so history fetches and future resumes can
   * address the provider transcript.
   *
   * Called from the gateway writer when the runtime either calls
   * `setSessionId(...)` or emits its `session_created` event — whichever
   * happens first wins; later calls with the same id are no-ops.
   */
  function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
    if (!providerSessionId || run.providerSessionId === providerSessionId) {
      return;
    }

    run.providerSessionId = providerSessionId;

    try {
      sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
      void broadcastSessionUpserted(run.appSessionId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
          appSessionId: run.appSessionId,
          providerSessionId,
          error: message,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    }
  }

  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   *
   * `supersedeRunning` is the one exception, and it is not a weakening of that
   * contract: it is how a second turn that is genuinely accepted while the
   * first is still running gets a run of its own. A resident session has no
   * reason to refuse a busy send — the CLI queues it and runs it as its own
   * turn — but the run registry is keyed one run per session, so the newer turn
   * must replace the older one *as the session's current run* or its frames
   * would be attributed to a run that already ended its own conversation.
   *
   * The replaced run is not marked completed by the replacement, and that is
   * the load-bearing half: its own turn is still running, and its terminal
   * `complete` is written through its own writer when that turn ends
   * (`ClaudeResidentHostDriver` sends it through the round's writer, not through
   * whichever round was armed last). Marking it completed here would hand it to
   * `decorateAndRecordEvent`'s exactly-one-complete rule, so the ending of a
   * turn that was genuinely running would be dropped and every client watching
   * the session would be left waiting on a run that never reports itself over.
   * Status tracks the run's *own* turn; the map slot is what "the session's
   * current run" means, and the newer run simply takes it.
   *
   * Both the superseded run and the new one stay addressable through
   * `getRunById` — this only changes which one `getRun` calls the session's
   * current run.
   */
  function startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for one nobody is watching
     * — a scheduled message fires with no browser attached. The writer's event
     * buffer still records everything, so a client that subscribes later
     * replays the run from its start.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
    /**
     * Who asked for this run. Optional so every existing call site keeps its
     * current meaning without being touched: a run with a connection is a
     * `user` turn, and one without is a `scheduled` turn, which is exactly what
     * the two production paths (`chat.send` and `runDetachedChatTurn`) already
     * are. A caller that knows better — the host layer opening a turn nobody
     * asked for — states `unattended` explicitly.
     */
    source?: ChatRunSource;
    /**
     * Whether an already-running run is replaced by this one instead of
     * refusing this one. Only ever set by a caller that has established the
     * session's provider will really run this turn concurrently — see above.
     *
     * Retired on the run=turn path (SPEC §6.1): a resident busy send no longer
     * opens a superseding run, it becomes a delivery of the open turn. The
     * parameter stays, and stays honoured, for the callers that still state it —
     * a per-run shape that genuinely runs two turns at once, and the criterion
     * that pins the pre-S2 reading.
     */
    supersedeRunning?: boolean;
    /**
     * What this run is, when the caller knows it (SPEC §4.1). Defaulted from
     * `source` so every existing call site keeps its current meaning without
     * being touched: an `unattended` source is an unattended turn, everything
     * else is a delivered one.
     */
    kind?: ChatRunKind;
    /**
     * The delivery ids this run is executing, when the caller already knows one
     * (see {@link ChatRun.deliveryIds}). Absent means "none stated yet", which
     * is the honest reading for a run opened at dispatch: on the run=turn path
     * the deliveries are bound at the CLI's `init`, not at the send.
     */
    deliveryIds?: string[];
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running' && !input.supersedeRunning) {
      return null;
    }

    const source = input.source ?? (input.connection ? 'user' : 'scheduled');
    const run: ChatRun = {
      appSessionId: input.appSessionId,
      runId: randomUUID(),
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      source,
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: now(),
      completedAt: null,
      bootId: bootId(),
      kind: input.kind ?? (source === 'unattended' ? 'unattended' : 'delivered'),
      deliveryIds: input.deliveryIds ? [...input.deliveryIds] : [],
      // No label at creation: the only writers are the MCP write tools, and they
      // stamp it through {@link setRunCorrelationId} once the send that opened
      // the run has answered. A run opened any other way (a UI send, a scheduled
      // message, the host layer) therefore always reads `null`, which is the
      // honest reading of "nobody attached a label" rather than a value invented
      // here.
      correlationId: null,
      connections: new Set<RealtimeClientConnection>(),
      lastError: null,
    };

    // Track the sockets this run's writer holds, so the lifecycle-forward log can
    // read a count back without reaching into the writer (see {@link ChatRun.connections}).
    // A caller that bound a socket contributes it here; a carried audience is added
    // below once `liveSessionAudience` has pruned the closed.
    if (input.connection) {
      run.connections.add(input.connection);
    }

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    // Hand the new run whatever audience the session already has. A caller that
    // bound a socket (a browser send) contributed it to the writer directly, but
    // a caller that bound none — the voice/MCP `session_send` above all, and the
    // superseding run a mid-turn spoken sentence opens — must not start blind:
    // the frames of the queued command, its `command_lifecycle` rows included,
    // are routed through THIS writer, and a person watching the session has to
    // receive them or the queue's withdraw row never resolves.
    if (carryAudience) {
      for (const watching of liveSessionAudience(input.appSessionId)) {
        run.writer.updateWebSocket(watching);
        run.connections.add(watching);
      }
    }

    runs.set(input.appSessionId, run);
    // Both runs are registered by their own id: the superseded one must remain
    // reachable through the id it was already handed out under.
    runsById.set(run.runId, run);
    return run;
  }

  /**
   * Looks a run up by its own id, whoever currently holds its session's slot.
   *
   * `getRun(appSessionId)` answers "what is this session's current run"; this
   * answers "what is this specific run", as a read-only summary. They diverge
   * the moment a resident session's busy send supersedes a running turn — the
   * newer run takes the session slot while the older one is still running its
   * own turn — and a caller that was handed both ids (the original send and the
   * queued one) has no other way to reach the older run.
   *
   * A terminal run is reported only while it is inside the retention window,
   * judged lazily against the injected clock; past it the lookup answers
   * `{ status: 'unknown', reason: 'expired' }`, and an id that was never handed
   * out answers `{ status: 'unknown', reason: 'unknown' }`. Consumed by this
   * module's criteria `chat-run-by-id.test.ts` and `chat-control-busy.test.ts`
   * and, later, by the MCP gateway's run-addressing verbs.
   */
  function getRunById(runId: string): ChatRunLookupResult {
    const run = runsById.get(runId);
    if (!run) {
      return { status: 'unknown', reason: 'unknown' };
    }

    if (run.status !== 'running' && run.completedAt !== null && now() - run.completedAt > retentionMs) {
      return { status: 'unknown', reason: 'expired' };
    }

    return summarize(run);
  }

  /**
   * The registry's own surface, held in a binding so the run-opening verbs can
   * reach `startRun` THROUGH it rather than through the closure.
   *
   * That indirection is load-bearing for a reading, not a style choice: the run
   * registry is a singleton other code (and the S2 criterion) wraps to count
   * mints, and a mint that went around the wrapper would be invisible — the count
   * would then say "this path opened no run" while a run was opened. Every
   * run-opening verb on this object therefore calls `registry.startRun`, so the
   * object's own property is the ONE mint entry and a spy on it sees every run
   * this registry created, whichever verb asked for it.
   */
  const registry = {
    startRun,

    /**
     * Opens a run for a turn the *host* layer detected, with nobody watching.
     *
     * The one thing this adds over `startRun` is the pair of facts a host caller
     * cannot state: `connection: null` and `source: 'unattended'`. Both are true
     * by construction here rather than by the caller's word — an unattended turn
     * is one no socket asked for, so there is no connection to attach, and the
     * source is what tells it apart from the `scheduled` turns that share the
     * no-connection shape.
     *
     * Returns the run's writer, or `null` when a run is already in flight for the
     * session: the caller (a resident host driver) treats that as "carry on as
     * before" rather than as a failure, because a turn that arrives while the
     * session is busy is a real sequence, not an error. Only the writer is
     * handed back — a driver has no business reading `seq`, `events` or the run's
     * status, and the frames it sends through the writer are what maintain them.
     */
    openUnattendedRun(input: {
      appSessionId: string;
      provider: LLMProvider;
      providerSessionId: string | null;
      userId: string | number | null;
      /**
       * Accepted and unused: the run record is keyed by the app session id and
       * carries no display name. It is part of the shape because the host layer
       * holds it on the same reading that produced the rest, and splitting the
       * shape in two so this caller could drop one field would be the seam
       * inventing a distinction the call site does not have.
       */
      sessionName?: string | null;
    }): { writer: ChatSessionWriter } | null {
      const run = registry.startRun({
        appSessionId: input.appSessionId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        connection: null,
        userId: input.userId,
        source: 'unattended',
        kind: 'unattended',
      });
      return run ? { writer: run.writer } : null;
    },

    /**
     * THE S2 ENTRY (SPEC §6.1): opens or adopts the run of one resident TURN,
     * and reports the writer its frames belong on.
     *
     * Called by the resident host driver at the two moments the CLI states a
     * turn boundary — the `system/init` that opens one (with every delivery the
     * ledger has bound to it so far) and a `command_lifecycle started` that
     * folds one more command into a turn already open. The two are one verb
     * because they are one question — "which run does this turn's work belong
     * to, and who writes its frames" — and the answer is the same shape in both
     * cases: the run's id and its writer.
     *
     * `delivered`: adopt the session's running run when there is one, else mint
     * it here. Adopting is what makes the run's identity the TURN's rather than
     * the send's: the opener's run is already in flight when the CLI announces
     * the turn (`chat.send` mints it at dispatch so the send can answer with an
     * id, `chat-websocket.service.ts`), so `init` binds its deliveries to that
     * run instead of opening a second one. A turn that begins with no run in
     * flight — a merge the CLI drained into a turn of its own after the previous
     * one ended — is minted here, once, for the whole turn.
     *
     * `unattended`: the same as {@link openUnattendedRun}, which is what this
     * generalizes; it stays a separate entry because that one is still the port
     * the host layer's older callers and the driver's flag-off path use.
     *
     * Returns `null` only for an unattended turn that arrives while a run is
     * already in flight — the driver treats that as "carry on as before", the
     * same reading `openUnattendedRun` has always had.
     */
    openTurn(input: {
      appSessionId: string;
      provider: LLMProvider;
      providerSessionId: string | null;
      userId: string | number | null;
      kind: ChatRunKind;
      /** The deliveries this turn is executing; merged into the run when it already holds some. */
      deliveryIds?: string[];
      sessionName?: string | null;
    }): { runId: string; writer: ChatSessionWriter } | null {
      if (input.kind === 'unattended') {
        const run = registry.startRun({
          appSessionId: input.appSessionId,
          provider: input.provider,
          providerSessionId: input.providerSessionId,
          connection: null,
          userId: input.userId,
          source: 'unattended',
          kind: 'unattended',
        });
        return run ? { runId: run.runId, writer: run.writer } : null;
      }

      const current = runs.get(input.appSessionId);
      if (current && current.status === 'running') {
        // The turn's run already exists — minted at dispatch (the opener) or at
        // an earlier `init` of this same turn. Bind the deliveries stated now;
        // a delivery already in the list is not added twice (the fold handler
        // and the `init` handler can both name the same command).
        for (const deliveryId of input.deliveryIds ?? []) {
          if (!current.deliveryIds.includes(deliveryId)) {
            current.deliveryIds.push(deliveryId);
          }
        }
        return { runId: current.runId, writer: current.writer };
      }

      const run = registry.startRun({
        appSessionId: input.appSessionId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        connection: null,
        userId: input.userId,
        source: 'user',
        kind: 'delivered',
        deliveryIds: input.deliveryIds,
      });
      return run ? { runId: run.runId, writer: run.writer } : null;
    },

    /**
     * The session's run: the open TURN's run while one is in flight, the most
     * recent one otherwise (SPEC §6.1).
     *
     * One map answers both halves, and that is the point of run=turn: with a
     * resident session's run minted per turn and never superseded, the session's
     * current run and its open turn are the same object, so "the most recent run"
     * is what this slot holds whenever nothing is open. Off that path the same
     * reading is what it always was — the run a busy send superseded is reachable
     * through `getRunById`, and the session slot follows the newest.
     */
    getRun(appSessionId: string): ChatRun | undefined {
      return runs.get(appSessionId);
    },

    /**
     * The run's own record — what it is, which deliveries it owns, and its frame
     * log — addressed by its id. The S2 frame-attribution and delivery-binding
     * reading (SPEC §6.1–§6.2, I3).
     *
     * A reader of its own rather than fields on {@link ChatRunSummary}, and the
     * reason is a pin, not taste: that projection is held to its exact seven-field
     * set by this module's own criterion (`chat-run-by-id.test.ts`), which is one
     * of the criteria S2 must leave untouched. The events are a COPY, so a reader
     * cannot mutate a buffer a live run is still appending to.
     *
     * `null` for an id this registry never handed out — the same absence
     * `getRunById` reports, in the shape a caller that wants the run's own facts
     * (rather than its summary) needs.
     */
    readRun(runId: string): {
      runId: string;
      sessionId: string;
      source: ChatRunSource;
      kind: ChatRunKind;
      status: ChatRunStatus;
      deliveryIds: string[];
      lastSeq: number;
      events: NormalizedMessage[];
    } | null {
      const run = runsById.get(runId);
      if (!run) {
        return null;
      }
      return {
        runId: run.runId,
        sessionId: run.appSessionId,
        source: run.source,
        kind: run.kind,
        status: run.status,
        deliveryIds: [...run.deliveryIds],
        lastSeq: run.lastSeq,
        events: run.events.map((event) => ({ ...event })),
      };
    },

    getRunById,

    /**
     * The process identity the run was created under, or `null` when the
     * registry no longer holds it.
     *
     * Deliberately NOT a field on {@link ChatRunSummary}: that projection is
     * pinned to its exact seven-field set by this module's own criterion
     * (`chat-run-by-id.test.ts`), and the one consumer of a run's boot — the MCP
     * gateway's `run_get` (AC-248) — only needs it on the run it is already
     * addressing by id, to tell a run of the current boot from one a previous
     * boot left behind (`bootId !== deps.bootId()` reads as "服务已重启").
     *
     * A run past its retention window is still held (lazily evicted), so this
     * answers for it too; `getRunById` is the reader that reports the expiry,
     * and callers check that first.
     */
    getRunBootId(runId: string): string | null {
      return runsById.get(runId)?.bootId ?? null;
    },

    /**
     * Whether the session is processing — THE SINGLE WRITER'S READING (SPEC §4.3,
     * I6).
     *
     * Under run=turn this is the ledger's predicate, not this registry's own
     * decision: `processing := turn.open ∨ ∃ delivery ∈ {pushed, queued,
     * started}`, published per session by the resident driver
     * (`readSessionProcessing`) and read here rather than recomputed. That is what
     * makes the six readers one reading — this registry's own two, the
     * `/api/providers/sessions/running` route and the heartbeat and the MCP
     * overview and the scheduled-message dispatcher all descend from this one bit
     * — instead of six independent judgements of a run's `status` that could (and
     * did) disagree with the ledger.
     *
     * The two-term shape is deliberate:
     *
     *  - the ledger term is what this exists for. It is TRUE in the two windows a
     *    run's `status` cannot see: after a send is accepted and before the CLI's
     *    `init` mints the turn (a `pushed` delivery), and after a turn's `RESULT`
     *    and before the next turn's `init` (commands the CLI drained out of the
     *    queue, still owed). Reading a run's `status` there answers "idle" while
     *    work is owed — the hole §4.3's "不出现空档" names;
     *  - a session with no resident ledger (`null`) keeps this registry's own
     *    answer, which is the whole truth for the per-run providers: their run
     *    *is* their execution, minted when the process starts, and there is no
     *    ledger behind it.
     *
     * The run's own `status` therefore stays as a term, but only as a WIDENING
     * one: a run is minted at dispatch, before the host has been handed the send,
     * so between those two instants the ledger has not been told yet and this
     * registry is the only side that knows. It can never narrow the ledger's
     * answer — `ledger.processing` alone decides every window the ledger has
     * spoken about, which is the whole of the two above.
     */
    isProcessing(appSessionId: string): boolean {
      const runIsRunning = runs.get(appSessionId)?.status === 'running';
      if (residentRunIsTurn()) {
        const ledger = readSessionProcessing(appSessionId);
        if (ledger) {
          return ledger.processing || runIsRunning;
        }
      }
      return runIsRunning;
    },

    /**
     * Every session processing for a provider run, in the shape the API, the MCP
     * overview and the run list all read (SPEC §4.3's `startedAt` rule included).
     *
     * Under run=turn the set is the LEDGER's, not the set of running runs: a
     * session whose run has ended but whose drained commands are still owed is
     * processing (§4.3), and it is exactly the session a run-keyed list would
     * drop. Sessions the ledger says nothing about keep the run-keyed reading —
     * the per-run providers' halves — and a session that is in both is reported
     * once, from the ledger, because that is the reading the two would have to
     * agree about.
     */
    listRunningRuns(): Array<{
      sessionId: string;
      provider: LLMProvider;
      startedAt: number;
      lastSeq: number;
      correlationId: string | null;
    }> {
      const rows = new Map<string, {
        sessionId: string;
        provider: LLMProvider;
        startedAt: number;
        lastSeq: number;
        correlationId: string | null;
      }>();

      if (residentRunIsTurn()) {
        for (const entry of listProcessingSessions()) {
          const run = runs.get(entry.sessionId);
          rows.set(entry.sessionId, {
            sessionId: entry.sessionId,
            provider: entry.provider,
            startedAt: entry.startedAt,
            lastSeq: run?.lastSeq ?? 0,
            correlationId: run ? ownerCorrelationId(run) : null,
          });
        }
      }

      for (const run of runs.values()) {
        if (run.status !== 'running' || rows.has(run.appSessionId)) {
          continue;
        }
        rows.set(run.appSessionId, {
          sessionId: run.appSessionId,
          provider: run.provider,
          startedAt: run.startedAt,
          lastSeq: run.lastSeq,
          correlationId: ownerCorrelationId(run),
        });
      }

      return Array.from(rows.values());
    },

    /**
     * Stamps the opaque correlation label on one run, addressed by its own id
     * (AC-337).
     *
     * Called by the MCP write tools that open a run (`session_send`,
     * `session_create` with a message) AFTER the control service's `send` has
     * answered with the run id, which is why the caller addresses the run by id
     * rather than by session: a superseding send opens a NEW run under the same
     * session while the older one is still running, and the label belongs to the
     * run the caller actually opened.
     *
     * `null` clears the label (no run a real caller opens is ever stamped with
     * it — {@link startRun} already initialises the field to `null`). An unknown
     * run id is a no-op rather than a throw: the label is advisory metadata, and
     * a run that has already been evicted is not an error the caller could act
     * on. Returns whether a run was stamped, so a criterion can read the write
     * happening rather than infer it.
     */
    setRunCorrelationId(runId: string, correlationId: string | null): boolean {
      const run = runsById.get(runId);
      if (run === undefined) {
        return false;
      }
      run.correlationId = correlationId;
      return true;
    },

    /**
     * Stamps the opaque correlation label on one DELIVERY, addressed by the
     * delivery id the send just answered with (SPEC §6.1).
     *
     * S3's write, and the reason it exists beside {@link setRunCorrelationId}:
     * a send that has not opened its turn yet — the ordinary resident case, whose
     * `runId` is the backfilled delivery id — holds no run id the registry knows,
     * so a run-addressed write would silently stamp nothing. The delivery id is
     * the one id the caller is sure of, and {@link listRunningRuns} resolves it
     * back to the run once the turn binds ({@link ChatRun.deliveryIds}).
     *
     * A run-addressed label still wins for a run whose owner delivery carries
     * none, so the two writes coexist rather than one replacing the other.
     */
    setDeliveryCorrelationId(deliveryId: string, correlationId: string | null): boolean {
      if (deliveryId.length === 0) {
        return false;
      }
      if (correlationId === null) {
        deliveryCorrelationIds.delete(deliveryId);
        return true;
      }
      deliveryCorrelationIds.set(deliveryId, correlationId);
      while (deliveryCorrelationIds.size > DELIVERY_CORRELATION_LIMIT) {
        const oldest = deliveryCorrelationIds.keys().next();
        if (oldest.done) {
          break;
        }
        deliveryCorrelationIds.delete(oldest.value);
      }
      return true;
    },

    /**
     * The label one delivery carries, or `null` when it carries none.
     *
     * The read side of {@link setDeliveryCorrelationId}, so a criterion — or any
     * later caller — can ask what a delivery was labelled without going through a
     * run: the answer is the delivery's own, whatever turn it belongs to.
     */
    getDeliveryCorrelationId(deliveryId: string): string | null {
      return deliveryCorrelationIds.get(deliveryId) ?? null;
    },

    /**
     * Every run the registry still holds, as read-only summaries: the running
     * ones plus the terminal ones (completed or aborted) still inside the
     * retention window. Expiry is judged lazily against the injected clock by the
     * SAME rule `getRunById` uses (`now() - completedAt <= retentionMs`), so a run
     * the by-id lookup would call `expired` never appears here either — the two
     * readings cannot disagree about which runs are still addressable.
     *
     * Iterates the by-id index rather than the session-keyed map so a run a newer
     * turn superseded — still running, or aborted inside the window — is reported
     * too: `overview` must see a cancelled run even when its session's current
     * slot now holds a different run.
     *
     * Consumers: the MCP gateway's `overview` tool (AC-247), which reads the
     * `aborted` subset to report runs cancelled inside the retention period.
     */
    listRecentRuns(): ChatRunSummary[] {
      const at = now();
      return Array.from(runsById.values())
        .filter(
          (run) =>
            run.status === 'running'
            || run.completedAt === null
            || at - run.completedAt <= retentionMs,
        )
        .map(summarize);
    },

    /**
     * Adds a websocket connection to a run's live audience.
     *
     * This is the generic replacement for the Claude-only writer reconnect:
     * after a page refresh the new socket subscribes and immediately starts
     * receiving the still-running stream, for every provider.
     *
     * Subscribing does not take the stream away from sockets that were already
     * watching — a session open in two places stays live in both, and the
     * refreshed tab's abandoned socket is dropped when the next event finds it
     * closed. Replay stays per-connection because each client sends its own
     * `lastSeq` with `chat.subscribe`.
     *
     * The socket is recorded against the session as well as handed to the
     * current run, so a run that later replaces this one for the same session
     * (the supersede a mid-turn spoken sentence opens) keeps writing to it.
     *
     * AND IT IS RECORDED EVEN WHEN NO RUN EXISTS. A person who opens the page
     * while the session is idle subscribes to a session with no run in flight;
     * before this, that subscribe registered nothing, so the very next turn — a
     * voice `session_send` arriving `connection: null` — opened a run that
     * carried no audience except the sockets watching at that instant, and the
     * `command_lifecycle` rows for the queued sentence were written to nobody.
     * Registering the watcher at subscribe time is what makes "whatever run
     * currently holds this session's slot" reachable across the idle→busy edge,
     * rather than only across the mid-turn supersede this originally covered
     * (2026-10-14).
     *
     * Returns whether a run was current at the instant of the call — `false` is
     * the idle subscribe above and is not a failure; the socket is watching from
     * now on either way.
     */
    attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
      // Remember the socket against the SESSION first, unconditionally: the
      // audience belongs to the session, and an idle subscribe must still be
      // watching when the session's next run opens (see the method note).
      let watching = sessionAudience.get(appSessionId);
      if (!watching) {
        watching = new Set<RealtimeClientConnection>();
        sessionAudience.set(appSessionId, watching);
      }
      watching.add(connection);

      const run = runs.get(appSessionId);
      if (!run) {
        return false;
      }

      run.writer.updateWebSocket(connection);
      run.connections.add(connection);
      return true;
    },

    /**
     * Returns buffered events with `seq` greater than `afterSeq` for replay.
     *
     * `runId` is the run the caller's `afterSeq` was recorded against. `seq` is
     * numbered per run, so a cursor recorded against a *different* run than the
     * one currently in flight means nothing here: `afterSeq` is ignored and the
     * run replays from its first event. A matching `runId`, or none at all (a
     * client that predates run ids, or an internal caller), keeps the plain
     * `seq > afterSeq` rule.
     *
     * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
     * means the buffer was truncated; the client should refresh over REST.
     */
    replayEvents(appSessionId: string, afterSeq: number, runId?: string): NormalizedMessage[] {
      const run = runs.get(appSessionId);
      if (!run) {
        return [];
      }

      const effectiveAfterSeq = runId !== undefined && runId !== run.runId ? 0 : afterSeq;
      return run.events.filter((event) => typeof event.seq === 'number' && event.seq > effectiveAfterSeq);
    },

    /**
     * Emits a synthetic terminal `complete` if (and only if) the run is still
     * marked running. Used when a provider runtime throws or resolves without
     * having produced its own terminal event, and by the abort path.
     */
    completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
      const run = runs.get(appSessionId);
      if (!run || run.status !== 'running') {
        return;
      }

      run.writer.sendComplete(opts);
    },

    /**
     * Safety-net variant of `completeRun` scoped to one specific run: a no-op
     * unless `run` is still the session's current, running run. A runtime
     * promise can resolve after its own `complete` already streamed AND a new
     * run has replaced it in the registry (a queued message sends within
     * milliseconds of the previous turn ending) — the session-keyed
     * `completeRun` would terminate that newer run.
     */
    completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
      if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
        return;
      }

      run.writer.sendComplete(opts);
    },

    /**
     * Test-only escape hatch: clears every tracked run.
     */
    clearAll(): void {
      runs.clear();
      runsById.clear();
      sessionAudience.clear();
      deliveryCorrelationIds.clear();
    },
  };

  return registry;
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them. This is the process-wide
 * instance `server/index.ts`, the websocket gateway and the control plane
 * share; the factory above is the injection seam for an isolated instance.
 */
export const chatRunRegistry = createChatRunRegistry({
  // Production's forwarding log: one line per `command_lifecycle` the registry
  // writes through a run's writer, so the next live Live Voice test can read
  // back, from the log alone, which run a lifecycle frame was routed to, how
  // many OPEN sockets that run's writer held, and which SESSION that run was for
  // (`session=`, SPEC §10.2 — see {@link ChatRunLifecycleForwardLog}).
  // `console.log`, not the error channel:
  // a forwarded frame is normal operation, and the line is the measurement, not
  // a fault report.
  lifecycleLog: (line) => {
    console.log(
      `[ChatRunRegistry] command_lifecycle forwarded uuid=${line.commandUuid} state=${line.commandState} runId=${line.runId} connections=${line.connections} session=${line.appSessionId}`,
    );
  },
});

// The process registry's read/write face, installed as the shared
// `chat-run-registry` port while this module evaluates. The consumer is the MCP
// gateway's tool assembly, which must not import this module: the gateway is
// reached from the voice-realtime runtime and the websocket module imports the
// providers module, so the edge kept the two sides' initialization order
// coupled. The gateway reads the accessor lazily (with a documented
// "unknown run" fallback when nothing installed one), and `server/index.ts`
// repeats the installation in the composition root.
installChatRunRegistryPort(chatRunRegistry);
