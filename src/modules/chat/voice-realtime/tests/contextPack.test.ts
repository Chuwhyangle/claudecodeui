/**
 * AC-320's own entry point for the C2 ContextPack: the pack as the voice-realtime module consumes
 * it (`contextFrame` → the `context` wire frame).
 *
 * WHY A SECOND SUITE. `src/modules/chat/utils/tests/voiceContextPack.test.ts` is the builder's
 * exhaustive suite — 200+ seeded random batches and the two executed false forms. This file is the
 * criterion AC-320 names, and it answers the criterion's own reading rather than restating the
 * builder's: that the rows kept are the rows the transcript's fold rules keep, that the character
 * budget is a HARD cap on any input, and that a single over-long row is elided as
 * 首 70% + `…` + 尾 30% inside `rowCapChars`. It is deliberately smaller — the deep randomised
 * coverage lives in the builder's own file — but every case here is a real reading against the
 * shipped functions, not a restatement of them.
 */
import assert from 'node:assert/strict';

import { test } from 'vitest';

import { shouldHideToolResult } from '@/modules/chat/tools';
import { buildVoiceContextPack, isVoiceContextRow, VOICE_CONTEXT_BUDGET_CHARS, VOICE_CONTEXT_ROW_CAP_CHARS } from '@/modules/chat/utils/voice/voiceContextPack';
import { isWorkSegmentMember } from '@/modules/chat/utils/transcript/workSegments';
import { contextFrame } from '@/modules/chat/voice-realtime/voiceRealtimeProtocol';
import type { ChatMessage } from '@/shared/types';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const FRESH = new Date(NOW - 30_000).toISOString();

/**
 * One row of every kind the transcript renders. `visible` is what the transcript's OWN rules say
 * about it — derived here from the imported predicates rather than hand-written, so a drift in
 * either predicate moves this expectation with it.
 */
const ROWS: ChatMessage[] = [
  { type: 'user', content: 'ROW-user', timestamp: FRESH },
  { type: 'assistant', content: 'ROW-assistant', timestamp: FRESH },
  { type: 'assistant', content: 'ROW-thinking', timestamp: FRESH, isThinking: true },
  {
    type: 'assistant',
    content: 'ROW-tool',
    timestamp: FRESH,
    isToolUse: true,
    toolName: 'Bash',
    toolResult: { content: 'ROW-result', isError: true },
  },
  { type: 'assistant', content: '', timestamp: FRESH, isSubagentContainer: true },
  { type: 'assistant', content: 'ROW-notification', timestamp: FRESH, isTaskNotification: true },
  { type: 'resident_pending' as never, content: 'ROW-lifecycle', timestamp: FRESH },
];

for (const [index, row] of ROWS.entries()) {
  test(`row ${index} (${row.type}${row.isToolUse ? '+tool' : ''}) is kept exactly when the fold rules keep it`, () => {
    const pack = buildVoiceContextPack([row], { now: NOW });
    const visible = isVoiceContextRow(row);
    assert.equal(pack.rows === 1, visible, `pack kept=${pack.rows === 1} but the rules say visible=${visible}`);
    // The two imported predicates are what `isVoiceContextRow` reads; naming them here is what makes
    // a drift in either one change THIS reading instead of passing silently.
    if (visible) {
      assert.equal(isWorkSegmentMember(row), false);
      assert.equal(
        row.toolResult ? shouldHideToolResult(String(row.toolName), row.toolResult) : false,
        false,
      );
    }
  });
}

test('the character budget is a HARD cap: a pack never exceeds it, at any budget', () => {
  const long = Array.from({ length: 40 }, (_, index) => ({
    type: 'user' as const,
    content: `ROW-${index}-${'字'.repeat(index * 7)}`,
    timestamp: FRESH,
  }));
  for (const budgetChars of [0, 1, 7, 60, 601, VOICE_CONTEXT_BUDGET_CHARS, 5000]) {
    const pack = buildVoiceContextPack(long, { now: NOW, budgetChars });
    assert.ok(pack.chars <= budgetChars, `pack of ${pack.chars} chars exceeded a budget of ${budgetChars}`);
    assert.equal(pack.chars, pack.text.length, 'chars must be the RENDERED length, not a sum of parts');
    assert.equal(pack.rows === 0, pack.text === '', 'an empty pack is an empty string');
  }
});

test('a single over-long row is elided to 首 70% + … + 尾 30% inside rowCapChars', () => {
  const row: ChatMessage = { type: 'user', content: `HEAD${'·'.repeat(900)}TAIL`, timestamp: FRESH };
  const cap = VOICE_CONTEXT_ROW_CAP_CHARS;
  const pack = buildVoiceContextPack([row], { now: NOW, rowCapChars: cap });

  assert.equal(pack.rows, 1);
  assert.ok(pack.text.length <= cap, `the elided row is ${pack.text.length} chars, over the ${cap}-char row cap`);
  assert.ok(pack.text.includes('…'), 'the elision marker must be present in an elided row');
  assert.ok(pack.text.includes('HEAD'), 'the head survives');
  assert.ok(pack.text.includes('TAIL'), 'the tail survives');
});

test('a fenced code block keeps its first 3 lines and says how many were dropped', () => {
  const block = `看这段：\n\`\`\`ts\n${['one();', 'two();', 'three();', 'four();', 'five();'].join('\n')}\n\`\`\`\n就这样。`;
  const pack = buildVoiceContextPack([{ type: 'assistant', content: block, timestamp: FRESH }], { now: NOW });

  assert.ok(pack.text.includes('one();'), 'the first line of the block is kept');
  assert.ok(pack.text.includes('three();'), 'the third line is kept');
  assert.equal(pack.text.includes('five();'), false, 'the tail of the block is dropped');
  assert.ok(pack.text.includes('省略 2 行'), 'the marker says how many lines were dropped');
});

test('attachments become placeholders, and an image-only row is still something said', () => {
  const pack = buildVoiceContextPack(
    [
      { type: 'user', content: '', timestamp: FRESH, images: [{ data: 'data:image/png;base64,AAA' }] },
      {
        type: 'user',
        content: '看看这个',
        timestamp: FRESH,
        files: [{ name: 'timeout.ts', content: '' } as never],
      },
    ],
    { now: NOW },
  );

  assert.ok(pack.text.includes('[图片]'), 'an image is a placeholder, never its bytes');
  assert.ok(pack.text.includes('[文件 timeout.ts]'), 'an attachment names the file');
  assert.equal(pack.rows, 2);
});

test('the wire frame carries the pack, and nothing for an empty one', () => {
  const pack = buildVoiceContextPack([{ type: 'user', content: '你好', timestamp: FRESH }], { now: NOW });
  const frame = contextFrame(pack);
  assert.ok(frame);
  assert.equal(frame.type, 'context');
  assert.equal(frame.text, pack.text);
  assert.equal(frame.rows, 1);

  assert.equal(contextFrame(buildVoiceContextPack([], { now: NOW })), null, 'an empty pack sends no frame');
});
