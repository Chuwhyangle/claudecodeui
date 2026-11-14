/**
 * `createGraphGestureController` — the architecture canvas's gesture rules,
 * exercised without React and without a live drawing.
 *
 * The readings the criterion names:
 * - a marquee drag suppresses exactly ONE trailing click, while a Shift+press
 *   that never travelled stays an ordinary click;
 * - the marquee rectangle follows the pointer in canvas coordinates and the
 *   release reports the drawn set the injected hit test answered;
 * - Shift/Ctrl/Cmd or the touch multi-select mode make a click additive;
 * - a coarse pointer sends the press through the enlarged node hit test, and a
 *   fine pointer never does;
 * - `setHandlers` replaces the slots, so the old callbacks are not called;
 * - dispose ignores every later event.
 */
import { describe, expect, it } from 'vitest';

import { createGraphGestureController } from '@/modules/architecture/dom/interaction/graphGestureController';
import type { ArchitectureSelection } from '@/modules/architecture/dom/interaction/selectionModel';

/** A press shape the controller accepts; defaults are a fine-pointer drag. */
function press(overrides: Partial<Parameters<ReturnType<typeof createGraphGestureController>['pointerDown']>[0]> = {}) {
  return {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    shiftKey: true,
    clientX: 10,
    clientY: 20,
    ...overrides,
  };
}

function move(pointerId: number, clientX: number, clientY: number) {
  return { pointerId, clientX, clientY };
}

function mounted(options: Parameters<typeof createGraphGestureController>[0] = {}) {
  return createGraphGestureController(options);
}

