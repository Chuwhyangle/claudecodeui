/**
 * Which Claude sessions have a Live Voice connection RIGHT NOW — the one fact the resident launch's
 * `UserPromptSubmit` hook gates its rule injection on.
 *
 * WHY PROCESS STATE AND NOT A MARKER FILE. The gate used to be a file the relay wrote at
 * `~/.cloudcli/voice-active/<session id>` because the hook ran in a DIFFERENT process (a command hook
 * the CLI spawned on every prompt), so a file was the cheapest channel between them. When the hook
 * became an IN-PROCESS callback in the resident launch's own process, both the relay and the hook
 * moved into the same address space — and a file's two costs came with them: a spawn on every prompt
 * is gone, but a file also OUTLIVES a relay that was killed, which is why a start-up sweep had to
 * paper over the leftovers. A `Set` cannot outlive its process, so there is nothing to sweep.
 *
 * WHY IT IMPORTS NOTHING, DELIBERATELY (a leaf). Two modules that otherwise sit on opposite sides of
 * this repository's import graph need this one fact: `voice-realtime-ws-proxy.service.ts` (the relay,
 * which owns the connection's lifetime) and `claude-host-driver.provider.ts` (the launch, which reads
 * the fact at prompt-submit time). The relay's own module barrel reaches the MCP gateway, which reaches
 * the providers module, which reaches the launch — so anything imported into this file would close that
 * loop. Importing nothing is what lets both sides depend on it without a cycle.
 *
 * Consumed by `voice-realtime-ws-proxy.service.ts` (marks a session active when its connection is
 * handled, clears it on every exit) and by `claude-host-driver.provider.ts` (the dispatch hook callback
 * asks {@link isVoiceSessionActive} about the session that is submitting the prompt).
 */

/**
 * The sessions with a Live Voice connection in THIS process.
 *
 * A session id is added the moment a browser connection is handled and removed by every path that ends
 * one — a teardown, a raw socket close, or a transport that failed to construct. Those paths race by
 * design and two of them often run for the same connection; the mutation is a `Set` add/delete, so the
 * race resolves to the same value no matter which of them lands last.
 */
const activeVoiceSessions = new Set<string>();

/**
 * Records that `sessionId` is in Live Voice. Called by the relay as a connection is handled — before
 * the upstream is open, so a prompt submitted in the gap between "voice connected" and "upstream open"
 * is still told it is in a voice session.
 *
 * The empty string is ignored rather than stored: an unbound session must never read as active, and a
 * falsy id is what a caller with no bound session hands over.
 */
export function markVoiceSessionActive(sessionId: string): void {
  if (sessionId === '') {
    return;
  }
  activeVoiceSessions.add(sessionId);
}

/**
 * Records that `sessionId` is no longer in Live Voice. Idempotent, and safe for a session that was
 * never marked: the relay's three exits (a teardown, a raw socket close, a transport that never
 * constructed) race by construction — at most one of them runs, and often two of them do.
 */
export function clearVoiceSessionActive(sessionId: string): void {
  activeVoiceSessions.delete(sessionId);
}

/**
 * Whether `sessionId` is in Live Voice in this process. Read by the resident launch's
 * `UserPromptSubmit` callback at the moment a prompt is submitted: true means this session's prompt is
 * about to be answered under the Live Voice rules, false means the launch behaves exactly as it would
 * with no hook installed at all.
 */
export function isVoiceSessionActive(sessionId: string): boolean {
  return sessionId !== '' && activeVoiceSessions.has(sessionId);
}
