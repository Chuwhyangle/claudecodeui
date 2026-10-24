import assert from 'node:assert/strict';

import { fireEvent, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, describe, it, vi } from 'vitest';

import { InputSuggestionChips } from '@/modules/chat/composer/InputSuggestionChips';
import { useInputSuggestions } from '@/modules/chat/hooks/useInputSuggestions';
import enChat from '@/modules/i18n/locales/en/chat.json';
import {
  SUGGESTION_LABEL_MAX_CHARS,
  buildSuggestionChips,
  truncateSuggestionLabel,
} from '@/modules/chat/utils/inputSuggestions';

/**
 * The merged chip strip at the component surface, plus the two visibility rules
 * that can only be read through the hook: a non-empty box keeps ONLY the quoted
 * chip, and a running turn (including the dock's server-confirmed anchor) hides
 * every chip.
 *
 * The order/dedupe rules themselves are pure and live in `inputSuggestions.test.ts`;
 * these cases read the rendered order and the second-line preview from the DOM.
 */

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

afterEach(() => {
  vi.restoreAllMocks();
});

const renderChips = (props: Partial<React.ComponentProps<typeof InputSuggestionChips>> = {}) => render(
  React.createElement(InputSuggestionChips, {
    listId: 'chip-list',
    chips: buildSuggestionChips({
      quotedText: '选中的原文',
      modelChips: ['模型答复一'],
      habitChips: ['习惯一'],
    }),
    selectedIndex: null,
    ...props,
  }),
);

describe('InputSuggestionChips', () => {
  it('draws the three sources in order, each tagged with its own source', () => {
    const view = renderChips();
    const options = view.getAllByRole('option');
    assert.deepEqual(
      options.map((option) => option.getAttribute('data-chip-source')),
      ['quoted', 'model', 'habit'],
    );
    // The quoted chip is labelled through the locale, the others by their own text.
    assert.ok(options[0].textContent?.includes('选中的原文'));
    assert.equal(options[1].textContent, '模型答复一');
    assert.equal(options[2].textContent, '习惯一');
  });

  it('shortens a long label and puts the complete text in the preview and title', () => {
    const longReply = '这是一条很长的模型回复文本，必须被截断显示但完整保留在第二行预览里';
    const view = renderChips({
      chips: buildSuggestionChips({ modelChips: [longReply] }),
    });

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
    const view = renderChips({
      chips: buildSuggestionChips({ modelChips: ['模型答复一'] }),
      showPreview: false,
    });
    assert.equal(view.container.querySelector('[data-suggestion-preview]'), null);
  });

  it('routes a click to the callback that owns each source', () => {
    const onAccept = vi.fn();
    const onAcceptModel = vi.fn();
    const onAcceptQuoted = vi.fn();
    const view = renderChips({
      onAccept,
      onAcceptModel,
      onAcceptQuoted,
      chips: buildSuggestionChips({
        quotedText: '选中的原文',
        modelChips: ['模型一', '模型二'],
        habitChips: ['习惯一'],
      }),
    });
    const options = view.getAllByRole('option');

    fireEvent.click(options[0]); // quoted
    fireEvent.click(options[1]); // model index 0
    fireEvent.click(options[3]); // habit index 0 in the strip
    assert.deepEqual(onAcceptQuoted.mock.calls.length, 1);
    assert.deepEqual(onAcceptModel.mock.calls, [[0]]);
    assert.deepEqual(onAccept.mock.calls, [[3]]);
  });
});

// ---------------------------------------------------------------------------
// Visibility, which only the hook can answer
// ---------------------------------------------------------------------------

const baseArgs = () => ({
  input: '',
  isLoading: false,
  isOccupied: false,
  isCommandMenuOpen: false,
  isFileMenuOpen: false,
  hasQueuedDraft: false,
  hasAttachments: false,
  draftScope: 'session-a',
  modelChips: ['模型一', '模型二'],
  quotedText: '选中的原文' as string | null,
  onAccept: () => undefined,
});

const renderSuggestions = (overrides: Partial<ReturnType<typeof baseArgs>> = {}) => renderHook(
  (props: ReturnType<typeof baseArgs>) => useInputSuggestions(props),
  { initialProps: { ...baseArgs(), ...overrides } },
);

describe('merged visibility', () => {
  it('drops model and habit chips while the box holds text, leaving only the quoted chip', () => {
    const { result } = renderSuggestions({ input: '已经写了一半' });

    assert.equal(result.current.visible, true, 'the quoted chip survives a non-empty box');
    assert.deepEqual(
      result.current.chips.map((chip) => chip.source),
      ['quoted'],
    );
  });

  it('hides every chip while a turn runs, including the dock turn anchor', () => {
    for (const blocker of [{ isLoading: true }, { isDockTurnShown: true }, { isOccupied: true }]) {
      const { result } = renderSuggestions(blocker);
      assert.equal(result.current.visible, false, JSON.stringify(blocker));
      assert.deepEqual(result.current.chips, [], JSON.stringify(blocker));
    }
  });

  it('is empty when all three sources are empty', () => {
    const { result } = renderSuggestions({ modelChips: [], quotedText: null });
    assert.equal(result.current.visible, false);
    assert.deepEqual(result.current.chips, []);
  });
});
