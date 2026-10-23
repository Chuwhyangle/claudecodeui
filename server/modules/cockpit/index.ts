// The cockpit hub's public surface. `server/index.ts` builds the one process-wide instance
// and hands it to the websocket gateway; the gateway drives `hello` / `handleEvent` /
// `disconnect` through the structurally-typed seam it declares itself, so this barrel never
// becomes a dependency of `modules/websocket` (the directory stays a leaf for AC-394).
export { createCockpitModule } from '@/modules/cockpit/cockpit.module.js';
export type { CockpitModuleDeps } from '@/modules/cockpit/cockpit.module.js';
export type { CockpitHub, CockpitHubDeps } from '@/modules/cockpit/cockpit-hub.service.js';
// The state vocabulary is published for the hub's consumers (the composition root types its
// target resolver against `CockpitState`) and for the criteria that drive the pure reducer.
export { COCKPIT_HISTORY_LIMIT, buildCockpitMessageBody, classifyCockpitUtterance, createCockpitState, reduceCockpit } from '@/modules/cockpit/cockpit.reducer.js';
export type {
  CockpitDirection,
  CockpitEvent,
  CockpitEventSource,
  CockpitFocusable,
  CockpitPendingSend,
  CockpitRole,
  CockpitSendTarget,
  CockpitState,
  CockpitUtteranceIntent,
  CockpitView,
  CockpitVisibleProject,
  CockpitVisibleSet,
} from '@/modules/cockpit/cockpit.reducer.js';
