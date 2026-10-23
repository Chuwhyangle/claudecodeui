import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { act, render, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { QuaySnapshot } from '@/shared/types';
import QuayPanel, { buildQuayInFlightContract, IN_FLIGHT_STALE_AFTER_MS } from '@/modules/quay/QuayPanel';
import { type QuayPanelView, useQuayStatus } from '@/modules/quay/hooks/useQuayStatus';

// The panel's in-flight reading travels hook → route → carrier. Only the network
// hop is stubbed; the test below drives the real `useQuayStatus` so the reading
// is exercised all the way into `QuayPanel`, not just by a hand-built prop.
const apiMock = vi.hoisted(() => ({ quaySnapshot: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { quaySnapshot: apiMock.quaySnapshot } }));

// The selected Loop pulse window is persisted to the URL, so one case's `?quayWindow=` must not
// leak into the next hook mount (jsdom reuses one `window` across a file).
beforeEach(() => {
  window.history.replaceState({}, '', '/');
});

const DASHBOARD_URL = 'http://172.28.0.1:3651/';

const SNAPSHOT: QuaySnapshot = {
  projectId: 'project-1',
  projectPath: '/workspace/project-1',
  generatedAt: '2026-10-02T00:00:00.000Z',
  cached: false,
  driver: { state: 'running', alive: true, running: true, lastRecordAt: '2026-10-01T23:59:00.000Z' },
  tasks: {
    total: 4,
    byStatus: { ready: 2, done: 1, 'needs-human': 1 },
    ready: 2,
    needsHuman: 1,
    done: 1,
    recent: [
      { id: 'gap-task-a', title: 'Task A', status: 'ready', updatedAt: '2026-10-01T12:00:00.000Z' },
      { id: 'gap-task-b', title: 'Task B', status: 'done', updatedAt: '2026-09-30T08:30:00.000Z' },
    ],
  },
  goals: {
    total: 3,
    achieved: 1,
    breakdown: {
      byStatus: { achieved: 1, active: 2 },
      recent: [
        { id: 'GOAL-3', title: 'Third goal', status: 'active', updatedAt: '2026-09-29T10:00:00.000Z' },
        { id: 'GOAL-1', title: 'First goal', status: 'achieved', updatedAt: '2026-09-28T09:00:00.000Z' },
      ],
    },
  },
  adrs: { total: 3, recent: [{ id: 'ADR-001', title: 'First decision', status: 'accepted', updatedAt: '2026-09-27T07:00:00.000Z' }] },
  configIssues: { total: 0, errors: 0 },
  tests: {
    current: {
      state: 'green',
      runner: 'inner',
      scope: 'worktree',
      startedAt: '2026-10-01T23:00:00.000Z',
      finishedAt: 1790986890,
      durationMs: 196837,
      laneCount: 127,
      commit: '8ae18cf39e1ec22b62bc3312532340eefd8677d2',
      taskId: 'gap-x',
      runId: 'r1',
    },
    recentRounds: [
      { round: 469, startedAt: '2026-10-01T23:00:00.000Z', durationMs: 100000, pass: 310, fail: 0, tests: 310, state: 'green' },
      { round: 470, startedAt: '2026-10-01T23:10:00.000Z', durationMs: 195593, pass: 308, fail: 2, tests: 310, state: 'red' },
    ],
  },
  fanIn: {
    // Lock epochs in Unix seconds, inside the shared window (the snapshot's `generatedAt` minus
    // the default 3h), so the windowed Fan-in bar draws both attempts.
    recent: [
      { task: 'gap-task-a', outcome: 'landed', lockAcquireEpoch: 1790895600, lockReleaseEpoch: 1790895696 },
      { task: 'gap-task-b', outcome: 'failed', lockAcquireEpoch: 1790895900, lockReleaseEpoch: null },
    ],
  },
  // Read and empty: the carrier answered, nothing is running. The `null` case (carrier
  // unreadable) is asserted separately and must render differently.
  inFlight: [],
  dashboardUrl: DASHBOARD_URL,
  warnings: [],
};

const renderView = (view: QuayPanelView, dashboardUrl: string | null = null) =>
  render(<QuayPanel projectId="project-1" view={view} onRefresh={() => {}} dashboardUrl={dashboardUrl} />);

test('QuayPanel renders the not-configured state without any counts', () => {
  const { container, getByTestId } = renderView({ status: 'not-configured' });

  getByTestId('quay-panel-not-configured');
  assert.equal(container.querySelector('[data-testid="quay-panel-loaded"]'), null);
  assert.match(container.textContent ?? '', /not configured/i);
});

test('QuayPanel renders the loading state', () => {
  const { getByTestId, container } = renderView({ status: 'loading' });

  getByTestId('quay-panel-loading');
  assert.equal(container.querySelector('[data-testid="quay-panel-error"]'), null);
});

test('QuayPanel renders the error state with the message and a retry', () => {
  const { getByTestId, getByText } = renderView({ status: 'error', message: 'boom' });

  getByTestId('quay-panel-error');
  getByText('boom');
  getByText('Retry');
});

test('QuayPanel renders the loaded snapshot counts, driver reading and sync time', () => {
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: SNAPSHOT });

  getByTestId('quay-panel-loaded');
  // The read-only marker and the driver reading the panel header promises.
  assert.match(container.textContent ?? '', /read-only/i);
  assert.match(container.textContent ?? '', /Driver running/i);
  assert.match(container.textContent ?? '', /Last synced/i);
  // Counts come from the snapshot, not a placeholder: 4 tasks, 1 needs-human.
  assert.match(container.textContent ?? '', /needs human/i);
  assert.equal(getByTestId('quay-panel-driver-last-record').textContent?.includes('never'), false);
});

test('QuayPanel renders a clickable Dashboard link when the snapshot carries a dashboardUrl', () => {
  const { container } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, DASHBOARD_URL);

  const link = container.querySelector(`a[href="${DASHBOARD_URL}"]`);
  assert.ok(link, 'expected an anchor pointing at the dashboard URL');
  assert.equal(link?.textContent?.trim(), 'Dashboard');
  assert.equal(link?.getAttribute('target'), '_blank');
});

test('QuayPanel renders no Dashboard link when the panel is given no dashboardUrl', () => {
  const { container, getByTestId } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, null);

  getByTestId('quay-panel-loaded');
  assert.equal(container.querySelector('a'), null);
  assert.equal((container.textContent ?? '').includes('Dashboard'), false);
});

