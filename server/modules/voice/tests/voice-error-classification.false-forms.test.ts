/**
 * The falsifying forms behind `voice-error-classification.test.ts`, plus AC7's exit codes and AC8's
 * compiler reading.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that is not something a passing run can show about
 * itself. Each case here builds a BROKEN copy of a shipping module by a one-line text mutation, runs
 * the criterion's whole reading list against it, and requires the readings it predicts to fail — by
 * name, and with the FIGURE that went wrong, so the red is attributable to a clause rather than to a
 * reading. The four mutations are the four cheap ways to satisfy this task's words while missing its
 * subject:
 *
 *   · (i) `status-only` — classify from the status alone, never reading the answer's own error code.
 *     Every code in the vocabulary still exists and the table still has fourteen rows; a `403`
 *     `AccessDenied.Unpurchased` and a `403` with no code collapse onto one answer, which is the
 *     single thing this task exists to stop. If this case passes, AC2's `matched` and AC3's
 *     `distinct400` are not measuring that the BODY decides.
 *   · (ii) `429-all-rate-limited` — short-circuit every `429` to `RATE_LIMITED` before the body is
 *     read. The rate limit is still classified, the quota codes still exist; the two quota facts
 *     behind the same number are gone. If this case passes, AC3's `distinct429` is not measuring the
 *     `429` group's width.
 *   · (iii) `table-missing-a-code` — delete one row from the code→status table. The table is still a
 *     table, the code still exists in the vocabulary, and the row that is missing is the one whose
 *     absence a reader would have to notice by eye. If this case passes, AC4's `missing` is not
 *     measuring that the table covers the vocabulary.
 *   · (iv) `table-extra-a-code` — add a row for a code the vocabulary no longer has (the deleted
 *     `UPSTREAM_ERROR`). Thirteen rows are still there and one more; a table written against the OLD
 *     vocabulary is exactly the drift this task's table is meant to have ended. If this case passes,
 *     AC4's `extra` is not measuring that the table is written against THIS vocabulary.
 *
 * EACH CASE HAS THREE PARTS, and the first is what keeps the others from being vacuous:
 *   1. the UNMUTATED copy must clear the whole list (a harness that is red for its own reasons proves
 *      nothing by going red on a mutant);
 *   2. the MUTATED copy must red every reading the case predicts, and that reading's measured value
 *      must contain the figure the mutation changes — a reading that is red for some other reason, or
 *      green while the figure is visibly wrong, is reported as a hole rather than as a success;
 *   3. some reading OUTSIDE that family must still be green, so "the whole rig broke" is not what the
 *      red means.
 *
 * WHERE THE COPIES GO, AND WHY NOT BESIDE THE MODULES. The sibling criteria in this directory put
 * their temp copies beside the modules they copy, because a copy keeps that module's relative imports
 * and only resolves in place. The copies here go to `tmp/__criterion-falsify-voice-error-classification/`
 * instead, and this is a registered deviation with two reasons rather than a preference:
 *   · AC8's drift mutant is TYPE-INVALID ON PURPOSE — that is what it measures. A type-invalid `.ts`
 *     sitting in `shared/` or `server/` while it exists reds a SIBLING criterion's `npm run typecheck`,
 *     and six files in this suite run that command concurrently. A criterion that can red another
 *     task's gate by existing has stopped being an observation of its own subject.
 *   · `tmp/` is gitignored, so the copies cannot appear in anyone's `git status --porcelain` snapshot
 *     either — including the three sibling criteria whose leftovers readings walk that output.
 * A copy in `tmp/` is one level deeper than the module it copies, so its `'./…'` imports are re-rooted
 * to `'../../shared/asr/…'` (`copyText` below) and each arm asserts that the re-rooting is the copy's
 * ONLY difference from the shipping text (`shippingOf`): a red is about the mutation, not the copy.
 *
 * WHY AC7'S EXIT CODES AND AC8'S COMPILER RUN ARE HERE. AC7 asks for the exit code of thirteen
 * existing criteria plus `npm run typecheck` and `npm run lint`, each printed rather than assumed, and
 * AC8 asks for a red compiler run on a drifted vocabulary. Those are SUBPROCESSES, and AC1 requires
 * the criterion file itself to start none inside a fifteen-second budget — one `npm run typecheck`
 * alone is most of that budget. This file is the task's other executable artifact, it already starts
 * subprocesses, and it is not the file AC1's budget is about. The criterion's AC8 reading therefore
 * prints `typecheck-reds-on-drift=not-measured-here` and names this file, rather than claiming a
 * measurement it did not take.
 *
 * WHY AC7 NO LONGER STARTS A SECOND VITEST FOR THE ASR CONTRACT SPEC. It used to: the entry ran
 * `npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts` in a child of its own, and
 * under the driver's memory ceiling that child is what went red. Measured on this box (2026-09-27,
 * one process in a scope): that child peaks at 1.944 GB, while every other entry in AC7_COMMANDS is
 * the ~0.3 GB a `tsx --test` file costs — and everything one project's loop runs at once (every task
 * worker, every fan-in, every capped scope) shares ONE `<project>.slice` with MemoryMax=64G
 * (scripts/start-drivers-scoped.sh). So the extra vitest per AC7 invocation is a MULTIPLIER on that
 * ceiling rather than a defect of any one call: while the client lane was already running the very
 * same spec (the lane's own per-file record for it reads passed=true in the same log), the AC7 child
 * was OOM-killed, `spawnSync` returned `status: null`, `runCommand`'s `result.status ?? 1` reported
 * `exit=1`, and the criterion red — six such reds across two unrelated tasks' fan-ins
 * (.quay/fan-in-suite-*.log). Re-running the suite does not clear it either: the criterion reds on a
 * clean tree under the same ceiling, which is why this is a fix task and not a re-dispatch.
 *
 * WHAT REPLACES IT, AND WHAT STILL HOLDS. The spec's EXECUTION was never AC7's to carry: the client
 * lane is the repository-level criterion that collects `src/**\/*.test.ts{,x}` (vitest.config.ts's
 * `include`) and whose per-file `passed=false` reds the suite (scripts/test.sh's client phase). AC7
 * now asks that lane's resolver to ENUMERATE the spec's cases — `vitest list <path>`, which loads the
 * module graph but forks no worker and runs no test body: measured 0.281 GB anon / 0.366 GB peak
 * against the 1.819 GB anon / 1.944 GB peak it replaces, a 6.5x anon cut, so it cannot contribute to
 * the oversubscription the red came from. It asks for the full listing rather than `--filesOnly`
 * (0.091 GB) because the listing is the stronger falsifiable reading: the lines it prints name the
 * spec's own cases as vitest resolved them, so "collected" is a claim about a spec with cases in it
 * rather than about a path string this file could have copied. Renaming the spec out of the lane's
 * globs, narrowing `include` until it no longer collects the spec, and emptying the spec of cases are
 * all reds.
 *
 * AND IT IS NOT AN ECHO OF ITS OWN QUESTION. `vitest list <path>` EXITS 0 WITH NO OUTPUT for a path
 * the lane does not collect, so an exit-code-only reading here would be a vacuous pass and the case
 * below does not take one. It asks `vitest list` about such a path and requires SILENCE: no case
 * line, no path echoed. That arm is what makes the marker on the collected path a measurement of the
 * lane's `include` set instead of a command repeating the argument it was handed — the same refusal
 * of a vacuous pass that the exit-code loop makes one level up.
 *
 * AC8'S DRIFT READING RUNS THE PROJECT'S OWN OPTIONS, NOT THE PROJECT'S OWN COMMAND. The mutant copy's
 * per-arm `tsconfig` is `{"extends": "../../server/tsconfig.json", "include": ["./<arm>.ts"]}`, so the
 * compiler options, `lib`, `types`, `moduleResolution` and `strict` are `server/tsconfig.json`'s own
 * and only the file list differs; the unmutated arm is compiled the same way first, so a mutant red
 * cannot be a red produced by the flag set. What is NOT done is drifting the shipping registry in
 * place and running `npm run typecheck`: that would put a type-invalid shipping file in front of the
 * sibling criteria's concurrent typecheck for the duration, which is the hazard the placement above
 * exists to avoid. The pair — the shipping tree green under the real `npm run typecheck` (AC7's
 * reading) and the drift red under the project's own options (this one) — is what AC8 asks for.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  collectReadings,
  SHIPPING_REGISTRY_MODULE,
  SHIPPING_SERVICE_MODULE,
} from './voice-error-classification.test.js';
import type { CriterionOverrides } from './voice-error-classification.test.js';

/** The repository root: the registry sits at `shared/asr/`, so its directory is two levels down. */
const WORKTREE_ROOT = path.resolve(path.dirname(SHIPPING_REGISTRY_MODULE), '../..');

