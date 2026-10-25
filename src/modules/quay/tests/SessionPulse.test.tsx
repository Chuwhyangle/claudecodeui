import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type {
  AppTab,
  Project,
  ProjectSession,
  QuayGanttLanes,
  QuayInFlightTask,
  QuaySessionMentionGoal,
  QuaySessionMentionTask,
  QuaySnapshot,
} from '@/shared/types';
import { cn } from '@/shared/utils';
import { QUAY_IN_FLIGHT_PHASE_META, QUAY_TASK_BADGE_BASE_CLASS } from '@/shared/constants';
import enCommon from '@/modules/i18n/locales/en/common.json';
import LoopPulseGantt from '@/modules/quay/LoopPulseGantt';
import QuayPanel from '@/modules/quay/QuayPanel';
import SessionPulse from '@/modules/quay/SessionPulse';
import {
  readPulseWindowHours,
  pulseWindowStorageKey,
} from '@/modules/quay/hooks/useSessionPulse';

/**
 * The title bar's Loop pulse entry (gap-workspace-header-quay-pulse-trigger-and-session-popover).
 *
 * The trigger's polling and the popover's one-shot list are exercised through the real
 * components: the network hop is the only stub. Everything else — the header-width breakpoint,
 * the shared bar-colour vocabulary, the per-project window storage, the sort/fold of the list —
 * is read back off the DOM, because those are the properties the task is defined by.
 */

const apiMock = vi.hoisted(() => ({
  quayLanes: vi.fn(),
  quaySessionMentions: vi.fn(),
}));
vi.mock('@/shared/api', () => ({ api: apiMock }));

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({
    plugins: [],
    loading: false,
    pluginsError: null,
    refreshPlugins: async () => {},
    installPlugin: async () => ({ success: true }),
    uninstallPlugin: async () => ({ success: true }),
    updatePlugin: async () => ({ success: true }),
    togglePlugin: async () => ({ success: true, error: null }),
  }),
  // The workspace tab strip has no plugin in this fixture, so the icon never renders.
  PluginIcon: () => null,
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** A ResizeObserver double whose callbacks the cases drive with an explicit header width. */
type ObserverRecord = {
  target: Element | null;
  fire: (width: number) => void;
};
const observers: ObserverRecord[] = [];

class TestResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private target: Element | null = null;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    const record: ObserverRecord = {
      target: null,
      fire: (width: number) => {
        this.callback(
          [{ target: this.target, contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      },
    };
    // Keep one record per instance, but expose the target through the record's getter below.
    Object.defineProperty(record, 'target', { get: () => this.target });
    observers.push(record);
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(): void {}

  // The widths are always filtered by target, so a record whose callback would fire after a
  // disconnect is harmless here; there is nothing to unregister.
  disconnect(): void {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function fireHeaderWidth(width: number): Promise<void> {
  const header = document.querySelector('header[data-app-header]');
  assert.ok(header, 'premise: the harness must render a header');
  await act(async () => {
    for (const record of observers.filter((candidate) => candidate.target === header)) {
      record.fire(width);
    }
  });
}

const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as Response;

const NOW = Date.parse('2026-02-01T12:00:00.000Z');
const HOUR = 3_600_000;

const PROJECT: Project = {
  projectId: 'proj-a',
  displayName: 'Quay probe',
  fullPath: '/repo',
  hasQuayConfig: true,
};
const SESSION: ProjectSession = { id: 's1', projectId: 'proj-a' } as ProjectSession;

const interval = (
  taskId: string,
  phase: string | null,
  finalState: string | null,
  startHoursAgo: number,
  endHoursAgo: number,
) => ({
  taskId,
  runId: `run-${taskId}`,
  startMs: NOW - startHoursAgo * HOUR,
  endMs: NOW - endHoursAgo * HOUR,
  phase,
  finalState,
  fanInOutcome: null,
});

/** One interval per state the card and the trigger must colour identically. */
const FOUR_STATE_GANTT: QuayGanttLanes = {
  windowHours: 3,
  nowMs: NOW,
  lanes: [[
    interval('t-completed', null, 'completed', 2.5, 2),
    interval('t-failed', null, 'failed', 2.4, 1.9),
    interval('t-timed-out', null, 'timed-out', 2.3, 1.8),
    interval('t-fanin', 'fan-in', null, 1.5, 0),
  ]],
  overflow: 0,
};

const EMPTY_GANTT: QuayGanttLanes = { windowHours: 3, nowMs: NOW, lanes: [[], [], [], [], []], overflow: 0 };

const lanesReading = (gantt: QuayGanttLanes | null) => ({
  ok: true,
  gantt,
  ganttUnavailable: gantt === null ? 'lanes-read-failed' : null,
  generatedAt: new Date(NOW).toISOString(),
});

const MENTION_TASKS: QuaySessionMentionTask[] = [
  { taskId: 't-impl', title: 'Implementing task', status: 'ready', phase: 'implementing', goalId: 'GOAL-1', mentionCount: 2, lastMentionAt: new Date(NOW - 120_000).toISOString() },
  { taskId: 't-fanin', title: 'Fan-in task', status: 'ready', phase: 'fan-in', goalId: 'GOAL-1', mentionCount: 1, lastMentionAt: null },
  { taskId: 't-awaiting', title: 'Awaiting land task', status: 'ready', phase: 'awaiting-land', goalId: null, mentionCount: 1, lastMentionAt: null },
  { taskId: 't-landed', title: 'Landed task', status: 'ready', phase: 'landed', goalId: null, mentionCount: 1, lastMentionAt: null },
];

const MENTION_GOALS: QuaySessionMentionGoal[] = [
  { goalId: 'GOAL-1', title: 'Active goal', status: 'active', viaTaskCount: 2, mentionedDirectly: false },
  { goalId: 'GOAL-2', title: 'Achieved goal', status: 'achieved', viaTaskCount: 0, mentionedDirectly: true },
];

const mentionsReading = (
  tasks: QuaySessionMentionTask[] = MENTION_TASKS,
  goals: QuaySessionMentionGoal[] = MENTION_GOALS,
) => ({
  ok: true,
  sessionId: 's1',
  projectId: 'proj-a',
  tasks,
  goals,
  generatedAt: new Date(NOW).toISOString(),
});

const trigger = (): HTMLButtonElement => {
  const element = document.querySelector('[data-testid="quay-pulse-trigger"]') as HTMLButtonElement | null;
  assert.ok(element, 'the quay pulse trigger must be rendered');
  return element;
};
const popover = (): HTMLElement | null =>
  document.querySelector('[data-testid="quay-pulse-popover"]');

async function openPopover(): Promise<void> {
  fireEvent.click(trigger());
  await flush();
}

/** A header wrapper for the trigger; the popover measures its closest `header[data-app-header]`. */
function PulseHarness({
  projectId = 'proj-a',
  sessionId = 's1',
  isMobile = false,
}: {
  projectId?: string;
  sessionId?: string | null;
  isMobile?: boolean;
}) {
  return (
    <header data-app-header>
      <SessionPulse
        projectId={projectId}
        sessionId={sessionId}
        isMobile={isMobile}
        onOpenQuayPanel={() => {}}
      />
    </header>
  );
}

beforeEach(() => {
  // jsdom does not implement scrollIntoView; the header's active-tab scroll effect calls it
  // from a requestAnimationFrame, which lands after the synchronous assertions below.
  Element.prototype.scrollIntoView = () => {};
  observers.length = 0;
  window.localStorage.clear();
  apiMock.quayLanes.mockReset();
  apiMock.quaySessionMentions.mockReset();
  apiMock.quayLanes.mockResolvedValue(jsonResponse(lanesReading(FOUR_STATE_GANTT)));
  apiMock.quaySessionMentions.mockResolvedValue(jsonResponse(mentionsReading()));
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
});

afterEach(() => {
  vi.useRealTimers();
  // The visibility override is an own property; removing it restores jsdom's prototype getter.
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

/* ── 显隐 ─────────────────────────────────────────────────────────────── */

// The `shouldShowQuayTab` gate itself lives in the project-workspace test
// (`workspaceTabsResponsive.test.tsx`), because this module must not import that one.
test('a quay project renders the trigger on desktop and mobile', async () => {
  const desktop = render(<PulseHarness />);
  await flush();
  assert.ok(desktop.container.querySelector('[data-testid="quay-pulse-trigger"]'), 'desktop trigger');

  desktop.unmount();
  const mobile = render(<PulseHarness isMobile />);
  await flush();
  assert.ok(mobile.container.querySelector('[data-testid="quay-pulse-trigger"]'), 'mobile trigger');
});

/* ── 形态切换 ─────────────────────────────────────────────────────────── */

test('the trigger shape follows the HEADER width, and mobile is always the pulse strip', async () => {
  // The viewport is wide in this case: the 959 px reading must therefore come from the header,
  // not from the window. Falsifying the criterion by switching to `window.innerWidth` reds it.
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  render(<PulseHarness />);
  await flush();

  await fireHeaderWidth(1000);
  assert.equal(trigger().getAttribute('data-variant'), 'wide', '1000 px header is the mini gantt');
  assert.equal(trigger().style.width, '110px', 'the wide trigger is 110 px');

  await fireHeaderWidth(959);
  assert.equal(trigger().getAttribute('data-variant'), 'narrow', '959 px header is the pulse strip');
  assert.equal(trigger().style.width, '43px', 'the narrow trigger is 43 px');
});

test('mobile is the pulse strip at any header width', async () => {
  render(<PulseHarness isMobile />);
  await flush();

  await fireHeaderWidth(2000);
  assert.equal(trigger().getAttribute('data-variant'), 'narrow');
  assert.equal(trigger().style.width, '43px');
});

/* ── 常态与点击态 ─────────────────────────────────────────────────────── */

test('the trigger is borderless and transparent at rest, accent-filled and expanded when open', async () => {
  render(<PulseHarness />);
  await flush();

  const classes = Array.from(trigger().classList);
  assert.ok(!classes.includes('bg-accent'), `closed trigger must not carry bg-accent: ${classes.join(' ')}`);
  assert.ok(!classes.some((name) => name === 'border' || name.startsWith('border-')), `closed trigger must carry no border: ${classes.join(' ')}`);
  assert.equal(trigger().getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  assert.ok((trigger().getAttribute('aria-label') ?? '').length > 0, 'the trigger needs a non-empty aria-label');
  assert.ok(classes.includes('focus-visible:ring-2'), 'keyboard focus ring');
  assert.ok(classes.includes('focus-visible:ring-primary/60'), 'keyboard focus ring colour');

  await openPopover();
  assert.ok(trigger().classList.contains('bg-accent'), 'the open trigger is accent-filled');
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');

  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
});

/* ── 画法同源 ─────────────────────────────────────────────────────────── */

test('the trigger draws each state with the card’s own colour class', async () => {
  render(
    <>
      <PulseHarness />
      <LoopPulseGantt gantt={FOUR_STATE_GANTT} />
    </>,
  );
  await flush();

  for (const state of ['completed', 'failed', 'timed-out', 'fan-in']) {
    const mini = document.querySelector(`[data-testid="quay-pulse-bar"][data-state="${state}"]`);
    const card = document.querySelector(`[data-testid="quay-gantt-bar"][data-state="${state}"]`);
    assert.ok(mini, `the trigger must draw a ${state} bar`);
    assert.ok(card, `the card must draw a ${state} bar`);
    assert.equal(
      mini.getAttribute('class'),
      card.getAttribute('class'),
      `the ${state} bar must use the card's colour class in both surfaces`,
    );
  }
});

test('an empty lane set still draws the five guide lines, with no bars', async () => {
  apiMock.quayLanes.mockResolvedValue(jsonResponse(lanesReading(EMPTY_GANTT)));
  render(<PulseHarness />);
  await flush();

  assert.equal(document.querySelectorAll('[data-testid="quay-pulse-lane"]').length, 5);
  assert.equal(document.querySelectorAll('[data-testid="quay-pulse-bar"]').length, 0);
  assert.equal(document.querySelector('[data-testid="quay-pulse-degraded"]'), null);
});

test('an unreadable lane set draws the guides plus the amber degraded dot and no bars', async () => {
  apiMock.quayLanes.mockResolvedValue(jsonResponse(lanesReading(null)));
  render(<PulseHarness />);
  await flush();

  assert.equal(document.querySelectorAll('[data-testid="quay-pulse-lane"]').length, 5);
  assert.equal(document.querySelectorAll('[data-testid="quay-pulse-bar"]').length, 0);
  assert.ok(document.querySelector('[data-testid="quay-pulse-degraded"]'), 'the degraded dot must be shown');
});

/* ── 按项目存窗口 ─────────────────────────────────────────────────────── */

test('the window is stored per project in localStorage, never sent to the server', async () => {
  render(<PulseHarness projectId="proj-a" />);
  await flush();
  assert.deepEqual(apiMock.quayLanes.mock.calls.at(-1), ['proj-a', 3], 'a project with no choice reads 3h');

  await openPopover();
  await act(async () => {
    fireEvent.click(document.querySelector('[data-testid="quay-gantt-window-6"]') as HTMLElement);
  });
  await flush();

  assert.equal(window.localStorage.getItem(pulseWindowStorageKey('proj-a')), '6');
  assert.deepEqual(apiMock.quayLanes.mock.calls.at(-1), ['proj-a', 6], 'the trigger re-reads the lanes for the new window');
  // No other api channel exists in this mock: no save endpoint was called to persist the window.
  assert.equal(apiMock.quaySessionMentions.mock.calls.length, 1, 'only the popover list read ran');
});

test('switching projects reads each project’s own stored window', async () => {
  window.localStorage.setItem(pulseWindowStorageKey('proj-a'), '6');
  window.localStorage.setItem(pulseWindowStorageKey('proj-b'), '12');

  const view = render(<PulseHarness projectId="proj-a" />);
  await flush();
  assert.deepEqual(apiMock.quayLanes.mock.calls.at(-1), ['proj-a', 6]);

  view.rerender(<PulseHarness projectId="proj-b" />);
  await flush();
  assert.deepEqual(apiMock.quayLanes.mock.calls.at(-1), ['proj-b', 12], 'project B keeps its own 12h reading');
});

test('an absent, illegal or unparseable stored window falls back to 3', () => {
  assert.equal(readPulseWindowHours('absent-project'), 3);
  window.localStorage.setItem(pulseWindowStorageKey('five-project'), '5');
  assert.equal(readPulseWindowHours('five-project'), 3, '5 is not one of the card’s windows');
  window.localStorage.setItem(pulseWindowStorageKey('abc-project'), 'abc');
  assert.equal(readPulseWindowHours('abc-project'), 3, 'an unparseable value reads as the default');
  window.localStorage.setItem(pulseWindowStorageKey('twelve-project'), '12');
  assert.equal(readPulseWindowHours('twelve-project'), 12);
});

/* ── 轮询 ─────────────────────────────────────────────────────────────── */

test('lanes poll every 30 s without re-rendering the parent, pause when hidden and catch up when visible', async () => {
  vi.useFakeTimers();
  let renderCount = 0;

  function Parent() {
    // Counted in an effect (a render-time reassignment is flagged as a side effect): the effect
    // runs once per committed Parent render, which is exactly what the case measures.
    useEffect(() => {
      renderCount += 1;
    });
    return <PulseHarness />;
  }

  render(<Parent />);
  await flush();
  assert.equal(apiMock.quayLanes.mock.calls.length, 1, 'one initial read');

  for (let poll = 0; poll < 3; poll += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
  }
  assert.equal(apiMock.quayLanes.mock.calls.length, 4, 'three polls after the initial read');
  assert.equal(renderCount, 1, 'the poll state lives inside the memoized pulse component');

  let visibility: DocumentVisibilityState = 'hidden';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  assert.equal(apiMock.quayLanes.mock.calls.length, 4, 'a hidden page spawns no read');

  visibility = 'visible';
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
  assert.equal(apiMock.quayLanes.mock.calls.length, 5, 'becoming visible catches up immediately');
});

test('a slow reply for the previous project cannot overwrite the new project’s view', async () => {
  let resolveSlow: (value: Response) => void = () => {};
  apiMock.quayLanes.mockImplementationOnce(
    () => new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    }),
  );

  const slowGantt: QuayGanttLanes = {
    ...FOUR_STATE_GANTT,
    lanes: [[interval('slow-task', null, 'failed', 2, 1)]],
  };
  const fastGantt: QuayGanttLanes = {
    ...FOUR_STATE_GANTT,
    lanes: [[interval('fast-task', null, 'completed', 2, 1)]],
  };
  apiMock.quayLanes.mockResolvedValue(jsonResponse(lanesReading(fastGantt)));

  const view = render(<PulseHarness projectId="proj-a" />);
  await flush();

  view.rerender(<PulseHarness projectId="proj-b" />);
  await flush();
  assert.ok(document.querySelector('[data-testid="quay-pulse-bar"][data-state="completed"]'), 'project B’s reading is drawn');

  await act(async () => {
    resolveSlow(jsonResponse(lanesReading(slowGantt)));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(
    document.querySelector('[data-testid="quay-pulse-bar"][data-state="failed"]'),
    null,
    'the superseded project-A reply must be dropped',
  );
  assert.ok(document.querySelector('[data-testid="quay-pulse-bar"][data-state="completed"]'));
});

/* ── popover 几何与风格 ───────────────────────────────────────────────── */

test('the popover is a fixed dialog aligned with the transcript column, and its window drives both charts', async () => {
  render(<PulseHarness />);
  await flush();

  const header = document.querySelector('header[data-app-header]') as HTMLElement;
  header.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 1000, height: 60, top: 0, right: 1000, bottom: 60,
    left: 0, toJSON: () => ({}),
  }) as DOMRect;

  await openPopover();
  const panel = popover();
  assert.ok(panel, 'the popover must open');
  assert.equal(panel.getAttribute('role'), 'dialog');
  for (const required of ['rounded-xl', 'border', 'border-border', 'bg-popover', 'shadow-xl']) {
    assert.ok(panel.classList.contains(required), `the dialog must carry ${required}: ${panel.className}`);
  }

  // min(868, 1000 - 16) = 868; centred in a header that starts at 0.
  assert.equal(panel.style.width, '868px');
  assert.equal(panel.style.left, '66px');
  assert.equal(panel.style.top, '64px');

  assert.ok(panel.querySelector('[data-testid="quay-gantt"]'), 'the big gantt belongs in the popover');
  assert.ok(panel.querySelector('[data-testid="quay-gantt-windows"]'), 'the window selector belongs in the popover');

  await act(async () => {
    fireEvent.click(panel.querySelector('[data-testid="quay-gantt-window-6"]') as HTMLElement);
  });
  await flush();
  assert.equal(trigger().getAttribute('data-window-hours'), '6', 'the trigger follows the popover window');
  assert.equal(
    panel.querySelector('[data-testid="quay-gantt-window-6"]')?.getAttribute('aria-pressed'),
    'true',
    'the popover chart shows the selected window',
  );
});

test('the popover is viewport-wide on mobile', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 });
  render(<PulseHarness isMobile />);
  await flush();

  const header = document.querySelector('header[data-app-header]') as HTMLElement;
  header.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 390, height: 56, top: 0, right: 390, bottom: 56,
    left: 0, toJSON: () => ({}),
  }) as DOMRect;

  await openPopover();
  const panel = popover();
  assert.ok(panel);
  assert.equal(panel.style.width, '374px', 'viewport width minus the two 8 px margins');
  assert.equal(panel.style.left, '8px');
});

