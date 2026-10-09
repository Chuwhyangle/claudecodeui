/**
 * A branch is cut at the answer, and only at an answer.
 *
 * THE CLAIM, IN ONE SENTENCE. The "fork from here" affordance sits on the
 * assistant turn-ending reply — the one row a branch is meaningful on — and on
 * nothing else: not on the user's prompt, which keeps its own edit-and-resend
 * control, and not on a reply that does not end a turn (narration, a mid-turn
 * aside). Pressing it hands the session and the reply's own `forkAnchorId` to
 * the API, and while the session is still producing output the control is absent
 * even though the provider could fork.
 *
 * WHY THE ROW'S OWN ANCHOR IS THE POINT. The anchor used to be
 * `transcriptAnchorId`, which names the *user input* row; a fork keyed on it
 * ends the branch at the prompt, so the answer it was pressed from is not in the
 * branch. `forkAnchorId` names the assistant row instead, and this case exists so
 * a later edit cannot quietly move the control back onto the prompt or onto a
 * reply that never carried an anchor.
 *
 * WHAT IS COMPOSED HERE, AND WHAT IS NOT. The real `ChatInterface` is rendered —
 * its own `handleForkFromMessage` is the code that calls the API, and a stand-in
 * for it would assert nothing about the shipped path. The session/provider/composer
 * hooks are given their answers directly, the way every `ChatInterface` case in
 * this directory does; `ChatMessagesPane` and `MessageComponent` are the real
 * ones, so both the presence and the absence of the button are read off shipped
 * markup. Only `api.forkSession` is doubled, so it can record what it was called
 * with rather than reach the network.
 *
 * Run: npx vitest run src/modules/chat/tests/forkFromAssistantReply.test.tsx
 */

import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

const SESSION_ID = 'session-fork-anchor';
/** The uuid the server would put on the first turn's final assistant row. */
const FORK_ANCHOR = 'a2-uuid';

const PROJECT: Project = {
  projectId: 'project-fork',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const SESSION: ProjectSession = { id: SESSION_ID };

/**
 * Mutable state the doubles read, so one case can flip processing between arms
 * and read what the API was handed.
 */
const state = vi.hoisted(() => ({
  isProcessing: false,
  forkCalls: [] as Array<{ sessionId: string; body: { upToAnchorId?: string } }>,
}));

/* ─── The three transcript rows the reading is taken off ─────────────────── */

/** The turn-ending answer: the one row a branch belongs on. */
const ANSWER_ROW = {
  type: 'assistant',
  content: 'first answer',
  timestamp: '2026-08-23T10:00:03.000Z',
  forkAnchorId: FORK_ANCHOR,
} as unknown as ChatMessage;

/** The user's prompt: a plain turn, with the edit anchor but no fork anchor. */
const PROMPT_ROW = {
  type: 'user',
  content: 'first question',
  timestamp: '2026-08-23T10:00:00.000Z',
  transcriptAnchorId: 'u1-uuid',
} as unknown as ChatMessage;

/**
 * A reply that does not end a turn — mid-turn narration, with no `forkAnchorId`.
 * It must still be drawn: its absence of a button is only meaningful beside the
 * answer's presence of one.
 */
const NARRATION_ROW = {
  type: 'assistant',
  content: 'let me check.',
  timestamp: '2026-08-23T10:00:01.000Z',
} as unknown as ChatMessage;

const VISIBLE_MESSAGES = [PROMPT_ROW, ANSWER_ROW, NARRATION_ROW];

/* ─── Module doubles: nothing here is the thing under test ───────────────── */

// The pane is active here, so it renders the Live Voice entry control
// (`live-voice-enter`) beside the composer; both read the auth context for a
// token. This case renders no `AuthProvider` (the app supplies one above
// `ChatInterface`), so hand the hook a tokenless context — the fork control is
// the thing under test, not voice.
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
}));

// Only `useWebSocket` is doubled: the module's default export is the real context,
// whose `null` value the pane's own `useContext` reading already tolerates.
vi.mock('@/shared/context/WebSocketContext', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useWebSocket: () => ({ subscribe: () => () => undefined, isConnected: true }),
  };
});

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({ markSessionProcessing: () => undefined, markSessionIdle: () => undefined }),
}));

vi.mock('@/modules/chat/hooks/useSessionStore', () => ({
  useSessionStore: () => ({}),
}));

vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({
  useChatRealtimeHandlers: () => undefined,
}));

vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: () => undefined }),
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useResidentProviders: () => new Set<string>(),
}));

vi.mock('@/shared/selectedProvider', () => ({
  readSelectedProvider: () => 'claude',
}));

