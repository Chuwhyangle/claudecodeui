import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { PendingPermissionRequest, Project, ProjectSession } from '@/shared/types';

/**
 * A pending AskUserQuestion stays ANSWERABLE while Live Voice is active.
 *
 * THE CLAIM. Entering Live Voice replaces the whole composer subtree with
 * `VoiceRealtimeBar` (AC-316's mutually-exclusive swap), and the strip that
 * renders the only answerable surface — `PermissionRequestsBanner`, which
 * registers `AskUserQuestionPanel` — lived inside `ChatComposer` alone. So the
 * moment voice mode came on, the pending prompt was on screen in the transcript
 * as a read-only record while nothing on it could be clicked. A spoken turn
 * reported exactly that ("I can see the dialog but I cannot press it") and the
 * question was recorded Skipped. The banner is now drawn above the bar; answering
 * there runs the ordinary decision path and neither leaves voice mode nor
 * reconnects the voice link.
 *
 * WHY THIS FILE. AC-316's swap is a real behaviour and the fix has to keep it:
 * the composer textarea must be gone in voice mode (that is the falsifying half),
 * and the panel must still be present (the claim). Both are read against the REAL
 * `ChatInterface` — the hook doubles below hand the pane the network state it
 * would otherwise fetch, while `ChatComposer`, `VoiceRealtimeBar`,
 * `PermissionRequestsBanner` and `AskUserQuestionPanel` are the shipping code.
 *
 * WHY THE REQUEST ARRIVES AFTER THE ENTRY. The composer hides its own input row
 * (Live Voice entry included) while an AskUserQuestion is pending, so the prompt
 * that has to stay answerable cannot be on screen before voice mode is entered:
 * it lands over the socket DURING a voice session, which is exactly the reported
 * shape ("I can see the dialog but cannot press it"). The cases below therefore
 * enter voice first and deliver the request into the live mode.
 *
 * TWO SEPARATE CASES. The first reads the answerable surface and the decision
 * payload; the second reads that answering did not disturb the connection. They
 * fail for different reasons, so they are kept apart rather than merged.
 */

const PROJECT: Project = {
  projectId: 'project-voice-banner',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const EXISTING_SESSION: ProjectSession = { id: 'session-voice-banner' };
const DESKTOP_WIDTH = 1280;

/** The one question the panel asks, and the option this file selects. */
const QUESTION = 'Which approach should this change take?';
const OPTION_LABEL = 'Narrow the change';

/**
 * The pending AskUserQuestion, shaped the way the server sends one: a
 * `permission_request` for `AskUserQuestion`, whose `input.questions` is what the
 * registered panel renders.
 */
const ASK_REQUEST: PendingPermissionRequest = {
  requestId: 'req-voice-banner-1',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: QUESTION,
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: OPTION_LABEL, description: 'Touch only the surface that misbehaves.' },
          { label: 'Widen the change', description: 'Also rework the surrounding composer rows.' },
        ],
      },
    ],
  },
};

/** One decision the panel handed the pane, kept so a case can read its payload. */
type RecordedDecision = {
  requestIds: string | string[];
  decision: { allow?: boolean; message?: string; rememberedEntry?: unknown; updatedInput?: unknown };
};

/**
 * Mutable state the doubles read and write.
 *
 * `pending` is lifted here so the two mocked hooks can share it: the provider
 * hook owns the array (as the real one does), and the composer hook's decision
 * handler removes the answered request from it — which is what makes the banner
 * disappear the way it does in the app.
 */
const state = vi.hoisted(() => ({
  pending: [] as PendingPermissionRequest[],
  setPending: null as null | React.Dispatch<React.SetStateAction<PendingPermissionRequest[]>>,
  decisions: [] as RecordedDecision[],
  grantCalls: [] as Array<{ entry: string; toolName: string }>,
  startCalls: 0,
  endCalls: 0,
  /** Fixed so the bar's elapsed clock reads the same before and after an answer. */
  connectedAt: Date.now() - 5_000,
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
    forkSession: async () => ({ ok: true, json: async () => ({ data: { sessionId: 'forked' } }) }),
    commands: { list: async () => ({ ok: true, json: async () => ({ commands: [] }) }) },
    providers: {
      createSession: async () => ({
        ok: true,
        status: 201,
        json: async () => ({ success: true, data: { sessionId: 'allocated', sessionName: 'x' } }),
      }),
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

// The real voice hook would open a WebSocket and reach for a microphone; the bar
// and its banner are what these cases read, so only the hook is replaced. Its
// `start`/`end` counters are the connection lifecycle a reconnect would move, and
// `connectedAt` is fixed so the elapsed clock is a stable reading.
vi.mock('@/modules/chat/voice-realtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const stub = {
    phase: 'listening',
    error: null,
    unansweredSeconds: null,
    captions: [],
    deliveries: [],
    delivering: false,
    queuedDepth: 0,
    refusal: null,
    levelRef: { current: 0 },
    connectedAt: state.connectedAt,
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

// The provider hook owns the pending set (stateful, so an answer really removes
// the request); it is seeded from the shared array so the panel has something to
// render on the first paint.
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => {
    const [pending, setPending] = React.useState<PendingPermissionRequest[]>(state.pending);
    state.setPending = setPending;
    return {
      provider: 'claude',
      setProvider: () => undefined,
      providerModels: { claude: 'claude-sonnet-4-5' },
      setStoredProviderModel: () => undefined,
      currentProviderEffort: 'medium',
      currentProviderEffortOptions: [{ value: 'medium' }],
      currentProviderModel: 'claude-sonnet-4-5',
      currentProviderModelOptions: [{ value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }],
      permissionMode: 'default',
      pendingPermissionRequests: pending,
      setPendingPermissionRequests: setPending,
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
    };
  },
}));

vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
    addMessage: () => undefined,
    markUserTurnUndelivered: () => undefined,
    restoreUserTurn: () => undefined,
    sessionActivity: { statusText: '', canInterrupt: false, startedAt: 0 },
    isProcessing: false,
    canAbortSession: false,
    currentSessionId: null,
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
    jumpToMessage: () => undefined,
  }),
}));