/** The prefix every temp copy in this repository carries, so "left behind" is a pattern, not a guess. */
const TEMP_PREFIX = '__criterion-falsify-';

/**
 * Where the copies go: gitignored, and outside every tsconfig's `include` (the root config lists
 * `src`, `shared` and `vite.config.js`; the server config lists `server/**` and `shared/**`; the
 * scripts config lists `scripts/**\/*.mjs`), so a copy here is invisible to git and to all three
 * compiler runs until an arm compiles it on purpose.
 */
const SCRATCH_DIR = path.join(WORKTREE_ROOT, 'tmp', `${TEMP_PREFIX}voice-error-classification`);

/** The tail every temp copy THIS process writes ends with, so "is this line mine?" has an answer. */
const OWN_TEMP_SUFFIX = `-${process.pid}`;

/** `git status --porcelain` for the worktree, as one string. */
function gitStatusPorcelain(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: WORKTREE_ROOT, encoding: 'utf8' });
}

/** True for a porcelain line naming a temp copy — any process's, this one's included. */
function isTempCopy(line: string): boolean {
  return line.includes(TEMP_PREFIX);
}

/** True for a porcelain line naming a temp copy THIS process wrote. */
function isOwnTempCopy(line: string): boolean {
  return isTempCopy(line) && line.includes(OWN_TEMP_SUFFIX);
}

