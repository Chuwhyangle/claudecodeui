/**
 * The MCP gateway's `ui_open_session` handler (gap-mcp-ui-open-session).
 *
 * This was the first tool that changes what the USER'S SCREEN shows, and it is
 * built to keep that fact honest rather than convenient:
 *
 *  - IT NAMES ONE DEVICE. `session` follows AC-246's existing target rules (an id
 *    or a unique title substring), and `client` addresses ONE connected browser;
 *    with exactly one device online `client` may be omitted; with several it is
 *    REQUIRED, and with none the tool reports `NO_CLIENT`.
 *  - IT DOES NOT WAIT FOR THE USER. The navigation service resolves with the
 *    DELIVERY reading and the tool returns at that moment; an `ask`-policy device
 *    answers `pending_user` and its human decides later.
 *  - IT IS RATE LIMITED PER TOKEN, and
 *  - IT NAMES THE ASKER through the gateway's ONE principal-name resolution.
 *
 * Those four behaviours now live in {@link ./mcp-ui-navigation.js}, the shared
 * body every `ui_*` navigation tool runs. This module is the `ui_open_session`
 * FACE of it: the session-open target shape (`{ latest }` / `{ messageId }`) and
 * the re-exported constants the rest of the code, the barrel and the criterion
 * already name `ui_open_session`'s own. The re-exports are deliberately the SAME
 * bindings the shared module owns, so the tool's limit and the three sibling
 * tools' limit cannot drift.
 *
 * What comes back is the RECORD the navigation service minted, projected to the
 * fields a caller acts on: the `navigationId` it can look the record up by, the
 * resolved device, and the delivery `status`.
 */

import { z } from 'zod';

import type { UiNavigationPosition } from '@/shared/types.js';

import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpWriteToolDeps, McpWriteToolSeam } from './mcp-gateway.write-tools.js';
import {
  buildUiNavigation,
  createUiNavigationRateLimiter,
  MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE,
  registerMcpUiNavigationTool,
  resolveUiNavigationDevice,
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

/**
 * How many times ONE token may call `ui_open_session` inside
 * {@link UI_OPEN_SESSION_RATE_WINDOW_MS}. The value IS the shared navigation
 * limit ({@link MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE}) — the same binding, not
 * a copy — so a later sibling tool cannot move the bar without moving this too.
 */
export const MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE = MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE;

/** The window the limit is measured over: one minute. The shared window binding. */
export const UI_OPEN_SESSION_RATE_WINDOW_MS = UI_NAVIGATION_RATE_WINDOW_MS;

/** The per-token throttle the handler consults before it does anything else. */
export type UiOpenSessionRateLimiter = UiNavigationRateLimiter;

/** The options a criterion may override to drive the limiter without waiting a minute. */
export type UiOpenSessionRateLimiterOptions = UiNavigationRateLimiterOptions;

/** Builds the per-token sliding-window limiter; the shared factory's `ui_open_session` name. */
export const createUiOpenSessionRateLimiter = createUiNavigationRateLimiter;

// --------------------------- the tool's schemas ---------------------------

/** Where in the session to land: the newest message (default) or one by id. */
export const UI_OPEN_SESSION_AT_SCHEMA = z.union([
  z.object({ latest: z.literal(true) }),
  z.object({ messageId: z.string() }),
]);

/**
 * The tool's arguments. `session` and `client` are resolved before the body runs
 * (the AC-246 target gate rewrites `session`; the shared body resolves `client`).
 * `at` is optional and defaults to `{ latest: true }`.
 */
export const UI_OPEN_SESSION_INPUT_SCHEMA = {
  client: z.string().optional(),
  session: z.string(),
  at: UI_OPEN_SESSION_AT_SCHEMA.optional(),
};

/** The tool's reading: which navigation was asked for, in which browser, and how it landed. */
export const UI_OPEN_SESSION_OUTPUT_SCHEMA = UI_NAVIGATION_OUTPUT_SCHEMA;

/** The tool's arguments, read off the validated `args`. */
export type McpUiOpenSessionInput = {
  client?: string;
  session: string;
  at?: UiNavigationPosition;
};

/** The tool's reading. */
export type UiOpenSessionPayload = UiNavigationToolPayload;

// --------------------------- injected services ---------------------------

/**
 * What the tool answers from: the connected-device roster, the navigation
 * service, and the per-token limiter — the shared navigation-tool deps.
 */
export type McpUiOpenSessionDeps = UiNavigationToolDeps;

/** Whether the injected deps carry this tool's services, i.e. it is wired. */
export function isUiOpenSessionWired(
  deps: McpWriteToolDeps,
): deps is McpWriteToolDeps & { uiOpenSession: McpUiOpenSessionDeps } {
  return deps.uiOpenSession !== undefined;
}

// --------------------------- device resolution ---------------------------

/**
 * Resolves the ONE device to open the session in — the shared navigation-device
 * resolution, re-exported under its `ui_open_session` name.
 */
export const resolveUiOpenSessionDevice = resolveUiNavigationDevice;

// --------------------------- input ---------------------------

/** Reads the landing position off validated args, defaulting to the newest message. */
function readPosition(value: unknown): UiNavigationPosition {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.latest === true) {
      return { latest: true };
    }
    if (typeof record.messageId === 'string' && record.messageId.length > 0) {
      return { messageId: record.messageId };
    }
  }
  return { latest: true };
}

