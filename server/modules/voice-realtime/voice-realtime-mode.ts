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
 * WHY DEFAULT-OFF, WITH AN ESCAPE HATCH. The original rollout decision (2026-10-10) made segmented
 * relay the default. The 2026-10-13 experience-first ruling (decision doc §11–§12, GOAL-044) reversed
 * that: continuous is now the default, so a browser connecting plainly stays on the wire it always
 * had, frame for frame, and nobody has to choose anything. `VOICE_REALTIME_MODE=segmented` is the
 * escape hatch — a deployment can still turn segmentation back on, and turning it off again is a
 * server-side env change alone, no browser release.
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
 * `continuous` (or unset, or empty) asks for the default: answer nothing, so the browser stays on
 * continuous frames. `segmented` asks for the escape hatch: answer a matching `hello` with
 * `{type:'ready', protocol:'segmented-v1'}`. Any other value is a misconfiguration and is reported
 * (see {@link describeVoiceRealtimeMode}) rather than obeyed — an unknown spelling must never
 * silently enable the relay, because "on by typo" is indistinguishable from a working rollback.
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
 * Pure and total: every input yields a usable mode. The default is `continuous` (the 2026-10-13
 * experience-first ruling, GOAL-044, superseding the 2026-10-10 P4 rollout decision), so an unset
 * variable, an empty string and an unknown value all land on `continuous` — the last one flagged
 * through `invalid` so it is visible instead of silent.
 */
export function resolveVoiceRealtimeMode(
  env: Readonly<Record<string, string | undefined>>,
): VoiceRealtimeModeResolution {
  const raw = env[VOICE_REALTIME_MODE_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { mode: 'continuous', invalid: null };
  }
  const value = raw.trim();
  if (value === 'segmented') return { mode: 'segmented', invalid: null };
  if (value === 'continuous') return { mode: 'continuous', invalid: null };
  // An unknown value is a typo, and the safe reading of a typo is the default — but only if it is
  // SAID OUT LOUD. A silently-ignored `VOICE_REALTIME_MODE=segmentd` would look exactly like a
  // working rollback while the relay stayed off, so this resolves to the default AND reports.
  return { mode: 'continuous', invalid: value };
}

/**
 * The line to log for one resolution, or `null` when there is nothing to report.
 *
 * Kept here so the composition root and the proxy say the SAME thing about the same misconfiguration
 * rather than two hand-written sentences that drift. Callers pass their own sink.
 */
export function describeVoiceRealtimeMode(resolution: VoiceRealtimeModeResolution): string | null {
  if (resolution.invalid === null) return null;
  return `mode: ${VOICE_REALTIME_MODE_ENV}="${resolution.invalid}" is not a known mode — using the default (continuous)`;
}

/** Whether this mode declares the segmented relay to the browser. */
export function declaresSegmentedRelay(mode: VoiceRealtimeMode): boolean {
  return mode === 'segmented';
}

// ── the per-connection transport opt-in ──────────────────────────────────────────────────────────
//
// The relay above is a DEPLOYMENT switch: `VOICE_REALTIME_MODE` is read once per process, so turning
// it on or off affects every browser and needs a server change. The opt-in below is the OTHER axis —
// ONE browser asks, on ONE connection, for the transport it wants. It is deliberately expressed as a
// URL parameter (the browser already opens `/voice-realtime?token=…&session=…`), so the choice is
// known to `server/index.ts` BEFORE the seams are assembled: the proxy reads `segmentedRelay` and
// builds its state machines once, at setup, and a per-connection answer that only arrived later — in
// the `hello` frame — would be too late for the duplicate guard and the segmentation branches that
// branch on it. A per-connection choice therefore WINS over the environment for that connection and
// nobody else's; the environment stays the default every connection without a choice follows.

/** The connection-URL query parameter a browser uses to name the transport it wants for one connection. */
export const VOICE_REALTIME_TRANSPORT_PARAM = 'transport';

/** A transport one connection may ask for — the same two words the deployment's own mode uses. */
export type VoiceRealtimeTransport = VoiceRealtimeMode;

/**
 * Reads a per-connection transport from a raw URL value.
 *
 * `null` MEANS "THIS CONNECTION ASKED FOR NOTHING", which is not the same as asking for the default:
 * the caller hands the `null` on, and the environment decides. Every other value — absent, empty, or
 * an unknown spelling — ALSO reads as `null`, so a typo in a query string can only ever fall back to
 * the deployment's own resolution; it can never silently blank the relay the way an unknown
 * environment value cannot (see {@link resolveVoiceRealtimeMode}).
 */
export function parseVoiceRealtimeTransport(raw: string | null | undefined): VoiceRealtimeTransport | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (value === 'segmented' || value === 'continuous') return value;
  return null;
}

/**
 * Applies a per-connection choice to a deployment resolution, the choice winning when there is one.
 *
 * The environment's `invalid` note is DROPPED when a choice overrode it: that note says the
 * deployment's own value was refused and the default was used, and for a connection whose transport
 * this browser picked, the deployment's value no longer decided anything. Reporting it here would
 * describe a resolution this connection is not using.
 */
export function applyVoiceRealtimeTransport(
  resolution: VoiceRealtimeModeResolution,
  transport: VoiceRealtimeTransport | null,
): VoiceRealtimeModeResolution {
  return transport === null ? resolution : { mode: transport, invalid: null };
}
