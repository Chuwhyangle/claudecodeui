import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/session/sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('a replacement echo survives a kept turn that repeats its text', () => {
  // The exact shape a rewind that branches produces: the turn that survived
  // the cut is re-stamped to the moment of the copy, one second before the
  // replacement was typed, and happens to say the same thing the user just
  // corrected their message to.
  const userRow = (id: string, content: string, timestamp: string) => ({
    id,
    kind: 'text',
    role: 'user',
    provider: 'codex',
    sessionId: 's1',
    content,
    timestamp,
  }) as NormalizedMessage;

  const kept = [userRow('kept', 'continue', '2026-01-01T00:00:21.000Z')];
  const echo = {
    ...userRow('local_1', 'continue', '2026-01-01T00:00:20.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: kept.length,
  } as NormalizedMessage;

  assert.deepEqual(removeOptimisticUserEchoes(kept, [echo]), [echo]);

  // Once the provider has written the replacement, it is a row the cut did not
  // keep, so it retires the echo.
  const persisted = [...kept, userRow('persisted', 'continue', '2026-01-01T00:00:25.000Z')];
  assert.deepEqual(removeOptimisticUserEchoes(persisted, [echo]), []);
});

test('a realtime row without a string id is passed through, not fatal', () => {
  // A control frame that carries no `id` (the server's `activity.heartbeat`)
  // reached the store. It is not this client's optimistic echo, so it is left
  // alone — and, crucially, reading its id must not throw: the exception would
  // escape `computeMerged` and freeze every later merge of the session.
  const idless = {
    id: undefined,
    sessionId: 'session-1',
    timestamp: '2026-07-28T20:30:21.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: '',
  } as unknown as NormalizedMessage;

  assert.deepEqual(removeOptimisticUserEchoes([], [idless]), [idless]);

  // Control: the same shape carrying a `local_` id is still reconciled — the
  // pass-through above is the absent id, not a filter that stopped matching.
  const localEcho = createUserMessage('local_echo', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_echo', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });
  assert.deepEqual(removeOptimisticUserEchoes([persisted], [localEcho]), []);
});

test('a retried send is retired by the persisted echo the socket delivers', () => {
  // The shape a failed send and its retry produce: the optimistic row is minted
  // at the first (never-delivered) attempt, and the persisted echo of the
  // accepted retry arrives as a *realtime* row — pushed over the socket before
  // the REST history page carries it. Only the persisted row may remain; drawn
  // side by side, the same message twice is exactly what a retry must not do.
  const local = createUserMessage('local_retry', '2026-10-02T09:50:24.375Z', {
    content: 'the retried text',
  });
  const socketEcho = createUserMessage('6915f537_text_0', '2026-10-02T09:50:25.655Z', {
    content: 'the retried text',
  });

  assert.deepEqual(removeOptimisticUserEchoes([], [local, socketEcho]), [socketEcho]);
});

test('two real same-text sends with one persisted echo keep the unpaired row', () => {
  // One-to-one, and it holds across both candidate lists: a persisted echo
  // retires exactly one optimistic row. The second genuine send of the same
  // words — a different message the user actually sent — has no echo of its own
  // and must survive, or a legitimate repeat would silently disappear. The echo
  // here is in the realtime list, so this also proves a local row is never
  // retired by another local row.
  const firstLocal = createUserMessage('local_first', '2026-10-02T09:50:24.000Z', {
    content: 'ok',
  });
  const secondLocal = createUserMessage('local_second', '2026-10-02T09:50:26.000Z', {
    content: 'ok',
  });
  const persisted = createUserMessage('claude_first', '2026-10-02T09:50:24.500Z', {
    content: 'ok',
  });

  assert.deepEqual(
    removeOptimisticUserEchoes([], [firstLocal, secondLocal, persisted]),
    [secondLocal, persisted],
  );
});

/**
 * The floor an edited echo carries is an absolute history subscript, while
 * `serverMessages` is only the window the client currently holds. These cases
 * pin the translation: the same absolute floor means different page indices
 * depending on where the window starts.
 */
test('retires an edited echo whose absolute floor is inside a shifted window', () => {
  const windowStart = 18;
  const absoluteFloor = 36;

  // A twenty-row page starting at absolute 18. The persisted replacement sits
  // at absolute 36 — page index 18 — which is where the floor starts looking.
  const page = Array.from({ length: 20 }, (_, offset) => createUserMessage(
    `server_${windowStart + offset}`,
    new Date(Date.UTC(2026, 9, 2, 9, 50, offset)).toISOString(),
    { content: windowStart + offset === absoluteFloor ? 'edited text' : `turn ${windowStart + offset}` },
  ));
  const echo = createUserMessage('local_edited', '2026-10-02T09:50:17.500Z', {
    content: 'edited text',
    replacesAnchorId: 'u-cut',
    replacesAfterRowCount: absoluteFloor,
  });

  assert.equal(page[absoluteFloor - windowStart]?.content, 'edited text');
  assert.deepEqual(removeOptimisticUserEchoes(page, [echo], windowStart), []);
});

test('keeps an edited echo whose absolute floor is past the window', () => {
  const windowStart = 18;
  const absoluteFloor = 50;

  // Same page, but the cut happened after every row the window holds: the
  // translated floor (50 - 18 = 32) is past the end, so the look-alike row in
  // the page must not be mistaken for the persisted replacement.
  const page = Array.from({ length: 20 }, (_, offset) => createUserMessage(
    `server_${windowStart + offset}`,
    new Date(Date.UTC(2026, 9, 2, 9, 50, offset)).toISOString(),
    { content: windowStart + offset === 36 ? 'edited text' : `turn ${windowStart + offset}` },
  ));
  const echo = createUserMessage('local_edited', '2026-10-02T09:50:17.500Z', {
    content: 'edited text',
    replacesAnchorId: 'u-cut',
    replacesAfterRowCount: absoluteFloor,
  });

  assert.deepEqual(removeOptimisticUserEchoes(page, [echo], windowStart), [echo]);
});
