#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-trim-capability-check.mjs (AC-135).
 *
 * Each case below first runs the probe against an UNMUTATED fixture and requires green, then
 * applies exactly one mutation and requires red on the check whose name the case carries. Both
 * halves matter: only the second proves the probe notices the fake form, and only the first proves
 * the red came from the mutation rather than from a probe that is red for every input.
 *
 * The fixture is built at run time, in a temporary directory, OUT OF THE SHIPPING FILES — copied,
 * never re-typed. A hand-written stub would prove the probe reads the stub, and a fixture checked
 * into the repository would be a second declaration of the capability the uniqueness check is
 * looking for.
 *
 * The cases are the two fake forms the criterion names, one for each direction the composition can
 * break from:
 *
 *   · the decision stays in the client and the capability is never read (AC-135 AC3's fake) —
 *     `single-source`;
 *   · the client reads the capability, and answers 裁不裁 by hand beside the read point —
 *     `single-source` again, from the other end;
 *   · the default is changed to "do not trim" (AC-135 AC2's fake) — `default`;
 *   · the read point is gutted so the capability is read but changes nothing (AC-135 AC5's empty
 *     reading) — `read-point`;
 *   · a non-destructive declaration with no experiment to point at (AC-135 AC7) — `discipline`;
 *   · the same red reached the other way: the fixture is complete except that the third registered
 *     provider's own record is gone, and the two records the other providers name are still there —
 *     `discipline`, which is what proves the check is per provider rather than per tree.
 *
 * Run with: node --test scripts/asr-trim-capability-check.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { provisionSharedClosure } from './__fixtures__/shared-closure.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBE = path.join(SCRIPT_DIR, 'asr-trim-capability-check.mjs');

const DECLARING_MODULE = 'src/shared/voiceTrim.ts';
/**
 * The declaring module's own dependency, reached through the frontend `@/` alias. `voiceTrim.ts`
 * imports its frame decision from here, so a fixture that carries the declaring module but not this
 * one cannot be loaded at all — the probe's alias hook resolves `@/shared/voiceEndpoint` to a file
 * that is not there and the run dies in `check probe` with ENOENT. It is therefore part of the
 * fixture's shipping set, and the last case below is what proves that membership is load-bearing.
 */
const ALIASED_DEPENDENCY = 'src/shared/voiceEndpoint.ts';
const CONSUMER = 'src/modules/chat/hooks/useVoiceInput.ts';
const SWITCH = 'src/shared/voiceDebug.ts';
const EVIDENCE = 'docs/experiments/2026-09-22-voice-provider-paired-quality.md';
/**
 * The record the OTHER registered provider's row names. The discipline check reads every row, not
 * just the effective one, so a fixture carrying the registry without this file reds the `discipline`
 * check before any case under test runs — and the two records are deliberately different files,
 * because decision 1 is a per-provider obligation.
 */
const SECOND_EVIDENCE = 'docs/experiments/2026-09-23-gemini.md';
/**
 * The THIRD registered provider's record and adapter module. `dashscope-omni` was registered by
 * `gap-asr-proxy-provider-dispatch`, and it declares `pauseCues: 'neutral'` — a non-destructive
 * value, so decision 1 obliges it to name its own paired measurement. That record is this case's
 * subject: the fixture carries it, and the last case below is what proves the `discipline` check is
 * reading it rather than passing because some file with that shape happens to exist.
 */
const THIRD_EVIDENCE = 'docs/experiments/2026-09-24-omni-written.md';
/**
 * The record the SIXTH registered provider's row names. `dashscope-omni-relay` was registered by
 * `gap-asr-relay-proxy-context` (`46a872e3f`) and declares `pauseCues: 'neutral'`, so decision 1
 * obliges it to name its own paired measurement. The discipline check reads every row, so a
 * fixture without this untouched control cannot load: the baseline reds before any case under test
 * runs. (Same staleness class as the three records above, not a change of assertion.)
 */
const SIXTH_EVIDENCE = 'docs/experiments/2026-10-22-omni-relay-pause-cues.md';
const THIRD_ADAPTER = 'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts';
/** Where the declarations live now: the adapter module of the recogniser registered FIRST. */
const FIRST_ADAPTER = 'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts';
const REGISTRY = 'shared/asr/asrRegistry.ts';

/**
 * The shipping files a fixture needs: the declaring module (the vocabulary and the read point) and
 * the aliased sibling it imports its frame decision from, the file that reaches the read point, the
 * module the shipped switch's default is read from, the
 * experiment record every declaration points at — each of which has to exist, or the discipline
 * check reds before the case under test runs — and the registry side the declarations are read
 * through, including the adapter module of EVERY registered provider, because the check reads the
 * declarations off those modules rather than out of the registration table.
 */
const SHIPPING_FILES = [
  DECLARING_MODULE,
  ALIASED_DEPENDENCY,
  CONSUMER,
  SWITCH,
  EVIDENCE,
  SECOND_EVIDENCE,
  THIRD_EVIDENCE,
  SIXTH_EVIDENCE,
  REGISTRY,
  FIRST_ADAPTER,
  'shared/asr/list/multimodal/multimodal.asr-provider.ts',
  THIRD_ADAPTER,
];

/** The read point's own body in the declaring module; the mutations below rewrite it. */
const READ_POINT_BODY = "  return { capability, trim: capability === 'destructive' };";

/**
 * The gate the consumer opens the trim with, and the import that gate needs.
 *
 * THE SHAPE MOVED WITH THE INPUT PATH, the criterion did not. `a88f5c2a` removed the batch
 * `prepareUpload` this used to name and made segment-then-commit the only path; the capability was
 * left unread. The consumer is now `gapFilterSecForCapture`, which reads the same recogniser at the
 * same read point and turns the answer into the segmenter's gap filter — a `destructive`
 * recogniser compresses long stepped-over pauses (`DEFAULT_KEEP_GAP_SEC`), any other keeps them
 * whole (`Number.POSITIVE_INFINITY`). The mutation below still means what it always meant: decide
 * 裁不裁 in the client without reading the capability, and this file's `single-source` check sees no
 * production file reach the read point.
 */
const CONSUMER_GATE = [
  '  const recogniser = effectivePauseCuesDeclaration();',
  '  if (!isVoiceTrimEnabled() || recogniser === null || !trimDecisionFor(recogniser.capability).trim) {',
  '    return Number.POSITIVE_INFINITY;',
  '  }',
  '  return DEFAULT_KEEP_GAP_SEC;',
].join('\n');
const CONSUMER_GATE_WITHOUT_CAPABILITY = [
  '  if (!isVoiceTrimEnabled()) {',
  '    return Number.POSITIVE_INFINITY;',
  '  }',
  '  return DEFAULT_KEEP_GAP_SEC;',
].join('\n');
// RE-ANCHORED (`099740ca0`): the consumer now imports `trimSilenceEdges` from the same module, so
// the "remove the read point" mutation drops only the capability symbol and keeps the sibling
// import the file still calls — a mutation that deleted both would break the fixture's load and
// red some other check rather than `single-source`.
const CONSUMER_IMPORT = "import { trimDecisionFor, trimSilenceEdges } from '@/shared/voiceTrim';";
// Removing the capability from the decision means removing the read point with it — a file that
// still imported the symbol without calling it would still read as a consumer to the scan, and the
// point of this mutation is that nothing reaches the read point any more.
const CONSUMER_IMPORT_WITHOUT_CAPABILITY = "import { trimSilenceEdges } from '@/shared/voiceTrim';";

/**
 * The first registered recogniser's own declaration, as its adapter module writes it. This is what
 * a non-destructive value — or a missing experiment — is declared ON now: the client has no table
 * left to mutate, which is the point of the seam.
 */
const FIRST_ADAPTER_CAPABILITY = "  pauseCues: 'destructive',";
/** The registry's row naming that recogniser's paired experiment. */
const FIRST_ADAPTER_EVIDENCE_ROW =
  "  [openaiCompatibleId]: 'docs/experiments/2026-09-22-voice-provider-paired-quality.md',";

/**
 * The registration table's FIRST TWO rows, as the registry writes them — the pair the reorder case
 * swaps. Only that case needs them: it changes the effective provider by reordering the two, and
 * `default` then disagrees with the declaration.
 *
 * THE ZERO-ROW CASE DOES NOT USE A LIST OF ROWS. It empties the whole table instead, because a
 * hand-written enumeration of the rows to delete is a second copy of the table that goes stale every
 * time a provider is registered — which is exactly how it broke when `sensevoice-local` and
 * `sensevoice-wasm` were added: the two patches below could only remove the three rows they named,
 * leaving two behind, and the `declaration` check read 2 rows rather than 0.
 */
const REGISTRATION_ROWS = [
  '  {',
  '    id: openaiCompatibleId,',
  '    capabilities: openaiCompatibleCapabilities,',
  "    wire: 'multipart',",
  '    transcribe: openaiCompatibleTranscribe,',
  '  },',
  '  {',
  '    id: multimodalId,',
  '    capabilities: multimodalCapabilities,',
  "    wire: 'inline-json',",
  '    transcribe: multimodalTranscribe,',
  '  },',
].join('\n');

/**
 * @returns {string} a fixture tree copied from the shipping files
 */
function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-trim-capability-'));
  for (const relativePath of SHIPPING_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO_ROOT, relativePath), destination);
  }
  // The registry's own subtree, derived rather than listed: `SHIPPING_FILES` names the adapter whose
  // declaration a case mutates, but the registry imports every adapter, and a fixture missing one
  // cannot be loaded at all. `provisionSharedClosure` copies whatever the registry reaches — the
  // shape that broke when `sensevoice-local` and `sensevoice-wasm` were registered — so this file
  // never has to name them.
  provisionSharedClosure({ repoRoot: REPO_ROOT, fixtureRoot: root, entries: SHIPPING_FILES });
  return root;
}

