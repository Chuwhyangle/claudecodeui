/**
 * The MCP gateway's stage-4 write tools (AC-249).
 *
 * This module owns the one statement of "which write tools exist at stage 4" and
 * the scope each requires: {@link MCP_STAGE4_WRITE_TOOLS} names exactly the five
 * tools the SPEC's stage-4 table lists, and {@link registerMcpWriteTools}
 * installs exactly those names through the audited registration seam AC-244
 * landed. A later task that fills in `session_create` (AC-250) or
 * `session_interrupt` / `session_start` / `session_close` (AC-251) replaces a
 * handler here; it must NOT add or rename a tool, because the name set is a
 * contract the self-referential guard (AC-252) reads to know which tools to
 * protect.
 *
 * `session_send` (AC-249), `session_create` / `session_interrupt` (AC-250) and
 * `session_start` / `session_close` (AC-251) are implemented. The stage-4 table
 * always lists all five names; a tool whose deps are absent still registers with
 * a body that throws a NAMED `MCP_TOOL_NOT_IMPLEMENTED` refusal pointing at its
 * owner. Registering every name keeps the set stable, so a later task replaces a
 * handler without touching the set.
 *
 * The AC-250 handlers are wired through optional deps ({@link McpWriteToolDeps.sessionCreate}
 * / {@link McpWriteToolDeps.sessionInterrupt}): a mount that supplies them gets
 * the real behaviour, while a mount that does not — AC-249's criterion, which
 * exercises only `session_send` — keeps the placeholder and its exact old
 * registration. AC-251's two handlers ride the same seam through
 * {@link McpWriteToolDeps.sessionHostControl}; supplying it swaps in
 * `buildSessionStart` / `buildSessionClose`, which delegate to the session-hosts
 * module's own resident start/close services.
 *
 * The scope literals come from AC-243's single scope vocabulary
 * (`ACCESS_TOKEN_SCOPES`) rather than being re-typed here; the array's order is
 * pinned by the OAuth module's own vocabulary criterion, so the positional read
 * cannot silently select the wrong scope.
 *
 * A SIXTH name rides this function without joining the table:
 * `ui_open_session` (gap-mcp-ui-open-session) is registered after the loop, from
 * {@link UI_OPEN_SESSION_TOOL_NAME} / {@link McpWriteToolDeps.uiOpenSession}. It
 * is not one of the five AC-249 pins, and it is not `protect`-wrapped — opening
 * the caller's own session is explicitly allowed, so `SELF_TARGET` must not fire.
 */

import { z } from 'zod';

import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';
import { readSessionTurn } from '@/modules/providers/index.js';

