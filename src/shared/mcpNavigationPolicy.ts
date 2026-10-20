/**
 * This device's answer to an incoming MCP navigation request.
 *
 * It lives in `shared` because the two sides of one decision are in two feature
 * modules: the chat module's navigation executor reads it while handling a
 * server frame, and the settings module's panel renders and writes it. Neither
 * module may import the other, so the stored value and its pure readers/writers
 * are owned here. The device name that travels beside it is already shared —
 * `@/shared/userSettings` — because the websocket provider reads it too.
 */

/**
 * This device's answer to an incoming MCP navigation request: `accept` opens it without
 * asking, `ask` confirms first, `reject` refuses. Stored in this browser's localStorage, so
 * the choice belongs to the device rather than to the account.
 */
export type McpNavigationPolicy = 'accept' | 'ask' | 'reject';

/** localStorage key holding this browser's chosen MCP navigation policy. */
export const MCP_NAVIGATION_POLICY_STORAGE_KEY = 'mcpNavigationPolicy';

/** Every policy the UI offers, in the order the settings section lists them. */
const MCP_NAVIGATION_POLICIES: readonly McpNavigationPolicy[] = ['accept', 'ask', 'reject'];

/**
 * The policy a device falls back to when it has not chosen one — and when what it stored
 * cannot be read: `ask` is safe because it neither opens nor silently refuses a navigation
 * the user never saw.
 */
export const DEFAULT_MCP_NAVIGATION_POLICY: McpNavigationPolicy = 'ask';

/** Narrows an arbitrary stored value to a policy; unset or junk is not one. */
export const isMcpNavigationPolicy = (value: unknown): value is McpNavigationPolicy =>
  typeof value === 'string' && (MCP_NAVIGATION_POLICIES as readonly string[]).includes(value);

/**
 * Reads this device's MCP navigation policy straight from localStorage, without React.
 * Anything unset, unrecognised, or unreadable answers `ask`, so a caller (a WS reply, a
 * navigation executor) never has to distinguish "no choice" from "no storage".
 */
export const readMcpNavigationPolicy = (): McpNavigationPolicy => {
  try {
    const stored = localStorage.getItem(MCP_NAVIGATION_POLICY_STORAGE_KEY);
    return isMcpNavigationPolicy(stored) ? stored : DEFAULT_MCP_NAVIGATION_POLICY;
  } catch {
    return DEFAULT_MCP_NAVIGATION_POLICY;
  }
};

/**
 * Writes this device's MCP navigation policy straight to localStorage, without React. Used
 * by features that let the user settle a decision permanently (the navigation prompt's
 * "always accept" / "always reject"), so a reader mounted afterwards — the settings section —
 * sees the new choice without a reload. Storage failures are swallowed: the choice then
 * applies only to the current page's lifetime, which is still better than throwing inside a
 * websocket handler.
 */
export const writeMcpNavigationPolicy = (policy: McpNavigationPolicy): void => {
  try {
    localStorage.setItem(MCP_NAVIGATION_POLICY_STORAGE_KEY, policy);
  } catch {
    // The caller's in-memory choice still applies while this page lives.
  }
};
