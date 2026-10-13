/**
 * Attribution: a delivery answers what the MODEL HAD IN FRONT OF IT, not what it chose to repeat.
 *
 * WHY THIS FILE EXISTS. On 2026-10-13 a live session (journal `af5559c0`, session `aec453a1`,
 * continuous) left two caption bubbles on screen that could never be dismissed, and — on leaving
 * the mode — dumped a jumbled paragraph into the composer made of sentences that HAD been handled.
 * The old claim step matched each pending caption's text against the delivery's message. A model
 * that rewords or omits one of several sentences it answers in one call breaks that match, and the
 * sentence then sits in a state with no way out.
 *
 * THE RULE THAT REPLACES IT. The relay reports the endpoint's conversation boundary with the
 * delivery (`coveredThroughItemId` — the last user item committed when the instruction was
 * relayed). Everything at or before it was in the model's conversation; the model disposed of
 * those sentences — relayed, reworded, merged, or deliberately dropped — and they fold into the
 * delivery's row. Only speech committed AFTER the boundary is still pending, and that is the only
 * speech the composer draft may carry on leaving. "Disposed of" is not a euphemism for "delivered":
 * the delivery's own message is what the person reads to see what actually went.
 *
 * THE SHAPE BELOW IS THE ONE THAT ACTUALLY HAPPENED, verbatim from that journal: three final
 * captions spoken into one window; the model answered with ONE `session_send` whose message covers
 * the first and third (the first rewritten) and omits the second entirely.
 *
 * Run: npx vitest run src/modules/chat/voice-realtime/tests/voiceAttributionRewriteGap.test.tsx
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { collectUndeliveredUtterances, useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import type {
  VoiceRealtimeAudioFrame,
  VoiceRealtimeAudioSource,
  VoiceRealtimeMicSuspension,
} from '@/modules/chat/voice-realtime/audioSource';

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: {
    en: {
      chat: JSON.parse(
        readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
      ) as Record<string, unknown>,
    },
  },
  interpolation: { escapeValue: false },
});

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

type FakeSource = VoiceRealtimeAudioSource & {
  push(frame: VoiceRealtimeAudioFrame): void;
  reportSuspension(event: VoiceRealtimeMicSuspension): void;
  stopped: number;
};
const sources: FakeSource[] = [];
vi.mock('@/modules/chat/voice-realtime/audioSource', () => {
  const make = (): FakeSource => {
    let onFrame: ((frame: VoiceRealtimeAudioFrame) => void) | null = null;
    let onSuspension: ((event: VoiceRealtimeMicSuspension) => void) | null = null;
    const source: FakeSource = {
      stopped: 0,
      async start(handler, suspensionHandler) {
        onFrame = handler;
        onSuspension = suspensionHandler ?? null;
      },
      stop() {
        source.stopped += 1;
      },
      push(frame) {
        onFrame?.(frame);
      },
      reportSuspension(event) {
        onSuspension?.(event);
      },
    };
    sources.push(source);
    return source;
  };
  return { microphoneAudioSource: make, fileAudioSource: make };
});

/** The slice of WebSocket the hook uses, with a hand to deliver server frames. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
}

beforeEach(() => {
  auth.token = 'jwt-token';
  FakeWebSocket.instances = [];
  sources.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
const openHook = () => {
  const hook = renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
  act(() => hook.result.current.start());
  act(() => socket().receive({ type: 'state', state: 'open' }));
  return hook;
};

/**
 * The window that actually happened: three final captions, one delivery. Kept as constants (not
 * inline strings) so the expectation below can name exactly which sentence the model dropped.
 */
const SAID_FIRST = '现在，在我的屏幕上，底部又多出了一个“waiting in the queue”的。';
const SAID_DROPPED = '呃。';
const SAID_LAST = '不管叫泡泡，或者说label。';
/** What the model actually relayed: the first REWRITTEN, the last kept, the middle one gone. */
const RELAYED_WITH_REWRITE =
  '现在在我的屏幕上，底部又多出了一个“waiting in the queue”这么一个不管叫泡泡或者说 label。';

const attributedIds = (result: { current: { deliveries: readonly { itemIds: readonly string[] }[] } }): Set<string> =>
  new Set(result.current.deliveries.flatMap((delivery) => delivery.itemIds));

