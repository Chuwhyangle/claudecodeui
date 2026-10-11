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
 * The `placeCaptions` helpers are the pane's row algebra: folding the utterances
 * still in flight into the one provisional row (AC-326), giving every REFUSED
 * utterance a row of its own so the loss is countable (this task), and finalising
 * that row into the real message a delivery confirms.
 */
export { default as VoiceRealtimeBar } from '@/modules/chat/voice-realtime/VoiceRealtimeBar';
export {
  countUnshownUtterances,
  deliveryIsShown,
  dropCaptionsDeliveredAsMessages,
  foldCaptionsIntoTranscriptRow,
  markDeliveredVoiceMessages,
  placeCaptionsChronologically,
  undeliveredUtteranceRows,
} from '@/modules/chat/voice-realtime/placeCaptions';
export { useFollowSentRun } from '@/modules/chat/voice-realtime/useFollowSentRun';
export {
  useVoiceRealtimeSession,
  type VoiceRealtimeCaption,
  type VoiceRealtimeDelivery,
  type VoiceRealtimePhase,
  type VoiceRealtimeSession,
} from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';
