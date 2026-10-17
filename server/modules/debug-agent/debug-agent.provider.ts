import type { IProvider, IProviderRuntime, IProviderSessions, IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { CHAT_TURN_OPTION, DELIVERY_SOURCE_OPTION } from '@/shared/types.js';
import type {
  ApprovalDecisionRecord,
  ChatRunSource,
  DeliveryEntry,
  DeliveryEntryReason,
  LLMProvider,
  MessageOrigin,
  MissingApprovalReason,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRuntimeWriter,
  RuntimeProviderCapabilities,
} from '@/shared/types.js';
import { AppError, createCompleteMessage, readObjectRecord } from '@/shared/utils.js';

import {
  evaluateScenarioExpectations,
  runDebugAgentScenario,
  type DebugAgentFrameForwarder,
  type DebugAgentPermissionOps,
} from './debug-agent.engine.js';
import { DEBUG_AGENT_PROVIDER_ID, readDebugAgentGate } from './debug-agent.gate.js';
import {
  createDebugAgentHostDriver,
  DEBUG_AGENT_BUSY_INPUT_OPTION,
  type DebugAgentHostDriver,
  type DebugAgentOpenRun,
} from './debug-agent.host-driver.js';
import {
  appendTypedTurnRow,
  buildCommandLifecycleRow,
  readArmedDebugAgentScenario,
  type ArmedDebugAgentScenario,
} from './debug-agent.runtime.js';
import {
  DEBUG_AGENT_TURN_TRIGGERS,
  type DebugAgentTurnTrigger,
} from './debug-agent.scenario.js';

/**
 * The debug agent as a provider: a face the registry can resolve and the product
 * chat path can drive, with no CLI and no SDK behind it.
 *
 * Where the other faces come from is the design, not a shortcut. `sessions` is the
 * claude provider's own implementation, so "the product and the debug agent turn
 * the same dialect row into the same frame" is reuse rather than a promise kept
 * in step by hand; only `runtime` is written here. ADR-003 decision 2 keeps the id
 * out of `LLMProvider`, which is why it is cast at exactly one place below and
 * why the injection shape exists at all: this module may not import the providers
 * module (the registry registers this provider, so the import would close a cycle
 * and leave the registry reading a half-evaluated binding), so everything it needs
 * from there arrives as a dependency.
 */

/** The id this provider registers under, cast once — the only cast ADR-003 decision 2 needs. */
const DEBUG_AGENT_RUNTIME_PROVIDER_ID = DEBUG_AGENT_PROVIDER_ID as LLMProvider;

/** Where the synchronizer for a fixture home should read from and write as. */
export type DebugAgentSynchronizerOptions = {
  home: string;
  providerId: string;
};

/**
 * Announces a debug prompt on the run's own writer and feeds the product's Turn
 * Tracker.
 *
 * Declared here, with no wire vocabulary, because this module may not name a
 * frame (ADR-003 decision 7 — the vocabulary guard forbids `permission_request`
 * and its kin in every source under `debug-agent/`). The implementation lives
 * where those names and the tracker do — `claude-runtime.provider.ts` — and
 * `provider.registry.ts`, the one construction site that sees both modules,
 * injects it. A build that wires none offers no `permission-request` step: the
 * runtime hands the engine no announcer and the engine refuses the step up
 * front rather than raising a prompt no client could see.
 */
export type DebugAgentPermissionAnnouncer = {
  /** Raises the prompt: a frame on `writer` plus a Turn Tracker `awaitingPermission` feed. */
  request(input: {
    sessionId: string;
    requestId: string;
    toolName: string;
    input: unknown;
    writer: ProviderRuntimeWriter;
  }): void;
  /** Retracts it: the frame that clears the prompt plus the tracker feed that leaves the phase. */
  resolved(input: { sessionId: string; requestId: string; writer: ProviderRuntimeWriter }): void;
};

export type DebugAgentProviderDependencies = {
  /**
   * The claude provider instance. Its `sessions` face is the real normalizer, so
   * the frames a debug run produces are the product's own shapes.
   */
  base: IProvider;
  /** The product's normalizer → writer forwarder (`forwardNormalizedFrames`). */
  forwardFrames: DebugAgentFrameForwarder;
  /**
   * Builds the indexer for a fixture home. Injected because the indexer belongs
   * to the providers module, and because the file it indexes is a fixture: the
   * product's own instance would scan the user's real transcripts.
   */
  createSessionSynchronizer: (options: DebugAgentSynchronizerOptions) => IProviderSessionSynchronizer;
  /**
   * How an unattended turn opens the run it belongs to.
   *
   * Injected, and optional, because the run registry lives in the websocket
   * module and the construction site that builds this provider does not have it
   * in scope — the registry this provider is being registered into is what the
   * websocket module imports, so reaching back for it would close the cycle
   * ADR-003 decision 7 forbids. A build that wires no seam gets a provider
   * whose scenario steps still run and whose unattended turn fails loudly
   * naming the gap; the capability declaration below is about the process
   * lifetimes the driver implements, not about this one seam.
   */
  openRun?: DebugAgentOpenRun;
  /**
   * How a debug scenario's `permission-request` step announces a prompt.
   *
   * Injected from `provider.registry.ts` because the frame vocabulary and the
   * Turn Tracker both live in the claude runtime module, which this module may
   * not import (and may not spell — see {@link DebugAgentPermissionAnnouncer}).
   * Optional: without it the runtime exposes no prompt layer, so a scenario that
   * raises one is refused rather than walked halfway.
   */
  announcePermission?: DebugAgentPermissionAnnouncer;
  /**
   * Records the lifecycle facts this provider states about itself.
   *
   * A callback rather than a direct call because the capability matrix belongs
   * to the providers module. It is how a provider that is deliberately not in
   * `LLMProvider` states `resident` mode and a multiplexed host without the
   * union-keyed table gaining a row for an id that can serve no user-facing
   * request.
   */
  declareRuntimeCapabilities?: (capabilities: RuntimeProviderCapabilities) => void;
  /**
   * Publishes this provider's delivery ledger to the activity channel — the same
   * seam the claude resident driver installs (`publishSessionDeliveries`).
   *
   * The real CLI's resident host writes a delivery entry for every command it
   * queues; this substitute held commands with no such record, so a client
   * reading the activity snapshot saw an empty `deliveries[]` for a debug session
   * and could not tell a withdrawn command from a voice one. Injected rather
   * than imported because the publishing store lives in the providers module
   * (the claude driver's own ledger registry) and this module may not reach back
   * into it — see ADR-003 decision 7. Absent, the provider behaves exactly as it
   * did: no ledger is published and nothing reads one.
   */
  publishDeliveries?: (sessionId: string, reading: () => DeliveryEntry[], signature: string) => void;
};

/**
 * The origin a dispatch stated for a pushed command, as the runtime option
 * carries it — the same reading the claude resident driver makes
 * (`readDeliverySource`). An unstated or unknown origin is `user`, because a
 * delivery nobody claimed is a person's message, not a tool's.
 */
function readDebugDeliverySource(options: Record<string, unknown> | undefined): ChatRunSource {
  const stated = options?.[DELIVERY_SOURCE_OPTION];
  return stated === 'user'
    || stated === 'scheduled'
    || stated === 'unattended'
    || stated === 'mcp'
    || stated === 'voice'
    ? stated
    : 'user';
}

/**
 * The run seam of a build that wired none.
 *
 * Throws rather than returning null: "no run was opened" and "this build has
 * nowhere to open one" are different failures, and a scenario author debugging
 * a silent turn deserves to be told which one they hit.
 */
const unwiredOpenRun: DebugAgentOpenRun = ({ appSessionId }) => {
  throw new AppError(
    `No run seam is wired for the debug agent's unattended turn on session "${appSessionId}".`,
    { code: 'DEBUG_AGENT_RUN_SEAM_UNAVAILABLE', statusCode: 500 },
  );
};

/**
 * The `origin` a transcript row carries, read back into the shared vocabulary.
 *
 * `null` for a row with none, and — deliberately — for a row whose field is
 * present but not one this build recognises. The row is the artifact and can be
 * hand-edited or written by an older build, so an unknown trigger reads as "no
 * stated cause" rather than being cast into the union and handed to a frontend
 * that would then have to render a label it has no word for. The frontend's own
 * fallback for a missing origin (`非用户触发`, §15.6) is what covers it.
 */
function readRowOrigin(raw: unknown): MessageOrigin | null {
  const origin = readObjectRecord(readObjectRecord(raw)?.origin);
  const trigger = origin?.trigger;
  if (typeof trigger !== 'string' || !(DEBUG_AGENT_TURN_TRIGGERS as readonly string[]).includes(trigger)) {
    return null;
  }

  const sender = origin?.sender;

  return {
    trigger: trigger as DebugAgentTurnTrigger,
    sender: typeof sender === 'string' && sender.length > 0 ? sender : null,
  };
}

/**
 * The claude sessions face with `origin` lifted onto the messages it builds.
 *
 * The debug agent's rows carry one field the claude dialect does not (see
 * `debug-agent.runtime.ts`), and the product's normalizer builds each message
 * field by field — so a row field it has never heard of is dropped on the way to
 * the wire, and every reader of a debug transcript sees a turn with no stated
 * cause. This is where it is put back, at the seam the readers reach the
 * normalizer through: the WebSocket frames (`context.normalizeMessage`), the
 * debug agent's own self-check and the REST history (`sessionsService`) all call
 * `provider.sessions.normalizeMessage` on this face.
 *
 * A proxy rather than a copy, because `ClaudeSessionsProvider` is a class: its
 * methods live on the prototype, so a spread would leave this face with no
 * `fetchHistory` at all. Everything but the one member is forwarded to the real
 * instance, which is what keeps this a lift rather than a second sessions
 * implementation.
 */
function withMessageOrigin(base: IProviderSessions): IProviderSessions {
  /**
   * The one member that is replaced: `normalizeMessage`, with every message it
   * builds stamped with the cause its own row stated.
   */
  const liftOrigin = (raw: unknown, sessionId: string | null): NormalizedMessage[] => {
    const messages = base.normalizeMessage(raw, sessionId);
    const origin = readRowOrigin(raw);
    return origin ? messages.map((message) => ({ ...message, origin })) : messages;
  };

  const face: IProviderSessions = new Proxy(base, {
    get(target, property) {
      if (property === 'normalizeMessage') {
        return liftOrigin;
      }

      const value = Reflect.get(target, property, target);
      // Bound to the face and not to the target, because one of the readers
      // never leaves the object: `fetchHistory` re-normalizes every raw row
      // through its own `this.normalizeMessage`, and a method bound to the
      // target would reach the un-lifted one. That is the whole difference
      // between the two halves of a conversation an unattended turn ran in —
      // the frames would carry the cause while the same rows, read back over
      // REST after a reload, would not — and it is a difference no caller can
      // see, which is why the calls made *inside* this face have to resolve
      // through it as well.
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(face) : value;
    },
  });

  return face;
}

/**
 * Records one command the host accepted while it was already in a turn.
 *
 * The whole act is one row and one frame. The uuid is minted here because the
 * host's own queue is keyed by it — the same value goes into the queue, into the
 * transcript row's `command_uuid` and out over the socket, so "the message the
 * user sent", "the entry the process is holding" and "the command a withdrawal
 * names" are one object to every reader, which is the only way the client's
 * withdrawal button can address the right command.
 *
 * The row is *not* appended to the transcript file. The engine's own steps write
 * the artifact's rows, and this row is not one of them: a push does not run the
 * scenario, so a row here would be a row the walk's own `expect.rows.delta` never
 * accounted for — an artifact that disagreed with the clock that produced it. The
 * frame is what a client reads, and the two steps that later act on this command
 * (`dequeue`, `cancel-ack`) write their rows through the engine, on the clock.
 *
 * Returns the reading, not `undefined`: the resident dispatch hands this value
 * back to whoever dispatched the turn, and a marker that said "this was a push"
 * is the only thing that distinguishes this run's result from a walk's.
 */
function acceptPushedCommand(input: {
  armed: ArmedDebugAgentScenario;
  writer: ProviderRuntimeWriter;
  context: ProviderRuntimeContext;
  forwardFrames: DebugAgentFrameForwarder;
  hostDriver: DebugAgentHostDriver;
}): { pushed: true; commandUuid: string } {
  const commandUuid = crypto.randomUUID();
  input.hostDriver.registerPushedCommand({ appSessionId: input.armed.sessionId, commandUuid });

  const row = buildCommandLifecycleRow({
    sessionId: input.armed.providerSessionId,
    cwd: input.armed.projectPath,
    commandUuid,
    state: 'queued',
    timestamp: new Date().toISOString(),
  });

  input.forwardFrames({
    transformedMessage: row,
    sessionId: input.armed.providerSessionId,
    normalizeMessage: input.context.normalizeMessage,
    writer: input.writer,
  });

  return { pushed: true, commandUuid };
}

/**
 * The debug agent's runtime face, widened with the two control verbs the
 * substitute process accepts.
 *
 * `stopTask` / `backgroundTask` are not part of `IProviderRuntime` — that
 * contract is what every provider shares, and these belong to one provider's
 * control plane. The gateway reads them structurally (`PerRunStopTaskRuntime` /
 * `PerRunBackgroundTaskRuntime` in `provider-runtime.service.ts`) on the route a
 * `per-run` debug session takes, so the object only has to carry them; they
 * delegate to the host driver so the accept logic has one implementation,
 * reachable from either the per-run route or a resident one.
 */
type DebugAgentRuntime = IProviderRuntime & {
  stopTask(sessionId: string, taskId: string): Promise<boolean>;
  backgroundTask(sessionId: string, toolUseId: string): Promise<boolean>;
  /**
   * The human-facing prompt face, so the debug agent's own prompts are visible
   * to the approval tools. Widened from `IProviderRuntime`'s optional
   * `permissions?` to a required member: this runtime always has one, and making
   * that a fact of the type rather than an optional a caller has to probe is the
   * point of the whole change — a debug session that "runs" but can hold no
   * prompt is the gap this closes.
   */
  permissions: ProviderRuntimePermissionGateway;
};

/**
 * The runtime face: it walks the scenario armed for the session the run is for,
 * and reports the artifact's own readings back to its caller.
 *
 * The only id a run can be addressed by is the id an armed scenario was indexed
 * under, so an unarmed session is refused with a reason naming it rather than
 * quietly producing nothing — a debug session that appears to run and emits no
 * frame would be indistinguishable from a client that failed to connect.
 */
function createDebugAgentRuntime(
  forwardFrames: DebugAgentFrameForwarder,
  hostDriver: DebugAgentHostDriver,
  announcePermission: DebugAgentPermissionAnnouncer | undefined,
  publishDeliveries: DebugAgentProviderDependencies['publishDeliveries'],
): DebugAgentRuntime {
  /**
   * This substitute process's delivery ledger, per app session.
   *
   * A push is a DELIVERY — the command the host took while it was mid-turn —
   * and the activity channel exists so a client can draw that wait. The real
   * CLI's resident driver maintains this ledger for its own process; this
   * substitute had nothing, which made a debug session's `deliveries[]` empty and
   * every reading over it vacuous. The entries are the same ten facts
   * `DeliveryEntry` states (SPEC §7.1), kept here because the debug agent's
   * process is this object.
   */
  const deliveriesBySession = new Map<string, DeliveryEntry[]>();

  /** Publishes one session's ledger through the injected seam (absent ⇒ no publication). */
  function publishSessionLedger(sessionId: string): void {
    if (publishDeliveries === undefined) {
      return;
    }
    const entries = deliveriesBySession.get(sessionId) ?? [];
    publishDeliveries(sessionId, () => entries.map((entry) => ({ ...entry })), JSON.stringify(entries));
  }

  /** Records one accepted push as a live (`queued`) delivery. */
  function recordQueuedDelivery(input: {
    sessionId: string;
    commandUuid: string;
    text: string;
    source: ChatRunSource;
  }): void {
    const entries = deliveriesBySession.get(input.sessionId) ?? [];
    entries.push({
      deliveryId: input.commandUuid,
      state: 'queued',
      source: input.source,
      priority: null,
      enqueuedAt: Date.now(),
      startedAt: null,
      endedAt: null,
      turnId: null,
      reason: null,
      text: input.text,
    });
    deliveriesBySession.set(input.sessionId, entries);
    publishSessionLedger(input.sessionId);
  }

  /** Moves one delivery to `started` (the walk dequeued it) and republishes. */
  function markDeliveryStarted(sessionId: string, deliveryId: string): void {
    const entry = deliveriesBySession.get(sessionId)?.find((candidate) => candidate.deliveryId === deliveryId);
    if (entry === undefined || entry.state !== 'queued') {
      return;
    }
    entry.state = 'started';
    entry.startedAt = Date.now();
    publishSessionLedger(sessionId);
  }

  /** Moves one delivery to its terminal state and republishes. */
  function markDeliveryEnded(
    sessionId: string,
    deliveryId: string,
    state: 'completed' | 'cancelled',
    reason: DeliveryEntryReason | null = null,
  ): void {
    const entry = deliveriesBySession.get(sessionId)?.find((candidate) => candidate.deliveryId === deliveryId);
    if (entry === undefined || entry.state === 'completed' || entry.state === 'cancelled') {
      return;
    }
    entry.state = state;
    entry.endedAt = Date.now();
    entry.reason = state === 'cancelled' ? reason : null;
    entry.text = null;
    publishSessionLedger(sessionId);
  }
  /**
   * The text of each command this process queued, keyed by the uuid it minted.
   *
   * A push records the command but does not run it, so by the time its round is
   * opened (after the in-flight turn ends) the dispatch that carried the text is
   * long gone. Keeping it here is what lets the queued message's round be opened
   * with the message the user actually sent rather than a placeholder. Keyed by
   * the host's own uuid, which is unique, so a later round cannot read another
   * command's text.
   */
  const queuedTextByCommand = new Map<string, string>();

  /**
   * Opens the round a dequeued command becomes and ends it with its own
   * terminal frame.
   *
   * Called only after the walk that dequeued the command has ended and its run
   * has been completed, because the registry holds one run per session: opened
   * any earlier, `openUnattendedTurn` would fall back to the still-open run's
   * writer and the command would never become a round of its own. The turn is
   * ended immediately after the frame, so no lease is left holding the process.
   */
  async function openQueuedCommandRound(input: {
    armed: ArmedDebugAgentScenario;
    commandUuid: string;
  }): Promise<void> {
    const writer = await hostDriver.openUnattendedTurn({
      appSessionId: input.armed.sessionId,
      text: queuedTextByCommand.get(input.commandUuid) ?? `queued command ${input.commandUuid}`,
      runId: crypto.randomUUID(),
    });

    writer.send(
      createCompleteMessage({
        provider: DEBUG_AGENT_RUNTIME_PROVIDER_ID,
        sessionId: input.armed.providerSessionId,
        exitCode: 0,
      }),
    );

    await hostDriver.endUnattendedTurn({ appSessionId: input.armed.sessionId });
    // The command ran: the turn's own rows are its record now, so the delivery
    // leaves the live ledger with `text: null` (the same terminal rule the real
    // ledger applies — a finished message's words belong to the transcript).
    markDeliveryEnded(input.armed.sessionId, input.commandUuid, 'completed');
  }

  /**
   * The prompt a `permission-request` step is holding, as this runtime holds it.
   *
   * Keyed by request id, one entry per outstanding prompt. `sessionId` is the APP
   * session id (`listPending` is asked by that id, the id every approval caller
   * addresses), while the rows a run writes carry the provider-native one — the
   * same split the run input documents. `wake` is attached only while the walk is
   * parked on the prompt.
   */
  type PendingDebugApproval = {
    requestId: string;
    sessionId: string;
    toolName: string;
    input: unknown;
    receivedAt: Date;
    writer: ProviderRuntimeWriter;
    wake?: (decision: ProviderPermissionDecision | null) => void;
  };
  const pendingApprovals = new Map<string, PendingDebugApproval>();

  /** How many held/decided request ids this runtime remembers. */
  const MAX_REMEMBERED_APPROVALS = 512;

  /**
   * The bounded ids this runtime has HELD.
   *
   * The live map empties the instant a prompt settles, so it cannot tell an id
   * that was held and then dropped (or answered) from one never minted — both
   * read as absent. The MCP `approval_answer` surface has to report those apart
   * (AC-287), so the id is recorded here at arm time and kept after the entry is
   * gone. Bounded (oldest first out) like the live map's claude counterpart: an
   * evicted id degrades to the conservative `never_issued`, never a false
   * `expired`.
   */
  const heldApprovalLedger = new Set<string>();

  /** Records `requestId` as held, evicting the oldest id past the cap. */
  function rememberHeldApproval(requestId: string): void {
    heldApprovalLedger.delete(requestId);
    heldApprovalLedger.add(requestId);
    if (heldApprovalLedger.size > MAX_REMEMBERED_APPROVALS) {
      const oldest = heldApprovalLedger.values().next().value;
      if (oldest !== undefined) {
        heldApprovalLedger.delete(oldest);
      }
    }
  }

  /**
   * The bounded decisions this runtime has recorded.
   *
   * `pendingApprovals` is deleted at settle time, so a second `approval_answer`
   * for the same id finds nothing and cannot tell "another caller already
   * decided this" from "nothing ever held it". The MCP surface needs them apart
   * so a caller can confirm its own answer landed, so the decision is written
   * here BEFORE the waiter wakes — synchronously with the lookup, which is the
   * only moment a concurrent second caller can still learn the request was
   * decided rather than merely gone. Bounded for the same reason the held ledger
   * is; an evicted id degrades to `expired`/`never_issued`, never a false
   * `ALREADY_DECIDED`.
   */
  const approvalDecisionLedger = new Map<string, ApprovalDecisionRecord>();

  /** Records one settled decision, evicting the oldest entry past the cap. */
  function rememberApprovalDecision(requestId: string, record: ApprovalDecisionRecord): void {
    approvalDecisionLedger.delete(requestId);
    approvalDecisionLedger.set(requestId, record);
    if (approvalDecisionLedger.size > MAX_REMEMBERED_APPROVALS) {
      const oldest = approvalDecisionLedger.keys().next().value;
      if (oldest !== undefined) {
        approvalDecisionLedger.delete(oldest);
      }
    }
  }

  /**
   * The prompt layer the engine's `permission-request` step drives.
   *
   * Registered only when an announcer is wired: a runtime that could register a
   * prompt but not announce it would let a scenario park on something no client
   * can see and no Turn Tracker can phase, so it offers no step at all and the
   * engine refuses one. The announcer is what turns "a prompt was raised" into
   * the frame AND the tracker feed, in one call — see
   * {@link DebugAgentPermissionAnnouncer}.
   */
  const permissionOps: DebugAgentPermissionOps | undefined = announcePermission
    ? {
        async request(input) {
          const requestId = input.requestId ?? crypto.randomUUID();
          // Recorded at ARM time, not settle time: the ledger must still name
          // this id after the live entry is deleted, which is the whole point.
          rememberHeldApproval(requestId);
          const entry: PendingDebugApproval = {
            requestId,
            sessionId: input.appSessionId,
            toolName: input.toolName,
            input: input.input,
            receivedAt: new Date(),
            writer: input.writer,
          };
          pendingApprovals.set(requestId, entry);
          announcePermission.request({
            sessionId: input.appSessionId,
            requestId,
            toolName: input.toolName,
            input: input.input,
            writer: input.writer,
          });

          if (!input.hold) {
            // The prompt was shown and is immediately gone — a request that
            // timed out or was discarded. The live entry is dropped and the
            // held ledger keeps it, so a later answer classifies it `expired`
            // rather than `never_issued`; no decision is recorded, because none
            // was made.
            pendingApprovals.delete(requestId);
            announcePermission.resolved({
              sessionId: input.appSessionId,
              requestId,
              writer: input.writer,
            });
            return { requestId };
          }

          // Park the walk until `permissions.resolve` is reached. The waiter is
          // stored on the entry so `resolve` can wake exactly this one, and the
          // resolved value is discarded here: what the answer MEANS to the walk
          // is the next step's row, not a value this layer interprets.
          await new Promise<void>((resolve) => {
            entry.wake = () => resolve();
          });
          return { requestId };
        },
      }
    : undefined;

  /**
   * The prompt face the approval tools read. Every verb answers from this
   * runtime's own tables — the pending map and the two ledgers — so a debug
   * session's prompts are the agent's own, never a borrowed claude runtime's.
   */
  const permissions: ProviderRuntimePermissionGateway = {
    listPending(sessionId) {
      return [...pendingApprovals.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => ({
          requestId: entry.requestId,
          sessionId: entry.sessionId,
          toolName: entry.toolName,
          input: entry.input,
          receivedAt: entry.receivedAt,
        }));
    },

    resolve(requestId, decision, decidedBy = null) {
      const entry = pendingApprovals.get(requestId);
      if (!entry) {
        // Nothing live to decide — a decision for an id this runtime is not
        // holding must not enter the ledger, or a later caller would read a
        // settlement that never happened. Mirrors the claude runtime's silence.
        return;
      }
      // Written BEFORE the waiter wakes, and synchronously with the lookup: the
      // waiter deletes the pending entry in the same tick, so this is the only
      // point a concurrent second caller can still learn the request was
      // decided rather than merely gone.
      rememberApprovalDecision(requestId, {
        decidedAt: Date.now(),
        decidedBy,
        allow: typeof decision?.allow === 'boolean' ? decision.allow : null,
      });
      pendingApprovals.delete(requestId);
      announcePermission?.resolved({ sessionId: entry.sessionId, requestId, writer: entry.writer });
      entry.wake?.(decision);
    },

    classifyMissingApproval(requestId): MissingApprovalReason {
      return heldApprovalLedger.has(requestId) ? 'expired' : 'never_issued';
    },

    readApprovalDecision(requestId): ApprovalDecisionRecord | null {
      return approvalDecisionLedger.get(requestId) ?? null;
    },
  };

  return {
    async run(command, options, writer, context) {
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
      const armed = readArmedDebugAgentScenario(sessionId);
      if (!armed) {
        throw new AppError(`No debug agent scenario is armed for session "${sessionId}".`, {
          code: 'DEBUG_AGENT_SCENARIO_NOT_ARMED',
          statusCode: 400,
        });
      }

      // The transcript's session id, announced before the first row is written.
      // It is what the registry maps the run's session back to, and therefore
      // what the terminal `complete`'s REST re-fetch reads the history through.
      writer.setSessionId?.(armed.providerSessionId);

      // A command the host took while it was already in a turn. This is not a
      // run of the scenario: a real CLI holds such a command in its own queue
      // until the turn in flight ends, so there is no walk to perform and no
      // terminal frame to send — the run this dispatch opened is a carrier for
      // one row, and it is the host's own `dequeue` / `cancel-ack` steps, on the
      // scenario's clock, that later say what became of the command.
      //
      // Read off the options rather than asked of the host layer, because this
      // and the decision that produced it are the same dispatch: the driver reads
      // the process's state, stamps the answer onto the turn, and this reads it
      // back. Asking the host again here would answer about the moment after,
      // when the pushed command's own arrival may already have changed it.
      if (options[DEBUG_AGENT_BUSY_INPUT_OPTION] === true) {
        const accepted = acceptPushedCommand({ armed, writer, context, forwardFrames, hostDriver });
        // The push does not run, so the dispatch that carried this text is gone
        // before its round is opened. Remembered here for that later round.
        queuedTextByCommand.set(accepted.commandUuid, command);
        // THE DELIVERY LEDGER (the activity channel's `deliveries[]`). The push
        // IS the delivery, and its origin is the dispatch's own — `voice` for a
        // spoken sentence the relay settled, `user`/`mcp` for a typed or tool
        // send. Publishing here is what gives a browser a row to decide about;
        // without it a voice delivery could not be told from any other, and the
        // "no pending command row for voice" reading would hold vacuously.
        recordQueuedDelivery({
          sessionId: armed.sessionId,
          commandUuid: accepted.commandUuid,
          text: command,
          source: readDebugDeliverySource(options),
        });
        return accepted;
      }

      // The turn's own prompt, written before the walk it starts.
      //
      // A typed turn reaches this entry with the person's text as `command`, and
      // the run it starts walks the scenario — which writes what the scenario
      // says and has never seen that text. So the row the prompt becomes has to
      // be written here, by the one component that both holds the text and knows
      // a turn is what it is. Before the walk rather than after: the row is on
      // disk before any frame is forwarded (`appendTypedTurnRow` writes
      // synchronously, and the forward below is the very next statement), and the
      // engine reads the transcript's `before` shape when it starts, so the
      // prompt is part of the artifact the scenario's expectations are measured
      // against rather than an extra row its `expect.rows.delta` never counted.
      //
      // The frame is forwarded for the same reason the engine forwards every row
      // it writes: the run's own client renders from frames, so a row that
      // reached only the disk would make the live conversation and the history
      // the reload reads two different conversations — the divergence this agent
      // exists to reproduce and must not manufacture itself.
      //
      // Only a turn the chat transport dispatched carries a message. The other
      // dispatches this entry serves are drivers naming a walk — the control
      // plane's clock advance is one, and it reaches this same entry with the
      // same option keys — so the flag is what tells "somebody composed this
      // text" apart from "a driver named this run". Absent means the latter: a
      // label recorded as a user row would be a message nobody sent, while the
      // missing row this reads for is the one thing the flag is for.
      if (options[CHAT_TURN_OPTION] === true) {
        const row = appendTypedTurnRow({
          transcriptPath: armed.transcriptPath,
          sessionId: armed.providerSessionId,
          cwd: armed.projectPath,
          text: command,
        });

        if (row) {
          forwardFrames({
            transformedMessage: row,
            sessionId: armed.providerSessionId,
            normalizeMessage: context.normalizeMessage,
            writer,
          });
        }
      }

      // Where this run's frames ended up. It starts as the caller's writer and
      // follows them to the run's own writer when an unattended turn opens one,
      // which is the whole reason it is tracked here: the terminal frame has to
      // end the run that produced the turn. Writing it to the caller's writer
      // instead would leave the run open for good — a client that replayed it
      // would see a turn that never finished, and the session would stay
      // "processing" with nothing running.
      let delivery = writer;

      // Every queued command this walk dequeues and starts. Collected during the
      // walk and acted on after it, because the round each one becomes can only
      // be opened once this walk's own run has ended — see the loop below.
      const startedCommands: string[] = [];

      const reading = await runDebugAgentScenario({
        scenario: armed.scenario,
        sessionId: armed.providerSessionId,
        // The id the host layer and the run registry address the session by.
        // `sessionId` above is the provider-native one the rows carry; a host
        // step addressed with that would land on a session no one is watching.
        appSessionId: armed.sessionId,
        cwd: armed.projectPath,
        transcriptPath: armed.transcriptPath,
        writer,
        normalizeMessage: context.normalizeMessage,
        forwardFrames,
        hostOps: hostDriver,
        // Registered only when an announcer is wired; absent, the engine refuses
        // a `permission-request` step up front rather than raising a prompt no
        // client can see (see `permissionOps` above).
        permissionOps,
        onDelivery: (next) => {
          delivery = next;
        },
        onQueuedCommandStarted: (commandUuid) => {
          startedCommands.push(commandUuid);
          // The walk's `dequeue` is the process taking the command: the ledger
          // follows it from `queued` to `started` here, before the round opens.
          markDeliveryStarted(armed.sessionId, commandUuid);
        },
      });

      const evaluation = evaluateScenarioExpectations({
        scenario: armed.scenario,
        transcriptPath: armed.transcriptPath,
        reading,
        sessionId: armed.providerSessionId,
        normalizeMessage: context.normalizeMessage,
      });

      // A scenario's expectations are the run's own verdict on itself, and it is
      // reported the way every provider reports one: the terminal frame's exit
      // code. The numbers stay in the return value, so a caller that wants the
      // artifact's readings does not have to reconstruct them from the socket.
      if (evaluation.failures.length > 0) {
        console.error(
          `[DebugAgent] Scenario run for session "${armed.sessionId}" did not meet its own expectations:\n${evaluation.failures.join('\n')}`,
        );
      }

      delivery.send(
        createCompleteMessage({
          provider: DEBUG_AGENT_RUNTIME_PROVIDER_ID,
          sessionId: armed.providerSessionId,
          exitCode: evaluation.failures.length === 0 ? 0 : 1,
        }),
      );

      // The round that was in flight has ended, so each command the walk started
      // — a queued message no withdrawal removed — now becomes an independent
      // round of its own: a run with a runId distinct from this one, ended with
      // its own terminal frame. The same held process serves it; nothing here
      // opens a second process.
      for (const commandUuid of startedCommands) {
        await openQueuedCommandRound({ armed, commandUuid });
      }

      return { reading, evaluation };
    },

    abort() {
      // A scenario is a clock walk over a file, and its longest step is a `wait`.
      // There is no child process, no SDK request and no partial artifact to tear
      // down, so there is nothing to abort — reported as "nothing was aborted"
      // rather than as a success a caller could mistake for a stopped run.
      return false;
    },

    // The per-run face of the substitute's control verbs. A `per-run` debug
    // session reaches these through the gateway's per-run route (its stored mode
    // makes `resolveResidentEntry` answer null), and they delegate to the host
    // driver so the accept behaviour lives in one place. They write nothing: the
    // task's terminal event and a backgrounding's two frames are the scenario's
    // own steps on the clock.
    stopTask(sessionId: string, taskId: string): Promise<boolean> {
      return hostDriver.stopTask(sessionId, taskId);
    },
    backgroundTask(sessionId: string, toolUseId: string): Promise<boolean> {
      return hostDriver.background(sessionId, toolUseId);
    },
    permissions,
  };
}

/**
 * Builds the debug agent's provider, or null when the gate is closed.
 *
 * Consumed by the provider registry, which calls this from its own construction
 * site and registers the result under {@link DEBUG_AGENT_PROVIDER_ID}. The gate is
 * read here as well as in the registry's seam so that a closed gate means nothing
 * is constructed at all — not a provider with a plausible-looking home that a
 * later bug could reach.
 */
export function createDebugAgentProvider(
  dependencies: DebugAgentProviderDependencies,
): IProvider | null {
  const gate = readDebugAgentGate();
  if (!gate.enabled || !gate.home) {
    return null;
  }

  const hostDriver = createDebugAgentHostDriver({ openRun: dependencies.openRun ?? unwiredOpenRun });
  if (!hostDriver) {
    // Unreachable: `createDebugAgentHostDriver` reads the same gate this
    // function just read. Kept as a refusal rather than a non-null assertion so
    // that a future gate rule that disagrees between the two produces no
    // provider at all instead of one with an unsound lifetime claim.
    return null;
  }

  // The declaration is derived from the driver rather than written out beside
  // it: "this provider serves resident hosts and multiplexes them" is a
  // statement about what the object below implements, and two copies of it
  // would be two things to keep in step.
  dependencies.declareRuntimeCapabilities?.({
    provider: DEBUG_AGENT_PROVIDER_ID,
    lifecycleModes: [...hostDriver.lifecycleModes],
    multiplexedHost: hostDriver.multiplexedHost === true,
  });

  const runtime = createDebugAgentRuntime(
    dependencies.forwardFrames,
    hostDriver,
    dependencies.announcePermission,
    dependencies.publishDeliveries,
  );

  // The resident turn entry, bound after both halves exist: the driver is what
  // the runtime reports its host steps through, and the runtime is what the
  // driver runs a turn with, so one of the two edges has to be late. Without
  // this binding `provider-runtime.service` finds no `run` on the driver and
  // routes every resident session through the per-run wrapper — which
  // *supersedes* the resident host, making a turn inside a held process
  // unreachable from the product's own dispatch.
  hostDriver.setTurnRunner(async (appSessionId, turn, writer, context) =>
    // Returned, not awaited-and-dropped: the runtime's result carries the reading its control plane
    // checks against the artifact, and this is the last hop before the dispatch hands it back to the
    // caller. Dropping it here is invisible in the walk — every step still runs and every frame still
    // arrives — and only shows up as a `/clock` that answers `DEBUG_AGENT_RUN_READING_MISSING`.
    runtime.run(turn.command, turn.options, writer, context));

  return {
    id: DEBUG_AGENT_RUNTIME_PROVIDER_ID,
    runtime,
    hostDriver,
    models: dependencies.base.models,
    mcp: dependencies.base.mcp,
    auth: dependencies.base.auth,
    skills: dependencies.base.skills,
    sessions: withMessageOrigin(dependencies.base.sessions),
    sessionSynchronizer: dependencies.createSessionSynchronizer({
      home: gate.home,
      providerId: DEBUG_AGENT_PROVIDER_ID,
    }),
  };
}
