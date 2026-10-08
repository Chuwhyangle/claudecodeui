/**
 * The MCP gateway's `ui_visible_context` handler (gap-mcp-ui-visible-context).
 *
 * The tool answers "what is the user looking at, in which window, right now" by
 * ASKING the browsers rather than by reading a store: one `ui.state_request`
 * broadcast, the answers collected by the websocket module's round trip, and the
 * result grouped by device. Nothing is cached and nothing is reported on a
 * schedule, so the answer is what the browsers said during this call — and a tab
 * that did not answer is reported as `unresponsive` rather than dropped, because
 * "the laptop lid is closed" is part of the picture.
 *
 * Two rules decide the shape of what comes back:
 *
 *  - IDENTIFIERS AND RANGES ONLY. The round trip already projects each frame down
 *    to a fixed whitelist, and this tool returns that projection unchanged — it
 *    adds no field and reads no body. A caller that wants message text asks
 *    `session_read mode=around` with an id from here, which is the whole point of
 *    reporting a range instead of the messages in it.
 *  - LOCATING A DEVICE IS THE SAME QUESTION AS LOCATING A SESSION. `client`
 *    follows AC-246's resolution rules — an exact `deviceId` wins, otherwise a
 *    trimmed case-insensitive substring must hit exactly one device — and reuses
 *    the same two refusals: `TARGET_AMBIGUOUS` with the candidates when several
 *    devices match, and, when none does, the existing `INVALID_ARGUMENT` envelope
 *    carrying the query that matched nothing. No second not-found literal is
 *    minted for devices: this vocabulary keeps one code per category.
 *
 * The deps are injected (`server/index.ts` binds the registry's read port and the
 * process-wide round trip), so this module owns the behaviour and the criterion
 * drives the same two seams over its own fake browsers.
 */

import { z } from 'zod';

import type {
  UiClientDevice,
  UiNavigationRecord,
  UiSelectedTextReading,
  UiVisibleContextDevice,
  UiVisibleContextTab,
} from '@/shared/types.js';
import type { UiStateRequestOptions } from '@/modules/websocket/index.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import type { McpReadToolDeps, McpReadToolSeam } from './mcp-gateway.read-tools.js';

/**
 * The two readings `ui_visible_context` answers from: which devices are
 * connected (what `client` is resolved against) and the round trip that asks
 * them.
 *
 * Both are injected rather than imported so the gateway keeps no handle on a
 * socket: the round trip is the only thing that touches a connection, and this
 * module only ever sees the identity-grouped result.
 */
export type McpUiVisibleContextDeps = {
  /**
   * Every connected device, the same listing `ui_clients_list` publishes.
   * Resolving `client` against it is what makes a name a legitimate way to
   * address a device.
   */
  listUiClients: () => UiClientDevice[];
  /**
   * The UI-state round trip: ask the (optionally one) device's tabs what they
   * are showing. Bound to the websocket module's `requestUiState`, which is the
   * same primitive the other UI-facing tools share.
   */
  requestUiState: (options?: UiStateRequestOptions) => Promise<UiVisibleContextDevice[]>;
  /**
   * The retained navigation records, newest first, optionally narrowed to one
   * `navigationId` (gap-mcp-ui-open-session). Bound to the websocket module's
   * `listUiNavigations`. Optional: a mount without the navigation service still
   * answers `navigations: []`, because "no navigation has been asked for" is the
   * truthful reading of a process that cannot perform one.
   */
  listNavigations?: (navigationId?: string) => UiNavigationRecord[];
};

/** Whether the injected deps carry the round trip, i.e. this tool is wired. */
export function isUiVisibleContextWired(
  deps: McpReadToolDeps,
): deps is McpReadToolDeps & { uiVisibleContext: McpUiVisibleContextDeps } {
  return deps.uiVisibleContext !== undefined;
}

/** The tool's arguments: an optional device reference and an optional navigation id. */
export type McpUiVisibleContextInput = {
  client?: string;
  /**
   * Narrow the `navigations[]` reading to ONE navigation. Absent means every
   * retained navigation is reported, which is how a caller asks "what did the
   * browsers do with what I asked for".
   */
  navigationId?: string;
};

/** The tool's reading: every addressed device, most recently focused first, plus the navigation log. */
export type UiVisibleContextPayload = {
  devices: UiVisibleContextPayloadDevice[];
  /**
   * The retained `ui_open_session` records, newest first. Empty when nothing has
   * been asked for (or when no navigation service is wired) — never omitted, so a
   * caller can read "no navigations" without a second call.
   */
  navigations: UiNavigationRecord[];
};

/**
 * One tab as `ui_visible_context` reports it: the round-trip tab WITHOUT the
 * selection reading.
 *
 * The browser sends `selectedText` (it cannot know the caller's token), but the
 * text only ever leaves through {@link buildUiSelectedText}'s separately-scoped
 * tool — so this tool's shape omits it entirely rather than redacting it to a
 * marker. A `cloudcli:read` caller learns nothing about a selection, not even
 * that one exists.
 */
