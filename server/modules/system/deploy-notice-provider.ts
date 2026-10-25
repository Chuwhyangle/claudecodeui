/**
 * The deploy source's notice provider.
 *
 * It adapts the ONE existing deploy reading (`deployService.readReadiness()`) into the notices
 * model — it does not read git or the build fingerprints itself, and it changes neither the
 * reading nor the `POST /api/system/deploy` action. The composition root (`server/index.ts`)
 * injects the reader, which is what keeps `modules/notices` from importing `modules/system`
 * (N8); this file imports notices' TYPES only.
 *
 * Mapping (proposal §5), row by row:
 *   fresh / unknown                    → no notice
 *   pending-build / built-pending-restart → `deploy:pending-build` (condition / attention,
 *                                          revision = headSha, primary action 「构建并重启」)
 *   building / restarting              → the SAME entry in its in-progress form: same id and
 *                                          revision, no primary action, no second entry
 *   failure !== null                   → `deploy:failed` (condition / blocking, revision =
 *   or lastDeploy.ok === false            failure.at / lastDeploy.at, never dismissible)
 *
 * A failed deploy usually also leaves the status at `pending-build`; that leftover is NOT a
 * second, dismissible 「N commits pending」 message — the failure is the one fact to act on, so
 * the failure arm wins and returns alone.
 */

import type { Notice, NoticeProvider } from '@/modules/notices/index.js';

import type { DeployReadinessReading } from './deploy-readiness.service.js';

/** The stable id of the 「there is work built but not running」 condition. */
const DEPLOY_PENDING_BUILD_ID = 'deploy:pending-build';
/** The stable id of the blocking 「the last build/restart failed」 condition. */
const DEPLOY_FAILED_ID = 'deploy:failed';

const BUILD_AND_RESTART_ACTION = {
  id: 'deploy.build-and-restart',
  labelKey: 'notices.deploy.pendingBuild.action',
} as const;

/** What the provider needs: the existing deploy reading, injected by the composition root. */
export type DeployNoticeProviderDeps = {
  readReadiness(): Promise<DeployReadinessReading>;
};

/** The blocking failure notice, at the time the failure was recorded. */
function failedNotice(revision: string, params: Record<string, string | number>): Notice {
  return {
    id: DEPLOY_FAILED_ID,
    source: 'deploy',
    lifecycle: 'condition',
    severity: 'blocking',
    revision,
    scope: 'global',
    title: 'notices.deploy.failed.title',
    params: { ...params, at: revision },
    raisedAt: revision,
  };
}

/**
 * Builds the deploy provider over the injected reader.
 *
 * Consumers: `server/index.ts` (one instance in the process-wide registry).
 */
export function createDeployNoticeProvider(deps: DeployNoticeProviderDeps): NoticeProvider {
  return {
    source: 'deploy',
    async read(): Promise<Notice[]> {
      const reading = await deps.readReadiness();

      // Blocking first: a recorded failure is the fact to act on, whatever the status reading
      // says about the commits it left pending.
      if (reading.failure !== null) {
        return [failedNotice(reading.failure.at, { step: reading.failure.step })];
      }
      if (reading.lastDeploy !== null && reading.lastDeploy.ok === false) {
        return [failedNotice(reading.lastDeploy.at, {})];
      }

      if (reading.status === 'pending-build' || reading.status === 'built-pending-restart') {
        const revision = reading.headSha ?? '';
        return [{
          id: DEPLOY_PENDING_BUILD_ID,
          source: 'deploy',
          lifecycle: 'condition',
          severity: 'attention',
          revision,
          scope: 'global',
          title: 'notices.deploy.pendingBuild.title',
          params: { count: reading.pendingCommits.length, headSha: revision },
          primaryAction: BUILD_AND_RESTART_ACTION,
          raisedAt: reading.checkedAt,
        }];
      }

      if (reading.status === 'building' || reading.status === 'restarting') {
        // The same entry, mid-action: the user cannot start a second build, so the action is
        // hidden (the notice stays visible as the status).
        return [{
          id: DEPLOY_PENDING_BUILD_ID,
          source: 'deploy',
          lifecycle: 'condition',
          severity: 'attention',
          revision: reading.headSha ?? '',
          scope: 'global',
          title: 'notices.deploy.pendingBuild.title',
          params: { count: 0, headSha: reading.headSha ?? '' },
          raisedAt: reading.checkedAt,
        }];
      }

      // `fresh` and `unknown` have nothing to tell anyone.
      return [];
    },
  };
}
