import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import { SEGMENTED_RELAY_PROTOCOL } from '@/modules/chat/voice-realtime/voiceRealtimeProtocol';
import { voiceRealtimeSocketUrl } from '@/shared/api';
import {
  VOICE_REALTIME_TRANSPORT_STORAGE_KEY,
  readVoiceTransportPreference,
  writeVoiceTransportPreference,
} from '@/shared/voiceConfig';

/**
 * The browser half of the per-connection transport opt-in (GOAL-044 / AC-374, decision doc §12.7).
 *
 * WHAT THIS FILE IS FOR. The server can already answer a connection that asks for the continuous wire;
 * this is the half that ASKS. Three facts, each read where it actually happens:
 *
 *   · THE PREFERENCE — the switch is remembered locally (a browser-local fact, never a server field),
 *     and `null` means "no choice made", told apart from a choice of the default.
 *   · THE URL — the choice rides THIS connection's socket URL, and a browser that made no choice opens
 *     the same URL it always opened (no `transport=`, so the server decides).
 *   · THE MOMENT — the preference is read when the connection OPENS, so flipping the switch mid-call
 *     leaves the live connection alone and the new choice applies to the next one. That is the rollback
 *     the design promises: no restart, just the next connection.
 */

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

/** The audio source: this file drives the wire, not the microphone, so it only has to exist. */
const sources: VoiceRealtimeAudioSource[] = [];
vi.mock('@/modules/chat/voice-realtime/audioSource', () => {
  const make = (): VoiceRealtimeAudioSource => {
    const source: VoiceRealtimeAudioSource = {
      async start() {},
      stop() {},
    };
    sources.push(source);
    return source;
  };
  return { microphoneAudioSource: make, fileAudioSource: make };
});

/** The slice of WebSocket the hook uses; the URL is the whole point here, so it is recorded. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
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
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  /** Delivers one server frame, so a session can reach the state the client considers open. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
}

/** The transport the last connection asked for, read off its URL (or `null` for "asked for nothing"). */
const requestedTransport = (url: string): string | null =>
  new URL(url, 'http://localhost').searchParams.get('transport');

beforeEach(() => {
  auth.token = 'jwt-token';
  FakeWebSocket.instances = [];
  sources.length = 0;
  localStorage.clear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the stored choice', () => {
  test('a choice is remembered, and forgetting it is not the same as choosing the default', () => {
    // Nothing stored reads as "no choice made" — which the server resolves with the deployment's own
    // mode, NOT with an explicit `segmented`. The two must stay distinguishable.
    expect(readVoiceTransportPreference()).toBeNull();

    writeVoiceTransportPreference('continuous');
    expect(readVoiceTransportPreference()).toBe('continuous');
    expect(localStorage.getItem(VOICE_REALTIME_TRANSPORT_STORAGE_KEY)).toBe('continuous');

    // Forgetting is a real transition back to "no choice", not a stored empty string.
    writeVoiceTransportPreference(null);
    expect(readVoiceTransportPreference()).toBeNull();
    expect(localStorage.getItem(VOICE_REALTIME_TRANSPORT_STORAGE_KEY)).toBeNull();
  });

  test('a value that is not a known transport reads as no choice, never as a broken one', () => {
    // A stale or hand-edited value must fall back to the deployment's mode rather than put a value the
    // server cannot parse on the wire.
    localStorage.setItem(VOICE_REALTIME_TRANSPORT_STORAGE_KEY, 'banana');
    expect(readVoiceTransportPreference()).toBeNull();
  });
});

describe('the socket URL', () => {
  test('the choice rides the connection URL; asking for nothing leaves the URL as it always was', () => {
    const withChoice = voiceRealtimeSocketUrl('tok', 'sess-1', 'continuous');
    expect(requestedTransport(withChoice)).toBe('continuous');
    // The token and session are still there — the choice is an addition, not a replacement.
    const parsed = new URL(withChoice, 'http://localhost');
    expect(parsed.searchParams.get('token')).toBe('tok');
    expect(parsed.searchParams.get('session')).toBe('sess-1');

    // No choice: the parameter is ABSENT (not `transport=`), so the parse on the server reads "no
    // choice" rather than an empty string it would have to special-case.
    for (const choice of [null, undefined]) {
      const url = voiceRealtimeSocketUrl('tok', 'sess-1', choice);
      expect(requestedTransport(url)).toBeNull();
      expect(url).not.toContain('transport=');
    }
  });
});

describe('the connection reads the choice when it opens', () => {
  test('the URL follows the stored choice, and flipping it applies to the NEXT connection', () => {
    // First connection: no choice made ⇒ the pre-opt-in URL.
    const hook = renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
    act(() => hook.result.current.start());
    const first = FakeWebSocket.instances.at(-1)!;
    expect(requestedTransport(first.url)).toBeNull();

    // The person flips the switch mid-call. The live connection must NOT be re-pointed — the choice is
    // read when a connection opens, so this one keeps what it opened on.
    writeVoiceTransportPreference('continuous');
    expect(requestedTransport(first.url)).toBeNull();

    // Ending and starting again — the next connection — opens with the choice on the URL. This is the
    // rollback/opt-in mechanism: it takes effect without a restart, on the next connection only.
    act(() => hook.result.current.end());
    act(() => hook.result.current.start());
    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(requestedTransport(second.url)).toBe('continuous');
  });

  test('a session that already opted in opens with the choice without touching the switch again', () => {
    // The stored preference from a previous visit is enough: a fresh mount's connection carries it,
    // which is what makes the choice persist across reloads.
    writeVoiceTransportPreference('continuous');
    const hook = renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
    act(() => hook.result.current.start());

    expect(requestedTransport(FakeWebSocket.instances.at(-1)!.url)).toBe('continuous');
  });
});

/** A frame the page put on the wire, so the continuous connection can be observed end to end. */
type SentFrame = { type: string; protocol?: string };

describe('the opened connection behaves as the choice asks', () => {
  test('a browser that asked for nothing still offers segmented-v1, exactly as before', () => {
    // The offer is unchanged: the client states what it CAN send on every connection, and the server
    // simply never declares it to a connection that asked for continuous. So this frame must still go
    // out, or the continuous opt-in would have broken the default path.
    const hook = renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
    act(() => hook.result.current.start());
    const ws = FakeWebSocket.instances.at(-1)!;
    act(() => ws.open());

    const offered = ws.sent.map((raw) => JSON.parse(raw) as SentFrame).filter((frame) => frame.type === 'hello');
    expect(offered).toEqual([{ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL }]);
  });
});
