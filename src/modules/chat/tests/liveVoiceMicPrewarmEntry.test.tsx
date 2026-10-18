import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * (this task) AC2 — the Live Voice tap PRE-WARMS the microphone before the session allocation can
 * resolve, and before capture is started when a session already exists.
 *
 * THE CLAIM. The first `Connecting voice…` window used to start the microphone only after the
 * session id existed and voice mode's effect called `startVoiceCapture()`. Everything said in
 * that window was produced by a microphone that was not yet collecting. The entry now calls
 * `warmMicrophoneSource()` on the tap itself, in parallel with whatever else the entry has to do
 * (for a brand-new conversation, the session allocation).
 *
 * WHY THE ALLOCATION IS A DEFERRED PROMISE. "Before the allocation resolves" is only observable if
 * the allocation has NOT resolved yet: the gateway answer is held open, the tap is performed, and
 * the reading is taken while the handler is still awaiting it. A gateway that answered in a
 * microtask would report the same call ORDER without proving that the warm ran in the pending
 * window.
 *
 * The cases render the REAL `ChatInterface` at a desktop width, with the hook-level doubles this
 * suite already uses (`liveVoiceNewSessionEntry.test.tsx`): `ChatComposer` and
 * `VoiceRealtimeBar` are the real components, while the voice hook, the API and the microphone
 * warm-up are recorded so their order can be read off one log.
 */

const PROJECT: Project = {
  projectId: 'project-live-voice',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const EXISTING_SESSION: ProjectSession = { id: 'session-existing' };
const NEW_SESSION_ID = 'server-minted-live-voice-session';
const DESKTOP_WIDTH = 1280;

/** Mutable state the doubles read and write: one flat ordered log is the criterion. */
const state = vi.hoisted(() => ({
  openSessionId: null as string | null,
  /**
   * The calls the entry can make, in the order they left the page. The criterion is positional:
   * `warm` must appear before `createSession` (and before capture starts), not merely at all.
   */
  requestLog: [] as string[],
  createSessionCalls: 0,
  warmCalls: 0,
  releaseCalls: 0,
  startCalls: 0,
  endCalls: 0,
  /** Resolves the deferred allocation; `null` until the entry reached the gateway. */
  resolveCreate: null as null | (() => void),
}));

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
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
  useResidentProviders: () => new Set<string>(['claude']),
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
    forkSession: async () => ({ ok: true, json: async () => ({ data: { sessionId: NEW_SESSION_ID } }) }),
    commands: { list: async () => ({ ok: true, json: async () => ({ commands: [] }) }) },
    providers: {
      // The session gateway call the brand-new entry makes. Held open so "the warm ran while the
      // allocation was still pending" is a reading, not an inference from call order alone.
      createSession: () => {
        state.createSessionCalls += 1;
        state.requestLog.push('createSession');
        return new Promise((resolve) => {
          state.resolveCreate = () => {
            resolve({
              ok: true,
              status: 201,
              json: async () => ({
                success: true,
                data: { sessionId: NEW_SESSION_ID, sessionName: 'live voice prewarm chat' },
              }),
            });
          };
        });
      },
      setSessionLifecycleMode: () =>
        Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) }),
    },
  },
}));

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  voiceDebugFlushSilenceSec: () => undefined,
}));

/**
 * The voice module is replaced only where it would reach the network or a browser microphone:
 * the hook and the warm-up entry. One stable stub object so the pane's "capture starts from the
 * moment the mode is entered" effect does not re-run on every render.
 */
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
    start: () => {
      state.startCalls += 1;
      state.requestLog.push('startVoiceCapture');
    },
    startWithFile: () => undefined,
    mute: () => undefined,
    unmute: () => undefined,
    end: () => {
      state.endCalls += 1;
    },
  };
  return {
    ...actual,
    // The warm-up under test: recorded in the same ordered log as the allocation and the capture
    // start, so the criterion is read off one sequence.
    warmMicrophoneSource: () => {
      state.warmCalls += 1;
      state.requestLog.push('warm');
      return Promise.resolve();
    },
    releaseWarmMicrophoneSource: () => {
      state.releaseCalls += 1;
    },
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

// Stateful, so `handleSessionEstablished`'s `setCurrentSessionId` really moves the pane onto the
// allocated id — that is the transition into voice mode the entry depends on.
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => {
    const [currentSessionId, setCurrentSessionId] = React.useState<string | null>(state.openSessionId);
    return {
      chatMessages: [],
      addMessage: () => undefined,
      markUserTurnUndelivered: () => undefined,
      restoreUserTurn: () => undefined,
      sessionActivity: { statusText: '', canInterrupt: false, startedAt: 0 },
      isProcessing: false,
      canAbortSession: false,
      currentSessionId,
      setCurrentSessionId: (id: string) => {
        state.openSessionId = id;
        setCurrentSessionId(id);
      },
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
      jumpToMessage: () => undefined,
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
  state.openSessionId = null;
  state.requestLog = [];
  state.createSessionCalls = 0;
  state.warmCalls = 0;
  state.releaseCalls = 0;
  state.startCalls = 0;
  state.endCalls = 0;
  state.resolveCreate = null;
});

const renderInterface = (selectedSession: ProjectSession | null) =>
  render(
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={selectedSession}
      ws={null}
      sendMessage={() => undefined}
    />,
  );

/** One tap on the Live Voice entry, with the async handler's microtasks flushed. */
const tapLiveVoice = async (view: ReturnType<typeof renderInterface>) => {
  await act(async () => {
    fireEvent.click(view.getByTestId('live-voice-button'));
  });
};

test('AC2a 全新会话：预热在 createChatSession resolve 之前发起', async () => {
  const view = renderInterface(null);

  await tapLiveVoice(view);

  // Premise: the entry really reached the gateway, and that gateway answer is STILL PENDING — the
  // reading below is therefore taken inside the allocation window, not after it.
  assert.ok(state.resolveCreate, 'premise: the entry must have reached the session allocation gateway');
  assert.deepEqual(
    state.requestLog,
    ['warm', 'createSession'],
    `the warm-up must be issued by the tap, before the pending allocation; the page made: ${JSON.stringify(state.requestLog)}`,
  );
  assert.equal(state.warmCalls, 1, `exactly one warm-up per tap; made ${state.warmCalls}`);

  // Let the allocation answer, so the pane reaches voice mode and this case leaves nothing pending.
  await act(async () => {
    state.resolveCreate!();
  });
  await waitFor(() => {
    assert.ok(
      view.queryByTestId('voice-realtime-bar'),
      `the successful allocation must still enter voice mode; DOM: ${view.container.innerHTML.slice(0, 400)}`,
    );
  });

  view.unmount();
});

test('AC2b 已有会话：点按钮先预热，再开始采集', async () => {
  const view = renderInterface(EXISTING_SESSION);

  assert.equal(view.queryByTestId('voice-realtime-bar'), null, 'premise: the text composer is showing');

  await tapLiveVoice(view);

  await waitFor(() => {
    assert.ok(
      view.queryByTestId('voice-realtime-bar'),
      `an open conversation must enter voice mode directly; DOM: ${view.container.innerHTML.slice(0, 400)}`,
    );
  });

  assert.equal(
    state.createSessionCalls,
    0,
    'premise: an existing conversation has an id, so the tap allocates nothing',
  );
  assert.deepEqual(
    state.requestLog,
    ['warm', 'startVoiceCapture'],
    `an existing session must warm the microphone on the tap, before capture starts; the page made: ${JSON.stringify(state.requestLog)}`,
  );

  view.unmount();
});
