/**
 * The two placement/marking rules that survive the caption-row removal (this task).
 *
 * WHAT WAS DELETED, AND WHY. This file used to also cover the rule that hid a caption whose words a
 * real message repeated verbatim, and the caption-row half of the delivered-marking rule (which used
 * to claim a delivery's captions and drop them). Both existed only to keep a client-side row of the
 * person's own words from standing beside the real message: one de-duplicated them, the other
 * absorbed them. With the provisional rows gone there is nothing to de-duplicate or absorb, so that
 * rule and its describe went with them, and the delivered-marking rule now takes its messages and
 * deliveries and returns the messages with the spoken mark only. The assertions that remain describe
 * what production actually does today; no assertion was turned into a tautology to keep the file
 * green.
 *
 * `placeCaptionsChronologically` is the fallback placement: a pending row with no segment to place
 * by rides after the whole real transcript, so the two clocks (browser stamp on a voice row, CLI-turn
 * stamp on a real one) can never put the person's live words ABOVE the message Claude is answering.
 */

import { describe, expect, test } from 'vitest';

import {
  markDeliveredVoiceMessages,
  placeCaptionsChronologically,
  undeliveredUtteranceRows,
} from '@/modules/chat/voice-realtime/placeCaptions';
import type { ChatMessage } from '@/shared/types';

const row = (id: string, timestamp: unknown, type: ChatMessage['type'] = 'user'): ChatMessage =>
  ({ id, type, content: id, timestamp } as unknown as ChatMessage);
const ids = (rows: ChatMessage[]): string[] => rows.map((entry) => String(entry.id));

describe('placeCaptionsChronologically', () => {
  test('a refused utterance spoken before the newest real row is placed BELOW it, not above it', () => {
    // 2026-10-11 15:41 timeline (voice journal 57279cc1): the person said B while Claude answered A.
    // A's real user row is stamped at the CLI turn's start (15:41:30.521) — a coalescing window plus a
    // queue wait after A was spoken — while B's row is stamped when the browser first saw it
    // (15:41:20.757). Comparing the browser clock to the CLI clock put B ABOVE the message Claude was
    // still answering. A pending row is by definition spoken words with no real message of their own
    // yet, so it can only belong after the newest real user row and that turn's reply.
    const visibleMessages = [row('userA', '2026-10-11T15:41:30.521Z'), row('reply-A', '2026-10-11T15:41:35Z', 'assistant')];
    const captions = [{ itemId: 'b', text: '我会发现泡泡跑上面去', final: true, at: Date.parse('2026-10-11T15:41:20.757Z') }];
    const refused = undeliveredUtteranceRows(captions, ['b'], visibleMessages);
    const out = ids(placeCaptionsChronologically(visibleMessages, refused));
    expect(out.indexOf('voice-undelivered-b')).toBeGreaterThan(out.indexOf('userA'));
    expect(out.indexOf('voice-undelivered-b')).toBeGreaterThan(out.indexOf('reply-A'));
  });

  test('a pending row lands after the real rows that came before it, not before the last one Claude is answering', () => {
    const messages = [
      row('older', '2026-10-10T07:02:00Z'),
      row('sent', '2026-10-10T07:02:29Z'),
      row('reply', '2026-10-10T07:02:32Z', 'assistant'),
    ];
    const pending = row('voice-undelivered-a', Date.parse('2026-10-10T07:02:15Z'));
    expect(ids(placeCaptionsChronologically(messages, [pending]))).toEqual(['older', 'sent', 'reply', 'voice-undelivered-a']);
  });

  test('a pending row newer than everything goes last, in its own order with the others', () => {
    const messages = [row('a', 1_000), row('b', 2_000)];
    const out = placeCaptionsChronologically(messages, [row('c2', 4_000), row('c1', 3_000)]);
    expect(ids(out)).toEqual(['a', 'b', 'c1', 'c2']);
  });

  test('pending rows go after every real user row, never interleaved among them', () => {
    const messages = [row('m1', 1_000), row('m2', 3_000), row('m3', 5_000)];
    const out = placeCaptionsChronologically(messages, [row('c1', 2_000), row('c2', 4_000)]);
    expect(ids(out)).toEqual(['m1', 'm2', 'm3', 'c1', 'c2']);
  });

  test('rows whose time cannot be read keep their place and never pull a pending row ahead of them', () => {
    const messages = [row('m1', 1_000), row('unstamped', undefined), row('m2', 3_000)];
    const out = placeCaptionsChronologically(messages, [row('c', 2_000)]);
    expect(ids(out)).toEqual(['m1', 'unstamped', 'c', 'm2']);
  });

  test('no pending rows is the same list', () => {
    const messages = [row('a', 1), row('b', 2)];
    expect(ids(placeCaptionsChronologically(messages, []))).toEqual(['a', 'b']);
  });
});

describe('markDeliveredVoiceMessages', () => {
  const real = (id: string, text: string, at: number): ChatMessage => ({ ...row(id, at), content: text } as ChatMessage);

  test('the delivered message becomes the spoken row, carrying what the model relayed it heard', () => {
    const out = markDeliveredVoiceMessages(
      [real('m', 'Change the timeout in voice.service.ts to 30 seconds.', 5_000)],
      [
        {
          message: 'Change the timeout in voice.service.ts to 30 seconds.',
          at: 4_000,
          heard: ['Change the timeout in.', 'Voice service ts to thirty seconds.'],
          itemIds: ['a', 'b'],
        },
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.voiceTranscript).toEqual({ heard: ['Change the timeout in.', 'Voice service ts to thirty seconds.'] });
    expect(out[0]!.content).toBe('Change the timeout in voice.service.ts to 30 seconds.');
  });

  test('until the delivered message is in the transcript, nothing is marked', () => {
    const out = markDeliveredVoiceMessages([], [
      { message: '放到 server。', at: 2_000, heard: ['放到 server。'], itemIds: ['a'] },
    ]);
    expect(out).toEqual([]);
  });

  test('each real message is claimed by one delivery, in order', () => {
    const out = markDeliveredVoiceMessages(
      [real('m1', '第一句话', 5_000), real('m2', '第二句话', 9_000)],
      [
        { message: '第一句话', at: 4_000, heard: ['第一句话'], itemIds: [] },
        { message: '第二句话', at: 8_000, heard: ['第二句话'], itemIds: [] },
      ],
    );
    expect(out.map((message) => message.voiceTranscript !== undefined)).toEqual([true, true]);
  });

  test('a message typed earlier with the same words is not mistaken for the spoken one', () => {
    const out = markDeliveredVoiceMessages(
      [real('typed', '请启动 server', 1_000), real('spoken', '请启动 server', 100_000)],
      [{ message: '请启动 server', at: 99_000, heard: ['请启动 server'], itemIds: [] }],
    );
    expect(out[0]!.voiceTranscript).toBeUndefined();
    expect(out[1]!.voiceTranscript).toBeDefined();
  });
});
