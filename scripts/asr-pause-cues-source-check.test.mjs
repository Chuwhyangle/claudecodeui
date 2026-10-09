#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-pause-cues-source-check.mjs.
 *
 * WHAT EACH CASE IS FOR. The probe's judgement is a comparison: the value the client would act on
 * against the value the registry declares for the effective provider. A probe like that can be
 * wrong in two opposite ways, and a control is needed for each:
 *
 *   · it reds on trees it should not — the control is a rig whose client declaration EQUALS the
 *     registry's, which has to stay green. A probe that reds on any client-side table would pass
 *     every "it must be red" case below while being useless.
 *   · it stays green on trees it should red — the control is the same rig with that one value
 *     changed to the registry's opposite, which has to red and to say which two values disagreed.
 *
 * Both cases drive the SAME rig, and both assert green on it BEFORE the mutation. That ordering is
 * the whole of the evidence: it rules out a red that came from the fixture being broken rather
 * than from the mutation, and it makes the two cases differ by exactly one string.
 *
 * THE FIXTURE IS COPIED FROM THE SHIPPING FILES, never re-typed, and it is the probe's own
 * `FIXTURE_FILES` list that says which ones. A hand-written stub would prove the probe reads the
 * stub; a fixture checked into the repository would be a second copy of the very declaration this
 * criterion is about.
 *
 * Run with: node --test scripts/asr-pause-cues-source-check.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURE_FILES, registryDeclarations } from './asr-pause-cues-source-check.mjs';
import { provisionSharedClosure } from './__fixtures__/shared-closure.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBE = path.join(SCRIPT_DIR, 'asr-pause-cues-source-check.mjs');

const REGISTRY = 'shared/asr/asrRegistry.ts';
const VOICE_TRIM = 'src/shared/voiceTrim.ts';
const GATE = 'src/modules/chat/hooks/useVoiceInput.ts';

/**
 * The provider the shipped configuration sends to, and the two capability values that oppose.
 *
 * The effective provider is the FIRST registered adapter, so these name the first row of
 * `shared/asr/asrRegistry.ts`: when the ordering changes, this file changes with it. `REGISTRY_VALUE`
 * is that adapter's own declaration — the value the agreeing rig writes and the probe must accept;
 * `OPPOSING_VALUE` is the other side of the distinction the probe is asked to draw.
 */
const EFFECTIVE_PROVIDER = 'openai-compatible';
const REGISTRY_VALUE = 'destructive';
const OPPOSING_VALUE = 'useful';

/** The judgement the probe has to reach on a disagreement, and the literal AC4 retires. */
const MISMATCH = '客户端声明的 `pauseCues` 与 registry 对当前 provider 的声明不一致';
const RETIRED_LITERAL = 'OPENAI_COMPATIBLE_PROVIDER';

/**
 * The paired experiment each registered provider's declaration rests on (ADR-004 decision 1).
 *
 * TWO PROVIDERS, TWO RECORDS. The obligation decision 1 states is on the PROVIDER: a
 * non-destructive value may only change what gets uploaded on the strength of *that provider's own*
 * paired measurement. `scripts/asr-trim-capability-check.mjs`'s `discipline` check enforces that the
 * named record EXISTS, and an existence check cannot tell a record about this service from a record
 * about another one — so both rows naming one run passes it while leaving half the claim unmeasured.
 * That is the shape the case below draws.
 */
const WHISPER_RECORD = 'docs/experiments/2026-09-22-voice-provider-paired-quality.md';
const MULTIMODAL_RECORD = 'docs/experiments/2026-09-23-gemini.md';
const MULTIMODAL_PROVIDER = 'multimodal';
/**
 * The third registered provider, and the record IT was measured in. Three providers now, so this
 * reading is a THREE-way one: the count below is what states it, and a fourth provider added
 * against someone else's record is the shape it is written to catch.
 */
