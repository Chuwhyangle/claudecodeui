import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useReplySuggestions } from '@/modules/chat/hooks/useReplySuggestions';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { buildSuggestionChips } from '@/modules/chat/utils/inputSuggestions';
import type { ComposerChipStrip, PermissionMode, Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * What each chip source does when it is clicked, and what the Suggest button is.
 *
 * Two layers, because the click semantics live in two places: the component
 * routes a press to the callback that owns the source, and the composer state
 * turns that callback into a draft. The component cases prove the routing; the
 * hook cases prove that every chip — model replies included — only FILLS the
 * draft and focuses it, while a quoted chip pastes `> text`; none of them send.
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
    enabled: true, expansion: 'off', maxChips: 3, maxChipChars: 120,
  }));
  apiMocks.suggest.mockReset().mockImplementation(() => Promise.resolve({
    chips: ['模型一', '模型二'], draw: 3,
  }));
  apiMocks.event.mockReset().mockImplementation(() => Promise.resolve(true));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Component: routing and the Suggest control
// ---------------------------------------------------------------------------

/**
 * The one chip prop the composer takes, with both real callbacks and spy
 * entries for the ones the component surface is about to call.
 */
const chipStripProps = (overrides: Partial<ComposerChipStrip> = {}): ComposerChipStrip => ({
  visible: true,
  selectedIndex: null,
  listId: 'suggestion-list',
  chips: buildSuggestionChips({
    quotedText: '选中的原文',
    modelChips: ['模型一'],
    habitChips: ['习惯一'],
  }),
  onAccept: vi.fn(),
  suggestionsEnabled: true,
  suggestionsLoading: false,
  onRequestSuggestions: vi.fn(),
  expansionChips: [],
  onAcceptExpansionChip: vi.fn(),
  ...overrides,
});

/** The strip a composer render was given, read back for its spy callbacks. */
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

describe('chip clicks at the composer surface', () => {
  it('routes every source click through the one accept callback, never the form submit', () => {
    const { view, props } = renderComposer();
    const onAccept = chipStripOf(props).onAccept as ReturnType<typeof vi.fn>;
    const modelChip = view.container.querySelector('[data-chip-source="model"]');
    const quotedChip = view.container.querySelector('[data-chip-source="quoted"]');
    const habitChip = view.container.querySelector('[data-chip-source="habit"]');
    assert.ok(modelChip && quotedChip && habitChip);

    fireEvent.click(modelChip);
    fireEvent.click(quotedChip);
    fireEvent.click(habitChip);

    assert.deepEqual(
      onAccept.mock.calls.map(([chip]) => (chip as { source: string }).source),
      ['model', 'quoted', 'habit'],
      'one callback receives every source; what it does is the source descriptor’s business',
    );
    assert.equal((props.onSubmit as ReturnType<typeof vi.fn>).mock.calls.length, 0);
  });

  it('the Suggest button asks for a redraw, submits nothing, and is disabled while drawing', () => {
    const { view, props, } = renderComposer();
    const button = view.getByRole('button', { name: enChat.input.suggestions.suggest });
    assert.equal(button.hasAttribute('disabled'), false);

    fireEvent.click(button);
    assert.equal((chipStripOf(props).onRequestSuggestions as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    assert.equal((props.onSubmit as ReturnType<typeof vi.fn>).mock.calls.length, 0);

    view.rerender(React.createElement(ChatComposer, {
      ...composerBaseProps(),
      chipStrip: chipStripProps({ suggestionsLoading: true }),
    } as unknown as React.ComponentProps<typeof ChatComposer>));
    const busy = view.getByRole('button', { name: enChat.input.suggestions.suggest });
    assert.equal(busy.hasAttribute('disabled'), true, 'a second click must not become a second draw');
    assert.equal(busy.getAttribute('aria-busy'), 'true');
  });

  it('shows no Suggest button at all when the feature is off', () => {
    const { view } = renderComposer({ chipStrip: chipStripProps({ suggestionsEnabled: false }) });
    assert.equal(view.queryByRole('button', { name: enChat.input.suggestions.suggest }), null);
  });

  it('shows the complete text of the keyboard-selected chip on the second line', () => {
    const habitText = '这是一条足够长的习惯文本，用来验证第二行预览完整出现';
    const chips = buildSuggestionChips({ modelChips: ['模型一'], habitChips: [habitText] });
    const { view } = renderComposer({
      chipStrip: chipStripProps({ chips, selectedIndex: 1 }),
    });

    const preview = view.container.querySelector('[data-suggestion-preview]');
    assert.ok(preview, 'Tab selection must produce the second-line preview');
    assert.equal(preview.textContent, habitText);
  });

  it('draws the expansion chips under the textarea and routes a click to its callback', () => {
    const { view, props } = renderComposer({
      chipStrip: chipStripProps({ expansionChips: ['变体一', '变体二'] }),
    });

    const row = view.container.querySelector('[data-slot="reply-expansion-chips"]');
    assert.ok(row, 'the expansion row is its own element, not the empty-box strip');
    const buttons = row.querySelectorAll('button');
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].textContent, '变体一');

    fireEvent.click(buttons[1]);
    assert.deepEqual(
      (chipStripOf(props).onAcceptExpansionChip as ReturnType<typeof vi.fn>).mock.calls,
      [['变体二', 1]],
    );
    assert.equal((props.onSubmit as ReturnType<typeof vi.fn>).mock.calls.length, 0, 'a variant is filled, not sent by the component');
  });
});

