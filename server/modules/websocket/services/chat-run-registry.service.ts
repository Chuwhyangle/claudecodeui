import { randomUUID } from 'node:crypto';

import { sessionsDb } from '@/modules/database/index.js';
import { BOOT_ID } from '@/modules/websocket/services/activity-heartbeat.service.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import type {
  ChatRunSource,
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

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
};

/**
 * Read-only facts about one run, looked up by the run's own id.
 *
 * Deliberately *not* the internal `ChatRun`: a caller addressing a run by id
 * needs its identity and lifecycle and nothing else, and handing out the
 * internal record would leak the live `writer` and the event buffer it could
 * still mutate. Consumed by this module's criterion
 * (`server/modules/websocket/tests/chat-run-by-id.test.ts`) and, through the
 * module barrel, by the MCP gateway's `overview` tool (AC-247), which types the
 * aborted-run reading of `listRecentRuns` against it.
 */
export type ChatRunSummary = {
  runId: string;
  sessionId: string;
  source: ChatRunSource;
  status: 'running' | 'completed' | 'aborted';
  startedAt: number;
  completedAt: number | null;
  lastSeq: number;
};

/**
 * Why a `getRunById` lookup returned no summary.
 *
 * `expired` means the run existed and stayed terminal past the retention
 * window; `unknown` means the id was never handed out. The two are kept apart
 * so a caller can distinguish "you waited too long" from "that id is not
 * ours". Consumed by the same criterion as `ChatRunSummary`.
 */
export type ChatRunLookupMiss = {
  status: 'unknown';
  reason: 'expired' | 'unknown';
};

/**
 * The result of a run lookup by id: the run's summary, or a typed miss.
 * Consumed by the same criterion as `ChatRunSummary`.
 */
export type ChatRunLookupResult = ChatRunSummary | ChatRunLookupMiss;

/**
 * How long a terminal run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 *
 * This is only the default: `createChatRunRegistry` accepts a `retentionMs`
 * override (today, the criterion uses it to move a fake clock past the window
 * without a real wait).
 */
const DEFAULT_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

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
}) {
  const retentionMs = resolveRetentionMs(options?.retentionMs);
  const now = options?.now ?? (() => Date.now());
  const bootId = options?.bootId ?? (() => BOOT_ID);

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
      evictRunLater(run.appSessionId);
    }

    run.events.push(outbound);
    if (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
      run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS_PER_RUN);
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
     */
    supersedeRunning?: boolean;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running' && !input.supersedeRunning) {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      runId: randomUUID(),
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      source: input.source ?? (input.connection ? 'user' : 'scheduled'),
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: now(),
      completedAt: null,
      bootId: bootId(),
      // No label at creation: the only writers are the MCP write tools, and they
      // stamp it through {@link setRunCorrelationId} once the send that opened
      // the run has answered. A run opened any other way (a UI send, a scheduled
      // message, the host layer) therefore always reads `null`, which is the
      // honest reading of "nobody attached a label" rather than a value invented
      // here.
      correlationId: null,
    };

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

  return {
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
      const run = startRun({
        appSessionId: input.appSessionId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        connection: null,
        userId: input.userId,
        source: 'unattended',
      });
      return run ? { writer: run.writer } : null;
    },

    getRun(appSessionId: string): ChatRun | undefined {
      return runs.get(appSessionId);
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

    isProcessing(appSessionId: string): boolean {
      return runs.get(appSessionId)?.status === 'running';
    },

    listRunningRuns(): Array<{
      sessionId: string;
      provider: LLMProvider;
      startedAt: number;
      lastSeq: number;
      correlationId: string | null;
    }> {
      return Array.from(runs.values())
        .filter((run) => run.status === 'running')
        .map((run) => ({
          sessionId: run.appSessionId,
          provider: run.provider,
          startedAt: run.startedAt,
          lastSeq: run.lastSeq,
          correlationId: run.correlationId,
        }));
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
     */
    attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
      const run = runs.get(appSessionId);
      if (!run) {
        return false;
      }

      run.writer.updateWebSocket(connection);
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
    },
  };
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
export const chatRunRegistry = createChatRunRegistry();
