import assert from 'node:assert/strict';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { KeyboardEvent } from 'react';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useActivityDockTurn } from '@/modules/chat/hooks/useActivityDockTurn';
import { useInputSuggestions } from '@/modules/chat/hooks/useInputSuggestions';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import enChat from '@/modules/i18n/locales/en/chat.json';
import WebSocketContext from '@/shared/context/WebSocketContext';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession, ServerEvent, SessionActivity } from '@/shared/types';

/**
 * The empty-composer chips follow the activity dock's own turn reading.
 *
 * The defect: the chips were hidden by the *local* `processingSessions` mark
 * while the status bar was hidden by the dock's server-backed reading, so a
 * server-confirmed turn (another client, a voice turn, a reload) could leave the
 * status bar saying a turn was running with the chips still on screen — and Tab
 * still consumed by them.
 *
 * Every leg here is independent: the two hooks are driven directly, the composer
 * state is driven for the keyboard, and the last case renders the real composer
 * through the real composer state so the listbox and the placeholder are read
 * from the DOM. The dock's own decision is never re-derived in this file.
 */

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      providers: {
        createSession: () => okJson({
          success: true,
          data: { sessionId: 'created-session', sessionName: 'created' },
        }),
        setSessionLifecycleMode: () => okJson({ success: true }),
        skills: () => okJson({ success: true, data: { skills: [] } }),
      },
    },
  };
});

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  voiceDebugFlushSilenceSec: () => undefined,
}));

vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    toggle: () => undefined,
    stop: () => undefined,
    transcribeFile: () => undefined,
    clipSlot: null,
    clipPlayState: { original: 'idle', trimmed: 'idle' },
    toggleClipPlayback: () => undefined,
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

const HISTORY_KEY = 'chat-input-history';
const SESSION_ID = 'session-a';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const UNREACHABLE_AFTER_MS = 900;
/** The freshness hook's own poll is what carries a threshold crossing into React. */
const POLL_STEP_MS = 1_000;

/** The ranked chips for this history are 检查进展, 提交, 继续. */
const SEED_HISTORY = ['继续', '继续', '提交', '提交', '检查进展', '检查进展'];

const seedHistory = (scope = SESSION_ID) => {
  localStorage.setItem(HISTORY_KEY, JSON.stringify({ [scope]: SEED_HISTORY }));
};

beforeEach(() => {
  localStorage.clear();
  // The drafts store is a module-level singleton; its in-memory copy outlives
  // localStorage.clear() and would leak one case's draft into the next.
  resetChatDrafts();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `statusText: null` so the dock's label falls through to the phase words. */
const ACTIVITY: SessionActivity = { statusText: null, canInterrupt: true, startedAt: START };

// ---------------------------------------------------------------------------
// An in-memory liveness channel: the hooks' only transport.
// ---------------------------------------------------------------------------

type Connection = React.ContextType<typeof WebSocketContext>;

const makeConnection = (): {
  connection: Connection;
  push: (event: ServerEvent) => void;
} => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const connection = {
    ws: null,
    isConnected: true,
    sendMessage: () => undefined,
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as Connection;
  const push = (event: ServerEvent) => {
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  };
  return { connection, push };
};

const subscribedFrame = (overrides: Partial<ServerEvent> = {}): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing: true,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: UNREACHABLE_AFTER_MS,
  timestamp: new Date(START).toISOString(),
  ...overrides,
});

const heartbeatFrame = (timestamp: number, isProcessing: boolean): ServerEvent => ({
  kind: 'activity.heartbeat',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 1,
  isProcessing,
  timestamp: new Date(timestamp).toISOString(),
});

const renderDockTurn = (connection: Connection, activity: SessionActivity | null, taskCount?: number) =>
  renderHook(
    (props: { activity: SessionActivity | null; taskCount?: number }) => useActivityDockTurn({
      sessionId: SESSION_ID,
      activity: props.activity,
      ...(props.taskCount === undefined ? {} : { taskCount: props.taskCount }),
    }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) => React.createElement(
        WebSocketContext.Provider,
        { value: connection },
        children,
      ),
      initialProps: { activity, ...(taskCount === undefined ? {} : { taskCount }) },
    },
  );

// ---------------------------------------------------------------------------
// (a) The display condition, with its positive control.
// ---------------------------------------------------------------------------

const baseSuggestionArgs = () => ({
  input: '',
  isLoading: false,
  isOccupied: false,
  isCommandMenuOpen: false,
  isFileMenuOpen: false,
  hasQueuedDraft: false,
  hasAttachments: false,
  draftScope: SESSION_ID,
  onAccept: () => undefined,
});

type SuggestionArgs = ReturnType<typeof baseSuggestionArgs> & { isDockTurnShown?: boolean };

