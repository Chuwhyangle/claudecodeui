import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import SessionTaskChain from '@/modules/chat/SessionTaskChain';
import type {
  SessionTaskChainCounts,
  SessionTaskChainEntry,
  SessionTaskChainPort,
  SessionTaskChainReading,
} from '@/modules/chat/SessionTaskChain';

/**
 * The session → task chain bar (AC3).
 *
 * WHAT THIS FILE PROVES, against the rendered DOM and the injected read port:
 *
 *   - the compact sentence's four counts are exactly the reading's counts;
 *   - a conversation that started no tasks renders no bar (and spends no transcript row);
 *   - expanding lists every task with its stage, and a blocked task carries its reason;
 *   - a task moving from 「已合入」 to 「线上运行」 raises ONE notice, and the same transition
 *     seen on later polls does not raise another.
 *
 * The read port is injected, so no network is involved and the assertions are about what the
 * component renders, not about a mocked fetch.
 */

const PROJECT_ID = 'project-1';
const SESSION_ID = 'session-1';

/** The stages the fixture spans, in list order. */
const FIXTURE_TASKS: SessionTaskChainEntry[] = [
  {
    taskId: 't-alpha',
    title: 'first in flight',
    status: 'ready',
    stage: 'in-progress',
    origin: 'created',
    landCommit: null,
    blockedReason: null,
  },
  {
    taskId: 't-beta',
    title: 'second in flight',
    status: 'ready',
    stage: 'in-progress',
    origin: 'created',
    landCommit: null,
    blockedReason: null,
  },
  {
    taskId: 't-gamma',
    title: 'landed one',
    status: 'done',
    stage: 'landed',
    origin: 'created',
    landCommit: 'a'.repeat(40),
    blockedReason: null,
  },
  {
    taskId: 't-delta',
    title: 'landed two',
    status: 'done',
    stage: 'landed',
    origin: 'edited',
    landCommit: 'b'.repeat(40),
    blockedReason: null,
  },
  {
    taskId: 't-epsilon',
    title: 'landed three',
    status: 'done',
    stage: 'landed',
    origin: 'created',
    landCommit: 'c'.repeat(40),
    blockedReason: null,
  },
  {
    taskId: 't-zeta',
    title: 'already live',
    status: 'done',
    stage: 'running',
    origin: 'created',
    landCommit: 'd'.repeat(40),
    blockedReason: null,
  },
];

const FIXTURE_COUNTS: SessionTaskChainCounts = {
  total: 6,
  filed: 0,
  ready: 0,
  inProgress: 2,
  landed: 3,
  built: 0,
  running: 1,
  blocked: 0,
  needsHuman: 0,
  superseded: 0,
  unknown: 0,
};

function reading(overrides: Partial<SessionTaskChainReading> = {}): SessionTaskChainReading {
  return {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    created: FIXTURE_TASKS.filter((task) => task.origin === 'created').map((task) => task.taskId),
    edited: FIXTURE_TASKS.filter((task) => task.origin === 'edited').map((task) => task.taskId),
    counts: FIXTURE_COUNTS,
    tasks: FIXTURE_TASKS,
    checkedAt: '2026-10-24T12:00:00.000Z',
    ...overrides,
  };
}

function renderBar(read: SessionTaskChainPort, pollIntervalMs = 60_000) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SessionTaskChain
        projectId={PROJECT_ID}
        sessionId={SESSION_ID}
        read={read}
        pollIntervalMs={pollIntervalMs}
      />
    </I18nextProvider>,
  );
}

afterEach(cleanup);

