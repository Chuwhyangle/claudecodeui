import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import { useEffect } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { VoiceRealtimeBar, useVoiceRealtimeSession } from '@/modules/chat/voice-realtime';
import type {
  VoiceRealtimeAudioFrame,
  VoiceRealtimeAudioSource,
  VoiceRealtimeMicSuspension,
} from '@/modules/chat/voice-realtime/audioSource';
import type { VoiceRealtimeSession } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';
import type { ChatMessage } from '@/shared/types';

/**
 * Stage C — the browser half of the Live Voice stream, with the wire and the audio source faked.
 *
 * The server stages prove what the proxy SAYS; this proves what the page DOES with it. The
 * e2e specs prove both together in a real browser, but a frame-handling slip (a recoverable
 * error ending the session, a caption replaced instead of appended, a muted frame replayed)
 * is cheaper to pin here and says exactly which rule broke.
 *
 * The bar's own cells are rendered (not just the hook driven) because several of these claims are
 * about what a person READS on screen, and only a render can say what reaches the text: the status
 * cell's connection phase, the caption line's classified error sentence with the server's own message
 * on its `title`, and — the other half of the same reading — the queue numbers that stay on the
 * element as diagnostics without being printed (operator's ruling, 2026-10-14).
 */

/** The shipped English copy, read as data so a copy edit is not a test edit. */
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

