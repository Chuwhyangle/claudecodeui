// The quay-fleet binary seam: binary lookup (QUAY_FLEET_BIN → PATH → ~/.quay-fleet/bin), the
// `resolve → fixed miss reading → execute` runner, and the registry/handshake reader built on
// them. This subpackage is a leaf of the quay module — it imports node builtins and
// `server/shared/**` only — so the fleet, read and service subpackages can all point at it
// without closing a cycle.
//
// Consumers: `server/index.ts` and `server/cockpit-fleet-wiring.ts` import
// `locateQuayFleetCli` / `createQuayFleetRunner` through the module barrel; `fleet/` and
// `read/quay-uri-resolve.ts` consume the rest inside the module.
export {
  QUAY_FLEET_BIN_NOT_FOUND_REASON,
  QUAY_FLEET_MAX_OUTPUT_BYTES,
  QUAY_FLEET_TIMEOUT_MS,
  canonicalFleetPath,
  createQuayFleetExec,
  createQuayFleetRunner,
  defaultQuayFleetExec,
  parseFleetJsonObject,
} from './quay-fleet-cli.js';
export type {
  QuayFleetCommandResult,
  QuayFleetExec,
  QuayFleetExecOptions,
  QuayFleetRunner,
  QuayFleetRunnerOptions,
} from './quay-fleet-cli.js';
export {
  QUAY_FLEET_BIN_ENV,
  QUAY_FLEET_HANDSHAKE_TIMEOUT_MS,
  QUAY_FLEET_HANDSHAKE_TTL_MS,
  QUAY_FLEET_SUPPORTED_CONTRACTS,
  createQuayFleetCliReader,
  locateQuayFleetCli,
  quayFleetBinPath,
} from './quay-fleet-locator.js';
export type {
  QuayFleetCliCommandResult,
  QuayFleetCliExec,
  QuayFleetCliLocateOptions,
  QuayFleetCliLocation,
  QuayFleetCliReader,
  QuayFleetCliReaderOptions,
  QuayFleetCliReading,
  QuayFleetCliSource,
  QuayFleetCliState,
  QuayFleetContracts,
} from './quay-fleet-locator.js';
