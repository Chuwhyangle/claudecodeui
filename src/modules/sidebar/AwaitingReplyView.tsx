import { useMemo } from 'react';
import { Inbox, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { useTickingNow } from '@/modules/sidebar/hooks/useTickingNow';
import { formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { AwaitingReplyListItem, AwaitingReplyReason } from '@/shared/awaitingReplyType';

/**
 * The Awaiting reply view: the sessions that have stopped and are waiting on the
 * user — a finished turn, a failed turn, or an unanswered tool approval.
 *
 * Rows are grouped by project because the list spans projects and a user
 * triaging a backlog reads "what does this project owe me" before "which
 * session"; the reason stays a badge on the row rather than a heading over it,
 * so a session that failed while another finished is still one project group,
 * not two.
 *
 * The rows are the view's own, not `SidebarProjectList`'s, because the list
 * includes sessions the sidebar may never have loaded — the row has to be
 * drawable from the `AwaitingReplyListItem` alone. Each row is still one click
 * from its session: opening it hands the item to `onOpen`, which navigates and
 * takes the row off the list.
 */
type AwaitingReplyViewProps = {
  /** The rows exactly as the server last reported them, oldest first; the view only groups. */
  sessions: AwaitingReplyListItem[];
  /** True only while a read is outstanding with nothing on screen yet. */
  isLoading: boolean;
  /** The last read's failure message, or null. */
  error: string | null;
  /** False while the socket that pushes whole-list frames is down; the list may be stale. */
  isConnected: boolean;
  /** The sidebar search box's text; applied to the session and project names. */
  searchQuery: string;
  /** Opens the session and takes it off the list; the caller decides how to navigate. */
  onOpen: (session: AwaitingReplyListItem) => void;
  /** Takes the session off the list without opening it. */
  onDismiss: (sessionId: string) => void;
  /** Re-reads the list after a failed read. */
  onRetry: () => void;
  t: TFunction;
};

/**
 * How each reason is drawn: the word over the row and the colour of its badge.
 *
 * Kept as one table rather than a chain of ternaries so the three reasons are
 * visibly a closed set — a new `AwaitingReplyReason` fails to type-check here
 * instead of silently rendering with no colour.
 *
 * The colours are the repository's existing accent families and none are new:
 * amber for a person's decision that is blocking a run, red for a failure, the
 * neutral/green pair for a turn that merely ended.
 */
const REASON_PRESENTATION: Record<
  AwaitingReplyReason,
  { labelKey: string; fallbackLabel: string; badgeClassName: string }
> = {
  permission: {
    labelKey: 'awaitingReply.reasonPermission',
    fallbackLabel: 'Waiting for approval',
    badgeClassName: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  failed: {
    labelKey: 'awaitingReply.reasonFailed',
    fallbackLabel: 'Failed',
    badgeClassName: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  },
  completed: {
    labelKey: 'awaitingReply.reasonCompleted',
    fallbackLabel: 'Finished',
    badgeClassName: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
};

/** One project's slice of the list, keyed by the server's project identity. */
type AwaitingReplyGroup = {
  key: string;
  projectDisplayName: string;
  sessions: AwaitingReplyListItem[];
};

/**
 * Groups the server's flattened rows by project, preserving order.
 *
 * A stable first-seen order rather than a re-sort: the server already sorts by
 * how long the user has owed a reply, so the group whose oldest wait is oldest
 * appears first, and the rows inside a group keep that same ordering.
 */
function groupByProject(sessions: AwaitingReplyListItem[]): AwaitingReplyGroup[] {
  const groups = new Map<string, AwaitingReplyGroup>();

  for (const session of sessions) {
    const key = session.projectId ?? session.projectPath ?? `session:${session.sessionId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    groups.set(key, {
      key,
      projectDisplayName: session.projectDisplayName,
      sessions: [session],
    });
  }

  return [...groups.values()];
}

/** Used by `SidebarContent` when the sidebar's mode is `awaiting-reply`, and by the sidebar's tests. */
export default function AwaitingReplyView({
  sessions,
  isLoading,
  error,
  isConnected,
  searchQuery,
  onOpen,
  onDismiss,
  onRetry,
  t,
}: AwaitingReplyViewProps) {
  // The wait ages are drawn in minutes and hours, but the reading has to move
  // while the page sits open — a row that still says `5m` an hour later is
  // worse than no age at all. One shared tick for the whole list, and none at
  // all while there is nothing to age.
  const now = useTickingNow(sessions.length > 0);
  const currentTime = useMemo(() => new Date(now), [now]);

  // The search box has to work here too: this list is the one place a user looks
  // for a specific session among the ones they owe an answer, and a box that did
  // nothing on this tab would read as broken. Both names are matched because the
  // row draws both.
  const visibleGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matched = query.length === 0
      ? sessions
      : sessions.filter((session) => session.sessionTitle.toLowerCase().includes(query)
        || session.projectDisplayName.toLowerCase().includes(query));
    return groupByProject(matched);
  }, [sessions, searchQuery]);

  // The count the list publishes is the rows a reader can actually see after the
  // search filter, not the whole inbox: the two disagree exactly when the user
  // is looking at a filtered list, and the visible number is the honest one.
  const visibleCount = useMemo(
    () => visibleGroups.reduce((sum, group) => sum + group.sessions.length, 0),
    [visibleGroups],
  );

  if (isLoading && sessions.length === 0) {
    return (
      <div className="space-y-2 px-2 py-1" data-awaiting-reply-view="true" data-awaiting-reply-loading="true" aria-busy="true">
        {[0, 1].map((skeleton) => (
          <div key={skeleton} className="animate-pulse rounded-lg border border-border/50 bg-card/40 px-3 py-2">
            <div className="h-3 w-2/3 rounded bg-muted" />
            <div className="mt-2 h-2 w-1/3 rounded bg-muted/70" />
          </div>
        ))}
      </div>
    );
  }

  // Nothing waiting at all: the list's own empty state, which is a different
  // answer from "your search matched nothing" and so is drawn differently.
  if (sessions.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8" data-awaiting-reply-view="true" data-awaiting-reply-empty="true">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border/70 bg-muted/50 md:mb-3">
          <Inbox className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
          {t('awaitingReply.emptyTitle', 'Nothing awaiting your reply')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(
            'awaitingReply.emptyDescription',
            'Sessions that finish a turn, fail, or wait for a tool approval appear here until you reply.',
          )}
        </p>
        {isConnected ? null : (
          <OfflineHint className="mt-3 justify-center" onRetry={onRetry} t={t} />
        )}
        {error ? (
          <FailedReadMessage message={error} onRetry={onRetry} retryLabel={t('awaitingReply.retry', 'Retry')} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-awaiting-reply-view="true" data-awaiting-reply-count={visibleCount}>
      {isConnected ? null : (
        <OfflineHint className="px-2" onRetry={onRetry} t={t} />
      )}
      {error ? (
        <div className="px-2">
          <FailedReadMessage message={error} onRetry={onRetry} retryLabel={t('awaitingReply.retry', 'Retry')} />
        </div>
      ) : null}

      {visibleGroups.length === 0 ? (
        <p data-awaiting-reply-no-match="true" className="px-4 py-2 text-[11px] text-muted-foreground">
          {t('awaitingReply.noMatchingSessions', 'No sessions match this search.')}
        </p>
      ) : (
        visibleGroups.map((group) => (
          <section
            key={group.key}
            data-awaiting-reply-group="true"
            data-awaiting-reply-group-id={group.key}
            data-awaiting-reply-group-count={group.sessions.length}
            className="space-y-1"
          >
            <div className="mx-2 flex items-center justify-between rounded-lg border border-border/60 bg-card/50 px-3 py-2 shadow-sm">
              <span data-awaiting-reply-project-name="true" className="min-w-0 truncate text-xs font-normal text-foreground">
                {group.projectDisplayName}
              </span>
              <span className="flex-shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-normal text-amber-700 dark:text-amber-300">
                {group.sessions.length}
              </span>
            </div>

            {group.sessions.map((session) => {
              const reason = REASON_PRESENTATION[session.reason] ?? REASON_PRESENTATION.completed;
              const age = formatCompactAge(session.awaitingSince, currentTime);

              return (
                <div
                  key={session.sessionId}
                  data-awaiting-reply-session={session.sessionId}
                  // The reason is published as an ASCII token as well as drawn, so a
                  // reader outside the component can tell a blocked approval from a
                  // finished turn without parsing a translated word.
                  data-awaiting-reply-reason={session.reason}
                  className="mx-2 flex items-start gap-2 rounded-lg border border-border/50 bg-card/30 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <a
                      href={`/session/${session.sessionId}`}
                      title={session.sessionTitle}
                      // Opening a wait answers it in the only sense this list owns:
                      // the row leaves the inbox. The href stays real so the link
                      // still works without JavaScript, and a middle-click or a
                      // copied link is not turned into an in-list action.
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
                          return;
                        }
                        event.preventDefault();
                        onOpen(session);
                      }}
                      className="block truncate text-xs text-foreground hover:underline"
                    >
                      {session.sessionTitle}
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                      <span
                        data-awaiting-reply-reason-label="true"
                        className={`inline-flex flex-shrink-0 items-center rounded-full border px-1.5 py-px font-normal ${reason.badgeClassName}`}
                      >
                        {t(reason.labelKey, reason.fallbackLabel)}
                      </span>
                      <span data-awaiting-reply-age="true" className="flex-shrink-0 tabular-nums">
                        {t('awaitingReply.waitingFor', {
                          age,
                          defaultValue: 'waiting {{age}}',
                        })}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    data-awaiting-reply-dismiss="true"
                    // The visible word alone ("Remove") is not a name a screen reader
                    // can attribute to a row, so the accessible name states which
                    // session the button belongs to. The label is a shipped string,
                    // not assembled from the title in code.
                    aria-label={t('awaitingReply.dismissLabel', {
                      title: session.sessionTitle,
                      defaultValue: 'Remove {{title}} from awaiting reply',
                    })}
                    onClick={() => onDismiss(session.sessionId)}
                    className="flex h-5 flex-shrink-0 items-center gap-0.5 rounded-md px-1 text-[10px] text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    {t('awaitingReply.dismiss', 'Remove')}
                  </button>
                </div>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}

/**
 * The last failed read's sentence plus the way to ask again.
 *
 * A stale list with no retry is a dead end — the page only re-reads on a pushed
 * frame or a window focus, and a tab that stays focused has neither — so the
 * failure is drawn with the control that fixes it rather than as a bare line.
 */
function FailedReadMessage({ message, onRetry, retryLabel }: { message: string; onRetry: () => void; retryLabel: string }) {
  return (
    <span data-awaiting-reply-error="true" className="mt-1 flex items-center gap-2 text-[11px] text-red-600 dark:text-red-400">
      <span className="min-w-0 truncate">{message}</span>
      <button
        type="button"
        data-awaiting-reply-retry="true"
        onClick={onRetry}
        className="flex-shrink-0 rounded-md border border-red-500/30 px-1.5 py-0.5 text-[10px] hover:bg-red-500/10"
      >
        {retryLabel}
      </button>
    </span>
  );
}

/**
 * The dropped-socket note. The rows stay on screen — the socket is down, not the
 * data — but the list can no longer promise it is current, so the note says so
 * and offers the one action that can refresh it without waiting for a frame.
 */
function OfflineHint({ className, onRetry, t }: { className?: string; onRetry: () => void; t: TFunction }) {
  return (
    <span
      data-awaiting-reply-offline="true"
      className={`flex items-center gap-2 text-[11px] text-muted-foreground ${className ?? ''}`}
    >
      <span className="min-w-0 truncate">
        {t('awaitingReply.offlineHint', 'Live updates are offline — the list may be out of date.')}
      </span>
      <button
        type="button"
        data-awaiting-reply-retry="true"
        onClick={onRetry}
        className="flex-shrink-0 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-accent/80"
      >
        {t('awaitingReply.retry', 'Retry')}
      </button>
    </span>
  );
}
