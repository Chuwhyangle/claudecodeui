#!/usr/bin/env node
/**
 * AC-131's criterion: the command line's two offline paths, and the launch method underneath them.
 *
 *   node scripts/asr-cli-offline-check.mjs                # check this repository
 *   node scripts/asr-cli-offline-check.mjs --root <tree>  # check another tree
 *   node scripts/asr-cli-offline-check.mjs --explain-sites
 *   node scripts/asr-cli-offline-check.mjs --emit-audio <path>   # the synthetic clip, verbatim
 *
 * WHAT IS READ, AND WHAT IS NOT
 *
 * Every reading below is something the RUN produced, never something the command said about itself.
 * A `network=none` line, a `redacted=all` line or a `launch=tsx` line would all be self-reports, and
 * a self-report is exactly what a flag's own implementation is free to keep printing after it stops
 * being true. So:
 *
 *   zero network     the injected double's CALL LOG is empty. The double is a module (`--fetch-impl`)
 *                    that appends one line per invocation, so "a call happened" is observable and
 *                    its absence is a reading rather than a promise. `dry-run made N calls` / the
 *                    `offline calls=` field say how many happened when it was not zero.
 *   redaction        the criterion's own constant key does not appear in the raw stdout BYTES, no
 *                    32-byte window of the synthetic clip appears there either, and a
 *                    `sha256=<64hex>` line DOES — recomputed here from the clip on disk, so an
 *                    implementation that printed nothing scores the same as one that never read the
 *                    file. That third half is what makes the first two mean "redacted" rather than
 *                    "silent".
 *   replay           the transcript the `--offline` arm writes is compared BYTE FOR BYTE against the
 *                    `expect` recorded in the fixture, and the strict arm is required to fail with
 *                    the recorded code. The parse behind it is the shipping adapter's; this file
 *                    spells neither the endpoint nor a multipart field, and a grep for the
 *                    recogniser's path under `scripts/` finds nothing.
 *   launch           derived from the CLI's own raw evidence (`execArgv=<json>`, `tsxEnv=<bool>`) on
 *                    two arms of the SAME file: `npx tsx` must report `tsx`, and bare `node` must
 *                    not be able to run it at all. The bare-node arm is required to be BLOCKED, not
 *                    merely non-tsx — see the note at the arm for why that stricter reading is the
 *                    one the task's own definition of done forces.
 *
 * THE EMPTY READING IS A FAILURE
 *
 * A missing recording, a `--dry-run` that printed nothing, a CLI that is not there: each is its own
 * red with its own token, never a silent exit 0. This repository has paid for the other shape once.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_ROOT = dirname(HERE);

const CLI_REL = join('experiments', 'voice-asr-cli', 'transcribe.ts');
const RECORDING_REL = join('experiments', 'voice-asr-cli', 'fixtures', 'recorded-transcriptions.json');
const DOUBLE_REL = join('scripts', '__fixtures__', 'no-network-fetch.mjs');
const ADAPTER_REL = join('shared', 'asr', 'contract', 'transcriptionWire.ts');

/** The criterion's own credential. It is a constant of this file's making and reaches the CLI only
 *  through a variable this file names, so nothing ambient can stand in for it. */
const TEST_KEY_VAR = 'ASR_CLI_TEST_KEY';
const TEST_KEY = 'asr-cli-test-key-2f9c1d7b';

/** Where the injected double writes its call log. */
const CALL_LOG_VAR = 'ASR_CLI_CALL_LOG';

/**
 * Where this criterion keeps the per-arm call logs, when a caller wants to read them itself.
 *
 * Unset — the ordinary case — means a private scratch directory that is removed on the way out, and
 * the arm's count is the only thing that leaves. A control suite sets it to a directory it owns so
 * that "the replay went online" can be checked against the double's own log rather than against this
 * file's `calls=` summary of it. The double is what writes the log; this variable only says where.
 * The dry run's own stdout is kept there too (`dry-run-stdout.bin`), for the same reason: this file
 * reports the redaction as a verdict line, and a control that moves one half of it needs the bytes
 * the verdict was reached from.
 *
 * @type {string | undefined}
 */
