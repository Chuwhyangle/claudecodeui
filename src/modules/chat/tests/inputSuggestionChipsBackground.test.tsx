import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { InputSuggestionChips } from '@/modules/chat/composer/InputSuggestionChips';
import { buildSuggestionChips } from '@/modules/chat/utils/inputSuggestions';
import enChat from '@/modules/i18n/locales/en/chat.json';

/**
 * The suggestion strip's background is a click target of its own: the listbox
 * used to be `flex-1`, stretching over the textarea and eating every press
 * that landed outside a chip. jsdom has no layout, so the geometry half lives
 * in the task's real-page DoD; here one leg per contract:
 *
 * (a) a press on the listbox itself is cancelled and routed to the composer,
 * (b) a press on a chip is still cancelled but is not a background press,
 * (c) clicking a chip accepts exactly that chip,
 * (d) the hook is optional — no callback, no throw,
 * (e) through the real composer, that routed press focuses the textarea,
 * (f) the listbox no longer carries `flex-1`, the root cause's class.
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

/** A real, cancelable mousedown so `defaultPrevented` is readable afterwards. */
const press = () => new MouseEvent('mousedown', { bubbles: true, cancelable: true });

const renderChips = (
  overrides: Partial<React.ComponentProps<typeof InputSuggestionChips>> = {},
) => render(React.createElement(InputSuggestionChips, {
  listId: 'suggestion-list',
  suggestions: ['第一', '第二'],
  selectedIndex: null,
  onAccept: () => undefined,
  ...overrides,
}));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The strip on its own — one leg per contract line
// ---------------------------------------------------------------------------

describe('suggestion strip background press', () => {
  it('(a) cancels a press on the listbox itself and calls onBackgroundPress once', () => {
    const onBackgroundPress = vi.fn();
    const view = renderChips({ onBackgroundPress });

    const listbox = view.getByRole('listbox');
    const mouseDown = press();
    listbox.dispatchEvent(mouseDown);

    assert.equal(mouseDown.defaultPrevented, true);
    assert.equal(onBackgroundPress.mock.calls.length, 1);
  });

  it('(b) cancels a press on a chip without treating it as a background press', () => {
    const onBackgroundPress = vi.fn();
    const view = renderChips({ onBackgroundPress });

    const chip = view.getByRole('option', { name: '第一' });
    const mouseDown = press();
    chip.dispatchEvent(mouseDown);

    assert.equal(mouseDown.defaultPrevented, true);
    assert.equal(onBackgroundPress.mock.calls.length, 0);
  });

  it('(c) accepts the clicked chip with exactly its own index', () => {
    const onAccept = vi.fn();
    const view = renderChips({ onAccept });

    fireEvent.click(view.getByRole('option', { name: '第二' }));

    assert.deepEqual(onAccept.mock.calls, [[1]]);
  });

  it('(d) does not throw on a background press when the callback is omitted', () => {
    const view = renderChips();

    const listbox = view.getByRole('listbox');
    assert.doesNotThrow(() => {
      listbox.dispatchEvent(press());
    });
  });

  it('(f) keeps `flex-1` off the listbox, the class that stretched it over the textarea', () => {
    const view = renderChips();

    const listbox = view.getByRole('listbox');
    const tokens = listbox.className.split(/\s+/).filter(Boolean);
    assert.equal(tokens.includes('flex-1'), false);
  });
});

// ---------------------------------------------------------------------------
// Through the real composer: the routed press is what restores focus
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
  onShowTokenUsage: vi.fn(),
  slashCommandsCount: 0,
  onToggleCommandMenu: vi.fn(),
  hasInput: false,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
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
  inputSuggestionCandidates: ['检查进展', '提交'],
  inputSuggestionsVisible: true,
  selectedInputSuggestionIndex: null,
  inputSuggestionListId: 'suggestion-list',
  onAcceptInputSuggestion: () => undefined,
});

