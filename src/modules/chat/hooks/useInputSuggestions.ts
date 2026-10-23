import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { readAllInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { buildInputSuggestions } from '@/modules/chat/utils/inputSuggestions';

/**
 * State and keyboard semantics for the empty-composer suggestion chips.
 *
 * The chips are the proposal's tier 1: three short inputs the user has repeated,
 * ranked by pure frequency from the browser's own `chat-input-history`. Nothing
 * here reaches the network or a model, and the hook is deliberately unaware of
 * the composer's structure — `useChatComposerState` supplies every visibility
 * input and the callback that writes an accepted label back into the draft.
 *
 * Focus never leaves the textarea: selection is a number the caller mirrors into
 * `aria-activedescendant`, and the chips themselves only report which index the
 * keyboard is on.
 */

const STATS_KEY = 'chat-suggestion-stats';

/** The local adoption readout that decides whether the LLM tier is worth building. */
type SuggestionStats = {
  shown: number;
  accepted: number;
  hidden: number;
  typedAway: number;
};

const EMPTY_STATS: SuggestionStats = { shown: 0, accepted: 0, hidden: 0, typedAway: 0 };

/**
 * Reads the adoption counters, tolerating a missing or corrupt entry. This is a
 * readout, never a source of truth: a browser that refuses storage still gets
 * the chips.
 */
function readSuggestionStats(): SuggestionStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) {
      return { ...EMPTY_STATS };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...EMPTY_STATS };
    }
    const record = parsed as Record<string, unknown>;
    const stats = { ...EMPTY_STATS };
    for (const key of Object.keys(stats) as (keyof SuggestionStats)[]) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        stats[key] = value;
      }
    }
    return stats;
  } catch {
    return { ...EMPTY_STATS };
  }
}

/**
 * Adds one to a counter. A refused write (private mode, quota, a stubbed storage
 * in a test) is swallowed: the readout is optional, and the composer must not
 * fail a keystroke because a counter could not be persisted.
 */
function bumpSuggestionStat(key: keyof SuggestionStats): void {
  try {
    const stats = readSuggestionStats();
    stats[key] += 1;
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // Counting is a readout; rendering and typing do not depend on it.
  }
}

const sameItems = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

type UseInputSuggestionsOptions = {
  /** The composer draft exactly as the textarea shows it. */
  input: string;
  /** True while the assistant's turn is running; chips are an idle-only affordance. */
  isLoading: boolean;
  /**
   * True while the activity dock is drawing a turn, from `useActivityDockTurn`.
   *
   * A second reading of the same question the dock answers: a turn the server
   * confirmed (a voice turn, another client's turn, a reloaded page) can be
   * running while this client's local `isLoading` mark is already clear, and the
   * chips must follow the dock rather than the local mark. Optional so a caller
   * with no dock (a test harness) keeps the legacy reading; false is the
   * default, never a required argument.
   */
  isDockTurnShown?: boolean;
  /** True while a background job holds the conversation (its textarea is disabled). */
  isOccupied: boolean;
  isCommandMenuOpen: boolean;
  isFileMenuOpen: boolean;
  hasQueuedDraft: boolean;
  hasAttachments: boolean;
  /** The chat being composed into; a change starts a new suggestion round. */
  draftScope: string | null;
  /** Writes the accepted label into the draft AND its send-time mirror. */
  onAccept: (text: string) => void;
};

