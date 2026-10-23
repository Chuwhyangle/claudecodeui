import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCockpitMessageBody,
  createCockpitState,
  reduceCockpit,
} from '@/modules/cockpit/index.js';
import type {
  CockpitEvent,
  CockpitEventSource,
  CockpitFocusable,
  CockpitState,
} from '@/modules/cockpit/index.js';

/**
 * The cockpit reducer's criterion: the state machine is pure, focus snaps over the DISPLAY's
 * reported grid without leaving it, zoom/back walk a stack, the tray edits in place, and an
 * unmatched phrase becomes a pending send built from the display's visible set.
 *
 * Every case drives `reduceCockpit` directly — no socket, no clock, no I/O — which is the
 * property the hub relies on: one `(state, event)` pair, one next state.
 */

const DISPLAY: CockpitEventSource = { deviceId: 'display-1', deviceName: 'desktop', role: 'display' };
const INPUT: CockpitEventSource = { deviceId: 'input-1', deviceName: 'phone', role: 'input' };

/** One declared object at a grid cell; the ordinal follows reading order. */
function object(uri: string, row: number, column: number, ordinal: number): CockpitFocusable {
  return {
    uri,
    label: '①②③④⑤⑥'[ordinal - 1] ?? `(${ordinal})`,
    display: { status: 'ready', color: 'green', ordinal, pos: { row, column } },
  };
}

/** A 2×2 grid: A B / C D. */
const GRID: CockpitFocusable[] = [
  object('quay://one/board', 1, 1, 1),
  object('quay://two/board', 1, 2, 2),
  object('quay://three/board', 2, 1, 3),
  object('quay://four/board', 2, 2, 4),
];

/** A state whose display has reported the 2×2 grid. */
function gridState(): CockpitState {
  return reduceCockpit(createCockpitState(), {
    type: 'visible',
    viewUri: 'quay://one/board',
    focusables: GRID,
    source: DISPLAY,
  });
}

test('the reducer is pure: same input, same output, and the input is never mutated', () => {
  const state = gridState();
  const snapshot = structuredClone(state);
  const event: CockpitEvent = { type: 'move', direction: 'down', source: INPUT };

  const first = reduceCockpit(state, event);
  const second = reduceCockpit(state, event);

  assert.deepEqual(state, snapshot, 'the input state was mutated');
  assert.deepEqual(first, second, 'two reductions of one (state, event) pair disagreed');
  assert.notEqual(first, second, 'the reducer returned the input object instead of a new value');
});

test('move snaps by grid position and clamps at every edge without wrapping', () => {
  let state = gridState();
  assert.equal(state.focusUri, 'quay://one/board', 'focus starts on the first declared object');

  state = reduceCockpit(state, { type: 'move', direction: 'right', source: INPUT });
  assert.equal(state.focusUri, 'quay://two/board');
  assert.equal(state.rev, 2, 'a move advances the revision');

  state = reduceCockpit(state, { type: 'move', direction: 'down', source: INPUT });
  assert.equal(state.focusUri, 'quay://four/board', 'down takes the nearest column of the next row');

  state = reduceCockpit(state, { type: 'move', direction: 'left', source: INPUT });
  assert.equal(state.focusUri, 'quay://three/board');

  state = reduceCockpit(state, { type: 'move', direction: 'right', source: INPUT });
  assert.equal(state.focusUri, 'quay://four/board');

  // Bottom-right: right and down stay put instead of wrapping to the top row.
  state = reduceCockpit(state, { type: 'move', direction: 'right', source: INPUT });
  assert.equal(state.focusUri, 'quay://four/board');
  state = reduceCockpit(state, { type: 'move', direction: 'down', source: INPUT });
  assert.equal(state.focusUri, 'quay://four/board');

  state = reduceCockpit(state, { type: 'move', direction: 'up', source: INPUT });
  assert.equal(state.focusUri, 'quay://two/board', 'up takes the nearest column of the row above');
  state = reduceCockpit(state, { type: 'move', direction: 'up', source: INPUT });
  assert.equal(state.focusUri, 'quay://two/board');

  state = reduceCockpit(state, { type: 'move', direction: 'left', source: INPUT });
  assert.equal(state.focusUri, 'quay://one/board');
});