// ---------------------------------------------------------------------------
// The Suggest control: absent when nothing can be suggested, visibly failed
// ---------------------------------------------------------------------------

const flushMicrotasks = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

/**
 * The real hook feeding the real composer, which is where the two readings meet:
 * `enabled` is false while the conversation has no assistant message, so the
 * control is not drawn at all rather than pressed into a silent no-op.
 */
function SuggestVisibilityHarness({ lastAssistantMessageId }: { lastAssistantMessageId: string | null }) {
  const { enabled, firstDraw } = useReplySuggestions({
    sessionId: 'session-a',
    lastAssistantMessageId,
    active: true,
  });
  return React.createElement(ChatComposer, {
    ...composerBaseProps(),
    chipStrip: chipStripProps({
      suggestionsEnabled: enabled,
      suggestionsLoading: firstDraw.loading,
      onRequestSuggestions: firstDraw.redraw,
    }),
  } as unknown as React.ComponentProps<typeof ChatComposer>);
}

describe('the Suggest control', () => {
  it('(a) is not drawn when there is no assistant message to respond to', async () => {
    const view = render(React.createElement(SuggestVisibilityHarness, { lastAssistantMessageId: null }));
    await waitFor(() => assert.equal(apiMocks.status.mock.calls.length, 1));
    await flushMicrotasks();

    assert.equal(
      view.queryByRole('button', { name: enChat.input.suggestions.suggest }) === null,
      true,
      'no assistant message means no Suggest control',
    );
  });

  it('(b) is drawn once an assistant message exists', async () => {
    const view = render(React.createElement(SuggestVisibilityHarness, { lastAssistantMessageId: 'assistant-1' }));

    await waitFor(() => assert.ok(view.queryByRole('button', { name: enChat.input.suggestions.suggest })));
  });

  it('(d) stays hidden when /status says the feature is off', async () => {
    apiMocks.status.mockImplementation(() => Promise.resolve({ enabled: false, expansion: 'off', maxChips: 3, maxChipChars: 120 }));
    const view = render(React.createElement(SuggestVisibilityHarness, { lastAssistantMessageId: 'assistant-1' }));
    await waitFor(() => assert.equal(apiMocks.status.mock.calls.length, 1));
    await flushMicrotasks();

    assert.equal(
      view.queryByRole('button', { name: enChat.input.suggestions.suggest }) === null,
      true,
      '/status disabled keeps the control hidden',
    );
  });

  it('(c) shows a visible failure state and recovers a few seconds later', async () => {
    const { view } = renderComposer({
      chipStrip: chipStripProps({ onRequestSuggestions: () => Promise.resolve(false) }),
    });
    const idle = view.getByRole('button', { name: enChat.input.suggestions.suggest });
    assert.equal(idle.getAttribute('data-reply-suggest-state'), 'idle');

    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(idle);
        await Promise.resolve();
        await Promise.resolve();
      });

      const failed = view.getByRole('button', { name: 'Suggest failed' });
      assert.equal(failed.getAttribute('data-reply-suggest-state'), 'failed');
      assert.ok(failed.className.includes('text-destructive'), 'the failure is visible, not only an attribute');

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      const recovered = view.getByRole('button', { name: enChat.input.suggestions.suggest });
      assert.equal(recovered.getAttribute('data-reply-suggest-state'), 'idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c2) treats a rejected request as a failure, never as an uncaught exception', async () => {
    const { view } = renderComposer({
      chipStrip: chipStripProps({
        onRequestSuggestions: () => Promise.reject(new Error('gateway down')),
      }),
    });
    const button = view.getByRole('button', { name: enChat.input.suggestions.suggest });

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(
      view.getByRole('button', { name: 'Suggest failed' }).getAttribute('data-reply-suggest-state'),
      'failed',
    );
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

type ComposerSetupOptions = {
  /** The settings' expansion switch the /status mock reports. */
  expansion?: 'off' | 'vary';
  /** True while a turn runs: a submit is queued (the durable draft) instead of sent. */
  isLoading?: boolean;
};

const setupComposer = (quotedSelection: string | null = null, options: ComposerSetupOptions = {}) => {
  if (options.expansion === 'vary') {
    apiMocks.status.mockImplementation(() => Promise.resolve({ enabled: true, expansion: 'vary', maxChips: 3, maxChipChars: 120 }));
  }
  const sendMessage = vi.fn();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  // The delivery acknowledgement. `useSendDeliveryState` only settles after the
  // server addresses a frame to the sending session; `deliver()` is that frame.
  const listeners: Array<(event: ServerEvent) => void> = [];
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.push(listener);
    return () => undefined;
  };
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
    isLoading: options.isLoading ?? false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage,
    subscribe,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
    lastAssistantMessageId: 'assistant-1',
    quotedSelection,
  }));
  const deliver = (sessionId = SESSION.id) => {
    listeners.forEach((listener) => listener({ kind: 'chat.delta', sessionId }));
  };
  return { view, sendMessage, frames, deliver };
};

