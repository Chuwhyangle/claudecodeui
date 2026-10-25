import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import type { KeyboardEvent, RefObject } from 'react';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { InputSuggestionChips } from '@/modules/chat/composer/InputSuggestionChips';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useInputSuggestions } from '@/modules/chat/hooks/useInputSuggestions';
import { buildSuggestionChips } from '@/modules/chat/utils/inputSuggestions';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { ComposerChipStrip, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * The empty-composer suggestion chips at the composer's own surface: the display
 * conditions the proposal names, the Tab/Enter/Esc contract that keeps focus in
 * the textarea, the mouse path, the per-round lifecycle, and the local adoption
 * counters.
 *
 * The rules live in `useInputSuggestions`, which is driven here both directly
 * (one visibility condition per case) and through the real
 * `useChatComposerState`, which is where the chips sit in the key order: after
 * history recall and before the existing Tab/Enter branches. The last group
 * renders the real composer to read the listbox/option roles and the textarea's
 * `aria-activedescendant`.
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

const HISTORY_KEY = 'chat-input-history';
const STATS_KEY = 'chat-suggestion-stats';

/**
 * Stored in the on-disk order (oldest first). Newest occurrences are the two
 * `检查进展`, so the ranked chips are 检查进展, 提交, 继续.
 */
const SEED_HISTORY = ['继续', '继续', '提交', '提交', '检查进展', '检查进展'];

const seedHistory = (entriesOldestFirst: string[], scope = 'session-a') => {
  localStorage.setItem(HISTORY_KEY, JSON.stringify({ [scope]: entriesOldestFirst }));
};

// ---------------------------------------------------------------------------
// Event doubles
// ---------------------------------------------------------------------------

type SuggestionKeyOptions = { shiftKey?: boolean };

const suggestionKeyEvent = (key: string, options: SuggestionKeyOptions = {}) => {
  const state = { prevented: false, stopped: false };
  const event = {
    key,
    shiftKey: options.shiftKey ?? false,
    preventDefault: () => {
      state.prevented = true;
    },
    stopPropagation: () => {
      state.stopped = true;
    },
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { event, state };
};

type ComposerKeyOptions = {
  value?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  composing?: boolean;
};

/** A keydown as `useChatComposerState.handleKeyDown` reads it, including the form it submits through. */
const composerKeyEvent = (key: string, options: ComposerKeyOptions = {}) => {
  const state = { prevented: false, stopped: false, submits: 0 };
  const event = {
    key,
    altKey: false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
    nativeEvent: { isComposing: options.composing ?? false },
    currentTarget: {
      value: options.value ?? '',
      form: {
        requestSubmit: () => {
          state.submits += 1;
        },
      },
    },
    preventDefault: () => {
      state.prevented = true;
    },
    stopPropagation: () => {
      state.stopped = true;
    },
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { event, state };
};

// ---------------------------------------------------------------------------
// Hook-level setup
// ---------------------------------------------------------------------------

const baseSuggestionArgs = () => ({
  input: '',
  isLoading: false,
  isOccupied: false,
  isCommandMenuOpen: false,
  isFileMenuOpen: false,
  hasQueuedDraft: false,
  hasAttachments: false,
  draftScope: 'session-a',
  onAccept: () => undefined,
});

type SuggestionArgs = ReturnType<typeof baseSuggestionArgs>;

const renderSuggestions = (overrides: Partial<SuggestionArgs> = {}) => renderHook(
  (props: SuggestionArgs) => useInputSuggestions(props),
  { initialProps: { ...baseSuggestionArgs(), ...overrides } },
);

// ---------------------------------------------------------------------------
// Composer-state setup
// ---------------------------------------------------------------------------

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-a' };

const setupComposer = (initialLoading = false) => {
  const cyclePermissionMode = vi.fn();
  const sendMessage = vi.fn();
  const view = renderHook(
    ({ isLoading }: { isLoading: boolean }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { isLoading: initialLoading } },
  );
  return { view, cyclePermissionMode, sendMessage };
};

beforeEach(() => {
  localStorage.clear();
  // The drafts store is a module-level singleton; its in-memory copy outlives
  // localStorage.clear() and would leak one case's draft into the next.
  resetChatDrafts();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Visibility conditions — one leg per case
// ---------------------------------------------------------------------------

describe('display conditions', () => {
  it('shows the ranked chips when the box is empty and the assistant is idle', () => {
    seedHistory(SEED_HISTORY);
    const { result } = renderSuggestions();
    assert.equal(result.current.visible, true);
    assert.deepEqual(result.current.chips.map((chip) => chip.text), ['检查进展', '提交', '继续']);
  });

  it('hides them as soon as the box has any text', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();
    rerender({ ...baseSuggestionArgs(), input: 'x' });
    assert.equal(result.current.visible, false);
  });

  it('hides them while the assistant is loading', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();
    rerender({ ...baseSuggestionArgs(), isLoading: true });
    assert.equal(result.current.visible, false);
  });

  it('hides them while the command menu is open', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();
    rerender({ ...baseSuggestionArgs(), isCommandMenuOpen: true });
    assert.equal(result.current.visible, false);
  });

  it('hides them while the file menu is open', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();
    rerender({ ...baseSuggestionArgs(), isFileMenuOpen: true });
    assert.equal(result.current.visible, false);
  });

  it('hides them while a draft is queued', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();
    rerender({ ...baseSuggestionArgs(), hasQueuedDraft: true });
    assert.equal(result.current.visible, false);
  });

  it('hides them while files are attached', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();
    rerender({ ...baseSuggestionArgs(), hasAttachments: true });
    assert.equal(result.current.visible, false);
  });

  it('hides them while a background job occupies the conversation', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();
    rerender({ ...baseSuggestionArgs(), isOccupied: true });
    assert.equal(result.current.visible, false);
  });

  it('shows nothing when there is no history to rank', () => {
    const { result } = renderSuggestions();
    assert.equal(result.current.visible, false);
    assert.deepEqual(result.current.chips.map((chip) => chip.text), []);
  });

  it('hides them for the rest of the round after Escape', () => {
    seedHistory(SEED_HISTORY);
    const { result } = renderSuggestions();
    const escape = suggestionKeyEvent('Escape');
    let handled = false;
    act(() => {
      handled = result.current.handleKeyDown(escape.event, false);
    });
    assert.equal(handled, true);
    assert.equal(escape.state.prevented, true);
    assert.equal(escape.state.stopped, true);
    assert.equal(result.current.visible, false);
  });
});