import type { McpPrincipal } from './mcp-gateway.auth.js';
import { McpToolError } from './mcp-error-envelope.js';
import {
  DRAFT_SET_DESCRIPTION,
  DRAFT_SET_INPUT_SCHEMA,
  DRAFT_SET_OUTPUT_SCHEMA,
  DRAFT_SET_TOOL_NAME,
  DRAFT_SUBMIT_DESCRIPTION,
  DRAFT_SUBMIT_INPUT_SCHEMA,
  DRAFT_SUBMIT_OUTPUT_SCHEMA,
  DRAFT_SUBMIT_TOOL_NAME,
  registerMcpDraftSetTool,
  registerMcpDraftSubmitTool,
} from './mcp-draft.js';
import type { McpDraftDeps } from './mcp-draft.js';
import { MCP_TOOL_NOT_IMPLEMENTED_CODE } from './mcp-gateway.read-tools.js';
import { MCP_CORRELATION_ID_DESCRIPTION } from './mcp-correlation-id.js';
import { buildSelfTargetGuard } from './mcp-self-target.js';
import type { SelfTargetDeps } from './mcp-self-target.js';
import {
  buildSessionCreate,
  buildSessionInterrupt,
  readSessionCreateInput,
  readSessionInterruptInput,
  SESSION_CREATE_INPUT_SCHEMA,
  SESSION_INTERRUPT_INPUT_SCHEMA,
} from './mcp-session-lifecycle.js';
import type { McpSessionCreateDeps, McpSessionInterruptDeps } from './mcp-session-lifecycle.js';
import {
  buildSessionClose,
  buildSessionStart,
  readSessionCloseInput,
  readSessionStartInput,
  SESSION_CLOSE_INPUT_SCHEMA,
  SESSION_START_INPUT_SCHEMA,
} from './mcp-session-host-control.js';
import type { McpSessionHostDeps } from './mcp-session-host-control.js';
import {
  buildSessionSend,
  readSessionSendInput,
  SESSION_SEND_BLOCKED_BY_SCHEMA,
  SESSION_SEND_INPUT_SCHEMA,
} from './mcp-session-send.js';
import type { McpSessionSendDeps } from './mcp-session-send.js';
import {
  isUiOpenSessionWired,
  registerMcpUiOpenSessionTool,
  UI_OPEN_SESSION_INPUT_SCHEMA,
  UI_OPEN_SESSION_OUTPUT_SCHEMA,
} from './mcp-ui-open-session.js';
import type { McpUiOpenSessionDeps } from './mcp-ui-open-session.js';
import {
  isUiFocusTurnWired,
  registerMcpUiFocusTurnTool,
  UI_FOCUS_TURN_INPUT_SCHEMA,
  UI_FOCUS_TURN_OUTPUT_SCHEMA,
} from './mcp-ui-focus-turn.js';
import type { McpUiFocusTurnDeps } from './mcp-ui-focus-turn.js';
import {
  isUiShowDiffWired,
  registerMcpUiShowDiffTool,
  UI_SHOW_DIFF_INPUT_SCHEMA,
  UI_SHOW_DIFF_OUTPUT_SCHEMA,
} from './mcp-ui-show-diff.js';
import type { McpUiShowDiffDeps } from './mcp-ui-show-diff.js';
import {
  isUiOpenTaskWired,
  registerMcpUiOpenTaskTool,
  UI_OPEN_TASK_INPUT_SCHEMA,
  UI_OPEN_TASK_OUTPUT_SCHEMA,
} from './mcp-ui-open-task.js';
import type { McpUiOpenTaskDeps } from './mcp-ui-open-task.js';

// --------------------------- scope vocabulary ---------------------------

// Positions within AC-243's vocabulary, in the order the constant declares and
// `access-token-scopes.test.ts` pins: read, session:send, session:create,
// session:control, approve, navigate. `navigate` was appended last so the five
// reads above keep their index.
const [, SESSION_SEND_SCOPE, SESSION_CREATE_SCOPE, SESSION_CONTROL_SCOPE, , NAVIGATE_SCOPE] =
  ACCESS_TOKEN_SCOPES;

/**
 * `ui_open_session`'s name and description. It is NOT one of AC-249's five — it
 * is registered alongside them by {@link registerMcpWriteTools} — but the
 * name/scope pair still lives here, next to the table, so the write-tool name set
 * has one statement.
 */
export const UI_OPEN_SESSION_TOOL_NAME = 'ui_open_session';

/** What `ui_open_session` says it does on `tools/list`. */
export const UI_OPEN_SESSION_DESCRIPTION =
  `Open a session in one of the connected browsers and position it, without waiting for the user. ${MCP_CORRELATION_ID_DESCRIPTION}`;

/**
 * The three sibling navigation tools (gap-mcp-ui-focus-turn-show-diff-open-task).
 * Same reasoning as {@link UI_OPEN_SESSION_TOOL_NAME}: not in AC-249's five, but
 * registered alongside them, so their names live here next to the table.
 */
export const UI_FOCUS_TURN_TOOL_NAME = 'ui_focus_turn';

/** What `ui_focus_turn` says it does on `tools/list`. */
export const UI_FOCUS_TURN_DESCRIPTION =
  `Focus one turn inside a session in one of the connected browsers, without waiting for the user. ${MCP_CORRELATION_ID_DESCRIPTION}`;

