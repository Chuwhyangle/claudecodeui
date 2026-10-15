/**
 * The MCP gateway's `session_send` handler (AC-249).
 *
 * `session_send` opens a chat run through the SAME control service the
 * WebSocket gateway and the scheduled-message timer use, and returns the run's
 * id IMMEDIATELY — the run keeps going after the tool call resolves. That
 * immediacy is structural, not a timeout: the wait loop lives only inside the
 * `waitSeconds > 0` branch (routed through AC-248's `buildRunGet`), so a
 * default-`waitSeconds` call has no `sleep` reachable from it at all.
 *
 * What this module owns is the ADAPTER half: the caller is the token's owner
 * (`{ userId, via: 'mcp' }`), the control service's structured refusals are
 * translated into {@link McpToolError}s the audit wrapper renders as the one
 * failure envelope (AC-284; the control service's `RUN_IN_PROGRESS` becomes the
 * gateway's `SESSION_BUSY`), and the two facts the control service cannot state — the run's
 * recorded `source` and, on `RUN_IN_PROGRESS`, the id of the run that is still
 * in flight — are read back from the run registry.
 *
 * Everything is injected ({@link McpSessionSendDeps}): the control seam, the run
 * reader, and the `run_get` builder plus its deps. Production wires the process
 * singletons (`server/index.ts`); the criterion wires the real control service
 * over its own fixture and the real `buildRunGet` over a fake clock. The module
 * holds no clock of its own — it never calls `Date.now()` or `setTimeout`, so
 * the bounded wait moves only through the injected `now`/`sleep` inside
 * `buildRunGet`.
 *
 * AC-272 adds the optional {@link McpSessionSendSelection}: when it is wired, an
 * options-less send reads the session's recorded model/effort/permissionMode and
 * puts them on the run, so a `session_reconfigure` a caller made is what the next
 * `session_send` actually runs with. Absent, the send is byte-identical to
 * AC-249's.
 *
 * gap-mcp-session-send-reports-pending-interaction-it-queued-behind adds the
 * optional {@link McpSessionSendApprovals}: a `queued: true` send names the
 * pending approval it was queued behind, read from the SAME pending set
 * `approvals_list` and `session_get` report (the runtime service's own lookup)
 * and projected through the ONE `toPendingInteraction` both of those tools use —
 * so a caller learns, in this single return, that a person is being waited on and
 * which tool to answer with, instead of reading a healthy park as a stall.
 *
 * AC-337 adds the optional opaque `correlationId` label. It is not sent to the
 * control service and it changes nothing about how a run is dispatched: when the
 * caller supplied a usable one, it is stamped onto the run this adapter just
 * opened ({@link McpRunReader.setRunCorrelationId}, addressed by run id) and it
 * rides the call's audit row through the wrapper's own reading of the argument.
 * With no label the send is byte-for-byte what it was — no registry write, no
 * extra argument.
 *
 * WHAT THIS ADAPTER DOES AND DOES NOT REJECT. This tool never refuses a send on
 * its OWN account: it only queues, it never auto-answers, and a `queued: false`
 * send is never blocked. A send that reached here has already been decided on —
 * the control service either opened a run or refused one (`SESSION_BUSY`), and
 * this adapter only translates. The BOUND on how MUCH text may be waiting (a
 * UTF-8 byte budget, not a message count) is NOT here: it belongs to the caller
 * that can see a backlog building, and the Live Voice relay enforces one before
 * it ever calls this adapter (`voice-realtime-ws-proxy.service.ts`,
 * `VOICE_QUEUE_MAX_BYTES` / `VOICE_QUEUE_FULL`). An MCP client calling
 * `session_send` directly is bounded only by the session's own queue, exactly as
 * before — this adapter's semantics are unchanged.
 */

import { z } from 'zod';

import type { HostInputPriority, LLMProvider, NormalizedMessage } from '@/shared/types.js';

import { toPendingInteraction } from './mcp-approvals.js';
import type { McpPendingInteraction } from './mcp-approvals.js';
import { MCP_CORRELATION_ID_INPUT_FIELD, readCorrelationId } from './mcp-correlation-id.js';
import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpApprovalReader } from './mcp-gateway.read-tools.js';
import { MCP_RUN_GET_MAX_WAIT_SECONDS } from './mcp-run-get.js';
import type { McpRunGetDeps, RunGetPayload } from './mcp-run-get.js';

// --------------------------- control-service vocabulary ---------------------------

