import { describe, expect, test } from 'vitest';

import {
  foldCaptionsIntoTranscriptRow,
  markDeliveredVoiceMessages,
  voiceTranscriptRows,
} from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeCaption, VoiceRealtimeDelivery } from '@/modules/chat/voice-realtime';
import type { ChatMessage } from '@/shared/types';

/**
 * AC-326 — how the pane shows the several utterances the endpoint reports for ONE spoken thought.
 *
 * WHAT THIS FILE IS FOR. The endpoint closes an utterance at every pause, so a sentence with a pause
 * in the middle arrives as several captions. Two rules have stood for those captions and this file
 * covers both, in the order of their standing:
 *
 *   · THE PRODUCTION MODEL — {@link voiceTranscriptRows}, the ONE entry point `ChatInterface` renders
 *     through. Since the honest per-utterance placement landed (`heardUtteranceRows`, 8a87620b) it
 *     puts ONE ROW PER UTTERANCE on screen — each keyed `voice-caption-<itemId>`, each `heard` until
 *     the relay accepts the instruction — and the delivery finalises them into the ONE real message in
 *     place. This is what the person actually reads, so it is the first thing the criterion asserts.
 *   · THE FOLD RULE — {@link foldCaptionsIntoTranscriptRow}, kept and exported but no longer on the
 *     production path. It joins the pieces of one thought into a single provisional row, which was
 *     AC-326's original reading. The rule is still the client's own answer to "how are the pieces of
 *     one spoken thought joined" (the backlog `collectUndeliveredUtterances` joins them the same way),
 *     and it is asserted here so its join rule cannot silently drift from the rows that replaced it.
 *
 * WHAT MOVED, AND WHY THIS FILE STILL EXISTS. When the production placement changed, this file went on
 * asserting only {@link foldCaptionsIntoTranscriptRow} — a function with no production call point — so
 * it stayed green while the pane's real rows changed shape underneath it. The assertions below are
 * re-anchored on the entry point the pane uses, and the fold block stays for the rule it kept.
 *
 * WHY THE FILE IS NAMED BY THE CRITERION. AC-326's command runs this file by name (the name is the
 * historical one: the rule it was born checking). A criterion that named only pre-existing test files
 * was green before any of this work existed, so the assertions that describe the behaviour live in a
 * file that did not exist until the behaviour did.
 *
 * The browser half — the same readings taken off a real page against a fake upstream — is in
 * `e2e/voice-realtime-upload-fixture.spec.ts`.
 */

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

/**
 * The real transcript row a delivery becomes, once it is VISIBLE — the other half of the removal
 * key. The fold only claims a delivery's utterances once its message is in the transcript, so these
 * readings pass the row the delivery turned into (a delivery with no such row leaves words on screen).
 */
const shownRow = (message = DELIVERED_MESSAGE, at = 9_100): ChatMessage => ({
  id: 'm1',
  type: 'user',
  content: message,
  timestamp: at,
});