// ---------------------------------------------------------------------------
// Keyboard semantics through the real composer state
// ---------------------------------------------------------------------------

describe('keyboard semantics', () => {
  const press = (view: ReturnType<typeof setupComposer>['view'], key: string, options?: ComposerKeyOptions) => {
    const event = composerKeyEvent(key, options);
    act(() => {
      view.result.current.handleKeyDown(event.event);
    });
    return event.state;
  };

  it('tabs through the chips in order and gives Tab back after the last', () => {
    seedHistory(SEED_HISTORY);
    const { view, cyclePermissionMode } = setupComposer();

    press(view, 'Tab');
    assert.equal(view.result.current.chipStrip.selectedIndex, 0);
    press(view, 'Tab');
    assert.equal(view.result.current.chipStrip.selectedIndex, 1);
    press(view, 'Tab');
    assert.equal(view.result.current.chipStrip.selectedIndex, 2);

    press(view, 'Tab');
    assert.equal(view.result.current.chipStrip.selectedIndex, null);
    // The key fell through to the composer's existing permission-mode branch, once.
    assert.equal(cyclePermissionMode.mock.calls.length, 1);
  });

  it('walks backwards with Shift+Tab and gives the key back past the first chip', () => {
    seedHistory(SEED_HISTORY);
    const { view, cyclePermissionMode } = setupComposer();

    press(view, 'Tab', { shiftKey: true });
    assert.equal(view.result.current.chipStrip.selectedIndex, 2);
    press(view, 'Tab', { shiftKey: true });
    assert.equal(view.result.current.chipStrip.selectedIndex, 1);
    press(view, 'Tab', { shiftKey: true });
    assert.equal(view.result.current.chipStrip.selectedIndex, 0);

    press(view, 'Tab', { shiftKey: true });
    assert.equal(view.result.current.chipStrip.selectedIndex, null);
    assert.equal(cyclePermissionMode.mock.calls.length, 1);
  });

  it('leaves Tab exactly as it was while the chips are not shown', () => {
    seedHistory(SEED_HISTORY);
    const { view, cyclePermissionMode } = setupComposer();
    act(() => {
      view.result.current.setInput('draft in progress');
    });
    assert.equal(view.result.current.chipStrip.visible, false);

    press(view, 'Tab', { value: 'draft in progress' });
    assert.equal(cyclePermissionMode.mock.calls.length, 1);
  });

  it('accepts the selected chip with Enter and writes both the input and its send-time mirror', async () => {
    seedHistory(SEED_HISTORY);
    const { view, sendMessage } = setupComposer();

    press(view, 'Tab');
    const accepted = press(view, 'Enter');
    assert.equal(accepted.prevented, true);
    assert.equal(accepted.submits, 0);
    assert.equal(view.result.current.input, '检查进展');

    // The send path reads `inputValueRef`, not render state: a submit right
    // after the acceptance must carry the chip text.
    const submit = composerKeyEvent('Enter');
    await act(async () => {
      await view.result.current.handleSubmit(submit.event as never);
    });
    assert.equal(sendMessage.mock.calls.length, 1);
    assert.equal((sendMessage.mock.calls[0][0] as { content: string }).content, '检查进展');
  });

  it('sends a restored draft without its trailing spaces and line breaks', async () => {
    writeDraftText('session-a', '草稿内容  \n');
    const { view, sendMessage } = setupComposer();

    assert.equal(view.result.current.input, '草稿内容  \n', 'the stored draft is restored as it was typed');

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });

    assert.equal(sendMessage.mock.calls.length, 1);
    assert.equal(
      (sendMessage.mock.calls[0][0] as { content: string }).content,
      '草稿内容',
      'the persisted draft takes the same trailing-whitespace rule as a typed send',
    );
  });

  it('does not accept any chip with Enter while nothing is selected', () => {
    seedHistory(SEED_HISTORY);
    const { view } = setupComposer();

    const enter = press(view, 'Enter');
    assert.equal(view.result.current.input, '');
    // The existing Enter branch still submits — unchanged behaviour.
    assert.equal(enter.submits, 1);
  });

  it('hides on Escape and stops the event from reaching the abort handler', () => {
    seedHistory(SEED_HISTORY);
    const { view } = setupComposer();

    press(view, 'Tab');
    const escape = press(view, 'Escape');
    assert.equal(escape.prevented, true);
    assert.equal(escape.stopped, true);
    assert.equal(view.result.current.chipStrip.visible, false);
  });

  it('never accepts a chip with an IME-confirming Enter', () => {
    seedHistory(SEED_HISTORY);
    const { view } = setupComposer();

    press(view, 'Tab');
    press(view, 'Enter', { composing: true });
    assert.equal(view.result.current.input, '');
    assert.equal(view.result.current.chipStrip.selectedIndex, 0);
  });

  it('leaves ArrowUp to the input history while the chips are visible', () => {
    seedHistory(SEED_HISTORY);
    const { view } = setupComposer();
    assert.equal(view.result.current.chipStrip.visible, true);

    press(view, 'ArrowUp');
    // Recalled from `chat-input-history` by `useInputHistory`, not accepted from a chip.
    assert.equal(view.result.current.input, '检查进展');
  });
});