describe('createGraphGestureController', () => {
  it('suppresses exactly one click after a marquee drag', () => {
    const controller = mounted();

    expect(controller.pointerDown(press())).toBe(true);
    controller.pointerMove(move(1, 120, 80));

    expect(controller.pointerUp(move(1, 120, 80))).toBe(true);
    expect(controller.consumeSuppressedClick()).toBe(true);
    // Only the click the browser sends after THIS gesture is suppressed.
    expect(controller.consumeSuppressedClick()).toBe(false);
  });

  it('keeps a Shift+press that never travelled an ordinary click', () => {
    const controller = mounted();

    controller.pointerDown(press({ clientX: 10, clientY: 20 }));
    controller.pointerUp(move(1, 11, 21));

    expect(controller.consumeSuppressedClick()).toBe(false);
  });

  it('reports the marquee rectangle in canvas coordinates as the pointer moves', () => {
    const controller = mounted({ canvasOrigin: () => ({ left: 100, top: 50 }) });

    controller.pointerDown(press({ clientX: 120, clientY: 70 }));

    expect(controller.getSnapshot().marquee).toEqual({ left: 20, top: 20, width: 0, height: 0 });

    controller.pointerMove(move(1, 220, 130));

    // A rectangle dragged up-left is normalised, and the origin is removed so
    // the overlay (positioned inside the canvas) lands over the same pixels.
    expect(controller.getSnapshot().marquee).toEqual({ left: 20, top: 20, width: 100, height: 60 });

    controller.pointerUp(move(1, 220, 130));
    expect(controller.getSnapshot().marquee).toBe(null);
  });

  it('reports the hit set of the marquee on release through the injected hit test', () => {
    const boxes: { left: number; top: number; right: number; bottom: number }[] = [];
    const selections: readonly ArchitectureSelection[] = [
      { kind: 'entity', nodeId: 'node-a' },
      { kind: 'relation', from: 'node-a', to: 'node-b', relationType: 'uses' },
    ];
    const controller = mounted({
      boxHitTest: (box) => {
        boxes.push(box);
        return selections;
      },
    });
    const reported: (readonly ArchitectureSelection[])[] = [];
    controller.setHandlers({ onBoxSelect: (hits) => reported.push(hits) });

    controller.pointerDown(press({ clientX: 0, clientY: 0 }));
    controller.pointerMove(move(1, 200, 150));
    controller.pointerUp(move(1, 200, 150));

    expect(boxes).toEqual([{ left: 0, top: 0, right: 200, bottom: 150 }]);
    expect(reported).toEqual([selections]);
  });

  it('makes a click additive on Shift/Ctrl/Cmd or while multi-select mode is on', () => {
    const controller = mounted();
    const plain = { shiftKey: false, ctrlKey: false, metaKey: false };

    expect(controller.isAdditiveClick(plain)).toBe(false);
    expect(controller.isAdditiveClick({ ...plain, shiftKey: true })).toBe(true);
    expect(controller.isAdditiveClick({ ...plain, ctrlKey: true })).toBe(true);
    expect(controller.isAdditiveClick({ ...plain, metaKey: true })).toBe(true);

    controller.setMultiSelectMode(true);
    expect(controller.isAdditiveClick(plain)).toBe(true);
    controller.setMultiSelectMode(false);
    expect(controller.isAdditiveClick(plain)).toBe(false);
  });

  it('resolves a coarse press through the enlarged node hit test only', () => {
    const calls: { clientX: number; clientY: number }[] = [];
    const controller = mounted({
      nodeHitTest: (clientX, clientY) => {
        calls.push({ clientX, clientY });
        return 'node-a';
      },
    });

    // A fine pointer keeps the visible shape: the 44px targets are not consulted.
    expect(controller.resolveCoarseNodeHit(12, 34)).toBe(null);
    expect(calls).toEqual([]);

    controller.setCoarsePointer(true);
    expect(controller.resolveCoarseNodeHit(12, 34)).toBe('node-a');
    expect(calls).toEqual([{ clientX: 12, clientY: 34 }]);
    expect(controller.isCoarsePointer()).toBe(true);
  });

  it('replaces the callback slots in one write', () => {
    const controller = mounted();
    const oldCalls: string[] = [];
    const newCalls: string[] = [];
    controller.setHandlers({ onBoxSelect: () => oldCalls.push('old'), onNodeHover: () => oldCalls.push('old-hover') });

    controller.setHandlers({ onBoxSelect: () => newCalls.push('new') });

    // Listeners read the slots at fire time, so the replaced callback survives
    // the listeners that were registered while the old one was installed.
    expect(controller.getHandlers().onNodeHover).toBe(undefined);
    controller.pointerDown(press({ clientX: 0, clientY: 0 }));
    controller.pointerMove(move(1, 60, 60));
    controller.pointerUp(move(1, 60, 60));

    expect(oldCalls).toEqual([]);
    expect(newCalls).toEqual(['new']);
  });

  it('suppresses the trailing click when the touch long-press starts multi-select', () => {
    const controller = mounted();
    const started: string[] = [];
    controller.setHandlers({ onMultiSelectStart: (node) => started.push(node.id) });

    expect(controller.startMultiSelect({ id: 'node-a', label: 'Alpha', distance: 0 })).toBe(true);
    expect(started).toEqual(['node-a']);
    expect(controller.consumeSuppressedClick()).toBe(true);

    // Without a handler the canvas keeps its curation-menu path.
    controller.setHandlers({});
    expect(controller.startMultiSelect({ id: 'node-b', label: 'Beta', distance: 0 })).toBe(false);
  });

  it('ignores every event after dispose', () => {
    const controller = mounted();
    let notifications = 0;
    let callbacks = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    controller.setHandlers({ onBoxSelect: () => callbacks += 1 });

    controller.pointerDown(press({ clientX: 0, clientY: 0 }));
    controller.pointerMove(move(1, 80, 80));
    expect(notifications).toBeGreaterThan(0);

    controller.dispose();
    const notificationsAtDispose = notifications;
    const snapshotAtDispose = controller.getSnapshot();
    expect(controller.pointerDown(press({ clientX: 0, clientY: 0 }))).toBe(false);
    controller.pointerMove(move(1, 200, 200));
    controller.pointerUp(move(1, 200, 200));

    expect(notifications).toBe(notificationsAtDispose);
    expect(callbacks).toBe(0);
    // The snapshot it held at dispose is frozen: no event reaches it again.
    expect(controller.getSnapshot()).toBe(snapshotAtDispose);
  });
});
