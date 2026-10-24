import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { buildSuggestionChips } from '@/modules/chat/utils/inputSuggestions';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * What each chip source does when it is clicked, and what the Suggest button is.
 *
 * Two layers, because the click semantics live in two places: the component
 * routes a press to the callback that owns the source, and the composer state
 * turns that callback into a draft/send. The component cases prove the routing;
 * the hook cases prove that a model chip really fills AND sends while a quoted
 * chip pastes `> text` and focuses without sending.
 */

const apiMocks = vi.hoisted(() => ({
  status: vi.fn(),
  suggest: vi.fn(),
  event: vi.fn(),
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      replySuggestions: {
        status: apiMocks.status,
        suggest: apiMocks.suggest,
        event: apiMocks.event,
      },
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

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  apiMocks.status.mockReset().mockImplementation(() => Promise.resolve({
    ok: true,
    json: async () => ({ enabled: true, expansion: 'off', maxChips: 3, maxChipChars: 120 }),
  }));
  apiMocks.suggest.mockReset().mockImplementation(() => Promise.resolve({
    ok: true,
    json: async () => ({ chips: ['模型一', '模型二'], draw: 3 }),
  }));
  apiMocks.event.mockReset().mockImplementation(() => Promise.resolve({ ok: true }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Component: routing and the Suggest control
// ---------------------------------------------------------------------------

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
  onSubmit: vi.fn(),
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
  textareaRef: { current: null },
  inputHighlightRef: { current: null },
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
  inputSuggestionsVisible: true,
  selectedInputSuggestionIndex: null,
  inputSuggestionListId: 'suggestion-list',
  onAcceptInputSuggestion: () => undefined,
  suggestionChips: buildSuggestionChips({
    quotedText: '选中的原文',
    modelChips: ['模型一'],
    habitChips: ['习惯一'],
  }),
  onAcceptModelSuggestion: vi.fn(),
  onAcceptQuotedSuggestion: vi.fn(),
  replySuggestionsEnabled: true,
  replySuggestionsLoading: false,
  onRequestReplySuggestions: vi.fn(),
});

const renderComposer = (overrides: Record<string, unknown> = {}) => {
  const props = { ...composerBaseProps(), ...overrides };
  const view = render(React.createElement(
    ChatComposer,
    props as unknown as React.ComponentProps<typeof ChatComposer>,
  ));
  return { view, props };
};

describe('chip clicks at the composer surface', () => {
  it('routes a model chip click to its own callback, never to the form submit', () => {
    const { view, props } = renderComposer();
    const modelChip = view.container.querySelector('[data-chip-source="model"]');
    assert.ok(modelChip);

    fireEvent.click(modelChip);

    assert.deepEqual((props.onAcceptModelSuggestion as ReturnType<typeof vi.fn>).mock.calls, [[0]]);
    assert.equal((props.onSubmit as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  it('routes a quoted chip click to the quote callback and sends nothing', () => {
    const { view, props } = renderComposer();
    const quotedChip = view.container.querySelector('[data-chip-source="quoted"]');
    assert.ok(quotedChip);

    fireEvent.click(quotedChip);

    assert.equal((props.onAcceptQuotedSuggestion as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    assert.equal((props.onSubmit as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  it('the Suggest button asks for a redraw, submits nothing, and is disabled while drawing', () => {
    const { view, props, } = renderComposer();
    const button = view.getByRole('button', { name: enChat.input.suggestions.suggest });
    assert.equal(button.hasAttribute('disabled'), false);

    fireEvent.click(button);
    assert.equal((props.onRequestReplySuggestions as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    assert.equal((props.onSubmit as ReturnType<typeof vi.fn>).mock.calls.length, 0);

    view.rerender(React.createElement(ChatComposer, {
      ...composerBaseProps(),
      ...props,
      replySuggestionsLoading: true,
    } as unknown as React.ComponentProps<typeof ChatComposer>));
    const busy = view.getByRole('button', { name: enChat.input.suggestions.suggest });
    assert.equal(busy.hasAttribute('disabled'), true, 'a second click must not become a second draw');
    assert.equal(busy.getAttribute('aria-busy'), 'true');
  });

  it('shows no Suggest button at all when the feature is off', () => {
    const { view } = renderComposer({ replySuggestionsEnabled: false });
    assert.equal(view.queryByRole('button', { name: enChat.input.suggestions.suggest }), null);
  });

  it('shows the complete text of the keyboard-selected chip on the second line', () => {
    const habitText = '这是一条足够长的习惯文本，用来验证第二行预览完整出现';
    const chips = buildSuggestionChips({ modelChips: ['模型一'], habitChips: [habitText] });
    const { view } = renderComposer({
      suggestionChips: chips,
      selectedInputSuggestionIndex: 1,
    });

    const preview = view.container.querySelector('[data-suggestion-preview]');
    assert.ok(preview, 'Tab selection must produce the second-line preview');
    assert.equal(preview.textContent, habitText);
  });
});

// ---------------------------------------------------------------------------
// Composer state: what the callbacks actually do
// ---------------------------------------------------------------------------

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};
const SESSION: ProjectSession = { id: 'session-a' };

const setupComposer = (quotedSelection: string | null = null) => {
  const sendMessage = vi.fn();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
    lastAssistantMessageId: 'assistant-1',
    quotedSelection,
  }));
  return { view, sendMessage, frames };
};

describe('composer state chip acceptance', () => {
  it('fills AND sends the complete text when a model chip is accepted', async () => {
    const { view, sendMessage } = setupComposer();
    await waitFor(() => {
      assert.equal(view.result.current.replySuggestionsEnabled, true);
      assert.ok(view.result.current.suggestionChips.some((chip) => chip.source === 'model'));
    });

    act(() => {
      view.result.current.acceptModelSuggestion(0);
    });

    assert.equal(view.result.current.input, '模型一');
    assert.equal(sendMessage.mock.calls.length, 1, 'a model chip click is a send');
    assert.equal((sendMessage.mock.calls[0][0] as { content: string }).content, '模型一');
  });

  it('pastes `> selection` plus a newline and focuses, without sending, for a quoted chip', () => {
    const { view, sendMessage, frames } = setupComposer('选中的原文');
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    (view.result.current.textareaRef as { current: HTMLTextAreaElement | null }).current = textarea;
    // The composer binds `input` to this node on the next render; put the quoted
    // text in first so the caret range has somewhere to land (as the habit-chip
    // criterion does).
    textarea.value = '> 选中的原文\n';

    act(() => {
      view.result.current.acceptQuotedSuggestion();
    });
    act(() => {
      frames.forEach((callback) => callback(0));
    });

    assert.equal(view.result.current.input, '> 选中的原文\n');
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.selectionStart, '> 选中的原文\n'.length);
    assert.equal(sendMessage.mock.calls.length, 0, 'quoting is not sending');

    textarea.remove();
  });

  it('keeps the quoted chip while the box holds the quote, after the selection collapses', () => {
    const view = renderHook(
      (props: { quotedSelection: string | null }) => useChatComposerState({
        selectedProject: PROJECT,
        selectedSession: SESSION,
        currentSessionId: SESSION.id,
        provider: 'claude',
        permissionMode: 'default',
        cyclePermissionMode: () => undefined,
        resolvePermissionModeForProvider: () => 'default' as PermissionMode,
        currentProviderModel: 'test-model',
        currentProviderEffort: 'medium',
        isLoading: false,
        canAbortSession: false,
        tokenBudget: null,
        sendMessage: vi.fn(),
        scrollToBottom: () => undefined,
        addMessage: () => undefined,
        setIsUserScrolledUp: () => undefined,
        setPendingPermissionRequests: () => undefined,
        lastAssistantMessageId: 'assistant-1',
        quotedSelection: props.quotedSelection,
      }),
      { initialProps: { quotedSelection: '选中的原文' } as { quotedSelection: string | null } },
    );

    act(() => {
      view.result.current.acceptQuotedSuggestion();
    });
    // Focusing the textarea collapses the browser selection; the composer sees null.
    act(() => {
      view.rerender({ quotedSelection: null });
    });

    assert.equal(view.result.current.input, '> 选中的原文\n');
    assert.deepEqual(
      view.result.current.suggestionChips.map((chip) => chip.source),
      ['quoted'],
      'the accepted quote stays as the only chip while the box is non-empty',
    );
  });
});
