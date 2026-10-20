import { getConnection } from '@/modules/database/core/index.js';
import type {
  VoiceIdentifierIncrement,
  VoiceIdentifierListItem,
  VoiceIdentifierRow,
} from '@/shared/types.js';

type CountRow = { count: number };

/**
 * Reads and writes the U-source lexicon: identifier-shaped tokens the user has
 * sent, with their frequency and the first/last instant each was seen.
 *
 * Used by the Voice module to serve `GET`/`DELETE /api/voice/lexicon` and
 * `POST /api/voice/lexicon/import`, and by the automatic recording path that
 * deposits a token whenever the user sends a message. The store holds only the
 * token, its counts and its timestamps — never the sentence it came from — so
 * nothing here can hand a caller the text it was mined from.
 */
export const voiceUserIdentifiersDb = {
  /**
   * Adds one occurrence of each entry's token, creating the row on first sight.
   *
   * The batch runs in one transaction so a send that contributes several tokens
   * is applied whole — a crash between two of them would otherwise leave a
   * frequency that no single message explains. The `canonical` spelling is kept
   * from the FIRST sighting (the conflict branch deliberately does not overwrite
   * it), so a later message that spells `cloudcli` does not rename a token the
   * listing already showed as `CloudCLI`.
   */
  incrementTokens(entries: VoiceIdentifierIncrement[]): void {
    if (entries.length === 0) {
      return;
    }

    const db = getConnection();
    const upsert = db.prepare(
      `INSERT INTO voice_user_identifiers (token_lower, canonical, count, first_seen_at, last_seen_at, project_key)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(token_lower, project_key) DO UPDATE SET
         count = count + 1,
         last_seen_at = excluded.last_seen_at`
    );

    db.transaction(() => {
      for (const entry of entries) {
        upsert.run(entry.tokenLower, entry.canonical, entry.at, entry.at, entry.projectKey);
      }
    })();
  },

  /**
   * Replaces the WHOLE table with the derived rows.
   *
   * This is the import path's write: a cold-start import recomputes the lexicon
   * from the complete history, so replacing (rather than merging) is what makes
   * running it twice — or running it after a live send — leave the same counts
   * rather than doubling them. The delete and the inserts share one transaction,
   * so a reader never observes the empty table a crash between the two would
   * leave behind.
   */
  replaceAll(entries: VoiceIdentifierRow[]): void {
    const db = getConnection();
    const insert = db.prepare(
      `INSERT INTO voice_user_identifiers (token_lower, canonical, count, first_seen_at, last_seen_at, project_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    db.transaction(() => {
      db.prepare('DELETE FROM voice_user_identifiers').run();
      for (const entry of entries) {
        insert.run(
          entry.tokenLower,
          entry.canonical,
          entry.count,
          entry.firstSeenAt,
          entry.lastSeenAt,
          entry.projectKey
        );
      }
    })();
  },

  /**
   * The most frequent tokens, most frequent first, summed across every project.
   *
   * The API returns one global list, so the per-project rows are summed here.
   * `token` is the canonical spelling of the highest-count row for that token —
   * a real casing the user typed, taken deterministically — and `lastSeenAt` is
   * the latest sighting across projects. `count DESC, token ASC` makes the order
   * total, so the same data always yields the same page.
   */
  listTop(limit: number): VoiceIdentifierListItem[] {
    return getConnection()
      .prepare(
        `SELECT
           (SELECT v2.canonical
              FROM voice_user_identifiers v2
             WHERE v2.token_lower = v.token_lower
             ORDER BY v2.count DESC, v2.canonical ASC
             LIMIT 1) AS token,
           SUM(v.count) AS count,
           MAX(v.last_seen_at) AS lastSeenAt
         FROM voice_user_identifiers v
         GROUP BY v.token_lower
         ORDER BY count DESC, token ASC
         LIMIT ?`
      )
      .all(limit) as VoiceIdentifierListItem[];
  },

  /** Empties the lexicon. Used by `DELETE /api/voice/lexicon` and by import's recompute. */
  clear(): void {
    getConnection().prepare('DELETE FROM voice_user_identifiers').run();
  },

  /**
   * How many rows the table holds.
   *
   * Exposed so a caller can read "the lexicon is empty" without a listing that
   * would also aggregate — the `DELETE` route's own criterion reads it directly.
   */
  countRows(): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS count FROM voice_user_identifiers')
      .get() as CountRow;
    return row.count;
  },
};
