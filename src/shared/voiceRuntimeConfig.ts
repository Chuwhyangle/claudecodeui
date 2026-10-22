import type { VoiceContextPackRuntimeSettings } from '@shared/voice/voiceSettingsRegistry';

/**
 * The deployment's effective context-pack size, as the last `GET /api/voice/runtime-config`
 * answered it, or `null` before any reading arrived.
 *
 * WHY THIS IS ITS OWN MODULE RATHER THAN A SLOT IN `src/shared/api`. The cache is read by the two
 * hooks that BUILD a pack — `useVoiceInput` (the one-shot listen) and `useVoiceRealtimeSession`
 * (the first `context` frame) — and both are driven by criteria that replace `@/shared/api` with a
 * hand-built partial double listing only the calls they need. A named export added to that module
 * would arrive in those doubles as `undefined`, so every one of them would have to learn the new
 * name or the listen would abort before it committed anything. Keeping the slot beside the builders
 * that read it means the doubles stay complete without being asked to know about a knob they never
 * exercise; `api.voice.runtimeConfig()` (the endpoint itself) still lives with the rest of the API.
 *
 * A SYNCHRONOUS SLOT, for the same reason `voiceProviderProfile` is one: the pack is built inside a
 * socket callback (the first `context` frame goes out on `open`) where awaiting a request is not
 * possible, so the reading has to have been published ahead of it. `null` means "no reading yet",
 * and every caller treats it as the shipped defaults — a value is never invented client-side.
 */
let voiceRuntimeConfig: VoiceContextPackRuntimeSettings | null = null;

/**
 * Publishes the runtime-config reading. Called by the chat module's `useVoiceAvailable`, which is
 * the one place the payload is fetched; nothing else writes it. `null` clears it (a failed fetch
 * leaves the defaults in force rather than keeping a stale reading).
 */
export function setVoiceRuntimeConfig(config: VoiceContextPackRuntimeSettings | null): void {
  voiceRuntimeConfig = config;
}

/** The published runtime-config reading, or `null` before one arrived. */
export function readVoiceRuntimeConfig(): VoiceContextPackRuntimeSettings | null {
  return voiceRuntimeConfig;
}
