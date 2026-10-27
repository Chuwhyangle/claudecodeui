import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { readSessionBroadcastPort } from '@/shared/ports/session-broadcast.port.js';
import type { AwaitingReplyListItem, AwaitingReplyReason, LLMProvider } from '@/shared/types.js';
import { resolveProjectDisplayName } from '@/shared/utils.js';

/**
 * Builds the sidebar's awaiting-reply snapshot from the sessions table.
 *
 * Module-private, and shared by the REST list read and the change announcer, so
 * a client that fetched the list and a client that received a pushed snapshot
 * cannot be shown different rows or different names for the same row.
 *
 * Archived sessions never appear: the store's query excludes them, because a
 * session the user put away is not something they still owe a reply.
 */
function buildAwaitingReplySnapshot(): AwaitingReplyListItem[] {
  const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

  return sessionsDb.getAwaitingReplySessions().map((session) => {
    const projectPath = session.project_path?.trim() ? session.project_path : null;
    let project = null;

    if (projectPath) {
      if (!projectCache.has(projectPath)) {
        projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
      }
      project = projectCache.get(projectPath) ?? null;
    }

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      projectId: project?.project_id ?? null,
      projectPath,
      projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
      sessionTitle: session.custom_name?.trim() || session.session_id,
      // The query only returns rows whose wait is set; these fallbacks describe
      // the type, not a state the store can produce.
      awaitingSince: session.awaiting_reply_at ?? new Date().toISOString(),
      reason: session.awaiting_reply_reason ?? 'completed',
    };
  });
}

/**
 * Pushes the current awaiting-reply snapshot to every open client.
 *
 * Failures are logged and swallowed: every caller is a provider run path or a
 * user action that has already done its real work (the row is written), and a
 * broadcast that could not be delivered must not turn that into a failure. The
 * next read of the list still shows the truth.
 */
function announceAwaitingReplySnapshot(): void {
  try {
    readSessionBroadcastPort()?.broadcastAwaitingReplyChanged(buildAwaitingReplySnapshot());
  } catch (error) {
    console.warn(
      `[sessions] announcing the awaiting-reply list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The sidebar's "awaiting reply" list: the sessions that have stopped and are
 * waiting on the user.
 *
 * READ BY the sidebar's awaiting-reply view (through the providers routes) and
 * by the change announcer below, which pushes the same snapshot over the
 * websocket so a list open in another tab or browser follows along.
 *
 * WRITTEN FROM the provider runtimes (a turn completed, a turn failed, a tool
 * approval is outstanding) and from the websocket chat gateway (a turn started,
 * which ends whatever wait the session was on). It lives in a service of its
 * own rather than on `sessionsService` because the runtimes need to write it
 * and `sessionsService` resolves providers through the registry — importing the
 * larger service from a provider file would close an import cycle, while this
 * one reads only the sessions table and the session-broadcast port.
 */
export const sessionAwaitingReplyService = {
  /**
   * Records that one session is now waiting on the user.
   *
   * The write is a no-op when the stored reading already says the same thing,
   * which is what keeps a run that reports twice (a `result` and then the run's
   * own tail) from re-announcing an unchanged list.
   */
  markSessionAwaitingReply(sessionId: string | null | undefined, reason: AwaitingReplyReason): boolean {
    if (!sessionId) {
      return false;
    }
    if (!sessionsDb.markSessionAwaitingReply(sessionId, reason)) {
      return false;
    }
    announceAwaitingReplySnapshot();
    return true;
  },

  /**
   * Records that one session is no longer waiting on the user.
   *
   * The three ways a wait ends all arrive here: the next turn started, a queued
   * permission prompt was answered, or the user removed the row by hand. A
   * clear is silent when nothing was waiting, so the many paths that run this
   * defensively (every send, every approval) announce only real changes.
   */
  clearSessionAwaitingReply(sessionId: string | null | undefined): boolean {
    if (!sessionId) {
      return false;
    }
    if (!sessionsDb.clearSessionAwaitingReply(sessionId)) {
      return false;
    }
    announceAwaitingReplySnapshot();
    return true;
  },

  /**
   * The list itself: every non-archived session waiting on the user, oldest
   * wait first, with enough project and session naming to draw a row without
   * consulting the project list.
   */
  listAwaitingReplySessions(): AwaitingReplyListItem[] {
    return buildAwaitingReplySnapshot();
  },
};