const OMNI_PROVIDER = 'dashscope-omni';
const OMNI_RECORD = 'docs/experiments/2026-09-24-omni-written.md';
/** The registry row as it ships, and the retargeting the falsification case applies to it. */
const MULTIMODAL_EVIDENCE_ROW = `  [multimodalId]: '${MULTIMODAL_RECORD}',`;
const MULTIMODAL_EVIDENCE_ROW_RETARGETED = `  [multimodalId]: '${WHISPER_RECORD}',`;

/** Where a client-side declaration is installed: immediately before the read point it would feed. */
const READ_POINT = 'export function trimDecisionFor(capability: PauseCues): TrimDecision {';

/** A client-side table, of exactly the shape the probe's scan is written to find. */
const CLIENT_TABLE = [
  '/** A client-side declaration of the capability, of the shape this check reads. */',
  'export const PAUSE_CUES_DECLARATIONS = [',
  `  { provider: '${EFFECTIVE_PROVIDER}', pauseCues: '${REGISTRY_VALUE}' },`,
  '];',
].join('\n');

/** The one row above, as the value-change case rewrites it. */
const ROW = `  { provider: '${EFFECTIVE_PROVIDER}', pauseCues: '${REGISTRY_VALUE}' },`;
const ROW_OPPOSING = `  { provider: '${EFFECTIVE_PROVIDER}', pauseCues: '${OPPOSING_VALUE}' },`;

/** The gate's shipping line, and the pre-fix line that names the retired literal instead. */
const GATE_READS_REGISTRY = '  const recogniser = effectivePauseCuesDeclaration();';
const GATE_NAMES_LITERAL = `  const recogniser = pauseCuesFor(${RETIRED_LITERAL});`;

/**
 * What the rig has to copy ON TOP of the probe's own `FIXTURE_FILES` list, and why it is here rather
 * than there.
 *
 * `registryDeclarations` follows the registry's imports, and `gap-asr-proxy-provider-dispatch` gave
 * that file a third one: without the `dashscope-omni` adapter module in the rig, the registry cannot
 * be read at all and every case below reds on `the registry's declarations could not be read` —
 * before its mutation is even applied. The probe's list names two adapters and this task does not
 * edit the probe (AC6: the two check scripts are unchanged, and the criterion greps for exactly
 * that), so the list is completed here, where the rig is built.
 *
 * THE ADAPTER MODULES ARE NOW DERIVED, NOT LISTED. `provisionSharedClosure` follows the rig's own
 * entries into `shared/` and copies whatever the registry reaches, so the next adapter added to the
 * registry is copied without this file naming it — the drift that left the registry unloadable when
 * `sensevoice-local` and `sensevoice-wasm` landed. The record below is NOT derived: it is a
 * document, not a module, and nothing imports it.
 */
const EXTRA_FIXTURE_FILES = [OMNI_RECORD];

const RIG_FILES = [...FIXTURE_FILES, ...EXTRA_FIXTURE_FILES];

/** @returns {string} a rig copied from the shipping files the probe declares */
function buildRig() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-pause-cues-source-'));
  for (const relativePath of RIG_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO_ROOT, relativePath), destination);
  }
  provisionSharedClosure({ repoRoot: REPO_ROOT, fixtureRoot: root, entries: RIG_FILES });
  return root;
}

/**
 * @param {string} root
 * @returns {{ status: number | null, stdout: string }}
 */
