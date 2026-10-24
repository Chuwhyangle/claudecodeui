import type { HostResidentStartResult, LLMProvider } from '@/shared/types.js';

import { RESIDENT_IDLE_TIMEOUT } from './session-host-manager.service.js';
import type { HostDriverResolver, ResidentSessionStarter } from './session-hosts.routes.js';

/**
 * Whether the shipped configuration restores resident sessions at start-up.
 *
 * On: a restart drops every resident process the previous server held, which
 * leaves the sessions dormant until the next `chat.send` lazily opens one — and
 * leaves cross-session peer addressing pointing at nobody. Bringing the recently
 * active ones back at boot is the behaviour an operator expects after a restart.
 * The switch is the `residentRestore.enabled` key of the generic server settings
 * file (`server/modules/settings/server-settings.ts`); this module owns the
 * default, the settings loader reads it, and `server/index.ts` branches on that
 * reading. A deployment that does not want the launch burst (one provider
 * process per restored session) writes `enabled: false` in that file. There is
 * no per-key environment variable for it. Pinned by this module's restore
 * criterion.
 */
export const DEFAULT_RESIDENT_RESTORE_ENABLED = true;

/**
 * The shipped ceiling on sessions per restore pass.
 *
 * Milliseconds are not involved; the unit is sessions. A ceiling exists because
 * a restore pass that started every resident row would turn a restart into a
 * launch storm — measured at eight sessions active in the last six hours and ten
 * in the last twelve, so sixteen leaves headroom for the busy case while still
 * bounding the burst. This is the value `residentRestore.max` falls back to when
 * the settings file says nothing or names a malformed value.
 */
export const DEFAULT_RESIDENT_RESTORE_MAX = 16;

/**
 * The shipped activity window.
 *
 * The value is also the semantic boundary of the claim: a resident session that
 * had already been idle past the provider's own idle ceiling before the restart
 * was not really alive, so it is not restored. It is
 * {@link RESIDENT_IDLE_TIMEOUT} — the same 24 hours the manager closes an idle
 * resident host at — so the restore window and the lifetime policy cannot drift
 * apart without this file changing. This is the value `residentRestore.maxAgeMs`
 * falls back to.
 */
export const DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS = RESIDENT_IDLE_TIMEOUT;

/**
 * The wall-clock ceiling for one whole pass.
 *
 * Not an environment knob: it bounds how long the fire-and-forget pass keeps
 * launching after the server is already serving, so a slow or hung provider
 * cannot keep the pass alive indefinitely. Once spent, the pass stops starting
 * new sessions and reports `budgetExhausted` rather than hanging.
 */
export const RESIDENT_RESTORE_BUDGET_MS = 60_000;

/**
 * One stored session the restore pass may bring back.
 *
 * Narrow on purpose — the four facts the pass decides on: which session, which
 * provider would launch it, the provider's own id for the conversation (a
 * resident process must be launched against the provider session, and a row
 * without one cannot be adopted), and when the session last carried activity.
 * `lastActiveAt` is epoch milliseconds so the window comparison does not depend
 * on how the store formats timestamps. Consumed by this module's restore
 * criterion and by `server/index.ts`, which maps `sessionsDb` rows onto it.
 */
export type RestorableResidentSession = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  lastActiveAt: number;
};

/** Why a candidate was left alone — reported, never thrown. */
export type ResidentRestoreSkipReason = 'stale' | 'no-provider-session' | 'no-resident-driver';

/**
 * What one restore pass did, in the form a log line and a criterion both read.
 *
 * `started` and `failed` are the work; `skipped` says which candidates the pass
 * declined and why; `budgetExhausted` says whether the pass stopped early on its
 * own deadline. Consumed by this module's restore criterion and by
 * `server/index.ts`, which logs the summary.
 */
export type ResidentRestoreOutcome = {
  /** Candidates the store handed over, before any of this pass's own filters. */
  considered: number;
  started: Array<{ appSessionId: string; hostId: string; pid: number | null }>;
  failed: Array<{ appSessionId: string; reason: string }>;
  skipped: Array<{ appSessionId: string; reason: ResidentRestoreSkipReason }>;
  budgetExhausted: boolean;
};

