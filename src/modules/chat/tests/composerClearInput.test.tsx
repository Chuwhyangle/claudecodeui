import assert from 'node:assert/strict';

import { fireEvent, render, act } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * The composer's clear control, one leg per rule the amended task states.
 *
 * Three surfaces are read together, because the behaviour is split across them:
 * the footer draws (or withholds) the ✕ by width and by whether the box holds
 * text; the composer state owns the clear/undo bookkeeping; and the Esc gesture
 * has to lose to an open menu and to a running turn. The `cleared` ledger event
 * belongs to the TWO deliberate clear gestures only — the clear control and Esc
 * — never to deleting the text by hand.
 */

const apiMocks = vi.hoisted(() => ({
  event: vi.fn(),
  commands: vi.fn(),
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      replySuggestions: {
        status: () => okJson({ enabled: false, expansion: 'off', maxChips: 3, maxChipChars: 120 }),
        suggest: () => okJson({ chips: [], draw: 0 }),
        event: apiMocks.event,
      },
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: apiMocks.commands },
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

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};
const SESSION: ProjectSession = { id: 'session-a' };

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  setViewportWidth(1280);
  apiMocks.event.mockReset().mockImplementation(() => Promise.resolve({ ok: true }));
  apiMocks.commands.mockReset().mockImplementation(() => Promise.resolve({
    ok: true,
    json: async () => ({
      success: true,
      builtIn: [{ name: '/help', description: 'Show help' }],
      custom: [],
    }),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  inputHighlightRef: { current: null },
  renderInputWithMentions: () => null,
  textareaRef: { current: null },
  input: '',
  onVoiceTranscript: () => undefined,
  scope: 'session-a',
  projectId: null,
  isActive: true,
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
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

/** The real composer state and the real composer, so a key press and a click meet the same draft. */
const Harness = ({ isLoading = false, isDockTurnShown = false }: {
  isLoading?: boolean;
  isDockTurnShown?: boolean;
}) => {
  const state = useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading,
    isDockTurnShown,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
    lastAssistantMessageId: null,
  });

  return React.createElement(ChatComposer, {
    ...composerBaseProps(),
    isLoading,
    input: state.input,
    hasInput: Boolean(state.input.trim()),
    onInputChange: state.handleInputChange,
    onTextareaKeyDown: state.handleKeyDown,
    textareaRef: state.textareaRef,
    inputHighlightRef: state.inputHighlightRef,
    onClearInput: state.handleClearInput,
    onSubmit: state.handleSubmit,
    inputSuggestionCandidates: state.inputSuggestionCandidates,
    inputSuggestionsVisible: state.inputSuggestionsVisible,
    selectedInputSuggestionIndex: state.selectedInputSuggestionIndex,
    inputSuggestionListId: state.inputSuggestionListId,
    onAcceptInputSuggestion: state.acceptInputSuggestion,
    suggestionChips: state.suggestionChips,
    isCommandMenuOpen: state.showCommandMenu,
    filteredCommands: state.filteredCommands,
    onCommandSelect: state.handleCommandSelect,
    onCloseCommandMenu: state.resetCommandMenuState,
  } as unknown as React.ComponentProps<typeof ChatComposer>);
};

const renderHarness = (width: number, props: { isLoading?: boolean; isDockTurnShown?: boolean } = {}) => {
  setViewportWidth(width);
  const view = render(React.createElement(Harness, props));
  const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(textarea, 'the composer must render a textarea');
  return { view, textarea };
};

const type = (textarea: HTMLTextAreaElement, value: string) => {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length } });
};

const clearEvents = () => apiMocks.event.mock.calls
  .map(([payload]) => (payload as { event: string }).event)
  .filter((event) => event === 'cleared');

const clickClear = (view: ReturnType<typeof render>) => {
  const button = view.getByRole('button', { name: enChat.input.clearInput });
  fireEvent.click(button);
};