test('QuayPanel renders each recent task and ADR row with id, title and status', () => {
  const { getByTestId } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, null);

  const taskRows = getByTestId('quay-panel-recent-tasks').querySelectorAll('[data-testid="quay-panel-recent-tasks-row"]');
  assert.equal(taskRows.length, 2);
  assert.match(taskRows[0]?.textContent ?? '', /gap-task-a/);
  assert.match(taskRows[0]?.textContent ?? '', /Task A/);
  assert.match(taskRows[0]?.textContent ?? '', /ready/);

  const adrRows = getByTestId('quay-panel-recent-adrs').querySelectorAll('[data-testid="quay-panel-recent-adrs-row"]');
  assert.equal(adrRows.length, 1);
  assert.match(adrRows[0]?.textContent ?? '', /ADR-001/);
  assert.match(adrRows[0]?.textContent ?? '', /First decision/);
  assert.match(adrRows[0]?.textContent ?? '', /accepted/);
});

/**
 * The reading this test is the permanent record of (2026-10-04): "Recent tasks" and "Stage
 * goals" are both ranked by `updatedAt` descending, and neither row showed it, so the list was
 * ordered by a field the reader could not see. Each row now carries its own reading twice: as
 * visible text in the reader's locale, and verbatim in `data-updated-at`, so a criterion can
 * compare it against the store without knowing the locale or timezone of the render.
 *
 * A `null` reading is the projection's answer for "the CLI reported no usable timestamp". It
 * renders the em-dash placeholder `formatDuration` already uses — not blank, not `never` (a
 * real "nothing recorded yet" reading) and not `Invalid Date`.
 */
test('QuayPanel stamps every Recent tasks and Stage goals row with its own last-updated reading', () => {
  const updatedAt = { task: '2026-10-01T12:34:56.000Z', goal: '2026-09-30T01:02:03.000Z' };
  const stamped: QuaySnapshot = {
    ...SNAPSHOT,
    tasks: {
      total: 2,
      byStatus: { ready: 1, todo: 1 },
      ready: 1,
      needsHuman: 0,
      done: 0,
      recent: [
        { id: 'gap-task-stamped', title: 'Stamped task', status: 'ready', updatedAt: updatedAt.task },
        { id: 'gap-task-unstamped', title: 'Unstamped task', status: 'todo', updatedAt: null },
      ],
    },
    goals: {
      total: 2,
      achieved: 1,
      breakdown: {
        byStatus: { achieved: 1, draft: 1 },
        recent: [
          { id: 'GOAL-STAMPED', title: 'Stamped goal', status: 'achieved', updatedAt: updatedAt.goal },
          { id: 'GOAL-UNSTAMPED', title: 'Unstamped goal', status: 'draft', updatedAt: null },
        ],
      },
    },
  };

  const { getByTestId } = renderView({ status: 'loaded', snapshot: stamped }, null);
  const rowsOf = (testId: string) => getByTestId(testId).querySelectorAll(`[data-testid="${testId}-row"]`);

  const taskRows = rowsOf('quay-panel-recent-tasks');
  assert.equal(taskRows.length, 2);
  // The attribute is the snapshot's ISO value verbatim, so a criterion can compare it with the
  // store's own reading without knowing how the row rendered it.
  assert.equal(taskRows[0].getAttribute('data-updated-at'), updatedAt.task);
  // The visible text is that same value formatted for the reader.
  assert.ok(
    (taskRows[0].textContent ?? '').includes(new Date(updatedAt.task).toLocaleString()),
    `the task row must render the formatted time; it read ${JSON.stringify(taskRows[0].textContent)}`,
  );
  // A null reading carries no attribute — there is no ISO value to state — and shows the
  // placeholder rather than a blank, `never` or `Invalid Date`.
  assert.equal(taskRows[1].getAttribute('data-updated-at'), null);
  assert.match(taskRows[1].textContent ?? '', /—/);
  assert.equal((taskRows[1].textContent ?? '').includes('never'), false);
  assert.equal((taskRows[1].textContent ?? '').includes('Invalid Date'), false);

  const goalRows = rowsOf('quay-panel-stage-goals');
  assert.equal(goalRows.length, 2);
  assert.equal(goalRows[0].getAttribute('data-updated-at'), updatedAt.goal);
  assert.ok(
    (goalRows[0].textContent ?? '').includes(new Date(updatedAt.goal).toLocaleString()),
    `the goal row must render the formatted time; it read ${JSON.stringify(goalRows[0].textContent)}`,
  );
  assert.equal(goalRows[1].getAttribute('data-updated-at'), null);
  assert.match(goalRows[1].textContent ?? '', /—/);
  assert.equal((goalRows[1].textContent ?? '').includes('never'), false);
  assert.equal((goalRows[1].textContent ?? '').includes('Invalid Date'), false);
});

test('QuayPanel renders an empty state for each detail list when the recents are empty', () => {
  const emptySnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    tasks: { total: 0, byStatus: {}, ready: 0, needsHuman: 0, done: 0, recent: [] },
    adrs: { total: 0, recent: [] },
  };
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: emptySnapshot }, null);

  assert.match(getByTestId('quay-panel-recent-tasks-empty').textContent ?? '', /No tasks reported/);
  assert.match(getByTestId('quay-panel-recent-adrs-empty').textContent ?? '', /No ADRs reported/);
  assert.equal(container.querySelector('[data-testid="quay-panel-recent-tasks-row"]'), null);
  assert.equal(container.querySelector('[data-testid="quay-panel-recent-adrs-row"]'), null);
});

/**
 * The reading that produced this test (2026-10-04, project `quay`): `quay task list
 * --json` printed ~26 MB — every task's whole body — which overflowed the backend's
 * 8 MiB output cap. `execFile` killed the CLI mid-string, `JSON.parse` failed on the
 * torn tail, the service degraded the section to `null`, and the panel rendered the
 * failure as "0 tasks · 0 ready · 0 needs human · 0 done" plus "No tasks reported."
 * — a reading indistinguishable from a genuinely empty board.
 */
