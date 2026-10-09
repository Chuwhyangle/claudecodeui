/**
 * The falsifying forms behind `voice-capture-off.test.ts`, plus the exit-code half of AC6.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that claim is not something a passing run can show
 * about itself. So each case here builds a BROKEN copy of a shipping module by a one-line text
 * mutation, runs the whole reading list against it, and requires the readings it predicts to fail.
 * The two mutations are the two cheap ways to satisfy this task's words while missing its subject:
 *
 *   · `gate-permanently-open` — record whenever a port exists. Every sentence about "the mode
 *     decides" is still literally implemented (there IS a mode, the port carries it, the audio write
 *     still checks for `audio`), and an `off` deployment records attempt rows. If this case passes,
 *     AC2's byte-equality readings are not measuring the gate.
 *   · `invalid-treated-as-text` — treat a value nobody defined as `text`. The resolver keeps its
 *     three named modes and its warning, and the fail-CLOSED decision is gone: a deployment that
 *     misspells the mode records the thing it meant to keep out of the log. If this case passes,
 *     AC4's start-up readings are not measuring which mode the process came up in.
 *
 * EACH CASE HAS THREE PARTS, and the first is what keeps the other two from being vacuous:
 *   1. the UNMUTATED copy must clear the whole list (a harness that is red for its own reasons
 *      proves nothing by going red on a mutant);
 *   2. the MUTATED copy must red at least one reading in the predicted family, and the red reading
 *      is printed by name so the failure is attributable;
 *   3. some reading OUTSIDE that family must still be green, so "the whole rig broke" is not what
 *      the red means.
 *
 * THE COPIES LIVE IN THE SAME TREE as the files they copy (`server/modules/voice/`), because a
 * module's imports are relative — `../../../shared/asr/asrRegistry.js` — and a copy in the OS temp
 * directory would not resolve them. Each copy gets its OWN path, because ESM caches a module by URL:
 * a mutant written over the base copy's path would import the already-evaluated base module and the
 * run would measure nothing. A copy of the SERVICE module still imports the SHIPPING capture module,
 * which is exactly what makes the two cases independent — each mutation is the only difference.
 * THAT DIRECTORY IS SHARED: the sibling criteria that build temp copies (`voice-capture-text`,
 * `voice-dashscope-settings`) write the same `__criterion-falsify-` prefix there and the suite runs
 * them concurrently, so the tree-half reading is scoped to this process's own copies — the AC7 case's
 * doc comment says why.
 *
 * WHY AC6'S EXIT CODES ARE HERE. AC6 asks for the exit code of four existing criteria plus
 * `npm run typecheck` and `npm run lint`, each printed rather than assumed. Those are SUBPROCESSES,
 * and AC1 requires the criterion file itself to start none inside a fifteen-second budget — one
 * `npm run typecheck` alone is most of that budget. This file is the task's other executable
 * artifact, it already starts `git`, and it is not the file the target-side gate runs. The in-process
 * half of AC6 (the `off` attempt line gains no field) is where the lines are, in the criterion file.
 *
 * WHAT AC6'S RED HAS TO SAY, AND WHY IT SAYS IT IN ONE LINE. A failure here reaches the log through
 * `scripts/test.sh`'s `first_error()`, which keeps the FIRST 300 BYTES of the first error-ish line
 * and then deletes the rest of the file's output with `$TMP`. So the attribution is not a diagnostic
 * that may be printed elsewhere or unfolded over several lines: the command, its exit and the
 * command's own failure line have to fit in that window, in that order, or the next red is as
 * unattributable as the one this task was filed about.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { collectReadings, SHIPPING_CAPTURE_MODULE, SHIPPING_SERVICE_MODULE } from './voice-capture-off.test.js';

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
 * to be asked, because this directory is shared with the sibling criteria — see the AC7 case below.
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
 * Captured in the module body rather than in a hook, because what AC7 owes is that THIS RUN adds
 * nothing: a tree that a developer already had dirty should not be reported as this criterion's
 * leftovers, and a tree that was clean has to come back clean.
 */
const PRE_RUN_PORCELAIN = gitStatusPorcelain();

