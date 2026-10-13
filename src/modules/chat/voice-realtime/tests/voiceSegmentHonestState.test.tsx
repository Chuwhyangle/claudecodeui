/**
 * AC-355 — the Live Voice transcript is honest, segment by segment (GOAL-043).
 *
 * THE CLAIM, in four parts, each of which the page currently gets wrong:
 *
 *   1. A ROW GOES WHERE ITS WORDS WERE SPOKEN. The endpoint answers its commits out of order, so a
 *      transcript can arrive for the sentence the person said FIRST long after the one they said
 *      third. Ordering rows by arrival — or by back-filling them at the bottom in the order their
 *      transcripts turned up — reads the person their own sentences shuffled. Every honest row (a
 *      hole, a refused utterance) carries the relay `seq` of the segment it is about, so it can be
 *      placed by it.
 *   2. ONLY WHAT THE MODEL FORWARDED IS DELIVERED. The realtime model may decline to relay part of
 *      what it heard. Those words were heard and went nowhere — and they are NOT a row of this
 *      client's own (this task, `gap-live-voice-remove-transcript-caption-rows`): the bottom voice
 *      bar shows the live transcript, and the composer is handed the unclaimed words back on Exit.
 *   3. A SEGMENT WITH NO TRANSCRIPT SAYS SO, IN PLACE. A commit the endpoint refused, or one it
 *      accepted and never answered, leaves a hole in the transcript that reads exactly like a pause.
 *      The row states the fact at the segment's own spoken place; a transcript that arrives LATE
 *      replaces it in place, because a late transcript is not a defect.
 *   4. LEAVING BY THE EXIT BUTTON LEAVES A TRACE. Until now the close trace was computed only when
 *      the SERVER closed the socket: the user's own Exit reset the segment counter and closed the
 *      socket before the count was taken, so the one moment a person asks "did that go?" had no
 *      answer on screen.
 *
 * WHY THESE READINGS. `seq` is the client's own segment number, minted when the segment is opened
 * and carried on the wire in both directions (`segment_start`/`audio`/`segment_end` out,
 * `caption.seq` and `segment_ack.seq` back — the pairing landed with
 * `gap-live-voice-caption-segment-attribution-by-item-id`), which is what makes "where it was
 * spoken" a reading rather than a guess from timestamps that two clocks produce.
 *
 * THE FALSE FORM, AND WHY THE FIRST GROUP IS FIRST. The defect these readings exist for is exactly
 * "order by arrival / back-fill at the bottom in arrival order". The first group is written so that
 * an arrival-ordered (or bottom-back-filled) implementation fails it: the fixtures hand the rows in
 * an order different from the order the sentences were spoken, and the assertions read the spoken
 * one — the hook's own caption order, and the placement of a refused row above the delivered turn it
 * was spoken before. (The red was demonstrated by making the capstone's own sort the identity and
 * re-running the group; see the task's Notes.)
 *
 * Run: npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  collectUndeliveredUtterances,
  useVoiceRealtimeSession,
  voiceTranscriptRows,
  type VoiceRealtimeCaption,
  type VoiceRealtimeDelivery,
} from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeAudioFrame, VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import { SEGMENTED_RELAY_PROTOCOL } from '@/modules/chat/voice-realtime/voiceRealtimeProtocol';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

// ── the fixtures: the five sentences the journal `ef9daacd` recorded being spoken ─────────────
//
// S1 was reported (and relayed) as S1_RELAYED by the model; S2 and S4 were heard and never
// forwarded; S3's segment produced no transcript at all; S5 was the last thing said, and was relayed.

const S1 = '第一句话。';
const S1_RELAYED = '第一句话，收到了。';
const S2 = '现在是第二句话。';
const S3 = '第三句话。';
const S4 = '第四句话。';
const S5 = '上面我们看见丢了一句话。';
const SEED = 'seeded turn for the honest-state reading';

/** One epoch-ms base for the whole file, so every timestamp is comparable and inside the skew bound. */
const T0 = 1_700_000_000_000;
const at = (seconds: number): number => T0 + seconds * 1_000;