test('QuayPanel renders a section whose command did not answer as unavailable, never as zero', () => {
  const degradedSnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    driver: null,
    tasks: null,
    goals: null,
    adrs: null,
    configIssues: null,
    warnings: ['task list --json: stdout maxBuffer length exceeded'],
  };
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: degradedSnapshot }, null);
  const text = container.textContent ?? '';

  // The Task ledger says it does not know, instead of claiming an empty board.
  assert.match(getByTestId('quay-panel-task-ledger-unavailable').textContent ?? '', /unavailable/i);
  assert.equal(container.querySelector('[data-testid="quay-panel-task-ledger-counts"]'), null);
  assert.equal(text.includes('0 tasks'), false);
  assert.equal(text.includes('0 ready'), false);
  assert.equal(container.querySelector('[data-testid="quay-panel-recent-tasks-empty"]'), null);

  assert.match(getByTestId('quay-panel-stage-goals-unavailable').textContent ?? '', /unavailable/i);
  assert.equal(container.querySelector('[data-testid="quay-panel-stage-goals-empty"]'), null);
  assert.match(getByTestId('quay-panel-recent-adrs-unavailable').textContent ?? '', /unavailable/i);
  assert.equal(container.querySelector('[data-testid="quay-panel-recent-adrs-empty"]'), null);
  assert.equal(getByTestId('quay-panel-config-issues').textContent, 'unavailable');

  // The driver reading: the panel only exists for a project that HAS a
  // `.quay/config.yml`, so a failed `driver status` read must not be reported as
  // that project being unconfigured.
  assert.match(getByTestId('quay-panel-loaded').textContent ?? '', /Driver status unavailable/i);
  assert.equal(text.includes('Not configured'), false);
  assert.equal(getByTestId('quay-panel-driver-last-record').textContent, 'unavailable');

  // The warning banner still names the command that failed.
  assert.match(getByTestId('quay-panel-warnings').textContent ?? '', /maxBuffer/);
});

test('QuayPanel renders the Stage goals, Tests and Fan-in cards with the snapshot data', () => {
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, null);

  // Stage goals: one row per recent goal, each carrying the status and a progress bar.
  const goalRows = getByTestId('quay-panel-stage-goals-list').querySelectorAll('[data-testid="quay-panel-stage-goals-row"]');
  assert.equal(goalRows.length, 2);
  assert.match(goalRows[0]?.textContent ?? '', /GOAL-3/);
  assert.match(getByTestId('quay-panel-stage-goals-counts').textContent ?? '', /active/);
  const goalBars = getByTestId('quay-panel-stage-goals-list').querySelectorAll('[data-testid="quay-panel-stage-goals-bar"]');
  assert.equal(goalBars.length, 2);
  assert.ok(Array.from(goalBars).every((bar) => bar.querySelector('div') !== null));

  // Tests: the current reading plus one timeline rect per recent round.
  assert.match(getByTestId('quay-panel-tests-current').textContent ?? '', /green/);
  assert.equal(
    getByTestId('quay-panel-tests-timeline').querySelectorAll('[data-testid="quay-panel-tests-timeline-rect"]').length,
    2,
  );

  // Fan-in: one rect per attempt that carries a lock epoch, plus the recent task rows.
  assert.equal(
    getByTestId('quay-panel-fanin-timeline').querySelectorAll('[data-testid="quay-panel-fanin-timeline-rect"]').length,
    2,
  );
  const fanInRows = getByTestId('quay-panel-fanin-list').querySelectorAll('[data-testid="quay-panel-fanin-row"]');
  assert.equal(fanInRows.length, 2);
  assert.match(fanInRows[0]?.textContent ?? '', /gap-task-b/);
  assert.match(container.textContent ?? '', /landed/);
});

test('QuayPanel renders empty states for the Stage goals, Tests and Fan-in cards', () => {
  const emptySnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    goals: { total: 0, achieved: 0, breakdown: { byStatus: {}, recent: [] } },
    tests: { current: null, recentRounds: [] },
    fanIn: { recent: [] },
  };
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: emptySnapshot }, null);

  assert.match(getByTestId('quay-panel-stage-goals-empty').textContent ?? '', /No goals reported/);
  assert.match(getByTestId('quay-panel-tests-current-empty').textContent ?? '', /No suite running/);
  assert.match(getByTestId('quay-panel-tests-timeline-empty').textContent ?? '', /No suite rounds/);
  assert.match(getByTestId('quay-panel-fanin-timeline-empty').textContent ?? '', /No fan-in attempts/);
  assert.equal(container.querySelector('[data-testid="quay-panel-stage-goals-row"]'), null);
  assert.equal(container.querySelector('[data-testid="quay-panel-fanin-row"]'), null);
});

/*
 * In-flight card (gap-quay-panel-inflight-task-display): before this card the panel's only
 * "activity" signals were the Driver badge (which names no task) and the Tests card's
 * `current.taskId` (which names the last *finished* suite). The backend already put the real
 * running tasks in the snapshot's `inFlight` field; the panel simply never rendered them.
 * The corresponding red baseline (the ticket's AC1) showed `screen.queryByText(/gap-example-task/)`
 * was `null` against the same fixture before this card existed.
 */
test('QuayPanel renders each in-flight task with its own phase marker and elapsed time', () => {
  const inFlightSnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    inFlight: [
      {
        taskId: 'gap-example-task',
        phase: 'implementing',
        startedAt: '2026-10-01T23:50:00.000Z',
        lastHeartbeat: '2026-10-02T00:00:00.000Z',
        workerPid: 4242,
      },
      {
        taskId: 'gap-example-fanin',
        phase: 'fan-in',
        startedAt: '2026-10-01T23:40:00.000Z',
        lastHeartbeat: '2026-10-02T00:00:00.000Z',
        workerPid: 4242,
      },
    ],
  };
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: inFlightSnapshot }, null);

  // The task id is now visible on the panel — the whole point of the card.
  assert.match(container.textContent ?? '', /gap-example-task/);

  const rows = getByTestId('quay-panel-inflight-list').querySelectorAll('[data-testid="quay-panel-inflight-row"]');
  assert.equal(rows.length, 2);

  // The two phases render *distinct* markers — text and `data-testid` both differ, so a
  // single shared label cannot pass this.
  const implementing = getByTestId('quay-panel-inflight-phase-implementing');
  const fanIn = getByTestId('quay-panel-inflight-phase-fan-in');
  assert.equal(implementing.textContent, 'implementing');
  assert.equal(fanIn.textContent, 'fan-in');
  assert.notEqual(implementing.textContent, fanIn.textContent);

  // Elapsed time runs from `startedAt` to the snapshot's own `generatedAt`
  // (2026-10-02T00:00:00Z): 10 minutes and 20 minutes.
  assert.equal(rows[0].querySelector('[data-testid="quay-panel-inflight-elapsed"]')?.textContent, '10m 0s');
  assert.equal(rows[1].querySelector('[data-testid="quay-panel-inflight-elapsed"]')?.textContent, '20m 0s');
});

