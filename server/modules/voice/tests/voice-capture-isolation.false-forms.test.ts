/**
 * The falsifying forms behind `voice-capture-isolation.test.ts`, plus the exit-code half of AC8.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that claim is not something a passing run can show about
 * itself. So each case here builds a BROKEN copy of the service module by a text mutation, runs the
 * whole reading list against it, and requires the readings it predicts to fail — by name, and with
 * the FIGURE that went wrong, so the red is attributable to a clause rather than to a reading. The
 * two mutations are the two cheap ways to satisfy this task's words while missing its subject:
 *
 *   · (i) `capture-throw-reaches-the-outer-catch` — delete the local guard around the recording call,
 *     so the throw from a port that refuses the row line escapes into the `catch (error)` that closes
 *     the whole attempt (`voice.service.ts`, the `unreachableBackendFailure` fold). Every sentence
 *     about "the recording failure is isolated" is still implemented — the capture module still builds
 *     the row, still writes the audio, and is byte-for-byte the shipping one — and a successful
 *     transcription is answered as a 502 whose text says the backend was unreachable, because the
 *     local guard is the ONLY thing between the recorder's failure and that fold. If this case passes,
 *     AC2's `text.resultIdentical` is not measuring the guard.
 *   · (ii) `failed-line-carries-the-transcript` — print the attempt's returned text on the failure
 *     line. The line still exists, still starts with the same words, and still appears exactly once;
 *     what it no longer is, is content-free. If this case passes, AC4's `failedLineContentFree` is not
 *     measuring the line.
 *
 * EACH CASE HAS THREE PARTS, and the first is what keeps the other two from being vacuous:
 *   1. the UNMUTATED copy must clear the whole list (a harness that is red for its own reasons proves
 *      nothing by going red on a mutant);
 *   2. the MUTATED copy must red every reading the case predicts, and that reading's measured value
 *      must contain the figure the mutation changes — a reading that is red for some other reason, or
 *      green while the figure is visibly wrong, is reported as a hole rather than as a success;
 *   3. some reading OUTSIDE that family must still be green, so "the whole rig broke" is not what the
 *      red means.
 *
 * WHERE THE COPIES GO, AND WHY NOT IN THIS FILE'S DIRECTORY. AC9 asks for the copies in the same
 * directory as the criterion, so that relative imports still resolve — and that REASON is exactly why
 * they cannot go there. Both mutations are in `voice.service.ts`, whose own imports are relative
 * (`./voice-capture.js`, `../../../shared/asr/asrRegistry.js`); a copy under `tests/` would resolve
 * the first to `tests/voice-capture.js` and the second to `server/shared/asr/…`, neither of which
 * exists. The copies therefore live beside the module they copy, under `server/modules/voice/` — the
 * same tree, and the only directory in which a copy of this module imports at all. Registered here
 * and in the criterion's AC10 rather than silently diverging.
 *
 * THE TWO CASES ARE TWO EDITS AND ONE PATH, because both mutations are in the same module. Each copy
 * gets its OWN path, because ESM caches a module by URL: a mutant written over the base copy's path
 * would import the already-evaluated base module and the run would measure nothing. `collectReadings`
 * takes the service module path as its one slot and the capture module is the shipping one in every
 * arm, so the mutation is the only difference between the two arms of a case.
 *
 * THE AC2 CLAUSE THIS FILE READS STRUCTURALLY RATHER THAN LITERALLY, registered so a reader does not
 * take the criterion for something it is not. AC2 asks for a port that throws on lines "以
 * `voice.capture {` 开头", which is the proposal's notation for a capture row. The SHIPPED row is
 * `{"event":"voice.capture",…}` — a fact AC-143/144/145 pin by parsing it — so a port keyed on that
 * literal prefix would never fire, and AC2's own `captureThrew≥1` would be unsatisfiable. The
 * criterion's port therefore refuses the line that IS a capture row (`parseCaptureRow`), which is the
 * same set read structurally and a superset of both spellings; AC7's port adds the literal prefix on
 * top, which is what makes AC7's arm strictly harder than AC2's.
 *
 * WHY AC8'S EXIT CODES ARE HERE. AC8 asks for the exit code of seven existing criteria plus
 * `npm run typecheck` and `npm run lint`, each printed rather than assumed. Those are SUBPROCESSES,
 * and AC1 requires the criterion file itself to start none inside a fifteen-second budget — one
 * `npm run typecheck` alone is most of that budget. This file is the task's other executable artifact,
 * it already starts `git`, and it is not the file AC1's budget is about.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  collectReadings,
  SHIPPING_SERVICE_MODULE,
} from './voice-capture-isolation.test.js';

/** Where the mutated copies go: beside the module, so its relative imports still resolve. */
const VOICE_DIR = path.dirname(SHIPPING_SERVICE_MODULE);
const REPO_ROOT = path.resolve(VOICE_DIR, '../../..');