/**
 * Everything a restore pass needs, and nothing else.
 *
 * `listRestorableResidentSessions` and `startResidentSession` are the two seams
 * that carry work, and neither can be imported here: the first belongs to the
 * database module and the second to the providers module, both of which this
 * module must not reach back into (the providers module already imports it, so
 * the edge would close a cycle). `server/index.ts` supplies both. The remaining
 * members are the pass's own policy overrides and its clock, present so the
 * criterion can reach the window, the ceiling and the budget without waiting.
 */
export type ResidentRestoreDeps = {
  /**
   * The candidate reader. Receives the pass's window and ceiling so the store
   * can push both down into one ordered query; the pass still re-applies them
   * (see {@link createResidentRestoreService}) because the reader is an injected
   * seam and a pass that trusted it could be handed a row it must not start.
   */
  listRestorableResidentSessions: (query: { maxAgeMs: number; limit: number }) => RestorableResidentSession[];
  /** See {@link ResidentSessionStarter}; the launch the on-demand start route uses. */
  startResidentSession: ResidentSessionStarter;
  /**
   * See {@link HostDriverResolver}. Used only to decline a provider that mounts
   * no driver, or a driver without the on-demand verb — the same pair of facts
   * the start route checks. Absent means the pass cannot tell and asks the
   * launch seam instead, whose rejection is isolated like any other failure.
   */
  resolveHostDriver?: HostDriverResolver;
  /** Sessions this pass may start; defaults to {@link DEFAULT_RESIDENT_RESTORE_MAX}. */
  max?: number;
  /** Activity window; defaults to {@link DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Wall-clock ceiling; defaults to {@link RESIDENT_RESTORE_BUDGET_MS}. */
  budgetMs?: number;
  /** The clock the window and the budget are measured against. */
  now?: () => number;
  /** Where the pass and its per-session failures are reported. */
  log?: (message: string) => void;
};

/**
 * Builds the restore pass over the two injected seams.
 *
 * The pass is one method, {@link ResidentRestoreService.restore}, and its shape
 * is the whole decision: read the candidates, order them by last activity, drop
 * the ones this pass must not start (stale, no provider session, no resident
 * driver), take the first `max`, and launch them one at a time. Each launch is
 * isolated — a rejection is recorded against its session and the pass carries on
 * — so one broken session never hides the ones behind it and never escapes as a
 * rejection of the pass. Sequential rather than concurrent by choice: the burst
 * this pass creates is already bounded by `max`, and serialising the launches
 * keeps provider load and log order readable at boot.
 *
 * Filters are re-applied here even though the reader was asked to apply them,
 * because the reader is an injected seam: a criterion's in-memory stand-in (and
 * any future caller) may answer with rows the pass must still decline, and the
 * pass must be the thing that refuses them.
 *
 * Consumed by `server/index.ts` (which schedules it fire-and-forget after the
 * orphan sweep) and by this module's restore criterion.
 */
