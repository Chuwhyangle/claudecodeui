import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { insertQuotedText } from '@/modules/chat/utils/inputSuggestions';

/**
 * The composer's quote-insertion rules, as one pure function.
 *
 * One case per row of the proposal's table, plus the edges the rules name in
 * prose: a punctuation mark counts as text, a line holding only spaces is not an
 * empty line, and the returned caret is the end of everything that was added in
 * UTF-16 units.
 *
 * The selected passage itself (`T`) is inserted verbatim — no marker, no forced
 * line break — because after this fill it is ordinary draft text.
 */

/** The passage the transcript selection hands over, trimmed and capped upstream. */
const T = 'T';

describe('insertQuotedText', () => {
  it('(a) empty box: the passage plus two line breaks, caret at the end', () => {
    const result = insertQuotedText({ input: '', selectionStart: 0, selectionEnd: 0 }, T);
    assert.equal(result.text, 'T\n\n');
    assert.equal(result.caret, 3);
  });

  it('(b) `我同意|`: a space before the passage, none after (end of the line)', () => {
    const result = insertQuotedText({ input: '我同意', selectionStart: 3, selectionEnd: 3 }, T);
    assert.equal(result.text, '我同意 T');
    assert.equal(result.caret, 5);
  });

  it('(c) `我同意 |`: the existing space is enough, none is added', () => {
    const result = insertQuotedText({ input: '我同意 ', selectionStart: 4, selectionEnd: 4 }, T);
    assert.equal(result.text, '我同意 T');
    assert.equal(result.caret, 5);
  });

  it('(d) `|后面`: a space after the passage, none before (start of the text)', () => {
    const result = insertQuotedText({ input: '后面', selectionStart: 0, selectionEnd: 0 }, T);
    assert.equal(result.text, 'T 后面');
    assert.equal(result.caret, 2);
  });

  it('(e) `前面|后面`: a space on each side', () => {
    const result = insertQuotedText({ input: '前面后面', selectionStart: 2, selectionEnd: 2 }, T);
    assert.equal(result.text, '前面 T 后面');
    assert.equal(result.caret, 5);
  });

  it('(f) `第一段↵|`: at the end of an empty line, two line breaks follow', () => {
    const result = insertQuotedText({ input: '第一段\n', selectionStart: 4, selectionEnd: 4 }, T);
    assert.equal(result.text, '第一段\nT\n\n');
    assert.equal(result.caret, 7);
  });

  it('(g) `a↵|↵b`: a line break beside the caret is not text, so no space is added', () => {
    const result = insertQuotedText({ input: 'a\n\nb', selectionStart: 2, selectionEnd: 2 }, T);
    assert.equal(result.text, 'a\nT\nb');
    assert.equal(result.caret, 3);
  });

  it('(h) with a selection: the passage is inserted after the selection, both sides spaced', () => {
    // `abc[def]ghi` — the selection (3..6) stays in the draft, T goes after it.
    const result = insertQuotedText({ input: 'abcdefghi', selectionStart: 3, selectionEnd: 6 }, T);
    assert.equal(result.text, 'abcdef T ghi');
    assert.equal(result.caret, 9);
  });

  it('(i) `我同意，|`: punctuation counts as text, so a space is added', () => {
    const result = insertQuotedText({ input: '我同意，', selectionStart: 4, selectionEnd: 4 }, T);
    assert.equal(result.text, '我同意， T');
    assert.equal(result.caret, 6);
  });

  it('(j) `我同意|` at the end of a non-empty line: no line breaks and no trailing space', () => {
    const result = insertQuotedText({ input: '我同意', selectionStart: 3, selectionEnd: 3 }, T);
    assert.equal(result.text.endsWith('T'), true, 'nothing follows the passage');
    assert.equal(result.text.includes('\n'), false, 'a non-empty line gets no paragraph break');
    assert.equal(result.caret, result.text.length);
  });

  it('(k) a multi-line passage keeps its own line breaks, verbatim', () => {
    const passage = '第一行\n第二行';
    const result = insertQuotedText({ input: '', selectionStart: 0, selectionEnd: 0 }, passage);
    assert.equal(result.text, '第一行\n第二行\n\n');
    assert.equal(result.caret, passage.length + 2);
  });

  it('(l) `  |` at the end: a line of only spaces is not an empty line, so no line breaks', () => {
    const result = insertQuotedText({ input: '  ', selectionStart: 2, selectionEnd: 2 }, T);
    assert.equal(result.text, '  T');
    assert.equal(result.text.includes('\n'), false);
    assert.equal(result.caret, 3);
  });

  it('(m) the caret is the insertion point plus everything added, in UTF-16 units', () => {
    // The selection starts after a surrogate pair (two UTF-16 units): the caret
    // must count units, not code points, or it would land inside the emoji.
    const passage = '😀T';
    const result = insertQuotedText({ input: '😀后面', selectionStart: 2, selectionEnd: 2 }, passage);
    assert.equal(result.text, '😀 😀T 后面');
    assert.equal(result.caret, 2 + 1 + passage.length + 1);
    assert.equal(result.caret, 7);
  });
});
