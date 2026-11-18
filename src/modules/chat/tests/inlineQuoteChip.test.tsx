import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { ChatComposer } from '@/modules/chat-composer';
import { buildSuggestionChips } from '@/modules/chat-support';
import enChat from '@/modules/i18n/locales/en/chat.json';
import zhChat from '@/modules/i18n/locales/zh-CN/chat.json';
import { resetChatDrafts } from '@/shared/api/chatDrafts';
import type { ComposerChipStrip } from '@/shared/types';

/**
 * A live transcript selection must no longer be drawn inside the composer.
 *
 * This file used to pin the inline quote-chip mode: the mirror layer became the
 * visible text layer and the box grew a line while a selection existed. That mode
 * is gone — the transcript's floating action owns the selection now — so the same
 * fixtures assert its absence instead: no chip, no placeholder, no transparent
 * textarea, and no empty-box strip switched on by the quoted chip alone.
 *
 * The quoted chip may still be PRESENT in `chipStrip.chips`; what matters is that
 * the composer does not draw it. That keeps the single acceptance entry available
 * to the transcript action without letting a selection resize the box.
 */

// The listen's state is read by the composer to decide whether a dictation owns
// the box; the mock keeps it mutable so a case can put a listen in progress.
const voiceMock = vi.hoisted(() => ({ state: 'idle' as string }));

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

vi.mock('@/modules/chat-support/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

vi.mock('@/shared/voice/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  voiceDebugFlushSilenceSec: () => undefined,
}));

vi.mock('@/modules/chat-voice/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: voiceMock.state,
    inFlight: false,
    toggle: () => undefined,
    stop: () => undefined,
    transcribeFile: () => undefined,
    clipSlot: null,
    clipPlayState: { original: 'idle', trimmed: 'idle' },
    toggleClipPlayback: () => undefined,
    writeSentLabels: () => undefined,
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

const QUOTED = '选中的原文';

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
  onShowTokenUsage: vi.fn(),
  slashCommandsCount: 0,
  onToggleCommandMenu: vi.fn(),
  hasInput: false,
  onClearInput: () => undefined,
  onSubmit: vi.fn(),
  isDragActive: false,
  queuedDraft: null,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: vi.fn(),
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
  renderInputWithMentions: (text: string) => text,
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
  chipStrip: baseChipStrip(),
});

function baseChipStrip(overrides: Partial<ComposerChipStrip> = {}): ComposerChipStrip {
  return {
    visible: true,
    selectedIndex: null,
    listId: 'suggestion-list',
    chips: [],
    onAccept: () => undefined,
    suggestionsEnabled: true,
    suggestionsLoading: false,
    onRequestSuggestions: () => undefined,
    expansionChips: [],
    onAcceptExpansionChip: () => undefined,
    ...overrides,
  };
}

const quotedStrip = (overrides: Partial<ComposerChipStrip> = {}): ComposerChipStrip => baseChipStrip({
  chips: buildSuggestionChips({ quotedText: QUOTED }),
  ...overrides,
});

type Overrides = Record<string, unknown>;

const renderComposer = (overrides: Overrides = {}) => render(React.createElement(
  ChatComposer,
  { ...composerBaseProps(), ...overrides } as unknown as React.ComponentProps<typeof ChatComposer>,
));

const textareaOf = (view: ReturnType<typeof render>): HTMLTextAreaElement => {
  const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(textarea, 'the composer must render a textarea');
  return textarea;
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  voiceMock.state = 'idle';
});

afterEach(() => {
  vi.restoreAllMocks();
  voiceMock.state = 'idle';
});

// ---------------------------------------------------------------------------
// The retired inline mode leaves no trace in the composer
// ---------------------------------------------------------------------------