/** The expansion requests sent to the mocked endpoint (the first draw has no `expand`). */
const expansionRequests = () => apiMocks.suggest.mock.calls
  .map(([body]) => body as Record<string, unknown>)
  .filter((body) => body.expand === true);

/** The `sent` ledger rows the composer reported (one per delivered, unedited chip fill). */
const sentEvents = () => apiMocks.event.mock.calls
  .map(([payload]) => payload as Record<string, unknown>)
  .filter((payload) => payload.event === 'sent');

/** A view whose hook result exposes the chip strip — all these cases read only that. */
type ChipHookView = { result: { current: { chipStrip: ComposerChipStrip } } };

/** Waits until the first draw has arrived and the strip shows a model chip. */
const waitForModelChip = (view: ChipHookView) => waitFor(() => {
  assert.equal(view.result.current.chipStrip.suggestionsEnabled, true);
  assert.ok(view.result.current.chipStrip.chips.some((chip) => chip.source === 'model'));
});

/** Presses the chip at `index` in the merged strip through the one accept entry. */
const acceptChipAt = (view: ChipHookView, index: number) => {
  const chip = view.result.current.chipStrip.chips[index];
  if (!chip) {
    throw new Error(`the strip has no chip at index ${index}`);
  }
  view.result.current.chipStrip.onAccept(chip);
};

/** Presses the quoted chip, wherever it currently sits in the strip. */
const acceptQuotedChip = (view: ChipHookView) => {
  const chip = view.result.current.chipStrip.chips.find((candidate) => candidate.source === 'quoted');
  if (!chip) {
    throw new Error('the strip has no quoted chip');
  }
  view.result.current.chipStrip.onAccept(chip);
};

type ComposerKeyEvent = Parameters<ReturnType<typeof useChatComposerState>['handleKeyDown']>[0];

/**
 * A textarea the composer can focus, place its caret in, and (as the page does)
 * submit through — mounted, never inside the render tree.
 *
 * `onRequestSubmit` is what the surrounding form's `requestSubmit()` would run;
 * the composer's Enter branch reaches the send path through it, which is the
 * same entry a click on the send button takes.
 */
const attachTextarea = (
  view: { result: { current: { textareaRef: unknown } } },
  onRequestSubmit?: () => void,
) => {
  const textarea = document.createElement('textarea');
  if (onRequestSubmit) {
    Object.defineProperty(textarea, 'form', { value: { requestSubmit: onRequestSubmit } });
  }
  document.body.appendChild(textarea);
  (view.result.current.textareaRef as { current: HTMLTextAreaElement | null }).current = textarea;
  return textarea;
};

/** The subset of a React keyboard event the composer's handlers read. */
const keyEvent = (key: string, currentTarget: EventTarget | { value: string } = { value: '' }) => {
  const event = {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      // The page-level abort handler is not part of this harness.
    },
    nativeEvent: { isComposing: false },
    currentTarget,
  };
  return event;
};