/**
 * AC2's fixture: a 3-column grid whose last row is short (①②③ / ④⑤). The page draws the
 * fleet tiles in exactly this shape (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`), so the
 * directions must be the two axes of THIS grid, not a linear next/previous.
 */
const THREE_COLUMN: CockpitFocusable[] = [
  object('quay://a/board', 1, 1, 1),
  object('quay://b/board', 1, 2, 2),
  object('quay://c/board', 1, 3, 3),
  object('quay://d/board', 2, 1, 4),
  object('quay://e/board', 2, 2, 5),
];

/** A state whose display has reported {@link THREE_COLUMN}. */
function threeColumnState(): CockpitState {
  return reduceCockpit(createCockpitState(), {
    type: 'visible',
    viewUri: 'quay://a/board',
    focusables: THREE_COLUMN,
    source: DISPLAY,
  });
}

test('AC2: arrows move on the two axes of the reported grid, and the short last row takes the nearest column', () => {
  let state = threeColumnState();
  assert.equal(state.focusUri, 'quay://a/board');

  // → crosses the row; ← comes back. A same-column-only rule (the old behaviour) made → a
  // no-op because every object was declared in column 1.
  state = reduceCockpit(state, { type: 'move', direction: 'right', source: INPUT });
  assert.equal(state.focusUri, 'quay://b/board', '(1,1) → (1,2)');
  state = reduceCockpit(state, { type: 'move', direction: 'left', source: INPUT });
  assert.equal(state.focusUri, 'quay://a/board', '(1,2) ← (1,1)');

  // ↓ moves to the next ROW, keeping the column (the old rule moved linearly to the next
  // object whatever its row).
  state = reduceCockpit(state, { type: 'move', direction: 'down', source: INPUT });
  assert.equal(state.focusUri, 'quay://d/board', '(1,1) ↓ (2,1)');
  state = reduceCockpit(state, { type: 'move', direction: 'up', source: INPUT });
  assert.equal(state.focusUri, 'quay://a/board', '(2,1) ↑ (1,1)');

  // The last row is short: (1,3) has no (2,3), so ↓ lands on the nearest column, (2,2).
  state = reduceCockpit(state, { type: 'move', direction: 'right', source: INPUT });
  state = reduceCockpit(state, { type: 'move', direction: 'right', source: INPUT });
  assert.equal(state.focusUri, 'quay://c/board');
  state = reduceCockpit(state, { type: 'move', direction: 'down', source: INPUT });
  assert.equal(state.focusUri, 'quay://e/board', '(1,3) ↓ nearest column (2,2)');

  // Edges clamp: no wrapping, no leaving the declared grid.
  state = reduceCockpit(state, { type: 'move', direction: 'right', source: INPUT });
  assert.equal(state.focusUri, 'quay://e/board', '→ past the last column stays put');
  state = reduceCockpit(state, { type: 'move', direction: 'down', source: INPUT });
  assert.equal(state.focusUri, 'quay://e/board', '↓ past the last row stays put');

  state = threeColumnState();
  state = reduceCockpit(state, { type: 'move', direction: 'left', source: INPUT });
  assert.equal(state.focusUri, 'quay://a/board', '← past the first column stays put');
  state = reduceCockpit(state, { type: 'move', direction: 'up', source: INPUT });
  assert.equal(state.focusUri, 'quay://a/board', '↑ past the first row stays put');
});