const renderSuggestions = (overrides: Partial<SuggestionArgs> = {}) => renderHook(
  (props: SuggestionArgs) => useInputSuggestions(props),
  { initialProps: { ...baseSuggestionArgs(), ...overrides } },
);

const suggestionKeyEvent = (key: string) => {
  const state = { prevented: false, stopped: false };
  const event = {
    key,
    shiftKey: false,
    preventDefault: () => {
      state.prevented = true;
    },
    stopPropagation: () => {
      state.stopped = true;
    },
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { event, state };
};

describe('the chips obey the dock turn reading', () => {
  it('(a) hides the chips while the dock draws a turn, and shows them with the flag absent or false', () => {
    seedHistory();

    const dockTurn = renderSuggestions({ isDockTurnShown: true });
    assert.equal(
      dockTurn.result.current.visible,
      false,
      'isDockTurnShown: true must hide the chips with every other condition satisfied',
    );

    const explicitlyOff = renderSuggestions({ isDockTurnShown: false });
    assert.equal(explicitlyOff.result.current.visible, true, 'isDockTurnShown: false is the positive control');

    const omitted = renderSuggestions();
    assert.equal(omitted.result.current.visible, true, 'the flag defaults to false for existing callers');
  });

  // -------------------------------------------------------------------------
  // (b) No key is consumed while the dock draws a turn.
  // -------------------------------------------------------------------------

  it('(b) leaves Tab, Enter and Escape un-consumed while the dock draws a turn, and Tab reaches the permission-mode branch once', () => {
    seedHistory();
    const { result } = renderSuggestions({ isDockTurnShown: true });

    for (const key of ['Tab', 'Enter', 'Escape']) {
      const { event, state } = suggestionKeyEvent(key);
      let handled = true;
      act(() => {
        handled = result.current.handleKeyDown(event, false);
      });
      assert.equal(handled, false, `${key} must not be consumed while the chips are hidden`);
      assert.equal(state.prevented, false, `${key} must not be prevented while the chips are hidden`);
      assert.equal(state.stopped, false, `${key} must not be stopped while the chips are hidden`);
    }

    // The composer's own Tab branch is the one that must see the key — exactly once.
    const cyclePermissionMode = vi.fn();
    const view = renderHook(() => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION_ID,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      isDockTurnShown: true,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: vi.fn(),
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));

    assert.equal(view.result.current.inputSuggestionsVisible, false);
    const tab = suggestionKeyEvent('Tab');
    const composerEvent = {
      ...tab.event,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      nativeEvent: { isComposing: false },
      currentTarget: { value: '', form: { requestSubmit: () => undefined } },
    } as unknown as KeyboardEvent<HTMLTextAreaElement>;
    act(() => {
      view.result.current.handleKeyDown(composerEvent);
    });
    assert.equal(
      cyclePermissionMode.mock.calls.length,
      1,
      'Tab must fall through to the composer permission-mode branch exactly once',
    );
    assert.equal(view.result.current.selectedInputSuggestionIndex, null);
  });
});

// ---------------------------------------------------------------------------
// (c)-(h) The dock-turn reading itself.
// ---------------------------------------------------------------------------

describe('useActivityDockTurn reads the dock decision', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(c) is true when there is no local activity but a server frame established a turn anchor', () => {
    const { connection, push } = makeConnection();
    const { result } = renderDockTurn(connection, null);

    assert.equal(result.current, false, 'before any frame the dock has no turn');
    push(subscribedFrame());
    assert.equal(result.current, true, 'a server-confirmed turn must read as the dock drawing a turn');
  });

  it('(d) is false when there is no local activity and no turn anchor', () => {
    const { connection } = makeConnection();
    const { result } = renderDockTurn(connection, null);
    assert.equal(result.current, false);
  });

  it('(e) is true while local activity exists, with or without a server frame', () => {
    const { connection } = makeConnection();
    const { result } = renderDockTurn(connection, ACTIVITY);
    assert.equal(result.current, true);
  });

  it('(f) returns to false when a server frame clears the anchor', () => {
    const { connection, push } = makeConnection();
    const { result } = renderDockTurn(connection, null);

    push(subscribedFrame());
    assert.equal(result.current, true);

    push(heartbeatFrame(START + 1_000, false));
    assert.equal(result.current, false, 'the frame that ends the turn must let the chips come back');
  });

  it('(g) is true when the dock is unreachable on an anchor it still holds', () => {
    const { connection, push } = makeConnection();
    const { result } = renderDockTurn(connection, null);

    push(subscribedFrame());
    assert.equal(result.current, true);

    act(() => {
      vi.advanceTimersByTime(UNREACHABLE_AFTER_MS + POLL_STEP_MS);
    });
    assert.equal(result.current, true, 'an unreachable dock with a turn anchor is still drawing a turn');
  });

  it('(h) is false when the dock is only showing background work between turns', () => {
    const { connection } = makeConnection();
    const { result } = renderDockTurn(connection, null, 1);
    assert.equal(result.current, false, 'a background task is not a turn');
  });
});

