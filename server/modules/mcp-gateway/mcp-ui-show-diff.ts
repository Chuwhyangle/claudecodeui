/**
 * The MCP gateway's `ui_show_diff` handler (gap-mcp-ui-focus-turn-show-diff-open-task).
 *
 * The `ui_show_diff` FACE of {@link ./mcp-ui-navigation.js}: the target is a FILE
 * whose diff should be revealed in the Git panel, addressed by a path relative to
 * the session's project — the same path `ui_visible_context`'s `currentDiff` and
 * the Git panel already use, so no new concept is invented.
 *
 * The reveal does NOT change the active session: it switches the workspace to the
 * Git panel and expands that file's diff. The navigation record still anchors to
 * the session the caller named, but the frontend's applied-notification (which
 * feeds `ui_last_opened_session`) is deliberately NOT fired for a diff target —
 * revealing a diff is not opening a session, and `applyStatus` in
 * `ui-navigation.service.ts` gates on exactly that.
 */

import { z } from 'zod';

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
export const MCP_UI_SHOW_DIFF_RATE_LIMIT_PER_MINUTE = MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE;

/** The window the limit is measured over: one minute, the shared window binding. */
export const UI_SHOW_DIFF_RATE_WINDOW_MS = UI_NAVIGATION_RATE_WINDOW_MS;

/** The per-token throttle the handler consults before it does anything else. */
export type UiShowDiffRateLimiter = UiNavigationRateLimiter;

/** The options a criterion may override to drive the limiter without waiting a minute. */
export type UiShowDiffRateLimiterOptions = UiNavigationRateLimiterOptions;

/** Builds the per-token sliding-window limiter; the shared factory. */
export const createUiShowDiffRateLimiter = createUiNavigationRateLimiter;

// --------------------------- the tool's schemas ---------------------------

/**
 * The tool's arguments. `session` is the session whose project owns the file
 * (resolved by the AC-246 target gate); `filePath` is the path relative to that
 * project, required. `client` addresses one connected browser; omitted chooses
 * the only one.
 */
export const UI_SHOW_DIFF_INPUT_SCHEMA = {
  client: z.string().optional(),
  session: z.string(),
  filePath: z.string(),
};

/** The tool's reading: which navigation was asked for, in which browser, and how it landed. */
export const UI_SHOW_DIFF_OUTPUT_SCHEMA = UI_NAVIGATION_OUTPUT_SCHEMA;

/** The tool's arguments, read off the validated `args`. */
export type McpUiShowDiffInput = { client?: string; session: string; filePath: string };

/** The tool's reading. */
export type UiShowDiffPayload = UiNavigationToolPayload;

// --------------------------- injected services ---------------------------

/** What the tool answers from: the connected-device roster, the navigation service and the throttle. */
export type McpUiShowDiffDeps = UiNavigationToolDeps;

/** Whether the injected deps carry this tool's services, i.e. it is wired. */
export function isUiShowDiffWired(
  deps: McpWriteToolDeps,
): deps is McpWriteToolDeps & { uiShowDiff: McpUiShowDiffDeps } {
  return deps.uiShowDiff !== undefined;
}

// --------------------------- input ---------------------------

/** Reads the tool's arguments off the validated `args`. */
export function readUiShowDiffInput(args: Record<string, unknown>): McpUiShowDiffInput {
  return {
    session: readStringArg(args, 'session') ?? '',
    filePath: readStringArg(args, 'filePath') ?? '',
    client: readStringArg(args, 'client'),
  };
}

// --------------------------- the handler ---------------------------

/**
 * The `ui_show_diff` reading. The throttle, device resolution and attribution are
 * {@link buildUiNavigation}'s; this reads its target off the args and names
 * itself for the rate-limit refusal.
 */
export async function buildUiShowDiff(
  deps: McpUiShowDiffDeps,
  input: McpUiShowDiffInput,
  principal: McpPrincipal,
): Promise<UiShowDiffPayload> {
  return buildUiNavigation(
    deps,
    { client: input.client, sessionId: input.session, at: { diffFile: input.filePath } },
    principal,
    {
      name: 'ui_show_diff',
      rateLimitPerMinute: MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE,
      rateWindowMs: UI_NAVIGATION_RATE_WINDOW_MS,
    },
  );
}

// --------------------------- registration ---------------------------

/** One tool's metadata as `registerMcpWriteTools` hands it down. */
export type McpUiShowDiffRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
};

/**
 * Registers `ui_show_diff` through the audited write seam. NOT `protect`-wrapped,
 * for the same reason as `ui_open_session`. Unwired, it keeps a named refusal
 * naming this task as its owner.
 */
export function registerMcpUiShowDiffTool(
  seam: McpWriteToolSeam,
  deps: McpUiShowDiffDeps | null,
  registration: McpUiShowDiffRegistration,
): void {
  const full: McpUiNavigationRegistration = {
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    owner: 'gap-mcp-ui-focus-turn-show-diff-open-task',
    target: (args) => {
      const read = readUiShowDiffInput(args);
      return { client: read.client, sessionId: read.session, at: { diffFile: read.filePath } };
    },
  };
  registerMcpUiNavigationTool(seam, deps, full);
}