/**
 * The caller `session_send` presents to the control service.
 *
 * `via: 'mcp'` is what makes the run this adapter opens record its origin as
 * `mcp` (the control service's `SOURCE_BY_VIA`), and `userId` is the token's
 * owner — never null, because the request reached the tool through the auth
 * middleware that attached the principal.
 */
export type McpControlCaller = {
  userId: string | number | null;
  via: 'mcp';
};

/** The refusals `session_send` translates. The vocabulary is the control service's own. */
export type McpControlRefusalCode =
  | 'SESSION_NOT_FOUND'
  | 'UNSUPPORTED_PROVIDER'
  | 'RUN_IN_PROGRESS'
  | 'FORBIDDEN';

/**
 * The control service result `session_send` reads, declared structurally.
 *
 * The control service's own `SendResult` is module-local, so the shape is
 * restated here as the injection contract — deliberately narrower than the real
 * one (it drops the `completion` promise), because the adapter must NOT await
 * the run's outcome when no wait was asked for. That omission is the structural
 * half of "immediate".
 */
export type McpControlSendResult =
  | { ok: true; runId: string; queued: boolean; queuedMessageUuid: string | null }
  | { ok: false; code: McpControlRefusalCode; message: string };

/** The one control verb `session_send` needs: opening a run. */
export type McpControlSeam = {
  send(
    caller: McpControlCaller,
    input: { sessionId: string; content: string; options?: Record<string, unknown> },
  ): Promise<McpControlSendResult>;
};

// --------------------------- run reading ---------------------------

/**
 * The slice of a run record `session_send` reads, declared structurally because
 * the registry's internal `ChatRun` is not exported.
 *
 * `source` is the run's recorded origin (the `mcp` reading this tool reports);
 * `writer.userId` is the authenticated owner the run was opened for, read back
 * so a caller can see the run really belongs to the token's owner.
 */
export type McpSessionRunRecord = {
  runId: string;
  source: string;
  status: string;
  writer?: { userId?: string | number | null };
};

/** The run reader `session_send` reads the current run and its origin from. */
export type McpRunReader = {
  getRun(sessionId: string): McpSessionRunRecord | undefined;
  /**
   * AC-337: stamps the opaque `correlationId` label on one run, addressed by its
   * own id — the id `session_send` / `session_create` were just handed. Called
   * only when the caller supplied a label, and only after the send answered, so
   * a label-less call never touches the registry at all.
   *
   * OPTIONAL on this seam for the same reason every other seam here is: a mount
   * that predates AC-337 — or a criterion that exercises these tools without a
   * registry — stays a valid `McpSessionSendDeps`. When absent, a labelled call
   * simply stamps nothing and the audit row is the only place the label lands.
   *
   * The member is named EXACTLY as the registry's own method, the same way
   * `getRun` above is: that convention is what makes `chatRunRegistry`
   * structurally satisfy this seam with no adapter, so production can hand the
   * registry over whole. Naming it anything else — this member was first written
   * as `setCorrelationId?`, and being optional it silently accepted the
   * registry, the mismatch surfacing only as a stamp that never happened on the
   * real service while every harness that hand-wrote an adapter stayed green.
   */
  setRunCorrelationId?(runId: string, correlationId: string): void;
};

/**
 * The `run_get` seam the bounded-wait branch routes through.
 *
 * `build` is AC-248's `buildRunGet` and `deps` its injected services (registry,
 * activity store, history reader, clock and sleeper). They are a seam rather
 * than an import so the criterion supplies the real builder over a fake clock.
 */
export type McpSessionRunGetSeam = {
  deps: McpRunGetDeps;
  build(input: { runId: string; waitSeconds?: number }, deps: McpRunGetDeps): Promise<RunGetPayload>;
};

/**
 * The two readers AC-272 uses to assemble an options-less send's run options.
 *
 * `session_send`'s input carries no model/effort/permissionMode (the SPEC's
 * argument shape is `{session, message, waitSeconds?}`), so when a caller has
 * just changed a session's stored selection with `session_reconfigure`, the
 * values have to be read back off the session row and put on the RUN — not left
 * to the provider runtime's own resume default, which covers the model only.
 * `sessions` names which provider the row belongs to (the selection lookup is
 * provider-scoped) and `models` reads the recorded model, effort and permission
 * mode.
 *
 * Optional as a whole, and absent means "do not assemble": AC-249's criterion
 * wires no selection reader, so its `session_send` keeps sending an options-less
 * run exactly as before. Production (`server/index.ts`) and AC-272's own
 * criterion wire the process singletons.
 */
