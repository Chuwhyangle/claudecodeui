import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { ChatComposer } from '@/modules/chat-composer';
import { useSuggestionChips } from '@/modules/chat-composer';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ComposerChipStrip } from '@/shared/types';

/**
 * The one affordance this surface adds: while a transcript passage is selected and the
 * box is still empty, the Suggest control says so — a ring plus the selection wording on
 * the wide tier, a ring plus a decorative dot on the compact tier. Everything about a
 * press stays as it was; these cases pin both halves of that.
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
  apiMocks.status.mockReset().mockImplementation(() => Promise.resolve({
    enabled: true, expansion: 'off', maxChips: 3, maxChipChars: 120,
  }));
  apiMocks.suggest.mockReset().mockImplementation(() => Promise.resolve({
    ok: true, result: { chips: ['模型一'], draw: 3 },
  }));
  apiMocks.event.mockReset().mockImplementation(() => Promise.resolve(true));
});

// The window signals the compact tier reads. Both are restored per case so one case's
// viewport cannot decide another's arrangement.
const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The composer surface
// ---------------------------------------------------------------------------

const SELECTION_LABEL = enChat.input.suggestions.suggestForSelection;

/** The one chip prop the composer takes; the default strip has no selection. */
const chipStripProps = (overrides: Partial<ComposerChipStrip> = {}): ComposerChipStrip => ({
  visible: false,
  selectedIndex: null,
  listId: 'suggestion-list',
  chips: [],
  onAccept: vi.fn(),
  suggestionsEnabled: true,
  hasTranscriptSelection: false,
  suggestionsLoading: false,
  onRequestSuggestions: vi.fn(),
  expansionChips: [],
  onAcceptExpansionChip: vi.fn(),
  ...overrides,
});

const chipStripOf = (props: Record<string, unknown>): ComposerChipStrip => (
  props.chipStrip as ComposerChipStrip
);

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

const renderComposer = (overrides: Record<string, unknown> = {}) => {
  const props = { ...composerBaseProps(), ...overrides };
  const view = render(React.createElement(
    ChatComposer,
    props as unknown as React.ComponentProps<typeof ChatComposer>,
  ));
  return { view, props };
};

const suggestButton = (container: HTMLElement): HTMLButtonElement | null => (
  container.querySelector('[data-slot="reply-suggest-button"]')
);

/**
 * The button's class list as tokens. A substring check is vacuous here: the resting
 * classes already carry `focus-visible:ring-2` and `hover:border-primary/60`, so
 * `includes('ring-2')`/`includes('border-primary')` would pass with no highlight at
 * all. The highlight's classes are unvariant tokens.
 */
const classTokens = (button: HTMLButtonElement): string[] => button.className.split(/\s+/).filter(Boolean);

/**
 * The compact tier is taken from the window below `md`. jsdom implements no media
 * queries, so the double answers "no" to every query; the width alone is enough for
 * `isMobile`, which is the same pattern `composerCompactTier.test.tsx` uses.
 */
const installCompactViewport = () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
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