// ---------------------------------------------------------------------------
// Mouse and lifecycle
// ---------------------------------------------------------------------------

describe('mouse and lifecycle', () => {
  it('cancels chip mousedown so the textarea keeps focus, and accepts on click', () => {
    const onAccept = vi.fn();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    const view = render(
      React.createElement(InputSuggestionChips, {
        listId: 'suggestion-list',
        chips: buildSuggestionChips({ habitChips: ['第一', '第二'] }),
        selectedIndex: null,
        onAccept,
      }),
    );

    const chip = view.getByRole('option', { name: '第一' });
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    chip.dispatchEvent(mouseDown);
    assert.equal(mouseDown.defaultPrevented, true);
    assert.equal(document.activeElement, textarea);

    fireEvent.click(chip);
    assert.deepEqual(
      onAccept.mock.calls.map(([accepted]) => (accepted as { text: string }).text),
      ['第一'],
    );

    view.unmount();
    textarea.remove();
  });

  it('fills the chip text in, puts the caret at the end and keeps the textarea focused', () => {
    seedHistory(SEED_HISTORY);
    const { view } = setupComposer();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    (view.result.current.textareaRef as { current: HTMLTextAreaElement | null }).current = textarea;
    textarea.focus();
    // The composer binds this node to `input`, and the caret frame runs after
    // that render; put the accepted text in first so the range is placeable.
    textarea.value = '检查进展';

    act(() => {
      view.result.current.chipStrip.onAccept(view.result.current.chipStrip.chips[0]);
    });
    act(() => {
      frames.forEach((callback) => callback(0));
    });

    assert.equal(view.result.current.input, '检查进展');
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.selectionStart, '检查进展'.length);

    textarea.remove();
  });

  it('disappears when a character is typed and reappears when the box is cleared', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();
    assert.equal(result.current.visible, true);

    rerender({ ...baseSuggestionArgs(), input: 'a' });
    assert.equal(result.current.visible, false);

    rerender({ ...baseSuggestionArgs(), input: '' });
    assert.equal(result.current.visible, true);
  });

  it('restores an Escape-hidden round when the turn ends', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();

    act(() => {
      result.current.handleKeyDown(suggestionKeyEvent('Escape').event, false);
    });
    assert.equal(result.current.visible, false);

    // The turn never showed chips; only its end is the boundary.
    rerender({ ...baseSuggestionArgs(), isLoading: true });
    assert.equal(result.current.visible, false);
    rerender({ ...baseSuggestionArgs(), isLoading: false });
    assert.equal(result.current.visible, true);
  });

  it('restores an Escape-hidden round when the chat scope changes', () => {
    seedHistory(SEED_HISTORY);
    const { result, rerender } = renderSuggestions();

    act(() => {
      result.current.handleKeyDown(suggestionKeyEvent('Escape').event, false);
    });
    assert.equal(result.current.visible, false);

    rerender({ ...baseSuggestionArgs(), draftScope: 'session-b' });
    assert.equal(result.current.visible, true);
  });

  it('re-ranks from the history as it stands when the box is cleared again', () => {
    // Stored oldest first: A and B tie, A being the newest overall.
    seedHistory(['B', 'A', 'B', 'A']);
    const { view } = setupComposer();
    assert.deepEqual(view.result.current.chipStrip.chips.map((chip) => chip.text), ['A', 'B']);

    // Accept A, then edit and clear.
    act(() => {
      view.result.current.handleKeyDown(composerKeyEvent('Tab').event);
    });
    act(() => {
      view.result.current.handleKeyDown(composerKeyEvent('Enter').event);
    });
    assert.equal(view.result.current.input, 'A');
    act(() => {
      view.result.current.setInput('A, edited');
    });

    // Between the two clears, real recorded sends flip the ranking.
    const history = renderHook(() => useInputHistory({
      setInput: () => undefined,
      textareaRef: { current: null } as RefObject<HTMLTextAreaElement>,
      scope: 'session-a',
    }));
    act(() => {
      history.result.current.recordSentMessage('B');
    });
    history.unmount();

    act(() => {
      view.result.current.setInput('');
    });
    assert.deepEqual(view.result.current.chipStrip.chips.map((chip) => chip.text), ['B', 'A']);
  });
});

