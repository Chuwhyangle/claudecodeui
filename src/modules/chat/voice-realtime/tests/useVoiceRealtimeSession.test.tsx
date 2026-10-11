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

  // AC-326's wordless half, at the source. The endpoint opens an utterance, reports an empty
  // transcription for it and never puts a word in it — silence the VAD segmented, a noise, an
  // utterance it gave up on. Carried into `captions` it becomes a blank transcript row the person
  // never said, and it would also be a piece the fold joins (adding its own separator to the row
  // standing beside it). It must not enter `captions` at all.
  test('a transcription with no words never becomes a caption', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'silent', text: '', final: false }));
    act(() => socket().receive({ type: 'caption', itemId: 'silent', text: '   ', final: false }));
    act(() => socket().receive({ type: 'caption', itemId: 'silent', text: '', final: true }));
    expect(result.current.captions).toEqual([]);
  });

  // The one wordless frame that is NOT dropped: the endpoint closes an utterance that already has
  // words on screen with an empty `completed`. Dropping it would leave the person's last words
  // looking like something still being spoken.
  test('a wordless frame that CLOSES an utterance keeps its words and marks it final', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '半句话', final: false }));
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '', final: true }));
    expect(result.current.captions.map((caption) => [caption.itemId, caption.text, caption.final])).toEqual([
      ['a', '半句话', true],
    ]);
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

  // The turn the person just spoke, which the endpoint heard and never answered (the live incident
  // behind this task). It must NOT travel as an `error`: the session is healthy and still listening,
  // and a failure notice would both misname the outcome and be cleared by the very next frame. The
  // outcome is its own state, held until a delivery answers it.
  test('an unanswered turn is its own state, not an error, and the session keeps listening', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'turn_unanswered', seconds: 8 }));
    expect(result.current.unansweredSeconds).toBe(8);
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('listening');
    // Still capturing: an unanswered turn does not stop the microphone.
    act(() => sources[0]!.push(frame([0.1])));
    expect(socket().audio()).toHaveLength(1);
  });

  test('a delivery answers the unanswered turn and the outcome goes away', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'turn_unanswered', seconds: 8 }));
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: '下一句。' }));
    expect(result.current.unansweredSeconds).toBeNull();
  });

  test('an unanswered turn does not survive into the next connection', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'turn_unanswered', seconds: 8 }));
    act(() => result.current.start());
    expect(result.current.unansweredSeconds).toBeNull();
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

  test('a socket closed under the mode is reported as disconnected; an explicit end is not, and a restart clears it', () => {
    const { result } = open();
    expect(result.current.disconnected).toBe(false);
    expect(result.current.connectedAt).not.toBeNull();
    act(() => socket().close());
    expect(result.current.phase).toBe('idle');
    expect(result.current.disconnected).toBe(true);
    expect(result.current.connectedAt).toBeNull();
    act(() => result.current.start());
    expect(result.current.disconnected).toBe(false);
    expect(result.current.connectedAt).not.toBeNull();
    act(() => result.current.end());
    expect(result.current.disconnected).toBe(false);
  });

  test('the level follows captured frames, and is 0 while muted', () => {
    const { result } = open();
    act(() => sources[0]!.push(frame([0.25, -0.25, 0.25, -0.25])));
    expect(result.current.levelRef.current).toBeGreaterThan(0.5);
    act(() => result.current.mute());
    expect(result.current.levelRef.current).toBe(0);
    act(() => sources[0]!.push(frame([0.25, -0.25])));
    expect(result.current.levelRef.current).toBe(0);
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

describe('connection lifecycle', () => {
  test('starting again replaces the connection: the old socket is closed and its microphone released', () => {
    const { result } = mount();
    act(() => result.current.start());
    const first = socket();
    act(() => first.receive({ type: 'state', state: 'open' }));
    act(() => result.current.start());
    expect(first.closed).toBe(true);
    expect(sources[0]!.stopped).toBeGreaterThan(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    // Audio from the NEW source reaches the NEW socket only.
    act(() => socket().receive({ type: 'state', state: 'open' }));
    act(() => sources[1]!.push(frame([0.1])));
    expect(socket().audio()).toHaveLength(1);
    expect(first.audio()).toHaveLength(0);
  });

  test('start is a stable function: a token refresh or re-render does not hand callers a new one', () => {
    const { result, rerender } = mount();
    const before = result.current.start;
    auth.token = 'a-refreshed-token';
    rerender();
    expect(result.current.start).toBe(before);
  });

  test('a start after the token was refreshed dials with the NEW token', () => {
    const { result, rerender } = mount();
    auth.token = 'a-refreshed-token';
    rerender();
    act(() => result.current.start());
    expect(socket().url).toContain('a-refreshed-token');
  });
});

describe('the bounded queue: depth and refusal (gap-live-voice-bounded-queue-refusal-visible)', () => {
  const open = () => {
    const hook = mount();
    act(() => hook.result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    return hook;
  };

  test('the waiting depth is read off the frames, and a delivered send puts it back to 0', () => {
    const { result } = open();
    // Nothing has been said, so the page has been told nothing: the negative control.
    expect(result.current.queuedDepth).toBe(0);
    act(() => socket().receive({ type: 'queued', depth: 2 }));
    expect(result.current.queuedDepth).toBe(2);
    // The delivery landed and the session started a run: nothing is waiting any more.
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, depth: 0 }));
    expect(result.current.queuedDepth).toBe(0);
  });

  test('a refusal names its reason and depth, and does NOT swallow the refused words', () => {
    const { result } = open();
    // The person's own words reached the page on the caption channel before the model's call.
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '把超时改成五十秒', final: true }));
    act(() => socket().receive({ type: 'refused', reason: 'queue-full', depth: 3 }));
    expect(result.current.refusal).toEqual({ reason: 'queue-full', depth: 3 });
    expect(result.current.queuedDepth).toBe(3);
    // The refusal is an ANSWER about a message, never a claim on the words: they stay readable as the
    // caption nobody claimed, so the person can still see what did not go.
    expect(result.current.captions.map((caption) => caption.text)).toEqual(['把超时改成五十秒']);
  });

  test('the next delivery clears the refusal: the queue it described has moved', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'refused', reason: 'queue-full', depth: 3 }));
    expect(result.current.refusal).not.toBeNull();
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, depth: 1 }));
    expect(result.current.refusal).toBeNull();
    expect(result.current.queuedDepth).toBe(1);
  });

  test('a new connection starts with no depth and no refusal from the previous one', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'refused', reason: 'queue-full', depth: 3 }));
    act(() => result.current.end());
    act(() => result.current.start());
    expect(result.current.queuedDepth).toBe(0);
    expect(result.current.refusal).toBeNull();
  });
});

