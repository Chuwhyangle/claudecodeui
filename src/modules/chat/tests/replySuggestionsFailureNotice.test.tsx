import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { ChatComposer, SuggestionFailureNotice } from '@/modules/chat-composer';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { resetChatDrafts } from '@/shared/api/chatDrafts';
import type { ComposerChipStrip, ReplySuggestionsFailure } from '@/shared/types';

/**
 * The inline reply-suggestions failure notice and its detail popover.
 *
 * The controller tests own the episode rules; this file owns the surface: the
 * status line appears without a click, the popover does NOT exist until the line
 * is activated, Escape / a second click closes it, retry and dismiss route to the
 * controller's own commands, and a healthy empty box renders nothing.
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

/** The failure episode the notice renders. */
const failure: ReplySuggestionsFailure = {
  at: '2026-11-18T10:00:00.000Z',
  code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
  category: 'http',
  httpStatus: 502,
  requestId: 'a1b2c3d4',
  model: 'gateway-model',
  message: 'reply-suggestions upstream request failed (http)',
};

const noticeProps = (overrides: Partial<React.ComponentProps<typeof SuggestionFailureNotice>> = {}) => ({
  failure,
  failureCount: 3,
  onRetry: vi.fn(),
  onDismiss: vi.fn(),
  ...overrides,
});

const renderNotice = (overrides: Partial<React.ComponentProps<typeof SuggestionFailureNotice>> = {}) => {
  const props = noticeProps(overrides);
  const view = render(React.createElement(SuggestionFailureNotice, props));
  return { view, props };
};

describe('SuggestionFailureNotice', () => {
  it('(a) shows the status line and does NOT mount the popover until activated', () => {
    const { view } = renderNotice();

    const line = view.container.querySelector('[data-slot="reply-suggestions-failure-notice"]');
    assert.ok(line, 'the inline notice is rendered');
    assert.equal(line.getAttribute('role'), 'status');
    assert.equal(line.getAttribute('aria-live'), 'polite');
    assert.ok(
      view.container.querySelector('[data-slot="reply-suggestions-failure-trigger"]')?.textContent
        ?.includes('returned an error'),
      'the line names the upstream failure',
    );
    // Compared as a boolean: an assertion diff that inspects a jsdom node is
    // pathologically slow when the RED path is exercised (the negative control).
    assert.ok(
      document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null,
      'the popover must NOT be in the DOM before a click',
    );
  });

  it('(b) a click mounts the popover with every correlation field', () => {
    const { view } = renderNotice();
    fireEvent.click(view.container.querySelector('[data-slot="reply-suggestions-failure-trigger"]') as Element);

    const popover = document.querySelector('[data-slot="reply-suggestions-failure-popover"]');
    assert.ok(popover, 'the popover is mounted after activation');
    assert.equal(popover.getAttribute('role'), 'dialog');
    assert.equal(popover.querySelector('[data-field="code"]')?.textContent, failure.code);
    assert.equal(popover.querySelector('[data-field="httpStatus"]')?.textContent, '502');
    assert.equal(popover.querySelector('[data-field="at"]')?.textContent, failure.at);
    assert.equal(popover.querySelector('[data-field="model"]')?.textContent, 'gateway-model');
    assert.equal(popover.querySelector('[data-field="requestId"]')?.textContent, 'a1b2c3d4');
    assert.equal(popover.querySelector('[data-field="failureCount"]')?.textContent, '3');
  });

  it('(c) a second click and Escape each close the popover', () => {
    const { view } = renderNotice();
    const trigger = view.container.querySelector('[data-slot="reply-suggestions-failure-trigger"]') as Element;

    fireEvent.click(trigger);
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]'));
    fireEvent.click(trigger);
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null);

    fireEvent.click(trigger);
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]'));
    fireEvent.keyDown(trigger, { key: 'Escape' });
    assert.ok(
      document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null,
      'Escape closes the detail popover',
    );
  });

  it('(d) Retry calls the injected draw command and keeps the notice on screen', () => {
    const { view, props } = renderNotice();
    fireEvent.click(view.container.querySelector('[data-slot="reply-suggestions-failure-trigger"]') as Element);
    fireEvent.click(document.querySelector('[data-action="retry"]') as Element);

    assert.equal((props.onRetry as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    assert.ok(
      view.container.querySelector('[data-slot="reply-suggestions-failure-notice"]'),
      'a retry press does not hide the reading before the answer arrives',
    );
  });

  it('(e) the dismiss action calls its command and the close action only closes', () => {
    const { view, props } = renderNotice();
    fireEvent.click(view.container.querySelector('[data-slot="reply-suggestions-failure-trigger"]') as Element);

    fireEvent.click(document.querySelector('[data-action="close"]') as Element);
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null);
    assert.equal((props.onDismiss as ReturnType<typeof vi.fn>).mock.calls.length, 0);

    fireEvent.click(view.container.querySelector('[data-slot="reply-suggestions-failure-trigger"]') as Element);
    fireEvent.click(document.querySelector('[data-action="dismiss"]') as Element);
    assert.equal((props.onDismiss as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it('(f) every state category picks its own line', () => {
    for (const [category, fragment] of [
      ['misconfigured', 'required setting'],
      ['rate-limit', 'Too many'],
      ['circuit-open', 'paused'],
      ['network', 'Could not reach'],
      ['unknown', 'could not be generated'],
    ] as const) {
      const { view } = renderNotice({ failure: { ...failure, category, code: 'X', httpStatus: null } });
      assert.ok(
        view.container.querySelector('[data-slot="reply-suggestions-failure-notice"]')?.textContent?.includes(fragment),
        `${category} picks its own copy`,
      );
      view.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Composer integration: the failed strip replaces the absent chips
// ---------------------------------------------------------------------------

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

describe('composer failure notice integration', () => {
  it('(g) draws the notice in the empty box and no popover until the line is clicked', () => {
    const { container } = renderComposer(chipStripProps());
    assert.ok(container.querySelector('[data-slot="reply-suggestions-failure-notice"]'));
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]') === null);

    fireEvent.click(container.querySelector('[data-slot="reply-suggestions-failure-trigger"]') as Element);
    assert.ok(document.querySelector('[data-slot="reply-suggestions-failure-popover"]'));
  });

  it('(h) retry routes to the strip command and dismiss to the strip dismissal', () => {
    const strip = chipStripProps();
    const { container } = renderComposer(strip);
    fireEvent.click(container.querySelector('[data-slot="reply-suggestions-failure-trigger"]') as Element);
    fireEvent.click(document.querySelector('[data-action="retry"]') as Element);
    assert.equal((strip.onRequestSuggestions as ReturnType<typeof vi.fn>).mock.calls.length, 1);

    fireEvent.click(document.querySelector('[data-action="dismiss"]') as Element);
    assert.equal((strip.onDismissSuggestionFailure as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  });

  it('(i) a dismissed failure and a healthy empty box both render no notice', () => {
    const dismissed = renderComposer(chipStripProps({ suggestionFailureDismissed: true }));
    assert.ok(dismissed.container.querySelector('[data-slot="reply-suggestions-failure-notice"]') === null);
    dismissed.unmount();

    const healthy = renderComposer(chipStripProps({ suggestionFailure: null }));
    assert.ok(healthy.container.querySelector('[data-slot="reply-suggestions-failure-notice"]') === null);
  });
});
