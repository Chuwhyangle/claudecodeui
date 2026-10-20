import assert from 'node:assert/strict';

import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import { createActivityFreshness } from '@/modules/chat/utils/session/activityFreshness';
import type { ActivityFrame } from '@/modules/chat/utils/session/activityFreshness';

// The server-declared silence budget this suite exercises. Deliberately not the shipped
// default (5000/15000, pinned by AC-182's own criterion) — the machine must obey whatever
// `staleAfter` the frame carries, so the test picks its own value.
const STALE_AFTER = 15_000;

const makeFrame = (overrides: Partial<ActivityFrame> = {}): ActivityFrame => ({
  bootId: 'boot-1',
  rev: 1,
  asOf: 1_000,
  staleAfter: STALE_AFTER,
  turn: { startedAt: null },
  ...overrides,
});

describe('activityFreshness', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // AC2: no evidence at all reads as unreachable; any frame is evidence that reads as fresh.
  test('AC2 a fresh machine is unreachable and any frame makes it fresh', () => {
    const machine = createActivityFreshness();

    assert.equal(machine.getLiveness(), 'unreachable');

    machine.onFrame(makeFrame({ asOf: 12_000, turn: { startedAt: 11_500 } }));

    assert.equal(machine.getLiveness(), 'fresh');
    machine.dispose();
  });

  // AC3: the threshold itself is the boundary — one millisecond short is still fresh.
  test('AC3 stays fresh until staleAfter and degrades exactly at the threshold', () => {
    const machine = createActivityFreshness();
    machine.onFrame(makeFrame({ asOf: 12_000 }));

    vi.advanceTimersByTime(STALE_AFTER - 1);
    assert.equal(machine.getLiveness(), 'fresh');

    vi.advanceTimersByTime(1);
    assert.equal(machine.getLiveness(), 'unreachable');

    machine.dispose();
  });

  // AC4: an unreachable machine recovers on the very next frame.
  test('AC4 any frame after unreachable returns to fresh', () => {
    const machine = createActivityFreshness();
    machine.onFrame(makeFrame());

    vi.advanceTimersByTime(STALE_AFTER);
    assert.equal(machine.getLiveness(), 'unreachable');

    machine.onFrame(makeFrame({ rev: 2, asOf: 40_000 }));

    assert.equal(machine.getLiveness(), 'fresh');
    machine.dispose();
  });

  // AC5: a closed socket is unreachable without waiting out the silence budget.
  test('AC5 socket close is unreachable immediately, before the budget elapses', () => {
    const machine = createActivityFreshness();
    machine.onFrame(makeFrame());
    assert.equal(machine.getLiveness(), 'fresh');

    machine.onSocketClose();

    assert.equal(machine.getLiveness(), 'unreachable');
    machine.dispose();
  });

  // AC6: a frame from a new server process voids the client's own in-progress assumption and
  // every reading falls back to what that frame carried.
  test('AC6 a bootId change discards the local in-progress assumption', () => {
    const machine = createActivityFreshness();

    // The client itself assumed a turn before the server confirmed anything.
    machine.markLocalTurnStarted(9_000);
    assert.equal(machine.getSnapshot().turnStartedAt, 9_000);
    assert.equal(machine.getSnapshot().turnIsLocal, true);

    // A frame from a different server process carries an idle snapshot.
    machine.onFrame(
      makeFrame({ bootId: 'boot-2', rev: 1, asOf: 50_000, turn: { startedAt: null } }),
    );

    const snapshot = machine.getSnapshot();
    assert.equal(snapshot.turnStartedAt, null);
    assert.equal(snapshot.turnIsLocal, false);
    assert.equal(snapshot.asOf, 50_000);
    assert.equal(snapshot.liveness, 'fresh');
    assert.equal(machine.getElapsedMs(), null);

    machine.dispose();
  });

  // AC8: the two turn-snapshot migrations the dock's idle-beat handling rides on. A frame
  // that asserts the turn keeps the anchor and the elapsed is re-derived from the server's
  // own `asOf`; a frame that asserts no turn clears the anchor outright. The hook decides
  // *which* snapshot a heartbeat asserts (from the run registry's in-flight bit); this pins
  // that the machine honours both without inventing a clock of its own.
  test('AC8 a turn-asserting frame keeps the anchor and a turn-clearing frame drops it', () => {
    const machine = createActivityFreshness();

    machine.onFrame(makeFrame({ asOf: 10_000, turn: { startedAt: 4_000 } }));
    assert.equal(machine.getElapsedMs(), 6_000);

    // A later frame that still asserts the turn: the anchor is carried, and the elapsed
    // advances because the server's `asOf` moved — never because a local clock ran.
    machine.onFrame(makeFrame({ rev: 2, asOf: 20_000, turn: { startedAt: 4_000 } }));
    assert.equal(machine.getSnapshot().turnStartedAt, 4_000);
    assert.equal(machine.getElapsedMs(), 16_000);

    // A frame asserting no turn clears the anchor and the elapsed reading with it.
    machine.onFrame(makeFrame({ rev: 3, asOf: 30_000, turn: { startedAt: null } }));
    assert.equal(machine.getSnapshot().turnStartedAt, null);
    assert.equal(machine.getElapsedMs(), null);

    machine.dispose();
  });

  // AC7: while unreachable the elapsed reading comes from the frame's asOf and turn.startedAt
  // and does not advance with the local clock.
  test('AC7 elapsed stays frozen while unreachable and equals asOf - turn.startedAt', () => {
    const asOf = 20_000;
    const startedAt = 3_000;
    const machine = createActivityFreshness();
    machine.onFrame(makeFrame({ rev: 3, asOf, turn: { startedAt } }));
    assert.equal(machine.getElapsedMs(), asOf - startedAt);

    // Go unreachable by silence, then let the wall clock run well past the threshold.
    vi.advanceTimersByTime(STALE_AFTER);
    assert.equal(machine.getLiveness(), 'unreachable');

    const first = machine.getElapsedMs();
    vi.advanceTimersByTime(7_000);
    const second = machine.getElapsedMs();

    assert.equal(first, second);
    assert.equal(first, asOf - startedAt);

    machine.dispose();
  });
});
