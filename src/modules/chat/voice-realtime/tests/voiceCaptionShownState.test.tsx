/**
 * AC (this task) — Live Voice caption words leave the screen only once the REAL message is visible.
 *
 * THE CLAIM. `foldCaptionsIntoTranscriptRow` used to drop every utterance any recorded delivery
 * claimed, and a delivery is recorded on the `sent` frame — the moment the CONTROL SERVICE accepted
 * the instruction, which is well before the session's transcript shows the message. In the CLI's own
 * queue window (the delivery is accepted but the message is not a row yet) the person's words were
 * deleted off the screen with nothing to replace them, irreversibly. The removal key is now the
 * message being VISIBLE, judged by the same rule `markDeliveredVoiceMessages` marks a row by.
 *
 * WHY THIS FILE, AND WHY THE FIRST ASSERTION IS THE FALSIFYING ONE. The criterion that names this
 * file runs it as the ONLY filter, so a green run is a reading of THIS file and nothing else. Its
 * first assertion takes the falsifying shape — a delivery is recorded and its real message is NOT in
 * `visibleMessages` — so the one reading that a broken (unconditional) fold fails is the first thing
 * the run reports. On the pre-fix code that assertion fails: the fold returns `null`, not the words.
 *
 * The browser half — the same reading taken off a real page against a fake upstream, where the
 * message appears a run later — is in `e2e/voice-realtime-upload-fixture.spec.ts`. The fan-in suite
 * (`scripts/test.sh`) does NOT run Playwright, so that half is this task's own evidence.
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
  foldCaptionsIntoTranscriptRow,
  markDeliveredVoiceMessages,
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

/** What the recogniser heard — the words the row must keep on screen until the delivery shows. */
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

const IN_FLIGHT_TESTIDS = ['voice-row-heard', 'voice-row-delivering'];

const createDiff = (): DiffLine[] => [];
const renderRow = (message: ChatMessage): HTMLElement => {
  const { container } = render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" />
    </UiPreferencesProvider>,
  );
  return container;
};

// ── AC1: the falsifying shape, FIRST ASSERTION IN THE FILE ──────────────────────────────────────
//
// A delivery is recorded (as if `sent` had just arrived) and its real message is NOT in
// `visibleMessages`. The removal key is "the message is visible", so the words MUST still be on the
// row. On the pre-fix code the fold claimed the delivery unconditionally and returned `null` here:
// this single reading is the whole defect, and it is the first thing the criterion run reports.

test('a delivery recorded but not yet visible leaves its words on the row', () => {
  const folded = foldCaptionsIntoTranscriptRow([caption()], [deliveryOf()], []);
  // THE reading the criterion names: the folded text still carries what was just said.
  assert.equal(
    folded?.content,
    HEARD,
    'the words were removed before the real message was on screen — the fold claimed a delivery whose message is not visible',
  );
  // And it still reads as in flight, not as a settled `heard` row (its words are on their way).
  assert.equal(folded?.voiceRowState, 'delivering');
  assert.equal(folded?.id, 'voice-caption-a');
});

test('deliveryIsShown is the one rule: a caption row never counts as its own delivery', () => {
  // The shared predicate, read directly. A real user row carrying the delivered words IS the shown
  // message; a row whose words merely match but which is a provisional caption row is not.
  assert.equal(deliveryIsShown(deliveryOf(), [shownRow()]), true);
  assert.equal(deliveryIsShown(deliveryOf(), []), false);
  assert.equal(
    deliveryIsShown(deliveryOf(), [{ type: 'user', content: DELIVERED, timestamp: 2_100, id: 'voice-caption-a' }]),
    false,
    'a provisional caption row must not be taken for the delivered message',
  );
});

// ── AC2: the negative control — once visible, removed, and NOT double-displayed ─────────────────

describe('once the real message is visible the caption row goes, with no double display', () => {
  test('the fold claims the utterance, and the transcript shows exactly one real user row', () => {
    const captions = [caption()];
    const deliveries = [deliveryOf()];
    const visible = [shownRow()];

    // The fold: the delivery is visible, so its utterance is claimed and there is no provisional row.
    const folded = foldCaptionsIntoTranscriptRow(captions, deliveries, visible);
    assert.equal(folded, null, 'a shown delivery must remove the caption row it replaces');

    // The real row is marked as spoken, and the caption row it replaced is dropped: one row, not two.
    const marked = markDeliveredVoiceMessages(visible, folded ? [folded] : [], deliveries);
    assert.equal(marked.captionRows.length, 0);
    const userRows = marked.messages.filter((message) => message.type === 'user');
    assert.equal(userRows.length, 1, 'the delivered message must appear once, not as a caption and a message');
    assert.deepEqual(userRows[0]!.voiceTranscript, { heard: [HEARD] });
  });

  test('the fold only claims when the message is visible, whatever the caption count', () => {
    // Three utterances, one shown delivery carrying two of them: the third is still in flight.
    const captions = [caption({ itemId: 'a' }), caption({ itemId: 'b' }), caption({ itemId: 'c', text: '第三句。' })];
    const deliveries = [deliveryOf({ itemIds: ['a', 'b'] })];
    const row = foldCaptionsIntoTranscriptRow(captions, deliveries, [shownRow()]);
    assert.equal(row?.content, '第三句。');
    assert.equal(row?.id, 'voice-caption-c');
  });
});

