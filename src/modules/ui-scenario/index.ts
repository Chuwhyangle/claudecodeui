/**
 * The dev-only UI scenario surface.
 *
 * This barrel is the ONLY import path other modules may use (the frontend boundary rule: a
 * cross-module import goes through `index.ts`). `main.tsx` imports it behind the build-time gate
 * to install `window.__cloudcliScenario`; `QuayPanel` imports it behind the same gate to publish
 * the view contract its focusable rows are drawn from. Nothing here ships in a production bundle.
 */
export {
  SCENARIO_SWITCH_KEY,
  SCENARIO_SWITCH_QUERY,
  attachScenarioSurface,
  clearScenarioRegistry,
  detachScenarioSurface,
  isScenarioSurfaceRequested,
  publishScenarioViewContract,
  scenarioWindow,
} from '@/modules/ui-scenario/scenarioSurface';
export type {
  ScenarioDriveStep,
  ScenarioFocusReading,
  ScenarioInputPack,
  ScenarioReading,
  ScenarioStepTiming,
  ScenarioSurface,
  ScenarioWindow,
} from '@/modules/ui-scenario/scenarioSurface';
