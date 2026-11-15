/**
 * Compatibility re-export. `voice-realtime-trunk-step-handlers` moved into `./connection/` in the 2026-11-15
 * voice-realtime god-package split; this file remains so every existing
 * `…/voice-realtime-trunk-step-handlers.js` import path keeps resolving.
 */
export * from './connection/voice-realtime-trunk-step-handlers.js';