test('QuayPanel distinguishes an unread in-flight carrier (null) from an empty one ([])', () => {
  const unavailable = renderView({ status: 'loaded', snapshot: { ...SNAPSHOT, inFlight: null } }, null);
  const unavailableText = unavailable.getByTestId('quay-panel-inflight-unavailable').textContent ?? '';
  assert.match(unavailableText, /unavailable/i);
  assert.equal(unavailable.container.querySelector('[data-testid="quay-panel-inflight-empty"]'), null);
  assert.equal(unavailable.container.querySelector('[data-testid="quay-panel-inflight-list"]'), null);

  const empty = renderView({ status: 'loaded', snapshot: { ...SNAPSHOT, inFlight: [] } }, null);
  const emptyText = empty.getByTestId('quay-panel-inflight-empty').textContent ?? '';
  assert.match(emptyText, /No tasks currently in flight/i);
  assert.equal(empty.container.querySelector('[data-testid="quay-panel-inflight-unavailable"]'), null);
  assert.equal(empty.container.querySelector('[data-testid="quay-panel-inflight-list"]'), null);

  // The two readings must be literally different: "carrier unreadable" is not
  // "nothing is running".
  assert.notEqual(unavailableText, emptyText);
});

test('TestsCard labels its current taskId as the last suite, not a live task pointer', () => {
  const { getByTestId } = renderView({ status: 'loaded', snapshot: SNAPSHOT }, null);

  // SNAPSHOT.tests.current.taskId is 'gap-x'; the id must not appear bare.
  const holder = getByTestId('quay-panel-tests-current-task');
  assert.match(holder.textContent ?? '', /gap-x/);
  const label = getByTestId('quay-panel-tests-current-task-label');
  assert.match(label.textContent ?? '', /last suite/i);
});

test('the in-flight reading reaches QuayPanel through the real useQuayStatus hook', async () => {
  const hookSnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    inFlight: [
      {
        taskId: 'gap-hook-task',
        phase: 'fan-in',
        startedAt: '2026-10-01T23:30:00.000Z',
        lastHeartbeat: '2026-10-02T00:00:00.000Z',
        workerPid: 99,
      },
    ],
  };
  apiMock.quaySnapshot.mockResolvedValue({ ok: true, json: async () => hookSnapshot });

  const { result } = renderHook(() => useQuayStatus('project-1', true, true));
  await waitFor(() => assert.equal(result.current.view.status, 'loaded'));

  const view = result.current.view;
  if (view.status !== 'loaded') {
    throw new Error(`expected a loaded view, got ${view.status}`);
  }

  const { container } = render(
    <QuayPanel projectId="project-1" view={view} onRefresh={() => {}} dashboardUrl={null} />,
  );
  assert.match(container.textContent ?? '', /gap-hook-task/);
});

/*
 * AC3 (gap-quay-tab-inflight-card-and-gantt-two-sources): every in-flight row must show its own
 * last heartbeat, and a row whose heartbeat has gone stale (older than the worker's own round
 * interval, measured against the snapshot's `generatedAt`) must be flagged — so a wedged worker
 * reads as stale rather than as a task that is merely still running.
 */
test('every in-flight row renders its last heartbeat in readable form', () => {
  const heartbeatA = '2026-10-01T23:57:00.000Z';
  const heartbeatB = '2026-10-01T23:58:00.000Z';
  const inFlightSnapshot: QuaySnapshot = {
    ...SNAPSHOT,
    inFlight: [
      { taskId: 'gap-heartbeat-a', phase: 'implementing', startedAt: '2026-10-01T23:50:00.000Z', lastHeartbeat: heartbeatA, workerPid: 1 },
      { taskId: 'gap-heartbeat-b', phase: 'fan-in', startedAt: '2026-10-01T23:40:00.000Z', lastHeartbeat: heartbeatB, workerPid: 1 },
    ],
  };
  const { getAllByTestId } = renderView({ status: 'loaded', snapshot: inFlightSnapshot }, null);

  const heartbeats = getAllByTestId('quay-panel-inflight-heartbeat');
  assert.equal(heartbeats.length, 2, 'every in-flight row must carry a heartbeat reading');
  // The text is the ISO instant's readable form (the panel's own formatting), and the
  // machine-readable ISO rides along in `data-heartbeat`.
  assert.ok((heartbeats[0].textContent ?? '').includes(new Date(heartbeatA).toLocaleString()));
  assert.ok((heartbeats[1].textContent ?? '').includes(new Date(heartbeatB).toLocaleString()));
  assert.equal(heartbeats[0].getAttribute('data-heartbeat'), heartbeatA);
  assert.equal(heartbeats[1].getAttribute('data-heartbeat'), heartbeatB);
});

test('an in-flight row older than the round interval is flagged stale, and one within it is not', () => {
  const generatedAtMs = Date.parse(SNAPSHOT.generatedAt);
  // Both sides are pinned against the SAME named constant the card reads: a heartbeat exactly
  // one round interval old is still "within"; one millisecond past it is "stale".
  const fresh = new Date(generatedAtMs - IN_FLIGHT_STALE_AFTER_MS).toISOString();
  const stale = new Date(generatedAtMs - IN_FLIGHT_STALE_AFTER_MS - 1).toISOString();

  const freshView = renderView({
    status: 'loaded',
    snapshot: {
      ...SNAPSHOT,
      inFlight: [{ taskId: 'gap-fresh', phase: 'implementing', startedAt: fresh, lastHeartbeat: fresh, workerPid: 1 }],
    },
  }, null);
  assert.equal(
    freshView.queryByTestId('quay-panel-inflight-stale'),
    null,
    'a heartbeat within the round interval must not be flagged stale',
  );

  const staleView = renderView({
    status: 'loaded',
    snapshot: {
      ...SNAPSHOT,
      inFlight: [{ taskId: 'gap-stale', phase: 'implementing', startedAt: stale, lastHeartbeat: stale, workerPid: 1 }],
    },
  }, null);
  // 取假: removing the staleness check leaves this row unmarked and this query throws.
  assert.match(staleView.getByTestId('quay-panel-inflight-stale').textContent ?? '', /stale/i);
});

/**
 * Every `md:grid-cols-2` grid on the panel must also declare a base column count.
 *
 * Without `grid-cols-1` Tailwind emits no `grid-template-columns` below `md`, and an
 * implicit grid track has no `minmax(0, 1fr)` floor: its min width falls back to the
 * content's min-content width. A row title is `truncate`d (`white-space: nowrap`), so
 * its min-content width is the whole unbroken line — and on a 390px phone the track is
 * stretched to that width, the grid overflows its `overflow-hidden` ancestor, and the
 * text is clipped instead of ellipsised.
 *
 * This is a source-level assertion because jsdom does not compute real CSS grid track
 * sizes, so a rendered reading here cannot see the defect at all. The real-browser
 * reading lives in `e2e/zz-quay-panel-mobile-grid.spec.ts`; this one exists so that a
 * future edit cannot silently drop the base column count again.
 */
