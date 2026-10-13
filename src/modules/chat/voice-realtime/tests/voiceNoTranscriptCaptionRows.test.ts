/**
 * AC1/AC2 (this task, `gap-live-voice-remove-transcript-caption-rows`) — the chat area carries no
 * transcript bubble of the person's own, and the rows that state a REAL problem are still there.
 *
 * THE CLAIM, in the two halves the criterion states.
 *
 *   AC1 — NOTHING THE PERSON SAID IS A ROW OF THIS CLIENT'S OWN. Under every reading the pane's row
 *   algebra is handed — an interim caption, a final one with nothing on its way, one while the proxy
 *   holds it in its coalescing window, one the proxy accepted but whose real message has not landed,
 *   and the reading where the real message HAS landed — the number of caption rows is 0 and the
 *   number of `heard`/`delivering` rows is 0. The bottom voice bar shows the live transcript text;
 *   the chat area shows the person's words only as the real message the model relayed.
 *
 *   AC2 — THE HONEST ROWS ARE STILL THERE. "No caption rows" must not be bought by emptying the
 *   whole path: a refused utterance is still exactly one `undelivered` row, a segment with no
 *   transcript is still one row per segment, a graded LOST segment is still one row, and the real
 *   message a delivery became is still marked with what the recogniser heard. Each half prints its
 *   own counts (see the `console.log` lines), so the zero above is read beside a non-zero here.
 *
 * WHY THE INPUTS AND NOT THE DOM. `voiceTranscriptRows` is the ONE entry point every row of the Live
 * Voice transcript comes through (`ChatInterface` calls this and nothing else), so a reading of it is
 * a reading of what the pane can put on screen. The browser half of the same claim — the bar's
 * caption line carries the words while the chat area holds no node with them — is taken off a real
 * page in `e2e/voice-realtime-upload-fixture.spec.ts`.
 *
 * Run: npx vitest run src/modules/chat/voice-realtime/tests/voiceNoTranscriptCaptionRows.test.ts
 */

import { describe, expect, test } from 'vitest';

import { voiceTranscriptRows } from '@/modules/chat/voice-realtime';
import type { VoiceRealtimeCaption, VoiceRealtimeDelivery } from '@/modules/chat/voice-realtime';
import type { ChatMessage, VoiceRealtimeSegmentOutcome } from '@/shared/types';

/** What the recogniser heard. */
const HEARD = '把 server 的日志贴出来';
/** What the relay sent — deliberately different, so "delivered" cannot be read off the caption text. */
const DELIVERED = 'paste the server logs into the thread';
/** A second utterance, refused by the proxy (the AC2 positive control). */
const REFUSED = '第二句话没有发出去';

const caption = (overrides: Partial<VoiceRealtimeCaption> = {}): VoiceRealtimeCaption => ({
  itemId: 'a',
  text: HEARD,
  final: true,
  at: 1_000,
  seq: 0,
  ...overrides,
});

/** A delivery the proxy confirmed (the `sent` frame's record). */
const delivery = (overrides: Partial<VoiceRealtimeDelivery> = {}): VoiceRealtimeDelivery => ({
  message: DELIVERED,
  at: 2_000,
  heard: [HEARD],
  itemIds: ['a'],
  ...overrides,
});

/** The real transcript row the delivery becomes, once it is VISIBLE. */
const shownRow = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  type: 'user',
  content: DELIVERED,
  timestamp: 2_100,
  ...overrides,
});

const SEED: ChatMessage = { type: 'user', content: 'earlier turn', timestamp: '2026-10-13T00:00:00.000Z' };

/**
 * The row kind this task removed: a row of the person's own words. Read off the RUNTIME value rather
 * than the type, because the point is that no such row comes out of the algebra — a cast keeps the
 * two removed states readable even though the type no longer admits them.
 */
const removedState = (row: ChatMessage): string | undefined => row.voiceRowState as string | undefined;
const isRemovedCaptionRow = (row: ChatMessage): boolean =>
  (typeof row.id === 'string' && row.id.startsWith('voice-caption-')) ||
  removedState(row) === 'heard' ||
  removedState(row) === 'delivering';

/** The two numbers AC1 is stated over, printed for every reading below. */
const printCaptionRowReading = (name: string, rows: readonly ChatMessage[]): void => {
  const captionRows = rows.filter(isRemovedCaptionRow).length;
  const heardOrDeliveringRows = rows.filter((row) => {
    const state = removedState(row);
    return state === 'heard' || state === 'delivering';
  }).length;
  console.log(`[caption-rows] ${name}: captionRows=${captionRows} heardOrDeliveringRows=${heardOrDeliveringRows}`);
  expect(captionRows, `${name} must put no transcript bubble in the chat area`).toBe(0);
  expect(heardOrDeliveringRows, `${name} must put no heard/delivering row in the chat area`).toBe(0);
  expect(
    rows.filter(isRemovedCaptionRow).map((row) => row.id ?? '(no id)'),
    `${name} must carry no row id of the removed kind`,
  ).toEqual([]);
};

type Reading = { name: string; input: Parameters<typeof voiceTranscriptRows>[0] };

