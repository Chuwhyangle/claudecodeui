/**
 * The MCP gateway's `ui_open_task` handler (gap-mcp-ui-focus-turn-show-diff-open-task).
 *
 * The `ui_open_task` FACE of {@link ./mcp-ui-navigation.js}: the target is a TASK
 * whose detail should be opened in the browser, addressed by the task's id.
 *
 * Carrier, verified rather than invented: the UI's task surface is the
 * TaskMaster panel (`src/modules/task-master/TaskMasterPanel.tsx`), whose detail
 * modal is the only "open a task" view in the app. The task store the panel reads
 * is quay's (a read-only mirror from the browser's side) — so this tool opens the
 * panel's DETAIL for a task it already lists; it does not mutate anything. The
 * panel is always mounted (hidden by `isVisible`), which is what lets a reveal
 * reach it before the workspace switches to the Tasks tab.
 *
 * As with `ui_show_diff`, the reveal does not change the active session, so the
 * applied-notification that feeds `ui_last_opened_session` is NOT fired for a
 * task target.
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
export const MCP_UI_OPEN_TASK_RATE_LIMIT_PER_MINUTE = MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE;

/** The window the limit is measured over: one minute, the shared window binding. */
export const UI_OPEN_TASK_RATE_WINDOW_MS = UI_NAVIGATION_RATE_WINDOW_MS;

/** The per-token throttle the handler consults before it does anything else. */
export type UiOpenTaskRateLimiter = UiNavigationRateLimiter;

/** The options a criterion may override to drive the limiter without waiting a minute. */
export type UiOpenTaskRateLimiterOptions = UiNavigationRateLimiterOptions;

/** Builds the per-token sliding-window limiter; the shared factory. */
export const createUiOpenTaskRateLimiter = createUiNavigationRateLimiter;

// --------------------------- the tool's schemas ---------------------------

/**
 * The tool's arguments. `session` anchors the navigation record (resolved by the
 * AC-246 target gate); `taskId` is the quay task id the panel should open,
 * required. `client` addresses one connected browser; omitted chooses the only
 * one.
 */
export const UI_OPEN_TASK_INPUT_SCHEMA = {
  client: z.string().optional(),
  session: z.string(),
  taskId: z.string(),
};

/** The tool's reading: which navigation was asked for, in which browser, and how it landed. */
export const UI_OPEN_TASK_OUTPUT_SCHEMA = UI_NAVIGATION_OUTPUT_SCHEMA;

/** The tool's arguments, read off the validated `args`. */
export type McpUiOpenTaskInput = { client?: string; session: string; taskId: string };

/** The tool's reading. */
export type UiOpenTaskPayload = UiNavigationToolPayload;

// --------------------------- injected services ---------------------------

/** What the tool answers from: the connected-device roster, the navigation service and the throttle. */
export type McpUiOpenTaskDeps = UiNavigationToolDeps;

/** Whether the injected deps carry this tool's services, i.e. it is wired. */
export function isUiOpenTaskWired(
  deps: McpWriteToolDeps,
): deps is McpWriteToolDeps & { uiOpenTask: McpUiOpenTaskDeps } {
  return deps.uiOpenTask !== undefined;
}

// --------------------------- input ---------------------------

/** Reads the tool's arguments off the validated `args`. */
export function readUiOpenTaskInput(args: Record<string, unknown>): McpUiOpenTaskInput {
  return {
    session: readStringArg(args, 'session') ?? '',
    taskId: readStringArg(args, 'taskId') ?? '',
    client: readStringArg(args, 'client'),
  };
}

// --------------------------- the handler ---------------------------

/**
 * The `ui_open_task` reading. The throttle, device resolution and attribution are
 * {@link buildUiNavigation}'s; this reads its target off the args and names
 * itself for the rate-limit refusal.
 */
export async function buildUiOpenTask(
  deps: McpUiOpenTaskDeps,
  input: McpUiOpenTaskInput,
  principal: McpPrincipal,
): Promise<UiOpenTaskPayload> {
  return buildUiNavigation(
    deps,
    { client: input.client, sessionId: input.session, at: { taskId: input.taskId } },
    principal,
    {
      name: 'ui_open_task',
      rateLimitPerMinute: MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE,
      rateWindowMs: UI_NAVIGATION_RATE_WINDOW_MS,
    },
  );
}

// --------------------------- registration ---------------------------

/** One tool's metadata as `registerMcpWriteTools` hands it down. */
export type McpUiOpenTaskRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
};

/**
 * Registers `ui_open_task` through the audited write seam. NOT `protect`-wrapped,
 * for the same reason as `ui_open_session`. Unwired, it keeps a named refusal
 * naming this task as its owner.
 */
export function registerMcpUiOpenTaskTool(
  seam: McpWriteToolSeam,
  deps: McpUiOpenTaskDeps | null,
  registration: McpUiOpenTaskRegistration,
): void {
  const full: McpUiNavigationRegistration = {
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    owner: 'gap-mcp-ui-focus-turn-show-diff-open-task',
    target: (args) => {
      const read = readUiOpenTaskInput(args);
      return { client: read.client, sessionId: read.session, at: { taskId: read.taskId } };
    },
  };
  registerMcpUiNavigationTool(seam, deps, full);
}
