import { getConnection } from '@/modules/database/core/index.js';

/**
 * Persistence for the observation layer's five tables.
 *
 * The repository owns SQL only: it reads and writes rows, computes the next revision inside a
 * transaction, and never validates the domain (the store does that before it gets here). The
 * observation module reaches this file through `modules/database`'s barrel, so the table shape
 * stays private to the database module.
 *
 * Consumers: `server/modules/observation/observation-store.ts`, which is the only writer and
 * reader of these rows.
 */

/** One row of `observed_objects`, mapped to the store's field names. */
export type ObservedObjectRow = {
  uri: string;
  kind: string;
  title: string;
  statusState: string;
  statusReason: string | null;
  digestJson: string;
  revision: number;
  updatedAt: number;
  provenanceProducer: string;
  provenanceTier: string;
  provenanceEvaluatedAt: number;
};

/** One row of `observed_revisions`; `deltaItemsJson` is the encoded `string[]` of delta items. */
export type ObservedRevisionRow = {
  uri: string;
  revision: number;
  at: number;
  deltaItemsJson: string;
};

/** One user's seen cursor on one object. */
export type ObservationSeenCursorRow = {
  userId: string;
  uri: string;
  revision: number;
  at: number;
};

/** One user's pinned watch entry. */
export type ObservationWatchEntryRow = {
  userId: string;
  uri: string;
  pinnedAt: number;
};

/** One producer's liveness record; both timestamps are nullable because "never ran" is real. */
export type ObservationProducerHeartbeatRow = {
  producer: string;
  lastAttemptAt: number | null;
  lastWriteAt: number | null;
  lastError: string | null;
  expectedIntervalMs: number;
};

type ObservedObjectRowShape = {
  uri: string;
  kind: string;
  title: string;
  status_state: string;
  status_reason: string | null;
  digest_json: string;
  revision: number;
  updated_at: number;
  provenance_producer: string;
  provenance_tier: string;
  provenance_evaluated_at: number;
};

type ObservedRevisionRowShape = {
  uri: string;
  revision: number;
  at: number;
  delta_items_json: string;
};

type ObservationSeenCursorRowShape = {
  user_id: string;
  uri: string;
  revision: number;
  at: number;
};

type ObservationWatchEntryRowShape = {
  user_id: string;
  uri: string;
  pinned_at: number;
};

type ObservationProducerHeartbeatRowShape = {
  producer: string;
  last_attempt_at: number | null;
  last_write_at: number | null;
  last_error: string | null;
  expected_interval_ms: number;
};

/** Everything one appended revision carries; the repository assigns `revision` itself. */
export type AppendObservedRevisionInput = {
  uri: string;
  kind: string;
  title: string;
  statusState: string;
  statusReason: string | null;
  digestJson: string;
  at: number;
  deltaItemsJson: string;
  provenanceProducer: string;
  provenanceTier: string;
  provenanceEvaluatedAt: number;
};

function toObservedObjectRow(row: ObservedObjectRowShape): ObservedObjectRow {
  return {
    uri: row.uri,
    kind: row.kind,
    title: row.title,
    statusState: row.status_state,
    statusReason: row.status_reason,
    digestJson: row.digest_json,
    revision: row.revision,
    updatedAt: row.updated_at,
    provenanceProducer: row.provenance_producer,
    provenanceTier: row.provenance_tier,
    provenanceEvaluatedAt: row.provenance_evaluated_at,
  };
}

function toObservedRevisionRow(row: ObservedRevisionRowShape): ObservedRevisionRow {
  return {
    uri: row.uri,
    revision: row.revision,
    at: row.at,
    deltaItemsJson: row.delta_items_json,
  };
}

function toSeenCursorRow(row: ObservationSeenCursorRowShape): ObservationSeenCursorRow {
  return { userId: row.user_id, uri: row.uri, revision: row.revision, at: row.at };
}

function toWatchEntryRow(row: ObservationWatchEntryRowShape): ObservationWatchEntryRow {
  return { userId: row.user_id, uri: row.uri, pinnedAt: row.pinned_at };
}