/** The two snapshots' disagreement, split by which side each line was seen on (set-based). */
function snapshotDelta(before: string, after: string): { onlyBefore: string[]; onlyAfter: string[] } {
  const split = (value: string): string[] => value.split('\n').filter((line) => line !== '');
  const beforeLines = new Set(split(before));
  const afterLines = new Set(split(after));
  return {
    onlyBefore: [...beforeLines].filter((line) => !afterLines.has(line)),
    onlyAfter: [...afterLines].filter((line) => !beforeLines.has(line)),
  };
}

/** The first non-empty line of a string, for printing something bounded. */
function firstLine(value: string): string {
  return value.split('\n').find((line) => line.trim() !== '') ?? '(empty)';
}

/**
 * `git status --porcelain` BEFORE anything here runs.
 *
 * Captured in the module body rather than in a hook, because what this file owes is that THIS RUN adds
 * nothing: a tree that a developer already had dirty should not be reported as this criterion's
 * leftovers, and a tree that was clean has to come back clean.
 */
const PRE_RUN_PORCELAIN = gitStatusPorcelain();

// ── how a copy is built, and how that is undone ───────────────────────────────────────────────

/**
 * How a copy of a module is made, and how the copy is mapped back to the text it was made from.
 *
 * `shippingOf(copyOf(text)) === text` is asserted for every copy before it is measured. That is the
 * attribution guard: the copies live one level deeper than the modules they copy, so the registry
 * copy's `'./…'` specifiers are re-rooted, and the assertion says the re-rooting is the copy's ONLY
 * difference from the shipping text — a red can then be about the mutation and nothing else.
 */
type CopyShape = {
  /** Builds the copy's text from the shipping text. */
  copyOf: (shipping: string) => string;
  /** Recovers the shipping text from the copy's text. */
  shippingOf: (copy: string) => string;
};

/** The registry copy: imported as a module, so its imports are re-rooted to the repository root. */
const RE_ROOTED: CopyShape = {
  copyOf: (shipping) => shipping.replaceAll("from './", "from '../../shared/asr/"),
  shippingOf: (copy) => copy.replaceAll("'../../shared/asr/", "'./"),
};

/**
 * The service copy: read as TEXT by AC4's source-table reading and never imported, so it is the
 * shipping file byte for byte — and it is written with a `.txt` extension to keep it that way.
 */
const AS_TEXT: CopyShape = {
  copyOf: (shipping) => shipping,
  shippingOf: (copy) => copy,
};

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
  /** The case's name, used in the reading name and the temp file names. */
  name: string;
  /** Which module is mutated: the registry (imported) or the service (its text). */
  slot: 'registry' | 'service-text';
  /** The exact shipping text to replace. Required to be unique in the module. */
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
  /** How the copy is built and undone. */
  shape: CopyShape;
};

/**
 * The two classifier mutations share an anchor: the line that reads the answer's own error code. Both
 * replace what that line produces, in the two ways a classifier can stop reading the body.
 */
const READS_THE_BODY = '  const named = extractUpstreamCode(body);';