/** A controllable audio source: the test pushes frames, and can see whether it was released. */
type FakeSource = VoiceRealtimeAudioSource & {
  push(frame: VoiceRealtimeAudioFrame): void;
  /** Reports a microphone-suspension change exactly the way `microphoneAudioSource` would. */
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

/**
 * The bar over a LIVE session (not a stubbed `VoiceRealtimeSession`), for the claims that are about
 * what a person READS on screen after a real frame: `renderHook` alone can say what `error` holds,
 * but only a render can say whether the error element is there. The latest session is handed out so
 * the test can still drive `start`/`end` on it.
 */
function BarOverHook({ onSession, busy }: { onSession: (voice: VoiceRealtimeSession) => void; busy?: boolean }) {
  const voice = useVoiceRealtimeSession({ sessionId: 'sess-1' });
  useEffect(() => {
    onSession(voice);
  });
  return <VoiceRealtimeBar voice={voice} busy={busy} onExit={() => {}} />;
}

const mountBar = (busy = false) => {
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
};

describe('connection and the handshake gap', () => {
  test('connects bound to the session, and listens only once the proxy is open AND the first frame is captured', () => {
    const { result } = mount();
    act(() => result.current.start());
    expect(result.current.phase).toBe('connecting');
    expect(socket().url).toContain('session=sess-1');
    act(() => socket().receive({ type: 'state', state: 'open' }));
    // The upstream is open, but capture is asynchronous: the page must not claim to be listening
    // before the microphone has produced anything (this task's phase).
    expect(result.current.phase).toBe('arming');
    act(() => sources[0]!.push(frame([0.1])));
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

  // AC1 (this task): the operator's ruling made executable — a recoverable error goes to the
  // browser console (code AND message) and NEVER to the bar. The on-screen error slot is reserved
  // for a failure the person has to SEE; one the session recovered from is not that. This is the
  // FALSE form, first in the group: on the unfixed tree the frame reached `setError`, so both the
  // reading and the render below are red there.
  test('a recoverable error goes to the console, not the bar, and the session stays listening', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container, session } = mountBar();
      act(() => session().start());
      act(() => socket().receive({ type: 'state', state: 'open' }));
      // Capture is running before the error arrives, so the surviving reading is unambiguously
      // `listening` (an open upstream with no frame would be the `arming` phase, not this claim).
      act(() => sources[0]!.push(frame([0.1])));
      act(() =>
        socket().receive({ type: 'error', code: 'MALFORMED_FUNCTION_CALL', message: 'bad args', recoverable: true }),
      );
      // Nothing lands on the bar — neither the reading nor the element.
      expect(session().error).toBeNull();
      expect(session().phase).toBe('listening');
      expect(container.querySelector('[data-testid="voice-realtime-error"]')).toBeNull();
      // And the one place it IS reported carries BOTH the code and the message, exactly once.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]!).toContain('MALFORMED_FUNCTION_CALL');
      expect(warn.mock.calls[0]!).toContain('bad args');
    } finally {
      warn.mockRestore();
    }
  });

  // AC2 (negative control): the ruling does not silence the failures that matter. An error frame
  // with no `recoverable` still reaches the bar — phase failed, reading set, red line on screen.
  // Without this leg, "no error element" would also be satisfied by showing nothing ever.
  //
  // WHAT THE BAR SAYS CHANGED (operator's ruling, 2026-10-14): the caption line used to print the
  // server's own message verbatim — an untranslated technical string. It now prints ONE understandable
  // sentence chosen by the error's `code`, and the raw message is kept on the element's `title`, so
  // the detail is still there for whoever asks for it. `UNKNOWN_EVENT` is in no class of its own, so
  // it takes the generic copy.
  test('a non-recoverable error still reaches the bar, as one understandable sentence', () => {
    const { container, session } = mountBar();
    act(() => session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    act(() => socket().receive({ type: 'error', code: 'UNKNOWN_EVENT', message: 'boom' }));
    expect(session().phase).toBe('failed');
    expect(session().error).toBe('boom');
    expect(session().errorCode).toBe('UNKNOWN_EVENT');
    const shown = container.querySelector('[data-testid="voice-realtime-error"]');
    expect(shown).not.toBeNull();
    expect(shown!.textContent).not.toContain('boom');
    expect(shown!.textContent!.trim().length).toBeGreaterThan(0);
    // The raw message is not thrown away: it rides on the caption element's title.
    expect(container.querySelector('[data-testid="voice-realtime-caption"]')!.getAttribute('title')).toBe('boom');
  });

  // AC3 (this task): the OLD assertion, rewritten to the ruling rather than deleted. Before it read
  // "a recoverable error is SHOWN but the session keeps listening"; the surviving half — a
  // recoverable error does not end the session, the microphone keeps feeding audio — is what this
  // pins, with the shown-ness now asserted as its absence.
  test('a recoverable error leaves the reading clear, and the session keeps listening and capturing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = open();
      act(() => socket().receive({ type: 'error', code: 'SESSION_BUSY', message: 'Claude is still working', recoverable: true }));
      expect(result.current.error).toBeNull();
      // Still capturing: the first frame after the error promotes to `listening` and reaches the
      // upstream — a recoverable error did not end the session.
      act(() => sources[0]!.push(frame([0.1])));
      expect(result.current.phase).toBe('listening');
      expect(socket().audio()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
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
    // Still capturing: an unanswered turn does not stop the microphone — the next frame both
    // reaches the upstream and completes the `listening` reading.
    act(() => sources[0]!.push(frame([0.1])));
    expect(result.current.phase).toBe('listening');
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

  // AC3: the old precondition for this case was a recoverable `SESSION_BUSY` — which no longer
  // reaches the notice at all, so the delivery below would have had nothing to clear and the test
  // would pass vacuously. The precondition is now a NON-recoverable error, which still sets the
  // notice; the assertion that it was there before the delivery keeps the case honest.
  test('a delivered instruction clears the notice and tells the pane to re-read the transcript', () => {
    const onSent = vi.fn();
    const { result } = open(onSent);
    act(() => socket().receive({ type: 'error', code: 'UNKNOWN_EVENT', message: 'waiting' }));
    expect(result.current.error).toBe('waiting');
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

  test('the waiting depth AND byte total are read off the frames, and a delivered send puts both back to 0', () => {
    const { result } = open();
    // Nothing has been said, so the page has been told nothing: the negative control.
    expect(result.current.queuedDepth).toBe(0);
    expect(result.current.queuedBytes).toBe(0);
    act(() => socket().receive({ type: 'queued', depth: 2, bytes: 640 }));
    expect(result.current.queuedDepth).toBe(2);
    expect(result.current.queuedBytes).toBe(640);
    // The delivery landed and the session started a run: nothing is waiting any more.
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, depth: 0, bytes: 0 }));
    expect(result.current.queuedDepth).toBe(0);
    expect(result.current.queuedBytes).toBe(0);
  });

  test('a refusal names its reason, depth and byte total, and does NOT swallow the refused words', () => {
    const { result } = open();
    // The person's own words reached the page on the caption channel before the model's call.
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: '把超时改成五十秒', final: true }));
    act(() => socket().receive({ type: 'refused', reason: 'queue-full', depth: 3, bytes: 1012 }));
    expect(result.current.refusal).toEqual({ reason: 'queue-full', depth: 3, bytes: 1012 });
    expect(result.current.queuedDepth).toBe(3);
    expect(result.current.queuedBytes).toBe(1012);
    // The refusal is an ANSWER about a message, never a claim on the words: they stay readable as the
    // caption nobody claimed, so the person can still see what did not go.
    expect(result.current.captions.map((caption) => caption.text)).toEqual(['把超时改成五十秒']);
  });

  test('the next delivery clears the refusal: the queue it described has moved', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'refused', reason: 'queue-full', depth: 3, bytes: 1012 }));
    expect(result.current.refusal).not.toBeNull();
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, depth: 1, bytes: 200 }));
    expect(result.current.refusal).toBeNull();
    expect(result.current.queuedDepth).toBe(1);
    expect(result.current.queuedBytes).toBe(200);
  });

  test('a queue_depth correction moves the badge without opening a delivery (live 2026-10-15)', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'stopped', aborted: true, depth: 1, runId: 'r' }));
    expect(result.current.queuedDepth).toBe(1);
    act(() => socket().receive({ type: 'queue_depth', depth: 0, bytes: 0 }));
    expect(result.current.queuedDepth).toBe(0);
    expect(result.current.queuedBytes).toBe(0);
    expect(result.current.delivering).toBe(false);
  });

  test('a new connection starts with no depth, no bytes and no refusal from the previous one', () => {
    const { result } = open();
    act(() => socket().receive({ type: 'refused', reason: 'queue-full', depth: 3, bytes: 1012 }));
    act(() => result.current.end());
    act(() => result.current.start());
    expect(result.current.queuedDepth).toBe(0);
    expect(result.current.queuedBytes).toBe(0);
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

  test('a rewrite that repeats none of the pending words carries the WHOLE spoken thought, not just its last piece', () => {
    // The relay does not always repeat the recognised words — it may translate or rewrite them — so its
    // message matches no pending utterance. The endpoint closes an utterance at every pause, so the ONE
    // thought the relay merges arrives as SEVERAL pending captions; the delivery must claim them ALL or a
    // caption row survives beside the delivered message (AC-326: the count never exceeds one). The old
    // fallback (`pending.slice(-1)`) claimed only the last piece.
    const { result } = open();
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: 'alfa bravo charlie', final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'b', text: 'delta echo foxtrot', final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'c', text: 'golf hotel india', final: true }));
    act(() =>
      socket().receive({
        type: 'sent',
        sessionId: 'sess-1',
        result: {},
        message: 'send the summary of the release notes to the team channel',
      }),
    );
    expect(result.current.deliveries.map((d) => [d.itemIds, d.heard])).toEqual([
      [['a', 'b', 'c'], ['alfa bravo charlie', 'delta echo foxtrot', 'golf hotel india']],
    ]);
  });

  test('a rewrite carries the thought since the last delivery, never an utterance the previous one left unclaimed', () => {
    // 14b8e9ed's guarantee, kept for the rewrite case too: an utterance the model recognised but never
    // forwarded keeps no delivery, so it must stay unclaimed (it is offered to the composer on leave). A
    // later rewrite merges only the speech spoken AFTER the previous delivery, so it cannot swallow it.
    const { result } = open();
    // Recognised, never relayed — the leave backlog.
    act(() => socket().receive({ type: 'caption', itemId: 'sw', text: 'something never relayed at all', final: true }));
    // A delivery that DOES carry the next utterance (verbatim) closes that window.
    act(() => socket().receive({ type: 'caption', itemId: 'a', text: 'first carried words here', final: true }));
    act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: 'first carried words here' }));
    // A LATER rewrite merges only the thought spoken since — never the never-relayed utterance.
    act(() => socket().receive({ type: 'caption', itemId: 'b', text: 'second thought piece one', final: true }));
    act(() => socket().receive({ type: 'caption', itemId: 'c', text: 'second thought piece two', final: true }));
    act(() =>
      socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: 'an unrelated rewrite of the later thought' }),
    );
    expect(result.current.deliveries[0]!.itemIds).toEqual(['a']);
    expect(result.current.deliveries[1]!.itemIds).toEqual(['b', 'c']);
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

