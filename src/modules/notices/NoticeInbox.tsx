import { useTranslation } from 'react-i18next';

import type { Notice } from '@/modules/notices/useNotices';

type NoticeInboxProps = {
  /** The entries folded out of the slot (everything after the one full entry). */
  active: Notice[];
  /** Entries this user already dismissed at their current revision (N6: still findable). */
  dismissed: Notice[];
  /** Present when the inbox may dismiss an entry in place; omitted for a read-only list. */
  onDismiss?: (notice: Notice) => void;
};

/** Whether this notice may be dismissed through the revision-bound endpoint (N2). */
function isDismissible(notice: Notice): boolean {
  return notice.lifecycle === 'condition' && notice.severity !== 'blocking';
}

/**
 * The notices folded out of the interrupt slot: the rest of the active entries and, separately,
 * the ones this user already dismissed. Used by the notices module's `NoticeSlot` when its 「另有
 * N 条」 line is expanded.
 */
export default function NoticeInbox({ active, dismissed, onDismiss }: NoticeInboxProps) {
  const { t } = useTranslation();

  return (
    <section
      data-testid="notices-inbox"
      aria-label={t('notices.inboxTitle')}
      className="mt-1 space-y-1 rounded-md border border-border/60 bg-card/60 p-2"
    >
      {active.length > 0 && (
        <ul data-testid="notices-inbox-active" className="space-y-1">
          {active.map((notice) => (
            <li
              key={notice.id}
              data-testid="notice-inbox-entry"
              data-severity={notice.severity}
              className="flex items-start justify-between gap-2 text-xs"
            >
              <span>{t(notice.title, notice.params)}</span>
              {onDismiss !== undefined && isDismissible(notice) && (
                <button
                  type="button"
                  data-testid="notice-inbox-dismiss"
                  className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
                  onClick={() => onDismiss(notice)}
                >
                  {t('notices.dismiss')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {dismissed.length > 0 && (
        <div data-testid="notices-dismissed-group">
          <p data-testid="notices-dismissed-title" className="text-xs font-medium text-muted-foreground">
            {t('notices.dismissedGroup')}
          </p>
          <ul className="space-y-0.5">
            {dismissed.map((notice) => (
              <li
                key={notice.id}
                data-testid="notice-dismissed-entry"
                data-severity={notice.severity}
                className="text-xs text-muted-foreground"
              >
                {t(notice.title, notice.params)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