test('Goals and Tasks are sibling section containers whose headings share their own rows; the scroller has no padding', async () => {
  render(<PulseHarness />);
  await flush();
  await openPopover();

  const panel = popover();
  assert.ok(panel);
  const goals = panel.querySelector('[data-testid="quay-pulse-goals"]');
  const tasks = panel.querySelector('[data-testid="quay-pulse-tasks"]');
  assert.ok(goals, 'the Goals section must render');
  assert.ok(tasks, 'the Tasks section must render');
  assert.equal(goals.parentElement, tasks.parentElement, 'the two sections are siblings');

  for (const [name, section] of [['goals', goals], ['tasks', tasks]] as const) {
    assert.ok(section.querySelector('h3'), `the ${name} heading lives in its own section`);
  }
  assert.ok(goals.querySelectorAll('[data-testid="quay-pulse-goal-row"]').length > 0, 'goal rows live in the Goals section');
  assert.ok(tasks.querySelectorAll('[data-testid="quay-pulse-task-row"]').length > 0, 'task rows live in the Tasks section');

  const list = panel.querySelector('[data-testid="quay-pulse-list"]') as HTMLElement;
  const paddingTokens = Array.from(list.classList).filter((name) => /^(p|px|py)-/.test(name));
  assert.deepEqual(paddingTokens, [], `the scroller must carry no padding class: ${list.className}`);
});