const CASES: readonly MutationCase[] = [
  {
    name: 'status-only',
    slot: 'registry',
    anchor: READS_THE_BODY,
    replacement:
      "  const named = extractUpstreamCode(''); // the mutation: only the status is read from here",
    target: /^AC[235] /,
    family: 'AC2/matched+AC3/distinct400+AC5/adapter-vs-pure-same',
    expects: [
      {
        reading: /^AC2 /,
        token: 'matched=12',
        meaning: 'seven rows lost their code: the body no longer decides anything',
      },
      {
        reading: /^AC3 /,
        token: 'distinct400=1',
        meaning: 'the four different 400s collapsed onto the status fallback',
      },
      {
        reading: /^AC5 /,
        token: 'adapter-vs-pure-same=false',
        meaning: 'the shipped adapter, which still reads the body, disagrees with the mutated function',
      },
    ],
    why: 'the answer is classified by its status alone, so a 403 naming a code and a bare 403 are one answer',
    shape: RE_ROOTED,
  },
  {
    name: '429-all-rate-limited',
    slot: 'registry',
    anchor: READS_THE_BODY,
    replacement:
      "  if (status === 429) return 'RATE_LIMITED'; // the mutation: every 429 is the rate limit\n" +
      READS_THE_BODY,
    target: /^AC[235] /,
    family: 'AC2/matched+AC3/distinct429+AC5/adapter-vs-pure-same',
    expects: [
      {
        reading: /^AC2 /,
        token: 'matched=17',
        meaning: 'the two quota rows behind a 429 were answered as the rate limit',
      },
      {
        reading: /^AC3 /,
        token: 'distinct429=1',
        meaning: "the 429 group lost its width: one number no longer carries two facts",
      },
      {
        reading: /^AC5 /,
        token: 'adapter-vs-pure-same=false',
        meaning: 'the shipped adapter, which still reads the body, disagrees with the mutated function',
      },
    ],
    why: 'a 429 is answered before its body is read, so an exhausted quota reads as the rate limit',
    shape: RE_ROOTED,
  },
  {
    name: 'table-missing-a-code',
    slot: 'service-text',
    anchor: '  QUOTA_EXHAUSTED: 429,\n',
    replacement: '',
    target: /^AC4 /,
    family: 'AC4/missing',
    expects: [
      {
        reading: /^AC4 /,
        token: 'missing=[QUOTA_EXHAUSTED]',
        meaning: 'the vocabulary has a member the table has no row for',
      },
      {
        reading: /^AC4 /,
        token: 'source=13',
        meaning: 'the parsed table is a row short of the fourteen the vocabulary declares',
      },
    ],
    why: 'a code the vocabulary declares has no status, so a failure carrying it has no answer',
    shape: AS_TEXT,
  },
  {
    name: 'table-extra-a-code',
    slot: 'service-text',
    anchor: '  NO_SPEECH_DETECTED: 422,\n',
    replacement: '  NO_SPEECH_DETECTED: 422,\n  UPSTREAM_ERROR: 502,\n',
    target: /^AC4 /,
    family: 'AC4/extra',
    expects: [
      {
        reading: /^AC4 /,
        token: 'extra=[UPSTREAM_ERROR]',
        meaning: 'the table still carries a row for a code this vocabulary deleted',
      },
      {
        reading: /^AC4 /,
        token: 'source=15',
        meaning: 'the parsed table is a row longer than the fourteen the vocabulary declares',
      },
    ],
    why: 'the table is written against the vocabulary this task replaced, which is the drift it exists to end',
    shape: AS_TEXT,
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

/** The override one arm drives: the mutated copy in its slot, the shipping module in the other. */
function overridesFor(mutation: MutationCase, copyPath: string): CriterionOverrides {
  return mutation.slot === 'registry' ? { registry: copyPath } : { serviceSource: copyPath };
}

async function measureArm(mutation: MutationCase, copyPath: string): Promise<ArmOutcome> {
  const outcomes = await collectReadings(overridesFor(mutation, copyPath));
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
 * THIS IS WHAT KEEPS A CASE FROM BEING SATISFIED BY AN ACCIDENT. "AC2 is red" is a much weaker claim
 * than "AC2 is red because `matched` is twelve": the first is also true if the mutation broke the
 * module's import, and the second is also false if the criterion stopped reading `matched` while still
 * printing it. Both are reported by name, together with the measured value, so the failure says which
 * of the two happened.
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
  test(`AC6/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
    const source = mutation.slot === 'registry' ? SHIPPING_REGISTRY_MODULE : SHIPPING_SERVICE_MODULE;
    const extension = mutation.slot === 'registry' ? '.ts' : '.service.txt';
    const basePath = path.join(SCRATCH_DIR, `${mutation.name}-base${OWN_TEMP_SUFFIX}${extension}`);
    const mutantPath = path.join(SCRATCH_DIR, `${mutation.name}-mut${OWN_TEMP_SUFFIX}${extension}`);

    mkdirSync(SCRATCH_DIR, { recursive: true });
    try {
      // ── the mutation itself. The anchor has to be unique: a text that occurs twice would be
      // rewritten in both places, and the case would then be about two edits rather than one.
      const shippingText = readFileSync(source, 'utf8');
      const anchorCount = shippingText.split(mutation.anchor).length - 1;
      assert.equal(
        anchorCount,
        1,
        `the anchor for ${mutation.name} occurs ${anchorCount} times in the shipping module; a mutation ` +
          'case has to name exactly one site, or it is not this case that the red would be about',
      );

      const mutatedText = shippingText.replace(mutation.anchor, mutation.replacement);
      assert.notEqual(mutatedText, shippingText, `the ${mutation.name} replacement did not change the text`);

      // The copy's shape is asserted on BOTH texts, so the mutant is the mutation plus the re-rooting
      // and the re-rooting is the only other difference there is.
      const baseCopy = mutation.shape.copyOf(shippingText);
      const mutantCopy = mutation.shape.copyOf(mutatedText);
      assert.equal(
        mutation.shape.shippingOf(baseCopy),
        shippingText,
        `the ${mutation.name} copy differs from the shipping text by more than its imports`,
      );
      assert.equal(
        mutation.shape.shippingOf(mutantCopy),
        mutatedText,
        `the ${mutation.name} mutant differs from the mutated text by more than its imports`,
      );

      writeFileSync(basePath, baseCopy, 'utf8');
      writeFileSync(mutantPath, mutantCopy, 'utf8');

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

      // ── arm two: the mutant, at a NEW path, because ESM caches a module by URL: a mutant written
      // over the base copy's path would import the already-evaluated base module and measure nothing.
      const mutant = await measureArm(mutation, mutantPath);
      const inTargetFamily = mutant.red.filter((name) => mutation.target.test(name));
      const misses = attributionMisses(mutation, mutant);
      process.stdout.write(
        `falsify/${mutation.name} mutant: mutation=${mutation.name} baseExit=0 ` +
          `mutantRed=${String(inTargetFamily.length > 0)} whichReading=${mutation.family} ` +
          `outsideFamilyGreen=${String(mutant.outsiderGreen !== '(none)')} ` +
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
      rmSync(basePath, { force: true });
      rmSync(mutantPath, { force: true });
    }
  });
}

// ── AC7's exit codes: the surfaces this task must not have moved ───────────────────────────────

/**
 * One command AC7 names, with what a non-vacuous pass looks like for it.
 *
 * `tally` and `markers` are the two ways a command can show it ran rather than exited: a test runner
 * prints how many cases it ran, and a check script prints the tally it decided on. A command with
 * neither is judged by its exit code alone, which is what those tools mean.
 */
type CommandSpec = {
  /** The file or script name, printed as `name=<…>`. */
  label: string;
  command: string;
  args: readonly string[];
  /** A count the command must print, e.g. `pass 7` for `node --test`. */
  tally: RegExp | null;
  /** Literals the output must contain, for a command that prints no tally. */
  markers: readonly string[];
  /** True for a surface this task does not own yet, so its absence is a named gap, not a failure. */
  optional?: boolean;
};

/**
 * The five command surfaces AC7 names that the fan-in suite does NOT itself run.
 *
 * THE LIST IS SHORT ON PURPOSE, and why it is short is this task's whole change. AC7 used to re-run
 * the `tsx --test` criteria plus `npm run typecheck` and `npm run lint` here as well. Every one of
 * those is already executed by the suite: the `server/**` criteria by the server phase, and the two
 * static phases by typecheck/lint. Re-running them from this case was a serial duplicator of the
 * suite's own work — measured 2026-10-06, THIS one case was 140.1s of a file whose mutation cases are
 * all under 0.2s, and 372.7s across the seven sibling `*.false-forms` files. What is left is only the
 * part the suite cannot run: `scripts/` is a lane of its own outside fan-in (`npm run test:scripts`),
 * and the ASR contract spec is a client-lane spec AC7 enumerates rather than executes.
 *
 * WHY THE SPEC IS ENUMERATED, NOT RUN. AC7 used to start a fresh `vitest run` child for it; under the
 * driver's ceiling that child (1.944 GB peak measured, against ~0.3 GB for a `tsx --test` file) was
 * the OOM victim inside the shared 64G project slice (`<project>.slice`), so the criterion red on
 * `status: null`. `vitest
 * list <path>` loads the module graph but forks no worker and runs no test body (0.281 GB anon
 * measured), so it cannot contribute to that oversubscription. The EXECUTION is the client lane's —
 * scripts/test.sh's client phase records its per-file `passed=false` and reds the suite. The listing
 * is the stronger reading: the lines it prints name the spec's own cases as the lane resolved them,
 * so "collected" is a claim about a spec with cases in it rather than about a path string this file
 * could have copied.
 */
const AC7_COMMANDS: readonly CommandSpec[] = [
  {
    label: 'src/shared/asr/tests/asrContractInvariants.test.ts',
    command: 'npx',
    args: ['vitest', 'list', 'src/shared/asr/tests/asrContractInvariants.test.ts'],
    tally: null,
    markers: ['src/shared/asr/tests/asrContractInvariants.test.ts > '],
  },
  {
    label: 'scripts/asr-dashscope-omni-check.mjs',
    command: 'node',
    args: ['scripts/asr-dashscope-omni-check.mjs'],
    tally: null,
    markers: ['platform-fetch-calls=0', 'failures=0'],
  },
  {
    label: 'scripts/asr-contract-invariants-check.mjs',
    command: 'node',
    args: ['scripts/asr-contract-invariants-check.mjs'],
    tally: null,
    markers: ['verdict=pass', 'platform-fetch-calls=0'],
  },
  {
    label: 'scripts/asr-dashscope-omni-check.test.mjs',
    command: 'node',
    args: ['--test', 'scripts/asr-dashscope-omni-check.test.mjs'],
    tally: /pass (\d+)/,
    markers: [],
  },
  {
    label: 'scripts/asr-contract-invariants-check.test.mjs',
    command: 'node',
    args: ['--test', 'scripts/asr-contract-invariants-check.test.mjs'],
    tally: /pass (\d+)/,
    markers: [],
  },
];

/**
 * The `server/**` criteria AC7 names, which the suite's own server phase collects and runs.
 *
 * These are NOT spawned from this file any more (they once were, one after the other). What this file
 * still owes them is the non-vacuity the spawn carried: a criterion renamed or deleted must still red,
 * so the merged case asserts each is present AND inside the set `scripts/test.sh` collects
 * (`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules`). `optional` is
 * preserved for the one surface that was a registered gap when AC7 was written: an absent optional is
 * a named gap, not a failure.
 */
const AC7_COLLECTED_CRITERIA: readonly { path: string; optional?: boolean }[] = [
  { path: 'server/modules/voice/tests/voice-provider-dispatch.test.ts' },
  { path: 'server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts' },
  { path: 'server/modules/voice/tests/voice.service.test.ts' },
  { path: 'server/modules/voice/tests/voiceHealth.test.ts' },
  { path: 'server/modules/voice/tests/voice-config.routes.test.ts' },
  { path: 'server/modules/voice/tests/voiceTranscribeGaps.test.ts' },
  { path: 'server/modules/voice/tests/voice-capture-off.test.ts' },
  { path: 'server/modules/voice/tests/voice-capture-text.test.ts' },
  { path: 'server/modules/voice/tests/voice-capture-audio.test.ts', optional: true },
];

/** How many of AC7's subprocesses run at once. The serial list it replaces is the cost it removes. */
const AC7_CONCURRENCY = 4;

type CommandOutcome = {
  label: string;
  /** The full command line, for the printed record. */
  command: string;
  /** The exit code, or `null` for an optional surface that is not in this tree. */
  exitCode: number | null;
  output: string;
};

/**
 * Runs one command and reports its exit code and its output, stdout and stderr together.
 *
 * SPAWNED, NOT `spawnSync`: the merged case runs a bounded pool of these at once (the serial list it
 * replaces is why this file was the suite's long pole). `NODE_TEST_CONTEXT` IS DELETED FROM THE
 * CHILD'S ENVIRONMENT, and that is what makes "exit 0" mean something: a `node --test` child that
 * inherits it runs in the parent's context and exits 0 having run NOTHING, which is the exact false
 * green this reading exists to catch. The tally and the markers are asserted for the same reason, one
 * level down. An `optional` command whose file is absent is not run at all and is reported with a
 * `null` exit code.
 */
function runCommand(spec: CommandSpec): Promise<CommandOutcome> {
  const command = `${spec.command} ${spec.args.join(' ')}`;
  if (spec.optional === true && !existsSync(path.join(WORKTREE_ROOT, spec.label))) {
    return Promise.resolve({ label: spec.label, command, exitCode: null, output: '' });
  }

  return new Promise((resolve) => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(spec.command, [...spec.args], { cwd: WORKTREE_ROOT, env: environment });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => resolve({ label: spec.label, command, exitCode: 1, output }));
    child.on('close', (code) => resolve({ label: spec.label, command, exitCode: code ?? 1, output }));
  });
}

/** Runs `specs` with at most `concurrency` in flight; the result is in `specs` order. */
async function runPool(specs: readonly CommandSpec[], concurrency: number): Promise<CommandOutcome[]> {
  const outcomes = new Array<CommandOutcome>(specs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < specs.length) {
      const index = next;
      next += 1;
      outcomes[index] = await runCommand(specs[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, () => worker()));
  return outcomes;
}

/** The suite's own server-phase collection, in process — same predicate as `scripts/test.sh`'s find. */
function collectedServerTests(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.(ts|js)$/.test(entry.name)) found.add(path.relative(WORKTREE_ROOT, full));
    }
  };
  walk(path.join(WORKTREE_ROOT, 'server'));
  return found;
}

