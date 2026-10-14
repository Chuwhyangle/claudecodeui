/**
 * THE ONE pushed message Live Voice holds while Claude is busy (ruling 2026-10-14) — the browser half.
 *
 * WHAT THIS PINS. The relay merges every sentence spoken while the bound session is busy into ONE
 * message and sends the browser a `pending` frame carrying its text as it grows. The page must draw
 * exactly ONE read-only card for it — the same card, its text changing — and never a stack of one row
 * per sentence, which is the defect the ruling abolished. An empty `text` is the CLEAR: the hold was
 * delivered, and the card comes down with it. A refused piece (the hold's byte bound) takes the
 * caption line with ONE readable sentence instead of a new page element.
 *
 * WHY HERE AND NOT IN THE SERVER SUITE. The server suite proves what the proxy SAYS (`pending`
 * frames, their text and the delivery count); this proves what the PAGE DOES with it — how many cards
 * are on screen, what they say, and that nothing on them can be pressed. The two halves are the same
 * ruling read from the two ends, and neither can stand in for the other.
 *
 * THE LAST CASE IS AC4 (exit must not duplicate). The words the relay is holding are undelivered by
 * the delivery test, so they would be handed to the composer as a draft — and then delivered a second
 * time by the proxy's own teardown flush. The leave reads the hold and leaves those words out, and
 * that is what this case drives: the exact expression `ChatInterface`'s leave handler evaluates.
 *
 * Run: npm run test:client -- src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import { useEffect, useRef } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  VoicePendingMessageCard,
  VoiceRealtimeBar,
  collectUndeliveredUtterances,
  useVoiceRealtimeSession,
} from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeAudioFrame, VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import type { VoiceRealtimeSession } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

/** The shipped English copy, read as data so a copy edit is not a test edit. */
const EN_CHAT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
) as { voice: { realtime: Record<string, unknown> } };

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: EN_CHAT } },
  interpolation: { escapeValue: false },
});

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

type FakeSource = VoiceRealtimeAudioSource & { push(frame: VoiceRealtimeAudioFrame): void; stopped: number };
const sources: FakeSource[] = [];
vi.mock('@/modules/chat/voice-realtime/audioSource', () => {
  const make = (): FakeSource => {
    let onFrame: ((frame: VoiceRealtimeAudioFrame) => void) | null = null;
    const source: FakeSource = {
      stopped: 0,
      async start(handler) {
        onFrame = handler;
      },
      stop() {
        source.stopped += 1;
      },
      push(frame) {
        onFrame?.(frame);
      },
    };
    sources.push(source);
    return source;
  };
  return { microphoneAudioSource: make, fileAudioSource: make };
});

