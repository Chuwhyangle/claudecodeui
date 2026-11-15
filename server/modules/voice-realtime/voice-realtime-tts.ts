/**
 * Compatibility re-export. `voice-realtime-tts` moved into `./core/` in the 2026-11-15
 * voice-realtime god-package split; this file remains so every existing
 * `…/voice-realtime-tts.js` import path keeps resolving.
 */
export * from './core/voice-realtime-tts.js';