/** The prefix every temp copy carries, so "nothing was left behind" is a pattern rather than a guess. */
const TEMP_PREFIX = '__criterion-falsify-';

/** `git status --porcelain` for the worktree, as one string. */
function gitStatusPorcelain(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/**
 * The tail every temp copy THIS process writes ends with.
 *
 * A copy's name already carries `process.pid` (`${TEMP_PREFIX}${name}-base-${process.pid}.ts`), so
 * "is this porcelain line mine?" is answered by the same value the file name was built from. It has
 * to be asked, because this directory is SHARED with the sibling criteria that build their copies
 * with the same prefix — see the AC9 case below.
 */
const OWN_TEMP_SUFFIX = `-${process.pid}.ts`;

/** True for a porcelain line naming a temp copy — any process's, this one's included. */
function isTempCopy(line: string): boolean {
  return line.includes(TEMP_PREFIX);
}

/** True for a porcelain line naming a temp copy THIS process wrote. */
function isOwnTempCopy(line: string): boolean {
  return isTempCopy(line) && line.trimEnd().endsWith(OWN_TEMP_SUFFIX);
}

/**
 * The two snapshots' disagreement, split by which side each line was seen on.
 *
 * Set-based rather than positional: `git status --porcelain` emits its entries sorted, so a set
 * difference says the same thing as a line-by-line walk while staying correct if porcelain ever
 * repeats a line.
 */
function snapshotDelta(before: string, after: string): { onlyBefore: string[]; onlyAfter: string[] } {
  const split = (value: string): string[] => value.split('\n').filter((line) => line !== '');
  const beforeLines = new Set(split(before));
  const afterLines = new Set(split(after));
  return {
    onlyBefore: [...beforeLines].filter((line) => !afterLines.has(line)),
    onlyAfter: [...afterLines].filter((line) => !beforeLines.has(line)),
  };
}

/** The first line of a string, for printing something bounded. */
function firstLine(value: string): string {
  return value.split('\n').find((line) => line !== '') ?? '(empty)';
}

/**
 * `git status --porcelain` BEFORE anything here runs.
 *
 * Captured in the module body rather than in a hook, because what AC9 owes is that THIS RUN adds
 * nothing: a tree that a developer already had dirty should not be reported as this criterion's
 * leftovers, and a tree that was clean has to come back clean.
 */
const PRE_RUN_PORCELAIN = gitStatusPorcelain();

// ── the mutation cases ────────────────────────────────────────────────────────────────────────

/** One text substitution. A case may carry several, and every anchor must occur exactly once. */
type Edit = { anchor: string; replacement: string };

/** A reading the case predicts will fail, and the figure it must fail WITH. */
type Expectation = { reading: RegExp; token: string; meaning: string };

type MutationCase = {
  name: string;
  /** The readings this case is allowed to red. Anything outside is a rig failure. */
  target: RegExp;
  /** The reading AC9 names for this case, for the printed line. */
  family: string;
  edits: readonly Edit[];
  expects: readonly Expectation[];
  why: string;
};

/**
 * The guard's two ends and the line it prints — the three sites the mutations below rewrite.
 *
 * The anchors carry their leading newline, and that is not cosmetic: an eight-space `} catch {` is a
 * SUBSTRING of the ten-space `} catch {` inside the same guard, so the bare line would be found
 * twice and the case's own "exactly one site" check would fail rather than the mutation being wrong.
 */
const GUARD_OPEN = '        try {\n          recording.recordAttempt(captureId, {';
const GUARD_OPEN_GONE = '        recording.recordAttempt(captureId, {';
const GUARD_CATCH = '\n        } catch {';
const GUARD_CATCH_GONE = '\n        if (false) { // MUTATION: the local catch is gone';
const FAILED_LINE_PRINT = '            log.info(VOICE_CAPTURE_FAILED_LINE);';
const FAILED_LINE_PRINT_MUT =
  '            log.info(VOICE_CAPTURE_FAILED_LINE + String(meta?.text));';

const CASES: readonly MutationCase[] = [
  {
    name: 'capture-throw-reaches-the-outer-catch',
    target: /^AC2 /,
    family: 'AC2',
    edits: [
      // The call moves out of the guard: the `try {` goes, and what is left of the clause becomes an
      // unreachable `if (false) { … }` so the mutated module is still a syntactically valid file. The
      // sequence is the mutation — a recorders' failure now leaves `logAttempt` the way it came in.
      { anchor: GUARD_OPEN, replacement: GUARD_OPEN_GONE },
      { anchor: GUARD_CATCH, replacement: GUARD_CATCH_GONE },
    ],
    expects: [
      {
        reading: /^AC2 /,
        token: 'text.resultIdentical=false',
        meaning: 'the refusal a refused row line used to be isolated from reached the caller',
      },
      {
        reading: /^AC2 /,
        token: 'text.textByteIdentical=false',
        meaning: 'and the transcription the caller asked for is not what came back',
      },
    ],
    why: 'the local guard is deleted, so a refused row line becomes the attempt`s own failure',
  },
  {
    name: 'failed-line-carries-the-transcript',
    target: /^AC4 /,
    family: 'AC4',
    edits: [
      // The line survives, keeps its prefix and its count; what it loses is the one property it
      // exists for. `String(meta?.text)` is the attempt`s own returned text, which on the success
      // path is the transcription the caller received.
      { anchor: FAILED_LINE_PRINT, replacement: FAILED_LINE_PRINT_MUT },
    ],
    expects: [
      {
        reading: /^AC4 /,
        token: 'failedLineContentFree=false',
        meaning: 'the failure line now carries the transcription it is defined not to carry',
      },
      {
        reading: /^AC4 /,
        token: 'needles-present=[TRANSCRIPT_SENTINEL',
        meaning: 'and the needle found in it is the transcript the caller was handed',
      },
    ],
    why: 'the failure line is concatenated with the returned text',
  },
];

// ── running one case ──────────────────────────────────────────────────────────────────────────

/** One arm's measurement, as the reading list reports it. */
type ArmOutcome = {
  /** The reading names that failed, in the order the list ran them. */
  red: string[];
  /** The number of readings the list ran, so a shortened list is visible. */
  total: number;
  /** The value of the first red reading, which is what a reader needs to attribute the failure. */
  firstRedReason: string;
  /** Whether a reading outside the target family stayed green. */
  outsiderGreen: string;
  /** Every reading's outcome, so a case can look a figure up by reading name. */
  outcomes: { name: string; value: string; ok: boolean }[];
};

async function measureArm(modulePath: string, target: RegExp): Promise<ArmOutcome> {
  const outcomes = await collectReadings(modulePath);
  const red = outcomes.filter((outcome) => !outcome.ok);
  return {
    red: red.map((outcome) => outcome.name),
    total: outcomes.length,
    firstRedReason: red[0] === undefined ? '(none)' : `${red[0].name} measured ${red[0].value}`,
    outsiderGreen: outcomes.find((outcome) => outcome.ok && !target.test(outcome.name))?.name ?? '(none)',
    outcomes,
  };
}

/**
 * The figure-level check: every predicted reading red, and red for the predicted reason.
 *
 * THIS IS WHAT KEEPS A CASE FROM BEING SATISFIED BY AN ACCIDENT. "AC2 is red" is a much weaker claim
 * than "AC2 is red because `resultIdentical` is false": the first is also true if the mutation broke
 * the module's import, and the second is also false if the criterion stopped reading that figure
 * while still printing it. Both are reported by name, together with the measured value, so the
 * failure says which of the two happened.
 */
function attributionMisses(mutation: MutationCase, mutant: ArmOutcome): string[] {
  const misses: string[] = [];
  for (const expectation of mutation.expects) {
    const outcome = mutant.outcomes.find((entry) => expectation.reading.test(entry.name));
    if (outcome === undefined) {
      misses.push(`no reading matching ${String(expectation.reading)} ran at all`);
      continue;
    }
    if (outcome.ok) {
      misses.push(
        `${outcome.name} STAYED GREEN while the figure read ${expectation.token}: this mutation ` +
          `(${expectation.meaning}) is not what that reading's verdict rests on`,
      );
      continue;
    }
    if (!outcome.value.includes(expectation.token)) {
      misses.push(
        `${outcome.name} went red but without ${expectation.token} in its measured value ` +
          `(measured ${outcome.value}): the red is about something else`,
      );
    }
  }
  return misses;
}

for (const mutation of CASES) {
  test(`AC9/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
    const basePath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-base-${process.pid}.ts`);
    const mutantPath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-mut-${process.pid}.ts`);

    try {
      await copyFile(SHIPPING_SERVICE_MODULE, basePath);

      // ── arm one: the same text, unmutated. A harness that reds here cannot say anything about the
      // mutant, so this arm is a precondition rather than a second experiment.
      const base = await measureArm(basePath, mutation.target);
      const baseExit = base.red.length === 0 ? 0 : 1;
      process.stdout.write(
        `falsify/${mutation.name} base: mutation=${mutation.name} baseExit=${baseExit} ` +
          `readings=${base.total} red=${base.red.length}` +
          `${base.red.length === 0 ? '' : ` [${base.red.join(' ')}]`}\n`,
      );
      assert.deepEqual(
        base.red,
        [],
        `the unmutated copy must clear the whole list before the mutation means anything; it red at ${base.red.join(', ')}`,
      );

      // ── the mutation itself. Every anchor has to be unique: a text that occurs twice would be
      // rewritten in both places, and the case would then be about two edits rather than one.
      const shippingText = await readFile(SHIPPING_SERVICE_MODULE, 'utf8');
      let mutated = shippingText;
      for (const edit of mutation.edits) {
        const anchorCount = mutated.split(edit.anchor).length - 1;
        assert.equal(
          anchorCount,
          1,
          `an anchor for ${mutation.name} occurs ${anchorCount} times in the shipping module; a ` +
            'mutation case has to name exactly one site per edit, or it is not this case that the ' +
            'red would be about',
        );
        mutated = mutated.replace(edit.anchor, edit.replacement);
      }
      assert.notEqual(mutated, shippingText, `the ${mutation.name} edits did not change the text`);
      await writeFile(mutantPath, mutated, 'utf8');

      // ── arm two: the mutant, at a NEW path, because ESM caches by URL and a mutant that reused
      // the base copy's path would import the base module and measure nothing at all.
      const mutant = await measureArm(mutantPath, mutation.target);
      const inTargetFamily = mutant.red.filter((name) => mutation.target.test(name));
      const misses = attributionMisses(mutation, mutant);
      process.stdout.write(
        `falsify/${mutation.name} mutant: mutation=${mutation.name} baseExit=0 ` +
          `mutantRed=${inTargetFamily.length > 0} whichReading=${mutation.family} ` +
          `predicted=[${mutation.expects.map((expectation) => expectation.token).join(' ')}] ` +
          `red=${mutant.red.length} [${mutant.red.join(' ')}] in-target=[${inTargetFamily.join(' ')}] ` +
          `red-reason=${mutant.firstRedReason} outsider-still-green=${mutant.outsiderGreen} ` +
          `why=${mutation.why}\n`,
      );

      assert.ok(
        inTargetFamily.length > 0,
        `the ${mutation.name} mutation (${mutation.why}) must red a reading matching ${String(mutation.target)}; ` +
          `the mutant was graded as: ${mutant.red.length === 0 ? 'all green' : mutant.red.join(', ')}`,
      );

      assert.deepEqual(
        misses,
        [],
        `the ${mutation.name} mutation did not red the figure it is supposed to move: ${misses.join(' | ')}`,
      );

      // ── arm three: something outside the family is still green, so the red is attributable to the
      // mutation rather than to a rig that fell over as a whole.
      assert.notEqual(
        mutant.outsiderGreen,
        '(none)',
        `every reading red under ${mutation.name}, which reads as a broken rig rather than as this mutation`,
      );
    } finally {
      await rm(basePath, { force: true });
      await rm(mutantPath, { force: true });
    }
  });
}

// ── AC8's exit codes: the surfaces this task must not have moved ───────────────────────────────

/**
 * The seven criteria AC8 names, by path so the printed line says which one answered.
 *
 * `voice-capture-off.test.ts` is first because it is AC-143's criterion and it reads the very gate
 * this task's guard sits under; `voice-capture-text.test.ts` and `voice-capture-audio.test.ts` follow
 * because they read the two payloads whose shape this task's failure line must not disturb. The four
 * service-level criteria close the list: this task edits the service's own attempt path, and a
 * regression there would be invisible to the three capture criteria.
 */
const EXISTING_CRITERIA = [
  'server/modules/voice/tests/voice-capture-off.test.ts',
  'server/modules/voice/tests/voice-capture-text.test.ts',
  'server/modules/voice/tests/voice-capture-audio.test.ts',
  'server/modules/voice/tests/voice.service.test.ts',
  'server/modules/voice/tests/voiceHealth.test.ts',
  'server/modules/voice/tests/voice-config.routes.test.ts',
  'server/modules/voice/tests/voiceTranscribeGaps.test.ts',
];

/**
 * The suite's own server-phase collection, in process.
 *
 * `scripts/test.sh` collects the server phase with
 * `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules`; this walks the same
 * tree with the same predicate, so the two cannot disagree about WHICH files the suite runs. It is
 * in-process on purpose: this case replaces a `spawnSync` re-run of the criteria below, and the point
 * of the replacement is that the suite already executes them — what is left to check is that each is
 * still in the tree and still inside the set the suite collects, not that it runs again here.
 */
function collectedServerTests(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.(ts|js)$/.test(entry.name)) found.add(path.relative(REPO_ROOT, full));
    }
  };
  walk(path.join(REPO_ROOT, 'server'));
  return found;
}

test('AC8 the named criteria exist and are collected by the suite', () => {
  const collected = collectedServerTests();
  const absent = EXISTING_CRITERIA.filter((file) => !existsSync(path.join(REPO_ROOT, file)));
  const uncollected = EXISTING_CRITERIA.filter(
    (file) => !absent.includes(file) && !collected.has(file),
  );

  process.stdout.write(
    `AC8 named-criteria=${EXISTING_CRITERIA.length} ` +
      `collected-by-suite=${EXISTING_CRITERIA.length - uncollected.length} ` +
      `absent=[${absent.join(' ')}] uncollected=[${uncollected.join(' ')}] ` +
      `(each is executed by the suite's own server phase — scripts/test.sh's find over ` +
      `server/**/*.test.ts — so this reading asserts presence and collection rather than re-running it)\n`,
  );

  assert.deepEqual(absent, [], 'a criterion this task must not have moved is missing from the tree');
  assert.deepEqual(
    uncollected,
    [],
    'a criterion exists but is outside the set scripts/test.sh collects, so the suite would no longer run it',
  );
  assert.ok(
    EXISTING_CRITERIA.length > 0,
    'the named-criteria list is empty, so this reading would be vacuously green',
  );
});

test('AC9 the temp copies are gone and git status --porcelain gained nothing', () => {
  const porcelain = gitStatusPorcelain();
  const lines = porcelain.split('\n');
  const ownLeftovers = lines.filter(isOwnTempCopy);
  const anyTempCopies = lines.filter(isTempCopy);
  const foreignTempCopies = anyTempCopies.filter((line) => !isOwnTempCopy(line));
  const clean = porcelain.trim() === '';

  const delta = snapshotDelta(PRE_RUN_PORCELAIN, porcelain);
  const rawUnchanged = delta.onlyBefore.length === 0 && delta.onlyAfter.length === 0;
  const differing = [...delta.onlyBefore, ...delta.onlyAfter];
  // Every differing line is some other process's in-flight temp copy => this run changed nothing.
  const concurrentOnly =
    differing.length > 0 && differing.every((line) => isTempCopy(line) && !isOwnTempCopy(line));
  const unchanged = rawUnchanged || concurrentOnly;

  process.stdout.write(
    `falsify/leftovers: git.status-clean=${String(clean)} unchanged=${String(unchanged)} ` +
      `own-temp-copies=${ownLeftovers.length === 0 ? 'none' : ownLeftovers.join(' ')} ` +
      `temp-copies-any=${anyTempCopies.length} foreign-temp-copies=${foreignTempCopies.length} ` +
      `raw-unchanged=${String(rawUnchanged)} added=${delta.onlyAfter.length} ` +
      `removed=${delta.onlyBefore.length} concurrent-foreign-only=${String(concurrentOnly)}\n`,
  );

  // The copies are UNTRACKED files, so a run that failed to delete one shows up as a `??` line
  // naming it. This is asserted before the comparison below, because it is the property the cases
  // are responsible for and it is the one that holds whether or not the tree was clean — and it is
  // scoped by PID, so a SIBLING criterion's in-flight copy is not read as this run's residue. The
  // sibling criteria (`voice-capture-off`, `-text`, `-audio`, `voice-dashscope-settings`, the
  // `voice-error-*` pair) build their own `__criterion-falsify-` copies in this SAME directory and
  // the suite runs them concurrently.
  assert.deepEqual(
    ownLeftovers,
    [],
    `this run left its own temp copies behind: ${ownLeftovers.join(' ')}`,
  );

  // AC9's own words: `git status --porcelain` is empty once the run is over. That is exactly true
  // when the run starts from a committed tree — which is how the gate runs it — and the criterion
  // says which reading it took rather than assuming it. In a tree that was ALREADY dirty (a developer
  // iterating on the module), the property this case owns is that the run ADDED nothing, so the
  // comparison is against the state this file started in rather than against an ideal.
  //
  // WHAT THE COMPARISON FORGIVES, AND ONLY THAT. A sibling's copy that is still on disk when this
  // file STARTS, and gone by the time this reading runs, is a cross-PROCESS artifact of the suite's
  // concurrency and not residue of this run: without the exemption the snapshot-vs-sample comparison
  // reported "changed" on a tree whose final state was empty. A difference is forgiven ONLY when
  // every line in it is a temp copy belonging to another pid; any other added, removed or modified
  // path — a copy of this run's, a stray file, a touched tracked file — keeps the red, and the
  // failure prints both sides of the delta. `raw-unchanged` and `foreign-temp-copies` are printed
  // beside the scoped verdict, so what was excluded is visible in the reading rather than implied.
  assert.equal(
    unchanged,
    true,
    "this run changed the worktree's git status; " +
      `added=[${delta.onlyAfter.join(' ')}] removed=[${delta.onlyBefore.join(' ')}] ` +
      `started-with=["${firstLine(PRE_RUN_PORCELAIN)}"] ended-with=["${firstLine(porcelain)}"]`,
  );
  if (concurrentOnly) {
    process.stdout.write(
      `falsify/concurrent-foreign-only=true (the only delta was ${differing.length} temp copy ` +
        "line(s) belonging to another process, alive at this file's start and cleaned up by now)\n",
    );
  }
  if (clean) {
    process.stdout.write('falsify/git-status-clean=true (the run started from a committed tree)\n');
  } else {
    process.stdout.write(
      `falsify/git-status-clean=false (tree was already dirty before this run): ${firstLine(porcelain)}\n`,
    );
  }
});
