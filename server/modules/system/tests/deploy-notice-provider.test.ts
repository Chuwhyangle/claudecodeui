/**
 * AC — the deploy notice provider's mapping table (proposal §5), row by row.
 *
 * The provider is driven over a STUBBED `readReadiness`, so each row is the production mapping
 * function's answer to one crafted reading and no git/build/subprocess runs:
 *
 *   fresh / unknown                       → no notice
 *   pending-build / built-pending-restart → deploy:pending-build, condition/attention,
 *                                           revision = headSha, primary action present
 *   building / restarting                 → the SAME entry in progress: no extra entry, no action
 *   failure !== null                      → deploy:failed, condition/blocking, revision = failure.at
 *   lastDeploy.ok === false               → deploy:failed, condition/blocking, revision = lastDeploy.at
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/system/tests/deploy-notice-provider.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Notice } from '@/modules/notices/index.js';

import type { DeployReadinessReading } from '../deploy-readiness.service.js';
import { createDeployNoticeProvider } from '../deploy-notice-provider.js';

const CHECKED_AT = '2026-10-25T09:00:00.000Z';
const HEAD_SHA = 'a'.repeat(40);

/** One reading, defaulting to the `fresh` row; each case overrides only the fields it is about. */
function reading(overrides: Partial<DeployReadinessReading> = {}): DeployReadinessReading {
  return {
    status: 'fresh',
    runningSha: HEAD_SHA,
    builtSha: HEAD_SHA,
    clientBuiltSha: null,
    headSha: HEAD_SHA,
    pendingCommits: [],
    lastDeploy: null,
    failure: null,
    checkedAt: CHECKED_AT,
    ...overrides,
  };
}

/** Reads one crafted reading through the production provider. */
async function readOver(overrides: Partial<DeployReadinessReading>): Promise<Notice[]> {
  const provider = createDeployNoticeProvider({ readReadiness: async () => reading(overrides) });
  return provider.read();
}

test('§5 fresh → no notice', async () => {
  assert.deepEqual(await readOver({ status: 'fresh' }), []);
});

test('§5 unknown → no notice', async () => {
  assert.deepEqual(
    await readOver({ status: 'unknown', runningSha: null, builtSha: null, headSha: null }),
    [],
  );
});

test('§5 pending-build → deploy:pending-build, attention, revision = headSha, action present', async () => {
  const notices = await readOver({
    status: 'pending-build',
    pendingCommits: [{ sha: 'b'.repeat(40), subject: 'src: change', taskId: null }],
  });

  assert.equal(notices.length, 1);
  const [notice] = notices;
  assert.equal(notice!.id, 'deploy:pending-build');
  assert.equal(notice!.source, 'deploy');
  assert.equal(notice!.lifecycle, 'condition');
  assert.equal(notice!.severity, 'attention');
  assert.equal(notice!.scope, 'global');
  assert.equal(notice!.revision, HEAD_SHA, 'the dismissal key is the checked-out sha');
  assert.deepEqual(notice!.primaryAction, {
    id: 'deploy.build-and-restart',
    labelKey: 'notices.deploy.pendingBuild.action',
  });
  assert.equal(notice!.params.headSha, HEAD_SHA);
  assert.equal(notice!.params.count, 1);
  assert.equal(notice!.raisedAt, CHECKED_AT);
});

test('§5 built-pending-restart → the same deploy:pending-build entry', async () => {
  const notices = await readOver({ status: 'built-pending-restart' });

  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.id, 'deploy:pending-build');
  assert.equal(notices[0]!.revision, HEAD_SHA);
  assert.ok(notices[0]!.primaryAction !== undefined);
});

test('§5 building → no extra entry, same id/revision, no primary action', async () => {
  const pending = await readOver({ status: 'pending-build' });
  const building = await readOver({ status: 'building' });

  assert.equal(building.length, 1, 'the in-progress state must not add a second entry');
  assert.equal(building[0]!.id, pending[0]!.id, 'it is the SAME notice, not a new one');
  assert.equal(building[0]!.revision, pending[0]!.revision);
  assert.equal(building[0]!.lifecycle, 'condition');
  assert.equal(building[0]!.primaryAction, undefined, 'no second build can be started mid-build');
});

test('§5 restarting → no extra entry, same id/revision, no primary action', async () => {
  const restarting = await readOver({ status: 'restarting' });

  assert.equal(restarting.length, 1);
  assert.equal(restarting[0]!.id, 'deploy:pending-build');
  assert.equal(restarting[0]!.revision, HEAD_SHA);
  assert.equal(restarting[0]!.primaryAction, undefined);
});

test('§5 failure !== null → deploy:failed, blocking, revision = failure.at, no action', async () => {
  const failureAt = '2026-10-25T09:05:00.000Z';
  const notices = await readOver({
    // A failed deploy leaves the status at pending-build; the failure must win and stand alone.
    status: 'pending-build',
    pendingCommits: [{ sha: 'b'.repeat(40), subject: 'server: change', taskId: null }],
    failure: { step: 'build', outputTail: 'tsc failed', at: failureAt },
  });

  assert.equal(notices.length, 1, 'the leftover pending-build is not a second dismissible message');
  const [notice] = notices;
  assert.equal(notice!.id, 'deploy:failed');
  assert.equal(notice!.source, 'deploy');
  assert.equal(notice!.lifecycle, 'condition');
  assert.equal(notice!.severity, 'blocking');
  assert.equal(notice!.revision, failureAt);
  assert.equal(notice!.raisedAt, failureAt);
  assert.equal(notice!.params.step, 'build');
  assert.equal(notice!.primaryAction, undefined);
});

test('§5 lastDeploy.ok === false → deploy:failed, blocking, revision = lastDeploy.at', async () => {
  const lastDeployAt = '2026-10-25T09:10:00.000Z';
  const notices = await readOver({
    status: 'fresh',
    lastDeploy: {
      targetSha: 'c'.repeat(40),
      ok: false,
      checks: [{ name: 'health', ok: false, status: 503, detail: 'not answering' }],
      at: lastDeployAt,
    },
  });

  assert.equal(notices.length, 1);
  const [notice] = notices;
  assert.equal(notice!.id, 'deploy:failed');
  assert.equal(notice!.severity, 'blocking');
  assert.equal(notice!.revision, lastDeployAt);
  assert.equal(notice!.primaryAction, undefined);
});

test('§5 a successful lastDeploy does not raise a notice', async () => {
  const notices = await readOver({
    status: 'fresh',
    lastDeploy: {
      targetSha: HEAD_SHA,
      ok: true,
      checks: [{ name: 'health', ok: true, status: 200, detail: 'ok' }],
      at: '2026-10-25T09:10:00.000Z',
    },
  });

  assert.deepEqual(notices, []);
});