describe('composer state chip acceptance', () => {
  it('(a) fills, focuses and puts the caret at the end on a model chip click, without sending', async () => {
    const { view, sendMessage, frames } = setupComposer();
    const submitted = vi.fn();
    const textarea = attachTextarea(view, submitted);
    await waitForModelChip(view);

    // The one accept entry: it is what ChatComposer wires for every source and
    // for the keyboard route, and the leg the refutation arm flips back to
    // `submitComposer()`.
    act(() => {
      acceptChipAt(view, 0);
    });
    // The controlled textarea receives the new value on the render that follows
    // the fill; commit it here, before the deferred focus/caret callback runs.
    textarea.value = view.result.current.input;
    act(() => {
      frames.forEach((callback) => callback(0));
    });

    assert.equal(view.result.current.input, '模型一');
    assert.equal(document.activeElement, textarea, 'the caret stays in the composer');
    assert.equal(textarea.selectionStart, '模型一'.length, 'the caret sits after the filled text');
    assert.equal(sendMessage.mock.calls.length, 0, 'accepting a model chip never sends');
    assert.equal(submitted.mock.calls.length, 0, 'and it never submits the composer form');
    assert.equal(expansionRequests().length, 0, 'expansion off sends no second request');

    // Then the chip press itself, from an empty box again: the same fill-only
    // outcome, still nothing sent. (The strip only carries draft chips while the
    // box is empty, so the second press starts from the cleared draft.)
    act(() => {
      view.result.current.setInput('');
    });
    act(() => {
      acceptChipAt(view, 0);
    });
    assert.equal(view.result.current.input, '模型一');
    assert.equal(sendMessage.mock.calls.length, 0, 'the chip press does not send either');
    assert.equal(submitted.mock.calls.length, 0);

    textarea.remove();
  });

  it('(b) accepts a Tab-selected model chip on Enter by filling, not sending', async () => {
    const { view, sendMessage, frames } = setupComposer();
    const textarea = attachTextarea(view);
    await waitForModelChip(view);

    act(() => {
      view.result.current.handleKeyDown(keyEvent('Tab', textarea) as unknown as ComposerKeyEvent);
    });
    assert.equal(view.result.current.chipStrip.selectedIndex, 0, 'Tab walks onto the first chip');

    const enter = keyEvent('Enter', textarea);
    act(() => {
      view.result.current.handleKeyDown(enter as unknown as ComposerKeyEvent);
    });
    textarea.value = view.result.current.input;
    act(() => {
      frames.forEach((callback) => callback(0));
    });

    assert.equal(enter.defaultPrevented, true, 'this Enter belongs to the chip, not the composer');
    assert.equal(view.result.current.input, '模型一');
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.selectionStart, '模型一'.length);
    assert.equal(sendMessage.mock.calls.length, 0, 'Enter accepts the chip; it does not send');

    textarea.remove();
  });

  it('(c) sends the filled draft on the next send and reports exactly one `sent`', async () => {
    const { view, sendMessage, deliver } = setupComposer();
    const submit = () => {
      void view.result.current.handleSubmit({
        preventDefault: () => undefined,
      } as unknown as Parameters<ReturnType<typeof useChatComposerState>['handleSubmit']>[0]);
    };
    const textarea = attachTextarea(view, submit);
    await waitForModelChip(view);

    act(() => {
      acceptChipAt(view, 0);
    });
    assert.equal(sendMessage.mock.calls.length, 0, 'the fill alone sends nothing');

    await act(async () => {
      view.result.current.handleKeyDown(keyEvent('Enter', textarea) as unknown as ComposerKeyEvent);
      await Promise.resolve();
    });
    act(() => {
      deliver();
    });

    await waitFor(() => assert.equal(sendMessage.mock.calls.length, 1, 'the next Enter is the send'));
    assert.equal((sendMessage.mock.calls[0][0] as { content: string }).content, '模型一');
    await waitFor(() => assert.equal(sentEvents().length, 1, 'one delivered, unedited fill is one `sent`'));

    textarea.remove();
  });

  it('(d) reports no `sent` when the filled draft was edited before sending', async () => {
    const { view, sendMessage, deliver } = setupComposer();
    await waitForModelChip(view);
    attachTextarea(view);

    act(() => {
      acceptChipAt(view, 0);
    });
    act(() => {
      view.result.current.handleInputChange({
        target: { value: '模型一，再补一句', selectionStart: 9, style: {} },
      } as unknown as Parameters<ReturnType<typeof useChatComposerState>['handleInputChange']>[0]);
    });

    await act(async () => {
      await view.result.current.handleSubmit({
        preventDefault: () => undefined,
      } as unknown as Parameters<ReturnType<typeof useChatComposerState>['handleSubmit']>[0]);
    });
    act(() => {
      deliver();
    });

    await waitFor(() => assert.equal(sendMessage.mock.calls.length, 1));
    assert.equal((sendMessage.mock.calls[0][0] as { content: string }).content, '模型一，再补一句');
    await waitFor(() => assert.equal(sentEvents().length, 0, 'an edited draft is the person’s text, not the chip’s'));
  });

  it('(e) forgets the previous fill when another chip is picked and judges the send against the new one', async () => {
    const { view, sendMessage, deliver } = setupComposer();
    await waitForModelChip(view);
    attachTextarea(view);

    act(() => {
      acceptChipAt(view, 0);
    });
    assert.equal(view.result.current.input, '模型一');

    // The draft chips are an empty-box affordance; clear so the second chip is
    // on screen again, then pick it. The attribution must follow the newer fill.
    act(() => {
      view.result.current.setInput('');
    });
    act(() => {
      acceptChipAt(view, 1);
    });
    assert.equal(view.result.current.input, '模型二', 'the second pick replaces the draft');

    await act(async () => {
      await view.result.current.handleSubmit({
        preventDefault: () => undefined,
      } as unknown as Parameters<ReturnType<typeof useChatComposerState>['handleSubmit']>[0]);
    });
    act(() => {
      deliver();
    });

    await waitFor(() => assert.equal(sendMessage.mock.calls.length, 1));
    assert.equal((sendMessage.mock.calls[0][0] as { content: string }).content, '模型二');
    await waitFor(() => assert.equal(sentEvents().length, 1, 'the send is attributed to the chip that filled it'));
  });

  it('(f) keeps the expansion branch as it was: fills, asks for variants, never sends', async () => {
    const { view, sendMessage } = setupComposer(null, { expansion: 'vary' });
    await waitForModelChip(view);
    apiMocks.suggest.mockImplementation(() => Promise.resolve({ chips: ['变体一', '变体二'], draw: 11 }));

    act(() => {
      acceptChipAt(view, 0);
    });
    await waitFor(() => assert.deepEqual(view.result.current.chipStrip.expansionChips, ['变体一', '变体二']));

    assert.equal(view.result.current.input, '模型一', 'the picked reply stays in the box as the seed');
    assert.equal(sendMessage.mock.calls.length, 0, 'an expanded pick is not sent');
    const requests = expansionRequests();
    assert.equal(requests.length, 1, 'one pick is one expansion request');
    assert.equal(requests[0].seed, '模型一');
  });

  it('(quoted) inserts the selected passage at the caret and focuses, without sending', () => {
    const { view, sendMessage, frames } = setupComposer('选中的原文');
    const textarea = attachTextarea(view);

    act(() => {
      acceptQuotedChip(view);
    });
    textarea.value = view.result.current.input;
    act(() => {
      frames.forEach((callback) => callback(0));
    });

    assert.equal(
      view.result.current.input,
      '选中的原文\n\n',
      'the passage lands on the empty line, then opens the next paragraph',
    );
    assert.equal(document.activeElement, textarea, 'the composer takes focus');
    assert.equal(textarea.selectionStart, '选中的原文\n\n'.length);
    assert.equal(sendMessage.mock.calls.length, 0, 'quoting is not sending');

    textarea.remove();
  });
});

