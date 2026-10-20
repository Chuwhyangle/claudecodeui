import { describe, expect, it } from 'vitest';

import { DEFAULT_ROW_HEIGHT_PX, ESTIMATE_DEADZONE_PX, aboveForFraction, estimateAbove, estimateContent, fractionAtAbove, nextPxPerMessage, rowAtAbove, shouldUpdateEstimate, thumbHeightPx } from '@/modules/chat/utils/transcript/contentHeightModel';
import type { ContentRowInput, EstimateState } from '@/modules/chat/utils/transcript/contentHeightModel';
/** The minimum drawn thumb length these cases were written against. */
const TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX = 28;

/**
 * A row that has never been measured.
 *
 * Its element still occupies the real 100px placeholder (`LazyMessageRow`'s
 * `ESTIMATED_ROW_HEIGHT_PX`, which the transcript reads back as the row's
 * `offsetHeight`), so its `height` is that placeholder — not zero. It must
 * estimate by `messages * p` all the same: the `measured` flag, not `height > 0`,
 * is what separates a measurement from a placeholder. Modelling it with
 * `height: 0` would make the two indistinguishable and leave the guard untested.
 */
const unmeasured = (messages = 1): ContentRowInput => ({
  messages,
  measured: false,
  height: DEFAULT_ROW_HEIGHT_PX,
});

/** A row whose real height is known. */
const measured = (height: number, messages = 1): ContentRowInput => ({ messages, measured: true, height });

/** The measured fixture's own average: one short-conversation message, ~258px tall. */
const SHORT_PX_PER_MESSAGE = 258;

describe('estimateContent', () => {
  it('estimates the 24-message short conversation at about 6190px, by p not the 100px placeholder', () => {
    // The whole short fixture is one row per message and none of them has been
    // measured yet; the estimate must still span the real conversation.
    const rows = Array.from({ length: 24 }, () => unmeasured());
    const estimate = estimateContent({
      rows,
      messagesBeforeWindow: 0,
      messagesAfterWindow: 0,
      pxPerMessage: SHORT_PX_PER_MESSAGE,
    });
    expect(estimate.estimatedTotal).toBe(24 * SHORT_PX_PER_MESSAGE);
    expect(Math.abs(estimate.estimatedTotal - 6190)).toBeLessThanOrEqual(10);
    // The placeholder would have given 24 x 100 = 2400 — proof it is not used.
    expect(estimate.estimatedTotal).not.toBe(24 * DEFAULT_ROW_HEIGHT_PX);
  });

  it('adds the unloaded messages before and after the window, each by p', () => {
    const rows = [measured(200, 2), unmeasured(3)];
    const estimate = estimateContent({
      rows,
      messagesBeforeWindow: 10,
      messagesAfterWindow: 4,
      pxPerMessage: 50,
    });
    // Window: 200 + 3*50 = 350; outside: (10 + 4) * 50 = 700.
    expect(estimate.windowHeight).toBe(350);
    expect(estimate.estimatedTotal).toBe(350 + 700);
  });

  it('keeps the total within 5% when the loaded window is replaced by another of the same conversation', () => {
    const perMessage = 258;
    const totalMessages = 240;
    // Window A: 30 loaded rows, 10 measured, 210 unloaded after.
    const windowA = estimateContent({
      rows: [
        ...Array.from({ length: 10 }, () => measured(perMessage)),
        ...Array.from({ length: 20 }, () => unmeasured()),
      ],
      messagesBeforeWindow: 0,
      messagesAfterWindow: totalMessages - 30,
      pxPerMessage: perMessage,
    });
    // Window B: a different stretch, none measured yet, 100 before / 110 after.
    const windowB = estimateContent({
      rows: Array.from({ length: 30 }, () => unmeasured()),
      messagesBeforeWindow: 100,
      messagesAfterWindow: totalMessages - 130,
      pxPerMessage: perMessage,
    });
    const relative = Math.abs(windowA.estimatedTotal - windowB.estimatedTotal) / windowA.estimatedTotal;
    expect(relative).toBeLessThanOrEqual(0.05);
  });

  it('estimates zero for a non-positive p (the caller bootstraps before any measurement)', () => {
    const estimate = estimateContent({
      rows: [unmeasured(4)],
      messagesBeforeWindow: 5,
      messagesAfterWindow: 5,
      pxPerMessage: 0,
    });
    expect(estimate.estimatedTotal).toBe(0);
  });
});

describe('thumbHeightPx', () => {
  it('is max(28px, track x viewport / total), with no 25% cap', () => {
    // The 1280x4000 short-conversation reading: a tall pane against ~6192px of content.
    const height = thumbHeightPx(24 * SHORT_PX_PER_MESSAGE, 3_900, 3_868, TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX);
    expect(height).toBe(Math.round((3_868 * 3_900) / (24 * SHORT_PX_PER_MESSAGE)));
    // Over a quarter of the track — the old ceiling would have clamped it to 967.
    expect(height).toBeGreaterThan(3_868 * 0.25);
  });

  it('floors a very long conversation at the grabbable minimum', () => {
    // 4800 messages at ~53px is ~254,400px; 1200px of viewport over a 1168px track.
    const height = thumbHeightPx(4_800 * 53, 1_200, 1_168, TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX);
    expect(height).toBe(TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX);
  });

  it('fills the track when the conversation fits the viewport', () => {
    expect(thumbHeightPx(3_900, 3_900, 3_800, TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX)).toBe(3_800);
  });
});

