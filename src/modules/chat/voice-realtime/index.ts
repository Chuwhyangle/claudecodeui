/**
 * The browser's voice control plane (GOAL-031 / AC-312).
 *
 * One public symbol: the mic → editable intent → `session_send` strip. It is a
 * part of the chat module rather than a module of its own because it only ever
 * renders inside `ChatInterface`, against that pane's open session.
 */
export { default as VoiceRealtimeControl } from '@/modules/chat/voice-realtime/VoiceRealtimeControl';
