/**
 * `createArchitectureChromeController` — the architecture tab's open/close
 * rules, exercised without React, `window` or a wall clock.
 *
 * What the criterion names:
 * - an explicit (Text door) open is distinguishable from a selection-driven
 *   one, and only the latter closes with an emptied selection;
 * - open/close requests inside the layout-lock window are merged into one
 *   window, which releases on its own timeout;
 * - the coarse drawer's height is clamped into the viewport;
 * - the one-off touch hint stays dismissed across a controller remount;
 * - `dispose` releases the layout-lock timer.
 */
import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  createArchitectureChromeController,
  DOCK_LAYOUT_LOCK_MS,
  type ArchitectureChromePersistence,
  type ArchitectureChromeViewport,
} from '@/modules/architecture/render/viewport/architectureChromeController';
import type { Clock } from '@/shared/types';

type Timer = {
  handle: number;
  callback: () => void;
  due: number;
};

/**
 * A deterministic clock: timers fire only when `advance` moves past them, and
 * `pending()` reports how many are still armed (what `dispose` must clear).
 */
function createFakeClock(): {
  clock: Clock;
  advance: (milliseconds: number) => Promise<void>;
  pending: () => number;
} {
  let now = 1_000_000;
  let nextHandle = 1;
  const timers = new Map<number, Timer>();

  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, milliseconds) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { handle, callback, due: now + milliseconds });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    setInterval: () => {
      throw new Error('the chrome controller must not need an interval');
    },
    clearInterval: () => {},
  };

  const flush = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };

  const advance = async (milliseconds: number): Promise<void> => {
    const target = now + milliseconds;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of timers.values()) {
        if (timer.due <= target && (next === undefined || timer.due < next.due)) next = timer;
      }
      if (next === undefined) break;
      now = next.due;
      timers.delete(next.handle);
      next.callback();
      await flush();
    }
    now = target;
    await flush();
  };

  return { clock, advance, pending: () => timers.size };
}

/** The two remembered choices, in memory. */
function createMemoryPersistence(initial: {
  touchHintDismissed?: boolean;
  readoutExpanded?: boolean;
} = {}): ArchitectureChromePersistence & {
  readonly touchHintDismissed: () => boolean;
  readonly readoutExpanded: () => boolean;
} {
  let touchHintDismissed = initial.touchHintDismissed ?? false;
  let readoutExpanded = initial.readoutExpanded ?? false;
  return {
    readTouchHintDismissed: () => touchHintDismissed,
    persistTouchHintDismissed: () => {
      touchHintDismissed = true;
    },
    readReadoutExpanded: () => readoutExpanded,
    persistReadoutExpanded: (open) => {
      readoutExpanded = open;
    },
    touchHintDismissed: () => touchHintDismissed,
    readoutExpanded: () => readoutExpanded,
  };
}

function createViewport(height = 800, portraitPhone = false): ArchitectureChromeViewport & {
  readonly setHeight: (next: number) => void;
  readonly setPortrait: (next: boolean) => void;
} {
  let currentHeight = height;
  let portrait = portraitPhone;
  return {
    height: () => currentHeight,
    portraitPhone: () => portrait,
    setHeight: (next) => {
      currentHeight = next;
    },
    setPortrait: (next) => {
      portrait = next;
    },
  };
}

