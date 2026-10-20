import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * The row a turn is streamed into has to keep one identity for the whole turn.
 *
 * The transcript keys each row by the store id it carries
 * (`getIntrinsicMessageKey`), so an id that changes under a row is an unmount
 * followed by a mount. On the frame the turn settles on that remount lands on a
 * transcript pinned to the bottom, where the freshly inserted row is measured at
 * its `content-visibility` intrinsic height — the pane's content collapses, the
 * browser clamps the offset, and the reader sees the transcript jump. The id is
 * therefore asserted here rather than left to the browser's geometry.
 *
 * Two things in the store change a row's identity under it, and both are
 * exercised below: the finalize that settles the streaming row, and the server's
 * persisted echo of the same reply — which arrives twice, once as a realtime
 * frame and once in the refresh the terminal `complete` triggers, and which the
 * reconciliation would otherwise let replace the client's row.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const SID = 'session-1';
const FIRST_PROMPT = 'prompt';
const REPLY = 'hello';

const msg = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  provider: 'claude',
  sessionId: SID,
  ...over,
} as NormalizedMessage);

const USER_ROW = msg({
  id: 'u1',
  kind: 'text',
  role: 'user',
  content: FIRST_PROMPT,
  timestamp: '2026-01-01T00:00:01.000Z',
  transcriptAnchorId: 'a1',
});

/**
 * The reply as the server persists it — a different id from the client's row.
 *
 * Dated past the client's clock on purpose. The server writes the row as the
 * turn ends, so it carries a timestamp at or after the last flush the client
 * made, and the two therefore reach the merge with the client's row first.
 * Pinning that order in the fixture keeps the case a statement about the
 * collapse rather than about which clock ran faster.
 */
const SERVER_ECHO = msg({
  id: 'srv-1',
  kind: 'text',
  role: 'assistant',
  content: REPLY,
  timestamp: '2099-01-01T00:00:00.000Z',
  memoryCitations: [{ source: 'MEMORY.md:1-2' }],
} as Partial<NormalizedMessage>);

const historyOf = (messages: NormalizedMessage[]) => ({
  ok: true,
  json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
});

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue(historyOf([USER_ROW]));
});

afterEach(() => {
  vi.resetModules();
});

async function loadedStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer(SID, { limit: 20, offset: 0 });
  });
  return view;
}

const assistantRows = (rows: NormalizedMessage[]) =>
  rows.filter((row) => row.kind !== 'text' || row.role !== 'user');

describe('the row a turn is streamed into', () => {
  it('is one row under one id from its first delta to the refresh that persists it', async () => {
    const view = await loadedStore();

    act(() => { view.result.current.updateStreaming(SID, 'he', 'claude'); });
    const firstDelta = assistantRows(view.result.current.getMessages(SID));
    assert.equal(firstDelta.length, 1, 'the turn must be one row while it streams');
    const liveId = firstDelta[0].id;
    assert.match(String(liveId), /^live:/, 'the client mints its own row id for the turn');

    // The same turn, one flush later: the text and the timestamp are re-minted,
    // the identity is not.
    act(() => { view.result.current.updateStreaming(SID, REPLY, 'claude'); });
    const secondDelta = assistantRows(view.result.current.getMessages(SID));
    assert.equal(secondDelta.length, 1, 'a flush must not add a second row for the turn');
    assert.equal(secondDelta[0].id, liveId, 'a flush must not re-mint the row id');

    // The server's own frame for the reply, arriving while the turn is still in
    // flight. The pair collapse into the client's row: one bubble, and the
    // echo's fields on it — it is the persisted record — but not its id.
    act(() => { view.result.current.appendRealtime(SID, SERVER_ECHO); });
    const echoed = assistantRows(view.result.current.getMessages(SID));
    assert.equal(echoed.length, 1, 'the server echo must not render beside the client row');
    assert.equal(echoed[0].id, liveId, 'the server echo must not take the turn\'s identity');
    assert.equal(
      echoed[0].kind,
      'stream_delta',
      'the echo must not settle a row whose own turn is still streaming',
    );

    // `stream_end`: the last flush, then the settle. This is the frame the row
    // used to be handed over on, and the fields go with the handover — the row
    // keeps the identity, the persisted record supplies everything else.
    act(() => { view.result.current.updateStreaming(SID, REPLY, 'claude'); });
    act(() => { view.result.current.finalizeStreaming(SID); });
    const settled = assistantRows(view.result.current.getMessages(SID));
    assert.equal(settled.length, 1, 'the settle must not add a row');
    assert.equal(settled[0].id, liveId, 'the settle must not re-mint the row id');
    assert.equal(settled[0].kind, 'text', 'the settle must stop the row being a stream');
    assert.deepEqual(
      settled[0].memoryCitations,
      SERVER_ECHO.memoryCitations,
      'the persisted record\'s own fields must still win',
    );

    // `complete` refreshes the persisted tail. The realtime row is not pruned
    // out from under the reply, and the echo that arrives with the refresh is
    // collapsed into it rather than over it.
    sessionMessages.mockResolvedValue(historyOf([USER_ROW, SERVER_ECHO]));
    await act(async () => {
      await view.result.current.refreshLatestFromServer(SID, { limit: 20 });
    });
    const refreshed = assistantRows(view.result.current.getMessages(SID));
    assert.equal(refreshed.length, 1, 'the refresh must not double the reply');
    assert.equal(refreshed[0].id, liveId, 'the refresh must not take the turn\'s identity');
  });

  it('gives the next turn a row of its own instead of streaming into the settled one', async () => {
    const view = await loadedStore();

    act(() => { view.result.current.updateStreaming(SID, REPLY, 'claude'); });
    const firstTurnId = assistantRows(view.result.current.getMessages(SID))[0].id;
    act(() => { view.result.current.finalizeStreaming(SID); });

    act(() => { view.result.current.updateStreaming(SID, 'second reply', 'claude'); });
    const rows = assistantRows(view.result.current.getMessages(SID));
    assert.equal(rows.length, 2, 'the second turn is a second row');
    assert.equal(rows[0].id, firstTurnId, 'the settled reply keeps the identity it settled with');
    assert.equal(rows[0].content, REPLY, 'the settled reply must survive the next turn');
    assert.notEqual(rows[1].id, firstTurnId, 'the second turn must not reuse the settled row');
  });
});

