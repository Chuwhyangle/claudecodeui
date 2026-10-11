import { describe, expect, test } from 'vitest';

import { dropCaptionsDeliveredAsMessages, markDeliveredVoiceMessages, placeCaptionsChronologically, undeliveredUtteranceRows } from '@/modules/chat/voice-realtime/placeCaptions';
import type { ChatMessage } from '@/shared/types';

const row = (id: string, timestamp: unknown, type: ChatMessage['type'] = 'user'): ChatMessage =>
  ({ id, type, content: id, timestamp } as unknown as ChatMessage);
const ids = (rows: ChatMessage[]): string[] => rows.map((entry) => String(entry.id));

describe('placeCaptionsChronologically', () => {
  test('a caption spoken while the previous turn is still in flight stays BELOW that turn, never above its message', () => {
    // 2026-10-11 15:41 timeline (voice journal 57279cc1): the person said B while Claude answered A.
    // A's real user row is stamped at the CLI turn's start (15:41:30.521) — a coalescing window plus a
    // queue wait after A was spoken — while B's caption is stamped when the browser first saw it
    // (15:41:20.757). Comparing the browser clock to the CLI clock put B ABOVE the message Claude was
    // still answering. A caption still on screen is by definition words not yet delivered, so it can
    // only belong after the newest real user row and that turn's reply.
    const messages = [
      row('prev-reply', '2026-10-11T15:40:57Z', 'assistant'),
      row('userA', '2026-10-11T15:41:30.521Z'),
      row('reply-A', '2026-10-11T15:41:35Z', 'assistant'),
    ];
    const caption = { ...row('voice-caption-B', Date.parse('2026-10-11T15:41:20.757Z')), voiceRowState: 'delivering' } as ChatMessage;
    const out = ids(placeCaptionsChronologically(messages, [caption]));
    expect(out.indexOf('voice-caption-B')).toBeGreaterThan(out.indexOf('userA'));
    expect(out.indexOf('voice-caption-B')).toBeGreaterThan(out.indexOf('reply-A'));
  });

  test('a refused utterance spoken before the newest real row is placed BELOW it, not above it', () => {
    // The same clock skew, reached through the undelivered rows (AC6): the refused words were spoken
    // before the newest real user row was stamped, so placing them by time would put them above the
    // message Claude is answering instead of below it.
    const visibleMessages = [row('userA', '2026-10-11T15:41:30.521Z')];
    const captions = [{ itemId: 'b', text: '我会发现泡泡跑上面去', final: true, at: Date.parse('2026-10-11T15:41:20.757Z') }];
    const refused = undeliveredUtteranceRows(captions, ['b'], visibleMessages);
    const out = ids(placeCaptionsChronologically(visibleMessages, refused));
    expect(out.indexOf('voice-undelivered-b')).toBeGreaterThan(out.indexOf('userA'));
  });

  test('a caption lands after the real rows that came before it, not before the last one Claude is answering', () => {
    const messages = [row('older', '2026-10-10T07:02:00Z'), row('sent', '2026-10-10T07:02:29Z'), row('reply', '2026-10-10T07:02:32Z', 'assistant')];
    const caption = row('voice-caption-a', Date.parse('2026-10-10T07:02:15Z'));
    expect(ids(placeCaptionsChronologically(messages, [caption]))).toEqual(['older', 'sent', 'reply', 'voice-caption-a']);
  });

  test('a caption newer than everything goes last, in its own order with the others', () => {
    const messages = [row('a', 1_000), row('b', 2_000)];
    const out = placeCaptionsChronologically(messages, [row('c2', 4_000), row('c1', 3_000)]);
    expect(ids(out)).toEqual(['a', 'b', 'c1', 'c2']);
  });

  test('captions go after every real user row, never interleaved among them', () => {
    const messages = [row('m1', 1_000), row('m2', 3_000), row('m3', 5_000)];
    const out = placeCaptionsChronologically(messages, [row('c1', 2_000), row('c2', 4_000)]);
    expect(ids(out)).toEqual(['m1', 'm2', 'm3', 'c1', 'c2']);
  });

  test('rows whose time cannot be read keep their place and never pull a caption ahead of them', () => {
    const messages = [row('m1', 1_000), row('unstamped', undefined), row('m2', 3_000)];
    const out = placeCaptionsChronologically(messages, [row('c', 2_000)]);
    expect(ids(out)).toEqual(['m1', 'unstamped', 'c', 'm2']);
  });

  test('no captions is the same list', () => {
    const messages = [row('a', 1), row('b', 2)];
    expect(ids(placeCaptionsChronologically(messages, []))).toEqual(['a', 'b']);
  });
});

