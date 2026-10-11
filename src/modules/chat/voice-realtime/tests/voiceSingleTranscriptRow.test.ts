import { describe, expect, test } from 'vitest';

import { foldCaptionsIntoTranscriptRow, markDeliveredVoiceMessages } from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeCaption, VoiceRealtimeDelivery } from '@/modules/chat/voice-realtime';
import type { ChatMessage } from '@/shared/types';

/**
 * AC-326, the pure-function half — one spoken thought becomes ONE transcript row.
 *
 * WHAT THIS FILE IS FOR. The endpoint closes an utterance at every pause, so a sentence with a
 * pause in the middle arrives as several captions. The pane used to render one row per caption,
 * so the person read their own words three times, then the relay model merged the whole thought
 * into one message and all three rows were deleted at once — "my words appeared three times, got
 * reworded, then vanished". `foldCaptionsIntoTranscriptRow` is the rule that replaces that: the
 * utterances not yet delivered are joined into the single row that stands for what is being said,
 * by the proxy's own joining rule, and that row is what a delivery finalises in place.
 *
 * WHY THE FILE IS NAMED BY THE CRITERION. AC-326's command runs this file by name. A criterion
 * that named only pre-existing test files was green before any of this work existed — the folded
 * row, the empty-caption guard and the e2e readings below were all absent and nothing noticed —
 * so the assertions that describe the new behaviour live in a file that did not exist until the
 * behaviour did.
 *
 * The browser half — the same reading taken off a real page against a fake upstream — is in
 * `e2e/voice-realtime-upload-fixture.spec.ts`.
 */

const caption = (itemId: string, text: string, at: number, final = true): VoiceRealtimeCaption => ({
  itemId,
  text,
  final,
  at,
});

/** What the model relayed instead of the pieces it heard — deliberately not any of them. */
const DELIVERED_MESSAGE = 'the one message the model delivered to the session';

/** A delivery that took over the named utterances. */
const deliveryTaking = (itemIds: readonly string[], message = DELIVERED_MESSAGE): VoiceRealtimeDelivery => ({
  message,
  at: 9_000,
  heard: [...itemIds],
  itemIds: [...itemIds],
});

describe('foldCaptionsIntoTranscriptRow', () => {
  test('three CJK utterances fold into ONE row, with no space between them and in the order they arrived', () => {
    const captions = [
      caption('a', '这个逻辑不要放在前。', 1_000),
      caption('b', '放到 server。那边去。', 2_000),
      caption('c', '顺便把测试补上。', 3_000),
    ];
    const row = foldCaptionsIntoTranscriptRow(captions, []);
    // The join rule is the proxy's own: `joinParts` in `voice-realtime-ws-proxy.service.ts` puts
    // nothing between two CJK pieces, so the row reads as the one sentence the person said.
    expect(row?.content).toBe('这个逻辑不要放在前。放到 server。那边去。顺便把测试补上。');
    // The row is keyed on, and stamped with, the utterance it OPENED with: that is the row's
    // stable identity while it grows, and the id the delivery below claims when it takes over.
    expect(row?.id).toBe('voice-caption-a');
    expect(row?.timestamp).toBe(1_000);
    expect(row?.type).toBe('user');
  });

  test('two English pieces are joined with exactly one space', () => {
    const row = foldCaptionsIntoTranscriptRow(
      [caption('a', 'change the timeout in voice.service.ts', 1_000), caption('b', 'to thirty seconds', 2_000)],
      [],
    );
    expect(row?.content).toBe('change the timeout in voice.service.ts to thirty seconds');
  });

  test('a CJK piece followed by a latin one is joined with a space, not welded together', () => {
    const row = foldCaptionsIntoTranscriptRow([caption('a', '这是第一段', 1_000), caption('b', 'and the second', 2_000)], []);
    expect(row?.content).toBe('这是第一段 and the second');
  });

  test('an utterance still being spoken is part of the row, in its latest text', () => {
    const row = foldCaptionsIntoTranscriptRow(
      [caption('a', '说完的一句。', 1_000), caption('b', '说到一半', 2_000, false)],
      [],
    );
    expect(row?.content).toBe('说完的一句。说到一半');
  });

  test('empty and whitespace-only captions produce no row at all', () => {
    expect(foldCaptionsIntoTranscriptRow([], [])).toBeNull();
    expect(foldCaptionsIntoTranscriptRow([caption('a', '', 1_000)], [])).toBeNull();
    expect(foldCaptionsIntoTranscriptRow([caption('a', '   ', 1_000), caption('b', '\n\t', 2_000)], [])).toBeNull();
  });

  test('a wordless caption is not a piece either: it adds no text and no separator of its own', () => {
    const row = foldCaptionsIntoTranscriptRow(
      [caption('a', '', 1_000), caption('b', '真的说了这一句。', 2_000), caption('c', '  ', 3_000)],
      [],
    );
    expect(row?.content).toBe('真的说了这一句。');
    // The row's time is the first utterance it actually carries — the moment words were first seen.
    expect(row?.timestamp).toBe(2_000);
    expect(row?.id).toBe('voice-caption-b');
  });

  test('the utterances a delivery already claimed are left out, so the row is rebuilt from what is still in flight', () => {
    const captions = [caption('a', '第一句。', 1_000), caption('b', '第二句。', 2_000), caption('c', '第三句。', 3_000)];
    const row = foldCaptionsIntoTranscriptRow(captions, [deliveryTaking(['a', 'b'])]);
    expect(row?.content).toBe('第三句。');
    expect(row?.id).toBe('voice-caption-c');
    expect(row?.timestamp).toBe(3_000);
    // Everything spoken has been taken over: there is no row left to show.
    expect(foldCaptionsIntoTranscriptRow(captions, [deliveryTaking(['a', 'b', 'c'])])).toBeNull();
  });

  test('the delivery finalises the folded row: the real message takes its place as the caption row goes', () => {
    const captions = [caption('a', '第一句。', 1_000), caption('b', '第二句。', 2_000)];
    const row = foldCaptionsIntoTranscriptRow(captions, []);
    const delivered = deliveryTaking(['a', 'b']);
    const real = {
      id: 'm1',
      type: 'user',
      content: DELIVERED_MESSAGE,
      timestamp: 9_100,
    } as ChatMessage;
    const out = markDeliveredVoiceMessages([real], row ? [row] : [], [delivered]);
    // One row in, one row out: the provisional row is absorbed by the delivery that carries its
    // utterances, and the message it became is the row that stays.
    expect(out.captionRows).toEqual([]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.voiceTranscript).toEqual({ heard: ['a', 'b'] });
  });
});
