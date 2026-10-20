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
 * The Live Voice entry in a brand-new conversation allocates the session first.
 *
 * THE CLAIM. A conversation with no session row yet has no id to bind a voice
 * connection to — the server keys `session_send` on that id — and the entry used
 * to answer such a tap with nothing but a notice ("send a message first"). That
 * made Live Voice unusable in the one conversation a reader most wants it in.
 * The entry now allocates a session through the same gateway the composer's
 * first send uses, enters voice mode on the id it returned, and keeps the notice
 * for what it is now: the visible reply to an allocation that FAILED.
 *
 * WHY THIS FILE, AND WHY THE FIRST ASSERTION IS THE FALSIFYING ONE. The
 * criterion that names this file runs it as the ONLY filter, so a green run is a
 * reading of THIS file and nothing else. Its first assertion reads the gateway
 * call count, so the pre-fix code — where the entry is disabled by
 * `!voiceSessionId` and therefore never reaches the gateway — fails on the first
 * line the run reports, not somewhere below it.
 *
 * The cases render the REAL `ChatInterface` (not a stand-in for its entry) at a
 * desktop width: the hook-level doubles below hand the pane the state it would
 * otherwise reach the network for, while `ChatComposer` and `VoiceRealtimeBar`
 * — what the readings are taken off — are the real components.
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

/** The resident switch the brand-new empty state draws, or `null` when it is not on screen. */
const residentSwitch = (view: ReturnType<typeof renderInterface>) =>
  view.container.querySelector('[data-resident-enable="true"]');

/** Flips the empty state's resident switch on, asserting it is there to flip. */
const enableResident = async (view: ReturnType<typeof renderInterface>) => {
  const toggle = residentSwitch(view);
  assert.ok(
    toggle,
    'the brand-new empty state must offer the resident switch, or these readings are of nothing',
  );
  await act(async () => {
    fireEvent.click(toggle);
  });
};

test('AC1 全新会话点 Live Voice：先分配会话、再进入语音，且没有 needsSession 通知', async () => {
  const view = renderInterface(null);

  await tapLiveVoice(view);

  // The falsifying assertion, first: the pre-fix entry was disabled by
  // `!voiceSessionId` and never reached the gateway, so it made ZERO calls here.
  assert.equal(
    state.createSessionPayloads.length,
    1,
    `a brand-new conversation's Live Voice entry must allocate exactly one session through the gateway; it made ${state.createSessionPayloads.length} call(s)`,
  );
  assert.equal(state.createSessionPayloads[0].provider, 'claude');
  assert.equal(state.createSessionPayloads[0].projectPath, '/repo');
  assert.equal(
    'initialMessage' in state.createSessionPayloads[0],
    false,
    'entering voice mode allocates a session; it does not send a message',
  );

  await waitFor(() => {
    assert.ok(
      view.queryByTestId('voice-realtime-bar'),
      `the voice bar must appear once the session is allocated; DOM: ${view.container.innerHTML.slice(0, 400)}`,
    );
  });

  assert.equal(
    view.queryByTestId('live-voice-notice'),
    null,
    'the successful path must not leave the needsSession notice on screen',
  );
  assert.ok(
    !view.container.textContent?.includes('Send a message first'),
    'the needsSession copy must not appear when the entry succeeded',
  );

  view.unmount();
});

test('AC2 已有会话点 Live Voice：零分配，直接进入语音', async () => {
  const view = renderInterface(EXISTING_SESSION);

  assert.equal(view.queryByTestId('voice-realtime-bar'), null, 'premise: the text composer is showing');

  await tapLiveVoice(view);

  assert.equal(
    state.createSessionPayloads.length,
    0,
    'an open conversation already has an id; the entry must not allocate another session',
  );
  await waitFor(() => {
    assert.ok(
      view.queryByTestId('voice-realtime-bar'),
      `the existing conversation must enter voice mode directly; DOM: ${view.container.innerHTML.slice(0, 400)}`,
    );
  });

  view.unmount();
});

test('AC3a 分配失败（网关 500）：不进入语音、控件仍可点、可见通知', async () => {
  state.createSessionMode = 'http500';
  const view = renderInterface(null);

  await tapLiveVoice(view);

  assert.equal(state.createSessionPayloads.length, 1, 'the failed path still made the allocation attempt');
  assert.equal(
    view.queryByTestId('voice-realtime-bar'),
    null,
    'a failed allocation must not enter voice mode',
  );

  const button = view.getByTestId('live-voice-button');
  assert.equal(
    button.getAttribute('aria-disabled'),
    null,
    'the entry stays tappable after a failure so the reader can try again',
  );

  const notices = view.queryAllByTestId('live-voice-notice');
  assert.equal(notices.length, 1, `exactly one visible notice; found ${notices.length}`);
  assert.ok(
    notices[0].textContent?.includes('Send a message first'),
    `the notice must carry the needsSession copy; got: ${notices[0].textContent}`,
  );

  view.unmount();
});

