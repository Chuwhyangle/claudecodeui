import assert from 'node:assert/strict';
import test from 'node:test';

import { selectUncoveredFragments } from '../voice-realtime-fragment-coverage.js';

/**
 * Which heard sentences a relayed message left out.
 *
 * The readings are the two live sentences that were lost on 2026-10-15 23:02 (journal `8fe60310`):
 * the person paused, the endpoint committed the first piece, the person resumed, and the model's
 * one `session_send` carried only the last piece.
 */

test('a sentence the message does not contain is reported, in the order it was heard', () => {
  assert.deepEqual(
    selectUncoveredFragments(
      ['涉及了Live Voice的这些修改。', '可以确认是有很大的问题。'],
      '我现在可以确认是有很大的问题。',
    ),
    ['涉及了Live Voice的这些修改。'],
  );
});

test('a sentence the model reworded lightly counts as covered', () => {
  // The ASR heard "QQ" and "You the message"; the model wrote the words it understood.
  assert.deepEqual(
    selectUncoveredFragments(
      ['在UI上我看见我上一句话在QQ里面出现很短几秒然后消失了，但是它并没有马上变成You the message显示在屏幕上。'],
      '在 UI 上，我看见我上一句话在 queue 里面出现很短几秒然后消失了，但是它并没有马上变成 user message 显示在屏幕上。',
    ),
    [],
  );
});

test('a merged relay that carries every piece reports none', () => {
  assert.deepEqual(
    selectUncoveredFragments(
      ['显然，最近差不多三四个小时的这个代码的修改是有很多问题的。', '涉及了Live Voice的这些修改。'],
      '显然最近差不多三四个小时的这个代码的修改是有很多问题的，涉及了 Live Voice 的这些修改。',
    ),
    [],
  );
});

test('a sentence the message reversed is not covered by sharing a word with it', () => {
  assert.deepEqual(selectUncoveredFragments(['他们又消失了。'], '它没有消失。'), ['他们又消失了。']);
});

test('punctuation, case and spacing do not decide coverage', () => {
  assert.deepEqual(selectUncoveredFragments(['Run the tests, please.'], 'run   the TESTS please'), []);
});

test('a filler too short to judge is never reported', () => {
  assert.deepEqual(selectUncoveredFragments(['嗯。', '。', '  '], '我现在可以确认是有很大的问题。'), []);
});

test('a short mishearing of a word the model repaired is never reported', () => {
  // Preserved real session (voice-realtime-replay): the endpoint heard "李的。" for "里的" and
  // "瑞士 T S。" for "server.ts"; the model's calls carried the repaired words.
  assert.deepEqual(selectUncoveredFragments(['李的。'], '里的'), []);
  assert.deepEqual(selectUncoveredFragments(['瑞士 T S。'], '把 voice 里的 server.ts 的超时改成 30 秒。'), []);
});

test('with no message at all every real sentence is reported', () => {
  assert.deepEqual(
    selectUncoveredFragments(['先看一下日志文件。', '再看一下代码实现。'], ''),
    ['先看一下日志文件。', '再看一下代码实现。'],
  );
});
