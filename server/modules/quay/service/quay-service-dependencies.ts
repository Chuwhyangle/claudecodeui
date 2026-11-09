
import type { QuayFleetProjectIdResolver } from '../fleet/quay-fleet-project-id.js';
import type { QuayCommandRunner, QuayFileReader } from '../read/quay-command-port.js';
import type { QuayEntrypointResolution } from '../read/quay-entrypoint-resolver.js';
import type { QuayContextEventsStatus } from '../read/quay-snapshot-types.js';
import type { QuayFleetWallReader } from '../read/quay-uri-resolve.js';

/**
 * Everything `createQuayService` is allowed to touch: the project registry, the command and
 * file boundaries, the clock, the TTLs, and the optional fleet/context-event seams. Declaring
 * it here (rather than beside the factory) keeps the snapshot-read, task-index and
 * fleet-summary factories able to type their own inputs without importing the composition.
 *
 * Consumers: `service/quay.service.ts` (the factory) and the three concern factories.
 */

export type QuayServiceDependencies = {
  fileExists(filePath: string): boolean;
  resolveProjectPathById(projectId: string): string | null;
  /**
   * Every project the composition knows about, as (id, absolute path) pairs. The fleet
   * summary is the only reader: it must fan out over ALL projects rather than a request
   * roster, so it cannot be built from `resolveProjectPathById`. Optional so a
   * composition without a project registry yields an empty summary instead of a crash.
   */
  listProjects?(): readonly { projectId: string; projectPath: string }[];
  runCommand: QuayCommandRunner;
  /**
   * Resolves the CLI the project's reads will spawn, for the snapshot's optional `entrypoint`
   * diagnostic (which binary, which version, which rule selected it). OPTIONAL so every
   * criterion composing this service is untouched: absent means the snapshot reports no
   * entrypoint instead of inventing one.
   */
  resolveEntrypoint?(projectPath: string): QuayEntrypointResolution;
  /** Read-only filesystem boundary for the `.quay/` carrier files behind the Tests and Fan-in cards. */
  readFile: QuayFileReader;
  /**
   * Probes a project's `quay serve` web face and resolves `true` only when it answers.
   * Injected so the dashboard reading is exercised without opening a socket, and so the
   * composition root can pick the transport (an in-process HTTP `GET /health`). It must
   * never reject: an unreachable dashboard is a `null` link, not an error.
   */
  probeWebService(host: string, port: number): Promise<boolean>;
  now(): number;
  /** How long a Tier-2 snapshot stays fresh; requests inside the window reuse it. */
  snapshotTtlMs: number;
  /** Per-command subprocess timeout. */
  commandTimeoutMs: number;
  /** Ceiling for the snapshot's cold `driver status` read; absent keeps {@link commandTimeoutMs}. */
  driverStatusTimeoutMs?: number;
  /**
   * The fleet wall read port (quay-fleet's `wall resolve` / `wall summary`) behind the
   * `quay://` dereference entry point. OPTIONAL so every existing criterion composing this
   * service is untouched: `undefined` builds the configured CLI adapter from
   * {@link QUAY_FLEET_BIN_ENV}; `null` disables the fleet path (task references read from
   * the snapshot); an injected reader is the seam the dereference criteria use.
   */
  fleetWallReader?: QuayFleetWallReader | null;
  /**
   * The Cloudpit project id → quay-fleet registry id join (`quay-fleet-project-id.ts`), behind
   * the wall's project segment and the per-project `fleetProjectId` reading. OPTIONAL so a
   * composition that does not run a fleet still works: absent means every project is
   * unregistered (`fleetProjectId: null`), which the UI renders as 「未登记到 quay-fleet」
   * rather than guessing an identity.
   */
  fleetProjectIdResolver?: QuayFleetProjectIdResolver | null;
  /**
   * The context-event stream's current state, read beside the fleet reading in
   * `getFleetSummary`. OPTIONAL so a criterion composing this service stays
   * untouched; absent means the response says `contextEvents: null`.
   */
  readContextEventsStatus?: () => QuayContextEventsStatus;
  /**
   * Called on every `readTaskIndex` — the read path the MCP `changes` tool and the session
   * mention join use. The event-driven refresh (`quay-task-events.service.ts`) uses it to
   * notice that a project is being read, which is one of the three conditions for watching it.
   * OPTIONAL so every existing composition stays untouched.
   */
  onTaskIndexRead?: (projectId: string) => void;
};

export type QuaySnapshotOptions = {
  /** Bypass the TTL cache for the manual refresh button. */
  forceRefresh?: boolean;
  /**
   * Loop pulse time window, in hours — the raw query value, coerced by
   * `normalizeGanttWindowHours` (it arrives as a string from the query, and an unrecognised
   * value must fall back to the default rather than being honoured).
   */
  windowHours?: unknown;
};
