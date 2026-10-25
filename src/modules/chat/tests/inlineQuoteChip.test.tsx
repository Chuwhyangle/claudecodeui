import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { buildSuggestionChips, truncateSuggestionLabel } from '@/modules/chat/utils/inputSuggestions';
import enChat from '@/modules/i18n/locales/en/chat.json';
import zhChat from '@/modules/i18n/locales/zh-CN/chat.json';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { ComposerChipStrip } from '@/shared/types';

/**
 * The quoted chip while the composer holds text: it belongs IN the draft, at the
 * caret, not in the strip above the box.
 *
 * The behaviour under test is the mode switch itself — when the mode is on, what
 * the mirror layer splits around, what the real button exposes, and how the box
 * returns to its ordinary shape. Geometry (the placeholder pushing text aside,
 * the button sitting on it, the height following the mirror) needs a layout
 * engine and lives in the task's real-page DoD; here each AC leg is one case.
 */

// The listen's state is read by the composer to decide whether a dictation owns
// the box; the mock keeps it mutable so one case can put a listen in progress.
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

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  voiceDebugFlushSilenceSec: () => undefined,
}));

vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
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
  // The mirror's before/after halves are read back as text: the stub renders the
  // string it is handed, which is what the real renderer does for plain text.
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

const rerenderComposer = (view: ReturnType<typeof render>, overrides: Overrides = {}) => view.rerender(
  React.createElement(
    ChatComposer,
    { ...composerBaseProps(), ...overrides } as unknown as React.ComponentProps<typeof ChatComposer>,
  ),
);

const textareaOf = (view: ReturnType<typeof render>): HTMLTextAreaElement => {
  const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea');
  assert.ok(textarea, 'the composer must render a textarea');
  return textarea;
};

const mirrorOf = (view: ReturnType<typeof render>): HTMLElement => {
  const mirror = view.container.querySelector<HTMLElement>('div.chat-input-placeholder');
  assert.ok(mirror, 'the composer must render the mirror layer');
  return mirror;
};

const inlineButtonOf = (view: ReturnType<typeof render>): HTMLButtonElement => {
  const button = view.container.querySelector<HTMLButtonElement>('[data-slot="inline-quote-chip"]');
  assert.ok(button, 'the inline quote chip must be drawn');
  return button;
};

const spacerOf = (view: ReturnType<typeof render>): HTMLElement => {
  const spacer = view.container.querySelector<HTMLElement>('[data-slot="inline-quote-chip-spacer"]');
  assert.ok(spacer, 'the mirror must carry the chip placeholder');
  return spacer;
};

/**
 * Puts the composer into the inline mode the way the app does: a non-empty draft
 * already exists, the caret sits where the person left it, and a transcript
 * selection then supplies the quoted chip.
 */
