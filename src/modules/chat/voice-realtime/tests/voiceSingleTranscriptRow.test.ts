/**
 * AC-326 — how the pane shows the several utterances the endpoint reports for ONE spoken thought.
 *
 * THE ANSWER CHANGED (this task, `gap-live-voice-remove-transcript-caption-rows`). The pane used to
 * put ONE ROW PER UTTERANCE on screen — each keyed `voice-caption-<itemId>`, each `heard` until the
 * relay accepted the instruction — and finalise them into the delivered message. Those provisional
 * rows are gone. A spoken utterance is not a row of this client's own at all: it reaches the
 * transcript the one way anything else does, as the real message the model relayed, and while it is
 * in flight its words are shown in the bottom voice bar, not in the chat area. This file now pins
 * THAT, because the rows it used to describe no longer exist.
 *
 * WHAT WAS DELETED, AND WHY. The per-utterance caption-row readings and the whole join-rule block
 * that folded a caption into that row went with the two functions they described: neither is on the
 * production path any more (the fold never was; the per-utterance rows were removed outright). The
 * readings that remain are taken off the production entry point, `voiceTranscriptRows`, and describe
 * what it does today. No assertion was turned into a tautology to keep the file green.
 *
 * WHY THE FILE IS STILL NAMED BY THE CRITERION. AC-326's command runs this file by name (the name is
 * the historical one: the rule it was born checking). Removing the file would erase the reading it
 * still takes; keeping it under its name keeps the criterion pointing at a real reading.
 *
 * The browser half — the same readings taken off a real page against a fake upstream, where the
 * message appears a run later — is in `e2e/voice-realtime-upload-fixture.spec.ts`.
 */

import { describe, expect, test } from 'vitest';

import { voiceTranscriptRows } from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeCaption, VoiceRealtimeDelivery } from '@/modules/chat/voice-realtime';
import type { ChatMessage } from '@/shared/types';

const caption = (itemId: string, text: string, at: number, final = true, seq?: number): VoiceRealtimeCaption => ({
  itemId,
  text,
  final,
  at,
  ...(seq === undefined ? {} : { seq }),
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

/** The real transcript row a delivery becomes, once it is VISIBLE — the removal key. */
const shownRow = (message = DELIVERED_MESSAGE, at = 9_100): ChatMessage => ({
  id: 'm1',
  type: 'user',
  content: message,
  timestamp: at,
});

describe('voiceTranscriptRows — the production model: no row of the client’s own', () => {
  test('utterances the model has not delivered yet put NOTHING on screen', () => {
    const captions = [
      caption('a', '这个逻辑不要放在前。', 1_000, true, 0),
      caption('b', '放到 server。那边去。', 2_000, true, 1),
      caption('c', '顺便把测试补上。', 3_000, true, 2),
    ];
    const rows = voiceTranscriptRows({ captions, deliveries: [], visibleMessages: [] });
    // Not one row: a spoken utterance is never carried by a row of this client's own. While it is in
    // flight it is shown in the bottom voice bar — this is the reading the pane's real rows changed to.
    expect(rows).toHaveLength(0);
  });

  test('the delivered message is the ONE row for the spoken thought, marked with what was heard', () => {
    const captions = [
      caption('a', '第一句。', 1_000, true, 0),
      caption('b', '第二句。', 2_000, true, 1),
      caption('c', '第三句。', 3_000, true, 2),
    ];
    // The real message the delivery became, already VISIBLE — the removal key, not the `sent` frame.
    const real = shownRow();
    const delivery: VoiceRealtimeDelivery = {
      message: DELIVERED_MESSAGE,
      at: 9_000,
      heard: ['第一句。', '第二句。', '第三句。'],
      itemIds: ['a', 'b', 'c'],
    };
    const rows = voiceTranscriptRows({ captions, deliveries: [delivery], visibleMessages: [real] });
    // One row: the message the model relayed. The three utterance rows that used to stand beside it
    // are gone — the words are on the message, not on a row of their own.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('m1');
    expect(rows[0]!.content).toBe(DELIVERED_MESSAGE);
    expect(rows[0]!.voiceTranscript).toEqual({ heard: ['第一句。', '第二句。', '第三句。'] });
    for (const text of ['第一句。', '第二句。', '第三句。']) {
      expect(
        rows.filter((row) => typeof row.content === 'string' && row.content.includes(text)),
        `the utterance ${text} was left as a user row of its own beside the delivered message`,
      ).toHaveLength(0);
    }
  });

  test('before that message is visible the utterance words are on NO row — the bar, not the chat, shows them', () => {
    // A delivery is recorded (the `sent` frame arrived) but its message is not in the transcript yet:
    // the CLI's own queue window. Nothing of the client's own stands in for the words.
    const captions = [caption('a', '第一句。', 1_000, true, 0)];
    const rows = voiceTranscriptRows({ captions, deliveries: [deliveryTaking(['a'])], visibleMessages: [] });
    expect(rows).toHaveLength(0);
  });

  test('empty and whitespace-only captions produce no row at all', () => {
    // The endpoint emits an empty transcription beside its interim text; a blank caption is not
    // something the person said, so it contributes neither a row nor (here) anything at all.
    const rows = voiceTranscriptRows({
      captions: [
        caption('a', '', 1_000, true, 0),
        caption('b', '   ', 2_000, true, 1),
        caption('c', '\n\t', 3_000, true, 2),
      ],
      deliveries: [],
      visibleMessages: [],
    });
    expect(rows).toHaveLength(0);
  });
});
