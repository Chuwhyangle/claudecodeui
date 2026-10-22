#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-proxy-only-ssrf-check.mjs (AC-140).
 *
 * Each case below first runs the probe against an UNMUTATED fixture and requires green, then applies
 * exactly one mutation and requires red. Both halves matter: only the second proves the probe
 * notices the fake form, and only the first proves the red came from the mutation rather than from a
 * probe that is red for every input.
 *
 * The fixture is built at run time, in a temporary directory, OUT OF THE SHIPPING FILES — copied,
 * never re-typed, and symlinked to this repository's `node_modules` so the browser tree's bare
 * imports (`clsx`, `tailwind-merge`) resolve exactly as they do in the repository. A hand-written
 * stub would only prove the probe reads the stub; a copy of the real modules is what makes these
 * cases evidence about this repository rather than about a paragraph describing it.
 *
 * The mutations are the fake forms the criteria name, one apiece:
 *
 *   · AC4 — `direct-despite-proxy-only`: the client's route condition goes inert, so a recording
 *     for a provider a browser cannot address is sent to the stored address anyway. The "zero
 *     requests to that address" half is the thing that has to notice.
 *   · AC7 — `host-check-removed`: the server's pre-request step stops asking the rule, so an
 *     address the provider may not be reached at is left to the format gate — which answers 400
 *     without the code the criterion reads.
 *   · AC7 — `rule-loosened`: the shipping rule itself is made always-true for a well-formed https
 *     address, so the same eight near-miss inputs are all admitted.
 *   · AC7 — `whitelist-for-every-provider`: the rule is consulted for a provider that declares
 *     `'direct'`, so the door the address is supposed to be for every other provider becomes a wall
 *     for them too — caught by AC8's passthrough control, not by AC6's.
 *
 * WHY THE HOSTS ARE NOT WRITTEN HERE (AC9). This file and the probe it drives are both forbidden
 * from spelling the two service addresses: a probe that typed them would be a second place they
 * live. So the address readings below are taken from the probe's own OUTPUT, and the "neither file
 * spells it" half is checked against those reported values. Read together, they are the positive
 * control AC9 asks for: the addresses reach the run as inputs while appearing in neither file.
 *
 * The last two cases are the other half of the same discipline: AC9's run is also the one that
 * shows the addresses arriving, and AC10's run shows the criterion re-taking the seven contract
 * readings of the tree under test — against this repository, since a fixture carries no `scripts/`
 * for them to be taken from.
 *
 * Run with: node --test scripts/asr-proxy-only-ssrf-check.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { provisionSharedClosure } from './__fixtures__/shared-closure.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBE = path.join(SCRIPT_DIR, 'asr-proxy-only-ssrf-check.mjs');
const TEST_FILE = fileURLToPath(import.meta.url);

/**
 * The shipping files a fixture needs: the two halves under test and everything they reach, and the
 * two records the probe mines its addresses out of.
 *
 * THE `shared/asr` SUBTREE IS NOT HERE. It is derived from the registry's own imports by
 * `provisionAsrRegistry` instead, because a hand-written copy list goes stale the moment the
 * registry gains an adapter — which is what this fixture's list did when `sensevoice-local` and
 * `sensevoice-wasm` were registered, leaving a tree whose registry could not be loaded at all
 * (`ERR_MODULE_NOT_FOUND` for the absent adapter, reported as EMPTY_READING rather than as a red
 * about the mutation under test).
 *
 * `package.json` is not decoration — its `"type": "module"` is what makes the loader treat a `.ts`
 * module as ESM, and without it the fixture's own imports are resolved as CommonJS and the probe
 * cannot load the registry at all (measured on the sibling probe: `ERR_REQUIRE_CYCLE_MODULE`).
 * Copying it keeps the fixture loaded exactly the way the repository is loaded instead of under a
 * hand-written approximation of it.
 *
 * `src/shared/api.ts` pulls in `@/shared/utils.ts`, which imports two bare packages, so the fixture
 * also gets a `node_modules` symlink — the same provisioning the dispatch script gives a worktree.
 */
const SHIPPING_FILES = [
  'package.json',
  'tsconfig.json',
  'src/shared/api.ts',
  'src/shared/authToken.ts',
  'src/shared/utils.ts',
  'src/shared/voiceConfig.ts',
  'server/modules/voice/voice.service.ts',
  // The service's runtime siblings (the concern split in `gap-voice-service-concern-split`): the
  // service composes the capture seam and re-exports the browser recogniser's asset surface from
  // these two, so a fixture copied without them cannot load the module under test.
  'server/modules/voice/voice-service-capture.ts',
  'server/modules/voice/voice-service-transcribe.ts',
  // The records the probe's addresses come from. Without them the probe reports EMPTY_READING —
  // which is exactly what AC1's empty-directory case reads, one root over.
  'docs/proposals/voice-dashscope-omni-written-instruction.md',
  'docs/experiments/2026-09-23-webm-asr-candidates.md',
];

