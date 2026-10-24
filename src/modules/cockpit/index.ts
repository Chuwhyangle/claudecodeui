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
  buildObservationWallContract,
  cockpitViewPath,
  readCockpitReturnPath,
  rememberCockpitReturnPath,
  resolveCockpitProject,
} from '@/modules/cockpit/cockpitView';
export type { CockpitProject, CockpitView } from '@/modules/cockpit/cockpitView';
// The observation URI grammar, so the sidebar's 「钉到观察墙」 mints the same address the
// producers wrote and the wall reads — one spelling, both sides.
export {
  formatArchitectureUri,
  formatProjectUri,
  formatSessionUri,
  parseObservationUri,
} from '@/modules/cockpit/observationUri';
// The observation wall itself, and the row action the sidebar shares with it. Exported here so
// the sidebar mints its pin toggle from the same module (and the same pin cache) the wall uses.
export { default as ObservationWall } from '@/modules/cockpit/ObservationWall';
export { default as ObservationPreview } from '@/modules/cockpit/ObservationPreview';
export {
  WatchPinToggle,
  observationLiveness,
  observationSummary,
} from '@/modules/cockpit/ObservationTile';
export {
  deriveSelfReading,
  fetchObservationWall,
  markObservationSeen,
  observationPinnedUris,
  setObservationWatch,
  useObservationPin,
  useObservationWall,
} from '@/modules/cockpit/hooks/useObservationWall';
export type {
  ObservationKind,
  ObservationWall as ObservationWallData,
  ObservationWallEntry,
  ObservationWallView,
  ObservedObject,
  ObservationProducerReading,
} from '@/modules/cockpit/hooks/useObservationWall';
