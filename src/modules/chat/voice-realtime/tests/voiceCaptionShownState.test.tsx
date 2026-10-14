/**
 * AC — Live Voice COUNTS the words the person spoke that never reached the screen.
 *
 * WHAT THIS FILE USED TO PIN, AND WHY IT CHANGED (this task,
 * `gap-live-voice-remove-transcript-caption-rows`). It used to be about the PROVISIONAL caption row:
 * a join rule built one row of the person's own words, and the whole claim was
 * that those words stayed on it until the REAL message became visible. That row is gone: a spoken
 * utterance is not a row of this client's own any more. So the fold sections, the `voice-row-heard`/
 * `voice-row-delivering` marker reads and the "the caption row goes once the message shows" readings
 * were deleted with the row they described.
 *
 * AND WHAT CHANGED AGAIN (`gap-voice-close-trace-row-removed-from-transcript`, 2026-10-14). The close
 * trace — `appendVoiceCloseTrace` and the line it appended ("Live Voice closed before N of your words
 * reached the screen.") — is REMOVED by human ruling: it counted caption segments while calling them
 * words, it kept saying the words had not arrived after they had been re-homed into the composer
 * draft, and it hung at the bottom of the transcript after the mode was left. The builder and its two
 * readings (the rendered line, the builder's mode-independence) went with it. `closedUnshown` and its
 * `voiceLog` client record STAY (they are diagnostics and other hook stubs read the field).
 *
 * WHAT REMAINS, AND IS STILL LOAD-BEARING. A connection can close on words that never reached the
 * screen, and this file keeps the readings that say so: the shared "is this delivery's message
 * visible yet" predicate (`deliveryIsShown`, now used by the close count), `countUnshownUtterances`
 * (how many utterances were lost at close, and the client record the hook writes), and
 * `undeliveredUtteranceRows` (a refused utterance is a countable row of its own). No assertion was
 * turned into a tautology to keep the file green — the trace readings were deleted with the row.
 *
 * The browser half — the same close reading taken off a real page against a fake upstream — is in
 * `e2e/voice-realtime-upload-fixture.spec.ts`. The fan-in suite (`scripts/test.sh`) does NOT run
 * Playwright, so that half is this task's own evidence.
 *
 * Run: npm run test:client -- src/modules/chat/voice-realtime/tests/voiceCaptionShownState.test.tsx
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  countUnshownUtterances,
  deliveryIsShown,
  undeliveredUtteranceRows,
  useVoiceRealtimeSession,
  type VoiceRealtimeCaption,
  type VoiceRealtimeDelivery,
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

// ── the fake wire and audio source the hook half drives (the voiceDeliveryState harness) ────────

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
const openHook = (contextMessages?: readonly ChatMessage[]) => {
  const hook = renderHook(() => useVoiceRealtimeSession({ sessionId: 'sess-1', contextMessages }));
  act(() => hook.result.current.start());
  act(() => socket().receive({ type: 'state', state: 'open' }));
  return hook;
};

// ── the fixtures ───────────────────────────────────────────────────────────────────────────────

/** What the recogniser heard. */
const HEARD = '把 server 的日志贴出来';

/** What the relay sent — deliberately a different string, so "shown" cannot be read off the caption. */
const DELIVERED = 'paste the server logs into the thread';

const caption = (overrides: Partial<VoiceRealtimeCaption> = {}): VoiceRealtimeCaption => ({
  itemId: 'a',
  text: HEARD,
  final: true,
  at: 1_000,
  ...overrides,
});

/** A delivery the proxy confirmed (the `sent` frame's record), carrying the utterance it took over. */
const deliveryOf = (overrides: Partial<VoiceRealtimeDelivery> = {}): VoiceRealtimeDelivery => ({
  message: DELIVERED,
  at: 2_000,
  heard: [HEARD],
  itemIds: ['a'],
  ...overrides,
});

/** The real transcript row the delivery becomes, once it is visible. */
const shownRow = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  type: 'user',
  content: DELIVERED,
  timestamp: 2_100,
  ...overrides,
});

const createDiff = (): DiffLine[] => [];
const renderRow = (message: ChatMessage): HTMLElement => {
  const { container } = render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" />
    </UiPreferencesProvider>,
  );
  return container;
};

// ── the removal key: "the delivery's message is visible", read off the shared predicate ─────────

test('deliveryIsShown is the one rule a real row is judged by', () => {
  // The shared predicate, read directly. A real user row carrying the delivered words IS the shown
  // message; nothing visible, or a row carrying the same words from far enough before the delivery
  // that it cannot be the row this delivery became, is not.
  assert.equal(deliveryIsShown(deliveryOf(), [shownRow()]), true);
  assert.equal(deliveryIsShown(deliveryOf(), []), false);
  // The stale-words reading: the person said this same sentence an hour ago, so a real user row with
  // the identical text exists — but it predates the delivery by far more than the clock skew the
  // predicate tolerates, so it must not be read as this delivery's message. (An earlier version of
  // this file read a `voice-caption-` row here; that row kind is gone, so the same words-one-hour-ago
  // row is what still exercises the time bound.)
  assert.equal(
    deliveryIsShown(deliveryOf(), [{ type: 'user', content: DELIVERED, timestamp: deliveryOf().at - 60 * 60 * 1000 }]),
    false,
    'a row carrying the same words from an hour before the delivery is not the delivered message',
  );
  // Non-vacuity: the time bound is a bound, not a blanket false — the same words just inside the
  // skew ARE read as the delivery's message. Without this the assertion above would pass even if the
  // predicate returned false for every candidate.
  assert.equal(
    deliveryIsShown(deliveryOf(), [{ type: 'user', content: DELIVERED, timestamp: deliveryOf().at - 1_000 }]),
    true,
    'words stamped within the clock skew are still the delivered message',
  );
});

