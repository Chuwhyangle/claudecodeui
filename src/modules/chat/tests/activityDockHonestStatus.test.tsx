import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { UNCONFIRMED_TURN_LABEL_MS } from '@/modules/chat/utils/activityDockView';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ActivityConnection, ServerEvent, SessionActivity } from '@/shared/types';

/**
 * The activity dock's honest reading of a turn the server is not describing.
 *
 * The dock used to answer one question with a fixed word: while the client's
 * local table held a turn and the server kept proving it was there, the row read
 * `Working…`. That is true of a turn the server is describing, but it is a
 * claim — not a reading — for a turn the server has never named a phase for: an
 * accepted-but-never-started run, or an old round pinned by a local mark. The
 * same surface also anchored its elapsed clock on the *hello* it happened to
 * hear, so a page refresh (or any remount) restarted a two-hour turn's clock at
 * zero.
 *
 * These cases drive the dock through its own in-memory liveness channel — a real
 * `ActivityIndicator`, a real `useActivityFreshness`, no socket — and read what
 * it publishes: `data-activity-state`, `data-activity-phase`, the label element
 * (`[data-activity-label]`), the server-derived `data-activity-elapsed-ms`, and
 * the turn's own Stop. The four legs are (a) the honest wording, (b) the elapsed
 * anchor, (c) the real-turn control, and (d) the false form recorded in the
 * task's completion notes.
 *
 * The positive control matters as much as any of them: at t=0, before the
 * threshold, the dock still draws a running word — otherwise "the word is gone"
 * would pass against a dock that never drew one, and it would break the two
 * opposite-direction pins in `activityDockUnreachable` / `activityDockProgressReading`.
 */

const START = Date.parse('2026-01-01T00:00:00.000Z');
const SESSION_ID = 'session-honest';
/** A silence budget far past every window below, so nothing here degrades by accident. */
const UNREACHABLE_AFTER_MS = 600_000;

/** The rotating action words, read from the shipped English locale — never retyped. */
const ACTION_WORDS: string[] = Object.values(enChat.claudeStatus.actions);

/** `statusText: null` so the label is the dock's own word, never a provider prose reading. */
const ACTIVITY: SessionActivity = { statusText: null, canInterrupt: true, startedAt: START };

const DOCK = '[data-activity-dock]';
const LABEL = '[data-activity-label]';
const STOP = '[data-testid="running-turn-stop"]';

/** An in-memory liveness channel, so the case can hand the hook frames with no socket. */
const makeConnection = () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const connection: ActivityConnection = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isConnected: true,
  };
  const push = (event: ServerEvent) => {
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  };
  return { connection, push };
};

/** The hello: it states the run is in flight and announces the silence budget. */
const subscribedFrame = (timestamp: number): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing: true,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: UNREACHABLE_AFTER_MS,
  timestamp: new Date(timestamp).toISOString(),
});

/**
 * A beat: the server proving it is there, and — while it has one — the phase it
 * reduced. `phase: 'idle'` is the server naming nothing, and `isProcessing` is
 * the run registry's own "a run is in flight for this session" bit.
 */
const heartbeatFrame = (
  timestamp: number,
  phase: string,
  isProcessing: boolean,
  toolName: string | null = null,
): ServerEvent => ({
  kind: 'activity.heartbeat',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 1,
  phase,
  toolName,
  isProcessing,
  timestamp: new Date(timestamp).toISOString(),
});

/**
 * The activity-feed frame: a whole snapshot, and the one frame that names *when*
 * the server's turn began — `turn.startedAt` on the server's own clock. This is
 * the reading the elapsed anchor must come from.
 */
const snapshotFrame = (asOf: number, turnStart: number | null): ServerEvent => ({
  kind: 'activity.snapshot',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 2,
  asOf,
  turn: { phase: 'idle', toolName: null, startedAt: turnStart },
  tasks: [],
  schedules: [],
});

const dockOf = (view: { container: HTMLElement }): HTMLElement => {
  const dock = view.container.querySelector<HTMLElement>(DOCK);
  assert.ok(dock, `the dock must be on screen (${DOCK}); DOM: ${view.container.innerHTML.slice(0, 400)}`);
  return dock;
};

