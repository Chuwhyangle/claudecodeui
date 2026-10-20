import { afterEach, describe, expect, it, vi } from 'vitest';

import { JUMP_ANCHOR_TOLERANCE_PX, createJumpAnchorLock, jumpAnchorCorrection } from '@/modules/chat/utils/transcript/jumpAnchorLock';

/**
 * The frame scheduler the controller is driven by: nothing runs until the test
 * says so, so "corrected on the next frame" is a fact of the test rather than a
 * wait.
 */
class ManualFrames {
  private handles = new Map<number, FrameRequestCallback>();
  private nextHandle = 1;

  request = (callback: FrameRequestCallback): number => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.handles.set(handle, callback);
    return handle;
  };

  cancel = (handle: number): void => {
    this.handles.delete(handle);
  };

  /** Runs the oldest scheduled frame, if any. */
  runNext(): void {
    const entry = this.handles.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return;
    this.handles.delete(entry[0]);
    entry[1](0);
  }

  pending(): number {
    return this.handles.size;
  }
}

type Geometry = {
  /** The row's top relative to the container's top. */
  currentTop: number;
  /** The row's own height. */
  rowHeight: number;
  /** The container's drawn height. */
  clientHeight: number;
};

/** Appends a container and its row and pins the geometry both are read with. */
function mountRow(geometry: Geometry): { container: HTMLDivElement; row: HTMLDivElement } {
  const container = document.createElement('div');
  const row = document.createElement('div');
  container.appendChild(row);
  document.body.appendChild(container);

  const containerTop = 100;
  Object.defineProperty(container, 'clientHeight', { value: geometry.clientHeight, configurable: true });
  Object.defineProperty(container, 'scrollHeight', { value: 10_000, configurable: true });
  container.getBoundingClientRect = () => ({
    top: containerTop,
    bottom: containerTop + geometry.clientHeight,
    left: 0,
    right: 400,
    width: 400,
    height: geometry.clientHeight,
  }) as DOMRect;
  row.getBoundingClientRect = () => ({
    top: containerTop + geometry.currentTop,
    bottom: containerTop + geometry.currentTop + geometry.rowHeight,
    left: 0,
    right: 400,
    width: 400,
    height: geometry.rowHeight,
  }) as DOMRect;

  return { container, row };
}