// ---------------------------------------------------------------------------
// ARIA and the local adoption readout
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
  chipStrip: chipStripProps(),
});

/**
 * The one chip prop the composer takes. The default mirrors the habit strip the
 * listbox cases read: two chips, the first selected.
 */
function chipStripProps(overrides: Partial<ComposerChipStrip> = {}): ComposerChipStrip {
  return {
    visible: true,
    selectedIndex: 0,
    listId: 'suggestion-list',
    chips: buildSuggestionChips({ habitChips: ['检查进展', '提交'] }),
    onAccept: () => undefined,
    suggestionsEnabled: false,
    suggestionsLoading: false,
    onRequestSuggestions: () => undefined,
    expansionChips: [],
    onAcceptExpansionChip: () => undefined,
    ...overrides,
  };
}

type ComposerOverrides = Record<string, unknown>;

const renderComposer = (overrides: ComposerOverrides = {}) => {
  const props = {
    ...composerBaseProps(),
    ...overrides,
  } as unknown as React.ComponentProps<typeof ChatComposer>;
  const view = render(React.createElement(ChatComposer, props));
  return {
    view,
    rerender: (next: ComposerOverrides) => view.rerender(React.createElement(
      ChatComposer,
      { ...composerBaseProps(), ...next } as unknown as React.ComponentProps<typeof ChatComposer>,
    )),
  };
};