export const UI_SHOW_DIFF_TOOL_NAME = 'ui_show_diff';

/** What `ui_show_diff` says it does on `tools/list`. */
export const UI_SHOW_DIFF_DESCRIPTION =
  `Reveal a file's diff in the Git panel of one of the connected browsers, without waiting for the user. ${MCP_CORRELATION_ID_DESCRIPTION}`;

export const UI_OPEN_TASK_TOOL_NAME = 'ui_open_task';

/** What `ui_open_task` says it does on `tools/list`. */
export const UI_OPEN_TASK_DESCRIPTION =
  `Open a task's detail in one of the connected browsers, without waiting for the user. ${MCP_CORRELATION_ID_DESCRIPTION}`;

// --------------------------- the stage-4 write table ---------------------------

/**
 * What `session_send` says it does on `tools/list`.
 *
 * The second sentence is this task's: a send that lands `queued` because the
 * session is parked on a person is NOT an answer to the request it is queued
 * behind, so the description names the one tool that answers it
 * (`approval_answer`) — the front door a caller reads before deciding the park
 * is a stall.
 */
export const SESSION_SEND_DESCRIPTION =
  'Send a message to a session, returning the run id at once. A queued message does not answer a pending approval; use approval_answer to answer it. ' +
  MCP_CORRELATION_ID_DESCRIPTION;

/**
 * Every write tool this stage ships, with the scope a caller's token must carry.
 * The single source of truth for (a) "exactly this set": the criterion compares
 * the SDK's `tools/list` names against this array, the transport reads each
 * registration's `requiredScope` from here rather than restating the literal,
 * and AC-252 reads the names from here rather than writing a second copy.
 */
export const MCP_STAGE4_WRITE_TOOLS = [
  {
    name: 'session_send',
    requiredScope: SESSION_SEND_SCOPE,
    description: SESSION_SEND_DESCRIPTION,
  },
  {
    name: 'session_create',
    requiredScope: SESSION_CREATE_SCOPE,
    description: `Create a session. ${MCP_CORRELATION_ID_DESCRIPTION}`,
  },
  {
    name: 'session_interrupt',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Interrupt the current run of a session.',
  },
  {
    name: 'session_start',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Start a session.',
  },
  {
    name: 'session_close',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Close a session.',
  },
] as const;

/** One stage-4 write tool's name, derived from the table so the two cannot drift. */
export type McpStage4WriteToolName = (typeof MCP_STAGE4_WRITE_TOOLS)[number]['name'];

// --------------------------- injected services ---------------------------

/**
 * The services the write tools answer from, all injected.
 *
 * Production passes the process singletons (`server/index.ts`): the single chat
 * control service every front end shares (AC-233), the run registry, and AC-248's
 * `run_get` builder over its own deps. The criterion passes the same real
 * objects over its fixture.
 *
 * The three `session_send` services come from {@link McpSessionSendDeps} so
 * AC-272's optional stored-selection reader rides the same bag — a mount that
 * supplies it dispatches an options-less send under the session's recorded
 * model/effort/permissionMode; a mount that does not (AC-249's criterion) keeps
 * AC-249's exact options-less send.
 */