/**
 * Reads the tool's arguments off the validated `args`.
 *
 * The audited wrapper has already enforced {@link UI_OPEN_SESSION_INPUT_SCHEMA}
 * before this runs, so a missing `session` is impossible by the time the handler
 * is entered; the default below is the same "newest message" the schema's optional
 * `at` documents.
 */
export function readUiOpenSessionInput(args: Record<string, unknown>): McpUiOpenSessionInput {
  const session = typeof args.session === 'string' ? args.session : '';
  const client = typeof args.client === 'string' ? args.client : undefined;
  return { session, client, at: readPosition(args.at) };
}

// --------------------------- the handler ---------------------------

/**
 * The `ui_open_session` reading.
 *
 * Order matters: the throttle is consulted FIRST (a refused call must not have
 * resolved or touched a device), then the device is resolved, and only then is
 * the navigation written. The returned `status` is the DELIVERY reading — this
 * function never awaits a `ui.navigate_result`. The body itself is the shared
 * {@link buildUiNavigation}.
 *
 * Consumers: {@link registerMcpUiOpenSessionTool}, and the criterion, which calls
 * it over a fake navigation service.
 */
export async function buildUiOpenSession(
  deps: McpUiOpenSessionDeps,
  input: McpUiOpenSessionInput,
  principal: McpPrincipal,
): Promise<UiOpenSessionPayload> {
  const read = readUiOpenSessionInput({
    session: input.session,
    client: input.client,
    at: input.at,
  });
  return buildUiNavigation(
    deps,
    { client: input.client, sessionId: input.session, at: read.at ?? { latest: true } },
    principal,
    {
      name: 'ui_open_session',
      rateLimitPerMinute: MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE,
      rateWindowMs: UI_NAVIGATION_RATE_WINDOW_MS,
    },
  );
}

// --------------------------- registration ---------------------------

/**
 * One tool's metadata as `registerMcpWriteTools` hands it down. The name,
 * description and scope come from the caller — the write-tools module is the one
 * statement of the name set.
 */
export type McpUiOpenSessionRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
};

/**
 * Registers `ui_open_session` through the audited write seam.
 *
 * The handler is NOT wrapped by the self-target guard: opening the caller's own
 * session neither interrupts nor queues a run, so `SELF_TARGET` must not fire
 * (the task's AC says so explicitly). Consumers: `mcp-gateway.write-tools.js`'s
 * `registerMcpWriteTools` (the single call site).
 */
export function registerMcpUiOpenSessionTool(
  seam: McpWriteToolSeam,
  deps: McpUiOpenSessionDeps | null,
  registration: McpUiOpenSessionRegistration,
): void {
  const full: McpUiNavigationRegistration = {
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    owner: 'gap-mcp-ui-open-session',
    target: (args) => {
      const read = readUiOpenSessionInput(args);
      return { client: read.client, sessionId: read.session, at: read.at ?? { latest: true } };
    },
  };
  registerMcpUiNavigationTool(seam, deps, full);
}
