/**
 * The ONE fleet CLI pipeline: `defaultQuayFleetExec`, the runner and the small parsers every
 * Quay reader shares.
 *
 * WHAT THIS PINS. The consolidation moved four copies of the same child-process wrapper into
 * `quay-fleet-cli.ts`; the risk of a consolidation is that the failure CLASSIFICATION silently
 * changes with it, because every reader turns `error` into the sentence the cockpit shows. So
 * this criterion drives the production binding against real children and pins the four
 * classifications (`ok`, `killed` timeout, `ENOENT` missing binary, non-zero exit) verbatim,
 * plus the runner's fixed "not found" reading and its option forwarding.
 *
 * RUNNER NOTE: a server test, run through `tsx --test` (see `scripts/test.sh`); vitest's
 * include is `src/**` and would find no tests here.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalFleetPath,
  createQuayFleetExec,
  createQuayFleetRunner,
  defaultQuayFleetExec,
  parseFleetJsonObject,
  QUAY_FLEET_BIN_NOT_FOUND_REASON,
  QUAY_FLEET_MAX_OUTPUT_BYTES,
  QUAY_FLEET_TIMEOUT_MS,
  type QuayFleetExecOptions,
} from '../cli/quay-fleet-cli.js';

/** The options every direct binding call gets; `maxBuffer` only bounds a runaway child. */
function execOptions(timeout = 5_000): QuayFleetExecOptions {
  return {
    timeout,
    maxBuffer: QUAY_FLEET_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    windowsHide: true,
  };
}

/** The node binary this test runs under, used as a real child that can exit on command. */
const node = process.execPath;

test('AC1: a successful child is `ok` with status 0 and its captured streams', async () => {
  const result = await defaultQuayFleetExec(node, ['-e', "process.stdout.write('hello')"], execOptions());

  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, '');
  assert.equal(result.error, undefined);
});

test('AC1: a timeout is classified as `killed` and keeps the verbatim timeout sentence', async () => {
  const result = await defaultQuayFleetExec(
    node,
    ['-e', 'setTimeout(() => {}, 10000)'],
    execOptions(250),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, null, 'a killed child has no exit status');
  assert.match(result.error ?? '', /^quay-fleet timed out: /, 'the timeout sentence is verbatim');
  assert.doesNotMatch(result.error ?? '', /was not found/, 'a timeout is not a missing binary');
});

test('AC1: ENOENT is classified as a missing binary and names the exact path verbatim', async () => {
  const missing = path.join(os.tmpdir(), 'quay-fleet-definitely-not-installed');
  const result = await defaultQuayFleetExec(missing, ['--version'], execOptions());

  assert.equal(result.ok, false);
  assert.equal(result.code, null);
  assert.equal(result.error, `quay-fleet was not found: ${missing}`);
});

test('AC1: a non-zero exit keeps its numeric code and the verbatim failed sentence', async () => {
  const result = await defaultQuayFleetExec(node, ['-e', 'process.exit(3)'], execOptions());

  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.match(result.error ?? '', /^quay-fleet failed: /, 'the failure sentence is verbatim');
  assert.doesNotMatch(result.error ?? '', /timed out|was not found/);
});

test('AC1: the locator label keeps the `quay-fleet --version` wording it always had', async () => {
  const versionExec = createQuayFleetExec('quay-fleet --version');
  // The label (not the argv) names the invocation in the sentence, so drive a real timeout.
  const result = await versionExec(node, ['-e', 'setTimeout(() => {}, 10000)'], execOptions(250));

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /^quay-fleet --version timed out: /);
});

test('AC2: the runner returns the fixed not-found reading without forking a child', async () => {
  let spawned = false;
  const run = createQuayFleetRunner({
    resolveBinPath: () => null,
    exec: async () => {
      spawned = true;
      throw new Error('a missing binary must not be spawned');
    },
  });

  const result = await run(['registry', 'list', '--json']);

  assert.equal(spawned, false);
  assert.deepEqual(result, {
    ok: false,
    code: null,
    stdout: '',
    stderr: '',
    error: QUAY_FLEET_BIN_NOT_FOUND_REASON,
  });
  assert.equal(
    QUAY_FLEET_BIN_NOT_FOUND_REASON,
    'quay-fleet was not found (checked QUAY_FLEET_BIN, PATH and ~/.quay-fleet/bin/quay-fleet)',
  );
});

