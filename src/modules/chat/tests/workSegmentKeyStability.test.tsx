import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/transcript/messageKeys';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/transcript/workSegments';

import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type {
  ChatMessage,
  NormalizedMessage,
  Project,
  ProjectSession,
  ProviderModelActions,
} from '@/shared/types';

/**
 * AC-207 (gap-ac207-expand-all-first-segment-recollapse): the fleet red is a document
 * reload, not a re-keyed anchor — the two halves of the chain the task's proposal
 * named, read separately, both through shipped code.
 *
 * The proposal named this chain: "a segment's first member is re-minted on settle, the
 * anchor key (the segment's identity, == `getIntrinsicMessageKey(firstMember)`) moves,
 * and the pane's expanded set — keyed by that anchor — no longer contains it, so the
 * run collapses while the runs whose keys did not move stay open." It asked for a
 * deterministic reading of it. Two readings answer, and each is the other's boundary:
 *
 *   (1) the anchor is only as stable as its first member's fields. For a segment whose
 *       first member carries no stable identity, `getIntrinsicMessageKey` falls through
 *       to a timestamp + content preview, so re-minting either moves the anchor and the
 *       expansion keyed by the old one is orphaned. The construction below drives the
 *       shipped projection (`normalizedToChatMessages`) and the shipped selector, and
 *       pins both the stable direction (a same-fields re-projection keeps the anchor)
 *       and the moving one (a re-minted timestamp moves it). Whether the shipped sync
 *       path ever applies that re-mint to a segment's FIRST member is read in the task's
 *       Evidence, not asserted here.
 *
 *   (2) the red's real shape is a pane remount. The client's own Vite build replaces the
 *       document whole on a re-optimization (`504 Outdated Optimize Dep`, the failure the
 *       sibling criteria settle with bounded reloads), which mounts a fresh pane; AC-204's
 *       contract starts a fresh pane collapsed. So a reload landing between opening the
 *       runs strands the runs opened before it and leaves the runs opened after it open —
 *       the "20 rows, first run collapsed" the recorded trace shows. The fixture here is
 *       the e2e seed's three-run shape, so the reading is the observed failure reproduced
 *       deterministically rather than a restatement of AC-204's single-run cases.
 */

//------------------------- fixtures --------------------------------

const historyTs = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

/** A server/history thinking row: no live id, no blockKey — the projection keeps neither. */
const normThinking = (id: string, content: string, second: number): NormalizedMessage => ({
  id,
  provider: 'claude',
  sessionId: 'session-1',
  kind: 'thinking',
  content,
  timestamp: historyTs(second),
});

const normTool = (id: string, toolId: string, second: number): NormalizedMessage => ({
  id,
  provider: 'claude',
  sessionId: 'session-1',
  kind: 'tool_use',
  toolName: 'Bash',
  toolId,
  timestamp: historyTs(second),
});

const normText = (id: string, role: 'user' | 'assistant', content: string, second: number): NormalizedMessage => ({
  id,
  provider: 'claude',
  sessionId: 'session-1',
  kind: 'text',
  role,
  content,
  timestamp: historyTs(second),
});

/**
 * The e2e seed's shape in miniature: three maximal runs of work rows, separated by
 * short assistant text rows, so the selector mints three segments. Runs 0 and 2 start
 * on a thinking row (no stable identity — the fallback anchor); run 1 starts on a tool
 * call (a tool id, so its anchor is the identity branch).
 */
const threeRunTranscript = (): NormalizedMessage[] => [
  normText('s0', 'user', 'Show me the release notes.', 0),
  normThinking('s1', 'Scanning the notes directory.', 1),
  normTool('s2', 'r0-tool', 2),
  normText('s3', 'assistant', 'First pass complete.', 3),
  normTool('s4', 'r1-tool', 4),
  normThinking('s5', 'The grep found the passage.', 5),
  normText('s6', 'assistant', 'Second pass complete.', 6),
  normThinking('s7', 'Summarising what the notes contain.', 7),
  normTool('s8', 'r2-tool', 8),
  normText('s9', 'assistant', 'Done.', 9),
];

const historyMessages = (): ChatMessage[] => normalizedToChatMessages(threeRunTranscript());

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

//------------------------- jsdom stand-ins --------------------------------

/** jsdom ships no `IntersectionObserver`; a row a pane never scrolls stays mounted. */
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

const paneProps = (messages: ChatMessage[]): React.ComponentProps<typeof ChatMessagesPane> => ({
  scrollContainerRef: { current: null },
  scrollContentRef: () => undefined,
  onWheel: () => undefined,
  onTouchMove: () => undefined,
  isLoadingSessionMessages: false,
  chatMessages: messages,
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
  totalMessages: messages.length,
  sessionMessagesCount: messages.length,
  visibleMessageCount: messages.length,
  visibleMessages: messages,
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
      <ChatMessagesPane {...paneProps(historyMessages())} />
    </UiPreferencesProvider>,
  );

/** The pane's own addressing contract for a segment row: the box it wraps the record in. */
const segmentBoxes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-work-segment-key]'));