export type UiVisibleContextPayloadTab = Omit<UiVisibleContextTab, 'selectedText'>;

/** One addressed device's tabs as `ui_visible_context` reports them. */
export type UiVisibleContextPayloadDevice = Omit<UiVisibleContextDevice, 'tabs'> & {
  tabs: UiVisibleContextPayloadTab[];
};

/** Copies a round-trip tab, leaving `selectedText` behind. */
function withoutSelection(tab: UiVisibleContextTab): UiVisibleContextPayloadTab {
  return {
    tabId: tab.tabId,
    deviceName: tab.deviceName,
    unresponsive: tab.unresponsive,
    navigationPolicy: tab.navigationPolicy,
    visibility: tab.visibility,
    hasFocus: tab.hasFocus,
    lastFocusedAt: tab.lastFocusedAt,
    panel: tab.panel,
    selectedProject: tab.selectedProject,
    selectedSession: tab.selectedSession,
    visibleMessages: tab.visibleMessages,
    pendingApprovals: tab.pendingApprovals,
    queuedMessages: tab.queuedMessages,
    currentDiff: tab.currentDiff,
    currentTask: tab.currentTask,
  };
}

/** Whether a device matches one query: an exact `deviceId`, or the substring in either of its names. */
function deviceMatches(device: UiClientDevice, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    device.deviceId.toLowerCase().includes(needle) || device.deviceName.toLowerCase().includes(needle)
  );
}

/**
 * Resolves one `client` reference to exactly one connected device.
 *
 * The precedence is AC-246's, applied to devices instead of sessions: an exact
 * `deviceId` (verbatim, case-sensitive) always wins, so a caller that read an id
 * off a previous listing addresses that device even if another device's name
 * happens to contain it; otherwise the trimmed, case-insensitive query must
 * match exactly one device's id or name. Several matches are refused with the
 * candidates rather than guessed, and no match is refused with the query —
 * picking either one for the caller would make `ui_visible_context` report a
 * device the caller did not name.
 */
function resolveDevice(devices: readonly UiClientDevice[], client: string): UiClientDevice {
  const exact = devices.find((device) => device.deviceId === client);
  if (exact !== undefined) {
    return exact;
  }

  const query = client.trim();
  const matches = devices.filter((device) => deviceMatches(device, query));
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) {
    return first;
  }

  if (matches.length > 1) {
    throw new McpToolError(
      MCP_ERROR_CODES.TARGET_AMBIGUOUS,
      `"${client}" matches ${matches.length} connected devices; name one of them.`,
      false,
      {
        client,
        kind: 'device',
        candidates: matches.map((device) => ({
          id: device.deviceId,
          name: device.deviceName,
          tabs: device.tabs.length,
        })),
      },
    );
  }

  throw new McpToolError(
    MCP_ERROR_CODES.INVALID_ARGUMENT,
    `No connected device matches "${client}".`,
    false,
    { client, kind: 'device', candidates: [] },
  );
}

/**
 * The `ui_visible_context` reading.
 *
 * Without `client`, every connected device is asked. With one, the reference is
 * resolved first and only that device's tabs are asked — so a caller naming a
 * device is not merely filtering the answer, it is asking a narrower question
 * (the other browsers are never written to at all).
 *
 * An empty device list is a legitimate answer, not a failure: "no browser is
 * connected" is exactly what the caller asked for, and an error would make the
 * ordinary state of a headless server look like a broken tool.
 *
 * Consumers: {@link registerMcpUiVisibleContextTool}, and the criterion, which
 * calls it over fake connections.
 */
export async function buildUiVisibleContext(
  deps: McpUiVisibleContextDeps,
  input: McpUiVisibleContextInput,
): Promise<UiVisibleContextPayload> {
  const navigations = deps.listNavigations?.(input.navigationId) ?? [];
  const devices = await requestDevices(deps, input);
  return {
    devices: devices.map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      lastFocusedAt: device.lastFocusedAt,
      tabs: device.tabs.map(withoutSelection),
    })),
    navigations,
  };
}

/**
 * Asks the round trip for the devices an input addresses: every connected device
 * when no `client` is named, or exactly the one the reference resolves to (the
 * other browsers are then never written to at all). Shared by
 * {@link buildUiVisibleContext} and {@link buildUiSelectedText} so the two tools
 * address devices identically.
 */
async function requestDevices(
  deps: McpUiVisibleContextDeps,
  input: McpUiVisibleContextInput,
): Promise<UiVisibleContextDevice[]> {
  const client = typeof input.client === 'string' ? input.client : null;
  if (client === null) {
    return deps.requestUiState();
  }
  const device = resolveDevice(deps.listUiClients(), client);
  return deps.requestUiState({ deviceId: device.deviceId });
}

// ---------------------- ui_selected_text (scoped) ----------------------

/**
 * The scope a token must carry to read the selection TEXT. The browser always
 * sends the reading; this gate decides whether the text is delivered or reduced
 * to the `'withheld'` marker. `cloudcli:navigate` is the precedent: a single
 * high-sensitivity action gets its own scope rather than riding `cloudcli:read`.
 */