describe('the narrow clear control', () => {
  it('(a) appears in the compact footer after "more", and only while the box holds text', () => {
    const { view } = renderHarness(390);
    assert.equal(view.queryByRole('button', { name: enChat.input.clearInput }), null, 'empty box: no ✕');

    type(view.container.querySelector('textarea') as HTMLTextAreaElement, 'draft');
    const clear = view.getByRole('button', { name: enChat.input.clearInput });
    assert.ok(clear);
    const more = view.getByRole('button', { name: enChat.input.moreTools });
    assert.equal(
      more.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING,
      Node.DOCUMENT_POSITION_FOLLOWING,
      'the ✕ must be after "more"',
    );
  });

  it('(b) does not appear while the box is empty', () => {
    const { view } = renderHarness(390);
    assert.equal(view.container.querySelector('[data-slot="composer-clear-input"]'), null);
  });

  it('(c) does not appear below 360px even with a draft', () => {
    const { view, textarea } = renderHarness(340);
    type(textarea, 'draft');
    assert.equal(view.container.querySelector('[data-slot="composer-clear-input"]'), null);
  });

  it('(d) clears the box, focuses it, and reports exactly one cleared event', () => {
    const { view, textarea } = renderHarness(390);
    type(textarea, 'draft to clear');
    assert.equal(clearEvents().length, 0);

    clickClear(view);

    assert.equal((view.container.querySelector('textarea') as HTMLTextAreaElement).value, '');
    assert.equal(document.activeElement, view.container.querySelector('textarea'), 'the caret returns to the box');
    assert.equal(clearEvents().length, 1);
  });
});

describe('Escape clears only when nothing else owns the key', () => {
  it('(e) clears a drafted, idle box and reports one cleared event', () => {
    const { textarea } = renderHarness(1280);
    type(textarea, 'draft');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    assert.equal(textarea.value, '');
    assert.equal(clearEvents().length, 1);
  });

  it('(f) never clears while a turn is running', () => {
    const { textarea } = renderHarness(1280, { isLoading: true });
    type(textarea, 'draft during a turn');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    assert.equal(textarea.value, 'draft during a turn', 'the turn keeps the abort meaning of Esc');
    assert.equal(clearEvents().length, 0);
  });

  it('(f2) never clears while the dock holds a server-confirmed turn anchor', () => {
    const { textarea } = renderHarness(1280, { isDockTurnShown: true });
    type(textarea, 'draft during a dock turn');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    assert.equal(textarea.value, 'draft during a dock turn');
    assert.equal(clearEvents().length, 0);
  });

  it('(g) an open command menu eats Esc: the menu closes and the draft stays', async () => {
    const { view, textarea } = renderHarness(1280);
    await act(async () => {
      type(textarea, '/');
      // The command list has loaded and its 150ms query debounce has run.
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    // The menu is open (the command list is rendered) before the key press. It
    // draws into a portal, so the document is the scope, not the render container.
    assert.ok(document.querySelectorAll('[role="listbox"]').length > 0, 'typing a slash must open the command menu');

    fireEvent.keyDown(textarea, { key: 'Escape' });

    assert.equal(textarea.value, '/', 'the draft is not a menu');
    assert.equal(clearEvents().length, 0);
    assert.equal(document.querySelectorAll('[role="listbox"]').length, 0, 'the menu closed');
  });

  it('(h) an empty box keeps the existing chip-hide behaviour and sends no cleared event', () => {
    localStorage.setItem('chat-input-history', JSON.stringify({
      'session-a': ['继续', '继续', '提交', '提交'],
    }));
    const { view } = renderHarness(1280);
    // The chips are the hint that the empty-box Esc path is live; it consumes the key.
    assert.ok(view.container.querySelector('[role="listbox"]'), 'chips must be visible on an empty box');
    fireEvent.keyDown(view.container.querySelector('textarea') as HTMLTextAreaElement, { key: 'Escape' });
    assert.equal(view.container.querySelector('[role="listbox"]'), null, 'the chips hide');
    assert.equal(clearEvents().length, 0, 'hiding chips is not clearing a draft');
  });

  it('(i) deleting the text by hand does not report cleared', () => {
    const { textarea } = renderHarness(1280);
    type(textarea, 'draft');
    type(textarea, ''); // backspace to empty
    assert.equal(textarea.value, '');
    assert.equal(clearEvents().length, 0, 'a manual delete is an edit, not a dismissal');
  });
});