describe('a rewritten relay settles everything the model had in front of it', () => {
  test('all three sentences are attributed — reworded, dropped-on-purpose, and verbatim alike', () => {
    const { result } = openHook();
    act(() => socket().receive({ type: 'caption', itemId: 'first', text: SAID_FIRST, final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'dropped', text: SAID_DROPPED, final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'last', text: SAID_LAST, final: true }));
    act(() =>
      socket().receive({
        type: 'sent',
        sessionId: 'sess-1',
        result: {},
        message: RELAYED_WITH_REWRITE,
        coveredThroughItemId: 'last',
      }),
    );

    const attributed = attributedIds(result);
    expect(attributed.has('first'), 'the reworded sentence was answered').toBe(true);
    expect(attributed.has('dropped'), 'the dropped sentence was answered').toBe(true);
    expect(attributed.has('last')).toBe(true);
    // Nothing comes back as a draft: every one of them was in front of the model.
    expect(collectUndeliveredUtterances(result.current.captions, result.current.deliveries)).toBe('');
  });

  test('no utterance is left in neither state — that state is the stuck bubble', () => {
    const { result } = openHook();
    act(() => socket().receive({ type: 'caption', itemId: 'first', text: SAID_FIRST, final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'dropped', text: SAID_DROPPED, final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'last', text: SAID_LAST, final: true }));
    act(() =>
      socket().receive({
        type: 'sent',
        sessionId: 'sess-1',
        result: {},
        message: RELAYED_WITH_REWRITE,
        coveredThroughItemId: 'last',
      }),
    );

    const attributed = attributedIds(result);
    const offeredBack = collectUndeliveredUtterances(result.current.captions, result.current.deliveries);
    for (const caption of result.current.captions.filter((entry) => entry.final)) {
      const settled = attributed.has(caption.itemId) || offeredBack.includes(caption.text);
      expect(settled, `"${caption.text}" is in neither state`).toBe(true);
    }
  });
});

describe('speech the boundary does not reach is still the model’s to answer', () => {
  test('a sentence committed after the delivery stays pending and is the whole draft', () => {
    const { result } = openHook();
    act(() => socket().receive({ type: 'caption', itemId: 'first', text: SAID_FIRST, final: true }));
    act(() =>
      socket().receive({
        type: 'sent',
        sessionId: 'sess-1',
        result: {},
        message: SAID_FIRST,
        coveredThroughItemId: 'first',
      }),
    );
    // Said after the model's boundary: nobody has handled this one yet.
    act(() => socket().receive({ type: 'caption', itemId: 'later', text: SAID_LAST, final: true }));

    expect(attributedIds(result).has('first')).toBe(true);
    expect(attributedIds(result).has('later')).toBe(false);
    expect(collectUndeliveredUtterances(result.current.captions, result.current.deliveries)).toBe(SAID_LAST);
  });
});

describe('negative control — the same window relays verbatim', () => {
  test('every sentence is attributed and nothing is offered back', () => {
    const { result } = openHook();
    act(() => socket().receive({ type: 'caption', itemId: 'first', text: SAID_FIRST, final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'last', text: SAID_LAST, final: true }));
    act(() =>
      socket().receive({
        type: 'sent',
        sessionId: 'sess-1',
        result: {},
        message: `${SAID_FIRST}${SAID_LAST}`,
        coveredThroughItemId: 'last',
      }),
    );

    const attributed = attributedIds(result);
    expect(attributed.has('first')).toBe(true);
    expect(attributed.has('last')).toBe(true);
    expect(collectUndeliveredUtterances(result.current.captions, result.current.deliveries)).toBe('');
  });
});

describe('fallback — a relay that reports no boundary', () => {
  test('the window rule still settles the sentences, so nothing is stranded', () => {
    const { result } = openHook();
    act(() => socket().receive({ type: 'caption', itemId: 'first', text: SAID_FIRST, final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'dropped', text: SAID_DROPPED, final: true }));
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: RELAYED_WITH_REWRITE }));

    expect(attributedIds(result).has('first')).toBe(true);
    expect(attributedIds(result).has('dropped')).toBe(true);
    expect(collectUndeliveredUtterances(result.current.captions, result.current.deliveries)).toBe('');
  });
});