export const SELECTION_SCOPE = 'cloudcli:selection';

/** One tab's selection as `ui_selected_text` reports it: the reading, `'withheld'`, or none. */
export type UiSelectedTextTab = {
  tabId: string;
  deviceName: string;
  unresponsive: boolean;
  /**
   * `null` — no selection here (including a tab that did not answer);
   * `'withheld'` — a selection exists but the caller's token lacks
   * {@link SELECTION_SCOPE}, so the text is not delivered;
   * an object — the authorized, already-reduced reading.
   */
  selectedText: UiSelectedTextReading | 'withheld' | null;
};

/** One addressed device's tabs as `ui_selected_text` reports them. */
export type UiSelectedTextDevice = {
  deviceId: string;
  deviceName: string;
  lastFocusedAt: number | null;
  tabs: UiSelectedTextTab[];
};

/** The `ui_selected_text` reading. */
export type UiSelectedTextPayload = {
  devices: UiSelectedTextDevice[];
};

/** The input `ui_selected_text` accepts: the same optional device reference as `ui_visible_context`. */
export type McpUiSelectedTextInput = {
  client?: string;
};

/**
 * Applies the selection gate to one tab's reading.
 *
 * The three outcomes are three on purpose, mirroring the `panel` precedent: a
 * token WITHOUT the scope must not read "the user is selecting sensitive text"
 * as "the user has selected nothing", so the withheld case gets its own value
 * rather than sharing `null`.
 */
export function gateSelectedText(
  reading: UiSelectedTextReading | null,
  scopes: readonly string[],
): UiSelectedTextReading | 'withheld' | null {
  if (reading === null) {
    return null;
  }
  return scopes.includes(SELECTION_SCOPE) ? reading : 'withheld';
}

/**
 * The `ui_selected_text` reading.
 *
 * Addresses devices exactly like `ui_visible_context`, then delivers each tab's
 * selection only to a caller whose token carries {@link SELECTION_SCOPE}. The
 * `scopes` are the caller's, threaded from the transport's principal — the read
 * seam's handlers receive no other caller identity.
 */
export async function buildUiSelectedText(
  deps: McpUiVisibleContextDeps,
  input: McpUiSelectedTextInput,
  scopes: readonly string[],
): Promise<UiSelectedTextPayload> {
  const devices = await requestDevices(deps, input);
  return {
    devices: devices.map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      lastFocusedAt: device.lastFocusedAt,
      tabs: device.tabs.map((tab) => ({
        tabId: tab.tabId,
        deviceName: tab.deviceName,
        unresponsive: tab.unresponsive,
        selectedText: gateSelectedText(tab.selectedText, scopes),
      })),
    })),
  };
}

/**
 * One tool's metadata as `registerMcpReadTools` hands it down: the name,
 * description and scope read from the stage-3 table, plus the two schemas read
 * from the body table. No handler — this module owns the behaviour.
 */
export type McpUiVisibleContextRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /** A raw shape, or a built schema carrying a constraint (the shared body-table type). */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

/**
 * Registers `ui_visible_context` through the audited read seam.
 *
 * The name, description, scope and both schemas come from the caller (the
 * stage-3 table plus its body-table entry), so this module owns the BEHAVIOUR
 * and `mcp-gateway.read-tools.js` remains the one statement of the name set.
 * `registerMcpReadTools` calls this only when the deps carry the round trip; an
 * unwired mount keeps the body-table's named refusal instead.
 *
 * Consumers: `mcp-gateway.read-tools.js`'s `registerMcpReadTools` (the single
 * call site).
 */
export function registerMcpUiVisibleContextTool(
  seam: McpReadToolSeam,
  deps: McpUiVisibleContextDeps,
  registration: McpUiVisibleContextRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: (args) => buildUiVisibleContext(deps, args as McpUiVisibleContextInput),
  });
}

/**
 * Registers `ui_selected_text` through the audited read seam.
 *
 * A separate tool from `ui_visible_context` on purpose: the selection TEXT is
 * content, so it gets its own name and its own (default-refusing) gate rather
 * than riding `cloudcli:read`. The name, description, scope and both schemas
 * come from `mcp-gateway.read-tools.js`'s table and body; this module owns the
 * behaviour. The handler receives the caller's principal through the read seam's
 * optional `ctx` — the transport threads it — and passes its scopes to
 * {@link buildUiSelectedText}, so the text is delivered only to a token carrying
 * {@link SELECTION_SCOPE} and reduced to `'withheld'` otherwise.
 *
 * Consumers: `mcp-gateway.read-tools.js`'s `registerMcpReadTools` (the single
 * call site), which calls this only when the deps carry the round trip.
 */
export function registerMcpUiSelectedTextTool(
  seam: McpReadToolSeam,
  deps: McpUiVisibleContextDeps,
  registration: McpUiVisibleContextRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: (args, ctx) =>
      buildUiSelectedText(deps, args as McpUiSelectedTextInput, ctx?.principal?.scopes ?? []),
  });
}
