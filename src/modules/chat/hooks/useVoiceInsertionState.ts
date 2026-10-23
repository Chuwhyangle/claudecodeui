import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { applyVoiceChange, beginVoiceInsertion } from '@/modules/chat/utils/voice/voiceInsertion';
import type { VoiceInsertion } from '@/modules/chat/utils/voice/voiceInsertion';

/**
 * Where a continuous dictation's text lands in the draft, and the range the
 * composer paints behind it.
 *
 * A listen opens a tracked insertion range at the caret the microphone was
 * pressed with; every committed segment is written into that range rather than
 * appended to the end of the box, so edits the user makes elsewhere while
 * talking shift the range instead of being overwritten. The range travels with
 * the text through ordinary typing (`remapVoiceRangeOnEdit`), which is why this
 * is one hook rather than a value the composition reads and writes out of step.
 */

type UseVoiceInsertionStateArgs = {
  setInput: Dispatch<SetStateAction<string>>;
  /** The send-time mirror of the draft, written in the same tick as the state. */
  inputValueRef: MutableRefObject<string>;
  /** Submits the composer once committed dictation has landed in the box. */
  submit: () => void;
};

export function useVoiceInsertionState({ setInput, inputValueRef, submit }: UseVoiceInsertionStateArgs) {
  /**
   * The tracked insertion range a continuous listen commits its text into, or null between listens.
   *
   * A ref rather than state: the range has to advance in step with `inputValueRef` on every edit and
   * every committed segment, and a value read asynchronously (the hook hands over text while the user
   * may be typing) cannot be a snapshot from an earlier render.
   */
  const voiceInsertionRef = useRef<VoiceInsertion | null>(null);
  /**
   * The interval `voiceInsertionRef` currently holds, as a value the composer can paint from.
   *
   * The ref above stays the source of truth — it is read and written from callbacks that outlive a
   * render — but a ref write does not redraw anything. This mirror exists for the one consumer that
   * has to SEE the range: the composer paints the provisional background behind the committed voice
   * text, and an overlay that only learned about the range on the next unrelated render would show
   * the highlight late and drop it late. Every write to the ref below writes this too, so the two
   * cannot describe different intervals.
   */
  const [voiceRange, setVoiceRange] = useState<Pick<VoiceInsertion, 'start' | 'end'> | null>(null);

  /**
   * Opens the tracked insertion range where a listen starts.
   *
   * The composer calls this with the caret that was in the box when the microphone was pressed.
   * Everything the listen commits goes into this range, so edits the user makes elsewhere while
   * talking shift it rather than being overwritten.
   */
  const handleVoiceListeningStart = useCallback((cursor: number) => {
    const opening = beginVoiceInsertion(inputValueRef.current, cursor);
    voiceInsertionRef.current = opening;
    // An empty interval at the caret: the overlay has nothing to paint yet, and the range's opening
    // point is where the next committed segment will appear.
    setVoiceRange({ start: opening.start, end: opening.end });
  }, [inputValueRef]);

  /**
   * Places the committed voice text.
   *
   * The continuous path hands over the whole committed dictation so far on every commit, and it is
   * written into the tracked range as a replacement rather than appended to the end of the box: the
   * range is where the listen began, which is not necessarily the end of the draft. Without an open
   * range — a caller that never signalled a listen start, or the single-shot shape before this
   * feature — the text is appended the way it always was.
   *
   * `send` submits once, after the text is in place. Mirror the value into inputValueRef
   * synchronously so the send path reads the new text, not the stale state.
   */
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const range = voiceInsertionRef.current;
    let next: string;
    if (range) {
      next = range.text.slice(0, range.start) + text + range.text.slice(range.end);
      voiceInsertionRef.current = { text: next, start: range.start, end: range.start + text.length };
      setVoiceRange({ start: range.start, end: range.start + text.length });
    } else {
      const base = inputValueRef.current.trim();
      next = base ? `${base} ${text}` : text;
      // The append shape has no tracked interval, but the appended words are still this listen's
      // text, so the overlay highlights the tail it just wrote rather than nothing.
      setVoiceRange({ start: base ? base.length + 1 : 0, end: next.length });
    }
    setInput(next);
    inputValueRef.current = next;
    if (send) {
      // The listen is over once it is sent; the next one opens a fresh range at the new caret.
      voiceInsertionRef.current = null;
      setVoiceRange(null);
      submit();
    }
  }, [inputValueRef, setInput, submit]);

  /**
   * Carries the insertion range through an edit before the new value lands in state.
   *
   * The range tracks the draft it was opened against, so an edit that does not
   * match it (a programmatic change through some other path) drops the range
   * rather than shifting it to the wrong place. A remapped range moves the
   * highlight with the committed words; a dropped one disappears from the
   * overlay too.
   */
  const remapVoiceRangeOnEdit = useCallback((previousValue: string, nextValue: string) => {
    const range = voiceInsertionRef.current;
    if (!range) {
      return;
    }
    const remapped = range.text === previousValue
      ? applyVoiceChange(range, nextValue)
      : null;
    voiceInsertionRef.current = remapped;
    setVoiceRange(remapped === null ? null : { start: remapped.start, end: remapped.end });
  }, []);

  return { voiceRange, handleVoiceListeningStart, handleVoiceTranscript, remapVoiceRangeOnEdit };
}
