import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeAudioFrame, VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';

/**
 * Stage C — the browser half of the Live Voice stream, with the wire and the audio source faked.
 *
 * The server stages prove what the proxy SAYS; this proves what the page DOES with it. The
 * e2e specs prove both together in a real browser, but a frame-handling slip (a recoverable
 * error ending the session, a caption replaced instead of appended, a muted frame replayed)
 * is cheaper to pin here and says exactly which rule broke.
 */

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

/** A controllable audio source: the test pushes frames, and can see whether it was released. */
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
  /** Delivers one server frame to the page. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
  /** The audio payloads sent so far (the `close` control frame is excluded). */
  audio(): string[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; audio?: string }).filter((frame) => frame.type === 'audio').map((frame) => frame.audio!);
  }
}

const frame = (samples: number[], sourceRate = 16_000): VoiceRealtimeAudioFrame => ({ samples: Float32Array.from(samples), sourceRate });
const decode = (audio: string): number[] => {
  const bytes = Buffer.from(audio, 'base64');
  return Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readInt16LE(index * 2));
};

beforeEach(() => {
  auth.token = 'jwt-token';
  FakeWebSocket.instances = [];
  sources.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = (onSent?: () => void) => renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1', onSent }));
const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

describe('connection and the handshake gap', () => {
  test('connects bound to the session, listens only once the proxy reports open', () => {
    const { result } = mount();
    act(() => result.current.start());
    expect(result.current.phase).toBe('connecting');
    expect(socket().url).toContain('session=sess-1');
    act(() => socket().receive({ type: 'state', state: 'open' }));
    expect(result.current.phase).toBe('listening');
  });

  test('audio captured before open is held and replayed IN ORDER the moment it opens', () => {
    const { result } = mount();
    act(() => result.current.start());
    act(() => {
      sources[0]!.push(frame([0.1]));
      sources[0]!.push(frame([0.2]));
      sources[0]!.push(frame([0.3]));
    });
    expect(socket().audio()).toEqual([]);
    act(() => socket().receive({ type: 'state', state: 'open' }));
    expect(socket().audio().map((audio) => decode(audio)[0])).toEqual([3276, 6553, 9830]);
    act(() => sources[0]!.push(frame([0.4])));
    expect(socket().audio()).toHaveLength(4);
  });

  test('with no sign-in the session fails with an explanation and opens nothing', () => {
    auth.token = null;
    const { result } = mount();
    act(() => result.current.start());
    expect(result.current.phase).toBe('failed');
    expect(result.current.error).toMatch(/sign in/i);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe('the PCM16 the upstream receives', () => {
  const opened = () => {
    const hook = mount();
    act(() => hook.result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    return hook;
  };

  test('16 kHz frames pass through one sample to one sample, clamped to the int16 range', () => {
    opened();
    act(() => sources[0]!.push(frame([0, 0.5, -0.5, 2, -2])));
    expect(decode(socket().audio()[0]!)).toEqual([0, 16383, -16384, 32767, -32768]);
  });

  test('48 kHz frames are decimated 3:1 and the length is exactly a third', () => {
    opened();
    const input = Array.from({ length: 480 }, (_, index) => (index % 3 === 0 ? 0.25 : 0.9));
    act(() => sources[0]!.push(frame(input, 48_000)));
    const samples = decode(socket().audio()[0]!);
    expect(samples).toHaveLength(160);
    // Every third source sample is kept: here exactly the 0.25 ones.
    expect(new Set(samples)).toEqual(new Set([8191]));
  });
});

describe('mute', () => {
  test('muted frames are dropped for good, and unmuting resumes the stream', () => {
    const { result } = mount();
    act(() => result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    act(() => sources[0]!.push(frame([0.1])));
    act(() => result.current.mute());
    expect(result.current.phase).toBe('muted');
    act(() => sources[0]!.push(frame([0.2])));
    act(() => result.current.unmute());
    expect(result.current.phase).toBe('listening');
    act(() => sources[0]!.push(frame([0.3])));
    expect(socket().audio().map((audio) => decode(audio)[0])).toEqual([3276, 9830]);
  });

  test('a frame queued during the handshake before Mute is not replayed after it', () => {
    const { result } = mount();
    act(() => result.current.start());
    act(() => sources[0]!.push(frame([0.1])));
    act(() => result.current.mute());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    expect(socket().audio()).toEqual([]);
    expect(result.current.phase).toBe('muted');
  });
});

describe('what the model heard', () => {
  const open = () => {
    const hook = mount();
    act(() => hook.result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    return hook;
  };

  test('interim captions replace in place, keep their order and first-seen time, and finalise', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '把', final: false }));
    act(() => socket().receive({ type: 'caption', itemId: 'b', text: 'Louis', final: false }));
    const firstSeen = result.current.captions[0]!.at;
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '把 server。', final: true }));
    expect(result.current.captions.map((caption) => [caption.itemId, caption.text, caption.final])).toEqual([
      ['a', '把 server。', true],
      ['b', 'Louis', false],
    ]);
    expect(result.current.captions[0]!.at).toBe(firstSeen);
  });

  test('a new connection starts with no captions from the previous one', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: 'old', final: true }));
    act(() => result.current.end());
    act(() => result.current.start());
    expect(result.current.captions).toEqual([]);
  });
});

describe('errors, delivery and teardown', () => {
  const open = (onSent?: () => void) => {
    const hook = mount(onSent);
    act(() => hook.result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    return hook;
  };

  test('a recoverable error is shown but the session keeps listening and capturing', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'error', code: 'SESSION_BUSY', message: 'Claude is still working', recoverable: true }));
    expect(result.current.error).toBe('Claude is still working');
    expect(result.current.phase).toBe('listening');
    act(() => sources[0]!.push(frame([0.1])));
    expect(socket().audio()).toHaveLength(1);
  });

  test('a fatal error stops the session', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'error', code: 'UNKNOWN_EVENT', message: 'boom' }));
    expect(result.current.phase).toBe('failed');
    expect(result.current.error).toBe('boom');
  });

  test('a delivered instruction clears the notice and tells the pane to re-read the transcript', () => {
    const onSent = vi.fn();
    const { result } = open(onSent);
    act(() => socket().receive({ type: 'error', code: 'SESSION_BUSY', message: 'waiting', recoverable: true }));
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {} }));
    expect(result.current.error).toBeNull();
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  test('the proxy closing the session returns to idle and releases capture', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'state', state: 'closed' }));
    expect(result.current.phase).toBe('idle');
    act(() => socket().close());
    expect(sources[0]!.stopped).toBeGreaterThan(0);
  });

  test('ending sends a close control frame, closes the socket and releases the microphone', () => {
    const { result } = open();
    const ws = socket();
    act(() => result.current.end());
    expect(ws.sent.map((raw) => JSON.parse(raw).type)).toContain('close');
    expect(ws.closed).toBe(true);
    expect(sources[0]!.stopped).toBeGreaterThan(0);
    expect(result.current.phase).toBe('idle');
  });

  test('unmounting mid-session releases everything (no open microphone left behind)', () => {
    const { unmount } = open();
    const ws = socket();
    unmount();
    expect(ws.closed).toBe(true);
    expect(sources[0]!.stopped).toBeGreaterThan(0);
  });
});
