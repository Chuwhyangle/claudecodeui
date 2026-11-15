import type {
  VoiceRealtimeNarration,
  VoiceRealtimeNarratorInterruptReason,
  VoiceRealtimeNarratorQueue,
  VoiceRealtimeNarratorReading,
  VoiceRealtimeNarratorTtsSeam,
  VoiceRealtimeOutboundFrame,
} from "./voice-realtime-contract.js";

// The narrator's paced, droppable playback queue.


// ---- the narrator's playback queue: the droppable layer ------------------------------------------
//
// WHAT THIS IS. Voice output on a Live Voice connection belongs to the NARRATOR — a bypass producer
// (run-end summary now, TTS next) that says short sentences so an eyes-off person keeps the
// confidence that the system heard them. It is NOT the relay model's reply and NOT the person's
// conversation: nothing it says is information they must be able to recall, so every narration is
// DROPPABLE.
//
// WHY THE PERSON SPEAKING CLEARS IT. Duplex conversation advances when they talk. A narration that
// keeps playing after their first word competes with them; one replayed after they have moved on is
// a stale summary of work they already left. So the rule is one line — a new user utterance stops
// the current narration and clears everything queued behind it. Not paused-and-resumed: dropped.
// Interrupting is conversation, not an error, and nothing here reports one.
//
// WHY THE QUEUE IS PACED. One narration is sent at a time and the next waits for the browser's
// `narrator_done`. If every item went out immediately, "clearing the queue" could not stop a
// narration the page already held — which is exactly the behaviour this layer exists to prevent.
//
// PRESENCE IS THE SWITCH, like every other narrator seam here: a connection wired without
// {@link VoiceRealtimeProxySeams.narrator} creates no queue and takes no hook, so every criterion
// written before this feature keeps its exact wire.


/**
 * Builds the queue over this connection's browser downlink.
 *
 * The downlink is injected rather than reached for, for the same reason every other leaf here takes
 * one: the criterion hands it a recorder, and the handler hands it its own `send`.
 */
export function createVoiceRealtimeNarratorQueue(input: {
  send: (frame: VoiceRealtimeOutboundFrame) => void;
  log?: (line: string) => void;
  /**
   * The TTS seam this connection's narrator speaks through, or absent for the text-only wire.
   *
   * ABSENCE IS THE PRE-TTS BEHAVIOUR, and every criterion written before the downlink existed uses
   * it: the queue emits `narrator_speak` and waits for the page's `narrator_done` exactly as before.
   * With a seam, the same `pump()` that emitted the text also synthesizes it and streams the audio
   * to the same page; the pacing ack still comes from the page, after playback.
   */
  tts?: VoiceRealtimeNarratorTtsSeam;
}): VoiceRealtimeNarratorQueue {
  /** The narration the page holds now, or `null`. Only one at a time — see the pacing note. */
  let current: VoiceRealtimeNarration | null = null;
  /** Narrations the page has NOT been sent. This is what an interrupt can still drop. */
  const pending: VoiceRealtimeNarration[] = [];
  let dropped = 0;
  let closed = false;

  /** Sends the next narration when the page is free. The ONLY place `narrator_speak` is emitted. */
  const pump = (): void => {
    if (closed || current !== null || pending.length === 0) return;
    const next = pending.shift() as VoiceRealtimeNarration;
    current = next;
    // The TEXT frame goes first even when audio follows: it is the sentence the page can display,
    // and it is the fallback a page without TTS playback can still honour. The audio frames are
    // ordered BEHIND it on the same socket, so a page that receives either has the correlation id.
    input.send({ type: 'narrator_speak', utteranceId: next.utteranceId, text: next.text });
    input.log?.(`narrator speak ${next.utteranceId} chars=${next.text.length} queued=${pending.length}`);

    const tts = input.tts;
    if (tts === undefined) return;
    // The downlink is guarded rather than trusted: an utterance the person has already cleared
    // (`interrupt` sets `current` to null) must not receive late audio AFTER its `narrator_stop`,
    // and a closed connection has no page to send to. The synth call itself is not cancellable
    // (the leaf's timeout is its bound); dropping the output is what makes the cut immediate.
    void tts
      .speak({ utteranceId: next.utteranceId, text: next.text }, (frame) => {
        if (closed || current === null || current.utteranceId !== next.utteranceId) return;
        input.send(frame);
      })
      .then((result) => {
        if (result.ok) {
          input.log?.(
            `narrator tts done ${next.utteranceId} frames=${result.frames} bytes=${result.bytes} ` +
              `durationMs=${result.durationMs === null ? '-' : Math.round(result.durationMs)}`,
          );
        }
        // A failure already reached the page as a `tts_error` frame (the leaf emits exactly one);
        // the log line is the server-side reading of the same refusal. The queue stays paced: the
        // page answers `narrator_done` on the error frame, so the next narration is still advanced.
        else {
          input.log?.(
            `narrator tts failed ${next.utteranceId} code=${result.code} upstream=${result.upstreamCode ?? '-'}`,
          );
        }
      })
      .catch((error: unknown) => {
        input.log?.(
          `narrator tts threw ${next.utteranceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  return {
    enqueue(narration: VoiceRealtimeNarration): void {
      if (closed) return;
      pending.push(narration);
      pump();
    },
    completed(utteranceId: string): void {
      // Only the utterance STANDING NOW can end normally. A done for one the person already
      // interrupted (a frame the page sent before it processed the stop) must not advance the
      // cleared queue — it is the stale ack the drop exists to make harmless.
      if (closed || current === null || current.utteranceId !== utteranceId) return;
      current = null;
      pump();
    },
    interrupt(reason: VoiceRealtimeNarratorInterruptReason): number {
      if (closed) return 0;
      const droppedNow = (current === null ? 0 : 1) + pending.length;
      if (current !== null) {
        input.send({ type: 'narrator_stop', utteranceId: current.utteranceId, reason });
      }
      current = null;
      pending.length = 0;
      dropped += droppedNow;
      // One INFO line, never an error: this is the duplex rule working, and a journal that calls it
      // a failure would send an operator looking for a fault that does not exist.
      if (droppedNow > 0) {
        input.log?.(`narrator cleared reason=${reason} dropped=${droppedNow}`);
      }
      return droppedNow;
    },
    reading(): VoiceRealtimeNarratorReading {
      return { current: current === null ? null : current.utteranceId, queued: pending.length, dropped };
    },
    close(): void {
      closed = true;
      current = null;
      pending.length = 0;
    },
  };
}
