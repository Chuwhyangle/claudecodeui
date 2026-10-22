/**
 * The Live Voice per-window spend cap, resolved as a PURE FUNCTION of three named sources: the
 * caller's override, the deployment's environment, and the deployment's settings file.
 *
 * THE DEFAULT IS ¥0.05 PER 30 s. It is a RATE guard, not a cost line: a runaway tool-call loop
 * crosses it within seconds, while ordinary conversation stays below it. The number is calibrated
 * against the owner's real journal (2026-10-11 through 2026-10-22, 147 connections with responses):
 * the 30 s sliding-window cost has p50 ¥0.0117, p90 ¥0.0376, p99 ¥0.0654 and max ¥0.0687. The old
 * ¥0.015 default tripped 59/147 (40.1%) of those normal connections — it was calibrated for a
 * ~1.0k-token context, while the observed responses re-read about 2.5k tokens. ¥0.05 trips 6/147
 * (4.1%) and still catches the recorded runaway shape (F8: 89 calls, 300,121 input tokens,
 * ≈¥0.49/min ≈¥0.245 per 30 s). The whole-connection total is untouched; it remains the explicit
 * `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` opt-in.
 *
 * THE FILE IS NOW A SOURCE. Before this module carried the settings-file block, a deployment could
 * only tune the cap through an environment variable or the diagnosis route's override; both are
 * per-process escape hatches rather than the operator-facing configuration surface. The settings
 * file (`VOICE_REALTIME_SETTINGS_PATH`) is the normal entry, the environment stays the escape
 * hatch, and the diagnosis route keeps its per-run override. Precedence is
 * override → environment → file → default.
 *
 * WHY A MISTYPED VALUE IS REFUSED AND REPORTED RATHER THAN PARSED. `Number('abc')` is `NaN` and
 * `inWindow > NaN` is false for every `inWindow`, so an unvalidated typo produces a cap that never
 * fires. A refused value therefore resolves to the DEFAULT (the guard stays armed) AND carries a
 * printable `invalid` string, following `resolveVoiceRealtimeMode`'s "never silently obey a typo"
 * rule. Resolving to `undefined` here would be worse than before the default existed: an operator
 * who meant to tune the cap would have silently disarmed it. The same applies to a
 * present-but-empty string: an exported `VOICE_…='  '` is someone trying to blank the knob, not a
 * deployment that said nothing. A refused value never falls through to the next source — substituting
 * one explicit cap for another would hide the misconfiguration the report exists to surface.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE. The whole-connection total
 * (`VOICE_REALTIME_MAX_CNY_PER_CONNECTION`) stays with the assembly point: it was always an
 * explicit opt-in and this change does not touch it. SPEC C5's context-package scaling is NOT
 * implemented here either — the package size is read per connection inside the proxy while the
 * seams are assembled once per connection at the composition root.
 */
import {
  VOICE_RUNTIME_BOUNDS,
  VOICE_RUNTIME_DEFAULTS,
  type VoiceSpendGuardRuntimeSettings,
} from '@shared/voice/voiceSettingsRegistry.js';

/**
 * The environment variable that overrides the per-window spend cap, in CNY per 30 s.
 *
 * Unset means the settings file (then {@link DEFAULT_SPEND_WINDOW_LIMIT_CNY}) decides. A set value
 * must be a positive finite number inside {@link VOICE_RUNTIME_BOUNDS.spendGuard.maxCnyPerWindow};
 * anything else is refused, reported through `invalid`, and leaves the default in force rather
 * than disarming the guard.
 */
export const VOICE_REALTIME_MAX_CNY_PER_30S_ENV = 'VOICE_REALTIME_MAX_CNY_PER_30S';

/**
 * The shipped per-window cap, in CNY per 30 s. Calibrated from the owner's observed 30 s windows:
 * p90 ¥0.0376, p99 ¥0.0654; ¥0.05 leaves ~96% of connections untouched and still ends the recorded
 * runaway shape. Re-exported from the shared runtime defaults so the browser-side docs, the
 * criterion and the assembly point read one number.
 */
export const DEFAULT_SPEND_WINDOW_LIMIT_CNY = VOICE_RUNTIME_DEFAULTS.spendGuard.maxCnyPerWindow;

/** The shipped window, in milliseconds. */
export const DEFAULT_SPEND_WINDOW_MS = VOICE_RUNTIME_DEFAULTS.spendGuard.windowMs;

/** Which source decided the effective CNY cap. Logged so "which knob won" is answerable. */
export type SpendWindowLimitSource = 'override' | 'environment' | 'file' | 'default';

/**
 * One resolution. `maxCnyPerWindow` is ALWAYS a usable positive number — the caller's override, the
 * deployment's environment value, the settings file's value, or the default — so a connection can
 * never be assembled with the guard silently absent. `invalid` is a readable description of a value
 * that was refused, or `null` when nothing was refused. The two are independent: `{0.05, '…'}` is
 * "someone asked for a cap and it was refused; the default applies instead", and the caller logs it.
 */
export type SpendWindowLimitResolution = {
  maxCnyPerWindow: number;
  /** The sliding window the cap applies over, from the file when it named one, else the default. */
  windowMs: number;
  source: SpendWindowLimitSource;
  invalid: string | null;
};

/** The shape a settings-file reading may carry; fields the file left out are absent. */
export type SpendGuardFileValues = Partial<Record<keyof VoiceSpendGuardRuntimeSettings, unknown>>;