vi.mock('@/shared/hooks/useSessionHosts', () => ({
  useSessionHosts: () => ({ snapshot: { hosts: [], sessions: [] } }),
  findSessionHostState: () => null,
  findSessionOccupancy: () => null,
}));

// The one read the criterion is about: `forkSession` is doubled so it can record
// what it was handed instead of reaching the network. The rest of the module is
// left real (partial mock) — the reply rows mount the speak control, which asks
// the same module for `voiceConfigSignature`, and a whole-module replacement
// would have to keep re-listing every export the transcript happens to touch.
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const realApi = (actual.api ?? {}) as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...realApi,
      forkSession: async (sessionId: string, body: { upToAnchorId?: string } = {}) => {
        state.forkCalls.push({ sessionId, body });
        return { ok: true, status: 200, json: async () => ({ data: { sessionId: 'forked-session' } }) };
      },
    },
  };
});

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  voiceDebugFlushSilenceSec: () => undefined,
}));

vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: 'claude',
    setProvider: () => undefined,
    providerModels: { claude: 'claude-sonnet-4-5' },
    setStoredProviderModel: () => undefined,
    currentProviderEffort: 'medium',
    currentProviderEffortOptions: [{ value: 'medium' }],
    currentProviderModel: 'claude-sonnet-4-5',
    currentProviderModelOptions: [{ value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }],
    permissionMode: 'default',
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => undefined,
    availablePermissionModes: ['default'],
    selectPermissionMode: () => undefined,
    cyclePermissionMode: () => undefined,
    providerModelCatalog: {},
    providerModelsLoading: false,
    providerModelActions: {},
    selectProviderModel: async () => undefined,
    selectProviderEffort: async () => undefined,
    resolvePermissionModeForProvider: () => 'default',
    // Both capabilities are on: the fork button's presence below is the anchor's
    // doing, never the provider's.
    supportsMessageEditing: true,
    supportsSessionForking: true,
  }),
}));

vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: VISIBLE_MESSAGES,
    addMessage: () => undefined,
    markUserTurnUndelivered: () => undefined,
    restoreUserTurn: () => undefined,
    sessionActivity: null,
    isProcessing: state.isProcessing,
    canAbortSession: state.isProcessing,
    currentSessionId: SESSION_ID,
    setCurrentSessionId: () => undefined,
    isLoadingSessionMessages: false,
    isLoadingMoreMessages: false,
    hasMoreMessages: false,
    totalMessages: VISIBLE_MESSAGES.length,
    isUserScrolledUp: false,
    setIsUserScrolledUp: () => undefined,
    tokenBudget: null,
    setTokenBudget: () => undefined,
    visibleMessageCount: VISIBLE_MESSAGES.length,
    visibleMessages: VISIBLE_MESSAGES,
    loadEarlierMessages: () => undefined,
    loadAllMessages: () => undefined,
    loadFullTranscript: async () => [],
    allMessagesLoaded: true,
    isLoadingAllMessages: false,
    loadAllJustFinished: false,
    showLoadAllOverlay: false,
    createDiff: () => [],
    scrollContainerRef: { current: null },
    scrollContentRef: null,
    scrollToBottom: () => undefined,
    scrollToBottomAndReset: () => undefined,
    handleScroll: () => undefined,
    requestLatestMessages: async () => undefined,
  }),
}));

vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({
    input: '',
    setInput: () => undefined,
    textareaRef: { current: null },
    inputHighlightRef: { current: null },
    isTextareaExpanded: false,
    slashCommandsCount: 0,
    filteredCommands: [],
    frequentCommands: [],
    commandQuery: '',
    showCommandMenu: false,
    selectedCommandIndex: 0,
    resetCommandMenuState: () => undefined,
    handleCommandSelect: () => undefined,
    handleToggleCommandMenu: () => undefined,
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    renderInputWithMentions: () => null,
    selectFile: () => undefined,
    attachedFiles: [],
    setAttachedFiles: () => undefined,
    fileErrors: new Map<string, string>(),
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    openAttachmentPicker: () => undefined,
    handleSubmit: () => undefined,
    queuedDraft: null,
    editQueuedDraft: () => undefined,
    deleteQueuedDraft: () => undefined,
    handleVoiceTranscript: () => undefined,
    handleInputChange: () => undefined,
    handleKeyDown: () => undefined,
    handlePaste: () => undefined,
    handleTextareaClick: () => undefined,
    handleTextareaInput: () => undefined,
    syncInputOverlayScroll: () => undefined,
    handleClearInput: () => undefined,
    handleAbortSession: () => undefined,
    handlePermissionDecision: () => undefined,
    handleGrantToolPermission: () => ({ success: true }),
    handleInputFocusChange: () => undefined,
    commandModalPayload: null,
    closeCommandModal: () => undefined,
    showCostModal: () => undefined,
    editingAnchorId: null,
    beginEditMessage: () => undefined,
    cancelEditMessage: () => undefined,
    draftScope: SESSION_ID,
    sendFailed: false,
  }),
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

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

