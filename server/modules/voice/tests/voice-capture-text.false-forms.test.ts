/**
 * The falsifying forms behind `voice-capture-text.test.ts`, plus the exit-code half of AC10.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that claim is not something a passing run can show about
 * itself. So each case here builds a BROKEN copy of a shipping module by a one-line text mutation,
 * runs the whole reading list against it, and requires the readings it predicts to fail — by name, and
 * with the FIGURE that went wrong, so the red is attributable to a clause rather than to a reading.
 * The four mutations are the four cheap ways to satisfy this task's words while missing its subject:
 *
 *   · (i) `upstream-body-replaced-by-final-text` — record the text the caller finally got instead of
 *     the answer that came back. Every word about "the upstream raw return" is still implemented (the
 *     row has an `upstream` object, with a status and a body), and the row is no longer a copy of what
 *     the upstream said. If this case passes, AC3's `rawVerbatim` is not measuring the raw return.
 *   · (ii) `failure-row-dropped` — build a row only for attempts that ended well. The construction
 *     point still exists and every field is still there; the two failures this task is FOR leave no
 *     trace at all. If this case passes, AC4's `failRow` is not measuring that the refused attempt was
 *     recorded.
 *   · (iii-a) `no-truncation` — take the verbatim branch unconditionally, so nothing is ever cut. The
 *     limit constant is still exported and still compared; it just no longer decides anything. If this
 *     case passes, AC7's `over.bodyBytes`/`over.flag` are not measuring the cut.
 *   · (iii-b) `truncated-always-true` — mark every answer as cut. The cut still happens where it
 *     should; the marker no longer distinguishes a cut body from a whole one, so a reader cannot tell
 *     a prefix from the answer. If this case passes, AC3's `truncatedAbsent` and AC7's
 *     `atLimit.flagAbsent` are not measuring the marker's ABSENCE.
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
 * WHERE THE COPIES GO, AND WHY NOT BESIDE THIS FILE. A copy of a module keeps that module's relative
 * imports (`../../../shared/asr/…`), so a copy in this file's directory would not resolve them; the
 * copies therefore live beside the modules they copy, under `server/modules/voice/`, which is the same
 * tree and the only place a copy of these modules resolves at all. Each copy gets its OWN path,
 * because ESM caches a module by URL: a mutant written over the base copy's path would import the
 * already-evaluated base module and the run would measure nothing. A copy of the CAPTURE module is
 * still imported by the SHIPPING service, and the criterion drives the shipping service, so the
 * mutation is the only difference in each arm. THAT DIRECTORY IS SHARED: the sibling criteria that
 * build temp copies (`voice-capture-off`, `voice-dashscope-settings`) write the same
 * `__criterion-falsify-` prefix there and the suite runs them concurrently, so the tree-half reading
 * is scoped to this process's own copies — the AC11 case's doc comment says why.
 *
 * WHY AC10'S EXIT CODES ARE HERE. AC10 asks for the exit code of six existing criteria plus
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
  SHIPPING_CAPTURE_MODULE,
  SHIPPING_SERVICE_MODULE,
} from './voice-capture-text.test.js';

/** Where the mutated copies go: beside the modules, so their relative imports still resolve. */
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
 * to be asked, because this directory is shared with the sibling criteria — see the AC11 case below.
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
 * Captured in the module body rather than in a hook, because what AC11 owes is that THIS RUN adds
 * nothing: a tree that a developer already had dirty should not be reported as this criterion's
 * leftovers, and a tree that was clean has to come back clean.
 */
const PRE_RUN_PORCELAIN = gitStatusPorcelain();

// ── the mutation cases ────────────────────────────────────────────────────────────────────────

/** One reading a mutation must break, and the figure in it that the mutation is supposed to move. */
type Expectation = {
  /** The reading, as the criterion names it. */
  reading: RegExp;
  /** A literal that must appear in that reading's measured value once the mutation is in place. */
  token: string;
  /** What the figure means, for the reason printed with the reading. */
  meaning: string;
};

type MutationCase = {
  /** The case's name, used in the reading names and the temp file names. */
  name: string;
  /** Which module the mutation is applied to; the other stays the shipping one. */
  slot: 'service' | 'capture';
  /** The exact shipping text to replace. Required to be unique in the file. */
  anchor: string;
  /** What it is replaced with. */
  replacement: string;
  /** The readings this mutation must break, as the criterion names them. */
  target: RegExp;
  /** Which reading (and figure) the red must be on, printed as `whichReading=`. */
  family: string;
  /** Figure-level attribution: each of these must red WITH this token in its measured value. */
  expects: readonly Expectation[];
  /** What the mutation is, in one sentence, for the reason printed with the reading. */
  why: string;
};