describe('composer wiring', () => {
  it('(e) focuses the composer textarea when the strip background is pressed', () => {
    const textareaRef = React.createRef<HTMLTextAreaElement>();
    const view = render(React.createElement(ChatComposer, {
      ...composerBaseProps(),
      textareaRef,
    } as unknown as React.ComponentProps<typeof ChatComposer>));

    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea, 'the composer must render a textarea');
    // Compare booleans, not the elements: a failing `assert.equal` on two DOM
    // nodes serialises them, and the message alone can exhaust the worker.
    assert.equal(textareaRef.current === textarea, true, 'the composer binds the ref to its own textarea');

    // Start from a blurred box so focus can only come from the press below.
    (document.activeElement as HTMLElement | null)?.blur();
    assert.equal(document.activeElement !== textarea, true, 'the box starts blurred');

    fireEvent.mouseDown(view.getByRole('listbox'));

    assert.equal(document.activeElement === textarea, true, 'the press must leave focus in the textarea');
  });
});

// ---------------------------------------------------------------------------
// The strip is an overlay: a non-empty box must not have its first line under it
// ---------------------------------------------------------------------------

/**
 * The flow row the composer reserves so the first text line starts below the
 * strip. A spacer rather than textarea padding: the textarea's auto-grow height
 * is measured before a padding class can land, so padding left the box short and
 * the browser scrolled the text back under the chips. A spacer is applied before
 * that measurement and cannot be undone by it.
 */
const CLEARANCE_SELECTOR = '[data-slot="chip-row-clearance"]';
const CLEARANCE_HEIGHT_CLASS = /(^|\s)h-12(\s|$)/u;

const quotedChips = () => buildSuggestionChips({ quotedText: '选中的原文' });

const renderComposerOverStrip = (overrides: Record<string, unknown> = {}) => render(React.createElement(
  ChatComposer,
  {
    ...composerBaseProps(),
    inputSuggestionCandidates: [],
    inputSuggestionsVisible: true,
    suggestionChips: quotedChips(),
    ...overrides,
  } as unknown as React.ComponentProps<typeof ChatComposer>,
));

describe('chip row clearance over a non-empty box', () => {
  it('(a) reserves the chip row above the text while a quoted chip shows', () => {
    const view = renderComposerOverStrip({ input: '> 选中的原文\n' });

    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea, 'the composer must render a textarea');
    const spacer = view.container.querySelector<HTMLElement>(CLEARANCE_SELECTOR);
    assert.ok(spacer, 'the box must reserve a row for the strip while text is present');
    assert.match(spacer.className, CLEARANCE_HEIGHT_CLASS, 'the reserved row is 48px, clearing the 40px chips and the 44px preview');
    assert.ok(view.getByRole('listbox'), 'the quoted chip row is still drawn');
  });

  it('(b) leaves the empty-box layout unchanged', () => {
    const view = renderComposerOverStrip({
      input: '',
      inputSuggestionCandidates: ['检查进展'],
      suggestionChips: undefined,
    });

    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea);
    assert.equal(view.container.querySelector(CLEARANCE_SELECTOR) === null, true, 'the empty box reserves no row');
  });

  it('(c) after the quote fills the box the row stays and the text keeps its clearance', () => {
    const view = renderComposerOverStrip({ input: '' });
    assert.equal(view.container.querySelector(CLEARANCE_SELECTOR) === null, true);

    view.rerender(React.createElement(ChatComposer, {
      ...composerBaseProps(),
      input: '> 选中的原文\n',
      inputSuggestionCandidates: [],
      inputSuggestionsVisible: true,
      suggestionChips: quotedChips(),
    } as unknown as React.ComponentProps<typeof ChatComposer>));

    const spacer = view.container.querySelector(CLEARANCE_SELECTOR);
    assert.ok(spacer, 'the filled quote gets the reserved row');
    assert.match(spacer.className, CLEARANCE_HEIGHT_CLASS);
    assert.ok(view.getByRole('listbox'), 'the quoted chip is still offered for appending a second passage');
  });
});
