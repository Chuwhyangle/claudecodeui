import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { render, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { QuaySnapshot } from '@/shared/types';
import QuayPanel from '@/modules/quay/QuayPanel';
import { type QuayPanelView, useQuayStatus } from '@/modules/quay/hooks/useQuayStatus';

// The panel's in-flight reading travels hook → route → carrier. Only the network
// hop is stubbed; the test below drives the real `useQuayStatus` so the reading
// is exercised all the way into `QuayPanel`, not just by a hand-built prop.
const apiMock = vi.hoisted(() => ({ quaySnapshot: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { quaySnapshot: apiMock.quaySnapshot } }));

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
    recent: [
      { task: 'gap-task-a', outcome: 'landed', lockAcquireEpoch: 1790986800, lockReleaseEpoch: 1790987016 },
      { task: 'gap-task-b', outcome: 'failed', lockAcquireEpoch: 1790987100, lockReleaseEpoch: null },
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