// ---------------------------------------------------------------------------
// Where a quotation lands: the caret is read from the textarea at click time
// ---------------------------------------------------------------------------

/** The `focus` values the Suggest control sent (an ordinary redraw, never an expansion). */
const redrawFocuses = () => apiMocks.suggest.mock.calls
  .map(([body]) => body as Record<string, unknown>)
  .filter((body) => body.redraw === true && typeof body.focus === 'string')
  .map((body) => body.focus as string);

/** A composer whose quoted selection the test can change, as the page's selection does. */
const setupQuotedComposer = (initialSelection: string | null) => {
  const sendMessage = vi.fn();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
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
      sendMessage,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
      lastAssistantMessageId: 'assistant-1',
      quotedSelection: props.quotedSelection,
    }),
    { initialProps: { quotedSelection: initialSelection } as { quotedSelection: string | null } },
  );
  const textarea = attachTextarea(view);
  return { view, textarea, frames, sendMessage };
};

const acceptQuoted = (
  view: ReturnType<typeof setupQuotedComposer>['view'],
  frames: FrameRequestCallback[],
  textarea: HTMLTextAreaElement,
) => {
  act(() => {
    acceptQuotedChip(view);
  });
  // React commits the new value to the controlled element; the bare node this
  // harness attaches has to be given it by hand before the deferred caret runs.
  textarea.value = view.result.current.input;
  act(() => {
    frames.splice(0).forEach((callback) => callback(0));
  });
};

