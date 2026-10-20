export { default as Settings } from '@/modules/settings/Settings';
/**
 * The device policy moved to `shared` because the chat module reads it too, and
 * the two feature modules may not import each other. Re-exported here so a
 * settings consumer keeps one import site.
 */
export { readMcpNavigationPolicy, writeMcpNavigationPolicy } from '@/shared';
export type { McpNavigationPolicy } from '@/shared';
