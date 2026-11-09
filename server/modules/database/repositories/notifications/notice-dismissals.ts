/**
 * Notice dismissal repository.
 *
 * One row per `(user, notice)`, holding the revision the user dismissed. The upsert keeps only
 * the latest revision: a dismissal is 「I have seen THIS revision」, so an older one carries no
 * information once the notice re-raises at a newer revision (N1).
 */

import { getConnection } from '@/modules/database/core/index.js';

export const noticeDismissalsDb = {
  /** The revision this user dismissed for `noticeId`, or null when there is no row. */
  getDismissedRevision(userId: number, noticeId: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT revision FROM user_notice_dismissals WHERE user_id = ? AND notice_id = ?',
      )
      .get(userId, noticeId) as { revision: string } | undefined;
    return row?.revision ?? null;
  },

  /** Upserts the dismissal, replacing the revision of an earlier dismissal of the same notice. */
  dismiss(userId: number, noticeId: string, revision: string): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO user_notice_dismissals (user_id, notice_id, revision, dismissed_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, notice_id) DO UPDATE SET
         revision = excluded.revision,
         dismissed_at = CURRENT_TIMESTAMP`,
    ).run(userId, noticeId, revision);
  },
};
