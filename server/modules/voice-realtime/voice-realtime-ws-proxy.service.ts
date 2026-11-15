/**
 * Compatibility re-export. `voice-realtime-ws-proxy.service` moved into `./connection/` in the 2026-11-15
 * voice-realtime god-package split; this file remains so every existing
 * `…/voice-realtime-ws-proxy.service.js` import path keeps resolving.
 */
export * from './connection/voice-realtime-ws-proxy.service.js';