test('AC7 the criteria, the check scripts and the repository gates still exit 0', async () => {
  const outcomes = await runPool(AC7_COMMANDS, AC7_CONCURRENCY);

  for (const outcome of outcomes) {
    const spec = AC7_COMMANDS.find((entry) => entry.label === outcome.label);
    const tally = spec?.tally == null ? null : spec.tally.exec(outcome.output);
    const absentMarkers =
      spec === undefined ? [] : spec.markers.filter((marker) => !outcome.output.includes(marker));
    const ranNothing = tally !== null && Number(tally[1]) === 0;
    process.stdout.write(
      `exit=${outcome.exitCode ?? 'SKIPPED'} name=${outcome.label}` +
        `${tally === null ? '' : ` cases=${tally[1]}${ranNothing ? ' (NOTHING RAN)' : ''}`}` +
        `${absentMarkers.length === 0 ? '' : ` MISSING-MARKERS=[${absentMarkers.join(' ')}]`}` +
        `${outcome.exitCode === null ? ' gap=not-in-this-tree' : ''}` +
        ` :: ${outcome.command}\n`,
    );
  }

  assert.deepEqual(
    outcomes
      .filter((outcome) => outcome.exitCode !== null && outcome.exitCode !== 0)
      .map((outcome) => outcome.label),
    [],
    'a surface this task must not have moved is red',
  );

  // The vacuity check, one level down from the exit code: a test runner that ran nothing and a check
  // script that did not print the tally it decided on are both passes this reading refuses to count.
  const vacuous = outcomes.filter((outcome) => {
    const spec = AC7_COMMANDS.find((entry) => entry.label === outcome.label);
    if (spec === undefined || outcome.exitCode === null) return false;
    const tally = spec.tally?.exec(outcome.output);
    if (tally !== null && tally !== undefined && Number(tally[1]) === 0) return true;
    return spec.markers.some((marker) => !outcome.output.includes(marker));
  });
  assert.deepEqual(
    vacuous.map((outcome) => outcome.label),
    [],
    'a command that exited 0 without running anything (or without printing what it decided) is a vacuous pass',
  );

  // ── the arm that keeps the enumeration reading from being an echo of its own question.
  //
  // The ASR contract spec's entry above is the one reading in this list that does not RUN its
  // subject: it asks the lane's resolver to enumerate the cases the client lane collects. `vitest
  // list <path>` prints one `<path> > <describe> > <case>` line per case only when the lane's own
  // `include` (vitest.config.ts) collects the path. That command EXITS 0 WITH NO OUTPUT for a path
  // the lane does not collect (measured), so its exit code cannot tell the two apart and the
  // discriminating arm has to be the output: a path the lane does NOT collect must produce no case
  // line. Without that arm, a change that made the command echo its argument would leave the marker
  // green while measuring nothing at all.
  const SPEC_PATH = 'src/shared/asr/tests/asrContractInvariants.test.ts';
  const DECOY_PATH = 'src/shared/asr/tests/__not-collected-by-any-lane__.test.ts';

  /** The case lines vitest printed FOR ONE FILE — `list` prints them as `<file> > <describe> > <case>`. */
  const caseLinesFor = (output: string, file: string): number =>
    output.split('\n').filter((line) => line.startsWith(`${file} > `)).length;

  const specOutcome = outcomes.find((outcome) => outcome.label === SPEC_PATH);
  const specCollected =
    specOutcome !== undefined && specOutcome.exitCode === 0 && specOutcome.output.includes(SPEC_PATH);
  const specCases = specOutcome === undefined ? 0 : caseLinesFor(specOutcome.output, SPEC_PATH);

  const decoyOutcome = await runCommand({
    label: DECOY_PATH,
    command: 'npx',
    args: ['vitest', 'list', DECOY_PATH],
    tally: null,
    markers: [],
  });
  const decoyEchoed = decoyOutcome.output.includes(DECOY_PATH);
  const decoyCases = caseLinesFor(decoyOutcome.output, DECOY_PATH);

  process.stdout.write(
    `ac7-collection: spec-collected=${String(specCollected)} spec-cases=${specCases} ` +
      `control-exit=${decoyOutcome.exitCode ?? 'SKIPPED'} control-echoed=${String(decoyEchoed)} ` +
      `control-cases=${decoyCases} ` +
      `(the spec itself is executed by the client lane — scripts/test.sh's client phase records its ` +
      `per-file passed=false and reds the suite; AC7 does not start a second vitest for it)\n`,
  );

  assert.equal(
    specCollected,
    true,
    `the client lane's resolver must name ${SPEC_PATH} as a spec it collects; it exited ` +
      `${specOutcome?.exitCode ?? 'never ran'} and said ${firstLine(specOutcome?.output ?? '')}`,
  );
  assert.ok(
    specCases > 0,
    `${SPEC_PATH} is collected by the lane but vitest enumerated no case in it (${specCases} case ` +
      `lines), so "collected" would be a reading about an empty spec`,
  );
  assert.equal(
    decoyEchoed,
    false,
    `the enumeration reading echoed a path the lane does not collect (${DECOY_PATH}), so it is not ` +
      `reading the lane's include set`,
  );
  assert.equal(
    decoyCases,
    0,
    `the enumeration reading produced case lines for a path the lane does not collect ` +
      `(${DECOY_PATH}), so its case count is not read out of the lane's include set`,
  );

  // ── AC7's `server/**` criteria: still present, and still inside the suite's own collection.
  //
  // The `tsx --test` re-runs this case used to make are gone (the suite's server phase runs them);
  // what remains is the falsifiable part of that spawn — a criterion renamed or deleted, or moved out
  // of the glob the suite collects, is still a red here. `optional` is preserved: an absent optional
  // surface is counted as a named gap rather than passed over.
  const collected = collectedServerTests();
  const absent: string[] = [];
  const uncollected: string[] = [];
  let optionalAbsent = 0;
  for (const entry of AC7_COLLECTED_CRITERIA) {
    if (!existsSync(path.join(WORKTREE_ROOT, entry.path))) {
      if (entry.optional === true) optionalAbsent += 1;
      else absent.push(entry.path);
    } else if (!collected.has(entry.path)) {
      uncollected.push(entry.path);
    }
  }
  process.stdout.write(
    `ac7-criteria: named=${AC7_COLLECTED_CRITERIA.length} ` +
      `collected-by-suite=${AC7_COLLECTED_CRITERIA.length - absent.length - uncollected.length - optionalAbsent} ` +
      `absent=[${absent.join(' ')}] uncollected=[${uncollected.join(' ')}] ` +
      `optional-absent=${optionalAbsent} ` +
      `(each is executed by the suite's own server phase — scripts/test.sh's find over ` +
      `server/**/*.test.ts — so this reading asserts presence and collection, not a re-run)\n`,
  );
  assert.deepEqual(absent, [], 'a criterion AC7 names is missing from the tree');
  assert.deepEqual(
    uncollected,
    [],
    'a criterion AC7 names exists but is outside the set scripts/test.sh collects, so the suite would no longer run it',
  );
});