/* ── 行与徽标 ─────────────────────────────────────────────────────────── */

test('a task’s phase badge is byte-identical to the Quay panel’s in-flight badge', async () => {
  const inFlight: QuayInFlightTask[] = MENTION_TASKS.map((task, index) => ({
    taskId: task.taskId,
    phase: task.phase as QuayInFlightTask['phase'],
    startedAt: null,
    lastHeartbeat: new Date(NOW).toISOString(),
    workerPid: index + 1,
  }));
  const snapshot: QuaySnapshot = {
    projectId: 'proj-a',
    projectPath: '/repo',
    generatedAt: new Date(NOW).toISOString(),
    cached: false,
    driver: null,
    tasks: null,
    goals: null,
    adrs: null,
    configIssues: null,
    tests: { current: null, recentRounds: [] },
    fanIn: { recent: [] },
    inFlight,
    gantt: null,
    ganttUnavailable: 'lanes-read-failed',
    dashboardUrl: null,
    warnings: [],
  };

  render(
    <>
      <PulseHarness />
      <QuayPanel projectId="proj-a" view={{ status: 'loaded', snapshot }} onRefresh={() => {}} />
    </>,
  );
  await flush();
  await openPopover();

  for (const task of MENTION_TASKS) {
    const badge = document.querySelector(
      `[data-testid="quay-pulse-task-row"][data-task-id="${task.taskId}"] [data-testid="quay-pulse-task-badge"]`,
    );
    const cardBadge = document.querySelector(`[data-testid="quay-panel-inflight-phase-${task.phase}"]`);
    assert.ok(badge, `the popover must badge ${task.taskId}`);
    assert.ok(cardBadge, `the panel must badge ${task.taskId}`);
    assert.equal(
      badge.className,
      cardBadge.className,
      `${task.phase} must be the same badge in both surfaces`,
    );
    // The shared declaration is the premise of the equality above, not a replacement for it.
    assert.equal(
      badge.className,
      cn(QUAY_TASK_BADGE_BASE_CLASS, QUAY_IN_FLIGHT_PHASE_META[task.phase as QuayInFlightTask['phase']].className),
    );
  }
});

