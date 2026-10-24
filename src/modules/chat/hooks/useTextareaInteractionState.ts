import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { readDraftText, subscribeToChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * The textarea itself: the text in the box together with the chat scope it
 * belongs to, the draft mirror that survives a reload, and the interaction
 * details the box brings with it — IME composition, auto-height, the highlight
 * overlay's scroll and the focus mark.
 *
 * The text and its scope are ONE state rather than a value plus a ref because
 * they have to move in lockstep: on a session switch there is one commit where
 * the scope has already changed while the text has not, and anything that
 * persisted the text in that commit would write the previous session's message
 * into the new session's draft.
 */

/**
 * Enter that CONFIRMS an IME candidate must not also submit.
 *
 * `event.isComposing` alone is not enough: Safari fires `compositionend` BEFORE the confirming
 * Enter's `keydown`, so the flag is already `false` by the time the handler runs. Chrome and
 * Firefox fire it after, which is why the naive guard looks correct on those two and the bug
 * reads as Safari-only. A tight window after `compositionend` covers it — that sequence is
 * synchronous (microseconds), while a human pressing Enter a second time takes >= 100ms and
 * never lands inside it.
 */
const SAFARI_IME_RACE_WINDOW_MS = 30;

/** One line's worth of pixels; a box never shrinks below a single line. */
const MIN_TEXTAREA_HEIGHT_PX = 22;

/**
 * Writes the box's natural (content-driven) height onto the element.
 *
 * `height: auto` first, because a textarea's `scrollHeight` includes any height
 * already written to it; then the measured value. Shared with the inline quote
 * chip, which takes the box out of this rule while the chip is in flow and has
 * to hand it back to the same one when the chip leaves.
 */
export function applyNaturalTextareaHeight(target: HTMLTextAreaElement): number {
  target.style.height = 'auto';
  const nextHeight = Math.max(MIN_TEXTAREA_HEIGHT_PX, target.scrollHeight);
  target.style.height = `${nextHeight}px`;
  return nextHeight;
}

type UseTextareaInteractionStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
};

export function useTextareaInteractionState({
  selectedProject,
  selectedSession,
  currentSessionId,
}: UseTextareaInteractionStateArgs) {
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // The composer text together with the chat scope it belongs to (see the
  // module comment for why they are one state). Restored synchronously from the
  // draft mirror so a reload shows what was being typed on the first paint
  // rather than after the drafts request lands.
  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const inputValueRef = useRef(input);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  // Whether the box has grown past two lines: the composer paints the expanded
  // shape (border/rounding) from this rather than measuring again.
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  // The focus mark the composer's footer reads to show or hide key hints.
  const [isInputFocused, setIsInputFocused] = useState(false);

  // Composition is tracked on `window` in the capture phase rather than on the textarea, so a
  // composition that starts in one field and ends after focus moves still closes cleanly.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  useEffect(() => {
    const onStart = () => {
      isComposingRef.current = true;
    };
    const onEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
    };
    // `blur` does not bubble, but a capture-phase listener on `window` still sees it on the way
    // down — otherwise a composition abandoned by clicking away would stay open forever.
    const onBlur = () => {
      isComposingRef.current = false;
    };
    window.addEventListener('compositionstart', onStart, true);
    window.addEventListener('compositionend', onEnd, true);
    window.addEventListener('blur', onBlur, true);
    return () => {
      window.removeEventListener('compositionstart', onStart, true);
      window.removeEventListener('compositionend', onEnd, true);
      window.removeEventListener('blur', onBlur, true);
    };
  }, []);

  /**
   * True while an IME composition owns the Enter key. It reads the live flag and
   * the same short post-composition window the Enter branch uses, because Safari
   * fires `compositionend` before the confirming keydown.
   */
  const isImeComposing = useCallback(
    () =>
      isComposingRef.current
      || performance.now() - lastCompositionEndAtRef.current < SAFARI_IME_RACE_WINDOW_MS,
    [],
  );

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    const nextHeight = applyNaturalTextareaHeight(target);

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputFocusChange = useCallback((focused: boolean) => {
    setIsInputFocused(focused);
  }, []);

  return {
    input,
    setInput,
    inputValueRef,
    sessionKey,
    sessionKeyRef,
    draftScope,
    draftScopeRef,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    setIsTextareaExpanded,
    resizeTextarea,
    syncInputOverlayScroll,
    isImeComposing,
    isInputFocused,
    handleInputFocusChange,
  };
}