// ── AC8's drift: the alignment construct is what makes the compiler the second reader ─────────

/**
 * The union member the drift case deletes.
 *
 * The anchor carries its newline so the deletion removes the whole line and leaves the union a valid
 * type with one member fewer — the drift AC8 describes is a vocabulary the compiler and the runtime
 * list disagree about, not a file that stopped parsing.
 */
const DRIFT_ANCHOR = "  | 'NO_SPEECH_DETECTED'\n";

/** The code the drift deletes, for the attribution assertions below. */
const DRIFT_CODE = 'NO_SPEECH_DETECTED';

test('AC8: deleting a union member is a compile error, under the project\'s own options', async () => {
  const basePath = path.join(SCRATCH_DIR, `drift-base${OWN_TEMP_SUFFIX}.ts`);
  const mutantPath = path.join(SCRATCH_DIR, `drift-mut${OWN_TEMP_SUFFIX}.ts`);
  const baseConfig = path.join(SCRATCH_DIR, `tsconfig.drift-base${OWN_TEMP_SUFFIX}.json`);
  const mutantConfig = path.join(SCRATCH_DIR, `tsconfig.drift-mut${OWN_TEMP_SUFFIX}.json`);

  mkdirSync(SCRATCH_DIR, { recursive: true });
  try {
    const shippingText = readFileSync(SHIPPING_REGISTRY_MODULE, 'utf8');
    const anchorCount = shippingText.split(DRIFT_ANCHOR).length - 1;
    assert.equal(anchorCount, 1, `the drift anchor occurs ${anchorCount} times in the shipping registry`);

    const driftedText = shippingText.replace(DRIFT_ANCHOR, '');
    assert.notEqual(driftedText, shippingText, 'the drift deletion did not change the registry');
    assert.equal(
      RE_ROOTED.shippingOf(RE_ROOTED.copyOf(driftedText)),
      driftedText,
      'the drift copy differs from the drifted text by more than its imports',
    );

    writeFileSync(basePath, RE_ROOTED.copyOf(shippingText), 'utf8');
    writeFileSync(mutantPath, RE_ROOTED.copyOf(driftedText), 'utf8');

    // The project's OWN compiler options, with only the file list changed: `extends` the server
    // config, and include the one arm. `exclude` is emptied because the server config's excludes are
    // paths this arm must not inherit an opinion about.
    const writeConfig = (configPath: string, armPath: string): void => {
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            extends: '../../server/tsconfig.json',
            include: [`./${path.basename(armPath)}`],
            exclude: [],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    };
    writeConfig(baseConfig, basePath);
    writeConfig(mutantConfig, mutantPath);

    const base = await runCommand({
      label: 'tsc/drift-base',
      command: 'npx',
      args: ['tsc', '--noEmit', '-p', baseConfig],
      tally: null,
      markers: [],
    });
    const mutant = await runCommand({
      label: 'tsc/drift-mutant',
      command: 'npx',
      args: ['tsc', '--noEmit', '-p', mutantConfig],
      tally: null,
      markers: [],
    });

    const reds = mutant.exitCode !== 0;
    const namesTheCode = mutant.output.includes(DRIFT_CODE);
    const namesTheAlignmentType = mutant.output.includes('AsrErrorCode');
    process.stdout.write(
      `alignment=ASR_ERROR_CODE_ALIGNMENT typecheck-reds-on-drift=${String(reds)} ` +
        `baseExit=${base.exitCode} mutantExit=${mutant.exitCode} ` +
        `names-the-deleted-code=${String(namesTheCode)} names-the-alignment-type=${String(namesTheAlignmentType)} ` +
        `arm=tsc --noEmit -p <scratch>/tsconfig.<arm>.json (extends server/tsconfig.json, the project's own ` +
        `options; the shipping tree's own npm run typecheck is AC7's reading above) ` +
        `first-error=${firstLine(mutant.output).slice(0, 240)}\n`,
    );

    // The base arm is the self-check on the option set: the same copy, compiled the same way, with the
    // vocabulary intact, must be green — otherwise a mutant red could have been produced by the flags
    // rather than by the drift.
    assert.equal(
      base.exitCode,
      0,
      `the unmutated registry copy must compile under the project's own options before a mutant red ` +
        `means anything; it exited ${base.exitCode} with ${firstLine(base.output)}`,
    );
    assert.equal(
      reds,
      true,
      `deleting '${DRIFT_CODE}' from the union while the alignment record keeps its key must fail the ` +
        `compiler; the mutant exited ${mutant.exitCode}`,
    );
    assert.equal(
      namesTheCode,
      true,
      `the compiler's red must name the deleted code (${DRIFT_CODE}); it said ${firstLine(mutant.output)}`,
    );
    assert.equal(
      namesTheAlignmentType,
      true,
      `the compiler's red must name the alignment type it is checked against; it said ${firstLine(mutant.output)}`,
    );
  } finally {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  }
});

