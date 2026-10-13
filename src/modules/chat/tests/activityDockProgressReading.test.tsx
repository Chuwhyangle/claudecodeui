import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ActivityConnection, ServerEvent, SessionActivity } from '@/shared/types';

/**
 * The dock's word is a live reading of what the turn is doing, not a fixture.
 *
 * A long turn — dozens of tool calls, a suite run — used to read `Working…` for
 * its whole span: the elapsed clock ticked, but nothing on the row said *what*
 * the turn was doing, so "still progressing" and "stuck" looked identical. The
 * surface now speaks the phase the server reduced (thinking / writing / the
 * pending tool / compacting / waiting for approval), and that word has to track
 * the server's reading as it changes, or the row is the same information-poor
 * label with a different spelling.
 *
 * This case drives the freshness machine through the dock's own in-memory
 * liveness channel — no socket, no server — and reads the one attribute the
 * reader actually sees (`[data-activity-label]`) across a phase-changing frame
 * sequence. The browser criterion (`e2e/activity-dock-truthful.spec.ts`) proves
 * the same shape against a real server's reduction of real rows; this file is the
 * fast feedback that pins it without the twenty-second boot.
 *
 * The positive control matters: before any phase-carrying frame the dock draws
 * the fixed fallback word, so "the label changed" cannot be satisfied by a dock
 * that only ever draws one thing.
 */

const START = Date.parse('2026-01-01T00:00:00.000Z');
const SESSION_ID = 'session-a';

/** `statusText: null` so the label is the phase alone, never a prose reading. */
const ACTIVITY: SessionActivity = { statusText: null, canInterrupt: true, startedAt: START };

const DOCK = '[data-activity-dock]';
const LABEL = '[data-activity-label]';

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

const subscribedFrame = (): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing: true,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: 600_000,
  timestamp: new Date(START).toISOString(),
});

/**
 * The server's own reduction of a turn row, stamped onto a heartbeat: the phase
 * the tracker derived, and — while it is `tool` — the pending tool's name.
 */
const phaseBeat = (timestamp: number, phase: string, toolName?: string): ServerEvent => ({
  kind: 'activity.heartbeat',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 1,
  phase,
  ...(toolName === undefined ? {} : { toolName }),
  isProcessing: true,
  timestamp: new Date(timestamp).toISOString(),
});

const dockOf = (view: { container: HTMLElement }) => {
  const dock = view.container.querySelector<HTMLElement>(DOCK);
  assert.ok(dock, `the dock must be on screen (${DOCK}); DOM: ${view.container.innerHTML.slice(0, 400)}`);
  return dock;
};

/** The word the reader sees, isolated from the elapsed span beside it. */
const labelOf = (view: { container: HTMLElement }): string => {
  const label = view.container.querySelector<HTMLElement>(LABEL);
  assert.ok(label, `the dock must carry a label (${LABEL}); DOM: ${view.container.innerHTML.slice(0, 400)}`);
  return (label.textContent ?? '').trim();
};

const phaseOf = (view: { container: HTMLElement }): string | null =>
  view.container.querySelector<HTMLElement>(DOCK)?.getAttribute('data-activity-phase') ?? null;

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

describe('the activity dock reads the turn as it progresses', () => {
  // AC1: a change in the server's activity reading updates the indicator. The
  // label must be a function of the phase, and only of the phase.
  test('AC1 the label tracks the phase the server reports, and holds still inside it', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    // Positive control. A running turn whose phase the server has not reported
    // yet draws the fixed fallback word — the thing the defect was stuck on.
    push(subscribedFrame());
    const fallback = labelOf(view);
    readings.push(`no phase yet: label="${fallback}" phase=${phaseOf(view)}`);
    assert.equal(
      phaseOf(view),
      'idle',
      `premise: a hello carries no phase; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      fallback.startsWith('Working'),
      `positive control: before any phase the dock must draw the fixed fallback word; readings: ${readings.join(' | ')}`,
    );

    // The turn's first tool. The server reduced a `tool_use` row to `tool`/`Bash`.
    push(phaseBeat(START + 5_000, 'tool', 'Bash'));
    const tool = labelOf(view);
    readings.push(`tool/Bash: label="${tool}" phase=${phaseOf(view)}`);
    assert.equal(
      tool,
      'Running Bash…',
      `the pending tool must be named on the row; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      phaseOf(view),
      'tool',
      `the published phase must match the label's source; readings: ${readings.join(' | ')}`,
    );

    // A second beat in the same phase says the same thing: the word is a
    // function of the phase, not of how long the phase has lasted.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    const stillTool = labelOf(view);
    readings.push(`tool/Bash +6s: label="${stillTool}"`);
    assert.equal(
      stillTool,
      tool,
      `a word must hold still inside a phase; readings: ${readings.join(' | ')}`,
    );

    // The tool result landed and the model is writing again. The row must follow
    // — this is the change that separates "still progressing" from "stuck".
    push(phaseBeat(START + 12_000, 'writing'));
    const writing = labelOf(view);
    readings.push(`writing: label="${writing}" phase=${phaseOf(view)}`);
    assert.equal(
      writing,
      'Writing…',
      `a phase change must rewrite the label; readings: ${readings.join(' | ')}`,
    );

    // And on to the next think. Three distinct readings across one turn.
    push(phaseBeat(START + 20_000, 'thinking'));
    const thinking = labelOf(view);
    readings.push(`thinking: label="${thinking}" phase=${phaseOf(view)}`);
    assert.equal(
      thinking,
      'Thinking…',
      `the label must keep tracking the phase; readings: ${readings.join(' | ')}`,
    );

    // The substance of the criterion: the word is not a constant. Dropping the
    // phase reading (leaving only elapsed) collapses these to the fallback word
    // and this set shrinks to one — the false form of AC1.
    const words = [...new Set([fallback, tool, writing, thinking])];
    readings.push(`distinct words across the turn=${JSON.stringify(words)}`);
    assert.equal(
      words.length,
      4,
      `the indicator must speak a changing activity reading, not one fixed word; readings: ${readings.join(' | ')}`,
    );

    // The activity reading is drawn *beside* the elapsed, not in place of it:
    // the row still owes the reader the server-derived clock.
    push(phaseBeat(START + 26_000, 'thinking'));
    const elapsed = dockOf(view).getAttribute('data-activity-elapsed-ms');
    readings.push(`elapsed alongside the word: ${elapsed}ms`);
    assert.equal(
      elapsed,
      String(26_000),
      `the activity reading joins the elapsed reading; it does not replace it; readings: ${readings.join(' | ')}`,
    );
  });
});