const seedRow: ChatMessage = { type: 'user', content: SEED, timestamp: '2026-10-12T07:47:00.000Z' };

const caption = (itemId: string, text: string, seq: number | null, seconds: number, final = true): VoiceRealtimeCaption => ({
  itemId,
  text,
  final,
  at: at(seconds),
  seq,
});

const delivery = (message: string, itemIds: string[], seconds: number, heard = itemIds.map(() => message)): VoiceRealtimeDelivery => ({
  message,
  at: at(seconds),
  heard,
  itemIds,
});

/** The real transcript row a delivery became — the row the pane reads back as delivered. */
const deliveredRow = (content: string, seconds: number): ChatMessage => ({
  type: 'user',
  content,
  timestamp: at(seconds),
});

/**
 * The same row, stamped NOW.
 *
 * The hook's deliveries carry the wall clock they were recorded at, and a real row is only read as
 * that delivery's row when the two are within the skew bound — so the hook-level cases below must
 * build their visible transcript on the same clock the hook is on, not on the fixture's fixed base.
 */
const justDelivered = (content: string): ChatMessage => ({ type: 'user', content, timestamp: Date.now() });

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
  frames(): { type: string; seq?: number }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; seq?: number });
  }
  types(): string[] {
    return this.frames().map((entry) => entry.type);
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
 * Speaks one sentence and closes it, which is what puts one segment on the wire.
 *
 * `mute()` flushes the open segment as its own `segment_end` (the shipped behaviour — see
 * `useVoiceRealtimeSession.segmented.test.tsx`), so each call mints exactly one segment number, in
 * the order the sentences were spoken. Nothing here depends on the detector's own gap timing.
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

const captionFrame = (itemId: string, text: string, seq: number): unknown => ({
  type: 'caption',
  itemId,
  text,
  final: true,
  seq,
});

// ── 1. the row order is the SPOKEN order, not the arrival order ──────────────────────────────
//
// FIRST, because this is the false form the task is about: every case here reds on an
// arrival-ordered (or bottom-back-filled) implementation.

describe('a row goes where its words were spoken, not where its transcript arrived', () => {
  test('the session reads its captions back in spoken order though the endpoint answered them out of order', () => {
    const { result, ws } = openSegmented();
    // Three sentences, spoken in this order: S2 (seq0), S4 (seq1), S5 (seq2).
    speakSentence(result);
    speakSentence(result);
    speakSentence(result);

    // The endpoint answers them in the order 2, 0, 1 — the journal's own shape.
    act(() => ws.receive(captionFrame('c', S5, 2)));
    act(() => ws.receive(captionFrame('a', S2, 0)));
    act(() => ws.receive(captionFrame('b', S4, 1)));

    expect(result.current.captions.map((entry) => entry.text)).toEqual([S2, S4, S5]);
    expect(result.current.captions.map((entry) => entry.seq)).toEqual([0, 1, 2]);
  });

  test('an honest row goes at the segment it is about, though the list is not handed in that order', () => {
    // Two segments produced no transcript: seq 2 and seq 1, both spoken before the delivered turn at
    // seq 3. The pane is handed them in ARRIVAL order (2 first) — what a hook that appended on
    // arrival would hand the algebra — and its delivered row anchors the tail. The honest rows are
    // placed by the segment they are about, so they read in spoken order, above the turn they
    // preceded. On an arrival-ordered implementation the two holes swap.
    const captions = [caption('e', S5, 3, 1)];
    const deliveries = [delivery(S5, ['e'], 6)];
    const visibleMessages = [seedRow, deliveredRow(S5, 6)];

    const rows = voiceTranscriptRows({ captions, deliveries, visibleMessages, unrecognizedSeqs: [2, 1] });

    expect(rows.map((row) => row.voiceUnrecognizedSeq ?? row.content)).toEqual([SEED, 1, 2, S5]);
  });

  test('an honest row about a sentence spoken before a delivered one sits above it', () => {
    // Spoken order: S2 (seq0) … S5 (seq3, delivered). The two sentences the model heard and never
    // forwarded are S2 and S4; their captions arrive AFTER the delivery, and S4's before S2's.
    // The delivered turn is the row that stays, marked with what was heard, and the two refused rows
    // are placed by the segment they were spoken in — BOTH ABOVE it. On a bottom-back-filled
    // implementation they read [seed, S5, …] instead.
    const captions = [
      caption('e', S5, 3, 1),
      caption('d', S4, 2, 2),
      caption('b', S2, 0, 3),
    ];
    const deliveries = [delivery(S5, ['e'], 6)];
    const visibleMessages = [seedRow, deliveredRow(S5, 6)];

    const rows = voiceTranscriptRows({ captions, deliveries, visibleMessages, undeliveredItemIds: ['b', 'd'] });
    const texts = rows.map((row) => row.content);

    // The delivered turn is the row that stays, and it is marked with the words the model heard.
    const real = rows.find((row) => row.content === S5)!;
    expect(real.voiceTranscript?.heard).toEqual([S5]);
    // Both refused sentences are on screen, each its own row, and BOTH ABOVE the delivered turn: they
    // were spoken before it.
    expect(texts.indexOf(S2)).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf(S4)).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf(S2)).toBeLessThan(texts.indexOf(S5));
    expect(texts.indexOf(S4)).toBeLessThan(texts.indexOf(S5));
    expect(texts.indexOf(S2)).toBeLessThan(texts.indexOf(S4));
  });

  test('the words the composer gets back on Exit are the unclaimed finals in spoken order', () => {
    const { result, ws } = openSegmented();
    // Spoken: S2, then S4, then S3. The endpoint answers them in the order 2, 1, 0 — every
    // transcript arrives out of order, and S3's arrives first.
    speakSentence(result);
    speakSentence(result);
    speakSentence(result);
    act(() => ws.receive(captionFrame('c', S3, 2)));
    act(() => ws.receive(captionFrame('d', S4, 1)));
    act(() => ws.receive(captionFrame('b', S2, 0)));

    // Nothing was delivered, so the composer is owed back everything that was said — in the order it
    // was said, which is what makes the draft readable as the thought the person had.
    expect(collectUndeliveredUtterances(result.current.captions, result.current.deliveries)).toBe(S2 + S4 + S3);
  });

  test('a caption the proxy could not attribute still lands where it was spoken, and leaves no second hole', () => {
    const { result, ws } = openSegmented();
    // The journal's own shape, read off the 2026-10-12 replay's recording: the endpoint's detector took
    // segment 1's audio as an item of its own, so the commit for that segment came back refused — and
    // the words of that audio arrived during segment 2 with NO seq of their own
    // (`{"itemId":"A_B","text":"现在是第二句话。","seq":null}`).
    speakSentence(result); // seq0 — S1
    speakSentence(result); // seq1 — refused; the audio the words below belong to
    speakSentence(result); // seq2 — the segment in flight when those words arrive
    act(() => ws.receive(captionFrame('a', S1, 0)));
    act(() => ws.receive({ type: 'segment_ack', seq: 1, state: 'dropped', reason: 'commit-refused' }));
    expect(result.current.unrecognizedSeqs).toEqual([1]);

    act(() => ws.receive({ type: 'caption', itemId: 'b', text: S2, final: true, seq: null }));

    // The client's own numbering places them: the oldest segment no other utterance accounts for, which
    // is the segment they were spoken in. An implementation that left them unplaceable reads back
    // [S1, S2 at the bottom] here, and hands the composer the sentences out of order.
    expect(result.current.captions.map((entry) => [entry.text, entry.seq])).toEqual([
      [S1, 0],
      [S2, 1],
    ]);
    expect(collectUndeliveredUtterances(result.current.captions, result.current.deliveries)).toBe(S1 + S2);
    const rows = voiceTranscriptRows({ captions: result.current.captions, deliveries: [], visibleMessages: [seedRow] });
    // And the words are not a row of this client's own: an accounted-for segment is not a hole, and
    // the person's words are shown in the bottom voice bar until the model relays them for real.
    expect(rows.map((row) => row.content)).toEqual([SEED]);
    expect(rows.some((row) => row.voiceUnrecognizedSeq !== undefined)).toBe(false);
    // And the refusal's line goes with the words it was about: the refusal said no transcript was coming
    // for that COMMIT, not that the audio was lost — it was transcribed under the item the detector made
    // instead. Five sentences across six segments show ONE hole, not a hole plus the words that fill it.
    expect(result.current.unrecognizedSeqs).toEqual([]);
  });
});