describe('quoted chip insertion reads the live selection', () => {
  it('(a) follows a selectionEnd the person put in the middle', () => {
    const { view, textarea, frames } = setupQuotedComposer('选中的原文');
    // A render first: the box is watched for focus from the render it mounts in.
    act(() => {
      view.result.current.setInput('前面后面');
    });
    textarea.value = '前面后面';
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    acceptQuoted(view, frames, textarea);

    assert.equal(view.result.current.input, '前面 选中的原文 后面');
    assert.equal(textarea.selectionStart, '前面 选中的原文 '.length, 'the caret is after the passage');
  });

  it('(b) inserts at the end of a box that was never focused', () => {
    const { view, frames, textarea } = setupQuotedComposer('选中的原文');
    act(() => {
      view.result.current.setInput('已有内容');
    });
    textarea.value = '已有内容';

    acceptQuoted(view, frames, textarea);

    // The element reports position 0 until it takes focus, which is not a caret
    // the person chose; the passage goes to the end of the draft instead.
    assert.equal(view.result.current.input, '已有内容 选中的原文');
  });

  it('(c) focuses the box and collapses the caret at the end of the inserted text', () => {
    const { view, textarea, frames } = setupQuotedComposer('选中的原文');
    act(() => {
      view.result.current.setInput('前面后面');
    });
    textarea.value = '前面后面';
    textarea.focus();
    textarea.setSelectionRange(1, 1);

    acceptQuoted(view, frames, textarea);

    assert.equal(document.activeElement, textarea);
    // The caret sits after everything that was inserted, not at the end of the
    // draft: the text that followed the caret is still there.
    assert.equal(textarea.selectionStart, '前 选中的原文 '.length);
    assert.equal(textarea.selectionEnd, '前 选中的原文 '.length);
  });

  it('(d) clears the page selection so the chip cannot be clicked twice', () => {
    const { view, frames, textarea } = setupQuotedComposer('选中的原文');
    const transcript = document.createElement('div');
    transcript.textContent = '选中的原文';
    document.body.appendChild(transcript);
    const range = document.createRange();
    range.selectNodeContents(transcript);
    const selection = window.getSelection();
    assert.ok(selection);
    selection.removeAllRanges();
    selection.addRange(range);
    assert.equal(selection.rangeCount, 1, 'the page selection exists before the click');

    acceptQuoted(view, frames, textarea);

    // Nothing is selected any more: the document may keep a collapsed caret
    // range for the focused textarea, which is not a selection to quote.
    const cleared = window.getSelection();
    assert.equal(
      cleared === null || cleared.rangeCount === 0 || cleared.isCollapsed,
      true,
      'the accepted passage leaves no page selection',
    );
    transcript.remove();
  });
});

// ---------------------------------------------------------------------------
// The chip leaves with the selection: nothing pins it on screen
// ---------------------------------------------------------------------------

const quotedChipShown = (view: ReturnType<typeof setupQuotedComposer>['view']) => (
  view.result.current.chipStrip.chips.some((chip) => chip.source === 'quoted')
);

describe('the quoted chip is shown only while a live selection exists', () => {
  it('(a) accepting it into a non-empty box takes it off screen', () => {
    const { view, frames, textarea } = setupQuotedComposer('选中的原文');
    act(() => {
      view.result.current.setInput('已有内容');
    });
    textarea.value = '已有内容';
    assert.equal(quotedChipShown(view), true, 'the live selection draws the chip over the non-empty box');

    acceptQuoted(view, frames, textarea);
    // Focusing the composer collapses the transcript selection, as the page reports it.
    act(() => {
      view.rerender({ quotedSelection: null });
    });

    assert.equal(view.result.current.input, '已有内容 选中的原文', 'the passage is in the draft');
    assert.equal(quotedChipShown(view), false, 'the accepted chip does not stay for a second passage');
  });

  it('(b) a new live selection draws it again', () => {
    const { view, frames, textarea } = setupQuotedComposer('选中的原文');
    acceptQuoted(view, frames, textarea);
    act(() => {
      view.rerender({ quotedSelection: null });
    });
    assert.equal(quotedChipShown(view), false);

    act(() => {
      view.rerender({ quotedSelection: '另一段原文' });
    });

    const quoted = view.result.current.chipStrip.chips.find((chip) => chip.source === 'quoted');
    assert.equal(quoted?.text, '另一段原文', 'the new selection is the new chip');
  });

  it('(c) a selection that goes away without an accept leaves no chip behind', () => {
    const { view } = setupQuotedComposer('选中的原文');
    act(() => {
      view.result.current.setInput('已经写了一半');
    });
    assert.equal(quotedChipShown(view), true);

    // The box took focus (or the person clicked elsewhere): the selection is gone.
    act(() => {
      view.rerender({ quotedSelection: null });
    });

    assert.equal(quotedChipShown(view), false, 'a non-empty box alone does not keep the chip');
  });

  it('(e) the Suggest button still re-draws with the accepted passage as its focus', async () => {
    const { view, frames, textarea } = setupQuotedComposer('选中的原文');
    await waitFor(() => assert.equal(view.result.current.chipStrip.suggestionsEnabled, true));
    acceptQuoted(view, frames, textarea);
    act(() => {
      view.rerender({ quotedSelection: null });
    });

    await act(async () => {
      await view.result.current.chipStrip.onRequestSuggestions();
    });

    assert.equal(
      redrawFocuses().includes('选中的原文'),
      true,
      'the fixed value now only anchors the Suggest request',
    );
  });
});

