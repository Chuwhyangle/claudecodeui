/**
 * The uncertain-pause backchannel (GOAL-047 / AC-407): ONE「嗯」-level receipt at the ambiguous edge of a
 * pause, in exchange for a LONGER silence window, so the person finishes the thought instead of the
 * detector cutting them off mid-sentence.
 *
 * THE PREREQUISITE, AND WHICH ARM THIS FILE PINS. The task's first step was to verify whether
 * `semantic_vad` can observe the intermediate "the user may not be finished" state. It cannot, on this
 * endpoint: the wire's whole server-VAD surface is `speech_started` / `speech_stopped` / `committed`
 * (`voice-realtime-bridge.service.ts`, `TOLERATED_ENDPOINT_EVENTS`, enumerated from the preserved live
 * capture), and the C-1 calibration (`docs/operations/voice-realtime-continuous-calibration.md`) shows
 * `semantic_vad` deciding LATER — `speech_started` at 11673 ms with `speech_stopped` 2 ms behind it — not
 * narrating an in-flight uncertain state. The task explicitly allows this outcome and names the fallback:
 * PAUSE DETECTION + a proactive `response.create`. That fallback is what
 * `voice-realtime-turn-detection.ts` encodes, and {@link SEMANTIC_VAD_EXPOSES_UNCERTAIN_PAUSE} records the
 * verdict so a later re-verification has to flip it deliberately rather than assume it.
 *
 * WHAT THIS FILE PINS, and why each reading is the one that matters:
 *
 *   · the receipt is ONE character and the window it buys is LONGER than the configured one — the two
 *     halves of the trade the task describes; a receipt with no extra room changes nothing, and extra
 *     room with no receipt is a different mechanism;
 *   · "继续说比例" RISES across a corpus of pauses — measured by replaying each episode's own resume time
 *     against the window the policy actually returns, with the gain ATTRIBUTED to the uncertain episodes
 *     only (word gaps and finished turns must read the same under both arms);
 *   · NOT EVERY PAUSE — a word gap and a finished turn both get silence, and one utterance carries at most
 *     one receipt (the cost constraint: every receipt is a full-context response);
 *   · THE FALSE FORM. A mutated copy of the shipping module that acknowledges every pause must redden the
 *     same criterion. A criterion nobody has watched fail is a criterion that might be green for the
 *     wrong reason.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json \
 *       --import ./scripts/undici-blocked-ports-preload.mjs --test \
 *       server/modules/voice-realtime/tests/voice-realtime-backchannel.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BACKCHANNEL_EXTENSION_FACTOR,
  BACKCHANNEL_MAX_PER_UTTERANCE,
  BACKCHANNEL_TEXT,
  BACKCHANNEL_TRIGGER_RATIO,
  DEFAULT_TURN_DETECTION,
  SEMANTIC_VAD_EXPOSES_UNCERTAIN_PAUSE,
  SILENCE_DURATION_MS_RANGE,
  decideBackchannel,
  type BackchannelDecision,
} from '../voice-realtime-turn-detection.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The shipping policy module — the file the false form mutates. */
const SHIPPING_MODULE = path.resolve(HERE, '../voice-realtime-turn-detection.ts');
/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
const ownCopy = (label: string): string => path.resolve(HERE, `../${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** The window a deployment that configures nothing closes the turn on (read from the shipping constant). */
const DEFAULT_WINDOW = DEFAULT_TURN_DETECTION.silence_duration_ms;
/** Where the receipt fires for that window — derived exactly as the module derives it. */
const TRIGGER_MS = Math.round(DEFAULT_WINDOW * BACKCHANNEL_TRIGGER_RATIO);
/** The longer window the receipt buys for that window — derived exactly as the module derives it. */
const EXTENDED_WINDOW = Math.round(DEFAULT_WINDOW * BACKCHANNEL_EXTENSION_FACTOR);

/**
 * One pause episode, as a replay reading: how long the person had been silent when the decision was
 * taken, and when (if ever) they resumed the same thought, measured from the start of the pause.
 *
 * `resumedAfterMs === null` means the turn was genuinely finished. The fixture is shaped so the three
 * kinds of pause are separable: an uncertain pause resumes PAST the configured window (so the baseline
 * cuts it and the longer window keeps it), a word gap resumes well inside both, and a finished turn never
 * resumes.
 */
type Episode = { label: string; silenceMs: number; resumedAfterMs: number | null };

const CORPUS: readonly Episode[] = [
  // The uncertain edge: a considered pause, resumed 1.2 s in — the baseline's 800 ms window has already
  // cut the turn, while the receipt's 2000 ms window is still open.
  { label: 'uncertain-1', silenceMs: 700, resumedAfterMs: 1_200 },
  { label: 'uncertain-2', silenceMs: 750, resumedAfterMs: 1_100 },
  { label: 'uncertain-3', silenceMs: 800, resumedAfterMs: 1_500 },
  { label: 'uncertain-4', silenceMs: 900, resumedAfterMs: 1_800 },
  { label: 'uncertain-5', silenceMs: 1_600, resumedAfterMs: 1_900 },
  // Ordinary word gaps: the person is still mid-flow and resumes long before either window.
  { label: 'word-gap-1', silenceMs: 180, resumedAfterMs: 180 },
  { label: 'word-gap-2', silenceMs: 250, resumedAfterMs: 260 },
  { label: 'word-gap-3', silenceMs: 400, resumedAfterMs: 420 },
  // Finished turns: nobody resumes, so no window can turn these into continuations.
  { label: 'turn-end-1', silenceMs: 2_300, resumedAfterMs: null },
  { label: 'turn-end-2', silenceMs: 2_600, resumedAfterMs: null },
  { label: 'turn-end-3', silenceMs: 3_000, resumedAfterMs: null },
];

/** Whether the person got to continue the thought before `windowMs` closed the turn. */
function continued(episode: Episode, windowMs: number): boolean {
  return episode.resumedAfterMs !== null && episode.resumedAfterMs <= windowMs;
}

/** The continuation ratio over the corpus, for one window policy. */
function continuationRatio(windowOf: (episode: Episode) => number): number {
  return CORPUS.filter((episode) => continued(episode, windowOf(episode))).length / CORPUS.length;
}

/** The window the policy returns for one episode. */
function policyWindow(episode: Episode): number {
  return decideBackchannel({ silenceMs: episode.silenceMs }).silenceDurationMs;
}

type PolicyModule = {
  decideBackchannel: (
    observation: { silenceMs: number; acknowledged?: number },
    defaultSilenceMs?: number,
  ) => BackchannelDecision;
};

/** Loads a copy of the policy module from a file URL (used by the false form). */
async function importPolicy(file: string): Promise<PolicyModule> {
  return (await import(pathToFileURL(file).href)) as PolicyModule;
}

// ── the prerequisite verdict and the arm it selects ──────────────────────────────────────────

test('prerequisite: semantic_vad exposes no uncertain state, so the pause-detection fallback is the shipped arm', () => {
  // This is a recorded READING (see the file header and the module's own header), not a preference. If a
  // future endpoint exposes a real uncertain-state event, this flips with a measured reading beside it.
  assert.equal(
    SEMANTIC_VAD_EXPOSES_UNCERTAIN_PAUSE,
    false,
    'semantic_vad cannot be treated as an uncertain-state source until a measurement says otherwise',
  );
  // The arm that actually ships infers the state from the relay's own measured silence — the only signal
  // the endpoint's event surface offers.
  const decision = decideBackchannel({ silenceMs: TRIGGER_MS });
  assert.equal(decision.kind, 'uncertain-pause', 'the decision must be taken from the measured pause, not from a semantic event');
});

// ── AC-407: one「嗯」at the uncertain edge, in exchange for a longer window ─────────────────────

test('uncertain pause: one「嗯」-level receipt and a longer silence window', () => {
  const decision = decideBackchannel({ silenceMs: TRIGGER_MS });

  assert.equal(decision.emit, true, 'the uncertain edge is exactly where the receipt fires');
  assert.equal(decision.kind, 'uncertain-pause');
  assert.equal(decision.text, BACKCHANNEL_TEXT);
  assert.equal([...BACKCHANNEL_TEXT].length, 1, 'the receipt must be ONE character — each one is a full-context response');

  assert.ok(
    decision.silenceDurationMs > DEFAULT_WINDOW,
    `the window must be LONGER than the ${DEFAULT_WINDOW} ms one that would have closed the turn (got ${decision.silenceDurationMs})`,
  );
  assert.equal(decision.silenceDurationMs, EXTENDED_WINDOW);

  // The whole band, not only its lower edge: every silence still inside it reads the same.
  for (const silenceMs of [TRIGGER_MS, 800, 1_200, EXTENDED_WINDOW - 1]) {
    const inside = decideBackchannel({ silenceMs });
    assert.equal(inside.emit, true, `${silenceMs} ms is inside the uncertain band`);
    assert.equal(inside.text, BACKCHANNEL_TEXT);
    assert.equal(inside.silenceDurationMs, EXTENDED_WINDOW);
  }
});

test('not every pause: a word gap and a finished turn both get silence and the configured window', () => {
  const wordGap = decideBackchannel({ silenceMs: TRIGGER_MS - 1 });
  assert.equal(wordGap.emit, false, 'a word gap is not an uncertain pause — speaking there interrupts mid-flow');
  assert.equal(wordGap.text, null);
  assert.equal(wordGap.kind, 'word-gap');
  assert.equal(wordGap.silenceDurationMs, DEFAULT_WINDOW, 'a word gap must leave the configured window alone');

  const turnEnd = decideBackchannel({ silenceMs: EXTENDED_WINDOW });
  assert.equal(turnEnd.emit, false, 'a finished turn must not be talked over');
  assert.equal(turnEnd.text, null);
  assert.equal(turnEnd.kind, 'turn-end');
  assert.equal(turnEnd.silenceDurationMs, DEFAULT_WINDOW, 'the turn is over — the detector closes it on the configured window');
});

test('frequency cap: one receipt per utterance, and the longer window stays for the rest of it', () => {
  const second = decideBackchannel({ silenceMs: 900, acknowledged: BACKCHANNEL_MAX_PER_UTTERANCE });
  assert.equal(second.emit, false, 'this utterance already got its receipt');
  assert.equal(second.text, null);
  assert.equal(second.kind, 'already-acknowledged');
  assert.equal(second.silenceDurationMs, EXTENDED_WINDOW, 'the room bought by the receipt is kept');

  // Not a fixed interval either: a further pause still says nothing.
  const third = decideBackchannel({ silenceMs: 1_200, acknowledged: BACKCHANNEL_MAX_PER_UTTERANCE + 4 });
  assert.equal(third.emit, false);
  assert.equal(third.text, null);
});

// ── AC-407: the continuing-speaking ratio rises, and the gain is the uncertain edge ───────────

test('continuing-speaking ratio rises, and only the uncertain pauses move', () => {
  const baseline = continuationRatio(() => DEFAULT_WINDOW);
  const policy = continuationRatio(policyWindow);

  assert.ok(
    policy > baseline,
    `the receipt + longer window must raise the ratio: baseline=${baseline.toFixed(3)} policy=${policy.toFixed(3)}`,
  );

  // ATTRIBUTION, not just a higher number: the gain must come from the uncertain pauses. A blanket window
  // increase that also stretched the word gaps and the finished turns would move the same total by a
  // different mechanism, and it is not what this AC describes.
  for (const episode of CORPUS) {
    const before = continued(episode, DEFAULT_WINDOW);
    const after = continued(episode, policyWindow(episode));
    if (episode.label.startsWith('uncertain-')) {
      assert.equal(before, false, `${episode.label}: the baseline window must cut this pause`);
      assert.equal(after, true, `${episode.label}: the longer window must keep the turn open`);
    } else {
      assert.equal(after, before, `${episode.label}: a non-uncertain pause must read the same under both arms`);
    }
  }
});

test('the receipt fires on the uncertain pauses and on no others', () => {
  const decided = CORPUS.map((episode) => ({ episode, decision: decideBackchannel({ silenceMs: episode.silenceMs }) }));
  const emitted = decided.filter((entry) => entry.decision.emit).map((entry) => entry.episode.label);
  const uncertain = CORPUS.filter((episode) => episode.label.startsWith('uncertain-')).map((episode) => episode.label);
  assert.deepEqual(emitted, uncertain, 'a receipt on any non-uncertain pause is the false behaviour this AC forbids');

  for (const { episode, decision } of decided) {
    assert.equal(decision.text, decision.emit ? BACKCHANNEL_TEXT : null, `${episode.label}: text and emit must agree`);
    if (decision.emit) {
      assert.equal([...decision.text!].length, 1, `${episode.label}: the receipt is one character`);
    }
  }
});

// ── the window stays a legal `session.update` value for every configuration ───────────────────

test('every decision returns an integer window inside the documented range, never shorter than the configured one', () => {
  const baseCandidates = [SILENCE_DURATION_MS_RANGE.min, 400, 800, 1_000, 2_000, SILENCE_DURATION_MS_RANGE.max];
  const silenceCandidates = [0, 100, 300, 600, 800, 1_200, 2_000, 4_500, SILENCE_DURATION_MS_RANGE.max];

  for (const base of baseCandidates) {
    for (const silenceMs of silenceCandidates) {
      const decision = decideBackchannel({ silenceMs }, base);
      assert.ok(Number.isInteger(decision.silenceDurationMs), `base=${base} silence=${silenceMs}: the window must be an integer`);
      assert.ok(
        decision.silenceDurationMs >= SILENCE_DURATION_MS_RANGE.min &&
          decision.silenceDurationMs <= SILENCE_DURATION_MS_RANGE.max,
        `base=${base} silence=${silenceMs}: ${decision.silenceDurationMs} is outside the documented range`,
      );
      assert.ok(
        decision.silenceDurationMs >= base,
        `base=${base} silence=${silenceMs}: the policy must not shorten a configured window below its own value`,
      );
    }
  }

  // A deployment already at the ceiling has no room to extend: the extension saturates instead of leaving
  // the range, and the decision still describes a usable state.
  const atCeiling = decideBackchannel({ silenceMs: 4_600 }, SILENCE_DURATION_MS_RANGE.max);
  assert.equal(atCeiling.emit, true);
  assert.equal(atCeiling.silenceDurationMs, SILENCE_DURATION_MS_RANGE.max);

  // Non-finite readings are total: they read as no silence, never as NaN on the wire.
  const odd = decideBackchannel({ silenceMs: Number.NaN });
  assert.equal(odd.emit, false);
  assert.equal(odd.kind, 'word-gap');
  assert.equal(odd.silenceDurationMs, DEFAULT_WINDOW);
});

// ── false form: acknowledging every pause must redden this criterion ──────────────────────────

test('false form: a policy that acknowledges EVERY pause reddens the criterion', async () => {
  const source = readFileSync(SHIPPING_MODULE, 'utf8');
  const ANCHOR = '  const { baseMs, fromMs, extendedMs } = backchannelWindow(defaultSilenceMs);';
  assert.equal(source.split(ANCHOR).length - 1, 1, 'the decision anchor must occur exactly once in the shipping module');

  // The mutation: every observation gets the receipt and the longer window, before any band or cap test.
  const MUTATION =
    '  if (observation.silenceMs >= 0) {\n' +
    '    return { emit: true, text: BACKCHANNEL_TEXT, silenceDurationMs: backchannelWindow(defaultSilenceMs).extendedMs, kind: \'uncertain-pause\' };\n' +
    '  }\n' +
    ANCHOR;

  const basePath = ownCopy('backchannel-base');
  const mutPath = ownCopy('backchannel-mut');
  try {
    writeFileSync(basePath, source, 'utf8');
    writeFileSync(mutPath, source.replace(ANCHOR, MUTATION), 'utf8');
    const base = await importPolicy(basePath);
    const mutant = await importPolicy(mutPath);

    // The AC-407 assertion, expressed as a predicate so the mutation's effect on IT is what is measured.
    const acHolds = (policy: PolicyModule): boolean => {
      try {
        const emitted = CORPUS.filter((episode) => policy.decideBackchannel({ silenceMs: episode.silenceMs }).emit).map(
          (episode) => episode.label,
        );
        const uncertain = CORPUS.filter((episode) => episode.label.startsWith('uncertain-')).map((episode) => episode.label);
        assert.deepEqual(emitted, uncertain);
        assert.equal(policy.decideBackchannel({ silenceMs: TRIGGER_MS - 1 }).emit, false);
        assert.equal(policy.decideBackchannel({ silenceMs: EXTENDED_WINDOW }).emit, false);
        return true;
      } catch {
        return false;
      }
    };

    assert.equal(acHolds(base), true, 'unmutated: the receipt is confined to the uncertain pauses');
    assert.equal(acHolds(mutant), false, 'acknowledging every pause must redden the criterion');
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
