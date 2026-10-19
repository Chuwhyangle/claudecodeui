import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * The transcript's scroll position is written from five places coordinated by
 * refs and timers rather than by one owner. These are the two cases where that
 * coordination was observably wrong; both are timing bugs, so they are driven
 * on fake timers rather than by clicking.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const buildMessage = (index: number, timestamp: string): NormalizedMessage => ({
  id: `m-${index}`,
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: SESSION_A,
  content: `message ${index}`,
  timestamp,
} as NormalizedMessage);

/**
 * jsdom has no layout, so scrollHeight/clientHeight are always 0 and assigning
 * scrollTop emits nothing. These are the exact reads the scroll code makes.
 */
function createContainer(scrollHeight: number, clientHeight: number) {
  const element = document.createElement('div');
  const writes: number[] = [];
  let scrollTop = scrollHeight - clientHeight;

  Object.defineProperty(element, 'scrollHeight', { get: () => scrollHeight });
  Object.defineProperty(element, 'clientHeight', { get: () => clientHeight });
  Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
      writes.push(next);
    },
  });

  return { element: element as HTMLDivElement, writes, scrollHeight };
}

/**
 * The same container, but with geometry that can change: the content-growth
 * follow is entirely about what happened between two layouts, so a fixture
 * whose scrollHeight is fixed could only ever observe the trivial case.
 */
function createResizableContainer(scrollHeight: number, clientHeight: number) {
  const element = document.createElement('div');
  const writes: number[] = [];
  let height = scrollHeight;
  let viewport = clientHeight;
  let top = scrollHeight - clientHeight;

  Object.defineProperty(element, 'scrollHeight', { get: () => height });
  Object.defineProperty(element, 'clientHeight', { get: () => viewport });
  Object.defineProperty(element, 'scrollTop', {
    get: () => top,
    set: (next: number) => {
      top = next;
      writes.push(next);
    },
  });

  return {
    element: element as HTMLDivElement,
    writes,
    /** The offset a pinned viewport sits at. */
    get bottom() {
      return height - viewport;
    },
    get scrollTop() {
      return top;
    },
    /** Grows the content the way a taller last row does — no row is added. */
    grow: (delta: number) => {
      height += delta;
    },
    /**
     * Shrinks the content the way a row above the viewport collapsing does. The
     * browser answers that by moving the offset itself, which is why the caller
     * follows it with `scrollTo` rather than letting the fixture do it.
     */
    shrink: (delta: number) => {
      height -= delta;
    },
    /**
     * Shrinks the pane itself — a software keyboard, a growing composer. Only the
     * container's box moves: the content keeps the height it had, and a pane that
     * got shorter needs no clamp, so the browser raises no `scroll` for it either.
     */
    shrinkPane: (delta: number) => {
      viewport -= delta;
    },
    /** Moves the viewport the way a gesture does. */
    scrollTo: (next: number) => {
      top = next;
    },
  };
}

/**
 * Stands in for the browser's ResizeObserver, which jsdom does not ship. The
 * spec drives it directly: `emit` is the notification the browser sends once
 * layout has settled after a change.
 */
class FakeResizeObserver {
  static latest: FakeResizeObserver | null = null;
  readonly observed: Element[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.latest = this;
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {}

  disconnect() {
    this.observed.length = 0;
  }

  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

/** Animation frames the follow deferred its write to; the spec runs them by hand. */
let pendingFrames: FrameRequestCallback[] = [];

function runFrames() {
  const frames = pendingFrames;
  pendingFrames = [];
  for (const frame of frames) {
    frame(0);
  }
}

function attachContentRef(
  ref: unknown,
  node: HTMLDivElement | null,
) {
  (ref as (target: HTMLDivElement | null) => void)(node);
}

function createStore(
  messagesBySession: Map<string, NormalizedMessage[]>,
  /** What the server says about the transcript's pagination, when a case needs an older page. */
  page: { hasMore?: boolean; prependCount?: number } = {},
) {
  // A hydrated slot, so the session-loading effect takes its early return
  // instead of re-fetching on every render.
  const slotFor = (sessionId: string) => ({
    fetchedAt: 1,
    status: 'idle' as const,
    total: messagesBySession.get(sessionId)?.length ?? 0,
    hasMore: page.hasMore ?? false,
    offset: messagesBySession.get(sessionId)?.length ?? 0,
  });

  return {
    fetchFromServer: vi.fn(async (sessionId: string) => slotFor(sessionId)),
    fetchMore: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId),
      prependedCount: page.prependCount ?? 0,
    })),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId),
      applied: true,
      changed: false,
      deferred: false,
    })),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn((sessionId: string) => messagesBySession.get(sessionId) ?? []),
    getSessionSlot: vi.fn((sessionId: string) => slotFor(sessionId)),
  };
}