beforeEach(() => {
  installMatchMedia();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
  state.isProcessing = false;
  state.forkCalls = [];
});

const renderInterface = () =>
  render(
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={SESSION}
      ws={null}
      sendMessage={() => undefined}
    />,
  );

/* ─── Readings off the mounted tree ──────────────────────────────────────── */

/**
 * The one transcript row carrying a piece of text.
 *
 * Rows are told apart by their content, not by position: the reading below is
 * about *which* row holds the control, so the row must be the one that says the
 * thing, or a reordering could hand the assertion to the wrong row.
 */
const rowFor = (container: HTMLElement, marker: string): HTMLElement | null =>
  [...container.querySelectorAll<HTMLElement>('.chat-message')].find((row) =>
    (row.textContent ?? '').includes(marker),
  ) ?? null;

const forkButton = (row: HTMLElement | null) =>
  row?.querySelector('button[aria-label="Fork from here"]') ?? null;

const editButton = (row: HTMLElement | null) =>
  row?.querySelector('button[aria-label="Edit and resend"]') ?? null;

/* ─── The reading ────────────────────────────────────────────────────────── */

test('the fork control lives on the turn-ending answer, nowhere else, and calls the API with its anchor', () => {
  const view = renderInterface();

  const answerRow = rowFor(view.container, 'first answer');
  const promptRow = rowFor(view.container, 'first question');
  const narrationRow = rowFor(view.container, 'let me check.');

  // Premise: all three rows are really on screen. Without this, an absent button
  // below would read the same against a row that never rendered.
  assert.ok(answerRow, `premise: the answer row must be drawn; DOM: ${view.container.innerHTML.slice(0, 600)}`);
  assert.ok(promptRow, 'premise: the prompt row must be drawn');
  assert.ok(narrationRow, 'premise: the mid-turn narration row must be drawn');

  // The anchored answer: the control, on the reply that ends the turn.
  assert.ok(
    forkButton(answerRow),
    `the turn-ending answer must offer the fork control; answer row DOM: ${answerRow.innerHTML.slice(0, 400)}`,
  );

  // A reply with no anchor: no control. This is the half that fails if the
  // button is keyed on "is an assistant text row" rather than on the anchor.
  // `assert.ok(x === null)` rather than `assert.equal(x, null)`: a failing
  // `assert.equal` hands the DOM node to the reporter as `actual`, and
  // serializing a React-rendered element walks its fiber tree — the run does not
  // fail, it grows to tens of gigabytes and the worker dies with `Channel
  // closed`. The boolean form asserts the identical thing and fails legibly.
  assert.ok(
    forkButton(narrationRow) === null,
    `an assistant reply that does not end a turn must offer no fork control; narration row DOM: ${narrationRow.innerHTML.slice(0, 400)}`,
  );

  // The user's prompt: no fork control, and its own control untouched.
  assert.ok(
    forkButton(promptRow) === null,
    `the user prompt must offer no fork control; prompt row DOM: ${promptRow.innerHTML.slice(0, 400)}`,
  );
  assert.ok(
    editButton(promptRow),
    'the prompt must keep its edit-and-resend control — the fork control moving off the answer must not take this with it',
  );

  // Pressing it hands the session and the answer's own anchor to the API.
  fireEvent.click(forkButton(answerRow) as HTMLElement);
  assert.deepEqual(
    state.forkCalls,
    [{ sessionId: SESSION_ID, body: { upToAnchorId: FORK_ANCHOR } }],
    'the fork must be addressed to the session and cut at the answer it was pressed from',
  );

  view.unmount();
});

test('the fork control is absent while the session is still producing output', () => {
  state.isProcessing = true;
  const view = renderInterface();

  const answerRow = rowFor(view.container, 'first answer');
  assert.ok(answerRow, `premise: the answer row must be drawn; DOM: ${view.container.innerHTML.slice(0, 600)}`);
  assert.ok(
    forkButton(answerRow) === null,
    `a reply on a running turn must offer no fork control; answer row DOM: ${answerRow.innerHTML.slice(0, 400)}`,
  );

  // The control arm: the same row, once the turn is over, carries the button.
  // Without this the reading above would also pass against a row that can never
  // draw one.
  state.isProcessing = false;
  view.rerender(
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={SESSION}
      ws={null}
      sendMessage={() => undefined}
    />,
  );
  const settledRow = rowFor(view.container, 'first answer');
  assert.ok(
    forkButton(settledRow),
    'once the turn ends, the same answer offers the fork control — so the absence was the running state, not a row that cannot draw it',
  );

  view.unmount();
});