const CALL_LOG_DIR_VAR = process.env.ASR_CLI_CHECK_CALL_LOG_DIR;

/** The window a leak of the audio is looked for in. Long enough that a match cannot be a coincidence. */
const WINDOW = 32;

/** How long one CLI arm may take. Generous: each arm boots tsx and compiles the module graph. */
const ARM_TIMEOUT_MS = 120000;

/**
 * The synthetic audio every reading here is taken on.
 *
 * Structurally a real RIFF/WAVE (16-bit mono PCM) rather than a text file, because the redaction
 * reading is a BYTE reading: a digest of something a recogniser could actually be sent, and a
 * payload whose leak would be visible.
 *
 * Its PCM region is a deterministic PRINTABLE-ASCII pattern on purpose. A leaked byte above 0x7f
 * would be re-encoded on its way through the stdout pipe, and the 32-byte windows across it would
 * not survive to be looked for; a payload inside 0x21..0x7e passes through unchanged, so "no window
 * of the clip is in stdout" is a reading that can actually go red when the clip is printed.
 */
function synthesizeAudio() {
  const payload = Buffer.alloc(1024);
  let state = 20250923;
  for (let i = 0; i < payload.length; i += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    payload[i] = 0x21 + (state % 94);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + payload.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(payload.length, 40);

  return Buffer.concat([header, payload]);
}

/** @param {Uint8Array} bytes @returns {string} */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** @param {string} text @returns {void} */
function print(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * The child environment, held equal across arms.
 *
 * `TSX_TSCONFIG_PATH` is deleted rather than trusted: it is set ambiently in this repository's worker
 * environment and is INHERITED by a bare-node child, so leaving it in would let the tsx evidence read
 * `true` for a process node started itself. With the variable gone the two arms differ in exactly one
 * thing — the launcher — which is the only way their evidence is comparable.
 *
 * @param {Record<string, string>} extra @returns {NodeJS.ProcessEnv}
 */
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.TSX_TSCONFIG_PATH;
  delete env.NODE_OPTIONS;
  // Both are ambient in this repository's worker environment, and node warns when they are both
  // present. Removed rather than forced: the arms' stdout is compared byte for byte, so a launcher
  // that decided to colour it would be a difference the comparison must not have to know about.
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} root
 * @param {Record<string, string>} extraEnv
 * @returns {{ status: number | null, error: string, stdoutBuf: Buffer, stderrBuf: Buffer, stdout: string, stderr: string }}
 */
function runSpawn(command, args, root, extraEnv) {
  /** @type {import('node:child_process').SpawnSyncOptionsWithBufferEncoding} */
  const options = {
    cwd: root,
    env: childEnv(extraEnv),
    timeout: ARM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  };
  const result = spawnSync(command, args, options);
  const stdoutBuf = result.stdout ?? Buffer.alloc(0);
  const stderrBuf = result.stderr ?? Buffer.alloc(0);
  return {
    status: result.status,
    error: result.error ? String(result.error.message) : '',
    stdoutBuf,
    stderrBuf,
    stdout: stdoutBuf.toString('utf8'),
    stderr: stderrBuf.toString('utf8'),
  };
}

/**
 * `npx tsx <cli> …` — the launch this whole command line is defined by.
 * @param {string} root @param {string[]} args @param {Record<string, string>} [extraEnv]
 */
function runTsxArm(root, args, extraEnv = {}) {
  return runSpawn('npx', ['tsx', CLI_REL, ...args], root, extraEnv);
}

/**
 * `<the same node that is running this criterion> <cli> …` — the arm that must be blocked.
 * @param {string} root @param {string[]} args @param {Record<string, string>} [extraEnv]
 */
function runNodeArm(root, args, extraEnv = {}) {
  return runSpawn(process.execPath, [CLI_REL, ...args], root, extraEnv);
}

/**
 * The launcher, derived from the raw evidence the CLI printed rather than from a label it wrote.
 *
 * Only `execArgv` decides. `tsxEnv` is printed and is deliberately NOT decisive: it reports the
 * presence of the variable tsx exports, and that variable survives into a bare-node child of a
 * tsx-launched parent — on this host it is set in the ambient environment, so bare node prints
 * `tsxEnv=true` too (measured). A rule that accepted it would answer `tsx` for a process node
 * started itself, which is the one thing this reading exists to distinguish.
 */
/**
 * @param {string} stderr
 * @returns {{ execArgv: unknown[], tsxEnv: boolean, launcher: string } | null}
 */
function launchEvidence(stderr) {
  const match = /^ASR-CLI-LAUNCH execArgv=(\[.*?\]) tsxEnv=(true|false)$/m.exec(stderr);
  if (!match) return null;
  /** @type {unknown[]} */
  let execArgv;
  try {
    const parsed = JSON.parse(match[1]);
    execArgv = Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
  const namesTsxLoader = execArgv.some((entry) => typeof entry === 'string' && entry.includes('/tsx/'));
  return { execArgv, tsxEnv: match[2] === 'true', launcher: namesTsxLoader ? 'tsx' : 'node' };
}

/**
 * The first line of stderr worth quoting, for a failure that has to be legible in a verdict.
 * @param {string} stderr @returns {string}
 */
function firstStderrLine(stderr) {
  const line = stderr
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('(node:') && !entry.startsWith('(Use `node'));
  return line ?? 'no stderr';
}

/**
 * How many calls the injected double recorded, and 0 when it was never reached.
 * @param {string} logPath @returns {number}
 */
function callCount(logPath) {
  if (!existsSync(logPath)) return 0;
  const text = readFileSync(logPath, 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * The offset of the first 32-byte window of `audio` present in `haystack`, or -1.
 * @param {Buffer} haystack @param {Buffer} audio @returns {number}
 */
function leakedWindowStart(haystack, audio) {
  for (let start = 0; start + WINDOW <= audio.length; start += 1) {
    if (haystack.includes(audio.subarray(start, start + WINDOW))) return start;
  }
  return -1;
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────

/**
 * Drives every arm and prints one verdict line per reading.
 *
 * @param {string} root the tree under test
 * @returns {number} the exit code
 */
function check(root) {
  /** @type {string[]} */
  const readings = [];
  /** @type {string[]} */
  const failures = [];

  /** @param {boolean} ok @param {string} line @param {string} reason @returns {void} */
  function record(ok, line, reason) {
    readings.push(`verdict ${ok ? 'PASS' : 'FAIL'} ${line}`);
    if (!ok) failures.push(reason);
  }

  const cliPath = join(root, CLI_REL);
  const recordingPath = join(root, RECORDING_REL);
  const doublePath = join(root, DOUBLE_REL);

  if (!existsSync(cliPath)) {
    print(`FAIL cli-missing: ${cliPath}`);
    return 1;
  }
  // Every "did anything happen" reading below is taken from this double's call log, so a tree
  // without it cannot produce a reading at all — refused up front rather than reported as a
  // suspiciously quiet series of passes.
  if (!existsSync(doublePath)) {
    print(`FAIL double-missing: ${doublePath}`);
    return 1;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'asr-cli-offline-'));
  const logDir = CALL_LOG_DIR_VAR || scratch;
  try {
    const audio = synthesizeAudio();
    const audioPath = join(scratch, 'clip.wav');
    writeFileSync(audioPath, audio);
    const audioSha256 = sha256Hex(audio);

    /** The endpoint the dry-run arm is pointed at; it carries a query credential on purpose. */
    const dryRunBaseUrl = 'https://asr.invalid/openai/v1?token=SHOULD-NEVER-BE-PRINTED';
    const dryRunArgs = [
      '--dry-run',
      '--audio', audioPath,
      '--base-url', dryRunBaseUrl,
      '--api-key-env', TEST_KEY_VAR,
      '--fetch-impl', DOUBLE_REL,
    ];

    // ── the dry run, and the two halves of its redaction ─────────────────────────────────────
    const dryLog = join(logDir, 'dry-run-calls.log');
    const dryRun = runTsxArm(root, dryRunArgs, { [TEST_KEY_VAR]: TEST_KEY, [CALL_LOG_VAR]: dryLog });
    const dryCalls = callCount(dryLog);

    // The two readings below are summarised here as booleans, and a boolean is not something a
    // control can disagree with: "the credential is gone AND a window of the audio is not" is a
    // claim about the dry run's stdout, and a control that moves only one half of the redaction has
    // to be able to see which half moved. So when the caller named a log directory the raw stdout
    // is kept there as well, and the summary above stays a summary.
    if (CALL_LOG_DIR_VAR) writeFileSync(join(logDir, 'dry-run-stdout.bin'), dryRun.stdoutBuf);

    const dryRunOk = dryRun.status === 0 && dryCalls === 0;
    record(
      dryRunOk,
      `dry-run calls=${dryCalls}`,
      dryCalls > 0
        ? `dry-run made ${dryCalls} calls (the injected double recorded them; a dry run that sends is not a dry run)`
        : `dry-run-failed: exit=${String(dryRun.status)} (${firstStderrLine(dryRun.stderr)})`,
    );

    const keyLeaked = dryRun.stdoutBuf.includes(Buffer.from(TEST_KEY, 'utf8'));
    const audioLeakStart = leakedWindowStart(dryRun.stdoutBuf, audio);
    const digestPrinted = dryRun.stdout.includes(`sha256=${audioSha256}`);
    const redactionOk = !keyLeaked && audioLeakStart === -1 && digestPrinted;
    record(
      redactionOk,
      `redaction audio-bytes=${audioLeakStart === -1 ? 'elided' : `leaked@${audioLeakStart}`} sha256=${audioSha256}`,
      keyLeaked
        ? 'redaction: the criterion\'s own key constant is in the dry-run stdout'
        : audioLeakStart !== -1
          ? `redaction: a 32-byte window of the audio (at offset ${audioLeakStart}) is in the dry-run stdout`
          : digestPrinted
            ? ''
            : `no readings: the dry-run stdout carries no sha256=${audioSha256} line, so "redacted" cannot be told from "silent"`,
    );

    // ── the launch method, from the same file driven two ways ────────────────────────────────
    const tsxEvidence = launchEvidence(dryRun.stderr);
    const tsxOk = dryRun.status === 0 && tsxEvidence?.launcher === 'tsx';
    record(
      tsxOk,
      `launch ${tsxEvidence?.launcher ?? 'unknown'}`,
      `cli-not-tsx-launched: the npx tsx arm exited ${String(dryRun.status)} and derived launcher=${
        tsxEvidence ? txSummary(tsxEvidence) : `no evidence line (${firstStderrLine(dryRun.stderr)})`
      }`,
    );

    // WHY THE BARE-NODE ARM IS REQUIRED TO BE BLOCKED, and not merely to report `node`.
    //
    // AC6 permits either outcome — a non-zero exit, or a launcher derived as `node` — so this arm
    // could have accepted `nodeArm.status === 0 && launcher === 'node'` and still been green. It
    // does not, because the task's own definition of done requires the variant "turn the specifier
    // into `.ts` so bare node can run it too" to make this arm RED. Under the permissive reading
    // that variant stays green: a CLI that loads under bare node and honestly reports `node` is
    // exactly what the permissive reading calls a pass. Only the strict reading leaves the mutation
    // somewhere to land, and the strict reading is itself permitted by AC6 — the blocked outcome is
    // one of the two it names. The reading is therefore the strict one, deliberately.
    const nodeArm = runNodeArm(root, dryRunArgs, { [TEST_KEY_VAR]: TEST_KEY, [CALL_LOG_VAR]: join(logDir, 'node-arm.log') });
    const nodeEvidence = launchEvidence(nodeArm.stderr);
    const nodeOk = nodeArm.status !== 0;
    record(
      nodeOk,
      `launch node-arm=${nodeOk ? 'load-blocked' : `ran (launcher=${nodeEvidence?.launcher ?? 'unknown'})`}`,
      nodeOk
        ? ''
        : `cli-not-tsx-launched: bare node ran this CLI (launcher=${nodeEvidence ? txSummary(nodeEvidence) : 'no evidence'}), ` +
          'so "launched by tsx" would be a property of the invocation rather than of the entry point',
    );

    // ── the replay, one arm per (entry, tolerance) the recording declares ────────────────────
    if (!existsSync(recordingPath)) {
      record(false, 'recording loaded=false', `recording-missing: ${recordingPath}`);
    } else {
      /** @type {{ entries: Array<{ baseUrl: string, expect: Record<string, { kind: string, text?: string, code?: string }> }> }} */
      const recording = JSON.parse(readFileSync(recordingPath, 'utf8'));

      // Selected by base URL, which is what the arm actually varies, rather than by the entry id:
      // the recording derives that id from the endpoint, and a criterion that spelled the derived
      // form would be red the day the derivation changed, for no reason a reader could act on.
      for (const [variant, baseUrl, tolerance] of [
        ['v1/lenient', 'https://asr.invalid/openai/v1', 'lenient'],
        ['v2/lenient', 'https://asr.invalid/openai/v2', 'lenient'],
        ['v2/strict', 'https://asr.invalid/openai/v2', 'strict'],
      ]) {
        const entry = recording.entries.find((candidate) => candidate.baseUrl === baseUrl);
        if (!entry) {
          record(false, `offline ${variant} entry=false`, `recording-missing: ${baseUrl} is not in ${RECORDING_REL}`);
          continue;
        }
        const expectation = entry.expect[tolerance];
        if (!expectation) {
          record(false, `offline ${variant} entry=false`, `recording-missing: ${baseUrl} records no ${tolerance} expectation`);
          continue;
        }
        const logPath = join(logDir, `offline-${variant.replace(/\W+/g, '-')}.log`);
        const run = runTsxArm(
          root,
          [
            '--offline', recordingPath,
            '--tolerance', tolerance,
            '--audio', audioPath,
            '--base-url', entry.baseUrl,
            '--api-key-env', TEST_KEY_VAR,
            '--fetch-impl', DOUBLE_REL,
          ],
          { [TEST_KEY_VAR]: TEST_KEY, [CALL_LOG_VAR]: logPath },
        );
        const calls = callCount(logPath);

        if (expectation.kind === 'text') {
          const recorded = expectation.text ?? '';
          const produced = run.stdoutBuf;
          const equal = produced.equals(Buffer.from(recorded, 'utf8'));
          const ok = run.status === 0 && equal && calls === 0;
          record(
            ok,
            `offline text=${JSON.stringify(recorded)} calls=${calls} variant=${variant}`,
            // The recorded text is quoted rather than printed raw: both entries carry whitespace at
            // their edges, and the mutation this arm exists to catch is a trim — printed raw, the
            // trimmed and untrimmed readings would look the same in the very line meant to tell
            // them apart. The comparison above is byte-for-byte regardless.
            calls > 0
              ? `offline made ${calls} calls with --fetch-impl supplied: the replay fell through to the injected transport`
              : run.status !== 0
                ? `offline-failed: ${variant} exited ${String(run.status)} (${firstStderrLine(run.stderr)})`
                : equal
                  ? ''
                  : `offline text differs: recorded=${JSON.stringify(recorded)} produced=${JSON.stringify(produced.toString('utf8'))}`,
          );
        } else {
          const code = expectation.code ?? '';
          const ok = run.status !== 0 && run.stderr.includes(code) && calls === 0;
          record(
            ok,
            `offline error=${code} calls=${calls} variant=${variant}`,
            calls > 0
              ? `offline made ${calls} calls with --fetch-impl supplied: the replay fell through to the injected transport`
              : run.status === 0
                ? `offline-failed: ${variant} exited 0; the strict path must report the recorded failure`
                : run.stderr.includes(code)
                  ? ''
                  : `offline-failed: ${variant} exited ${String(run.status)} without ${code} (${firstStderrLine(run.stderr)})`,
          );
        }
      }
    }

    for (const line of readings) print(line);
    print(`arms=${readings.length} red=${failures.length}`);
    for (const failure of failures) print(`reason ${failure}`);
    return failures.length === 0 ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The evidence as one legible clause, quoted into a failure.
 * @param {{ execArgv: unknown[], tsxEnv: boolean }} evidence @returns {string}
 */
function txSummary(evidence) {
  return `execArgv=${JSON.stringify(evidence.execArgv)} tsxEnv=${String(evidence.tsxEnv)}`;
}

/**
 * `--explain-sites`: the absolute path and symbol behind every module the modes drive.
 *
 * The paths come from the CLI's own `import.meta.resolve`, not from a list here, so a symbol that
 * has moved reports where it actually is — and a path outside the tree under test, or a file that
 * does not declare the symbol it claims, is a red. A report that named the right path but drove
 * something else would be the same failure as a reader that measured a copy of the implementation.
 *
 * @param {string} root @returns {number}
 */
function explainSites(root) {
  const reasons = [];
  const run = runTsxArm(root, ['--explain-sites']);
  if (run.status !== 0) {
    print(`FAIL explain-failed: exit=${String(run.status)} (${firstStderrLine(run.stderr)})`);
    return 1;
  }

  const expected = new Set([join(root, CLI_REL), join(root, ADAPTER_REL)].map((path) => realpathSync(path)));
  let sites = 0;

  for (const line of run.stdout.split('\n')) {
    const match = /^ASR-CLI-SITE (\S+) (\S+) symbol=(\S+)$/.exec(line);
    if (!match) continue;
    const [, arm, file, symbol] = match;
    sites += 1;

    if (!existsSync(file)) {
      print(`site ${arm} ${file} symbol=${symbol} MISSING`);
      reasons.push(`site-missing: ${arm} drove ${file}, which does not exist`);
      continue;
    }
    const real = realpathSync(file);
    const inTree = expected.has(real);
    const declaresSymbol = readFileSync(real, 'utf8').includes(symbol);
    print(`site ${arm} ${real} symbol=${symbol} ${inTree ? 'in-shipping-tree' : 'OUTSIDE-SHIPPING-TREE'}`);
    if (!inTree) reasons.push(`site-outside-shipping-tree: ${arm} drove ${real}`);
    if (!declaresSymbol) reasons.push(`site-symbol-missing: ${arm} claims ${symbol} in ${real}`);
  }

  if (sites === 0) {
    print('site <none> — the CLI printed no ASR-CLI-SITE line');
    reasons.push('site-missing: the CLI printed no ASR-CLI-SITE line (an empty site list is not a pass)');
  }

  for (const reason of reasons) print(`reason ${reason}`);
  print(`verdict ${reasons.length === 0 ? 'PASS' : 'FAIL'} sites=${sites} red=${reasons.length}`);
  return reasons.length === 0 ? 0 : 1;
}

// ── entry point ───────────────────────────────────────────────────────────────────────────────

/** @param {string[]} argv @returns {number} */
function main(argv) {
  let root = PROBE_ROOT;
  let explain = false;
  let emitAudio = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[index + 1] ?? '';
      index += 1;
      if (!root) {
        print('usage: --root needs a path');
        return 2;
      }
    } else if (arg === '--explain-sites') {
      explain = true;
    } else if (arg === '--emit-audio') {
      emitAudio = argv[index + 1] ?? '';
      index += 1;
      if (!emitAudio) {
        print('usage: --emit-audio needs a path');
        return 2;
      }
    } else if (arg === '--help' || arg === '-h') {
      print(
        'usage: node scripts/asr-cli-offline-check.mjs [--root <tree>] [--explain-sites] [--emit-audio <path>]',
      );
      return 0;
    } else {
      print(`unknown argument: ${arg}`);
      return 2;
    }
  }

  if (emitAudio) {
    const audio = synthesizeAudio();
    writeFileSync(emitAudio, audio);
    print(`audio ${emitAudio} bytes=${audio.length} sha256=${sha256Hex(audio)}`);
    return 0;
  }

  if (!existsSync(root)) {
    print(`root does not exist: ${root}`);
    return 2;
  }

  return explain ? explainSites(root) : check(root);
}

process.exitCode = main(process.argv.slice(2));
