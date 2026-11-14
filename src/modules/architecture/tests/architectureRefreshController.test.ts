/**
 * `createArchitectureRefreshController` — the architecture tab's refresh rules,
 * exercised without React, the network or a wall clock.
 *
 * The three rules the criterion names:
 * - once-per-job delivery: a watched job's success reaches `onSucceeded` once;
 * - observed-running dedup: a stale `succeeded` reading the tab never watched
 *   running is not delivered;
 * - coalescing: a press while a job runs sends no second POST, and a
 *   `coalesced: true` answer adopts the job it joined.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createArchitectureRefreshController,
  type ArchitectureRefreshClock,
} from '@/modules/architecture/render/viewport/architectureRefreshController';
import type { ArchitectureRefreshStatus } from '@/shared/types';

/**
 * A controller armed the way the hook arms it: the activation read and timers
 * start on the first subscriber.
 */
function createMountedController(
  options: Parameters<typeof createArchitectureRefreshController>[0],
): ReturnType<typeof createArchitectureRefreshController> {
  const controller = createArchitectureRefreshController(options);
  controller.subscribe(() => {});
  return controller;
}

type Timer = {
  handle: number;
  callback: () => void;
  due: number;
  interval: number | null;
};

/** A deterministic clock: timers fire only when `advance` moves past them. */
function createFakeClock(): {
  clock: ArchitectureRefreshClock;
  advance: (milliseconds: number) => Promise<void>;
} {
  let now = 1_000_000;
  let nextHandle = 1;
  const timers = new Map<number, Timer>();

  const schedule = (callback: () => void, milliseconds: number, interval: number | null): number => {
    const handle = nextHandle;
    nextHandle += 1;
    timers.set(handle, { handle, callback, due: now + milliseconds, interval });
    return handle;
  };

  const clock: ArchitectureRefreshClock = {
    now: () => now,
    setTimeout: (callback, milliseconds) => schedule(callback, milliseconds, null),
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    setInterval: (callback, milliseconds) => schedule(callback, milliseconds, milliseconds),
    clearInterval: (handle) => {
      timers.delete(handle as number);
    },
  };

  const flush = async (): Promise<void> => {
    // Let an awaiting API mock and its continuation run.
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };

  const advance = async (milliseconds: number): Promise<void> => {
    const target = now + milliseconds;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of timers.values()) {
        if (timer.due <= target && (next === undefined || timer.due < next.due)) next = timer;
      }
      if (next === undefined) break;
      now = next.due;
      if (next.interval === null) timers.delete(next.handle);
      else next.due = now + next.interval;
      next.callback();
      await flush();
    }
    now = target;
    await flush();
  };

  return { clock, advance };
}

function statusOf(overrides: Partial<ArchitectureRefreshStatus> = {}): ArchitectureRefreshStatus {
  return {
    state: 'idle',
    jobId: null,
    startedAt: null,
    finishedAt: null,
    stage: 'idle',
    elapsedMs: 0,
    exitCode: null,
    stderrTail: [],
    error: null,
    ...overrides,
  };
}

function runningStatus(jobId = 'job-1'): ArchitectureRefreshStatus {
  return statusOf({
    state: 'running',
    jobId,
    startedAt: new Date(1_000_000 - 65_000).toISOString(),
    stage: 'analyzing',
    elapsedMs: 65_000,
  });
}

function succeededStatus(jobId = 'job-1'): ArchitectureRefreshStatus {
  return statusOf({
    state: 'succeeded',
    jobId,
    startedAt: new Date(1_000_000 - 90_000).toISOString(),
    finishedAt: new Date(1_000_000).toISOString(),
    stage: 'succeeded',
    exitCode: 0,
  });
}

