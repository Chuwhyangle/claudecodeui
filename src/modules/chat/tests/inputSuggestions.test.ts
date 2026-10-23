import assert from 'node:assert/strict';

import { beforeEach, describe, it } from 'vitest';

import { readAllInputHistory } from '@/modules/chat/hooks/useInputHistory';
import {
  buildInputSuggestions,
  normalizeSuggestionKey,
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
