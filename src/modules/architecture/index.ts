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