/** The slice of WebSocket the hook uses, with a hand to deliver server frames. */
class FakeWebSocket {
  static readonly OPEN = 1;
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

const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

beforeEach(() => {
  auth.token = 'jwt-token';
  FakeWebSocket.instances = [];
  sources.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The REAL bar over a LIVE session, wired the way `ChatInterface` wires it: the card the pane hands
 * the bar's `pendingMessage` slot is built from `voice.pendingMessage`, so what a person reads here is
 * the reading the pane would draw, not a prop the test made up.
 */
function BarOverHook({
  onSession,
  busy,
}: {
  onSession: (voice: VoiceRealtimeSession) => void;
  busy?: boolean;
}) {
  const voice = useVoiceRealtimeSession({ sessionId: 'sess-1' });
  useEffect(() => {
    onSession(voice);
  });
  return (
    <VoiceRealtimeBar
      voice={voice}
      busy={busy}
      onExit={() => {}}
      pendingMessage={<VoicePendingMessageCard text={voice.pendingMessage} />}
    />
  );
}

function mountBar(busy = false) {
  let latest: VoiceRealtimeSession | null = null;
  const view = render(
    <BarOverHook
      busy={busy}
      onSession={(voice) => {
        latest = voice;
      }}
    />,
  );
  return { ...view, session: (): VoiceRealtimeSession => latest! };
}

/** Opens the (fake) connection so the page is past the handshake and a frame is acted on. */
const open = (session: () => VoiceRealtimeSession) => {
  act(() => session().start());
  act(() => socket().receive({ type: 'state', state: 'open' }));
};

const cards = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-testid="voice-pending-message"]'));

describe('the ONE held message is ONE read-only card', () => {
  test('AC2: three `pending` frames draw exactly one card, carrying the LAST frame\'s text and no button', () => {
    const { container, session } = mountBar();
    open(session);

    // As more is said the SAME card's text grows — never a second card.
    act(() => socket().receive({ type: 'pending', text: '第一句', bytes: 9 }));
    act(() => socket().receive({ type: 'pending', text: '第一句 第二句', bytes: 20 }));
    act(() => socket().receive({ type: 'pending', text: '第一句 第二句 第三句', bytes: 32 }));

    const drawn = cards(container);
    expect(drawn.length, 'three sentences while busy are ONE merged message, so ONE card').toBe(1);
    expect(drawn[0]!.textContent).toContain('第一句 第二句 第三句');
    // The card is READ-ONLY: nothing inside it can be pressed, so nothing can be read as "withdraw".
    expect(drawn[0]!.querySelectorAll('button').length, 'the held-message card offers no control').toBe(0);
  });

  test('AC2: the clear frame (`text: ""`) takes the card down, and an idle session never draws one', () => {
    const { container, session } = mountBar();
    open(session);

    // The negative control: before anything is held there is no card at all.
    expect(cards(container).length).toBe(0);

    act(() => socket().receive({ type: 'pending', text: 'waiting words', bytes: 13 }));
    expect(cards(container).length).toBe(1);

    // Delivered: the hold is empty, and the card goes with it.
    act(() => socket().receive({ type: 'pending', text: '', bytes: 0 }));
    expect(cards(container).length, 'the delivered hold must leave no card behind').toBe(0);
  });

  test('AC2: a refused piece takes the caption line with ONE sentence, and adds no page element', () => {
    const { container, session } = mountBar(true);
    open(session);

    // A sentence is spoken, then a piece the relay will not hold is refused.
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '开头', final: true }));
    act(() => socket().receive({ type: 'refused', reason: 'queue-full', depth: 1, bytes: 1012 }));

    const notice = container.querySelector<HTMLElement>('[data-testid="voice-realtime-refusal"]');
    expect(notice, 'the over-cap piece must be told in the caption line').not.toBeNull();
    expect(notice!.textContent).toBe(EN_CHAT.voice.realtime.queueFull as string);
    // The notice is copy on the line the bar already has — not a new element of its own, and not a card.
    expect(cards(container).length, 'a refusal is not a held message').toBe(0);
    expect(
      container.querySelectorAll('[data-testid="voice-realtime-refusal"]').length,
      'one refusal, one sentence — never a stack',
    ).toBe(1);

    // And the next delivery clears it: the queue it described has moved.
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, depth: 0, bytes: 0 }));
    expect(container.querySelector('[data-testid="voice-realtime-refusal"]')).toBeNull();
  });
});

describe('leaving Live Voice with a message still held', () => {
  /**
   * The exact expression `ChatInterface`'s leave handler evaluates, over the LIVE session — the draft
   * the composer would be handed. Rendered in a component so the hook's own state is what is read.
   */
  function LeaveBacklog({
    onBacklog,
    onSession,
  }: {
    onBacklog: (draft: string) => void;
    onSession: (voice: VoiceRealtimeSession) => void;
  }) {
    const voice = useVoiceRealtimeSession({ sessionId: 'sess-1' });
    const latest = useRef(voice);
    latest.current = voice;
    useEffect(() => {
      onSession(voice);
      const draft = collectUndeliveredUtterances(voice.captions, voice.deliveries, voice.pendingMessage);
      onBacklog(draft);
    });
    return null;
  }

  test('AC4: the held words are NOT offered back to the composer, and the genuinely-lost ones are', () => {
    let draft = '';
    let live: VoiceRealtimeSession | null = null;
    render(
      <LeaveBacklog
        onBacklog={(next) => { draft = next; }}
        onSession={(voice) => { live = voice; }}
      />,
    );
    act(() => live!.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));

    // Two finished utterances, then the relay holds them while the session is busy.
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '被扣住的第一句', final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'b', text: '被扣住的第二句', final: true }));
    act(() => socket().receive({ type: 'pending', text: '被扣住的第一句 被扣住的第二句', bytes: 44 }));

    // A third the model never relayed at all — the words a leave really does lose.
    act(() => socket().receive({ type: 'caption', itemId: 'c', text: '从未送出的那句', final: true }));

    // THE READING THE LEAVE MAKES. The hold's words are on their way (the proxy delivers them on
    // teardown), so re-typing them would send them twice; the third is going nowhere and must come
    // back. A page that ignored the hold would put all three in the box.
    expect(draft).toContain('从未送出的那句');
    expect(draft).not.toContain('被扣住的第一句');
    expect(draft).not.toContain('被扣住的第二句');
  });
});