const showInlineChip = (
  input: string,
  selectionEnd: number,
  strip: ComposerChipStrip = quotedStrip(),
) => {
  const view = renderComposer({ input, chipStrip: baseChipStrip() });
  const textarea = textareaOf(view);
  textarea.setSelectionRange(selectionEnd, selectionEnd);
  rerenderComposer(view, { input, chipStrip: strip });
  return { view, textarea: textareaOf(view) };
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
// (a) structure: the button and the mirror's placeholder at selectionEnd
// ---------------------------------------------------------------------------

describe('inline mode structure', () => {
  it('(a) draws the button and a placeholder at selectionEnd, split by UTF-16 units', () => {
    // 'a' (1 unit) + surrogate-pair emoji (2 units) + 中 + bc; index 3 is after
    // the emoji, so a split at a code-unit boundary must not cut it in half.
    const input = 'a😀中bc';
    const { view, textarea } = showInlineChip(input, 3);

    assert.equal(textarea.selectionEnd, 3, 'the caret is where the person left it');
    const spacer = spacerOf(view);
    assert.equal(spacer.previousSibling?.textContent, 'a😀', 'everything before the caret');
    assert.equal(spacer.nextSibling?.textContent, '中bc', 'everything after the caret');
    assert.ok(inlineButtonOf(view).textContent?.includes(QUOTED));

    // The strip has nothing left to draw: the quoted chip moved into the flow.
    assert.equal(view.queryByRole('listbox') === null, true);
  });

  it('(j) splits with a non-empty after-half and with an empty one (caret at the end)', () => {
    const middle = showInlineChip('前面后面', 2);
    const middleSpacer = spacerOf(middle.view);
    assert.equal(middleSpacer.previousSibling?.textContent, '前面');
    assert.equal(middleSpacer.nextSibling?.textContent, '后面');

    const end = showInlineChip('前面后面', 4);
    const endSpacer = spacerOf(end.view);
    assert.equal(endSpacer.previousSibling?.textContent, '前面后面');
    assert.equal(endSpacer.nextSibling === null, true, 'nothing follows a caret at the end');
  });
});

// ---------------------------------------------------------------------------
// (b)-(d) when the mode must NOT be on
// ---------------------------------------------------------------------------

describe('inline mode preconditions', () => {
  it('(b) does not draw it over an empty box, and the quoted chip stays in the row', () => {
    const view = renderComposer({ input: '', chipStrip: quotedStrip() });

    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip"]') === null, true);
    assert.ok(view.getByRole('listbox'), 'the empty-box strip is unchanged');
    const option = view.getByRole('option');
    assert.equal(option.getAttribute('data-chip-source'), 'quoted');
  });

  it('(c) does not draw it without a live selection', () => {
    const view = renderComposer({
      input: '已经写了一半',
      chipStrip: baseChipStrip({ chips: buildSuggestionChips({ habitChips: ['检查进展'] }) }),
    });

    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip"]') === null, true);
  });

  it('(d) does not draw it while a listen owns the box', () => {
    voiceMock.state = 'recording';
    const view = renderComposer({
      input: 'abcdef',
      voiceRange: { start: 0, end: 2 },
      chipStrip: quotedStrip(),
    });

    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip"]') === null, true);
  });
});

// ---------------------------------------------------------------------------
// (e) the mode switch itself, and its reversal
// ---------------------------------------------------------------------------

describe('inline mode switch', () => {
  it('(e) hides the textarea text, shows the mirror text, and restores both on exit', () => {
    const { view, textarea } = showInlineChip('前面后面', 2);

    assert.equal(textarea.getAttribute('data-inline-chip-mode'), 'true');
    assert.equal(textarea.style.getPropertyValue('color'), 'transparent');

    let mirror = mirrorOf(view);
    assert.equal(mirror.className.includes('text-foreground'), true, 'the mirror carries the visible text');
    assert.equal(mirror.className.includes('text-transparent'), false);

    rerenderComposer(view, { input: '前面后面', chipStrip: baseChipStrip() });

    assert.equal(textarea.getAttribute('data-inline-chip-mode'), null);
    assert.equal(textarea.style.getPropertyValue('color'), '', 'the textarea text is restored');
    mirror = mirrorOf(view);
    assert.equal(mirror.className.includes('text-transparent'), true, 'the mirror goes back to being invisible');
    assert.equal(mirror.className.includes('text-foreground'), false);
  });
});

// ---------------------------------------------------------------------------
// (f)-(h) the real button's contract
// ---------------------------------------------------------------------------

describe('inline chip button', () => {
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
  // Digests taken from the locale files AFTER the suggestion strip retired the
  // second-line preview and the keyboard hint: the inline chip reuses the
  // existing `quoteChip` key and must not add one to any locale.
  const EN_KEY_SET_DIGEST = '6322ac76d8b216e9f833b1d0a93916acb97cd84f979eac4117cbca18dbd4fcf0';
  const ZH_KEY_SET_DIGEST = '2bf40ffe33de095726e3c650f1089b57cd13335fad2f5a0b11cedf91bfe398e6';

  it('(f) has a readable name from the existing key and the complete text in title', () => {
    const { view } = showInlineChip('前面后面', 2);
    const button = inlineButtonOf(view);

    assert.equal(button.getAttribute('title'), QUOTED);
    assert.equal(button.getAttribute('data-chip-source'), 'quoted');
    // No new i18n key: the wording is the chip row's own `input.suggestions.quoteChip`.
    assert.equal(
      button.textContent,
      i18next.t('input.suggestions.quoteChip', { text: truncateSuggestionLabel(QUOTED, 20) }),
    );
    assert.equal(button.getAttribute('aria-label'), null, 'the visible text is the accessible name');

    assert.equal(digestOf(enChat), EN_KEY_SET_DIGEST, 'en key set unchanged');
    assert.equal(digestOf(zhChat), ZH_KEY_SET_DIGEST, 'zh-CN key set unchanged');
  });

  it('(g) cancels mousedown so the transcript selection survives the press', () => {
    const { view } = showInlineChip('前面后面', 2);
    const button = inlineButtonOf(view);

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(mouseDown);

    assert.equal(mouseDown.defaultPrevented, true);
  });

  it('(h) clicks go through the one acceptance entry, exactly once, with the quoted chip', () => {
    const onAccept = vi.fn();
    const strip = quotedStrip({ onAccept });
    const { view } = showInlineChip('前面后面', 2, strip);

    fireEvent.click(inlineButtonOf(view));

    assert.equal(onAccept.mock.calls.length, 1);
    const [accepted] = onAccept.mock.calls[0] as [{ source: string; text: string }];
    assert.equal(accepted.source, 'quoted');
    assert.equal(accepted.text, QUOTED);
  });
});

// ---------------------------------------------------------------------------
// (i) the mode leaves when the live selection does
// ---------------------------------------------------------------------------

describe('inline mode exit', () => {
  it('(i) exits when the live selection disappears', () => {
    const { view, textarea } = showInlineChip('前面后面', 2);
    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip"]') !== null, true);

    rerenderComposer(view, { input: '前面后面', chipStrip: baseChipStrip({ visible: false, chips: [] }) });

    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip"]') === null, true);
    assert.equal(view.container.querySelector('[data-slot="inline-quote-chip-spacer"]') === null, true);
    assert.equal(textarea.getAttribute('data-inline-chip-mode'), null);
    assert.equal(textarea.style.getPropertyValue('color'), '');
  });
});
