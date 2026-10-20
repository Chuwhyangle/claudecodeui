/**
 * The transcript's drawn scrollbar geometry, estimated in pixels.
 *
 * A browser's scrollbar draws a thumb whose length is
 * `trackHeight * viewportHeight / contentHeight` and whose position is the
 * fraction of the content already scrolled past. The transcript cannot read
 * `scrollHeight` for that: the loaded window is only a slice of the
 * conversation, and rows that are not currently mounted hold a fixed
 * placeholder (100px) that is not their real height. This module models the
 * whole conversation in pixels instead — measured rows contribute their real
 * height, every other message contributes the running average
 * `pxPerMessage` — so the thumb keeps a browser-faithful length and a position
 * in the conversation, not in the loaded window.
 *
 * Every function here is pure; the DOM readings that feed them (which rows are
 * measured, the window's opening ordinal, the track's height) are the caller's.
 * Its live consumer is `ChatMessagesPane`, which through `nextPxPerMessage`
 * sizes a never-measured row's placeholder with the transcript's running
 * average so a jump is not centred against a flat constant. Unit-tested directly.
 */

/** Placeholder px per message before any row has been measured — bootstrap only. */
export const DEFAULT_ROW_HEIGHT_PX = 100;

/** How much an estimate must move before the drawn geometry is rebuilt, in CSS pixels. */
export const ESTIMATE_DEADZONE_PX = 1;

/**
 * One loaded row of the transcript, as the model needs it.
 *
 * `measured` is true only when the row's real height is currently knowable —
 * a mounted row, or one whose height was captured before it unmounted to a
 * placeholder. A row that has never been measured must not contribute its
 * 100px placeholder; it contributes `messages * pxPerMessage` instead.
 */
export type ContentRowInput = {
  /** How many messages the row stands for; a collapsed work segment counts all of its members. */
  messages: number;
  /** True when the row's real height is knowable. */
  measured: boolean;
  /** The row's real height in CSS pixels, read only when `measured`. */
  height: number;
};

/** The estimated pixel geometry of the loaded window and the conversation it sits in. */
export type ContentEstimate = {
  /** Each loaded row's estimated height, in content order. */
  rowHeights: number[];
  /** Cumulative estimated height before each row; length `rowHeights.length + 1`, starts at 0. */
  prefix: number[];
  /** Estimated height of the loaded window's rows alone. */
  windowHeight: number;
  /** Estimated height of the whole conversation, the unloaded parts included. */
  estimatedTotal: number;
};

/** A position inside the loaded window's estimated pixel space. */
export type AboveTarget = {
  /** The loaded row the position falls in. */
  rowIndex: number;
  /** How far into that row, 0..1, the position sits. */
  ratio: number;
};

/** Clamps a number into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The estimated pixel geometry for the loaded window and the conversation it is a
 * slice of.
 *
 * `messagesBeforeWindow` and `messagesAfterWindow` are the conversation's own
 * messages the loaded window does not hold; each contributes `pxPerMessage`, so
 * the estimate spans the whole conversation even though only one window is in the
 * DOM. `pxPerMessage` must be positive to be meaningful; a non-positive value
 * estimates zero, which the caller should never pass once any row is measured
 * (see `nextPxPerMessage`).
 */
export function estimateContent(input: {
  rows: readonly ContentRowInput[];
  messagesBeforeWindow: number;
  messagesAfterWindow: number;
  pxPerMessage: number;
}): ContentEstimate {
  const perMessage = input.pxPerMessage > 0 ? input.pxPerMessage : 0;
  const rowHeights = input.rows.map((row) =>
    row.measured && row.height > 0
      ? row.height
      : Math.max(0, row.messages) * perMessage,
  );
  const prefix = [0];
  for (const height of rowHeights) {
    prefix.push(prefix[prefix.length - 1] + height);
  }
  const windowHeight = prefix[prefix.length - 1];
  const before = Math.max(0, input.messagesBeforeWindow) * perMessage;
  const after = Math.max(0, input.messagesAfterWindow) * perMessage;
  return { rowHeights, prefix, windowHeight, estimatedTotal: before + windowHeight + after };
}

/**
 * The estimated distance from the conversation's top to a position inside the
 * loaded window, given the row it falls in and how far into that row.
 *
 * `rowIndex` may equal `rowHeights.length`, which is the window's end.
 */
export function estimateAbove(estimate: ContentEstimate, rowIndex: number, ratio: number): number {
  const index = clamp(Math.trunc(rowIndex), 0, estimate.rowHeights.length);
  const base = estimate.prefix[index] ?? estimate.windowHeight;
  const height = estimate.rowHeights[index] ?? 0;
  return base + clamp(ratio, 0, 1) * height;
}

/**
 * The loaded row a position in the window's estimated space falls in, and how far
 * into it — the inverse of `estimateAbove` for a position inside the window.
 *
 * A position past the window's end lands on its last row at ratio 1.
 */