/**
 * Reads one candidate cap, accepting only a positive finite number inside `[minimum, maximum]`.
 *
 * Accepts the string form a deployment exports and the number form the diagnosis route passes,
 * because both reach the same resolver (see {@link resolveSpendWindowLimit}). `null` means
 * "refused" — the caller turns it into an `invalid` entry with the raw value's spelling intact, so
 * the log names what the operator actually typed.
 */
function parseNumberInRange(provided: unknown, minimum: number, maximum: number): number | null {
  let parsed: number;
  if (typeof provided === 'number') {
    parsed = provided;
  } else if (typeof provided === 'string') {
    const trimmed = provided.trim();
    // A blank string is a refused value, not an absent one: `Number('')` is 0, which is not a cap
    // anyone means, and AC2's "unset" means the variable is ABSENT.
    if (trimmed === '') return null;
    parsed = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed >= minimum && parsed <= maximum ? parsed : null;
}

/**
 * Resolves the per-window spend cap for one connection from the override, environment and file.
 *
 * Pure and total. Precedence is override → environment → file → default. An override is the
 * authority whenever it is present, so the HTTP diagnosis route's value wins over a deployment's
 * own variable/file for that run, exactly as `resolveTurnDetection`'s per-run override does. A
 * refused value resolves to the DEFAULT and carries the report; the guard stays armed.
 *
 * `windowMs` has no environment or override spelling: it is the file's value when the file named a
 * valid one, otherwise {@link DEFAULT_SPEND_WINDOW_MS}. A refused window is reported in the same
 * `invalid` string as a refused cap and the default window applies.
 *
 * Consumers: the composition root (`server/index.ts`, `buildVoiceRealtimeSeams`) calls this at the
 * ONE place the seams are assembled for a connection, so the browser socket and the HTTP diagnosis
 * route resolve through the same function; the module's criterion feeds it the three sources as
 * ARGUMENTS, so it reads the same answers the assembly point does rather than a copy.
 */
export function resolveSpendWindowLimit(
  env: Readonly<Record<string, string | undefined>>,
  override?: number,
  file?: SpendGuardFileValues | null,
): SpendWindowLimitResolution {
  const [minCny, maxCny] = VOICE_RUNTIME_BOUNDS.spendGuard.maxCnyPerWindow;
  const [minWindow, maxWindow] = VOICE_RUNTIME_BOUNDS.spendGuard.windowMs;

  // The window is independent of which source names the cap: the file is its only deployment
  // spelling, and a refused window never silently becomes the cap's fault.
  let windowInvalid: string | null = null;
  let windowMs: number = DEFAULT_SPEND_WINDOW_MS;
  if (file !== null && file !== undefined && file.windowMs !== undefined) {
    const parsed = parseNumberInRange(file.windowMs, minWindow, maxWindow);
    if (parsed === null) {
      windowInvalid = `settings file windowMs ${JSON.stringify(file.windowMs)} is not a number of milliseconds between ${minWindow} and ${maxWindow}`;
    } else {
      windowMs = parsed;
    }
  }

  if (override !== undefined) {
    const value = parseNumberInRange(override, minCny, maxCny);
    if (value === null) {
      return {
        maxCnyPerWindow: DEFAULT_SPEND_WINDOW_LIMIT_CNY,
        windowMs,
        source: 'default',
        invalid: `override ${JSON.stringify(override)} is not a number of CNY per window between ${minCny} and ${maxCny}`,
      };
    }
    return { maxCnyPerWindow: value, windowMs, source: 'override', invalid: windowInvalid };
  }

  const raw = env[VOICE_REALTIME_MAX_CNY_PER_30S_ENV];
  if (raw !== undefined) {
    const value = parseNumberInRange(raw, minCny, maxCny);
    if (value === null) {
      return {
        maxCnyPerWindow: DEFAULT_SPEND_WINDOW_LIMIT_CNY,
        windowMs,
        source: 'default',
        invalid: `${VOICE_REALTIME_MAX_CNY_PER_30S_ENV}=${JSON.stringify(raw)} is not a number of CNY per window between ${minCny} and ${maxCny}`,
      };
    }
    return { maxCnyPerWindow: value, windowMs, source: 'environment', invalid: windowInvalid };
  }

  if (file !== null && file !== undefined && file.maxCnyPerWindow !== undefined) {
    const value = parseNumberInRange(file.maxCnyPerWindow, minCny, maxCny);
    if (value === null) {
      return {
        maxCnyPerWindow: DEFAULT_SPEND_WINDOW_LIMIT_CNY,
        windowMs,
        source: 'default',
        invalid: `settings file maxCnyPerWindow ${JSON.stringify(file.maxCnyPerWindow)} is not a number of CNY per window between ${minCny} and ${maxCny}`,
      };
    }
    return { maxCnyPerWindow: value, windowMs, source: 'file', invalid: windowInvalid };
  }

  return { maxCnyPerWindow: DEFAULT_SPEND_WINDOW_LIMIT_CNY, windowMs, source: 'default', invalid: windowInvalid };
}

/**
 * The line to log for one resolution, or `null` when there is nothing to report.
 *
 * Kept here so the composition root and any other caller say the SAME thing about the same
 * misconfiguration rather than two hand-written sentences that drift (the shape
 * `describeVoiceRealtimeMode` established). Callers pass their own sink. The sentence states the
 * consequence, because the consequence is the point: a refused value leaves the DEFAULT cap in
 * force, so the guard is still armed and the operator can see which value was not applied.
 */
export function describeSpendWindowLimit(resolution: SpendWindowLimitResolution): string | null {
  if (resolution.invalid === null) return null;
  return `spend window limit: ${resolution.invalid} — the ¥${DEFAULT_SPEND_WINDOW_LIMIT_CNY}/30 s default applies for this connection (set a positive number, or nothing at all)`;
}