describe('accessibility and adoption readout', () => {
  it('exposes a labelled listbox of options and mirrors the selection onto the textarea', () => {
    const { view, rerender } = renderComposer();

    const listbox = view.getByRole('listbox');
    assert.equal(listbox.getAttribute('aria-label'), 'Frequent inputs');
    const options = within(listbox).getAllByRole('option');
    assert.equal(options.length, 2);

    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea, 'the composer must render a textarea');
    assert.equal(textarea.getAttribute('aria-activedescendant'), options[0].id);

    rerender({ chipStrip: chipStripProps({ selectedIndex: null }) });
    assert.equal(textarea.getAttribute('aria-activedescendant'), null);
  });

  it('counts shown, accepted, hidden and typedAway in real interactions', () => {
    seedHistory(SEED_HISTORY);
    const { view } = setupComposer();

    // shown (mount) ×1
    act(() => {
      view.result.current.setInput('x');
    }); // typedAway ×1
    act(() => {
      view.result.current.setInput('');
    }); // shown ×2

    act(() => {
      view.result.current.handleKeyDown(composerKeyEvent('Tab').event);
    });
    act(() => {
      view.result.current.handleKeyDown(composerKeyEvent('Enter').event);
    }); // accepted ×1, and the fill must NOT count as typedAway
    act(() => {
      view.result.current.setInput('');
    }); // shown ×3

    act(() => {
      view.result.current.handleKeyDown(composerKeyEvent('Escape').event);
    }); // hidden ×1

    const stats = JSON.parse(localStorage.getItem(STATS_KEY) ?? '{}') as Record<string, number>;
    assert.deepEqual(stats, { shown: 3, accepted: 1, hidden: 1, typedAway: 1 });
  });

  it('keeps rendering and typing when the counter write is refused', () => {
    seedHistory(SEED_HISTORY);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage refused');
    });

    const { view } = setupComposer();
    assert.equal(view.result.current.chipStrip.visible, true);

    act(() => {
      view.result.current.handleKeyDown(composerKeyEvent('Tab').event);
    });
    assert.equal(view.result.current.chipStrip.selectedIndex, 0);
  });
});

// ---------------------------------------------------------------------------
// The empty box's height while the strip is on screen
// ---------------------------------------------------------------------------

/**
 * The strip is a flow row below the textarea, so an empty box that keeps the textarea's
 * two-row default puts two blank lines between the box top and the chips (the placeholder
 * is blank in this mode). The box therefore drops to one row exactly while the strip is
 * its content; text and the no-chip empty state keep the default and the auto-height path.
 */
