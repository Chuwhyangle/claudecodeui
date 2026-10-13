/**
 * AC-367 — a segment the graded ACK reported UNCERTAIN or LOST is shown honestly (GOAL-043).
 *
 * THE CLAIM. AC-366 gave the page a graded per-segment verdict on the wire —
 * `segment_ack { seq, state }` with four states — and until this task the page read only two of them
 * (`committed`, `dropped`). The two it ignored are the ones a broken connection produces:
 *
 *   - `written` — UNCERTAIN. The segment's audio and its commit were written to an upstream socket
 *     that died before the endpoint answered. The bridge may still replay it, so the honest wording
 *     is "retrying this part" — never "not recognised", which would blame the recogniser for a wire
 *     that may yet carry the audio.
 *   - `lost` — TERMINAL, with a reason. `connection-closed`: the voice connection was not open when
 *     the segment ended, so its frames never left the page — and the bar has to say the connection is
 *     down rather than keep reading "Listening…" over a microphone with nowhere to send.
 *     `upstream-drop`: the frames were written but the bridge spent its replay budget, so the words
 *     never reached the model.
 *
 * WHAT WAS WRONG. A lost segment produced no caption, so it left no row: the person's sentence simply
 * vanished from the transcript, reading exactly like a pause, and the bar went on looking live. The
 * fix is a row of the segment's own (`type:'system'`, no words, no bubble) placed where the segment
 * was spoken, carrying the state; and `lost(connection-closed)` also flips the connection to
 * disconnected.
 *
 * WHY A LOST SEGMENT IS NOT AN UNRECOGNISED ONE, which is the whole task. `dropped` means the
 * endpoint WAS handed the audio and answered with no words — the blame is the recogniser's. `lost`
 * means the audio never got there — the blame is the connection's. Collapsing the two (the false
 * form below: handling a `lost` frame the way a `dropped` one is handled) both mislabels the failure
 * and, worse, hides it: the person is told their speech was not transcribed when in fact it never
 * arrived, so "say it again into a working microphone" is the one thing that would help and the one
 * thing the copy does not suggest.
 *
 * NOT BACK-FILLED. A lost segment has no transcript, so there are no words of the person's to hand
 * back: `collectUndeliveredUtterances` reads captions, so a lost segment contributes nothing to the
 * composer draft by construction — asserted here so the invariant cannot be broken silently.
 *
 * THE FALSE FORM, AND THE FIRST GROUP. Every case in the first group is written so that an
 * implementation handling a `lost` frame as a `dropped` one fails: a lost verdict is asserted NOT to
 * appear in `unrecognizedSeqs` and to appear in `segmentOutcomes` instead, and — non-vacuity — a real
 * `dropped` verdict is asserted to still mark. (The red was demonstrated by making the hook's `lost`
 * branch call `markSegmentUnrecognized` and re-running; see the task's Notes.)
 *
 * Frames are driven through the REAL wire type (`VoiceRealtimeSegmentAck`), not a hand-written shape,
 * so the test cannot drift from what AC-366 emits.
 *
 * Run: npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentLostState.test.tsx
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  VoiceRealtimeBar,
  collectUndeliveredUtterances,
  useVoiceRealtimeSession,
  voiceTranscriptRows,
} from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeAudioFrame, VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import {
  SEGMENTED_RELAY_PROTOCOL,
  type VoiceRealtimeSegmentAck,
} from '@/modules/chat/voice-realtime/voiceRealtimeProtocol';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

// ── the fixtures ─────────────────────────────────────────────────────────────────────────────

const S1 = '第一句话。';
const S2 = '现在是第二句话。';
const SEED = 'seeded turn for the lost-state reading';

/** One epoch-ms base for the whole file, so every timestamp is comparable. */
const T0 = 1_700_000_000_000;
const at = (seconds: number): number => T0 + seconds * 1_000;

const seedRow: ChatMessage = { type: 'user', content: SEED, timestamp: '2026-10-12T07:47:00.000Z' };