/** The dock's published state, or `absent` when there is no dock element at all. */
const dockStateOf = (view: { container: HTMLElement }): string =>
  view.container.querySelector<HTMLElement>(DOCK)?.getAttribute('data-activity-state') ?? 'absent';

/** The phase the dock publishes, or null. */
const phaseOf = (view: { container: HTMLElement }): string | null =>
  view.container.querySelector<HTMLElement>(DOCK)?.getAttribute('data-activity-phase') ?? null;

/** The server-derived elapsed the dock publishes, or null when it publishes none. */
const elapsedOf = (view: { container: HTMLElement }): number | null => {
  const raw = view.container.querySelector<HTMLElement>(DOCK)?.getAttribute('data-activity-elapsed-ms');
  return raw === null || raw === undefined ? null : Number(raw);
};

/** The word the reader sees, isolated from the elapsed span beside it. */
const labelOf = (view: { container: HTMLElement }): string => {
  const label = view.container.querySelector<HTMLElement>(LABEL);
  assert.ok(label, `the dock must carry a label element (${LABEL}); DOM: ${view.container.innerHTML.slice(0, 400)}`);
  return (label.textContent ?? '').replace(/[…]+$/, '').replace(/\.+$/, '').trim();
};

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the activity dock is honest about a turn the server is not describing', () => {
  // (a) The load-bearing leg: a fresh, running turn the server keeps proving it
  // is there for, but never names a phase for, stops saying `Working…`.
  test('(a) only idle beats past the threshold ⇒ the honest waiting wording, still in-turn, Stop kept', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
        onStop: () => {},
        canStop: true,
      }),
    );

    // The hello anchors a running turn; the server has named no phase for it.
    push(subscribedFrame(START));
    const atZero = labelOf(view);
    readings.push(`t=0: state=${dockStateOf(view)} label=${JSON.stringify(atZero)}`);

    // The server keeps proving it is alive, but never says what the turn is
    // doing: `phase` stays `idle` while the registry reports the run in flight.
    // Only the server's own clock advances, well past the threshold.
    const BEAT_OFFSETS_MS = [5_000, 11_000, 16_000];
    for (const offset of BEAT_OFFSETS_MS) {
      push(heartbeatFrame(START + offset, 'idle', true));
    }
    const state = dockStateOf(view);
    const label = labelOf(view);
    const elapsed = elapsedOf(view);
    readings.push(
      `after ${BEAT_OFFSETS_MS[BEAT_OFFSETS_MS.length - 1]}ms of idle beats: state=${state} label=${JSON.stringify(label)} elapsed=${elapsed}ms action-word-hits=${JSON.stringify(ACTION_WORDS.filter((word) => label.includes(word)))}`,
    );
    console.log(`dock.honestStatus.(a) ${readings.join(' | ')}`);

    // Positive control: at t=0 the dock still draws a running word, so the
    // wording below cannot pass against a dock that never drew one.
    assert.ok(
      ACTION_WORDS.some((word) => atZero.includes(word)),
      `positive control: at t=0 an unconfirmed turn still reads a running word; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      elapsed !== null && elapsed >= UNCONFIRMED_TURN_LABEL_MS,
      `premise: the turn must be past the threshold (${UNCONFIRMED_TURN_LABEL_MS}ms); readings: ${readings.join(' | ')}`,
    );
    // (i) no rotating action word survives.
    assert.deepEqual(
      ACTION_WORDS.filter((word) => label.includes(word)),
      [],
      `no claudeStatus.actions.* word may remain on an unconfirmed turn; readings: ${readings.join(' | ')}`,
    );
    // (ii) the label is the shipped honest wording.
    assert.equal(
      label,
      enChat.claudeStatus.awaitingServer.title,
      `the dock must carry the shipped "waiting for the server" wording; readings: ${readings.join(' | ')}`,
    );
    // (iii) the turn is still a turn.
    assert.equal(
      state,
      'in-turn',
      `an unconfirmed turn must stay in-turn, not degrade to unreachable; readings: ${readings.join(' | ')}`,
    );
    // (iv) the turn's own Stop is still drawn.
    assert.ok(
      dockOf(view).querySelector(STOP),
      `the turn's own Stop must stay drawn while the turn runs; readings: ${readings.join(' | ')}`,
    );
  });

  // (b) The elapsed anchor is the server's own turn start, not the hello.
  test('(b) the elapsed anchor is the server turn start: a remount and a later hello do not restart it', () => {
    const readings: string[] = [];
    const S = START;
    const T = 30_000;
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    // The turn began at the server's own clock S; the snapshot names that start.
    push(subscribedFrame(S));
    push(snapshotFrame(S, S));

    // The server clock reaches S+T; the dock reports the turn's own age, not the
    // age of the frame that happened to deliver it.
    push(heartbeatFrame(S + T, 'idle', true));
    const before = elapsedOf(view);
    readings.push(`before remount: elapsed=${before}ms (want ${T})`);

    // Remount: a fresh machine, exactly what a page refresh builds. The replayed
    // snapshot re-teaches the same start; the clock must not restart at 0.
    view.unmount();
    const remounted = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );
    push(snapshotFrame(S + T, S));
    const afterRemount = elapsedOf(remounted);
    readings.push(`after remount: elapsed=${afterRemount}ms (want ${T})`);

    // A later hello on the same server process must not restart it either.
    push(subscribedFrame(S + T + 5_000));
    const afterHello = elapsedOf(remounted);
    readings.push(`after a new hello: elapsed=${afterHello}ms (want ${T + 5_000})`);
    console.log(`dock.honestStatus.(b) ${readings.join(' | ')}`);

    assert.equal(
      before,
      T,
      `the elapsed must be measured from the server turn's start S; readings: ${readings.join(' | ')}`,
    );
    assert.notEqual(
      afterRemount,
      null,
      `a remounted dock must still publish an elapsed reading; readings: ${readings.join(' | ')}`,
    );
    assert.notEqual(
      afterRemount,
      0,
      `a remount must not restart the anchor to 0; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      afterRemount,
      T,
      `a remount must read the server turn's own age from the replayed snapshot; readings: ${readings.join(' | ')}`,
    );
    assert.notEqual(
      afterHello,
      0,
      `a new hello must not restart the anchor; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      afterHello,
      T + 5_000,
      `a hello must only advance the server clock, never move the anchor; readings: ${readings.join(' | ')}`,
    );
  });

  // (c) The positive control for (a): a turn the server *is* describing still
  // reads its phase words, and its clock still grows with the server's readings.
  test('(c) a turn the server is really describing keeps its phase words and a growing clock', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    push(subscribedFrame(START));
    push(snapshotFrame(START, START));

    const beats: Array<{ offsetMs: number; phase: string; tool: string | null }> = [
      { offsetMs: 3_000, phase: 'thinking', tool: null },
      { offsetMs: 7_000, phase: 'writing', tool: null },
      { offsetMs: 11_000, phase: 'tool', tool: 'Bash' },
    ];
    const samples = beats.map((beat) => {
      push(heartbeatFrame(START + beat.offsetMs, beat.phase, true, beat.tool));
      const sample = { phase: phaseOf(view), label: labelOf(view), elapsed: elapsedOf(view) };
      readings.push(
        `${beat.phase}: phase=${sample.phase} label=${JSON.stringify(sample.label)} elapsed=${sample.elapsed}ms`,
      );
      return sample;
    });
    console.log(`dock.honestStatus.(c) ${readings.join(' | ')}`);

    assert.deepEqual(
      samples.map((sample) => sample.phase),
      ['thinking', 'writing', 'tool'],
      `the published phase must track the server frame by frame; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      samples[0].label,
      enChat.claudeStatus.phases.thinking,
      `a described turn reads the locale's phase word; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      samples[1].label,
      enChat.claudeStatus.phases.writing,
      `a described turn reads the locale's phase word; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      samples[2].label,
      (enChat.claudeStatus.phases.tool as string).replace('{{tool}}', 'Bash'),
      `a tool phase must name the pending tool; readings: ${readings.join(' | ')}`,
    );
    const elapsedOfSamples = samples.map((sample) => sample.elapsed ?? -1);
    assert.ok(
      elapsedOfSamples[0] > 0 &&
        elapsedOfSamples[1] > elapsedOfSamples[0] &&
        elapsedOfSamples[2] > elapsedOfSamples[1],
      `the elapsed must grow with the server's own clock, monotonically; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      elapsedOfSamples[elapsedOfSamples.length - 1] - elapsedOfSamples[0] >= 3_000,
      `the sampled window must span at least three seconds; readings: ${readings.join(' | ')}`,
    );
  });
});
