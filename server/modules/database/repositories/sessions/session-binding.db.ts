import { getConnection } from '@/modules/database/core/index.js';

/**
 * The provider-session binding writes: everything that decides which
 * provider-native thread a session row is bound to.
 *
 * Split out of `sessions.db.ts` by `gap-session-binding-consistency` — the
 * sibling that owns the rest of the `sessions` table. The concern is one thing
 * (the id/path pair and the superseded ledger are written together), it grew
 * past what the row repository should carry, and the ratchet on
 * `sessions.db.ts` only falls. `sessionsDb` keeps `assignProviderSessionId` as a
 * delegation so its existing callers (the watchers and synchronizers) are
 * unchanged.
 *
 * Everything here runs in a transaction: a binding, the transcript path it
 * invalidates, and the superseded mark either all commit or none do.
 */

/**
 * The columns the binding operations read.
 *
 * Deliberately narrower than `sessions.db.ts`'s full raw projection: these
 * operations only need the binding pair plus the name/transcript columns the
 * duplicate merge adopts. Reading them directly (not through the display
 * projection) keeps an adopted reading from being written back as an override.
 */
const BINDING_ROW_COLUMNS =
  'session_id, provider, provider_session_id, jsonl_path, custom_name, name_source, transcript_name, transcript_name_source';

type BindingRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  name_source: string | null;
  transcript_name: string | null;
  transcript_name_source: string | null;
};

/** The one column of a retirement record a recovery has to restore. */
type RetiredBindingRow = {
  session_id: string;
  jsonl_path: string | null;
};

/**
 * The row recording that `providerSessionId` was retired for `provider`, or
 * undefined when the id is not retired.
 *
 * The whole binding surface reads the ledger through this one function. The
 * invariant is deliberately single-sourced: an id is either the row's current
 * binding or a retirement record, never both, and every write below asks this
 * same question before it writes.
 */
function findRetiredProviderSession(
  db: ReturnType<typeof getConnection>,
  providerSessionId: string,
  provider: string,
): RetiredBindingRow | undefined {
  return db
    .prepare(
      `SELECT session_id, jsonl_path FROM superseded_provider_sessions
       WHERE provider_session_id = ? AND provider = ?
       LIMIT 1`
    )
    .get(providerSessionId, provider) as RetiredBindingRow | undefined;
}