describe('createArchitectureChromeController', () => {
  it('distinguishes an explicit open from a selection-driven one', () => {
    const { clock } = createFakeClock();
    const chrome = createArchitectureChromeController({ clock });

    // The Text door: the reader opened it themselves, on the text page.
    chrome.openDock({ explicit: true, tab: 'text' });
    assert.equal(chrome.getSnapshot().dockOpen, true);
    assert.equal(chrome.getSnapshot().dockExplicitlyOpened, true);
    assert.equal(chrome.getSnapshot().dockTab, 'text');

    // An emptied selection must NOT close a dock the reader opened.
    chrome.selectionChanged(false);
    assert.equal(chrome.getSnapshot().dockOpen, true, 'an explicit open survives an empty selection');

    // Closing drops the licence; a later selection open is auto, on inspector.
    chrome.closeDock();
    assert.equal(chrome.getSnapshot().dockOpen, false);
    assert.equal(chrome.getSnapshot().dockExplicitlyOpened, false);

    chrome.selectionChanged(true);
    assert.equal(chrome.getSnapshot().dockOpen, true, 'a selection opens the dock');
    assert.equal(chrome.getSnapshot().dockExplicitlyOpened, false);
    assert.equal(chrome.getSnapshot().dockTab, 'inspector', 'a selection lands on the inspector page');

    // An auto-opened dock closes as soon as its selection empties.
    chrome.selectionChanged(false);
    assert.equal(chrome.getSnapshot().dockOpen, false, 'an auto-open closes with the empty selection');
  });

  it('merges open/close requests inside one layout-lock window', async () => {
    const { clock, advance } = createFakeClock();
    const chrome = createArchitectureChromeController({ clock });

    chrome.openDock();
    assert.equal(chrome.getSnapshot().dockLayoutLocked, true, 'opening freezes the aspect re-layout');

    await advance(100);
    // A second gesture inside the window replaces the deadline instead of
    // leaving the first timer to release the lock under the newer change.
    chrome.closeDock();
    assert.equal(chrome.getSnapshot().dockLayoutLocked, true);

    await advance(100);
    assert.equal(
      chrome.getSnapshot().dockLayoutLocked,
      true,
      'the merged window ends at the LAST gesture, not the first',
    );

    await advance(DOCK_LAYOUT_LOCK_MS - 100);
    assert.equal(chrome.getSnapshot().dockLayoutLocked, false, 'the window releases on its timeout');
  });

  it('clamps the coarse drawer height into the viewport', () => {
    const { clock } = createFakeClock();
    const viewport = createViewport(800);
    const chrome = createArchitectureChromeController({ clock, viewport });

    chrome.setDrawerHeight(1200);
    assert.equal(chrome.getSnapshot().touchDrawerHeight, 800, 'a taller reading is clamped down');

    chrome.setDrawerHeight(-40);
    assert.equal(chrome.getSnapshot().touchDrawerHeight, 0, 'a negative reading is clamped up');

    chrome.setDrawerHeight(359.6);
    assert.equal(chrome.getSnapshot().touchDrawerHeight, 360, 'the painted pixel height is rounded');

    chrome.setDrawerHeight(Number.NaN);
    assert.equal(chrome.getSnapshot().touchDrawerHeight, 0, 'a missing viewport reading is 0, not NaN');
  });

  it('keeps the touch hint dismissed across a remount', () => {
    const { clock } = createFakeClock();
    const persistence = createMemoryPersistence();
    const first = createArchitectureChromeController({ clock, persistence });

    assert.equal(first.getSnapshot().touchHintDismissed, false);
    first.dismissTouchHint();
    assert.equal(first.getSnapshot().touchHintDismissed, true);
    assert.equal(persistence.touchHintDismissed(), true, 'the dismissal is remembered');

    const second = createArchitectureChromeController({ clock, persistence });
    assert.equal(second.getSnapshot().touchHintDismissed, true, 'the bubble must not return on remount');
  });

  it('remembers the portrait readout expansion only where the tier has a height budget', () => {
    const { clock } = createFakeClock();
    const persistence = createMemoryPersistence({ readoutExpanded: true });
    const viewport = createViewport(844, true);
    const chrome = createArchitectureChromeController({ clock, viewport, persistence });

    assert.equal(chrome.getSnapshot().readoutOpen, true, 'the portrait tier starts from the session choice');
    chrome.toggleReadout();
    assert.equal(chrome.getSnapshot().readoutOpen, false);
    assert.equal(persistence.readoutExpanded(), false, 'the change is written back');

    // A wide tier never persists: its readout is not behind a height budget.
    viewport.setPortrait(false);
    const wide = createArchitectureChromeController({
      clock,
      viewport,
      persistence: createMemoryPersistence(),
    });
    assert.equal(wide.getSnapshot().readoutOpen, false, 'a non-portrait tier starts collapsed');
    wide.toggleReadout();
    assert.equal(wide.getSnapshot().readoutOpen, true);
  });

  it('dispose clears the layout-lock timer', async () => {
    const { clock, advance, pending } = createFakeClock();
    const chrome = createArchitectureChromeController({ clock });

    chrome.openDock();
    assert.equal(pending(), 1, 'the open armed one lock timer');
    assert.equal(chrome.getSnapshot().dockLayoutLocked, true);

    chrome.dispose();
    assert.equal(pending(), 0, 'dispose releases the timer');

    await advance(DOCK_LAYOUT_LOCK_MS * 2);
    assert.equal(
      chrome.getSnapshot().dockLayoutLocked,
      true,
      'the cancelled callback never ran (commands stay usable; the timer is gone)',
    );
  });

  it('bumps the reveal token on every focus request and walks Escape outward', () => {
    const { clock } = createFakeClock();
    const chrome = createArchitectureChromeController({ clock });

    chrome.focusNode('node-a');
    chrome.focusNode('node-a', true);
    assert.equal(chrome.getSnapshot().focusTarget?.id, 'node-a');
    assert.equal(chrome.getSnapshot().focusTarget?.token, 2, 'the same node twice is its own request');
    assert.equal(chrome.getSnapshot().focusTarget?.drill, true);

    chrome.selectionChanged(true);
    chrome.setTrayExpanded(true);
    assert.equal(chrome.escapeSelection(), 'tray', 'Escape collapses the tray first');
    assert.equal(chrome.getSnapshot().trayExpanded, false);
    assert.equal(chrome.escapeSelection(), 'dock', 'then closes the dock');
    assert.equal(chrome.getSnapshot().dockOpen, false);
    assert.equal(chrome.escapeSelection(), 'selection', 'then leaves the selection to the panel');
  });
});
