import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  inlineChipTextareaHeight,
  scrollbarCompensation,
  splitInlineQuoteChipInput,
} from '@/modules/chat/utils/inlineQuoteChipLayout';

/**
 * The arithmetic behind the inline quote chip's height.
 *
 * While the chip is in the text flow the textarea's height follows the mirror
 * layer's CONTENT (the chip's line exists only there), capped by the box's
 * existing maximum. The browser geometry that produces those numbers is checked
 * on a real page in the DoD; here the rule itself is pinned, as one pure function,
 * so it cannot drift into "height = mirror height" and quietly drop the cap.
 */

describe('inline chip textarea height', () => {
  it('takes the cap when the mirror content is taller than it', () => {
    assert.equal(inlineChipTextareaHeight(480, 300), 300);
  });

  it('takes the content height when it is below the cap', () => {
    assert.equal(inlineChipTextareaHeight(180, 300), 180);
  });

  it('uses the content height when the environment reports no cap', () => {
    assert.equal(inlineChipTextareaHeight(180, null), 180);
  });

  it('treats a non-positive or non-finite cap as "no cap", never as zero height', () => {
    assert.equal(inlineChipTextareaHeight(180, 0), 180);
    assert.equal(inlineChipTextareaHeight(180, -1), 180);
    assert.equal(inlineChipTextareaHeight(180, Number.NaN), 180);
  });

  it('never returns a negative height for a negative or unreadable content height', () => {
    assert.equal(inlineChipTextareaHeight(-10, 300), 0);
    assert.equal(inlineChipTextareaHeight(Number.NaN, 300), 0);
  });
});

describe('scrollbar width compensation', () => {
  it('is the width the classic vertical scrollbar takes from the content box', () => {
    assert.equal(scrollbarCompensation(400, 385), 15);
  });

  it('is zero when no scrollbar is drawn', () => {
    assert.equal(scrollbarCompensation(400, 400), 0);
  });

  it('is never negative, and tolerates unreadable widths', () => {
    assert.equal(scrollbarCompensation(385, 400), 0);
    assert.equal(scrollbarCompensation(Number.NaN, 400), 0);
    assert.equal(scrollbarCompensation(400, Number.NaN), 0);
  });
});

describe('caret split', () => {
  it('cuts at the UTF-16 index the textarea reports, surrogate pairs included', () => {
    assert.deepEqual(
      splitInlineQuoteChipInput('a😀中bc', 3),
      { before: 'a😀', after: '中bc', caret: 3 },
    );
  });

  it('clamps a stale offset into the draft', () => {
    assert.deepEqual(
      splitInlineQuoteChipInput('abc', 99),
      { before: 'abc', after: '', caret: 3 },
    );
    assert.deepEqual(
      splitInlineQuoteChipInput('abc', -2),
      { before: '', after: 'abc', caret: 0 },
    );
  });

  it('falls back to the end of the draft when the element reports no caret', () => {
    assert.deepEqual(
      splitInlineQuoteChipInput('abc', Number.NaN),
      { before: 'abc', after: '', caret: 3 },
    );
  });
});
