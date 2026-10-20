import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * The Live Voice entry's session allocation carries the composer's selection.
 *
 * THE CLAIM. Entering Live Voice in a brand-new conversation allocates the session
 * through `POST /api/providers/sessions` (the same gateway the composer's first send
 * uses). That call used to state `{provider, projectPath}` and nothing else, while the
 * model/effort/permission-mode a person picked travelled only on a `chat.send` frame —
 * and the first turn of a voice conversation is the relay's `session_send`, which carries
 * no such option. The minted row therefore had no model, and the Claude runtime's
 * fresh-start fallback (`options.model || 'default'`) launched the child with the CLI's
 * account default: measured 2026-10-15, a session whose page showed `v4.1flash` ran
 * `--model default`, with no ANTHROPIC_* in its env at all — the host account was spent
 * instead of the model entry's gateway, and it died on that account's session limit.
 *
 * WHY THIS FILE, AND WHY THE FIRST ASSERTION IS THE FALSIFYING ONE. The criterion that
 * names this file runs it as the ONLY filter, so a green run is a reading of THIS file.
 * Its first assertion reads the allocation's payload, so the pre-fix entry — which sent
 * `{provider, projectPath}` — fails on the first line the run reports.
 *
 * The case renders the REAL `ChatInterface` (not a stand-in for its entry) at a desktop
 * width: the hook-level doubles below hand the pane the state it would otherwise reach
 * the network for, while the entry, `ChatComposer` and `VoiceRealtimeBar` are the real
 * components.
 */

const PROJECT: Project = {
  projectId: 'project-live-voice',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const NEW_SESSION_ID = 'server-minted-live-voice-session';
const DESKTOP_WIDTH = 1280;

/** Mutable state the doubles read: one case flips the gateway's answer or the open session. */
const state = vi.hoisted(() => ({
  openSessionId: null as string | null,
  createSessionMode: 'ok' as 'ok' | 'http500' | 'empty-id',
  /** Every `POST /api/providers/sessions` the page made, so "none was made" is checkable. */
  createSessionPayloads: [] as Array<Record<string, unknown>>,
  /**
   * The two gateway calls the entry can make, in the order they left the page.
   *
   * Order is the criterion, not just presence: the mode is a statement ABOUT a
   * session, so a write that travelled before the allocation would name an id
   * that did not exist yet. One flat log makes "after" checkable without
   * guessing at scheduling.
   */
  requestLog: [] as string[],
  /** Every `setSessionLifecycleMode` the page made, so "none was made" is checkable. */
  lifecycleCalls: [] as Array<{ provider: string; sessionId: string; mode: string }>,
  /**
   * When true, `setCurrentSessionId` records the id but does not move the pane
   * onto it, holding the brand-new empty state (and the switch on it) mounted.
   *
   * The switch only exists in the brand-new state — once a session row exists
   * the empty state is gone — so the only way to read the switch's post-write
   * position is to keep that state on screen. Production never holds it; this
   * is a reading instrument, not a behaviour.
   */
  freezeBrandNewState: false,
  startCalls: 0,
  endCalls: 0,
}));

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
  // ChatInterface hands this to the transcript's empty state; tasksEnabled is false above, so it
  // is never rendered. The real one reads TaskMasterContext, which these cases do not provide.
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
  // `claude` is a resident-capable provider, so the brand-new empty state draws
  // the resident switch these readings flip. With an empty set the switch never
  // rendered and the criteria below would be readings of nothing.
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
      // The session gateway call under test. Its answer is switched per case;
      // the payload is kept so a case can read what the entry actually asked for.
      createSession: (payload: Record<string, unknown>) => {
        state.createSessionPayloads.push(payload);
        state.requestLog.push('createSession');
        if (state.createSessionMode === 'http500') {
          return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
        }
        if (state.createSessionMode === 'empty-id') {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: async () => ({ success: true, data: { sessionId: '', sessionName: '' } }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ success: true, data: { sessionId: NEW_SESSION_ID, sessionName: 'live voice chat' } }),
        });
      },
      // The resident write the voice entry is now expected to make for a
      // brand-new session. Logged so both the call count and its position
      // relative to the allocation are checkable.
      setSessionLifecycleMode: (provider: string, sessionId: string, mode: string) => {
        state.lifecycleCalls.push({ provider, sessionId, mode });
        state.requestLog.push(`lifecycle:${provider}:${sessionId}:${mode}`);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
      },
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

// The real voice hook would open a WebSocket and reach for a microphone; the
// bar's rendering is what these cases read, so only the hook is replaced and the
// rest of the module (the bar itself) is the real one.
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
    // The graded per-segment outcomes (AC-367) are read by `ChatInterface`'s transcript gate, so a
    // hand-built session has to carry them or the gate throws on `undefined.length`.
    segmentOutcomes: [],
    // The ONE message the relay holds while busy (ruling 2026-10-14) is read on every render — the
    // bar's card takes `text.trim()` — so a hand-built session has to carry it or the card throws.
    // Empty is the honest value for a session that is not holding anything.
    pendingMessage: '',
    start: () => {
      state.startCalls += 1;
    },
    startWithFile: () => undefined,
    mute: () => undefined,
    unmute: () => undefined,
    end: () => {
      state.endCalls += 1;
    },
  };
  return { ...actual, useVoiceRealtimeSession: () => stub };
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

// Stateful, so `handleSessionEstablished`'s `setCurrentSessionId` really moves
// the pane onto the allocated id — that is the transition the entry depends on.
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
        if (state.freezeBrandNewState) return;
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
  state.createSessionMode = 'ok';
  state.createSessionPayloads = [];
  state.requestLog = [];
  state.lifecycleCalls = [];
  state.freezeBrandNewState = false;
  state.startCalls = 0;
  state.endCalls = 0;
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

test('the Live Voice entry states the new session\'s selection on the gateway call', async () => {
  const view = renderInterface(null);

  await tapLiveVoice(view);

  assert.equal(
    state.createSessionPayloads.length,
    1,
    `the voice entry allocates exactly one session through the gateway; it made ${state.createSessionPayloads.length} call(s)`,
  );

  // The falsifying assertion, first: the pre-fix payload was
  // `{provider, projectPath}`, so `model` was undefined and the minted row had no
  // selection for the first (relayed, options-less) turn to run with.
  // The three expectations below are the values the mocked `useChatProviderState`
  // hands the pane — one per composer-level selection the send path carries.
  assert.equal(
    state.createSessionPayloads[0].model,
    'claude-sonnet-4-5',
    `the allocation must carry the model the page shows; payload=${JSON.stringify(state.createSessionPayloads[0])}`,
  );
  assert.equal(state.createSessionPayloads[0].effort, 'medium');
  assert.equal(state.createSessionPayloads[0].permissionMode, 'default');
});
