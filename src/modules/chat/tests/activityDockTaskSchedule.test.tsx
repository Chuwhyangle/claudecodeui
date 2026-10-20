import assert from 'node:assert/strict';

import { act, cleanup, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, describe, test } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ActivityDockPanel from '@/modules/chat/transcript/ActivityDockPanel';
import {
  applyActivityFrame,
  findTaskByToolUseId,
  readSessionActivityView,
  resetSessionActivityStore,
  selectActiveTasks,
} from '@/modules/chat/hooks/useSessionActivity';
import { deriveActivityDockView } from '@/modules/chat/utils/voice/activityDockView';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ActivityScheduleView, ActivityTaskState, ActivityTaskView } from '@/shared/types';

/**
 * The background half of the activity dock, in milliseconds.
 *
 * The browser criterion (`e2e/activity-dock-background.spec.ts -g "AC-194"`) is
 * the authority on "a real server's frames drive a real page". This file pins the
 * readings that must be right for that to be true, at the unit:
 *
 *   - the dock reports **current** activity: its count and its `background`
 *     decision read only the tasks that can still move, so a settled task stops
 *     holding the dock open and the last one to settle retires it;
 *   - the panel lists the same live set — a terminal task has no row, which is
 *     what makes every row's stop control the row count;
 *   - a snapshot's tasks and schedules become the dock's counts and the panel's
 *     rows, with each row's own four / three readings taken from the entity;
 *   - a plan row renders **no** cancel control — the selector count is zero by
 *     construction, not by hiding.
 *
 * The terminal rows stay in the *store* — that is the control the panel's empty
 * task section needs: the transcript card joins its task by `toolUseId` and still
 * reads a finished task, so the panel dropping the row is a filter over a live
 * table, not a table that lost it.
 *
 * The store is reset per test so a frame from one case cannot be read by the
 * next; the panel reads the store through `useSessionActivity`, so this is the
 * same path the page uses.
 */

const SESSION_ID = 'session-task-schedule';

/** One task row with only the fields its case reads, so each case names its own fixture. */
function task(
  taskId: string,
  state: ActivityTaskState,
  extra: Partial<ActivityTaskView> = {},
): ActivityTaskView {
  return {
    taskId,
    kind: 'shell',
    state,
    isBackgrounded: true,
    description: `${taskId} description`,
    origin: 'sdk-event',
    startedAt: 1_000,
    ...extra,
  };
}

/** The four states AC1 counts over: two can still move, two cannot. */
const FOUR_STATES: ActivityTaskView[] = [
  task('t-running', 'running'),
  task('t-completed', 'completed', { endedAt: 6_000 }),
  task('t-stopped', 'stopped', { endedAt: 7_000 }),
  task('t-blocked', 'blocked'),
];

const SCHEDULES: ActivityScheduleView[] = [
  {
    scheduleId: 'cron-abc',
    kind: 'cron',
    spec: 'Every 2 minutes',
    recurring: true,
    prompt: 'check the queue',
    nextFireAt: Date.now() + 90_000,
    source: 'tool-call',
  },
];

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const dockCount = (container: HTMLElement): string | null =>
  container.querySelector('[data-activity-task-count]')?.getAttribute('data-activity-task-count') ?? null;