// ── 2. only the utterances a delivery claimed are delivered ──────────────────────────────────

describe('only the utterances a delivery claimed become delivered', () => {
  test('the `sent` frame claims the utterance its own message carries and no other', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    speakSentence(result);
    speakSentence(result);
    act(() => ws.receive(captionFrame('a', S1, 0)));
    act(() => ws.receive(captionFrame('b', S2, 1)));
    act(() => ws.receive(captionFrame('d', S5, 2)));

    // The model relays S1 — and only S1: S2 was heard and not forwarded. (The relayed words are the
    // model's own rendering of what it heard, which is why the delivery is matched on the words the
    // caption carries, not on the two strings being equal.)
    act(() => ws.receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: S1_RELAYED }));

    expect(result.current.deliveries.map((entry) => entry.itemIds)).toEqual([['a']]);
    expect(result.current.delivering).toBe(false);

    const rows = voiceTranscriptRows({
      captions: result.current.captions,
      deliveries: result.current.deliveries,
      visibleMessages: [seedRow, justDelivered(S1_RELAYED)],
    });
    // S1's words are the real row now. S2 and S5 were heard and never forwarded: they are NOT rows
    // of this client's own — the bottom voice bar shows them while the session is open, and the
    // composer is handed them back on Exit. No row of the pane's is left carrying them.
    expect(rows.map((row) => row.content)).toEqual([SEED, S1_RELAYED]);
    expect(rows.filter((row) => row.voiceRowState !== undefined)).toEqual([]);
    for (const text of [S2, S5]) {
      expect(
        rows.filter((row) => row.content === text),
        `${text} was never forwarded, so it is not a row of the pane's own`,
      ).toHaveLength(0);
    }
  });

  test('words the model never forwarded are not rows of the client’s own, in flight or landed', () => {
    const captions = [
      caption('a', S1, 0, 1),
      caption('b', S2, 1, 2),
      caption('d', S4, 2, 3),
      caption('e', S5, 3, 4),
    ];
    const deliveries = [delivery(S1, ['a'], 5)];
    const visibleMessages = [seedRow, deliveredRow(S1, 5)];

    // The proxy holds S5 in its coalescing window: S5 is the one on its way. Nothing in flight is a
    // row of this client's own — the waiting words are shown in the bottom voice bar.
    const inFlight = voiceTranscriptRows({ captions, deliveries, visibleMessages });
    expect(inFlight.map((row) => row.content)).toEqual([SEED, S1]);

    // The window closes and the delivery lands: S5's words become the real message, and the two the
    // model never forwarded are still not rows. The pane never invents a row that must then vanish —
    // a row that appears and disappears is what the person read as the transcript rewriting itself.
    const landed = voiceTranscriptRows({
      captions,
      deliveries: [...deliveries, delivery(S5, ['e'], 7)],
      visibleMessages: [seedRow, deliveredRow(S1, 5), deliveredRow(S5, 7)],
    });
    expect(landed.map((row) => row.content)).toEqual([SEED, S1, S5]);
    expect(landed.filter((row) => row.voiceRowState !== undefined)).toEqual([]);
  });
});