async function renderChatSessionState(options: {
  session: ProjectSession;
  store: ReturnType<typeof createStore>;
}) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');

  return renderHook(
    ({ session }: { session: ProjectSession }) =>
      useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage: vi.fn(),
        resetStreamingState: vi.fn(),
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: options.store as never,
      }),
    { initialProps: { session: options.session } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // The initial-scroll effect is a separate writer that re-scrolls to the
  // bottom every animation frame until the height settles. It would satisfy an
  // assertion meant for the deferred timer, so it is silenced here — these
  // tests are about which writer wins, and it is not one of the two.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('deferred scroll-to-bottom', () => {
  it('does not yank the view back down when the user scrolls up inside the delay', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    // A new row lands while the user is at the bottom: a scroll is armed for +50ms.
    messages.set(SESSION_A, [
      ...messages.get(SESSION_A)!,
      buildMessage(1, '2026-01-01T00:00:01.000Z'),
    ]);
    act(() => {
      rerender({ session: { id: SESSION_A } as ProjectSession });
    });

    // ...and the user drags upward before it fires.
    act(() => {
      result.current.setIsUserScrolledUp(true);
    });
    container.writes.length = 0;

    act(() => {
      vi.advanceTimersByTime(200);
    });

    assert.deepEqual(
      container.writes,
      [],
      `a scroll armed before the user scrolled up must not fire afterwards; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('still sticks to the bottom when the user has not scrolled away', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    messages.set(SESSION_A, [
      ...messages.get(SESSION_A)!,
      buildMessage(1, '2026-01-01T00:00:01.000Z'),
    ]);
    act(() => {
      rerender({ session: { id: SESSION_A } as ProjectSession });
    });
    container.writes.length = 0;

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(container.writes).toContain(container.scrollHeight);
  });

  /**
   * The deferred half of the same bug, and the one the intent state cannot see.
   *
   * A scroll key moves the pane as its default action and the browser reports
   * the `scroll` a frame or more later, so a placement armed a moment earlier —
   * the composer's post-send pin is the one this exists for — still reads "the
   * user is following" at fire time, over a pane the user has already taken.
   * That write is the pull-back the criterion forbids, and it lands inside the
   * window a small gesture is asserting itself in. The offset the app itself
   * placed last is what survives the gap.
   */
  it('refuses a deferred placement once the pane has moved up, before any report says so', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    // The app puts the pane on the bottom and takes note of where that landed.
    act(() => {
      result.current.scrollToBottom();
    });
    assert.deepEqual(
      container.writes,
      [container.scrollHeight],
      'premise: the placement lands on the bottom',
    );

    // And it still fires while the pane is where it was left — the guard is not
    // a blanket refusal, which is what a send on an untouched pane relies on.
    container.writes.length = 0;
    act(() => {
      result.current.scrollToBottom();
    });
    assert.deepEqual(
      container.writes,
      [container.scrollHeight],
      'an untouched pane is still placed on the bottom',
    );

    // Now the pane moves up — as a key's default action does — and no `scroll`
    // has been delivered for it yet, so the mirrored intent still reads
    // "following" over a viewport that is no longer where the app put it. The
    // fixture has one counter for both, so the window opens after the movement:
    // in the browser this is the pane's own, and no JS write at all.
    container.element.scrollTop = container.scrollHeight - 30;
    assert.equal(
      result.current.isUserScrolledUp,
      false,
      'premise: the movement has not been reported yet, so the intent has not moved',
    );
    container.writes.length = 0;

    act(() => {
      result.current.scrollToBottom();
    });

    assert.deepEqual(
      container.writes,
      [],
      `a placement must not fire over a pane that has moved up since the app placed it; got ${JSON.stringify(container.writes)}`,
    );
  });

  /**
   * The clamp the browser makes when a turn settles is not the gesture the
   * offset guard exists to refuse. A settle shrinks the content — or grows the
   * pane — by a couple of pixels, and the browser clamps the offset down to that
   * new bottom, a `scroll` nobody caused. `lastPlacedTopRef` does not follow the
   * clamp, so the offset reads as "moved up" by exactly the few pixels the clamp
   * took — and the next send's placement was refused over a viewport that was
   * still at the bottom, leaving the new row and the whole reply below the fold.
   */
  it('still pins when a settle clamped the pane to a new bottom', async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages);
    const { result } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });

    const container = createContainer(5000, 500);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    // The app puts the pane on the bottom and takes note of where that landed.
    act(() => {
      result.current.scrollToBottom();
    });
    container.writes.length = 0;

    // The browser clamps the offset to the new bottom the settle left — the
    // viewport is at the bottom, a couple of pixels below what the app recorded.
    container.element.scrollTop = container.element.scrollHeight - container.element.clientHeight;
    container.writes.length = 0;

    act(() => {
      result.current.scrollToBottom();
    });

    assert.deepEqual(
      container.writes,
      [container.scrollHeight],
      `a viewport the browser clamped to the bottom must still pin; got ${JSON.stringify(container.writes)}`,
    );
  });
});

describe('content-growth follow', () => {
  beforeEach(() => {
    pendingFrames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    FakeResizeObserver.latest = null;
  });

  /**
   * Renders the hook over a resizable container, attaches the content column to
   * the follow and settles the baseline layout, returning the parts a case
   * drives. The container is never scrollable in jsdom, so the geometry the
   * follow reads is the one the fixture declares.
   */
  async function mountFollow(scrollHeight = 5000, clientHeight = 500) {
    const session = { id: SESSION_A } as ProjectSession;
    const messages = new Map([[SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]]]);
    const store = createStore(messages);
    const { result, rerender } = await renderChatSessionState({ session, store });

    const container = createResizableContainer(scrollHeight, clientHeight);
    const content = document.createElement('div');
    // The order React really commits in, which is the one the wiring has to
    // survive: the content column is the pane's child, so its ref callback runs
    // while the pane's ref is still null — and that callback's identity never
    // changes, so it is never called a second time to pick the pane up. The
    // render below is what runs the layout effect that points the observer at it.
    act(() => {
      attachContentRef(result.current.scrollContentRef, content);
    });
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;
    act(() => {
      rerender({ session });
    });

    const observer = FakeResizeObserver.latest;
    assert.ok(observer, 'attaching the content column must install a ResizeObserver');
    assert.deepEqual(
      observer.observed,
      [content, container.element],
      'the content column and the pane it scrolls in are both watched',
    );

    // The session-open scroll is a writer of its own, and the render above is what
    // lets it start over a pane that is by now attached: it re-scrolls every
    // animation frame until the height stops changing, then stops. Drained here,
    // because its writes would otherwise land in the windows below and be read as
    // the follow reacting to growth.
    for (let frame = 0; frame < 8; frame += 1) {
      act(() => {
        runFrames();
      });
    }
    // A pane with nowhere to scroll is held at one offset whatever a writer asks
    // for. The fixture assigns rather than clamps, so the clamp is applied here.
    container.scrollTo(Math.min(container.scrollTop, container.bottom));
    container.writes.length = 0;
    act(() => {
      runFrames();
    });
    assert.deepEqual(
      container.writes,
      [],
      'the session-open scroll must be finished before the window below opens',
    );

    // The baseline: the follow judges a resize against the layout before it, so
    // the attach-time layout has to be delivered once before anything is asked.
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });
    container.writes.length = 0;

    /**
     * Commits a render in which the transcript grew, the way a streaming row
     * does.
     *
     * A row is appended to the store, so the list the hook derives takes a new
     * identity — which is the *only* thing that re-runs the layout effect that
     * answers growth this component committed itself. That identity is the whole
     * point of doing it through the store: `getMessages` hands the hook whatever
     * array the map holds, so re-reading the same array back would leave
     * `chatMessages` the same value, the effect would never run, and a case
     * written that way would pass without ever reaching the code it means to
     * test.
     */
    const commitGrownRow = () => {
      const existing = messages.get(SESSION_A)!;
      messages.set(SESSION_A, [
        ...existing,
        buildMessage(existing.length, '2026-01-01T00:00:01.000Z'),
      ]);
      act(() => {
        rerender({ session });
      });
    };

    return { result, rerender, store, messages, container, observer, session, commitGrownRow };
  }

  it('stays pinned when the last row grows without a new one arriving', async () => {
    const { container, observer } = await mountFollow();

    // No store flush and no new row: the row already on screen is simply taller,
    // which is invisible to every row-count-driven scroll writer.
    container.grow(400);
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });

    assert.deepEqual(
      container.writes,
      [container.bottom],
      `a pinned viewport must land back on the bottom; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('follows a whole row past the box its first layout used', async () => {
    const { container, observer, commitGrownRow } = await mountFollow();

    // A whole row arrives, and its first layout is not its own height: a message
    // the pane has not drawn yet is laid out at the intrinsic-size box the
    // stylesheet gives it, so what the column measures in the commit the row
    // appears in is that box. The commit answers the box — a row that has not been
    // measured cannot be followed to — which places the viewport on a bottom the
    // row is about to grow out of.
    container.grow(240);
    commitGrownRow();
    act(() => {
      runFrames();
    });
    assert.strictEqual(
      container.writes[container.writes.length - 1],
      container.bottom,
      `the commit has to place the viewport on the bottom the row's own box leaves; got ${JSON.stringify(container.writes)}`,
    );

    // The browser then lays the row out for real, with no new row to announce it:
    // the row is already in the list, so the only thing that reports the growth is
    // the column's own resize. A follow driven by rows appearing stops here, a
    // whole row short — the reader is left looking at a box rather than at the
    // line that arrived.
    container.grow(900);
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });

    assert.strictEqual(
      container.scrollTop,
      container.bottom,
      `a whole row's real height is growth the follow has to answer; the pane sat `
      + `${container.bottom - container.scrollTop}px above the bottom (writes ${JSON.stringify(container.writes)})`,
    );
  });

  it('leaves the viewport where a gesture put it', async () => {
    const { container, observer } = await mountFollow();
    // The intent listener is on the window, so the pane has to be a node the
    // wheel can reach it through — the gesture is what marks the drift as the
    // user's, not the bare offset.
    document.body.appendChild(container.element);
    try {
      // The user wheels away from the bottom; the follow must read that as drift
      // the user owns, not as a gap it is free to close.
      act(() => {
        container.element.dispatchEvent(new Event('wheel'));
      });
      container.scrollTo(container.bottom - 300);
      act(() => {
        observer.emit();
      });
      act(() => {
        runFrames();
      });
      container.writes.length = 0;

      container.grow(400);
      act(() => {
        observer.emit();
      });
      act(() => {
        runFrames();
      });

      assert.deepEqual(
        container.writes,
        [],
        `growth must open the gap a scrolled-away viewport is holding; got ${JSON.stringify(container.writes)}`,
      );
    } finally {
      container.element.remove();
    }
  });

  it('follows growth after the browser nudges the viewport a few pixels on its own', async () => {
    const { container, observer } = await mountFollow();

    // The browser's own scroll anchoring (no input in front of it) moves the
    // offset a few pixels below the recorded bottom. That drift is not the user
    // leaving, and the growth that follows must still be pinned.
    container.scrollTo(container.bottom - 4);
    container.writes.length = 0;

    container.grow(400);
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });

    assert.deepEqual(
      container.writes,
      [container.bottom],
      `a viewport the browser nudged must still be followed; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('does not re-pin over a gesture that lands before the write', async () => {
    const { container, observer } = await mountFollow();

    container.grow(400);
    act(() => {
      observer.emit();
    });

    // The frame between the resize and the write is exactly the window a gesture
    // can land in, and taking the viewport back there has to win.
    container.scrollTo(container.scrollTop - 30);
    act(() => {
      runFrames();
    });

    assert.deepEqual(
      container.writes,
      [],
      `a scroll-up inside the deferred window must survive; got ${JSON.stringify(container.writes)}`,
    );
  });

  /** The shape of the browser's own scroll: the offset moves, nothing was touched. */
  const dispatchScroll = (container: HTMLElement) => {
    container.dispatchEvent(new Event('scroll'));
  };

  it('does not read a scroll with no input behind it as leaving the bottom', async () => {
    const { result, container, observer } = await mountFollow();
    // The listeners that attribute a scroll are on the window, so the pane has to
    // be a node the event can reach them through.
    document.body.appendChild(container.element);
    try {
      // The transcript has a scroll history behind it by now (the gestures that
      // brought the viewport to the bottom), so the offset the shrink is about to
      // change is one an implementation could already have recorded. Without this
      // the case below could only tell a source-based reading apart from one that
      // compares against a baseline it has never seen — and the difference this
      // test exists for is the source.
      act(() => {
        dispatchScroll(container.element);
      });
      // A row above the viewport collapses. The browser holds the visible content
      // still by moving the offset up by the same amount — the offset decreases,
      // exactly as it does under a wheel-up, with nobody touching the page.
      container.shrink(300);
      container.scrollTo(container.bottom);
      act(() => {
        observer.emit();
      });
      act(() => {
        runFrames();
      });
      const intentReadings: boolean[] = [];
      act(() => {
        dispatchScroll(container.element);
      });
      intentReadings.push(result.current.isUserScrolledUp);

      // The row that then grows in place must still be followed: the viewport
      // never left the bottom, so there is no gap for the growth to open.
      container.writes.length = 0;
      container.grow(480);
      act(() => {
        observer.emit();
      });
      act(() => {
        runFrames();
      });
      intentReadings.push(result.current.isUserScrolledUp);

      assert.deepEqual(
        intentReadings,
        [false, false],
        'a scroll the page received no input for must never raise the scroll-to-bottom state',
      );
      assert.deepEqual(
        container.writes,
        [container.bottom],
        `the growth after the browser's own scroll must still be followed; got ${JSON.stringify(container.writes)}`,
      );
    } finally {
      container.element.remove();
    }
  });

  it('still reads a wheel as the user leaving the bottom', async () => {
    const { result, container } = await mountFollow();
    document.body.appendChild(container.element);
    try {
      // The same offset change as above, and the same event — the input in front
      // of it is the only difference between them.
      act(() => {
        container.element.dispatchEvent(new Event('wheel'));
      });
      container.scrollTo(container.bottom - 300);
      act(() => {
        dispatchScroll(container.element);
      });

      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'a wheel that carries the viewport away from the bottom is the user leaving it',
      );
    } finally {
      container.element.remove();
    }
  });

  /**
   * The distinction the criterion turns on: intent is a *direction*, not a distance.
   *
   * A wheel of thirty pixels leaves the viewport inside the 50px band the pane's
   * "is it at the bottom?" question answers yes to, so an implementation that
   * decided by distance would keep following — and the next growth would then be
   * pinned over the user, which is the pull-back this case exists for. What the
   * report still carries on its own is the way the offset moved.
   */
  it('reads a small upward wheel as the user leaving, however near the bottom it lands', async () => {
    const { result, container, observer } = await mountFollow();
    document.body.appendChild(container.element);
    try {
      act(() => {
        container.element.dispatchEvent(new Event('wheel'));
      });
      container.scrollTo(container.bottom - 30);
      act(() => {
        dispatchScroll(container.element);
      });

      // The premise, stated so a run cannot pass without meeting it: the viewport
      // really did stay inside the band a distance rule reads as "at the bottom".
      assert.ok(
        container.bottom - container.scrollTop < 50,
        'the fixture must leave the viewport inside the band a distance rule calls pinned',
      );
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'a gesture that moved the viewport up must detach it however small the movement',
      );

      // And the consequence the criterion is about: the growth that follows opens
      // the gap the user is holding instead of closing it.
      container.writes.length = 0;
      container.grow(480);
      act(() => {
        observer.emit();
      });
      act(() => {
        runFrames();
      });
      assert.deepEqual(
        container.writes,
        [],
        `growth must open the gap the user is holding, not close it; got ${JSON.stringify(container.writes)}`,
      );
    } finally {
      container.element.remove();
    }
  });

  /**
   * The other way the same viewport is moved, and the one input a wheel-and-touch
   * rule cannot see: the browser scrolls the focused pane itself and reports a
   * `scroll` with no wheel and no touch anywhere on the page, so only the key in
   * front of the report says whose movement it was.
   */
  it('reads a keyboard scroll as the user leaving, with no wheel or touch behind it', async () => {
    const { result, container } = await mountFollow();
    document.body.appendChild(container.element);
    try {
      act(() => {
        container.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
      });
      container.scrollTo(container.bottom - 400);
      act(() => {
        dispatchScroll(container.element);
      });

      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'a scroll key that moved the pane is the user leaving the bottom, exactly as a wheel is',
      );
    } finally {
      container.element.remove();
    }
  });

  /**
   * The frame a scroll key spends before the browser reports it.
   *
   * A key moves a pane as its *default action*, and that movement is animated,
   * so the `scroll` carrying it arrives a frame or more after the press. Over
   * that frame the app has seen the input while the pane's offset still reads as
   * "nobody touched it" — which is precisely the window a commit landing in it
   * can pin over. Dispatching the key is that window exactly: jsdom moves no
   * offset and raises no `scroll`, so the case holds the app at the instant the
   * report is owed rather than at the instant it arrives.
   */
  const pressScrollKey = (container: HTMLElement, key: string) => {
    container.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  };

  it('does not pin a growth over a scroll key the browser has not reported yet', async () => {
    const { result, container, commitGrownRow } = await mountFollow();
    // The listeners that attribute a scroll — and the key handler this turns on
    // — are on the window, so the pane has to be a node the event can reach
    // them through.
    document.body.appendChild(container.element);
    try {
      // The row grew in the commit that is about to land, and the user pressed
      // PageUp in the frame before it.
      container.grow(400);
      act(() => {
        pressScrollKey(container.element, 'PageUp');
      });

      // The premise, read before the commit so it cannot be the commit that
      // produced it: the intent is taken at the input, not at the report.
      const intentAtInput = result.current.isUserScrolledUp;

      container.writes.length = 0;
      commitGrownRow();
      const writes = [...container.writes];

      // Both readings in one assertion, so a red run reports the whole frame —
      // the intent still on "follow" *and* the offset the pin put back over the
      // key — rather than stopping at whichever half it happens to name first.
      assert.deepEqual(
        { intentAtInput, writes },
        { intentAtInput: true, writes: [] },
        `an up key must detach the pane in the task it landed in, and the growth that commits before the browser reports the scroll must open the gap it is holding; got ${JSON.stringify({ intentAtInput, writes })}`,
      );
    } finally {
      container.element.remove();
    }
  });

  /**
   * The control for the case above, and the reason it cannot be satisfied by an
   * inert implementation: with no key pressed the very same commit has to reach
   * the pin and land on the bottom. Without this, "no writes" would be equally
   * true of a follow that had simply stopped working.
   */
  it('pins the same growth when no scroll key was pressed', async () => {
    const { container, commitGrownRow } = await mountFollow();

    container.grow(400);
    container.writes.length = 0;
    commitGrownRow();

    assert.deepEqual(
      container.writes,
      [container.bottom],
      `the commit above has to reach the pin, or the case it controls proves nothing; got ${JSON.stringify(container.writes)}`,
    );
  });

  /**
   * The other half of the rule: only a key that asks for *older* content
   * detaches. A key that asks for the bottom is the user returning to it, and
   * detaching on one would leave the follow dead until some later input came
   * back to undo it.
   */
  it('does not detach on a scroll key that asks for the bottom', async () => {
    const { result, container } = await mountFollow();
    document.body.appendChild(container.element);
    try {
      const readings: boolean[] = [];
      for (const key of ['ArrowDown', 'PageDown', 'End']) {
        act(() => {
          pressScrollKey(container.element, key);
        });
        readings.push(result.current.isUserScrolledUp);
      }

      assert.deepEqual(
        readings,
        [false, false, false],
        `ArrowDown, PageDown and End ask for the bottom and must leave the follow alone; got ${JSON.stringify(readings)}`,
      );
    } finally {
      container.element.remove();
    }
  });

  /**
   * The pane's own box getting shorter — a software keyboard, a growing composer,
   * the activity indicator's padding toggle — is the other side of the same
   * question. Nothing about the content changes, so the content column's own
   * observer has nothing to report; and a pane that got shorter needs no clamp,
   * so the browser raises no `scroll` for it either. The only evidence is the
   * container's box, and the only thing that can say whether to follow is the
   * user's intent: by the time any observer runs, the gap the shrink opened is
   * already there, and judging "is the viewport at the bottom?" against it would
   * answer no for exactly the case this exists for.
   */
  it('re-pins a pane that gets shorter under a viewport that was at the bottom', async () => {
    const { container, observer } = await mountFollow();

    // The content keeps the box it had; only the container moves.
    container.shrinkPane(300);
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });

    assert.deepEqual(
      container.writes,
      [container.bottom],
      `a pinned viewport must land back on the bottom of a pane that got shorter; got ${JSON.stringify(container.writes)}`,
    );
  });

  it('leaves a pane that gets shorter alone while the user is away from the bottom', async () => {
    const { result, container, observer } = await mountFollow();
    document.body.appendChild(container.element);
    try {
      // The user wheels away, and the pane reports it: the intent the shrink
      // below has to be judged against.
      act(() => {
        container.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      });
      container.scrollTo(container.bottom - 300);
      act(() => {
        dispatchScroll(container.element);
      });
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'a wheel that carries the viewport away from the bottom is the user leaving it',
      );
      container.writes.length = 0;

      container.shrinkPane(300);
      act(() => {
        observer.emit();
      });
      act(() => {
        runFrames();
      });

      assert.deepEqual(
        container.writes,
        [],
        `a shrink must open the gap the user is holding, not close it; got ${JSON.stringify(container.writes)}`,
      );
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'and must not re-attach the follow behind the user\'s back',
      );
    } finally {
      container.element.remove();
    }
  });

  /**
   * The first screen a chat opens on is often shorter than the pane, so it has no
   * scrollbar at all: the offset never moves and no `scroll` is ever raised. A
   * wheel up there is still the user reaching for older messages, and the prepend
   * that answers it ends with a restore whose anchor offset cannot be kept — the
   * clamp puts the viewport on the bottom, where a user who scrolled there would
   * sit. So neither the offset nor the `scroll` report the restore's own write
   * raises can say who wants the viewport there; the only thing left to go on is
   * that the newest thing that happened was the user's gesture.
   */
  it('keeps a prepend the wheel asked for out of the follow\'s hands', async () => {
    /** What the older page adds above the viewport, in CSS pixels. */
    const PREPENDED_PX = 1041;
    /** What the row that grows afterwards adds, in CSS pixels. */
    const GROWTH_PX = 480;

    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createStore(messages, { hasMore: true, prependCount: 1 });
    const { result, rerender } = await renderChatSessionState({
      session: { id: SESSION_A } as ProjectSession,
      store,
    });
    // The pane the criterion names: exactly as tall as its content, so there is no
    // offset to move and nothing for a wheel to report.
    const container = createResizableContainer(5776, 5776);
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;

    const content = document.createElement('div');
    act(() => {
      attachContentRef(result.current.scrollContentRef, content);
    });
    const observer = FakeResizeObserver.latest;
    assert.ok(observer, 'attaching the content column must install a ResizeObserver');
    // The baseline layout, delivered once before anything is asked.
    act(() => {
      observer.emit();
    });
    // The session load reports whether an older page exists from a resolved
    // promise, and the wheel below is only a request for one if it does. It is
    // also the rerender that lets the session-open scroll below see the container
    // that was attached a moment ago.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The session-open scroll to the bottom re-scrolls every animation frame
    // until the height stops changing, so it is not a growth-driven writer at
    // all — but its frames are on the same queue as the follow's, so left armed
    // they would land in the window below and be read as the follow reacting to
    // growth. Run to completion here: over a settled height it stops after three
    // stable frames. The writes it made are counted, so a drain over an effect
    // that never ran cannot pass for one that did.
    let sessionOpenWrites = 0;
    for (let frame = 0; frame < 6; frame += 1) {
      const before = container.writes.length;
      act(() => {
        runFrames();
      });
      sessionOpenWrites += container.writes.length - before;
    }
    assert.ok(
      sessionOpenWrites > 0,
      'the session-open scroll has to have run, or the drain below certifies nothing',
    );
    container.writes.length = 0;
    act(() => {
      runFrames();
    });
    assert.deepEqual(
      container.writes,
      [],
      'the session-open scroll must be finished before the window below opens',
    );
    // A pane exactly as tall as its content has one offset the browser will hold
    // it at, whatever a writer asks for. The fixture assigns rather than clamps,
    // so the clamp is applied here — as it is after the restore below.
    container.scrollTo(Math.min(container.scrollTop, container.bottom));
    assert.equal(
      container.scrollTop,
      0,
      'the first screen has to be sitting at the top, or the gesture below is not reaching for an older page',
    );
    assert.equal(
      container.element.scrollHeight,
      container.element.clientHeight,
      'the fixture has to be a first screen with no scrollbar',
    );
    container.writes.length = 0;

    // The listeners that attribute a scroll are on the window, so the pane has to
    // be a node the event can reach them through.
    document.body.appendChild(container.element);
    try {
      assert.equal(
        result.current.hasMoreMessages,
        true,
        'the fixture has to have an older page for the wheel to ask for',
      );

      // The gesture, through the entry the app really reads it from: a wheel aimed
      // at the pane. A pane with nothing to scroll raises no scroll behind it, so
      // the wheel is the whole evidence.
      act(() => {
        container.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      });
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'a wheel up over a first screen with nothing to scroll is still the user leaving the bottom',
      );

      // The prepend, through the entry the pane's own `onWheel` prop calls. The
      // restore state is captured synchronously inside the call and the fetch
      // resolves later, so the older page lands in between — the browser's own
      // ordering: capture → older page on screen → restore. Those rows are also
      // what drives the restore: it runs off the transcript growing, so a fixture
      // whose store never grew would be waiting for an effect that never re-runs.
      const pending = result.current.handleScroll();
      container.grow(PREPENDED_PX);
      messages.set(SESSION_A, [
        buildMessage(2, '2025-12-31T23:59:59.000Z'),
        ...messages.get(SESSION_A)!,
      ]);
      await act(async () => {
        await pending;
      });

      // The restore the prepend ends with. A pane that had no scrollable height
      // cannot keep the anchor's offset, so the write lands on the bottom; the
      // browser's clamp is not a write and is applied here as the fixture's own
      // step.
      assert.deepEqual(
        container.writes,
        [container.bottom],
        `the restore must land on the bottom of the pane it could not scroll; got ${JSON.stringify(container.writes)}`,
      );
      container.scrollTo(Math.min(container.scrollTop, container.bottom));

      // (a) The report that write raises. It came from the app placing the
      // viewport, and the pane it came from could not have been scrolled by the
      // user — reading it as intent is what hands the viewport back to the follow.
      act(() => {
        dispatchScroll(container.element);
      });
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'the restore\'s own scroll report must not hand the viewport back to the follow',
      );

      // (b) The growth that follows. A row that gets taller in place, with no new
      // row and no store flush behind it.
      container.writes.length = 0;
      container.grow(GROWTH_PX);
      act(() => {
        observer.emit();
      });
      // Every deferred writer gets its chance: the follow's frame, and the delay a
      // row-triggered scroll is armed on.
      act(() => {
        runFrames();
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      assert.deepEqual(
        container.writes,
        [],
        `growth in place under a transcript the wheel took over must not move it; got ${JSON.stringify(container.writes)}`,
      );

      // ...and the shape a real arrival takes: a new row in the store. A new row
      // is the one growth a row-count-driven writer would act on.
      messages.set(SESSION_A, [
        ...messages.get(SESSION_A)!,
        buildMessage(1, '2026-01-01T00:00:01.000Z'),
      ]);
      await act(async () => {
        rerender({ session: { id: SESSION_A } as ProjectSession });
      });
      act(() => {
        runFrames();
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      assert.deepEqual(
        container.writes,
        [],
        `a row the wheel's prepend did not ask for must not pull the viewport down; got ${JSON.stringify(container.writes)}`,
      );
      assert.equal(
        result.current.isUserScrolledUp,
        true,
        'and must not re-attach the follow behind the user\'s back',
      );
    } finally {
      container.element.remove();
    }
  });
});

