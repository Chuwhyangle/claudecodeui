/**
 * The neutral accessor for the cockpit's initiative spot-check sampling ratio.
 *
 * WHY THIS FILE EXISTS. `modules/quay/quay.module.ts` composed the initiatives reading with
 * `loadServerSettings().initiative.auditRatio`, i.e. a `modules/quay -> modules/settings` edge.
 * `modules/settings` already imports `modules/mcp-gateway` (a type import that the scanner
 * counts), and mcp-gateway imports quay/projects/providers/websocket — so that one edge pulled
 * quay, projects and settings INTO the providers/websocket cycle, taking AC-394's pinned
 * G1 group from three members to ten (and reding the two port-break criteria that assert
 * `modules/websocket` and `modules/projects` sit in no non-trivial cycle). The ratio is a
 * boot-time scalar that `server/index.ts` — the ONE composition root — has already read by the
 * time a request arrives, so it can be installed here instead of imported from the settings
 * module.
 *
 * The ratio is read at CALL time, not captured: `createQuayInitiatives` memoizes its own
 * answer on the first initiatives read, so installing the reader at boot is enough, and a
 * focused criterion can install its own fixture without re-composing the module.
 *
 * An uninstalled port answers `null` — a wiring fact, not a policy value. The consumer falls
 * back to the shipped default (the same `1/5` `loadServerSettings` falls back to when no file
 * is configured), so a process that never assembled the composition root samples exactly as
 * an unconfigured deployment does.
 *
 * Consumers: `modules/quay/quay.module.ts` (the reader) and `server/index.ts` (the assembly
 * that installs it). This file imports nothing.
 */

/** The installed reader shape: a call-time getter, never a captured value. */
export type InitiativeAuditRatioPort = {
  /** The fraction of liaison self-decisions (`kind ∈ {inference, llm}`) that reach spot-check. */
  readAuditRatio(): number;
};

/** The installed reader, or null before `server/index.ts` assembles the process. */
let installedInitiativeAuditRatio: InitiativeAuditRatioPort | null = null;

/**
 * Installs the process's audit-ratio reader.
 *
 * Called by `server/index.ts` next to the other port installations. Re-installing the same
 * object is a no-op; the last installation wins, which is what a focused criterion that swaps
 * in a fixture wants.
 */
export function installInitiativeAuditRatioPort(port: InitiativeAuditRatioPort): void {
  installedInitiativeAuditRatio = port;
}

/**
 * Reads the configured sampling ratio, or null when the composition root has not installed a
 * reader. Null is left to the caller to interpret as "use the shipped default".
 */
export function readInitiativeAuditRatio(): number | null {
  return installedInitiativeAuditRatio?.readAuditRatio() ?? null;
}