// ── 3. a segment with no transcript is marked where it was spoken ────────────────────────────

describe('a segment that produced no transcript says so, in place', () => {
  test('the proxy`s own dropped verdict marks the segment at once', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    expect(result.current.unrecognizedSeqs).toEqual([]);

    act(() => ws.receive({ type: 'segment_ack', seq: 0, state: 'dropped', reason: 'empty-transcript' }));

    expect(result.current.unrecognizedSeqs).toEqual([0]);
    const rows = voiceTranscriptRows({
      captions: result.current.captions,
      deliveries: result.current.deliveries,
      visibleMessages: [seedRow],
      unrecognizedSeqs: result.current.unrecognizedSeqs,
    });
    expect(rows.filter((row) => typeof row.voiceUnrecognizedSeq === 'number').map((row) => row.voiceUnrecognizedSeq)).toEqual([0]);
  });

  test('a commit the endpoint refused is marked too — the words have nowhere else to be', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    speakSentence(result);
    act(() => ws.receive({ type: 'segment_ack', seq: 1, state: 'dropped', reason: 'commit-refused' }));
    expect(result.current.unrecognizedSeqs).toEqual([1]);
  });

  test('a committed segment nobody answers is marked only after the grace window, not before', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result, ws } = openSegmented();
    speakSentence(result);

    // Committed and unanswered: nothing on the wire will ever say so, and the endpoint's answers are
    // late by seconds — the page must not accuse it while the transcript is still coming.
    act(() => ws.receive({ type: 'segment_ack', seq: 0, state: 'committed' }));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.unrecognizedSeqs).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.unrecognizedSeqs).toEqual([0]);
  });

  test('a transcript that arrives late REPLACES the not-recognised line in place', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    speakSentence(result);
    act(() => ws.receive(captionFrame('b', S4, 1)));
    act(() => ws.receive({ type: 'segment_ack', seq: 0, state: 'dropped', reason: 'empty-transcript' }));
    expect(result.current.unrecognizedSeqs).toEqual([0]);

    // The endpoint answers at last, for the same segment: the mark is retracted and the words take
    // its place — a late transcript is not a defect.
    act(() => ws.receive(captionFrame('a', S1, 0)));

    expect(result.current.unrecognizedSeqs).toEqual([]);
    const rows = voiceTranscriptRows({
      captions: result.current.captions,
      deliveries: result.current.deliveries,
      visibleMessages: [seedRow],
      unrecognizedSeqs: result.current.unrecognizedSeqs,
    });
    expect(rows.some((row) => typeof row.voiceUnrecognizedSeq === 'number')).toBe(false);
    // And the words take their place the way any words do — as the real message the model relays, in
    // the turn it belongs to — not as a row of the pane's own. Here that message has not landed yet,
    // so the pane shows the opening transcript alone.
    expect(rows.map((row) => row.content)).toEqual([SEED]);
  });

  test('the not-recognised line is rendered from the locale, not from an untranslated literal', async () => {
    const row: ChatMessage = { type: 'system', content: '', timestamp: at(1), voiceUnrecognizedSeq: 2 };

    for (const lang of LOCALES) {
      const translated = messageOf(lang).voiceUnrecognized;
      expect(typeof translated, `${lang}/chat.json must carry message.voiceUnrecognized`).toBe('string');
      expect(String(translated).trim(), `${lang}'s not-recognised line is empty`).not.toBe('');
      if (lang !== 'en') {
        expect(
          String(translated),
          `${lang} ships the English literal instead of a translation: ${JSON.stringify(translated)}`,
        ).not.toBe(messageOf('en').voiceUnrecognized);
      }
    }

    // The strongest reading of the same fact: a NON-English locale renders its own line, so the
    // English `defaultValue` in the component is a fallback nobody sees.
    await i18next.changeLanguage('ja');
    try {
      const { container } = render(
        <UiPreferencesProvider>
          <MessageComponent message={row} prevMessage={null} createDiff={(): DiffLine[] => []} provider="claude" />
        </UiPreferencesProvider>,
      );
      const line = container.querySelector('[data-testid="voice-row-unrecognized"]')!;
      expect(line.getAttribute('data-voice-unrecognized-seq')).toBe('2');
      expect(line.textContent).toBe(messageOf('ja').voiceUnrecognized);
      // It is not the person's row and not a blank bubble: the pane's row algebra must not count it.
      expect(container.querySelector('[data-message-style]')).toBeNull();
    } finally {
      await i18next.changeLanguage('en');
    }

    const { container } = render(
      <UiPreferencesProvider>
        <MessageComponent message={row} prevMessage={null} createDiff={(): DiffLine[] => []} provider="claude" />
      </UiPreferencesProvider>,
    );
    expect(container.querySelector('[data-testid="voice-row-unrecognized"]')!.textContent).toBe(
      messageOf('en').voiceUnrecognized,
    );
  });
});

