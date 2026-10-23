import { useCallback, useEffect, useRef } from 'react';

import type { VoiceFailureReport, VoiceInputState } from '@/shared/types';
import { useVoiceInput } from '@/modules/chat';
import type { VoiceCaptureEngine } from '@/modules/chat';

/**
 * The cockpit's push-to-talk: the SAME dictation hook the composer uses, plus one extra trigger.
 *
 * WHY ONE HOOK. `useVoiceInput` is the repository's single ASR path — segmentation, retries,
 * identifier repair and the relay context pack all live inside it. A cockpit-only implementation
 * would be a second path whose transcripts could differ from the chat box's, which is exactly
 * what "口述的文字进入同一个输入框" forbids. Dictation therefore lands through `onTranscript`
 * exactly as it does in the composer, and the cockpit owns only where that text goes.
 *
 * THE SECOND TRIGGER IS A HOLD, NOT A SECOND RECORDER. Holding Space (outside a text field)
 * starts the same session a press on the mic button starts, and releasing it stops and commits
 * the text. The hook never sends: a preview and a confirmation stand between dictation and the
 * project's conversation, so a spoken sentence is always editable before it leaves.
 */

/** The events the page needs from the dictation hook. */
export type CockpitPushToTalk = {
  /** `idle` / `recording` / `transcribing`, straight from `useVoiceInput`. */
  state: VoiceInputState;
  /** True while a request for the still-recording listen is outstanding (the mic's dot). */
  inFlight: boolean;
  /** Starts a listen if idle, stops it if recording — the mic button's own action. */
  toggle: () => void;
};

export type CockpitPushToTalkOptions = {
  /** The committed dictation text. It goes into the input box; it is never sent from here. */
  onTranscript: (text: string) => void;
  /** The recogniser's failures, surfaced where the cockpit shows its other honest states. */
  onError?: (failure: VoiceFailureReport) => void;
  /**
   * Names for the deterministic transcript repair — the current view's labels and project names,
   * so a spoken project name is repaired against what the person can actually see.
   */
  candidates?: readonly string[];
  /**
   * Where the audio comes from. Absent is the shipping microphone engine; a test hands in a fake
   * so it can push PCM without an audio thread or a microphone.
   */
  captureEngine?: VoiceCaptureEngine;
  /** False suspends the Space trigger (a confirmation is open, or the stage is not ready). */
  enabled?: boolean;
};

/** True when the focused element owns keyboard input; Space belongs to it, not to the recorder. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Reads the engine's outcome as the state the button paints. */
export function useCockpitPushToTalk({
  onTranscript,
  onError,
  candidates,
  captureEngine,
  enabled = true,
}: CockpitPushToTalkOptions): CockpitPushToTalk {
  const { state, inFlight, toggle, stop } = useVoiceInput(
    (text) => {
      // The send flag is deliberately ignored: this surface always commits into the box and lets
      // the person submit, so a dictation can never become an unconfirmed message.
      onTranscript(text);
    },
    onError,
    {
      scope: 'cockpit',
      ...(candidates === undefined ? {} : { candidates }),
      ...(captureEngine === undefined ? {} : { captureEngine }),
    },
  );

  // Whether THIS hook opened the current listen with Space. Only a hold it started is stopped on
  // keyup: a listen started from the mic button keeps running until that button is pressed.
  const holdingRef = useRef(false);
  // The live `enabled` reading, so the window listeners are registered once rather than rebuilt on
  // every render (a rebuild mid-hold would race the keyup that closes it).
  const enabledRef = useRef(enabled);
  // `toggle` changes identity with the hook's own state; the listeners read it through a ref for
  // the same reason.
  const toggleRef = useRef(toggle);
  const stopRef = useRef(stop);

  useEffect(() => {
    enabledRef.current = enabled;
    toggleRef.current = toggle;
    stopRef.current = stop;
  }, [enabled, stop, toggle]);

  const startHold = useCallback(() => {
    holdingRef.current = true;
    toggleRef.current();
  }, []);

  const endHold = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    stopRef.current();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      // A focused text field keeps Space: it types a space and must not open the microphone.
      if (isEditableTarget(event.target)) return;
      if (!enabledRef.current) return;
      // Space is the cockpit's push-to-talk, so the page must not scroll while it is held.
      event.preventDefault();
      startHold();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      // Released whether or not the keyup lands on an editable target: the hold that started the
      // listen is the thing being ended, and focus may have moved while the microphone was open.
      endHold();
    };
    // A window that loses focus never delivers the keyup; leaving the microphone open would keep
    // the browser's recording indicator lit with nobody holding anything.
    const handleBlur = () => endHold();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [endHold, startHold]);

  return { state, inFlight, toggle };
}
