/**
 * The neutral accessor for the websocket module's chat-run registry.
 *
 * WHY THIS FILE EXISTS. `modules/mcp-gateway/mcp-gateway.transport.ts` handed
 * its tools the process's `chatRunRegistry` by importing it from the websocket
 * barrel. That is a `mcp-gateway -> websocket` edge, and the websocket module
 * already imports the providers module, which imports the providers list — the
 * loop that made server start-up order-sensitive. The gateway needs only the
 * registry's read/write verbs, and it needs them when a tool is CALLED, not
 * while either module evaluates, so the dependency can be installed rather than
 * imported.
 *
 * `chat-run-registry.service.ts` installs the process registry at the bottom of
 * its own module body, and `server/index.ts` names the installation explicitly
 * in the composition root. The gateway reads the port lazily through
 * {@link readChatRunRegistryPort}, which takes a fallback: a mount that never
 * imported the websocket module (a focused transport criterion) keeps working
 * and answers every run lookup as a miss, instead of throwing at mount time.
 *
 * Consumers: `modules/mcp-gateway/mcp-gateway.transport.ts` (the `runs` seam of
 * its read/write tool bags) and `modules/providers/services/sessions.service.ts`
 * (the run-liveness reads behind `listRunningSessions` / `fetchHistory` and the
 * window readers). The providers reader is why {@link ChatRunRegistryPort}
 * carries the optional `isProcessing` member: it is the session-addressed
 * "is a run owed?" read those three call sites make, and it was the providers
 * group's other outgoing edge into the websocket module. This file imports no
 * module, only shared vocabulary.
 */

/**
 * The registry surface the MCP gateway hands to its tools.
 *
 * Generic in the run record, the by-id lookup result, and the two listing
 * readings so this shared file does not have to name either module's types: the
 * gateway instantiates it with `McpSessionRunRecord` / `ChatRunLookupResult` /
 * `McpRunningRun` / `McpRunSummary` at the call site, where those types already
 * live. The member names are the registry's own, which is what makes the real
 * registry structurally satisfy this contract with no adapter.
 *
 * `getRun` is the session-addressed liveness read; the two stamping members are
 * optional for the same reason they are optional on `McpRunReader` (a mount
 * without a registry stamps nothing); `getRunById` / `getRunBootId` are the
 * `run_get` seam's two reads. `isProcessing` is OPTIONAL and answers the
 * providers service's "is work owed on this session?" question: a registry-less
 * mount answers it as `false` at the call site, which is the same degradation
 * `listRunningRuns` takes when it has no runs to report.
 */
export type ChatRunRegistryPort<
  RunRecord = unknown,
  LookupResult = unknown,
  RunningRun = unknown,
  RecentRun = unknown,
> = {
  getRun(sessionId: string): RunRecord | undefined;
  isProcessing?(sessionId: string): boolean;
  listRunningRuns(): RunningRun[];
  listRecentRuns?(): RecentRun[];
  setRunCorrelationId?(runId: string, correlationId: string): void;
  setDeliveryCorrelationId?(deliveryId: string, correlationId: string): void;
  getRunById(runId: string): LookupResult;
  getRunBootId(runId: string): string | null;
};

/**
 * The installed registry, or null before composition.
 *
 * A process-wide singleton because the run registry is one: `chatRunRegistry` is
 * created once at module load and every gateway mount must see the same runs.
 */
let installedChatRunRegistry: ChatRunRegistryPort | null = null;

/**
 * Installs the process's chat-run registry.
 *
 * Called by `chat-run-registry.service.ts` at the bottom of its own module body
 * and by `server/index.ts`. Re-installing the same object is a no-op.
 */
export function installChatRunRegistryPort(port: ChatRunRegistryPort): void {
  installedChatRunRegistry = port;
}

/**
 * Reads the installed registry, or the caller's fallback when none is installed.
 *
 * The fallback is required rather than optional because the alternative — a
 * throw — would make merely importing the gateway module depend on having
 * imported the websocket module first, which is the class of ordering coupling
 * this port removes. A focused criterion that mounts the gateway without a
 * registry gets the documented "every run is unknown" reading instead.
 */
export function readChatRunRegistryPort<RunRecord, LookupResult, RunningRun, RecentRun>(
  fallback: ChatRunRegistryPort<RunRecord, LookupResult, RunningRun, RecentRun>,
): ChatRunRegistryPort<RunRecord, LookupResult, RunningRun, RecentRun> {
  return (
    (installedChatRunRegistry as ChatRunRegistryPort<
      RunRecord,
      LookupResult,
      RunningRun,
      RecentRun
    > | null) ?? fallback
  );
}
