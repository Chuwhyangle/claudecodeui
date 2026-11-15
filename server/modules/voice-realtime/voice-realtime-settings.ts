/**
 * Compatibility re-export. `voice-realtime-settings` moved into `./connection/` in the 2026-11-15
 * voice-realtime god-package split; this file remains so every existing
 * `…/voice-realtime-settings.js` import path keeps resolving.
 */
export * from './connection/voice-realtime-settings.js';