describe('SessionTaskChain', () => {
  it('renders the compact bar with the reading’s counts, and expands to every task’s stage', async () => {
    const read = vi.fn<SessionTaskChainPort>(async () => reading());
    renderBar(read);

    const bar = await screen.findByTestId('session-task-chain');
    expect(bar.getAttribute('data-total')).toBe('6');
    expect(bar.getAttribute('data-count-in-progress')).toBe('2');
    expect(bar.getAttribute('data-count-landed')).toBe('3');
    expect(bar.getAttribute('data-count-running')).toBe('1');
    expect(bar.getAttribute('data-count-blocked')).toBe('0');

    const summary = screen.getByTestId('session-task-chain-summary').textContent ?? '';
    expect(summary).toContain('6');
    expect(summary).toContain('2');
    expect(summary).toContain('3');
    expect(summary).toContain('1');

    // Collapsed by default: the per-task list is the click's payoff.
    expect(screen.queryByTestId('session-task-chain-entry')).toBeNull();
    fireEvent.click(screen.getByTestId('session-task-chain-toggle'));

    const entries = screen.getAllByTestId('session-task-chain-entry');
    expect(entries).toHaveLength(6);
    expect(entries.map((entry) => entry.getAttribute('data-stage'))).toEqual([
      'in-progress',
      'in-progress',
      'landed',
      'landed',
      'landed',
      'running',
    ]);

    // The read was asked once with this session's identity; the bar is not a second cache.
    expect(read).toHaveBeenCalledWith({ projectId: PROJECT_ID, sessionId: SESSION_ID });
  });

  it('renders nothing for a conversation that started no tasks', async () => {
    const read = vi.fn<SessionTaskChainPort>(async () =>
      reading({
        created: [],
        edited: [],
        tasks: [],
        counts: { ...FIXTURE_COUNTS, total: 0, inProgress: 0, landed: 0, running: 0 },
      }),
    );
    renderBar(read);

    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.queryByTestId('session-task-chain')).toBeNull();
  });

  it('raises one notice when a task goes 已合入 → 线上运行, and does not repeat it on later polls', async () => {
    const landedReading = reading();
    const liveTask: SessionTaskChainEntry = {
      ...FIXTURE_TASKS[2],
      stage: 'running',
    };
    const liveReading = reading({
      tasks: [FIXTURE_TASKS[0], FIXTURE_TASKS[1], liveTask, ...FIXTURE_TASKS.slice(3)],
      counts: { ...FIXTURE_COUNTS, landed: 2, running: 2 },
    });

    // Poll 1: the task is landed. Polls 2+: it is live (and stays live).
    const sequence = [landedReading, liveReading, liveReading, liveReading];
    let calls = 0;
    // A fresh object per poll: the component must not rely on reference identity to decide
    // whether a reading is new, and the announcement guard is the thing under test.
    const read = vi.fn<SessionTaskChainPort>(async () => ({
      ...sequence[Math.min(calls++, sequence.length - 1)],
    }));

    renderBar(read, 10);

    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    const notices = await screen.findAllByTestId('session-task-chain-notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent ?? '').toContain('t-gamma');

    // Keep polling through the same unchanged reading: the announcement is not repeated.
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(4));
    expect(screen.getAllByTestId('session-task-chain-notice')).toHaveLength(1);
  });

  it('shows the first line of a blocked task’s unlanded reason when expanded', async () => {
    const blocked: SessionTaskChainEntry = {
      taskId: 't-blocked',
      title: 'parked',
      status: 'todo',
      stage: 'blocked',
      origin: 'created',
      landCommit: null,
      blockedReason: 'step=suite: not ok - server/modules/x/tests/x.test.ts',
    };
    const read = vi.fn<SessionTaskChainPort>(async () =>
      reading({
        tasks: [blocked],
        created: ['t-blocked'],
        edited: [],
        counts: { ...FIXTURE_COUNTS, total: 1, inProgress: 0, landed: 0, running: 0, blocked: 1 },
      }),
    );
    renderBar(read);

    fireEvent.click(await screen.findByTestId('session-task-chain-toggle'));
    expect(screen.getByTestId('session-task-chain-blocked-reason').textContent ?? '').toContain(
      'step=suite: not ok',
    );
  });
});
