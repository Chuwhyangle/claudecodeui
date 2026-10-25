import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import InputOutlineDrawer from '@/modules/chat/outline/InputOutlineDrawer';

/**
 * A touch stream stays bound to the node it began on. The handle swaps its icon the moment a
 * drag starts, so an icon that is the touch target unmounts and later touchmove/touchend never
 * reach the document: the handle froze after one step and the body scroll lock was never released.
 * jsdom has no hit-testing, so the guard is that no icon can be a hit target, plus the
 * touchcancel release.
 */

const getHandle = (container: HTMLElement) => {
  const handle = container.querySelector<HTMLButtonElement>('[data-input-outline-handle]');
  assert.ok(handle, 'handle must render');
  return handle;
};

const touch = (clientY: number) => ({ touches: [{ clientX: 370, clientY }] });

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
});

afterEach(() => {
  document.body.removeAttribute('style');
});

test('every icon the handle can show ignores pointer hits, so the button stays the touch target', () => {
  const { container } = render(<InputOutlineDrawer entries={[]} isMobile onJump={() => {}} />);
  const handle = getHandle(container);

  const closedIcon = handle.querySelector('svg');
  assert.ok(closedIcon?.classList.contains('pointer-events-none'), 'chevron icon must not be hit-testable');

  fireEvent.touchStart(handle, touch(700));
  act(() => {
    fireEvent.touchMove(document, touch(600));
  });
  const draggingIcon = handle.querySelector('svg');
  assert.ok(draggingIcon?.classList.contains('pointer-events-none'), 'grip icon must not be hit-testable');
});

test('touchcancel ends the drag and releases the body scroll lock', () => {
  const { container } = render(<InputOutlineDrawer entries={[]} isMobile onJump={() => {}} />);
  const handle = getHandle(container);

  fireEvent.touchStart(handle, touch(700));
  act(() => {
    fireEvent.touchMove(document, touch(600));
  });
  assert.equal(document.body.style.position, 'fixed');

  act(() => {
    fireEvent.touchCancel(document);
  });
  assert.equal(document.body.style.position, '');
  assert.equal(document.body.style.overflow, '');
});