export type McpWriteToolDeps = McpSessionSendDeps & {
  /**
   * The services `session_create` answers from (AC-250). Optional so a mount
   * that only exercises `session_send` — AC-240/244/245/249's criteria — stays a
   * valid deps bag and keeps `session_create`'s placeholder. Supplying it swaps
   * in `buildSessionCreate`.
   */
  sessionCreate?: McpSessionCreateDeps;
  /**
   * The abort seam `session_interrupt` answers from (AC-250). Optional for the
   * same reason as {@link McpWriteToolDeps.sessionCreate}: absent keeps the
   * placeholder, present swaps in `buildSessionInterrupt`.
   */
  sessionInterrupt?: McpSessionInterruptDeps;
  /**
   * The resident host start/close services `session_start` / `session_close`
   * answer from (AC-251). Optional for the same reason as the two above: a mount
   * that does not supply it — AC-240/244/245/249's criteria, none of which drive
   * these two tools — keeps their `MCP_TOOL_NOT_IMPLEMENTED` placeholder and its
   * exact old registration. Present swaps in `buildSessionStart` /
   * `buildSessionClose`, which delegate every start and close to the
   * session-hosts module's own services (production: `createSessionHostControl`
   * over the session-hosts barrel).
   */
  sessionHostControl?: McpSessionHostDeps;
  /**
   * The self-referential guard's two seams (AC-252): the target session's live
   * turn reader and the gateway write-tool name set. Optional so a mount that
   * does not inject them — every criterion before AC-252 — keeps this module's
   * production default, `readSessionTurn` over `MCP_STAGE4_WRITE_TOOLS`' names.
   * The criterion injects its own turn reader and its own registry, which is how
   * leg (d) proves a newly added write tool is covered without a guard edit.
   */
  selfTarget?: SelfTargetDeps;
  /**
   * The `ui_open_session` services (gap-mcp-ui-open-session): the connected-device
   * roster, the navigation push, and the per-token throttle. Optional so a mount
   * that predates this task — or a criterion that exercises the other write tools
   * — is still a valid `McpWriteToolDeps`; when absent the tool keeps its named
   * `MCP_TOOL_NOT_IMPLEMENTED` refusal, when present `registerMcpWriteTools`
   * installs the real body. `server/index.ts` binds the process-wide singletons.
   */
  uiOpenSession?: McpUiOpenSessionDeps;
  /**
   * The three sibling navigation tools (gap-mcp-ui-focus-turn-show-diff-open-task):
   * `ui_focus_turn`, `ui_show_diff` and `ui_open_task`. Each is the same
   * device-roster / navigation-push / throttle bag as {@link McpWriteToolDeps.uiOpenSession},
   * optional for the same reason — and `server/index.ts` binds the SAME singletons
   * to all four, so one token's screen control is budgeted as a whole.
   */
  uiFocusTurn?: McpUiFocusTurnDeps;
  uiShowDiff?: McpUiShowDiffDeps;
  uiOpenTask?: McpUiOpenTaskDeps;
  /**
   * The per-session composer draft store (gap-mcp-draft-get-set-submit). Optional
   * so a mount that predates this task — or any criterion that exercises the
   * other write tools — is still a valid `McpWriteToolDeps`. When absent,
   * `draft_set` / `draft_submit` are simply NOT registered (the resident-tools
   * precedent rather than the `ui_*` placeholder: neither is one of AC-249's five,
   * so a mount that cannot serve them must not enlarge `tools/list`); when
   * present they are registered through {@link registerMcpDraftSetTool} /
   * {@link registerMcpDraftSubmitTool}, over the SAME `control` and `runs` this
   * bag already carries for `session_send`. `server/index.ts` binds it to
   * `sessionDraftsDb`.
   */
  draft?: McpDraftDeps;
};

// --------------------------- registration ---------------------------

/**
 * One write tool as it is handed to the registration seam.
 *
 * `outputSchema` is optional so the placeholder tools (no result schema) and
 * `session_send` (which declares one so its payload also reaches the client as
 * `structuredContent`) share one seam shape.
 */
export type McpWriteToolRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: { principal: McpPrincipal }) => unknown | Promise<unknown>;
};

/**
 * The seam `registerMcpWriteTools` installs through.
 *
 * The transport supplies one backed by AC-244's `withMcpAudit` (and, when wired,
 * AC-246's target gate), so every write tool inherits the single audit row and
 * the scope refusal without restating either. The criterion supplies a recording
 * seam, which is how it reads back the names and required scopes a registration
 * actually declared.
 */
export type McpWriteToolSeam = (registration: McpWriteToolRegistration) => void;

