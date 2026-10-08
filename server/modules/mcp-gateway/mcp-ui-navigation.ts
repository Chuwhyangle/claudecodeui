/**
 * The machinery the gateway's `ui_*` navigation tools share
 * (gap-mcp-ui-focus-turn-show-diff-open-task).
 *
 * `ui_open_session` (gap-mcp-ui-open-session) was the first tool that changes
 * what the USER'S SCREEN shows, and it settled the shape every later one reuses:
 *
 *  - IT NAMES ONE DEVICE. `client` addresses ONE connected browser — an exact
 *    device id, or a unique substring of the device's id or name. With exactly
 *    one device online `client` may be omitted; with several it is REQUIRED (the
 *    refusal lists the candidates), and with none the tool reports `NO_CLIENT`.
 *  - IT DOES NOT WAIT FOR THE USER. The navigation service resolves with the
 *    DELIVERY reading and the tool returns at that moment; an `ask`-policy device
 *    answers `pending_user` and its human decides later.
 *  - IT IS RATE LIMITED PER TOKEN, and
 *  - IT NAMES THE ASKER through the gateway's ONE principal-name resolution.
 *
 * Rather than copy that body three more times, this module owns it ONCE. Every
 * `ui_*` tool is a thin module over {@link buildUiNavigation} /
 * {@link registerMcpUiNavigationTool}, differing only in its name, its `at`
 * target shape and its schema. The rate limit, the device resolution and the
 * requester attribution are therefore literally the same code — not a parallel
 * re-implementation that could drift.
 *
 * Consumers: `mcp-ui-open-session.ts`, `mcp-ui-focus-turn.ts`,
 * `mcp-ui-show-diff.ts` and `mcp-ui-open-task.ts` (the four async builders plus
 * their registrations), and their criteria.
 */

import { z } from 'zod';

import type { UiClientDevice, UiNavigationPosition, UiNavigationRecord } from '@/shared/types.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_TOOL_NOT_IMPLEMENTED_CODE } from './mcp-gateway.read-tools.js';
import type {
  McpWriteToolRegistration,
  McpWriteToolSeam,
} from './mcp-gateway.write-tools.js';
// The gateway's ONE principal-name resolution, shared with the write
// notifications so the name on the bar and the name an operator sees cannot drift.
import { resolveClientName } from './mcp-write-notification.js';

// --------------------------- the rate limit ---------------------------

/**
 * How many times ONE token may call a `ui_*` navigation tool inside
 * {@link UI_NAVIGATION_RATE_WINDOW_MS}. Fixed in code on purpose: the permission
 * the tools need is the scope, and the rate limit is a safety rail against a
 * runaway agent, not a per-user setting.
 *
 * Every `ui_*` tool reads THIS constant (via `ui_open_session`'s re-exported
 * {@link MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE} alias), so the limit cannot
 * differ between the tools that move a user's screen.
 */
export const MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE = 6;

/** The window the limit is measured over: one minute. */
export const UI_NAVIGATION_RATE_WINDOW_MS = 60_000;

/** The per-token throttle a navigation handler consults before it does anything else. */
export type UiNavigationRateLimiter = {
  /**
   * True when this call is allowed. False when the key has already made the
   * limit's worth of calls inside the window — the refused call is NOT counted,
   * so a caller that keeps hammering does not extend its own penalty.
   */
  allow(key: string): boolean;
};