/**
 * A real transcript row stamped NOW: the hook's deliveries carry the wall clock they were recorded
 * at, and a real row is only read as that delivery's row when the two are within the skew bound.
 */
const justDelivered = (content: string): ChatMessage => ({ type: 'user', content, timestamp: Date.now() });

const captionFrame = (itemId: string, text: string, seq: number): unknown => ({
  type: 'caption',
  itemId,
  text,
  final: true,
  seq,
});

/**
 * The graded ACK, built from the type AC-366's server frames are declared with.
 *
 * `receive` takes `unknown`, so this is the test's own hand at the wire — but the SHAPE is the
 * protocol's, not a literal retyped here, which is what the task's DoD asks for ("真实分级 ACK 帧 …
 * 不手写帧形状"). If the wire type's states or fields change, this fails to compile rather than
 * silently drifting.
 */
const segmentAck = (ack: Omit<VoiceRealtimeSegmentAck, 'type'>): VoiceRealtimeSegmentAck => ({
  type: 'segment_ack',
  ...ack,
});

// ── the i18n surface, read off every locale the repo ships ───────────────────────────────────

const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');
const LOCALES = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const chatOf = (lang: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(LOCALES_DIR, lang, 'chat.json'), 'utf8')) as Record<string, unknown>;
const CHAT = new Map(LOCALES.map((lang) => [lang, chatOf(lang)]));
const messageOf = (lang: string): Record<string, unknown> => (CHAT.get(lang)!.message ?? {}) as Record<string, unknown>;
/** A `voice.realtime.*` copy, read straight from the locale file the bar reads it from. */
const voiceRealtimeOf = (lang: string, key: string): string => {
  const voice = (CHAT.get(lang)!.voice ?? {}) as Record<string, unknown>;
  const realtime = (voice.realtime ?? {}) as Record<string, unknown>;
  return String(realtime[key]);
};

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: Object.fromEntries(LOCALES.map((lang) => [lang, { chat: CHAT.get(lang)! }])),
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

/** The slice of WebSocket the hook uses, with both hands: it opens when the test says so. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState: number = FakeWebSocket.CONNECTING;
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
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
  types(): string[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
  }
}

const SAMPLE_RATE = 16_000;
const CHUNK_SAMPLES = SAMPLE_RATE;

/** One second of speech: a 220 Hz tone under a moving envelope, so its energy is not a flat line. */
function speechChunk(offsetSeconds: number): Float32Array {
  const samples = new Float32Array(CHUNK_SAMPLES);
  for (let index = 0; index < samples.length; index += 1) {
    const seconds = offsetSeconds + index / SAMPLE_RATE;
    const envelope = 0.8 + 0.2 * Math.sin(2 * Math.PI * 3 * seconds);
    samples[index] = 0.3 * envelope * Math.sin(2 * Math.PI * 220 * seconds);
  }
  return samples;
}

/** One second of room tone, three orders of magnitude below speech: the noise floor. */
function silenceChunk(): Float32Array {
  const samples = new Float32Array(CHUNK_SAMPLES);
  samples.fill(1e-4);
  return samples;
}