// ── 4. Exit leaves a trace, and it counts what went unrecognised ─────────────────────────────

describe('leaving by the Exit button leaves a trace that counts the unrecognised segments', () => {
  test('Exit counts the words that never reached the screen, including the segment with no transcript', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    speakSentence(result);
    // S2 was transcribed and never forwarded; the second segment produced no transcript at all.
    act(() => ws.receive(captionFrame('b', S2, 0)));
    act(() => ws.receive({ type: 'segment_ack', seq: 1, state: 'dropped', reason: 'empty-transcript' }));

    act(() => result.current.end());

    // One unshown final + one silent segment: the trace is not silent, and it counts both kinds.
    expect(result.current.closedUnshown).toBe(2);
    expect(result.current.phase).toBe('idle');
    expect(result.current.disconnected).toBe(false);
  });

  test('the unclaimed words are owed back to the composer, and the unrecognised segment is not', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    speakSentence(result);
    act(() => ws.receive(captionFrame('b', S2, 0)));
    act(() => ws.receive({ type: 'segment_ack', seq: 1, state: 'dropped', reason: 'empty-transcript' }));

    act(() => result.current.end());

    const draft = collectUndeliveredUtterances(result.current.captions, result.current.deliveries);
    expect(draft).toBe(S2);
    // Nothing was invented for the segment that produced no words: there is no text to hand back.
    expect(draft).not.toMatch(/not recogni[sz]ed|未识别/i);
  });
});

