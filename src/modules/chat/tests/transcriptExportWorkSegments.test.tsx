import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ChatMessage, WorkSegmentListItem } from '@/shared/types';
import { buildTranscriptExport } from '@/modules/chat/utils/transcript/chatExport';
import { createCachedDiffCalculator } from '@/modules/chat/utils/transcript/messageTransforms';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/transcript/messageKeys';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/transcript/workSegments';

/**
 * AC-206: the HTML export must keep every row the transcript had, even though
 * the work-segment layer groups its work rows.
 *
 * The reading is SET EQUALITY against the real export chain, not a count and not
 * a text search: `buildTranscriptExport('html', …)` renders the shipped
 * `TranscriptExportDocument`, every row it actually draws publishes its own
 * `getIntrinsicMessageKey` as `data-message-key`, and the set of those values is
 * compared key for key with the keys of the messages the fixture was built from.
 * A segment that stayed collapsed (its members withheld from the static render)
 * is a non-empty set difference; a segment header that invented a key is a value
 * outside the fixture's set.
 *
 * The fixture is one multi-member run of work rows (a thinking row and two tool
 * calls) between two ordinary rows, plus a lone tool row further down so the
 * "a one-member run is emitted unwrapped" path is drawn once as well. Every row
 * carries a `blockKey`, so the keys compared are the rows' identities rather
 * than the `content-preview` fallback at the end of `getIntrinsicMessageKey`.
 */

const createDiff = createCachedDiffCalculator();
const exportedAt = new Date('2026-10-02T12:30:00.000Z');

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
const toolRow = (id: string, toolName = 'Read'): ChatMessage =>
  row(id, { isToolUse: true, toolName, content: `tool ${id}` });

const fixture: ChatMessage[] = [
  row('u1', { type: 'user', content: 'do the thing' }),
  thinkingRow('k1'),
  toolRow('k2'),
  toolRow('k3', 'Edit'),
  row('a1', { content: 'one step done' }),
  toolRow('k4'),
  row('a2', { content: 'all done' }),
];

const input = {
  messages: fixture,
  sessionTitle: 'Work segment export',
  provider: 'claude' as const,
  createDiff,
};

const sortedKeys = (keys: (string | null)[]): string[] =>
  keys.filter((key): key is string => key !== null).sort();

const fixtureKeys = sortedKeys(fixture.map(getIntrinsicMessageKey));

/** Parses the exported document string so rows can be selected by their DOM attribute. */
const parseHtml = (html: string): HTMLElement => {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
};

/** The `data-message-key` values the exported HTML actually carries, in DOM order. */
const exportedRowKeys = (html: string): string[] =>
  Array.from(parseHtml(html).querySelectorAll('[data-message-key]'))
    .map((node) => node.getAttribute('data-message-key'))
    .filter((key): key is string => key !== null);

/** A row the selector would absorb into a work run, read from its type fields alone. */
const isWorkRow = (item: WorkSegmentListItem): boolean =>
  !isWorkSegment(item) &&
  Boolean(item.isThinking || item.isToolUse || item.isSubagentContainer);

test('the fixture actually contains a multi-member work segment', () => {
  const items = groupWorkSegments(fixture);
  const segments = items.filter(isWorkSegment);

  assert.equal(segments.length, 1, 'the fixture must select exactly one multi-member segment');
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

  // The segment must sit strictly between non-member rows: without an ordinary
  // row on each side, the run would not have both edges, and the set-equality
  // reading below could pass on a selector that folded everything.
  const segmentIndex = items.findIndex(isWorkSegment);
  assert.ok(segmentIndex > 0, 'a non-member row must precede the segment');
  assert.equal((items[segmentIndex - 1] as ChatMessage).id, 'u1');
  assert.ok(!isWorkRow(items[segmentIndex - 1]), 'the row before the segment must not be a work row');
  assert.ok(segmentIndex + 1 < items.length, 'a non-member row must follow the segment');
  assert.equal((items[segmentIndex + 1] as ChatMessage).id, 'a1');
  assert.ok(!isWorkRow(items[segmentIndex + 1]), 'the row after the segment must not be a work row');
});

test('the exported document keeps every pre-merge row key', async () => {
  const html = await buildTranscriptExport('html', input, exportedAt);
  const actual = sortedKeys(exportedRowKeys(html));

  assert.deepEqual(
    actual,
    fixtureKeys,
    'the exported rows must equal the pre-merge fixture keys — no row dropped (a non-empty set difference), no key invented',
  );

  const missing = fixtureKeys.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !fixtureKeys.includes(key));
  assert.deepEqual(missing, [], 'no pre-merge row may go missing from the export');
  assert.deepEqual(extra, [], 'the export may not carry a row key the fixture never had');
});

test('the segment header contributes no row key', async () => {
  const html = await buildTranscriptExport('html', input, exportedAt);
  const container = parseHtml(html);

  const extra = exportedRowKeys(html).filter((key) => !fixtureKeys.includes(key));
  assert.deepEqual(extra, [], 'the export may not invent a row key for a header');

  const segment = container.querySelector('[data-work-segment-count]');
  assert.ok(segment, 'the export must draw the work segment record');
  assert.equal(
    segment.hasAttribute('data-message-key'),
    false,
    'the segment record element must not carry a row key',
  );

  const header = segment.querySelector('button');
  assert.ok(header, 'the segment record must draw a header button');
  assert.equal(
    header.hasAttribute('data-message-key'),
    false,
    'the segment header must not carry a row key',
  );
});
