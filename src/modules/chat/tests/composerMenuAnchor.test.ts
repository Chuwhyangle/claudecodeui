import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import type { ComposerMenuAnchor } from '@/shared/types';

/**
 * A phone-width composer popover used to paint past the screen edge. The surface is
 * a fixed portal whose whole position comes from `useComposerMenuAnchor`, and the
 * hook's clamp was defeated by its own lower bounds: `maxWidth` never went below
 * 200px even when the trigger sat mid-row with less than that to its left, and
 * `maxHeight` never went below 160px even when the trigger sat near the top of the
 * screen or the soft keyboard had shortened the visible area. The horizontal cases
 * below read every combination of viewport width and trigger position; the vertical
 * ones read a trigger pinned near the top and a `visualViewport` shorter than (and
 * offset from) `window.innerHeight`.
 *
 * The reading is the *box the hook guarantees*, derived from the anchor it returns:
 * with `right`/`bottom` anchoring and a `maxWidth`/`maxHeight` cap the rendered menu
 * can only be narrower and shorter than this box, and its right and bottom edges are
 * exactly these — so an edge that clears the margin here clears it for the real menu
 * too. jsdom lays nothing out, so this cannot read the painted pixels; the browser
 * probe is what does that.
 */

const VIEWPORT_MARGIN = 8;

const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

type Viewport = {
  width: number;
  height: number;
  /** Present only when the case is about the soft keyboard shrinking the visible area. */
  visualHeight?: number;
  visualTop?: number;
};

/**
 * Puts the window in the given state. The hook reads `window` at `updateAnchor()`
 * time, so a case installs this before it places the menu.
 */
const installViewport = ({ width, height, visualHeight, visualTop = 0 }: Viewport) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });

  if (visualHeight === undefined) {
    // No visual viewport: the hook must fall back to the layout window.
    if (originalVisualViewport) {
      Object.defineProperty(window, 'visualViewport', originalVisualViewport);
    } else {
      delete (window as { visualViewport?: unknown }).visualViewport;
    }
    return;
  }

  const double = {
    width,
    height: visualHeight,
    offsetTop: visualTop,
    offsetLeft: 0,
    pageTop: visualTop,
    pageLeft: 0,
    scale: 1,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  };
  Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: double });
};

/** A trigger 40px wide whose right edge is at `right`; only top/right decide the anchor. */
const triggerRect = (top: number, right: number) =>
  ({
    top,
    right,
    bottom: top + 40,
    left: right - 40,
    width: 40,
    height: 40,
    x: right - 40,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/** Stable across renders, as every shipping caller's `useCallback` closer is. */
const closeMenu = () => undefined;

/** Renders the hook open, hands it a trigger with this rect, and reads the anchor it computes. */
const placeMenu = (rect: { top: number; right: number }) => {
  const hook = renderHook(() => useComposerMenuAnchor(true, closeMenu));
  const trigger = document.createElement('button');
  trigger.getBoundingClientRect = () => triggerRect(rect.top, rect.right);
  hook.result.current.triggerRef.current = trigger;
  act(() => {
    hook.result.current.updateAnchor();
  });
  const anchor = hook.result.current.anchor;
  assert.ok(anchor, 'an open menu must be given an anchor');
  return { anchor, unmount: hook.unmount };
};

/**
 * The largest box the anchor permits, in viewport coordinates. Right and bottom are
 * exact; left and top are the extremes (a narrower or shorter menu moves them
 * inward), so "this box is inside the margins" is a guarantee about the menu.
 */
const anchorBox = (anchor: ComposerMenuAnchor) => {
  const right = window.innerWidth - anchor.right;
  const bottom = window.innerHeight - anchor.bottom;
  return {
    left: right - anchor.maxWidth,
    right,
    top: bottom - anchor.maxHeight,
    bottom,
  };
};

const readingsOf = (label: string, box: { left: number; right: number; top: number; bottom: number }) =>
  `${label}: [left ${box.left}, right ${box.right}] x [top ${box.top}, bottom ${box.bottom}]`;

/* ── horizontal: the width the menu may take is the width that fits ────────── */

const WIDTHS = [320, 390, 768];
const TRIGGER_POSITIONS = [
  { label: 'trigger flush with the right edge', right: (width: number) => width },
  { label: 'trigger mid viewport', right: (width: number) => Math.round(width / 2) },
  { label: 'trigger near the left edge', right: () => 80 },
];

test('(a) the menu box clears both horizontal margins at every viewport width and trigger position', () => {
  const readings: string[] = [];

  for (const width of WIDTHS) {
    for (const position of TRIGGER_POSITIONS) {
      installViewport({ width, height: 780 });
      const { anchor, unmount } = placeMenu({ top: 640, right: position.right(width) });
      const box = anchorBox(anchor);
      readings.push(readingsOf(`${width}px / ${position.label}`, box));

      assert.ok(
        box.left >= VIEWPORT_MARGIN,
        `the menu's left edge must clear the viewport margin; ${readingsOf(`${width}px / ${position.label}`, box)}`,
      );
      assert.ok(
        box.right <= width - VIEWPORT_MARGIN,
        `the menu's right edge must clear the viewport margin; ${readingsOf(`${width}px / ${position.label}`, box)}`,
      );

      unmount();
    }
  }
});

/* ── vertical: the height the menu may take is the height that is visible ──── */

test('(b) a trigger near the top of the screen opens a menu whose top edge stays on screen', () => {
  // 60px of trigger, minus the 8px gap, is 52px above it — far less than the old
  // 160px height floor, which used to send the top edge to y = -108.
  installViewport({ width: 390, height: 780 });
  const { anchor, unmount } = placeMenu({ top: 60, right: 380 });
  const box = anchorBox(anchor);

  assert.ok(
    box.top >= VIEWPORT_MARGIN,
    `the menu's top edge must clear the viewport margin; ${readingsOf('trigger at y=60', box)}`,
  );
  assert.ok(
    box.bottom <= 780 - VIEWPORT_MARGIN,
    `the menu's bottom edge must stay above the viewport bottom; ${readingsOf('trigger at y=60', box)}`,
  );

  unmount();
});

test('(c) a soft keyboard that shortens or pans the visual viewport keeps the menu inside it', () => {
  const readings: string[] = [];

  for (const visible of [
    { label: 'keyboard shortens the viewport', visualTop: 0, visualHeight: 460 },
    { label: 'keyboard pans the viewport', visualTop: 120, visualHeight: 440 },
  ]) {
    installViewport({ width: 390, height: 780, ...visible });
    // The trigger sits at the bottom of the *layout* window, which the keyboard has
    // covered: its 700px top is below the 460px/560px visible bottom.
    const { anchor, unmount } = placeMenu({ top: 700, right: 380 });
    const box = anchorBox(anchor);
    readings.push(readingsOf(visible.label, box));

    assert.ok(
      box.top >= visible.visualTop + VIEWPORT_MARGIN,
      `the menu's top edge must stay inside the visible area; ${readingsOf(visible.label, box)}`,
    );
    assert.ok(
      box.bottom <= visible.visualTop + visible.visualHeight - VIEWPORT_MARGIN,
      `the menu's bottom edge must stay above the keyboard; ${readingsOf(visible.label, box)}`,
    );

    unmount();
  }
});
