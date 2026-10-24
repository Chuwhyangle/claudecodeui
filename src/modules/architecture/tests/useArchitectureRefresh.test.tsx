/**
 * `useArchitectureRefresh` — the architecture tab's manual re-analysis hook.
 *
 * The network is stubbed at the API seam; the hook's own accounting is real:
 * the activation GET (a tab opened mid-run shows the shared running state), the
 * running poll, the once-per-job success delivery, the start guard, and the
 * failure/retry reading.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SharedApiModule from '@/shared/api';
import {
  useArchitectureRefresh,
  type ArchitectureRefreshStartResult,
  type ArchitectureRefreshStatus,
} from '@/modules/architecture/useArchitectureRefresh';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    // The transport helper is an identity step here: the mocks answer documents,
    // not `Response` objects.
    readApiJson: async (value: unknown) => value,
    api: {
      ...actual.api,
      architectureRefreshStatus: apiMock.status,
      architectureRefresh: apiMock.start,
    },
  };
});

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
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    stage: 'analyzing',
    elapsedMs: 65_000,
  });
}

function started(jobId: string, status: ArchitectureRefreshStatus, coalesced = false): ArchitectureRefreshStartResult {
  return { jobId, coalesced, status };
}

beforeEach(() => {
  apiMock.status.mockReset();
  apiMock.start.mockReset();
});

describe('useArchitectureRefresh', () => {
  it('loads the status on mount and reflects another session’s running job without offering a start', async () => {
    apiMock.status.mockResolvedValue(runningStatus());

    const { result } = renderHook(() => useArchitectureRefresh('project-1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.status.state).toBe('running'));

    expect(apiMock.status).toHaveBeenCalledWith('project-1');
    expect(result.current.status.jobId).toBe('job-1');

    // A running job must not be startable a second time from this tab.
    act(() => result.current.start());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(apiMock.start).not.toHaveBeenCalled();
  });

  it('reports the live elapsed time for a running job', async () => {
    apiMock.status.mockResolvedValue(runningStatus());
    const { result } = renderHook(() => useArchitectureRefresh('project-1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.status.state).toBe('running'));
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(65_000);
  });

  it('polls a running job and delivers its success exactly once', async () => {
    apiMock.status
      .mockResolvedValueOnce(runningStatus())
      .mockResolvedValue(statusOf({
        state: 'succeeded',
        jobId: 'job-1',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        stage: 'succeeded',
        exitCode: 0,
      }));
    const onSucceeded = vi.fn();

    const { result } = renderHook(() => useArchitectureRefresh('project-1', {
      pollIntervalMs: 10,
      onSucceeded,
    }));

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(result.current.status.state).toBe('succeeded');

    // Further polls/renders must not re-deliver the same job.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onSucceeded).toHaveBeenCalledTimes(1);
  });

  it('does NOT deliver a success the tab never saw running (a stale terminal reading)', async () => {
    apiMock.status.mockResolvedValue(statusOf({ state: 'succeeded', jobId: 'old-job', stage: 'succeeded' }));
    const onSucceeded = vi.fn();

    const { result } = renderHook(() => useArchitectureRefresh('project-1', {
      pollIntervalMs: 10,
      onSucceeded,
    }));

    await waitFor(() => expect(result.current.status.state).toBe('succeeded'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onSucceeded).not.toHaveBeenCalled();
  });

  it('starts once, ignores a second press while running, and delivers the job’s success', async () => {
    apiMock.status.mockResolvedValueOnce(statusOf()).mockResolvedValue(statusOf({
      state: 'succeeded',
      jobId: 'job-2',
      stage: 'succeeded',
      exitCode: 0,
    }));
    apiMock.start.mockResolvedValue(started('job-2', runningStatus('job-2')));
    const onSucceeded = vi.fn();

    const { result } = renderHook(() => useArchitectureRefresh('project-1', {
      pollIntervalMs: 10,
      onSucceeded,
    }));
    await waitFor(() => expect(result.current.status.state).toBe('idle'));

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.status.state).toBe('running'));
    expect(apiMock.start).toHaveBeenCalledTimes(1);
    expect(apiMock.start).toHaveBeenCalledWith('project-1');

    act(() => result.current.start());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(apiMock.start).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
  });

  it('exposes a failed job’s reason and lets a retry start again', async () => {
    apiMock.status.mockResolvedValue(statusOf());
    apiMock.start
      .mockResolvedValueOnce(started('job-fail', statusOf({
        state: 'failed',
        jobId: 'job-fail',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        stage: 'failed',
        exitCode: 1,
        stderrTail: ['boom'],
        error: 'ArchGuard exited with code 1: boom',
      })))
      .mockResolvedValueOnce(started('job-retry', runningStatus('job-retry')));

    const { result } = renderHook(() => useArchitectureRefresh('project-1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.status.state).toBe('idle'));

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.status.state).toBe('failed'));
    expect(result.current.status.error).toBe('ArchGuard exited with code 1: boom');

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.status.state).toBe('running'));
    expect(apiMock.start).toHaveBeenCalledTimes(2);
    expect(result.current.status.jobId).toBe('job-retry');
  });

  it('surfaces a transport failure from the start request as requestError', async () => {
    apiMock.status.mockResolvedValue(statusOf());
    apiMock.start.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useArchitectureRefresh('project-1', { pollIntervalMs: 60_000 }));
    await waitFor(() => expect(result.current.status.state).toBe('idle'));

    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.requestError).toBe('network down'));
    expect(result.current.status.state).toBe('idle');
  });

  it('does nothing without a project', async () => {
    const { result } = renderHook(() => useArchitectureRefresh(null));
    expect(result.current.status.state).toBe('idle');
    act(() => result.current.start());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(apiMock.status).not.toHaveBeenCalled();
    expect(apiMock.start).not.toHaveBeenCalled();
  });
});
