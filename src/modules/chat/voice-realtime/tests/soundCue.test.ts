import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import type {
  VoiceRealtimeAudioFrame,
  VoiceRealtimeAudioSource,
} from '@/modules/chat/voice-realtime/audioSource';
import type * as SoundCueModule from '@/modules/chat/voice-realtime/soundCue';
import type { VoiceRealtimeSession } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

/**
 * (this task) The three non-verbal cues: entry, exit, and connection loss.
 *
 * THE CLAIM. Entering Live Voice used to be narrated by transient copy ("connecting", "starting the
 * microphone", "listening"); it is now silent, and the moment the session first becomes live is
 * marked by a rising two-note cue. Leaving a session that opened gets the falling pair, and a
 * connection that dies gets a third, distinct pulse pattern. Each sounds at most once for the scope
 * that owns it — once per session for entry, once per END for exit, once per CONNECTION for loss — so
 * a reconnect cannot replay the entry cue and a close that both reports and fires an event cannot
 * double the attention cue. The cue module itself synthesizes `OscillatorNode` tones: no audio
 * element and no path shared with the spoken narration.
 *
 * The hook is driven with a faked wire and audio source; only the cue module is replaced, so these
 * cases read the SHIPPED trigger points. Run:
 *   npx vitest run src/modules/chat/voice-realtime/tests/soundCue.test.ts
 */

/** Every cue the hook asked for, in order. */
type Cue = 'enter' | 'exit' | 'attention';
const cues = vi.hoisted(() => [] as Cue[]);
vi.mock('@/modules/chat/voice-realtime/soundCue', () => ({
  primeVoiceCues: () => undefined,
  playVoiceEnterCue: () => cues.push('enter'),
  playVoiceExitCue: () => cues.push('exit'),
  playVoiceAttentionCue: () => cues.push('attention'),
}));

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

/** A controllable audio source: the test pushes the frames that make capture "live". */
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
  cues.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = () => renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
const open = (): { result: { current: VoiceRealtimeSession } } => {
  const view = mount();
  act(() => view.result.current.start());
  act(() => socket().receive({ type: 'state', state: 'open' }));
  return view;
};
/** The network takes the socket away: no close frame from either side, just the close event. */
const drop = (): void => {
  act(() => {
    const ws = socket();
    ws.readyState = FakeWebSocket.CLOSED;
    ws.onerror?.();
    ws.onclose?.();
  });
};

describe('the entry cue marks the session first becoming live, exactly once', () => {
  test('the first captured frame after the handshake rings it once, not again for later frames', () => {
    const { result } = open();
    expect(cues).toEqual([]);

    act(() => sources[0]!.push(frame([0.1])));
    expect(result.current.phase).toBe('listening');
    expect(cues).toEqual(['enter']);

    act(() => sources[0]!.push(frame([0.2])));
    expect(cues).toEqual(['enter']);
  });

  test('when capture was ready before the handshake finished, the open frame is the moment', () => {
    const { result } = mount();
    act(() => result.current.start());
    // Capture is live while the upstream is still opening: no cue yet, because the session is not
    // listening — the frame is held and replayed later.
    act(() => sources[0]!.push(frame([0.1])));
    expect(cues).toEqual([]);

    act(() => socket().receive({ type: 'state', state: 'open' }));
    expect(result.current.phase).toBe('listening');
    expect(cues).toEqual(['enter']);
  });

  test('unmuting a session whose first frame arrived while muted is the third merged moment', () => {
    const { result } = open();
    act(() => result.current.mute());
    act(() => sources[0]!.push(frame([0.1])));
    // The capture is ready, but the session is muted: its first `listening` has not happened.
    expect(result.current.phase).toBe('muted');
    expect(cues).toEqual([]);

    act(() => result.current.unmute());
    expect(result.current.phase).toBe('listening');
    expect(cues).toEqual(['enter']);
  });

  test('a reconnect that listens again does not replay the entry cue, and its own drop is heard again', () => {
    vi.useFakeTimers();
    try {
      const { result } = open();
      act(() => sources[0]!.push(frame([0.1])));
      expect(cues).toEqual(['enter']);

      drop();
      // The connection is gone: the attention cue sounds, once for this wire.
      expect(cues).toEqual(['enter', 'attention']);

      act(() => vi.advanceTimersByTime(500));
      act(() => socket().receive({ type: 'state', state: 'open' }));
      act(() => sources[1]!.push(frame([0.1])));
      expect(result.current.phase).toBe('listening');
      // Same session, so no second entry cue.
      expect(cues).toEqual(['enter', 'attention']);

      // A NEW connection, though: losing this one is news again.
      drop();
      expect(cues).toEqual(['enter', 'attention', 'attention']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the exit cue belongs to a session that actually opened', () => {
  test('end() rings it exactly once, even though end also runs as the cleanup', () => {
    const { result } = open();
    act(() => result.current.end());
    expect(cues).toEqual(['exit']);

    // The same callback runs again as the effect/unmount cleanup on an already-closed session.
    act(() => result.current.end());
    expect(cues).toEqual(['exit']);
  });

  test('end() on a mode that never started is silent', () => {
    const { result } = mount();
    act(() => result.current.end());
    expect(cues).toEqual([]);
  });

  test('a start that fails before a connection exists does not arm the exit cue', () => {
    auth.token = null;
    const { result } = mount();
    act(() => result.current.start());
    expect(result.current.phase).toBe('failed');
    // It failed, so the attention cue sounded — but there is no session to leave.
    expect(cues).toEqual(['attention']);

    act(() => result.current.end());
    expect(cues).toEqual(['attention']);
  });
});

describe('the attention cue sounds once per connection when the wire is lost', () => {
  test('state:closed rings it once; the close that follows does not repeat it, and end adds only the exit cue', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'state', state: 'closed' }));
    expect(cues).toEqual(['attention']);

    act(() => socket().close());
    expect(cues).toEqual(['attention']);

    act(() => result.current.end());
    expect(cues).toEqual(['attention', 'exit']);
  });

  test('a fatal error frame rings it once, and the close behind it stays silent', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'error', code: 'SPEND_LIMIT', message: 'spent' }));
    expect(result.current.phase).toBe('failed');
    expect(cues).toEqual(['attention']);

    act(() => socket().close());
    expect(cues).toEqual(['attention']);
  });

  test('a narration error is shown but is not a connection loss, so it stays silent', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'tts_error', utteranceId: 'u1', code: 'TTS_FAILED', message: 'no audio' }));
    // The session is alive and listening; only the caption line carries the outcome.
    expect(result.current.phase).not.toBe('failed');
    expect(cues).toEqual([]);
  });

  test('a normal end() never sounds the attention cue', () => {
    const { result } = open();
    act(() => sources[0]!.push(frame([0.1])));
    act(() => result.current.end());
    expect(cues).toEqual(['enter', 'exit']);
  });
});

