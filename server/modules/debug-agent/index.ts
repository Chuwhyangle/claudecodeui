// The debug agent's public surface (ADR-003).
//
// Importing this module is inert: every consumer asks the gate before it acts,
// which keeps "off" a decision made at the consumer's own seam rather than a
// side effect of an import. Cross-module consumers must come through here
// (backend module standards / `boundaries/dependencies`):
//
//  - `server/index.ts` — mounts the control plane only when the gate is open,
//    registering the endpoints onto the gate's router in the same branch and
//    building the seams the routes reach the providers module through;
//  - `server/modules/providers/provider.registry.ts` — the runtime provider id,
//    and the provider factory it registers under it;
//  - `server/modules/providers/services/sessions-watcher.service.ts` — the fixture root.
//
// The engine, the scenario document and the arming step are reachable from here
// by value for the module's own tests and for the control plane that drives
// them; they cost an importer nothing until it calls one, because the gate is
// read inside the call and not at import time.
export {
  DEBUG_AGENT_CONTROL_PLANE_PATH,
  DEBUG_AGENT_PROVIDER_ID,
  debugAgentControlPlaneRouter,
  getDebugAgentGateReason,
  getDebugAgentProjectsRoot,
  isDebugAgentEnabled,
  mountDebugAgentControlPlane,
  readDebugAgentGate,
} from './debug-agent.gate.js';

export {
  DEBUG_AGENT_DIALECTS,
  DEBUG_AGENT_EXIT_DETAILS,
  DEBUG_AGENT_HOMES,
  DEBUG_AGENT_HOST_OPS,
  DEBUG_AGENT_KEEPALIVE_KINDS,
  DEBUG_AGENT_LIFECYCLE_MODES,
  DEBUG_AGENT_OPS,
  DEBUG_AGENT_ROLES,
  DEBUG_AGENT_SCENARIO_VERSION,
  DEBUG_AGENT_TRANSCRIPT_MODES,
  isDebugAgentHostOp,
  loadScenario,
} from './debug-agent.scenario.js';
export type {
  DebugAgentDialect,
  DebugAgentExitDetail,
  DebugAgentHome,
  DebugAgentHostOp,
  DebugAgentKeepaliveKind,
  DebugAgentLifecycleMode,
  DebugAgentRole,
  DebugAgentScenario,
  DebugAgentScenarioExpectations,
  DebugAgentScenarioOp,
  DebugAgentScenarioSeed,
  DebugAgentScenarioStep,
  DebugAgentTranscriptMode,
} from './debug-agent.scenario.js';

export {
  armDebugAgentScenario,
  disarmDebugAgentScenario,
  readArmedDebugAgentScenario,
} from './debug-agent.runtime.js';
export type {
  ArmedDebugAgentScenario,
  DebugAgentArmInput,
  DebugAgentTranscriptShape,
} from './debug-agent.runtime.js';

export { evaluateScenarioExpectations, runDebugAgentScenario } from './debug-agent.engine.js';
export type {
  DebugAgentFrameForwarder,
  DebugAgentGrowReading,
  DebugAgentHostOps,
  DebugAgentPermissionOps,
  DebugAgentRunInput,
  DebugAgentRunReading,
  DebugAgentScenarioEvaluation,
  DebugAgentStepObservation,
} from './debug-agent.engine.js';

// createDebugAgentHostDriver: the provider's process-lifetime face. Built and
// attached by `createDebugAgentProvider`, and placed on the manager by a caller
// that owns the session (`bindSession`/`openHost`). The criterion drives it
// directly, which is what makes a resident, multiplexed host measurable without
// a real process to wait on.
export { createDebugAgentHostDriver, setDebugAgentOpenRun } from './debug-agent.host-driver.js';
export type {
  DebugAgentHostDriver,
  DebugAgentHostDriverDependencies,
  DebugAgentOpenRun,
} from './debug-agent.host-driver.js';

export { createDebugAgentProvider } from './debug-agent.provider.js';
export type {
  DebugAgentPermissionAnnouncer,
  DebugAgentProviderDependencies,
  DebugAgentSynchronizerOptions,
} from './debug-agent.provider.js';

// registerDebugAgentControlPlaneRoutes: the control plane's HTTP face, registered
// by `server/index.ts` onto the router the gate module owns. The seams are injected
// rather than imported because this module may not reach the providers module (see
// the routes module): the entrypoint is the one place both sides are in scope.
export { registerDebugAgentControlPlaneRoutes } from './debug-agent.routes.js';
export type { DebugAgentControlPlaneSeams } from './debug-agent.routes.js';
