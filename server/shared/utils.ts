import type { RenderedVoiceContextLimits } from '@shared/voice/voiceContextTruncation.js';

/**
 * Whether a resident session's run IS its turn (SPEC §6, `RESIDENT_RUN_IS_TURN`).
 *
 * The one place the flag is spelled. The resident host driver
 * (`claude-host-driver.provider.ts`) and the websocket run registry
 * (`chat-run-registry.service.ts`, and through it `chat-websocket.service.ts`
 * and `chat-control.service.ts`) both import it from here; `modules/websocket`'s
 * barrel re-exports it for the MCP gateway's criteria, which print it beside
 * their readings.
 *
 * It lives in this leaf rather than in either consumer because the two sides
 * sit on an ESM evaluation-order boundary: the providers module may not import
 * the websocket module (that edge would close a cycle and trip the
 * `providerRegistry` TDZ), so before this leaf each side carried its own copy of
 * the predicate — two spellings of one string. The predicate stays in this root evaluation leaf (the split's util helpers
 * live in `./utils/` and re-export through here), so both sides reach the same
 * single reader without closing anything.
 *
 * Read at CALL time, never cached at module load: a criterion sets the variable
 * in its own body, after every importer has been evaluated, so a module-level
 * constant would answer the flag-off value and the criterion would measure the
 * old path while believing it measured the new one. The flag is off unless the
 * variable is exactly `1`.
 */
export function residentRunIsTurn(): boolean {
  return process.env.RESIDENT_RUN_IS_TURN === '1';
}

// ---------------------------
//----------------- CLAUDE TRANSCRIPT ROW CLASSIFICATION UTILITIES ------------

/**
 * Row types the Claude CLI writes to record the request it sent to the API,
 * not the conversation. `api-request-blob` carries the wire message itself
 * (`message: { role, content }`) under the session's `sessionId` but with no
 * `uuid` or `timestamp`; the others are bookkeeping around it.
 */
const CLAUDE_REQUEST_CAPTURE_ROW_TYPES: ReadonlySet<string> = new Set([
  'api-request-blob',
  'api-request',
  'api-request-shape',
  'atis-latch',
]);

/**
 * Whether one parsed Claude transcript row is a request-capture row rather than
 * a conversation row.
 *
 * A reader that projects or indexes rows by `message.role` must skip these: a
 * blob looks like a user or assistant row, so it would surface as a duplicate
 * prompt under a generated id, and as speech the user never wrote (the text
 * blocks the CLI adds only to the wire request, such as `Tool loaded.`). Pass
 * an already `JSON.parse`d row; any non-object or row without a string `type`
 * is not a capture row.
 *
 * Consumed by the Claude history reader (`claude-sessions.provider`) and the
 * conversation search service, which each read the transcript line by line.
 */
export function isClaudeRequestCaptureRow(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') {
    return false;
  }
  const type = (entry as { type?: unknown }).type;
  return typeof type === 'string' && CLAUDE_REQUEST_CAPTURE_ROW_TYPES.has(type);
}

//----------------- VOICE RUNTIME CONFIG PORT ------------

/**
 * One deployment-level reading of the runtime knobs a voice consumer needs.
 *
 * Deliberately NARROW: the context pack's three numbers and nothing else. The route that serves
 * them to the browser, the one-shot dictation path and the Live Voice proxy all read the SAME
 * installed reader, so one settings-file edit governs every voice entry without a restart.
 */
export type VoiceRuntimeConfigReading = {
  contextPack: RenderedVoiceContextLimits;
  /** Whether the settings file was read and accepted (`file`) or the defaults stood (`default`). */
  source?: 'default' | 'file';
  /** Readable warnings (a refused block, an unreadable file), oldest first. */
  warnings?: readonly string[];
};

/**
 * The installed reader, or null before the composition root installs one.
 *
 * WHY A PORT RATHER THAN AN IMPORT. The reader lives in the `voice-realtime` module (it owns the
 * settings-file loader), while its consumers live in the `voice` module. A direct `voice →
 * voice-realtime` import closes a real import cycle through the websocket/providers cluster (the
 * AC-394 ratchet reds on it), and the alternative — duplicating the loader — would let the two
 * voice entries drift. So the composition root, which already imports both modules, installs the
 * reader here and each consumer resolves it through this shared port. Absent means "no runtime
 * configuration wired": consumers fall back to the shipped defaults.
 */
let installedVoiceRuntimeConfigReader: (() => VoiceRuntimeConfigReading) | null = null;

/** Installs (or clears, with `null`) the process's runtime-config reader. Idempotent. */
export function installVoiceRuntimeConfigReader(reader: (() => VoiceRuntimeConfigReading) | null): void {
  installedVoiceRuntimeConfigReader = reader;
}

/**
 * Reads the installed runtime-config port, or `null` when the composition root has not installed
 * one (a leaf test, a probe, a process that never mounts the voice routes).
 *
 * The reader itself is invoked here, per call, so the settings file is re-read for each request /
 * connection — the hot-update contract — rather than snapshotted at install time.
 */
export function readInstalledVoiceRuntimeConfig(): VoiceRuntimeConfigReading | null {
  return installedVoiceRuntimeConfigReader === null ? null : installedVoiceRuntimeConfigReader();
}

//----------------- NUMERIC USAGE READS ------------

/**
 * Reads a numeric quantity, collapsing a missing or non-finite value to 0.
 *
 * Consumed by the Claude token-usage reader (`claude-token-usage.provider.ts`)
 * and the current-turn aggregator (`claude-turn-usage.ts`). Use
 * {@link readReportedUsageNumber} instead when "the source reported nothing"
 * must stay distinct from "the source reported zero".
 */
export function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

/**
 * Reads an optional quantity, keeping "the source reported a number" distinct
 * from "the source did not report this quantity" (`null`).
 *
 * Used for the cache subset reads so an absent field stays absent in a counts
 * shape instead of being fabricated as zero. Consumed by the same two Claude
 * usage readers as {@link readUsageNumber}.
 */
export function readReportedUsageNumber(value: unknown): number | null {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

export * from './utils/index.js';
export { readLastTranscriptRecord } from '@/shared/transcript-activity.js';