/**
 * The refusal a registered-but-unowned write tool answers with. AC-250 delivers
 * `session_create` and `session_interrupt`; AC-251 delivers `session_start` and
 * `session_close`.
 */
function notImplemented(name: McpStage4WriteToolName, owner: string): never {
  throw new McpToolError(
    MCP_TOOL_NOT_IMPLEMENTED_CODE,
    `${name} is registered by AC-249 but its behaviour is delivered by ${owner}.`,
    false,
    { tool: name, owner },
  );
}

/**
 * Which later task owns each placeholder tool's behaviour.
 *
 * Only reached when the matching optional deps are absent — the real handlers
 * (AC-249's `session_send`, AC-250's `session_create` / `session_interrupt`)
 * register ahead of this map, so the owner named here is informational for the
 * two that still lack behaviour.
 */
const PLACEHOLDER_OWNER: Record<McpStage4WriteToolName, string> = {
  session_send: 'AC-249',
  session_create: 'AC-250',
  session_interrupt: 'AC-250',
  session_start: 'AC-251',
  session_close: 'AC-251',
};

/**
 * Registers every stage-4 write tool exactly once.
 *
 * The scope comes from {@link MCP_STAGE4_WRITE_TOOLS} — the table is the one
 * place the pair (name, scope) is written down. `session_send`'s handler is
 * `buildSessionSend`; AC-250's two handlers are installed when their optional
 * deps are present; the rest throw a named `MCP_TOOL_NOT_IMPLEMENTED` refusal
 * owned by AC-250/AC-251, so the registered name set is stable across those
 * tasks.
 */
