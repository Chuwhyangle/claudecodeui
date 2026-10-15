/**
 * The upstream turn detector's parameters — its type, its threshold and the silence window that closes
 * an utterance — resolved as a PURE FUNCTION of the environment, a per-run override and the deployment's
 * settings file.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE HANDLER. Before this switch existed, the relay shipped a
 * HARD-CODED `turn_detection` (`server_vad`, threshold 0.5, silence 400 ms) with no way to change it,
 * per deployment or per diagnosis. That literal is a BEHAVIOURAL CHOICE — how aggressively the upstream
 * VAD cuts a person mid-thought — and a behavioural choice that cannot be stated, printed or varied is
 * one nobody can measure. Resolution is a pure function of its three arguments: nothing here reads
 * `process.env`, nothing here opens a file, nothing here logs, and nothing here touches a socket. The
 * composition root
 * (`server/index.ts`, `buildVoiceRealtimeSeams`) calls {@link resolveTurnDetection} at the ONE place the
 * seams are assembled, and the HTTP diagnosis route hands the SAME resolver a per-run override — so a
 * deployment that sets nothing gets the shipped default, and a criterion that sets nothing reads the
 * SAME default rather than a copy of it.
 *
 * WHY THE SHIPPED WINDOW IS 800 AND NOT 400. The switch landed as a WIRE-NEUTRAL refactor: with nothing
 * configured the resolution reproduced the `{ type: 'server_vad', threshold: 0.5, silence_duration_ms:
 * 400 }` the transport carried, so the frames a browser saw were unchanged. The 400 was then MEASURED
 * and moved. `experiments/voice-realtime-fragment-hold-probe/RESULTS.md` (2026-10-15; three real
 * recordings × four repeats, `silence_duration_ms` the only variable) read HALF the upstream turns
 * (−38…−53%) and — the symptom this task exists for — a fifth to two thirds fewer RESPONSES (one per
 * half-sentence), while the relayed content held (relay characters / ASR characters 0.87–1.02) at
 * 0.1–0.5 s of extra end-of-turn latency and roughly half the spend on the two worst-split recordings.
 * So the shipped value is a DATA-DRIVEN choice, and the transport's own fallback IS this same object
 * (`DEFAULT_SESSION_DEFAULTS.turn_detection`), so the two cannot drift apart.
 *
 * WHERE THE VALUE MAY COME FROM. Three sources, in this order: the per-run override the diagnosis route
 * hands in (highest), the environment ({@link VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV} and its
 * siblings), then the deployment's settings file
 * (`VOICE_REALTIME_SETTINGS_PATH` → JSON `turnDetection`, validated by {@link validateTurnDetection}),
 * then {@link DEFAULT_TURN_DETECTION}. The environment deliberately OUTRANKS the file: it is the
 * deployment's escape hatch, and an operator rolling a value back must not have to edit a file another
 * process may own.
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
 * the platform's own documented default is 800, and so is the shipped one.
 *
 * This variable OUTRANKS the settings file's `turnDetection.silence_duration_ms` and the shipped default
 * (see {@link resolveTurnDetection}): the file is where a tuned value ships, the environment is how a
 * deployment overrides it without editing anybody's file.
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
 * The SHIPPED default — `server_vad`, threshold 0.5, and the 800 ms window the fragment-hold probe
 * measured (see the file header). The `turn_detection` object the transport falls back to when a caller
 * passes no `sessionDefaults` IS this object, not a copy of it
 * (`voice-realtime-dashscope-transport.ts`, `DEFAULT_SESSION_DEFAULTS.turn_detection`), so the two can
 * never disagree. Frozen so a caller cannot mutate the shared default in place and make a later
 * resolution disagree with this one.
 */