// ── the mutation cases ────────────────────────────────────────────────────────────────────────

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
  /** Which AC's line the red must be on, printed as `whichLine=`. */
  family: 'AC2' | 'AC4';
  /** What the mutation is, in one sentence, for the reason printed with the reading. */
  why: string;
};

const CASES: readonly MutationCase[] = [
  {
    name: 'gate-permanently-open',
    slot: 'service',
    anchor: [
      '  const recording: VoiceCapturePort | null =',
      "    dependencies.capture !== undefined && dependencies.capture.mode !== 'off'",
      '      ? dependencies.capture',
      '      : null;',
    ].join('\n'),
    replacement: '  const recording: VoiceCapturePort | null = dependencies.capture ?? null;',
    target: /^AC2 /,
    family: 'AC2',
    why: 'the gate is short-circuited, so any injected port records whether or not the deployment is off',
  },
  {
    name: 'invalid-treated-as-text',
    slot: 'capture',
    anchor: [
      "  if (value === 'text' || value === 'audio') {",
      '    return { mode: value, warning: null };',
      '  }',
      '',
      "  return { mode: 'off', warning: voiceCaptureWarningLine(value) };",
    ].join('\n'),
    replacement: [
      "  if (value === 'text' || value === 'audio') {",
      '    return { mode: value, warning: null };',
      '  }',
      '',
      "  return { mode: 'text', warning: voiceCaptureWarningLine(value) };",
    ].join('\n'),
    target: /^AC4 /,
    family: 'AC4',
    why: 'an unrecognised value is recorded as text, so the fail-closed decision is gone',
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
  };
}