function runProbe(root) {
  const result = spawnSync(process.execPath, [PROBE, '--root', root], { encoding: 'utf8' });
  assert.equal(result.error, undefined, `the probe could not be started: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout };
}

/**
 * Replaces `from` with `to` in a rig file, requiring exactly one occurrence — a mutation that
 * matched nothing (because the shipping source moved on) would leave the case asserting about an
 * unmutated tree, and would read as a probe that cannot be reddened at all.
 *
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
 * A rig whose probe run is green — the state every mutation below starts from.
 *
 * @param {import('node:test').TestContext} t
 * @returns {string} the rig root
 */
function greenRig(t) {
  const root = buildRig();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = runProbe(root);
  assert.equal(before.status, 0, `the rig is not green before any mutation:\n${before.stdout}`);
  return root;
}

/**
 * Installs a client-side table that agrees with the registry, and requires the probe to still pass
 * — so the disagreement case below differs from this one by a single value and not by a table.
 *
 * @param {string} root
 * @returns {{ status: number | null, stdout: string }}
 */
function installAgreeingTable(root) {
  patch(root, VOICE_TRIM, READ_POINT, `${CLIENT_TABLE}\n${READ_POINT}`);
  const after = runProbe(root);
  assert.equal(after.status, 0, `a client table that agrees with the registry was refused:\n${after.stdout}`);
  return after;
}

test('the shipping tree passes: the client declares nothing and reads the registry', () => {
  const { status, stdout } = runProbe(REPO_ROOT);

  assert.equal(status, 0, stdout);
  // The readings the pass rests on, so a green that came from an empty scan cannot hide here:
  // the registry side was read, and the gate was found reaching it.
  assert.match(stdout, /^registry-pauseCues=destructive$/m);
  assert.match(stdout, /^client-declaration-rows=0$/m);
  assert.match(stdout, /^gate-reads-registry=yes \(/m);
  assert.match(stdout, /^verdict=ok$/m);
});

test('a client table whose value EQUALS the registry stays green', (t) => {
  const root = greenRig(t);

  const { status, stdout } = installAgreeingTable(root);

  assert.equal(status, 0, stdout);
  assert.match(stdout, /^client-declaration-rows=1$/m);
  assert.match(stdout, /^client-pauseCues=destructive$/m);
  assert.match(stdout, /^verdict=ok$/m);
});

test('the same rig, with only that value changed to the registry\'s opposite, reds', (t) => {
  const root = greenRig(t);
  installAgreeingTable(root);

  patch(root, VOICE_TRIM, ROW, ROW_OPPOSING);
  const { status, stdout } = runProbe(root);

  assert.notEqual(status, 0, `the client disagreed with the registry and the probe passed:\n${stdout}`);
  assert.ok(stdout.includes(MISMATCH), stdout);
  // Both values verbatim, and which provider they are about: the judgement is only actionable if
  // the reader can see what disagreed with what without opening either file.
  assert.ok(
    stdout.includes(`client=${OPPOSING_VALUE} registry=${REGISTRY_VALUE} provider=${EFFECTIVE_PROVIDER}`),
    stdout,
  );
});

test('AC4: writing the retired literal back into the gate reds it', (t) => {
  const root = greenRig(t);

  patch(root, GATE, GATE_READS_REGISTRY, GATE_NAMES_LITERAL);
  const { status, stdout } = runProbe(root);

  assert.notEqual(status, 0, `the gate named ${RETIRED_LITERAL} and the probe passed:\n${stdout}`);
  assert.match(stdout, new RegExp(`^gate-retired-literal=${RETIRED_LITERAL}$`, 'm'));
  assert.match(stdout, /^gate-reads-registry=no$/m);
});

test('a tree whose registry cannot be read reds rather than passing an empty scan', (t) => {
  const root = greenRig(t);

  rmSync(path.join(root, REGISTRY));
  const { status, stdout } = runProbe(root);

  assert.notEqual(status, 0, `the registry was gone and the probe passed:\n${stdout}`);
  assert.match(stdout, /^verdict=fail$/m);
  assert.ok(stdout.includes(REGISTRY), stdout);
});

test('every registered provider names its OWN paired experiment (ADR-004 decision 1)', () => {
  const { providers, error } = registryDeclarations(REPO_ROOT);
  assert.equal(error, null, `the registry's declarations could not be read: ${error}`);

  const evidence = new Map(providers.map((row) => [row.id, row.evidence]));
  // The non-destructive declaration is the one decision 1 is about: `destructive` is the shipped
  // default and needs no measurement, every other value changes what leaves the machine.
  assert.equal(
    evidence.get(MULTIMODAL_PROVIDER),
    MULTIMODAL_RECORD,
    `${MULTIMODAL_PROVIDER} declares a non-destructive pauseCues; its record must be the run it was measured in`,
  );
  assert.equal(evidence.get(EFFECTIVE_PROVIDER), WHISPER_RECORD, `${EFFECTIVE_PROVIDER} must keep its own record`);
  assert.equal(
    evidence.get(OMNI_PROVIDER),
    OMNI_RECORD,
    `${OMNI_PROVIDER} declares a non-destructive pauseCues too; its record must be the run it was measured in`,
  );

  // The judgement itself, stated as the count rather than as per-row comparisons: among the rows
  // that NAME a record at all, `n` rows and `n` distinct records mean no row is resting on a
  // measurement of a different service. A per-row check would go on passing if a further provider
  // were added pointing at one of these.
  //
  // ONLY NAMED RECORDS COUNT. `destructive` is the shipped default, so a provider carrying it may
  // name no measurement — and two such providers are not "resting on the same paired experiment":
  // `undefined` is not a record. Both `sensevoice-local` and `sensevoice-wasm` sit on the default,
  // being handed the same already-trimmed audio, so counting the unset rows would red on a pair that
  // makes no claim at all. The loop above the count keeps the obligation the count would otherwise
  // drop: a provider that declares a NON-default value is the one that changes what leaves the
  // machine, and it must name its own record.
  for (const row of providers) {
    if (row.capability === REGISTRY_VALUE) continue;
    assert.notEqual(
      row.evidence,
      undefined,
      `${row.id} declares '${row.capability}', which changes what leaves the machine, but names no paired experiment`,
    );
  }
  const named = providers.filter((row) => row.evidence !== undefined);
  assert.equal(
    new Set(named.map((row) => row.evidence)).size,
    named.length,
    `two providers rest on the same paired experiment (${named.map((row) => `${row.id}->${row.evidence}`).join(', ')}) — decision 1 obliges the provider, so one of them is unmeasured`,
  );
});

