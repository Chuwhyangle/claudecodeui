import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import {
  consumePendingLocateRequest,
  requestLocateMessage,
} from '@/shared/chatMessageLocator';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * The chat half of the "locate this message" seam.
 *
 * The architecture inspector asks the shared locator to centre a transcript
 * message. `WorkspaceMain` keeps the chat pane MOUNTED but hidden behind the
 * architecture tab, so the pane must not scroll a hidden transcript: it
 * consumes the request only once `isActive` is true. A request that names a
 * message the transcript does not have must say so instead of failing
 * silently.
 *
 * The real `ChatInterface` is rendered; the session-state hook (which owns
 * `jumpToMessage`) and the network-facing hooks are the doubles. This is the
 * same seam `liveVoiceMicPrewarmEntry.test.tsx` uses.
 */

const PROJECT: Project = {
  projectId: 'project-locate',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const SESSION: ProjectSession = { id: 'session-locate' };

const state = vi.hoisted(() => ({
  jumpToMessage: vi.fn(),
}));

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
  NextTaskBanner: () => null,
}));

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
    commands: { list: async () => ({ ok: true, json: async () => ({ commands: [] }) }) },
  },
}));

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

vi.mock('@/modules/chat/voice-realtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const stub = {
    phase: 'idle',
    error: null,
    unansweredSeconds: null,
    captions: [],
    deliveries: [],
    delivering: false,
    queuedDepth: 0,
    refusal: null,
    levelRef: { current: 0 },
    connectedAt: null,
    disconnected: false,
    reconnecting: null,
    closedUnshown: 0,
    unrecognizedSeqs: [],
    segmentOutcomes: [],
    pendingMessage: '',
    start: () => undefined,
    startWithFile: () => undefined,
    mute: () => undefined,
    unmute: () => undefined,
    end: () => undefined,
  };
  return {
    ...actual,
    warmMicrophoneSource: () => Promise.resolve(),
    releaseWarmMicrophoneSource: () => undefined,
    useVoiceRealtimeSession: () => stub,
  };
});

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

/**
 * The session-state hook is the placement owner: `jumpToMessage` is the ONE
 * entry that centres a message. The double records every request so the
 * criterion reads its call count and argument directly.
 */
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => {
    const [currentSessionId, setCurrentSessionId] = React.useState<string | null>(SESSION.id);
    return {
      chatMessages: [],
      addMessage: () => undefined,
      markUserTurnUndelivered: () => undefined,
      restoreUserTurn: () => undefined,
      sessionActivity: { statusText: '', canInterrupt: false, startedAt: 0 },
      isProcessing: false,
      canAbortSession: false,
      currentSessionId,
      setCurrentSessionId,
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
      jumpToMessage: state.jumpToMessage,
    };
  },
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
    draftScope: null,
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

beforeEach(() => {
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
  state.jumpToMessage.mockReset();
  state.jumpToMessage.mockResolvedValue(true);
  consumePendingLocateRequest();
});

function renderInterface(isActive: boolean) {
  return render(
    <ChatInterface
      isActive={isActive}
      selectedProject={PROJECT}
      selectedSession={SESSION}
      ws={null}
      sendMessage={() => undefined}
    />,
  );
}

test('a locate request made while the chat is hidden waits until the tab is visible', async () => {
  const view = renderInterface(false);

  act(() => {
    requestLocateMessage('message-42');
  });
  // Give the (absent) jump a chance to run if the inactive guard were missing.
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(
    state.jumpToMessage.mock.calls.length,
    0,
    'a hidden chat must not centre a message it cannot show',
  );

  // Becoming visible consumes the pending request exactly once.
  view.rerender(
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={SESSION}
      ws={null}
      sendMessage={() => undefined}
    />,
  );
  await waitFor(() => {
    assert.deepEqual(state.jumpToMessage.mock.calls, [['message-42']]);
  });
  view.unmount();
});

test('a locate request made while visible is placed immediately', async () => {
  const view = renderInterface(true);

  act(() => {
    requestLocateMessage('message-77');
  });
  await waitFor(() => assert.deepEqual(state.jumpToMessage.mock.calls, [['message-77']]));
  view.unmount();
});

test('a locate request for a message that is not in the transcript says so', async () => {
  state.jumpToMessage.mockResolvedValue(false);
  const view = renderInterface(true);

  act(() => {
    requestLocateMessage('missing-message');
  });

  await waitFor(() => {
    const notice = document.querySelector('[data-chat-locate-notice]');
    assert.ok(notice !== null, 'a failed locate must not be silent');
    assert.equal(notice.getAttribute('data-chat-locate-notice'), 'missing-message');
    assert.match(notice.textContent ?? '', /No message with that id was found/);
  });
  view.unmount();
});
