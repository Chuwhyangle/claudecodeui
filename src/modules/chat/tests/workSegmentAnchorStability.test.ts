import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { ChatMessage, NormalizedMessage, WorkSegment, WorkSegmentListItem } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/transcript/messageKeys';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/transcript/workSegments';
import { mergeOlderServerPage } from '@/modules/chat/utils/session/sessionMessagePagination';

/**
 * AC-205: a work segment's anchor is its FIRST member's intrinsic key, and
 * nothing the streaming tail does may re-mint it.
 *
 * The anchor is the same key the transcript binds a segment's identity to
 * (AC-202's `groupWorkSegments` mints `segment.key` from
 * `getIntrinsicMessageKey(firstMember)`, and AC-204's panel addresses a segment
 * by exactly that key with `data-work-segment-key`), so the readings below
 * consume the shipped identity rather than a second copy computed in the test.
 * The expanded set — `expandedAnchors`, the same shape as the panel's
 * `expandedSegmentKeys` — is keyed by that anchor, which is what makes a stable
 * anchor equivalent to a stable expansion.
 *
 * Two growth directions are pinned as documented behaviour rather than as
 * defects (GOAL-016 §"已知不等价点与限制"):
 *
 *   (a) head growth — an older page prepended to a window whose top was the
 *       first thing loaded. The prepended rows join the top run, so the run's
 *       first member changes and its anchor (and expansion) is lost. Driven
 *       through the shipped `mergeOlderServerPage`.
 *
 *   (b) a folded terminator echo — the client's realtime copy of a reply the
 *       server already holds in the same turn sits between two runs. The
 *       store's assistant-echo reconciliation prunes that realtime copy, the
 *       two runs become adjacent, and the second run's anchor (and expansion)
 *       is lost. Driven through `useSessionStore`'s public methods, never a
 *       dedup re-implemented here.
 *
 * Both boundaries are asserted as "it really is dropped" — the old anchor is
 * gone from the current anchor set — each with a local positive control (a
 * segment the fold does not touch keeps its anchor and stays expanded), so a
 * constant "everything is lost" assertion cannot stand in for the reading.
 */

//------------------------- fixtures --------------------------------

/** A rendered transcript row with a stable identity field, so its key is the identity branch and not the content preview. */
const chatRow = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: id,
  timestamp: '2026-10-02T12:00:00.000Z',
  id,
  blockKey: `block-${id}`,
  ...overrides,
});

const chatTool = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage =>
  chatRow(id, { isToolUse: true, toolName: 'Read', toolId: id, ...overrides });

const chatThinking = (id: string): ChatMessage => chatRow(id, { isThinking: true });

const normTs = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

const normTool = (id: string, second: number): NormalizedMessage => ({
  id,
  provider: 'claude',
  sessionId: 'session-1',
  kind: 'tool_use',
  toolName: 'Read',
  toolId: id,
  blockKey: `block-${id}`,
  timestamp: normTs(second),
});

const normText = (id: string, content: string, second: number): NormalizedMessage => ({
  id,
  provider: 'claude',
  sessionId: 'session-1',
  kind: 'text',
  role: 'assistant',
  content,
  blockKey: `block-${id}`,
  timestamp: normTs(second),
});

const normUser = (id: string, second: number): NormalizedMessage => ({
  id,
  provider: 'claude',
  sessionId: 'session-1',
  kind: 'text',
  role: 'user',
  content: `prompt ${id}`,
  timestamp: normTs(second),
});

/** The selected entries' work segments, in transcript order. */
const segmentsOf = (items: WorkSegmentListItem[]): WorkSegment[] => items.filter(isWorkSegment);

/** The selected entries' segment anchors, as the set the expansion state is keyed by. */
const anchorSet = (items: WorkSegmentListItem[]): Set<string> => {
  const anchors = new Set<string>();
  for (const segment of segmentsOf(items)) {
    if (segment.key) anchors.add(segment.key);
  }
  return anchors;
};

/**
 * The one segment whose first member is `id`, or undefined when no run starts
 * there. Members are matched on `toolId` first: a server row projected by
 * `normalizedToChatMessages` deliberately carries no `id` (only the client's own
 * live rows do), so the tool id is what identifies it across that projection.
 */
const segmentStartingAt = (items: WorkSegmentListItem[], id: string): WorkSegment | undefined =>
  segmentsOf(items).find((segment) => (segment.messages[0]?.toolId ?? segment.messages[0]?.id) === id);