test('a provider\'s evidence row retargeted at another provider\'s record is visible in the reading', (t) => {
  const root = greenRig(t);

  patch(root, REGISTRY, MULTIMODAL_EVIDENCE_ROW, MULTIMODAL_EVIDENCE_ROW_RETARGETED);
  const { providers } = registryDeclarations(root);
  const evidence = new Map(providers.map((row) => [row.id, row.evidence]));

  // The reading followed the tree. Without this half the case above could be asserting a constant
  // and never opening the registry at all.
  assert.equal(
    evidence.get(MULTIMODAL_PROVIDER),
    WHISPER_RECORD,
    `the reading did not follow the mutated row (${evidence.get(MULTIMODAL_PROVIDER)})`,
  );
  // The collision is the reading: among the rows that NAME a record, n rows and n - 1 distinct
  // records mean exactly one pair collided.
  //
  // SCOPED TO THE NAMED ROWS, and this is the count's own shape rather than a relaxation of it. The
  // registry now carries providers that name no record at all — `sensevoice-local` and
  // `sensevoice-wasm` sit on the `destructive` default, which needs no paired measurement — and
  // their two `undefined` evidence values collapse into a single set entry, so counting every row
  // would read their shared silence as a collision. The sibling case above excludes them the same
  // way, for the same reason: `undefined` is not a record. Stated against the named row count rather
  // than as a literal, so it keeps saying "exactly one pair collided" as providers are added —
  // which is the shape this case exists to catch.
  const named = providers.filter((row) => row.evidence !== undefined);
  assert.equal(
    new Set(named.map((row) => row.evidence)).size,
    named.length - 1,
    'the retargeted row and the row it was pointed at now rest on one record — the shape this case exists to catch',
  );
});
