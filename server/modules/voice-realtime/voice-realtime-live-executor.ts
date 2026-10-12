/**
 * The live executor: the Realtime bridge's routing table, bound to the REAL
 * in-process services (GOAL-031 / AC-310).
 *
 * WHY IT EXISTS. `docs/proposals/voice-native-control-plane.md` wants a spoken
 * intent to become a real Claude Code turn. Until now every executor that drove
 * the bridge was a fixture: `experiments/voice-realtime-ambiguity/run-real.mjs`
 * answered function calls from pre-written readings, and nothing reached the
 * `ChatControlService` a UI send uses. This module is the missing wire — the
 * routing table `connect` looks a function call up in, whose handlers are the
 * gateway's OWN build functions, not a second copy of their behaviour. The
 * paired-evidence reading (`docs/experiments/2026-10-09-voice-realtime-real-
 * paired.md`) came back GO, so the next step it named is this one: a real
 * session_send, not a fixture.
 *
 * WHY IT IS A SEPARATE MODULE FROM THE BRIDGE. `voice-realtime-bridge.service.ts`
 * imports only a type and reaches no module at runtime — it must stay an
 * offline-provable leaf. THIS file is the opposite by design: it imports the MCP
 * gateway's barrel (and therefore express, the database and the whole server
 * boot) because its one job is to reach those real services. Consumers:
 * `server/index.ts` (a later task opens a real Realtime connection over it) and
 * this module's criteria, which drive it over fake services.
 *
 * THE SECURITY BOUNDARY IS A PARAMETER WHITELIST, NOT AN APPROVAL LAYER. A voice
 * connection is opened FOR one app session; that id is injected here as
 * `boundSessionId` and is the only session `session_send` can ever act on. A
 * function call that names a DIFFERENT session is refused and recorded (its raw
 * attempt is handed to `onSessionRefusal` for later troubleshooting), never
 * silently rewritten onto the bound one and never allowed to reach the other
 * session. This adds NO permission mode, NO consent flow and NO confirmation
 * dialog: `canUseTool`, `approval_answer` and every existing scope check are
 * untouched — the whitelist is the whole boundary (AC4).
 *
 * The six read tools are deliberately NOT bound: they are read-only, and the
 * operation the whitelist pins down is WHICH SESSION A SPOKEN INTENT MAY ACT ON.
 */
import {
  buildApprovalsList,
  buildRunGet,
  buildSessionBackground,
  buildSessionDetail,
  buildSessionInterrupt,
  buildSessionSend,
  buildUiVisibleContext,
  MCP_ERROR_CODES,
  McpToolError,
  readSessionInterruptInput,
  readSessionSendInput,
  type McpApprovalsDeps,
  type McpApprovalsListInput,
  type McpPrincipal,
  type McpReadToolDeps,
  type McpRunGetDeps,
  type McpRunGetInput,
  type McpSessionBackgroundDeps,
  type McpSessionBackgroundInput,
  type McpSessionInterruptDeps,
  type McpSessionSendDeps,
  type McpUiVisibleContextDeps,
  type McpUiVisibleContextInput,
} from '@/modules/mcp-gateway/index.js';

import type { RealtimeToolExecutor } from './voice-realtime-bridge.service.js';
import {
  VOICE_QUEUE_MAX_BYTES,
  type VoiceRealtimeExecStatusReading,
} from './voice-realtime-ws-proxy.service.js';

/**
 * The two fields the VOICE plane's `session_interrupt` declares and the MCP gateway's does not
 * (SPEC §6.2: `intent` required, `heard` optional — see `voice-realtime-tools.ts`).
 *
 * They live in one list because they are removed in one place: the executor's `session_interrupt`
 * route reads and checks `intent`, then hands the gateway a bag with both fields gone. Declaring the
 * set once is what keeps "the MCP client's view of this tool is unchanged" a property of the code
 * rather than of two literals that could drift apart.
 */
const VOICE_INTERRUPT_ONLY_FIELDS: readonly string[] = ['intent', 'heard'];

/** Whether an interrupt argument belongs to the voice plane alone. */
function isVoiceInterruptOnlyField(key: string): boolean {
  return VOICE_INTERRUPT_ONLY_FIELDS.includes(key);
}

