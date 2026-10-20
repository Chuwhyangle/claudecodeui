import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ChatMessage, WorkSegmentListItem } from '@/shared/types';
import {
  RESIDENT_PENDING_MESSAGE_TYPE,
  UNATTENDED_DIVIDER_MESSAGE_TYPE,
} from '@/modules/chat/hooks/useChatMessages';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/transcript/messageKeys';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/transcript/workSegments';

/**
 * AC-202: the work-segment selector's boundaries are a pure function of a row's
 * type, and they do not move while the tail of a run streams in. Every row here
 * carries a stable `blockKey`, so the keys these cases compare are the rows'
 * identities rather than anything derived from their text.
 */

const row = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: id,
  timestamp: '2026-10-02T12:00:00.000Z',
  id,
  blockKey: `block-${id}`,
  ...overrides,
});

const thinking = (id: string, content = `thinking ${id}`): ChatMessage =>
  row(id, { isThinking: true, content });

const tool = (id: string, toolName = 'Read', content = `tool ${id}`): ChatMessage =>
  row(id, { isToolUse: true, toolName, content });

/** The ids of each segment's members, in order — one entry per selected segment. */
const memberIdRuns = (items: WorkSegmentListItem[]): string[][] =>
  items.filter(isWorkSegment).map((segment) => segment.messages.map((message) => message.id ?? ''));

/** Each segment's start-to-end sequence of member keys; the boundary reading AC5 compares. */
const boundarySignature = (items: WorkSegmentListItem[]): (string | null)[][] =>
  items
    .filter(isWorkSegment)
    .map((segment) => segment.messages.map((message) => getIntrinsicMessageKey(message)));

test('empty content does not move boundaries: a tool row with empty prose stays a member', () => {
  const items = groupWorkSegments([
    tool('a', 'Read', ''),
    thinking('b', ''),
    tool('c', 'Read', ''),
  ]);

  assert.equal(items.length, 1, 'a run must not be split by its own not-yet-arrived prose');
  assert.deepEqual(memberIdRuns(items), [['a', 'b', 'c']]);
});

test('empty content does not move boundaries: an empty body row still terminates the segment', () => {
  const before = tool('a', 'Read');
  const emptyBody = row('b', { content: '' });
  const after = tool('c', 'Read');

  const items = groupWorkSegments([before, emptyBody, after]);

  assert.equal(items.length, 3, 'an empty body row must not be crossed over');
  assert.equal(items[0], before);
  assert.equal(items[1], emptyBody);
  assert.equal(items[2], after);
});

test('same-name tool calls stay N members', () => {
  const calls = [
    tool('a', 'Bash'),
    tool('b', 'Bash'),
    tool('c', 'Bash'),
    tool('d', 'Bash'),
  ];

  const items = groupWorkSegments(calls);

  assert.deepEqual(memberIdRuns(items), [['a', 'b', 'c', 'd']]);
  assert.equal(
    items.filter((item) => '_isGroup' in item).length,
    0,
    'the selector must not fold same-name calls into an xN group',
  );
});

test('single-member run is not wrapped', () => {
  const before = row('x', { content: 'before' });
  const loneTool = tool('a', 'Read');
  const after = row('y', { content: 'after' });

  const items = groupWorkSegments([before, loneTool, after]);

  assert.equal(items.length, 3);
  assert.equal(items[0], before);
  assert.equal(items[1], loneTool, 'a lone tool row must be emitted as itself');
  assert.equal(items[2], after);
  assert.equal(items.filter(isWorkSegment).length, 0);
});

test('boundaries are stable while the tail text streams in', () => {
  const leading = [tool('a', 'Read'), tool('b', 'Read')];
  const tailBefore = thinking('tail', '');
  const tailAfter = thinking('tail', 'the tail text has arrived');

  const before = groupWorkSegments([...leading, tailBefore]);
  const after = groupWorkSegments([...leading, tailAfter]);

  assert.deepEqual(
    boundarySignature(before),
    boundarySignature(after),
    'a member’s content must not participate in boundary selection',
  );
  assert.deepEqual(boundarySignature(before), [
    [
      getIntrinsicMessageKey(leading[0]),
      getIntrinsicMessageKey(leading[1]),
      getIntrinsicMessageKey(tailBefore),
    ],
  ]);
});

function assertStructuralRowTerminates(structural: ChatMessage, label: string): void {
  const items = groupWorkSegments([
    tool('a', 'Read'),
    tool('b', 'Read'),
    structural,
    tool('c', 'Read'),
    tool('d', 'Read'),
  ]);

  assert.equal(items.length, 3, `${label} must be emitted as its own entry`);
  assert.equal(items[1], structural, `${label} must not be absorbed into a segment`);
  assert.deepEqual(
    memberIdRuns(items),
    [['a', 'b'], ['c', 'd']],
    `${label} must terminate the run`,
  );
}

test('structural rows terminate the segment: a user row', () => {
  assertStructuralRowTerminates(row('u', { type: 'user', content: 'hello' }), 'a user row');
});

test('structural rows terminate the segment: an unattended divider', () => {
  assertStructuralRowTerminates(
    row('divider', { type: UNATTENDED_DIVIDER_MESSAGE_TYPE, content: '' }),
    'an unattended divider',
  );
});

test('structural rows terminate the segment: a compaction row', () => {
  assertStructuralRowTerminates(
    row('summary', { isCompactSummary: true, content: 'summary' }),
    'a compaction summary row',
  );
  assertStructuralRowTerminates(
    row('compact', { compact: { phase: 'done' }, compactSummary: 'summary' }),
    'a compaction boundary row',
  );
});

test('a task notification row is a member, not a boundary', () => {
  // A background shell's terminal line lands behind the card that launched it.
  // While it was a boundary it cut that run in two — the reader saw the card's
  // header float free of its command — so it is absorbed like the work rows it
  // sits between, and the run stays whole.
  const before = tool('a', 'Bash');
  const notification = row('notification', { isTaskNotification: true, content: 'completed: sleep 25' });
  const after = tool('c', 'Bash');

  const items = groupWorkSegments([before, notification, after]);

  assert.deepEqual(memberIdRuns(items), [['a', 'notification', 'c']], 'the run is one three-member segment');
  assert.equal(items.length, 1, 'the notification must not split the run');
  assert.equal(items.filter(isWorkSegment)[0]?.messages.length, 3, 'the segment holds all three rows');
});

test('a task notification row on its own is still emitted as itself', () => {
  // Membership must not invent a segment around a lone notification: a run of
  // one member is emitted as that member, exactly as a lone tool row is.
  const notification = row('notification', { isTaskNotification: true, content: 'completed: sleep 25' });
  const items = groupWorkSegments([row('body', { content: 'before' }), notification, row('after', { content: 'after' })]);

  assert.equal(items.length, 3);
  assert.equal(items[1], notification, 'a lone notification must be emitted as itself');
  assert.equal(items.filter(isWorkSegment).length, 0);
});

test('structural rows terminate the segment: a resident pending row', () => {
  assertStructuralRowTerminates(
    row('pending', { type: RESIDENT_PENDING_MESSAGE_TYPE, content: 'queued' }),
    'a resident pending row',
  );
});
