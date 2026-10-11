/**
 * The Live Voice per-window spend cap, resolved as a PURE FUNCTION of the environment and an
 * explicit override.
 *
 * WHY THE PRODUCTION PATH HAS NO DEFAULT HERE. Until this module existed the assembly point carried
 * a hard-coded `0.015` fallback (`input.spendWindowLimitCny ?? Number(process.env.VOICE_REALTIME_MAX_CNY_PER_30S ?? 0.015)`),
 * and the ONLY caller that relied on it was the production browser path: the HTTP diagnosis route
 * passes its own `0.05`, so every other path was already explicit. That default was not a
 * failsafe — it ended real sessions. The guard's own arithmetic says why: a `response.done` that
 * re-reads a ~1.0k-token context and emits ~18 tokens costs about ¥0.0016, so ¥0.015 is roughly
 * NINE responses per 30 s, and a normal tool-heavy conversation spends one full context re-read per
 * tool round trip. The rule this module encodes (owner's decision, 2026-10-11) is that production
 * does not set this cap at all: it exists only when a deployment explicitly names one, either as
 * the assembly override or through {@link VOICE_REALTIME_MAX_CNY_PER_30S_ENV}. Absent both, the
 * assembled `spendGuard` carries NO `maxCnyPerWindow` and the transport's window branch can never
 * fire.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE HANDLER. The same reason the sibling switches are
 * (`resolveVoiceRealtimeMode`, `resolveTurnDetection`): a threshold that lives inline in the
 * composition root can only be read by re-reading `process.env` in the test, so the criterion and
 * the assembly point drift into two different readings of "the default". Resolution here is pure —
 * nothing reads `process.env`, nothing logs, nothing touches a socket — the environment arrives as
 * a parameter and the caller passes its own sink to {@link describeSpendWindowLimit}.
 *
 * WHY A MISTYPED VALUE IS REFUSED AND REPORTED RATHER THAN PARSED. `Number('abc')` is `NaN` and
 * `inWindow > NaN` is false for every `inWindow`, so an unvalidated typo produces a cap that never
 * fires — indistinguishable, in the log and in behaviour, from a deployment that deliberately set
 * no cap. A refused value therefore resolves to `undefined` (no window cap, the same as absent) AND
 * carries a printable `invalid` string, following `resolveVoiceRealtimeMode`'s "never silently
 * obey a typo" rule. The same applies to a present-but-empty string: an exported `VOICE_…='  '` is
 * someone trying to blank the knob, not a deployment that said nothing.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE. The whole-connection total
 * (`VOICE_REALTIME_MAX_CNY_PER_CONNECTION`) stays with the assembly point: it was always an
 * explicit opt-in and this change does not touch it. SPEC C5's context-package scaling
 * (`windowLimit = 0.015 + 0.003 × 包token/1000`) is NOT implemented here either — the package size
 * is read per connection inside the proxy while the seams are assembled once at boot, so that
 * scaling needs a `createTransport` signature change and is its own task.
 */

/**
 * The environment variable that sets the per-window spend cap, in CNY per 30 s.
 *
 * Unset (the shipped state) means NO window cap at all. A set value must be a positive finite
 * number; anything else is refused and reported through `invalid` rather than obeyed.
 */
export const VOICE_REALTIME_MAX_CNY_PER_30S_ENV = 'VOICE_REALTIME_MAX_CNY_PER_30S';

/**
 * One resolution. `maxCnyPerWindow` is `undefined` when neither the override nor the environment
 * named a usable cap — which is the shipped production state, not an error — and `invalid` is a
 * readable description of a value that was refused, or `null` when nothing was refused. The two are
 * independent: `{undefined, null}` is "nobody asked for a cap", `{undefined, '…'}` is "someone
 * asked for one and it was refused", and the caller logs the second.
 */
export type SpendWindowLimitResolution = {
  maxCnyPerWindow: number | undefined;
  invalid: string | null;
};

/**
 * Reads one candidate cap, accepting only a positive finite number.
 *
 * Accepts the string form a deployment exports and the number form the diagnosis route passes,
 * because both reach the same resolver (see {@link resolveSpendWindowLimit}). `null` means
 * "refused" — the caller turns it into an `invalid` entry with the raw value's spelling intact, so
 * the log names what the operator actually typed.
 */
function parsePositiveCny(provided: unknown): number | null {
  if (typeof provided === 'number') {
    return Number.isFinite(provided) && provided > 0 ? provided : null;
  }
  if (typeof provided !== 'string') return null;
  const trimmed = provided.trim();
  // A blank string is a refused value, not an absent one: `Number('')` is 0, which is not a cap
  // anyone means, and AC2's "unset" means the variable is ABSENT.
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves the per-window spend cap for one deployment (and, optionally, one caller's override)
 * from the environment and override it is handed.
 *
 * Pure and total. Precedence is override → environment → NO cap: an override is the authority
 * whenever it is present, so the HTTP diagnosis route's `0.05` wins over a deployment's own
 * variable for that run, exactly as `resolveTurnDetection`'s per-run override does. A present but
 * refused value does NOT fall through to the lower-precedence source — substituting one cap for
 * another would hide the misconfiguration the report exists to surface.
 *
 * Consumers: the composition root (`server/index.ts`, `buildVoiceRealtimeSeams`) calls this at the
 * ONE place the seams are assembled, so the browser socket and the HTTP diagnosis route resolve
 * through the same function; the module's criterion feeds it the environment and the override as
 * ARGUMENTS, so it reads the same answers the assembly point does rather than a copy.
 */
export function resolveSpendWindowLimit(
  env: Readonly<Record<string, string | undefined>>,
  override?: number,
): SpendWindowLimitResolution {
  if (override !== undefined) {
    const value = parsePositiveCny(override);
    if (value === null) {
      return {
        maxCnyPerWindow: undefined,
        invalid: `override ${JSON.stringify(override)} is not a positive number of CNY per 30 s`,
      };
    }
    return { maxCnyPerWindow: value, invalid: null };
  }
  const raw = env[VOICE_REALTIME_MAX_CNY_PER_30S_ENV];
  if (raw === undefined) return { maxCnyPerWindow: undefined, invalid: null };
  const value = parsePositiveCny(raw);
  if (value === null) {
    return {
      maxCnyPerWindow: undefined,
      invalid: `${VOICE_REALTIME_MAX_CNY_PER_30S_ENV}=${JSON.stringify(raw)} is not a positive number of CNY per 30 s`,
    };
  }
  return { maxCnyPerWindow: value, invalid: null };
}

/**
 * The line to log for one resolution, or `null` when there is nothing to report.
 *
 * Kept here so the composition root and any other caller say the SAME thing about the same
 * misconfiguration rather than two hand-written sentences that drift (the shape
 * `describeVoiceRealtimeMode` established). Callers pass their own sink. The sentence states the
 * consequence, because the consequence is the point: with no usable cap the window branch is off,
 * which is a silent-disarm only if nobody says it out loud.
 */
export function describeSpendWindowLimit(resolution: SpendWindowLimitResolution): string | null {
  if (resolution.invalid === null) return null;
  return `spend window limit: ${resolution.invalid} — the per-window spend cap is OFF for this connection (set a positive number, or nothing at all)`;
}
