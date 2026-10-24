// The cockpit's public surface. `App` mounts `CockpitPage` at `/cockpit` and `CockpitRemote` at
// `/cockpit/remote`; the next cockpit task (push-to-talk + focus routing) reuses the same
// deterministic intent parser, so it is exported here rather than deep-imported from its file.
export { default as CockpitPage } from '@/modules/cockpit/CockpitPage';
export { default as CockpitRemote } from '@/modules/cockpit/CockpitRemote';
export { parseCockpitIntent } from '@/modules/cockpit/cockpitIntent';
export type { CockpitIntent, CockpitIntentContext } from '@/modules/cockpit/cockpitIntent';
// The cockpit's address grammar, exported so the sidebar's mode switch and its project rows
// mint the same deep link this module parses (`?view=board&project=…`) instead of each
// spelling `/cockpit` by hand. The storage helpers are the round trip: a session page records
// where it was before entering, and the cockpit's 「会话」 segment leads back to it.
export {
  COCKPIT_PATH,
  cockpitViewPath,
  readCockpitReturnPath,
  rememberCockpitReturnPath,
  resolveCockpitProject,
} from '@/modules/cockpit/cockpitView';
export type { CockpitProject, CockpitView } from '@/modules/cockpit/cockpitView';