// ── the close count and its client record (the trace LINE is removed) ───────────────────────────

const voiceLogLines = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((call) => String(call[0]));

describe('a connection that closes with unshown words counts them and writes a client record', () => {
  test('unshown utterance at close: closedUnshown > 0 and one client record', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const hook = openHook();
      act(() => socket().receive({ type: 'caption', itemId: 'a', text: HEARD, final: true }));
      // `sent` arrives — accepted — but no transcript row for it exists in contextMessages.
      act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: DELIVERED }));
      act(() => socket().close());

      expect(hook.result.current.closedUnshown).toBeGreaterThan(0);
      expect(
        voiceLogLines(info).some((line) => line.includes('unshown utterance')),
        `no client record of the loss was written: ${JSON.stringify(voiceLogLines(info))}`,
      ).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  test('negative control — everything shown at close: closedUnshown is 0 and no record', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      // The delivered message IS in the transcript this connection was given, so nothing is lost.
      // Its timestamp is `now`, like a message that really landed beside the `sent` frame — the
      // shared matcher bounds a candidate row in time, so a stale fixture far in the past would not
      // be read as this delivery's message at all.
      const hook = openHook([shownRow({ timestamp: Date.now() })]);
      act(() => socket().receive({ type: 'caption', itemId: 'a', text: HEARD, final: true }));
      act(() => socket().receive({ type: 'sent', sessionId: 'sess-1', result: {}, message: DELIVERED }));
      act(() => socket().close());

      expect(hook.result.current.closedUnshown).toBe(0);
      expect(voiceLogLines(info).some((line) => line.includes('unshown utterance'))).toBe(false);
    } finally {
      info.mockRestore();
    }
  });

  test('countUnshownUtterances counts both a final caption no shown delivery took over and a silent segment', () => {
    // A final caption, a recorded delivery that never showed: one lost utterance.
    expect(countUnshownUtterances([caption()], [deliveryOf()], [])).toBe(1);
    // The same, once the message is visible: none.
    expect(countUnshownUtterances([caption()], [deliveryOf()], [shownRow()])).toBe(0);
    // Segments handed to the relay that produced no caption at all: the gap is the loss.
    expect(countUnshownUtterances([], [], [], 2)).toBe(2);
    // An interim-only caption is not yet a spoken utterance the model heard — it is not counted as lost.
    expect(countUnshownUtterances([caption({ final: false })], [], [])).toBe(0);
  });
});

// ── a refused utterance is a countable line of its own ──────────────────────────────────────────

const UNDELIVERED_MARKER = 'voice-row-undelivered';

describe('a refused utterance is a row of its own, marked undelivered', () => {
  test('2 refused utterances ⇒ 2 marked rows', () => {
    const captions = [caption({ itemId: 'a' }), caption({ itemId: 'b', text: '第二句没有发出去' })];
    const refused = ['a', 'b'];

    const rows = undeliveredUtteranceRows(captions, refused, []);
    assert.equal(rows.length, 2, 'each refused utterance must be its own row');
    assert.deepEqual(
      rows.map((row) => row.content),
      [HEARD, '第二句没有发出去'],
      'each row carries the words that did not go, in the order they were said',
    );
    assert.equal(
      rows.every((row) => row.voiceRowState === 'undelivered'),
      true,
      'every refused row must carry the undelivered marker state',
    );

    // Rendered, each row shows the marker: the count is 2, one per refused sentence. THE reading the
    // criterion names — not "some of this did not go", but exactly how many.
    let marked = 0;
    for (const row of rows) {
      marked += renderRow(row).querySelectorAll(`[data-testid="${UNDELIVERED_MARKER}"]`).length;
    }
    assert.equal(marked, 2, 'two refused sentences must render as exactly two undelivered rows');
  });

  test('negative control — once every refused utterance is delivered, the marker count is 0', () => {
    const captions = [caption({ itemId: 'a' }), caption({ itemId: 'b', text: '第二句没有发出去' })];
    // The refusal is spent: a later delivery carried both utterances, so none are marked undelivered.
    assert.equal(
      undeliveredUtteranceRows(captions, [], []).length,
      0,
      'with everything delivered there are no undelivered rows to build',
    );
    // And a refused utterance whose words a real message already carries is not undelivered after all.
    const withReal = [shownRow({ content: HEARD })];
    assert.equal(
      undeliveredUtteranceRows([caption({ itemId: 'a' })], ['a'], withReal).length,
      0,
      'the words are on a real message, so the refusal is not shown twice',
    );
  });
});
