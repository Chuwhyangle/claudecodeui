/**
 * AC-327 — the Live Voice "accepted, not yet delivered" window, read where it now lives.
 *
 * WHAT THIS FILE USED TO PIN, AND WHY IT CHANGED (this task,
 * `gap-live-voice-remove-transcript-caption-rows`). The proxy accepts a `session_send` immediately
 * but delivers it only when its coalescing window closes; the server emits one frame when the window
 * OPENS (`queued`). The page used to read that frame as a boolean on the hook (`delivering`) and
 * stamp it onto the ONE provisional row it built for the person's words — `heard` while the utterance
 * was still just heard, `delivering` from the moment the instruction was accepted, each a
 * `voice-row-heard`/`voice-row-delivering` marker on that row's DOM.
 *
 * Those provisional rows are gone. A spoken utterance is not a row of this client's own any more: the
 * real message the model relayed is the row, and while it is in flight its words are shown in the
 * bottom voice bar. So the ROW half of this file — the caption-join reads and the two `voice-row-*`
 * marker reads — was deleted along with the function and the testids it named. What
 * remains, and is still production behaviour, is the hook's own server-driven window signal: the
 * `delivering` boolean the frames set and clear. It is asserted here because it is a fact about the
 * connection's timeline (the SERVER's window, not a client timer), independent of where it is shown.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeAudioFrame, VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';

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
    // The proxy accepted the instruction: the wait is real and now visible to the client.
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

  test('a socket that dies mid-window does not leave the window open', () => {
    const { result } = openHook();
    act(() => socket().receive({ type: 'queued' }));
    expect(result.current.delivering).toBe(true);
    act(() => socket().close());
    expect(result.current.delivering).toBe(false);
  });
});
