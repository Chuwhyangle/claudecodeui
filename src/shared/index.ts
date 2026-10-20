/**
 * The shared layer's public surface for consumers outside `src/shared`.
 *
 * Nothing re-exported here may import a feature module: that is what keeps
 * `shared` loadable on its own (see `src/shared/tests/sharedLayerIsolation.test.tsx`).
 */
export { readDeviceName } from '@/shared/userSettings';
/**
 * This device's MCP navigation policy — read by the chat module's navigation
 * executor, written by the settings panel. It lives here because those two
 * feature modules may not import each other.
 */
export {
  readMcpNavigationPolicy,
  writeMcpNavigationPolicy,
} from '@/shared/mcpNavigationPolicy';
export type { McpNavigationPolicy } from '@/shared/mcpNavigationPolicy';
