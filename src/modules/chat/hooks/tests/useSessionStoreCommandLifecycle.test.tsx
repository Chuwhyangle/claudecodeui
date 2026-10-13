/**
 * A message sent to a process that is already busy must not vanish when the
 * host runs it.
 *
 * THE CLAIM. When a session is mid-turn, a send joins the process's queue rather
 * than opening a turn. The composer records it as this client's own
 * `command_lifecycle` row, carrying the user's text, and the host narrates it
 * with `command_lifecycle` events. The row may only leave the screen once the
 * turn it became has its own user row there — the same "the replacement is
 * visible" key the voice side uses for a delivered caption. `started` is the
 * host saying it dequeued the command, NOT that the turn's rows have arrived;
 * those come asynchronously, over the socket or on the next history read.
 *
 * THE SYMPTOM (2026-10-13). `started` blanked the row's content, so the bubble
 * disappeared the moment the process picked the message up and only came back on
 * a refresh — while "Working…" (another line) kept showing, so the reader saw
 * their own message vanish while the process worked on it.
 *
 * FALSIFIABLE. The first case is the fix's premise: after `started`, with no
 * persisted turn row yet, the text must still be there. Restore the old
 * `content: event.state === 'queued' ? … : ''` and it reds. The later cases pin
 * the other half — the row is retired once the turn IS visible, and not by an
 * earlier turn that happens to share the words.
 *
 * Run: npx vitest run src/modules/chat/hooks/tests/useSessionStoreCommandLifecycle.test.tsx
 */
import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { normalizedToChatMessages, RESIDENT_PENDING_MESSAGE_TYPE } from '@/modules/chat/hooks/useChatMessages';
import type { NormalizedMessage } from '@/shared/types';

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const SESSION = 'session-busy-1';
const TEXT = 'ship it while the answer is still streaming';

/** A persisted (non-live) user turn, the shape a pending row is waiting to become. */
const persistedUserTurn = (id: string, content: string, timestamp: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'user',
  provider: 'claude',
  sessionId: SESSION,
  content,
  timestamp,
} as NormalizedMessage);

/** The session's already-running turn, so the store is loaded when the send lands. */
const HISTORY: NormalizedMessage[] = [
  {
    id: '1',
    kind: 'text',
    role: 'assistant',
    provider: 'claude',
    sessionId: SESSION,
    content: 'working on the previous request…',
    timestamp: '2026-01-01T00:00:00.000Z',
  } as NormalizedMessage,
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

/** A loaded store with the busy send already recorded and waiting on the host. */
async function storeWithPendingSend() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer(SESSION, { limit: 20, offset: 0 });
  });
  act(() => {
    view.result.current.addResidentPending(SESSION, TEXT);
  });
  return view;
}

const lifecycleRows = (rows: NormalizedMessage[]) => rows.filter((row) => row.kind === 'command_lifecycle');

describe('a busy send survives command_lifecycle:started', () => {
  it('keeps the text on screen when the host starts the command before its turn rows arrive', async () => {
    const { result } = await storeWithPendingSend();

    // The host dequeues the command into a turn. The turn's own user row has NOT
    // arrived yet — it reaches the client asynchronously, after this event.
    act(() => {
      result.current.applyCommandLifecycle(SESSION, { commandUuid: 'cmd-1', state: 'started' });
    });

    const pending = lifecycleRows(result.current.getMessages(SESSION));
    assert.equal(pending.length, 1, 'the pending row must still be in the transcript');
    assert.equal(pending[0].content, TEXT, 'the message text must survive started');
    assert.equal(pending[0].commandState, 'started');

    // And through the projection the reader actually sees: the bubble's content.
    const projected = normalizedToChatMessages(result.current.getMessages(SESSION));
    const bubble = projected.find((message) => message.type === RESIDENT_PENDING_MESSAGE_TYPE);
    assert.ok(bubble, 'the resident pending bubble must be rendered');
    assert.equal(bubble.content, TEXT);
  });

  it('still empties the row when the command is cancelled', async () => {
    const { result } = await storeWithPendingSend();

    act(() => {
      result.current.applyCommandLifecycle(SESSION, { commandUuid: 'cmd-1', state: 'cancelled' });
    });

    const pending = lifecycleRows(result.current.getMessages(SESSION));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].content, '', 'a withdrawn command leaves no message to draw');
  });
});

describe('the pending row is retired by the replacement being visible', () => {
  it('hands the message off to the persisted turn once it arrives', async () => {
    const { result } = await storeWithPendingSend();
    act(() => {
      result.current.applyCommandLifecycle(SESSION, { commandUuid: 'cmd-1', state: 'started' });
    });

    // The turn's own row lands from the persisted transcript.
    act(() => {
      result.current.appendRealtime(
        SESSION,
        persistedUserTurn('u-turn-1', TEXT, new Date(Date.now() + 1_000).toISOString()),
      );
    });

    const messages = result.current.getMessages(SESSION);
    assert.equal(lifecycleRows(messages).length, 0, 'the pending row is done once its turn is on screen');
    assert.equal(
      messages.filter((message) => message.content === TEXT).length,
      1,
      'the message is carried by exactly one row — the turn, not the pending copy',
    );
  });

  it('does not retire for an identical message from an earlier turn', async () => {
    const { result } = await storeWithPendingSend();
    act(() => {
      result.current.applyCommandLifecycle(SESSION, { commandUuid: 'cmd-1', state: 'started' });
    });

    // An older turn with the same words — the second "continue" of a long
    // conversation. It is not the replacement for this send.
    act(() => {
      result.current.appendRealtime(SESSION, {
        ...persistedUserTurn('u-earlier', TEXT, '2025-12-31T23:00:00.000Z'),
      });
    });

    assert.equal(
      lifecycleRows(result.current.getMessages(SESSION)).length,
      1,
      'an earlier identical turn must not retire the message the user just sent',
    );
  });
});
