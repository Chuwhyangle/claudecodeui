import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MutableRefObject, RefObject } from 'react';

import type { ComposerChipStrip, SuggestionChip } from '@/shared/types';
import { useInputSuggestions } from '@/modules/chat/hooks/useInputSuggestions';
import { useReplySuggestions } from '@/modules/chat/hooks/useReplySuggestions';
import {
  SUGGESTION_CHIP_ACCEPT_SOURCES,
  suggestionConditionsHold,
} from '@/modules/chat/utils/inputSuggestions';
import type {
  SuggestionDisplayConditions,
  SuggestionFillSelection,
} from '@/modules/chat/utils/inputSuggestions';

/**
 * Owns the composer suggestion chips: the merged strip, the model/expansion
 * draws, and the one acceptance path every source goes through.
 *
 * The accepted chip always FILLS the draft — both stores written, the textarea
 * focused with the caret after the inserted text — and never sends. What differs
 * per source is only data: each source's record in
 * {@link SUGGESTION_CHIP_ACCEPT_SOURCES} says how its fill text is built, what
 * it anchors, what it reports, and what expansion seed it asks for. `acceptChip`
 * reads that record and has no `chip.source` branch of its own.
 *
 * A quotation is inserted at the live caret as ordinary text; the chip exists
 * only while a transcript selection exists, so accepting it (or losing the
 * selection) takes it off screen. The accepted passage is also kept here as the
 * `quoteAnchor` the Suggest button re-draws with — it is not what keeps the chip
 * visible.
 *
 * Also here, because they are chip state: the last fill for the one Ctrl+Z undo
 * this surface owns (text *and* caret), and the model-fill attribution that
 * makes a later `sent` a report about a delivered chip rather than a click.
 *
 * Consumers: `useChatComposerState`, which forwards the produced
 * `ComposerChipStrip` to `ChatComposer` and routes the keyboard/clear/send
 * helpers to the right places.
 */

/**
 * Drops the page's own selection. The transcript selection that draws the
 * quoted chip is this selection; an accepted fill is ordinary draft text, so it
 * must not leave one behind.
 */
function clearPageSelection(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.getSelection()?.removeAllRanges();
}

type UseSuggestionChipsOptions = {
  /** The composer draft exactly as the textarea shows it. */
  input: string;
  /** The send-time mirror of the draft, written in the same tick as the state. */
  inputValueRef: MutableRefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** Writes the draft into both stores so the next Enter sends the new text. */
  setInputFromHistory: (value: string) => void;
  /** The composer's submit path; read only by a descriptor that declares `submitsAfterFill`. */
  submit: () => void;
  /** The idle conditions both chip tiers share. */
  conditions: SuggestionDisplayConditions;
  /** The chat being composed into; a change starts a new suggestion round. */
  draftScope: string | null;
  /** The open conversation, or null before one exists. */
  sessionId: string | null;
  /** Stable identity of the last assistant message; the model draw's key. */
  lastAssistantMessageId: string | null;
  /** The passage selected in the transcript, from `useTranscriptSelection`. */
  quotedSelection: string | null;
};

export type UseSuggestionChipsResult = {
  /** Everything `ChatComposer` needs to draw and drive the strip. */
  chipStrip: ComposerChipStrip;
  /**
   * Handles the Ctrl/Cmd+Z that undoes a chip fill. Returns true when consumed;
   * every other key keeps the browser's own undo.
   */
  handleChipUndoKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Forfeits the `sent` attribution when the person edits a chip-filled draft. */
  noteDraftEdit: (newValue: string) => void;
  /** Reports `sent` when the delivered text is exactly a model chip's fill. */
  reportChipSent: (currentInput: string) => void;
  /** Forgets the pin and the last fill (the clear control and Escape clear). */
  forgetChipState: () => void;
  /** Drops the expansion chips and resets the chain (edit, clear, send). */
  clearExpansion: () => void;
  /** Reports the `cleared` ledger event for a dismissed draft. */
  reportCleared: () => void;
  /** The strip's Tab/Enter/Esc semantics; true when the key was consumed. */
  handleSuggestionKeyDown: (
    event: KeyboardEvent<HTMLTextAreaElement>,
    composing: boolean,
  ) => boolean;
};