test('AC2: the runner resolves per call, forwards argv and honours both bounds', async () => {
  const calls: {
    file: string;
    args: readonly string[];
    options: QuayFleetExecOptions;
  }[] = [];
  let current = '/first/quay-fleet';
  const run = createQuayFleetRunner({
    resolveBinPath: () => current,
    exec: async (file, args, options) => {
      calls.push({ file, args, options });
      return { ok: true, code: 0, stdout: '{}', stderr: '' };
    },
    timeoutMs: 1_234,
    maxOutputBytes: 2 * 1024 * 1024,
  });

  await run(['initiative', 'list', '--json']);
  current = '/second/quay-fleet';
  await run(['initiative', 'show', 'slug', '--json']);

  assert.deepEqual(calls.map((call) => call.file), ['/first/quay-fleet', '/second/quay-fleet']);
  assert.deepEqual(calls[0]?.args, ['initiative', 'list', '--json']);
  assert.equal(calls[0]?.options.timeout, 1_234);
  assert.equal(calls[0]?.options.maxBuffer, 2 * 1024 * 1024);
  assert.equal(calls[0]?.options.encoding, 'utf8');
  assert.equal(calls[0]?.options.windowsHide, true);
  assert.equal(QUAY_FLEET_TIMEOUT_MS, 10_000, 'the shared default stays 10s');
});

test('AC2: the runner defaults to the shared 10s / 1 MiB bounds', async () => {
  const seen: QuayFleetExecOptions[] = [];
  const run = createQuayFleetRunner({
    resolveBinPath: () => '/usr/local/bin/quay-fleet',
    exec: async (_file, _args, options) => {
      seen.push(options);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });

  await run(['registry', 'list', '--json']);

  assert.equal(seen[0]?.timeout, QUAY_FLEET_TIMEOUT_MS);
  assert.equal(seen[0]?.maxBuffer, QUAY_FLEET_MAX_OUTPUT_BYTES);
  assert.equal(QUAY_FLEET_MAX_OUTPUT_BYTES, 1024 * 1024, 'the shared default stays 1 MiB');
});

test('AC: a string error.code is preserved as errorCode, with the bytes captured before the kill', async () => {
  // The cockpit card read's real accident: the child outran `maxBuffer`, Node killed it, and the
  // callback still received the prefix it had captured. The string code is what tells a consumer
  // this is a CUT document rather than a failure with no output — `code` is null for both.
  const over = await defaultQuayFleetExec(
    node,
    ['-e', "process.stdout.write('x'.repeat(4096))"],
    { ...execOptions(), maxBuffer: 1024 },
  );
  assert.equal(over.ok, false);
  assert.equal(over.code, null, 'a maxBuffer kill has no exit status');
  assert.equal(over.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.ok(over.stdout.length > 0 && over.stdout.length <= 1024, 'the captured prefix survives');
  assert.match(over.error ?? '', /^quay-fleet failed: /);

  const missing = path.join(os.tmpdir(), 'quay-fleet-definitely-not-installed');
  const enoent = await defaultQuayFleetExec(missing, ['--version'], execOptions());
  assert.equal(enoent.errorCode, 'ENOENT', 'every string code is kept, not only the maxBuffer one');

  // The timeout classification is unchanged: `killed` still decides, and its error carries no
  // string code to be mistaken for a salvageable cut.
  const timedOut = await defaultQuayFleetExec(
    node,
    ['-e', 'setTimeout(() => {}, 10000)'],
    execOptions(250),
  );
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, null);
  assert.equal(timedOut.errorCode, undefined);
  assert.match(timedOut.error ?? '', /^quay-fleet timed out: /);
});

test('AC: the runner forwards maxOutputBytes verbatim as the child maxBuffer', async () => {
  // A value no other reader uses, so this can only pass by forwarding the option itself.
  const bound = 5 * 1024 * 1024 + 123;
  const seen: QuayFleetExecOptions[] = [];
  const run = createQuayFleetRunner({
    resolveBinPath: () => '/usr/local/bin/quay-fleet',
    maxOutputBytes: bound,
    exec: async (_file, _args, options) => {
      seen.push(options);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });

  await run(['cockpit', 'cards', '--json']);

  assert.deepEqual(seen.map((options) => options.maxBuffer), [bound]);
});

test('AC3: parseFleetJsonObject accepts objects and rejects every other JSON shape', () => {
  assert.deepEqual(parseFleetJsonObject('{"a":1}'), { a: 1 });
  assert.equal(parseFleetJsonObject('[]'), null);
  assert.equal(parseFleetJsonObject('null'), null);
  assert.equal(parseFleetJsonObject('"text"'), null);
  assert.equal(parseFleetJsonObject('not json'), null);
  assert.equal(parseFleetJsonObject(''), null);
});

test('AC3: canonicalFleetPath drops trailing separators and resolves a missing path lexically', () => {
  const missing = path.join(os.tmpdir(), 'quay-fleet-canonical-missing');
  assert.equal(canonicalFleetPath(`${missing}/`), path.resolve(missing));
  assert.equal(canonicalFleetPath(os.tmpdir()), path.resolve(os.tmpdir()).replace(/[\\/]+$/, ''));
});