const idsOf = (segment: WorkSegment): string[] =>
  segment.messages.map((message) => message.toolId ?? message.id ?? '');

//------------------------- reading (i): tail growth ----------------

test("the tail segment keeps its anchor while members stream into its tail", () => {
  // A sibling run, a non-member terminator, then the run whose tail will grow.
  const sibling = [chatTool('a1'), chatTool('a2')];
  const terminator = chatRow('boundary', { content: 'a reply that ends the run' });
  let tail: ChatMessage[] = [chatThinking('t1'), chatTool('t2')];

  const evaluate = (): WorkSegmentListItem[] => groupWorkSegments([...sibling, terminator, ...tail]);

  const initial = evaluate();
  const tailSegment = segmentStartingAt(initial, 't1');
  const siblingSegment = segmentStartingAt(initial, 'a1');
  assert.ok(tailSegment, 'the tail run must already be a segment before it grows');
  assert.ok(siblingSegment, 'the sibling run must be a segment');

  const tailAnchor = tailSegment.key;
  assert.ok(tailAnchor, "the tail segment's first member must yield an anchor");
  assert.ok(siblingSegment.key);
  assert.notEqual(
    tailAnchor,
    siblingSegment.key,
    'the two segments must have distinct anchors for the control to mean anything',
  );

  // What the panel holds: the anchors of the segments the reader expanded.
  const expandedAnchors = new Set<string>([tailAnchor, siblingSegment.key]);

  const appended: ChatMessage[] = [chatThinking('t3'), chatTool('t4'), chatThinking('t5')];
  for (let round = 0; round < appended.length; round++) {
    tail = [...tail, appended[round]];
    // Streaming the tail row's own text grows the tail too; membership is by
    // row type, so this must not move the anchor either.
    tail = tail.map((message, index) =>
      index === tail.length - 1
        ? { ...message, content: `streamed-${round}-${'x'.repeat(round + 1)}` }
        : message,
    );

    const items = evaluate();
    const grownTail = segmentStartingAt(items, 't1');
    const untouchedSibling = segmentStartingAt(items, 'a1');
    assert.ok(grownTail && untouchedSibling);
    assert.deepEqual(
      idsOf(grownTail),
      ['t1', 't2', ...appended.slice(0, round + 1).map((message) => message.id ?? '')],
      'the tail segment must take every appended member and keep its order',
    );

    assert.equal(
      grownTail.key,
      tailAnchor,
      `append #${round + 1} must not re-mint the tail anchor`,
    );
    assert.equal(
      expandedAnchors.has(grownTail.key ?? ''),
      true,
      `append #${round + 1} must leave the expanded tail segment expanded`,
    );

    // Local positive control: the sibling run is not grown, so its anchor is
    // unchanged and still expanded — the reading is not a constant "all lost".
    assert.equal(untouchedSibling.key, siblingSegment.key, 'the sibling anchor must not move');
    assert.equal(expandedAnchors.has(untouchedSibling.key ?? ''), true);
    assert.notEqual(grownTail.key, untouchedSibling.key);
  }
});

//------------------------- reading (ii): anchor identity -----------

test("the anchor is the first member's intrinsic key", () => {
  const first = chatTool('t1');

  // Same first member, different counts and different orders of what follows.
  const variants: ChatMessage[][] = [
    [first, chatTool('t2')],
    [first, chatTool('t3'), chatThinking('t4')],
    [first, chatThinking('t5'), chatTool('t6'), chatThinking('t7')],
  ];

  for (const members of variants) {
    const segment = segmentStartingAt(groupWorkSegments(members), 't1');
    assert.ok(segment);
    assert.equal(segment.messages[0], first, 'the first member must be the one supplied');
    assert.equal(
      segment.key,
      getIntrinsicMessageKey(segment.messages[0]),
      "the anchor must be the first member's intrinsic key",
    );
    assert.equal(segment.key, getIntrinsicMessageKey(first));
  }

  // (d) Positive control: the first member carries a stable identity field, so
  // `getIntrinsicMessageKey` takes the identity branch — the anchor is not the
  // content-preview fallback, which would make (ii) content-sensitive and so
  // empty. Strip every identity field and the key becomes content-derived.
  assert.ok(
    first.blockKey || first.id || first.toolId,
    'the fixture first member must carry a stable identity field',
  );
  assert.equal(
    getIntrinsicMessageKey({ ...first, content: 'the first member text has been rewritten' }),
    getIntrinsicMessageKey(first),
    'the anchor must not depend on the first member text while an identity field exists',
  );
  const identityStripped: ChatMessage = {
    ...first,
    blockKey: undefined,
    id: undefined,
    toolId: undefined,
  };
  assert.notEqual(
    getIntrinsicMessageKey({ ...identityStripped, content: 'text one' }),
    getIntrinsicMessageKey({ ...identityStripped, content: 'text two' }),
    'without an identity field the key is content-derived — which is what the fixture avoids',
  );
});

