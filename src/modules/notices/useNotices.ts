import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';

/**
 * The client half of the notice model: the same wire shape `server/modules/notices` publishes
 * through `GET /api/notices`. It is duplicated rather than imported because the server tree and
 * the browser bundle do not share types, and the shape is the contract the route documents.
 */
export type NoticeLifecycle = 'event' | 'condition' | 'decision';

/** How loudly a notice may interrupt; `blocking` outranks `attention`, which outranks `info`. */
export type NoticeSeverity = 'info' | 'attention' | 'blocking';

/** The one action the slot may offer. `id` picks the confirm panel; `labelKey` is an i18n key. */
export type NoticePrimaryAction = {
  id: string;
  labelKey: string;
};

/** One 「need to know」 entry as `GET /api/notices` returns it. `title` is an i18n key. */
export type Notice = {
  id: string;
  source: string;
  lifecycle: NoticeLifecycle;
  severity: NoticeSeverity;
  revision: string;
  scope: 'global';
  title: string;
  params: Record<string, string | number>;
  primaryAction?: NoticePrimaryAction;
  raisedAt: string;
};

/** A user's answer to `GET /api/notices`: the entries the slot may show and the ones this user
 * dismissed at their current revision (the inbox's 「已忽略」 section). */
export type NoticeList = {
  active: Notice[];
  dismissed: Notice[];
};

/** Reads the user's notices. Injected in tests; the default talks to `/api/notices`. */
export type NoticeListPort = () => Promise<NoticeList>;

/** Sends the revision-bound dismissal. The response is read only for its status: a 409 means
 * the notice changed under the caller and the reading must be refreshed, not reported. */
export type NoticeDismissPort = (id: string, revision: string) => Promise<Response>;

/** What the notices surfaces read. `unavailable` is only reachable before any reading arrived;
 * a failed later poll keeps the last good reading rather than erasing a notice still on screen. */
export type NoticesView =
  | { status: 'loading' }
  | { status: 'ready'; active: Notice[]; dismissed: Notice[] }
  | { status: 'unavailable'; reason: string };

/** What `useNotices` hands its consumers. */
export type NoticesController = {
  view: NoticesView;
  /** Re-reads the list now, e.g. after a dismissal or after a confirmed deploy. */
  refresh: () => Promise<void>;
  /** Dismisses one notice at the revision it was read at. A 409 re-reads silently. */
  dismiss: (notice: Notice) => Promise<void>;
};

/** The poll the compact deploy strip used; the notice registry inherits it unchanged. */
export const NOTICES_POLL_INTERVAL_MS = 15_000;

const defaultList: NoticeListPort = async () => {
  const response = await api.notices.list();
  if (!response.ok) {
    throw new Error(`GET /api/notices answered ${response.status}`);
  }
  return (await response.json()) as NoticeList;
};

const defaultDismiss: NoticeDismissPort = (id, revision) => api.notices.dismiss(id, revision);

type UseNoticesDeps = {
  list?: NoticeListPort;
  dismiss?: NoticeDismissPort;
  pollMs?: number;
};

/**
 * Polls the user's notices and exposes the two writes its surfaces need.
 *
 * The ports are held in refs so a caller passing a fresh closure each render cannot restart the
 * poll or loop the refresh effect; only the interval duration itself is a dependency.
 */
export function useNotices({
  list = defaultList,
  dismiss = defaultDismiss,
  pollMs = NOTICES_POLL_INTERVAL_MS,
}: UseNoticesDeps = {}): NoticesController {
  const [view, setView] = useState<NoticesView>({ status: 'loading' });
  // The ports are read through refs so a caller passing a fresh closure each render cannot
  // restart the poll (which, with the state write below, would render → restart → write forever).
  // The sync effects are declared before the refresh effect so they run first in the same commit.
  const listRef = useRef(list);
  const dismissRef = useRef(dismiss);
  useEffect(() => {
    listRef.current = list;
  }, [list]);
  useEffect(() => {
    dismissRef.current = dismiss;
  }, [dismiss]);
  // Whether a reading has ever landed. A later failed poll must not replace a good reading: the
  // notice it carries may still be actionable.
  const hasReading = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await listRef.current();
      hasReading.current = true;
      setView({ status: 'ready', active: next.active, dismissed: next.dismissed });
    } catch (cause) {
      if (!hasReading.current) {
        setView({
          status: 'unavailable',
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      } else {
        console.error('Error refreshing notices:', cause);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [refresh, pollMs]);

  const dismissNotice = useCallback(
    async (notice: Notice) => {
      try {
        const response = await dismissRef.current(notice.id, notice.revision);
        // 409 is not a failure to report: the condition moved to a new revision between our read
        // and this write, so the server is right and our copy is stale. Re-read silently.
        if (response.ok || response.status === 409) {
          await refresh();
          return;
        }
        console.error(`Dismissing notice ${notice.id} answered ${response.status}`);
      } catch (cause) {
        // The reading is left in place; a dismissal that did not reach the server cannot make the
        // notice disappear locally, and the next poll corrects any disagreement.
        console.error('Error dismissing notice:', cause);
      }
    },
    [refresh],
  );

  return { view, refresh, dismiss: dismissNotice };
}