/**
 * @param {string} root
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runProbe(root) {
  const result = spawnSync(process.execPath, [PROBE, '--root', root], { encoding: 'utf8' });
  assert.equal(result.error, undefined, `the probe could not be started: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Replaces `from` with `to` in a fixture file, requiring exactly one occurrence — a mutation that
 * matched nothing (because the shipping source moved on) would leave the case asserting about an
 * unmutated tree.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} from
 * @param {string} to
 */
function patch(root, relativePath, from, to) {
  const file = path.join(root, relativePath);
  const source = readFileSync(file, 'utf8');
  const occurrences = source.split(from).length - 1;
  assert.equal(occurrences, 1, `the mutation does not match ${relativePath} exactly once (${occurrences})`);
  writeFileSync(file, source.replace(from, to));
}

/**
 * Empties the registry's registration table, whatever rows it currently holds.
 *
 * THE ROWS ARE MATCHED, NOT LISTED. The zero-row case needs a table with nothing in it, and the way
 * to say that for any number of rows is to take the table's whole body and remove it — the same
 * span the probe's own `REGISTRATION_TABLE` pattern reads. Enumerating the rows to delete is a
 * second copy of the table, and it had already gone stale: the two patches this replaced could
 * remove only the three rows they named, so with five registered the "no rows" case left two behind
 * and read 2.
 *
 * @param {string} root
 * @returns {number} the characters removed, so the case can assert something was there to remove
 */
