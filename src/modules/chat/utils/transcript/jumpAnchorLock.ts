/**
 * The short correction window a transcript jump keeps open after it places its
 * target row.
 *
 * A jump can only measure the target once it is in the DOM, and the rows above
 * it are mostly placeholders: a row that has never been measured stands in for
 * its real content at an estimated height. The frame the jump writes its
 * `scrollTop` on is therefore a frame in which the target's position is still
 * provisional — the rows around it mount as the widened window commits, replace
 * their placeholders with real content, and push the target down the page. The
 * jump has already written its one offset by then, so without something watching
 * the row it lands on, it stays where that first estimate put it — below the
 * viewport, on a long conversation, which is exactly the failure this exists to
 * remove.
 *
 * So the jump hands its target here instead of ending. For
 * {@link JUMP_ANCHOR_WINDOW_MS} the row is re-read every animation frame, and
 * whenever it has drifted more than {@link JUMP_ANCHOR_TOLERANCE_PX} from the
 * centred position it is re-placed — through the caller's own
 * {@link JumpAnchorLockOptions.writeScrollTop}, so every write stays on the
 * transcript's single scroll channel and is not read back as a user gesture.
 *
 * The window is deliberately short and one-directional: it exists to absorb the
 * handful of frames a lazy window takes to settle, not to hold the viewport
 * against the user. It ends at once on any real input, on the timeout, or when
 * the row leaves the DOM (the window it belonged to was swapped out) — after
 * that the app never writes `scrollTop` again on the row's behalf.
 *
 * Used by `useChatSessionState`'s shared jump. The pure decision is
 * `jumpAnchorCorrection`, unit-tested directly; the controller is tested through
 * its injected frame scheduler.
 */

/** How long the jump keeps re-placing its target after the first write. */
export const JUMP_ANCHOR_WINDOW_MS = 600;

/**
 * How far the target may sit from the centred position before it is corrected.
 *
 * Two pixels rather than a fraction of the row: the drift this answers is the
 * placeholder-for-content swap, which moves the row by hundreds of pixels on a
 * long conversation, while the sub-pixel jitter of a settled layout is what the
 * tolerance is here to ignore.
 */
export const JUMP_ANCHOR_TOLERANCE_PX = 2;

/**
 * The scroll delta that re-centres the target row, or `null` when it is close
 * enough to leave alone. Pure: the caller reads both positions off the DOM.
 *
 * `currentTop` is the row's top relative to the container's top; `centeredTop`
 * is where that same edge would sit if the row were centred in the container.
 * A positive delta means the row has been pushed down and the viewport must move
 * down with it.
 */
export function jumpAnchorCorrection(
  currentTop: number,
  centeredTop: number,
  tolerancePx: number = JUMP_ANCHOR_TOLERANCE_PX,
): number | null {
  const delta = currentTop - centeredTop;
  return Math.abs(delta) > tolerancePx ? delta : null;
}

/** The window's lifetime and the app's own scroll writer; both are the caller's. */
export type JumpAnchorLockOptions = {
  /** Writes a scroll offset through the transcript's single scroll channel. */
  writeScrollTop: (container: HTMLElement, next: number) => void;
  /** Called once when the window closes, whatever closed it. */
  onEnd?: () => void;
  /** The frame scheduler; defaults to `requestAnimationFrame`. Injectable for tests. */
  requestFrame?: (callback: FrameRequestCallback) => number;
  /** Cancels a scheduled frame; defaults to `cancelAnimationFrame`. */
  cancelFrame?: (handle: number) => void;
  /** The clock the timeout is measured on; defaults to `performance.now`. */
  now?: () => number;
  /** Overrides {@link JUMP_ANCHOR_WINDOW_MS}. */
  windowMs?: number;
  /** Overrides {@link JUMP_ANCHOR_TOLERANCE_PX}. */
  tolerancePx?: number;
};

/** Starts, ends and reports a jump's correction window. */
export type JumpAnchorLock = {
  /** Opens the window on a container and the row the jump landed on. */
  start: (container: HTMLElement, element: HTMLElement) => void;
  /** Ends the window at once — a user gesture, a session change, a superseding jump. */
  release: () => void;
  /** True while the window is open. */
  isActive: () => boolean;
};

/**
 * Builds a jump's correction window.
 *
 * One lock serves one jump at a time: starting a new one abandons the previous
 * window without firing its `onEnd` a second time (the caller has already moved
 * on to the new jump). `release` is idempotent, so a user gesture arriving in
 * the same frame as the timeout cannot end the window twice.
 */
export function createJumpAnchorLock(options: JumpAnchorLockOptions): JumpAnchorLock {
  const requestFrame = options.requestFrame
    ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  const now = options.now ?? (() => performance.now());
  const windowMs = options.windowMs ?? JUMP_ANCHOR_WINDOW_MS;
  const tolerancePx = options.tolerancePx ?? JUMP_ANCHOR_TOLERANCE_PX;

  let active = false;
  let frame: number | null = null;
  let expiresAt = 0;
  let container: HTMLElement | null = null;
  let element: HTMLElement | null = null;

  const clearFrame = () => {
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
  };

  const end = () => {
    if (!active) return;
    active = false;
    clearFrame();
    container = null;
    element = null;
    options.onEnd?.();
  };

  const tick = () => {
    frame = null;
    if (!active || !container || !element) return;
    // The window this row belonged to may have been swapped out from under it —
    // a session change, a "back to latest", another read. A detached row has no
    // position to correct, and the jump that owned it is over.
    if (now() >= expiresAt || !element.isConnected) {
      end();
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const currentTop = elementRect.top - containerRect.top;
    const centeredTop = (container.clientHeight - elementRect.height) / 2;
    const delta = jumpAnchorCorrection(currentTop, centeredTop, tolerancePx);
    if (delta !== null) {
      const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
      const next = Math.max(0, Math.min(container.scrollTop + delta, maxTop));
      // A correction clamped back to the offset it is already at is not a
      // movement: writing it would raise no scroll report but would still spend
      // a programmatic-echo credit the next real gesture then reads against.
      if (Math.abs(next - container.scrollTop) > 0.5) {
        options.writeScrollTop(container, next);
      }
    }
    frame = requestFrame(tick);
  };

  return {
    start(nextContainer, nextElement) {
      // A superseding jump is not a window ending; it is this one being replaced.
      if (active) {
        active = false;
        clearFrame();
      }
      container = nextContainer;
      element = nextElement;
      expiresAt = now() + windowMs;
      active = true;
      frame = requestFrame(tick);
    },
    release: end,
    isActive: () => active,
  };
}
