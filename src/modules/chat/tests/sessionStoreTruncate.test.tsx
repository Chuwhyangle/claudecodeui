import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * When an already-sent message is replaced, every client watching the session
 * drops the superseded turns before the replacement streams in — otherwise the
 * transcript shows the question twice until the next REST refresh.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const row = (id: string, content: string, anchor?: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: anchor ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: 'session-1',
  content,
  timestamp: `2026-01-01T00:00:0${id}.000Z`,
  ...(anchor ? { transcriptAnchorId: anchor } : {}),
} as NormalizedMessage);

const HISTORY = [
  row('1', 'first prompt', 'u1'),
  row('2', 'first answer'),
  row('3', 'second prompt', 'u2'),
  row('4', 'second answer'),
];

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
  });
});

afterEach(() => {
  vi.resetModules();
});

async function loadedStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
  });
  return view;
}

describe('truncateAt', () => {
  it('drops the anchored message and everything after it', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.truncateAt('session-1', 'u2');
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.content),
      ['first prompt', 'first answer'],
    );
  });

  it('keeps a message whose anchor was not the cut point', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.truncateAt('session-1', 'u1');
    });

    assert.deepEqual(result.current.getMessages('session-1'), []);
  });

  it('leaves the transcript alone for an anchor it does not hold', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.truncateAt('session-1', 'not-here');
    });

    assert.equal(result.current.getMessages('session-1').length, 4);
  });

  it('clears rows that streamed for the turn being replaced', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.appendRealtime('session-1', row('5', 'streaming reply'));
    });
    assert.equal(result.current.getMessages('session-1').length, 5);

    act(() => {
      result.current.truncateAt('session-1', 'u2');
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.content),
      ['first prompt', 'first answer'],
    );
  });

  it('keeps the replacement the cut was made for', async () => {
    const { result } = await loadedStore();

    // The composer appends its echo of the edited message before the server
    // acknowledges the edit, so the cut arrives with the replacement already
    // on screen. Clearing it left the chat pane without the message the user
    // had just sent until the run finished.
    act(() => {
      result.current.appendRealtime('session-1', {
        ...row('5', 'second prompt, corrected'),
        role: 'user',
        replacesAnchorId: 'u2',
      } as NormalizedMessage);
    });

    act(() => {
      result.current.truncateAt('session-1', 'u2');
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.content),
      ['first prompt', 'first answer', 'second prompt, corrected'],
    );
  });

  it('keeps the replacement last when the kept history comes back re-stamped', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.appendRealtime('session-1', {
        ...row('5', 'second prompt, corrected'),
        role: 'user',
        replacesAnchorId: 'u2',
      } as NormalizedMessage);
      result.current.truncateAt('session-1', 'u2');
    });

    // A provider that rewinds by branching writes the surviving turns into a
    // fresh transcript, so the next refresh returns them stamped later than
    // the replacement was typed. Without a floor on where a replacement can
    // sort, the message the user just sent moves to the top.
    sessionMessages.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          messages: [
            { ...row('1', 'first prompt', 'u1'), timestamp: '2026-01-01T00:00:09.000Z' },
            { ...row('2', 'first answer'), timestamp: '2026-01-01T00:00:09.001Z' },
          ],
          total: 2,
          hasMore: false,
        },
      }),
    });

    await act(async () => {
      await result.current.refreshLatestFromServer('session-1');
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.content),
      ['first prompt', 'first answer', 'second prompt, corrected'],
    );
  });

  it('keeps only the newest replacement when an earlier attempt was refused', async () => {
    const { result } = await loadedStore();

    // A refused send leaves its echo in place — nothing rolls it back — so by
    // the time an edit succeeds the store can be holding two attempts at the
    // same message.
    act(() => {
      result.current.appendRealtime('session-1', {
        ...row('5', 'first attempt'),
        role: 'user',
        replacesAnchorId: 'u2',
      } as NormalizedMessage);
      result.current.appendRealtime('session-1', {
        ...row('6', 'second attempt'),
        role: 'user',
        replacesAnchorId: 'u2',
      } as NormalizedMessage);
      result.current.truncateAt('session-1', 'u2');
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.content),
      ['first prompt', 'first answer', 'second attempt'],
    );
  });

  it('clears a replacement tagged for a different cut', async () => {
    const { result } = await loadedStore();

    act(() => {
      result.current.appendRealtime('session-1', {
        ...row('5', 'first prompt, corrected'),
        role: 'user',
        replacesAnchorId: 'u1',
      } as NormalizedMessage);
    });

    act(() => {
      result.current.truncateAt('session-1', 'u2');
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.content),
      ['first prompt', 'first answer'],
    );
  });
});