export const DEFAULT_TURN_DETECTION: Readonly<TurnDetection> = Object.freeze({
  type: 'server_vad',
  threshold: 0.5,
  silence_duration_ms: 800,
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
 * The fields a deployment's SETTINGS FILE may name, already validated — the shape
 * `voice-realtime-settings.ts` hands {@link resolveTurnDetection}, and the shape
 * {@link validateTurnDetection} returns.
 *
 * Every field is optional, and an absent one simply is not a source: a file that names only
 * `silence_duration_ms` still leaves `type` and `threshold` to the environment or to the default.
 * The names are the WIRE's own (`silence_duration_ms`, not `silenceMs`) because this is what an
 * operator writes in the file, and the file must read like the `session.update` it becomes.
 */
export type TurnDetectionValues = {
  type?: TurnDetectionType;
  threshold?: number;
  silence_duration_ms?: number;
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

/**
 * The first of the three optional sources that names a value for one field: the per-run override, then
 * the environment, then the settings file. `undefined` means NO source named it, so the shipped default
 * stands — which is a different state from "a source named it and the value was refused" (see the
 * `accept*` functions below, which report the latter).
 */
function provided(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  override: unknown,
  file: unknown,
): unknown {
  if (override !== undefined) return override;
  const fromEnv = env[name];
  if (fromEnv !== undefined) return fromEnv;
  return file;
}

/**
 * Accepts one raw `type`, or reports why not and returns `null`.
 *
 * Shared by the environment/override path and {@link validateTurnDetection} on purpose: a settings file
 * naming `"off"` and an environment naming `"off"` are the SAME mistake, and they must be refused with
 * the same sentence rather than by two validators that drift.
 *
 * A value present but empty is refused too: "unset" means the source did not name it, so an exported
 * empty string is someone trying to blank the knob, not a deployment that said nothing.
 */
function acceptType(provided: unknown, problems: string[]): TurnDetectionType | null {
  if (typeof provided === 'string') {
    const value = provided.trim();
    if (isOffWord(value)) {
      problems.push(
        `type "${provided}" asks for no detector, which this knob cannot do (the segmented relay's \`session.turn_detection: null\` is the only door to that state)`,
      );
      return null;
    }
    if (value === 'server_vad' || value === 'semantic_vad') return value;
  }
  problems.push(`type ${JSON.stringify(provided)} is not a known detector type (server_vad or semantic_vad)`);
  return null;
}

/** Accepts one raw `silence_duration_ms` — an integer in the documented range — or reports why not. */
function acceptSilence(provided: unknown, problems: string[]): number | null {
  const parsed = typeof provided === 'number' ? provided : Number(String(provided).trim());
  if (!Number.isInteger(parsed) || parsed < SILENCE_DURATION_MS_RANGE.min || parsed > SILENCE_DURATION_MS_RANGE.max) {
    problems.push(
      `silence_duration_ms ${JSON.stringify(provided)} is not an integer in [${SILENCE_DURATION_MS_RANGE.min}, ${SILENCE_DURATION_MS_RANGE.max}]`,
    );
    return null;
  }
  return parsed;
}

/** Accepts one raw `threshold` — a finite number in the documented range — or reports why not. */
function acceptThreshold(provided: unknown, problems: string[]): number | null {
  const parsed = typeof provided === 'number' ? provided : Number(String(provided).trim());
  if (!Number.isFinite(parsed) || parsed < THRESHOLD_RANGE.min || parsed > THRESHOLD_RANGE.max) {
    problems.push(`threshold ${JSON.stringify(provided)} is not a number in [${THRESHOLD_RANGE.min}, ${THRESHOLD_RANGE.max}]`);
    return null;
  }
  return parsed;
}

/** Resolves `type` from the first source that names it, falling back to the default on absence or refusal. */
function resolveType(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride,
  file: TurnDetectionValues,
  problems: string[],
): TurnDetectionType {
  const raw = provided(env, VOICE_REALTIME_TURN_DETECTION_ENV, override.type, file.type);
  if (raw === undefined) return DEFAULT_TURN_DETECTION.type;
  return acceptType(raw, problems) ?? DEFAULT_TURN_DETECTION.type;
}

/** Resolves `silence_duration_ms` from the first source that names it, falling back on absence or refusal. */
function resolveSilence(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride,
  file: TurnDetectionValues,
  problems: string[],
): number {
  const raw = provided(env, VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV, override.silenceMs, file.silence_duration_ms);
  if (raw === undefined) return DEFAULT_TURN_DETECTION.silence_duration_ms;
  return acceptSilence(raw, problems) ?? DEFAULT_TURN_DETECTION.silence_duration_ms;
}

/** Resolves `threshold` from the first source that names it, falling back on absence or refusal. */
function resolveThreshold(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride,
  file: TurnDetectionValues,
  problems: string[],
): number {
  const raw = provided(env, VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV, override.threshold, file.threshold);
  if (raw === undefined) return DEFAULT_TURN_DETECTION.threshold;
  return acceptThreshold(raw, problems) ?? DEFAULT_TURN_DETECTION.threshold;
}

/**
 * Validates the `turnDetection` object a SETTINGS FILE carries — an untrusted `unknown` straight out of
 * `JSON.parse` — into the fields that were accepted, plus a readable reason for every one that was
 * refused.
 *
 * WHY THIS IS NOT RE-DONE INSIDE {@link resolveTurnDetection}. The loader has to report a bad file value
 * through `VoiceRealtimeSettings.problems`, which is the list a deployment reads in its log; the
 * resolver reports through `invalid`. Both must apply the SAME rules, so both call the `accept*`
 * functions above rather than each carrying its own copy of the ranges.
 *
 * Absence is not a problem: a file with no `turnDetection` at all — or one naming only part of it —
 * yields `{}` and no problems, and the fields it left out fall through to the environment or the
 * shipped default. Only a value that was PRESENT and refused produces a problem. Keys this function
 * does not know are ignored, the same way the loader ignores unknown top-level keys.
 */
export function validateTurnDetection(raw: unknown): { values: TurnDetectionValues; problems: string[] } {
  const problems: string[] = [];
  const values: TurnDetectionValues = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`\`turnDetection\` must be a JSON object (got ${Array.isArray(raw) ? 'an array' : typeof raw})`);
    return { values, problems };
  }
  const record = raw as Record<string, unknown>;
  if (record.type !== undefined) {
    const accepted = acceptType(record.type, problems);
    if (accepted !== null) values.type = accepted;
  }
  if (record.threshold !== undefined) {
    const accepted = acceptThreshold(record.threshold, problems);
    if (accepted !== null) values.threshold = accepted;
  }
  if (record.silence_duration_ms !== undefined) {
    const accepted = acceptSilence(record.silence_duration_ms, problems);
    if (accepted !== null) values.silence_duration_ms = accepted;
  }
  return { values, problems };
}

/**
 * Resolves the turn detector for one deployment (and, optionally, one diagnosis run) from three
 * optional sources it is handed.
 *
 * ⛔ PRECEDENCE, FIELD BY FIELD: OVERRIDE > ENVIRONMENT > SETTINGS FILE > SHIPPED DEFAULT. The order is
 * not an accident and must not be flipped:
 *
 *   · the OVERRIDE (the diagnosis route's request body) is the most specific — one observed run;
 *   · then the ENVIRONMENT, which is the deployment operator's escape hatch: a value rolled back by hand
 *     must win over a file another process may have written, and must not require editing that file;
 *   · then the SETTINGS FILE (`{@link TurnDetectionValues}`, the deployment's tuned value, already
 *     validated by {@link validateTurnDetection} so a refusal was reported through that loader's
 *     `problems`);
 *   · then {@link DEFAULT_TURN_DETECTION}, the shipped 800 ms window.
 *
 * Each field is resolved independently, so a run may override ONLY the silence window and inherit the
 * rest, and a file that names only `silence_duration_ms` still takes `type`/`threshold` from the
 * environment or the default.
 *
 * Pure and total: every input yields a usable `turn_detection`. Every refused value is collected into
 * `invalid`, and the field it named falls back to the shipped default — the resolution is never `null`
 * and never a partial object.
 */
export function resolveTurnDetection(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride = {},
  file: TurnDetectionValues = {},
): TurnDetectionResolution {
  const problems: string[] = [];
  const type = resolveType(env, override, file, problems);
  const threshold = resolveThreshold(env, override, file, problems);
  const silenceDurationMs = resolveSilence(env, override, file, problems);
  return {
    turnDetection: { type, threshold, silence_duration_ms: silenceDurationMs },
    invalid: problems.length === 0 ? null : problems.join('; '),
  };
}

/**
 * Where the resolved `silence_duration_ms` came from, as the phrase the log line carries — the ONE thing
 * a reader needs beside the number itself, because "800" means something different depending on whether
 * the deployment shipped it, tuned it in a file, or exported it for one run.
 *
 * Mirrors {@link resolveTurnDetection}'s precedence exactly (override → environment → file → default) and
 * lives beside it so the two cannot drift. A caller that knows of a source the resolver does not — the
 * proxy's per-connection `seams.uplinkVad.silenceDurationMs`, which is applied AFTER the resolution —
 * says so itself rather than asking this function to guess.
 */
export function describeSilenceDurationSource(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride = {},
  file: TurnDetectionValues = {},
): string {
  if (override.silenceMs !== undefined) return 'the run override';
  if (env[VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV] !== undefined) return 'the environment';
  if (file.silence_duration_ms !== undefined) return 'the settings file';
  return 'the shipped default';
}

/**
 * The line to log for one resolution.
 *
 * WITHOUT `origin` this is the historical contract: the refusal sentence when there is something to
 * report, and `null` when the resolution is clean, so a deployment that configured nothing reads no line
 * about a detector it never asked about. WITH `origin` — the phrase
 * {@link describeSilenceDurationSource} returns, or a caller's own for a source the resolver cannot see
 * — it ALWAYS returns a line, naming the resolved values and where the silence window came from. That is
 * the form a caller logs when the question is not "was this refused?" but "what is this connection
 * actually using, and who set it?".
 *
 * Kept here so every caller says the SAME thing about the same resolution rather than hand-writing
 * sentences that drift. Callers pass their own sink.
 */
export function describeTurnDetection(resolution: TurnDetectionResolution, origin?: string): string | null {
  const { type, threshold, silence_duration_ms: silence } = resolution.turnDetection;
  const values = `${type}/${threshold}/${silence}ms`;
  if (resolution.invalid !== null) {
    return `turn detection: ${resolution.invalid} — using the default (${values})`;
  }
  if (origin === undefined) return null;
  return `turn detection: ${values} — silence from ${origin}`;
}
