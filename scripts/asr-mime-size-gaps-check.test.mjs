#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-mime-size-gaps-check.mjs (AC9).
 *
 * Four ways the container whitelist and the two-layer size limit could have been faked, one at a
 * time. Each case first runs the probe against an UNMUTATED fixture and requires green, then
 * applies exactly one mutation and requires the probe to go red on the reading that mutation
 * breaks. Both halves matter: only the second proves the probe notices the fake, and only the
 * first proves the red came from the mutation rather than from a probe that is red for everything.
 *
 * The four, and the reading each one must move:
 *   1. the whitelist refuses everything                                   -> declared-container-bare
 *   2. the container is matched as an exact string                        -> declared-container-parameterised
 *   3. only the proxy face gates, the browser sends whatever it has       -> two-paths-same-code
 *   4. the budget is written down as a figure of the gate's own           -> provider-switch-budget
 *
 * The fourth is the one the AC singles out: the reading that has to move is the ADAPTER's refusal,
 * not the transport ceiling's. Hardcoding the gate's figure moves no request through multer at all,
 * which is why the control reads the gate directly and not a status code.
 *
 * The fixture is built at run time, in a temporary directory, OUT OF THE SHIPPING FILES — copied,
 * never re-typed (see `buildFixture` in the probe).
 *
 * Run with: node --test scripts/asr-mime-size-gaps-check.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildFixture } from './asr-mime-size-gaps-check.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(SCRIPT_DIR, 'asr-mime-size-gaps-check.mjs');

const CONTRACT_MODULE = 'shared/asr/contract/asrContract.ts';
const SERVICE_MODULE = 'server/modules/voice/voice.service.ts';
const CLIENT_API_MODULE = 'src/shared/api/index.ts';

/**
 * @param {string} root
 * @param {string[]} [args]
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runProbe(root, args = []) {
  const result = spawnSync(process.execPath, [PROBE, '--root', root, ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined, `the probe could not be started: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A fixture whose probe run is green — the precondition every mutation case starts from.
 * @param {import('node:test').TestContext} t
 * @returns {string} the fixture root
 */
function greenFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-mime-size-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  buildFixture(root);
  const baseline = runProbe(root);
  assert.equal(
    baseline.status,
    0,
    `the unmutated fixture must pass, otherwise the mutation below proves nothing:\n${baseline.stdout}${baseline.stderr}`,
  );
  return root;
}

/**
 * Replaces `from` with `to`, refusing to silently no-op on a fixture that has drifted.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} from
 * @param {string} to
 */
function patchFixtureFile(root, relativePath, from, to) {
  const filePath = path.join(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  assert.ok(source.includes(from), `${relativePath} no longer contains ${from}; this case needs updating`);
  writeFileSync(filePath, source.replace(from, to));
}

test('AC8: the landing reading is candidate (a), and a frontend-tree landing is refused', (t) => {
  const root = greenFixture(t);

  const landing = runProbe(root, ['--landing']);
  assert.equal(landing.status, 0, `--landing must pass on the fixture:\n${landing.stdout}`);
  assert.match(landing.stdout, /^landing=shared\/asr$/m);
  assert.match(landing.stdout, /^landing-candidate=a$/m);
  assert.match(landing.stdout, /^server-compiles-landing=yes$/m);
});

test('AC1/AC9: a whitelist that refuses everything is reported by the half it breaks', (t) => {
  const root = greenFixture(t);

  // The fake form: a "whitelist" that is really a blanket refusal. Every reading about an upload
  // being turned away still looks right — the outside-container case is refused with the right
  // code and costs no upstream call — so only the accepting half can catch it.
  patchFixtureFile(
    root,
    CONTRACT_MODULE,
    'return capabilities.acceptsMime.indexOf(base) !== -1;',
    'return false; // The fake form: the whitelist refuses every container.',
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `a whitelist that refuses everything must not pass:\n${result.stdout}`);
  assert.match(
    result.stdout,
    /^declared-container-bare=refused-415-UNSUPPORTED_MIME$/m,
    `the verdict must name the reading that moved:\n${result.stdout}`,
  );
});

test('AC2/AC9: an exact-string match is reported instead of the recorder\'s own output', (t) => {
  const root = greenFixture(t);

  // The fake form: the declaration is compared against the whole header. `audio/webm;codecs=opus`
  // is what this app's own recorder produces, so this is the whitelist refusing its own input —
  // and the bare type beside it still reads as accepted, which is why the parameterised case is
  // the one that has to be read.
  patchFixtureFile(
    root,
    CONTRACT_MODULE,
    'return mimeType.split(\';\')[0].trim().toLowerCase();',
    'return mimeType.trim().toLowerCase(); // The fake form: the parameters stay on.',
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `an exact-string match must not pass:\n${result.stdout}`);
  assert.match(
    result.stdout,
    /^declared-container-parameterised=refused-415-UNSUPPORTED_MIME$/m,
    `the verdict must name the reading that moved:\n${result.stdout}`,
  );
});

test('AC4/AC9: a browser face that gates nothing is reported by the two-path comparison', (t) => {
  const root = greenFixture(t);

  // The fake form: the rule lands on the proxy path only. The recording then takes two different
  // answers depending on which endpoint it went to — which is the whole property the seam's one
  // code exists to give — while each face read on its own still looks reasonable.
  patchFixtureFile(
    root,
    CLIENT_API_MODULE,
    'const refusal = unregisteredProviderRefusal() ?? unsupportedContainerRefusal(blob.type);',
    'const refusal = unregisteredProviderRefusal(); // The fake form: the browser gates nothing.',
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `a one-sided gate must not pass:\n${result.stdout}`);
  assert.match(
    result.stdout,
    /^two-paths-same-code=no$/m,
    `the verdict must name the reading that moved:\n${result.stdout}`,
  );
});

test('AC5/AC9: a budget written down in the gate is reported as not following the declaration', (t) => {
  const root = greenFixture(t);

  // The fake form: the figure the gate enforces is its own rather than the declaration's. It is
  // also the fake the AC singles out — the reading that has to move is the ADAPTER's refusal, so
  // this mutation touches no transport limit at all.
  patchFixtureFile(
    root,
    SERVICE_MODULE,
    'const budget = capabilities.maxInlineRequestBytes;',
    'const budget = 25 * 1024 * 1024; // The fake form: a figure of the gate\'s own.',
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `a hardcoded budget must not pass:\n${result.stdout}`);
  assert.match(
    result.stdout,
    /^provider-switch-budget=constant$/m,
    `the verdict must name the reading that moved:\n${result.stdout}`,
  );
});