/**
 * The argument bag the MCP gateway's `session_interrupt` handler is handed for a voice stop: the
 * model's call with the voice plane's own fields removed and `session` forced onto the bound id.
 *
 * EXPORTED, and not inlined into the route, because it IS the compatibility boundary AC4 names: the
 * claim "an MCP client's view of this tool is unchanged" is a claim about THIS transform, and a
 * criterion has to be able to hand it a bag carrying `intent`/`heard` and read back a bag that does
 * not. Inlined, the only way to observe it would be through `readSessionInterruptInput`, which
 * narrows to `{ session }` on its own — so an assertion made there would stay green even with the
 * strip deleted. Same reason `diffToolSchemas` is exported.
 *
 * `session` is FORCED rather than passed through, for the same reason `sessionSend` forces it: the
 * value that reaches the control service is the connection's, never anything the model supplied.
 */
export function voiceInterruptGatewayArgs(
  args: Record<string, unknown>,
  boundSessionId: string,
): Record<string, unknown> {
  const gatewayArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isVoiceInterruptOnlyField(key)) {
      continue;
    }
    gatewayArgs[key] = value;
  }
  gatewayArgs.session = boundSessionId;
  return gatewayArgs;
}

/**
 * Checks the voice plane's mandatory `intent`, refusing a stop that does not carry one.
 *
 * It answers nothing: the value itself is the PROXY's to record (see `writeInterruptAudit` in
 * `voice-realtime-ws-proxy.service.ts`), and the gateway — the only consumer below this line — has no
 * column for it. What this route owes the contract is the REFUSAL, which is why the function is named
 * for the check and not for the read.
 *
 * The wording mirrors the gateway's own readers (`readSessionInterruptInput` says `"session" is
 * required and must be a non-empty string.`) because this is the SAME kind of refusal one layer out:
 * an argument error whose text names the field, so the model is told which one to supply rather than
 * left with a stop that silently did nothing. `McpToolError` with `INVALID_ARGUMENT` is the gateway's
 * canonical envelope for it, and the bridge renders its message into the `TOOL_EXECUTION_FAILED`
 * frame the model reads.
 */
function assertVoiceInterruptIntent(args: Record<string, unknown>): void {
  const intent = args.intent;
  if (typeof intent !== 'string' || intent.trim() === '') {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"intent" is required and must be a non-empty string: a stop is a judgement, so say what you took the user to want.',
    );
  }
}

/**
 * The identity a voice connection acts as.
 *
 * A voice connection is FIRST-PARTY: it presents no PAT and reaches no HTTP
 * endpoint, so it has neither a token nor an OAuth client. Only the two fields
 * the gateway's builders actually read are carried here — `userId` (the owner
 * whose sessions the run is opened for, which the control service stamps onto
 * the run and the sender of `approvals_list` / `session_background`) and
 * `scopes` (forwarded unchanged to the gateway's own checks, e.g.
 * `session_background`'s `cloudcli:session:control` stop gate). {@link toPrincipal}
 * adapts this onto the gateway's `McpPrincipal`, whose token-only fields are
 * inert for a first-party caller.
 */
export type VoiceRealtimeCaller = {
  userId: number;
  scopes: readonly string[];
};

/**
 * One refused `session_send` attempt: the original call the model made that
 * named a session other than the bound one, kept so a human can see WHAT was
 * attempted. This is a troubleshooting record, never an approval input.
 */
export type VoiceRealtimeSessionRefusal = {
  /** The bounded tool whose call named a foreign session. */
  tool: 'session_send' | 'session_interrupt' | 'session_status';
  /** The only session this connection may act on. */
  boundSessionId: string;
  /** The raw `session` value the function call carried. */
  requestedSession: unknown;
  /** The function call's arguments, verbatim. */
  rawArguments: Record<string, unknown>;
  /** When the refusal was recorded, from the injected clock. */
  at: number;
};

/**
 * The error the executor throws for a refused bounded-tool call.
 *
 * The bridge catches a throwing handler and reports it through `onError` as
 * `TOOL_EXECUTION_FAILED`, so a refusal reaches the model as a failed tool call
 * rather than as a silent success — which is the point: the model is told the
 * call did not happen. {@link VoiceRealtimeSessionRefusalError.refusal} carries
 * the same record handed to `onSessionRefusal`.
 */
