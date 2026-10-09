/**
 * The falsifying forms behind `voice-capture-audio.test.ts`, plus the exit-code half of AC8.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red, and that claim is not something a passing run can show about
 * itself. So each case here builds a BROKEN copy of the capture module by a text mutation, runs the
 * whole reading list against it, and requires the readings it predicts to fail — by name, and with
 * the FIGURE that went wrong, so the red is attributable to a clause rather than to a reading. The
 * four mutations are the cheap ways to satisfy this task's words while missing its subject:
 *
 *   · (i) `write-in-text-too` — drop the mode from the write guard, so every deployment that records
 *     a row also writes a file. Every word about "the upload is written to a file" is still
 *     implemented, and the mode that must write NOTHING writes. If this case passes, AC6's
 *     `text.dirCreated`/`text.writeCalls` are not measuring the gate.
 *   · (ii-a) `bytes-truncated` — write the first half of the upload. A file is still created, at the
 *     resolved path, with the promised permissions, and its digest is a real sha256 of real bytes.
 *     If this case passes, AC3's `lenEqual`/`bytesEqual`/`shaMatch` are not measuring the bytes.
 *   · (ii-b) `bytes-base64-text` — write the base64 TEXT of the upload rather than the upload. This
 *     is the encode-conversion road: a deployment that "stores the audio" as a text field would pass
 *     every existence and permission reading and fail this one.
 *   · (iii) `no-permission-setting` — create the directory and the file with no permission argument
 *     and no `chmod`. See THE FORM THIS TASK NAMES THAT IS NOT REACHABLE below for why this is the
 *     reachable mutation and not the `mode:`-only one the AC names.
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
 * copies therefore live beside the module they copy, under `server/modules/voice/`, which is the same
 * tree and the only place a copy resolves at all. Each copy gets its OWN path, because ESM caches a
 * module by URL: a mutant written over the base copy's path would import the already-evaluated base
 * module and the run would measure nothing. The criterion IMPORTS the capture module by path and
 * hands the resulting port and write-audio factory to the shipping service, so the mutation is the
 * only difference between the two arms of a case.
 *
 * THE FORM THIS TASK NAMES THAT IS NOT REACHABLE, and what stands in for it.
 *
 * The AC asks for a case named `mode-only-no-chmod`: delete the explicit `chmod` and keep the `mode:`
 * argument to `open`, and it must red AC4's `dirMode`/`fileMode` under `umask 0o000`. IT CANNOT, and
 * not because of anything this module does: `mode:` is an argument to `open(2)`/`mkdir(2)` and the
 * kernel applies `mode & ~umask` to it, so a umask can only ever CLEAR bits from the requested mode.
 * `0o700 & ~umask` is a subset of `0o700` for every umask, and it is exactly `0o700` at the umask
 * this criterion runs under — which is the umask chosen precisely so that nothing is masked. A
 * `mode:`-only implementation and a `mode:`-plus-`chmod` implementation therefore read IDENTICALLY
 * at `umask 0o000`, and the case the AC describes would pass while measuring the opposite of what it
 * claims. There is no umask that separates them, so this is a property of the reading rather than a
 * fixture that could be built better.
 *
 * What the reading DOES separate is "sets the permission bits this deployment promises" from "sets
 * none", which is a real and reachable implementation: with no `mode:` argument and no `chmod`, the
 * directory lands at `0777` and the file at `0666` under `umask 0o000`. That is the mutation below.
 * The `chmod` this task ships is therefore justified by the API's contract and by the AC's own words
 * rather than by this case — registered here so a reader does not take the case as evidence for a
 * separation it cannot make.
 *
 * THE OTHER NAMED FORM THAT IS A NO-OP, registered for the same reason. The AC offers
 * `Buffer.from(bytes.toString('base64'), 'base64')` as one of the re-encodings AC3 must catch. For
 * EVERY byte string that expression is the IDENTITY — base64 decoding is the exact inverse of base64
 * encoding, padding included — so as a mutation it changes no byte of the file and cannot red
 * anything. `bytes-base64-text` above is the reachable form of the same idea (the encode happens,
 * nothing decodes it back), and `bytes-truncated` is the other road the AC names.
 *
 * WHY AC8'S EXIT CODES ARE HERE. AC8 asks for the exit code of seven existing criteria plus
 * `npm run typecheck` and `npm run lint`, each printed rather than assumed. Those are SUBPROCESSES,
 * and AC1 requires the criterion file itself to start none inside a fifteen-second budget — one
 * `npm run typecheck` alone is most of that budget. This file is the task's other executable artifact,
 * it already starts `git`, and it is not the file AC1's budget is about.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  collectReadings,
  SHIPPING_CAPTURE_MODULE,
  SHIPPING_MODULE_ROOT,
  SHIPPING_SERVICE_MODULE,
} from './voice-capture-audio.test.js';

/** Where the mutated copies go: beside the module, so its relative imports still resolve. */
const VOICE_DIR = path.dirname(SHIPPING_CAPTURE_MODULE);
const REPO_ROOT = path.resolve(VOICE_DIR, '../../..');

