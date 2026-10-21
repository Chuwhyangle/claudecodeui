export { default as ProjectWorkspaceRoute } from '@/modules/project-workspace/ProjectWorkspaceRoute';
// The workspace tab strip's host, exposed for the architecture module's tab
// criterion: that reading has to verify the gate → tab-list wiring through the
// real header rather than restating WorkspaceTabs' source.
export { default as WorkspaceHeader } from '@/modules/project-workspace/WorkspaceHeader';
export {
  useProjectSessionFilter,
  // The rule predicate, exported so the sidebar's live Conversations feed can be
  // handed the same implementation through props (see SessionHiddenByProjectFilter).
  isSessionHiddenByProjectFilter,
} from '@/modules/project-workspace/hooks/useProjectSessionFilter';
export { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