describe('dropCaptionsDeliveredAsMessages', () => {
  const real = (id: string, text: string, at: number): ChatMessage => ({ ...row(id, at), content: text } as ChatMessage);
  const caption = (id: string, text: string, at: number): ChatMessage => ({ ...row(id, at), content: text } as ChatMessage);

  test('a caption whose words were delivered verbatim is not shown twice', () => {
    const out = dropCaptionsDeliveredAsMessages(
      [real('m', '好，这句话就是语音输入的。', 2_000)],
      [caption('c', '好，这句话就是语音输入的。', 1_000)],
    );
    expect(out).toEqual([]);
  });

  test('punctuation, spacing and case do not hide a match', () => {
    const out = dropCaptionsDeliveredAsMessages(
      [real('m', 'Change the timeout in voice.service.ts to 30 seconds.', 2_000)],
      [caption('c', 'change the timeout in voice service ts to 30 seconds', 1_000)],
    );
    expect(out).toEqual([]);
  });

  test('pieces that were joined into one delivered message are each dropped', () => {
    const out = dropCaptionsDeliveredAsMessages(
      [real('m', '这个逻辑不要放在前。端。放到 server。那边去。', 5_000)],
      [caption('a', '这个逻辑不要放在前。', 1_000), caption('b', '放到 server。', 2_000), caption('c', '那边去。', 3_000)],
    );
    expect(out).toEqual([]);
  });

  test('a caption that differs from what was sent stays, so heard-versus-sent is visible', () => {
    const heard = caption('c', 'what the endpoint transcribed from the uploaded audio', 1_000);
    const out = dropCaptionsDeliveredAsMessages([real('m', 'voice instruction delivered from the uploaded fixture', 2_000)], [heard]);
    expect(out).toEqual([heard]);
  });

  test('a caption older than the real message by far, or with no message at all, stays', () => {
    const early = caption('c', '同样的一句话在更早之前', 100_000);
    expect(dropCaptionsDeliveredAsMessages([real('m', '同样的一句话在更早之前', 1_000)], [early])).toEqual([early]);
    const lonely = caption('d', '没有被转发的话', 1_000);
    expect(dropCaptionsDeliveredAsMessages([], [lonely])).toEqual([lonely]);
  });

  test('a one- or two-character fragment is left alone', () => {
    const tiny = caption('c', '端。', 1_000);
    expect(dropCaptionsDeliveredAsMessages([real('m', '端口转发', 2_000)], [tiny])).toEqual([tiny]);
  });
});

describe('markDeliveredVoiceMessages', () => {
  const real = (id: string, text: string, at: number): ChatMessage => ({ ...row(id, at), content: text } as ChatMessage);
  const caption = (itemId: string, text: string, at: number): ChatMessage => ({ ...row(`voice-caption-${itemId}`, at), content: text } as ChatMessage);

  test('the delivered message becomes the spoken row, carrying what was heard, and its captions go', () => {
    const out = markDeliveredVoiceMessages(
      [real('m', 'Change the timeout in voice.service.ts to 30 seconds.', 5_000)],
      [caption('a', 'Change the timeout in.', 1_000), caption('b', 'Voice service ts to thirty seconds.', 2_000)],
      [{ message: 'Change the timeout in voice.service.ts to 30 seconds.', at: 4_000, heard: ['Change the timeout in.', 'Voice service ts to thirty seconds.'], itemIds: ['a', 'b'] }],
    );
    expect(out.captionRows).toEqual([]);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.voiceTranscript).toEqual({ heard: ['Change the timeout in.', 'Voice service ts to thirty seconds.'] });
    expect(out.messages[0]!.content).toBe('Change the timeout in voice.service.ts to 30 seconds.');
  });

  test('until the delivered message is in the transcript, its captions stay so the words never vanish', () => {
    const captions = [caption('a', '放到 server。', 1_000)];
    const out = markDeliveredVoiceMessages([], captions, [{ message: '放到 server。', at: 2_000, heard: ['放到 server。'], itemIds: ['a'] }]);
    expect(out.captionRows).toEqual(captions);
    expect(out.messages).toEqual([]);
  });

  test('each real message is claimed by one delivery, in order', () => {
    const out = markDeliveredVoiceMessages(
      [real('m1', '第一句话', 5_000), real('m2', '第二句话', 9_000)],
      [],
      [
        { message: '第一句话', at: 4_000, heard: ['第一句话'], itemIds: [] },
        { message: '第二句话', at: 8_000, heard: ['第二句话'], itemIds: [] },
      ],
    );
    expect(out.messages.map((message) => message.voiceTranscript !== undefined)).toEqual([true, true]);
  });

  test('a message typed earlier with the same words is not mistaken for the spoken one', () => {
    const out = markDeliveredVoiceMessages(
      [real('typed', '请启动 server', 1_000), real('spoken', '请启动 server', 100_000)],
      [],
      [{ message: '请启动 server', at: 99_000, heard: ['请启动 server'], itemIds: [] }],
    );
    expect(out.messages[0]!.voiceTranscript).toBeUndefined();
    expect(out.messages[1]!.voiceTranscript).toBeDefined();
  });

  test('a caption row is never itself taken for the delivered message', () => {
    const cap = caption('a', '同样的话', 5_000);
    const out = markDeliveredVoiceMessages([cap], [], [{ message: '同样的话', at: 4_000, heard: [], itemIds: [] }]);
    expect(out.messages[0]!.voiceTranscript).toBeUndefined();
  });
});
