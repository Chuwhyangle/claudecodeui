/**
 * The spoken-order algebra for Live Voice captions: which segment a caption belongs to, the order
 * they were SPOKEN in (not the order they arrived in), and which pending captions one delivery
 * accounts for.
 *
 * Kept beside `useVoiceRealtimeSession` and used by it alone, so the hook's state machine reads one
 * named module when it asks where a sentence was said rather than carrying the ordering rules among
 * its effects. The `seq` reading these share is the client's own spoken key; see
 * {@link sortCaptionsInSpokenOrder} and {@link unclaimedSegment} for why arrival order is not it.
 */
import type { VoiceRealtimeCaption } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

/** A caption's spoken-order key: its own segment, and `Infinity` for one that belongs to no segment. */
function captionOrderKey(caption: VoiceRealtimeCaption): number {
  return typeof caption.seq === 'number' && Number.isInteger(caption.seq) ? caption.seq : Number.POSITIVE_INFINITY;
}

/**
 * The captions in the order they were SPOKEN, which is not the order they arrived in.
 *
 * The endpoint answers its commits in whatever order it finishes, so a transcript for an earlier
 * segment regularly lands after a later one's (journal `ef9daacd`: seq2's after seq3's, seq4's after
 * seq5's). Appending on arrival — what this did — therefore read the person their own sentences out
 * of order, and the composer's leave-backlog in that order too. Sorting by the segment each caption
 * was spoken in is what puts both right, and the sort is STABLE: captions that belong to no segment
 * (`Infinity`) keep their arrival order among themselves, so a connection with no seq information at
 * all is ordered exactly as it was before.
 */
export function sortCaptionsInSpokenOrder(captions: readonly VoiceRealtimeCaption[]): VoiceRealtimeCaption[] {
  return [...captions].sort((left, right) => {
    const a = captionOrderKey(left);
    const b = captionOrderKey(right);
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

/**
 * The segment a caption with no `seq` of its own belongs to: the OLDEST segment this connection has
 * committed that no other utterance accounts for, or `null` when there is none to be had.
 *
 * WHY A CAPTION THE PROXY COULD NOT PLACE STILL GETS PLACED. `seq` is the client's own segment number,
 * echoed back on the frames the proxy can attribute — and there is one utterance it cannot attribute:
 * the one whose item the ENDPOINT's own detector created. The 2026-10-12 journal's seq1 was refused a
 * commit ("buffer too small") precisely because the deployment's VAD had already taken that audio as an
 * item of its own, and the words of that utterance came back during seq2 carrying `seq: null` — read
 * off the replay's own recording: `{"itemId":"A_B","text":"现在是第二句话。","seq":null}`. Placement by
 * speech had nothing to place by, so the sentence fell past the end of the transcript, BELOW the
 * answers it preceded, and the leave-backlog (which reads the captions in this same order) was read
 * back to front with it. The person's own second sentence was the one sentence the screen got wrong.
 *
 * THE OLDEST UNCLAIMED SEGMENT, NOT THE ACTIVE ONE. A segment is claimed by the utterance whose `seq`
 * names it; the ones left over are the segments still waiting for their words, and the earliest of
 * those is the earliest place the words can have been spoken — so nothing already on screen is pushed
 * below a sentence that may have been said after it. Reading the segment that happened to be active
 * when the endpoint finally answered would be a coin toss the page cannot see the result of: for the
 * journal's caption the two candidates are 34 ms apart (`segment_ack seq=2` at …550906, the caption at
 * …551206, `segment_ack seq=3` at …551240) and both are "the segment in flight", so the client would be
 * choosing by clock skew rather than by anything it knows.
 *
 * A GUESSED SEGMENT IS NOT A SECOND HOLE. The refusal that preceded such a caption says no transcript is
 * coming for that COMMIT — not that the audio was lost: the same audio was transcribed under the item the
 * detector made instead (the journal's item B is created during seq1's own turn, which is why seq1's
 * commit was refused). So a guessed segment is settled like an attributed one
 * ({@link settleSegmentTranscript} retracts the not-recognised line the refusal drew), and the guess never
 * ADDS a line to the transcript: the segments that really produced no words keep theirs, and the one the
 * words came back to stops claiming to be one.
 *
 * `null` for a connection that has committed no segment at all (continuous mode, whose captions carry
 * no seq either) or for a caption that arrives before the first commit: those keep the placement this
 * module has always had, with no position to place by.
 */
export function unclaimedSegment(captions: readonly VoiceRealtimeCaption[], segmentsSent: number): number | null {
  const claimed = new Set<number>();
  for (const caption of captions) {
    const key = captionOrderKey(caption);
    if (Number.isFinite(key)) claimed.add(key);
  }
  for (let seq = 0; seq < segmentsSent; seq += 1) {
    if (!claimed.has(seq)) return seq;
  }
  return null;
}

/**
 * The pending captions one delivery answers, up to and including the item it reports covering.
 *
 * The watermark is a boundary the ENDPOINT moved — the commit that created the item — so everything
 * at or before it was in the model's conversation when this delivery was produced. Captions the page
 * holds that the watermark does not name are all EARLIER than it (an item is committed before it is
 * transcribed, and captions arrive in that order), so an unmatched watermark covers them too: the
 * alternative is leaving a sentence on screen as never-handled for the one reason that it was the
 * last thing said, which is exactly the bubble this attribution exists to stop drawing.
 */
export function claimThrough(
  pending: readonly VoiceRealtimeCaption[],
  coveredThroughItemId: string,
): VoiceRealtimeCaption[] {
  const boundary = pending.findIndex((caption) => caption.itemId === coveredThroughItemId);
  return boundary === -1 ? [...pending] : pending.slice(0, boundary + 1);
}