describe('createArchitectureRefreshController', () => {
  it('delivers a watched job’s success exactly once, however many readings follow', async () => {
    const { clock, advance } = createFakeClock();
    const status = vi.fn()
      .mockResolvedValueOnce(runningStatus())
      .mockResolvedValue(succeededStatus());
    const start = vi.fn();
    const onSucceeded = vi.fn();

    const controller = createMountedController({
      api: { status, start },
      projectId: 'project-1',
      clock,
      pollIntervalMs: 10,
      onSucceeded,
    });

    // The activation read sees the job running; the first poll sees it finish.
    await advance(0);
    expect(controller.getSnapshot().status.state).toBe('running');

    await advance(10);
    await advance(50);
    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(onSucceeded.mock.calls[0]?.[0]).toMatchObject({ jobId: 'job-1', state: 'succeeded' });

    // The terminal reading is cached by the server; a late poll must not re-deliver.
    await advance(10);
    expect(onSucceeded).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a success the tab never watched running', async () => {
    const { clock, advance } = createFakeClock();
    const status = vi.fn().mockResolvedValue(succeededStatus('old-job'));
    const onSucceeded = vi.fn();

    const controller = createMountedController({
      api: { status, start: vi.fn() },
      projectId: 'project-1',
      clock,
      pollIntervalMs: 10,
      onSucceeded,
    });

    await advance(0);
    expect(controller.getSnapshot().status.state).toBe('succeeded');
    await advance(100);
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  it('coalesces: a press while a job runs sends no second POST', async () => {
    const { clock, advance } = createFakeClock();
    const status = vi.fn().mockResolvedValue(runningStatus());
    const start = vi.fn();

    const controller = createMountedController({
      api: { status, start },
      projectId: 'project-1',
      clock,
      pollIntervalMs: 60_000,
    });

    await advance(0);
    expect(controller.getSnapshot().status.state).toBe('running');

    controller.refresh();
    await advance(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('adopts a coalesced start and delivers the joined job’s success once', async () => {
    const { clock, advance } = createFakeClock();
    const status = vi.fn()
      .mockResolvedValueOnce(statusOf())
      .mockResolvedValue(succeededStatus('joined-job'));
    const start = vi.fn().mockResolvedValue({
      jobId: 'joined-job',
      coalesced: true,
      status: runningStatus('joined-job'),
    });
    const onSucceeded = vi.fn();

    const controller = createMountedController({
      api: { status, start },
      projectId: 'project-1',
      clock,
      pollIntervalMs: 10,
      onSucceeded,
    });

    await advance(0);
    controller.refresh();
    await advance(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().status.state).toBe('running');

    await advance(10);
    expect(onSucceeded).toHaveBeenCalledTimes(1);
    expect(onSucceeded.mock.calls[0]?.[0]).toMatchObject({ jobId: 'joined-job' });
  });

  it('tracks the live elapsed reading while a job runs', async () => {
    const { clock, advance } = createFakeClock();
    const status = vi.fn().mockResolvedValue(runningStatus());

    const controller = createMountedController({
      api: { status, start: vi.fn() },
      projectId: 'project-1',
      clock,
      pollIntervalMs: 60_000,
    });

    await advance(0);
    const first = controller.getSnapshot().elapsedMs;
    await advance(2_000);
    expect(controller.getSnapshot().elapsedMs).toBeGreaterThanOrEqual(first + 2_000);
  });

  it('surfaces a start transport failure as requestError and keeps the reading', async () => {
    const { clock, advance } = createFakeClock();
    const status = vi.fn().mockResolvedValue(statusOf());
    const start = vi.fn().mockRejectedValue(new Error('network down'));

    const controller = createMountedController({
      api: { status, start },
      projectId: 'project-1',
      clock,
      pollIntervalMs: 60_000,
    });

    await advance(0);
    controller.refresh();
    await advance(0);
    expect(controller.getSnapshot().requestError).toBe('network down');
    expect(controller.getSnapshot().status.state).toBe('idle');
    expect(controller.getSnapshot().starting).toBe(false);
  });

  it('does nothing without a project', async () => {
    const { clock, advance } = createFakeClock();
    const status = vi.fn();
    const start = vi.fn();

    const controller = createMountedController({
      api: { status, start },
      projectId: null,
      clock,
    });

    controller.refresh();
    await advance(1_000);
    expect(status).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status.state).toBe('idle');
  });
});
