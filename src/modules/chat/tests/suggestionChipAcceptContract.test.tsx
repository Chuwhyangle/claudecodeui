import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { SUGGESTION_CHIP_ACCEPT_SOURCES } from '@/modules/chat/utils/inputSuggestions';
import type { SuggestionDisplayConditions } from '@/modules/chat/utils/inputSuggestions';
import { useSuggestionChips } from '@/modules/chat/hooks/useSuggestionChips';
import type { UseSuggestionChipsResult } from '@/modules/chat/hooks/useSuggestionChips';
import type { SuggestionChip } from '@/shared/types';

/**
 * The cross-source acceptance contract.
 *
 * Every source goes through one entry (`chipStrip.onAccept`), so the invariants
 * are stated once and asserted per source: the draft becomes exactly what the
 * source's descriptor says, focus lands in the textarea with the caret at the
 * end, nothing is sent, and Ctrl+Z restores the draft from before the fill.
 *
 * The last two legs are what keep that structure honest: a source registered in
 * the descriptor record — with no change to the accept entry — obeys the same
 * invariants, and the expansion experiment's request is still the descriptor's
 * data (a `seed` for a model reply, a `focus` for a quotation, nothing for a
 * habit). The reply-suggestions hook is doubled here because its ledger and
 * expansion requests are the contract's observables, not its subject.
 */

const reply = vi.hoisted(() => ({
  state: {
    enabled: true,
    chips: ['模型回复'] as string[],
    loading: false,
    expansionEnabled: false,
    expansionChips: [] as string[],
    expansionSource: null as 'seed' | 'focus' | null,
    canExpand: false,
  },
  reportEvent: vi.fn(),
  requestExpansion: vi.fn(),
  clearExpansion: vi.fn(),
  redraw: vi.fn(async () => true),
}));

vi.mock('@/modules/chat/hooks/useReplySuggestions', () => ({
  REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH: 5,
  useReplySuggestions: () => ({
    enabled: reply.state.enabled,
    status: null,
    firstDraw: {
      chips: reply.state.chips,
      draw: 1,
      loading: reply.state.loading,
      redraw: reply.redraw,
    },
    expansion: {
      enabled: reply.state.expansionEnabled,
      chips: reply.state.expansionChips,
      source: reply.state.expansionSource,
      loading: false,
      depth: 0,
      canExpand: reply.state.canExpand,
      request: reply.requestExpansion,
      clear: reply.clearExpansion,
    },
    reportEvent: reply.reportEvent,
  }),
}));

const HISTORY_KEY = 'chat-input-history';

/** The idle conditions every chip shares; a test that needs one false overrides it. */
const idleConditions = (): SuggestionDisplayConditions => ({
  isLoading: false,
  isOccupied: false,
  isCommandMenuOpen: false,
  isFileMenuOpen: false,
  hasQueuedDraft: false,
  hasAttachments: false,
});

type HarnessProps = {
  apiRef: { current: UseSuggestionChipsResult | null };
  submit: () => void;
  quotedSelection: string | null;
  initialInput?: string;
};

/**
 * The real chip hook with a real textarea, so focus and the caret are read from
 * the element the browser would be driving.
 */
function ChipHarness({ apiRef, submit, quotedSelection, initialInput = '' }: HarnessProps) {
  const [input, setInput] = useState(initialInput);
  const inputValueRef = useRef(initialInput);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, []);
  const chipState = useSuggestionChips({
    input,
    inputValueRef,
    textareaRef,
    setInputFromHistory,
    submit,
    conditions: idleConditions(),
    draftScope: 'session-a',
    sessionId: 'session-a',
    lastAssistantMessageId: 'assistant-1',
    quotedSelection,
  });
  // Publishing the hook's result for the test to drive; an effect (not the render
  // body) so reading the ref stays outside render.
  useEffect(() => {
    apiRef.current = chipState;
  });
  return (
    <textarea
      ref={textareaRef}
      aria-label="composer"
      value={input}
      onChange={(event) => setInputFromHistory(event.target.value)}
    />
  );
}