export function rowAtAbove(estimate: ContentEstimate, above: number): AboveTarget {
  const count = estimate.rowHeights.length;
  if (count === 0 || estimate.windowHeight <= 0) return { rowIndex: 0, ratio: 0 };
  const target = clamp(above, 0, estimate.windowHeight);
  // The prefix is strictly increasing, so the owning row is found by binary
  // search: a pointer frame must not scan the loaded window.
  let lo = 0;
  let hi = estimate.prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimate.prefix[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  const rowIndex = Math.min(lo, count - 1);
  const height = estimate.rowHeights[rowIndex];
  const ratio = height > 0 ? clamp((target - estimate.prefix[rowIndex]) / height, 0, 1) : 0;
  return { rowIndex, ratio };
}

/**
 * The thumb's fraction of its travel for a pixel distance already scrolled past:
 * `above / (estimatedTotal - viewportHeight)`, clamped to `[0, 1]`.
 *
 * The denominator is the scrollable range, so a position at the conversation's
 * head reads 0 and one at its tail reads 1. When the content fits there is
 * nothing to scroll, and the reading is 0.
 */
export function fractionAtAbove(above: number, estimatedTotal: number, viewportHeight: number): number {
  const travel = estimatedTotal - viewportHeight;
  if (travel <= 0) return 0;
  return clamp(above / travel, 0, 1);
}

/** The scrollable offset a thumb fraction names — the inverse of `fractionAtAbove`. */
export function aboveForFraction(fraction: number, estimatedTotal: number, viewportHeight: number): number {
  const travel = Math.max(0, estimatedTotal - viewportHeight);
  return clamp(fraction, 0, 1) * travel;
}

/**
 * The thumb's drawn height, by the browser's own rule:
 * `max(minThumbPx, trackHeight * viewportHeight / estimatedTotal)`.
 *
 * There is no upper cap beyond the track itself: a conversation the viewport can
 * hold draws a thumb that fills the track (and is hidden with it). A
 * conversation far taller than the viewport floors at `minThumbPx` so it stays
 * grabbable. `minThumbPx` is the shared `TRANSCRIPT_SCROLLBAR_MIN_THUMB_PX`,
 * passed in rather than duplicated here.
 */
export function thumbHeightPx(
  estimatedTotal: number,
  viewportHeight: number,
  trackHeight: number,
  minThumbPx: number,
): number {
  if (trackHeight <= 0 || estimatedTotal <= 0) return minThumbPx;
  const raw = (trackHeight * viewportHeight) / estimatedTotal;
  return Math.round(Math.max(minThumbPx, raw));
}

/**
 * The next running average px per message, moved slowly toward the measured
 * rows' own average.
 *
 * Only rows whose real height is known contribute — a 100px placeholder is not a
 * measurement. A slow exponential move (`alpha`) keeps a single unusually tall
 * row from stepping the estimate, so the drawn length does not jump as the window
 * scrolls. The previous value is kept when nothing is measurable; it bootstraps
 * to `DEFAULT_ROW_HEIGHT_PX` when there is no previous value either.
 */
export function nextPxPerMessage(
  previous: number,
  rows: readonly ContentRowInput[],
  alpha = 0.25,
): number {
  let measuredHeight = 0;
  let measuredMessages = 0;
  for (const row of rows) {
    if (row.measured && row.height > 0 && row.messages > 0) {
      measuredHeight += row.height;
      measuredMessages += row.messages;
    }
  }
  if (measuredMessages <= 0) {
    return previous > 0 ? previous : DEFAULT_ROW_HEIGHT_PX;
  }
  const sample = measuredHeight / measuredMessages;
  if (!(previous > 0)) return sample;
  return previous + clamp(alpha, 0, 1) * (sample - previous);
}

/** The estimate facts whose changes decide whether the drawn geometry is rebuilt. */
export type EstimateState = {
  /** The whole conversation's estimated height. */
  estimatedTotal: number;
  /** The loaded window's estimated height. */
  windowHeight: number;
  /** The running average px per message. */
  pxPerMessage: number;
  /** The conversation's own message count. */
  totalMessages: number;
  /** The scroll container's drawn height. */
  viewportHeight: number;
  /**
   * A cheap identity of the loaded row set — its length and its two ends. A
   * window swap can leave every number above unchanged (a uniform fixture's
   * estimate is the same for any window) while every row element is replaced, and
   * the drawn geometry holds references to those elements; the row set itself
   * therefore has to be part of what triggers a rebuild.
   */
  rowSetKey: string;
};

/**
 * Whether a freshly computed estimate should replace the drawn one.
 *
 * The estimate is rebuilt only when something it is built from has moved: the
 * loaded row set, the conversation's message count, the viewport height, the
 * running px-per-message, or the estimate itself by more than `deadzonePx`.
 *
 * A gesture that holds the thumb (`frozen`) suppresses a rebuild so the numbers
 * cannot move under the pointer — but a *new row set* still wins: a jump or a
 * drag reads a new window, and the drawn geometry holds references to the old
 * window's elements, so refusing that rebuild would leave the position reading
 * detached nodes. The drawn *length* is held separately (a snapshot taken when
 * the gesture began), so a window swap underneath a drag cannot change it.
 */
export function shouldUpdateEstimate(
  previous: EstimateState | null,
  next: EstimateState,
  frozen: boolean,
  deadzonePx: number = ESTIMATE_DEADZONE_PX,
): boolean {
  if (!previous) return true;
  if (previous.rowSetKey !== next.rowSetKey) return true;
  if (frozen) return false;
  if (previous.totalMessages !== next.totalMessages) return true;
  if (Math.abs(previous.viewportHeight - next.viewportHeight) > 0.5) return true;
  if (Math.abs(previous.pxPerMessage - next.pxPerMessage) > 0.5) return true;
  return Math.abs(previous.estimatedTotal - next.estimatedTotal) > deadzonePx;
}
