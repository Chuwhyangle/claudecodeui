import { describe, expect, it } from 'vitest';

import type { Clock } from '@/shared/types';
import type { NcLeaseStatus } from '@/shared/ncLeaseType';
import { createNcLeaseController } from '@/modules/nclease/utils/ncLeaseController';

/**
 * The sidebar NC-lease controller's rules, driven without React.
 *
 * The reading, the poll cadence, the superseded-reply guard, and the
 * hidden-tab pause are the decisions the row depends on; the hook is only the
 * binding. A fake clock lets each case advance time instead of sleeping.
 */

/** A `Clock` whose timers only fire when a case calls `advance`. */
function fakeClock(): Clock & { advance(ms: number): Promise<void> } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; at: number }>();
  return {
    now: () => now,
    setTimeout(callback: () => void, milliseconds: number): unknown {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, at: now + milliseconds });
      return id;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
    setInterval(): unknown {
      throw new Error('the controller schedules with setTimeout only');
    },
    clearInterval(): void {},
    async advance(milliseconds: number): Promise<void> {
      now += milliseconds;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
      // Let each fired async read settle before the next case reads the snapshot:
      // `Response.json()` resolves over real microtask turns, not one.
      for (let index = 0; index < 10; index += 1) {
        await new Promise<void>((resolve) => { globalThis.setTimeout(resolve, 0); });
      }
    },
  };
}

function sampleStatus(): NcLeaseStatus {
  return {
    ts: '2026-11-10T15:00:00',
    degraded: false,
    instances: [],
    free: ['nc1', 'nc2', 'nc3'],
    errors: [],
  };
}

describe('createNcLeaseController', () => {
  it('reads once on start and again on each poll tick', async () => {
    const clock = fakeClock();
    let calls = 0;
    const controller = createNcLeaseController({
      fetchStatus: async () => {
        calls += 1;
        return new Response(JSON.stringify(sampleStatus()), { status: 200 });
      },
      fetchRelease: async () => new Response('{}', { status: 200 }),
      readJson: async <T,>(response: Response) => (await response.json()) as T,
      clock,
      pollMs: 5_000,
    });

    controller.start();
    await clock.advance(0);
    expect(calls).toBe(1);
    expect(controller.getSnapshot().status?.free).toEqual(['nc1', 'nc2', 'nc3']);
    expect(controller.getSnapshot().isLoading).toBe(false);

    await clock.advance(5_000);
    expect(calls).toBe(2);
    await clock.advance(5_000);
    expect(calls).toBe(3);

    controller.stop();
    await clock.advance(5_000);
    expect(calls).toBe(3);
  });

  it('stops reading while hidden and catches up when visible again', async () => {
    const clock = fakeClock();
    let calls = 0;
    const controller = createNcLeaseController({
      fetchStatus: async () => {
        calls += 1;
        return new Response(JSON.stringify(sampleStatus()), { status: 200 });
      },
      fetchRelease: async () => new Response('{}', { status: 200 }),
      readJson: async <T,>(response: Response) => (await response.json()) as T,
      clock,
      pollMs: 5_000,
    });

    controller.start();
    await clock.advance(5_000);
    expect(calls).toBe(2);

    controller.setVisible(false);
    await clock.advance(30_000);
    expect(calls).toBe(2);

    controller.setVisible(true);
    await clock.advance(0);
    expect(calls).toBe(3);
    controller.stop();
  });

  it('keeps the last good reading when a refresh fails', async () => {
    const clock = fakeClock();
    let failNext = false;
    const controller = createNcLeaseController({
      fetchStatus: async () => {
        if (failNext) throw new Error('ncres missing');
        return new Response(JSON.stringify(sampleStatus()), { status: 200 });
      },
      fetchRelease: async () => new Response('{}', { status: 200 }),
      readJson: async <T,>(response: Response) => (await response.json()) as T,
      clock,
      pollMs: 5_000,
    });

    controller.start();
    await clock.advance(0);
    expect(controller.getSnapshot().status).not.toBeNull();

    failNext = true;
    await controller.reload();
    const snapshot = controller.getSnapshot();
    expect(snapshot.error).toBe('ncres missing');
    // The row must still draw the previous three slots rather than blanking.
    expect(snapshot.status?.free).toEqual(['nc1', 'nc2', 'nc3']);
    controller.stop();
  });

  it('drops a reply superseded by a newer read', async () => {
    const clock = fakeClock();
    const pending: Array<(response: Response) => void> = [];
    const controller = createNcLeaseController({
      fetchStatus: () => new Promise<Response>((resolve) => { pending.push(resolve); }),
      fetchRelease: async () => new Response('{}', { status: 200 }),
      readJson: async <T,>(response: Response) => (await response.json()) as T,
      clock,
      pollMs: 5_000,
    });

    const first = controller.reload();
    const second = controller.reload();
    // The newer read lands first…
    pending[1](new Response(JSON.stringify({ ...sampleStatus(), ts: 'second' }), { status: 200 }));
    await second;
    // …then the slow one it superseded lands last; it must not overwrite the reading.
    pending[0](new Response(JSON.stringify({ ...sampleStatus(), ts: 'first' }), { status: 200 }));
    await first;
    expect(controller.getSnapshot().status?.ts).toBe('second');
    controller.stop();
  });

  it('reports a refused release and clears the pending slot', async () => {
    const clock = fakeClock();
    const controller = createNcLeaseController({
      fetchStatus: async () => new Response(JSON.stringify(sampleStatus()), { status: 200 }),
      fetchRelease: async () => new Response(JSON.stringify({ ok: false, error: '心跳正常' }), { status: 409 }),
      readJson: async <T,>(response: Response) => (await response.json()) as T,
      clock,
      pollMs: 5_000,
    });

    await controller.release('nc2');
    const snapshot = controller.getSnapshot();
    expect(snapshot.error).toBe('心跳正常');
    expect(snapshot.releasing).toBeNull();
    controller.stop();
  });
});
