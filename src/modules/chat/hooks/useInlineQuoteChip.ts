import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { SuggestionChip } from '@/shared/types';
import { applyNaturalTextareaHeight } from '@/modules/chat/hooks/useTextareaInteractionState';
import {
  inlineChipTextareaHeight,
  resolveInlineQuoteChipCaret,
  scrollbarCompensation,
  splitInlineQuoteChipInput,
} from '@/modules/chat/utils/inlineQuoteChipLayout';
import type { InlineQuoteChipPosition } from '@/modules/chat/utils/inlineQuoteChipLayout';

/**
 * The quoted-selection chip while the composer holds text: it is drawn INSIDE the
 * text flow at the draft's caret instead of in the chip row above the box.
 *
 * The composer is blurred whenever a transcript selection exists, which is what
 * makes this possible: there is no caret or selection inside the textarea that
 * has to stay aligned with the mirror layer, so the mirror can be turned into the
 * visible text layer and the textarea's own text hidden for the duration. The
 * chip participates in that flow as an inline-block spacer; the real button (the
 * mirror is `aria-hidden`, so assistive tech would never see anything drawn in
 * it) is a sibling positioned over the spacer's box.
 *
 * While the mode is on:
 * - the textarea's text is transparent, its caret colour kept (`!important`
 *   because the dark-mode stylesheet pins textarea colours);
 * - the textarea's height comes from the mirror's content height, capped by the
 *   box's existing maximum, so the added chip line cannot be cut off;
 * - the mirror gets the textarea's scrollbar width as extra right padding, so
 *   both layers wrap at the same place.
 *
 * When the mode ends (selection gone, chip accepted, draft cleared, dictation
 * started) every one of those is undone and the box returns to its natural
 * content height.
 */

type UseInlineQuoteChipOptions = {
  /** The composer draft exactly as the textarea shows it. */
  input: string;
  /** The quoted chip from the strip, or null when no live selection draws one. */
  chip: SuggestionChip | null;
  /** False while a listen owns the box (`provisionalVoiceRange` is not null). */
  enabled: boolean;
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** The mirror layer's content element (the visible text while the mode is on). */
  mirrorRef: RefObject<HTMLDivElement>;
  /** The composer body; the button's absolute position is measured against it. */
  bodyRef: RefObject<HTMLDivElement>;
};

export type UseInlineQuoteChipResult = {
  /** True while the chip is drawn in the text flow. */
  active: boolean;
  /** The draft before the insertion point. */
  before: string;
  /** The draft after the insertion point. */
  after: string;
  /** The inline-block placeholder the real button is drawn over. */
  spacerRef: RefObject<HTMLSpanElement>;
  /** The real chip button, measured for the spacer's width. */
  chipRef: RefObject<HTMLButtonElement>;
  /** Button coordinates relative to the composer body; null before the first measure. */
  position: InlineQuoteChipPosition | null;
  /** Width the spacer reserves for the chip, in CSS pixels (0 until measured). */
  spacerWidth: number;
  /** Extra right padding the mirror needs to match the textarea's scrollbar. */
  scrollbarWidth: number;
  /** Re-measures the button after the textarea scrolls. */
  reposition: () => void;
};