test('AC3b 分配失败（2xx 但 sessionId 为空）：不进入语音、控件仍可点、可见通知', async () => {
  state.createSessionMode = 'empty-id';
  const view = renderInterface(null);

  await tapLiveVoice(view);

  assert.equal(state.createSessionPayloads.length, 1, 'the empty-id path still made the allocation attempt');
  assert.equal(
    view.queryByTestId('voice-realtime-bar'),
    null,
    'a 2xx response without a session id must not enter voice mode',
  );

  const button = view.getByTestId('live-voice-button');
  assert.equal(
    button.getAttribute('aria-disabled'),
    null,
    'the entry stays tappable after a failure so the reader can try again',
  );

  const notices = view.queryAllByTestId('live-voice-notice');
  assert.equal(notices.length, 1, `exactly one visible notice; found ${notices.length}`);
  assert.ok(
    notices[0].textContent?.includes('Send a message first'),
    `the notice must carry the needsSession copy; got: ${notices[0].textContent}`,
  );

  view.unmount();
});

/**
 * The resident intent the empty-state switch sets has to reach the Live Voice
 * entry the same way it reaches the composer's first send.
 *
 * The switch's position is the frontend's only statement of "the session this
 * next step creates should be resident", and the entry allocates that session
 * itself. The composer path already reads the switch inside its new-session
 * branch and writes the mode through `setSessionLifecycleMode` before the turn
 * starts; these cases hold the voice entry to the same shape. The write has to
 * be a SEPARATE call that lands AFTER the allocation — the mode names an id the
 * allocation mints — and it must happen before the voice connection (which is
 * itself a turn the server refuses a mode change during) opens.
 */

test('AC1 全新会话 + resident 开：POST 分配之后才写 resident，且进入语音', async () => {
  const view = renderInterface(null);

  await enableResident(view);

  await tapLiveVoice(view);

  assert.equal(state.createSessionPayloads.length, 1, 'the entry allocates exactly one session');
  assert.deepEqual(
    state.requestLog,
    ['createSession', `lifecycle:claude:${NEW_SESSION_ID}:resident`],
    `the resident write must be a separate call that lands AFTER the allocation; the page made: ${JSON.stringify(state.requestLog)}`,
  );
  assert.deepEqual(
    state.lifecycleCalls,
    [{ provider: 'claude', sessionId: NEW_SESSION_ID, mode: 'resident' }],
    'the write must name the id the gateway just minted and the resident mode',
  );

  await waitFor(() => {
    assert.ok(
      view.queryByTestId('voice-realtime-bar'),
      `voice mode must still be entered after the resident write; DOM: ${view.container.innerHTML.slice(0, 400)}`,
    );
  });

  view.unmount();
});

test('AC2 正控制——开关为关时同一条流程不得出现任何 setSessionLifecycleMode 调用', async () => {
  const view = renderInterface(null);

  assert.equal(
    residentSwitch(view)?.getAttribute('aria-checked'),
    'false',
    'premise: the switch starts off, so the intent is not set',
  );

  await tapLiveVoice(view);

  assert.equal(state.createSessionPayloads.length, 1, 'the off-switch path still allocates');
  assert.equal(
    state.lifecycleCalls.length,
    0,
    'with no resident intent there is nothing to write; the entry must not convert the session on its own',
  );

  await waitFor(() => {
    assert.ok(view.queryByTestId('voice-realtime-bar'), 'voice mode is entered either way');
  });

  view.unmount();
});

test('AC3 已有会话（voiceSessionId 非空）点 Live Voice 不得出现任何 setSessionLifecycleMode 调用', async () => {
  const view = renderInterface(EXISTING_SESSION);

  await tapLiveVoice(view);

  assert.equal(state.createSessionPayloads.length, 0, 'an open conversation already has an id');
  assert.equal(
    state.lifecycleCalls.length,
    0,
    'the intent belongs to a brand-new session only; the entry must not convert a session the user merely opened',
  );

  await waitFor(() => {
    assert.ok(view.queryByTestId('voice-realtime-bar'), 'the open conversation enters voice mode directly');
  });

  view.unmount();
});

test('AC4 意图消费：resident 写入之后开关回到关', async () => {
  // The switch lives only in the brand-new empty state, and the allocation
  // normally replaces that state with the (empty) session's own view — so the
  // switch's post-write position can only be read while that state is held
  // mounted. Holding it is a reading instrument: the write and its ordering are
  // exactly the shipping ones, asserted above.
  state.freezeBrandNewState = true;
  const view = renderInterface(null);

  await enableResident(view);
  assert.equal(
    residentSwitch(view)?.getAttribute('aria-checked'),
    'true',
    'premise: the user set the intent by flipping the switch on',
  );

  await tapLiveVoice(view);

  assert.deepEqual(
    state.requestLog,
    ['createSession', `lifecycle:claude:${NEW_SESSION_ID}:resident`],
    'the write still happened, so the reading below is not of a no-op path',
  );
  assert.equal(
    residentSwitch(view)?.getAttribute('aria-checked'),
    'false',
    'the intent has been spent on the session it was set for; a stale "on" would be drawn on the next New Session',
  );

  view.unmount();
});