function emptyRegistrationTable(root) {
  const file = path.join(root, REGISTRY);
  const source = readFileSync(file, 'utf8');
  const match = /const\s+REGISTERED[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
  assert.ok(match, `${REGISTRY} no longer declares a registration table this case can empty`);
  const body = /** @type {string} */ (match[1]);
  assert.notEqual(body.trim(), '', 'the registration table is already empty; this case needs rows to remove');
  writeFileSync(file, source.replace(body, ''));
  return body.length;
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
    `the unmutated fixture must pass, otherwise the mutation below proves nothing:\n${baseline.stdout}`,
  );
  return root;
}

/**
 * Runs the mutated fixture and requires the named check to be the one that failed — not merely
 * that the probe exited non-zero, which a fixture that was already broken would also satisfy.
 * @param {string} root
 * @param {string} checkName
 * @returns {string} the probe's stdout, so a case can go on to assert the cause it printed
 */
function expectCheckFails(root, checkName) {
  const result = runProbe(root);
  assert.equal(result.status, 1, `the probe must red this fake form:\n${result.stdout}`);
  assert.match(
    result.stdout,
    new RegExp(`^check ${checkName}: FAIL `, 'm'),
    `${checkName} is not the check that failed:\n${result.stdout}`,
  );
  return result.stdout;
}