export function registerMcpWriteTools(seam: McpWriteToolSeam, deps: McpWriteToolDeps): void {
  const sessionCreate = deps.sessionCreate;
  const sessionInterrupt = deps.sessionInterrupt;
  const sessionHostControl = deps.sessionHostControl;

  // AC-252's guard, built once per registration over the injected seams. The
  // default reads the live turn through the providers barrel and takes the write
  // tool names from THIS module's table — the one statement of which write tools
  // exist — so a new row there widens the guard with no edit to the guard. A
  // caller that supplies `selfTarget` (the criterion, for legs (a)–(d)) overrides
  // both seams.
  const guard = buildSelfTargetGuard(
    deps.selfTarget ?? {
      readTurn: readSessionTurn,
      writeToolNames: MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name),
    },
  );
  // Wraps one tool body so the guard runs BEFORE it, over the session id AC-246's
  // target gate has already rewritten the `session` argument to. A refusal is
  // thrown as a JSON body (the audit wrapper renders it as an `isError` result);
  // the body is never entered, so the control and host services are never called.
  const protect = (
    name: string,
    handler: McpWriteToolRegistration['handler'],
  ): McpWriteToolRegistration['handler'] => {
    return (args, ctx) => {
      const targetSessionId = typeof args.session === 'string' ? args.session : '';
      const decision = guard({ op: name, targetSessionId });
      if (!decision.allowed) {
        throw new McpToolError(decision.code, decision.message);
      }
      return handler(args, ctx);
    };
  };

  for (const tool of MCP_STAGE4_WRITE_TOOLS) {
    if (tool.name === 'session_send') {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_SEND_INPUT_SCHEMA,
        // AC-385 / SPEC §8.1: `deliveryId` is the handle EVERY accepted send
        // answers with — the id the lifecycle frame's `commandUuid` states, and
        // the alias `queuedMessageUuid` carries while a send is queued. `runId`
        // is nullable because a resident send has no turn when it answers: inside
        // the run-id compat window it states the delivery id instead, past the
        // window it is `null` until the delivery binds a turn. Both must be
        // declared HERE, not only on `SessionSendPayload`: the SDK validates every
        // structured result against this shape, so a payload field the shape omits
        // is rejected as "must NOT have additional properties" and the tool stops
        // answering at all. `voice-realtime-tools.ts` mirrors this shape field for
        // field, and `tests/voice-realtime-bridge.test.ts` reds if the two drift.
        outputSchema: {
          deliveryId: z.string().nullable(),
          runId: z.string().nullable(),
          queued: z.boolean(),
          queuedMessageUuid: z.string().nullable(),
          source: z.string(),
          blockedBy: SESSION_SEND_BLOCKED_BY_SCHEMA.nullable(),
          run: z.unknown().optional(),
        },
        handler: protect(tool.name, (args, ctx) => buildSessionSend(readSessionSendInput(args), ctx, deps)),
      });
      continue;
    }
    if (tool.name === 'session_create' && sessionCreate !== undefined) {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_CREATE_INPUT_SCHEMA,
        // AC-385 / SPEC §8.1: a create carrying a first message answers with the
        // delivery that message was accepted as, and with the same nullable
        // `runId` `session_send` states (null while a resident create has no
        // bound turn past the compat window). A create with no message returns
        // `{ sessionId }` alone — both fields are optional here, and the SDK's
        // output shape makes every declared field optional anyway.
        outputSchema: { sessionId: z.string(), deliveryId: z.string().nullable(), runId: z.string().nullable() },
        // AC-337: the create's optional correlationId is stamped through the SAME
        // run registry `session_send` writes through — the bag already carries it,
        // so the registration site is where the two halves are joined rather than
        // a second `McpSessionCreateDeps` assembly (the `draft_submit` precedent
        // a few lines below: `{ ...draft, control: deps.control, runs: deps.runs }`).
        handler: protect(tool.name, (args, ctx) =>
          buildSessionCreate(readSessionCreateInput(args), ctx, { ...sessionCreate, runs: deps.runs }),
        ),
      });
      continue;
    }
    if (tool.name === 'session_interrupt' && sessionInterrupt !== undefined) {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_INTERRUPT_INPUT_SCHEMA,
        outputSchema: { aborted: z.boolean(), message: z.string().optional() },
        handler: protect(tool.name, (args, ctx) =>
          buildSessionInterrupt(readSessionInterruptInput(args), ctx, sessionInterrupt),
        ),
      });
      continue;
    }
    if (tool.name === 'session_start' && sessionHostControl !== undefined) {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_START_INPUT_SCHEMA,
        outputSchema: { hostId: z.string(), sessionId: z.string(), mode: z.string(), pid: z.number().nullable() },
        handler: protect(tool.name, (args, ctx) =>
          buildSessionStart(readSessionStartInput(args), ctx, sessionHostControl),
        ),
      });
      continue;
    }
    if (tool.name === 'session_close' && sessionHostControl !== undefined) {
      seam({
        name: tool.name,
        description: tool.description,
        requiredScope: tool.requiredScope,
        inputSchema: SESSION_CLOSE_INPUT_SCHEMA,
        outputSchema: {
          hostId: z.string(),
          sessionId: z.string(),
          mode: z.string(),
          closeReason: z.string(),
          leases: z.array(z.unknown()),
        },
        handler: protect(tool.name, (args, ctx) =>
          buildSessionClose(readSessionCloseInput(args), ctx, sessionHostControl),
        ),
      });
      continue;
    }
    seam({
      name: tool.name,
      description: tool.description,
      requiredScope: tool.requiredScope,
      inputSchema: {},
      handler: protect(tool.name, () => notImplemented(tool.name, PLACEHOLDER_OWNER[tool.name])),
    });
  }

  // gap-mcp-ui-open-session: a SIXTH write tool, registered alongside the five
  // above rather than in `MCP_STAGE4_WRITE_TOOLS` (whose length is AC-249's own
  // pinned contract). It is deliberately NOT passed through `protect`: opening
  // the caller's own session neither interrupts nor queues a run, so the
  // self-target guard must not fire on it. Unwired, it keeps a named refusal so
  // its name stays on `tools/list` for the annotation / error-code records.
  registerMcpUiOpenSessionTool(seam, isUiOpenSessionWired(deps) ? deps.uiOpenSession : null, {
    name: UI_OPEN_SESSION_TOOL_NAME,
    description: UI_OPEN_SESSION_DESCRIPTION,
    requiredScope: NAVIGATE_SCOPE,
    inputSchema: UI_OPEN_SESSION_INPUT_SCHEMA,
    outputSchema: UI_OPEN_SESSION_OUTPUT_SCHEMA,
  });

  // gap-mcp-ui-focus-turn-show-diff-open-task: three MORE navigation tools, each
  // the same shape as `ui_open_session` — same scope, same throttle, same device
  // policy — differing only in the target they reveal. Also NOT `protect`-wrapped
  // (a reveal interrupts no run), and each keeps a named refusal when unwired so
  // its name stays on `tools/list` for the annotation / error-code records.
  registerMcpUiFocusTurnTool(seam, isUiFocusTurnWired(deps) ? deps.uiFocusTurn : null, {
    name: UI_FOCUS_TURN_TOOL_NAME,
    description: UI_FOCUS_TURN_DESCRIPTION,
    requiredScope: NAVIGATE_SCOPE,
    inputSchema: UI_FOCUS_TURN_INPUT_SCHEMA,
    outputSchema: UI_FOCUS_TURN_OUTPUT_SCHEMA,
  });
  registerMcpUiShowDiffTool(seam, isUiShowDiffWired(deps) ? deps.uiShowDiff : null, {
    name: UI_SHOW_DIFF_TOOL_NAME,
    description: UI_SHOW_DIFF_DESCRIPTION,
    requiredScope: NAVIGATE_SCOPE,
    inputSchema: UI_SHOW_DIFF_INPUT_SCHEMA,
    outputSchema: UI_SHOW_DIFF_OUTPUT_SCHEMA,
  });
  registerMcpUiOpenTaskTool(seam, isUiOpenTaskWired(deps) ? deps.uiOpenTask : null, {
    name: UI_OPEN_TASK_TOOL_NAME,
    description: UI_OPEN_TASK_DESCRIPTION,
    requiredScope: NAVIGATE_SCOPE,
    inputSchema: UI_OPEN_TASK_INPUT_SCHEMA,
    outputSchema: UI_OPEN_TASK_OUTPUT_SCHEMA,
  });

  // gap-mcp-draft-get-set-submit: two more write tools, registered alongside the
  // five above rather than in `MCP_STAGE4_WRITE_TOOLS` (whose length is AC-249's
  // own pinned contract) and only when their store is wired. Both carry
  // `SESSION_SEND_SCOPE` — the scope `session_send` itself requires, because
  // staging text a caller can then send, and sending it, are the same authority.
  // Neither is `protect`-wrapped: `draft_set` merely stores unsent text and
  // `draft_submit` opens a run through the same control service `session_send`
  // already guards, so the self-target rule is unchanged by them. `submit` gets
  // the SAME `control` and `runs` seams this function already holds, so it cannot
  // reach a second send path.
  if (deps.draft !== undefined) {
    const draft = deps.draft;
    registerMcpDraftSetTool(seam, draft, {
      name: DRAFT_SET_TOOL_NAME,
      description: DRAFT_SET_DESCRIPTION,
      requiredScope: SESSION_SEND_SCOPE,
      inputSchema: DRAFT_SET_INPUT_SCHEMA,
      outputSchema: DRAFT_SET_OUTPUT_SCHEMA,
    });
    registerMcpDraftSubmitTool(seam, { ...draft, control: deps.control, runs: deps.runs }, {
      name: DRAFT_SUBMIT_TOOL_NAME,
      description: DRAFT_SUBMIT_DESCRIPTION,
      requiredScope: SESSION_SEND_SCOPE,
      inputSchema: DRAFT_SUBMIT_INPUT_SCHEMA,
      outputSchema: DRAFT_SUBMIT_OUTPUT_SCHEMA,
    });
  }
}