function toProducerHeartbeatRow(
  row: ObservationProducerHeartbeatRowShape,
): ObservationProducerHeartbeatRow {
  return {
    producer: row.producer,
    lastAttemptAt: row.last_attempt_at,
    lastWriteAt: row.last_write_at,
    lastError: row.last_error,
    expectedIntervalMs: row.expected_interval_ms,
  };
}

/**
 * Reads and writes the observation layer's rows.
 *
 * APPEND IS ONE TRANSACTION. `appendRevision` reads the current revision and inserts the next
 * object state plus its revision row together, so a reader never observes an object whose
 * `revision` has no matching log entry (the delta reader would then silently lose items).
 *
 * Consumers: `server/modules/observation/observation-store.ts`.
 */
export const observationDb = {
  /** Appends one revision, returning it with the revision number the transaction assigned. */
  appendRevision(input: AppendObservedRevisionInput): ObservedRevisionRow {
    const db = getConnection();
    const append = db.transaction((entry: AppendObservedRevisionInput): number => {
      const current = db
        .prepare('SELECT revision FROM observed_objects WHERE uri = ?')
        .get(entry.uri) as { revision: number } | undefined;
      const revision = (current?.revision ?? 0) + 1;
      db.prepare(
        `INSERT INTO observed_objects (
           uri, kind, title, status_state, status_reason, digest_json, revision, updated_at,
           provenance_producer, provenance_tier, provenance_evaluated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET
           kind = excluded.kind,
           title = excluded.title,
           status_state = excluded.status_state,
           status_reason = excluded.status_reason,
           digest_json = excluded.digest_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at,
           provenance_producer = excluded.provenance_producer,
           provenance_tier = excluded.provenance_tier,
           provenance_evaluated_at = excluded.provenance_evaluated_at`,
      ).run(
        entry.uri,
        entry.kind,
        entry.title,
        entry.statusState,
        entry.statusReason,
        entry.digestJson,
        revision,
        entry.at,
        entry.provenanceProducer,
        entry.provenanceTier,
        entry.provenanceEvaluatedAt,
      );
      db.prepare(
        `INSERT INTO observed_revisions (uri, revision, at, delta_items_json)
         VALUES (?, ?, ?, ?)`,
      ).run(entry.uri, revision, entry.at, entry.deltaItemsJson);
      return revision;
    });
    const revision = append(input);
    return { uri: input.uri, revision, at: input.at, deltaItemsJson: input.deltaItemsJson };
  },

  /** The current state of one object, or `null` before its producer ever wrote it. */
  readObject(uri: string): ObservedObjectRow | null {
    const row = getConnection()
      .prepare('SELECT * FROM observed_objects WHERE uri = ?')
      .get(uri) as ObservedObjectRowShape | undefined;
    return row === undefined ? null : toObservedObjectRow(row);
  },

  /** Every observed object, for the wall's candidate set. */
  listObjects(): ObservedObjectRow[] {
    const rows = getConnection()
      .prepare('SELECT * FROM observed_objects')
      .all() as ObservedObjectRowShape[];
    return rows.map(toObservedObjectRow);
  },

  /** The revisions strictly after `afterRevision`, oldest first. */
  listRevisionsAfter(uri: string, afterRevision: number): ObservedRevisionRow[] {
    const rows = getConnection()
      .prepare(
        `SELECT uri, revision, at, delta_items_json
         FROM observed_revisions
         WHERE uri = ? AND revision > ?
         ORDER BY revision ASC`,
      )
      .all(uri, afterRevision) as ObservedRevisionRowShape[];
    return rows.map(toObservedRevisionRow);
  },

  /** One user's cursor on one object. */
  readSeenCursor(userId: string, uri: string): ObservationSeenCursorRow | null {
    const row = getConnection()
      .prepare('SELECT user_id, uri, revision, at FROM observation_seen_cursors WHERE user_id = ? AND uri = ?')
      .get(userId, uri) as ObservationSeenCursorRowShape | undefined;
    return row === undefined ? null : toSeenCursorRow(row);
  },

  /** Every seen cursor one user holds, keyed by URI. */
  listSeenCursors(userId: string): ObservationSeenCursorRow[] {
    const rows = getConnection()
      .prepare('SELECT user_id, uri, revision, at FROM observation_seen_cursors WHERE user_id = ?')
      .all(userId) as ObservationSeenCursorRowShape[];
    return rows.map(toSeenCursorRow);
  },

  /** Advances one user's cursor; the store guarantees it never moves backwards. */
  writeSeenCursor(userId: string, uri: string, revision: number, at: number): void {
    getConnection()
      .prepare(
        `INSERT INTO observation_seen_cursors (user_id, uri, revision, at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, uri) DO UPDATE SET
           revision = excluded.revision,
           at = excluded.at`,
      )
      .run(userId, uri, revision, at);
  },

  /** Users holding a cursor on `uri` (the push fan-out's seen half). */
  listSeenUserIds(uri: string): string[] {
    const rows = getConnection()
      .prepare('SELECT user_id FROM observation_seen_cursors WHERE uri = ?')
      .all(uri) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  },

  /** Every object one user pinned. */
  listWatchEntries(userId: string): ObservationWatchEntryRow[] {
    const rows = getConnection()
      .prepare('SELECT user_id, uri, pinned_at FROM observation_watch_entries WHERE user_id = ?')
      .all(userId) as ObservationWatchEntryRowShape[];
    return rows.map(toWatchEntryRow);
  },

  /** Pins an object for one user; a repeated pin keeps the original `pinnedAt`. */
  writeWatchEntry(userId: string, uri: string, pinnedAt: number): ObservationWatchEntryRow {
    getConnection()
      .prepare(
        `INSERT INTO observation_watch_entries (user_id, uri, pinned_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, uri) DO NOTHING`,
      )
      .run(userId, uri, pinnedAt);
    const row = getConnection()
      .prepare('SELECT user_id, uri, pinned_at FROM observation_watch_entries WHERE user_id = ? AND uri = ?')
      .get(userId, uri) as ObservationWatchEntryRowShape;
    return toWatchEntryRow(row);
  },

  /** Removes one pin; returns whether a row was there. */
  deleteWatchEntry(userId: string, uri: string): boolean {
    const result = getConnection()
      .prepare('DELETE FROM observation_watch_entries WHERE user_id = ? AND uri = ?')
      .run(userId, uri);
    return result.changes > 0;
  },

  /** Users who pinned `uri` (the push fan-out's watch half). */
  listWatchUserIds(uri: string): string[] {
    const rows = getConnection()
      .prepare('SELECT user_id FROM observation_watch_entries WHERE uri = ?')
      .all(uri) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  },

  /** Registers a producer and its expected cadence; a re-registration updates the cadence. */
  registerProducer(producer: string, expectedIntervalMs: number): void {
    getConnection()
      .prepare(
        `INSERT INTO observation_producer_heartbeats (producer, last_attempt_at, last_write_at, last_error, expected_interval_ms)
         VALUES (?, NULL, NULL, NULL, ?)
         ON CONFLICT(producer) DO UPDATE SET expected_interval_ms = excluded.expected_interval_ms`,
      )
      .run(producer, expectedIntervalMs);
  },

  /** One producer's heartbeat row, or `null` when it was never registered. */
  readProducer(producer: string): ObservationProducerHeartbeatRow | null {
    const row = getConnection()
      .prepare('SELECT * FROM observation_producer_heartbeats WHERE producer = ?')
      .get(producer) as ObservationProducerHeartbeatRowShape | undefined;
    return row === undefined ? null : toProducerHeartbeatRow(row);
  },

  /** Every registered producer, in registration-independent (name) order. */
  listProducers(): ObservationProducerHeartbeatRow[] {
    const rows = getConnection()
      .prepare('SELECT * FROM observation_producer_heartbeats ORDER BY producer ASC')
      .all() as ObservationProducerHeartbeatRowShape[];
    return rows.map(toProducerHeartbeatRow);
  },

  /**
   * Records one attempt. A successful attempt (`lastError === null`) also moves `lastWriteAt`
   * and clears a previous error; a failed one leaves the last successful write time intact.
   */
  recordProducerAttempt(producer: string, at: number, lastError: string | null): void {
    getConnection()
      .prepare(
        `UPDATE observation_producer_heartbeats
         SET last_attempt_at = ?,
             last_error = ?,
             last_write_at = CASE WHEN ? IS NULL THEN ? ELSE last_write_at END
         WHERE producer = ?`,
      )
      .run(at, lastError, lastError, at, producer);
  },
};
