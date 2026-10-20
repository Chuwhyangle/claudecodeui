import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/transcript/workSegments';
import type {
  ChatMessage,
  Project,
  ProjectSession,
  ProviderModelActions,
} from '@/shared/types';

/**
 * AC-204: a work segment's expansion state lives in the pane's own React state —
 * longer-lived than the `LazyMessageRow` subtree it is drawn inside, shorter-lived
 * than a pane mount.
 *
 * The two readings are each other's controls, and each has a false form the other
 * rules out:
 *
 *   (i)  expand a segment, drive its row out of the viewport and back — the row is
 *        really unmounted (its members leave the DOM, its placeholder stays), and
 *        the segment is still open when it returns. State kept *inside* the record
 *        would fail here: the record dies with the row.
 *   (ii) expand a segment, unmount the whole pane, mount a fresh one — the segment
 *        is collapsed. State kept at module scope would fail here: the fresh pane
 *        would inherit the previous mount's expansion.
 *
 * Everything below drives the shipped pane, selector and record; nothing here
 * re-implements a second copy of them. The intersection observer is the drivable
 * stand-in `lazyMessageRow.test.tsx` installs, because jsdom has none and the
 * unmount-under-test is the real `LazyMessageRow` near/far state machine.
 */

/**
 * The viewport observer stand-in: jsdom ships no `IntersectionObserver`, so the
 * case installs one and fires its callback by hand to walk a row near → far → near.
 */
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  observed: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    StubIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(element: Element): void {
    this.observed = this.observed.filter((observed) => observed !== element);
  }

  disconnect(): void {
    this.observed = [];
  }
}

