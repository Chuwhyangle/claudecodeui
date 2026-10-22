#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-dashscope-omni-check.mjs (AC-138).
 *
 * Each case first runs the probe against an UNMUTATED fixture and requires green, then applies
 * exactly one mutation and requires red naming the token the fake form should trip. Both halves
 * matter: the second is what proves the probe notices the fake form, and the first is what proves
 * the red came from the mutation rather than from a probe that is red on every input. A criterion
 * that is red whatever the tree says would pass every "must be red" claim in the task while
 * measuring nothing, which is the failure mode this file exists to close.
 *
 * THE FIXTURE IS BUILT AT RUN TIME, IN A TEMPORARY DIRECTORY, OUT OF THE SHIPPING FILES — copied,
 * never re-typed. A hand-written stub would only prove the probe reads the stub; a copy of the real
 * modules is what makes these cases evidence about this repository's adapter rather than about a
 * paragraph describing it. The probe reaches the fixture through `--root`, which is the only way it
 * can be pointed at a tree other than its own.
 *
 * THE TOKENS ARE THE PROBE'S OWN, and the cases below assert them rather than merely the exit code:
 * a probe that went red for an unrelated reason would otherwise count as evidence for every claim
 * here at once. Where a fake form could trip more than one reading — a system turn that lost a
 * segment is both a missing segment and a wrong composition — the case asserts the reading that
 * NAMES the thing the fake form changed.
 *
 * Run with: node --test scripts/asr-dashscope-omni-check.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBE = path.join(SCRIPT_DIR, 'asr-dashscope-omni-check.mjs');

/**
 * The shipping files a fixture needs: everything the probe loads, and the two files that say how the
 * tree is compiled and loaded.
 *
 * `package.json` IS NOT DECORATION. Its `"type": "module"` is what makes the loader treat a `.ts`
 * module as ESM, and without it the fixture's own imports are resolved as CommonJS and the probe
 * cannot load the adapter at all (`asr-second-adapter-check.test.mjs` measured this as
 * `ERR_REQUIRE_CYCLE_MODULE`). `tsconfig.json` comes along for the same reason: the fixture is meant
 * to be loaded the way the repository is loaded, not under a hand-written approximation of it.
 *
 * The board is in the list because the probe feeds it the shipping adapter, and the registry because
 * the probe reads the contract face out of it. Neither is registered or dispatched through — the
 * adapter under test is not in `REGISTERED` (that is a later task) — so the fixture's registry is
 * the shipping one, copied rather than trimmed.
 */
const SHIPPING_FILES = [
  'package.json',
  'tsconfig.json',
  'shared/asr/asrRegistry.ts',
  'shared/asr/asrInvariants.ts',
  'shared/asr/transcriptionWire.ts',
  'shared/asr/list/multimodal/multimodal.asr-provider.ts',
  'shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts',
  'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts',
  // The relay row shares this adapter's helpers and is imported by the registry, so it has to be
  // in the fixture or the registry cannot load at all.
  'shared/asr/list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.ts',
  'shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.ts',
  // THE CLIENT ADAPTER'S MODULE IS PART OF THE FIXTURE, not an optional extra: the registry imports
  // this module at load time to build its `REGISTERED` row, so a fixture without it cannot load the
  // registry at all. It is the fifth wiring shape — a recogniser that runs in the user's own browser
  // and is handed an engine rather than an address — and the module the registry imports back.
  'shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider.ts',
];

/** The module under test: every mutation below but one is applied to this file. */
const ADAPTER = 'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts';
/** The contract face the wire member and the degradation field live on. */
const REGISTRY = 'shared/asr/asrRegistry.ts';
/** The contract board, whose rows the probe measures the shipping adapter against. */
const BOARD = 'shared/asr/asrInvariants.ts';

/** @returns {string} the fixture root */
function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-dashscope-omni-'));
  for (const relativePath of SHIPPING_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO_ROOT, relativePath), destination);
  }
  return root;
}

/**
 * @param {string} root
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runProbe(root) {
  const result = spawnSync(process.execPath, [PROBE, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
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
    `the unmutated fixture must pass, otherwise the mutation below proves nothing:\n${baseline.stdout}`,
  );
  return root;
}

/**
 * Replaces `from` with `to`, refusing to silently no-op on a fixture that has drifted, and refusing
 * an anchor that is not unique.
 *
 * THE UNIQUENESS CHECK IS THIS FILE'S ADDITION to the precedent it follows. A `String.replace` with a
 * non-unique anchor rewrites the first occurrence and leaves the rest, which means the case would
 * still run — against a tree that is not the one the case describes. Naming the count is what turns
 * that into a failing test instead of a green one measuring something else.
 *
 * @param {string} root
 * @param {string} relativePath
 * @param {string} from
 * @param {string} to
 */