/** Writes the retirement record for one thread, refreshing an existing one. */
function retireProviderSession(
  db: ReturnType<typeof getConnection>,
  input: {
    providerSessionId: string;
    provider: string;
    sessionId: string;
    jsonlPath: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO superseded_provider_sessions (provider_session_id, provider, session_id, jsonl_path)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider_session_id, provider) DO UPDATE SET
       session_id = excluded.session_id,
       jsonl_path = excluded.jsonl_path,
       created_at = CURRENT_TIMESTAMP`
  ).run(input.providerSessionId, input.provider, input.sessionId, input.jsonlPath);
}

/** Deletes the retirement record for one thread; only recovery may do this. */
function clearRetiredProviderSession(
  db: ReturnType<typeof getConnection>,
  providerSessionId: string,
  provider: string,
): void {
  db.prepare(
    `DELETE FROM superseded_provider_sessions
     WHERE provider_session_id = ? AND provider = ?`
  ).run(providerSessionId, provider);
}

/**
 * What an ordinary run's attempt to record the provider-native id it discovered
 * did to the stored binding.
 *
 * Consumed by the database module's `session-binding.service`, which never lets
 * a run overwrite a binding some other run/thread owns. `confirmed` means the
 * row already claimed the id; `assigned` is the first registration on an
 * app-minted row; `replaced` is the one in-run replacement that is legitimate —
 * the provider could not resume the stored thread (a zero-turn thread has no
 * rollout) and branched to a new one, and this very run started on the stored
 * binding. The three rejections are the late-write cases: the announced id was
 * already retired by an edit (`rejected-superseded`), the run started on a
 * binding this session no longer claims (`rejected-stale` — an old host or
 * run), or there is no row at all.
 */
export type ProviderSessionBindingOutcome =
  | { kind: 'assigned'; previousProviderSessionId: string | null }
  | { kind: 'confirmed' }
  | {
      kind: 'replaced';
      previousProviderSessionId: string;
      /** The unusable transcript path the replacement dropped, if it had one. */
      previousJsonlPath: string | null;
    }
  | { kind: 'rejected-superseded'; supersededProviderSessionId: string }
  | { kind: 'rejected-stale'; currentProviderSessionId: string }
  | { kind: 'rejected-missing-session' };

/**
 * What an explicit recovery of a wrongly retired thread did.
 *
 * `already-consistent` is the idempotent second run: the row already claims
 * the thread with the same path and no retirement record is left. The
 * `previous*` fields name what the recovery displaced so the caller can report
 * the old binding, which is retired in the same transaction.
 */
export type ProviderSessionBindingRecovery = {
  kind: 'recovered' | 'already-consistent';
  previousProviderSessionId: string | null;
  previousJsonlPath: string | null;
  /** Whether this write actually removed a retirement record for the target. */
  clearedRetiredMark: boolean;
};

/**
 * Merges a watcher-created duplicate row into the app row while recording the
 * provider-native id.
 *
 * Shared by the two entry points that may discover the id after the transcript
 * was already indexed — the unconditional `assignProviderSessionId` and the
 * guarded `confirmRunDiscoveredProviderSession`. Reading raw columns is
 * deliberate: the duplicate's stored name is adopted as it is, not as the
 * display projection would present it, so a reading never becomes an override.
 */
function mergeDiscoveredProviderSessionDuplicate(
  db: ReturnType<typeof getConnection>,
  sessionId: string,
  providerSessionId: string,
): void {
  const duplicate = db
    .prepare(
      `SELECT ${BINDING_ROW_COLUMNS} FROM sessions
       WHERE (session_id = ? OR provider_session_id = ?)
         AND session_id <> ?
       LIMIT 1`
    )
    .get(providerSessionId, providerSessionId, sessionId) as BindingRow | undefined;

  if (duplicate) {
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
    db.prepare(
      `UPDATE sessions SET
         provider_session_id = @providerSessionId,
         jsonl_path = COALESCE(jsonl_path, @jsonlPath),
         custom_name = COALESCE(custom_name, @customName),
         name_source = CASE
           WHEN custom_name IS NULL AND @customName IS NOT NULL THEN @nameSource
           ELSE name_source
         END,
         transcript_name = COALESCE(transcript_name, @transcriptName),
         transcript_name_source = CASE
           WHEN transcript_name IS NULL AND @transcriptName IS NOT NULL THEN @transcriptNameSource
           ELSE transcript_name_source
         END,
         updated_at = CURRENT_TIMESTAMP
       WHERE session_id = @sessionId`
    ).run({
      providerSessionId,
      jsonlPath: duplicate.jsonl_path,
      customName: duplicate.custom_name,
      // A name and its provenance move together: adopting the duplicate's
      // name without its source would let the next provider scan overwrite
      // a name the user had chosen on the other row.
      nameSource: duplicate.name_source ?? 'derived',
      transcriptName: duplicate.transcript_name,
      transcriptNameSource: duplicate.transcript_name_source ?? 'derived',
      sessionId,
    });
    return;
  }

  db.prepare(
    `UPDATE sessions SET
       provider_session_id = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE session_id = ?`
  ).run(providerSessionId, sessionId);
}

/**
 * The provider-session binding write surface.
 *
 * Consumed by `sessions.db.ts`'s `assignProviderSessionId` delegation (the
 * watchers and synchronizers), by the database module's `session-binding.service`
 * (run discovery and the Codex edit fork/restart), and by no caller that writes
 * these columns directly.
 */
export const providerSessionBindingDb = {
  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * Kept on this surface because the watchers and synchronizers already call
   * it. It is not a blind write any more: it is the unguarded-looking legacy
   * spelling of ordinary discovery, so it is answered by
   * {@link confirmRunDiscoveredProviderSession} with no admitting run (a
   * synchronizer has no run record to speak for). A retired id, or an id that
   * would displace a binding this caller never started on, is therefore
   * rejected exactly like a late run announcement instead of overwriting it.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the guarded path merges the duplicate into the app row in the same
   * transaction.
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): ProviderSessionBindingOutcome {
    return providerSessionBindingDb.confirmRunDiscoveredProviderSession({
      sessionId,
      providerSessionId,
      runStartedWithProviderSessionId: null,
    });
  },

  /**
   * Records the provider-native id an ordinary run discovered, without letting
   * that run overwrite a binding it does not own.
   *
   * This is the guarded sibling of {@link assignProviderSessionId}: the runtime
   * announcement (`session_created` / `setSessionId`) is an observation, not an
   * instruction to rebind, and an old host or run can announce its own id long
   * after the session was edited onto another thread. The rules, in the order
   * they are applied, are the whole point of the method:
   *
   *  1. An id recorded in `superseded_provider_sessions` is retired — an edit
   *     already left that thread behind — so it can never become the binding
   *     again, not even on a row a first-prompt edit detached to NULL.
   *  2. The same id the row already claims is a confirmation, not a write.
   *  3. A row with no binding takes the id: first registration on an
   *     app-minted session, merging a watcher-created duplicate if there is one.
   *  4. A different id is accepted only when this run *started on the binding
   *     the row still claims*. That is the provider's zero-turn fallback: the
   *     stored thread has no rollout to resume, the run branched to a fresh
   *     thread, and its old path stops being claimed at the same time.
   *  5. Anything else is a late write from a run/host that no longer owns the
   *     session; it is rejected rather than written.
   *
   * Runs in one transaction so the id and the transcript path it invalidates
   * cannot be observed half-updated.
   */
  confirmRunDiscoveredProviderSession(input: {
    sessionId: string;
    providerSessionId: string;
    /**
     * The provider-native id the run was started with — the binding it was
     * entitled to speak for. Null for a run that started a brand-new session.
     */
    runStartedWithProviderSessionId: string | null;
  }): ProviderSessionBindingOutcome {
    const db = getConnection();

    return db.transaction((): ProviderSessionBindingOutcome => {
      const row = db
        .prepare(`SELECT ${BINDING_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(input.sessionId) as BindingRow | undefined;
      if (!row) {
        return { kind: 'rejected-missing-session' };
      }

      if (findRetiredProviderSession(db, input.providerSessionId, row.provider)) {
        return {
          kind: 'rejected-superseded',
          supersededProviderSessionId: input.providerSessionId,
        };
      }

      const currentProviderSessionId = row.provider_session_id;
      if (currentProviderSessionId === input.providerSessionId) {
        return { kind: 'confirmed' };
      }

      if (currentProviderSessionId === null) {
        mergeDiscoveredProviderSessionDuplicate(db, input.sessionId, input.providerSessionId);
        return { kind: 'assigned', previousProviderSessionId: null };
      }

      if (
        input.runStartedWithProviderSessionId !== null
        && input.runStartedWithProviderSessionId === currentProviderSessionId
      ) {
        // The run that owns the stored binding replaced it in-run. The new
        // thread has no rollout yet, so the old path must not be kept: a row
        // claiming thread B while pointing at thread A's file is exactly the
        // inconsistent binding this guard exists to prevent.
        db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
          .run(input.providerSessionId, input.sessionId);
        const updated = db
          .prepare(
            `UPDATE sessions SET
               provider_session_id = ?,
               jsonl_path = NULL,
               updated_at = CURRENT_TIMESTAMP
             WHERE session_id = ?`
          )
          .run(input.providerSessionId, input.sessionId);
        if (updated.changes === 0) {
          throw new Error(`Session "${input.sessionId}" vanished while replacing its provider binding.`);
        }
        return {
          kind: 'replaced',
          previousProviderSessionId: currentProviderSessionId,
          previousJsonlPath: row.jsonl_path ?? null,
        };
      }

      return { kind: 'rejected-stale', currentProviderSessionId };
    })();
  },

  /**
   * Atomically moves a session onto another provider session and transcript.
   *
   * This is the explicit binding replacement — an edit fork, a restart, or a
   * deliberate recovery — and not an observation, so it is allowed to displace
   * the current binding. It retires that binding in the same transaction: the
   * superseded row, the deletion of a watcher-created duplicate keyed by the
   * new provider id, and the session's new id/path either all commit or none
   * do. A caller that finds the session missing or has its UPDATE rejected
   * gets a throw, which rolls the transaction back.
   *
   * `clearSupersededForNewBinding` is for recovery: restoring a thread a
   * previous edit wrongly retired. Ordinary edit forks leave it false, and a
   * replacement that targets a retired thread without it is refused — that is
   * the write that used to leave a row claiming a thread the ledger also called
   * retired. Recovery still has to have verified the thread's transcript
   * identity before it calls here; this method only owns the atomic ledger
   * move.
   */
  replaceProviderSessionBinding(input: {
    sessionId: string;
    providerSessionId: string;
    jsonlPath: string | null;
    clearSupersededForNewBinding?: boolean;
  }): { previousProviderSessionId: string | null; previousJsonlPath: string | null } {
    const db = getConnection();

    return db.transaction(() => {
      const row = db
        .prepare(`SELECT ${BINDING_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(input.sessionId) as BindingRow | undefined;
      if (!row) {
        throw new Error(`Session "${input.sessionId}" was not found while replacing its provider binding.`);
      }

      const previousProviderSessionId = row.provider_session_id;
      const previousJsonlPath = row.jsonl_path ?? null;

      // The invariant: a row may not claim a thread the ledger records as
      // retired. Ordinary replacement refuses; only explicit recovery clears
      // the mark, and it does so in this same transaction.
      if (
        findRetiredProviderSession(db, input.providerSessionId, row.provider)
        && !input.clearSupersededForNewBinding
      ) {
        throw new Error(
          `Provider session "${input.providerSessionId}" is retired for session "${input.sessionId}"; `
          + 'an ordinary replacement cannot claim a retired thread — explicit recovery is required.'
        );
      }

      if (previousProviderSessionId && previousProviderSessionId !== input.providerSessionId) {
        retireProviderSession(db, {
          providerSessionId: previousProviderSessionId,
          provider: row.provider,
          sessionId: input.sessionId,
          jsonlPath: previousJsonlPath,
        });
      }

      if (input.clearSupersededForNewBinding) {
        clearRetiredProviderSession(db, input.providerSessionId, row.provider);
      }

      // The watcher may already have indexed the new transcript under its own
      // id. That row is this conversation about to be, so it is replaced rather
      // than left behind as a second sidebar entry.
      db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
        .run(input.providerSessionId, input.sessionId);

      const updated = db
        .prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        )
        .run(input.providerSessionId, input.jsonlPath, input.sessionId);
      if (updated.changes === 0) {
        throw new Error(`Session "${input.sessionId}" vanished while replacing its provider binding.`);
      }

      return { previousProviderSessionId, previousJsonlPath };
    })();
  },

  /**
   * Atomically restores a thread a previous write wrongly retired.
   *
   * This is the ONLY write that may remove a retirement record, and it is
   * deliberately narrower than `replaceProviderSessionBinding`:
   *
   *  - the target must still be recorded as retired (otherwise this is an
   *    ordinary replacement, not a recovery, and the caller is refused);
   *  - a session already claiming the target with the same path and no
   *    retirement record is `already-consistent` and writes nothing, so
   *    operators can run recovery twice;
   *  - the binding the recovery displaces is retired in the same transaction.
   *
   * The caller is responsible for having verified that the transcript at
   * `jsonlPath` really is the target thread (the Codex entry point does this by
   * reading `session_meta.id`/`cwd`). This method owns the transaction, not the
   * identity claim. A failure throws and rolls every write back, so a recovery
   * can never leave the row claiming a thread whose retirement record is gone
   * while the path stayed wrong.
   */
  recoverProviderSessionBinding(input: {
    sessionId: string;
    providerSessionId: string;
    jsonlPath: string;
  }): ProviderSessionBindingRecovery {
    const db = getConnection();

    return db.transaction((): ProviderSessionBindingRecovery => {
      const row = db
        .prepare(`SELECT ${BINDING_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(input.sessionId) as BindingRow | undefined;
      if (!row) {
        throw new Error(`Session "${input.sessionId}" was not found while recovering its provider binding.`);
      }

      const previousProviderSessionId = row.provider_session_id;
      const previousJsonlPath = row.jsonl_path ?? null;
      const retired = findRetiredProviderSession(db, input.providerSessionId, row.provider);

      if (!retired) {
        if (
          previousProviderSessionId === input.providerSessionId
          && previousJsonlPath === input.jsonlPath
        ) {
          return {
            kind: 'already-consistent',
            previousProviderSessionId,
            previousJsonlPath,
            clearedRetiredMark: false,
          };
        }
        throw new Error(
          `Provider session "${input.providerSessionId}" is not retired for session "${input.sessionId}"; `
          + 'recovery only restores a thread a previous write wrongly retired.'
        );
      }

      // The old binding (when it is a different thread) is retired in the same
      // transaction: recovery moves a conversation, it does not forget one.
      if (previousProviderSessionId && previousProviderSessionId !== input.providerSessionId) {
        retireProviderSession(db, {
          providerSessionId: previousProviderSessionId,
          provider: row.provider,
          sessionId: input.sessionId,
          jsonlPath: previousJsonlPath,
        });
      }

      clearRetiredProviderSession(db, input.providerSessionId, row.provider);

      // A watcher-created row keyed by the restored thread is this same
      // conversation; keeping it would put two sidebar entries back.
      db.prepare('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?')
        .run(input.providerSessionId, input.sessionId);

      const updated = db
        .prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        )
        .run(input.providerSessionId, input.jsonlPath, input.sessionId);
      if (updated.changes === 0) {
        throw new Error(`Session "${input.sessionId}" vanished while recovering its provider binding.`);
      }

      return {
        kind: 'recovered',
        previousProviderSessionId,
        previousJsonlPath,
        clearedRetiredMark: true,
      };
    })();
  },

  /**
   * Reads the retirement record for one thread, if any.
   *
   * Used by the Codex explicit-recovery entry point to find the transcript a
   * wrongly retired binding left behind, and by tests that pin the ledger.
   */
  getRetiredProviderSession(providerSessionId: string, provider: string): RetiredBindingRow | null {
    return findRetiredProviderSession(getConnection(), providerSessionId, provider) ?? null;
  },

  /**
   * Atomically retires the current binding and detaches the session.
   *
   * Used by an edit of the very first prompt: nothing of the conversation
   * survives, the next run opens a new thread, and the old thread must be
   * retired in the same transaction that clears the row — otherwise a failure
   * between the two writes leaves a superseded thread still claimed, or a
   * cleared row whose old thread the indexer can hand straight back.
   */
  detachProviderSessionForEdit(sessionId: string): {
    previousProviderSessionId: string | null;
    previousJsonlPath: string | null;
  } {
    const db = getConnection();

    return db.transaction(() => {
      const row = db
        .prepare(`SELECT ${BINDING_ROW_COLUMNS} FROM sessions WHERE session_id = ? LIMIT 1`)
        .get(sessionId) as BindingRow | undefined;
      if (!row) {
        throw new Error(`Session "${sessionId}" was not found while detaching its provider binding.`);
      }

      const previousProviderSessionId = row.provider_session_id;
      const previousJsonlPath = row.jsonl_path ?? null;

      if (previousProviderSessionId) {
        retireProviderSession(db, {
          providerSessionId: previousProviderSessionId,
          provider: row.provider,
          sessionId,
          jsonlPath: previousJsonlPath,
        });
      }

      const updated = db
        .prepare(
          `UPDATE sessions SET
             provider_session_id = NULL,
             jsonl_path = NULL,
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        )
        .run(sessionId);
      if (updated.changes === 0) {
        throw new Error(`Session "${sessionId}" vanished while detaching its provider binding.`);
      }

      return { previousProviderSessionId, previousJsonlPath };
    })();
  },
};