// ── 5. a recoverable failure stays in the console, and nothing is ever re-sent ────────────────

describe('a recoverable failure stays in the console', () => {
  test('UPSTREAM_ERROR and MODEL_TEXT_REPLY raise no UI, no row and no lost-utterance mark', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    act(() => ws.receive(captionFrame('a', S1, 0)));
    const readRows = (): ChatMessage[] =>
      voiceTranscriptRows({
        captions: result.current.captions,
        deliveries: result.current.deliveries,
        visibleMessages: [seedRow],
        unrecognizedSeqs: result.current.unrecognizedSeqs,
      });
    const before = readRows();

    act(() => ws.receive({ type: 'error', code: 'UPSTREAM_ERROR', message: 'upstream blew up', recoverable: true }));
    act(() => ws.receive({ type: 'error', code: 'MODEL_TEXT_REPLY', message: 'the model answered in text', recoverable: true }));

    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe('listening');
    expect(result.current.unrecognizedSeqs).toEqual([]);
    // Nothing was added: a spoiled model turn is not a hole in the transcript and not a label on the
    // person's words.
    expect(readRows().map((row) => row.content)).toEqual(before.map((row) => row.content));
    expect(readRows().some((row) => typeof row.voiceUnrecognizedSeq === 'number')).toBe(false);

    // Non-vacuity: the console-only rule is about RECOVERABLE failures. One that is not still shows.
    act(() => ws.receive({ type: 'error', code: 'FATAL', message: 'the relay died' }));
    expect(result.current.error).toBe('the relay died');
    expect(result.current.phase).toBe('failed');
  });

  test('the page sends nothing of its own: no resent request, before or after Exit', () => {
    const { result, ws } = openSegmented();
    speakSentence(result);
    act(() => ws.receive(captionFrame('a', S1, 0)));
    act(() => ws.receive({ type: 'error', code: 'UPSTREAM_ERROR', message: 'upstream blew up', recoverable: true }));

    // Everything on the wire is the session's own framing: the offer, then one segment's audio
    // between its boundaries, and nothing else.
    const own = ws.types();
    expect(own[0]).toBe('hello');
    expect(own.slice(1).filter((type) => !['segment_start', 'audio', 'segment_end'].includes(type))).toEqual([]);
    expect(own.filter((type) => type === 'segment_end')).toHaveLength(1);

    act(() => result.current.end());

    // Exit adds the close and nothing else — there is no auto-resend request for the model's
    // silence, and the frames above are the whole of what this page ever initiates.
    expect(ws.types().slice(own.length)).toEqual(['close']);
  });
});
