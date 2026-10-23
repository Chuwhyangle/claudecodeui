// The cockpit's public surface. `App` mounts `CockpitPage` at `/cockpit`; the next cockpit task
// (push-to-talk + focus routing) reuses the same deterministic intent parser, so it is exported
// here rather than deep-imported from its file.
export { default as CockpitPage } from '@/modules/cockpit/CockpitPage';
export { parseCockpitIntent } from '@/modules/cockpit/cockpitIntent';
export type { CockpitIntent, CockpitIntentContext } from '@/modules/cockpit/cockpitIntent';