// The composer hook's decision handler is the one the panel calls: it records the
// payload under test and, like the app, drops the answered request from pending.
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
    handleVoiceListeningStart: () => undefined,
    handleInputChange: () => undefined,
    handleKeyDown: () => undefined,
    handlePaste: () => undefined,
    handleTextareaClick: () => undefined,
    handleTextareaInput: () => undefined,
    syncInputOverlayScroll: () => undefined,
    handleClearInput: () => undefined,
    handleAbortSession: () => undefined,
    handlePermissionDecision: (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      state.decisions.push({ requestIds, decision });
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      state.setPending?.((prev) => prev.filter((request) => !ids.includes(request.requestId)));
    },
    handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => {
      state.grantCalls.push(suggestion);
      return { success: true };
    },
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
  state.pending = [];
  state.setPending = null;
  state.decisions = [];
  state.grantCalls = [];
  state.startCalls = 0;
  state.endCalls = 0;
});

const renderInterface = () =>
  render(
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={EXISTING_SESSION}
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

/** Delivers the pending request into the pane the way the socket would, mid-session. */
const deliverPendingRequest = async (request: PendingPermissionRequest) => {
  await act(async () => {
    state.setPending!(() => [request]);
  });
};

test('AC2 a pending AskUserQuestion delivered in voice mode is answerable and the decision carries the answers', async () => {
  const view = renderInterface();

  await tapLiveVoice(view);

  // The swap AC-316 owns is intact: the bar replaced the composer.
  await waitFor(() => {
    assert.ok(view.queryByTestId('voice-realtime-bar'), 'the voice bar must appear once Live Voice is entered');
  });
  assert.equal(
    view.queryByTestId('prompt-input-textarea'),
    null,
    'the text composer must be gone in voice mode — this is the swap the fix must preserve',
  );
  assert.equal(view.queryByText('Claude needs your input'), null, 'premise: no question is pending yet');

  // The request lands over the socket while voice mode is live.
  await deliverPendingRequest(ASK_REQUEST);

  // The claim: the answerable surface appears even though the text composer is gone.
  await waitFor(() => {
    assert.ok(
      view.queryByText('Claude needs your input'),
      `voice mode must surface the pending question; DOM: ${view.container.innerHTML.slice(0, 600)}`,
    );
  });

  // Answer it: pick the option, then submit.
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: new RegExp(OPTION_LABEL) }));
  });
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: /Submit/ }));
  });

  assert.equal(state.decisions.length, 1, `exactly one decision must be sent; got ${state.decisions.length}`);
  const recorded = state.decisions[0];
  assert.equal(recorded.requestIds, ASK_REQUEST.requestId, 'the decision must address the pending request');
  assert.equal(recorded.decision.allow, true, 'answering the question allows the tool');
  const answers = (recorded.decision.updatedInput as { answers?: Record<string, string> } | undefined)?.answers;
  assert.deepEqual(
    answers,
    { [QUESTION]: OPTION_LABEL },
    `the decision must carry the selected answer; got ${JSON.stringify(answers)}`,
  );

  // The answered request is gone from the surface, exactly as it is in text mode.
  await waitFor(() => {
    assert.equal(view.queryByText('Claude needs your input'), null, 'the answered question must leave the screen');
  });

  view.unmount();
});

test('AC3 answering does not leave voice mode and does not reconnect the voice link', async () => {
  const view = renderInterface();

  await tapLiveVoice(view);

  await waitFor(() => {
    assert.ok(view.queryByTestId('voice-realtime-bar'), 'the voice bar must appear once Live Voice is entered');
  });

  await deliverPendingRequest(ASK_REQUEST);
  await waitFor(() => {
    assert.ok(view.queryByText('Claude needs your input'), 'premise: the question is pending in voice mode');
  });

  const elapsedBefore = view.getByTestId('voice-realtime-elapsed').textContent;
  const startCallsBefore = state.startCalls;

  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: new RegExp(OPTION_LABEL) }));
  });
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: /Submit/ }));
  });

  assert.equal(state.decisions.length, 1, 'the answer must have gone through the decision path');

  // composerMode is still voice: the bar is mounted and the text composer is not.
  assert.ok(view.queryByTestId('voice-realtime-bar'), 'answering must not leave voice mode');
  assert.equal(view.queryByTestId('prompt-input-textarea'), null, 'the text composer must stay replaced');

  // The connection was neither torn down nor re-established: no `end`, no `start`.
  assert.equal(state.endCalls, 0, `answering must not close the voice connection; end called ${state.endCalls} time(s)`);
  assert.equal(state.startCalls, startCallsBefore, 'answering must not open a new voice connection');

  // `connectedAt` is continuous: the same clock is still being displayed.
  assert.equal(
    view.getByTestId('voice-realtime-elapsed').textContent,
    elapsedBefore,
    'the elapsed clock must not reset — a reconnect would restart it',
  );

  view.unmount();
});
