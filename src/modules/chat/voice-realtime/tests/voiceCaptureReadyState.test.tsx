import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import { useEffect } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { VoiceRealtimeBar, useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import type {
  VoiceRealtimeAudioFrame,
  VoiceRealtimeAudioSource,
} from '@/modules/chat/voice-realtime/audioSource';
import type { VoiceRealtimeSession } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

/**
 * (this task) The bar must not claim words for phases the person cannot act on — and the capture
 * reading must stay legible without any.
 *
 * THE CLAIM. `state: open` says the UPSTREAM session is up; capture is asynchronous
 * (`getUserMedia` → `AudioContext` → the worklet), so it can be hundreds of milliseconds — much
 * longer on the first permission grant — before the first audio frame exists. That window used to be
 * named in copy. It is deliberately silent now (the entry sound marks the live moment instead), so
 * what this file pins is the stable reading: `data-capture="starting"` until the first frame and
 * `"live"` from then on, the raw phase on `voice-realtime-phase`, and `Muted` still spoken.
 *
 * The hook and the shipped bar are the unit under test: the wire and the audio source are faked,
 * because this criterion is about what the PAGE does with them. Run:
 *   npx vitest run src/modules/chat/voice-realtime/tests/voiceCaptureReadyState.test.tsx
 */

const EN_CHAT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
) as { voice: { realtime: Record<string, unknown> & { errors: Record<string, string> } } };

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

/** A controllable audio source: the test pushes the frames, and the capture is ready only then. */
type FakeSource = VoiceRealtimeAudioSource & { push(frame: VoiceRealtimeAudioFrame): void };
const sources: FakeSource[] = [];
vi.mock('@/modules/chat/voice-realtime/audioSource', () => {
  const make = (): FakeSource => {
    let onFrame: ((frame: VoiceRealtimeAudioFrame) => void) | null = null;
    const source: FakeSource = {
      async start(handler) {
        onFrame = handler;
      },
      stop() {
        /* nothing to release in the fake */
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
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
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
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
}

const frame = (samples: number[]): VoiceRealtimeAudioFrame => ({ samples: Float32Array.from(samples), sourceRate: 16_000 });

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

/** The bar over the REAL hook, so the reading is what the shipped bar renders. */
function BarOverHook({ onSession }: { onSession: (voice: VoiceRealtimeSession) => void }) {
  const voice = useVoiceRealtimeSession({ sessionId: 'sess-1' });
  useEffect(() => {
    onSession(voice);
  });
  return <VoiceRealtimeBar voice={voice} onExit={() => {}} />;
}

const mountBar = () => {
  let latest: VoiceRealtimeSession | null = null;
  const view = render(
    <BarOverHook
      onSession={(voice) => {
        latest = voice;
      }}
    />,
  );
  const session = (): VoiceRealtimeSession => latest!;
  const status = (): HTMLElement => view.container.querySelector<HTMLElement>('[data-testid="voice-realtime-status"]')!;
  return { ...view, session, status };
};

describe('the transient phases carry no words, and the capture reading stays on the element', () => {
  test('(a) upstream open with no captured frame yet: no words, and data-capture="starting"', () => {
    const { session, status, container } = mountBar();
    act(() => session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));

    // The connection is open — the premise this reading is about.
    expect(session().phase).toBe('arming');
    expect(session().captureReady).toBe(false);

    // Transient phases are silent: no "starting the microphone" word to watch for.
    expect(status().textContent).toBe('');
    // The stable reading, independent of copy.
    expect(status().getAttribute('data-capture')).toBe('starting');
    // The raw phase seam agrees.
    expect(container.querySelector('[data-testid="voice-realtime-phase"]')?.textContent).toBe('arming');
  });

  test('(b) the first captured frame promotes the phase to listening and data-capture="live", still wordless', () => {
    const { session, status } = mountBar();
    act(() => session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));

    act(() => sources[0]!.push(frame([0.1])));

    expect(session().phase).toBe('listening');
    expect(session().captureReady).toBe(true);
    expect(status().textContent).toBe('');
    expect(status().getAttribute('data-capture')).toBe('live');
  });

  test('a muted session keeps its word when the first frame arrives, and unmute returns to the silent listening cell', () => {
    const { session, status } = mountBar();
    act(() => session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));

    // Mute is offered while arming; the phase stays muted whether or not capture has started.
    act(() => session().mute());
    expect(session().phase).toBe('muted');
    expect(status().textContent).toBe('Muted');

    act(() => sources[0]!.push(frame([0.1])));
    // The frame is recorded as readiness (capture IS running) but it must not override Mute.
    expect(session().captureReady).toBe(true);
    expect(session().phase).toBe('muted');
    expect(status().getAttribute('data-capture')).toBe('live');

    act(() => session().unmute());
    expect(session().phase).toBe('listening');
    expect(status().textContent).toBe('');
  });
});
