export { default as ArchitecturePanel } from '@/modules/architecture/ArchitecturePanel';
export { useArchitectureGraph } from '@/modules/architecture/useArchitectureGraph';
export type {
  ArchitectureGraphResult,
  ArchitectureGraphStats,
  ArchitectureProvenance,
  ArchitectureView,
} from '@/modules/architecture/useArchitectureGraph';
export {
  isArchitectureTabVisible,
  useEnsureArchitectureTabVisible,
} from '@/modules/architecture/hooks/useArchitectureTabVisibility';
/**
 * The standalone architecture page's transport, exposed for the two modules
 * that own its other halves: `WorkspaceMain` receives the page's "put in chat
 * input" / focus requests, and `App`'s standalone route asks the open
 * workspace tab to come forward before navigating a new copy.
 */
export { requestArchitectureSessionFocus, useArchitectureChatBridge } from '@/modules/architecture/architectureChatBridge';
