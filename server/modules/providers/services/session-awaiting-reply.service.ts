import { sendAwaitingReplyDesktopAlert } from '@/modules/notifications/index.js';
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
 * Pushes one snapshot to every open client.
 *
 * Failures are logged and swallowed: every caller is a provider run path or a
 * user action that has already done its real work (the row is written), and a
 * broadcast that could not be delivered must not turn that into a failure. The
 * next read of the list still shows the truth.
 */
function broadcastAwaitingReplySnapshot(snapshot: AwaitingReplyListItem[]): void {
  try {
    readSessionBroadcastPort()?.broadcastAwaitingReplyChanged(snapshot);
  } catch (error) {
    console.warn(
      `[sessions] announcing the awaiting-reply list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Pushes the list as it stands now; used by the paths that only end a wait. */
function announceAwaitingReplySnapshot(): void {
  broadcastAwaitingReplySnapshot(buildAwaitingReplySnapshot());
}

/** The one sentence a desktop alert shows for why the session stopped. Private to the announcer. */
function describeAwaitingReplyReason(reason: AwaitingReplyReason): string {
  switch (reason) {
    case 'permission':
      return '等待你批准工具调用';
    case 'failed':
      return '运行出错，等待你处理';
    case 'completed':
      return '已跑完，等待你的回话';
    default:
      return '等待你的回话';
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
   *
   * A NEW wait — one whose row was not already waiting — also raises the
   * off-browser desktop alert, so a user who closed the page learns about it.
   * A mere reason change (a permission prompt arriving and then the turn
   * completing anyway) does not: it is the same thing still waiting to be
   * answered, and alerting again would ring once per event rather than once per
   * answer owed.
   */
  markSessionAwaitingReply(sessionId: string | null | undefined, reason: AwaitingReplyReason): boolean {
    if (!sessionId) {
      return false;
    }

    // Read before the write, because the write itself cannot tell a first mark
    // from a reason change and would otherwise alert on both.
    const wasWaiting = Boolean(sessionsDb.getSessionById(sessionId)?.awaiting_reply_at);

    if (!sessionsDb.markSessionAwaitingReply(sessionId, reason)) {
      return false;
    }

    const snapshot = buildAwaitingReplySnapshot();
    broadcastAwaitingReplySnapshot(snapshot);

    if (!wasWaiting) {
      const waiting = snapshot.find((item) => item.sessionId === sessionId);
      if (waiting) {
        sendAwaitingReplyDesktopAlert({
          sessionId: waiting.sessionId,
          title: `CloudCLI · ${waiting.sessionTitle}`.slice(0, 90),
          body: describeAwaitingReplyReason(waiting.reason),
        });
      }
    }

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
