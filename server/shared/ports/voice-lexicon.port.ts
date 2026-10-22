/**
 * The neutral accessor for the session-history reader the voice lexicon's
 * cold-start import needs.
 *
 * WHY THIS FILE EXISTS. `voice-lexicon.ts` recomputes the user's identifier
 * vocabulary from every indexed session's history, and the reader it uses is
 * `sessionsService.fetchHistory` — the very reader the messages route serves,
 * so a transcript format change is absorbed below the lexicon rather than
 * duplicated in it. That reader lives in `modules/providers`, and the voice
 * lexicon used to reach it through a literal dynamic
 * `import('@/modules/providers/index.js')`. The deferral kept module EVALUATION
 * order safe (chat dispatch makes `voice` depend on `websocket`, and `providers`
 * depends on `websocket`), but the directory scanner counts a literal dynamic
 * import exactly like a static one — so `modules/voice -> modules/providers`
 * stayed an edge and closed the eight-member import cycle. Deferring the import
 * was never the fix; removing the edge is.
 *
 * The answer is a port owned by the shared layer, following the same shape as
 * `voice-rules.port.ts`. `server/index.ts` (the composition root) installs the
 * real reader while assembling the process, and the lexicon reads it at call
 * time — only ever on the explicit `/lexicon/import` route, long after the
 * module graph has settled. The lexicon therefore imports `server/shared/**`
 * and nothing from `server/modules/**`, which is what takes `modules/voice` out
 * of the cycle.
 *
 * An uninstalled port is a wiring error, not an empty history: the lexicon's
 * caller asks for a real recomputation, and silently answering "no messages"
 * would look like a successful cold start that imported nothing. The read
 * raises instead, so a process assembled without the install line fails loudly
 * on the route rather than quietly emptying the vocabulary.
 *
 * Consumers: `modules/voice/voice-lexicon.ts` (reads the port) and
 * `server/index.ts` (the assembly that installs it). This file imports only a
 * type from `server/shared/`.
 */
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * The one capability the lexicon needs from the provider layer: read one
 * session's normalized history.
 *
 * Declared structurally rather than as `typeof sessionsService` so the shared
 * layer does not name a module-local implementation, and narrow to the call the
 * lexicon makes (`limit: null, offset: 0` — the whole transcript). A provider
 * service that grows more parameters still satisfies this shape.
 */
export type VoiceLexiconHistoryReader = {
  fetchHistory(
    sessionId: string,
    options: { limit: number | null; offset: number },
  ): Promise<{ messages: NormalizedMessage[] }>;
};

/** The installed history reader, or null before `server/index.ts` assembles the process. */
let installedVoiceLexiconHistory: VoiceLexiconHistoryReader | null = null;

/**
 * Installs the process's session-history reader.
 *
 * Called by `server/index.ts` next to the other port installations. Installing
 * the same object twice is a no-op; the last installation wins, which is what a
 * focused test that swaps in a fixture reader wants.
 */
export function installVoiceLexiconPort(port: VoiceLexiconHistoryReader): void {
  installedVoiceLexiconHistory = port;
}

/**
 * Reads the installed history reader, or null when the composition root has not
 * installed one.
 *
 * Null is left to the caller to interpret: the lexicon's import route treats it
 * as a wiring error and throws, rather than reporting a zero-message import.
 */
export function readVoiceLexiconPort(): VoiceLexiconHistoryReader | null {
  return installedVoiceLexiconHistory;
}
