/**
 * The upstream turn detector's parameters — its type, its threshold and the silence window that closes
 * an utterance — resolved as a PURE FUNCTION of the environment.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE HANDLER. Before this switch existed, the relay shipped a
 * HARD-CODED `turn_detection` (`server_vad`, threshold 0.5, silence 400 ms) with no way to change it,
 * per deployment or per diagnosis. That literal is a BEHAVIOURAL CHOICE — how aggressively the upstream
 * VAD cuts a person mid-thought — and a behavioural choice that cannot be stated, printed or varied is
 * one nobody can measure. Resolution is a pure function of the environment: nothing here reads
 * `process.env`, nothing here logs, and nothing here touches a socket. The composition root
 * (`server/index.ts`, `buildVoiceRealtimeSeams`) calls {@link resolveTurnDetection} at the ONE place the
 * seams are assembled, and the HTTP diagnosis route hands the SAME resolver a per-run override — so a
 * deployment that sets nothing gets the shipped default, and a criterion that sets nothing reads the
 * SAME default rather than a copy of it.
 *
 * WHY THE DEFAULT IS BYTE-IDENTICAL TO THE OLD LITERAL. The switch is a WIRE-NEUTRAL refactor first and
 * a new capability second: with no environment and no override the resolution must reproduce the exact
 * `{ type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 }` the transport carried, so the
 * frames a browser sees are unchanged (AC5). Changing the shipped value is a separate, DATA-DRIVEN
 * decision — see `experiments/voice-realtime-turn-detection/RESULT.json`.
 *
 * WHY THE KNOB CANNOT TURN THE DETECTOR OFF. There is exactly ONE door to a session with no turn
 * detector: the segmented relay's `session.turn_detection: null`, which the bridge sends when the client
 * takes over the utterance boundaries. If this new knob could ALSO null the detector, a deployment
 * could disable it by a totally different route (a typo, a stray env var) and break the segmented path's
 * assumption that it is the only writer. So an "off"-shaped value is REFUSED and reported through
 * `invalid` (AC6) — never silently applied.
 *
 * WHY A MISCONFIGURATION IS REPORTED RATHER THAN OBEYED. The `invalid` field carries a readable
 * description of every value that was refused, and {@link describeTurnDetection} turns the resolution
 * into the ONE sentence the composition root logs. A silently-ignored
 * `VOICE_REALTIME_TURN_DETECTION=off` would look exactly like a working rollback while the detector was
 * still cutting utterances, so an unknown spelling resolves to the default AND is SAID OUT LOUD.
 */

/**
 * The environment variable that selects the detector `type`.
 *
 * `server_vad` (the default) or `semantic_vad`. Unset means the default. Any other value — including
 * the "off"-shaped spellings (`off`, `none`, `null`, `false`, …) — is a misconfiguration and is reported
 * (see {@link describeTurnDetection}) rather than obeyed.
 */
export const VOICE_REALTIME_TURN_DETECTION_ENV = 'VOICE_REALTIME_TURN_DETECTION';

/**
 * The environment variable that sets the server VAD's `silence_duration_ms` — how long the upstream
 * waits after speech stops before it decides the utterance is over. Integers in `[200, 6000]` only;
 * the platform's own documented default is 800, and the shipped default is 400.
 */
export const VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV = 'VOICE_REALTIME_TURN_DETECTION_SILENCE_MS';

/** The environment variable that sets the detector `threshold`. Numbers in `[-1.0, 1.0]` only. */
export const VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV = 'VOICE_REALTIME_TURN_DETECTION_THRESHOLD';

/** The detector types the endpoint accepts (Aliyun Bailian realtime, `qwen3.8-omni-flash-realtime`). */
export type TurnDetectionType = 'server_vad' | 'semantic_vad';

/** The `turn_detection` object the wire's `session.update` carries. */
export type TurnDetection = {
  type: TurnDetectionType;
  threshold: number;
  silence_duration_ms: number;
};

/**
 * The SHIPPED default, byte-identical to the literal the transport carried before this switch existed
 * (`voice-realtime-dashscope-transport.ts`, `DEFAULT_SESSION_DEFAULTS.turn_detection`). Frozen so a
 * caller cannot mutate the shared default in place and make a later resolution disagree with this one.
 */
export const DEFAULT_TURN_DETECTION: Readonly<TurnDetection> = Object.freeze({
  type: 'server_vad',
  threshold: 0.5,
  silence_duration_ms: 400,
});

/** The documented valid range for `silence_duration_ms`. */
export const SILENCE_DURATION_MS_RANGE = Object.freeze({ min: 200, max: 6_000 });

/** The documented valid range for `threshold`. */
export const THRESHOLD_RANGE = Object.freeze({ min: -1, max: 1 });

/**
 * A per-run override, as the diagnosis route's request body carries it. Every field is optional and
 * UNTRUSTED (it arrives as JSON), so it is typed `unknown` and validated by {@link resolveTurnDetection}
 * with the SAME rules as the environment — an out-of-range value falls back to the default and is
 * reported, never applied.
 */
export type TurnDetectionOverride = {
  type?: unknown;
  silenceMs?: unknown;
  threshold?: unknown;
};