/**
 * Positions, ids and timestamps all derive from the absolute index so a row
 * keeps its identity when the server window around it slides. A provider that
 * rewinds by branching rewrites the transcript after an edit, which moves every
 * absolute position by the number of rows the rewrite added — the window the
 * client holds is then no longer the window the next page describes.
 */
const absoluteRow = (
  absoluteIndex: number,
  content: string,
  anchor?: string,
): NormalizedMessage => ({
  id: `m${absoluteIndex}`,
  kind: 'text',
  role: anchor ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: 'session-1',
  content,
  timestamp: `2026-01-01T00:00:${String(absoluteIndex).padStart(2, '0')}.000Z`,
  ...(anchor ? { transcriptAnchorId: anchor } : {}),
} as NormalizedMessage);

/** A tail page: `total` rows exist, these are the newest `messages.length`. */
function tailPage(total: number, messages: NormalizedMessage[]) {
  return {
    ok: true,
    json: async () => ({ data: { messages, total, hasMore: false } }),
  };
}

const WINDOW_TOTAL = 40;
const WINDOW_LENGTH = 20;
const CUT_ANCHOR = 'u-anchor';
const REPLACEMENT_ANCHOR = 'u-replacement';
const EDITED_TEXT = 'last prompt, corrected';

/**
 * The transcript the client holds before the edit: a page that starts at
 * absolute 20 (`total=40`, twenty rows), with the message about to be edited as
 * its last row.
 */
function preEditWindow(): NormalizedMessage[] {
  return Array.from({ length: WINDOW_LENGTH }, (_, offset) => {
    const absolute = WINDOW_TOTAL - WINDOW_LENGTH + offset;
    return absolute === WINDOW_TOTAL - 1
      ? absoluteRow(absolute, 'last prompt', CUT_ANCHOR)
      : absoluteRow(absolute, `turn ${absolute}`);
  });
}

/**
 * The local echo the composer appends before the server acknowledges an edit.
 * Its id is a `local_…` one — the only kind `removeOptimisticUserEchoes` will
 * consider retiring — and it is stamped just after the row it replaces.
 */
function localReplacementEcho(): NormalizedMessage {
  return {
    id: 'local_edit_1',
    kind: 'text',
    role: 'user',
    provider: 'claude',
    sessionId: 'session-1',
    content: EDITED_TEXT,
    timestamp: `2026-01-01T00:00:${String(WINDOW_TOTAL - 1).padStart(2, '0')}.500Z`,
    replacesAnchorId: CUT_ANCHOR,
  } as NormalizedMessage;
}

/** Loads the shifted-origin window, then performs the edit's cut. */
async function windowShiftStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());

  sessionMessages.mockResolvedValue(tailPage(WINDOW_TOTAL, preEditWindow()));
  await act(async () => {
    await view.result.current.fetchFromServer('session-1', { limit: WINDOW_LENGTH, offset: 0 });
  });
  assert.equal(
    view.result.current.getSessionSlot('session-1')?.startIndex,
    WINDOW_TOTAL - WINDOW_LENGTH,
  );

  act(() => {
    view.result.current.appendRealtime('session-1', localReplacementEcho());
    view.result.current.truncateAt('session-1', CUT_ANCHOR);
  });

  return view;
}

/** The edited text as the screen reads it, one entry per drawn row. */
function drawnEditedRows(view: Awaited<ReturnType<typeof windowShiftStore>>) {
  return view.result.current
    .getMessages('session-1')
    .map((message) => message.content)
    .filter((content) => content === EDITED_TEXT);
}

