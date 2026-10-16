import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { Project, SessionActivity } from '@/shared/types';

/**
 * Escape stops the turn, with no floating tab in the picture.
 *
 * The Escape handler is ChatInterface's own document-level capture listener, armed
 * while `canAbortSession` is true. It used to be one of two stop entries on the
 * desktop — the other lived on the activity tab the composer hung over the
 * transcript — and the tab is gone now: the composer's submit button is the one
 * stop entry at every viewport, and the key is named on its tooltip.
 *
 * This case renders the real ChatInterface (not a stand-in for its listener) at a
 * desktop width with a running turn on screen, asserts the page carries no tab,
 * and then presses Escape twice: once while the turn can be aborted, and once
 * after `canAbortSession` has gone false. The listener's behaviour is unchanged by
 * this task; the case exists so a later change to the composer's stop surface
 * cannot quietly take the key with it.
 *
 * ChatInterface wires a websocket, session, provider and composer state that would
 * each reach the network here; the hook-level doubles below hand it their answers
 * directly. The two components under it — ChatComposer and ChatMessagesPane — are
 * the real ones, so the absence of a tab is read off real markup.
 */

const SESSION_ID = 'session-escape';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const DESKTOP_WIDTH = 1280;

const PROJECT: Project = {
  projectId: 'project-escape',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const ACTIVITY: SessionActivity = { statusText: 'Reviewing', canInterrupt: true, startedAt: START };

/** Mutable state the doubles read, so one case can flip `canAbortSession` between arms. */
const state = vi.hoisted(() => ({ canAbortSession: true, aborts: 0 }));

/**
 * The composer's textarea ref, hoisted so the double hands ChatInterface the *same* object on every
 * render: a fresh `{ current: null }` per render would have the real ChatComposer detach and
 * reattach its ref, and the guard now reads focus off this node before it claims the key.
 */
const composerRef = vi.hoisted(() => ({ textarea: { current: null as HTMLTextAreaElement | null } }));

// The pane is active here, so it renders the Live Voice entry control
// (`live-voice-enter`) beside the composer; both read the auth context for a
// token. This case renders no `AuthProvider` (the app supplies one above
// `ChatInterface`), so hand the hook a tokenless context — the Escape abort
// path is the thing under test, not voice.
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
}));

// Only `useWebSocket` is doubled: the module's default export is the real context,
// whose `null` value the dock's own `useContext` reading already tolerates.
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

vi.mock('@/shared/api', () => ({
  api: {
    forkSession: async () => ({ ok: true, json: async () => ({ data: { sessionId: SESSION_ID } }) }),
    commands: { list: async () => ({ ok: true, json: async () => ({ commands: [] }) }) },
  },
}));

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default: keeps this whole-module replacement complete.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
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
    supportsMessageEditing: true,
    supportsSessionForking: true,
  }),
}));

vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
    addMessage: () => undefined,
    markUserTurnUndelivered: () => undefined,
    restoreUserTurn: () => undefined,
    sessionActivity: ACTIVITY,
    isProcessing: true,
    canAbortSession: state.canAbortSession,
    currentSessionId: SESSION_ID,
    setCurrentSessionId: () => undefined,
    isLoadingSessionMessages: false,
    isLoadingMoreMessages: false,
    hasMoreMessages: false,
    totalMessages: 0,
    isUserScrolledUp: false,
    setIsUserScrolledUp: () => undefined,
    tokenBudget: null,
    setTokenBudget: () => undefined,
    visibleMessageCount: 0,
    visibleMessages: [],
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
    textareaRef: composerRef.textarea,
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
    handleAbortSession: () => {
      state.aborts += 1;
    },
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
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: DESKTOP_WIDTH });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
  state.canAbortSession = true;
  state.aborts = 0;
});

const renderInterface = () =>
  render(
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={null}
      ws={null}
      sendMessage={() => undefined}
    />,
  );

test('desktop: Escape aborts once while the turn can be aborted, and not at all once it cannot', () => {
  const view = renderInterface();

  // Premise: the turn is on screen and it is the pane's in-flow line, not a tab.
  // Without this the "no tab" reading below would pass for a page that never drew
  // the turn at all.
  assert.ok(
    view.container.querySelector('.chat-messages-pane [data-activity-dock]') !== null,
    `premise: the running turn must be drawn as the pane's status line; DOM: ${view.container.innerHTML.slice(0, 500)}`,
  );
  const shell = view.container.querySelector('.chat-composer-shell');
  assert.ok(shell, 'premise: the composer must render');
  assert.equal(
    shell.querySelectorAll('[data-activity-dock]').length,
    0,
    `the composer must draw no floating tab; DOM: ${shell.innerHTML.slice(0, 400)}`,
  );

  // The added prerequisite, and the only change to this case: the handler now claims Escape only
  // where the composer is, so put focus in its textarea before pressing the key. The key itself
  // still lands on the document, as it always did.
  const textarea = view.container.querySelector('textarea');
  assert.ok(textarea, 'premise: the real composer must draw its textarea');
  textarea.focus();
  assert.equal(document.activeElement, textarea, 'premise: focus must be in the composer textarea');

  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(
    state.aborts,
    1,
    `Escape must reach the abort handler exactly once; it reached it ${state.aborts} time(s)`,
  );

  view.unmount();

  // The control arm: with nothing to abort, the same key reaches nothing.
  state.canAbortSession = false;
  const idle = renderInterface();
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(
    state.aborts,
    1,
    `Escape must not reach the abort handler once the turn cannot be aborted; it reached it ${state.aborts} time(s)`,
  );
  idle.unmount();
});