/** The box's configured height cap, in pixels; null means the environment reports none. */
function readMaxHeightPx(target: HTMLTextAreaElement): number | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const raw = window.getComputedStyle(target).maxHeight;
  if (!raw || raw === 'none') {
    return null;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function useInlineQuoteChip({
  input,
  chip,
  enabled,
  textareaRef,
  mirrorRef,
  bodyRef,
}: UseInlineQuoteChipOptions): UseInlineQuoteChipResult {
  const active = enabled && chip !== null && input !== '';
  const [caret, setCaret] = useState(input.length);
  const [position, setPosition] = useState<InlineQuoteChipPosition | null>(null);
  const [spacerWidth, setSpacerWidth] = useState(0);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const spacerRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const wasActiveRef = useRef(false);

  const segments = useMemo(
    () => splitInlineQuoteChipInput(input, caret),
    [caret, input],
  );

  /** Aligns the button with the spacer and keeps the spacer as wide as the button. */
  const reposition = useCallback(() => {
    const spacer = spacerRef.current;
    const body = bodyRef.current;
    if (spacer !== null && body !== null) {
      const spacerRect = spacer.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const left = spacerRect.left - bodyRect.left;
      const top = spacerRect.top - bodyRect.top;
      setPosition((previous) => (
        previous !== null && Math.abs(previous.left - left) < 0.5 && Math.abs(previous.top - top) < 0.5
          ? previous
          : { left, top }
      ));
    }
    const button = chipRef.current;
    const measured = button !== null && button.offsetWidth > 0 ? button.offsetWidth : 0;
    if (measured > 0) {
      setSpacerWidth((previous) => (Math.abs(previous - measured) < 0.5 ? previous : measured));
    }
  }, [bodyRef]);

  // The mode switch. On the way in it captures the insertion point once per
  // appearance and hides the textarea's own text; on the way out it restores both
  // the text and the natural content height.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      wasActiveRef.current = false;
      return;
    }
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active) {
      if (!wasActive) {
        setCaret(resolveInlineQuoteChipCaret(input, textarea.selectionEnd));
      }
      if (typeof window !== 'undefined') {
        // Caret colour is read before the text colour is replaced: it is the
        // colour the caret had while the text was visible.
        const foreground = window.getComputedStyle(textarea).color;
        textarea.style.setProperty('color', 'transparent', 'important');
        textarea.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
        if (foreground) {
          textarea.style.setProperty('caret-color', foreground, 'important');
        }
      }
      return;
    }

    textarea.style.removeProperty('color');
    textarea.style.removeProperty('-webkit-text-fill-color');
    textarea.style.removeProperty('caret-color');
    if (wasActive) {
      applyNaturalTextareaHeight(textarea);
      setScrollbarWidth(0);
      setSpacerWidth(0);
      setPosition(null);
    }
  }, [active, input, textareaRef]);

  // While the chip is in flow the textarea's height follows the mirror content,
  // not its own scroll height: the extra line exists only in the mirror.
  useLayoutEffect(() => {
    if (!active) {
      return undefined;
    }
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (textarea === null || mirror === null) {
      return undefined;
    }

    const applyHeight = () => {
      // The box's ordinary content height, measured with the plain auto-grow rule
      // (`height: auto`, then `scrollHeight`). The floor matters: a one-line draft
      // normally sits in the textarea's two-row default, taller than the mirror's
      // own content, and following the mirror alone would SHRINK the box by a line
      // the moment a selection appeared. The chip may grow the box by a line; it
      // must never make it jump the other way.
      const previousHeight = textarea.style.height;
      textarea.style.height = 'auto';
      const plainHeight = textarea.scrollHeight;
      textarea.style.height = previousHeight;
      const contentHeight = Math.max(mirror.scrollHeight, plainHeight);
      if (contentHeight > 0) {
        textarea.style.height = `${inlineChipTextareaHeight(contentHeight, readMaxHeightPx(textarea))}px`;
      }
      setScrollbarWidth((previous) => {
        const next = scrollbarCompensation(textarea.offsetWidth, textarea.clientWidth);
        return previous === next ? previous : next;
      });
    };

    applyHeight();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      applyHeight();
      reposition();
    });
    observer.observe(mirror);
    if (spacerRef.current !== null) {
      observer.observe(spacerRef.current);
    }
    if (chipRef.current !== null) {
      observer.observe(chipRef.current);
    }
    return () => observer.disconnect();
  }, [
    active,
    caret,
    chip?.text,
    input,
    mirrorRef,
    reposition,
    scrollbarWidth,
    spacerWidth,
    textareaRef,
  ]);

  // A viewport width change re-wraps the mirror; both the height and the button's
  // position are recomputed from the new layout.
  useLayoutEffect(() => {
    if (!active || typeof window === 'undefined') {
      return undefined;
    }
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [active, reposition]);

  return {
    active,
    before: segments.before,
    after: segments.after,
    spacerRef,
    chipRef,
    position,
    spacerWidth,
    scrollbarWidth,
    reposition,
  };
}
