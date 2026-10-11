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
  tool: 'session_send' | 'session_interrupt';
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
   * Where a refused `session_send` attempt is recorded. Required, not optional:
   * AC-310's whitelist must both REFUSE and RECORD, so a wiring that forgot to
   * pass a sink would silently drop the record the criterion reads.
   */
  onSessionRefusal: (refusal: VoiceRealtimeSessionRefusal) => void;
  /** The clock the refusal record is stamped from. Defaults to `Date.now`. */
  now?: () => number;
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
  const assertBoundSession = (tool: 'session_send' | 'session_interrupt', args: Record<string, unknown>): void => {
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
   * `session_interrupt`, behind the same whitelist.
   *
   * It reaches the gateway's OWN `buildSessionInterrupt`, whose only effect is
   * `control.abort` — the SAME verb the browser's stop and the MCP
   * `session_interrupt` tool call, so a spoken stop is one abort path, not two.
   */
  const sessionInterrupt = async (args: Record<string, unknown>): Promise<unknown> => {
    assertBoundSession('session_interrupt', args);
    const input = readSessionInterruptInput({ ...args, session: deps.boundSessionId });
    return buildSessionInterrupt(input, ctx, deps.sessionInterrupt);
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
  };
}
