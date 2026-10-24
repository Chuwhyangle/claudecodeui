import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { MAX_QUOTED_SELECTION_CHARS, useTranscriptSelection } from '@/modules/chat/hooks/useTranscriptSelection';

/**
 * The quoted-chip source, one rule per case.
 *
 * jsdom implements `Range` and `Selection`, so the cases build a real transcript
 * region and a real selection over its text nodes, then dispatch the same
 * `selectionchange` event a browser would. Nothing here re-derives what the hook
 * reads: the DOM selection IS the input.
 */

const SETTLE_MS = 50;

const makeRegion = (text: string, marker = true) => {
  const region = document.createElement('div');
  if (marker) {
    region.setAttribute('data-transcript-content', '');
  }
  const paragraph = document.createElement('p');
  const textNode = document.createTextNode(text);
  paragraph.appendChild(textNode);
  region.appendChild(paragraph);
  document.body.appendChild(region);
  return { region, textNode };
};

const selectRange = (node: Node, start: number, end: number) => {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  assert.ok(selection, 'jsdom must expose a Selection');
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
};

const clearSelection = () => {
  window.getSelection()?.removeAllRanges();
  document.dispatchEvent(new Event('selectionchange'));
};

const settle = () => act(() => {
  vi.advanceTimersByTime(SETTLE_MS + 1);
});

const renderSelection = () => renderHook(() => useTranscriptSelection({ settleMs: SETTLE_MS }));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('useTranscriptSelection', () => {
  it('reads a selection whose ends both lie in the transcript region', () => {
    const { textNode } = makeRegion('这是助手回答里的一段话');
    const { result } = renderSelection();

    selectRange(textNode, 0, 8);
    settle();

    assert.equal(result.current.selectionText, '这是助手回答里的一段话'.slice(0, 8));
  });

  it('ignores a selection made in the composer or a sidebar', () => {
    const transcript = makeRegion('助手回答的文字');
    const composer = makeRegion('输入框里的字', false);
    makeRegion('侧栏里的字', false);
    const { result } = renderSelection();

    // A transcript selection first, so "ignored" is a transition, not a no-op on empty state.
    selectRange(transcript.textNode, 0, 6);
    settle();
    assert.ok(result.current.selectionText);

    act(() => selectRange(composer.textNode, 0, 5));
    assert.equal(result.current.selectionText, null, 'a selection outside the transcript clears at once');
  });

  it('ignores a selection that starts inside the transcript and ends outside it', () => {
    const transcript = makeRegion('助手回答的文字');
    const outside = makeRegion('输入框里的字', false);
    const { result } = renderSelection();

    const range = document.createRange();
    range.setStart(transcript.textNode, 0);
    range.setEnd(outside.textNode, 4);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    settle();

    assert.equal(result.current.selectionText, null);
  });

  it('clears the state on an empty or collapsed selection, at once', () => {
    const { textNode } = makeRegion('助手回答的文字');
    const { result } = renderSelection();

    selectRange(textNode, 0, 6);
    settle();
    assert.ok(result.current.selectionText);

    // A collapsed caret: same start and end.
    act(() => selectRange(textNode, 3, 3));
    assert.equal(result.current.selectionText, null, 'a collapsed selection clears without waiting');

    selectRange(textNode, 0, 6);
    settle();
    assert.ok(result.current.selectionText);
    act(() => clearSelection());
    assert.equal(result.current.selectionText, null, 'an emptied selection clears immediately');
  });

  it('drops a selection shorter than four characters', () => {
    const { textNode } = makeRegion('助手回答的文字');
    const { result } = renderSelection();

    selectRange(textNode, 0, 3);
    settle();

    assert.equal(result.current.selectionText, null);
  });

  it('truncates a very long selection to 600 code points', () => {
    const longText = '甲'.repeat(MAX_QUOTED_SELECTION_CHARS + 400);
    const { textNode } = makeRegion(longText);
    const { result } = renderSelection();

    selectRange(textNode, 0, longText.length);
    settle();

    assert.equal(result.current.selectionText?.length, MAX_QUOTED_SELECTION_CHARS);
    assert.equal(result.current.selectionText, longText.slice(0, MAX_QUOTED_SELECTION_CHARS));
  });

  it('coalesces a burst of selectionchange events into one state update', () => {
    const { textNode } = makeRegion('助手回答的文字，足够长可以反复选择');
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTranscriptSelection({ settleMs: SETTLE_MS });
    });

    // Three changes in one frame, all with the same text.
    selectRange(textNode, 0, 10);
    selectRange(textNode, 0, 10);
    selectRange(textNode, 0, 10);
    settle();

    const afterFirstSettle = renders;
    assert.equal(result.current.selectionText, '助手回答的文字，足够长'.slice(0, 10));

    // The same text again: the committed value did not change, so no re-render.
    selectRange(textNode, 0, 10);
    settle();
    assert.equal(renders, afterFirstSettle, 'an unchanged selection must not update state again');
  });
});