//------------------------- boundary (a): head growth ---------------

test('loading an older page re-anchors the top segment and loses its expansion', () => {
  // The cached window: a top run, a terminator, then a lower run.
  const top = [normTool('top1', 10), normTool('top2', 11)];
  const terminator = normText('mid', 'done', 12);
  const lower = [normTool('low1', 13), normTool('low2', 14)];
  const cached: NormalizedMessage[] = [...top, terminator, ...lower];

  // An older page whose tail member is adjacent to the top segment's first
  // member — no terminator between them — and that shares no row with the cache.
  const older: NormalizedMessage[] = [normTool('old1', 1), normTool('old2', 2)];

  const beforeItems = groupWorkSegments(normalizedToChatMessages(cached));
  const topBefore = segmentStartingAt(beforeItems, 'top1');
  const lowBefore = segmentStartingAt(beforeItems, 'low1');
  assert.ok(topBefore && lowBefore, 'the cached window must hold two segments');
  assert.ok(topBefore.key && lowBefore.key);
  assert.notEqual(topBefore.key, lowBefore.key);

  const expandedAnchors = new Set<string>([topBefore.key, lowBefore.key]);

  const merged = mergeOlderServerPage(cached, older);
  assert.equal(merged.prependedCount, 2, 'the older page must prepend both of its rows');

  const afterItems = groupWorkSegments(normalizedToChatMessages(merged.messages));
  const topAfter = segmentStartingAt(afterItems, 'old1');
  const lowAfter = segmentStartingAt(afterItems, 'low1');
  assert.ok(topAfter && lowAfter);

  // The prepended tail joins the top run: the two rows are one run of four.
  assert.deepEqual(
    idsOf(topAfter),
    ['old1', 'old2', 'top1', 'top2'],
    'the older rows must join the top run into one segment',
  );

  // (a) The top segment re-anchored...
  assert.notEqual(topAfter.key, topBefore.key, 'the top segment must re-anchor onto the older row');
  assert.equal(topAfter.key, getIntrinsicMessageKey(topAfter.messages[0]));
  assert.equal(topAfter.key, 'message-assistant-block-old1');

  // (b) ...so its old anchor is gone from the current set: the expansion is lost.
  const afterAnchors = anchorSet(afterItems);
  assert.equal(
    afterAnchors.has(topBefore.key),
    false,
    'the old top anchor must no longer be present — the expansion really is dropped',
  );
  assert.equal(expandedAnchors.has(topAfter.key ?? ''), false);

  // (c) Local positive control: the lower run was not touched, so its anchor is
  // unchanged and still expanded.
  assert.equal(lowAfter.key, lowBefore.key, 'the lower segment must not re-anchor');
  assert.equal(afterAnchors.has(lowBefore.key), true);
  assert.equal(expandedAnchors.has(lowBefore.key), true);
});

//------------------------- boundary (b): folded terminator echo ----

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SID = 'session-1';

const historyOf = (messages: NormalizedMessage[]) => ({
  ok: true,
  json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
});

beforeEach(() => {
  sessionMessages.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

async function loadedStore(initial: NormalizedMessage[]) {
  sessionMessages.mockResolvedValue(historyOf(initial));
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer(SID, { limit: 20, offset: 0 });
  });
  return view;
}

async function refreshFromServer(
  view: Awaited<ReturnType<typeof loadedStore>>,
  messages: NormalizedMessage[],
) {
  sessionMessages.mockResolvedValue(historyOf(messages));
  await act(async () => {
    await view.result.current.fetchFromServer(SID, { limit: 20, offset: 0 });
  });
}