test('the shipped tree decides 裁不裁 from the recogniser declaration', () => {
  const result = runProbe(REPO_ROOT);
  assert.equal(result.status, 0, `the shipping tree reds its own criterion:\n${result.stdout}`);
  for (const checkName of ['declaration', 'read-point', 'single-source', 'decision', 'default', 'discipline']) {
    assert.match(result.stdout, new RegExp(`^check ${checkName}: ok `, 'm'), `no reading for ${checkName}`);
  }
  // The read point's symbol name is printed, which is what AC3 asks the probe to show.
  assert.match(result.stdout, /^check read-point: ok .*trimDecisionFor/m);
});

test('green fixture — the falsifiers below start from a passing tree', (t) => {
  const root = greenFixture(t);
  const result = runProbe(root);
  assert.equal(result.status, 0, result.stdout);
});

test('a consumer that keeps deciding 裁不裁 for itself reds single-source (AC3 fake: the capability is never read)', (t) => {
  const root = greenFixture(t);
  patch(root, CONSUMER, CONSUMER_GATE, CONSUMER_GATE_WITHOUT_CAPABILITY);
  patch(root, CONSUMER, CONSUMER_IMPORT, CONSUMER_IMPORT_WITHOUT_CAPABILITY);
  expectCheckFails(root, 'single-source');
});

test('a consumer that answers 裁不裁 by hand beside the read point reds single-source (AC3 fake: a second read point)', (t) => {
  const root = greenFixture(t);
  patch(
    root,
    CONSUMER,
    CONSUMER_GATE,
    `${CONSUMER_GATE}\n  const byHand = recogniser.capability === 'destructive';`,
  );
  expectCheckFails(root, 'single-source');
});

test('changing the declared default to "do not trim" reds default (AC2 fake: the shipped pairing must red)', (t) => {
  const root = greenFixture(t);
  // The declaration the shipped configuration resolves to is the FIRST registered adapter's, and
  // the experiment record stays in place: what this case changes is the value, so the red has to
  // come from the decision and not from the discipline check beside it.
  patch(root, FIRST_ADAPTER, FIRST_ADAPTER_CAPABILITY, "  pauseCues: 'useful',");
  expectCheckFails(root, 'default');
});

test('reordering the registry so a non-trimming recogniser is first also reds default (AC2 fake: the order is the default)', (t) => {
  const root = greenFixture(t);
  // The other way to flip the shipped default: leave every declaration alone and register the
  // multimodal recogniser first, which is the shape the defect actually arrived in.
  patch(
    root,
    REGISTRY,
    REGISTRATION_ROWS,
    [
      '  {',
      '    id: multimodalId,',
      '    capabilities: multimodalCapabilities,',
      "    wire: 'inline-json',",
      '    transcribe: multimodalTranscribe,',
      '  },',
      '  {',
      '    id: openaiCompatibleId,',
      '    capabilities: openaiCompatibleCapabilities,',
      "    wire: 'multipart',",
      '    transcribe: openaiCompatibleTranscribe,',
      '  },',
    ].join('\n'),
  );
  expectCheckFails(root, 'default');
});

test('a read point that answers the same thing for both capabilities reds read-point (AC5 fake: the empty reading)', (t) => {
  const root = greenFixture(t);
  patch(root, DECLARING_MODULE, READ_POINT_BODY, '  return { capability, trim: true };');
  expectCheckFails(root, 'read-point');
});

test('a non-destructive declaration with no experiment to point at reds discipline (AC7)', (t) => {
  const root = greenFixture(t);
  patch(root, FIRST_ADAPTER, FIRST_ADAPTER_CAPABILITY, "  pauseCues: 'useful',");
  patch(root, REGISTRY, FIRST_ADAPTER_EVIDENCE_ROW, '');
  expectCheckFails(root, 'discipline');
});

