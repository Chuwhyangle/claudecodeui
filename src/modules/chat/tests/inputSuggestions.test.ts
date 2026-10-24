import assert from 'node:assert/strict';

import { beforeEach, describe, it } from 'vitest';

import { readAllInputHistory } from '@/modules/chat/hooks/useInputHistory';
import {
  SUGGESTION_LABEL_MAX_CHARS,
  buildInputSuggestions,
  buildSuggestionChips,
  normalizeSuggestionKey,
  suggestionConditionsHold,
  truncateSuggestionLabel,
} from '@/modules/chat/utils/inputSuggestions';

/**
 * Candidate rules for the empty-composer chips, one rule per case.
 *
 * `buildInputSuggestions` takes its input newest first, which is the order
 * `readAllInputHistory()` returns. Frequency is counted on the normalized key;
 * the label shown is the most recent original spelling.
 */

beforeEach(() => {
  localStorage.clear();
});

describe('buildInputSuggestions', () => {
  it('(a) ranks by frequency descending and keeps at most three', () => {
    // four x3; three/two/one x2 each. The tie is decided by recency, so the
    // fourth habit (least recently used among the ties) is cut.
    const entries = ['four', 'three', 'two', 'one', 'four', 'three', 'two', 'one', 'four'];
    assert.deepEqual(buildInputSuggestions(entries), ['four', 'three', 'two']);
  });

  it('(b) breaks a frequency tie by the most recent use', () => {
    // Each appears twice, but beta's newest occurrence is more recent.
    assert.deepEqual(
      buildInputSuggestions(['beta', 'alpha', 'alpha', 'beta']),
      ['beta', 'alpha'],
    );
  });

  it('(c) drops an entry that appears only once', () => {
    assert.deepEqual(buildInputSuggestions(['said once']), []);
  });

  it('(d) drops multi-line entries', () => {
    const paragraph = 'first line\nsecond line';
    assert.deepEqual(buildInputSuggestions([paragraph, paragraph]), []);
  });

  it('(e) drops entries longer than 60 characters', () => {
    const tooLong = 'x'.repeat(61);
    assert.deepEqual(buildInputSuggestions([tooLong, tooLong]), []);
    // The boundary itself is accepted.
    const atLimit = 'y'.repeat(60);
    assert.deepEqual(buildInputSuggestions([atLimit, atLimit]), [atLimit]);
  });

  it('(f) drops entries that start with a slash command', () => {
    assert.deepEqual(buildInputSuggestions(['/help', '/help']), []);
    // Only the leading slash matters; a slash mid-message is ordinary text.
    assert.deepEqual(buildInputSuggestions(['path/to/file', 'path/to/file']), ['path/to/file']);
  });

  it('(g) merges case and trailing punctuation, showing the most recent spelling', () => {
    const entries = ['Hello!', 'hello', 'HELLO??', 'hello.'];
    assert.deepEqual(buildInputSuggestions(entries), ['Hello!']);
    assert.equal(normalizeSuggestionKey('  继续！！ '), '继续');
  });

  it('(h) returns an empty list for empty history', () => {
    assert.deepEqual(buildInputSuggestions([]), []);
  });

  it('(i) aggregates the same phrase across chat scopes before counting', () => {
    localStorage.setItem(
      'chat-input-history',
      JSON.stringify({
        'session-a': ['检查进展'],
        'session-b': ['检查进展。', 'other'],
      }),
    );
    // One use in each scope is the two occurrences the rule requires; the
    // newest spelling comes from session-b, the most recently written scope.
    assert.deepEqual(buildInputSuggestions(readAllInputHistory()), ['检查进展。']);
  });
});

describe('buildSuggestionChips', () => {
  it('orders the three sources: quoted, then model, then habit', () => {
    const chips = buildSuggestionChips({
      quotedText: '选中的原文',
      modelChips: ['模型一', '模型二'],
      habitChips: ['习惯一'],
    });
    assert.deepEqual(
      chips.map((chip) => [chip.source, chip.text]),
      [
        ['quoted', '选中的原文'],
        ['model', '模型一'],
        ['model', '模型二'],
        ['habit', '习惯一'],
      ],
    );
  });

  it('drops a model chip whose normalized text equals a habit chip', () => {
    const chips = buildSuggestionChips({
      modelChips: ['继续', '  别的 答复 '],
      habitChips: ['继续', '习惯'],
    });
    assert.deepEqual(
      chips.map((chip) => chip.text),
      ['继续', '别的 答复', '习惯'],
      'the model spelling wins; whitespace is normalized for the comparison only',
    );
  });

  it('keeps the quoted chip and drops later duplicates of it', () => {
    const chips = buildSuggestionChips({
      quotedText: '同一段',
      modelChips: ['同一段'],
      habitChips: ['同一段', '别的'],
    });
    assert.deepEqual(
      chips.map((chip) => [chip.source, chip.text]),
      [['quoted', '同一段'], ['habit', '别的']],
    );
  });

  it('indexes each source independently', () => {
    const chips = buildSuggestionChips({
      quotedText: '引用',
      modelChips: ['模型一', '模型二'],
      habitChips: ['习惯一', '习惯二'],
    });
    assert.deepEqual(
      chips.map((chip) => `${chip.source}:${chip.index}`),
      ['quoted:0', 'model:0', 'model:1', 'habit:0', 'habit:1'],
    );
  });

  it('returns an empty strip when every source is empty', () => {
    assert.deepEqual(buildSuggestionChips({}), []);
    assert.deepEqual(buildSuggestionChips({ quotedText: '   ', modelChips: [], habitChips: [] }), []);
  });
});

describe('truncateSuggestionLabel', () => {
  it('keeps a short label unchanged and ellipsizes a long one', () => {
    assert.equal(truncateSuggestionLabel('短句'), '短句');
    const long = '一'.repeat(SUGGESTION_LABEL_MAX_CHARS + 5);
    const label = truncateSuggestionLabel(long);
    assert.equal(Array.from(label).length, SUGGESTION_LABEL_MAX_CHARS + 1);
    assert.ok(label.endsWith('…'));
    assert.equal(label, `${'一'.repeat(SUGGESTION_LABEL_MAX_CHARS)}…`);
  });

  it('collapses line breaks so a multi-line reply still reads as one chip', () => {
    assert.equal(truncateSuggestionLabel('第一行\n第二行'), '第一行 第二行');
  });

  it('never splits an emoji surrogate pair', () => {
    const label = truncateSuggestionLabel('😀'.repeat(SUGGESTION_LABEL_MAX_CHARS + 1));
    assert.equal(Array.from(label).length, SUGGESTION_LABEL_MAX_CHARS + 1);
  });
});

describe('suggestionConditionsHold', () => {
  const idle = {
    isLoading: false,
    isOccupied: false,
    isCommandMenuOpen: false,
    isFileMenuOpen: false,
    hasQueuedDraft: false,
    hasAttachments: false,
  };

  it('is true when nothing holds the composer', () => {
    assert.equal(suggestionConditionsHold(idle), true);
  });

  it('is false for each single blocker, including the dock turn anchor', () => {
    for (const blocker of [
      { isLoading: true },
      { isDockTurnShown: true },
      { isOccupied: true },
      { isCommandMenuOpen: true },
      { isFileMenuOpen: true },
      { hasQueuedDraft: true },
      { hasAttachments: true },
    ]) {
      assert.equal(suggestionConditionsHold({ ...idle, ...blocker }), false, JSON.stringify(blocker));
    }
  });
});