test('QuayPanel’s responsive grids declare a base column count so they cannot blow out below `md`', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/quay/QuayPanel.tsx'), 'utf8');
  const gridClassNames = source.match(/className="[^"]*\bgrid\b[^"]*"/g) ?? [];
  const responsive = gridClassNames.filter((className) => className.includes('md:grid-cols-2'));

  assert.equal(
    responsive.length,
    1,
    `expected the panel's single \`md:grid-cols-2\` grid (the Task ledger/Stage goals/Tests/Fan-in grid); found ${JSON.stringify(gridClassNames)}`,
  );
  for (const className of responsive) {
    const tokens = className.split(/[\s"]+/);
    assert.ok(
      tokens.includes('grid-cols-1'),
      `a \`md:grid-cols-2\` grid is missing its base column count (grid-cols-1): ${className}`,
    );
  }
});

/**
 * `DetailList`'s id span (used by "Recent tasks" and "ADRs") must be able to shrink and
 * ellipsise, and the row's own id must stay reachable in full even when it visually truncates.
 *
 * The id used here (71 characters) is a real task slug measured in this repository's own `.quay`
 * store (`gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence`), not a
 * synthetic worst case — quay task ids routinely run this long. Before this fix the span carried
 * `shrink-0` with no `truncate`/`min-w-0`: flexbox never shrinks a `shrink-0` item, so on a
 * 375px phone viewport this id alone measured ~470px (font-mono at its own min-content width),
 * pushing `quay-panel-loaded`'s `scrollWidth` to 633px against a 375px `clientWidth` — a real,
 * DOM-measured overflow distinct from the grid-track blowout the guard above already pins (that
 * one was fixed by `grid-cols-1` and is reproduced only by a long *title*; this one needs a long
 * *id*, which the existing `e2e/zz-quay-panel-mobile-grid.spec.ts` fixture never exercised).
 *
 * jsdom does not compute real flex/text layout, so this test only pins the two things that make
 * truncation possible at all (`truncate` so the overflow is ellipsised, `min-w-0` so the flex
 * item can shrink below its content width) and that accessibility is preserved — the full id is
 * never dropped from the DOM text or the `title` attribute, only visually shortened by CSS.
 * The geometric reading that the row actually stays inside the viewport lives in the e2e spec.
 */
test('DetailList’s id span can shrink and ellipsise instead of forcing the row to overflow, and keeps the full id reachable', () => {
  const longId = 'gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence';
  const withLongId: QuaySnapshot = {
    ...SNAPSHOT,
    tasks: {
      total: 1,
      byStatus: { ready: 1 },
      ready: 1,
      needsHuman: 0,
      done: 0,
      recent: [{ id: longId, title: 'A task with a long id', status: 'ready', updatedAt: null }],
    },
  };

  const { getByTestId } = renderView({ status: 'loaded', snapshot: withLongId }, null);
  const row = getByTestId('quay-panel-recent-tasks-row');
  const idSpan = row.querySelector('span');
  if (!idSpan) {
    throw new Error('the recent-tasks row rendered no id span');
  }

  // Truncation requires both: `truncate` to ellipsise, `min-w-0` to let the flex item shrink
  // below its own content width (a `truncate` item with the default `min-width: auto` still
  // forces its container to its full min-content width in a flex row).
  const tokens = (idSpan.className ?? '').split(/\s+/);
  assert.ok(tokens.includes('truncate'), `the id span must be able to ellipsise: ${idSpan.className}`);
  assert.ok(tokens.includes('min-w-0'), `the id span must be able to shrink below its content width: ${idSpan.className}`);
  assert.ok(
    !tokens.includes('shrink-0'),
    `the id span must not refuse to shrink (shrink-0 is the reported defect): ${idSpan.className}`,
  );

  // Accessibility: CSS truncation never removes the value from the DOM, and the full id is also
  // reachable via a native tooltip — a reader (sighted hover, assistive tech reading the title
  // attribute, or a test/automation querying either) can always get the untruncated id.
  assert.equal(idSpan.getAttribute('title'), longId);
  assert.equal(idSpan.textContent, longId);
});

/**
 * The Loop pulse card is the panel's window onto quay's own packed gantt lanes.
 *
 * The panel's job is narrow and these two cases pin exactly that: hand the snapshot's lane
 * payload to the card, and render an explicit unavailable line when there is no reading.
 * The distinction matters because the backend does not produce this reading yet — an
 * absent lane set means "not reported", and the card must not render it as an empty chart,
 * which would read as "nothing ran".
 */
test('QuayPanel hands the snapshot’s packed lanes to the Loop pulse card', () => {
  const nowMs = Date.UTC(2026, 9, 20, 12, 0, 0);
  const withGantt: QuaySnapshot = {
    ...SNAPSHOT,
    gantt: {
      windowHours: 3,
      nowMs,
      overflow: 2,
      lanes: [
        [
          {
            taskId: 'gap-gantt-task',
            runId: 'worker-gap-gantt-task',
            startMs: nowMs - 1800_000,
            endMs: nowMs,
            phase: 'implementing',
            finalState: null,
            fanInOutcome: null,
          },
        ],
      ],
    },
  };

  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: withGantt }, null);

  assert.equal(getByTestId('quay-panel-loop-pulse').querySelector('h3')?.textContent, 'Loop pulse');
  assert.match(container.textContent ?? '', /gap-gantt-task/);
  assert.equal(getByTestId('quay-gantt-overflow').textContent, '+2 more');
  assert.equal(container.querySelector('[data-testid="quay-panel-loop-pulse-unavailable"]'), null);
});

test('QuayPanel renders the Loop pulse card as unavailable — never as an empty chart — when no lanes were reported', () => {
  const { getByTestId, container } = renderView({ status: 'loaded', snapshot: { ...SNAPSHOT, gantt: null } }, null);

  assert.match(getByTestId('quay-panel-loop-pulse-unavailable').textContent ?? '', /unavailable/);
  // No chart at all: an empty svg would read as "nothing ran", which is a different reading
  // from "this backend did not report a lane set".
  assert.equal(container.querySelector('[data-testid="quay-gantt"]'), null);
});

/* ── the window is one card's data filter, not a reason to blank the panel ────── */

/**
 * The defect this task exists for (2026-10-11, real backend + browser): switching the Loop
 * pulse window ran `load()`, whose only path was `setFetchedView({status:'loading'})`. The
 * window selector lives inside the loaded panel, so it unmounted with it — 250 ms after the
 * click the buttons were gone, a second click landed on nothing, and because a non-default
 * window ran a full cold pass (six quay CLI spawns) the panel stayed blank for 3–4 s on a
 * large store. The window re-reads one card's data; the panel and its selector must stay up.
 */
