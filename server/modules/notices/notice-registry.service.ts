/**
 * The notice registry — the ONE place that answers 「这个用户现在有哪些需要人知道的事」.
 *
 * A Notice is modelled by its LIFECYCLE, not by its source: an `event` happens once, a
 * `condition` stays true until the world changes, and a `decision` waits for a ruling. P1 only
 * wires `condition` (the deploy strip is the first source); `event` and `decision` are kept in
 * the type so the model is complete, and no branch here pretends to implement them.
 *
 * Dismissal is a per-user statement about a REVISION, never a deletion (N1/N6): the row records
 * 「I have seen revision X of notice Y」, and the moment the provider raises revision Z the notice
 * is active again. `blocking` notices cannot be dismissed at all (N2), and the check lives HERE,
 * on the server, rather than only in the client's rendering choice.
 *
 * The registry owns no provider: `server/index.ts` (the composition root) injects the list, which
 * is what keeps this module from importing the system module (N8).
 */

import { AppError } from '@/shared/utils.js';

//----------------- NOTICE MODEL ------------
/**
 * How long a notice lives. `event` = one-off (shown until confirmed), `condition` = true for as
 * long as the world says so (its dismissal is bound to `revision`), `decision` = waits for a
 * human ruling. P1 implements `condition` only.
 */
export type NoticeLifecycle = 'event' | 'condition' | 'decision';

/**
 * How loudly a notice may interrupt. `blocking` outranks `attention`, which outranks `info`;
 * the slot renders at most one notice and picks the highest severity first. `blocking` notices
 * are never dismissible.
 */
export type NoticeSeverity = 'info' | 'attention' | 'blocking';

/** The one action the chat-page slot may offer. The client maps `id` to its confirm panel and
 * renders `labelKey` through i18n; the server never ships rendered text. */
export type NoticePrimaryAction = {
  id: string;
  labelKey: string;
};

/**
 * One 「need to know」 entry.
 *
 * - `id` is the stable identity of the CONDITION (`deploy:pending-build`), not of one occurrence.
 * - `revision` is the version key a dismissal is bound to: for the deploy source it is the
 *   commit sha the condition is about. A different revision is a different message.
 * - `title` is an i18n KEY plus `params`, never rendered prose.
 * - `raisedAt` is when the current revision of the condition was observed, as an ISO string.
 */
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

/** What a source supplies. A provider reads the world and returns the notices that are true
 * right now; it holds no per-user state — dismissal is applied by the registry. */
export type NoticeProvider = {
  source: string;
  read(): Promise<Notice[]>;
};

/** A user's answer to `GET /api/notices`: the interruptible/visible entries and the ones this
 * user already dismissed at their current revision (the inbox's 「已忽略」 section). */
export type NoticeList = {
  active: Notice[];
  dismissed: Notice[];
};
// ---------------------------

//----------------- DISMISSAL PERSISTENCE ------------
/**
 * The per-user dismissal table the registry reads and writes. `dismiss` upserts `(userId,
 * noticeId)` so only the most recently dismissed revision is kept. Implemented by
 * `modules/database`'s `noticeDismissalsDb`; a criterion substitutes an in-memory one.
 */
export type NoticeDismissalsStore = {
  /** The revision this user dismissed for `noticeId`, or null when they never dismissed it. */
  getDismissedRevision(userId: number, noticeId: string): string | null;
  /** Records that the user has seen `revision` of `noticeId`, replacing any earlier revision. */
  dismiss(userId: number, noticeId: string, revision: string): void;
};
// ---------------------------

//----------------- REGISTRY ------------
/** The registry's dependencies: the provider list (injected by the composition root) and the
 * dismissal table. */
export type NoticeRegistryDeps = {
  providers: NoticeProvider[];
  dismissals: NoticeDismissalsStore;
};

/** What routes and future callers use. Both methods read every provider on every call, so a
 * condition that changed between two requests is visible without a restart. */