describe('voiceTranscriptRows — the production model: one row per utterance', () => {
  test('each utterance of one spoken thought is its own row, `heard`, in the order it was spoken (seq)', () => {
    const captions = [
      caption('a', '这个逻辑不要放在前。', 1_000, true, 0),
      caption('b', '放到 server。那边去。', 2_000, true, 1),
      caption('c', '顺便把测试补上。', 3_000, true, 2),
    ];
    const rows = voiceTranscriptRows({ captions, deliveries: [], visibleMessages: [] });
    // One row PER UTTERANCE — not the pieces folded into one. This is the reading that went stale when
    // the fold stopped being the production placement, and the one this file was re-anchored to take.
    expect(rows.map((row) => row.id)).toEqual(['voice-caption-a', 'voice-caption-b', 'voice-caption-c']);
    expect(rows.map((row) => row.content)).toEqual(['这个逻辑不要放在前。', '放到 server。那边去。', '顺便把测试补上。']);
    // Every one of them reads `heard`: nothing has been accepted by the relay, so nothing is in flight.
    expect(rows.map((row) => row.voiceRowState)).toEqual(['heard', 'heard', 'heard']);
    // Each row is stamped with, and keyed on, its own utterance — so it is stable across renders.
    expect(rows.map((row) => row.timestamp)).toEqual([1_000, 2_000, 3_000]);
    expect(rows.every((row) => row.type === 'user')).toBe(true);
  });

  test('the rows follow the order the person SPOKE, not the order the endpoint answered', () => {
    // The endpoint answers its commits out of order, so a caption for seq 2 can arrive before seq 1's.
    // `seq` is the segment the utterance was spoken in, so the rows are placed by it, not by arrival.
    const captions = [
      caption('c', '第三句。', 3_000, true, 2),
      caption('a', '第一句。', 1_000, true, 0),
      caption('b', '第二句。', 2_000, true, 1),
    ];
    const rows = voiceTranscriptRows({ captions, deliveries: [], visibleMessages: [] });
    expect(rows.map((row) => row.content)).toEqual(['第一句。', '第二句。', '第三句。']);
  });

  test('the delivery finalises the utterances into ONE real message, leaving none of them as a row of its own', () => {
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
    // One row in, one row out: the three utterance rows are absorbed by the delivery that carries them,
    // and the message it became is the row that stays.
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

  test('before that message is visible the utterance rows STAY, so the words never vanish in the window', () => {
    // The same delivery, the same caption — only `visibleMessages` differs. A delivery whose message is
    // not on screen yet must not claim its words: they stay on the row, marked in flight.
    const captions = [caption('a', '第一句。', 1_000, true, 0)];
    const rows = voiceTranscriptRows({ captions, deliveries: [deliveryTaking(['a'])], visibleMessages: [] });
    expect(rows.map((row) => row.id)).toEqual(['voice-caption-a']);
    expect(rows[0]!.content).toBe('第一句。');
    expect(rows[0]!.voiceRowState).toBe('delivering');
  });

  test('empty and whitespace-only captions produce no row at all', () => {
    // The endpoint emits an empty transcription beside its interim text, and a blank row is not
    // something the person said.
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

describe('foldCaptionsIntoTranscriptRow — the join rule, kept (no production call point)', () => {
  test('three CJK utterances fold into ONE row, with no space between them and in the order they arrived', () => {
    const captions = [
      caption('a', '这个逻辑不要放在前。', 1_000),
      caption('b', '放到 server。那边去。', 2_000),
      caption('c', '顺便把测试补上。', 3_000),
    ];
    const row = foldCaptionsIntoTranscriptRow(captions, [], []);
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
      [],
    );
    expect(row?.content).toBe('change the timeout in voice.service.ts to thirty seconds');
  });

  test('a CJK piece followed by a latin one is joined with a space, not welded together', () => {
    const row = foldCaptionsIntoTranscriptRow([caption('a', '这是第一段', 1_000), caption('b', 'and the second', 2_000)], [], []);
    expect(row?.content).toBe('这是第一段 and the second');
  });

  test('an utterance still being spoken is part of the row, in its latest text', () => {
    const row = foldCaptionsIntoTranscriptRow(
      [caption('a', '说完的一句。', 1_000), caption('b', '说到一半', 2_000, false)],
      [],
      [],
    );
    expect(row?.content).toBe('说完的一句。说到一半');
  });

  test('empty and whitespace-only captions produce no row at all', () => {
    expect(foldCaptionsIntoTranscriptRow([], [], [])).toBeNull();
    expect(foldCaptionsIntoTranscriptRow([caption('a', '', 1_000)], [], [])).toBeNull();
    expect(foldCaptionsIntoTranscriptRow([caption('a', '   ', 1_000), caption('b', '\n\t', 2_000)], [], [])).toBeNull();
  });

  test('a wordless caption is not a piece either: it adds no text and no separator of its own', () => {
    const row = foldCaptionsIntoTranscriptRow(
      [caption('a', '', 1_000), caption('b', '真的说了这一句。', 2_000), caption('c', '  ', 3_000)],
      [],
      [],
    );
    expect(row?.content).toBe('真的说了这一句。');
    // The row's time is the first utterance it actually carries — the moment words were first seen.
    expect(row?.timestamp).toBe(2_000);
    expect(row?.id).toBe('voice-caption-b');
  });

  test('the utterances a delivery has already SHOWN are left out, so the row is rebuilt from what is still in flight', () => {
    const captions = [caption('a', '第一句。', 1_000), caption('b', '第二句。', 2_000), caption('c', '第三句。', 3_000)];
    const visible = [shownRow()];
    const row = foldCaptionsIntoTranscriptRow(captions, [deliveryTaking(['a', 'b'])], visible);
    expect(row?.content).toBe('第三句。');
    expect(row?.id).toBe('voice-caption-c');
    expect(row?.timestamp).toBe(3_000);
    // Everything spoken has been taken over: there is no row left to show.
    expect(foldCaptionsIntoTranscriptRow(captions, [deliveryTaking(['a', 'b', 'c'])], visible)).toBeNull();
  });

  test('until that message is visible the words are NOT taken over, however many deliveries were recorded', () => {
    // The same delivery, the same captions — only `visibleMessages` differs. The removal key is the
    // message being on screen, not the fact that the server accepted the send.
    const captions = [caption('a', '第一句。', 1_000), caption('b', '第二句。', 2_000)];
    const row = foldCaptionsIntoTranscriptRow(captions, [deliveryTaking(['a', 'b'])], []);
    expect(row?.content).toBe('第一句。第二句。');
    expect(row?.id).toBe('voice-caption-a');
  });

  test('the delivery finalises the folded row: the real message takes its place as the caption row goes', () => {
    const captions = [caption('a', '第一句。', 1_000), caption('b', '第二句。', 2_000)];
    const row = foldCaptionsIntoTranscriptRow(captions, [], []);
    const delivered = deliveryTaking(['a', 'b']);
    const real = shownRow();
    const out = markDeliveredVoiceMessages([real], row ? [row] : [], [delivered]);
    // One row in, one row out: the provisional row is absorbed by the delivery that carries its
    // utterances, and the message it became is the row that stays.
    expect(out.captionRows).toEqual([]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.voiceTranscript).toEqual({ heard: ['a', 'b'] });
  });
});