describe('replacement rows across a sliding history window', () => {
  it.fails('KNOWN GAP: a shifted window draws the edited user row twice', async () => {
    const view = await windowShiftStore();

    // The rewrite added one row, so the tail page now starts at absolute 21.
    // The persisted replacement sits at absolute 39 — page index 18 — one slot
    // below the floor (19) the cut stored while the origin was 20.
    const shiftedWindow = Array.from({ length: WINDOW_LENGTH }, (_, offset) => {
      const absolute = WINDOW_TOTAL + 1 - WINDOW_LENGTH + offset;
      if (absolute === WINDOW_TOTAL - 1) {
        return absoluteRow(absolute, EDITED_TEXT, REPLACEMENT_ANCHOR);
      }
      if (absolute === WINDOW_TOTAL) {
        return absoluteRow(absolute, 'edited answer');
      }
      return absoluteRow(absolute, `turn ${absolute}`);
    });
    sessionMessages.mockResolvedValue(tailPage(WINDOW_TOTAL + 1, shiftedWindow));

    await act(async () => {
      await view.result.current.refreshLatestFromServer('session-1');
    });

    assert.equal(
      view.result.current.getSessionSlot('session-1')?.startIndex,
      WINDOW_TOTAL + 1 - WINDOW_LENGTH,
    );

    // The persisted copy should have retired the local echo. Because the floor
    // is window-relative it now points past the persisted row, so the echo
    // survives and the edited question is drawn twice.
    assert.deepEqual(drawnEditedRows(view), [EDITED_TEXT]);
  });

  it('retires the replacement when the refresh keeps the window origin', async () => {
    const view = await windowShiftStore();

    // Same edit, but the rewrite replaced the row in place: `total` is still 40
    // and the page still starts at absolute 20, so the persisted replacement is
    // at page index 19 — exactly where the stored floor starts looking.
    const unchangedWindow = Array.from({ length: WINDOW_LENGTH }, (_, offset) => {
      const absolute = WINDOW_TOTAL - WINDOW_LENGTH + offset;
      return absolute === WINDOW_TOTAL - 1
        ? absoluteRow(absolute, EDITED_TEXT, REPLACEMENT_ANCHOR)
        : absoluteRow(absolute, `turn ${absolute}`);
    });
    sessionMessages.mockResolvedValue(tailPage(WINDOW_TOTAL, unchangedWindow));

    await act(async () => {
      await view.result.current.refreshLatestFromServer('session-1');
    });

    assert.equal(
      view.result.current.getSessionSlot('session-1')?.startIndex,
      WINDOW_TOTAL - WINDOW_LENGTH,
    );
    assert.deepEqual(drawnEditedRows(view), [EDITED_TEXT]);
  });

  it('keeps an unclaimed local send when two sends share the same text', async () => {
    const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
    const view = renderHook(() => useSessionStore());

    sessionMessages.mockResolvedValue(tailPage(2, [
      absoluteRow(0, 'first prompt', 'u1'),
      absoluteRow(1, 'first answer'),
    ]));
    await act(async () => {
      await view.result.current.fetchFromServer('session-1', { limit: WINDOW_LENGTH, offset: 0 });
    });

    // Two real sends of the same words, both still unacknowledged. The second
    // is sent a moment later, the way a user re-sends after a refusal.
    act(() => {
      view.result.current.appendRealtime('session-1', {
        ...absoluteRow(2, 'continue'),
        id: 'local_send_a',
        role: 'user',
        timestamp: '2026-01-01T00:00:02.000Z',
      } as NormalizedMessage);
      view.result.current.appendRealtime('session-1', {
        ...absoluteRow(2, 'continue'),
        id: 'local_send_b',
        role: 'user',
        timestamp: '2026-01-01T00:00:02.100Z',
      } as NormalizedMessage);
    });

    // Only one of them reached disk, and the server pushes that persisted turn
    // over the socket. It may retire one local row, never both: the same words
    // in a second, unacknowledged send are a separate message.
    act(() => {
      view.result.current.appendRealtime('session-1', absoluteRow(2, 'continue', 'u2'));
    });

    const sends = view.result.current
      .getMessages('session-1')
      .filter((message) => message.content === 'continue');
    assert.equal(sends.length, 2);
    assert.equal(sends.filter((message) => message.id === 'local_send_b').length, 1);
  });
});