test('a window change re-reads in place — the panel and its selector stay mounted and clickable', async () => {
  const ganttFor = (windowHours: number): QuaySnapshot => ({
    ...SNAPSHOT,
    gantt: {
      windowHours,
      nowMs: Date.UTC(2026, 9, 20, 12, 0, 0),
      overflow: 0,
      lanes: [[{
        taskId: `run-${windowHours}h`,
        runId: 'worker-run',
        startMs: Date.UTC(2026, 9, 20, 11, 0, 0),
        endMs: Date.UTC(2026, 9, 20, 12, 0, 0),
        phase: 'implementing',
        finalState: null,
        fanInOutcome: null,
      }]],
    },
  });

  // Every fetch hangs until the test resolves it, so the "during the read" window is a fact the
  // test can observe rather than a race against an already-resolved promise.
  const pending: Array<{ hours?: number; resolve: (snapshot: QuaySnapshot) => void }> = [];
  apiMock.quaySnapshot.mockImplementation((_projectId: string, opts?: { hours?: number }) =>
    new Promise((resolve) => {
      pending.push({ hours: opts?.hours, resolve: (snapshot) => resolve({ ok: true, json: async () => snapshot }) });
    }),
  );

  // The host wires the real hook to the panel and records every requested window.
  const requested: number[] = [];
  const Harness = () => {
    const { view, refresh, windowHours, setWindowHours, ganttRefreshing } = useQuayStatus('project-1', true, true);
    return (
      <QuayPanel
        projectId="project-1"
        view={view}
        onRefresh={refresh}
        dashboardUrl={null}
        windowHours={windowHours}
        onWindowChange={(hours) => {
          requested.push(hours);
          setWindowHours(hours);
        }}
        ganttRefreshing={ganttRefreshing}
      />
    );
  };

  const { container, getByTestId } = render(<Harness />);

  // Initial load at the default window.
  await waitFor(() => assert.equal(pending.length, 1));
  assert.equal(pending[0].hours, 3);
  await act(async () => pending[0].resolve(ganttFor(3)));
  await waitFor(() => assert.ok(container.querySelector('[data-testid="quay-panel-loaded"]')));
  assert.ok(getByTestId('quay-gantt-windows'), 'the selector is present once loaded');

  // Change the window; the re-read hangs.
  (getByTestId('quay-gantt-window-12') as HTMLButtonElement).click();
  await waitFor(() => assert.equal(pending.length, 2));
  assert.equal(pending[1].hours, 12, 'the re-read must ask for the newly selected window');

  // DURING the read: the panel is still loaded (not swapped for the loading branch) and the
  // selector is still mounted, with the card showing its own local busy marker. This is the
  // assertion the old `setFetchedView({status:'loading'})` window path fails.
  assert.ok(container.querySelector('[data-testid="quay-panel-loaded"]'), 'the loaded panel must stay mounted');
  assert.equal(container.querySelector('[data-testid="quay-panel-loading"]'), null);
  assert.ok(getByTestId('quay-gantt-windows'), 'the selector must survive the read it triggered');
  await waitFor(() => getByTestId('quay-gantt-refreshing'));

  // A second click during the read is received — the button was never removed.
  (getByTestId('quay-gantt-window-1') as HTMLButtonElement).click();
  await waitFor(() => assert.deepEqual(requested, [12, 1]));

  // Let both reads settle: the newer one wins and the stale 12h reply cannot overwrite it.
  await waitFor(() => assert.equal(pending.length, 3));
  assert.equal(pending[2].hours, 1);
  await act(async () => {
    pending[1].resolve(ganttFor(12));
    pending[2].resolve(ganttFor(1));
  });
  await waitFor(() => assert.equal(getByTestId('quay-gantt-window-1').getAttribute('aria-pressed'), 'true'));
  assert.equal(container.querySelector('[data-testid="quay-panel-loading"]'), null);
  assert.equal(container.querySelector('[data-testid="quay-gantt-refreshing"]'), null, 'the busy marker clears once settled');
});

test('QuayPanel keeps the Loop pulse selector, disabled and with a reason, when no lanes were reported', () => {
  // The selector owns the window whose read produced this (missing) reading, so it stays put —
  // inert, and pointing at the reason — instead of disappearing along with the chart.
  const requested: number[] = [];
  const { getByTestId, container } = render(
    <QuayPanel
      projectId="project-1"
      view={{ status: 'loaded', snapshot: { ...SNAPSHOT, gantt: null } }}
      onRefresh={() => {}}
      dashboardUrl={null}
      windowHours={6}
      onWindowChange={(hours) => requested.push(hours)}
    />,
  );

  assert.ok(getByTestId('quay-gantt-windows'), 'the selector must be present even without a lane reading');
  assert.match(getByTestId('quay-gantt-unavailable-reason').textContent ?? '', /unavailable/i);
  assert.equal(container.querySelector('[data-testid="quay-gantt-empty"]'), null);

  for (const hours of [1, 3, 6, 12]) {
    assert.equal((getByTestId(`quay-gantt-window-${hours}`) as HTMLButtonElement).disabled, true, `${hours}h must be disabled`);
  }
  (getByTestId('quay-gantt-window-12') as HTMLButtonElement).click();
  assert.deepEqual(requested, [], 'a disabled selector must not report a window change');

  // The plain unavailable line (no selector) is the reading WITHOUT a host that can honour a
  // window change — it must not be what this case falls back to.
  assert.equal(container.querySelector('[data-testid="quay-panel-loop-pulse-unavailable"]'), null);
});

test('QuayPanel states the snapshot’s own unavailable reason, and the two reasons differ', () => {
  // The panel must not flatten "no `lanes` verb" and "the lanes read failed" into one line:
  // it renders whichever reason the snapshot carried.
  const reasonFor = (ganttUnavailable: 'plugin-lacks-lanes-verb' | 'lanes-read-failed') => {
    const { container } = render(
      <QuayPanel
        projectId="project-1"
        view={{ status: 'loaded', snapshot: { ...SNAPSHOT, gantt: null, ganttUnavailable } }}
        onRefresh={() => {}}
        dashboardUrl={null}
        windowHours={3}
        onWindowChange={() => {}}
      />,
    );
    return container.querySelector('[data-testid="quay-gantt-unavailable-reason"]')?.textContent ?? '';
  };

  const upgrade = reasonFor('plugin-lacks-lanes-verb');
  const retry = reasonFor('lanes-read-failed');
  assert.ok(upgrade.length > 0 && retry.length > 0, 'each reason must say something');
  assert.match(upgrade, /lanes/i);
  assert.match(retry, /lanes/i);
  assert.notEqual(upgrade, retry, 'an un-upgraded plugin and a failed read must not share one sentence');
});

