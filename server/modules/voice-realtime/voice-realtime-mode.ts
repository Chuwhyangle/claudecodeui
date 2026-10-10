/**
 * Which relay the server offers a browser, and the token it offers it in (GOAL-034 / AC-322, P4).
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE HANDLER. The segmented relay changes what the UPSTREAM
 * hears — silence stops being uploaded — so the switch that turns it on must be resolvable, printable
 * and testable on its own. Resolution is a pure function of the environment: nothing here reads
 * `process.env`, nothing here logs, and nothing here touches a socket. The composition root
 * (`server/index.ts`, `buildVoiceRealtimeSeams`) calls {@link resolveVoiceRealtimeMode} at the ONE
 * place the seams are assembled, and the proxy calls it too when a caller passes no seam — so a
 * deployment that sets nothing gets the shipped default, and a criterion that sets nothing reads the
 * SAME default rather than a copy of it.
 *
 * WHY DEFAULT-ON, WITH A FALLBACK. The rollout decision (2026-10-10) is that segmented relay is the
 * default and `VOICE_REALTIME_MODE=continuous` is the escape hatch: a browser only ever switches when
 * the server ANSWERS its `hello`, so a proxy that says nothing keeps the continuous wire it always
 * had, frame for frame. Turning it off is therefore a server-side env change alone — no browser
 * release — which is what makes the fallback usable as a rollback.
 *
 * The token is the SAME string the browser offers (`SEGMENTED_RELAY_PROTOCOL` in
 * `src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts`). It is repeated, not imported: the
 * server's `tsconfig.json` excludes `../src`, so a server module cannot reach the browser's copy, and
 * a shared module that both could import would be a third place to keep in step. The criterion pins
 * the two literals against each other instead — a divergence there breaks the handshake silently, so
 * it must be a red, not a comment.
 */

/**
 * The relay protocol token the browser offers in `hello` and the server answers in `ready`
 * (and, for a proxy that declares it alongside the upstream session, in `state`).
 *
 * MUST equal the browser's `SEGMENTED_RELAY_PROTOCOL` — see the file header.
 */
export const SEGMENTED_RELAY_PROTOCOL = 'segmented-v1';

/**
 * The environment variable that selects the relay for a deployment.
 *
 * `segmented` (or unset, or empty) asks for the default: answer a matching `hello` with
 * `{type:'ready', protocol:'segmented-v1'}`. `continuous` asks for the pre-P4 wire: answer nothing,
 * so the browser stays on continuous frames. Any other value is a misconfiguration and is reported
 * (see {@link describeVoiceRealtimeMode}) rather than obeyed — an unknown spelling must never
 * silently disable the relay, because "off by typo" is indistinguishable from a working rollback.
 */
export const VOICE_REALTIME_MODE_ENV = 'VOICE_REALTIME_MODE';

/** The two relays the server can offer. */
export type VoiceRealtimeMode = 'segmented' | 'continuous';

/**
 * One resolution. `invalid` is the offending raw value when the environment named a mode that does
 * not exist, and `null` otherwise — so a caller can log the misconfiguration without re-reading the
 * environment, and the resolution still carries the mode that will actually be used.
 */
export type VoiceRealtimeModeResolution = {
  mode: VoiceRealtimeMode;
  invalid: string | null;
};

/**
 * Resolves the relay for one deployment from the environment it is handed.
 *
 * Pure and total: every input yields a usable mode. The default is `segmented` (the P4 rollout
 * decision), so an unset variable, an empty string and an unknown value all land on `segmented` —
 * the last one flagged through `invalid` so it is visible instead of silent.
 */
export function resolveVoiceRealtimeMode(
  env: Readonly<Record<string, string | undefined>>,
): VoiceRealtimeModeResolution {
  const raw = env[VOICE_REALTIME_MODE_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { mode: 'segmented', invalid: null };
  }
  const value = raw.trim();
  if (value === 'segmented') return { mode: 'segmented', invalid: null };
  if (value === 'continuous') return { mode: 'continuous', invalid: null };
  // An unknown value is a typo, and the safe reading of a typo is the default — but only if it is
  // SAID OUT LOUD. A silently-ignored `VOICE_REALTIME_MODE=coninuous` would look exactly like a
  // working fallback while the relay stayed on, so this resolves to the default AND reports.
  return { mode: 'segmented', invalid: value };
}

/**
 * The line to log for one resolution, or `null` when there is nothing to report.
 *
 * Kept here so the composition root and the proxy say the SAME thing about the same misconfiguration
 * rather than two hand-written sentences that drift. Callers pass their own sink.
 */
export function describeVoiceRealtimeMode(resolution: VoiceRealtimeModeResolution): string | null {
  if (resolution.invalid === null) return null;
  return `mode: ${VOICE_REALTIME_MODE_ENV}="${resolution.invalid}" is not a known mode — using the default (segmented)`;
}

/** Whether this mode declares the segmented relay to the browser. */
export function declaresSegmentedRelay(mode: VoiceRealtimeMode): boolean {
  return mode === 'segmented';
}
