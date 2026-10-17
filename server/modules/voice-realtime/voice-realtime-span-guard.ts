/**
 * THE LIVE RELAY'S SPAN GUARD — the A/B switch that brings back the deleted "prepend every heard
 * sentence the model's call left out" behaviour (task `gap-live-voice-span-guard-flag`).
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE COMPOSITION ROOT. Same reason as
 * `voice-realtime-mode.ts` and `voice-realtime-closing-turn.ts`: the switch has to be resolvable,
 * printable and testable on its own, and nothing here reads `process.env`, logs, or touches a socket.
 * `server/index.ts` hands in the environment at the ONE place the seams are assembled; a proxy handed
 * no seam reads the shipped default below, never the environment, so a criterion that sets nothing
 * sees the same default a deployment that sets nothing does.
 *
 * WHAT IT SWITCHES. With `on`, the continuous wire's `session_send` compares every sentence the
 * endpoint transcribed since the forwarding watermark against the model's own message (by
 * adjacent-character-pair overlap, see `selectUncoveredFragments`) and puts the ones it
 * judges uncovered VERBATIM in front of that message, in one delivery. With `off` — the default and
 * the shipped behaviour since the 2026-10-16 ruling — the model's words are the whole of what the
 * segment sends.
 *
 * WHY DEFAULT OFF. The 2026-10-16 ruling (`gap-live-voice-one-text-per-segment-prefer-response`)
 * removed the guard because its measure cannot tell "the model rewrote this" from "the model dropped
 * this": in journal `3d2d3b2c` the endpoint misheard "LiveWire" as "来望也", the model repaired it
 * from the audio, and the pair share (6/13 = 0.462 < 0.5) delivered the mishearing in front of the
 * correction. `on` deliberately reproduces that risk — it is the arm the A/B exists to measure — so
 * it must be chosen, never inherited from a typo. An unknown spelling resolves to OFF and is
 * REPORTED, the shape `resolveVoiceRealtimeMode` established.
 *
 * Read once per process; a change takes effect on the next server restart.
 */

/**
 * The environment variable that turns the span guard on for a deployment.
 *
 * Read by the composition root (`server/index.ts`) and handed to
 * {@link resolveVoiceRealtimeSpanGuard}; consumed by `voice-realtime-ws-proxy.service.ts` through the
 * resolved seam only.
 */
export const VOICE_REALTIME_SPAN_GUARD_ENV = 'VOICE_REALTIME_SPAN_GUARD';

/**
 * Whether a deployment that names nothing replays the span guard. `false` is the shipped behaviour:
 * one text per segment, the model's response when there is one.
 */
export const DEFAULT_VOICE_REALTIME_SPAN_GUARD = false;

/** One span-guard resolution; `invalid` is the offending raw value, or `null` when there was none. */
export type VoiceRealtimeSpanGuardResolution = {
  spanGuard: boolean;
  invalid: string | null;
};

/**
 * Resolves the span guard from the environment it is handed.
 *
 * Pure and total: `on` and `off` are taken as spelled; unset, empty and blank are the default
 * (`off`); anything else is the default AND reported through `invalid`, so a typo cannot pass for a
 * working switch. Consumed by `server/index.ts` (`buildVoiceRealtimeSeams`).
 */
export function resolveVoiceRealtimeSpanGuard(
  env: Readonly<Record<string, string | undefined>>,
): VoiceRealtimeSpanGuardResolution {
  const raw = env[VOICE_REALTIME_SPAN_GUARD_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { spanGuard: DEFAULT_VOICE_REALTIME_SPAN_GUARD, invalid: null };
  }
  const value = raw.trim();
  if (value === 'on') return { spanGuard: true, invalid: null };
  if (value === 'off') return { spanGuard: false, invalid: null };
  return { spanGuard: DEFAULT_VOICE_REALTIME_SPAN_GUARD, invalid: value };
}

/**
 * The line to log for one resolution, or `null` when there is nothing to report.
 *
 * A misspelling is reported (the default was used), and so is an EXPLICIT `on` — this switch is an
 * A/B arm that knowingly reproduces the `3d2d3b2c` duplicate delivery, so a deployment that turned
 * it on should see that in the startup line rather than infer it from behaviour. Consumed by
 * `server/index.ts`, which passes its own sink.
 */
export function describeVoiceRealtimeSpanGuard(resolution: VoiceRealtimeSpanGuardResolution): string | null {
  if (resolution.invalid !== null) {
    return `span-guard: ${VOICE_REALTIME_SPAN_GUARD_ENV}="${resolution.invalid}" is not a known value (on | off) — using the default (${DEFAULT_VOICE_REALTIME_SPAN_GUARD ? 'on' : 'off'})`;
  }
  return resolution.spanGuard
    ? `span-guard: ${VOICE_REALTIME_SPAN_GUARD_ENV}=on — uncovered heard sentences are prepended to session_send (the deleted A/B arm; it can duplicate a segment the model rewrote)`
    : null;
}
