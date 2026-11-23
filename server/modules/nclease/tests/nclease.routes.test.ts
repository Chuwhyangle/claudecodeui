/**
 * The NC-lease routes: input bounds and what the sidebar is allowed to do.
 *
 *   ① a reading is answered verbatim, including `degraded` — the route never
 *      upgrades an unreadable ledger into a confident "all free";
 *   ② an unknown slot or outcome is refused with 400 and calls no service;
 *   ③ a release answers 200 and passes the note through;
 *   ④ a live lease is refused (409) and no release is attempted;
 *   ⑤ a rejected release (CLI failed) answers 409;
 *   ⑥ the binary is taken from `NCRES_BIN`, never a personal home-directory path.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/nclease/tests/nclease.routes.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import express, { type Express } from 'express';

import type { NcLeaseStatus } from '@/shared/types.js';

import { createNcLeaseRoutes, type NcLeaseRoutesDeps } from '../nclease.routes.js';
import { isReleasable, readNcLeaseStatus, releaseNcLease } from '../nclease.service.js';

function sampleStatus(): NcLeaseStatus {
  return {
    ts: '2026-11-10T15:00:00',
    degraded: false,
    instances: [
      {
        id: 'nc1',
        container: 'fj-erp-dev',
        port: 18080,
        tier: 'dev',
        out_dir: '/srv/NC/docker-build/replacement',
        db: 'NEWNC',
        probe: {
          container: 'fj-erp-dev', port: 18080, state: 'running', health: 'healthy',
          uptime_s: 100, image_id: 'sha256:abc', error: null,
        },
        lease: null,
        build: null,
        build_state: { state: 'unmarked' },
      },
    ],
    free: ['nc1'],
    errors: [],
  };
}

/** A reading where nc2 holds a lease; `stale` decides whether the panel may release it. */
function statusWithLease(stale: boolean, heartbeatAge = stale ? 3600 : 30): NcLeaseStatus {
  const base = sampleStatus();
  return {
    ...base,
    free: [],
    instances: [{
      ...base.instances[0],
      id: 'nc2',
      container: 'fj-erp-preprod',
      port: 18081,
      lease: {
        lease_id: 'nc2-1',
        who: 'ai:holder',
        purpose: '测试',
        phase: 'editing',
        state: 'active',
        since: '2026-11-10T15:00:00',
        expires_at: '2026-11-10T16:00:00',
        ttl_s: 900,
        heartbeat_age_s: heartbeatAge,
        stale,
        branch: null,
        topic: null,
        base_sha: null,
        out_dir: null,
        contract_path: null,
        image_id: null,
        note: null,
        probe_state: 'running',
      },
    }],
  };
}

async function withServer(
  deps: NcLeaseRoutesDeps,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app: Express = express();
  app.use(express.json());
  app.use('/api/nclease', createNcLeaseRoutes(deps));
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /status answers the reading verbatim', async () => {
  await withServer(
    { readStatus: async () => sampleStatus() },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nclease/status`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), sampleStatus());
    },
  );
});

test('GET /status keeps a degraded reading degraded', async () => {
  const degraded: NcLeaseStatus = {
    ts: null, degraded: true, instances: [], free: [],
    errors: ['ncres missing'],
  };
  await withServer(
    { readStatus: async () => degraded },
    async (baseUrl) => {
      assert.deepEqual(await (await fetch(`${baseUrl}/api/nclease/status`)).json(), degraded);
    },
  );
});

test('POST /release refuses an unknown slot without calling the service', async () => {
  let called = false;
  await withServer(
    {
      release: async () => {
        called = true;
        return { ok: true };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nclease/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'nc9' }),
      });
      assert.equal(response.status, 400);
      assert.equal(called, false);
    },
  );
});

test('POST /release refuses an unknown outcome without calling the service', async () => {
  let called = false;
  await withServer(
    {
      release: async () => {
        called = true;
        return { ok: true };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nclease/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'nc2', outcome: 'maybe' }),
      });
      assert.equal(response.status, 400);
      assert.equal(called, false);
    },
  );
});

test('POST /release passes the slot and note through and answers 200', async () => {
  let seen: unknown = null;
  await withServer(
    {
      readStatus: async () => statusWithLease(true),
      release: async (input) => {
        seen = input;
        return { ok: true, leaseId: 'nc2-1', slot: 'nc2' };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nclease/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'nc2', outcome: 'ok', note: '已推 pending' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(seen, { slot: 'nc2', outcome: 'ok', note: '已推 pending' });
      assert.deepEqual(await response.json(), { ok: true, leaseId: 'nc2-1', slot: 'nc2' });
    },
  );
});

test('POST /release refuses a degraded ledger without calling the service', async () => {
  let called = false;
  await withServer(
    {
      readStatus: async () => ({ ts: null, degraded: true, instances: [], free: [], errors: ['boom'] }),
      release: async () => {
        called = true;
        return { ok: true };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nclease/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'nc2' }),
      });
      assert.equal(response.status, 409);
      assert.equal(called, false);
    },
  );
});

test('POST /release refuses a live lease and calls no release', async () => {
  let called = false;
  await withServer(
    {
      readStatus: async () => statusWithLease(false),
      release: async () => {
        called = true;
        return { ok: true };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nclease/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'nc2' }),
      });
      assert.equal(response.status, 409);
      assert.equal(called, false);
      const body = await response.json() as { error: string };
      assert.match(body.error, /心跳正常/);
    },
  );
});

test('POST /release answers 409 when the CLI refuses', async () => {
  await withServer(
    {
      readStatus: async () => statusWithLease(true),
      release: async () => ({ ok: false, error: 'BLOCKED' }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nclease/release`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'nc2' }),
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { ok: false, error: 'BLOCKED' });
    },
  );
});

test('isReleasable offers a release only for an abandoned lease', () => {
  const lease = statusWithLease(true, 3600).instances[0].lease;
  const probe = statusWithLease(true).instances[0].probe;
  assert.deepEqual(isReleasable(lease, probe), { ok: true });
  // A recent heartbeat on a running container is not releasable.
  assert.equal(isReleasable({ ...lease!, stale: false, heartbeat_age_s: 10 }, probe).ok, false);
  // A stopped container is releasable regardless of the heartbeat.
  assert.deepEqual(isReleasable(lease, { ...probe, state: 'exited' }), { ok: true });
  // No lease at all is not releasable.
  assert.equal(isReleasable(null, probe).ok, false);
});

test('the ncres binary comes from NCRES_BIN, not a personal path', async () => {
  const source = readFileSync(
    fileURLToPath(new URL('../nclease.service.ts', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(source, /\/home\/[A-Za-z0-9_.-]+\//, 'no personal home path may be baked in');

  const previous = process.env.NCRES_BIN;
  process.env.NCRES_BIN = '/nonexistent/ncres-for-the-criterion';
  try {
    const missing = await readNcLeaseStatus();
    assert.equal(missing.degraded, true);
    assert.equal(missing.instances.length, 0);
    // A release through the same missing binary fails without throwing.
    const result = await releaseNcLease({ slot: 'nc1' });
    assert.equal(result.ok, false);
  } finally {
    if (previous === undefined) delete process.env.NCRES_BIN;
    else process.env.NCRES_BIN = previous;
  }
});
