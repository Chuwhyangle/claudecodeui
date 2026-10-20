export { default as Settings } from '@/modules/settings/Settings';
export {
  readMcpNavigationPolicy,
  writeMcpNavigationPolicy,
} from '@/modules/settings/hooks/useMcpNavigationSettings';
export type { McpNavigationPolicy } from '@/modules/settings/hooks/useMcpNavigationSettings';