describe('a quoted selection draws nothing in the composer', () => {
  it('draws no inline chip and no placeholder over a non-empty box', () => {
    const view = renderComposer({ input: '前面后面', chipStrip: quotedStrip() });

    assert.equal(
      view.container.querySelector('[data-slot="inline-quote-chip"]') === null,
      true,
      'the inline quote chip path is retired',
    );
    assert.equal(
      view.container.querySelector('[data-slot="inline-quote-chip-spacer"]') === null,
      true,
      'the mirror carries no chip placeholder',
    );
    const textarea = textareaOf(view);
    assert.equal(textarea.getAttribute('data-inline-chip-mode'), null);
    assert.equal(textarea.style.getPropertyValue('color'), '', 'the textarea text is never hidden');

    const mirror = view.container.querySelector<HTMLElement>('div.chat-input-placeholder');
    assert.ok(mirror, 'the composer must render the mirror layer');
    assert.ok(mirror.className.includes('text-transparent'), 'the mirror stays invisible');
    assert.equal(mirror.className.includes('text-foreground'), false);
    assert.equal(mirror.closest('[aria-hidden="true"]') === null, false, 'the mirror stays aria-hidden');
  });

  it('does not switch an empty box into the shared-line strip for the quoted chip alone', () => {
    const view = renderComposer({ input: '', chipStrip: quotedStrip() });

    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip"]') === null, true);
    // The quoted chip is still in the strip data (the acceptance entry reads it),
    // but it may not light up the drawn strip by itself: doing so changed the
    // textarea's rows and therefore its height. Before and after a selection the
    // box keeps the same default rows.
    assert.equal(view.queryByRole('listbox'), null, 'a selection alone draws no composer strip');
    const textarea = textareaOf(view);
    assert.equal(textarea.getAttribute('rows'), null, 'the default row count is untouched');
    assert.equal(textarea.getAttribute('data-inline-chip-mode'), null);
  });

  it('keeps the non-quoted suggestion sources on an empty box', () => {
    const view = renderComposer({
      input: '',
      chipStrip: quotedStrip({
        chips: buildSuggestionChips({ quotedText: QUOTED, habitChips: ['检查进展'] }),
      }),
    });

    const listbox = view.getByRole('listbox');
    assert.ok(listbox, 'the empty-box strip still serves the other sources');
    const sources = Array.from(view.container.querySelectorAll('[role="option"]'))
      .map((option) => option.getAttribute('data-chip-source'));
    assert.ok(sources.includes('habit'), `the habit chip still draws; sources read ${String(sources)}`);
    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip"]') === null, true);
  });

  it('leaves no mode trace when the selection goes away', () => {
    const view = renderComposer({ input: '前面后面', chipStrip: quotedStrip() });
    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip"]') === null, true);

    view.rerender(React.createElement(ChatComposer, {
      ...composerBaseProps(),
      input: '前面后面',
      chipStrip: baseChipStrip({ visible: false, chips: [] }),
    } as unknown as React.ComponentProps<typeof ChatComposer>));

    const textarea = textareaOf(view);
    assert.equal(textarea.getAttribute('data-inline-chip-mode'), null);
    assert.equal(textarea.style.getPropertyValue('color'), '');
    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip-spacer"]') === null, true);
  });
});

// ---------------------------------------------------------------------------
// The retired path added no locale key, and must not grow one now
// ---------------------------------------------------------------------------

describe('locale key sets', () => {
  /** Every leaf path in a locale object, sorted — one locale's complete key set. */
  const keyPaths = (value: unknown, prefix = ''): string[] => {
    if (value === null || typeof value !== 'object') {
      return [prefix];
    }
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
      keyPaths(child, prefix ? `${prefix}.${key}` : key)
    ));
  };
  const digestOf = (value: unknown): string => createHash('sha256')
    .update(keyPaths(value).sort().join('\n'))
    .digest('hex');
  // Digests taken from the locale files after the selection-aware suggest
  // highlight added `input.suggestions.suggestForSelection` to every locale. The
  // transcript action REUSES that key; retiring the inline chip must not add a
  // key either. Re-measured 2026-11-18 when the failure notice deliberately added
  // the `input.suggestions.failure` block to every locale (task
  // gap-reply-suggestions-failure-reading-and-inline-notice): this is the only
  // intended key-set change, and the pin still catches any later accidental add.
  const EN_KEY_SET_DIGEST = 'aac3d9951e2f8f3b9d4e2c5fd583e71f2aa173cf433c23df2652f81af357fe11';
  const ZH_KEY_SET_DIGEST = '67a400586cfb08f872a391ad7720bd60d28c5da482f59a601f874f1dd02b8494';

  it('keeps the en and zh-CN key sets unchanged', () => {
    assert.equal(digestOf(enChat), EN_KEY_SET_DIGEST, 'en key set unchanged');
    assert.equal(digestOf(zhChat), ZH_KEY_SET_DIGEST, 'zh-CN key set unchanged');
  });
});
