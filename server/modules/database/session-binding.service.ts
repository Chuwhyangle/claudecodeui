import {
  providerSessionBindingDb,
  type ProviderSessionBindingOutcome,
  type ProviderSessionBindingRecovery,
} from '@/modules/database/repositories/sessions/session-binding.db.js';

/**
 * The one place a run's provider-session observation becomes a stored binding.
 *
 * Two kinds of write reach the session row and they must not be confused:
 *
 * - An ordinary run *discovers* its provider-native id (`session_created` /
 *   `setSessionId`) and reports it. That is an observation about a run, not an
 *   instruction to rebind the session: the run may be an old host whose thread
 *   an edit already retired, and its late report must not undo the edit.
 * - An active replacement — an edit fork, a first-prompt restart, or a
 *   deliberate recovery — *does* move the session onto another thread, and is
 *   the only caller that may displace the stored binding.
 *
 * The repository owns both transactions; this service owns the distinction and
 * the rule that a rejected observation is reported rather than silently lost.
 * It lives in the database module (not in `providers/services`) because both of
 * its consumers — the websocket module's chat run registry and the Codex
 * sessions provider — already reach the database barrel, while a provider-side
 * import from `providers/services` would pull `providers/list/codex` into the
 * providers import cycle AC-394 pins. `scripts/repair-session-binding.mjs`
 * documents the same limited recovery path for an operator.
 */
export type SessionBindingServiceDeps = {
  confirmRunDiscoveredProviderSession: (input: {
    sessionId: string;
    providerSessionId: string;
    runStartedWithProviderSessionId: string | null;
  }) => ProviderSessionBindingOutcome;
  replaceProviderSessionBinding: (input: {
    sessionId: string;
    providerSessionId: string;
    jsonlPath: string | null;
    clearSupersededForNewBinding?: boolean;
  }) => { previousProviderSessionId: string | null; previousJsonlPath: string | null };
  detachProviderSessionForEdit: (sessionId: string) => {
    previousProviderSessionId: string | null;
    previousJsonlPath: string | null;
  };
  recoverProviderSessionBinding: (input: {
    sessionId: string;
    providerSessionId: string;
    jsonlPath: string;
  }) => ProviderSessionBindingRecovery;
};

export type SessionBindingService = ReturnType<typeof createSessionBindingService>;

export function createSessionBindingService(deps: SessionBindingServiceDeps) {
  return {
    /**
     * Records the id an ordinary run announced, or rejects the write when the
     * run is no longer entitled to speak for the session.
     *
     * `runStartedWithProviderSessionId` is read from the run record, not from
     * the row at write time: it is the binding this run was admitted under, and
     * it is what tells a legitimate in-run replacement (the Codex zero-turn
     * fallback) apart from a stale host reporting against someone else's
     * binding.
     */
    recordRunDiscoveredBinding(input: {
      sessionId: string;
      providerSessionId: string;
      runStartedWithProviderSessionId: string | null;
    }): ProviderSessionBindingOutcome {
      const outcome = deps.confirmRunDiscoveredProviderSession(input);

      if (outcome.kind === 'rejected-superseded') {
        console.warn('[SessionBinding] Ignoring a retired provider session id', {
          sessionId: input.sessionId,
          providerSessionId: input.providerSessionId,
        });
      } else if (outcome.kind === 'rejected-stale') {
        console.warn('[SessionBinding] Ignoring a late provider session id from a stale run', {
          sessionId: input.sessionId,
          providerSessionId: input.providerSessionId,
          currentProviderSessionId: outcome.currentProviderSessionId,
        });
      } else if (outcome.kind === 'rejected-missing-session') {
        console.error('[SessionBinding] Provider session id reported for a missing session', {
          sessionId: input.sessionId,
          providerSessionId: input.providerSessionId,
        });
      }

      return outcome;
    },

    /**
     * Moves a session onto another thread and transcript, atomically.
     *
     * Used by the Codex edit fork and by deliberate recovery; never by run
     * discovery. `clearSupersededForNewBinding` is only for recovery of a
     * thread a previous edit wrongly retired.
     */
    replaceBinding(input: {
      sessionId: string;
      providerSessionId: string;
      jsonlPath: string | null;
      clearSupersededForNewBinding?: boolean;
    }) {
      return deps.replaceProviderSessionBinding(input);
    },

    /** Retires the current binding and detaches the row in one transaction. */
    detachForEdit(sessionId: string) {
      return deps.detachProviderSessionForEdit(sessionId);
    },

    /**
     * Restores a thread a previous write wrongly retired.
     *
     * This is the explicit recovery entry, and it is deliberately not what the
     * indexer or run discovery calls. The caller MUST have verified that
     * `jsonlPath` is the target thread's transcript first; the Codex entry
     * point does that by reading `session_meta.id`/`cwd`. The repository owns
     * the atomic move — clearing the retirement record, retiring the binding
     * being displaced and writing the restored path commit together — and an
     * already-consistent second call writes nothing.
     */
    recoverBinding(input: {
      sessionId: string;
      providerSessionId: string;
      jsonlPath: string;
    }): ProviderSessionBindingRecovery {
      const outcome = deps.recoverProviderSessionBinding(input);

      if (outcome.kind === 'recovered') {
        console.info('[SessionBinding] Restored a wrongly retired provider session', {
          sessionId: input.sessionId,
          providerSessionId: input.providerSessionId,
          jsonlPath: input.jsonlPath,
          previousProviderSessionId: outcome.previousProviderSessionId,
        });
      }

      return outcome;
    },
  };
}

/**
 * The process-wide binding entry point. A factory is exported as well so the
 * session-binding criterion can drive the same rules through an injected repo
 * double without a database connection.
 */
export const sessionBindingService = createSessionBindingService({
  confirmRunDiscoveredProviderSession: (input) =>
    providerSessionBindingDb.confirmRunDiscoveredProviderSession(input),
  replaceProviderSessionBinding: (input) => providerSessionBindingDb.replaceProviderSessionBinding(input),
  detachProviderSessionForEdit: (sessionId) => providerSessionBindingDb.detachProviderSessionForEdit(sessionId),
  recoverProviderSessionBinding: (input) => providerSessionBindingDb.recoverProviderSessionBinding(input),
});