// ---------------------------------------------------------------------------
// (i) The real composer, through the real composer state.
// ---------------------------------------------------------------------------

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: SESSION_ID };

const composerBaseProps = (): Record<string, unknown> => ({
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: null,
  isLoading: false,
  onAbortSession: () => undefined,
  permissionMode: 'default',
  availablePermissionModes: ['default'],
  onSelectPermissionMode: () => undefined,
  providerLabel: 'Claude',
  effort: 'medium',
  availableEffortOptions: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
  onSelectEffort: () => undefined,
  model: 'test-model',
  availableModelOptions: [{ value: 'test-model', label: 'test-model' }],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: () => undefined,
  slashCommandsCount: 0,
  onToggleCommandMenu: () => undefined,
  hasInput: false,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDraft: null,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: () => undefined,
  onCancelScheduledMessage: () => undefined,
  onEditQueuedDraft: () => undefined,
  onDeleteQueuedDraft: () => undefined,
  attachedFiles: [],
  onRemoveAttachment: () => undefined,
  fileErrors: new Map<string, string>(),
  showFileDropdown: false,
  filteredFiles: [],
  selectedFileIndex: 0,
  onSelectFile: () => undefined,
  filteredCommands: [],
  selectedCommandIndex: 0,
  onCommandSelect: () => undefined,
  onCloseCommandMenu: () => undefined,
  isCommandMenuOpen: false,
  frequentCommands: [],
  getRootProps: () => ({}),
  getInputProps: () => ({}),
  openAttachmentPicker: () => undefined,
  renderInputWithMentions: () => null,
  input: '',
  onVoiceTranscript: () => undefined,
  scope: SESSION_ID,
  projectId: null,
  isActive: true,
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Ask anything',
  isTextareaExpanded: false,
  inputSuggestionCandidates: [],
  inputSuggestionsVisible: false,
  selectedInputSuggestionIndex: null,
  inputSuggestionListId: 'suggestion-list',
  onAcceptInputSuggestion: () => undefined,
});

/**
 * The shipping wiring in miniature: the dock-turn hook feeds the composer state,
 * and the composer state feeds the real composer. The local `isLoading` mark is
 * false throughout — only the server's frame can put the dock in turn.
 */
const ComposerIntegrationHarness = ({ sessionId }: { sessionId: string }) => {
  const isDockTurnShown = useActivityDockTurn({ sessionId, activity: null });
  const state = useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: sessionId,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    isDockTurnShown,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  });

  return React.createElement(ChatComposer, {
    ...composerBaseProps(),
    sessionId,
    input: state.input,
    textareaRef: state.textareaRef,
    inputHighlightRef: state.inputHighlightRef,
    onInputChange: state.handleInputChange,
    onTextareaKeyDown: state.handleKeyDown,
    onTextareaClick: state.handleTextareaClick,
    onTextareaInput: state.handleTextareaInput,
    onTextareaScrollSync: state.syncInputOverlayScroll,
    onClearInput: state.handleClearInput,
    onSubmit: state.handleSubmit,
    inputSuggestionCandidates: state.inputSuggestionCandidates,
    inputSuggestionsVisible: state.inputSuggestionsVisible,
    selectedInputSuggestionIndex: state.selectedInputSuggestionIndex,
    inputSuggestionListId: state.inputSuggestionListId,
    onAcceptInputSuggestion: state.acceptInputSuggestion,
  } as unknown as React.ComponentProps<typeof ChatComposer>);
};

describe('the composer surface follows the dock', () => {
  const renderHarness = (connection: Connection) => render(
    React.createElement(
      WebSocketContext.Provider,
      { value: connection },
      React.createElement(ComposerIntegrationHarness, { sessionId: SESSION_ID }),
    ),
  );

  const listboxCount = (container: HTMLElement) => container.querySelectorAll('[role="listbox"]').length;
  const placeholderOf = (container: HTMLElement) =>
    container.querySelector('textarea')?.getAttribute('placeholder') ?? null;

  it('(i) hides the listbox and restores the placeholder while the dock is in turn, and shows it without an anchor', () => {
    seedHistory();
    const { connection, push } = makeConnection();
    const view = renderHarness(connection);

    // No anchor: the composer is genuinely idle, so the chips are the positive control.
    assert.equal(listboxCount(view.container), 1, 'without a turn anchor the chips must be on screen');
    assert.equal(placeholderOf(view.container), '', 'while the chips are shown the placeholder is blank');

    // A server-confirmed turn with no local mark at all.
    push(subscribedFrame());
    assert.equal(listboxCount(view.container), 0, 'the dock says a turn is running: no chips');
    assert.ok(
      (placeholderOf(view.container) ?? '') !== '',
      'with the chips gone the textarea must show its real placeholder again',
    );
  });
});
