/**
 * AC-327 — the Live Voice delivery state is visible, linearly, on the ONE row that stands for what
 * the person is saying.
 *
 * THE CLAIM. The proxy accepts a `session_send` immediately but delivers it only when its 2.5 s
 * coalescing window closes. Before this, the page was told nothing during that window, so the
 * person's row sat frozen and read as "nothing happened". The server now emits one frame when the
 * window OPENS (`queued`); the page reads it as a boolean and stamps the row:
 *
 *   - a closed utterance sitting on the row, nothing accepted yet  → `heard`
 *   - the proxy has accepted the instruction, not yet delivered     → `delivering` (same row)
 *   - delivered: the real spoken message replaces the row           → neither, and the badge
 *
 * WHY THESE READINGS. `delivering` is the SERVER's own timeline, not a client timer that could show
 * "tidying up" for a wait that is not happening; the fold stamps the marker on the row it already
 * builds, so both states fall on the same row rather than a second control; and the marker is read
 * off the rendered DOM, because "the row says X" is a claim about what a reader sees.
 *
 * Run: npm run test:client -- src/modules/chat/voice-realtime/tests/voiceDeliveryState.test.tsx
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  foldCaptionsIntoTranscriptRow,
  useVoiceRealtimeSession,
  type VoiceRealtimeCaption,
} from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeAudioFrame, VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

const EN_CHAT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
) as Record<string, unknown>;

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: EN_CHAT } },
  interpolation: { escapeValue: false },
});

// ── the fake wire and audio source the hook half drives ──────────────────────────────────────

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

describe('the delivering flag follows the server, not a timer', () => {
  test('the accepted frame opens the window and `sent` closes it', () => {
    const { result } = openHook();
    expect(result.current.delivering).toBe(false);
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '把 server', final: true }));
    expect(result.current.delivering).toBe(false);
    // The proxy accepted the instruction: the wait is real and now visible.
    act(() => socket().receive({ type: 'queued' }));
    expect(result.current.delivering).toBe(true);
    // Delivered: the window is over.
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: '把 server' }));
    expect(result.current.delivering).toBe(false);
  });

  test('a new connection starts with the window closed', () => {
    const { result } = openHook();
    act(() => socket().receive({ type: 'queued' }));
    expect(result.current.delivering).toBe(true);
    act(() => result.current.start());
    expect(result.current.delivering).toBe(false);
  });

  test('a socket that dies mid-window does not leave the row delivering', () => {
    const { result } = openHook();
    act(() => socket().receive({ type: 'queued' }));
    expect(result.current.delivering).toBe(true);
    act(() => socket().close());
    expect(result.current.delivering).toBe(false);
  });
});

// ── the row the fold stamps ──────────────────────────────────────────────────────────────────

const caption = (overrides: Partial<VoiceRealtimeCaption> = {}): VoiceRealtimeCaption => ({
  itemId: 'a',
  text: '把 server',
  final: true,
  at: 1_000,
  ...overrides,
});

describe('the fold marks its ONE row with the delivery state', () => {
  test('a closed utterance waiting on the row reads `heard`', () => {
    const row = foldCaptionsIntoTranscriptRow([caption()], [], false);
    expect(row?.voiceRowState).toBe('heard');
  });

  test('while the proxy is delivering, the SAME row reads `delivering`', () => {
    const heard = foldCaptionsIntoTranscriptRow([caption()], [], false);
    const delivering = foldCaptionsIntoTranscriptRow([caption()], [], true);
    // Same row identity: the state changes on the row, it is not a new row.
    expect(delivering?.id).toBe(heard?.id);
    expect(delivering?.voiceRowState).toBe('delivering');
  });

  test('a row that only holds words still being spoken carries no state', () => {
    const row = foldCaptionsIntoTranscriptRow([caption({ final: false })], [], false);
    expect(row?.voiceRowState).toBeUndefined();
  });

  test('once the delivery claimed the utterance there is no row left to mark', () => {
    const delivery = { message: '把 server', at: 2_000, heard: ['把 server'], itemIds: ['a'] };
    expect(foldCaptionsIntoTranscriptRow([caption()], [delivery], true)).toBeNull();
  });
});

// ── the row, as the DOM renders it ───────────────────────────────────────────────────────────

const createDiff = (): DiffLine[] => [];
const renderRow = (message: ChatMessage): HTMLElement => {
  const { container } = render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" />
    </UiPreferencesProvider>,
  );
  return container;
};

const ROW_STATE_TESTIDS = ['voice-row-heard', 'voice-row-delivering'];

describe('the state is a marker on the row itself', () => {
  test('a delivering row carries `voice-row-delivering`, and no `voice-row-heard`', () => {
    const row = foldCaptionsIntoTranscriptRow([caption()], [], true)!;
    const container = renderRow(row);
    assert.ok(container.querySelector('[data-testid="voice-row-delivering"]'), 'the row must carry the delivering marker');
    assert.equal(
      container.querySelector('[data-testid="voice-row-heard"]'),
      null,
      'the two states are exclusive: the heard marker must be gone',
    );
  });

  test('a heard row carries `voice-row-heard`, and no `voice-row-delivering`', () => {
    const row = foldCaptionsIntoTranscriptRow([caption()], [], false)!;
    const container = renderRow(row);
    assert.ok(container.querySelector('[data-testid="voice-row-heard"]'), 'the row must carry the heard marker');
    assert.equal(container.querySelector('[data-testid="voice-row-delivering"]'), null);
  });

  test('an ordinary typed user row carries neither marker', () => {
    const container = renderRow({ type: 'user', content: 'something typed', timestamp: '2026-10-11T00:00:00.000Z' });
    for (const testid of ROW_STATE_TESTIDS) {
      assert.equal(container.querySelector(`[data-testid="${testid}"]`), null, `a typed row must not carry ${testid}`);
    }
  });

  test('the delivered message is the row: both markers gone, the spoken badge present', () => {
    const container = renderRow({
      type: 'user',
      content: '把 server 放到 server。',
      timestamp: '2026-10-11T00:00:00.000Z',
      voiceTranscript: { heard: ['把 server', '放到 server。'] },
    });
    for (const testid of ROW_STATE_TESTIDS) {
      assert.equal(container.querySelector(`[data-testid="${testid}"]`), null, `the delivered row must not carry ${testid}`);
    }
    assert.ok(container.querySelector('[data-testid="voice-transcript-badge"]'), 'the delivered row must show the spoken badge');
  });
});