describe('activity dock background panel', () => {
  beforeEach(() => {
    resetSessionActivityStore();
    cleanup();
  });

  test('AC1: the dock counts only the tasks that can still move', () => {
    applyActivityFrame({ sessionId: SESSION_ID, rev: 1, tasks: FOUR_STATES, schedules: [] });

    const { container } = render(
      React.createElement(ActivityIndicator, { activity: null, sessionId: SESSION_ID }),
    );

    const reading = dockCount(container);
    console.log(`ac1.dockTaskCount=${reading} of ${FOUR_STATES.length} rows`);
    assert.equal(reading, '2', 'running + blocked are live; completed + stopped are not');
    assert.equal(
      selectActiveTasks(FOUR_STATES).length,
      2,
      'the dock count is the shared active-task selector, not a second filter',
    );
  });

  test('AC2: the dock retires itself when the last live task settles', () => {
    applyActivityFrame({ sessionId: SESSION_ID, rev: 1, tasks: [task('t-one', 'running')], schedules: [] });

    const { container } = render(
      React.createElement(ActivityIndicator, { activity: null, sessionId: SESSION_ID }),
    );

    console.log(`ac2.before: dock=${container.querySelector('[data-activity-dock]') !== null} count=${dockCount(container)}`);
    assert.ok(container.querySelector('[data-activity-dock]'), 'a live task holds the dock between turns');
    assert.equal(dockCount(container), '1', 'the one live task is the dock’s count');

    // One `activity.upsert` — the whole snapshot again, with the task settled. No turn, no plan:
    // the dock has nothing left to say, so it goes rather than reporting a finished task.
    act(() => {
      applyActivityFrame({
        sessionId: SESSION_ID,
        rev: 2,
        tasks: [task('t-one', 'stopped', { endedAt: 9_000 })],
        schedules: [],
      });
    });

    console.log(`ac2.after: dock=${container.querySelector('[data-activity-dock]') !== null} count=${dockCount(container)}`);
    // Compared as booleans, deliberately: a failing `assert.equal(<element>, null)` makes the
    // reporter serialize a live DOM node, which is a hang rather than a red test.
    assert.ok(container.querySelector('[data-activity-dock]') === null, 'with every task terminal, the dock is gone');
    assert.ok(dockCount(container) === null, 'and the count went with it, in the same render');

    // The row is the store's to keep: the transcript card still joins it by `toolUseId`.
    assert.equal(readSessionActivityView(SESSION_ID).tasks.length, 1, 'the task table keeps the terminal row');
  });

  test('AC3: the panel lists the live tasks only, and every listed row is stoppable', () => {
    const sessionId = 'session-panel-live';
    applyActivityFrame({
      sessionId,
      rev: 1,
      tasks: [
        task('t-done', 'completed', {
          endedAt: 4_000,
          description: 'Finished build',
          toolUseId: 'tool-done-1',
        }),
        task('t-live', 'running', { description: 'Long build', toolUseId: 'tool-live-1' }),
      ],
      schedules: [],
    });

    const { container } = render(React.createElement(ActivityDockPanel, { sessionId }));

    const rows = container.querySelectorAll('[data-activity-task-row]');
    const stops = container.querySelectorAll('[data-task-stop]');
    const count = container.querySelector('[data-activity-dock-panel]')?.getAttribute('data-task-count') ?? null;
    console.log(`ac3.rows=${rows.length} stops=${stops.length} panelTaskCount=${count}`);
    assert.equal(rows.length, 1, 'the completed task is not a row — the panel lists live work');
    assert.equal(count, '1', 'the panel’s count is the same live set the dock counts');
    assert.equal(rows[0].getAttribute('data-task-id'), 't-live');
    assert.equal(stops.length, rows.length, 'every listed row is live, so every listed row carries a stop');
    assert.ok(
      container.querySelector('[data-activity-task-row][data-task-id="t-done"]') === null,
      'a settled task has no row to carry a control',
    );

    // The control: the same frame still holds the terminal row, so the missing list entry is a
    // filter over a live table rather than a table that lost the task.
    assert.equal(readSessionActivityView(sessionId).tasks.length, 2);
    // And the join a transcript card uses is unaffected: a finished task is still findable by its
    // `tool_use` id, which is what lets its card keep reading a state the panel no longer lists.
    assert.equal(findTaskByToolUseId('tool-done-1')?.taskId, 't-done');
  });

  test('a snapshot frames the dock as `background` and carries its live counts', () => {
    const armed = deriveActivityDockView({
      activity: null,
      liveness: 'fresh',
      elapsedMs: null,
      hasTurnAnchor: false,
      wired: true,
      hasAbort: false,
      taskCount: selectActiveTasks(FOUR_STATES).length,
      scheduleCount: SCHEDULES.length,
    });
    console.log(
      `dock.state=${armed.state} dock.liveTasks=${armed.taskCount} dock.plans=${armed.scheduleCount}`,
    );
    assert.equal(armed.state, 'background', 'a session holding live work must draw the dock between turns');
    assert.equal(armed.taskCount, 2, 'the two live tasks, not all four rows');
    assert.equal(armed.scheduleCount, 1);

    // The negative control: with nothing live and no turn, the dock stays hidden —
    // so the branch above is the counts, not a dock that always draws.
    const idle = deriveActivityDockView({
      activity: null,
      liveness: 'fresh',
      elapsedMs: null,
      hasTurnAnchor: false,
      wired: true,
      hasAbort: false,
    });
    console.log(`dock.emptyState=${idle.state}`);
    assert.equal(idle.state, 'hidden');
  });

  test('the panel lists plans with three readings and no plan control', () => {
    const sessionId = 'session-panel';
    applyActivityFrame({
      sessionId,
      rev: 1,
      tasks: [task('t-live', 'running', { description: 'Long build', stepLabel: 'reading files' })],
      schedules: SCHEDULES,
    });

    const { container } = render(React.createElement(ActivityDockPanel, { sessionId }));

    const taskRows = container.querySelectorAll('[data-activity-task-row]');
    const scheduleRows = container.querySelectorAll('[data-activity-schedule-row]');
    console.log(`panel.tasks=${taskRows.length} panel.plans=${scheduleRows.length}`);
    assert.equal(taskRows.length, 1, 'one row per live task in the snapshot');
    assert.equal(scheduleRows.length, 1, 'one row per plan in the snapshot');

    // AC4: each task row carries all four readings.
    const liveRow = container.querySelector('[data-activity-task-row][data-task-id="t-live"]');
    assert.ok(liveRow, 'the live task must have a row');
    assert.equal(liveRow!.getAttribute('data-task-state'), 'running');
    assert.equal(liveRow!.querySelector('[data-task-description]')?.textContent, 'Long build');
    assert.match(
      liveRow!.querySelector('[data-task-elapsed]')?.textContent ?? '',
      /^\d+s$/,
      'a live task’s elapsed is measured to the panel’s own clock',
    );
    assert.equal(liveRow!.querySelector('[data-task-last-action]')?.textContent, 'reading files');

    // AC5: each plan row carries all three readings.
    const planRow = container.querySelector('[data-activity-schedule-row]');
    assert.ok(planRow, 'the plan must have a row');
    assert.equal(planRow!.querySelector('[data-schedule-expression]')?.textContent, 'Every 2 minutes');
    assert.ok(
      (planRow!.querySelector('[data-schedule-countdown]')?.textContent ?? '').length > 0,
      'the plan row must show a countdown',
    );
    assert.equal(planRow!.querySelector('[data-schedule-prompt]')?.textContent, 'check the queue');

    // AC9: a plan row has no cancel control — by construction.
    const cancelCount = container.querySelectorAll('[data-schedule-cancel]').length;
    console.log(`panel.scheduleCancelControls=${cancelCount}`);
    assert.equal(cancelCount, 0, 'a plan row must render no cancel control');

    // AC8's join: a card finds its task by the call's tool_use id, terminal or not.
    const joined = readSessionActivityView(sessionId);
    assert.equal(joined.tasks.length, 1);
    assert.equal(findTaskByToolUseId('nope'), null);
  });
});
