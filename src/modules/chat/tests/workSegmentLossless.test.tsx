import assert from 'node:assert/strict';

import { Fragment } from 'react';
import { render } from '@testing-library/react';
import { test } from 'vitest';

import type { ChatMessage, WorkSegment, WorkSegmentListItem } from '@/shared/types';
import WorkSegmentRecord from '@/modules/chat/transcript/WorkSegmentRecord';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/transcript/messageKeys';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/transcript/workSegments';

/**
 * AC-203: a work segment's collapsed state may hide its rows but must not lose
 * any of them.
 *
 * The reading is SET EQUALITY, not a count and not text: the keys of the rows the
 * transcript mounts with every segment expanded must equal, key for key, the keys
 * of the rows the fixture was built from. `renderMember` writes a row's intrinsic
 * key into the DOM, so "mounted" is a DOM fact rather than an internal call tally,
 * and a segment header that invented a key, or a member that went missing, shows
 * up as a non-empty set difference.
 */

const row = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: id,
  timestamp: '2026-10-02T12:00:00.000Z',
  id,
  blockKey: `block-${id}`,
  ...overrides,
});

const thinkingRow = (id: string): ChatMessage =>
  row(id, { isThinking: true, content: `thinking ${id}` });
const toolRow = (id: string): ChatMessage =>
  row(id, { isToolUse: true, toolName: 'Read', content: `tool ${id}` });
const subagentRow = (id: string): ChatMessage =>
  row(id, { isSubagentContainer: true, content: `agent ${id}` });

/** Renders a row's intrinsic key into the DOM so a mounted row can be collected by query. */
const renderMember = (message: ChatMessage, index: number) => (
  <div data-message-key={getIntrinsicMessageKey(message) ?? `unkeyed-${index}`}>
    {message.content ?? ''}
  </div>
);

/** The intrinsic keys of every row actually mounted under `container`, in DOM order. */
const mountedKeys = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('[data-message-key]'))
    .map((node) => node.getAttribute('data-message-key'))
    .filter((key): key is string => key !== null);

const sortedKeys = (keys: (string | null)[]): string[] =>
  keys.filter((key): key is string => key !== null).sort();

/**
 * A body row, four work rows (thinking, tool, subagent container, thinking), and
 * a closing body row. `groupWorkSegments` absorbs only the middle four, and the
 * non-member rows on either side give the case its both-ends boundary.
 */
const fixture: ChatMessage[] = [
  row('u1', { type: 'user', content: 'do the thing' }),
  thinkingRow('k1'),
  toolRow('k2'),
  subagentRow('k3'),
  thinkingRow('k4'),
  row('a1', { content: 'done' }),
];

const fixtureKeys = sortedKeys(fixture.map(getIntrinsicMessageKey));
const segmentItems = groupWorkSegments(fixture);

/** Draws every selected entry: non-segment rows as themselves, segments through the record under test. */
function Transcript({ items, expanded }: { items: WorkSegmentListItem[]; expanded: boolean }) {
  return (
    <div>
      {items.map((item, index) =>
        isWorkSegment(item) ? (
          <WorkSegmentRecord
            key={`segment-${index}`}
            segment={item}
            expanded={expanded}
            renderMember={renderMember}
          />
        ) : (
          <Fragment key={`row-${index}`}>{renderMember(item, index)}</Fragment>
        ),
      )}
    </div>
  );
}

test('fixture actually exercises a multi-member segment', () => {
  const segments = segmentItems.filter(isWorkSegment);
  assert.equal(segments.length, 1, 'the fixture must select exactly one work segment');

  const segment = segments[0];
  assert.ok(segment.messages.length >= 3, 'the segment must have at least three members');
  assert.ok(
    segment.messages.some((message) => message.isThinking),
    'the segment must contain a thinking row',
  );
  assert.ok(
    segment.messages.some((message) => message.isToolUse),
    'the segment must contain a tool-call row',
  );
  assert.ok(
    segment.messages.some((message) => message.isSubagentContainer),
    'the segment must contain a subagent container row',
  );

  const segmentIndex = segmentItems.findIndex(isWorkSegment);
  assert.equal(segmentIndex, 1, 'a non-member row must precede the segment');
  assert.equal(segmentItems.length, 3, 'a non-member row must follow the segment');
});

test('expanded segments render every pre-merge key', () => {
  const { container } = render(<Transcript items={segmentItems} expanded />);

  assert.deepEqual(
    sortedKeys(mountedKeys(container)),
    fixtureKeys,
    'with every segment expanded, the mounted keys must equal the pre-merge fixture keys — no key invented, none dropped',
  );
});

test('collapse hides but does not consume', () => {
  const segment = segmentItems.find(isWorkSegment);
  assert.ok(segment, 'the fixture must yield a work segment');
  const memberKeys = sortedKeys(segment.messages.map(getIntrinsicMessageKey));

  const collapsed = render(
    <WorkSegmentRecord segment={segment} expanded={false} renderMember={renderMember} />,
  );
  assert.deepEqual(
    mountedKeys(collapsed.container),
    [],
    'a collapsed segment must mount no member row at all',
  );
  const countNode = collapsed.container.querySelector('[data-work-segment-count]');
  assert.ok(countNode, 'the collapsed header must expose the member count');
  assert.equal(
    countNode.getAttribute('data-work-segment-count'),
    String(segment.messages.length),
    'the collapsed header must count the segment’s real members',
  );

  // The SAME segment object, expanded after being collapsed: a fold that rewrote
  // or consumed `segment.messages` would fail here.
  const expanded = render(
    <WorkSegmentRecord segment={segment} expanded renderMember={renderMember} />,
  );
  assert.deepEqual(
    sortedKeys(mountedKeys(expanded.container)),
    memberKeys,
    'expanding the same segment object after collapsing it must restore the same keys',
  );
  assert.deepEqual(
    sortedKeys(segment.messages.map(getIntrinsicMessageKey)),
    memberKeys,
    'collapsing must not rewrite or consume the segment members',
  );
});

test('single-member segment renders that member itself', () => {
  const lone = toolRow('lone');
  // The selector unwraps a one-member run, so this width never reaches the record
  // from `groupWorkSegments`; it is built directly to pin the record's own
  // contract for it, using the shipped `WorkSegment` type and key function.
  const segment: WorkSegment = {
    _isWorkSegment: true,
    key: getIntrinsicMessageKey(lone),
    messages: [lone],
  };

  const { container } = render(
    <WorkSegmentRecord segment={segment} expanded renderMember={renderMember} />,
  );

  const nodes = container.querySelectorAll('[data-message-key]');
  assert.equal(nodes.length, 1, 'the lone member must mount once, with no extra wrapper key');
  assert.equal(
    nodes[0].getAttribute('data-message-key'),
    getIntrinsicMessageKey(lone),
    'the mounted row must be the lone member under its own key',
  );
});
