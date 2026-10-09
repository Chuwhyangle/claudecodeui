import { describe, expect, test } from 'vitest';

import { placeCaptionsChronologically } from '@/modules/chat/voice-realtime/placeCaptions';
import type { ChatMessage } from '@/shared/types';

const row = (id: string, timestamp: unknown, type: ChatMessage['type'] = 'user'): ChatMessage =>
  ({ id, type, content: id, timestamp } as unknown as ChatMessage);
const ids = (rows: ChatMessage[]): string[] => rows.map((entry) => String(entry.id));

describe('placeCaptionsChronologically', () => {
  test('a caption lands before the real rows that came after it, not after Claude\'s reply', () => {
    const messages = [row('older', '2026-10-10T07:02:00Z'), row('sent', '2026-10-10T07:02:29Z'), row('reply', '2026-10-10T07:02:32Z', 'assistant')];
    const caption = row('voice-caption-a', Date.parse('2026-10-10T07:02:15Z'));
    expect(ids(placeCaptionsChronologically(messages, [caption]))).toEqual(['older', 'voice-caption-a', 'sent', 'reply']);
  });

  test('a caption newer than everything goes last, in its own order with the others', () => {
    const messages = [row('a', 1_000), row('b', 2_000)];
    const out = placeCaptionsChronologically(messages, [row('c2', 4_000), row('c1', 3_000)]);
    expect(ids(out)).toEqual(['a', 'b', 'c1', 'c2']);
  });

  test('captions interleave with the rows around them, keeping both sequences intact', () => {
    const messages = [row('m1', 1_000), row('m2', 3_000), row('m3', 5_000)];
    const out = placeCaptionsChronologically(messages, [row('c1', 2_000), row('c2', 4_000)]);
    expect(ids(out)).toEqual(['m1', 'c1', 'm2', 'c2', 'm3']);
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