/**
 * The five readings, in the order the criterion names them. The third is the proxy's coalescing
 * window (`delivering`): that window used to be an ARGUMENT to this function and a state on the row
 * it stamped; since this task it is not an input at all — the hook's `delivering` flag is the
 * connection's own timeline and nothing on screen — which is why its input is the second utterance's
 * finals with nothing on their way. A distinct utterance keeps it an independent reading rather than
 * a repeat of the second.
 */
const READINGS: readonly Reading[] = [
  {
    name: 'only an interim caption',
    input: { captions: [caption({ text: '把 server', final: false, seq: null })], deliveries: [], visibleMessages: [] },
  },
  {
    name: 'one final caption, no delivery',
    input: { captions: [caption()], deliveries: [], visibleMessages: [] },
  },
  {
    name: 'a final caption while the proxy holds it in its window',
    input: {
      captions: [caption({ itemId: 'w', text: '这一段还在合并窗口里。' })],
      deliveries: [],
      visibleMessages: [],
    },
  },
  {
    name: 'a delivery the proxy accepted, its real message not visible yet',
    input: { captions: [caption()], deliveries: [delivery()], visibleMessages: [] },
  },
  {
    name: 'the delivered real message is visible',
    input: { captions: [caption()], deliveries: [delivery()], visibleMessages: [SEED, shownRow()] },
  },
];

describe('AC1 — no reading of the row algebra yields a transcript bubble', () => {
  for (const reading of READINGS) {
    test(reading.name, () => {
      printCaptionRowReading(reading.name, voiceTranscriptRows(reading.input));
    });
  }

  test('the readings are not all empty: the delivered one carries the real message, and no other does', () => {
    // Non-vacuity for the whole group: four of the five readings produce NOTHING at all (the person's
    // words live in the bottom voice bar and in the composer), and the fifth produces exactly the one
    // real message. If every reading produced no rows the group would still be green and say nothing.
    const produced = READINGS.map((reading) => voiceTranscriptRows(reading.input).length);
    expect(produced).toEqual([0, 0, 0, 0, 2]);
    const delivered = voiceTranscriptRows(READINGS[4]!.input);
    expect(delivered.map((row) => row.content)).toEqual([SEED.content, DELIVERED]);
  });
});

describe('AC2 — the honest rows and the spoken mark survive', () => {
  test('a refused utterance, a silent segment, a lost segment, and the marked real row', () => {
    const captions = [
      caption({ itemId: 'a', text: HEARD, seq: 0 }),
      caption({ itemId: 'b', text: REFUSED, seq: 1 }),
    ];
    const deliveries = [delivery({ itemIds: ['a'], message: DELIVERED, heard: [HEARD] })];
    const outcomes: readonly VoiceRealtimeSegmentOutcome[] = [{ seq: 4, state: 'lost', reason: 'upstream-drop' }];

    const rows = voiceTranscriptRows({
      captions,
      deliveries,
      visibleMessages: [SEED, shownRow()],
      undeliveredItemIds: ['b'],
      unrecognizedSeqs: [2, 3],
      segmentOutcomes: outcomes,
    });

    const undeliveredRows = rows.filter((row) => removedState(row) === 'undelivered');
    const unrecognizedRows = rows.filter((row) => typeof row.voiceUnrecognizedSeq === 'number');
    const outcomeRows = rows.filter((row) => row.voiceSegmentOutcome !== undefined);
    const markedRealRows = rows.filter((row) => row.voiceTranscript !== undefined);

    console.log(
      `[honest-rows] undeliveredRows=${undeliveredRows.length} unrecognizedRows=${unrecognizedRows.length} ` +
        `outcomeRows=${outcomeRows.length} markedRealRows=${markedRealRows.length}`,
    );

    expect(undeliveredRows).toHaveLength(1);
    expect(undeliveredRows[0]!.content).toBe(REFUSED);
    expect(unrecognizedRows.map((row) => row.voiceUnrecognizedSeq)).toEqual([2, 3]);
    expect(outcomeRows.map((row) => row.voiceSegmentOutcome)).toEqual([
      { seq: 4, state: 'lost', reason: 'upstream-drop' },
    ]);
    expect(markedRealRows).toHaveLength(1);
    expect(markedRealRows[0]!.content).toBe(DELIVERED);
    expect(markedRealRows[0]!.voiceTranscript).toEqual({ heard: [HEARD] });

    // ...and the same reading is still free of the row kind this task removed.
    printCaptionRowReading('the AC2 positive control', rows);
  });

  test('the positive controls are not vacuous: each honest row needs its own input', () => {
    // The same captions and deliveries, with NO honest input: every honest count drops to 0 while the
    // marked real row stays. A row read off the wrong switch would survive this comparison.
    const rows = voiceTranscriptRows({
      captions: [caption({ itemId: 'a', text: HEARD, seq: 0 })],
      deliveries: [delivery({ itemIds: ['a'], message: DELIVERED, heard: [HEARD] })],
      visibleMessages: [SEED, shownRow()],
    });
    expect(rows.filter((row) => removedState(row) === 'undelivered')).toHaveLength(0);
    expect(rows.filter((row) => typeof row.voiceUnrecognizedSeq === 'number')).toHaveLength(0);
    expect(rows.filter((row) => row.voiceSegmentOutcome !== undefined)).toHaveLength(0);
    expect(rows.filter((row) => row.voiceTranscript !== undefined)).toHaveLength(1);
  });
});