test('only a non-achieved goal draws the progress bar', async () => {
  render(<PulseHarness />);
  await flush();
  await openPopover();

  const active = document.querySelector('[data-testid="quay-pulse-goal-row"][data-goal-id="GOAL-1"]');
  const achieved = document.querySelector('[data-testid="quay-pulse-goal-row"][data-goal-id="GOAL-2"]');
  assert.ok(active && achieved);
  assert.ok(active.querySelector('[data-testid="quay-pulse-goal-bar"]'), 'an active goal draws its bar');
  assert.equal(achieved.querySelector('[data-testid="quay-pulse-goal-bar"]'), null, 'an achieved goal draws no bar');
});

test('in-flight and actionable tasks sort first; done and superseded fold under “Done · N”', async () => {
  const tasks: QuaySessionMentionTask[] = [
    { taskId: 't-todo', title: 'Todo', status: 'todo', phase: null, goalId: null, mentionCount: 1, lastMentionAt: null },
    { taskId: 't-done', title: 'Done task', status: 'done', phase: null, goalId: null, mentionCount: 1, lastMentionAt: null },
    { taskId: 't-needs', title: 'Needs human', status: 'needs-human', phase: null, goalId: null, mentionCount: 1, lastMentionAt: null },
    { taskId: 't-ready', title: 'Ready', status: 'ready', phase: null, goalId: null, mentionCount: 1, lastMentionAt: null },
    { taskId: 't-superseded', title: 'Superseded', status: 'superseded', phase: null, goalId: null, mentionCount: 1, lastMentionAt: null },
    { taskId: 't-flight', title: 'In flight', status: 'ready', phase: 'implementing', goalId: null, mentionCount: 1, lastMentionAt: null },
  ];
  apiMock.quaySessionMentions.mockResolvedValue(jsonResponse(mentionsReading(tasks, [])));
  render(<PulseHarness />);
  await flush();
  await openPopover();

  const visibleIds = Array.from(document.querySelectorAll('[data-testid="quay-pulse-task-row"]')).map(
    (row) => row.getAttribute('data-task-id'),
  );
  assert.deepEqual(visibleIds, ['t-flight', 't-needs', 't-ready', 't-todo'], 'in-flight, then actionable, then the rest');

  const toggle = document.querySelector('[data-testid="quay-pulse-done-toggle"]');
  assert.ok(toggle, 'the folded Done group needs its toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'Done starts collapsed');
  assert.match(toggle.textContent ?? '', /Done · 2/, 'the toggle counts the folded rows');

  await act(async () => {
    fireEvent.click(toggle as HTMLElement);
  });
  const expandedIds = Array.from(document.querySelectorAll('[data-testid="quay-pulse-task-row"]')).map(
    (row) => row.getAttribute('data-task-id'),
  );
  assert.deepEqual(new Set(expandedIds), new Set([...visibleIds, 't-done', 't-superseded']), 'expanding shows every folded row');
});

test('when lanes are unreadable the list still renders, without phase badges, above an amber note', async () => {
  apiMock.quayLanes.mockResolvedValue(jsonResponse(lanesReading(null)));
  render(<PulseHarness />);
  await flush();
  await openPopover();

  assert.ok(document.querySelector('[data-testid="quay-pulse-lanes-note"]'), 'the amber lanes note must show');
  const rows = document.querySelectorAll('[data-testid="quay-pulse-task-row"]');
  assert.ok(rows.length > 0, 'the list survives the lanes failure');
  const phaseLabels = Object.values(QUAY_IN_FLIGHT_PHASE_META).map((meta) => meta.label);
  for (const row of Array.from(rows)) {
    const badge = row.querySelector('[data-testid="quay-pulse-task-badge"]');
    assert.ok(badge);
    assert.ok(
      !phaseLabels.includes((badge.textContent ?? '').trim()),
      `a row must not claim a phase while lanes are unreadable; got "${badge.textContent}"`,
    );
  }
});

/* ── 四种状态 ─────────────────────────────────────────────────────────── */

test('the mention list has distinct loading, empty and error states, none of which drops the gantt', async () => {
  // Loading: the read never settles for this arm.
  apiMock.quaySessionMentions.mockImplementationOnce(() => new Promise<Response>(() => {}));
  const loadingView = render(<PulseHarness />);
  await flush();
  await openPopover();
  assert.ok(document.querySelector('[data-testid="quay-pulse-loading"]'), 'the loading state');
  loadingView.unmount();

  // Empty: the read succeeded and named nothing.
  apiMock.quaySessionMentions.mockResolvedValue(jsonResponse(mentionsReading([], [])));
  const emptyView = render(<PulseHarness />);
  await flush();
  await openPopover();
  assert.ok(document.querySelector('[data-testid="quay-pulse-empty"]'), 'the empty state');
  assert.ok(document.querySelector('[data-testid="quay-gantt"]'), 'the gantt survives an empty list');
  emptyView.unmount();

  // List read failure: the lanes reading is unaffected.
  apiMock.quaySessionMentions.mockResolvedValue(jsonResponse({ ok: false, reason: 'boom' }, false, 500));
  render(<PulseHarness />);
  await flush();
  await openPopover();
  assert.ok(document.querySelector('[data-testid="quay-pulse-list-error"]'), 'the list error state');
  assert.ok(document.querySelector('[data-testid="quay-gantt"]'), 'the gantt survives a failed list read');
});

/* ── 取数时机 ─────────────────────────────────────────────────────────── */

test('session-mentions is read once per opening, never while closed and never polled', async () => {
  vi.useFakeTimers();
  render(<PulseHarness />);
  await flush();
  assert.equal(apiMock.quaySessionMentions.mock.calls.length, 0, 'a closed popover reads nothing');

  await openPopover();
  assert.equal(apiMock.quaySessionMentions.mock.calls.length, 1, 'opening reads exactly once');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  assert.equal(apiMock.quaySessionMentions.mock.calls.length, 1, 'the open list is not polled');

  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  assert.equal(popover(), null, 'Escape closes the popover');

  await openPopover();
  assert.equal(apiMock.quaySessionMentions.mock.calls.length, 2, 'reopening reads again');
});

/* ── 关闭与焦点 ───────────────────────────────────────────────────────── */

test('clicking outside closes the popover and returns focus to the trigger', async () => {
  render(<PulseHarness />);
  await flush();
  await openPopover();
  assert.ok(popover());

  await act(async () => {
    fireEvent.mouseDown(document.body);
  });
  assert.equal(popover(), null, 'an outside click closes the popover');
  assert.equal(document.activeElement, trigger(), 'focus returns to the trigger');
});