/** The geometry that puts the row exactly in the middle of the container. */
const centredGeometry = (rowHeight = 200, clientHeight = 800): Geometry => ({
  currentTop: (clientHeight - rowHeight) / 2,
  rowHeight,
  clientHeight,
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('jumpAnchorCorrection', () => {
  it('corrects only when the target is more than the tolerance off centre', () => {
    // 10px below centre: the viewport must move down by 10.
    expect(jumpAnchorCorrection(410, 400)).toBe(10);
    // 2px is still "centred" — the tolerance is inclusive.
    expect(jumpAnchorCorrection(402, 400)).toBeNull();
    expect(jumpAnchorCorrection(398, 400)).toBeNull();
    // 3px is past it in either direction.
    expect(jumpAnchorCorrection(403, 400)).toBe(3);
    expect(jumpAnchorCorrection(397, 400)).toBe(-3);
    expect(jumpAnchorCorrection(0, 0)).toBeNull();
  });

  it('uses the module tolerance by default and honours an override', () => {
    expect(JUMP_ANCHOR_TOLERANCE_PX).toBe(2);
    expect(jumpAnchorCorrection(400 + JUMP_ANCHOR_TOLERANCE_PX + 0.5, 400)).toBe(JUMP_ANCHOR_TOLERANCE_PX + 0.5);
    expect(jumpAnchorCorrection(405, 400, 10)).toBeNull();
  });
});

describe('createJumpAnchorLock', () => {
  it('re-places a target that has drifted off centre, through the caller channel', () => {
    const frames = new ManualFrames();
    const writeScrollTop = vi.fn((container: HTMLElement, next: number) => {
      container.scrollTop = next;
    });
    const lock = createJumpAnchorLock({
      writeScrollTop,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });
    // The row has been pushed 120px below centre and the pane sits at 3000.
    const { container, row } = mountRow({ currentTop: 460, rowHeight: 200, clientHeight: 800 });
    container.scrollTop = 3000;

    lock.start(container, row);
    frames.runNext();

    expect(writeScrollTop).toHaveBeenCalledTimes(1);
    expect(writeScrollTop.mock.calls[0][0]).toBe(container);
    // centred is (800-200)/2 = 300; the row sits at 460, so the pane moves down by 160.
    expect(writeScrollTop.mock.calls[0][1]).toBe(3160);
    expect(lock.isActive()).toBe(true);
  });

  it('writes nothing while the target is within the tolerance', () => {
    const frames = new ManualFrames();
    const writeScrollTop = vi.fn();
    const lock = createJumpAnchorLock({
      writeScrollTop,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });
    const { container, row } = mountRow(centredGeometry());

    lock.start(container, row);
    frames.runNext();

    expect(writeScrollTop).not.toHaveBeenCalled();
    expect(lock.isActive()).toBe(true);
  });

  it('ends at once on a user input and never corrects after that', () => {
    const frames = new ManualFrames();
    const writeScrollTop = vi.fn();
    const onEnd = vi.fn();
    const lock = createJumpAnchorLock({
      writeScrollTop,
      onEnd,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });
    const { container, row } = mountRow({ currentTop: 460, rowHeight: 200, clientHeight: 800 });

    lock.start(container, row);
    // The gesture lands before the frame does.
    lock.release();
    expect(lock.isActive()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    // Even a frame that had already been scheduled writes nothing once released.
    frames.runNext();
    expect(writeScrollTop).not.toHaveBeenCalled();
    // A second release is a no-op — the end callback does not fire twice.
    lock.release();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ends on the timeout', () => {
    const frames = new ManualFrames();
    const writeScrollTop = vi.fn();
    const onEnd = vi.fn();
    let now = 1_000;
    const lock = createJumpAnchorLock({
      writeScrollTop,
      onEnd,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      now: () => now,
      windowMs: 600,
    });
    const { container, row } = mountRow({ currentTop: 460, rowHeight: 200, clientHeight: 800 });

    lock.start(container, row);
    // One frame inside the window still corrects.
    now = 1_400;
    frames.runNext();
    expect(writeScrollTop).toHaveBeenCalledTimes(1);

    // Past the deadline the window closes instead of correcting again.
    now = 1_700;
    frames.runNext();
    expect(writeScrollTop).toHaveBeenCalledTimes(1);
    expect(lock.isActive()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ends when the target row leaves the DOM', () => {
    const frames = new ManualFrames();
    const writeScrollTop = vi.fn();
    const onEnd = vi.fn();
    const lock = createJumpAnchorLock({
      writeScrollTop,
      onEnd,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });
    const { container, row } = mountRow({ currentTop: 460, rowHeight: 200, clientHeight: 800 });

    lock.start(container, row);
    row.remove();
    frames.runNext();

    expect(writeScrollTop).not.toHaveBeenCalled();
    expect(lock.isActive()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('replaces a previous window without ending it', () => {
    const frames = new ManualFrames();
    const writeScrollTop = vi.fn();
    const onEnd = vi.fn();
    const lock = createJumpAnchorLock({
      writeScrollTop,
      onEnd,
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    });
    const first = mountRow(centredGeometry());
    const second = mountRow({ currentTop: 700, rowHeight: 200, clientHeight: 800 });
    second.container.scrollTop = 500;

    lock.start(first.container, first.row);
    lock.start(second.container, second.row);
    // A supersede is not an end: the second jump has already taken over.
    expect(onEnd).not.toHaveBeenCalled();

    frames.runNext();
    expect(writeScrollTop).toHaveBeenCalledTimes(1);
    expect(writeScrollTop.mock.calls[0][0]).toBe(second.container);
    expect(writeScrollTop.mock.calls[0][1]).toBe(900);
  });
});