// ── AC3: the two observable surfaces are mutually exclusive, no new testid ──────────────────────

describe('the in-flight row and the delivered row are told apart by the delivered surfaces alone', () => {
  test('accepted-but-unshown: the row carries the in-flight marker and NOT the spoken badge', () => {
    const row = foldCaptionsIntoTranscriptRow([caption()], [deliveryOf()], [])!;
    const container = renderRow(row);
    assert.ok(
      container.querySelector('[data-testid="voice-row-delivering"]'),
      'an accepted-but-unshown row must carry the delivering marker',
    );
    assert.equal(
      container.querySelector('[data-testid="voice-transcript-badge"]'),
      null,
      'the words are not the real message yet, so the spoken badge must not be present',
    );
  });

  test('shown: no in-flight marker anywhere, and the real row carries the spoken badge', () => {
    // The caption row is claimed away, so the transcript renders the real message — which must carry
    // the badge and NEITHER delivery-state marker.
    const container = renderRow(shownRow({ voiceTranscript: { heard: [HEARD] } }));
    for (const testid of IN_FLIGHT_TESTIDS) {
      assert.equal(
        container.querySelector(`[data-testid="${testid}"]`),
        null,
        `the shown message must not carry ${testid}`,
      );
    }
    assert.ok(
      container.querySelector('[data-testid="voice-transcript-badge"]'),
      'the shown message must carry the spoken badge',
    );
  });
});

// ── AC4: the close trace ────────────────────────────────────────────────────────────────────────

const TRACE_TESTID = 'voice-closed-unshown-utterance';

const voiceLogLines = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((call) => String(call[0]));

describe('a connection that closes with unshown words leaves a visible trace and a client record', () => {
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

  test('the trace renders as a visible line, and its testid count is 0 when nothing was lost', () => {
    const lost = renderRow({ type: 'system', content: '', timestamp: 1_000, voiceClosedUnshown: 2 });
    assert.ok(lost.querySelector(`[data-testid="${TRACE_TESTID}"]`), 'the close trace must be visible');
    assert.equal(lost.querySelector(`[data-testid="${TRACE_TESTID}"]`)!.getAttribute('data-voice-closed-unshown'), '2');
    assert.equal(
      lost.querySelectorAll('[data-testid="voice-row-delivering"]').length,
      0,
      'the trace is a line of its own, not a caption row',
    );

    // Negative control: the pane builds no such row when nothing was lost, so its count is 0.
    const quiet = renderRow({ type: 'system', content: '', timestamp: 1_000 });
    assert.equal(quiet.querySelectorAll(`[data-testid="${TRACE_TESTID}"]`).length, 0);
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

// ── AC6 (this task): a refused utterance is a countable line of its own ──────────────────────────
//
// The relay refuses a delivery when the session's undelivered backlog is over its byte budget; the
// words never reach Claude. They must not vanish, and must not hide behind the one provisional row —
// "two sentences did not go" has to be a reading, not an inference. Each refused utterance therefore
// gets a row of its own carrying the `undelivered` marker, and the fold is told to keep those words
// OUT of the row that is still being spoken.

const UNDELIVERED_MARKER = 'voice-row-undelivered';

describe('a refused utterance is a row of its own, marked undelivered', () => {
  test('2 refused utterances ⇒ 2 marked rows, and the fold leaves them out of the spoken row', () => {
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

    // And the fold keeps them out of the one spoken row entirely (they are not being spoken, not heard
    // and not on their way): with only refused captions left, there is no provisional row at all.
    assert.equal(
      foldCaptionsIntoTranscriptRow(captions, [], [], false, refused),
      null,
      'a refused utterance must not fold back into the row that is still being spoken',
    );
  });

  test('negative control — once every refused utterance is delivered, the marker count is 0', () => {
    const captions = [caption({ itemId: 'a' }), caption({ itemId: 'b', text: '第二句没有发出去' })];
    // The refusal is spent: a later delivery carried both utterances, so none are marked undelivered.
    assert.equal(
      undeliveredUtteranceRows(captions, [], []).length,
      0,
      'with everything delivered there are no undelivered rows to build',
    );
    // The fold is then free to show them as the row being spoken/heard, with no undelivered marker.
    const folded = foldCaptionsIntoTranscriptRow(captions, [], [], false, []);
    assert.equal(folded?.voiceRowState === 'undelivered', false);
    const rendered = renderRow(folded!);
    assert.equal(rendered.querySelectorAll(`[data-testid="${UNDELIVERED_MARKER}"]`).length, 0);
  });
});