test('the Loop pulse window is persisted to the URL, restored on mount, and a non-offered value falls back', async () => {
  apiMock.quaySnapshot.mockResolvedValue({ ok: true, json: async () => SNAPSHOT });

  const first = renderHook(() => useQuayStatus('project-1', true, true));
  await waitFor(() => assert.equal(first.result.current.view.status, 'loaded'));
  assert.equal(first.result.current.windowHours, 3, 'the default window is the starting point');

  await act(async () => first.result.current.setWindowHours(12));
  assert.equal(new URLSearchParams(window.location.search).get('quayWindow'), '12', 'the choice is written to the URL');
  first.unmount();

  // A fresh mount is what a page reload does: it reads the window back from the URL.
  const second = renderHook(() => useQuayStatus('project-1', true, true));
  assert.equal(second.result.current.windowHours, 12, 'a reload must restore the selected window');
  second.unmount();

  // A value outside the offered set is not honoured — it falls back to the default rather than
  // driving a read the card has no button for.
  window.history.replaceState({}, '', '/?quayWindow=5');
  const third = renderHook(() => useQuayStatus('project-1', true, true));
  assert.equal(third.result.current.windowHours, 3);
});

/* ── the three charts share one time axis (gap-quay-tab-three-timelines-share-no-time-axis) ─────
 *
 * Before this task Loop pulse, Tests and Fan-in each picked their own horizontal window: the gantt
 * from its `windowHours`/`nowMs`, the two bars from `min(start)…max(end)` of their own records. On
 * the same snapshot their endpoints differed by hours and the Tests/Fan-in bars had no axis at all,
 * so a reader could not line one chart up against another. These cases pin the shared-window
 * contract: one window from the snapshot's gantt, the same endpoints on all three charts, and
 * records outside it clipped away.
 */

const HOUR_MS = 3_600_000;
/** A fixed `now` for the shared-window cases: 2026-10-20T12:00:00Z. */
const WINDOW_NOW_MS = Date.UTC(2026, 9, 20, 12, 0, 0);
const SHARED_WINDOW_HOURS = 3;

/**
 * A snapshot whose gantt carries a known window (`SHARED_WINDOW_HOURS` ending at `WINDOW_NOW_MS`)
 * and whose Tests/Fan-in records sit inside it — the setup every shared-window case needs, so the
 * three charts all have something to draw over the *same* span.
 */
const inWindowSnapshot = (overrides: Partial<QuaySnapshot> = {}): QuaySnapshot => ({
  ...SNAPSHOT,
  gantt: {
    windowHours: SHARED_WINDOW_HOURS,
    nowMs: WINDOW_NOW_MS,
    overflow: 0,
    lanes: [
      [
        {
          taskId: 'run-shared',
          runId: 'worker-run-shared',
          startMs: WINDOW_NOW_MS - HOUR_MS,
          endMs: WINDOW_NOW_MS,
          phase: 'implementing',
          finalState: null,
          fanInOutcome: null,
        },
      ],
    ],
  },
  tests: {
    current: SNAPSHOT.tests.current,
    recentRounds: [
      { round: 1, startedAt: new Date(WINDOW_NOW_MS - 2 * HOUR_MS).toISOString(), durationMs: 60000, pass: 1, fail: 0, tests: 1, state: 'green' },
      { round: 2, startedAt: new Date(WINDOW_NOW_MS - HOUR_MS).toISOString(), durationMs: 120000, pass: 1, fail: 0, tests: 1, state: 'green' },
    ],
  },
  fanIn: {
    recent: [
      {
        task: 'gap-in-a',
        outcome: 'landed',
        lockAcquireEpoch: Math.floor((WINDOW_NOW_MS - 2 * HOUR_MS) / 1000),
        lockReleaseEpoch: Math.floor((WINDOW_NOW_MS - 2 * HOUR_MS + 60000) / 1000),
      },
    ],
  },
  ...overrides,
});

/*
 * AC2: the three charts expose the same window endpoints. The gantt prints its axis clocks as SVG
 * text; the two bars print theirs under `-axis-start` / `-axis-end`. Same snapshot, same window —
 * every reading must be identical. 取假: putting Tests/Fan-in back on a window adapted to their own
 * records makes their labels differ from the gantt's, and this case goes red.
 */
test('the three Quay charts are cut to one shared window: their endpoints read identically', () => {
  const { container, getByTestId } = renderView({ status: 'loaded', snapshot: inWindowSnapshot() }, null);

  const ganttClocks = Array.from(container.querySelectorAll('[data-testid="quay-gantt-svg"] text'))
    .map((text) => text.textContent ?? '')
    .filter((text) => /\d{1,2}:\d{2}/.test(text));
  assert.equal(ganttClocks.length, 2, `the gantt must print exactly a start and an end clock, got ${JSON.stringify(ganttClocks)}`);
  const [ganttStart, ganttEnd] = ganttClocks;

  for (const base of ['quay-panel-tests-timeline', 'quay-panel-fanin-timeline']) {
    assert.equal(getByTestId(`${base}-axis-start`).textContent, ganttStart, `${base} start must equal the gantt's`);
    assert.equal(getByTestId(`${base}-axis-end`).textContent, ganttEnd, `${base} end must equal the gantt's`);
    // The machine-readable window rides along and matches the gantt's own `[now - hours, now]`.
    const svg = getByTestId(base);
    assert.equal(svg.getAttribute('data-window-start'), String(WINDOW_NOW_MS - SHARED_WINDOW_HOURS * HOUR_MS));
    assert.equal(svg.getAttribute('data-window-end'), String(WINDOW_NOW_MS));
  }
});

/*
 * AC3: each of the Tests and Fan-in cards renders a start clock, an end clock and a `now` vertical
 * line, all readable. 取假: dropping the axis rendering leaves these testids absent and this reds.
 */
test('the Tests and Fan-in cards each render start/end clock labels and a now marker', () => {
  const { getByTestId } = renderView({ status: 'loaded', snapshot: inWindowSnapshot() }, null);

  for (const base of ['quay-panel-tests-timeline', 'quay-panel-fanin-timeline']) {
    const start = getByTestId(`${base}-axis-start`);
    const end = getByTestId(`${base}-axis-end`);
    const now = getByTestId(`${base}-now`);

    assert.match(start.textContent ?? '', /\d{1,2}:\d{2}/, `${base} start label must be a clock reading`);
    assert.match(end.textContent ?? '', /\d{1,2}:\d{2}/, `${base} end label must be a clock reading`);
    assert.equal(now.tagName.toLowerCase(), 'line', `${base} now marker must be a vertical line`);
    assert.match(now.textContent ?? '', /\d{1,2}:\d{2}/, `${base} now marker must name its instant`);
  }
});