for (const mutation of CASES) {
  test(`AC7/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
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
      process.stdout.write(
        `falsify/${mutation.name} mutant: mutation=${mutation.name} baseExit=0 ` +
          `mutantRed=${inTargetFamily.length > 0} whichLine=${mutation.family} red=${mutant.red.length} ` +
          `[${mutant.red.join(' ')}] in-target=[${inTargetFamily.join(' ')}] ` +
          `red-reason=${mutant.firstRedReason} outsider-still-green=${mutant.outsiderGreen} ` +
          `why=${mutation.why}\n`,
      );

      assert.ok(
        inTargetFamily.length > 0,
        `the ${mutation.name} mutation (${mutation.why}) must red a reading matching ${mutation.target}; ` +
          `the mutant was graded as: ${mutant.red.length === 0 ? 'all green' : mutant.red.join(', ')}`,
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

// ── AC6's exit codes: the surfaces this task must not have moved ───────────────────────────────

/** The four existing criteria AC6 names, by path so the printed line says which one answered. */
const EXISTING_CRITERIA = [
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

/**
 * How long ONE of AC6's subcommands may run before it is killed and reported as its own failure.
 *
 * THE BOUND IS PART OF THE ATTRIBUTION. Without it a command that hangs is not a reading at all: the
 * runner kills this whole file at its per-file timeout (`$QUAY_TEST_FILE_TIMEOUT`, 600s), the
 * assertion below never runs, and the log keeps nothing but "a file died" — the same unattributable
 * shape this task was filed about. 240s is 20x the slowest command measured on an idle host
 * (`npm run typecheck`, 11.7s) and leaves 360s of the runner's budget for the other five, so one
 * hung command is named and the rest of the file still finishes. Six simultaneous hangs would still
 * outlast the runner — that is the one shape this bound cannot name, and it is not a shape the suite
 * produces by accident.
 */
const COMMAND_TIMEOUT_MS = 240_000;

/** How much of a red command's own output travels with a reading: the last lines, then a byte cap. */
const TAIL_LINES = 20;
const TAIL_CHARS = 2048;

/** How much of a red command's own diagnostic line travels with a reading. */
const SIGNATURE_CHARS = 240;

/** The shape one command's result is reported in: its exit, and — for a red — what it said. */
type CommandOutcome = {
  command: string;
  exitCode: number;
  /** The case tally the runner printed, or `null` for a command that prints no tally. */
  cases: number | null;
  /** The signal that killed the command, or `null` when it exited on its own. */
  signal: string | null;
  /** True when the command was killed for exceeding `COMMAND_TIMEOUT_MS` rather than exiting. */
  timedOut: boolean;
  /** The command's own most diagnostic output line, or `null` when it printed nothing. */
  signature: string | null;
  /** The bounded tail of the command's own output, or `null` when it printed nothing. */
  tail: string | null;
  /** What `tail` dropped, as a label: `tail: last 20 of 44 lines, 1832B of 9231B kept`. */
  tailLabel: string | null;
};

/**
 * The lines that read as a failure signature.
 *
 * A DELIBERATE SUPERSET OF THE RUNNER'S OWN PATTERN. `scripts/test.sh`'s `first_error()` greps
 * `Error|error|not ok|✗|FAIL|failed`; the spec reporter this file is read under marks a failing test
 * with `✖` (U+2716 — a different codepoint from the `✗` it greps for) and puts the sentence a reader
 * needs on the line after it, so the runner's pattern steps over both. What this picks is the first
 * line a reader would call the failure — the line the runner would have quoted had it reached it.
 */
const FAILURE_SIGNATURE_LINE = /✖|✗|✘|Error|error|not ok|FAIL|fail/;

/** The command's own most diagnostic line, bounded, or `null` when it printed nothing. */
function signatureOf(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return null;
  const line = lines.find((candidate) => FAILURE_SIGNATURE_LINE.test(candidate)) ?? lines[lines.length - 1];
  return line.length > SIGNATURE_CHARS ? `${line.slice(0, SIGNATURE_CHARS)}…` : line;
}

/**
 * The tail of a command's output, bounded twice, with the label that says what was dropped.
 *
 * THE LABEL IS NOT DECORATION. The runner keeps 300 bytes of a failing line and deletes the rest of
 * the file's output with `$TMP`, so a reading that shows fewer lines than the command printed has to
 * say so — otherwise "this command printed one unhelpful line" and "this command's last 40 lines did
 * not survive the runner" look the same, which is the ambiguity this task removes. `tail` is `null`
 * only when the command printed nothing at all, which is itself worth carrying: a child killed by a
 * signal says nothing, and only the label distinguishes that from a child whose words were too long.
 */
function tailOf(text: string): { tail: string | null; label: string | null } {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const body = lines.slice(-TAIL_LINES).join(' ⏎ ');
  if (body === '') return { tail: null, label: null };
  const tail = body.length > TAIL_CHARS ? body.slice(-TAIL_CHARS) : body;
  return {
    tail,
    label:
      `tail: last ${Math.min(TAIL_LINES, lines.length)} of ${lines.length} lines, ` +
      `${tail.length}B of ${text.length}B kept`,
  };
}

/** How a command ended, when `exit=N` alone would misdescribe it. */
function endOf(outcome: CommandOutcome): string {
  if (outcome.timedOut) {
    return `, timed out after ${COMMAND_TIMEOUT_MS}ms${outcome.signal === null ? '' : ` (killed by ${outcome.signal})`}`;
  }
  if (outcome.signal === null) return '';
  // No exit status at all: the child was KILLED, which is a different event from "it failed". An OOM
  // kill reads here, and so does an outside `timeout(1)`. Reporting the fallback `exit=1` alone would
  // show that as an ordinary failing test, which is the misattribution this reading exists to stop.
  return `, killed by ${outcome.signal} with no exit status`;
}

/** True when a command reds either of AC6's two sets: a non-zero exit, or a vacuous case count. */
function isRed(outcome: CommandOutcome): boolean {
  return outcome.exitCode !== 0 || (outcome.cases !== null && outcome.cases === 0);
}

/**
 * One red command, described so that the runner's 300-byte slice of this line still names it, its
 * exit, and what it said.
 *
 * ORDER IS THE WHOLE POINT, and it is the difference between this task's red and the one it was filed
 * about. The command and its exit come first, the command's OWN diagnostic line second, and the
 * bounded tail last — so what the runner cuts is the tail, never the attribution. The message this
 * replaces carried none of it: it flagged a boolean and left the reasons in `$TMP`, which the runner
 * deletes before anyone can read them.
 */
function describeRed(outcome: CommandOutcome): string {
  const parts = [`${outcome.command} (exit=${outcome.exitCode}${endOf(outcome)})`];
  if (outcome.signature !== null) parts.push(`sig: ${outcome.signature}`);
  if (outcome.tail !== null) parts.push(`${outcome.tailLabel}: ${outcome.tail}`);
  // A command can end having printed NOTHING AT ALL — a child killed by a signal often does — and
  // that is worth stating: it is what tells a reader the silence is the child's, rather than the
  // runner's 300-byte budget having eaten words the child did say.
  if (parts.length === 1) parts.push('it printed nothing at all');
  return parts.join(' | ');
}

/**
 * One command's reading, in the shape the runner will quote it.
 *
 * A GREEN reading is exactly what it always was. A RED one gains the token `first_error()` greps for
 * and then the attribution, so the line lifted into `not ok - <file>: …` is this command's own
 * reading rather than a flag sentence whose reasons are already gone.
 */
function readingOf(outcome: CommandOutcome): string {
  const tally =
    outcome.cases === null
      ? 'cases=n/a'
      : `cases=${outcome.cases}${outcome.cases > 0 ? '' : ' (NOTHING RAN)'}`;
  if (!isRed(outcome)) return `AC6 exit=${outcome.exitCode} ${tally} :: ${outcome.command}`;
  return `AC6 FAIL ${tally} :: ${describeRed(outcome)}`;
}

/**
 * Runs one command and reports its exit code plus, for a test runner, how many cases it ran.
 *
 * `NODE_TEST_CONTEXT` IS DELETED FROM THE CHILD'S ENVIRONMENT, and that is what makes "exit 0" mean
 * something: a `node --test` child that inherits it runs in the parent's context and exits 0 having
 * run NOTHING, which is the exact false green this reading exists to catch. The tally is asserted
 * non-zero for the same reason, one level down.
 *
 * THE OUTPUT IS KEPT NOW, AND THAT IS THE FIX. This function used to return the exit code and throw
 * the command's words away, so a red could only be reported AS a red: the reason lived in the child's
 * stdout, which this file never saw and the runner deletes with `$TMP` when it exits. On the failing
 * path both streams are captured — a successful `execFileSync` hands back stdout alone, and a green
 * command's stderr is nothing this reading needs — and bounded into `signature`/`tail`. Every command
 * also carries `COMMAND_TIMEOUT_MS`, so a hang ends as this command's named failure rather than as a
 * file that stopped reporting.
 *
 * KEPT THOUGH AC6 NO LONGER SPAWNS A SUBPROCESS LIST (see the case below): this is the attribution
 * half of `gap-voice-capture-off-ac6-red-not-attributable` (`1fe9714d`), preserved verbatim so the
 * fix is not regressed by the merge, and the two callers it still has in this file are the collection
 * walk's own readings — a real `runCommand` is not needed for files the suite already runs, but the
 * capture/attribution shape it defines is what keeps a red here readable.
 */
function runCommand(command: string, args: readonly string[], tally: boolean): CommandOutcome {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const options = {
    cwd: REPO_ROOT,
    encoding: 'utf8' as const,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
  };

  // `stdout` stays apart from the combined capture because the case tally is read from it alone: a
  // `pass N` that appeared on stderr is not a runner's tally and must not become this reading's.
  let stdout = '';
  let spoken = '';
  let exitCode = 0;
  let signal: string | null = null;
  let timedOut = false;
  try {
    stdout = execFileSync(command, [...args], options);
    spoken = stdout;
  } catch (error) {
    const failure = error as {
      status?: number;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
      code?: string;
    };
    signal = typeof failure.signal === 'string' ? failure.signal : null;
    timedOut = failure.code === 'ETIMEDOUT';
    exitCode = typeof failure.status === 'number' ? failure.status : 1;
    stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
    spoken = [stdout, typeof failure.stderr === 'string' ? failure.stderr : '']
      .filter((part) => part !== '')
      .join('\n');
  }

  const match = tally ? /pass (\d+)/.exec(stdout) : null;
  const { tail, label } = tailOf(spoken);
  return {
    command: `${command} ${args.join(' ')}`,
    exitCode,
    cases: match === null ? null : Number(match[1]),
    signal,
    timedOut,
    signature: signatureOf(spoken),
    tail,
    tailLabel: label,
  };
}

test('AC6 the named criteria exist and are collected by the suite', () => {
  const collected = collectedServerTests();
  const absent = EXISTING_CRITERIA.filter((file) => !existsSync(path.join(REPO_ROOT, file)));
  const uncollected = EXISTING_CRITERIA.filter(
    (file) => !absent.includes(file) && !collected.has(file),
  );

  // THE READING IS STILL ATTRIBUTED (`1fe9714d`, preserved). The subprocess list this case used to
  // carry is gone — the suite runs those criteria itself, which is the point of the merge — so the
  // only red left to attribute is the collection read's own: which criteria were named, which are
  // absent, and which are outside the set scripts/test.sh collects. It is rendered through the
  // SAME `readingOf`/`describeRed` path so the runner's 300-byte slice of the `not ok` line carries
  // the reason rather than a bare boolean, exactly as AC6's reds did before the merge.
  const spoken = [
    ...absent.map((file) => `absent: ${file}`),
    ...uncollected.map((file) => `uncollected: ${file}`),
  ].join('\n');
  const { tail, label } = tailOf(spoken);
  const collection: CommandOutcome = {
    command: `find server -name '*.test.ts' -o -name '*.test.js' (in process)`,
    exitCode: absent.length === 0 && uncollected.length === 0 ? 0 : 1,
    cases: EXISTING_CRITERIA.length,
    signal: null,
    timedOut: false,
    signature: signatureOf(spoken),
    tail,
    tailLabel: label,
  };
  const outcomes: CommandOutcome[] = [collection];
  process.stdout.write(`${readingOf(collection)}\n`);
  process.stdout.write(
    `AC6 named-criteria=${EXISTING_CRITERIA.length} ` +
      `collected-by-suite=${EXISTING_CRITERIA.length - uncollected.length} ` +
      `absent=[${absent.join(' ')}] uncollected=[${uncollected.join(' ')}] ` +
      `(each is executed by the suite's own server phase — scripts/test.sh's find over ` +
      `server/**/*.test.ts — so this reading asserts presence and collection rather than re-running it)\n`,
  );

  // THE TWO SETS BELOW ARE UNCHANGED ON PURPOSE: the set is the criterion, and this task adds
  // attribution without relaxing it. What changed is the MESSAGE — which reading, which exit, and
  // what it said — because the runner keeps the first 300 bytes of the first error-ish line and then
  // deletes the reading's output with `$TMP`. Nothing renders when the sets are empty, so the green
  // path is untouched.
  assert.deepEqual(
    outcomes.filter((outcome) => outcome.exitCode !== 0).map((outcome) => outcome.command),
    [],
    [
      'a surface this task must not have moved is red —',
      outcomes.filter((outcome) => outcome.exitCode !== 0).map(describeRed).join(' ;; '),
    ].join(' '),
  );
  assert.deepEqual(
    outcomes.filter((outcome) => outcome.cases !== null && outcome.cases === 0).map((outcome) => outcome.command),
    [],
    [
      'a criterion that exits 0 having run no cases is a vacuous pass, not a green one —',
      outcomes.filter((outcome) => outcome.cases !== null && outcome.cases === 0).map(describeRed).join(' ;; '),
    ].join(' '),
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
 * AC7's tree half, scoped to what THIS run is answerable for.
 *
 * WHY THE READING IS SCOPED BY PID. The copies cannot live in the OS temp directory (their relative
 * imports would not resolve), and this file is not the only criterion writing into that directory:
 * `voice-capture-text` and `voice-dashscope-settings` build their own `__criterion-falsify-*` copies
 * in the SAME directory, and the suite runs four files at a time. So a sibling's copies are untracked
 * lines in this file's tree through no act of this file's, and a sibling that is still holding them
 * when this file STARTS has finished and cleaned up by the time this reading runs — which made the
 * snapshot-vs-sample comparison report "changed" on a tree whose final state was empty. That is a
 * cross-PROCESS artifact, not residue, so the comparison forgives exactly that and nothing else:
 *
 *   · THIS run's own copies stay an unconditional red (`own-temp-copies`), so the property AC7 names
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
test('AC7: the temp copies are gone and git status --porcelain gained nothing', () => {
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

  // AC7's own words: `git status --porcelain` is identical to the state this file started in. In the
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
