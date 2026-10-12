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
 * The `placeCaptions` helpers are the pane's row algebra: one row per utterance the model
 * heard, at the segment it was spoken in (this task), giving every REFUSED utterance a row
 * of its own so the loss is countable, and a row where a segment came back with no
 * transcript at all so a silence is not read as a pause — plus the two edge readers the bar
 * and the pane share: the words a leave never delivered, and the close trace that says so.
 * All of it is entered through `voiceTranscriptRows`.
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
  appendVoiceCloseTrace,
  collectUndeliveredUtterances,
  countUnshownUtterances,
  deliveryIsShown,
  dropCaptionsDeliveredAsMessages,
  foldCaptionsIntoTranscriptRow,
  heardUtteranceRows,
  markDeliveredVoiceMessages,
  placeCaptionsChronologically,
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