describe('the stopped reading: what the proxy reports after the model aborts a run (gap-live-voice-voice-terminated-interrupt)', () => {
  const open = () => {
    const hook = mount();
    act(() => hook.result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    return hook;
  };

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

// ── AC5 (this task): the busy status cell reads the CONNECTION, and the backlog stays a diagnostic ─
//
// The relay admits by a UTF-8 byte budget, and the status cell used to render that backlog as
// `mm:ss · N bytes waiting` — one of the readings the operator's ruling of 2026-10-14 took off the
// bar: while Claude is busy the cell says where the CONNECTION is, not how much is queued. The
// numbers are still computed and still ride on the element as `data-*` diagnostics (several tests
// and e2e specs read them), which is what these cases pin: the reading survives, the sentence does
// not. The non-vacuity guard is the byte value itself — a fixture of 480 that the cell must NOT
// print, on an element that still carries it.

describe('the status cell reads the connection while Claude is busy, and the backlog stays a diagnostic', () => {
  /** A bar over a voice session that is mid-turn, with `queuedBytes` of speech waiting on it. */
  const renderBusyBar = (queuedBytes: number) => {
    const voice = {
      phase: 'listening',
      error: null,
      unansweredSeconds: null,
      captions: [],
      deliveries: [],
      delivering: false,
      queuedDepth: queuedBytes > 0 ? 1 : 0,
      queuedBytes,
      refusal: null,
      undelivered: [],
      levelRef: { current: 0 },
      // 65s in, so the elapsed token is a real mm:ss the assertion can insist on.
      connectedAt: Date.now() - 65_000,
      disconnected: false,
      reconnecting: null,
      closedUnshown: 0,
      start: () => {},
      startWithFile: () => {},
      mute: () => {},
      unmute: () => {},
      end: () => {},
    } as unknown as VoiceRealtimeSession;
    return render(<VoiceRealtimeBar voice={voice} busy onExit={() => {}} />);
  };

  test('busy: the cell stays wordless with a live connection, and the byte count is on the element rather than in the text', () => {
    const { container } = renderBusyBar(480);
    const status = container.querySelector('[data-testid="voice-realtime-status"]')!;
    // `listening` is a transient phase now: it carries no words even though 65 seconds have passed
    // and 480 bytes are waiting behind Claude. The readings below still prove the cell is live.
    expect(status.textContent).toBe('');
    expect(status.textContent).not.toMatch(/\d{2}:\d{2}/);
    expect(status.textContent).not.toContain('480');
    // The waiting is not lost — it is a diagnostic now, read off the element.
    expect(status.getAttribute('data-queued-bytes')).toBe('480');
    expect(status.getAttribute('data-queued-depth')).toBe('1');
    expect(status.getAttribute('data-busy')).toBe('true');
  });

  test('negative control — with nothing waiting the reading is 0, and the cell still reads the connection', () => {
    const { container } = renderBusyBar(0);
    const status = container.querySelector('[data-testid="voice-realtime-status"]')!;
    expect(status.getAttribute('data-queued-bytes')).toBe('0');
    expect(status.getAttribute('data-queued-depth')).toBe('0');
    // The cell is wordless at either backlog value: the connection is read off `data-capture`.
    expect(status.textContent).toBe('');
    expect(status.getAttribute('data-capture')).toBe('starting');
  });
});

// ── (this task) AC2: a browser-forced microphone suspension is console-only state ───────────────
//
// A suspended capture AudioContext stops the worklet delivering frames with nothing on screen to
// say so. The hook surfaces it as its own reading, but the operator's UX rule is that it must NOT
// become the red `error` line and must NOT move the `muted` phase — Mute is the user's own button,
// and flipping it for a suspension the user never asked for would change its `aria-pressed` and its
// label under them. The suspension detail is a console line, never a rendered string.

describe('a microphone suspension reaches the page as console-only state', () => {
  test('suspended→resumed keeps error null and phase listening, flips micSuspended, and logs the detail', () => {
    const { result } = mount();
    act(() => result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    // Capture running, so `listening` is the phase this test's claim is about (a suspension is not
    // what makes the phase move).
    act(() => sources[0]!.push(frame([0.1])));
    expect(result.current.phase).toBe('listening');
    expect(result.current.micSuspended).toBe(false);

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    act(() => sources[0]!.reportSuspension({ suspended: true, detail: 'AudioContext suspended, attempting resume' }));

    // The suspension is visible as its own reading...
    expect(result.current.micSuspended).toBe(true);
    // ...but it is NOT an error (nothing red gets rendered) and NOT the user's Mute.
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('listening');
    // ...and its detail really reached the console rather than being swallowed.
    expect(
      info.mock.calls.some((args) => args.some((arg) => typeof arg === 'string' && arg.includes('suspend'))),
      'the suspension detail never reached the console',
    ).toBe(true);

    act(() => sources[0]!.reportSuspension({ suspended: false, detail: 'AudioContext resumed after suspension' }));
    expect(result.current.micSuspended).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('listening');
  });

  test('negative control — no suspension report leaves micSuspended false and error null', () => {
    const { result } = mount();
    act(() => result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    act(() => sources[0]!.push(frame([0.1])));
    expect(result.current.micSuspended).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('listening');
  });
});

// ── (this task) AC3: a failure reads as ONE understandable sentence, and there is nothing to press ─
//
// What the caption line used to print on an error frame is the server's own `message` — for a frame
// this build does not know, the sentence `The upstream sent an event this build does not handle: …`,
// which describes this build's event table to a person who only wants to know whether their voice is
// broken. It now prints copy chosen by the error's `code` and keeps the server's own words on the
// caption element's `title`, so the detail is still one hover away. The three readings below are the
// task's own: the classified sentence, the absence of a reconnect control, and the status cell
// reading the CONNECTION rather than the backlog while Claude is busy.

describe('an error is one understandable sentence, with the server words kept on the title', () => {
  /** The exact frame the ruling was written about: a code this build's event table does not have. */
  const UNKNOWN_MESSAGE =
    'The upstream sent an event this build does not handle: response.output_audio_transcript.delta';

  test('an unknown code gets the generic sentence, and the server message is on the title', () => {
    const { container, session } = mountBar();
    act(() => session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    act(() => socket().receive({ type: 'error', code: 'UNKNOWN_EVENT', message: UNKNOWN_MESSAGE }));

    const caption = container.querySelector('[data-testid="voice-realtime-caption"]')!;
    const line = container.querySelector('[data-testid="voice-realtime-error"]')!;
    expect(line.textContent).toBe(EN_CHAT.voice.realtime.errors.generic);
    // The raw string is NOT what the person reads — that is the whole change.
    expect(line.textContent).not.toContain('output_audio_transcript');
    // ...and it is not thrown away either: it is the element's tooltip.
    expect(caption.getAttribute('title')).toContain(UNKNOWN_MESSAGE);
  });

  test('a classified code gets its own sentence — the generic one is a fallback, not the only answer', () => {
    const { container, session } = mountBar();
    act(() => session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    act(() => socket().receive({ type: 'error', code: 'CONNECTION_LOST', message: 'socket closed: 1006' }));

    const line = container.querySelector('[data-testid="voice-realtime-error"]')!;
    expect(line.textContent).toBe(EN_CHAT.voice.realtime.errors.connectionFailed);
    // Non-vacuity: the two sentences really are different, so the reading above is a classification
    // and not "every code renders the same string".
    expect(EN_CHAT.voice.realtime.errors.connectionFailed).not.toBe(EN_CHAT.voice.realtime.errors.generic);
    expect(line.textContent).not.toContain('1006');
  });

  test('a failed connection offers no reconnect control — Mute and Exit are the whole bar', () => {
    const { container, session } = mountBar();
    act(() => session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    act(() => socket().receive({ type: 'error', code: 'CONNECTION_FAILED', message: 'the relay died' }));
    expect(session().phase).toBe('failed');

    // The bar's own controls, read as testids: mute and exit, and nothing that reopens anything.
    const testids = Array.from(container.querySelectorAll('[data-testid^="voice-realtime-"]')).map(
      (node) => node.getAttribute('data-testid')!,
    );
    expect(testids).toContain('voice-realtime-mute');
    expect(testids).toContain('voice-realtime-end');
    expect(testids.filter((id) => /retry|reconnect|resume-connection/.test(id))).toEqual([]);
    // Non-vacuity: the list above is not empty, so "no retry testid" is not read off nothing.
    expect(testids.length).toBeGreaterThan(2);
  });

  test('while Claude is busy the status cell still carries the connection, not the backlog', () => {
    const { container, session } = mountBar(true);
    act(() => session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    // Capture running, so the cell's `data-capture` really is reading this connection while the
    // backlog changes — the claim below is about the queue, not about the arming phase.
    act(() => sources[0]!.push(frame([0.1])));
    act(() => socket().receive({ type: 'queued', depth: 3, bytes: 480 }));

    const status = container.querySelector('[data-testid="voice-realtime-status"]')!;
    // `listening` is transient and wordless; the connection reading is the attribute.
    expect(status.textContent).toBe('');
    expect(status.getAttribute('data-capture')).toBe('live');
    expect(status.textContent).not.toMatch(/\d{2}:\d{2}/);
    expect(status.textContent).not.toContain('480');
    expect(status.textContent).not.toContain('3');
    // The backlog the cell no longer prints is still on the element, so nothing was lost by the change.
    expect(status.getAttribute('data-queued-bytes')).toBe('480');
    expect(status.getAttribute('data-queued-depth')).toBe('3');
  });
});

/**
 * A network drop reconnects (person's ruling, 2026-10-15, overturning the earlier no-reconnect one).
 *
 * Live test 2026-10-15 (connection 71e53da5): the tunnel dropped the voice socket alone — no close
 * frame, no server error, the page socket stayed up — and the page only greyed into "Voice
 * disconnected" in the status cell; everything said afterwards went nowhere, unnoticed. A raw drop of
 * an opened microphone connection now reconnects with backoff, and a banner says so.
 */
describe('a network drop reconnects with backoff, and says so', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const open = () => {
    const view = mount();
    act(() => view.result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    return view;
  };
  /** The network takes the socket away: no close frame from either side, just the close event. */
  const drop = (ws: FakeWebSocket = socket()) => {
    act(() => {
      ws.readyState = FakeWebSocket.CLOSED;
      ws.onerror?.();
      ws.onclose?.();
    });
  };

  test('a dropped open connection reconnects to the same session on a new microphone capture', () => {
    const { result } = open();
    drop();
    expect(result.current.phase).not.toBe('failed');
    expect(result.current.error).toBeNull();
    expect(result.current.disconnected).toBe(true);
    expect(result.current.reconnecting).toEqual({ attempt: 1, of: 5 });
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(500));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket().url).toContain('session=sess-1');
    expect(sources).toHaveLength(2);
    expect(result.current.reconnecting).toEqual({ attempt: 1, of: 5 });

    act(() => socket().receive({ type: 'state', state: 'open' }));
    // The reconnect starts a NEW capture, so the phase re-enters `arming` until that source's first
    // frame arrives — the same contract as a fresh connection.
    expect(result.current.phase).toBe('arming');
    act(() => sources[1]!.push(frame([0.1])));
    expect(result.current.phase).toBe('listening');
    expect(result.current.disconnected).toBe(false);
    expect(result.current.reconnecting).toBeNull();
  });

  test('attempts back off 0.5/1/2/4/8 s, and after five failures it stays disconnected', () => {
    const { result } = open();
    drop();
    const delays = [500, 1_000, 2_000, 4_000, 8_000];
    delays.forEach((delay, index) => {
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(FakeWebSocket.instances).toHaveLength(index + 1);
      act(() => vi.advanceTimersByTime(1));
      expect(FakeWebSocket.instances).toHaveLength(index + 2);
      // The attempt never opens: the network is still down.
      drop();
    });
    expect(result.current.reconnecting).toBeNull();
    expect(result.current.disconnected).toBe(true);
    expect(result.current.phase).not.toBe('failed');
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(6);
  });

  test('Mute survives a reconnect: the new capture stays muted until the person unmutes (live 2026-10-15)', () => {
    const { result } = open();
    act(() => result.current.mute());
    drop();
    act(() => vi.advanceTimersByTime(500));
    act(() => socket().receive({ type: 'state', state: 'open' }));
    expect(result.current.phase).toBe('muted');
    act(() => sources[1]!.push(frame([0.2])));
    expect(socket().audio()).toEqual([]);
    act(() => result.current.unmute());
    act(() => sources[1]!.push(frame([0.3])));
    expect(socket().audio().map((audio) => decode(audio)[0])).toEqual([9830]);
  });

  test('a start the person asks for is never muted by an earlier session', () => {
    const { result } = open();
    act(() => result.current.mute());
    act(() => result.current.end());
    act(() => result.current.start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    act(() => sources[1]!.push(frame([0.1])));
    expect(result.current.phase).toBe('listening');
  });

  test('a reconnect that opens resets the backoff for the next drop', () => {
    const { result } = open();
    drop();
    act(() => vi.advanceTimersByTime(500));
    drop();
    expect(result.current.reconnecting).toEqual({ attempt: 2, of: 5 });
    act(() => vi.advanceTimersByTime(1_000));
    act(() => socket().receive({ type: 'state', state: 'open' }));
    drop();
    expect(result.current.reconnecting).toEqual({ attempt: 1, of: 5 });
  });

  test('a server close, a fatal error, an exit and a file source never reconnect', () => {
    const closed = open();
    act(() => socket().receive({ type: 'state', state: 'closed' }));
    act(() => socket().close());
    expect(closed.result.current.reconnecting).toBeNull();
    closed.unmount();

    const fatal = open();
    act(() => socket().receive({ type: 'error', code: 'SPEND_LIMIT', message: 'spent' }));
    act(() => socket().close());
    expect(fatal.result.current.reconnecting).toBeNull();
    expect(fatal.result.current.error).toBe('spent');
    fatal.unmount();

    const neverOpened = mount();
    act(() => neverOpened.result.current.start());
    drop();
    expect(neverOpened.result.current.reconnecting).toBeNull();
    neverOpened.unmount();

    const file = mount();
    act(() => file.result.current.startWithFile(new File([new Uint8Array(4)], 'a.wav')));
    act(() => socket().receive({ type: 'state', state: 'open' }));
    drop();
    expect(file.result.current.reconnecting).toBeNull();
    file.unmount();

    const count = FakeWebSocket.instances.length;
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(count);
  });

  test('exit while waiting cancels the reconnect', () => {
    const { result } = open();
    drop();
    act(() => result.current.end());
    expect(result.current.reconnecting).toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test('the bar shows a banner while reconnecting, and another once it has given up', () => {
    const view = mountBar();
    act(() => view.session().start());
    act(() => socket().receive({ type: 'state', state: 'open' }));
    expect(view.queryByTestId('voice-realtime-connection-alert')).toBeNull();

    drop();
    const alert = view.getByTestId('voice-realtime-connection-alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('1/5');

    for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
      act(() => vi.advanceTimersByTime(delay));
      drop();
    }
    const gaveUp = view.getByTestId('voice-realtime-connection-alert');
    expect(gaveUp.getAttribute('data-state')).toBe('disconnected');
    expect(gaveUp.textContent).not.toContain('/5');
  });
});

/**
 * The C2 context pack FOLLOWS the conversation (gap-voice-context-pack-refresh-and-stale-summary-gate).
 *
 * It used to be a single frame at `socket.onopen`, and the proxy kept that reading for the whole
 * connection — so a run-end summary could only ever describe what had been said when Live Voice was
 * started. The rules pinned here are the client half: a change in what the person can READ is
 * re-sent after a short quiet window, an unchanged pack is not re-sent (the proxy would report a
 * new injection for no new context), and a closed connection is never written to.
 */
describe('context: the pack is resent when the conversation moves', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A fixed clock keeps the pack's relative times (`刚刚`) stable across the debounce window, so
    // "the pack did not change" is a fact of the transcript rather than of how long the test ran.
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const row = (type: 'user' | 'assistant', content: string): ChatMessage => ({
    type,
    content,
    timestamp: new Date('2026-10-21T00:00:00Z'),
  });

  const mountWithContext = (contextMessages: readonly ChatMessage[]) =>
    renderHook(
      ({ messages }: { messages: readonly ChatMessage[] }) =>
        useVoiceRealtimeSession({ sessionId: 'sess-1', contextMessages: messages }),
      { initialProps: { messages: contextMessages } },
    );

  /** Every `context` frame the page put on this socket, in order. */
  const contextFrames = (ws: FakeWebSocket) =>
    ws.sent
      .map((raw) => JSON.parse(raw) as { type: string; text?: string; chars?: number; rows?: number })
      .filter((frame) => frame.type === 'context');

  const openWith = (messages: readonly ChatMessage[]) => {
    const view = mountWithContext(messages);
    act(() => view.result.current.start());
    act(() => socket().onopen?.());
    return view;
  };

  test('a new visible row is resent after the debounce, and the frame carries the new pack', () => {
    const first = [row('user', '把登录页改一下。')];
    const view = openWith(first);
    const [opening] = contextFrames(socket());
    expect(opening).toBeDefined();

    view.rerender({ messages: [...first, row('assistant', '已经改好了，单元测试 12/12 通过。')] });
    // Nothing inside the quiet window: a streaming answer must not put a frame per row on the wire.
    act(() => vi.advanceTimersByTime(2_499));
    expect(contextFrames(socket())).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1));
    const frames = contextFrames(socket());
    expect(frames).toHaveLength(2);
    expect(frames[1]!.text).not.toBe(frames[0]!.text);
    expect(frames[1]!.chars).toBeGreaterThan(frames[0]!.chars!);
    expect(frames[1]!.rows).toBe(2);
  });

  test('a transcript change that leaves the pack identical is not sent again', () => {
    const messages = [row('user', '把登录页改一下。'), row('assistant', '已经改好了。')];
    const view = openWith(messages);
    expect(contextFrames(socket())).toHaveLength(1);

    // A new ARRAY with the same rows — the shape a re-render of the transcript hands over.
    view.rerender({ messages: [...messages] });
    act(() => vi.advanceTimersByTime(2_500));
    expect(contextFrames(socket())).toHaveLength(1);
  });

  test('a closed socket is never written to, and a pending resend is dropped', () => {
    const first = [row('user', '把登录页改一下。')];
    const view = openWith(first);
    expect(contextFrames(socket())).toHaveLength(1);

    // Arm the debounce, then take the connection away before it fires.
    view.rerender({ messages: [...first, row('assistant', '已经改好了。')] });
    const ws = socket();
    act(() => view.result.current.end());

    act(() => vi.advanceTimersByTime(10_000));
    expect(ws.sent.filter((raw) => (JSON.parse(raw) as { type: string }).type === 'context')).toHaveLength(1);

    // And a change AFTER the close arms nothing on the dead socket.
    view.rerender({ messages: [...first, row('assistant', '又改了一版。')] });
    act(() => vi.advanceTimersByTime(10_000));
    expect(ws.sent.filter((raw) => (JSON.parse(raw) as { type: string }).type === 'context')).toHaveLength(1);
  });
});
