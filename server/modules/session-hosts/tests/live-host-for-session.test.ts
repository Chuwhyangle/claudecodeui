/**
 * Behavior baseline for `SessionHostManager.liveHostForSession` (AC-324).
 *
 * This is the canonical "session -> live host" read: `resident-host.service.ts`,
 * `mcp-session-host-control.ts`'s `readLiveHost`, and `providers/sessions.service.ts`'s
 * `switchSessionLifecycleMode` all call it directly instead of each keeping a
 * private copy of `manager.snapshot().find(h => h.state !== 'closed' &&
 * h.bindings.has(id))`. This file pins the method's own behavior across the four
 * cases those three call sites care about, so a future change to any of them
 * reds here first instead of silently diverging from the others.
 *
 * The manager is real (`createSessionHostManager()`), driven with a passive
 * stand-in driver — the same pattern `resident-host-service.test.ts` uses — so
 * "closed hosts are skipped" and "an unbound session finds nothing" are read
 * from a live binding table, not a fixture's opinion.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { IProviderHostDriver } from '@/shared/interfaces.js';
import type { ProcessHost } from '@/shared/types.js';

import { createSessionHostManager } from '../session-host-manager.service.js';

function createPassiveDriver(): IProviderHostDriver {
  return {
    multiplexedHost: false,
    async startHost(host: ProcessHost): Promise<ProcessHost> {
      return host;
    },
    async bind(): Promise<void> {},
    async submit(): Promise<void> {},
    async interrupt(): Promise<boolean> {
      return false;
    },
    async reconfigure(): Promise<'live' | 'next-turn'> {
      return 'live';
    },
    async unbind(): Promise<void> {},
    async closeHost(): Promise<void> {},
  };
}

test('liveHostForSession finds the host bound to a live session', async () => {
  const manager = createSessionHostManager();
  const boundId = 'session-bound';
  const host = await manager.openHost({
    provider: 'claude',
    mode: 'resident',
    appSessionId: boundId,
    driver: createPassiveDriver(),
    pid: 4242,
  });

  const found = manager.liveHostForSession(boundId);

  assert.ok(found, 'a session with a live, open host must be found');
  assert.equal(found?.hostId, host.hostId);
  assert.equal(found?.pid, 4242);
});

test('liveHostForSession returns null for a session with no binding at all', async () => {
  const manager = createSessionHostManager();
  await manager.openHost({
    provider: 'claude',
    mode: 'resident',
    appSessionId: 'some-other-session',
    driver: createPassiveDriver(),
  });

  assert.equal(manager.liveHostForSession('never-bound-session'), null);
});

test('liveHostForSession returns null once the host is closed, even within the retention window', async () => {
  const manager = createSessionHostManager();
  const boundId = 'session-to-close';
  const host = await manager.openHost({
    provider: 'claude',
    mode: 'resident',
    appSessionId: boundId,
    driver: createPassiveDriver(),
  });
  manager.closeHost(host.hostId, 'user');

  // The closed host is still readable off `snapshot()` during its retention
  // window (closing is not the same as forgetting) but must not be reported as
  // the session's *live* host.
  const stillInSnapshot = manager.snapshot().some((h) => h.hostId === host.hostId);
  assert.ok(stillInSnapshot, 'a just-closed host stays in snapshot() during retention');
  assert.equal(manager.liveHostForSession(boundId), null);
});

test('liveHostForSession is specific to the session asked about, not just "any live host"', async () => {
  const manager = createSessionHostManager();
  const sessionA = 'session-a';
  const sessionB = 'session-b';
  const hostA = await manager.openHost({
    provider: 'claude',
    mode: 'resident',
    appSessionId: sessionA,
    driver: createPassiveDriver(),
  });
  const hostB = await manager.openHost({
    provider: 'claude',
    mode: 'resident',
    appSessionId: sessionB,
    driver: createPassiveDriver(),
  });

  assert.equal(manager.liveHostForSession(sessionA)?.hostId, hostA.hostId);
  assert.equal(manager.liveHostForSession(sessionB)?.hostId, hostB.hostId);
  assert.notEqual(hostA.hostId, hostB.hostId);
});