export type NoticeRegistry = {
  /** Every provider's notices, with this user's dismissals applied and the order the slot needs. */
  list(userId: number): Promise<NoticeList>;
  /** Records the user's dismissal of `noticeId` at `revision`, or throws with the HTTP status
   * the route must answer: 404 (no such notice), 403 (not dismissible), 409 (stale revision). */
  dismiss(userId: number, noticeId: string, revision: string): Promise<{ ok: true }>;
};

/** Lowest number wins the slot. */
const SEVERITY_RANK: Record<NoticeSeverity, number> = {
  blocking: 0,
  attention: 1,
  info: 2,
};

/**
 * Only a `condition` that is not `blocking` may be dismissed through the revision endpoint.
 * `event` means 「confirmed」 and `decision` means 「ruled on」 — neither is a revision dismissal,
 * and P1 does not implement either, so they stay non-dismissible rather than being silently
 * treated as conditions.
 */
function isDismissible(notice: Notice): boolean {
  return notice.lifecycle === 'condition' && notice.severity !== 'blocking';
}

/**
 * The slot's order: severity first (blocking > attention > info), then the newest `raisedAt`,
 * then the id so two notices raised in the same millisecond still order deterministically.
 */
function compareNotices(left: Notice, right: Notice): number {
  const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (bySeverity !== 0) return bySeverity;
  if (left.raisedAt !== right.raisedAt) return right.raisedAt.localeCompare(left.raisedAt);
  return left.id.localeCompare(right.id);
}

/**
 * Builds the registry over the injected providers and dismissal table.
 *
 * Consumers: `server/index.ts` (creates the one process-wide registry behind `GET
 * /api/notices`), and `server/modules/notices/tests/notice-registry.test.ts`.
 */
export function createNoticeRegistry(deps: NoticeRegistryDeps): NoticeRegistry {
  /** Every provider's current notices, un-collated and unfiltered. */
  const collectNotices = async (): Promise<Notice[]> => {
    const perProvider = await Promise.all(deps.providers.map((provider) => provider.read()));
    return perProvider.flat();
  };

  return {
    async list(userId: number): Promise<NoticeList> {
      const notices = await collectNotices();
      const active: Notice[] = [];
      const dismissed: Notice[] = [];

      for (const notice of notices) {
        // A stale row (an earlier revision) does not suppress the current one, and a row for a
        // notice that has since become non-dismissible is ignored rather than hidden.
        const alreadyDismissed = isDismissible(notice)
          && deps.dismissals.getDismissedRevision(userId, notice.id) === notice.revision;
        (alreadyDismissed ? dismissed : active).push(notice);
      }

      active.sort(compareNotices);
      dismissed.sort(compareNotices);
      return { active, dismissed };
    },

    async dismiss(userId: number, noticeId: string, revision: string): Promise<{ ok: true }> {
      const notice = (await collectNotices()).find((candidate) => candidate.id === noticeId);
      if (notice === undefined) {
        throw new AppError(`Notice ${noticeId} does not exist`, {
          code: 'NOTICE_NOT_FOUND',
          statusCode: 404,
        });
      }
      // Permission before revision: 「you may never dismiss this one」 is not a stale-write case,
      // and a blocked dismiss must not write a row even when the revision happens to match.
      if (!isDismissible(notice)) {
        throw new AppError(`Notice ${noticeId} is not dismissible`, {
          code: 'NOTICE_NOT_DISMISSIBLE',
          statusCode: 403,
        });
      }
      if (notice.revision !== revision) {
        throw new AppError(
          `Notice ${noticeId} changed since it was read (current revision ${notice.revision})`,
          { code: 'NOTICE_REVISION_CONFLICT', statusCode: 409 },
        );
      }
      deps.dismissals.dismiss(userId, noticeId, revision);
      return { ok: true };
    },
  };
}
// ---------------------------