/** The options a criterion may override to drive the limiter without waiting a minute. */
export type UiNavigationRateLimiterOptions = {
  /** Calls allowed per window; defaults to {@link MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE}. */
  limit?: number;
  /** The window length; defaults to {@link UI_NAVIGATION_RATE_WINDOW_MS}. */
  windowMs?: number;
  /** The clock; defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Builds a per-key sliding-window limiter.
 *
 * Production builds ONE of these per server run (`server/index.ts`) and hands the
 * SAME instance to every `ui_*` tool's deps, because the MCP server itself is
 * built per request: the throttle only exists if its state outlives a single
 * call — and sharing it means a token's screen control is budgeted as a whole.
 */
export function createUiNavigationRateLimiter(
  options: UiNavigationRateLimiterOptions = {},
): UiNavigationRateLimiter {
  const limit = options.limit ?? MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE;
  const windowMs = options.windowMs ?? UI_NAVIGATION_RATE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  /** One key's recent call timestamps, oldest first. */
  const hits = new Map<string, number[]>();

  return {
    allow(key) {
      const moment = now();
      const recent = (hits.get(key) ?? []).filter((at) => at > moment - windowMs);
      if (recent.length >= limit) {
        // The refused call is not recorded: the window is a reading of what was
        // allowed, so a caller in penalty cannot push its own expiry out.
        hits.set(key, recent);
        return false;
      }
      recent.push(moment);
      hits.set(key, recent);
      return true;
    },
  };
}

// --------------------------- injected services ---------------------------

/**
 * What a `ui_*` tool answers from: the connected-device roster, the navigation
 * service, and the per-token limiter.
 *
 * All injected so `server/index.ts` can bind the process-wide singletons while a
 * criterion drives its own fakes — and so the limiter's state is owned by the
 * composition root rather than by a per-request closure.
 */
export type UiNavigationToolDeps = {
  /** Every connected device, the same listing `ui_clients_list` publishes. */
  listUiClients: () => UiClientDevice[];
  /** The navigation push: write a `ui.navigate` and resolve with its delivery reading. */
  navigate: (request: {
    deviceId: string;
    deviceName: string;
    sessionId: string;
    at: UiNavigationPosition;
    requestedBy: string | null;
  }) => Promise<UiNavigationRecord>;
  /**
   * The throttle, consulted once per call BEFORE device resolution. Optional: a
   * mount without it performs no rate limiting.
   */
  rateLimiter?: UiNavigationRateLimiter;
  /**
   * Resolves the asking client's human-readable name for the confirmation bar
   * and the navigation record. Optional: it defaults to the gateway's ONE
   * principal resolver ({@link resolveClientName}), so a mount that does not care
   * about the label is still wired to the real resolution rather than a copy.
   */
  resolveClientName?: (principal: McpPrincipal) => string;
};

/** Whether a deps bag carries the services a `ui_*` tool answers from. */
export function hasUiNavigationDeps(deps: Record<string, unknown>, key: string): boolean {
  return deps[key] !== undefined;
}

/**
 * Reads one string field off validated args, or undefined when it is absent.
 *
 * The audited wrapper has already enforced each tool's schema, so the read is a
 * narrowing rather than a validation — but a `_`-typed arg bag still reaches
 * here as `Record<string, unknown>`, and every `ui_*` tool's target reader needs
 * exactly this.
 */
export function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

// --------------------------- the tool's reading ---------------------------

/**
 * The reading every `ui_*` navigation tool returns: which navigation was asked
 * for, in which browser, and how it landed. Shared verbatim across the four
 * tools so `ui_visible_context` and a caller read the same field set.
 */
export const UI_NAVIGATION_OUTPUT_SCHEMA = {
  navigationId: z.string(),
  device: z.object({ deviceId: z.string(), deviceName: z.string() }),
  sessionId: z.string(),
  status: z.enum([
    'applied',
    'declined',
    'pending_user',
    'unresponsive',
    'ignored',
    'superseded',
    'expired',
  ]),
  tabId: z.string().nullable(),
};

/** The reading, as a type. */
export type UiNavigationToolPayload = {
  navigationId: string;
  device: { deviceId: string; deviceName: string };
  sessionId: string;
  status: UiNavigationRecord['status'];
  tabId: string | null;
};

// --------------------------- device resolution ---------------------------

/** Whether a device matches one query: an exact `deviceId`, or the substring in either of its names. */
function deviceMatches(device: UiClientDevice, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    device.deviceId.toLowerCase().includes(needle) || device.deviceName.toLowerCase().includes(needle)
  );
}

/** The candidate shape a refusal carries so the caller can retry with a real device. */
function candidatesOf(devices: readonly UiClientDevice[]): { id: string; name: string; tabs: number }[] {
  return devices.map((device) => ({
    id: device.deviceId,
    name: device.deviceName,
    tabs: device.tabs.length,
  }));
}

/**
 * Resolves the ONE device to write the navigation to.
 *
 * The rules are AC-246's device reading, plus the omitted-`client` arm every
 * `ui_*` tool adds:
 *
 *  - omitted, exactly one device connected: that device is chosen (there is no
 *    ambiguity to refuse) — a single phone must not require its own id echoed
 *    back;
 *  - omitted, several connected: refused `CLIENT_REQUIRED` with the candidates,
 *    because guessing would act on a screen the caller did not choose;
 *  - omitted, none connected: refused `NO_CLIENT`;
 *  - named: an exact `deviceId` wins; otherwise the trimmed, case-insensitive
 *    query must match exactly one device's id or name. Several matches are
 *    refused `TARGET_AMBIGUOUS` with the candidates, and no match is refused
 *    `CLIENT_NOT_FOUND` carrying the query.
 */
export function resolveUiNavigationDevice(
  devices: readonly UiClientDevice[],
  client: string | undefined,
): UiClientDevice {
  const named = typeof client === 'string' ? client.trim() : '';
  if (named.length === 0) {
    const only = devices[0];
    if (devices.length === 0) {
      throw new McpToolError(
        MCP_ERROR_CODES.NO_CLIENT,
        'No browser is connected, so there is no screen to navigate.',
        true,
        { kind: 'device', candidates: [] },
      );
    }
    if (devices.length === 1 && only !== undefined) {
      return only;
    }
    throw new McpToolError(
      MCP_ERROR_CODES.CLIENT_REQUIRED,
      `${devices.length} browsers are connected; name the one to navigate.`,
      false,
      { kind: 'device', candidates: candidatesOf(devices) },
    );
  }

  const exact = devices.find((device) => device.deviceId === named);
  if (exact !== undefined) {
    return exact;
  }

  const matches = devices.filter((device) => deviceMatches(device, named));
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) {
    return first;
  }

  if (matches.length > 1) {
    throw new McpToolError(
      MCP_ERROR_CODES.TARGET_AMBIGUOUS,
      `"${named}" matches ${matches.length} connected devices; name one of them.`,
      false,
      { client: named, kind: 'device', candidates: candidatesOf(matches) },
    );
  }

  throw new McpToolError(
    MCP_ERROR_CODES.CLIENT_NOT_FOUND,
    `No connected browser matches "${named}".`,
    false,
    { client: named, kind: 'device', candidates: candidatesOf(devices) },
  );
}

