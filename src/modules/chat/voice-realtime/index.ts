/**
 * The browser's Live Voice control plane (GOAL-031/AC-310-315; GOAL-033/AC-316-317).
 *
 * Three public symbols: the hook that owns the `/voice-realtime` connection, the
 * fixed compact bar `ChatInterface` renders in place of `ChatComposer` while Live
 * Voice mode is active, and the caption type the pane turns into transcript rows.
 * The hook is exported because the pane — not the bar — owns the connection: the
 * transcript it also renders has to show what the model heard (AC-317), and a
 * connection owned by the bar could not reach it.
 *
 * The `placeCaptions` helpers are the pane's row algebra: the real messages (the delivered ones
 * marked as spoken) plus one HONEST row per segment the transcript cannot account for — a REFUSED
 * utterance gets a row of its own so the loss is countable, and so does a segment that came back
 * with no transcript at all, so a silence is not read as a pause. The person's spoken words are
 * never carried by a row of the client's own; the bottom voice bar shows the live transcript. Plus
 * the edge reader the pane and the hook share: the words a leave never delivered, which
 * `ChatInterface` puts back into the composer's draft. All of it is entered through
 * `voiceTranscriptRows`.
 *
 * `useVoicePendingWithdraw` and its row/list are the per-utterance withdrawal
 * control (GOAL-041 / AC-351, SPEC §0.3 D-11): a delivery that joined the CLI's
 * queue carries the command's own id, and this is the UI that can take exactly
 * one of those sentences back without touching the run in flight. The pane owns
 * the hook (it owns the deliveries) and hands the rows to the bar's
 * `pendingUtterances` slot.
 */
export { default as VoiceRealtimeBar } from '@/modules/chat/voice-realtime/VoiceRealtimeBar';
export { default as VoicePendingUtteranceList, VoicePendingUtteranceRow } from '@/modules/chat/voice-realtime/VoicePendingUtterance';
export {
  useVoicePendingWithdraw,
  type VoicePendingUtterance,
  type VoicePendingUtteranceState,
} from '@/modules/chat/voice-realtime/useVoicePendingWithdraw';
export {
  collectUndeliveredUtterances,
  countUnshownUtterances,
  deliveryIsShown,
  markDeliveredVoiceMessages,
  placeCaptionsChronologically,
  segmentOutcomeRows,
  undeliveredUtteranceRows,
  unrecognizedSegmentRows,
  voiceTranscriptRows,
} from '@/modules/chat/voice-realtime/placeCaptions';
export { useFollowSentRun } from '@/modules/chat/voice-realtime/useFollowSentRun';
export {
  useVoiceRealtimeSession,
  type VoiceRealtimeCaption,
  type VoiceRealtimeDelivery,
  type VoiceRealtimePhase,
  type VoiceRealtimeSession,
} from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';