// ---------------------------------------------------------------------------
// Undo restores the caret as well as the text
// ---------------------------------------------------------------------------

describe('chip undo restores the caret', () => {
  it('Ctrl+Z after an insertion returns the draft and the caret from before it', () => {
    const { view, textarea, frames } = setupQuotedComposer('选中的原文');
    act(() => {
      view.result.current.setInput('前面后面');
    });
    textarea.value = '前面后面';
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    acceptQuoted(view, frames, textarea);
    assert.equal(view.result.current.input, '前面 选中的原文 后面');

    const event = keyEvent('z', textarea);
    event.ctrlKey = true;
    act(() => {
      view.result.current.handleKeyDown(event as unknown as ComposerKeyEvent);
    });
    act(() => {
      frames.splice(0).forEach((callback) => callback(0));
    });

    assert.equal(event.defaultPrevented, true, 'the chip fill owns this Ctrl+Z');
    assert.equal(view.result.current.input, '前面后面', 'the draft is back');
    assert.equal(textarea.selectionStart, 2, 'the caret is back where it was, not at the end');
  });
});

// ---------------------------------------------------------------------------
// Sending drops trailing spaces and line breaks
// ---------------------------------------------------------------------------

/** The content of the one frame the composer sent. */
const sentContent = (sendMessage: ReturnType<typeof vi.fn>): string => (
  (sendMessage.mock.calls[0]?.[0] as { content: string } | undefined)?.content ?? ''
);