/**
 * One resolution. `invalid` is a readable description of everything that was refused, and `null` when
 * every provided value was valid — so a caller can log the misconfiguration without re-reading the
 * environment, and the resolution still carries the parameters that will actually be used.
 */
export type TurnDetectionResolution = {
  turnDetection: TurnDetection;
  invalid: string | null;
};

/**
 * Spellings that ask for "no detector". Refused, because the segmented relay's `session.turn_detection:
 * null` is the ONLY door to that state (see the file header) — and because a value that means "off" must
 * never be silently indistinguishable from a working configuration.
 */
const OFF_WORDS: ReadonlySet<string> = new Set([
  'off',
  'none',
  'null',
  'nil',
  'false',
  'no',
  'disabled',
  'disable',
  'nothing',
]);

/** True when a string spells "off" (case- and whitespace-insensitive). */
function isOffWord(value: string): boolean {
  return OFF_WORDS.has(value.trim().toLowerCase());
}

/** Reads a string-valued raw input from an override or the environment, or `undefined` when absent. */
function rawString(env: Readonly<Record<string, string | undefined>>, name: string, override: unknown): unknown {
  return override !== undefined ? override : env[name];
}

/**
 * Resolves the `type`, refusing every "off"-shaped value and every unknown spelling.
 *
 * A value present but empty is refused too: AC1's "unset" means the variable is ABSENT, so an exported
 * empty string is someone trying to blank the knob, not a deployment that said nothing.
 */
function resolveType(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride,
  problems: string[],
): TurnDetectionType {
  const provided = rawString(env, VOICE_REALTIME_TURN_DETECTION_ENV, override.type);
  if (provided === undefined) return DEFAULT_TURN_DETECTION.type;
  if (typeof provided === 'string') {
    const value = provided.trim();
    if (isOffWord(value)) {
      problems.push(
        `type "${provided}" asks for no detector, which this knob cannot do (the segmented relay's \`session.turn_detection: null\` is the only door to that state)`,
      );
      return DEFAULT_TURN_DETECTION.type;
    }
    if (value === 'server_vad' || value === 'semantic_vad') return value;
  }
  problems.push(`type ${JSON.stringify(provided)} is not a known detector type (server_vad or semantic_vad)`);
  return DEFAULT_TURN_DETECTION.type;
}

/** Resolves `silence_duration_ms`, accepting only integers in the documented range. */
function resolveSilence(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride,
  problems: string[],
): number {
  const provided = rawString(env, VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV, override.silenceMs);
  if (provided === undefined) return DEFAULT_TURN_DETECTION.silence_duration_ms;
  const parsed = typeof provided === 'number' ? provided : Number(String(provided).trim());
  if (!Number.isInteger(parsed) || parsed < SILENCE_DURATION_MS_RANGE.min || parsed > SILENCE_DURATION_MS_RANGE.max) {
    problems.push(
      `silence_duration_ms ${JSON.stringify(provided)} is not an integer in [${SILENCE_DURATION_MS_RANGE.min}, ${SILENCE_DURATION_MS_RANGE.max}]`,
    );
    return DEFAULT_TURN_DETECTION.silence_duration_ms;
  }
  return parsed;
}

/** Resolves `threshold`, accepting only finite numbers in the documented range. */
function resolveThreshold(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride,
  problems: string[],
): number {
  const provided = rawString(env, VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV, override.threshold);
  if (provided === undefined) return DEFAULT_TURN_DETECTION.threshold;
  const parsed = typeof provided === 'number' ? provided : Number(String(provided).trim());
  if (!Number.isFinite(parsed) || parsed < THRESHOLD_RANGE.min || parsed > THRESHOLD_RANGE.max) {
    problems.push(`threshold ${JSON.stringify(provided)} is not a number in [${THRESHOLD_RANGE.min}, ${THRESHOLD_RANGE.max}]`);
    return DEFAULT_TURN_DETECTION.threshold;
  }
  return parsed;
}

/**
 * Resolves the turn detector for one deployment (and, optionally, one diagnosis run) from the
 * environment and an untrusted override it is handed.
 *
 * Pure and total: every input yields a usable `turn_detection`. Precedence is override field →
 * environment variable → shipped default, field by field, so a run may override ONLY the silence window
 * and inherit the rest. Every refused value is collected into `invalid`, and the field it named falls
 * back to the shipped default — the resolution is never `null` and never a partial object.
 */
export function resolveTurnDetection(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride = {},
): TurnDetectionResolution {
  const problems: string[] = [];
  const type = resolveType(env, override, problems);
  const threshold = resolveThreshold(env, override, problems);
  const silenceDurationMs = resolveSilence(env, override, problems);
  return {
    turnDetection: { type, threshold, silence_duration_ms: silenceDurationMs },
    invalid: problems.length === 0 ? null : problems.join('; '),
  };
}

/**
 * The line to log for one resolution, or `null` when there is nothing to report.
 *
 * Kept here so the composition root and any other caller say the SAME thing about the same
 * misconfiguration rather than two hand-written sentences that drift. Callers pass their own sink.
 */
export function describeTurnDetection(resolution: TurnDetectionResolution): string | null {
  if (resolution.invalid === null) return null;
  const { type, threshold, silence_duration_ms: silence } = resolution.turnDetection;
  return `turn detection: ${resolution.invalid} — using the default (${type}/${threshold}/${silence}ms)`;
}