function patchFixtureFile(root, relativePath, from, to) {
  const filePath = path.join(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  const occurrences = source.split(from).length - 1;
  assert.equal(
    occurrences,
    1,
    `${relativePath} contains ${occurrences} occurrence(s) of the anchor this case mutates, expected exactly 1:\n${from}`,
  );
  writeFileSync(filePath, source.replace(from, to));
}

/**
 * One control: the unmutated tree is green first, then exactly one edit is applied and the named
 * token must be the one that fires.
 *
 * The token is matched with a word boundary rather than a colon, so both shapes the probe prints are
 * accepted: a reading that disagreed prints `FAIL <TOKEN> <id> value=… expected=…`, and a structural
 * failure prints `FAIL <TOKEN>: <reason>`. Matching only one of the two would let a case pass by
 * finding the other form of an unrelated problem.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ name: string, file: string, from: string, to: string, token: string, names?: string }} control
 */
function control(t, { name, file, from, to, token, names }) {
  const root = greenFixture(t);
  patchFixtureFile(root, file, from, to);
  const result = runProbe(root);
  assert.notEqual(result.status, 0, `${name} must not pass:\n${result.stdout}`);
  assert.match(
    result.stdout,
    new RegExp(`^FAIL ${token}\\b`, 'm'),
    `${name} must be caught by ${token}:\n${result.stdout}`,
  );
  if (names !== undefined) {
    assert.ok(
      result.stdout.includes(names),
      `${name} must name ${names} in the reading that fired:\n${result.stdout}`,
    );
  }
}

// ── AC1: an empty root is an empty reading, not a green run ──────────────────────────────────

test('AC1: a tree that does not hold the seam is red with EMPTY_READING rather than silently green', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-dashscope-omni-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runProbe(root);
  assert.notEqual(result.status, 0, `an empty root must not pass:\n${result.stdout}`);
  assert.match(result.stdout, /^FAIL EMPTY_READING\b/m, `an empty root must say what was not measured:\n${result.stdout}`);
  // The cause is on the output too: a run that produced no readings has to say WHY, or the absence
  // is indistinguishable from a probe that never started.
  assert.match(result.stdout, /adapter-module=<none>|no module under shared\/asr\//, result.stdout);
});

// ── AC2: the request's shape ─────────────────────────────────────────────────────────────────

test('AC2: a system turn that lost a segment is caught by the reading that names it', (t) => {
  control(t, {
    name: 'a prompt built from two of the three segments',
    file: ADAPTER,
    from: '  return `${ROLE}\\n\\n${RULES}\\n\\n${EXAMPLES}`;',
    to: '  return `${ROLE}\\n\\n${EXAMPLES}`;',
    token: 'PROMPT_SEGMENT_MISSING',
    names: 'prompt.segment.RULES.in-system',
  });
});

test('AC2: relaxed decode parameters are caught on the body', (t) => {
  control(t, {
    name: 'a request that streams and spends a different decode budget',
    file: ADAPTER,
    from: ['    stream: false,', "    reasoning_effort: REASONING_EFFORT,"].join('\n'),
    to: ['    stream: true,', "    reasoning_effort: 'high',"].join('\n'),
    token: 'REQUEST_PARAMS_MISMATCH',
  });
});

// ── AC3: the prompt on the wire is the shipping module's own ──────────────────────────────────

test('AC3: a segment the module no longer exports is caught, and the segment is named', (t) => {
  control(t, {
    name: 'a segment the module keeps for itself, so the composition on the wire is a shorter prompt',
    file: ADAPTER,
    from: 'export const RULES = `',
    to: 'const RULES_UNUSED = `',
    token: 'PROMPT_SEGMENT_SHA256_MISMATCH',
    names: 'prompt.segment-sha256.RULES',
  });
});

test('AC3: a segment changed by ONE character is caught by its recorded hash', (t) => {
  // This is the case the recorded hashes exist for. The composed system turn and the wire's system
  // turn are built from the same constant, so they agree with each other whatever that constant says
  // — a comparison between the two could not see this edit. Only the hash, held on the tooling side,
  // can. The one character is inside a rule rather than in the segment's opening words, so the case
  // does not need the anchor to be a distinctive prefix.
  control(t, {
    name: 'a prompt segment whose text moved by one character',
    file: ADAPTER,
    from: '2. 删掉口头禅和填充词（嗯、那个、就是、啊）。',
    to: '2. 删掉口头禅和填充词（嗯、那个、就是、诶）。',
    token: 'PROMPT_SEGMENT_SHA256_MISMATCH',
    names: 'prompt.segment-sha256.RULES',
  });
});

// ── AC4: the format field ────────────────────────────────────────────────────────────────────

test('AC4: a format that is a constant rather than a derivation is caught by the mime rows', (t) => {
  control(t, {
    name: 'a format field written once instead of derived from the recording',
    file: ADAPTER,
    from: '  return alias === undefined ? subtype : alias;',
    to: "  return 'mp3';",
    token: 'FORMAT_MISMATCH',
    names: 'format-by-mime[audio/webm;codecs=opus]',
  });
});

// ── AC6: the degradation ─────────────────────────────────────────────────────────────────────

test('AC6: returning the raw content as the text is caught by the degradation group', (t) => {
  control(t, {
    name: 'a fallback that hands the answer\'s whole content back as the transcription',
    file: ADAPTER,
    from: '      text: transcript,',
    to: '      text: content,',
    token: 'DEGRADATION_WRONG_TEXT',
  });
});

// ── AC8: the error mapping ───────────────────────────────────────────────────────────────────

test('AC8: filing an unenabled model as a refused credential is caught', (t) => {
  // THE MUTATION MOVED WITH THE IMPLEMENTATION. The mapping this case falsifies used to be a
  // status-only function in the ADAPTER; it is now `classifyUpstreamFailure` in the registry
  // (`shared/asr/asrRegistry.ts`), so the mutation is the one rule that tells the two 403s apart —
  // the code string the body names. Applied to the adapter the anchor no longer exists, and a case
  // whose anchor had drifted is a case that would fail for a reason unrelated to its claim.
  control(t, {
    name: 'a body naming an unenabled model filed as a refused credential, so the two 403s collapse onto one code',
    file: REGISTRY,
    from: "  { token: 'AccessDenied.Unpurchased', code: 'ACCOUNT_ACCESS' },",
    to: "  { token: 'AccessDenied.Unpurchased', code: 'UNAUTHORIZED' },",
    token: 'ERROR_CODE_MISMATCH',
    names: 'error.403-unpurchased.code',
  });
});

// ── AC9: the budget ──────────────────────────────────────────────────────────────────────────

test('AC9: an oversize request that is still sent is caught by the call counter', (t) => {
  control(t, {
    name: 'a guard that is declared but never fires, so the over-budget audio leaves anyway',
    file: ADAPTER,
    from: '  if (requestBytes > capabilities.maxInlineRequestBytes) {',
    to: '  if (false) {',
    token: 'OVERSIZE_SENT_REQUESTS',
  });
});

// ── AC12: the offline guard ──────────────────────────────────────────────────────────────────

test('AC12: an adapter that reaches for the ambient transport is caught by the poison', (t) => {
  control(t, {
    name: 'an adapter that uses the ambient fetch instead of the injected transport',
    file: ADAPTER,
    from: '    response = await invocation.fetchImpl(endpoint, {',
    to: '    response = await fetch(endpoint, {',
    token: 'NETWORK_CALL',
  });
});

// ── AC13: the contract face ──────────────────────────────────────────────────────────────────

test('AC13: a wire tag that disagrees with the body sent is caught by the board', (t) => {
  // The claim is a CLAIM, so this is the case that proves it: the adapter declares the wire it does
  // not speak. The board resolves a different row for the declaration and then measures the request
  // against it, so the body no longer matches — which is the reading that makes the tag worth
  // declaring. `names` pins WHICH reading, so a board that red for an unrelated reason is not
  // mistaken for this one.
  control(t, {
    name: 'an adapter that declares the inline-json wire while sending a chat-audio body',
    file: ADAPTER,
    from: "export const wire: AsrWire = 'chat-audio';",
    to: "export const wire: AsrWire = 'inline-json';",
    token: 'BOARD_READING_FAILED',
    names: 'board:request.url[dashscope-omni]',
  });
});

test('AC13: a board group that produced no readings is a failure, not a silent green', (t) => {
  // The row this task adds is a claim, and the probe's reason for feeding it the shipping adapter is
  // so the row cannot be a declaration with nothing behind it. A group that returned nothing at all
  // is the shape that would otherwise pass: zero readings, zero failures, green. The mutation is the
  // shortest one that produces it.
  control(t, {
    name: 'a probe group that returns no readings at all',
    file: BOARD,
    from: [
      'export async function probeSizeLayering(provider: AsrAdapter): Promise<InvariantReading[]> {',
      "  const group: InvariantGroupId = 'size-layering';",
    ].join('\n'),
    to: [
      'export async function probeSizeLayering(provider: AsrAdapter): Promise<InvariantReading[]> {',
      '  if (provider !== null) return [];',
      "  const group: InvariantGroupId = 'size-layering';",
    ].join('\n'),
    token: 'BOARD_GROUP_EMPTY',
    names: 'board.size-layering.readings',
  });
});

// ── the contract face itself ─────────────────────────────────────────────────────────────────

test('AC13: the wire member and the degradation field are read out of the registry source', (t) => {
  // Both halves are the tree's own statements rather than the probe's: the probe reads them from the
  // registry file it discovered, and this case takes each one away in turn. Without the member the
  // adapter's declaration has no name in the contract; without the field the degradation is a
  // behaviour nothing can select on.
  control(t, {
    name: 'a contract whose wire union does not name the new shape',
    file: REGISTRY,
    from: "export type AsrWire = 'chat-audio' | 'inline-json' | 'multipart';",
    to: "export type AsrWire = 'inline-json' | 'multipart';",
    token: 'WIRE_MEMBER_ABSENT',
  });
});

test('AC13: a success envelope with no field for the degradation is caught', (t) => {
  control(t, {
    name: 'a success envelope that cannot say the rewrite was skipped',
    file: REGISTRY,
    from: '    writtenFallback?: number;',
    to: '    writtenFallbackRemoved?: number;',
    token: 'META_FIELD_ABSENT',
  });
});