export type McpSessionSendSelection = {
  sessions: { getSessionById(sessionId: string): { provider: string } | null | undefined };
  models: {
    resolveSessionModel(
      provider: LLMProvider,
      options: { sessionId: string },
    ): Promise<{ model: string | null; effort: string | null; permissionMode: string | null }>;
  };
};

/**
 * The pending-approval reader AC-273's `blockedBy` reading draws from.
 *
 * Structurally the read tools' own {@link McpApprovalReader} plus the clock the
 * `waitedMs` projection needs — the SAME `pendingForSession` lookup and the SAME
 * `toPendingInteraction` projection `approvals_list` / `session_get` use, so a
 * `session_send` queued behind a request cannot report a different id, tool,
 * questions or wait than either of those tools. Optional as a whole: absent, a
 * queued send reports `blockedBy: null` and behaves exactly as AC-249's did.
 */
export type McpSessionSendApprovals = McpApprovalReader & { now(): number };

/** The services `session_send` answers from, all injected. */
export type McpSessionSendDeps = {
  control: McpControlSeam;
  runs: McpRunReader;
  runGet: McpSessionRunGetSeam;
  /**
   * The stored-selection reader AC-272 adds (see
   * {@link McpSessionSendSelection}). Optional: absent keeps AC-249's
   * options-less send verbatim.
   */
  selection?: McpSessionSendSelection;
  /**
   * The pending-approval reader this task adds (see
   * {@link McpSessionSendApprovals}). Optional: absent keeps AC-249's payload
   * with `blockedBy: null`.
   */
  approvals?: McpSessionSendApprovals;
};

// --------------------------- input and payload ---------------------------

/** The `session_send` tool's typed input. */
export type McpSessionSendInput = {
  /** The session to send to; the transport's target gate resolves a name to an id first. */
  session: string;
  message: string;
  /** A bounded wait for the run to settle, in seconds; absent or `0` returns immediately. */
  waitSeconds?: number;
  /**
   * AC-337's opaque correlation label, when the caller supplied a usable one.
   * Absent is the whole of "no label": the send is then byte-for-byte what it was
   * before this field existed.
   */
  correlationId?: string;
  /**
   * The tier the frame THIS send writes should carry, when the caller named one.
   *
   * THE ONE CALLER THAT NAMES ONE IS THE LIVE VOICE RELAY, and it names `next`. Its busy
   * hold releases a merged message into a turn that is still running — the X3' replay
   * (2026-10-15) measured a p90 delivery delay of 10.8–18.5 s and a p90 first-reaction of
   * 14.0–22.5 s when that release instead waited the turn out — so the frame has to be
   * merged at the running turn's next tool boundary rather than queued behind it, which
   * is exactly what the tier says and exactly what a person's own busy send must NOT say
   * (`later` is their "after this", and it stays the default).
   *
   * DELIBERATELY NOT IN {@link SESSION_SEND_INPUT_SCHEMA}. The tier is not a parameter of
   * the TOOL: no MCP client declares it, the relay does not ask the model for it, and the
   * relay injects it into the argument bag one layer below the model's function call. A
   * field the transport validated would be a second, model-reachable way to set a tier
   * that only one internal caller is entitled to set — and it would make this module's
   * advertised schema disagree with the voice plane's mirror of it.
   *
   * Read through {@link readRequestedPriority}, so a value that is not one of the CLI's
   * three tiers is dropped rather than forwarded into a run's options.
   */
  priority?: HostInputPriority;
};

/** The `session_send` tool's Zod input shape, used for registration and validation. */
export const SESSION_SEND_INPUT_SCHEMA = {
  session: z.string(),
  message: z.string(),
  waitSeconds: z.number().optional(),
  // AC-337: the one declaration of the label's contract, splices in verbatim so
  // `tools/list` advertises exactly what the wrapper enforces (AC-288 (f)).
  correlationId: MCP_CORRELATION_ID_INPUT_FIELD.optional(),
} satisfies z.ZodRawShape;

/**
 * The `session_send` result.
 *
 * `source` is the run's recorded origin (`mcp` on every run this adapter opens).
 * `blockedBy` names the pending approval a `queued: true` send was queued
 * behind, or `null` when nothing is waiting on a person — the same reading
 * `session_get` reports as `pendingInteraction` and `approvals_list` reports (as
 * its entry, minus the session this call already named). `run` is attached ONLY
 * when the caller asked to wait, and is AC-248's own reading — its `outcome`, its
 * `lastAssistantMessage` and its final summary, all merged under one key rather
 * than restated here.
 */
