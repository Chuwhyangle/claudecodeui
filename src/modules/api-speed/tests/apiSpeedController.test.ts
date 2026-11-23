import { describe, expect, it, vi } from 'vitest';

import type {
  ApiLatencyProbeResult,
  ApiLatencySeries,
} from '@/shared/apiLatencyType';
import {
  createApiSpeedController,
  type ApiSpeedClient,
} from '@/modules/api-speed/utils/apiSpeedController';

/**
 * The API-speed rules, driven without React, a timer or a network.
 *
 * These are the four decisions the panel must not get wrong: which answer wins
 * when two reads overlap, what a failed refresh does to the chart already on
 * screen, how the auto-probe schedules its next sample, and what a disposed
 * controller does with a late answer. Each is unreachable through a rendered
 * component, which is why the rules live in the controller at all.
 */

function probe(overrides: Partial<ApiLatencyProbeResult> = {}): ApiLatencyProbeResult {
  return {
    id: `probe-${Math.random().toString(36).slice(2)}`,
    at: '2026-11-20T00:00:00.000Z',
    ok: true,
    mode: 'ping',
    stream: true,
    model: 'test-model',
    transport: 'reused',
    status: 200,
    requestBytes: 120,
    responseBytes: 40,
    timings: { dnsMs: null, tcpMs: null, tlsMs: null, uploadMs: 0, firstByteMs: 400, downloadMs: 2, totalMs: 402 },
    firstTokenMs: 410,
    error: null,
    ...overrides,
  };
}

function series(probes: ApiLatencyProbeResult[] = []): ApiLatencySeries {
  return {
    target: {
      baseUrl: 'https://gateway.example.test',
      host: 'gateway.example.test',
      model: 'test-model',
      hasCredential: true,
      credentialSource: 'env',
    },
    probes,
  };
}

/** A promise whose settlement the case controls, for the overlap cases. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function clientOf(overrides: Partial<ApiSpeedClient> = {}): ApiSpeedClient {
  return {
    series: vi.fn(async () => series()),
    probe: vi.fn(async () => probe()),
    ...overrides,
  } as ApiSpeedClient;
}

describe('api speed controller', () => {
  it('the first read fills the snapshot and clears the loading flag', async () => {
    const reading = series([probe({ id: 'one' })]);
    const client = clientOf({ series: vi.fn(async () => reading) });
    const controller = createApiSpeedController({ client });

    expect(controller.getSnapshot().isLoading).toBe(true);
    await controller.reload();

    expect(controller.getSnapshot().series).toEqual(reading);
    expect(controller.getSnapshot().isLoading).toBe(false);
    expect(controller.getSnapshot().error).toBeNull();
  });

  it('a failed refresh keeps the reading on screen and reports the error', async () => {
    const reading = series([probe({ id: 'kept' })]);
    const client = clientOf({
      series: vi.fn()
        .mockResolvedValueOnce(reading)
        .mockRejectedValueOnce(new Error('gateway unreachable')),
    });
    const controller = createApiSpeedController({ client });

    await controller.reload();
    await controller.reload();

    // Blanking the chart on one failed refresh would hide the trend exactly when
    // the link is misbehaving, so the previous reading stands.
    expect(controller.getSnapshot().series).toEqual(reading);
    expect(controller.getSnapshot().error).toBe('gateway unreachable');
  });

  it('a stale answer never overwrites a newer one', async () => {
    const slow = deferred<ApiLatencySeries>();
    const fast = deferred<ApiLatencySeries>();
    const client = clientOf({
      series: vi.fn()
        .mockReturnValueOnce(slow.promise)
        .mockReturnValueOnce(fast.promise),
    });
    const controller = createApiSpeedController({ client });

    const first = controller.reload();
    const second = controller.reload();

    fast.resolve(series([probe({ id: 'newer' })]));
    await second;
    expect(controller.getSnapshot().series?.probes.map((entry) => entry.id)).toEqual(['newer']);

    // The earlier request answers afterwards; it must be dropped, not applied.
    slow.resolve(series([probe({ id: 'older' })]));
    await first;
    expect(controller.getSnapshot().series?.probes.map((entry) => entry.id)).toEqual(['newer']);
  });

  it('a probe appends its result and then re-reads the store', async () => {
    const first = series();
    const measured = probe({ id: 'fresh' });
    const client = clientOf({
      series: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(series([measured])),
      probe: vi.fn(async () => measured),
    });
    const controller = createApiSpeedController({ client });

    await controller.reload();
    await controller.probe({ mode: 'ping', stream: true });

    expect(client.series).toHaveBeenCalledTimes(2);
    // The store, not this tab, is the authority once two tabs probe at once — and
    // the optimistic append is what kept the chart moving during the re-read.
    expect(controller.getSnapshot().series?.probes.map((entry) => entry.id)).toEqual(['fresh']);
    expect(controller.getSnapshot().isProbing).toBe(false);
  });

  it('a probe that never reached the gateway reports its message and clears the busy flag', async () => {
    const reading = series([probe({ id: 'kept' })]);
    const client = clientOf({
      series: vi.fn(async () => reading),
      probe: vi.fn(async () => {
        throw new Error('Request failed (502)');
      }),
    });
    const controller = createApiSpeedController({ client });

    await controller.reload();
    await controller.probe({ mode: 'ping' });

    expect(controller.getSnapshot().error).toBe('Request failed (502)');
    expect(controller.getSnapshot().isProbing).toBe(false);
    // The reading that arrived before the failure is not thrown away.
    expect(controller.getSnapshot().series).toEqual(reading);
  });

  it('the auto-probe takes one sample at once, then schedules the next only after it finished', async () => {
    const timers: Array<() => void> = [];
    const client = clientOf();
    const controller = createApiSpeedController({
      client,
      autoProbeMs: 30_000,
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length - 1;
      },
      clearTimer: vi.fn(),
    });

    controller.setAutoProbe(true);
    expect(controller.getSnapshot().autoProbe).toBe(true);

    // Switching on means "take one now", not "wait 30 s for the first one".
    await vi.waitFor(() => expect(client.probe).toHaveBeenCalledTimes(1));
    expect(client.probe).toHaveBeenCalledWith({ mode: 'ping', stream: true });

    // The next sample is armed only after the previous one finished, so a slow
    // probe stretches the interval instead of stacking requests behind it.
    await vi.waitFor(() => expect(timers.length).toBe(1));
    const next = timers[0]!;
    timers.length = 0;
    next();
    await vi.waitFor(() => expect(client.probe).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timers.length).toBe(1));
  });

  it('switching the auto-probe off cancels the pending sample', async () => {
    const clearTimer = vi.fn();
    const timers: Array<() => void> = [];
    const client = clientOf();
    const controller = createApiSpeedController({
      client,
      setTimer: (callback) => {
        timers.push(callback);
        return `timer-${timers.length}`;
      },
      clearTimer,
    });

    controller.setAutoProbe(true);
    await vi.waitFor(() => expect(timers.length).toBe(1));
    controller.setAutoProbe(false);

    expect(controller.getSnapshot().autoProbe).toBe(false);
    expect(clearTimer).toHaveBeenCalledWith('timer-1');
  });

  it('a disposed controller drops the answer that was still in flight', async () => {
    const pending = deferred<ApiLatencySeries>();
    const client = clientOf({ series: vi.fn(() => pending.promise) });
    const controller = createApiSpeedController({ client });

    const reload = controller.reload();
    controller.stop();
    pending.resolve(series([probe({ id: 'late' })]));
    await reload;

    expect(controller.getSnapshot().series).toBeNull();
  });
});
