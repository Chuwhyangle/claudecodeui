import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { ChatComposer } from '@/modules/chat-composer';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { resetChatDrafts } from '@/shared/api/chatDrafts';
import type { ComposerChipStrip, ReplySuggestionsFailure } from '@/shared/types';

/**
 * The composer's reply-suggestions failure surface.
 *
 * The failure reading still exists in the controller (it drives the ledger and
 * Diagnostics), but the composer no longer draws it: an automatic draw failure or
 * a `misconfigured` setting is silent, and only a manual Suggest press shows the
 * existing three-second control state. These cases pin that the removed overlay
 * cannot block the empty textarea again.
 */

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      replySuggestions: {
        status: () => okJson({ enabled: true, state: 'ready', problems: [], lastFailure: null, expansion: 'off', maxChips: 3, maxChipChars: 120 }),
        suggest: () => okJson({ chips: [], draw: 0 }),
        event: () => okJson({ ok: true }),
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
        createSession: () => okJson({ success: true, data: { sessionId: 'created-session', sessionName: 'created' } }),
        setSessionLifecycleMode: () => okJson({ success: true }),
        skills: () => okJson({ success: true, data: { skills: [] } }),
      },
    },
  };
});

vi.mock('@/modules/chat-support/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));
vi.mock('@/shared/voice/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  voiceDebugFlushSilenceSec: () => undefined,
}));
vi.mock('@/modules/chat-voice/hooks/useVoiceInput', () => ({
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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The failure episode the controller would still hold. */
const failure: ReplySuggestionsFailure = {
  at: '2026-11-18T10:00:00.000Z',
  code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
  category: 'http',
  httpStatus: 502,
  requestId: 'a1b2c3d4',
  model: 'gateway-model',
  message: 'reply-suggestions upstream request failed (http)',
};

const chipStripProps = (overrides: Partial<ComposerChipStrip> = {}): ComposerChipStrip => ({
  visible: false,
  selectedIndex: null,
  listId: 'suggestion-list',
  chips: [],
  onAccept: vi.fn(),
  suggestionsEnabled: true,
  suggestionsLoading: false,
  onRequestSuggestions: vi.fn(),
  expansionChips: [],
  onAcceptExpansionChip: vi.fn(),
  suggestionFailure: failure,
  suggestionFailureDismissed: false,
  suggestionFailureCount: 2,
  onDismissSuggestionFailure: vi.fn(),
  ...overrides,
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
  chipStrip: chipStripProps(),
});

const renderComposer = (strip: ComposerChipStrip) => render(React.createElement(
  ChatComposer,
  { ...composerBaseProps(), chipStrip: strip } as unknown as React.ComponentProps<typeof ChatComposer>,
));

/** A composer whose draft is real state, so a change event can be observed. */
function StatefulComposer({ strip }: { strip: ComposerChipStrip }) {
  const [input, setInput] = React.useState('');
  return React.createElement(ChatComposer, {
    ...composerBaseProps(),
    input,
    onInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setInput(event.target.value),
    chipStrip: strip,
  } as unknown as React.ComponentProps<typeof ChatComposer>);
}

describe('composer reply-suggestions failure surface', () => {
  it('(a) an automatic failure renders no notice and no popover', () => {
    const { container } = renderComposer(chipStripProps());

    assert.ok(container.querySelector('[data-slot="reply-suggestions-failure-notice"]') === null);
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null);
  });

  it('(a2) a misconfigured failure is silent in the composer', () => {
    const { container } = renderComposer(chipStripProps({
      suggestionFailure: { ...failure, category: 'misconfigured', httpStatus: null, code: 'REPLY_SUGGESTIONS_MISCONFIGURED' },
    }));

    assert.ok(container.querySelector('[data-slot="reply-suggestions-failure-notice"]') === null);
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null);
  });

  it('(b) the empty textarea is focusable and accepts input while a failure is held', () => {
    const { container } = render(React.createElement(StatefulComposer, { strip: chipStripProps() }));
    const textarea = container.querySelector('textarea');
    assert.ok(textarea, 'the composer textarea is rendered');

    textarea.focus();
    assert.equal(document.activeElement, textarea, 'the empty input line takes focus');

    fireEvent.change(textarea, { target: { value: 'hello' } });
    assert.equal(textarea.value, 'hello', 'typing reaches the draft');
  });

  it('(c) a manual Suggest failure shows the failed control state, then returns to idle', async () => {
    const { container } = renderComposer(chipStripProps({
      onRequestSuggestions: () => Promise.resolve(false),
    }));
    const button = container.querySelector('[data-slot="reply-suggest-button"]');
    assert.ok(button, 'the Suggest control is rendered');
    assert.equal(button.getAttribute('data-reply-suggest-state'), 'idle');

    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
        await Promise.resolve();
      });
      assert.equal(button.getAttribute('data-reply-suggest-state'), 'failed');

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      assert.equal(button.getAttribute('data-reply-suggest-state'), 'idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('(d) a healthy empty box renders no failure DOM', () => {
    const { container } = renderComposer(chipStripProps({ suggestionFailure: null }));

    assert.ok(container.querySelector('[data-slot="reply-suggestions-failure-notice"]') === null);
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null);
  });
});
