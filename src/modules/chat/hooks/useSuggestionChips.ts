import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MutableRefObject, RefObject } from 'react';

import type { ComposerChipStrip, SuggestionChip } from '@/shared/types';
import { useInputSuggestions } from '@/modules/chat/hooks/useInputSuggestions';
import { useReplySuggestions } from '@/modules/chat/hooks/useReplySuggestions';
import {
  SUGGESTION_CHIP_ACCEPT_SOURCES,
  suggestionConditionsHold,
} from '@/modules/chat/utils/inputSuggestions';
import type { SuggestionDisplayConditions } from '@/modules/chat/utils/inputSuggestions';

/**
 * Owns the composer suggestion chips: the merged strip, the model/expansion
 * draws, and the one acceptance path every source goes through.
 *
 * The accepted chip always FILLS the draft — both stores written, the textarea
 * focused with the caret at the end — and never sends. What differs per source is
 * only data: each source's record in {@link SUGGESTION_CHIP_ACCEPT_SOURCES} says
 * how its fill text is built, whether it stays visible, what it reports, and what
 * expansion request it asks for. `acceptChip` reads that record and has no
 * `chip.source` branch of its own.
 *
 * Also here, because they are chip state: the quoted chip's pin (it survives the
 * focus collapse the fill causes), the last fill for the one Ctrl+Z undo this
 * surface owns, and the model-fill attribution that makes a later `sent` a report
 * about a delivered chip rather than a click.
 *
 * Consumers: `useChatComposerState`, which forwards the produced
 * `ComposerChipStrip` to `ChatComposer` and routes the keyboard/clear/send
 * helpers to the right places.
 */

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

/**
 * Split a quoted draft into the part a response must keep and the part it
 * replaces.
 *
 * A quotation is pasted as one or more `> …` lines. An expansion chip for that
 * quotation replaces what the person wrote AFTER it, never the quotation itself,
 * so the prefix runs through the last `> ` line (and its newline). A draft with
 * no quotation has an empty prefix and the chip replaces all of it.
 */
function splitQuotedPrefix(text: string): { prefix: string; rest: string } {
  const lines = text.split('\n');
  let lastQuotedLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimStart().startsWith('>')) {
      lastQuotedLine = index;
    }
  }
  if (lastQuotedLine < 0) {
    return { prefix: '', rest: text };
  }
  return {
    prefix: `${lines.slice(0, lastQuotedLine + 1).join('\n')}\n`,
    rest: lines.slice(lastQuotedLine + 1).join('\n'),
  };
}

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
   * The passage a quoted chip pasted, held after the browser selection itself is gone.
   *
   * Clicking the chip focuses the textarea, and focusing it collapses the document
   * selection — which the selection hook correctly reports as "no selection". The
   * strip still promises the chip stays while the box holds the quote (that is how
   * several passages are appended), so the accepted text is pinned here until the
   * box is emptied or a NEW transcript selection arrives. It is never a stale
   * source: it is set only from the chip that was just accepted.
   */
  const [pinnedQuote, setPinnedQuote] = useState<string | null>(null);
  // The composition's last chip fill, for the one undo this surface owns: a fill is a
  // programmatic value, so the browser has no native undo entry for it.
  const lastChipFillRef = useRef<{ before: string; after: string } | null>(null);
  // The text a model chip wrote into the draft, held until the send path confirms
  // it went out. That is what makes `sent` a report about a delivered chip rather
  // than about a click.
  const modelChipFillRef = useRef<string | null>(null);

  const trimmedQuotedSelection = quotedSelection?.trim() ? quotedSelection.trim() : null;
  // A fresh selection supersedes the pinned one. Clearing (null) deliberately does not:
  // that is the focus collapse the pin exists to survive.
  useEffect(() => {
    if (trimmedQuotedSelection) {
      setPinnedQuote(null);
    }
  }, [trimmedQuotedSelection]);

  const effectiveQuotedSelection = trimmedQuotedSelection
    ?? (input !== '' ? pinnedQuote : null);

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
    focus: effectiveQuotedSelection,
  });

  /**
   * The one acceptance entry. Every source fills only: clicking a chip is a
   * draft, not a send, and the person confirms by pressing send themselves.
   *
   * All per-source differences come from the source's descriptor record — the
   * fill text, the pin, the `picked` report, the `sent` attribution and the
   * expansion request — so this function contains no source branch.
   */
  const acceptChip = useCallback((chip: SuggestionChip) => {
    const descriptor = SUGGESTION_CHIP_ACCEPT_SOURCES[chip.source];
    if (!descriptor) {
      return;
    }
    const current = inputValueRef.current;
    const next = descriptor.buildFill(chip, current);

    if (descriptor.reportsPicked) {
      reportReplySuggestionEvent('picked', chip.index);
    }
    if (descriptor.keepVisibleAfterFill) {
      setPinnedQuote(chip.text);
    }
    modelChipFillRef.current = descriptor.attributesSent && !replyExpansionEnabled
      ? chip.text
      : null;
    lastChipFillRef.current = { before: current, after: next };
    setInputFromHistory(next);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(next.length, next.length);
    });

    if (replyExpansionEnabled && descriptor.expansionRequest) {
      requestReplyExpansion(descriptor.expansionRequest(chip));
    }
    if (descriptor.submitsAfterFill) {
      submit();
    }
  }, [
    inputValueRef,
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
    quotedText: effectiveQuotedSelection,
    onAccept: acceptChip,
  });

  /**
   * Accepts one variant/response chip from the expansion experiment.
   *
   * The chip REPLACES the body — `> 原文` lines are the only part that survives a
   * quoted draft — and, while the chain has depth left, becomes the seed of the
   * next expansion so the person can keep refining. At the cap the chip is simply
   * accepted and the strip goes away.
   *
   * The text arrives with the click, so accepting never looks a chip up by its
   * array index again; `index` is only the batch position the `picked` event
   * reports.
   */
  const acceptExpansionChip = useCallback((text: string, index: number) => {
    reportReplySuggestionEvent('picked', index, replyExpansionSource ?? undefined);
    const current = inputValueRef.current;
    const { prefix } = splitQuotedPrefix(current);
    const next = prefix === '' ? text : `${prefix}${text}`;
    modelChipFillRef.current = null;
    lastChipFillRef.current = { before: current, after: next };
    setInputFromHistory(next);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(next.length, next.length);
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
    return true;
  }, [inputValueRef, setInputFromHistory]);

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
    setPinnedQuote(null);
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