describe('the cue module synthesizes tones instead of playing audio assets', () => {
  test('soundCue.ts drives OscillatorNode and has no audio-element or speech path', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src', 'modules', 'chat', 'voice-realtime', 'soundCue.ts'),
      'utf8',
    );
    expect(source).toContain('createOscillator');
    expect(source).not.toMatch(/new Audio\(/);
    expect(source).not.toMatch(/speechSynthesis/i);
    expect(source).not.toMatch(/narrator/i);
  });

  test('enter ascends, exit descends, and attention repeats one pitch — three distinct shapes', async () => {
    const tones: Array<{ type: string; frequency: number[] }> = [];
    class FakeAudioContext {
      currentTime = 0;
      state = 'running';
      destination = {};
      resume(): Promise<void> {
        return Promise.resolve();
      }
      createOscillator(): {
        type: string;
        frequency: { setValueAtTime(value: number): void };
        connect(): void;
        start(): void;
        stop(): void;
      } {
        const frequency: number[] = [];
        const oscillator = {
          type: 'sine',
          frequency: { setValueAtTime: (value: number) => frequency.push(value) },
          connect: () => undefined,
          start: () => undefined,
          stop: () => undefined,
        };
        const recorded = {
          get type() {
            return oscillator.type;
          },
          frequency,
        };
        tones.push(recorded);
        return oscillator;
      }
      createGain(): {
        gain: { setValueAtTime(): void; linearRampToValueAtTime(): void };
        connect(): void;
      } {
        return {
          gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
          connect: () => undefined,
        };
      }
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const actual = await vi.importActual<typeof SoundCueModule>('@/modules/chat/voice-realtime/soundCue');

    actual.primeVoiceCues();
    actual.playVoiceEnterCue();
    actual.playVoiceExitCue();
    actual.playVoiceAttentionCue();

    expect(tones).toHaveLength(7);
    expect(tones.every((tone) => tone.type === 'triangle')).toBe(true);
    expect(tones[0]!.frequency[0]!, 'the entry cue rises').toBeLessThan(tones[1]!.frequency[0]!);
    expect(tones[2]!.frequency[0]!, 'the exit cue falls').toBeGreaterThan(tones[3]!.frequency[0]!);
    expect(
      new Set(tones.slice(4).map((tone) => tone.frequency[0])).size,
      'the attention cue is flat, so its rhythm cannot be read as either two-note cue',
    ).toBe(1);
  });
});
