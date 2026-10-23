// The cockpit's public surface. `App` mounts `CockpitPage` at `/cockpit` and `CockpitRemote` at
// `/cockpit/remote`; the next cockpit task (push-to-talk + focus routing) reuses the same
// deterministic intent parser, so it is exported here rather than deep-imported from its file.
export { default as CockpitPage } from '@/modules/cockpit/CockpitPage';
export { default as CockpitRemote } from '@/modules/cockpit/CockpitRemote';
export { parseCockpitIntent } from '@/modules/cockpit/cockpitIntent';
export type { CockpitIntent, CockpitIntentContext } from '@/modules/cockpit/cockpitIntent';
