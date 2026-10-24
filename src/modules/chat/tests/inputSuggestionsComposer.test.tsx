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
import {
  SUGGESTION_LABEL_MAX_CHARS,
  buildSuggestionChips,
  truncateSuggestionLabel,
} from '@/modules/chat/utils/inputSuggestions';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

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
    assert.deepEqual(result.current.candidates, ['检查进展', '提交', '继续']);
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
    assert.deepEqual(result.current.candidates, []);
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
    assert.equal(view.result.current.selectedInputSuggestionIndex, 0);
    press(view, 'Tab');
    assert.equal(view.result.current.selectedInputSuggestionIndex, 1);
    press(view, 'Tab');
    assert.equal(view.result.current.selectedInputSuggestionIndex, 2);

    press(view, 'Tab');
    assert.equal(view.result.current.selectedInputSuggestionIndex, null);
    // The key fell through to the composer's existing permission-mode branch, once.
    assert.equal(cyclePermissionMode.mock.calls.length, 1);
  });

  it('walks backwards with Shift+Tab and gives the key back past the first chip', () => {
    seedHistory(SEED_HISTORY);
    const { view, cyclePermissionMode } = setupComposer();

    press(view, 'Tab', { shiftKey: true });
    assert.equal(view.result.current.selectedInputSuggestionIndex, 2);
    press(view, 'Tab', { shiftKey: true });
    assert.equal(view.result.current.selectedInputSuggestionIndex, 1);
    press(view, 'Tab', { shiftKey: true });
    assert.equal(view.result.current.selectedInputSuggestionIndex, 0);

    press(view, 'Tab', { shiftKey: true });
    assert.equal(view.result.current.selectedInputSuggestionIndex, null);
    assert.equal(cyclePermissionMode.mock.calls.length, 1);
  });

  it('leaves Tab exactly as it was while the chips are not shown', () => {
    seedHistory(SEED_HISTORY);
    const { view, cyclePermissionMode } = setupComposer();
    act(() => {
      view.result.current.setInput('draft in progress');
    });
    assert.equal(view.result.current.inputSuggestionsVisible, false);

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
    assert.equal(view.result.current.inputSuggestionsVisible, false);
  });

  it('never accepts a chip with an IME-confirming Enter', () => {
    seedHistory(SEED_HISTORY);
    const { view } = setupComposer();

    press(view, 'Tab');
    press(view, 'Enter', { composing: true });
    assert.equal(view.result.current.input, '');
    assert.equal(view.result.current.selectedInputSuggestionIndex, 0);
  });

  it('leaves ArrowUp to the input history while the chips are visible', () => {
    seedHistory(SEED_HISTORY);
    const { view } = setupComposer();
    assert.equal(view.result.current.inputSuggestionsVisible, true);

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
        suggestions: ['第一', '第二'],
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
    assert.deepEqual(onAccept.mock.calls, [[0]]);

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
      view.result.current.acceptInputSuggestion(0);
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
    assert.deepEqual(view.result.current.inputSuggestionCandidates, ['A', 'B']);

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
    assert.deepEqual(view.result.current.inputSuggestionCandidates, ['B', 'A']);
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
  inputSuggestionCandidates: ['检查进展', '提交'],
  inputSuggestionsVisible: true,
  selectedInputSuggestionIndex: 0,
  inputSuggestionListId: 'suggestion-list',
  onAcceptInputSuggestion: () => undefined,
});

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

    rerender({ selectedInputSuggestionIndex: null });
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
    assert.equal(view.result.current.inputSuggestionsVisible, true);

    act(() => {
      view.result.current.handleKeyDown(composerKeyEvent('Tab').event);
    });
    assert.equal(view.result.current.selectedInputSuggestionIndex, 0);
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

  it('shortens a long label and puts the complete text in the preview and title', () => {
    const longReply = '这是一条很长的模型回复文本，必须被截断显示但完整保留在第二行预览里';
    const view = renderMergedChips({ chips: buildSuggestionChips({ modelChips: [longReply] }) });

    const option = view.getByRole('option');
    assert.equal(option.textContent, truncateSuggestionLabel(longReply));
    assert.ok((option.textContent?.length ?? 0) <= SUGGESTION_LABEL_MAX_CHARS + 1);
    assert.ok(option.textContent?.endsWith('…'));
    assert.equal(option.getAttribute('title'), longReply);

    const preview = view.container.querySelector('[data-suggestion-preview]');
    assert.ok(preview, 'the first model chip is the default preview');
    assert.equal(preview.textContent, longReply);
  });

  it('shows no preview on a coarse pointer', () => {
    const view = renderMergedChips({ showPreview: false });
    assert.equal(view.container.querySelector('[data-suggestion-preview]'), null);
  });

  it('routes a click to the callback that owns each source', () => {
    const onAccept = vi.fn();
    const onAcceptModel = vi.fn();
    const onAcceptQuoted = vi.fn();
    const view = renderMergedChips({
      chips: buildSuggestionChips({
        quotedText: '选中的原文',
        modelChips: ['模型一', '模型二'],
        habitChips: ['习惯一'],
      }),
      onAccept,
      onAcceptModel,
      onAcceptQuoted,
    });
    const options = view.getAllByRole('option');

    fireEvent.click(options[0]); // quoted
    fireEvent.click(options[1]); // model index 0
    fireEvent.click(options[3]); // habit index 0 in the strip
    assert.deepEqual(onAcceptQuoted.mock.calls, [['选中的原文']]);
    assert.deepEqual(onAcceptModel.mock.calls, [[0]]);
    assert.deepEqual(onAccept.mock.calls, [[3]]);
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