/*
 * AC4: a round and a fan-in attempt that fall outside the shared window are clipped by the
 * consumer and never drawn as rects. 取假: removing the window clip draws both and this reds.
 */
test('a round and a fan-in attempt outside the shared window are not drawn', () => {
  const snapshot = inWindowSnapshot({
    tests: {
      current: SNAPSHOT.tests.current,
      recentRounds: [
        { round: 1, startedAt: new Date(WINDOW_NOW_MS - HOUR_MS).toISOString(), durationMs: 60000, pass: 1, fail: 0, tests: 1, state: 'green' },
        // 10h before `now`: outside the 3h window.
        { round: 2, startedAt: new Date(WINDOW_NOW_MS - 10 * HOUR_MS).toISOString(), durationMs: 60000, pass: 0, fail: 1, tests: 1, state: 'red' },
      ],
    },
    fanIn: {
      recent: [
        {
          task: 'gap-inside',
          outcome: 'landed',
          lockAcquireEpoch: Math.floor((WINDOW_NOW_MS - HOUR_MS) / 1000),
          lockReleaseEpoch: Math.floor((WINDOW_NOW_MS - HOUR_MS + 60000) / 1000),
        },
        // 10h before `now`: outside the window, so it must not reach the plot.
        { task: 'gap-outside', outcome: 'failed', lockAcquireEpoch: Math.floor((WINDOW_NOW_MS - 10 * HOUR_MS) / 1000), lockReleaseEpoch: null },
      ],
    },
  });
  const { container } = renderView({ status: 'loaded', snapshot }, null);

  assert.equal(
    container.querySelectorAll('[data-testid="quay-panel-tests-timeline-rect"]').length,
    1,
    'only the in-window round is drawn',
  );
  assert.equal(
    container.querySelectorAll('[data-testid="quay-panel-fanin-timeline-rect"]').length,
    1,
    'only the in-window fan-in attempt is drawn',
  );
});

/* ── the wall view contract: the In-flight tile declares focusable objects ───────────────────
 *
 * AC2 of quay-wall-addressable-view-and-input-package: a focusable child is exactly
 * `{uri, label, display}` and at least one real QuayPanel tile — here the in-flight tile —
 * declares them. Each row's URI is the project-segmented task form
 * `quay://<project>/task/<id>`, and its display attributes are derived from the SAME reading
 * the row draws: the phase's status, the phase marker's colour, the spatial ordinal and its
 * top-left position. The tile publishes the contract once as JSON and once per row; both
 * must describe the same objects, or the wall advertises addresses its rows do not answer.
 *
 * The ordinal is also VISIBLE (`quay-panel-inflight-label`), because the declaimed label is
 * what a person reads as ①② when they say 「第二个」.
 */
test('the In-flight tile declares each row as a focusable quay://<project>/task/<id> object', () => {
  const snapshot: QuaySnapshot = {
    ...SNAPSHOT,
    inFlight: [
      { taskId: 'gap-wall-a', phase: 'implementing', startedAt: '2026-10-01T23:50:00.000Z', lastHeartbeat: '2026-10-02T00:00:00.000Z', workerPid: 1 },
      { taskId: 'gap-wall-b', phase: 'fan-in', startedAt: '2026-10-01T23:40:00.000Z', lastHeartbeat: '2026-10-02T00:00:00.000Z', workerPid: 1 },
    ],
  };
  const { getByTestId, getAllByTestId } = renderView({ status: 'loaded', snapshot }, null);

  const tile = getByTestId('quay-panel-inflight');
  const declared = JSON.parse(tile.getAttribute('data-quay-focusables') ?? '[]') as Array<{
    uri: string;
    label: string;
    display: { status: string; color: string; ordinal: number; pos: { row: number; column: number } };
  }>;

  assert.deepEqual(
    declared,
    buildQuayInFlightContract('project-1', snapshot.inFlight).focusables,
    'the tile and the exported contract disagree',
  );
  assert.deepEqual(declared, [
    {
      uri: 'quay://project-1/task/gap-wall-a',
      label: '①',
      display: { status: 'implementing', color: 'blue', ordinal: 1, pos: { row: 1, column: 1 } },
    },
    {
      uri: 'quay://project-1/task/gap-wall-b',
      label: '②',
      display: { status: 'fan-in', color: 'violet', ordinal: 2, pos: { row: 2, column: 1 } },
    },
  ]);

  // Exactly the triple — no task id/title content rides inside a focusable, because the
  // voice pack carries references and reads content back downstream.
  for (const focusable of declared) {
    assert.deepEqual(Object.keys(focusable).sort(), ['display', 'label', 'uri']);
    assert.deepEqual(Object.keys(focusable.display).sort(), ['color', 'ordinal', 'pos', 'status']);
  }

  // The rows carry the same declaration, and the ordinal is VISIBLE in the row.
  const rows = getAllByTestId('quay-panel-inflight-row');
  const labels = getAllByTestId('quay-panel-inflight-label');
  assert.equal(rows.length, declared.length);
  assert.equal(labels.length, declared.length);
  rows.forEach((row, index) => {
    assert.equal(row.getAttribute('data-quay-uri'), declared[index].uri);
    assert.equal(row.getAttribute('data-quay-label'), declared[index].label);
    assert.deepEqual(JSON.parse(row.getAttribute('data-quay-display') ?? '{}'), declared[index].display);
    assert.equal(labels[index].textContent, declared[index].label);
  });
});

test('an unread In-flight tile declares nothing, while an empty reading declares an empty set', () => {
  // Both renders are alive at once, so the tile is addressed through its own container
  // rather than document-wide `getByTestId` (which would see both panels' tiles).
  const tileOf = (rendered: ReturnType<typeof renderView>) =>
    rendered.container.querySelector('[data-testid="quay-panel-inflight"]');

  const unread = renderView({ status: 'loaded', snapshot: { ...SNAPSHOT, inFlight: null } }, null);
  // `null` is "no lane reading": there is no set to declare, so there is no attribute.
  assert.equal(tileOf(unread)?.getAttribute('data-quay-focusables'), null);

  const empty = renderView({ status: 'loaded', snapshot: { ...SNAPSHOT, inFlight: [] } }, null);
  // `[]` is a reading that answered with nothing: it declares an empty focusable set.
  assert.equal(tileOf(empty)?.getAttribute('data-quay-focusables'), '[]');
});