const renderHarness = (options: {
  quotedSelection?: string | null;
  initialInput?: string;
  submit?: SubmitSpy;
} = {}) => {
  const apiRef: { current: UseSuggestionChipsResult | null } = { current: null };
  const submit = options.submit ?? vi.fn();
  const view = render(
    <ChipHarness
      apiRef={apiRef}
      submit={submit}
      quotedSelection={options.quotedSelection ?? null}
      initialInput={options.initialInput ?? ''}
    />,
  );
  const textarea = view.getByRole('textbox', { name: 'composer' }) as HTMLTextAreaElement;
  const state = () => {
    const current = apiRef.current;
    if (!current) {
      throw new Error('the chip harness has not rendered');
    }
    return current;
  };
  const chipFor = (source: string): SuggestionChip => {
    const chip = state().chipStrip.chips.find((candidate) => candidate.source === source);
    if (!chip) {
      throw new Error(`the strip has no ${source} chip`);
    }
    return chip;
  };
  return { view, textarea, state, chipFor, submit };
};

/**
 * The deferred focus/caret frame, as the composer's real path runs it. React has
 * already committed the new value by the time this is called, which is exactly
 * why the production fill defers the caret to the next frame.
 */
const frames: FrameRequestCallback[] = [];
const flushFrames = () => {
  act(() => {
    frames.splice(0).forEach((callback) => callback(0));
  });
};