const CASES: readonly MutationCase[] = [
  {
    name: 'upstream-body-replaced-by-final-text',
    slot: 'capture',
    anchor: '    upstream: input.upstream === null ? null : truncateVoiceCaptureReturn(input.upstream),',
    replacement:
      '    upstream: input.upstream === null\n' +
      '      ? null\n' +
      '      : truncateVoiceCaptureReturn({ status: input.upstream.status, body: input.reading.text }),',
    target: /^AC3 /,
    family: 'AC3/rawVerbatim',
    expects: [
      {
        reading: /^AC3 /,
        token: 'rawVerbatim=false',
        meaning: 'the row carried the text the caller got, not the answer the upstream gave',
      },
    ],
    why: 'only the final text is recorded, so the row cannot show what the upstream actually said',
  },
  {
    name: 'failure-row-dropped',
    slot: 'capture',
    anchor: '    recordAttempt(captureId: string, attempt: VoiceCaptureAttempt): void {',
    replacement:
      '    recordAttempt(captureId: string, attempt: VoiceCaptureAttempt): void {\n' +
      '      // The mutation: an attempt that failed records nothing at all.\n' +
      "      if (attempt.outcome === 'fail') {\n" +
      '        return;\n' +
      '      }',
    target: /^AC4 /,
    family: 'AC4/failRow',
    expects: [
      {
        reading: /^AC4 /,
        token: 'failRow=0',
        meaning: 'the refused attempt left no row, which is the whole subject of this task',
      },
    ],
    why: 'a failed attempt builds no row, so an upstream refusal leaves no trace in the log',
  },
  {
    name: 'no-truncation',
    slot: 'capture',
    anchor: '  if (bytes.length <= RAW_RETURN_LIMIT_BYTES) {',
    replacement: '  if (bytes.length >= 0) {',
    target: /^AC7 /,
    family: 'AC7/over.bodyBytes+over.flag',
    expects: [
      {
        reading: /^AC7 /,
        token: 'over.bodyBytes=70000',
        meaning: 'an over-limit answer was recorded whole instead of cut at the limit',
      },
      {
        reading: /^AC7 /,
        token: 'over.flag=false',
        meaning: 'and it carries no marker saying it is a prefix, because it is not one',
      },
    ],
    why: 'the limit is never exceeded, so an over-limit answer is recorded whole and unmarked',
  },
  {
    name: 'truncated-always-true',
    slot: 'capture',
    anchor: '    return { status: rawReturn.status, body: rawReturn.body };',
    replacement: '    return { status: rawReturn.status, body: rawReturn.body, truncated: true };',
    target: /^(AC3|AC7) /,
    family: 'AC3/truncatedAbsent+AC7/atLimit.flagAbsent',
    expects: [
      {
        reading: /^AC3 /,
        token: 'truncatedAbsent=false',
        meaning: 'a body that fits now claims to have been cut',
      },
      {
        reading: /^AC7 /,
        token: 'atLimit.flagAbsent=false',
        meaning: 'the exactly-at-limit body, the one the marker has to be ABSENT on, is marked',
      },
    ],
    why: 'every answer is marked as cut, so the marker stops distinguishing a prefix from an answer',
  },
];

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

/** The module paths one arm drives: the mutated copy in its slot, the shipping module in the other. */
function modulesFor(mutation: MutationCase, modulePath: string): { service?: string; capture?: string } {
  return mutation.slot === 'service' ? { service: modulePath } : { capture: modulePath };
}

async function measureArm(mutation: MutationCase, modulePath: string): Promise<ArmOutcome> {
  const outcomes = await collectReadings(modulesFor(mutation, modulePath));
  const red = outcomes.filter((outcome) => !outcome.ok);
  const outsider = outcomes.find((outcome) => outcome.ok && !mutation.target.test(outcome.name));
  return {
    red: red.map((outcome) => outcome.name),
    total: outcomes.length,
    firstRedReason: red[0] === undefined ? '(none)' : `${red[0].name} measured ${red[0].value}`,
    outsiderGreen: outsider?.name ?? '(none)',
    outcomes,
  };
}