describe('search jump ownership', () => {
  it('does not follow the user into the next session', { timeout: 20_000 }, async () => {
    const messages = new Map<string, NormalizedMessage[]>([
      [SESSION_A, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
      [SESSION_B, [buildMessage(1, '2026-01-01T00:00:05.000Z')]],
    ]);
    const store = createStore(messages);
    const searchSession = {
      id: SESSION_A,
      __searchTargetSnippet: 'message 0',
      __searchTargetTimestamp: '2026-01-01T00:00:00.000Z',
    } as unknown as ProjectSession;

    const { result, rerender } = await renderChatSessionState({ session: searchSession, store });

    const container = createContainer(5000, 500);
    // The row session B renders. The jump requested against session A resolves
    // by timestamp, and on its last retry it accepts the nearest row it can
    // find — which, after the switch, is this one.
    const sessionBRow = document.createElement('div');
    sessionBRow.setAttribute('data-message-timestamp', '2026-01-01T00:00:05.000Z');
    container.element.appendChild(sessionBRow);

    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // Let the jump arm and start retrying.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The user gives up waiting and opens a different session.
    await act(async () => {
      rerender({ session: { id: SESSION_B } as ProjectSession });
    });

    // Let the whole retry budget elapse (20 retries, 150ms apart).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3400);
    });

    assert.equal(
      scrollIntoView.mock.calls.length,
      0,
      'a jump requested in the previous session must not scroll the new one',
    );
    assert.equal(
      container.element.querySelectorAll('.search-highlight-flash').length,
      0,
      'and must not flash the search highlight on one of its rows',
    );
  });
});