export type SessionSendPayload = {
  runId: string;
  queued: boolean;
  queuedMessageUuid: string | null;
  source: string;
  blockedBy: McpPendingInteraction | null;
  run?: RunGetPayload;
};

/**
 * The advertised shape of `session_send`'s `blockedBy` reading — the same fields
 * `session_get` advertises for its `pendingInteraction` (which itself is
 * `approvals_list`'s entry minus `session`), so the three tools a client may use
 * to discover a park declare one shape.
 */
export const SESSION_SEND_BLOCKED_BY_SCHEMA = z.object({
  requestId: z.string(),
  toolName: z.string(),
  inputSummary: z.string(),
  interactive: z.boolean(),
  autoTimeoutMs: z.number().nullable(),
  waitedMs: z.number(),
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().optional(),
        options: z.array(
          z.object({
            label: z.string(),
            description: z.string().optional(),
            multiSelect: z.boolean().optional(),
          }),
        ),
      }),
    )
    .optional(),
});

/** The hint a `SESSION_BUSY` refusal carries. `run_get` is load-bearing. */
const RUN_IN_PROGRESS_HINT =
  'This session already has a run in progress; use run_get to follow it, or retry later.';

/** Reads and validates `session_send`'s arguments. */
export function readSessionSendInput(args: Record<string, unknown>): McpSessionSendInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  const message = args.message;
  if (typeof message !== 'string' || message.length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"message" is required and must be a non-empty string.',
    );
  }
  const waitSeconds =
    typeof args.waitSeconds === 'number' && Number.isFinite(args.waitSeconds) && args.waitSeconds > 0
      ? args.waitSeconds
      : undefined;
  // AC-337: read through the shared reader, so "no label" and "a label this
  // handler cannot use" are the same `undefined` — the declared schema is what
  // refuses an unusable one on the wire, and this is a reading, never a second
  // validation rule.
  const correlationId = readCorrelationId(args.correlationId) ?? undefined;
  const priority = readRequestedPriority(args.priority);
  return {
    session,
    message,
    waitSeconds,
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(priority === undefined ? {} : { priority }),
  };
}

/**
 * The tier a caller named for one send, or `undefined` when it named none this layer can use.
 *
 * The three values are {@link HostInputPriority}'s — the CLI's own vocabulary, checked on a value
 * because the argument bag is the caller's `Record<string, unknown>`. Anything else is dropped, so a
 * mistyped tier never reaches a run's options and never becomes a frame the process cannot honor.
 */
function readRequestedPriority(value: unknown): HostInputPriority | undefined {
  return value === 'now' || value === 'next' || value === 'later' ? value : undefined;
}

/** The effective wait, capped by AC-248's one literal: a positive request, else zero. */
function effectiveWaitSeconds(waitSeconds: number | undefined): number {
  if (waitSeconds === undefined) {
    return 0;
  }
  return Math.min(waitSeconds, MCP_RUN_GET_MAX_WAIT_SECONDS);
}

/**
 * Assembles the run options an options-less `session_send` should carry.
 *
 * Reads the session row's provider, then the model/effort/permissionMode
 * `session_reconfigure` (or an ordinary UI send) last recorded for it, and
 * returns them under the option names the dispatch path reads (`model`,
 * `effort`, `permissionMode`). A field with no recorded value is omitted rather
 * than sent as `null`, so a provider runtime's own default still applies to the
 * fields nobody set.
 *
 * Returns `undefined` when no selection reader was wired, when the session row
 * cannot be read, or when the row records none of the three values — in every
 * case the send proceeds exactly as it did before AC-272, options-less.
 */
