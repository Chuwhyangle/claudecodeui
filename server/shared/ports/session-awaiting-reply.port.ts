/**
 * The neutral accessor for the providers module's awaiting-reply transitions.
 *
 * WHY THIS FILE EXISTS. `modules/providers/list/codex/host/codex-runtime.provider.ts`
 * would otherwise import `sessionAwaitingReplyService` from
 * `modules/providers/services`. That single import is the codex group's only
 * edge into the providers/services directory, and it closes the cycle
 * providers → list/codex → providers/services → providers that the codex
 * provider had no part in. The transition is needed only at CALL time (a turn
 * is waiting, a turn ended), so the composition root installs it instead of the
 * runtime importing it.
 *
 * `session-awaiting-reply.service.ts` installs the real implementation at the
 * bottom of its own module body, so a runtime that reaches the port after the
 * providers service has been evaluated sees the real one. A runtime reads the
 * port lazily through {@link readSessionAwaitingReplyPort}.
 *
 * An uninstalled port is read as a wiring fact, not as an empty write: a process
 * that never assembled the providers module has no session table to update, so
 * the transition is a no-op. Production always installs the real service.
 *
 * Consumers: `modules/providers/list/codex/host/codex-runtime.provider.ts` and
 * the service's own installation. Its only import is a type.
 */

import type { AwaitingReplyReason } from '@/shared/types.js';

/**
 * The two transitions a runtime needs and nothing more.
 *
 * Declared structurally rather than as `typeof sessionAwaitingReplyService` so
 * the shared layer does not name a module-local implementation. The real
 * service satisfies this contract with no adapter.
 */
export type SessionAwaitingReplyPort = {
  /** Records that one session is now waiting on the user. */
  markSessionAwaitingReply(sessionId: string | null | undefined, reason: AwaitingReplyReason): boolean;
  /** Records that one session is no longer waiting on the user. */
  clearSessionAwaitingReply(sessionId: string | null | undefined): boolean;
};

/** The installed transitions, or null before composition. */
let installedSessionAwaitingReply: SessionAwaitingReplyPort | null = null;

/**
 * Installs the process's awaiting-reply transitions.
 *
 * Called by `session-awaiting-reply.service.ts` at the bottom of its own module
 * body. Re-installing the same object is a no-op; the last installation wins,
 * which is what a focused criterion that swaps in a fixture wants.
 */
export function installSessionAwaitingReplyPort(port: SessionAwaitingReplyPort): void {
  installedSessionAwaitingReply = port;
}

/**
 * Reads the installed transitions, or null when the composition root has not
 * installed one.
 *
 * Null is left to the caller to interpret. A runtime treats it as "nobody is
 * recording waits": there is no session table to update, so the transition is a
 * no-op rather than a failure that would take down a turn.
 */
export function readSessionAwaitingReplyPort(): SessionAwaitingReplyPort | null {
  return installedSessionAwaitingReply;
}