/** The two halves the mutations are applied to. */
const CLIENT = 'src/shared/api.ts';
const SERVICE = 'server/modules/voice/voice.service.ts';
const RULE = 'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts';

/**
 * @returns {string} the fixture root
 */
function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-proxy-only-ssrf-'));
  for (const relativePath of SHIPPING_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO_ROOT, relativePath), destination);
  }
  // The `shared/` subtree these entries reach, taken by closure and self-checked, so this fixture
  // cannot go stale when the registry gains an adapter (the drift that broke this file) or when an
  // entry starts importing a new shared file.
  provisionSharedClosure({ repoRoot: REPO_ROOT, fixtureRoot: root, entries: SHIPPING_FILES });
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

/**
 * @param {string} root
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runProbe(root) {
  const result = spawnSync(process.execPath, [PROBE, '--root', root], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(result.error, undefined, `the probe could not be started: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A fixture whose probe run is green — the precondition every mutation case starts from.
 * @param {import('node:test').TestContext} t
 * @returns {string} the fixture root
 */
function greenFixture(t) {
  const root = buildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = runProbe(root);
  assert.equal(
    baseline.status,
    0,
    `the unmutated fixture must pass, otherwise the mutation below proves nothing:\n${baseline.stdout}\n${baseline.stderr}`,
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
  // Exactly one occurrence, or the replacement is a coin toss between two call sites.
  assert.equal(
    source.split(from).length - 1,
    1,
    `${relativePath} contains ${from} more than once; the mutation would not be one edit`,
  );
  writeFileSync(filePath, source.replace(from, to));
}

/**
 * One control: the unmutated tree is green first, then exactly one edit is applied and the named
 * verdict must be the one that fires. The token — not merely the exit code — is asserted, because a
 * probe that went red for an unrelated reason would otherwise count as evidence.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ name: string, file: string, from: string, to: string, token: string }} control
 */
function control(t, { name, file, from, to, token }) {
  const root = greenFixture(t);
  patchFixtureFile(root, file, from, to);
  const result = runProbe(root);
  assert.notEqual(result.status, 0, `${name} must not pass:\n${result.stdout}`);
  assert.match(
    result.stdout,
    new RegExp(`^FAIL ${token}:`, 'm'),
    `${name} must be caught by ${token}:\n${result.stdout}`,
  );
}

// ── AC4 ──────────────────────────────────────────────────────────────────────────────────────

test('AC4: a proxy-only provider whose route is not taken is caught on the stored address', (t) => {
  control(t, {
    name: 'direct-despite-proxy-only: an inert route condition, so the recording goes direct anyway',
    file: CLIENT,
    // THE CONDITION MOVED, THE MUTATION DID NOT. This read `profile.capabilities.transport ===
    // 'proxy-only'` when the branch was written for the one such provider; a later change made the
    // route a property of the DECLARATION rather than one transport value, and the condition became
    // `!sharedBackendApplies(profile.capabilities)` — the proxy hop is now taken by every recogniser
    // that is not one the shared backend reaches directly. An inert `if (false)` still means exactly
    // what this case is about: the branch that steps over the stored address never runs, so a
    // recording for a provider a browser cannot address is sent to the stored address anyway, and the
    // "zero requests to that address" half is the thing that has to notice.
    from: '  if (profile !== null && !sharedBackendApplies(profile.capabilities)) {',
    to: '  if (false) {',
    token: 'PROXY_ONLY_STILL_DIRECT',
  });
});

// ── AC7 ──────────────────────────────────────────────────────────────────────────────────────

test('AC7: a server step that no longer asks the rule is caught by the missing code', (t) => {
  control(t, {
    // The rule itself is untouched here: what this mutation removes is the CALL. The address is
    // left to the format gate, which answers 400 without a code — so the case that reds is the one
    // reading the code, not the one reading the status.
    name: 'host-check-removed: the pre-request step stops asking the endpoint rule',
    file: SERVICE,
    from: '      const endpointFailure = endpointRuleRefusal(adapter, config.baseUrl);',
    to: '      const endpointFailure = null;',
    token: 'REJECTED_NOT_INVALID_BASE_URL',
  });
});

test('AC7: a rule that admits every well-formed address is caught by the same near-misses', (t) => {
  control(t, {
    name: 'rule-loosened: the shipping rule made always-true for a well-formed https address',
    file: RULE,
    from: '  return hostname === PUBLIC_HOSTNAME || WORKSPACE_HOSTNAME.test(hostname);',
    to: '  return true;',
    token: 'REJECTED_NOT_INVALID_BASE_URL',
  });
});

test('AC7: a rule applied to every provider is caught by the direct provider’s control', (t) => {
  control(t, {
    // The mutation keeps AC6 green on purpose — the rule still refuses, so nothing is admitted —
    // and moves the rule onto the adapter that declares `'direct'`. What has to notice is the
    // passthrough control, and only the passthrough control: a wall for everyone is not the door
    // the rule is for one provider.
    name: 'whitelist-for-every-provider: the rule consulted for a provider that declares direct',
    file: SERVICE,
    from: '      const endpointFailure = endpointRuleRefusal(adapter, config.baseUrl);',
    to: "      const endpointFailure = endpointRuleRefusal(adapter.allowedBaseUrl ? adapter : tryResolve('dashscope-omni'), config.baseUrl);",
    token: 'DIRECT_PROVIDER_BLOCKED',
  });
});

// ── AC9 ──────────────────────────────────────────────────────────────────────────────────────

test('AC9: the addresses reach the run as inputs while neither file spells them', (t) => {
  const root = buildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runProbe(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  // The two addresses are read off the probe's own report of what it mined — never typed here,
  // which is the constraint the criterion's grep reads out of these two files.
  const reported = result.stdout.match(/^public-host=(\S+) workspace-host=(\S+)$/m);
  assert.ok(reported, `the probe must report the two addresses it mined:\n${result.stdout}`);
  const [, publicHost, workspaceHost] = reported;
  assert.notEqual(publicHost, '<none>');
  assert.notEqual(workspaceHost, '<none>');
  assert.notEqual(publicHost, workspaceHost);

  const probeSource = readFileSync(PROBE, 'utf8');
  const testSource = readFileSync(TEST_FILE, 'utf8');
  for (const host of [publicHost, workspaceHost]) {
    // The positive control: an address that never reached the run could not have been read out of
    // the tree, so "the rule accepts these" has to be visible as an input the driver was handed.
    assert.ok(
      result.stdout.includes(`allow[https://${host}]`),
      `${host} must appear as an allowed input — the readings are about real addresses:\n${result.stdout}`,
    );
    // And the negative half, which is the criterion's own grep: the addresses are in the RUN, not
    // in either file.
    assert.ok(!probeSource.includes(host), `${PROBE} must not spell ${host}`);
    assert.ok(!testSource.includes(host), `${TEST_FILE} must not spell ${host}`);
  }
});

// ── AC10 ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The seven contract readings AC10 names. Listed rather than imported, for the same reason the probe
 * lists them: the set is closed, and a reading that stops being taken has to show up as a missing
 * line rather than as a shorter list nobody counts.
 */
const CONTRACT_READINGS = [
  'asr-second-adapter-check',
  'asr-contract-invariants-check',
  'asr-capability-check',
  'asr-mime-size-gaps-check',
  'asr-extraction-parity-check',
  'asr-health-provider-check',
  'asr-pause-cues-source-check',
];

test('AC10: the criterion re-takes the seven contract readings and prints their codes', () => {
  // Run against THIS repository rather than a fixture: the readings belong to the tree under test,
  // and this is the invocation the criterion gate makes. The fixture cases above deliberately carry
  // none of them — which is what keeps nine probe runs inside the criterion's own time budget.
  const result = runProbe(REPO_ROOT);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  // "Not an empty pass", made falsifiable: a probe that stopped executing the seven would print no
  // exit codes at all, and this case would red rather than quietly pass.
  assert.match(result.stdout, /^subprocesses=7 \(contract readings only\)$/m);
  for (const name of CONTRACT_READINGS) {
    assert.match(
      result.stdout,
      new RegExp(`^sibling\\[${name}\\] exit=(?:\\d+|<unstarted>)(?: first-fail=[A-Z_]+)?$`, 'm'),
      `${name} must have been run and its exit code printed:\n${result.stdout}`,
    );
    assert.ok(
      !result.stdout.includes(`sibling[${name}] exit=<unstarted>`),
      `${name} did not start, so its code is not a reading:\n${result.stdout}`,
    );
  }
  // The codes themselves are the criterion's business. One of the seven is red on develop, for a
  // reason owned by the probe that declares the third wire's vocabulary (see the probe's own note);
  // what this case establishes is that all seven were executed and their codes printed.
});