async function resolveSendOptions(
  sessionId: string,
  selection: McpSessionSendSelection | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!selection) {
    return undefined;
  }

  const session = selection.sessions.getSessionById(sessionId);
  if (!session || typeof session.provider !== 'string' || session.provider.length === 0) {
    return undefined;
  }

  const recorded = await selection.models.resolveSessionModel(session.provider as LLMProvider, { sessionId });
  const options: Record<string, unknown> = {};
  if (typeof recorded.model === 'string' && recorded.model.length > 0) {
    options.model = recorded.model;
  }
  if (typeof recorded.effort === 'string' && recorded.effort.length > 0) {
    options.effort = recorded.effort;
  }
  if (typeof recorded.permissionMode === 'string' && recorded.permissionMode.length > 0) {
    options.permissionMode = recorded.permissionMode;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

// --------------------------- buildSessionSend ---------------------------

/**
 * Opens a run for `input.session` and returns its id at once.
 *
 * The caller is the token's owner, and the control service is asked to send with
 * it — so the run this opens is registered and dispatched through the identical
 * path a WebSocket `chat.send` uses, with origin `mcp`. On success the payload
 * is returned immediately; only a positive `waitSeconds` awaits AC-248's
 * `buildRunGet` (capped at {@link MCP_RUN_GET_MAX_WAIT_SECONDS}) and merges its
 * reading under `run`.
 *
 * A refusal is thrown as a {@link McpToolError}, which the audited seam renders
 * as the one failure envelope. `SESSION_BUSY` (the gateway's code for the
 * control service's `RUN_IN_PROGRESS`) is widened with the in-flight run's id
 * (the control service's message does not carry one) and a hint naming
 * `run_get` as the way to follow it.
 *
 * A `queued: true` send is widened with `blockedBy`: the pending request it is
 * parked behind, read through {@link McpSessionSendApprovals}. The default
 * `waitSeconds: 0` path is untouched — the `blockedBy` read happens after the run
 * id is in hand, so it never delays the immediate return.
 *
 * Consumers: `registerMcpWriteTools` (the registered handler) and this module's
 * criterion, which drives it through the real mount.
 */
export async function buildSessionSend(
  input: McpSessionSendInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionSendDeps,
): Promise<SessionSendPayload> {
  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const stored = await resolveSendOptions(input.session, deps.selection);
  // The caller's tier rides INSIDE the run's options, which is the one channel a run carries to the
  // host that writes its frames (`HostTurnInput.options`). Merged rather than replacing the stored
  // selection, and left off entirely when the caller named none — an ordinary send's options bag is
  // byte-for-byte what it was before this field existed.
  const options =
    input.priority === undefined ? stored : { ...(stored ?? {}), priority: input.priority };
  const result = await deps.control.send(caller, {
    sessionId: input.session,
    content: input.message,
    ...(options ? { options } : {}),
  });

  if (!result.ok) {
    if (result.code === 'RUN_IN_PROGRESS') {
      // The current run's id is read from the registry: the control service's
      // refusal message states the fact but not the id, and this is the one
      // reading that tells the caller WHICH run to follow. The busier's
      // vocabulary (`RUN_IN_PROGRESS`) is normalized to the gateway's one code
      // for the class (`SESSION_BUSY`), so every tool naming "the session is
      // busy" says the same thing (AC-284).
      const current = deps.runs.getRun(input.session);
      const message = result.message.trim().length > 0 ? result.message : RUN_IN_PROGRESS_HINT;
      throw new McpToolError(MCP_ERROR_CODES.SESSION_BUSY, message, true, {
        runId: current?.runId ?? null,
        hint: RUN_IN_PROGRESS_HINT,
      });
    }
    throw new McpToolError(result.code, result.message, true);
  }

  // AC-337: stamp the caller's opaque label onto the run this send opened. Done
  // HERE — after the control service answered with the run id, before the payload
  // is assembled — so a `sessions_list` read at any later instant sees it, and
  // addressed by run id so a send that SUPERSEDED a running turn labels the run
  // it actually opened rather than whatever now holds the session's slot. A send
  // that carried no label takes no branch and touches the registry not at all.
  if (input.correlationId !== undefined) {
    deps.runs.setRunCorrelationId?.(result.runId, input.correlationId);
  }

  const source = deps.runs.getRun(input.session)?.source ?? 'mcp';
  // A send that was QUEUED is one the session could not start now — and the one
  // reason that is worth naming is a pending approval: the queue is drained when
  // the current turn ends, and a turn parked on a person never ends on its own.
  // The reading is projected from the SAME pending set, through the SAME
  // `toPendingInteraction`, that `session_get` / `approvals_list` use, so all
  // three name one request at one instant. A send that opened a run
  // (`queued: false`) is never blocked, and a mount with no approval reader
  // reports `null` — the AC-249 payload unchanged.
  const blockedBy =
    result.queued && deps.approvals
      ? toPendingInteraction(deps.approvals.pendingForSession(input.session), deps.approvals.now())
      : null;
  const payload: SessionSendPayload = {
    runId: result.runId,
    queued: result.queued,
    queuedMessageUuid: result.queuedMessageUuid,
    source,
    blockedBy,
  };

  const waitSeconds = effectiveWaitSeconds(input.waitSeconds);
  if (waitSeconds > 0) {
    payload.run = await deps.runGet.build({ runId: result.runId, waitSeconds }, deps.runGet.deps);
  }

  return payload;
}