test('zoom in on a project address pushes the fleet view and back pops it', () => {
  let state = gridState();
  state = reduceCockpit(state, { type: 'zoom', direction: 'in', source: INPUT });

  assert.deepEqual(state.view, { type: 'board', project: 'one' });
  assert.deepEqual(state.viewStack, [{ type: 'fleet' }], 'the previous view is stacked');
  assert.equal(state.focusUri, null, 'the new view starts unfocused until its display reports');

  state = reduceCockpit(state, { type: 'back', source: INPUT });
  assert.deepEqual(state.view, { type: 'fleet' });
  assert.deepEqual(state.viewStack, []);
});

test('back on a board with an empty stack falls back to the fleet; back on the fleet is a no-op', () => {
  const board: CockpitState = { ...createCockpitState(), view: { type: 'board', project: 'one' } };
  const back = reduceCockpit(board, { type: 'back', source: INPUT });
  assert.deepEqual(back.view, { type: 'fleet' });

  const fleet = createCockpitState();
  const unchanged = reduceCockpit(fleet, { type: 'back', source: INPUT });
  assert.deepEqual(unchanged.view, { type: 'fleet' });
});

test('pin adds the focused reference to the tray once; unpin removes it', () => {
  let state = gridState();
  state = reduceCockpit(state, { type: 'move', direction: 'right', source: INPUT });
  state = reduceCockpit(state, { type: 'pin', source: INPUT });
  state = reduceCockpit(state, { type: 'pin', source: INPUT });
  assert.deepEqual(state.tray, ['quay://two/board'], 'pinning twice must not duplicate');

  state = reduceCockpit(state, { type: 'unpin', uri: 'quay://two/board', source: INPUT });
  assert.deepEqual(state.tray, []);
});

test('a recognised utterance changes the view and never creates a pending send', () => {
  const state = gridState();
  const next = reduceCockpit(state, { type: 'utterance', text: '看 one', source: INPUT });

  assert.deepEqual(next.view, { type: 'board', project: 'one' });
  assert.equal(next.pendingSend, null, 'a recognised phrase is a view change, not speech to send');
});

test('an unmatched utterance becomes a pending send whose visible set is the display report', () => {
  const state = gridState();
  const next = reduceCockpit(state, { type: 'utterance', text: '今天天气不错', source: INPUT });

  assert.notEqual(next.pendingSend, null);
  assert.equal(next.pendingSend?.text, '今天天气不错');
  assert.deepEqual(
    next.pendingSend?.visible,
    state.visible.focusables,
    'the pending pack must carry the display’s last visible set',
  );
  assert.equal(next.pendingSend?.focusUri, state.focusUri);
  assert.equal(next.pendingSend?.reason, 'no-session', 'a focused object with no target says so');

  const cancelled = reduceCockpit(next, { type: 'cancel', source: INPUT });
  assert.equal(cancelled.pendingSend, null);
});

test('confirm closes the pending send (the send itself belongs to the hub)', () => {
  const state = gridState();
  const pending = reduceCockpit(state, { type: 'utterance', text: '随便说说', source: INPUT });
  const confirmed = reduceCockpit(pending, { type: 'confirm', source: INPUT });
  assert.equal(confirmed.pendingSend, null);
});

test('the confirmed body carries the phrase and de-duplicated reference URIs', () => {
  const pending = {
    text: '把第二个钉住',
    visible: [GRID[1], GRID[0]],
    viewUri: 'quay://one/board',
    focusUri: 'quay://two/board',
    target: null,
    reason: 'no-session' as const,
  };
  const body = buildCockpitMessageBody(pending);
  assert.ok(body.startsWith('把第二个钉住'), body);
  assert.equal(body.match(/quay:\/\/two\/board/g)?.length, 1, 'the focused URI must appear once');
  assert.ok(body.includes('- quay://one/board'), body);
});

test('the status bar’s source echo is the event that produced the state', () => {
  const state = reduceCockpit(gridState(), { type: 'move', direction: 'down', source: INPUT });
  assert.deepEqual(state.lastEventSource, INPUT);
  assert.equal(state.lastEventSource?.deviceName, 'phone');
});