beforeEach(() => {
  auth.token = 'jwt-token';
  FakeWebSocket.instances = [];
  sources.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

/** Opens a session whose server declares the segmented relay before the upstream opens. */
const openSegmented = () => {
  const hook = renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1' }));
  act(() => hook.result.current.start());
  const ws = socket();
  act(() => ws.open());
  act(() => ws.receive({ type: 'ready', protocol: SEGMENTED_RELAY_PROTOCOL }));
  act(() => ws.receive({ type: 'state', state: 'open' }));
  return { ...hook, ws };
};

let speechSeconds = 0;
/**
 * Speaks one sentence and closes it, which is what puts one segment on the wire — one segment number
 * per call, in the order the sentences were spoken (`mute()` flushes the open segment).
 */
const speakSentence = (result: { current: { mute: () => void; unmute: () => void } }): void => {
  act(() => {
    sources[0]!.push({ samples: silenceChunk(), sourceRate: SAMPLE_RATE });
    sources[0]!.push({ samples: speechChunk(speechSeconds), sourceRate: SAMPLE_RATE });
  });
  speechSeconds += 10;
  act(() => result.current.mute());
  act(() => result.current.unmute());
};

/** The rows the pane would place for a session, entered through the one public entry point. */
const rowsFor = (result: { current: {
  captions: Parameters<typeof voiceTranscriptRows>[0]['captions'];
  deliveries: Parameters<typeof voiceTranscriptRows>[0]['deliveries'];
  unrecognizedSeqs: readonly number[];
  segmentOutcomes: NonNullable<Parameters<typeof voiceTranscriptRows>[0]['segmentOutcomes']>;
} }, extraVisible: readonly ChatMessage[] = []): ChatMessage[] =>
  voiceTranscriptRows({
    captions: result.current.captions,
    deliveries: result.current.deliveries,
    visibleMessages: [seedRow, ...extraVisible],
    unrecognizedSeqs: result.current.unrecognizedSeqs,
    segmentOutcomes: result.current.segmentOutcomes,
  });

// ── 1. a segment the connection lost is never read as an unrecognised one ────────────────────
//
// FIRST, because this is the false form the task is about: every case here reds on an implementation
// that handles a `lost` (or `written`) frame the way a `dropped` one is handled.

describe('a segment the connection lost is never read as an unrecognised one', () => {
  test('a `written` verdict reads as retrying, and is not a not-recognised mark', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    act(() => ws.receive(segmentAck({ seq: 0, state: 'written' })));

    expect(result.current.segmentOutcomes).toEqual([{ seq: 0, state: 'written' }]);
    // The false form marks this as "no transcript came"; a written segment's audio may still be
    // replayed, so it must NOT be accused of being empty.
    expect(result.current.unrecognizedSeqs).toEqual([]);

    const rows = rowsFor(result);
    expect(rows[rows.length - 1]!.voiceSegmentOutcome).toEqual({ seq: 0, state: 'written' });
    expect(rows.some((row) => typeof row.voiceUnrecognizedSeq === 'number')).toBe(false);
  });

  test('a `lost(upstream-drop)` verdict reads as never-reached, is not not-recognised, and is not back-filled', () => {
    const { result, ws } = openSegmented();
    speakSentence(result); // seq0 — the segment the connection lost
    speakSentence(result); // seq1 — a real transcript arrives for this one
    act(() => ws.receive(captionFrame('b', S2, 1)));
    act(() => ws.receive(segmentAck({ seq: 0, state: 'lost', reason: 'upstream-drop' })));

    expect(result.current.segmentOutcomes).toEqual([{ seq: 0, state: 'lost', reason: 'upstream-drop' }]);
    expect(result.current.unrecognizedSeqs).toEqual([]);
    // The composer is owed back the real caption and NOTHING for the lost segment: it produced no
    // words, so there is nothing of the person's to hand back.
    expect(collectUndeliveredUtterances(result.current.captions, result.current.deliveries)).toBe(S2);

    // The model relays the sentence said after the lost segment, so the pane has a real row to place
    // the graded line against: the anchor is the delivered message, whose turn began at seq1.
    act(() => ws.receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: S2 }));

    const rows = rowsFor(result, [justDelivered(S2)]);
    expect(rows.find((row) => row.voiceSegmentOutcome)!.voiceSegmentOutcome).toEqual({
      seq: 0,
      state: 'lost',
      reason: 'upstream-drop',
    });
    expect(rows.some((row) => typeof row.voiceUnrecognizedSeq === 'number')).toBe(false);
    // Placed where it was spoken: before the delivered turn of the sentence said after it. A row of
    // its own is the ONLY thing the pane puts beside the real transcript for these words — nothing is
    // back-filled for the lost segment.
    expect(rows.map((row) => (row.voiceSegmentOutcome ? 'lost:0' : row.content))).toEqual([SEED, 'lost:0', S2]);
  });

  test('a `lost(connection-closed)` verdict flips the bar to disconnected, and the bar says so', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    act(() => ws.receive(segmentAck({ seq: 0, state: 'lost', reason: 'connection-closed' })));

    expect(result.current.segmentOutcomes).toEqual([{ seq: 0, state: 'lost', reason: 'connection-closed' }]);
    // The page socket is still open and the phase still reads `listening` — the disconnect is the one
    // reading that must win on the bar, or it goes on looking live over a dead connection.
    expect(result.current.phase).toBe('listening');
    expect(result.current.disconnected).toBe(true);

    const { container } = render(<VoiceRealtimeBar voice={result.current} onExit={() => {}} />);
    expect(container.querySelector('[data-testid="voice-realtime-status"]')!.textContent).toBe(
      voiceRealtimeOf('en', 'disconnected'),
    );
    // Disconnected is exactly the state Retry exists for.
    expect(container.querySelector('[data-testid="voice-realtime-retry"]')).not.toBeNull();
  });

  test('the false form: a `lost` frame handled as a `dropped` one is caught', () => {
    const { result, ws } = openSegmented();
    speakSentence(result); // seq0 — lost
    speakSentence(result); // seq1 — refused
    act(() => ws.receive(segmentAck({ seq: 0, state: 'lost', reason: 'upstream-drop' })));

    // "Treat a lost frame as dropped" is the defect: it would put seq0 in `unrecognizedSeqs` and leave
    // `segmentOutcomes` empty. Both assertions below red under that mutation.
    expect(result.current.unrecognizedSeqs, 'a lost segment is not a not-recognised one').not.toContain(0);
    expect(result.current.segmentOutcomes.map((outcome) => outcome.seq)).toEqual([0]);

    // Non-vacuity: a REAL dropped verdict still marks — the assertions above are about `lost` being
    // kept apart from `dropped`, not about the unrecognised path having stopped working.
    act(() => ws.receive(segmentAck({ seq: 1, state: 'dropped', reason: 'commit-refused' })));
    expect(result.current.unrecognizedSeqs).toEqual([1]);
  });
});