/** The member rows actually mounted inside a segment box — none when the record is collapsed. */
const memberRows = (box: HTMLElement) => box.querySelectorAll('.chat-message[data-message-timestamp]');

const clickHeader = (box: HTMLElement) => {
  const header = box.querySelector('button');
  assert.ok(header, 'the segment must expose its collapse header as a button');
  fireEvent.click(header);
};

const segmentsOf = (messages: ChatMessage[]) => groupWorkSegments(messages).filter(isWorkSegment);

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);
  StubIntersectionObserver.instances = [];
  installMatchMedia();
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

describe('work segment anchor under a first-member re-mint', () => {
  test('the fixture really yields three runs, the two thinking-led ones without a stable first-member identity', () => {
    const messages = historyMessages();
    const segments = segmentsOf(messages);
    assert.equal(segments.length, 3, 'the three-run fixture must select three work segments');

    const firsts = segments.map((segment) => segment.messages[0]);
    assert.equal(firsts[0]?.isThinking, true);
    assert.equal(firsts[1]?.isToolUse, true);
    assert.equal(firsts[2]?.isThinking, true);

    // A server/history row is projected without a live id, and a thinking row has no
    // tool/blob/row identity either — so the two thinking-led runs rest on the
    // timestamp + content fallback, which is the construction the task named.
    assert.equal(firsts[0]?.id, undefined, 'a history row carries no live id');
    assert.equal(firsts[0]?.blockKey, undefined, 'the history read path stamps no blockKey');
    assert.equal(firsts[2]?.id, undefined);
    assert.equal(segments[1].messages[0]?.toolId, 'r1-tool', 'the tool-led run keeps a stable identity branch');
  });

  test('a same-fields re-projection keeps the anchor; only a re-minted field moves it', () => {
    const [run0] = segmentsOf(historyMessages());
    const firstMember = run0.messages[0];
    const anchor = run0.key;

    assert.ok(anchor, 'the run must have an anchor');
    assert.equal(anchor, getIntrinsicMessageKey(firstMember), 'the anchor is the first member’s intrinsic key');
    assert.match(anchor, /^message-assistant-\d+--/, 'a thinking-led run with no stable identity rests on the fallback');

    // Same fields, a fresh object — what a re-projection of an unchanged history row is.
    // The anchor does not move, so the expansion keyed by it survives the re-projection.
    const reprojected = { ...firstMember };
    assert.equal(getIntrinsicMessageKey(reprojected), anchor, 're-projecting unchanged fields must not move the anchor');

    // The boundary the proposal named: the fallback is derived from the timestamp and the
    // content preview, so re-minting either moves the anchor and orphans the expansion keyed
    // by the old one. This pins exactly what the proposal claimed the red was — the task's
    // Evidence reads whether the shipped sync path ever applies that re-mint to a first member.
    const reminted = { ...firstMember, timestamp: historyTs(99) };
    assert.notEqual(getIntrinsicMessageKey(reminted), anchor, 'a re-minted timestamp moves a fallback anchor');
    const expand = new Set([anchor]);
    assert.equal(expand.has(getIntrinsicMessageKey(reminted) ?? ''), false, 'a moved anchor is no longer in the expanded set');
  });
});

describe('work segment expansion across a document reload', () => {
  test('with no reload, opening every run leaves every run open', () => {
    const { container, unmount } = renderPane();
    const boxes = segmentBoxes(container);
    assert.equal(boxes.length, 3, 'the pane draws the fixture’s three runs');
    for (const box of boxes) clickHeader(box);
    for (const box of boxes) {
      assert.ok(memberRows(box).length > 0, 'every opened run must have its members mounted');
    }
    unmount();
  });

  test('a remount between clicks strands the run opened before it and leaves the later runs open', () => {
    // The intended end state: every run open. Open run 0 first, exactly as the e2e does.
    const first = renderPane();
    const firstBox = segmentBoxes(first.container)[0];
    clickHeader(firstBox);
    assert.ok(memberRows(firstBox).length > 0, 'run 0 must be open before the client restarts');

    // The client replaces the document (Vite's own full-reload): a fresh pane, which AC-204
    // starts collapsed. The runs opened from here on are the only ones that survive.
    act(() => first.unmount());
    const second = renderPane();
    const boxes = segmentBoxes(second.container);
    assert.equal(boxes.length, 3, 'the restarted document still draws the three runs');
    assert.equal(memberRows(boxes[0]).length, 0, 'a fresh pane starts run 0 collapsed');
    clickHeader(boxes[1]);
    clickHeader(boxes[2]);

    // The observed shape: the first run — opened before the restart — is collapsed while the
    // two opened after it are open. Streamed into the e2e's 24-row fixture this is exactly the
    // recorded "drew 20 rows" (the first run's 7 members missing), and it is a document restart,
    // not the anchor moving: run 0's anchor is unchanged (the reading above), only the pane is new.
    assert.equal(memberRows(boxes[0]).length, 0, 'the run opened before the restart is stranded');
    assert.ok(memberRows(boxes[1]).length > 0, 'a run opened after the restart stays open');
    assert.ok(memberRows(boxes[2]).length > 0, 'the other run opened after the restart stays open');
    act(() => second.unmount());
  });
});