test("echo dedup folds the terminator and loses the second segment's expansion", async () => {
  // One user turn holds two work runs and the reply that ends the turn. The
  // reply's persisted row sits after both runs; a second run follows in the
  // next turn, untouched, as the control.
  const server: NormalizedMessage[] = [
    normUser('u1', 0),
    normTool('a1', 1),
    normTool('a2', 2),
    normTool('b1', 4),
    normTool('b2', 5),
    normText('s1', 'reply', 6),
    normUser('u2', 7),
    normTool('c1', 8),
    normTool('c2', 9),
  ];

  const view = await loadedStore(server);

  // The client holds its own realtime copy of the same reply, dated into the gap
  // between the two runs — this is the duplicate prose row that, before the
  // fold, is the terminator between them.
  act(() => {
    view.result.current.appendRealtime(SID, normText('rt1', 'reply', 3));
  });

  const beforeMerged = view.result.current.getMessages(SID);
  const beforeItems = groupWorkSegments(normalizedToChatMessages(beforeMerged));
  const runA = segmentStartingAt(beforeItems, 'a1');
  const runB = segmentStartingAt(beforeItems, 'b1');
  const runC = segmentStartingAt(beforeItems, 'c1');

  // (a) Before the fold the fixture really is two runs with the duplicate prose
  // row between them, and that row really is the terminator that keeps them apart.
  assert.ok(runA && runB && runC, 'the fixture must yield three segments before the fold');
  assert.deepEqual(idsOf(runA), ['a1', 'a2']);
  assert.deepEqual(idsOf(runB), ['b1', 'b2']);
  assert.ok(runA.key && runB.key && runC.key);
  const betweenIndex = beforeMerged.findIndex((message) => message.id === 'rt1');
  const runAEndIndex = beforeMerged.findIndex((message) => message.id === 'a2');
  const runBStartIndex = beforeMerged.findIndex((message) => message.id === 'b1');
  assert.equal(
    betweenIndex > runAEndIndex && betweenIndex < runBStartIndex,
    true,
    'the duplicate prose row must sit between the two runs',
  );
  assert.equal(
    normalizedToChatMessages(beforeMerged)[betweenIndex]?.isToolUse ?? false,
    false,
    'the duplicate prose row must not be a work member — it is the terminator',
  );
  // It is genuinely a duplicate of a reply the same turn already holds.
  assert.equal(
    beforeMerged.filter((message) => message.kind === 'text' && message.content === 'reply').length,
    2,
    'the fixture must hold two copies of the reply before the fold',
  );

  const expandedAnchors = new Set<string>([runA.key, runB.key, runC.key]);

  // Fold the echo through the real store path — a refresh reconciles the
  // realtime copy against the persisted reply of the same turn.
  await refreshFromServer(view, server);
  const afterMerged = view.result.current.getMessages(SID);
  const afterItems = groupWorkSegments(normalizedToChatMessages(afterMerged));
  const mergedRun = segmentStartingAt(afterItems, 'a1');
  const controlRun = segmentStartingAt(afterItems, 'c1');

  // (b) The fold really happened: the duplicate is gone and the segment count is
  // one lower because the two runs became one.
  assert.equal(
    afterMerged.filter((message) => message.kind === 'text' && message.content === 'reply').length,
    1,
    'the realtime duplicate of the reply must be folded away',
  );
  assert.equal(segmentsOf(afterItems).length, 2, 'the segment count must drop by one');
  assert.ok(mergedRun, 'the two runs must merge into a single segment');
  assert.deepEqual(
    idsOf(mergedRun),
    ['a1', 'a2', 'b1', 'b2'],
    'the fold must make the two runs adjacent and merge them',
  );
  assert.equal(segmentStartingAt(afterItems, 'b1'), undefined, 'the second run must no longer be its own segment');

  // (c) The second run's old anchor is gone from the current set — its expansion
  // is dropped, and that is the documented outcome, not a thing to paper over.
  const afterAnchors = anchorSet(afterItems);
  assert.equal(
    afterAnchors.has(runB.key),
    false,
    "the second run's old anchor must no longer be present — its expansion really is lost",
  );
  assert.equal(expandedAnchors.has(runB.key), true, 'the second run was expanded before the fold');
  assert.equal(
    afterAnchors.has(runB.key),
    false,
    'the anchor it was expanded under is no longer a live anchor, so nothing matches it',
  );

  // (d) Local positive control: the third run is untouched by the fold, so its
  // anchor is unchanged and it stays expanded.
  assert.ok(controlRun);
  assert.equal(controlRun.key, runC.key, 'the untouched run must not re-anchor');
  assert.equal(afterAnchors.has(runC.key), true);
  assert.equal(expandedAnchors.has(runC.key), true);
});