describe('position and its inverse', () => {
  it('reads 0 at the head and 1 at the tail of the scrollable range', () => {
    expect(fractionAtAbove(0, 6_192, 3_900)).toBe(0);
    expect(fractionAtAbove(6_192 - 3_900, 6_192, 3_900)).toBe(1);
    expect(fractionAtAbove(0, 3_900, 3_900)).toBe(0);
  });

  it('round-trips a fraction through aboveForFraction', () => {
    for (const fraction of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
      const above = aboveForFraction(fraction, 6_192, 3_900);
      expect(fractionAtAbove(above, 6_192, 3_900)).toBeCloseTo(fraction, 9);
    }
  });

  it('places above inside the loaded window and inverts it back', () => {
    const rows = [measured(200), measured(300), unmeasured(2)];
    const estimate = estimateContent({
      rows,
      messagesBeforeWindow: 0,
      messagesAfterWindow: 0,
      pxPerMessage: 258,
    });
    // The third row is estimated at 2 x 258 = 516, not its placeholder.
    expect(estimate.rowHeights[2]).toBe(516);
    const above = estimateAbove(estimate, 1, 0.5);
    expect(above).toBe(200 + 0.5 * 300);
    expect(rowAtAbove(estimate, above)).toEqual({ rowIndex: 1, ratio: 0.5 });
  });

  it('clamps a position past the window end onto its last row', () => {
    const estimate = estimateContent({
      rows: [measured(200), measured(300)],
      messagesBeforeWindow: 0,
      messagesAfterWindow: 0,
      pxPerMessage: 258,
    });
    expect(rowAtAbove(estimate, 10_000)).toEqual({ rowIndex: 1, ratio: 1 });
    expect(rowAtAbove(estimate, -10)).toEqual({ rowIndex: 0, ratio: 0 });
  });
});

describe('nextPxPerMessage', () => {
  it('moves slowly toward the measured rows average', () => {
    // previous 258, measured sample 100 -> 258 + 0.25*(100-258) = 218.5.
    expect(nextPxPerMessage(258, [measured(100)])).toBeCloseTo(218.5, 6);
  });

  it('ignores unmeasured rows entirely', () => {
    // Only the measured 200 contributes; the unmeasured rows must not drag it to 100.
    expect(nextPxPerMessage(258, [measured(200), unmeasured(5), unmeasured(5)])).toBeCloseTo(258 + 0.25 * (200 - 258), 6);
  });

  it('bootstraps to the default before anything is measurable, then keeps its last value', () => {
    expect(nextPxPerMessage(0, [unmeasured(3)])).toBe(DEFAULT_ROW_HEIGHT_PX);
    expect(nextPxPerMessage(258, [unmeasured(3)])).toBe(258);
  });
});

describe('shouldUpdateEstimate', () => {
  const base: EstimateState = {
    estimatedTotal: 6_192,
    windowHeight: 6_192,
    pxPerMessage: SHORT_PX_PER_MESSAGE,
    totalMessages: 24,
    viewportHeight: 3_900,
    rowSetKey: '24:first|last',
  };

  it('always accepts the first estimate', () => {
    expect(shouldUpdateEstimate(null, base, false)).toBe(true);
  });

  it('freezes while a gesture holds the thumb, however far the estimate has moved', () => {
    const next: EstimateState = { ...base, estimatedTotal: 9_999, pxPerMessage: 400 };
    expect(shouldUpdateEstimate(base, next, true)).toBe(false);
  });

  it('accepts a new row set even when every number is unchanged — a window swap replaces the elements', () => {
    expect(shouldUpdateEstimate(base, { ...base, rowSetKey: '40:another|tipped' }, false)).toBe(true);
  });

  it('lets a window swap rebuild even while a gesture holds the thumb — the drawn length is snapshotted separately', () => {
    expect(shouldUpdateEstimate(base, { ...base, rowSetKey: '40:another|tipped' }, true)).toBe(true);
  });

  it('ignores a change under the deadzone and accepts one over it', () => {
    expect(shouldUpdateEstimate(base, { ...base, estimatedTotal: base.estimatedTotal + ESTIMATE_DEADZONE_PX }, false))
      .toBe(false);
    expect(shouldUpdateEstimate(base, { ...base, estimatedTotal: base.estimatedTotal + 40 }, false))
      .toBe(true);
  });

  it('accepts a new message count or viewport height outright', () => {
    expect(shouldUpdateEstimate(base, { ...base, totalMessages: 25 }, false)).toBe(true);
    expect(shouldUpdateEstimate(base, { ...base, viewportHeight: 4_000 }, false)).toBe(true);
    expect(shouldUpdateEstimate(base, { ...base, pxPerMessage: 300 }, false)).toBe(true);
  });
});