/** The prefix every temp copy carries, so "nothing was left behind" is a pattern rather than a guess. */
const TEMP_PREFIX = '__criterion-falsify-';

/** AC-143's criterion, which this task must not have moved. */
const OFF_CRITERION = 'server/modules/voice/tests/voice-capture-off.test.ts';

/** `git status --porcelain` for the worktree, as one string. */
function gitStatusPorcelain(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** The first line of a string, for printing something bounded. */
function firstLine(value: string): string {
  return value.split('\n').find((line) => line !== '') ?? '(empty)';
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
  /** Which module the mutation goes into. Always `capture` here; named so a case can say otherwise. */
  slot: 'capture' | 'service';
  /** The readings this case is allowed to red. Anything outside is a rig failure. */
  target: RegExp;
  /** The readings the case predicts, for the printed line. */
  family: string;
  edits: readonly Edit[];
  expects: readonly Expectation[];
  why: string;
};

/**
 * The write guard, the two permission sites and the byte argument — the four lines every mutation
 * below rewrites. Named once so a case reads as the change it makes rather than as a wall of text.
 */
const GATE = "      if (dependencies.mode === 'audio' && dependencies.audio !== undefined) {";
const MKDIR = '      mkdirSync(directory, { recursive: true, mode: CAPTURE_DIR_MODE });';
const CHMOD_DIR = '      chmodSync(directory, CAPTURE_DIR_MODE);';
/**
 * The shipping write line, re-anchored to the exclusive create this task introduced.
 *
 * The former anchor (`writeFileSync(target, audio.bytes, …)`) was the literal call at the write site;
 * the write now lives inside `writeExclusive`, whose bytes parameter is `bytes` rather than
 * `audio.bytes`, and the open carries `flag: 'wx'`. The mutations below still rewrite THIS one line,
 * so the anchor has to name the line as it now reads — and it is still unique (the only `'wx'` open in
 * the module). This is the "re-anchor the shipped-write anchor" cost the proposal registered.
 */
const WRITE = "      writeFileSync(target, bytes, { flag: 'wx', mode: CAPTURE_FILE_MODE });";
const CHMOD_FILE = '      chmodSync(target, CAPTURE_FILE_MODE);';

/**
 * The instance-salt segment of the id expression, the ONE anchor the legacy-id case removes.
 *
 * Kept as a contiguous substring of `` `${dependencies.mode}-${dependencies.instanceSalt}-${…}` `` so
 * the mutation is a single deletion rather than a rewrite of the whole return, and so it occurs
 * exactly once. See `legacy-attempt-id` below.
 */
const INSTANCE_SALT_SEGMENT = '${dependencies.instanceSalt}-';

const CASES: readonly MutationCase[] = [
  {
    name: 'write-in-text-too',
    slot: 'capture',
    target: /^AC6 /,
    family: 'AC6/text.dirCreated+text.writeCalls',
    edits: [{ anchor: GATE, replacement: '      if (dependencies.audio !== undefined) {' }],
    expects: [
      {
        reading: /^AC6 /,
        token: 'text.dirCreated=true',
        meaning: 'a deployment in a mode that writes nothing created a directory and wrote a file',
      },
      {
        reading: /^AC6 /,
        token: 'text.writeCalls=3',
        meaning: 'and it reached the write port once per attempt doing it',
      },
    ],
    why: 'the mode is dropped from the write guard, so every recording deployment writes a file',
  },
  {
    name: 'bytes-truncated',
    slot: 'capture',
    target: /^AC3 /,
    family: 'AC3/bytesEqual+lenEqual+shaMatch',
    edits: [
      {
        anchor: WRITE,
        replacement:
          '      writeFileSync(target, bytes.subarray(0, bytes.length >> 1), ' +
          "{ flag: 'wx', mode: CAPTURE_FILE_MODE });",
      },
    ],
    expects: [
      {
        reading: /^AC3 /,
        token: 'lenEqual=false',
        meaning: 'the file is a different length from the upload',
      },
      {
        reading: /^AC3 /,
        token: 'bytesEqual=false',
        meaning: 'and a different sequence of bytes',
      },
      {
        reading: /^AC3 /,
        token: 'shaMatch=false',
        meaning: 'so a digest recomputed from the file does not describe the row`s own bytes',
      },
    ],
    why: 'half the upload is written, and every existence and permission reading still passes',
  },
  {
    name: 'bytes-base64-text',
    slot: 'capture',
    target: /^AC3 /,
    family: 'AC3/bytesEqual+lenEqual+shaMatch',
    edits: [
      {
        anchor: WRITE,
        replacement:
          "      writeFileSync(target, Buffer.from(bytes.toString('base64'), 'utf8'), " +
          "{ flag: 'wx', mode: CAPTURE_FILE_MODE });",
      },
    ],
    expects: [
      {
        reading: /^AC3 /,
        token: 'bytesEqual=false',
        meaning: 'the file holds a representation of the upload rather than the upload',
      },
      {
        reading: /^AC3 /,
        token: 'lenEqual=false',
        meaning: 'and a base64 text is longer than the bytes it encodes',
      },
    ],
    why: 'the audio is stored re-encoded, which is how a "store it as a text field" deployment fails',
  },
  {
    name: 'no-permission-setting',
    slot: 'capture',
    target: /^AC4 /,
    family: 'AC4/dirMode+fileMode',
    edits: [
      // The four sites at once: the two `mode:` arguments lose their value and the two `chmod`s go.
      // See THE FORM THIS TASK NAMES THAT IS NOT REACHABLE above for why the `mode:`-only form the
      // AC names cannot be separated from the shipping one and this is the reachable replacement.
      { anchor: MKDIR, replacement: '      mkdirSync(directory, { recursive: true });' },
      { anchor: CHMOD_DIR, replacement: '' },
      { anchor: WRITE, replacement: '      writeFileSync(target, bytes);' },
      { anchor: CHMOD_FILE, replacement: '' },
    ],
    expects: [
      {
        reading: /^AC4 /,
        token: 'dirMode=0777',
        meaning: 'the directory was created with no permission bits of this deployment`s own',
      },
      {
        reading: /^AC4 /,
        token: 'fileMode=0666',
        meaning: 'and so was the recording',
      },
    ],
    why: 'nothing requests the promised bits, so under a zero umask the kernel`s defaults land',
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
 * than "AC3 is red because `bytesEqual` is false": the first is also true if the mutation broke the
 * module's import, and the second is also false if the criterion stopped reading `bytesEqual` while
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
  test(`AC9/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
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

      // ── the mutation itself. Every anchor has to be unique: a text that occurs twice would be
      // rewritten in both places, and the case would then be about two edits rather than one.
      const shippingText = await readFile(source, 'utf8');
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

// ── AC1: the attempt id is unique ACROSS PROCESSES, measured with two real children ─────────────

/** One child process's answer: the id it minted and where its bytes landed. */
type ChildAnswer = { id: string; path: string };

/** The whole cross-process reading. */
type CrossProcessReading = {
  first: ChildAnswer;
  second: ChildAnswer;
  /** Whether the two children minted different ids — the property this task adds. */
  idsDistinct: boolean;
  /** Whether their bytes landed in different files: "each can be a name that does not overwrite". */
  pathsDistinct: boolean;
  /** Whether each file holds its OWN child's bytes, so neither write clobbered the other. */
  filesIntact: boolean;
  /** The two payloads, so the reader can see which bytes each file is expected to hold. */
  payloads: { first: string; second: string };
};

/**
 * The child program, as TEXT, importing the module under test by URL.
 *
 * THE SPECIFIER IS `file:///-ABSOLUTE`, not a bare path: the child lives in a temp directory of its
 * own, so a relative import cannot reach the module, and a `file:` URL is what an ESM importer
 * resolves from anywhere. The module under test is passed in, so the SAME child program measures the
 * shipping module and a mutant.
 *
 * THE CHILD GOES THROUGH THE ASSEMBLY PATH, not through a stubbed one: it calls the shipping
 * `resolveInstanceSalt` with its OWN `process.pid` and `Date.now()`, builds the shipping port with
 * that salt, mints one id, and writes one recording through the shipping sink. That is the shape the
 * composition root wires, minus the router — so what the parent compares is two REAL process
 * instances' ids, which is the only way to see the pre-fix collision (the proposal's registered
 * criterion hole: two ports in ONE process were already distinct under the old sequence-only scheme).
 */
function crossProcessChildSource(modulePath: string): string {
  const specifier = JSON.stringify(pathToFileURL(modulePath).href);
  return [
    `import { createVoiceCapture, createVoiceCaptureAudioSink, resolveInstanceSalt } from ${specifier};`,
    `const [dir, payload] = process.argv.slice(2);`,
    `const bytes = Buffer.from(payload, 'utf8');`,
    `const lines = [];`,
    `const port = createVoiceCapture({`,
    `  mode: 'audio',`,
    `  log: { info: (message) => lines.push(message) },`,
    `  instanceSalt: resolveInstanceSalt(process.pid, Date.now()),`,
    `  audio: createVoiceCaptureAudioSink({ directory: dir }),`,
    `});`,
    `const id = port.newAttemptId();`,
    `port.recordAttempt(id, {`,
    `  providerId: 'child',`,
    `  outcome: 'ok',`,
    `  status: 200,`,
    `  audio: { bytes, mimeType: 'audio/webm', fileName: 'c.webm' },`,
    `  payload: {`,
    `    model: 'm',`,
    `    baseUrl: 'https://voice.example/v1',`,
    `    audio: { bytes, mimeType: 'audio/webm', fileName: 'c.webm' },`,
    `    upstream: null,`,
    `    requestSent: false,`,
    `    reading: { ok: true, text: '' },`,
    `  },`,
    `});`,
    `const row = lines`,
    `  .map((line) => { try { return JSON.parse(line); } catch { return null; } })`,
    `  .find((parsed) => parsed && parsed.event === 'voice.capture');`,
    `process.stdout.write(JSON.stringify({ id, path: row ? row.path : null }) + '\\n');`,
  ].join('\n');
}

/** Runs one child against `modulePath`, writing into `directory`, and reads its answer off stdout. */
function runCrossProcessChild(
  modulePath: string,
  scriptDir: string,
  directory: string,
  payload: string,
  tag: string,
): ChildAnswer {
  const scriptPath = path.join(scriptDir, `cross-process-child-${tag}-${process.pid}.ts`);
  writeFileSync(scriptPath, crossProcessChildSource(modulePath), 'utf8');

  // `NODE_TEST_CONTEXT` deleted for the same reason `runCommand` deletes it: a child that inherits it
  // would run in the parent's context rather than as its own process, and the whole reading is about
  // two SEPARATE processes.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const output = execFileSync('npx', ['tsx', scriptPath, directory, payload], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });

  let answer: ChildAnswer | null = null;
  for (const line of output.split('\n')) {
    try {
      const parsed = JSON.parse(line) as { id?: unknown; path?: unknown };
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.id === 'string') {
        answer = { id: parsed.id, path: typeof parsed.path === 'string' ? parsed.path : '' };
      }
    } catch {
      // Not this child's answer line; the child prints exactly one, but tsx may add its own output.
    }
  }
  if (answer === null) {
    throw new Error(`the cross-process child printed no answer; stdout was: ${output}`);
  }
  return answer;
}

/**
 * Drives two REAL children against one module, into one shared directory, and reports what happened.
 *
 * THE TWO PAYLOADS DIFFER, so "each file holds its own child's bytes" is a comparison that can fail
 * if one write landed where the other's did. The temp tree is this run's own and is removed in the
 * `finally`, so AC9's cleanliness reading is unaffected.
 */
function measureCrossProcess(modulePath: string): CrossProcessReading {
  const root = mkdtempSync(path.join(os.tmpdir(), 'voice-cross-process-'));
  try {
    const directory = path.join(root, 'recordings');
    mkdirSync(directory, { recursive: true });
    const payloads = { first: `child-one-${process.pid}`, second: `child-two-${process.pid}` };
    const first = runCrossProcessChild(modulePath, root, directory, payloads.first, 'one');
    const second = runCrossProcessChild(modulePath, root, directory, payloads.second, 'two');
    const bytesAt = (answer: ChildAnswer): Buffer =>
      answer.path !== '' && existsSync(answer.path) ? readFileSync(answer.path) : Buffer.alloc(0);
    return {
      first,
      second,
      idsDistinct: first.id !== second.id,
      pathsDistinct: first.path !== '' && first.path !== second.path,
      filesIntact:
        bytesAt(first).equals(Buffer.from(payloads.first, 'utf8')) &&
        bytesAt(second).equals(Buffer.from(payloads.second, 'utf8')),
      payloads,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('AC1 two real processes mint distinct attempt ids that do not overwrite each other', () => {
  const reading = measureCrossProcess(SHIPPING_CAPTURE_MODULE);
  process.stdout.write(
    `reading AC1 cross-process = p1-id=${reading.first.id} p2-id=${reading.second.id} ` +
      `idsDistinct=${String(reading.idsDistinct)} pathsDistinct=${String(reading.pathsDistinct)} ` +
      `filesIntact=${String(reading.filesIntact)} p1-path=${reading.first.path} p2-path=${reading.second.path}\n`,
  );
  assert.notEqual(
    reading.first.id,
    reading.second.id,
    'two process instances minted the SAME attempt id: an id unique only within a process is what ' +
      'makes a restart overwrite a recording that outlives it',
  );
  assert.ok(reading.pathsDistinct, 'the two processes wrote to the same path');
  assert.ok(reading.filesIntact, 'a recording did not survive byte for byte across the two processes');
});

test('AC1/legacy-attempt-id: dropping the instance salt collides two REAL processes', () => {
  const source = readFileSync(SHIPPING_CAPTURE_MODULE, 'utf8');
  const occurrences = source.split(INSTANCE_SALT_SEGMENT).length - 1;
  assert.equal(
    occurrences,
    1,
    `the instance-salt anchor occurs ${occurrences} times in the shipping module; the case names one site`,
  );

  const mutantPath = path.join(VOICE_DIR, `${TEMP_PREFIX}legacy-attempt-id-${process.pid}.ts`);
  try {
    writeFileSync(mutantPath, source.replace(INSTANCE_SALT_SEGMENT, ''), 'utf8');
    const reading = measureCrossProcess(mutantPath);
    process.stdout.write(
      `falsify/legacy-attempt-id = mutant-p1-id=${reading.first.id} ` +
        `mutant-p2-id=${reading.second.id} collided=${String(!reading.idsDistinct)}\n`,
    );
    // The false form the proposal registered: with the salt gone, both processes read `audio-1`, which
    // is exactly what the real criterion above would red on. This is the positive control that says
    // the AC1 reading is measuring the salt rather than two processes that happen to differ anyway.
    assert.equal(
      reading.first.id,
      reading.second.id,
      'the mutation was expected to make the two processes mint the SAME id, but they differed: the ' +
        'AC1 criterion may be green for a reason other than the instance salt',
    );
  } finally {
    rmSync(mutantPath, { force: true });
  }
});

// ── AC8's exit codes: the surfaces this task must not have moved ───────────────────────────────

/**
 * The seven criteria AC8 names, by path so the printed line says which one answered.
 *
 * `voice-capture-off.test.ts` is first because it is AC-143's criterion AND because this task edits
 * the one construction point that criterion reads: if this task's audio sink moved the row AC-143
 * pinned, this is the line that says so. `voice-capture-text.test.ts` is second for the same reason
 * on AC-144's side — this task changed the write-audio port's arity, and that criterion implements
 * the port twice.
 */
const EXISTING_CRITERIA = [
  'server/modules/voice/tests/voice-capture-off.test.ts',
  'server/modules/voice/tests/voice-capture-text.test.ts',
  'server/modules/voice/tests/voice.service.test.ts',
  'server/modules/voice/tests/voiceHealth.test.ts',
  'server/modules/voice/tests/voice-config.routes.test.ts',
  'server/modules/voice/tests/voiceTranscribeGaps.test.ts',
  'server/modules/voice/tests/voice-provider-dispatch.test.ts',
];

type CommandOutcome = {
  command: string;
  exitCode: number;
  /** The case tally the runner printed, or `null` for a command that prints no tally. */
  cases: number | null;
};

/**
 * Runs one command and reports its exit code plus, for a test runner, how many cases it ran.
 *
 * `NODE_TEST_CONTEXT` IS DELETED FROM THE CHILD'S ENVIRONMENT, and that is what makes "exit 0" mean
 * something: a `node --test` child that inherits it runs in the parent's context and exits 0 having
 * run NOTHING, which is the exact false green this reading exists to catch. The tally is asserted
 * non-zero for the same reason, one level down.
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
  };

  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(command, [...args], options);
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    exitCode = typeof failure.status === 'number' ? failure.status : 1;
    output = typeof failure.stdout === 'string' ? failure.stdout : '';
  }

  const match = tally ? /pass (\d+)/.exec(output) : null;
  return {
    command: `${command} ${args.join(' ')}`,
    exitCode,
    cases: match === null ? null : Number(match[1]),
  };
}

/**
 * AC8's cross-task clause, as a measurement rather than a promise.
 *
 * `process.env.VOICE_CAPTURE` is a PREFIX of `process.env.VOICE_CAPTURE_DIR`, so a bare substring
 * count of the mode variable is raised by every read of the directory variable. Both counts are
 * printed here, side by side, off the shipping composition root: the pair is the evidence that the
 * boundary form is the one a criterion has to count with, and the substring form is what a criterion
 * that counted naively would read.
 *
 * `narrowed` is whether AC-143's criterion ALREADY counts on a boundary. It does — this task found
 * the boundary form shipped — so this task does not write that count. The file is still in this
 * task's Touches for a different reason, registered here so the two are not confused: AC-143's
 * registration reading asserted `audio-sink-wired=false` outright, and wiring the sink is exactly
 * what this task does, so that assertion was narrowed to the invariant it owns (the wiring agrees
 * with the module shipping the factory) in the same edit.
 */
function crossTaskFigures(): {
  substring: number;
  token: number;
  dirReads: number;
  rawReads: number;
  narrowed: boolean;
} {
  const root = readFileSync(SHIPPING_MODULE_ROOT, 'utf8');
  const offSource = readFileSync(path.join(REPO_ROOT, OFF_CRITERION), 'utf8');
  return {
    substring: root.split('process.env.VOICE_CAPTURE').length - 1,
    token: (root.match(/process\.env\.VOICE_CAPTURE(?!_)/g) ?? []).length,
    // The two `VOICE_CAPTURE`-prefixed readers that are NOT the mode variable. Counting them here —
    // rather than assuming one — is what keeps this equation true as the composition root grows a
    // third such read: the raw switch's read is the same shape of change the directory read was.
    dirReads: (root.match(/process\.env\.VOICE_CAPTURE_DIR(?![\w$])/g) ?? []).length,
    rawReads: (root.match(/process\.env\.VOICE_CAPTURE_RAW(?![\w$])/g) ?? []).length,
    narrowed: offSource.includes('VOICE_CAPTURE(?!_)'),
  };
}

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

  // The cross-task clause, kept here because it is an in-process read of the composition root and of
  // AC-143's criterion rather than one of the subprocess re-runs this case used to carry.
  const figures = crossTaskFigures();
  process.stdout.write(
    `AC8 named-criteria=${EXISTING_CRITERIA.length} ` +
      `collected-by-suite=${EXISTING_CRITERIA.length - uncollected.length} ` +
      `absent=[${absent.join(' ')}] uncollected=[${uncollected.join(' ')}] ` +
      `(each is executed by the suite's own server phase — scripts/test.sh's find over ` +
      `server/**/*.test.ts — so this reading asserts presence and collection rather than re-running it)\n`,
  );
  process.stdout.write(
    `AC8 cross-task: envCaptureSubstring=${figures.substring} envCaptureToken=${figures.token} ` +
      `dirReads=${figures.dirReads} rawReads=${figures.rawReads} ` +
      `narrowed=${String(figures.narrowed)} ` +
      `note=[the dir read and the raw switch's read are POSITIVE EXAMPLES for the boundary count: ` +
      'the substring count is raised by each of them, the token count is not]\n',
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
  // The two figures are different, and the difference is exactly the directory reads plus the raw
  // switch's own read: this is the measurement the boundary form exists for, and a run where they
  // were equal would mean the composition root had stopped reading the directory variable at all.
  // Naming BOTH non-mode reads means a future `VOICE_CAPTURE_*` variable added without accounting for
  // it here reddens this reading rather than silently inflating the substring count.
  assert.ok(
    figures.token >= 1 && figures.substring === figures.token + figures.dirReads + figures.rawReads,
    `the composition root's VOICE_CAPTURE counts read substring=${figures.substring} token=${figures.token} ` +
      `dirReads=${figures.dirReads} rawReads=${figures.rawReads}, which is not "one mode read plus one ` +
      'read per other VOICE_CAPTURE-prefixed variable"',
  );
  assert.equal(
    figures.narrowed,
    true,
    'AC-143`s criterion no longer counts the mode variable on a boundary, so this task DID have to ' +
      'narrow that count and the registration above is wrong',
  );
});

// ── AC3/AC4: the criteria this task must not have moved ────────────────────────────────────────

/**
 * The four criteria this task's AC3 and AC4 name, by path.
 *
 * AC3 asks that the three behaviours that were already delivered are not regressed — zero files for
 * `off`/`text` and the row's fields (AC-143), the 0700/0600 permissions and the byte-identical upload
 * (AC-145), and the row's id equal to its `voice.transcribe` line's (AC-144). AC4 asks that a recorder
 * which cannot record still leaves the transcription alone and prints exactly one content-free
 * failure line (AC-147). Each is its own criterion file; this runs them as subprocesses and reads
 * their EXIT CODES, so a surface this task moved is a red here rather than a sentence.
 */
const REGRESSION_CRITERIA = [
  'server/modules/voice/tests/voice-capture-off.test.ts',
  'server/modules/voice/tests/voice-capture-text.test.ts',
  'server/modules/voice/tests/voice-capture-audio.test.ts',
  'server/modules/voice/tests/voice-capture-isolation.test.ts',
];

test('AC3/AC4 the named regression criteria still exit 0', () => {
  const outcomes: CommandOutcome[] = REGRESSION_CRITERIA.map((file) =>
    runCommand('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', '--test', file], true),
  );

  for (const outcome of outcomes) {
    const tally =
      outcome.cases === null
        ? 'cases=n/a'
        : `cases=${outcome.cases}${outcome.cases > 0 ? '' : ' (NOTHING RAN)'}`;
    process.stdout.write(`AC3/AC4 exit=${outcome.exitCode} ${tally} :: ${outcome.command}\n`);
  }

  assert.deepEqual(
    outcomes.filter((outcome) => outcome.exitCode !== 0).map((outcome) => outcome.command),
    [],
    'a criterion this task must not have moved is red',
  );
  assert.deepEqual(
    outcomes.filter((outcome) => outcome.cases === null || outcome.cases === 0).map((outcome) => outcome.command),
    [],
    'a criterion that exits 0 having run no cases is a vacuous pass, not a green one',
  );
});

/**
 * The tree half, scoped to what THIS run is answerable for.
 *
 * WHY THE READING IS SCOPED BY PID. The copies cannot live in the OS temp directory (the module's
 * relative imports would not resolve), and this file is not the only criterion writing into that
 * directory: `voice-capture-off`, `voice-capture-text`, `voice-capture-isolation`,
 * `voice-dashscope-settings` and the `voice-error-*` pair all build their own `__criterion-falsify-*`
 * copies in the SAME directory, and the suite runs several files at a time. A sibling's copy is an
 * untracked line in this file's tree through no act of this file's — and because the runs overlap, a
 * copy a neighbour is still holding when this reading runs was reported as if this run had left it
 * behind (the pre-fix reading counted ANY `__criterion-falsify-` line, so a concurrent sibling's
 * in-flight `env-only-configured` pair read as this file's residue). That is a cross-PROCESS artifact,
 * not residue, so the reading forgives exactly that and nothing else:
 *
 *   · THIS run's own copies stay an unconditional red (`own-temp-copies`), so the property the case
 *     names — no temp copy of this run survives — is asserted at full strength, and more precisely
 *     than before (the old reading reported a sibling's copies as if they were this run's);
 *   · a difference is forgiven ONLY when every line in it is a temp copy belonging to another pid.
 *     Any other added, removed or modified path — a copy of this run's, a stray file, a touched
 *     tracked file — keeps the red, and the failure prints both sides of the delta;
 *   · a foreign copy present in BOTH snapshots contributes no difference at all and needs no
 *     forgiveness.
 *
 * `temp-copies-any` and `raw-unchanged` are printed beside the scoped verdict, so what was excluded
 * is visible in the reading rather than implied by it.
 */
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
  // naming it. This is asserted before the comparison below, because it is the property the cases are
  // responsible for and it is the one that holds whether or not the tree was clean — and it is
  // scoped by PID, so a SIBLING criterion's in-flight copy is not read as this run's residue.
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
