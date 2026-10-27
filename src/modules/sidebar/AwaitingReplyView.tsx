import { useMemo } from 'react';
import { Inbox, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { useTickingNow } from '@/modules/sidebar/hooks/useTickingNow';
import { formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { AwaitingReplyListItem, AwaitingReplyReason } from '@/shared/types';

/**
 * The Awaiting reply view: the sessions that have stopped and are waiting on the
 * user — a finished turn, a failed turn, or an unanswered tool approval.
 *
 * A flat list rather than groups because every row answers the same question
 * ("what do I owe a reply"), and the reason is a badge on the row rather than a
 * heading over it: a session that failed while a second one finished is one
 * inbox, not two.
 *
 * The rows are the hook's own, not `SidebarProjectList`'s, because the list spans
 * projects and includes sessions the sidebar may never have loaded — the row has
 * to be drawable from the `AwaitingReplyListItem` alone. Each row is still one
 * click from its session, so a wait found here is one click from being answered.
 */
type AwaitingReplyViewProps = {
  /** The rows exactly as the server last reported them; the view never re-sorts. */
  sessions: AwaitingReplyListItem[];
  /** True only while a read is outstanding with nothing on screen yet. */
  isLoading: boolean;
  /** The last read's failure message, or null. */
  error: string | null;
  /** The sidebar search box's text; applied to the session and project names. */
  searchQuery: string;
  onDismiss: (sessionId: string) => void;
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

/** Used by `SidebarContent` when the sidebar's mode is `awaiting-reply`, and by the sidebar's tests. */
export default function AwaitingReplyView({
  sessions,
  isLoading,
  error,
  searchQuery,
  onDismiss,
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
  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length === 0) {
      return sessions;
    }
    return sessions.filter((session) => session.sessionTitle.toLowerCase().includes(query)
      || session.projectDisplayName.toLowerCase().includes(query));
  }, [sessions, searchQuery]);

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
        {error ? (
          <p data-awaiting-reply-error="true" className="mt-3 text-[11px] text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-awaiting-reply-view="true" data-awaiting-reply-count={visibleSessions.length}>
      {error ? (
        <p data-awaiting-reply-error="true" className="px-2 text-[11px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {visibleSessions.length === 0 ? (
        <p data-awaiting-reply-no-match="true" className="px-4 py-2 text-[11px] text-muted-foreground">
          {t('awaitingReply.noMatchingSessions', 'No sessions match this search.')}
        </p>
      ) : (
        visibleSessions.map((session) => {
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
                  className="block truncate text-xs text-foreground hover:underline"
                >
                  {session.sessionTitle}
                </a>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                  <span data-awaiting-reply-project="true" className="max-w-[45%] truncate">
                    {session.projectDisplayName}
                  </span>
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
        })
      )}
    </div>
  );
}