export function createResidentRestoreService(deps: ResidentRestoreDeps): {
  restore: () => Promise<ResidentRestoreOutcome>;
} {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  return {
    async restore(): Promise<ResidentRestoreOutcome> {
      const max = deps.max ?? DEFAULT_RESIDENT_RESTORE_MAX;
      const maxAgeMs = deps.maxAgeMs ?? DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS;
      const budgetMs = deps.budgetMs ?? RESIDENT_RESTORE_BUDGET_MS;

      const candidates = deps.listRestorableResidentSessions({ maxAgeMs, limit: max });
      const considered = candidates.length;
      const skipped: ResidentRestoreOutcome['skipped'] = [];

      // Ordering is the reader's contract too, but the pass states it again: the
      // ceiling takes the *most recently active* sessions, and a reader that
      // answered out of order would silently restore the wrong ones.
      const ordered = [...candidates].sort(compareByLastActivity);

      const eligible: RestorableResidentSession[] = [];
      const startedAt = now();
      for (const candidate of ordered) {
        const skipReason = skipReasonFor(candidate, maxAgeMs, startedAt, deps.resolveHostDriver);
        if (skipReason) {
          skipped.push({ appSessionId: candidate.appSessionId, reason: skipReason });
          continue;
        }
        eligible.push(candidate);
      }

      const selected = eligible.slice(0, max);
      const started: ResidentRestoreOutcome['started'] = [];
      const failed: ResidentRestoreOutcome['failed'] = [];
      let budgetExhausted = false;

      for (const candidate of selected) {
        // The budget is checked between launches, never mid-launch: a launch
        // already under way is allowed to finish so the pass never leaves a
        // process whose adoption was abandoned halfway.
        if (now() - startedAt >= budgetMs) {
          budgetExhausted = true;
          break;
        }
        try {
          const result: HostResidentStartResult = await deps.startResidentSession(
            candidate.provider,
            candidate.appSessionId,
          );
          started.push({
            appSessionId: candidate.appSessionId,
            hostId: result.hostId,
            pid: result.pid,
          });
        } catch (error) {
          // Isolation is the point: one session's launch refusal is a fact about
          // that session, and the ones behind it are still worth starting.
          failed.push({ appSessionId: candidate.appSessionId, reason: errorMessage(error) });
          log(
            `[resident-restore] could not restore session "${candidate.appSessionId}": ${errorMessage(error)}`,
          );
        }
      }

      log(
        `[resident-restore] considered=${considered} started=${started.length} ` +
          `failed=${failed.length} skipped=${skipped.length}` +
          `${budgetExhausted ? ' (budget exhausted)' : ''} ` +
          `window=${maxAgeMs}ms max=${max}`,
      );

      return { considered, started, failed, skipped, budgetExhausted };
    },
  };
}

/**
 * Why one candidate must not be started by this pass, or null when it may.
 *
 * The three refusals are the pass's own, in the order the start route checks the
 * same facts: a session outside the activity window was not really alive before
 * the restart; a row without a provider session id names no conversation the
 * provider could be asked to adopt; and a provider that mounts no host driver —
 * or a driver without the on-demand verb — has nothing the launch seam could
 * call. A driver check is skipped when no resolver was injected, because the
 * pass then cannot tell and the launch seam's rejection is isolated anyway.
 */
function skipReasonFor(
  candidate: RestorableResidentSession,
  maxAgeMs: number,
  now: number,
  resolveHostDriver: HostDriverResolver | undefined,
): ResidentRestoreSkipReason | null {
  if (!Number.isFinite(candidate.lastActiveAt) || now - candidate.lastActiveAt > maxAgeMs) {
    return 'stale';
  }
  if (!candidate.providerSessionId) {
    return 'no-provider-session';
  }
  if (resolveHostDriver) {
    const driver = resolveHostDriver(candidate.provider);
    if (!driver || typeof driver.startResidentSession !== 'function') {
      return 'no-resident-driver';
    }
  }
  return null;
}

/**
 * Orders candidates the way the restore ceiling reads them: most recent first.
 *
 * Ties are broken by app session id descending, which is the store's own
 * `session_id DESC` tiebreak — so a pass and the query that fed it agree on the
 * order rather than each having an opinion at the boundary.
 */
function compareByLastActivity(left: RestorableResidentSession, right: RestorableResidentSession): number {
  if (left.lastActiveAt !== right.lastActiveAt) {
    return right.lastActiveAt - left.lastActiveAt;
  }
  if (left.appSessionId === right.appSessionId) {
    return 0;
  }
  return left.appSessionId < right.appSessionId ? 1 : -1;
}

/**
 * The sentence from a rejected launch, whatever was thrown.
 *
 * Duplicated from the resident-host service by design: it is a one-use helper,
 * and importing another module's private utility would either export it
 * speculatively or cross a file boundary for four lines. A non-`Error` rejection
 * is stringified rather than dropped, so the reason a session failed to restore
 * is never reduced to "failed".
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
