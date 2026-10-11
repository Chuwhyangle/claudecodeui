/**
 * The MCP gateway's `ui_focus_turn` handler (gap-mcp-ui-focus-turn-show-diff-open-task).
 *
 * `ui_open_session` (gap-mcp-ui-open-session) settled the shape every `ui_*`
 * navigation tool reuses — name ONE device, do not wait for the user, rate limit
 * per token, name the asker — and that shape lives ONCE in
 * {@link ./mcp-ui-navigation.js}. This module is the `ui_focus_turn` FACE of it:
 * the target is a TURN inside a named session, addressed by the turn's
 * `messageAnchorId` (the spec's turn id), rather than the session's tail.
 *
 * Unlike `ui_open_session`'s optional `at`, the target here is not optional: a
 * tool whose whole job is "focus THIS turn" has no sensible default, so
 * `turnId` is required and the caller must have read it from
 * `ui_visible_context` / `session_read` rather than guessed it.
 *
 * Everything else — the throttle, the device resolution, the `resolveClientName`
 * attribution, the `cloudcli:navigate` scope and the accept/ask/reject policy
 * flow — is {@link buildUiNavigation}'s, shared verbatim with the other three
 * tools; this module adds no parallel implementation.
 */

import { z } from 'zod';

import { MCP_CORRELATION_ID_INPUT_FIELD } from './mcp-correlation-id.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpWriteToolDeps, McpWriteToolSeam } from './mcp-gateway.write-tools.js';
import {
  buildUiNavigation,
  createUiNavigationRateLimiter,
  MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE,
  registerMcpUiNavigationTool,
  readStringArg,
  UI_NAVIGATION_OUTPUT_SCHEMA,
  UI_NAVIGATION_RATE_WINDOW_MS,
} from './mcp-ui-navigation.js';
import type {
  McpUiNavigationRegistration,
  UiNavigationRateLimiter,
  UiNavigationRateLimiterOptions,
  UiNavigationToolDeps,
  UiNavigationToolPayload,
} from './mcp-ui-navigation.js';

// --------------------------- the rate limit ---------------------------

/** Calls allowed per minute: the shared navigation limit, the same binding. */
export const MCP_UI_FOCUS_TURN_RATE_LIMIT_PER_MINUTE = MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE;

/** The window the limit is measured over: one minute, the shared window binding. */
export const UI_FOCUS_TURN_RATE_WINDOW_MS = UI_NAVIGATION_RATE_WINDOW_MS;

/** The per-token throttle the handler consults before it does anything else. */
export type UiFocusTurnRateLimiter = UiNavigationRateLimiter;

/** The options a criterion may override to drive the limiter without waiting a minute. */
export type UiFocusTurnRateLimiterOptions = UiNavigationRateLimiterOptions;

/** Builds the per-token sliding-window limiter; the shared factory. */
export const createUiFocusTurnRateLimiter = createUiNavigationRateLimiter;

// --------------------------- the tool's schemas ---------------------------

/**
 * The tool's arguments. `session` is the session the turn lives in (resolved to
 * an id by the AC-246 target gate before the body runs); `turnId` is the turn's
 * `messageAnchorId`, required because "focus a turn" without naming one is not a
 * request. `client` addresses one connected browser; omitted chooses the only one.
 */
export const UI_FOCUS_TURN_INPUT_SCHEMA = {
  client: z.string().optional(),
  session: z.string(),
  turnId: z.string(),
  // AC-337: the opaque label. A reveal opens no run, so this tool only records
  // it on the call's audit row.
  correlationId: MCP_CORRELATION_ID_INPUT_FIELD.optional(),
};

/** The tool's reading: which navigation was asked for, in which browser, and how it landed. */
export const UI_FOCUS_TURN_OUTPUT_SCHEMA = UI_NAVIGATION_OUTPUT_SCHEMA;

/** The tool's arguments, read off the validated `args`. */
export type McpUiFocusTurnInput = { client?: string; session: string; turnId: string };

/** The tool's reading. */
export type UiFocusTurnPayload = UiNavigationToolPayload;

// --------------------------- injected services ---------------------------

/** What the tool answers from: the connected-device roster, the navigation service and the throttle. */
export type McpUiFocusTurnDeps = UiNavigationToolDeps;

/** Whether the injected deps carry this tool's services, i.e. it is wired. */
export function isUiFocusTurnWired(
  deps: McpWriteToolDeps,
): deps is McpWriteToolDeps & { uiFocusTurn: McpUiFocusTurnDeps } {
  return deps.uiFocusTurn !== undefined;
}

// --------------------------- input ---------------------------

/** Reads the tool's arguments off the validated `args`. */
export function readUiFocusTurnInput(args: Record<string, unknown>): McpUiFocusTurnInput {
  return {
    session: readStringArg(args, 'session') ?? '',
    turnId: readStringArg(args, 'turnId') ?? '',
    client: readStringArg(args, 'client'),
  };
}

// --------------------------- the handler ---------------------------

/**
 * The `ui_focus_turn` reading.
 *
 * The throttle, the device resolution, the requester attribution and the record
 * projection are {@link buildUiNavigation}'s; this function only reads its
 * target off the args and names itself for the rate-limit refusal. The returned
 * `status` is the DELIVERY reading — it never awaits a `ui.navigate_result`.
 */
export async function buildUiFocusTurn(
  deps: McpUiFocusTurnDeps,
  input: McpUiFocusTurnInput,
  principal: McpPrincipal,
): Promise<UiFocusTurnPayload> {
  return buildUiNavigation(
    deps,
    { client: input.client, sessionId: input.session, at: { turnId: input.turnId } },
    principal,
    {
      name: 'ui_focus_turn',
      rateLimitPerMinute: MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE,
      rateWindowMs: UI_NAVIGATION_RATE_WINDOW_MS,
    },
  );
}

// --------------------------- registration ---------------------------

/** One tool's metadata as `registerMcpWriteTools` hands it down. */
export type McpUiFocusTurnRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
};

/**
 * Registers `ui_focus_turn` through the audited write seam. Like `ui_open_session`
 * it is NOT `protect`-wrapped: moving a user's view neither interrupts nor queues
 * a run, so `SELF_TARGET` must not fire. Unwired, it keeps a named refusal naming
 * this task as its owner.
 */
export function registerMcpUiFocusTurnTool(
  seam: McpWriteToolSeam,
  deps: McpUiFocusTurnDeps | null,
  registration: McpUiFocusTurnRegistration,
): void {
  const full: McpUiNavigationRegistration = {
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    owner: 'gap-mcp-ui-focus-turn-show-diff-open-task',
    target: (args) => {
      const read = readUiFocusTurnInput(args);
      return { client: read.client, sessionId: read.session, at: { turnId: read.turnId } };
    },
  };
  registerMcpUiNavigationTool(seam, deps, full);
}