test('a fixture whose declaring module is deleted reds declaration rather than passing on an empty scan', (t) => {
  const root = greenFixture(t);
  rmSync(path.join(root, DECLARING_MODULE));
  expectCheckFails(root, 'declaration');
});

/**
 * AC5's zero-row arm. Distinct from the deletion above: there the module the vocabulary lives in
 * is gone, here the registration table is present and empty — and an empty registry is exactly the
 * shape that would otherwise read as "no capability contradicts the trim", with the check finding
 * nothing to contradict instead of nothing to read. The printed cause is asserted too: "the
 * registry could not be followed" would be a different observation, and a reader chasing this
 * failure deserves the one that actually happened.
 */
test('a registry with no rows reds declaration with the zero-row cause (AC5)', (t) => {
  const root = greenFixture(t);
  // One edit, and it empties the table for however many rows it holds: a table with one row left in
  // it is not the shape this case is about, and the count of what to delete is the probe's own
  // reading of the table rather than a copy of it here.
  assert.ok(emptyRegistrationTable(root) > 0, 'the table must have had rows to empty');
  const stdout = expectCheckFails(root, 'declaration');
  assert.match(stdout, /nothing is registered — a registry that cannot be followed is not a pass/, stdout);
});

/**
 * The third provider's own record, removed from a fixture that is otherwise complete.
 *
 * This is the case the whole task exists for: `dashscope-omni` declares a non-destructive
 * `pauseCues`, so decision 1 obliges it to name its own paired measurement, and a check that only
 * asked whether SOME record exists would go on passing here. Deleting the third record must red
 * `discipline` — the check whose name says the obligation — and name the provider it is about,
 * rather than reding some earlier check (the fixture is green before the deletion) or passing on
 * the two records the other providers name.
 *
 * WHICH HALF OF `discipline` FIRES. The obligation has two halves and they are two sub-checks: the
 * row must NAME a record, and the record it names must EXIST. This fixture keeps the row and
 * removes the file, so the red is the existence half — the literal below is therefore the
 * "does not exist" cause and not the "no paired experiment" one, and it carries the provider and
 * the path, because a missing record that the reader cannot attribute is not actionable.
 */
test('deleting the third provider\'s record reds discipline (AC7: the evidence is per provider)', (t) => {
  const root = greenFixture(t);
  rmSync(path.join(root, THIRD_EVIDENCE));
  const stdout = expectCheckFails(root, 'discipline');
  assert.match(
    stdout,
    /the declared experiment record does not exist: dashscope-omni->docs\/experiments\/2026-09-24-omni-written\.md/,
    stdout,
  );
});

/**
 * AC3's negative control for the fixture's own completeness — the arm the `@/` alias fix adds.
 *
 * The declaring module now reaches a sibling shared module through `@/`, so a fixture that carries
 * the declaring module but not that sibling does not red a NAMED check: it cannot be loaded at all,
 * and the probe dies in the top-level `check probe` catch. This case proves the `SHIPPING_FILES`
 * addition is load-bearing rather than decorative, in the two halves every case here uses: the
 * unmutated fixture — the one with `voiceEndpoint.ts` — is green (`greenFixture` asserts exactly
 * that), and with that one file removed the probe reds at `check probe` with ENOENT naming the
 * absent file. Without the file the alias hook has nothing to resolve to; if the fixture passed
 * with it gone, the hook was never in play and the shipping run would not be proving anything.
 *
 * The red is asserted to be `check probe` and not one of the six named checks, because that is the
 * shape a module-resolution failure takes and a named-check red here would misattribute the cause.
 */
test('removing the declaring module\'s aliased dependency reds check probe with ENOENT (AC3: the fixture addition is load-bearing)', (t) => {
  const root = greenFixture(t);
  rmSync(path.join(root, ALIASED_DEPENDENCY));
  const result = runProbe(root);
  assert.equal(result.status, 1, `the probe must red a fixture missing the aliased dependency:\n${result.stdout}`);
  assert.match(result.stdout, /^check probe: FAIL .*ENOENT/m, result.stdout);
  assert.match(result.stdout, /voiceEndpoint\.ts/, result.stdout);
});