/**
 * The row id above is the store's identity for a turn; the *transcript's* key is
 * a different thing (`getIntrinsicMessageKey` over the projected `ChatMessage`),
 * and for a block-keyed turn it has to stay the same across the three states the
 * store passes a block through:
 *
 *   1. streaming  — the live row, under the client's own `live:…` id;
 *   2. settled    — the same row after the server's `text` frame replaced it, so
 *                   it now carries the server's `<uuid>_0` id;
 *   3. persisted  — the row a refresh brings in under that same server id, with
 *                   the block key carried onto it by the store's reconciliation.
 *
 * A key that changes between any two of these is an unmount followed by a mount
 * on a pane pinned to the bottom — the scroll jump this whole change exists to
 * stop. The block key is the only field common to all three, so it is asserted
 * directly rather than inferred from the row ids, which are *meant* to differ.
 */
describe('the key the transcript derives for a block-keyed turn', () => {
  const BLOCK = 'msg-9:0';
  const BLOCK_STREAM_AT = '2026-01-01T00:00:02.000Z';
  const BLOCK_ECHO = msg({
    ...SERVER_ECHO,
    blockKey: BLOCK,
  });

  it('is the same while streaming, after the settled frame replaces it, and after the refresh', async () => {
    const { normalizedToChatMessages } = await import('@/modules/chat/hooks/useChatMessages');
    const { getIntrinsicMessageKey } = await import('@/modules/chat/utils/transcript');
    const view = await loadedStore();
    const store = view.result.current;

    const keyOfOnlyAssistantRow = (): string | null => {
      const converted = normalizedToChatMessages(store.getMessages(SID));
      const assistant = converted.filter((message) => message.type === 'assistant');
      assert.equal(assistant.length, 1, 'the turn must be one assistant row at every state');
      return getIntrinsicMessageKey(assistant[0]);
    };

    // 1. streaming.
    act(() => {
      store.updateStreaming(SID, 'he', 'claude', { blockKey: BLOCK, timestamp: BLOCK_STREAM_AT });
    });
    const streamingKey = keyOfOnlyAssistantRow();
    assert.ok(streamingKey, 'the transcript must be able to key the row');

    // 2. the settled frame for the block replaces the live row in place.
    act(() => { store.appendRealtime(SID, BLOCK_ECHO); });
    assert.equal(
      assistantRows(store.getMessages(SID))[0].id,
      SERVER_ECHO.id,
      'the settled frame is the row\'s identity from here on',
    );
    assert.equal(keyOfOnlyAssistantRow(), streamingKey, 'settling must not re-key the row');

    // 3. the refresh brings the persisted row in under that id, without a key of
    //    its own — the store carries the block onto it.
    sessionMessages.mockResolvedValue(historyOf([USER_ROW, SERVER_ECHO]));
    await act(async () => {
      await store.refreshLatestFromServer(SID, { limit: 20 });
    });
    assert.equal(keyOfOnlyAssistantRow(), streamingKey, 'the refresh must not re-key the row');
  });
});
