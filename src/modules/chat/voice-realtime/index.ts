/**
 * The browser's Live Voice control plane (GOAL-031/AC-310-315; GOAL-033/AC-316).
 *
 * One public symbol: the fixed, compact capture bar `ChatInterface` renders in
 * place of `ChatComposer` while Live Voice mode is active. It is a part of the
 * chat module rather than a module of its own because it only ever renders
 * inside `ChatInterface`, against that pane's open session.
 */
export { default as VoiceRealtimeBar } from '@/modules/chat/voice-realtime/VoiceRealtimeBar';
