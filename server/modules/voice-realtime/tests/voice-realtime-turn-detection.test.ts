/**
 * The configurable turn detector (GOAL-037 / AC-325): the upstream silence window, detector type and
 * threshold, resolved as a pure function of the environment, LANDED ON THE ACTUAL `session.update`
 * frame, and refused at the one value that could break the segmented path — "off".
 *
 * WHAT THIS FILE PINS, and why each reading is the one that matters:
 *
 *   · AC1 — the resolution reaches the WIRE. Every case drives the REAL transport over the fake WS
 *     upstream and reads `turn_detection` out of the `session.update` frame the transport emitted, not
 *     out of the resolver's return value: a knob that resolves perfectly and never lands on a frame is
 *     exactly the bug this task exists to make impossible. The default case asserts the SHIPPED value
 *     (read from `DEFAULT_TURN_DETECTION`, not typed in here); the override cases assert a change
 *     lands; the invalid cases assert a refusal falls back to the default AND reports through `invalid`.
 *
 *   · AC5 — the default is LINE-NEUTRAL. With nothing configured the composed session body
 *     (`DEFAULT_SESSION_DEFAULTS` with the resolved detector spliced in) must be byte-for-byte the body
 *     the shipped literal produces — same values, same key order — compared as `JSON.stringify`. The
 *     literal below moved 400 → 800 with the shipped window (2026-10-15, the fragment-hold task), which
 *     is exactly the edit this leg makes visible: a default changed in the resolver but not here reds it.
 *
 *   · AC6 — the knob CANNOT turn the detector off. There is one door to a session with no detector (the
 *     segmented relay's `session.turn_detection: null`); every "off"-shaped value the new knob could be
 *     given is refused and reported, and the frame keeps the detector. A parser that silently applied
 *     `null` would break that assumption, so it is pinned as a red, not a claim.
 *
 * WHY THE FALSE FORMS COPY THE MODULE BESIDE IT. The last two blocks write mutated copies of the
 * shipping `voice-realtime-turn-detection.ts` (`__criterion-falsify-<label>-<pid>.ts`, excluded from
 * `server/tsconfig.json` BY NAME, removed in a `finally`) — one with the shipped default changed, one
 * that accepts "off" as a null detector — and assert the AC5 / AC6 assertions above go red on them.
 * A criterion nobody has watched fail is a criterion that might be green for the wrong reason.
 *
 * THE COMPOSITION IS THE ASSEMBLY POINT'S. `server/index.ts` cannot be imported by a test (it calls
 * `startServer()` at module scope), so the wiring that composes these defaults is pinned as SOURCE TEXT
 * of the seams builder, and the body these tests compose by hand is the same shape that wiring builds.
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers resolving to `.ts`):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-turn-detection.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_SESSION_DEFAULTS,
  DEFAULT_TURN_DETECTION,
  VOICE_REALTIME_TURN_DETECTION_ENV,
  VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV,
  VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV,
  connect,
  createDashscopeTransport,
  describeTurnDetection,
  resolveTurnDetection,
  toDashscopeFrames,
  type RealtimeToolExecutor,
  type TurnDetection,
  type TurnDetectionOverride,
  type TurnDetectionResolution,
} from '../index.js';

import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';
import { waitFor } from './realtime-bridge-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The shipping resolver module — the file the false forms mutate. */
const SHIPPING_MODULE = path.resolve(HERE, '../voice-realtime-turn-detection.ts');
/** The composition root whose wiring is pinned as source text. */
const SERVER_INDEX = path.resolve(HERE, '../../../index.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
const ownCopy = (label: string): string => path.resolve(HERE, `../${TEMP_PREFIX}${label}-${process.pid}.ts`);

/**
 * The exact byte string the shipped default produces on the wire (key order included).
 *
 * `interrupt_response:false` is appended by the transport's composer on EVERY `session.update`
 * (GOAL-046), so it is part of the shipped wire bytes whether or not the resolver names it.
 */
const DEFAULT_WIRE = '{"type":"server_vad","threshold":0.5,"silence_duration_ms":800,"interrupt_response":false}';
/** The shipped detector as it reaches the wire: the resolver's default plus the composer's field. */
const DEFAULT_ON_WIRE = { ...DEFAULT_TURN_DETECTION, interrupt_response: false };

/** Picks the client frames of one wire `type`. */
function sentOfType(sent: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
  return sent.filter((frame) => frame.type === type);
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Drives the REAL transport over the fake upstream with the composed session defaults and returns both
 * the resolution and the session body the transport actually put on the wire — the frame a browser
 * would see, not a re-derivation from the resolver.
 */
async function wireTurnDetection(
  env: Readonly<Record<string, string | undefined>>,
  override: TurnDetectionOverride = {},
): Promise<{ resolution: TurnDetectionResolution; session: Record<string, unknown> }> {
  const resolution = resolveTurnDetection(env, override);
  const server = createFakeDashscopeServer();
  const transport = createDashscopeTransport({
    apiKey: 'sk-test',
    socketFactory: server.socketFactory,
    onError: () => {},
    // The composition the assembly point performs: the transport's own defaults with only the resolved
    // detector spliced in.
    sessionDefaults: { ...DEFAULT_SESSION_DEFAULTS, turn_detection: resolution.turnDetection },
  });
  const bridge = connect(transport, [], {} as RealtimeToolExecutor, {});
  try {
    await bridge.whenConnected();
    bridge.sendSessionUpdate('be brief');
    await waitFor(() => sentOfType(server.sent, 'session.update').length > 0);
    const frame = sentOfType(server.sent, 'session.update')[0]!;
    return { resolution, session: frame.session as Record<string, unknown> };
  } finally {
    await bridge.close();
  }
}

type ParserModule = {
  DEFAULT_TURN_DETECTION: TurnDetection;
  resolveTurnDetection: (
    env: Readonly<Record<string, string | undefined>>,
    override?: TurnDetectionOverride,
  ) => TurnDetectionResolution;
};

/** Loads a copy of the resolver module from a file URL (used by the false forms). */
async function importParser(file: string): Promise<ParserModule> {
  return (await import(pathToFileURL(file).href)) as ParserModule;
}

// ── AC1: the resolution lands on the actual frame ─────────────────────────────────────────────

test('AC1 default: with nothing configured the wire carries the exact shipped detector', async () => {
  const { resolution, session } = await wireTurnDetection({});
  assert.equal(resolution.invalid, null, 'an unset environment must not be reported as invalid');
  // The default is READ from the shipping constant, not typed in here.
  assert.deepEqual(session.turn_detection, DEFAULT_ON_WIRE);
  assert.equal(JSON.stringify(session.turn_detection), DEFAULT_WIRE, 'the wire bytes must be unchanged');
});

test('AC1 env: a valid type / silence window / threshold land on the actual frame', async () => {
  const { resolution, session } = await wireTurnDetection({
    [VOICE_REALTIME_TURN_DETECTION_ENV]: 'semantic_vad',
    [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '800',
    [VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV]: '0.7',
  });
  assert.equal(resolution.invalid, null);
  assert.deepEqual(session.turn_detection, { type: 'semantic_vad', threshold: 0.7, silence_duration_ms: 800, interrupt_response: false });
});

test('AC1 override: a per-run override wins over the environment, field by field', async () => {
  const { session } = await wireTurnDetection(
    { [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '600' },
    { silenceMs: 900, type: 'semantic_vad' },
  );
  // threshold is neither overridden nor in the environment, so it keeps the shipped default.
  assert.deepEqual(session.turn_detection, { type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 900, interrupt_response: false });
});

test('AC1 invalid: an out-of-range or unknown value falls back to the default AND is reported', async () => {
  const cases: Array<{ label: string; env: Record<string, string>; override: TurnDetectionOverride }> = [
    { label: 'unknown type', env: { [VOICE_REALTIME_TURN_DETECTION_ENV]: 'banana' }, override: {} },
    { label: 'silence below range', env: { [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '10' }, override: {} },
    { label: 'silence above range', env: { [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '99999' }, override: {} },
    { label: 'silence not an integer', env: { [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '400.5' }, override: {} },
    { label: 'threshold out of range', env: { [VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV]: '2' }, override: {} },
    { label: 'override below range', env: {}, override: { silenceMs: -5 } },
  ];
  for (const { label, env, override } of cases) {
    const { resolution, session } = await wireTurnDetection(env, override);
    assert.notEqual(resolution.invalid, null, `${label}: a refused value must be reported`);
    assert.deepEqual(session.turn_detection, DEFAULT_ON_WIRE, `${label}: must fall back to the shipped default`);
    assert.match(describeTurnDetection(resolution) ?? '', /using the default/, `${label}: the log line must say so`);
  }
});

// ── AC5: the default is line-neutral ─────────────────────────────────────────────────────────

test('AC5 line-neutral: the composed default session body is byte-identical to the shipped literal', () => {
  const composed = { ...DEFAULT_SESSION_DEFAULTS, turn_detection: resolveTurnDetection({}).turnDetection };
  const frames = toDashscopeFrames({ type: 'session.update', session: { instructions: 'be brief', tools: [] } }, composed);
  assert.equal(frames.length, 1);
  const session = (frames[0] as { session: Record<string, unknown> }).session;
  // Stringify compares VALUES AND KEY ORDER — the whole body, not just the detector.
  assert.equal(
    JSON.stringify(session),
    JSON.stringify({
      modalities: ['text'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm24',
      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800, interrupt_response: false },
      voice: 'Tina',
      instructions: 'be brief',
    }),
  );
});

// ── AC6: the knob cannot turn the detector off (negative control) ──────────────────────────────

test('AC6 negative control: every "off"-shaped value is refused and the frame keeps the detector', async () => {
  for (const value of ['off', 'none', 'null', 'nil', 'false', 'disabled', 'nothing', '']) {
    const { resolution, session } = await wireTurnDetection({ [VOICE_REALTIME_TURN_DETECTION_ENV]: value });
    assert.notEqual(resolution.invalid, null, `"${value}" must be refused`);
    assert.equal(resolution.turnDetection.type, 'server_vad', `"${value}" must resolve to the default`);
    assert.notEqual(session.turn_detection, null, `"${value}" must not blank the detector on the wire`);
    assert.deepEqual(session.turn_detection, DEFAULT_ON_WIRE, `"${value}" must leave the shipped detector in place`);
  }
  // The override path cannot blank it either.
  const { resolution, session } = await wireTurnDetection({}, { type: null });
  assert.notEqual(resolution.invalid, null, 'a null override type must be refused');
  assert.deepEqual(session.turn_detection, DEFAULT_ON_WIRE);
});

// ── AC5 false form: a changed default must redden the line-neutral check ───────────────────────

test('AC5 false form: a mutated shipped default reddens the byte-identical check', async () => {
  const source = readFileSync(SHIPPING_MODULE, 'utf8');
  const ANCHOR = 'silence_duration_ms: 800,';
  assert.equal(countOccurrences(source, ANCHOR), 1, 'the default literal must occur exactly once');

  const basePath = ownCopy('turn-default-base');
  const mutPath = ownCopy('turn-default-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, source.replace(ANCHOR, 'silence_duration_ms: 900,'), 'utf8');
    const base = await importParser(basePath);
    const mutant = await importParser(mutPath);

    const wireOf = (mod: ParserModule): string => {
      const composed = { ...DEFAULT_SESSION_DEFAULTS, turn_detection: mod.resolveTurnDetection({}).turnDetection };
      const frame = toDashscopeFrames({ type: 'session.update', session: { instructions: 'x', tools: [] } }, composed)[0] as {
        session: Record<string, unknown>;
      };
      return JSON.stringify(frame.session.turn_detection);
    };

    assert.equal(wireOf(base), DEFAULT_WIRE, 'unmutated: the default is byte-identical');
    assert.notEqual(wireOf(mutant), DEFAULT_WIRE, 'a changed default must redden the check');
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── AC6 false form: a parser that accepts "off" must redden the negative control ───────────────

test('AC6 false form: a parser that accepts "off" as a null detector reddens the negative control', async () => {
  const source = readFileSync(SHIPPING_MODULE, 'utf8');
  const ANCHOR = '  return {\n    turnDetection: { type, threshold, silence_duration_ms: silenceDurationMs },';
  assert.equal(countOccurrences(source, ANCHOR), 1, 'the resolution return must occur exactly once');
  // The mutation: an "off"-shaped type short-circuits to a NULL detector instead of being refused.
  const MUTATION =
    "  if (isOffWord(String(provided(env, VOICE_REALTIME_TURN_DETECTION_ENV, override.type, file.type) ?? ''))) {\n" +
    '    return { turnDetection: null as unknown as TurnDetection, invalid: null };\n' +
    '  }\n' +
    ANCHOR;

  const basePath = ownCopy('turn-off-base');
  const mutPath = ownCopy('turn-off-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, source.replace(ANCHOR, MUTATION), 'utf8');
    const base = await importParser(basePath);
    const mutant = await importParser(mutPath);

    // The AC6 assertion, expressed as a predicate so the mutation's effect on IT is what is measured.
    const ac6Holds = (mod: ParserModule): boolean => {
      const resolution = mod.resolveTurnDetection({ [VOICE_REALTIME_TURN_DETECTION_ENV]: 'off' });
      try {
        assert.notEqual(resolution.invalid, null);
        assert.deepEqual(resolution.turnDetection, DEFAULT_TURN_DETECTION);
        return true;
      } catch {
        return false;
      }
    };

    assert.equal(ac6Holds(base), true, 'unmutated: "off" is refused and the default stands');
    assert.equal(ac6Holds(mutant), false, 'accepting "off" as null must redden the negative control');
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

test('the false forms leave none of this process`s copies behind', () => {
  const leftovers = readdirSync(path.resolve(HERE, '..')).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});

// ── wiring: the seams builder resolves per connection and lands it on sessionDefaults ───────────

test('wiring: the seams builder resolves the detector from env + override + the connection\'s settings and splices it in', () => {
  const source = readFileSync(SERVER_INDEX, 'utf8');
  assert.match(source, /from '\.\/modules\/voice-realtime\/index\.js'/, 'index.ts must reach the module through its barrel');
  // THREE SOURCES, not two: the proxy hands THIS connection's settings-file reading through the
  // seam. A two-argument call is the 2026-10-20 defect — the file's window reached the gate/log but
  // never the `session.update` (1500 ms in the log, 800 ms on the wire).
  assert.match(
    source,
    /resolveTurnDetection\(\s*process\.env,\s*input\.turnDetection,\s*settingsTurnDetection \?\? \{\},?\s*\)/,
    'the wire resolution must read env + the run override + the connection\'s settings-file reading',
  );
  assert.match(source, /describeTurnDetection\(turnDetection\)/, 'a misconfiguration must be described for the log');
  assert.match(
    source,
    /sessionDefaults:\s*\{\s*\.\.\.DEFAULT_SESSION_DEFAULTS,\s*turn_detection:\s*resolveTurnDetection\(\s*process\.env,\s*input\.turnDetection,\s*settingsTurnDetection \?\? \{\},?\s*\)\.turnDetection,?\s*\}/,
    'the per-connection resolved detector must be handed to the transport as sessionDefaults.turn_detection',
  );
  // The resolution sits INSIDE the seams builder — the ONE assembly point both the browser socket and
  // the diagnosis route share — not at module scope, where it would be read once at boot. It is
  // per connection because only the proxy reads that connection's settings file.
  const fnStart = source.indexOf('const buildVoiceRealtimeSeams');
  const fnEnd = source.indexOf('function resolveIdleRotateMs');
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'the seams builder must be findable in index.ts');
  const body = source.slice(fnStart, fnEnd);
  assert.match(
    body,
    /resolveTurnDetection\(\s*process\.env,\s*input\.turnDetection,\s*settingsTurnDetection \?\? \{\},?\s*\)/,
    'the per-connection resolution must sit in the seams builder',
  );
  assert.match(
    body,
    /turn_detection:\s*resolveTurnDetection\([\s\S]*?settingsTurnDetection \?\? \{\}[\s\S]*?\)\.turnDetection/,
    'the splice must sit in the seams builder',
  );
});
