/**
 * `createGraphSelectionController` — the architecture canvas's selection and
 * keyboard-navigation rules, exercised without React or a wall clock.
 *
 * The readings the criterion names:
 * - a plain selection sets the primary AND the drillable reading, while an
 *   additive (multi-select) click only moves the primary;
 * - clearing the selection clears both readings and the touch modality;
 * - moving the navigation cursor rewrites the cursor and the polite sentence,
 *   and only an entity (not a package frame) becomes the next entry point;
 * - the focus modality is one reading, switched by the pointer/keyboard
 *   listeners and read by the canvas focus handler;
 * - the double tap is measured on the injected clock;
 * - dispose stops every notification.
 */
import { describe, expect, it } from 'vitest';

import { createGraphSelectionController } from '@/modules/architecture/dom/interaction/graphSelectionController';
import { DOUBLE_TAP_MS } from '@/modules/architecture/dom/graphConstants';

/** A hand-driven clock: `now` only moves when the test moves it. */
function createFakeClock(start = 0): { clock: { now: () => number }; advance: (ms: number) => void } {
  let now = start;
  return {
    clock: { now: () => now },
    advance: (ms) => {
      now += ms;
    },
  };
}

function mountedController(): ReturnType<typeof createGraphSelectionController> {
  return createGraphSelectionController({ clock: createFakeClock().clock });
}

describe('createGraphSelectionController', () => {
  it('sets the primary and drillable selection on a plain click', () => {
    const controller = mountedController();

    controller.selectNode('node-a', false);

    expect(controller.getSnapshot()).toMatchObject({
      primaryNodeId: 'node-a',
      drillNodeId: 'node-a',
      selectedByTouch: false,
    });
  });

  it('keeps the drillable reading on an additive multi-select click', () => {
    const controller = mountedController();
    controller.selectNode('node-a', false);

    controller.addToSelection('node-b');

    // The multi-select gesture joins the panel's set; it is not a drill
    // request, so the "Drill in" reading stays on the first node.
    expect(controller.getSnapshot()).toMatchObject({
      primaryNodeId: 'node-b',
      drillNodeId: 'node-a',
    });
  });

  it('records whether the drillable selection came from a touch tap', () => {
    const controller = mountedController();

    controller.selectNode('node-a', true);

    expect(controller.getSnapshot().selectedByTouch).toBe(true);
  });

  it('clears the primary and drillable readings on a background click', () => {
    const controller = mountedController();
    controller.selectNode('node-a', true);

    controller.clearSelection();

    expect(controller.getSnapshot()).toMatchObject({
      primaryNodeId: null,
      drillNodeId: null,
      selectedByTouch: false,
    });
  });

  it('mirrors the panel selection and makes its node the primary reading', () => {
    const controller = mountedController();
    const relation = { from: 'a', to: 'b', relationType: 'uses' };

    controller.syncPanelSelection({
      nodeId: 'node-a',
      relation,
      nodeIds: ['node-a', 'node-b'],
      relations: [relation],
    });

    expect(controller.getSnapshot().panel).toEqual({
      nodeId: 'node-a',
      relation,
      nodeIds: ['node-a', 'node-b'],
      relations: [relation],
    });
    expect(controller.getSnapshot().primaryNodeId).toBe('node-a');
  });

  it('moves the navigation cursor and announces the landing', () => {
    const controller = mountedController();
    controller.enterNavigation('node-a', 'Alpha, class, 1/2');

    controller.moveNavigationCursor('node-b', 'Beta, class, 2/2', true);

    expect(controller.getSnapshot()).toMatchObject({
      navigationActive: true,
      navigationCursorId: 'node-b',
      navigationAnnouncement: 'Beta, class, 2/2',
      keyboardFocusId: 'node-b',
    });
  });

  it('does not remember a package frame as the next entry point', () => {
    const controller = mountedController();
    controller.enterNavigation('node-a', 'Alpha, class, 1/2');

    controller.moveNavigationCursor('package::modules', 'modules, package, 1/1', false);

    expect(controller.getSnapshot().navigationCursorId).toBe('package::modules');
    expect(controller.getSnapshot().keyboardFocusId).toBe('node-a');
  });

  it('leaving navigation clears the cursor and the announcement', () => {
    const controller = mountedController();
    controller.enterNavigation('node-a', 'Alpha, class, 1/2');

    controller.exitNavigation();

    expect(controller.getSnapshot()).toMatchObject({
      navigationActive: false,
      navigationCursorId: null,
      navigationAnnouncement: '',
      // The last entity stays remembered so the next entry lands there.
      keyboardFocusId: 'node-a',
    });
  });

  it('switches the focus modality between pointer and keyboard', () => {
    const controller = mountedController();
    expect(controller.getSnapshot().focusModality).toBe('keyboard');

    controller.setFocusModality('pointer');
    expect(controller.getSnapshot().focusModality).toBe('pointer');

    controller.setFocusModality('keyboard');
    expect(controller.getSnapshot().focusModality).toBe('keyboard');
  });

  it('reads the double tap on the injected clock', () => {
    const { clock, advance } = createFakeClock();
    const controller = createGraphSelectionController({ clock });

    expect(controller.registerTap('node-a')).toBe(false);
    advance(DOUBLE_TAP_MS - 1);
    expect(controller.registerTap('node-a')).toBe(true);
    // The completed double tap resets the window: the next tap starts over.
    expect(controller.registerTap('node-a')).toBe(false);

    advance(DOUBLE_TAP_MS + 1);
    expect(controller.registerTap('node-a')).toBe(false);
    expect(controller.registerTap('node-b')).toBe(false);
  });

  it('consumes the recorded pointer type once', () => {
    const controller = mountedController();

    controller.recordPointerType('touch');
    expect(controller.consumePointerType()).toBe('touch');
    expect(controller.consumePointerType()).toBe(null);
  });

  it('opens and closes the context menu', () => {
    const controller = mountedController();

    controller.openContextMenu({ x: 4, y: 6, nodeId: 'node-a' });
    expect(controller.getSnapshot().contextMenu).toEqual({ x: 4, y: 6, nodeId: 'node-a' });

    controller.closeContextMenu();
    expect(controller.getSnapshot().contextMenu).toBe(null);
  });

  it('stops notifying after dispose', () => {
    const controller = mountedController();
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });

    controller.selectNode('node-a', false);
    expect(notifications).toBe(1);

    controller.dispose();
    controller.selectNode('node-b', false);
    controller.enterNavigation('node-b', 'Beta, class, 1/1');
    expect(notifications).toBe(1);
  });
});