const ctrlZ = () => {
  const event = {
    key: 'z',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
};

type SubmitSpy = ReturnType<typeof vi.fn>;

/** The assertions every source must satisfy, in the order the contract states them. */
const assertAccepted = (options: {
  textarea: HTMLTextAreaElement;
  expectedDraft: string;
  submit: SubmitSpy;
  before: string;
  state: () => UseSuggestionChipsResult;
}) => {
  const { textarea, expectedDraft, submit, before, state } = options;
  assert.equal(textarea.value, expectedDraft, 'the draft is exactly the source’s fill text');
  assert.equal(document.activeElement, textarea, 'the caret stays in the composer');
  assert.equal(textarea.selectionStart, expectedDraft.length, 'the caret sits after the fill');
  assert.equal(submit.mock.calls.length, 0, 'accepting a chip never sends');

  const undo = ctrlZ();
  act(() => {
    assert.equal(state().handleChipUndoKey(undo as unknown as KeyboardEvent<HTMLTextAreaElement>), true);
  });
  assert.equal(undo.prevented, true);
  assert.equal(textarea.value, before, 'Ctrl+Z restores the draft from before the fill');
};

beforeEach(() => {
  localStorage.clear();
  reply.state.enabled = true;
  reply.state.chips = ['模型回复'];
  reply.state.loading = false;
  reply.state.expansionEnabled = false;
  reply.state.expansionChips = [];
  reply.state.expansionSource = null;
  reply.state.canExpand = false;
  reply.reportEvent.mockReset();
  reply.requestExpansion.mockReset();
  reply.clearExpansion.mockReset();
  // One habit, used twice: a repeated input is what makes it a habit chip.
  localStorage.setItem(HISTORY_KEY, JSON.stringify({ 'session-a': ['习惯输入', '习惯输入'] }));
  frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete SUGGESTION_CHIP_ACCEPT_SOURCES.synthetic;
});

describe('every source fills, focuses and never sends', () => {
  it('(a) habit chip: writes its text, keeps focus, caret at the end, Ctrl+Z restores', () => {
    const { textarea, state, chipFor, submit } = renderHarness();
    act(() => {
      state().chipStrip.onAccept(chipFor('habit'));
    });
    flushFrames();

    assertAccepted({ textarea, expectedDraft: '习惯输入', submit, before: '', state });
  });

  it('(b) model chip: writes its text, reports picked once, never sends', () => {
    const { textarea, state, chipFor, submit } = renderHarness();
    act(() => {
      state().chipStrip.onAccept(chipFor('model'));
    });
    flushFrames();

    assertAccepted({ textarea, expectedDraft: '模型回复', submit, before: '', state });
    assert.deepEqual(
      reply.reportEvent.mock.calls,
      [['picked', 0]],
      'a model pick reports the ledger event exactly once',
    );
  });

  it('(c) quoted chip with an empty box: writes `> text` plus its newline', () => {
    const { textarea, state, chipFor, submit } = renderHarness({ quotedSelection: '选中的原文' });
    act(() => {
      state().chipStrip.onAccept(chipFor('quoted'));
    });
    flushFrames();

    assertAccepted({ textarea, expectedDraft: '> 选中的原文\n', submit, before: '', state });
  });

  it('(d) quoted chip with a non-empty box: appends after a blank line and Ctrl+Z restores the original', () => {
    const { textarea, state, chipFor, submit } = renderHarness({
      quotedSelection: '选中的原文',
      initialInput: '已有内容',
    });
    act(() => {
      state().chipStrip.onAccept(chipFor('quoted'));
    });
    flushFrames();

    assertAccepted({
      textarea,
      expectedDraft: '已有内容\n\n> 选中的原文\n',
      submit,
      before: '已有内容',
      state,
    });
  });

  it('(e) a source registered only in the descriptor record obeys the same invariants', () => {
    SUGGESTION_CHIP_ACCEPT_SOURCES.synthetic = {
      buildFill: (chip) => chip.text,
      keepVisibleAfterFill: false,
      reportsPicked: false,
      attributesSent: false,
      expansionRequest: null,
      submitsAfterFill: false,
    };
    const { textarea, state, submit } = renderHarness();
    const synthetic: SuggestionChip = {
      id: 'synthetic-0',
      text: '合成来源文本',
      source: 'synthetic',
      index: 0,
    };

    act(() => {
      // The accept entry is untouched: it reads the registered descriptor.
      state().chipStrip.onAccept(synthetic);
    });
    flushFrames();

    assertAccepted({ textarea, expectedDraft: '合成来源文本', submit, before: '', state });
  });
});

describe('the expansion request is part of the source’s data', () => {
  it('(f) model asks for a `seed`, quoted asks for a `focus`, habit asks for nothing', () => {
    reply.state.expansionEnabled = true;

    const model = renderHarness();
    act(() => {
      model.state().chipStrip.onAccept(model.chipFor('model'));
    });
    flushFrames();
    assert.deepEqual(reply.requestExpansion.mock.calls, [[{ seed: '模型回复' }]]);
    model.view.unmount();

    reply.requestExpansion.mockClear();
    const quoted = renderHarness({ quotedSelection: '选中的原文' });
    act(() => {
      quoted.state().chipStrip.onAccept(quoted.chipFor('quoted'));
    });
    flushFrames();
    assert.deepEqual(reply.requestExpansion.mock.calls, [[{ focus: '选中的原文', seed: '' }]]);
    quoted.view.unmount();

    reply.requestExpansion.mockClear();
    const habit = renderHarness();
    act(() => {
      habit.state().chipStrip.onAccept(habit.chipFor('habit'));
    });
    flushFrames();
    assert.deepEqual(reply.requestExpansion.mock.calls, [], 'a habit chip has no expansion anchor');
  });
});

describe('the ledger report follows the source', () => {
  it('(g) model reports `picked` once; habit reports nothing', () => {
    const model = renderHarness();
    act(() => {
      model.state().chipStrip.onAccept(model.chipFor('model'));
    });
    flushFrames();
    assert.deepEqual(reply.reportEvent.mock.calls, [['picked', 0]]);
    model.view.unmount();

    reply.reportEvent.mockClear();
    const habit = renderHarness();
    act(() => {
      habit.state().chipStrip.onAccept(habit.chipFor('habit'));
    });
    flushFrames();
    assert.deepEqual(reply.reportEvent.mock.calls, []);
  });
});

describe('the strip still offers all three sources', () => {
  it('merges quoted > model > habit when the box is empty', () => {
    const { state } = renderHarness({ quotedSelection: '选中的原文' });
    assert.deepEqual(
      state().chipStrip.chips.map((chip) => chip.source),
      ['quoted', 'model', 'habit'],
    );
  });
});