function fireIntersection(
  observer: StubIntersectionObserver,
  target: Element,
  isIntersecting: boolean,
  rect: { width: number; height: number } = { width: 100, height: 40 },
): void {
  act(() => {
    observer.callback(
      [{ target, isIntersecting, boundingClientRect: rect } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

/** jsdom ships no media queries; the device rule the pane reads is the width one. */
const installMatchMedia = () => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const row = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: id,
  timestamp: '2026-01-01T00:00:00.000Z',
  id,
  blockKey: `block-${id}`,
  ...overrides,
});

/**
 * A user turn, two adjacent work rows (a thinking row and a tool call) that the
 * selector must absorb into one segment, and a closing assistant turn. The two
 * members carry distinct timestamps so a case can address each member's own row
 * and tell it apart from the row that wraps the segment.
 */
const ANCHOR_TS = '2026-01-01T00:00:01.000Z';
const SECOND_MEMBER_TS = '2026-01-01T00:00:02.000Z';

const fixture: ChatMessage[] = [
  row('u1', { type: 'user', content: 'ask the thing', timestamp: '2026-01-01T00:00:00.000Z' }),
  row('k1', { isThinking: true, content: 'thinking k1', timestamp: ANCHOR_TS }),
  row('k2', { isToolUse: true, toolName: 'Read', content: 'reading k2', timestamp: SECOND_MEMBER_TS }),
  row('a1', { content: 'the answer', timestamp: '2026-01-01T00:00:03.000Z' }),
];
const SEGMENT_MEMBER_COUNT = 2;

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

/** The pane's own props, only as far as a transcript with a work segment needs them. */
const paneProps = (): React.ComponentProps<typeof ChatMessagesPane> => ({
  scrollContainerRef: { current: null },
  scrollContentRef: () => undefined,
  onWheel: () => undefined,
  onTouchMove: () => undefined,
  isLoadingSessionMessages: false,
  chatMessages: fixture,
  selectedSession: { id: 'session-a' } as ProjectSession,
  currentSessionId: 'session-a',
  provider: 'claude' as const,
  setProvider: () => undefined,
  textareaRef: { current: null },
  providerModels: { claude: 'claude-sonnet-4-5', cursor: 'cursor-small', codex: 'codex-mini', opencode: 'opencode-default' },
  setProviderModel: () => undefined,
  providerModelCatalog: {},
  providerModelActions: {} as ProviderModelActions,
  providerModelsLoading: false,
  tasksEnabled: false,
  isTaskMasterInstalled: null,
  setInput: () => undefined,
  isLoadingMoreMessages: false,
  hasMoreMessages: false,
  totalMessages: fixture.length,
  sessionMessagesCount: fixture.length,
  visibleMessageCount: fixture.length,
  visibleMessages: fixture,
  loadEarlierMessages: () => undefined,
  loadAllMessages: () => undefined,
  allMessagesLoaded: true,
  isLoadingAllMessages: false,
  loadAllJustFinished: false,
  showLoadAllOverlay: false,
  createDiff: () => undefined,
  onGrantToolPermission: () => ({ success: true }),
  selectedProject: project,
  showThinking: true,
});

const renderPane = () =>
  render(
    <UiPreferencesProvider>
      <ChatMessagesPane {...paneProps()} />
    </UiPreferencesProvider>,
  );

/** The pane's own addressing contract for a segment row: the box it wraps the record in. */
const segmentBox = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-work-segment-key]');

/** The member rows mounted inside a segment box — the rows the record's expansion reveals. */
const memberRows = (box: HTMLElement) => box.querySelectorAll('[data-message-timestamp]');

const expandSegment = (box: HTMLElement) => {
  const header = box.querySelector('button');
  assert.ok(header, 'the segment must expose its collapse header as a button');
  fireEvent.click(header);
};

beforeEach(() => {
  installMatchMedia();
  setViewportWidth(1280);
});

afterEach(() => {
  StubIntersectionObserver.instances = [];
  vi.unstubAllGlobals();
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

describe('work segment expansion persistence', () => {
  test('the fixture really yields one multi-member work segment', () => {
    const segments = groupWorkSegments(fixture).filter(isWorkSegment);
    assert.equal(segments.length, 1, 'the fixture must select exactly one work segment');
    assert.equal(
      segments[0].messages.length,
      SEGMENT_MEMBER_COUNT,
      'the fixture segment must have the member count the cases below read back',
    );
  });

  test('member content is mounted before the far transition', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const view = renderPane();
    const box = segmentBox(view.container);
    assert.ok(box, 'the pane must render its addressable work-segment box');

    expandSegment(box);
    assert.equal(
      memberRows(box).length,
      SEGMENT_MEMBER_COUNT,
      'after expanding, every member row must really be in the DOM — otherwise the disappearance the '
        + 'round-trip case reads could hold for any input, and the reading would be vacuous',
    );

    // The same rows must be gone once the row goes far, so "mounted before" is a
    // real transition and not a constant that is always true.
    const wrapper = box.parentElement as HTMLElement;
    const observer = StubIntersectionObserver.instances[0];
    fireIntersection(observer, wrapper, false);
    assert.equal(
      segmentBox(view.container),
      null,
      'the segment box must leave the DOM when the row goes far, or the mount above proved nothing',
    );
    view.unmount();
  });

  test('expansion survives the row leaving the viewport', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const view = renderPane();
    const box = segmentBox(view.container);
    assert.ok(box, 'the pane must render its addressable work-segment box');
    assert.equal(memberRows(box).length, 0, 'a freshly mounted segment must start collapsed');

    expandSegment(box);
    assert.equal(
      memberRows(box).length,
      SEGMENT_MEMBER_COUNT,
      'expanding must mount every member row',
    );

    // The lazy row the segment is drawn inside, addressed by the segment anchor's
    // timestamp; its placeholder is what must survive the unmount.
    const wrapper = box.parentElement as HTMLElement;
    assert.ok(wrapper, 'the segment box must sit inside the lazy row wrapper');
    assert.equal(
      wrapper.getAttribute('data-message-timestamp'),
      ANCHOR_TS,
      'the lazy row must publish the segment anchor timestamp as its placeholder address',
    );

    const observer = StubIntersectionObserver.instances[0];
    Object.defineProperty(wrapper, 'offsetHeight', { value: 123, configurable: true });
    fireIntersection(observer, wrapper, false);

    // The row left the viewport: the segment — header and members together — is gone.
    assert.equal(
      segmentBox(view.container),
      null,
      'the segment must be unmounted once its row leaves the viewport',
    );
    assert.equal(
      view.container.querySelector(`[data-message-timestamp="${SECOND_MEMBER_TS}"]`),
      null,
      'the member rows must not remain in the DOM while the row is away',
    );
    const placeholder = view.container.querySelector(`[data-message-timestamp="${ANCHOR_TS}"]`);
    assert.ok(placeholder, 'the lazy row placeholder must remain, addressed by the anchor timestamp');
    assert.notEqual(
      (placeholder as HTMLElement).style.height,
      '',
      'the placeholder must hold the height measured before the content was unmounted',
    );

    fireIntersection(observer, wrapper, true);

    const restored = segmentBox(view.container);
    assert.ok(restored, 'the segment must remount when the row returns to the viewport');
    assert.equal(
      memberRows(restored).length,
      SEGMENT_MEMBER_COUNT,
      'the segment must still be expanded after the round trip, with every member mounted again',
    );
    assert.equal(
      (wrapper as HTMLElement).style.height,
      '',
      'the row must be mounted again rather than left as a placeholder',
    );
    view.unmount();
  });

  test('a fresh pane mount starts every segment collapsed', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const first = renderPane();
    const firstBox = segmentBox(first.container);
    assert.ok(firstBox, 'the first pane must render the segment');
    // Guard the discriminating step without assuming which state the segment
    // starts in: the click must toggle it, or the fresh-mount reading below could
    // pass simply because the first pane never had an expansion to forget.
    const beforeClick = memberRows(firstBox).length;
    expandSegment(firstBox);
    assert.notEqual(
      memberRows(firstBox).length,
      beforeClick,
      'precondition: clicking the header must toggle the segment in the first pane',
    );
    first.unmount();

    const second = renderPane();
    const secondBox = segmentBox(second.container);
    assert.ok(secondBox, 'the fresh pane must still render the segment');
    assert.equal(
      memberRows(secondBox).length,
      0,
      'a fresh pane mount must not inherit the previous mount’s expansion — the default is collapsed, '
        + 'not “remember the last one”',
    );
    const countNode = secondBox.querySelector('[data-work-segment-count]');
    assert.ok(countNode, 'the collapsed header must expose the member count');
    assert.equal(
      countNode.getAttribute('data-work-segment-count'),
      String(SEGMENT_MEMBER_COUNT),
      'the collapsed default must expose the fixture segment’s real member count',
    );
    second.unmount();
  });
});