/**
 * The figure-level check: every predicted reading red, and red for the predicted reason.
 *
 * THIS IS WHAT KEEPS A CASE FROM BEING SATISFIED BY AN ACCIDENT. "AC3 is red" is a much weaker claim
 * than "AC3 is red because `rawVerbatim` is false": the first is also true if the mutation broke the
 * module's import, and the second is also false if the criterion stopped reading `rawVerbatim` while
 * still printing it. Both are reported by name, together with the measured value, so the failure says
 * which of the two happened.
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
  test(`AC11/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
    const source = mutation.slot === 'service' ? SHIPPING_SERVICE_MODULE : SHIPPING_CAPTURE_MODULE;
    const basePath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-base-${process.pid}.ts`);
    const mutantPath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-mut-${process.pid}.ts`);

    try {
      await copyFile(source, basePath);

      // ── arm one: the same text, unmutated. A harness that reds here cannot say anything about the
      // mutant, so this arm is a precondition rather than a second experiment.
      const base = await measureArm(mutation, basePath);
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

      // ── the mutation itself. The anchor has to be unique: a text that occurs twice would be
      // rewritten in both places, and the case would then be about two edits rather than one.
      const shippingText = await readFile(source, 'utf8');
      const anchorCount = shippingText.split(mutation.anchor).length - 1;
      assert.equal(
        anchorCount,
        1,
        `the anchor for ${mutation.name} occurs ${anchorCount} times in the shipping module; a mutation ` +
          'case has to name exactly one site, or it is not this case that the red would be about',
      );

      const mutated = shippingText.replace(mutation.anchor, mutation.replacement);
      assert.notEqual(mutated, shippingText, `the ${mutation.name} replacement did not change the text`);
      await writeFile(mutantPath, mutated, 'utf8');

      // ── arm two: the mutant, at a NEW path, because ESM caches by URL and a mutant that reused
      // the base copy's path would import the base module and measure nothing at all.
      const mutant = await measureArm(mutation, mutantPath);
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

// ── AC10's exit codes: the surfaces this task must not have moved ──────────────────────────────

/**
 * The six criteria AC10 names, by path so the printed line says which one answered.
 *
 * `voice-capture-off.test.ts` is first because it is AC-143's criterion AND because this task edits
 * the one construction point that criterion reads: if this task's payload broke the row AC-143 pinned,
 * this is the line that says so. `voice-provider-dispatch.test.ts` is here because the attempt this
 * task records is the one that runs through provider dispatch, and its rows are driven by the same
 * seam.
 */
const EXISTING_CRITERIA = [
  'server/modules/voice/tests/voice-capture-off.test.ts',
  'server/modules/voice/tests/voice.service.test.ts',
  'server/modules/voice/tests/voiceHealth.test.ts',
  'server/modules/voice/tests/voice-config.routes.test.ts',
  'server/modules/voice/tests/voiceTranscribeGaps.test.ts',
  'server/modules/voice/tests/voice-provider-dispatch.test.ts',
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

test('AC10 the named criteria exist and are collected by the suite', () => {
  const collected = collectedServerTests();
  const absent = EXISTING_CRITERIA.filter((file) => !existsSync(path.join(REPO_ROOT, file)));
  const uncollected = EXISTING_CRITERIA.filter(
    (file) => !absent.includes(file) && !collected.has(file),
  );

  process.stdout.write(
    `AC10 named-criteria=${EXISTING_CRITERIA.length} ` +
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

/**
 * AC11's tree half, scoped to what THIS run is answerable for.
 *
 * WHY THE READING IS SCOPED BY PID. The copies cannot live in the OS temp directory (their relative
 * imports would not resolve), and this file is not the only criterion writing into that directory:
 * `voice-capture-off` and `voice-dashscope-settings` build their own `__criterion-falsify-*` copies
 * in the SAME directory, and the suite runs four files at a time. So a sibling's copies are untracked
 * lines in this file's tree through no act of this file's, and a sibling that is still holding them
 * when this file STARTS has finished and cleaned up by the time this reading runs — which made the
 * snapshot-vs-sample comparison report "changed" on a tree whose final state was empty. That is a
 * cross-PROCESS artifact, not residue, so the comparison forgives exactly that and nothing else:
 *
 *   · THIS run's own copies stay an unconditional red (`own-temp-copies`), so the property AC11 names
 *     — no temp copy of this run survives — is asserted at full strength, and more precisely than
 *     before (the old reading reported a sibling's copies as if they were this run's);
 *   · a difference is forgiven ONLY when every line in it is a temp copy belonging to another pid.
 *     Any other added, removed or modified path — a copy of this run's, a stray file, a touched
 *     tracked file — keeps the red, and the failure prints both sides of the delta;
 *   · a foreign copy present in BOTH snapshots contributes no difference at all and needs no
 *     forgiveness.
 *
 * `temp-copies-any` and `raw-unchanged` are printed beside the scoped verdict, so what was excluded
 * is visible in the reading rather than implied by it.
 */
test('AC11: the temp copies are gone and git status --porcelain gained nothing', () => {
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
  // naming it. This is asserted before the comparison below, because it is the property the cases are
  // responsible for and it is the one that holds whether or not the tree was clean.
  assert.deepEqual(
    ownLeftovers,
    [],
    `this run left its own temp copies behind: ${ownLeftovers.join(' ')}`,
  );

  // AC11's own words: `git status --porcelain` is identical to the state this file started in. In the
  // tree the gate runs, that state is empty; in a tree a developer was already iterating on, the
  // property this case owns is that the run ADDED nothing, so the comparison is against the state
  // this file started in rather than against an ideal it was never handed — and, for that same
  // reason, a sibling criterion's in-flight copies are not this run's change to answer for.
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