// ── 2. a later, truer answer retracts the graded line ────────────────────────────────────────

describe('a later answer retracts the graded line', () => {
  test('`committed` after `written` clears it — the segment is no longer uncertain', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    act(() => ws.receive(segmentAck({ seq: 0, state: 'written' })));
    expect(result.current.segmentOutcomes).toHaveLength(1);

    act(() => ws.receive(segmentAck({ seq: 0, state: 'committed' })));
    expect(result.current.segmentOutcomes).toEqual([]);
    expect(result.current.unrecognizedSeqs).toEqual([]);
  });

  test('a late transcript replaces the graded line in place, and leaves no second line', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    act(() => ws.receive(segmentAck({ seq: 0, state: 'written' })));
    expect(result.current.segmentOutcomes).toHaveLength(1);

    // The endpoint answers at last for the same segment: the words are the segment's truth now.
    act(() => ws.receive(captionFrame('a', S1, 0)));
    expect(result.current.segmentOutcomes).toEqual([]);
    expect(result.current.captions.map((entry) => entry.text)).toEqual([S1]);

    const rows = rowsFor(result);
    expect(rows.some((row) => row.voiceSegmentOutcome)).toBe(false);
    // And the words do not become a row of the pane's own: they take their place the one way any
    // words do — as the real message the model relays — so here the pane holds the transcript alone.
    expect(rows.map((row) => row.content)).toEqual([SEED]);
  });

  test('the transcript deadline does not overwrite a graded verdict, and still marks a bare segment', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result, ws } = openSegmented();
    speakSentence(result); // seq0 — gets a graded verdict before the deadline
    speakSentence(result); // seq1 — left bare, so the deadline is the only reader that can speak
    act(() => ws.receive(segmentAck({ seq: 0, state: 'written' })));

    act(() => {
      vi.advanceTimersByTime(7_000);
    });

    // The graded verdict is more specific than the deadline's "no words came", so it stands;
    // the bare segment is still marked, so the guard did not simply disable the deadline.
    expect(result.current.segmentOutcomes.map((outcome) => outcome.seq)).toEqual([0]);
    expect(result.current.unrecognizedSeqs).toEqual([1]);
  });
});