export function useSuggestionChips({
  input,
  inputValueRef,
  textareaRef,
  setInputFromHistory,
  submit,
  conditions,
  draftScope,
  sessionId,
  lastAssistantMessageId,
  quotedSelection,
}: UseSuggestionChipsOptions): UseSuggestionChipsResult {
  /**
   * The passage a quoted chip inserted, kept as the Suggest button's `focus`.
   *
   * Taking the composer's focus collapses the transcript selection, and the
   * suggestion button should still re-draw around the passage the person just
   * quoted. This is a query anchor only: it never decides whether the chip is
   * visible (that is the live selection alone), and it is superseded by a new
   * selection and forgotten with the draft.
   */
  const [quoteAnchor, setQuoteAnchor] = useState<string | null>(null);
  // The composition's last chip fill, for the one undo this surface owns: a fill is a
  // programmatic value, so the browser has no native undo entry for it. The caret
  // before the fill travels with the text, so undo restores the position too.
  const lastChipFillRef = useRef<{ before: string; beforeCaret: number; after: string } | null>(null);
  // The text a model chip wrote into the draft, held until the send path confirms
  // it went out. That is what makes `sent` a report about a delivered chip rather
  // than about a click.
  const modelChipFillRef = useRef<string | null>(null);

  const trimmedQuotedSelection = quotedSelection?.trim() ? quotedSelection.trim() : null;
  // A fresh selection supersedes the anchor it was quoted from.
  useEffect(() => {
    if (trimmedQuotedSelection) {
      setQuoteAnchor(null);
    }
  }, [trimmedQuotedSelection]);

  // The chip's visibility reads the live selection and nothing else: the chip is
  // gone the moment the selection is (a focus collapse, a click elsewhere).
  const focus = trimmedQuotedSelection ?? quoteAnchor;

  // Model chips: one draw per assistant message, only while the empty box would
  // show them, silent when the feature is off. The reply hook also owns the
  // expansion experiment, which is a chip surface too, so it lives under this
  // hook rather than beside it.
  const {
    enabled: suggestionsEnabled,
    firstDraw: {
      chips: replySuggestionChips,
      loading: suggestionsLoading,
      redraw: requestSuggestions,
    },
    expansion: {
      enabled: replyExpansionEnabled,
      chips: replyExpansionChips,
      source: replyExpansionSource,
      canExpand: replyExpansionCanExpand,
      request: requestReplyExpansion,
      clear: clearReplyExpansion,
    },
    reportEvent: reportReplySuggestionEvent,
  } = useReplySuggestions({
    sessionId,
    lastAssistantMessageId,
    active: suggestionConditionsHold(conditions) && input === '',
    focus,
  });

  // Whether the textarea has ever taken focus. The element reports the start of
  // its text until then, which is not a caret the person put anywhere; after the
  // first focus the browser keeps their position across blurs, which is what a
  // fill must read.
  const textareaWasFocusedRef = useRef(false);
  const watchedTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }
    if (watchedTextareaRef.current !== textarea) {
      watchedTextareaRef.current = textarea;
      textareaWasFocusedRef.current = false;
    }
    const markFocused = () => {
      textareaWasFocusedRef.current = true;
    };
    textarea.addEventListener('focus', markFocused);
    return () => {
      textarea.removeEventListener('focus', markFocused);
    };
  });

  /**
   * The live selection the fill is built from.
   *
   * Read from the textarea at acceptance time, never from a cached position: the
   * element keeps its `selectionStart`/`selectionEnd` while it is blurred, so
   * this is the caret the person left behind. A box that has never taken focus
   * reports the element's default (the start of the text), not a position the
   * person chose, so the fill goes to the end of the draft in that case — and
   * likewise when no element is mounted yet.
   */
  const readFillSelection = useCallback((): SuggestionFillSelection => {
    const textarea = textareaRef.current;
    const input = inputValueRef.current;
    if (textarea === null || !textareaWasFocusedRef.current) {
      return { input, selectionStart: input.length, selectionEnd: input.length };
    }
    const selectionEnd = Math.min(Math.max(textarea.selectionEnd, 0), input.length);
    const selectionStart = Math.min(Math.max(textarea.selectionStart, 0), selectionEnd);
    return { input, selectionStart, selectionEnd };
  }, [inputValueRef, textareaRef]);

  /**
   * The one acceptance entry. Every source fills only: clicking a chip is a
   * draft, not a send, and the person confirms by pressing send themselves.
   *
   * All per-source differences come from the source's descriptor record — the
   * fill text and caret, the focus anchor, the `picked` report, the `sent`
   * attribution and the expansion seed — so this function contains no source
   * branch.
   */
  const acceptChip = useCallback((chip: SuggestionChip) => {
    const descriptor = SUGGESTION_CHIP_ACCEPT_SOURCES[chip.source];
    if (!descriptor) {
      return;
    }
    const selection = readFillSelection();
    const fill = descriptor.buildFill(chip, selection);

    if (descriptor.reportsPicked) {
      reportReplySuggestionEvent('picked', chip.index);
    }
    if (descriptor.anchorsSuggestionFocus) {
      setQuoteAnchor(chip.text);
    }
    modelChipFillRef.current = descriptor.attributesSent && !replyExpansionEnabled
      ? chip.text
      : null;
    lastChipFillRef.current = {
      before: selection.input,
      beforeCaret: selection.selectionEnd,
      after: fill.text,
    };
    // The chip's job is done once the passage is in the draft: dropping the page
    // selection takes it off screen immediately and makes a second click on the
    // same chip impossible (there is no chip left to click).
    clearPageSelection();
    setInputFromHistory(fill.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      // Focus first, then place the caret: while the textarea holds focus its
      // selection IS the document selection, so clearing the page selection
      // afterwards would wipe the caret as well.
      textarea.focus();
      textarea.setSelectionRange(fill.caret, fill.caret);
    });

    if (replyExpansionEnabled && descriptor.expansionSeed) {
      requestReplyExpansion({ seed: descriptor.expansionSeed(chip) });
    }
    if (descriptor.submitsAfterFill) {
      submit();
    }
  }, [
    readFillSelection,
    replyExpansionEnabled,
    reportReplySuggestionEvent,
    requestReplyExpansion,
    setInputFromHistory,
    submit,
    textareaRef,
  ]);

  // Empty-box suggestion chips. Every display condition the proposal names is
  // read by the caller — the same values the composer itself paints from — and the
  // hook owns selection, the Esc round, the adoption counters and the Tab/Enter/Esc
  // semantics. The accept callback is the one entry above, for every source.
  const {
    chips,
    selectedIndex,
    listId,
    visible,
    handleKeyDown: handleSuggestionKeyDown,
  } = useInputSuggestions({
    input,
    ...conditions,
    draftScope,
    modelChips: replySuggestionChips,
    quotedText: trimmedQuotedSelection,
    onAccept: acceptChip,
  });

  /**
   * Accepts one variant chip from the expansion experiment.
   *
   * The chip REPLACES the draft — the expansion is anchored on a picked reply,
   * not on quoted text — and, while the chain has depth left, becomes the seed
   * of the next expansion so the person can keep refining. At the cap the chip
   * is simply accepted and the strip goes away.
   *
   * The text arrives with the click, so accepting never looks a chip up by its
   * array index again; `index` is only the batch position the `picked` event
   * reports.
   */
  const acceptExpansionChip = useCallback((text: string, index: number) => {
    reportReplySuggestionEvent('picked', index, replyExpansionSource ?? undefined);
    const current = inputValueRef.current;
    modelChipFillRef.current = null;
    lastChipFillRef.current = { before: current, beforeCaret: current.length, after: text };
    setInputFromHistory(text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
    });
    if (replyExpansionCanExpand) {
      requestReplyExpansion({ seed: text });
    } else {
      clearReplyExpansion();
    }
  }, [
    clearReplyExpansion,
    inputValueRef,
    replyExpansionCanExpand,
    replyExpansionSource,
    reportReplySuggestionEvent,
    requestReplyExpansion,
    setInputFromHistory,
    textareaRef,
  ]);

  const handleChipUndoKey = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (
      event.key.toLowerCase() !== 'z'
      || (!event.ctrlKey && !event.metaKey)
      || event.shiftKey
    ) {
      return false;
    }
    const fill = lastChipFillRef.current;
    // Intercept exactly while the box still holds that fill; every other edit
    // keeps the browser's own undo.
    if (fill === null || inputValueRef.current !== fill.after) {
      return false;
    }
    event.preventDefault();
    lastChipFillRef.current = null;
    setInputFromHistory(fill.before);
    // The caret comes back with the text: undo must land where the person was
    // editing, not at the end of the restored draft.
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(fill.beforeCaret, fill.beforeCaret);
    });
    return true;
  }, [inputValueRef, setInputFromHistory, textareaRef]);

  const noteDraftEdit = useCallback((newValue: string) => {
    // Only an unedited model-chip fill is that chip's text going out; once the
    // person changes it, whatever they send is their own message.
    if (modelChipFillRef.current !== null && newValue !== modelChipFillRef.current) {
      modelChipFillRef.current = null;
    }
  }, []);

  const reportChipSent = useCallback((currentInput: string) => {
    if (modelChipFillRef.current !== null && currentInput === modelChipFillRef.current) {
      reportReplySuggestionEvent('sent');
    }
    modelChipFillRef.current = null;
  }, [reportReplySuggestionEvent]);

  const forgetChipState = useCallback(() => {
    setQuoteAnchor(null);
    lastChipFillRef.current = null;
  }, []);

  const reportCleared = useCallback(() => {
    reportReplySuggestionEvent('cleared');
  }, [reportReplySuggestionEvent]);

  const chipStrip: ComposerChipStrip = {
    visible,
    selectedIndex,
    listId,
    chips,
    onAccept: acceptChip,
    suggestionsEnabled,
    suggestionsLoading,
    onRequestSuggestions: requestSuggestions,
    expansionChips: replyExpansionChips,
    onAcceptExpansionChip: acceptExpansionChip,
  };

  return {
    chipStrip,
    handleChipUndoKey,
    noteDraftEdit,
    reportChipSent,
    forgetChipState,
    clearExpansion: clearReplyExpansion,
    reportCleared,
    handleSuggestionKeyDown,
  };
}
