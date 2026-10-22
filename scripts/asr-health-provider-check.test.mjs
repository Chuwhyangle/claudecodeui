#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-health-provider-check.mjs (AC8).
 *
 * Three ways the health-and-provider change could have been faked, one at a time. Each case
 * first runs the probe against an UNMUTATED fixture and requires green, then applies exactly one
 * mutation and requires the probe to go red on the reading that mutation breaks. Both halves
 * matter: only the second proves the probe notices the fake, and only the first proves the red
 * came from the mutation rather than from a probe that is red for everything.
 *
 * The three, and the reading each one must move:
 *   1. the health reading still only looks at the server's environment   -> health-user-configured
 *   2. an unregistered id quietly becomes the default provider           -> proxy-unknown-provider
 *   3. the `configured` field is renamed out from under its consumer      -> configured-field-present
 *
 * The fixture is built at run time, in a temporary directory, OUT OF THE SHIPPING FILES —
 * copied, never re-typed. A fixture checked into the repository would be a second copy of the
 * implementation that nothing keeps in step, and a hand-written stub would prove the probe reads
 * the stub rather than this repository's real service.
 *
 * Run with: node --test scripts/asr-health-provider-check.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURE_FILES } from './asr-health-provider-check.mjs';
import { provisionSharedClosure } from './__fixtures__/shared-closure.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBE = path.join(SCRIPT_DIR, 'asr-health-provider-check.mjs');

const SERVICE_MODULE = 'server/modules/voice/voice.service.ts';
const API_MODULE = 'src/shared/api.ts';
/**
 * A line in the fixture's `api.ts` that occurs exactly once, used as the insertion point for the
 * AC6 controls below. Each case asserts its own `from` is unique, so a second copy would fail the
 * control rather than silently mutating the wrong site.
 */
const PROFILE_SLOT = 'let voiceProviderProfile: { id: string; capabilities: AsrCapabilities } | null = null;';

function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-health-fixture-'));
  for (const relativePath of FIXTURE_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO_ROOT, relativePath), destination);
  }
  // The probe's own list names the adapters it knew about; `provisionSharedClosure` derives the
  // `shared/` subtree from the entries instead, so the registry's newest adapters are copied without
  // this file naming them, and the fixture cannot go quiet when the registry gains one. The probe is
  // deliberately left untouched — its list stays what it always was.
  provisionSharedClosure({ repoRoot: REPO_ROOT, fixtureRoot: root, entries: FIXTURE_FILES });
  return root;
}

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
  const root = buildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = runProbe(root);
  assert.equal(baseline.status, 0, `the unmutated fixture must pass, otherwise the mutation below proves nothing:\n${baseline.stdout}${baseline.stderr}`);
  return root;
}

/**
 * Replaces `from` with `to`, refusing to silently no-op on a fixture that has drifted.
 *
 * The `from` must occur EXACTLY ONCE: a mutation that names a string found twice could move a
 * different site than the case believes it moved, and the case would then read green for the wrong
 * reason.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} from
 * @param {string} to
 */
