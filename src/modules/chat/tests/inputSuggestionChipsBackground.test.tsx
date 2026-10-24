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
import type { ComposerChipStrip } from '@/shared/types';

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

const habitChips = () => buildSuggestionChips({ habitChips: ['第一', '第二'] });

const renderChips = (
  overrides: Partial<React.ComponentProps<typeof InputSuggestionChips>> = {},
) => render(React.createElement(InputSuggestionChips, {
  listId: 'suggestion-list',
  chips: habitChips(),
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

  it('(c) accepts the clicked chip with exactly that chip', () => {
    const onAccept = vi.fn();
    const view = renderChips({ onAccept });

    fireEvent.click(view.getByRole('option', { name: '第二' }));

    assert.deepEqual(
      onAccept.mock.calls.map(([chip]) => (chip as { text: string }).text),
      ['第二'],
    );
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
  chipStrip: baseChipStrip(),
});

/**
 * The one chip prop the composer takes. The default draws the two habit chips so
 * the strip has a real listbox; individual cases narrow it.
 */
function baseChipStrip(overrides: Partial<ComposerChipStrip> = {}): ComposerChipStrip {
  return {
    visible: true,
    selectedIndex: null,
    listId: 'suggestion-list',
    chips: buildSuggestionChips({ habitChips: ['检查进展', '提交'] }),
    onAccept: () => undefined,
    suggestionsEnabled: true,
    suggestionsLoading: false,
    onRequestSuggestions: () => undefined,
    expansionChips: [],
    onAcceptExpansionChip: () => undefined,
    ...overrides,
  };
}

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
// A quoted chip over a non-empty box lives IN the text flow, not in the strip
// ---------------------------------------------------------------------------

/**
 * The chip that used to sit in the strip above a filled box now has its own mode:
 * the mirror layer becomes the visible text layer, the chip is an inline-block
 * placeholder in that text, and a real button is drawn over the placeholder. The
 * strip above the box is drawn only when the box is empty.
 */
const INLINE_CHIP_SELECTOR = '[data-slot="inline-quote-chip"]';
const INLINE_SPACER_SELECTOR = '[data-slot="inline-quote-chip-spacer"]';

const quotedChips = () => buildSuggestionChips({ quotedText: '选中的原文' });

const renderComposerOverStrip = (overrides: Record<string, unknown> = {}) => render(React.createElement(
  ChatComposer,
  {
    ...composerBaseProps(),
    chipStrip: baseChipStrip({ chips: quotedChips() }),
    ...overrides,
  } as unknown as React.ComponentProps<typeof ChatComposer>,
));

describe('a quoted chip over a non-empty box', () => {
  it('(a) draws it in the text flow: a real button over the mirror placeholder', () => {
    const view = renderComposerOverStrip({ input: '选中的原文\n\n' });

    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea, 'the composer must render a textarea');
    const button = view.container.querySelector<HTMLElement>(INLINE_CHIP_SELECTOR);
    assert.ok(button, 'the quoted chip is drawn in the text flow while the box holds text');
    assert.equal(button.getAttribute('data-chip-source'), 'quoted');
    assert.ok(
      view.container.querySelector(INLINE_SPACER_SELECTOR),
      'the mirror layer carries the placeholder the button is drawn over',
    );
    assert.equal(textarea.getAttribute('data-inline-chip-mode'), 'true');
    assert.equal(view.queryByRole('listbox') === null, true, 'the strip has nothing left to draw');
  });

  it('(b) leaves the empty-box layout unchanged', () => {
    const view = renderComposerOverStrip({
      input: '',
      chipStrip: baseChipStrip({ chips: buildSuggestionChips({ habitChips: ['检查进展'] }) }),
    });

    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea);
    assert.equal(
      view.container.querySelector(INLINE_CHIP_SELECTOR) === null,
      true,
      'the empty box has no inline chip',
    );
    assert.ok(view.getByRole('listbox'), 'the empty box keeps the chip row');
  });

  it('(c) moves from the chip row into the text flow as the box gains text', () => {
    const view = renderComposerOverStrip({ input: '' });
    assert.ok(view.getByRole('listbox'));
    assert.equal(view.container.querySelector(INLINE_CHIP_SELECTOR) === null, true);

    view.rerender(React.createElement(ChatComposer, {
      ...composerBaseProps(),
      input: '选中的原文\n\n',
      chipStrip: baseChipStrip({ chips: quotedChips() }),
    } as unknown as React.ComponentProps<typeof ChatComposer>));

    assert.ok(view.container.querySelector(INLINE_CHIP_SELECTOR), 'the filled quote moves into the text flow');
    assert.equal(view.queryByRole('listbox') === null, true, 'nothing remains in the strip');
  });
});

// ---------------------------------------------------------------------------
// Deleting the reserved 48px row must not change the empty-box layout at all
// ---------------------------------------------------------------------------

describe('empty-box layout', () => {
  it('keeps the textarea and mirror class lists byte-for-byte unchanged', () => {
    const view = renderComposerOverStrip({ input: '' });

    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea);
    const mirror = view.container.querySelector('div.chat-input-placeholder');
    assert.ok(mirror);

    assert.equal(
      textarea.className,
      'chat-input-placeholder block max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-4 py-2 text-sm leading-6 text-foreground placeholder-muted-foreground/50 focus:outline-none sm:max-h-[min(300px,45vh)]',
    );
    assert.equal(
      mirror.className,
      'chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent',
    );
  });
});