describe('a send never carries trailing spaces or line breaks', () => {
  it('(a) a draft ending in two line breaks sends without them', async () => {
    const { view, sendMessage, deliver } = setupComposer();
    act(() => {
      view.result.current.setInput('T\n\n');
    });

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
    act(() => {
      deliver();
    });

    await waitFor(() => assert.equal(sendMessage.mock.calls.length, 1));
    assert.equal(sentContent(sendMessage), 'T');
  });

  it('(b) trailing spaces are dropped too', async () => {
    const { view, sendMessage, deliver } = setupComposer();
    act(() => {
      view.result.current.setInput('abc  \n');
    });

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
    act(() => {
      deliver();
    });

    await waitFor(() => assert.equal(sendMessage.mock.calls.length, 1));
    assert.equal(sentContent(sendMessage), 'abc');
  });

  it('(c) spaces and line breaks inside the message are kept', async () => {
    const { view, sendMessage, deliver } = setupComposer();
    act(() => {
      view.result.current.setInput('abc  def\nghi \n ');
    });

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
    act(() => {
      deliver();
    });

    await waitFor(() => assert.equal(sendMessage.mock.calls.length, 1));
    assert.equal(sentContent(sendMessage), 'abc  def\nghi');
  });

  it('(d) the queued draft is written and replayed with its trailing whitespace removed', async () => {
    const { view } = setupComposer(null, { isLoading: true });
    act(() => {
      view.result.current.setInput('排队内容  \n\n');
    });

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });

    assert.equal(view.result.current.queuedDraft?.content, '排队内容', 'the durable draft is trimmed');

    // Replaying that queued submission (the flush path) sends the same text.
    const { view: sending, sendMessage, deliver } = setupComposer();
    await act(async () => {
      await sending.result.current.handleSubmit(
        { preventDefault: () => undefined } as never,
        view.result.current.queuedDraft ?? undefined,
      );
    });
    act(() => {
      deliver();
    });

    await waitFor(() => assert.equal(sendMessage.mock.calls.length, 1));
    assert.equal(sentContent(sendMessage), '排队内容');
  });

  it('(e) a message that is only whitespace is not sent', async () => {
    const { view, sendMessage } = setupComposer();
    act(() => {
      view.result.current.setInput('  \n\n');
    });

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });

    assert.equal(sendMessage.mock.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The expansion experiment: a picked chip becomes a seed, its variants replace
// ---------------------------------------------------------------------------

describe('composer state expansion', () => {
  it('(b) fills without sending and sends exactly one seed expansion request when expansion is vary', async () => {
    const { view, sendMessage } = setupComposer(null, { expansion: 'vary' });
    await waitForModelChip(view);
    apiMocks.suggest.mockImplementation(() => Promise.resolve({ chips: ['变体一', '变体二'], draw: 11 }));

    act(() => {
      acceptChipAt(view, 0);
    });
    await waitFor(() => assert.deepEqual(view.result.current.chipStrip.expansionChips, ['变体一', '变体二']));

    assert.equal(view.result.current.input, '模型一', 'the picked reply stays in the box');
    assert.equal(sendMessage.mock.calls.length, 0, 'an expanded pick is not sent');
    const requests = expansionRequests();
    assert.equal(requests.length, 1, 'one pick is one expansion request');
    assert.equal(requests[0].seed, '模型一');
    assert.equal(requests[0].expand, true);
  });

  it('(c) accepting a variant replaces the body instead of appending it', async () => {
    const { view } = setupComposer(null, { expansion: 'vary' });
    await waitForModelChip(view);
    apiMocks.suggest.mockImplementation(() => Promise.resolve({ chips: ['变体一', '变体二'], draw: 11 }));
    act(() => {
      acceptChipAt(view, 0);
    });
    await waitFor(() => assert.deepEqual(view.result.current.chipStrip.expansionChips, ['变体一', '变体二']));

    apiMocks.suggest.mockImplementation(() => Promise.resolve({ chips: ['变体三'], draw: 12 }));
    act(() => {
      view.result.current.chipStrip.onAcceptExpansionChip('变体一', 0);
    });

    assert.equal(view.result.current.input, '变体一', 'replaced, not appended to the seed');
    await waitFor(() => assert.deepEqual(view.result.current.chipStrip.expansionChips, ['变体三']));
    assert.equal(expansionRequests().length, 2, 'the variant became the next seed');
  });

  it('(e) a manual edit drops the variant chips', async () => {
    const { view } = setupComposer(null, { expansion: 'vary' });
    await waitForModelChip(view);
    apiMocks.suggest.mockImplementation(() => Promise.resolve({ chips: ['变体一'], draw: 11 }));
    act(() => {
      acceptChipAt(view, 0);
    });
    await waitFor(() => assert.deepEqual(view.result.current.chipStrip.expansionChips, ['变体一']));

    act(() => {
      view.result.current.handleInputChange({
        target: { value: '模型一，再补一句', selectionStart: 9, style: {} },
      } as unknown as Parameters<typeof view.result.current.handleInputChange>[0]);
    });

    assert.deepEqual(view.result.current.chipStrip.expansionChips, [], 'an edited draft has no variants to replace');
  });

  it('(f) sending the draft drops the variant chips', async () => {
    const { view, deliver } = setupComposer(null, { expansion: 'vary' });
    await waitForModelChip(view);
    apiMocks.suggest.mockImplementation(() => Promise.resolve({ chips: ['变体一'], draw: 11 }));
    act(() => {
      acceptChipAt(view, 0);
    });
    await waitFor(() => assert.deepEqual(view.result.current.chipStrip.expansionChips, ['变体一']));

    await act(async () => {
      await view.result.current.handleSubmit({
        preventDefault: () => undefined,
      } as unknown as Parameters<typeof view.result.current.handleSubmit>[0]);
    });
    act(() => {
      deliver();
    });

    await waitFor(() => assert.equal(view.result.current.input, '', 'the delivered send empties the box'));
    assert.deepEqual(view.result.current.chipStrip.expansionChips, [], 'the sent message has no variants');
  });

  it('(g) a quotation is inserted, never expanded: no expansion request follows it', async () => {
    const { view } = setupComposer('选中的原文', { expansion: 'vary' });
    await waitForModelChip(view);

    act(() => {
      acceptQuotedChip(view);
    });
    await waitFor(() => assert.equal(view.result.current.input.includes('选中的原文'), true));

    const requests = expansionRequests();
    assert.equal(
      requests.length,
      0,
      'expansion is anchored on a picked reply only; a quotation has no seed to vary',
    );
  });

  it('(h) accepting a variant replaces the whole draft (the `> ` prefix path is gone)', async () => {
    const { view } = setupComposer(null, { expansion: 'vary' });
    await waitForModelChip(view);
    apiMocks.suggest.mockImplementation(() => Promise.resolve({ chips: ['变体一', '变体二'], draw: 11 }));
    act(() => {
      acceptChipAt(view, 0);
    });
    await waitFor(() => assert.deepEqual(view.result.current.chipStrip.expansionChips, ['变体一', '变体二']));

    apiMocks.suggest.mockImplementation(() => Promise.resolve({ chips: ['变体一的变体'], draw: 12 }));
    act(() => {
      view.result.current.chipStrip.onAcceptExpansionChip('变体一', 0);
    });

    assert.equal(view.result.current.input, '变体一', 'nothing of the previous draft survives a variant');
  });
});