test('AC6: the temp copies and the scratch directory are gone and git status gained nothing', () => {
  const remains = existsSync(SCRATCH_DIR);
  const porcelain = gitStatusPorcelain();
  const lines = porcelain.split('\n').filter((line) => line !== '');
  const ownLeftovers = lines.filter(isOwnTempCopy);
  const delta = snapshotDelta(PRE_RUN_PORCELAIN, porcelain);
  const differing = [...delta.onlyBefore, ...delta.onlyAfter];
  // Every differing line is some OTHER process's in-flight temp copy (the sibling criteria in this
  // suite write theirs while this file runs) => this run changed nothing.
  const concurrentOnly =
    differing.length > 0 && differing.every((line) => isTempCopy(line) && !isOwnTempCopy(line));
  const unchanged = differing.length === 0 || concurrentOnly;

  process.stdout.write(
    `falsify/leftovers: scratch-remains=${String(remains)} own-temp-copies=${ownLeftovers.length === 0 ? 'none' : ownLeftovers.join(' ')} ` +
      `git-unchanged=${String(unchanged)} ` +
      `concurrent-foreign-copies=${String(differing.filter(isTempCopy).length)}\n`,
  );

  assert.equal(remains, false, `the scratch directory ${SCRATCH_DIR} was left behind`);
  assert.deepEqual(ownLeftovers, [], 'this run left temp copies behind');
  assert.equal(
    unchanged,
    true,
    `this run changed the worktree's git status: ${differing.map(firstLine).join(' | ')}`,
  );
});