describe('the Suggest control advertises a transcript selection', () => {
  it('(a) is highlighted on the wide tier with a selection, an empty box and an idle feature', () => {
    const { view, props } = renderComposer({
      chipStrip: chipStripProps({ hasTranscriptSelection: true }),
    });
    const button = suggestButton(view.container);
    assert.ok(button, 'the Suggest control is drawn when the feature is on');

    assert.equal(button.getAttribute('data-reply-suggest-highlighted'), 'true');
    assert.equal(button.textContent, SELECTION_LABEL, 'the wide tier says what the press will use');
    assert.equal(button.getAttribute('aria-label'), SELECTION_LABEL);
    assert.ok(classTokens(button).includes('ring-2'), 'the highlight is visible, not only an attribute');
    assert.ok(classTokens(button).includes('border-primary'));

    fireEvent.click(button);
    assert.equal(
      (chipStripOf(props).onRequestSuggestions as ReturnType<typeof vi.fn>).mock.calls.length,
      1,
      'the highlight does not change the press path',
    );
  });

  it('(b) draws no highlight without a transcript selection', () => {
    const { view } = renderComposer({ chipStrip: chipStripProps({ hasTranscriptSelection: false }) });
    const button = suggestButton(view.container);
    assert.ok(button);

    assert.equal(button.hasAttribute('data-reply-suggest-highlighted'), false);
    assert.equal(button.textContent, enChat.input.suggestions.suggest);
    assert.equal(button.getAttribute('aria-label'), enChat.input.suggestions.suggest);
    assert.equal(classTokens(button).includes('ring-2'), false);
  });

  it('(c) draws no highlight while the draft is not empty', () => {
    const { view } = renderComposer({
      input: '已经写了一半',
      chipStrip: chipStripProps({ hasTranscriptSelection: true }),
    });
    const button = suggestButton(view.container);
    assert.ok(button);

    assert.equal(button.hasAttribute('data-reply-suggest-highlighted'), false);
    assert.equal(button.textContent, enChat.input.suggestions.suggest);
    assert.equal(classTokens(button).includes('ring-2'), false);
  });

  it('(d) keeps the loading spinner and the failure reading ahead of the highlight', async () => {
    // The compact tier is the one that draws the spinner (the wide tier's in-flight
    // reading is the "Suggesting…" label), so both segments run there.
    installCompactViewport();
    const { view } = renderComposer({
      chipStrip: chipStripProps({ hasTranscriptSelection: true, suggestionsLoading: true }),
    });
    const loading = suggestButton(view.container);
    assert.ok(loading);
    assert.equal(loading.getAttribute('data-reply-suggest-state'), 'loading');
    assert.equal(loading.hasAttribute('data-reply-suggest-highlighted'), false);
    assert.ok(loading.querySelector('svg.animate-spin'), 'the spinner is still the in-flight reading');

    const failedRender = renderComposer({
      chipStrip: chipStripProps({
        hasTranscriptSelection: true,
        onRequestSuggestions: () => Promise.resolve(false),
      }),
    });
    const idle = suggestButton(failedRender.view.container);
    assert.ok(idle);
    assert.equal(
      idle.getAttribute('data-reply-suggest-highlighted'),
      'true',
      'precondition: the control starts highlighted',
    );

    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(idle);
        await Promise.resolve();
        await Promise.resolve();
      });

      const failed = suggestButton(failedRender.view.container);
      assert.ok(failed);
      assert.equal(failed.getAttribute('data-reply-suggest-state'), 'failed');
      assert.equal(failed.hasAttribute('data-reply-suggest-highlighted'), false);
      assert.ok(failed.className.includes('text-destructive'), 'the failure colour wins');

      act(() => {
        vi.advanceTimersByTime(3000);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('(e) is a ring plus a decorative dot on the compact tier', () => {
    installCompactViewport();
    const { view } = renderComposer({
      chipStrip: chipStripProps({ hasTranscriptSelection: true }),
    });
    const button = suggestButton(view.container);
    assert.ok(button);

    assert.equal(button.getAttribute('data-reply-suggest-highlighted'), 'true');
    assert.equal(button.getAttribute('aria-label'), SELECTION_LABEL);
    assert.ok(classTokens(button).includes('ring-2'));
    const dot = button.querySelector('[data-slot="reply-suggest-dot"]');
    assert.ok(dot, 'the compact tier publishes the dot for tests and scenarios');
    assert.equal(dot.getAttribute('aria-hidden'), 'true');

    const withoutSelection = renderComposer({
      chipStrip: chipStripProps({ hasTranscriptSelection: false }),
    });
    const plain = suggestButton(withoutSelection.view.container);
    assert.ok(plain);
    assert.equal(plain.hasAttribute('data-reply-suggest-highlighted'), false);
    assert.equal(plain.querySelector('[data-slot="reply-suggest-dot"]'), null);
    assert.equal(plain.getAttribute('aria-label'), enChat.input.suggestions.suggest);
  });
});

// ---------------------------------------------------------------------------
// Where the flag comes from: the hook, not the component stub
// ---------------------------------------------------------------------------

/** The chip hook fed a selection the test can change, as the page's selection does. */
const renderChipHook = (initialSelection: string | null) => renderHook(
  ({ selection }: { selection: string | null }) => useSuggestionChips({
    input: '',
    inputValueRef: { current: '' },
    textareaRef: { current: null },
    setInputFromHistory: () => undefined,
    submit: () => undefined,
    conditions: {
      isLoading: false,
      isOccupied: false,
      isCommandMenuOpen: false,
      isFileMenuOpen: false,
      hasQueuedDraft: false,
      hasAttachments: false,
    },
    draftScope: 'session-a',
    sessionId: 'session-a',
    lastAssistantMessageId: 'assistant-1',
    quotedSelection: selection,
  }),
  { initialProps: { selection: initialSelection } as { selection: string | null } },
);

describe('the chip hook publishes the live selection (the highlight’s source)', () => {
  it('sets hasTranscriptSelection from the trimmed selection and drops it with the selection', () => {
    const { result, rerender } = renderChipHook('选中的原文');
    assert.equal(result.current.chipStrip.hasTranscriptSelection, true);

    rerender({ selection: null });
    assert.equal(result.current.chipStrip.hasTranscriptSelection, false);

    rerender({ selection: '   ' });
    assert.equal(result.current.chipStrip.hasTranscriptSelection, false, 'whitespace is not a selection');
  });
});

// ---------------------------------------------------------------------------
// The copy exists in every locale (AC2)
// ---------------------------------------------------------------------------

type LocaleChatFile = {
  input?: { suggestions?: { suggestForSelection?: unknown } };
};

// Eager so the case is a plain synchronous read; the glob is what makes a newly added
// locale file part of the check without anyone remembering to list it.
const localeChatFiles = import.meta.glob(
  '@/modules/i18n/locales/*/chat.json',
  { eager: true },
) as Record<string, { default: LocaleChatFile }>;

describe('the selection copy in every locale', () => {
  it('is a non-empty string everywhere, with the zh-CN and en wording fixed', () => {
    const entries = Object.entries(localeChatFiles);
    assert.ok(entries.length >= 12, `expected all 12 locale files, found ${entries.length}`);

    for (const [path, module] of entries) {
      const value = module.default.input?.suggestions?.suggestForSelection;
      assert.equal(typeof value, 'string', `${path} has no suggestForSelection string`);
      assert.ok((value as string).trim().length > 0, `${path} has an empty suggestForSelection`);
    }

    const valueOf = (locale: string): unknown => {
      const key = Object.keys(localeChatFiles).find((path) => path.includes(`/locales/${locale}/`));
      assert.ok(key, `no ${locale} chat.json among the locale files`);
      return localeChatFiles[key].default.input?.suggestions?.suggestForSelection;
    };

    assert.equal(valueOf('zh-CN'), '用选段生成建议');
    assert.equal(valueOf('en'), 'Suggest from selection');
  });
});