export type UseInputSuggestionsResult = {
  /** Ranked labels; may be non-empty while `visible` is false. */
  candidates: string[];
  selectedIndex: number | null;
  /** Stable id of the listbox, from which each option's id is derived. */
  listId: string;
  /** Every display condition currently holds and at least one candidate exists. */
  visible: boolean;
  accept: (index: number) => void;
  /** Returns true when the event was consumed by the chips. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => boolean;
};

export function useInputSuggestions({
  input,
  isLoading,
  isDockTurnShown = false,
  isOccupied,
  isCommandMenuOpen,
  isFileMenuOpen,
  hasQueuedDraft,
  hasAttachments,
  draftScope,
  onAccept,
}: UseInputSuggestionsOptions): UseInputSuggestionsResult {
  // Derived from the listbox's own id so the textarea's aria-activedescendant
  // and the option's id cannot drift apart.
  const listId = useId();
  // Recomputed whenever the box becomes empty again, so a send and a later clear
  // rank against the history as it stands then, not as it stood at mount.
  const [candidates, setCandidates] = useState<string[]>(() =>
    buildInputSuggestions(readAllInputHistory()),
  );
  // Which chip the keyboard is on; null is "none selected", which is also the
  // state Tab hands back to the composer's permission-mode branch.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  // Set by Escape, cleared only at a turn boundary — not by typing, so hiding
  // then clearing the box keeps the round hidden.
  const [roundHidden, setRoundHidden] = useState(false);

  useEffect(() => {
    if (input !== '') {
      return;
    }
    const next = buildInputSuggestions(readAllInputHistory());
    setCandidates((previous) => (sameItems(previous, next) ? previous : next));
    setSelectedIndex(null);
  }, [input]);

  const visible = input === ''
    && !isLoading
    && !isDockTurnShown
    && !isOccupied
    && !isCommandMenuOpen
    && !isFileMenuOpen
    && !hasQueuedDraft
    && !hasAttachments
    && !roundHidden
    && candidates.length > 0;

  // A selection must not survive the chips leaving the screen — otherwise the
  // next visible round would start with a highlight the user never asked for.
  useEffect(() => {
    if (!visible && selectedIndex !== null) {
      setSelectedIndex(null);
    }
  }, [selectedIndex, visible]);

  // The round boundary that un-hides an Escape: the turn ending (true -> false).
  const wasLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) {
      setRoundHidden(false);
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  // The other boundary: another conversation is a new round.
  useEffect(() => {
    setRoundHidden(false);
  }, [draftScope]);

  // Adoption readout. `shown` is a false->true transition of the chips; `typedAway`
  // is a keystroke arriving while they were on screen. An acceptance also moves the
  // box from empty to non-empty, so it suppresses the typedAway it would otherwise
  // look like.
  const wasVisibleRef = useRef(false);
  const acceptingRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      bumpSuggestionStat('shown');
    }
    if (wasVisibleRef.current && input !== '' && !acceptingRef.current) {
      bumpSuggestionStat('typedAway');
    }
    acceptingRef.current = false;
    wasVisibleRef.current = visible;
  }, [input, visible]);

  const accept = useCallback((index: number) => {
    const text = candidates[index];
    if (text === undefined) {
      return;
    }
    acceptingRef.current = true;
    setSelectedIndex(null);
    bumpSuggestionStat('accepted');
    onAccept(text);
  }, [candidates, onAccept]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean => {
      if (!visible) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        // The page-level Escape handler is the abort key; a hide must not reach it.
        event.stopPropagation();
        setRoundHidden(true);
        bumpSuggestionStat('hidden');
        return true;
      }

      if (event.key === 'Tab') {
        const lastIndex = candidates.length - 1;
        if (event.shiftKey) {
          if (selectedIndex === null) {
            event.preventDefault();
            setSelectedIndex(lastIndex);
            return true;
          }
          if (selectedIndex > 0) {
            event.preventDefault();
            setSelectedIndex(selectedIndex - 1);
            return true;
          }
          // Past the first chip: give the key back to the composer's Tab branch.
          setSelectedIndex(null);
          return false;
        }
        if (selectedIndex === null) {
          event.preventDefault();
          setSelectedIndex(0);
          return true;
        }
        if (selectedIndex < lastIndex) {
          event.preventDefault();
          setSelectedIndex(selectedIndex + 1);
          return true;
        }
        // Past the last chip: hand Tab back to the existing permission-mode branch.
        setSelectedIndex(null);
        return false;
      }

      if (event.key === 'Enter') {
        // An IME's confirming Enter belongs to the composition, never to a chip.
        if (composing || selectedIndex === null) {
          return false;
        }
        event.preventDefault();
        accept(selectedIndex);
        return true;
      }

      return false;
    },
    [accept, candidates.length, selectedIndex, visible],
  );

  return { candidates, selectedIndex, listId, visible, accept, handleKeyDown };
}
