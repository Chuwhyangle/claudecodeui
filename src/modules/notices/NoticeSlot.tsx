import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DeployConfirmDialog,
} from '@/modules/cockpit';
import type {
  DeployCommitReading,
  DeployExecutePort,
  DeployReadinessPort,
  DeployReadinessReading,
} from '@/modules/cockpit';
import NoticeInbox from '@/modules/notices/NoticeInbox';
import { useNotices } from '@/modules/notices/useNotices';
import type {
  Notice,
  NoticeDismissPort,
  NoticeListPort,
} from '@/modules/notices/useNotices';
import { api } from '@/shared/api';

/** The same read the cockpit's deploy strip performs; injected in tests. */
const defaultReadDeploy: DeployReadinessPort = async () => {
  const response = await api.system.deployReadiness();
  return (await response.json()) as DeployReadinessReading;
};

/** Lowest rank wins the slot. */
const SEVERITY_RANK: Record<Notice['severity'], number> = {
  blocking: 0,
  attention: 1,
  info: 2,
};

/** Only a non-blocking condition may be dismissed through the revision endpoint (N2). The
 * server enforces the same rule; rendering the button is the client's independent half. */
function isDismissible(notice: Notice): boolean {
  return notice.lifecycle === 'condition' && notice.severity !== 'blocking';
}

/** The slot's admission rule: global scope and at least `attention` (proposal §4.2). */
function isSlotWorthy(notice: Notice): boolean {
  return notice.scope === 'global' && SEVERITY_RANK[notice.severity] <= SEVERITY_RANK.attention;
}

/** Blocking first, then the newest `raisedAt`, then the id so same-millisecond entries stay
 * deterministic. The server already sorts, but the slot must not depend on that ordering. */
function compareNotices(left: Notice, right: Notice): number {
  const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (bySeverity !== 0) return bySeverity;
  if (left.raisedAt !== right.raisedAt) return right.raisedAt.localeCompare(left.raisedAt);
  return left.id.localeCompare(right.id);
}

type NoticeSlotProps = {
  list?: NoticeListPort;
  dismiss?: NoticeDismissPort;
  pollMs?: number;
  /** Reads the pending commits the shared confirmation panel lists; injected in tests. */
  readDeploy?: DeployReadinessPort;
  /** The confirmed write behind the shared panel; injected in tests so no request is sent. */
  deploy?: DeployExecutePort;
};

/**
 * The chat page's interrupt slot: at most ONE full notice, the rest folded behind 「另有 N 条」,
 * plus the inbox that keeps dismissed entries reachable (N4/N6). It replaces the cockpit's compact
 * deploy strip, so a deploy notice's primary action opens the SAME confirmation panel the cockpit
 * uses — the panel, not this button, is what sends `POST /api/system/deploy` (N7).
 *
 * Used by `WorkspaceMain` through the `noticeSlot` prop of `ChatInterface`.
 */
export default function NoticeSlot({
  list,
  dismiss,
  pollMs,
  readDeploy = defaultReadDeploy,
  deploy,
}: NoticeSlotProps) {
  const { t } = useTranslation();
  const { view, refresh, dismiss: dismissNotice } = useNotices({ list, dismiss, pollMs });
  const [inboxOpen, setInboxOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingCommits, setPendingCommits] = useState<DeployCommitReading[]>([]);

  const visible = useMemo(
    () =>
      view.status === 'ready'
        ? view.active.filter(isSlotWorthy).sort(compareNotices)
        : [],
    [view],
  );
  const dismissed = useMemo(
    () =>
      view.status === 'ready'
        ? view.dismissed.filter(isSlotWorthy).sort(compareNotices)
        : [],
    [view],
  );

  /**
   * Opens the shared confirmation panel. The commit list is read from the same readiness port the
   * cockpit strip uses; failing to read it still opens the panel rather than sending anything, so
   * the confirm button stays the only way a deploy starts.
   */
  const openConfirm = useCallback(async () => {
    setConfirmOpen(true);
    try {
      const reading = await readDeploy();
      setPendingCommits(reading.pendingCommits);
    } catch (cause) {
      console.error('Error reading the deploy commits for the confirmation panel:', cause);
      setPendingCommits([]);
    }
  }, [readDeploy]);

  const handleDismiss = useCallback(
    (notice: Notice) => {
      void dismissNotice(notice);
    },
    [dismissNotice],
  );

  const [head, ...others] = visible;
  // No interruptible entry, no slot: dismissing the last notice must leave the transcript alone.
  // The inbox stays reachable through the fold line whenever the slot is up (including its
  // 「已忽略」 group when the remaining entries are all folded).
  if (head === undefined) {
    return null;
  }

  const folded = others.length;
  const hasFoldLine = folded > 0 || dismissed.length > 0;

  return (
    <section
      data-testid="notice-slot"
      className="relative shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs"
      aria-label={t('notices.inboxTitle')}
    >
      <div
        data-testid="notice-entry"
        data-notice-id={head.id}
        data-severity={head.severity}
        className="flex flex-wrap items-center gap-2"
      >
        <span data-testid="notice-title" className="text-foreground">
          {t(head.title, head.params)}
        </span>

        {head.primaryAction !== undefined && (
          <button
            type="button"
            data-testid="notice-primary-action"
            className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
            onClick={() => void openConfirm()}
          >
            {t(head.primaryAction.labelKey)}
          </button>
        )}

        {isDismissible(head) && (
          <button
            type="button"
            data-testid="notice-dismiss"
            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
            onClick={() => handleDismiss(head)}
          >
            {t('notices.dismiss')}
          </button>
        )}
      </div>

      {hasFoldLine && (
        <button
          type="button"
          data-testid={folded > 0 ? 'notice-more' : 'notice-inbox-toggle'}
          className="mt-1 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={inboxOpen}
          onClick={() => setInboxOpen((open) => !open)}
        >
          {folded > 0 ? t('notices.more', { n: folded }) : t('notices.inboxTitle')}
        </button>
      )}

      {inboxOpen && (
        <NoticeInbox active={others} dismissed={dismissed} onDismiss={handleDismiss} />
      )}

      {confirmOpen && (
        <DeployConfirmDialog
          pendingCommits={pendingCommits}
          deploy={deploy}
          onCancel={() => setConfirmOpen(false)}
          onDeployed={() => {
            setConfirmOpen(false);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