describe('the strip owns the empty box\'s single line', () => {
  const textareaOf = (view: ReturnType<typeof render>) => {
    const textarea = view.container.querySelector('textarea');
    assert.ok(textarea, 'the composer must render a textarea');
    return textarea;
  };

  /**
   * The real composer state under the real composer, so the textarea is wired to the
   * auto-height path (`resizeTextarea`) the interface uses rather than to a stub.
   */
  const Harness = () => {
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
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: () => undefined,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    });

    return React.createElement(ChatComposer, {
      ...composerBaseProps(),
      input: state.input,
      hasInput: Boolean(state.input.trim()),
      onInputChange: state.handleInputChange,
      onTextareaKeyDown: state.handleKeyDown,
      onTextareaClick: state.handleTextareaClick,
      onTextareaInput: state.handleTextareaInput,
      textareaRef: state.textareaRef,
      inputHighlightRef: state.inputHighlightRef,
      onClearInput: state.handleClearInput,
      onSubmit: state.handleSubmit,
      chipStrip: state.chipStrip,
    } as unknown as React.ComponentProps<typeof ChatComposer>);
  };

  it('AC1: the empty textarea is one row with chips, and the default without them', () => {
    const { view, rerender } = renderComposer();
    assert.ok(view.getByRole('listbox'), 'the strip is on screen in this mode');
    assert.equal(textareaOf(view).getAttribute('rows'), '1');

    // No chips: the empty box keeps the browser default (two rows) and its placeholder.
    rerender({ chipStrip: chipStripProps({ visible: false }) });
    const withoutChips = textareaOf(view);
    assert.equal(withoutChips.getAttribute('rows'), null, 'rows must not be forced without chips');
    assert.equal(withoutChips.rows, 2, 'the textarea keeps the browser-default row count');
    assert.equal(withoutChips.getAttribute('placeholder'), 'Ask anything');
  });

  it('AC2: typed text restores the default rows and auto-height; clearing returns to one row', () => {
    seedHistory(SEED_HISTORY);
    const view = render(React.createElement(Harness));
    const textarea = textareaOf(view);
    assert.ok(view.getByRole('listbox'), 'the seeded strip is on screen');
    assert.equal(textarea.getAttribute('rows'), '1');

    act(() => {
      fireEvent.change(textarea, { target: { value: '第一行\n第二行' } });
    });
    assert.equal(textarea.getAttribute('rows'), null, 'a typed draft takes back the default rows');
    // jsdom reports scrollHeight 0, so the untouched auto-height path writes its 22px floor.
    assert.equal(textarea.style.height, '22px', 'the auto-height write still runs for a typed draft');

    act(() => {
      fireEvent.change(textarea, { target: { value: '' } });
    });
    assert.equal(textarea.getAttribute('rows'), '1', 'clearing returns to the single-line box');
    assert.equal(textarea.style.height, 'auto', 'the empty box is handed back to the default height');
    assert.ok(view.getByRole('listbox'), 'the strip is back with the empty box');
  });
});

// ---------------------------------------------------------------------------
// The merged strip: sources, labels, preview and visibility
// ---------------------------------------------------------------------------

/**
 * The three-source strip at the component and hook surfaces.
 *
 * The pure ordering/dedupe rules are in `inputSuggestions.test.ts`; what is read
 * here is the DOM order the component draws and the two visibility rules that only
 * the hook can answer — a non-empty box keeps ONLY the quoted chip, and a running
 * turn (including the dock's server-confirmed anchor) hides every chip.
 */

const mergedChips = () => buildSuggestionChips({
  quotedText: '选中的原文',
  modelChips: ['模型答复一'],
  habitChips: ['习惯一'],
});

const renderMergedChips = (props: Partial<React.ComponentProps<typeof InputSuggestionChips>> = {}) => render(
  React.createElement(InputSuggestionChips, {
    listId: 'chip-list',
    chips: mergedChips(),
    selectedIndex: null,
    onAccept: () => undefined,
    ...props,
  }),
);

describe('merged strip at the component surface', () => {
  it('draws the three sources in order, each tagged with its own source', () => {
    const view = renderMergedChips();
    const options = view.getAllByRole('option');
    assert.deepEqual(
      options.map((option) => option.getAttribute('data-chip-source')),
      ['quoted', 'model', 'habit'],
    );
    assert.ok(options[0].textContent?.includes('选中的原文'));
    assert.equal(options[1].textContent, '模型答复一');
    assert.equal(options[2].textContent, '习惯一');
  });

  it('keeps a long label whole, lets it take two lines, and keeps the complete text in title', () => {
    const longReply = '这是一条很长的模型回复文本，必须被截断显示但完整保留在第二行预览里';
    const view = renderMergedChips({ chips: buildSuggestionChips({ modelChips: [longReply] }) });

    const option = view.getByRole('option');
    // No JS ellipsis any more: the chip carries the text and CSS clamps it to
    // two lines, so a long reply is readable instead of cut at ~18 characters.
    assert.equal(option.textContent, longReply);
    assert.ok(
      option.className.split(/\s+/).includes('line-clamp-2'),
      'a chip may occupy at most two lines',
    );
    assert.equal(option.getAttribute('title'), longReply);
  });

  it('routes every source to the one accept callback, each with its own chip', () => {
    const onAccept = vi.fn();
    const view = renderMergedChips({
      chips: buildSuggestionChips({
        quotedText: '选中的原文',
        modelChips: ['模型一', '模型二'],
        habitChips: ['习惯一'],
      }),
      onAccept,
    });
    const options = view.getAllByRole('option');

    fireEvent.click(options[0]); // quoted
    fireEvent.click(options[1]); // model index 0
    fireEvent.click(options[3]); // habit index 0 in the strip
    assert.deepEqual(
      onAccept.mock.calls.map(([chip]) => {
        const accepted = chip as { source: string; text: string };
        return [accepted.source, accepted.text];
      }),
      [['quoted', '选中的原文'], ['model', '模型一'], ['habit', '习惯一']],
    );
  });
});

