// sessionHostManager: the process-wide host view. Used by the providers module's
// `provider-runtime.service` to register every dispatched run as a per-run host,
// by `server/index.ts` to stop every host during shutdown, and by this module's
// criterion tests, which read hosts only through `snapshot()`.
export { sessionHostManager, createSessionHostManager } from './session-host-manager.service.js';
// createSessionHostsRouter: the listing face this module owns, mounted by
// `server/index.ts` at `/api/session-hosts` over the process-wide manager, and
// by the routes criterion over a manager it drove itself. A factory because the
// manager is a dependency: `createApiSuccessResponse` wraps its one response.
// The same factory also serves the mode-restricted verbs (`POST
// /:sessionId/start`, `POST /:sessionId/close`), which is why its two reader
// seams travel with it.
export { createSessionHostsRouter } from './session-hosts.routes.js';
// startResidentHost / closeResidentHost: the resident start/close decision,
// lifted out of the route so a SECOND transport can reach the same code instead
// of writing its own. Consumers: the MCP gateway's `session_start` /
// `session_close` adapter (`mcp-session-host-control.ts` in that module),
// which delegates every start and close to these two functions and never
// re-implements them. Exported here (not re-stated in the gateway) so the
// gateway's on-demand verb is provably the route's verb.
export { closeResidentHost, startResidentHost } from './resident-host.service.js';
// ResidentHostServiceDeps: the four seams the two services read, handed through
// by the barreled default builder the MCP gateway calls. ResidentHostStartOutcome
// / ResidentHostCloseOutcome / ResidentHostRefusal: what each service answers —
// a success carrying the host (and, on close, its leases), or a refusal whose
// `code`/`message` the MCP adapter forwards verbatim.
export type {
  ResidentHostCloseOutcome,
  ResidentHostRefusal,
  ResidentHostServiceDeps,
  ResidentHostStartOutcome,
} from './resident-host.service.js';
// SessionLifecycleReading / HostDriverResolver: the two dependency seams the
// start/close verbs are constructed with. `SessionLifecycleReading` is the shape
// the providers module's `sessionsService.readSessionLifecycle` returns (the
// route reads a session's provider and stored mode, and must not touch the
// database itself); `HostDriverResolver` is the driver lookup the composition
// root supplies so this module never imports the providers module back.
export type {
  HostDriverResolver,
  SessionHostStateReading,
  SessionLifecycleReading,
  SessionReader,
} from './session-hosts.routes.js';
// RESIDENT_NOT_RUNNING_REASON: the derived reason a resident session carries on
// the listing when nothing is serving it. Exported as a value — not restated as
// a literal at the read site — so a consumer (and the restart criterion, which
// prints it) asserts against the same string the projection fills in.
export { RESIDENT_NOT_RUNNING_REASON } from './session-hosts.routes.js';
// CLOSED_HOST_RETENTION_MS: how long a closed host stays in `snapshot()`, so a
// reader of the listing (and the criterion for its far edge) can place a
// deadline on the same value the manager expires with.
export { CLOSED_HOST_RETENTION_MS } from './session-host-manager.service.js';
// PerRunTurnInput / SessionHostManagerOptions / OpenHostInput: the manager's own
// call shapes, so a caller can type the turn or the host it hands over without
// reaching into the service file.
// BindSessionInput: the session-addressed call shape beside them — a caller with
// an application session id lets the manager choose the process instead of
// naming a host itself; used by providers that own their process through a host
// driver.
export type {
  BindSessionInput,
  OpenHostInput,
  PerRunTurnInput,
  SessionHostManager,
  SessionHostManagerOptions,
  ShutdownSummary,
} from './session-host-manager.service.js';
// UnattendedRunInput / UnattendedRunHandle / UnattendedRunOpener: the seam a
// resident host driver calls when its process opens a turn nobody pushed, and
// the shape `server/index.ts` implements over the run registry. Exported
// because the driver types its port against them and the composition root
// builds the opener elsewhere — neither can name them from the service file
// without crossing a module edge this barrel exists to keep one-way.
export type {
  UnattendedRunHandle,
  UnattendedRunInput,
  UnattendedRunOpener,
} from './session-host-manager.service.js';
// HostScheduler: the deadline seam a criterion injects in place of the wall
// clock, so the quiet ceiling and the shutdown grace period are reachable
// without waiting them out.
export type { HostScheduler } from './session-host-manager.service.js';
// The two shipped policies and the ceilings they are built from, exported so a
// reader (and the lifecycle criterion) can state a deadline from the same value
// the manager uses rather than restating the number.
export {
  DEFAULT_PER_RUN_POLICY,
  DEFAULT_RESIDENT_POLICY,
  PER_RUN_QUIET_CEILING_MS,
  RESIDENT_IDLE_TIMEOUT,
} from './session-host-manager.service.js';
// Host lifecycle read-port types: the vocabulary a consumer needs to read
// `snapshot()` (and the shape siblings will extend with resident-mode data).
export type {
  HostCloseReason,
  HostLease,
  HostMode,
  HostState,
  ProcessHost,
  RemoteControlIsolation,
  SessionBinding,
} from '@/shared/types.js';
// HOST_CLOSE_REASONS: every close reason as a runtime value, so the lifecycle
// criterion can assert that its cases produced all of them instead of trusting
// its own list to match the union.
export { HOST_CLOSE_REASONS } from '@/shared/types.js';
// HostBindResult / HostBindErrorCode: what a `bindSession` answered, and the
// refusal vocabulary it branches on, so a caller can tell "the session is
// already somewhere" from "this process cannot take a second conversation".
export type { HostBindErrorCode, HostBindResult } from '@/shared/types.js';
// HOST_BIND_ERROR_CODES: every refusal as a runtime value, so a criterion can
// assert each one is reachable by reading the list the manager is typed against
// rather than a literal typed a second time.
export { HOST_BIND_ERROR_CODES } from '@/shared/types.js';
// LifecycleModeErrorCode / LIFECYCLE_MODE_ERROR_CODES: the refusal vocabulary of
// the lifecycle verbs (`/start`, `/close`, the mode write). A caller branches on
// the code, so a criterion that has to show three refusals are *mutually
// distinguishable* reads the runtime list rather than the three values it
// happened to produce — "distinct" stays a property of the vocabulary.
export type { LifecycleModeErrorCode } from '@/shared/types.js';
export { LIFECYCLE_MODE_ERROR_CODES } from '@/shared/types.js';
// LifecyclePolicy / HostCloseDetail: the policy a mode runs under and the extra
// fact two close reasons carry, needed by any caller that injects a policy or
// reads why an `exited` host died.
export type { HostCloseDetail, LifecyclePolicy } from '@/shared/types.js';
// createResidentRestoreService / resolveResidentRestoreEnabled: the start-up
// restore pass and the switch that gates it. Consumed by `server/index.ts`,
// which asks the resolver whether to schedule the pass and hands the factory the
// two seams only it can supply (the session store's candidate reader and the
// providers layer's resident launch). Exported here rather than reached into by
// path because the composition root imports this module through its barrel.
export {
  createResidentRestoreService,
  resolveResidentRestoreEnabled,
} from './resident-restore.service.js';
// ResidentRestoreOutcome / ResidentRestoreDeps / RestorableResidentSession: the
// pass's answer, its inputs, and the candidate row it reads. Exported as types
// for the same consumer: the composition root types its mapping from stored
// session rows onto the candidate, and the restore criterion drives the pass
// over fakes it owns.
export type {
  ResidentRestoreDeps,
  ResidentRestoreOutcome,
  ResidentRestoreSkipReason,
  RestorableResidentSession,
} from './resident-restore.service.js';