export class VoiceRealtimeSessionRefusalError extends Error {
  readonly refusal: VoiceRealtimeSessionRefusal;

  constructor(refusal: VoiceRealtimeSessionRefusal) {
    super(
      `${refusal.tool} may only act on the bound session "${refusal.boundSessionId}"; refused a call naming ${JSON.stringify(refusal.requestedSession)}.`,
    );
    this.name = 'VoiceRealtimeSessionRefusalError';
    this.refusal = refusal;
  }
}

/**
 * Everything the live executor answers from — all injected, so the criteria can
 * drive it over fakes while production hands it the process's own services.
 *
 * The service bags are the SAME bags the MCP gateway's own handlers are
 * built over (`server/index.ts` already assembles them); this module re-uses
 * them rather than reaching for a singleton, which is what lets the criteria
 * substitute a fake `ChatControlService` and a fake gateway on every call.
 */
export type VoiceRealtimeLiveExecutorDeps = {
  /** The one app session this voice connection is bound to. The whitelist's root. */
  boundSessionId: string;
  /** The first-party identity the connection acts as. */
  caller: VoiceRealtimeCaller;
  /** `ui_visible_context`'s round trip to the connected browsers. */
  visibleContext: McpUiVisibleContextDeps;
  /** `session_get`'s session/host/run readers. */
  readTools: McpReadToolDeps;
  /** `run_get`'s run reader, activity store and clock. */
  runGet: McpRunGetDeps;
  /** `approvals_list`'s pending-approvals reader. */
  approvals: McpApprovalsDeps;
  /** `session_background`'s lease snapshot and stop seam. */
  sessionBackground: McpSessionBackgroundDeps;
  /** `session_send`'s control seam, run reader and `run_get` builder. */
  sessionSend: McpSessionSendDeps;
  /**
   * `session_interrupt`'s control seam — the SAME abort verb the browser's own
   * stop button and the MCP gateway's `session_interrupt` reach, injected rather
   * than rebuilt here so a spoken stop is not a second, divergent abort path.
   */
  sessionInterrupt: McpSessionInterruptDeps;
  /**
   * Where `session_status` reads the execution plane: the SAME L3 aggregator
   * reading the injected S-A status line was rendered from (SPEC §6.3's first
   * bullet forbids a second, disagreeing computation). Optional so the executor's
   * existing criteria — which drive the other tools and never ask for a status —
   * keep compiling; production wires it in `server/index.ts`.
   *
   * `reading()` returns the LAST reading the aggregator handed out beside an
   * injection, or `null` before any line has ever gone out. It is deliberately NOT
   * a live poll: the reading is event-driven (SPEC §8.2), so a tool that re-read
   * the clock would be a second source. `maxBytes` is the effective queue budget
   * the reading is judged against; omitted, {@link VOICE_QUEUE_MAX_BYTES} — the
   * value this deployment's proxy uses unless `maxQueuedVoiceBytes` overrides it,
   * which is not threaded here because a criterion pins the default.
   */
  sessionStatus?: VoiceRealtimeSessionStatusSource;
  /**
   * Where a refused `session_send` attempt is recorded. Required, not optional:
   * AC-310's whitelist must both REFUSE and RECORD, so a wiring that forgot to
   * pass a sink would silently drop the record the criterion reads.
   */
  onSessionRefusal: (refusal: VoiceRealtimeSessionRefusal) => void;
  /** The clock the refusal record is stamped from. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * The `session_status` tool's window onto the execution plane: the ONE aggregator
 * reading the injected status line came from, plus the queue budget it is measured
 * against.
 *
 * Kept to two fields (a reading and a number) so the executor never reaches for the
 * proxy's internals beyond the reading type, and so a criterion can hand it a fixed
 * reading without standing up a whole connection. The reading's shape is
 * {@link VoiceRealtimeExecStatusReading} — the proxy module's own, deep-imported here
 * because the two are the SAME feature module and forcing a mirror of it would be the
 * second reading SPEC §8.2 exists to forbid.
 */
export type VoiceRealtimeSessionStatusSource = {
  /** The last reading the aggregator published beside an injection, or `null` before any. */
  reading(): VoiceRealtimeExecStatusReading | null;
  /** The effective queue budget in bytes. Defaults to {@link VOICE_QUEUE_MAX_BYTES}. */
  maxBytes?: number;
};

/**
 * Adapts the first-party {@link VoiceRealtimeCaller} onto the gateway's
 * `McpPrincipal`.
 *
 * A first-party voice connection presents no token, so `tokenId`/`clientId` have
 * no value to carry; every gateway builder this executor calls reads only
 * `userId` and `scopes`, so the two placeholders are inert. They exist to satisfy
 * the gateway's contract, not to assert a token identity.
 */
function toPrincipal(caller: VoiceRealtimeCaller): McpPrincipal {
  return { userId: caller.userId, tokenId: 0, clientId: null, scopes: [...caller.scopes] };
}

/**
 * Builds the executor the Realtime bridge routes function calls through.
 *
 * Every read tool handler delegates to the MCP gateway's own exported build
 * function for that tool, over the injected services and with its arguments
 * passed through unchanged — the same code path the gateway's registered
 * handlers take, so a behaviour change on the gateway side reaches voice at
 * once. `session_send` is the one handler with a guard in front of it: see
 * {@link VoiceRealtimeLiveExecutorDeps.boundSessionId}'s description and
 * {@link VoiceRealtimeSessionRefusal}.
 *
 * Consumers: `server/index.ts` (production wiring) and this module's positive
 * and false-form criteria.
 */
export function createVoiceRealtimeLiveExecutor(
  deps: VoiceRealtimeLiveExecutorDeps,
): RealtimeToolExecutor {
  const principal = toPrincipal(deps.caller);
  const ctx = { principal };
  const readNow = deps.now ?? Date.now;

  /**
   * The whitelist guard both bounded tools share.
   *
   * A call that names a session other than `boundSessionId` is refused and
   * recorded before any service is reached, and a call that names none passes
   * through (for a first-party connection "bound" means "the one the connection
   * opened onto"). The refusal is thrown so the bridge reports it, and recorded
   * so the raw attempt is not lost. It is ONE helper rather than a guard copied
   * into each handler so the wording and the record shape cannot drift between
   * the two tools; the criterion that proves the guard is load-bearing mutates
   * this one line.
   */
  const assertBoundSession = (
    tool: 'session_send' | 'session_interrupt' | 'session_status',
    args: Record<string, unknown>,
  ): void => {
    if (args.session !== undefined && args.session !== deps.boundSessionId) {
      const refusal: VoiceRealtimeSessionRefusal = {
        tool,
        boundSessionId: deps.boundSessionId,
        requestedSession: args.session,
        rawArguments: { ...args },
        at: readNow(),
      };
      deps.onSessionRefusal(refusal);
      throw new VoiceRealtimeSessionRefusalError(refusal);
    }
  };

  /**
   * `session_send`, behind the whitelist.
   *
   * The session the send targets is ALWAYS `boundSessionId`. `readSessionSendInput`
   * is the gateway's OWN reader (the same one its registered `session_send` handler
   * uses); forcing `session` onto the bound id here is what makes the whitelist
   * total — the value that reaches the control service is the bound id, never
   * anything the model supplied.
   */
  const sessionSend = async (args: Record<string, unknown>): Promise<unknown> => {
    assertBoundSession('session_send', args);
    const input = readSessionSendInput({ ...args, session: deps.boundSessionId });
    return buildSessionSend(input, ctx, deps.sessionSend);
  };

  /**
   * `session_interrupt`, behind the same whitelist, plus the voice plane's own two fields.
   *
   * It reaches the gateway's OWN `buildSessionInterrupt`, whose only effect is
   * `control.abort` — the SAME verb the browser's stop and the MCP
   * `session_interrupt` tool call, so a spoken stop is one abort path, not two.
   *
   * WHY THIS ROUTE HAS A READER THE OTHER ROUTES DO NOT. The voice plane's `session_interrupt`
   * declares two fields the gateway's does not ({@link VOICE_INTERRUPT_ONLY_FIELDS}), and the shape of
   * the contract is that they are the VOICE plane's: an MCP client calling the same tool must keep
   * seeing exactly the arguments it always saw. So `intent` is read and checked HERE, then dropped —
   * together with `heard` — before the gateway's own `readSessionInterruptInput` runs. The gateway
   * therefore receives a bag it would have received from any MCP client, and the reading SPEC §6.2
   * makes mandatory (the model's own statement of what it took the user to want) never reaches a layer
   * that has no column for it.
   *
   * A MISSING `intent` IS REFUSED, NOT DEFAULTED. The field is required by the descriptor precisely
   * because a stop is a judgement, and the whole point of C-3's audit is that the judgement is on the
   * record. Recording an absent one as `''` — or quietly aborting anyway — would produce exactly the
   * un-auditable stop the criterion exists to forbid, so the call fails as an argument error naming
   * the field. The proxy turns that refusal into an `outcome: 'refused'` audit line before it reaches
   * the model, so a refused stop is still recorded as an ATTEMPT.
   */
  const sessionInterrupt = async (args: Record<string, unknown>): Promise<unknown> => {
    assertBoundSession('session_interrupt', args);
    assertVoiceInterruptIntent(args);
    // The strip: the voice plane's own fields come off, every OTHER argument is carried through, so a
    // field the gateway's schema gains later still arrives (see {@link voiceInterruptGatewayArgs}).
    const input = readSessionInterruptInput(voiceInterruptGatewayArgs(args, deps.boundSessionId));
    return buildSessionInterrupt(input, ctx, deps.sessionInterrupt);
  };

  /**
   * `session_status`, behind the same whitelist, reading the L3 aggregator.
   *
   * The reading is the SAME object the injected status line was rendered from (SPEC §6.3's first
   * bullet: "读的是 L3 聚合的同一份状态，不是自己翻 CLI"), so the tool's `statusSeq` IS the line's
   * `statusSeq` — no re-derivation, no second source to disagree with it (SPEC §8.2's whole point).
   *
   * THREE FIELDS §6.3 names are answered with a documented `null` rather than recomputed, because
   * the L3 reading honestly does not carry them:
   *
   *  - `startedAt` — the reading carries `elapsedMs` but not the run's start stamp. Deriving it as
   *    `now - elapsedMs` would be exactly the second, disagreeing computation §8.2 forbids, so it
   *    stays `null` until the aggregator carries one.
   *  - `lastDelivery` — the proxy has no event source for the previous delivery's size/time; the
   *    reading's queue fields are what it does know.
   *  - `pendingInteraction.inputSummary` — the aggregated pending interaction carries only
   *    `{requestId, toolName}` (the two fields §8.3 keys the dedup on); the full summary lives in
   *    the gateway's own `approvals_list` / `session_get` reading, and inventing one here would be
   *    a third copy. It is `''`.
   *
   * `elapsedMs` is `null` when there is no run (idle, or only messages queued), which is what §6.3's
   * `number|null` is for — an idle session has no elapsed time to report.
   */
  const sessionStatus = async (args: Record<string, unknown>): Promise<unknown> => {
    assertBoundSession('session_status', args);
    const reading = deps.sessionStatus?.reading() ?? null;
    const pending = reading?.pendingInteraction ?? null;
    const hasRun = reading !== null && reading.runId !== null;
    return {
      sessionId: deps.boundSessionId,
      phase: reading?.phase ?? 'idle',
      runId: reading?.runId ?? null,
      elapsedMs: hasRun ? reading!.elapsedMs : null,
      startedAt: null,
      queuedItems: reading?.queuedItems ?? 0,
      queuedBytes: reading?.queuedBytes ?? 0,
      maxBytes: deps.sessionStatus?.maxBytes ?? VOICE_QUEUE_MAX_BYTES,
      lastDelivery: null,
      pendingInteraction:
        pending === null
          ? null
          : { requestId: pending.requestId, toolName: pending.toolName, inputSummary: '' },
      statusSeq: reading?.statusSeq ?? 0,
      at: reading?.at ?? 0,
    };
  };

  return {
    ui_visible_context: (args) =>
      buildUiVisibleContext(deps.visibleContext, args as McpUiVisibleContextInput),
    session_get: (args) => buildSessionDetail(deps.readTools, args.session as string),
    run_get: (args) => buildRunGet(args as McpRunGetInput, deps.runGet),
    approvals_list: (args) => buildApprovalsList(args as McpApprovalsListInput, ctx, deps.approvals),
    session_background: (args) =>
      buildSessionBackground(args as McpSessionBackgroundInput, ctx, deps.sessionBackground),
    session_send: sessionSend,
    session_interrupt: sessionInterrupt,
    session_status: sessionStatus,
  };
}