describe('the strip wraps and draws no second-line preview', () => {
  const previewOf = (view: ReturnType<typeof render>) => view.container.querySelector('[data-suggestion-preview]');

  it('AC1: with no hover and no selection a model chip produces no [data-suggestion-preview]', () => {
    const view = renderMergedChips();
    assert.ok(view.container.querySelector('[data-chip-source="model"]'), 'a model chip must be on screen');

    assert.equal(previewOf(view), null, 'an unselected strip must not print a chip\'s full text below it');

    // Hovering is the pointer's highlight, not a second line either.
    fireEvent.mouseEnter(view.container.querySelector('[data-chip-source="model"]') as HTMLElement);
    assert.equal(previewOf(view), null, 'hover highlights the chip instead of previewing it');
  });

  it('AC2: six long chips all stay in the DOM inside a flex-wrap listbox with no horizontal scroll', () => {
    const longReplies = Array.from(
      { length: 6 },
      (_, index) => `第${index + 1}条很长的模型回复文本，用来验证自动换行布局不会把后面的 chip 横向裁掉`,
    );
    const view = renderMergedChips({ chips: buildSuggestionChips({ modelChips: longReplies }) });

    const listbox = view.getByRole('listbox');
    const tokens = listbox.className.split(/\s+/).filter(Boolean);
    assert.ok(tokens.includes('flex-wrap'), `the listbox must wrap; class read ${listbox.className}`);
    assert.equal(tokens.includes('overflow-x-auto'), false, 'no horizontal scroll track');
    assert.equal(tokens.includes('whitespace-nowrap'), false, 'chips may wrap their own text');
    assert.equal(
      view.getAllByRole('option').length,
      longReplies.length,
      'every chip is in the DOM, none parked off-screen behind a scroll',
    );
  });
});

type MergedArgs = ReturnType<typeof baseSuggestionArgs> & {
  modelChips?: string[];
  quotedText?: string | null;
};

const renderMergedSuggestions = (overrides: Partial<MergedArgs> = {}) => renderHook(
  (props: MergedArgs) => useInputSuggestions(props),
  {
    initialProps: {
      ...baseSuggestionArgs(),
      modelChips: ['模型一', '模型二'],
      quotedText: '选中的原文',
      ...overrides,
    } as MergedArgs,
  },
);

describe('merged visibility through the hook', () => {
  it('drops model and habit chips while the box holds text, leaving only the quoted chip', () => {
    const { result } = renderMergedSuggestions({ input: '已经写了一半' });
    assert.equal(result.current.visible, true, 'the quoted chip survives a non-empty box');
    assert.deepEqual(result.current.chips.map((chip) => chip.source), ['quoted']);
  });

  it('hides every chip while a turn runs, including the dock turn anchor', () => {
    for (const blocker of [{ isLoading: true }, { isDockTurnShown: true }, { isOccupied: true }]) {
      const { result } = renderMergedSuggestions(blocker);
      assert.equal(result.current.visible, false, JSON.stringify(blocker));
      assert.deepEqual(result.current.chips, [], JSON.stringify(blocker));
    }
  });

  it('is empty when all three sources are empty', () => {
    const { result } = renderMergedSuggestions({ modelChips: [], quotedText: null });
    assert.equal(result.current.visible, false);
    assert.deepEqual(result.current.chips, []);
  });
});