describe('deliveries', () => {
  const open = () => {
    const hook = mount();
    act(() => hook.result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    return hook;
  };

  test('a delivery names the finished utterances it carries, and the next one only the new ones', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '把 server', final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'b', text: '放到 server。', final: true }));
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: '把 server 放到 server。' }));
    act(() => socket().receive({ type: 'caption', itemId: 'c', text: '再来一句。', final: true }));
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: '再来一句。' }));
    expect(result.current.deliveries.map((d) => [d.message, d.itemIds, d.heard])).toEqual([
      ['把 server 放到 server。', ['a', 'b'], ['把 server', '放到 server。']],
      ['再来一句。', ['c'], ['再来一句。']],
    ]);
  });

  test('an utterance still being spoken is not carried by a delivery that happened meanwhile', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '完整的一句。', final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'b', text: '说到一半', final: false }));
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: '完整的一句。' }));
    expect(result.current.deliveries[0]!.itemIds).toEqual(['a']);
  });

  test('a new connection starts with no deliveries', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '一句话。', final: true }));
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: '一句话。' }));
    act(() => result.current.end());
    act(() => result.current.start());
    expect(result.current.deliveries).toEqual([]);
  });
});

describe('the local stop: a spoken stop the model did not relay (gap-live-voice-voice-terminated-interrupt)', () => {
  const open = () => {
    const hook = mount();
    act(() => hook.result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    return hook;
  };

  /** The control frames the page has sent so far (the handshake's `hello`/`close` excluded). */
  const interruptFrames = () =>
    socket()
      .sent.map((raw) => JSON.parse(raw) as { type: string })
      .filter((frame) => frame.type === 'interrupt');

  test('a FINAL caption whose whole text is a stop word sends the interrupt frame', () => {
    const { result } = open();
    expect(interruptFrames()).toEqual([]);
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '停', final: true }));
    expect(interruptFrames()).toEqual([{ type: 'interrupt' }]);
    // The caption is still the person's own words, shown like any other.
    expect(result.current.captions.map((caption) => caption.text)).toEqual(['停']);
  });

  test('a sentence that merely CONTAINS a stop word, or an interim one, never stops the run', () => {
    const { result } = open();
    // The failure mode this guards: a loose match turning a sentence ABOUT stopping into an abort.
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '我不知道要不要停下来思考', final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'b', text: '把超时改成五十秒', final: true }));
    // An interim stop word is not a finished utterance — the recogniser may still be revising it.
    act(() => socket().receive({ type: 'caption', itemId: 'c', text: '停', final: false }));
    expect(result.current.captions.map((caption) => caption.text)).toEqual([
      '我不知道要不要停下来思考',
      '把超时改成五十秒',
      '停',
    ]);
    expect(interruptFrames()).toEqual([]);
  });

  test('one utterance stops the run once, however many final frames it arrives in', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '停', final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '停', final: true }));
    expect(interruptFrames()).toHaveLength(1);
    // A DIFFERENT utterance that is also a stop is its own stop.
    act(() => socket().receive({ type: 'caption', itemId: 'b', text: 'stop', final: true }));
    expect(interruptFrames()).toHaveLength(2);
    expect(result.current.captions.map((caption) => caption.itemId)).toEqual(['a', 'b']);
  });

  test('the stopped frame is reported, and the next delivery clears it', () => {
    const { result } = open();
    expect(result.current.stopped).toBeNull();
    act(() => socket().receive({ type: 'stopped', aborted: true, depth: 2 }));
    expect(result.current.stopped).toEqual({ aborted: true, depth: 2 });
    // The next delivery means the queue the stop described has moved.
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, depth: 0 }));
    expect(result.current.stopped).toBeNull();
  });

  test('a new connection starts with no stop reading from the previous one', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'stopped', aborted: true, depth: 1 }));
    act(() => result.current.end());
    act(() => result.current.start());
    expect(result.current.stopped).toBeNull();
  });
});