// --------------------------- the handler ---------------------------

/** One `ui_*` tool's validated arguments, reduced to what the shared body needs. */
export type UiNavigationToolInput = {
  /** The connected browser to address; omitted chooses the only one. */
  client?: string;
  /** The session the navigation is anchored to (AC-246 already rewrote it to an id). */
  sessionId: string;
  /** Where the target browser should land. */
  at: UiNavigationPosition;
};

/** What distinguishes one `ui_*` tool from another inside the shared body. */
export type UiNavigationToolOptions = {
  /** The tool's `tools/list` name, used in the rate-limit refusal. */
  name: string;
  /** Calls allowed per window for this tool; the shared limit constant. */
  rateLimitPerMinute: number;
  /** The window length; the shared window constant. */
  rateWindowMs: number;
};

/**
 * The body every `ui_*` navigation tool runs.
 *
 * Order matters: the throttle is consulted FIRST (a refused call must not have
 * resolved or touched a device), then the device is resolved, and only then is
 * the navigation written. The returned `status` is the DELIVERY reading — this
 * function never awaits a `ui.navigate_result`.
 */
export async function buildUiNavigation(
  deps: UiNavigationToolDeps,
  input: UiNavigationToolInput,
  principal: McpPrincipal,
  options: UiNavigationToolOptions,
): Promise<UiNavigationToolPayload> {
  const limiter = deps.rateLimiter;
  // Keyed by TOKEN, not by device or session: the limit is a property of the
  // credential that was handed out, which is also the unit a human revokes.
  if (limiter !== undefined && !limiter.allow(String(principal.tokenId))) {
    throw new McpToolError(
      MCP_ERROR_CODES.RATE_LIMITED,
      `This token may call ${options.name} at most ${options.rateLimitPerMinute} times a minute.`,
      true,
      { limit: options.rateLimitPerMinute, windowMs: options.rateWindowMs, tool: options.name },
    );
  }

  const resolveRequester = deps.resolveClientName ?? resolveClientName;
  const device = resolveUiNavigationDevice(deps.listUiClients(), input.client);
  const record = await deps.navigate({
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    sessionId: input.sessionId,
    at: input.at,
    // The NAME the user reads on the bar, never the raw client id: a personal
    // access token has no client at all, so `principal.clientId` alone left the
    // prompt blank and the "ask" policy asked about nobody.
    requestedBy: resolveRequester(principal),
  });

  return {
    navigationId: record.navigationId,
    device: { deviceId: record.deviceId, deviceName: record.deviceName },
    sessionId: record.sessionId,
    status: record.status,
    tabId: record.tabId,
  };
}

// --------------------------- registration ---------------------------

/**
 * One `ui_*` tool's metadata as `registerMcpWriteTools` hands it down.
 *
 * The name, description and scope come from the caller — the write-tools module
 * is the one statement of the name set. `owner` names the task that delivers the
 * behaviour, for the unwired refusal. `target` reduces the validated args to the
 * shared body's input; it is where a tool's own `at` shape is read.
 */
export type McpUiNavigationRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  /** The task owning this tool's behaviour, named in the unwired refusal. */
  owner: string;
  /** Reads the tool's validated args into the shared body's input. */
  target: (args: Record<string, unknown>) => UiNavigationToolInput;
};

/** The refusal a mount without the injected deps answers with. */
function notImplemented(name: string, owner: string): never {
  throw new McpToolError(
    MCP_TOOL_NOT_IMPLEMENTED_CODE,
    `${name} is registered but its behaviour is delivered by ${owner}.`,
    false,
    { tool: name, owner },
  );
}

/**
 * Registers one `ui_*` tool through the audited write seam.
 *
 * The handler is NOT wrapped by the self-target guard: opening, focusing or
 * revealing something in the caller's own client neither interrupts nor queues a
 * run, so `SELF_TARGET` must not fire. A tool registered even when its deps are
 * absent keeps its name on `tools/list` (the annotation and error-code records
 * are total over the tool-name union), with a body that throws a NAMED
 * `MCP_TOOL_NOT_IMPLEMENTED` refusal pointing at its owner.
 */
export function registerMcpUiNavigationTool(
  seam: McpWriteToolSeam,
  deps: UiNavigationToolDeps | null,
  registration: McpUiNavigationRegistration,
): void {
  const body: McpWriteToolRegistration['handler'] =
    deps === null
      ? () => notImplemented(registration.name, registration.owner)
      : (args, ctx) =>
          buildUiNavigation(deps, registration.target(args), ctx.principal, {
            name: registration.name,
            rateLimitPerMinute: MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE,
            rateWindowMs: UI_NAVIGATION_RATE_WINDOW_MS,
          });

  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: body,
  });
}