function patchFixtureFile(root, relativePath, from, to) {
  const filePath = path.join(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const occurrences = source.split(from).length - 1;
  assert.equal(occurrences, 1, `${relativePath} contains ${from} ${occurrences} time(s), expected exactly 1; this case needs updating`);
  writeFileSync(filePath, source.replace(from, to));
}

/**
 * Replaces EVERY occurrence of `from`, requiring `expected` of them — the "rename all N sites"
 * mutations. Kept separate from `patchFixtureFile` so a counted rename is explicit rather than a
 * silently different meaning of the same helper.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} from
 * @param {string} to
 * @param {number} expected
 */
function renameEverywhere(root, relativePath, from, to, expected) {
  const filePath = path.join(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const occurrences = source.split(from).length - 1;
  assert.equal(occurrences, expected, `${relativePath} contains ${from} ${occurrences} time(s), expected ${expected}; this case needs updating`);
  writeFileSync(filePath, source.split(from).join(to));
}

test('AC7/AC8: the landing reading is candidate (a), and a frontend-tree landing is refused', (t) => {
  const root = greenFixture(t);

  const landing = runProbe(root, ['--landing']);
  assert.equal(landing.status, 0, `--landing must pass on the fixture:\n${landing.stdout}`);
  assert.match(landing.stdout, /^landing=shared\/asr$/m);
  assert.match(landing.stdout, /^landing-candidate=a$/m);
  assert.match(landing.stdout, /^server-compiles-landing=yes$/m);

  // The fake form: the registry lives where only the frontend can compile it. The health
  // reading is a server route change, so this landing makes the task unlandable, not merely
  // wrong — which is exactly what the precondition assertion has to refuse.
  mkdirSync(path.join(root, 'src/shared/asr'), { recursive: true });
  cpSync(
    path.join(root, 'shared/asr/asrRegistry.ts'),
    path.join(root, 'src/shared/asr/asrRegistry.ts'),
  );
  rmSync(path.join(root, 'shared/asr/asrRegistry.ts'));

  const after = runProbe(root, ['--landing']);
  assert.notEqual(after.status, 0, `a frontend-only landing must not pass:\n${after.stdout}`);
  assert.match(after.stdout, /^landing-candidate=b$/m, `the verdict must name the landing it found:\n${after.stdout}`);
});

test('AC1/AC8: a health reading that only looks at the server environment is reported', (t) => {
  const root = greenFixture(t);

  // The fake form: keep the reading this endpoint shipped with, which consulted the server's
  // environment and nothing else. On this fixture the environment has no voice backend at all,
  // so the reading has to answer "not configured" for a user who configured everything.
  //
  // THE STORED READ MOVED, THE FAKE DID NOT. This line read the settings object's field directly
  // (`settings.baseUrl.trim()`); a later change routed every stored read through `readStoredField`,
  // which is the one place a settings row is read. Dropping that half still means exactly what this
  // case is about — an environment-only reading, blind to the user's stored choice.
  patchFixtureFile(
    root,
    SERVICE_MODULE,
    "return Boolean(readStoredField(settings, 'baseUrl') || defaults.baseUrl);",
    'return Boolean(defaults.baseUrl);',
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `an environment-only reading must not pass:\n${result.stdout}`);
  assert.match(result.stdout, /^health-user-configured=false$/m, `the verdict must name the reading that moved:\n${result.stdout}`);
});

test('AC3/AC8: an unregistered provider id that silently falls back is reported', (t) => {
  const root = greenFixture(t);

  // The fake form: the guard that refuses an id nothing claims is replaced by nothing at all,
  // so the request goes out with the configuration the default provider would have used. The
  // user believes they are transcribing with the provider they named; the previous one answers.
  // The guard now binds the adapter it checked, because the gates of AC-133 read their
  // declaration from that same adapter. The fake is unchanged and is still the same one: the
  // refusal goes away and the first registered provider quietly answers instead.
  // THE GUARD'S INTERIOR GREW, THE FAKE DID NOT. The refusal now binds its result (`const refusal
  // = unknownProviderFailure(...)`) so it can log the attempt before returning; the anchor below
  // tracks that interior rather than the old one-line return. What the mutation removes is still the
  // whole guard: with it gone, an unregistered id falls into `listProviders()[0]` and is served by
  // the first registered provider without a word.
  patchFixtureFile(
    root,
    SERVICE_MODULE,
    [
      '      const adapter = tryResolve(providerId);',
      '      if (adapter === null) {',
      '        // Refused before any request is built: nothing about the user\'s backend can make an',
      '        // unregistered id serveable. The row still names an address and a model — see `configForRow`,',
      '        // which falls back to the shared backend\'s own resolution precisely because there is no',
      '        // adapter here to declare either.',
      '        const refusal = unknownProviderFailure(providerId, requestedProviderId ? 400 : 503);',
      "        logAttempt('fail', refusal.status);",
      '        return refusal;',
      '      }',
    ].join('\n'),
    [
      '      // The fake form: an unregistered id becomes the default provider without a word.',
      '      const adapter = listProviders()[0];',
    ].join('\n'),
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `a silent fallback must not pass:\n${result.stdout}`);
  assert.match(result.stdout, /^proxy-unknown-provider=served-by-a-fallback$/m, `the verdict must name the reading that moved:\n${result.stdout}`);
});

test('AC4/AC8: a renamed `configured` field is reported, not merely un-flagged', (t) => {
  const root = greenFixture(t);

  // The fake form: the field survives but under another name. The consumer's reading
  // (`data?.configured === true`) then resolves to false, which is the compatibility break the
  // uniqueness of this field was supposed to prevent.
  //
  // THE VALUE'S FORM MOVED, THE FAKE DID NOT. The field used to be written from an in-scope
  // `configured` binding (shorthand); it is now computed inline (`configuredFor(effectiveAdapter)`),
  // because what "configured" means became per-provider. The rename below is still the one edit, and
  // still the one this criterion is about.
  patchFixtureFile(
    root,
    SERVICE_MODULE,
    [
      '        value: {',
      '          configured: configuredFor(effectiveAdapter),',
      '          provider: providerId,',
    ].join('\n'),
    [
      '        value: {',
      '          voiceConfigured: configuredFor(effectiveAdapter),',
      '          provider: providerId,',
    ].join('\n'),
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `a renamed configured field must not pass:\n${result.stdout}`);
  assert.match(result.stdout, /^configured-field-present=missing$/m, `the verdict must name the reading that moved:\n${result.stdout}`);
});

test('AC6/AC8: a second capability declaration in the client is reported', (t) => {
  const root = greenFixture(t);

  // The fake form: the client keeps its own copy of a capability table — the copy AC6 exists to
  // forbid, because it is the one that goes stale when the registry changes a provider.
  const declaration = "export const probeCaps = { pauseCues: 'neutral' };";
  patchFixtureFile(root, API_MODULE, PROFILE_SLOT, `${declaration}\n${PROFILE_SLOT}`);

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `a client-side capability declaration must not pass:\n${result.stdout}`);
  assert.match(result.stdout, /^client-capability-table=declared-in-1-file\(s\)$/m, `the verdict must name the reading that moved:\n${result.stdout}`);
  assert.match(
    result.stdout,
    /^failure=AC6: the client declares capabilities of its own in src\/shared\/api\.ts$/m,
    `the verdict must name the file that declares them:\n${result.stdout}`,
  );

  patchFixtureFile(root, API_MODULE, `${declaration}\n`, '');
  const restored = runProbe(root);
  assert.equal(restored.status, 0, `the declaration's removal must restore green:\n${restored.stdout}`);
});

test('AC6/AC8: a capability name in a comment is prose, but the same text as code is a declaration', (t) => {
  const root = greenFixture(t);

  // The regression shape (`87a4199ab`): one JSDoc line that explains the registry's own
  // `pauseCues: 'neutral'` declaration. It is documentation, not a second capability table, so
  // the probe must stay green. The sentence is read from the file that carries it rather than
  // retyped here, so this control cannot drift from the prose it mirrors.
  const sentence = readFileSync(path.join(REPO_ROOT, 'src/shared/voiceTrim.ts'), 'utf8')
    .split('\n')
    .find((line) => /^\s*\*/.test(line) && /\bpauseCues\s*:/.test(line));
  assert.ok(sentence, 'the shipping tree no longer carries the documented sentence this control mirrors');
  const comment = `/*\n${sentence}\n */`;

  patchFixtureFile(root, API_MODULE, PROFILE_SLOT, `${comment}\n${PROFILE_SLOT}`);
  const asComment = runProbe(root);
  assert.equal(asComment.status, 0, `a capability name inside a comment must not be read as a declaration:\n${asComment.stdout}`);
  assert.match(asComment.stdout, /^client-capability-table=none$/m, `the comment must not move the reading:\n${asComment.stdout}`);

  // The same text at the same place, with the comment delimiters removed. The two branches differ
  // ONLY in whether it is a comment, so the red below is about code-vs-prose and nothing else.
  patchFixtureFile(root, API_MODULE, comment, "export const probeRelayCaps = { pauseCues: 'neutral' };");
  const asCode = runProbe(root);
  assert.notEqual(asCode.status, 0, `the same text as code must be read as a declaration:\n${asCode.stdout}`);
  assert.match(asCode.stdout, /^client-capability-table=declared-in-1-file\(s\)$/m, `the code form must move the reading:\n${asCode.stdout}`);
});

test('AC6/AC8: a client that no longer asks the registry is reported', (t) => {
  const root = greenFixture(t);

  // The fake form: the client stops consulting the registry. The declaration scan would stay
  // green on this tree, so without this control deleting the leg would look like a pass.
  renameEverywhere(root, API_MODULE, 'tryResolve', 'resolveProvider', 3);
  const unasked = runProbe(root);
  assert.notEqual(unasked.status, 0, `a client that does not ask the registry must not pass:\n${unasked.stdout}`);
  assert.match(unasked.stdout, /does not ask the registry/, `the verdict must name the missing registry read:\n${unasked.stdout}`);

  renameEverywhere(root, API_MODULE, 'resolveProvider', 'tryResolve', 3);
  const restored = runProbe(root);
  assert.equal(restored.status, 0, `restoring the registry read must restore green:\n${restored.stdout}`);
});

test('AC6/AC8: a client whose capability read points moved is reported', (t) => {
  const root = greenFixture(t);

  // The fake form: the variable that carries the health reading's provider is renamed, so the
  // published profile is no longer what the capability path reads. The hook's setter is left
  // alone: only the read point moved, which is exactly the reading this leg owns.
  renameEverywhere(root, API_MODULE, 'voiceProviderProfile', 'voiceProfile', 7);
  const moved = runProbe(root);
  assert.notEqual(moved.status, 0, `a moved capability read point must not pass:\n${moved.stdout}`);
  assert.match(moved.stdout, /read points/, `the verdict must name the moved read point:\n${moved.stdout}`);

  renameEverywhere(root, API_MODULE, 'voiceProfile', 'voiceProviderProfile', 7);
  const restored = runProbe(root);
  assert.equal(restored.status, 0, `restoring the read point must restore green:\n${restored.stdout}`);
});