// ── 3. the three copies ship in every locale and render from it ──────────────────────────────

describe('the three copies ship in every locale, and render from the locale', () => {
  const KEYS = ['voiceSegmentRetrying', 'voiceSegmentLostUpstream', 'voiceSegmentLostConnection'] as const;

  const outcomeRow = (outcome: NonNullable<ChatMessage['voiceSegmentOutcome']>, seconds: number): ChatMessage => ({
    type: 'system',
    content: '',
    timestamp: at(seconds),
    voiceSegmentOutcome: outcome,
  });

  const renderOutcome = (message: ChatMessage): HTMLElement => {
    const { container } = render(
      <UiPreferencesProvider>
        <MessageComponent message={message} prevMessage={null} createDiff={(): DiffLine[] => []} provider="claude" />
      </UiPreferencesProvider>,
    );
    return container;
  };

  test('every locale carries all three keys, and none ships the English literal', () => {
    for (const lang of LOCALES) {
      for (const key of KEYS) {
        const translated = messageOf(lang)[key];
        expect(typeof translated, `${lang}/chat.json must carry message.${key}`).toBe('string');
        expect(String(translated).trim(), `${lang}'s ${key} is empty`).not.toBe('');
        if (lang !== 'en') {
          expect(
            String(translated),
            `${lang} ships the English literal for ${key}: ${JSON.stringify(translated)}`,
          ).not.toBe(messageOf('en')[key]);
        }
      }
    }
  });

  test('each state renders its own copy, as a transcript line and never a bubble', () => {
    const cases: [ChatMessage, string, string, string][] = [
      [outcomeRow({ seq: 1, state: 'written' }, 1), 'written', '', String(messageOf('en').voiceSegmentRetrying)],
      [
        outcomeRow({ seq: 2, state: 'lost', reason: 'upstream-drop' }, 2),
        'lost',
        'upstream-drop',
        String(messageOf('en').voiceSegmentLostUpstream),
      ],
      [
        outcomeRow({ seq: 3, state: 'lost', reason: 'connection-closed' }, 3),
        'lost',
        'connection-closed',
        String(messageOf('en').voiceSegmentLostConnection),
      ],
    ];

    for (const [message, state, reason, copy] of cases) {
      const container = renderOutcome(message);
      const line = container.querySelector('[data-testid="voice-row-segment-outcome"]')!;
      expect(line.getAttribute('data-voice-segment-outcome-state')).toBe(state);
      expect(line.getAttribute('data-voice-segment-outcome-reason')).toBe(reason);
      expect(line.getAttribute('data-voice-segment-outcome-seq')).toBe(String(message.voiceSegmentOutcome!.seq));
      expect(line.textContent).toBe(copy);
      // Not the person's row: no bubble, no words.
      expect(container.querySelector('[data-message-style]')).toBeNull();
    }
  });

  test('a NON-English locale renders its own line, so the English defaultValue is a fallback nobody sees', async () => {
    await i18next.changeLanguage('ja');
    try {
      const container = renderOutcome(outcomeRow({ seq: 2, state: 'lost', reason: 'upstream-drop' }, 2));
      expect(container.querySelector('[data-testid="voice-row-segment-outcome"]')!.textContent).toBe(
        messageOf('ja').voiceSegmentLostUpstream,
      );
    } finally {
      await i18next.changeLanguage('en');
    }
  });
});
