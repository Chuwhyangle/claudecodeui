/**
 * The reference-target primitives: extraction, caret query, and matching.
 *
 * WHAT THIS PINS. The composer would offer to complete the token before the
 * caret only if three things agree: which strings in a reply are retype-able,
 * what the fragment before the caret is, and which target that fragment names.
 * Each section drives one of them directly — no DOM, no hook — because a
 * disagreement here is a wrong offer at the keyboard.
 *
 * Numbered reply items are deliberately absent: this module is the broad
 * search set, not the ①② address space.
 *
 * Run: npx vitest run src/modules/chat/utils/tests/referenceTargets.test.ts
 */

import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  extractReferenceTargets,
  matchReferenceTargets,
  normalizeReferenceTarget,
  readCaretQuery,
} from '@/modules/chat/utils/transcript/referenceTargets';

const REPLY = [
  '## Implementation notes',
  '',
  'The matcher lives in `src/modules/chat/utils/transcript/referenceTargets.ts`.',
  '',
  '- It calls `matchReferenceTargets` with a target list.',
  '- The task id is chat-reply-items-addressable.',
  '- The gate is AC-394.',
  '',
  '```ts',
  'const fill = buildVerbatimFill(chip);',
  '```',
].join('\n');

describe('extractReferenceTargets', () => {
  test('collects paths from prose and inline code, preferring the whole path', () => {
    const targets = extractReferenceTargets(REPLY);
    const path = 'src/modules/chat/utils/transcript/referenceTargets.ts';
    const target = targets.find((candidate) => candidate.text === path);
    assert.ok(target, 'the inline-code path is extracted');
    assert.equal(target.kind, 'path');
    assert.ok(target.matchKeys.includes('referenceTargets.ts'), 'the basename is a match key');
    assert.ok(
      target.matchKeys.includes('utils/transcript/referenceTargets.ts'),
      'a trailing segment join is a match key',
    );
  });

  test('collects identifiers, kebab ids and issue ids', () => {
    const texts = extractReferenceTargets(REPLY).map((target) => target.text);
    assert.ok(texts.includes('matchReferenceTargets'), 'camelCase identifier');
    assert.ok(texts.includes('chat-reply-items-addressable'), 'multi-segment kebab id');
    assert.ok(texts.includes('AC-394'), 'issue-style id');
  });

  test('collects headings without their marker and code lines from a fence', () => {
    const targets = extractReferenceTargets(REPLY);
    assert.ok(targets.some((target) => target.kind === 'heading' && target.text === 'Implementation notes'));
    assert.ok(
      targets.some((target) => target.kind === 'code-line' && target.text === 'const fill = buildVerbatimFill(chip);'),
    );
  });

  test('paragraphs stay off by default and are opt-in', () => {
    const prose = '这一条普通段落只是说明文字，并不应该成为建议。';
    assert.equal(extractReferenceTargets(prose).length, 0);
    const withParagraphs = extractReferenceTargets(prose, { includeParagraphs: true });
    assert.equal(withParagraphs.length, 1);
    assert.equal(withParagraphs[0].kind, 'paragraph');
  });

  test('a numbered list line is not a target by itself', () => {
    const texts = extractReferenceTargets('1. 第一条普通说明\n2. 第二条普通说明').map((target) => target.text);
    assert.deepEqual(texts, []);
  });

  test('dedupes by normalised text and keeps the stronger kind', () => {
    const targets = extractReferenceTargets('```ts\nfooBar\n```\n\nThen call fooBar.');
    const matching = targets.filter((target) => normalizeReferenceTarget(target.text) === 'foobar');
    assert.equal(matching.length, 1, 'one target for the same normalised text');
    assert.equal(matching[0].kind, 'identifier', 'the identifier displaces the code-line copy');
  });
});

describe('readCaretQuery', () => {
  test('takes the trailing ASCII/path run', () => {
    assert.deepEqual(readCaretQuery('请看看 src/modules/chat/ref'), {
      query: 'src/modules/chat/ref',
      start: '请看看 '.length,
    });
  });

  test('takes the trailing CJK run, capped', () => {
    const query = readCaretQuery('那就按参考目标来实现吧');
    assert.equal(query.query, '参考目标来实现吧');
    assert.equal(query.start, '那就按'.length);
  });

  test('returns nothing when the caret follows whitespace or punctuation', () => {
    assert.deepEqual(readCaretQuery('看看 '), { query: '', start: 3 });
    assert.deepEqual(readCaretQuery('看看。'), { query: '', start: 3 });
  });
});

describe('matchReferenceTargets', () => {
  const targets = extractReferenceTargets(REPLY);

  test('completes a path typed by its basename', () => {
    const matches = matchReferenceTargets('改一下 referenceTar', targets);
    assert.equal(matches[0]?.target.text, 'src/modules/chat/utils/transcript/referenceTargets.ts');
  });

  test('completes an identifier prefix', () => {
    const matches = matchReferenceTargets('调用 matchRef', targets);
    assert.equal(matches[0]?.target.text, 'matchReferenceTargets');
  });

  test('offers nothing below the minimum fragment length', () => {
    assert.deepEqual(matchReferenceTargets('AC', targets), []);
    assert.equal(matchReferenceTargets('AC-3', targets)[0]?.target.text, 'AC-394');
  });

  test('does not echo a fragment that already is the whole target', () => {
    assert.deepEqual(matchReferenceTargets('AC-394', targets), []);
  });

  test('ranks longer coverage and stronger kinds first, and caps the list', () => {
    const matches = matchReferenceTargets('chat-reply', targets, { maxCandidates: 3 });
    assert.equal(matches[0]?.target.text, 'chat-reply-items-addressable');
    assert.ok(matches.length <= 3);
  });

  test('does not offer a path for an ordinary lowercase word', () => {
    const withPath = extractReferenceTargets('The entry is `server/index.ts`; restart server after.');
    assert.deepEqual(matchReferenceTargets('重启 server', withPath), []);
    assert.deepEqual(matchReferenceTargets('重启 Quay', withPath), [], 'a short title-case product is not code-shaped');
    assert.equal(matchReferenceTargets('重启 server/', withPath)[0]?.target.text, 'server/index.ts');
  });

  test('keeps a mixed-case identifier of five characters or more', () => {
    const withIdentifier = extractReferenceTargets('Call `matchRef` here.');
    assert.equal(matchReferenceTargets('先调 matchR', withIdentifier)[0]?.target.text, 'matchRef');
  });

  test('finds a target from a Chinese suffix', () => {
    const withCjk = extractReferenceTargets('建议先看 referenceTargets 的实现。');
    const matches = matchReferenceTargets('先看 referenceTar', withCjk);
    assert.equal(matches[0]?.target.text, 'referenceTargets');
  });
});
