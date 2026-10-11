#!/usr/bin/env node
/**
 * Operator entry point for the voice turn-detection comparison harness
 * (task `gap-voice-turn-detection-pluggable-comparison-p0`, SPEC
 * `docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md`).
 *
 * It does exactly two things, and both are things `run.mts` deliberately cannot do itself:
 *
 *   1. `--harness` (the default). Make sure the Smart Turn v3.2 CPU ONNX weights are in a local
 *      cache — download ONCE from the model's own Hugging Face repo, verify the sha256, keep the
 *      file — and then hand off to `experiments/voice-turn-detection-compare/run.mts` under `tsx`.
 *      The harness writes `experiments/voice-turn-detection-compare/RESULT.json`. The download is
 *      in this file, not in the harness, so a reader of the harness sees a pure measurement with no
 *      network side effect, and a reader of THIS file sees the one place anything is fetched.
 *
 *   2. `--probe-qwen`. A real, paid, non-realtime BATCH of calls to `qwen3.8-omni-flash` answering
 *      the SPEC Go/No-Go row "非实时 qwen 可行性". The P0 single-call probe could only say
 *      "no function_call on this one clip" — a reading that cannot tell a structurally incapable
 *      interface apart from a clip/prompt that simply did not warrant a call. This is the AC7
 *      redesign: TWO clips (one an unambiguous executable command, one P0's hesitant control) x
 *      THREE prompt-explicitness levels (P0's implicit instruction with `tool_choice=auto`; an
 *      explicit instruction naming the tool, still `auto`; the explicit one with the call FORCED
 *      via `tool_choice`), a 5-call matrix whose readings separate
 *        · interface-structural support (does the wire accept audio+tools at all),
 *        · prompt-not-triggered (implicit→text but explicit→call),
 *        · schema problem (a forced call that still yields no conforming call),
 *        · model-chose-not-to-call (explicit prompt, unambiguous clip, still text).
 *      It costs money, so the budget is written to RESULT.json BEFORE the first request is sent
 *      (see the two-phase note below) and every raw response body is preserved verbatim.
 *
 * ── THE BUDGET IS TWO-PHASE, ON PURPOSE ────────────────────────────────────────────────────────
 * A spend cap that is only checked after the response arrives records nothing if the process dies
 * mid-call. So `runProbe` (a) computes a worst-case upper bound for the WHOLE matrix from each
 * clip's duration, the declared output cap and a deliberately pessimistic token rate; (b) REFUSES
 * to send anything if that bound exceeds the batch cap; (c) writes `qwenProbe.status = "armed"` with
 * the bound, the matrix plan, and the CUMULATIVE baseline (P0's already-spent ¥0.00242) into
 * RESULT.json; and only then (d) sends the calls one by one, appending each result and aborting the
 * remainder if the running spend would exceed the cap, and finally rewrites the block as
 * `"completed"` with the real usage. An interrupted run therefore leaves the armed record — the cap
 * and what it was measuring — rather than a silent hole.
 *
 * ── CREDENTIAL HYGIENE (inherited from experiments/voice-realtime-turn-detection/compare.mts) ───
 * `DASHSCOPE_API_KEY` is read from the environment only — never from a file this script parses —
 * and travels in a request header only. The artifact is scrubbed of the live key and of every
 * `sk-…`-shaped token before it is written, and `writeResult` REFUSES to write one that still
 * carries a credential or a request-auth header name.
 *
 * ── WHY THE REALTIME SIDE OF THE COMPARISON IS CITED, NOT RE-RUN ───────────────────────────────
 * The SPEC's probe step 3 says to run the same clip through the Realtime path and place the two
 * `usage` blocks side by side. The sibling task (`experiments/voice-realtime-turn-detection/`) has
 * ALREADY run this exact clip — same file, same 15.733 s — through three Realtime arms, and its
 * `RESULT.json` records the usage and the per-response cost. This task's 边界 forbids re-running
 * that comparison and the SPEC's 非目标 forbids duplicate spend, so the probe CITES the recorded
 * arm instead of re-billing it, and records the citation as its basis. Re-running would add a
 * second draw of a number that is already on the record, not new information.
 *
 * Usage:
 *   node scripts/voice-turn-detection-compare.mjs                # model + harness (no spend)
 *   node scripts/voice-turn-detection-compare.mjs --emit-manifest
 *   node scripts/voice-turn-detection-compare.mjs --offline      # fail instead of downloading
 *   DASHSCOPE_API_KEY=… node scripts/voice-turn-detection-compare.mjs --probe-qwen
 *   node scripts/voice-turn-detection-compare.mjs --reclassify   # recompute readings offline, no spend
 *   node scripts/voice-turn-detection-compare.mjs --all          # harness then probe
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '..');

const EXP_REL = 'experiments/voice-turn-detection-compare';
const EXP_DIR = path.join(REPO_ROOT, EXP_REL);
const RESULT_FILE = path.join(EXP_DIR, 'RESULT.json');
const RUN_MTS = path.join(EXP_DIR, 'run.mts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

// ── the model (step 1) ─────────────────────────────────────────────────────────────────────────

/** Pipecat's int8 CPU export of Smart Turn v3.2 — the file group B measures. */
const MODEL_FILE_NAME = 'smart-turn-v3.2-cpu.onnx';
const MODEL_URL = `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/${MODEL_FILE_NAME}`;
/** Pinned so a re-download that silently changed the weights cannot pass as the same measurement. */
const MODEL_SHA256 = '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f';
const MODEL_CACHE_DIR = path.join(os.homedir(), '.cache', 'voice-turn-detection-compare');
const MODEL_PATH = path.join(MODEL_CACHE_DIR, MODEL_FILE_NAME);

// ── the paid probe (step 2 — AC7 redesign) ─────────────────────────────────────────────────────

const PROBE_MODEL = 'qwen3.8-omni-flash';
const CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const SIBLING_RESULT_REL = 'experiments/voice-realtime-turn-detection/RESULT.json';
/**
 * The hard cap for the WHOLE reshaped probe. The SPEC's §非实时探针 wrote ≤ ¥0.02 for P0's SINGLE
 * call; the AC7 matrix is five calls (see PROBE_LEVELS), so the cap is scaled to the batch and
 * written to the artifact before the first request, exactly as P0's was.
 */
const PROBE_CAP_CNY = 0.03;
/** Bounded output so the completion side of the worst case is a constant, not a hope. */
const PROBE_MAX_TOKENS = 256;
/**
 * Price of `qwen3.8-omni-flash-realtime` in CNY per 1,000 tokens, as billed in October 2026 —
 * `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:156`. The NON-realtime omni
 * price is not published in this repository, so the realtime table is used as a CONSERVATIVE proxy
 * (realtime audio input is the dearer of the two). Every number derived from it is labelled
 * `costBasis` so a reader can re-price the raw `usage` against the real invoice.
 */
const PRICE_CNY_PER_1K = { textInput: 0.0015, audioInput: 0.006, textOutput: 0.0045 };
/**
 * Pessimistic audio tokenisation rate for the pre-call guard. Alibaba documents ~25 tokens per
 * second of audio for the omni models; 50 is used so the upper bound holds even if that doubles.
 */
const AUDIO_TOKENS_PER_SECOND_GUARD = 50;
/** Prompt text (system + tool declaration + instruction), over-estimated on purpose. */
const PROMPT_TEXT_TOKENS_GUARD = 200;

/** P0's one completed probe call, cited so the cumulative figure is honest about money already spent. */
const P0_PROBE_CNY = 0.00242;
const P0_PROBE_RECORDED_AT = '2026-10-10T17:26:09.385Z';
/**
 * P0's probe ledger, carried forward verbatim so the AC7 batch's cumulative figure starts from the
 * money already spent rather than from zero. Row 1 is P0's very first attempt (bounded, not
 * measured, because the credential guard refused the write); rows 2–3 are diagnostics; rows 4–6 are
 * P0's three recorded calls, of which row 6 (`costCny` ¥0.00242) is the one P0's artifact holds.
 * Lifted into a constant so the new batch's ledger APPENDS to it instead of restating it.
 */
const P0_PRIOR_CALLS = [
  { n: 1, via: 'scripts/voice-turn-detection-compare.mjs --probe-qwen', httpStatus: 200, costCny: null, upperBoundCny: 0.006174, note: 'the response arrived but the write was refused by this file’s credential guard, which at that point matched the plain English word "authorization" in the harness’s own caveat text. The body was not retained, so this call is bounded by the pre-call estimate rather than measured.' },
  { n: 2, via: 'an ad-hoc diagnostic with the identical request body', httpStatus: 200, costCny: 0.002195, upperBoundCny: null, note: 'usage prompt 548 (audio 107 / text 441) / completion 198 (reasoning 178). Sent only to find out whether the provider or the writer was at fault.' },
  { n: 3, via: 'an inline diagnostic with the identical request body', httpStatus: 200, costCny: 0.002195, upperBoundCny: null, note: 'the same usage again: the first diagnostic printed the body but not the usage fields separately, and the split is what the cost model needs.' },
  { n: 4, via: 'scripts/voice-turn-detection-compare.mjs --probe-qwen', httpStatus: 200, costCny: 0.002429, upperBoundCny: null, note: 'the first call that actually reached RESULT.json; superseded because the verdict still needed the wire-accepts-tools distinction recorded beside it.' },
  { n: 5, via: 'scripts/voice-turn-detection-compare.mjs --probe-qwen', httpStatus: 200, costCny: 0.002019, upperBoundCny: null, note: 'the call that added the nuance; superseded by the recorded one, which corrects the ledger itself.' },
  { n: 6, via: 'scripts/voice-turn-detection-compare.mjs --probe-qwen', httpStatus: 200, costCny: 0.00242, upperBoundCny: null, note: 'P0’s RECORDED call — the one whose verdict P0’s SPEC row quoted, and the ¥0.00242 this task’s cumulative figure must include. Its clip is the p0-hesitant-control of this redesign.' },
];
/** P0's ledger total: row 1 at its bound plus rows 2–6 measured (includes the recorded ¥0.00242). */
const P0_PRIOR_TOTAL_UPPER_BOUND_CNY = 0.017432;
/**
 * The ONE cell P0 recorded, named exactly so the redesign can ask whether it REPRODUCES. P0 sent
 * the p0-hesitant-control clip with the implicit instruction and `tool_choice=auto` and got text
 * back (verdict `unsupported`). This batch sends the identical request; if the model now calls, the
 * P0 reading was a single sample of a nondeterministic model, not a stable property of the path.
 */
const P0_RECORDED_CELL = {
  clipId: 'p0-hesitant-control',
  levelId: 'implicit-auto',
  outcome: 'text-only',
  textAnswer: '好的——想在哪个设置页面、加一个控制什么的开关？',
  recordedAt: P0_PROBE_RECORDED_AT,
};

/**
 * AC7: ≥ 2 clips. One is an UNAMBIGUOUS executable command — a plain, complete imperative naming a
 * file and a concrete change, so a text-only reply cannot be explained by the audio being unclear.
 * The other is P0's SAME hesitant clip verbatim, kept as the control: a text reply there is the
 * expected behaviour and proves nothing on its own.
 */
const PROBE_CLIPS = [
  {
    id: 'unambiguous-command',
    rel: 'experiments/voice-trim/fixtures/zh-d01-o85.wav',
    language: 'zh',
    kind: 'unambiguous-command',
    reference: '把 server 里的 voice.service.ts 的超时改成三十秒',
    why:
      'a complete imperative that names the file and the exact change — unambiguously actionable, so "the model replied in text" cannot be explained by an unclear request',
  },
  {
    id: 'p0-hesitant-control',
    rel: 'experiments/voice-trim/fixtures/zh-d13-o45.wav',
    language: 'zh',
    kind: 'p0-control-hesitant',
    reference: '呃…我想想…就是在那个设置页面…嗯…加一个开关',
    why:
      "P0's exact clip, re-run at all three prompt levels: the same audio P0 measured, now placed beside a level that mandates the call, so the P0 reading is bounded rather than replaced",
  },
];

/** The `session_send` tool as the Realtime voice path declares it — `voice-realtime-tools.ts:200`. */
const TOOL_DECLARATION = {
  type: 'function',
  function: {
    name: 'session_send',
    description:
      'Send a message to a session, returning the run id at once. A queued message does not answer a pending approval; use approval_answer to answer it.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The session to send to.' },
        message: { type: 'string', description: 'The message body.' },
        waitSeconds: { type: 'number', description: 'How long to wait for the run before returning.' },
      },
      required: ['session', 'message'],
    },
  },
};

/** Level 1 — P0's instruction, WORD FOR WORD. The baseline the redesign varies against. */
const PROBE_INSTRUCTION_IMPLICIT =
  'You are the voice assistant embedded in this repository’s UI. The user just spoke; their audio ' +
  'is attached. If they are asking you to change something, call the tool that carries the request ' +
  'out. If they are only thinking aloud, reply with one short sentence instead.';

/** Level 2 — names the tool and mandates the call for any change request. */
const PROBE_INSTRUCTION_EXPLICIT =
  'You are the voice assistant embedded in this repository’s UI; the user’s audio is attached. ' +
  'You have exactly one tool, session_send, which sends a message to a session. If the user asks ' +
  'you to change, add, fix, remove or look at anything in this repository — under ANY wording, ' +
  'including a bare imperative such as “把超时改成三十秒” — you MUST call session_send and put their ' +
  'request in the message argument. Do NOT answer such a request in text. Reply with text only ' +
  'when the user is merely thinking aloud and asks for nothing.';

/**
 * The AC7 matrix. Each level is one (instruction, tool_choice) pair; `onClips` names which clips it
 * is sent with. Level 3 is sent on the unambiguous clip ONLY: forcing the call is a probe of the
 * INTERFACE and the SCHEMA, not of the clip, and one clip is enough to answer it — running it on
 * both would be four wasted cents' worth of a question already answered by the first.
 */
const PROBE_LEVELS = [
  {
    id: 'implicit-auto',
    label: 'P0’s implicit instruction, tool_choice=auto',
    instruction: PROBE_INSTRUCTION_IMPLICIT,
    toolChoice: 'auto',
    onClips: ['unambiguous-command', 'p0-hesitant-control'],
    isolates:
      'the P0 behaviour on both clips — whether an un-prompted request produces a call. A text reply here is what P0 already saw and is NOT by itself evidence about the interface',
  },
  {
    id: 'explicit-auto',
    label: 'explicit instruction naming the tool, tool_choice=auto',
    instruction: PROBE_INSTRUCTION_EXPLICIT,
    toolChoice: 'auto',
    onClips: ['unambiguous-command', 'p0-hesitant-control'],
    isolates:
      'prompt-not-triggered vs model-chose-not-to-call: if implicit→text but explicit→call, the trigger was the PROMPT; if explicit→text on the unambiguous clip too, the model saw a mandatory instruction and stayed in text',
  },
  {
    id: 'explicit-forced',
    label: 'explicit instruction, tool_choice FORCED to session_send',
    instruction: PROBE_INSTRUCTION_EXPLICIT,
    toolChoice: { type: 'function', function: { name: 'session_send' } },
    onClips: ['unambiguous-command'],
    isolates:
      'interface-structural support and schema validity: a forced call that still yields no conforming tool_call (or an HTTP/schema error) is an INTERFACE/SCHEMA finding, independent of any prompt',
  },
];

// ── small helpers ──────────────────────────────────────────────────────────────────────────────

/** @param {string} p */
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** @param {number} n */
function mb(n) {
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Node's `fetch` or a clear failure — the probe is the only thing here that talks to the network. */
function getFetch() {
  const f = globalThis.fetch;
  if (typeof f !== 'function') throw new Error(`this Node has no global fetch (${process.version}); the probe needs one`);
  return f;
}

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(msg);
  process.exit(1);
}

// ── step 1: model ──────────────────────────────────────────────────────────────────────────────

/**
 * The cached model path, downloading it once if it is absent or fails its checksum.
 * @param {{ offline: boolean }} args
 */
async function ensureModel(args) {
  if (existsSync(MODEL_PATH)) {
    const digest = sha256File(MODEL_PATH);
    if (digest === MODEL_SHA256) {
      console.log(`model: cached ${MODEL_PATH} (sha256 ok, ${mb(statSync(MODEL_PATH).size)})`);
      return MODEL_PATH;
    }
    console.log(`model: cached copy has sha256 ${digest}, expected ${MODEL_SHA256} — re-fetching`);
  }
  if (args.offline) {
    die(`model: ${MODEL_PATH} is missing or wrong and --offline forbids the download (${MODEL_URL})`);
  }
  console.log(`model: downloading ${MODEL_URL}`);
  const res = await getFetch()(MODEL_URL, { redirect: 'follow' });
  if (!res.ok) die(`model: download failed with HTTP ${res.status} from ${MODEL_URL}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== MODEL_SHA256) {
    die(
      `model: downloaded file has sha256 ${digest}, expected ${MODEL_SHA256}.\n` +
        'Refusing to keep it: a different file would silently make group B a different measurement.',
    );
  }
  mkdirSync(MODEL_CACHE_DIR, { recursive: true });
  const tmp = `${MODEL_PATH}.partial`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, MODEL_PATH);
  console.log(`model: wrote ${MODEL_PATH} (${mb(bytes.length)}, sha256 ok)`);
  return MODEL_PATH;
}

/** @param {string} modelPath */
function runHarness(modelPath) {
  if (!existsSync(TSX_BIN)) die(`harness: ${TSX_BIN} not found — run npm install (or the worktree setup script)`);
  console.log('harness: tsx experiments/voice-turn-detection-compare/run.mts');
  const res = spawnSync(TSX_BIN, [RUN_MTS, '--model', modelPath], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (res.error) die(`harness: failed to spawn: ${String(res.error)}`);
  if (res.status !== 0) die(`harness: run.mts exited ${res.status}`);
}

function emitManifest() {
  if (!existsSync(TSX_BIN)) die(`manifest: ${TSX_BIN} not found`);
  const res = spawnSync(TSX_BIN, [RUN_MTS, '--emit-manifest'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (res.status !== 0) die(`manifest: run.mts --emit-manifest exited ${res.status}`);
}

// ── credentials, scrubbing (same contract as the sibling harness) ──────────────────────────────

const SECRET_SHAPE = /sk-[A-Za-z0-9_-]{16,}/g;

function readApiKey() {
  const key = process.env.DASHSCOPE_API_KEY ?? '';
  if (key === '') {
    die('probe: DASHSCOPE_API_KEY is not set — `set -a; . <main-checkout>/.env.test; set +a` first.');
  }
  return key;
}

/**
 * Replaces the live key and every `sk-…`-shaped token with `<redacted>`.
 * @param {string} text
 * @param {string} apiKey
 */
function scrubSecrets(text, apiKey) {
  let out = text;
  let scrubbed = 0;
  if (apiKey !== '') {
    scrubbed += out.split(apiKey).length - 1;
    out = out.split(apiKey).join('<redacted>');
  }
  out = out.replace(SECRET_SHAPE, () => {
    scrubbed += 1;
    return '<redacted>';
  });
  return { text: out, scrubbed };
}

/**
 * Writes RESULT.json, scrubbed, refusing to write one that still carries a credential.
 * @param {Record<string, unknown>} payload
 * @param {string} apiKey
 */
function writeResult(payload, apiKey) {
  const { text, scrubbed } = scrubSecrets(JSON.stringify(payload, null, 2), apiKey);
  SECRET_SHAPE.lastIndex = 0;
  if (SECRET_SHAPE.test(text)) die('refusing to write RESULT.json: a sk-…-shaped string survived scrubbing');
  SECRET_SHAPE.lastIndex = 0;
  // An auth HEADER NAME is always written as a header (name, then `:` or `=`), which is what this
  // matches. The bare English word is not a credential and must not block the write — this harness's
  // own caveats say "no human-voice authorization was obtained", and a guard that refused that
  // sentence would be refusing the record of the measurement rather than the leak it exists to stop.
  const authName = /["']?Authorization["']?\s*[:=]/i.exec(text);
  if (authName) {
    // `text` is already scrubbed of the live key, so showing the match is safe and is the only way
    // an operator can tell WHICH field tripped the guard (usually a provider error body quoting the
    // request back, which is exactly the thing this guard exists to keep out of the artifact).
    const at = authName.index;
    die(
      'refusing to write RESULT.json: the artifact names a request-auth header. Context: ' +
        JSON.stringify(text.slice(Math.max(0, at - 160), at + 160)),
    );
  }
  writeFileSync(RESULT_FILE, `${text}\n`, 'utf8');
  return scrubbed;
}

/** @returns {Record<string, any>} */
function readResult() {
  if (!existsSync(RESULT_FILE)) {
    die(`probe: ${RESULT_FILE} is missing — run the harness step first (node scripts/voice-turn-detection-compare.mjs)`);
  }
  return JSON.parse(readFileSync(RESULT_FILE, 'utf8'));
}

// ── step 2: the paid probe ─────────────────────────────────────────────────────────────────────

/** @param {string} rel */
function readClip(rel) {
  const abs = path.join(REPO_ROOT, rel);
  const wav = readFileSync(abs);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${rel} is not a RIFF/WAVE file`);
  }
  // Canonical 44-byte header; the fixtures are 16-bit mono PCM (checked when the module was built).
  const dataBytes = wav.readUInt32LE(40);
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bits = wav.readUInt16LE(34);
  return {
    abs,
    bytes: wav.length,
    sha256: createHash('sha256').update(wav).digest('hex'),
    seconds: Number(((dataBytes / (channels * (bits / 8))) / sampleRate).toFixed(3)),
    dataUri: `data:audio/wav;base64,${wav.toString('base64')}`,
  };
}

/**
 * The worst-case cost of the request we are about to send: audio tokens at the pessimistic rate,
 * prompt text over-estimated, and the completion at its own declared cap. If this exceeds the cap
 * the request is never sent.
 * @param {number} seconds
 */
function worstCaseCost(seconds) {
  const audioTokens = Math.ceil(seconds * AUDIO_TOKENS_PER_SECOND_GUARD);
  const textTokens = PROMPT_TEXT_TOKENS_GUARD;
  const outputTokens = PROBE_MAX_TOKENS;
  const cny =
    (textTokens * PRICE_CNY_PER_1K.textInput + audioTokens * PRICE_CNY_PER_1K.audioInput + outputTokens * PRICE_CNY_PER_1K.textOutput) / 1000;
  return {
    cny: Number(cny.toFixed(6)),
    inputs: {
      audioSeconds: seconds,
      audioTokensAtGuardRate: audioTokens,
      audioTokensPerSecondGuard: AUDIO_TOKENS_PER_SECOND_GUARD,
      promptTextTokensGuard: textTokens,
      outputTokensCap: outputTokens,
      priceCnyPer1k: PRICE_CNY_PER_1K,
    },
  };
}

/**
 * The real cost of the call that happened, from the provider's own `usage`. Any token class the
 * provider does not itemise is priced at the text-input rate, which under-charges rather than
 * over-charges — the point is a figure that reconciles with the invoice, not a flattering one.
 * @param {Record<string, any> | null} usage
 */
function actualCost(usage) {
  if (!usage || typeof usage !== 'object') return null;
  /** @param {any} v @returns {number} */
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const audio = num(details.audio_tokens);
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  const text = Math.max(0, prompt - audio);
  const output = num(usage.completion_tokens ?? usage.output_tokens);
  const cny = (text * PRICE_CNY_PER_1K.textInput + audio * PRICE_CNY_PER_1K.audioInput + output * PRICE_CNY_PER_1K.textOutput) / 1000;
  return {
    cny: Number(cny.toFixed(6)),
    tokens: { textInput: text, audioInput: audio, output },
    costBasis:
      'priced from the provider’s own usage with the qwen3.8-omni-flash-realtime table (voice-realtime-dashscope-transport.ts:156) as a proxy; the non-realtime omni price is not published in this repo, so reconcile against the invoice',
    providerItemisedAudio: audio > 0,
  };
}

/**
 * The Realtime side of the SPEC's side-by-side, CITED from the sibling task's record rather than
 * re-billed (see the file header). Returns null if the sibling artifact is not present.
 */
function readRealtimeComparison() {
  const abs = path.join(REPO_ROOT, SIBLING_RESULT_REL);
  if (!existsSync(abs)) return null;
  const sibling = JSON.parse(readFileSync(abs, 'utf8'));
  const arms = Array.isArray(sibling.arms) ? sibling.arms : [];
  if (arms.length === 0) return null;
  return {
    basis:
      'CITED, not re-run: the sibling task experiments/voice-realtime-turn-detection/ already ran THIS clip through the Realtime path; its RESULT.json is the source. Re-running would bill a second draw of a number already on the record and is forbidden by this task’s 边界 and the SPEC’s 非目标.',
    source: SIBLING_RESULT_REL,
    clip: sibling.clip ?? null,
    arms: arms.map(/** @param {any} a */ (a) => ({
      label: a.label,
      clipSeconds: a.audio ? a.audio.clipSeconds : null,
      commits: a.commits ?? null,
      responses: a.responses ?? null,
      inputTokens: a.inputTokens ?? null,
      audioInputTokens: a.audioInputTokens ?? null,
      textInputTokens: a.textInputTokens ?? null,
      outputTokens: a.outputTokens ?? null,
      spendCny: a.spendCny ?? null,
      wallClockMs: a.wallClockMs ?? null,
    })),
  };
}

/**
 * The spend record for the redesigned batch, carrying P0's already-spent money forward rather than
 * starting the clock at zero. `prior` is whatever ledger the PREVIOUS `qwenProbe` block held (P0's,
 * on the first run of this redesign); `rows` are this batch's calls; `batchWorstCaseCny` is the
 * pre-call bound for the batch, used to charge any call that produced no usage.
 * @param {Record<string, any> | null} prior
 * @param {Array<Record<string, any>>} rows
 * @param {number} batchWorstCaseCny
 */
function buildSpendLedger(prior, rows, batchWorstCaseCny) {
  const priorCalls = Array.isArray(prior?.calls) ? prior.calls : P0_PRIOR_CALLS;
  const priorTotal =
    typeof prior?.allCallsTotalUpperBoundCny === 'number' ? prior.allCallsTotalUpperBoundCny : P0_PRIOR_TOTAL_UPPER_BOUND_CNY;
  const measured = rows.filter((r) => typeof r.costCny === 'number');
  const thisBatchMeasuredCny = Number(measured.reduce((a, r) => a + r.costCny, 0).toFixed(6));
  const unmeasured = rows.length - measured.length;
  // Each call that produced no usage (a transport failure, or an over-budget abort) is charged at
  // the pessimistic per-call bound, so the batch total is an upper bound, not a flattering sum.
  const perCallWorst = Number((batchWorstCaseCny / Math.max(1, rows.length)).toFixed(6));
  const thisBatchTotalUpperBoundCny = Number((thisBatchMeasuredCny + unmeasured * perCallWorst).toFixed(6));
  return {
    why:
      'a reader must be able to add up what the probes spent without having to ask what happened during the build. The prior block is P0’s ledger, carried forward verbatim; a re-run replaces THIS batch’s rows and keeps the prior history.',
    priorProbes: {
      label: 'P0 (gap-voice-turn-detection-pluggable-comparison-p0)',
      calls: priorCalls,
      totalUpperBoundCny: priorTotal,
    },
    thisBatch: {
      calls: rows,
      measuredCny: thisBatchMeasuredCny,
      measuredCalls: measured.length,
      unmeasuredCalls: unmeasured,
      totalUpperBoundCny: thisBatchTotalUpperBoundCny,
    },
    cumulativeUpperBoundCny: Number((priorTotal + thisBatchTotalUpperBoundCny).toFixed(6)),
    cumulativeMeasuredCny: Number((P0_PROBE_CNY + thisBatchMeasuredCny).toFixed(6)),
    note:
      'cumulativeUpperBoundCny is the ceiling: P0’s full ledger at P0’s bound plus this batch at its bound. cumulativeMeasuredCny is the floor: only measured calls (P0’s ¥0.00242 plus this batch’s measured usage). The truth lies between; the SPEC’s ≤ cap governs THIS batch’s guard, and P0’s spend is included in the cumulative because the AC7 wording asks for it.',
  };
}

/**
 * One call of the matrix: send one clip at one prompt level, return a flat, reader-shaped record.
 * Non-throwing on transport failure — a single failed cell is a data point (and a partial batch is
 * still a paid-for record), not a reason to lose the rows already collected.
 * @param {Record<string, any>} clip
 * @param {Record<string, any>} level
 * @param {string} key
 */
async function probeOnce(clip, level, key) {
  const body = {
    model: PROBE_MODEL,
    messages: [
      { role: 'system', content: level.instruction },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: clip.dataUri, format: 'wav' } }] },
    ],
    tools: [TOOL_DECLARATION],
    tool_choice: level.toolChoice,
    max_tokens: PROBE_MAX_TOKENS,
    temperature: 0,
  };

  const t0 = Date.now();
  /** @type {Response} */
  let res;
  try {
    res = await getFetch()(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      clipId: clip.id,
      levelId: level.id,
      toolChoiceSent: level.toolChoice,
      status: 'failed-transport',
      transportError: String(err),
      wallClockMs: Date.now() - t0,
      emitted: false,
      costCny: null,
    };
  }
  const wallClockMs = Date.now() - t0;
  const rawText = await res.text();
  /** @type {any} */
  let raw = null;
  try {
    raw = JSON.parse(rawText);
  } catch {
    raw = { unparsedBody: rawText.slice(0, 4000) };
  }

  const message = raw?.choices?.[0]?.message ?? null;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const legacyFunctionCall = message?.function_call ?? null;
  const emitted = toolCalls.length > 0 || legacyFunctionCall !== null;
  const fnName = toolCalls.length > 0 ? toolCalls.map(/** @param {any} c */ (c) => c?.function?.name ?? '?').join(',') : legacyFunctionCall?.name ?? null;
  const argsRaw = toolCalls.length > 0 ? toolCalls[0]?.function?.arguments ?? null : legacyFunctionCall?.arguments ?? null;
  /** @type {any} */
  let fnArguments = null;
  let fnArgumentsParseError = null;
  if (argsRaw != null) {
    try {
      fnArguments = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
    } catch (err) {
      fnArgumentsParseError = String(err);
    }
  }
  const cost = actualCost(raw?.usage ?? null);

  return {
    clipId: clip.id,
    levelId: level.id,
    toolChoiceSent: level.toolChoice,
    status: res.ok ? (emitted ? 'tool-call' : 'text-only') : 'http-error',
    httpStatus: res.status,
    ok: res.ok,
    wallClockMs,
    finishReason: raw?.choices?.[0]?.finish_reason ?? null,
    requestId: raw?.request_id ?? raw?.id ?? null,
    toolCalls,
    legacyFunctionCall,
    emitted,
    functionName: fnName,
    functionArguments: fnArguments,
    functionArgumentsParseError: fnArgumentsParseError,
    textAnswer: message?.content ?? null,
    usage: raw?.usage ?? null,
    errorShape: res.ok ? null : raw?.error ?? raw?.code ?? null,
    costCny: cost ? cost.cny : null,
    cost,
    rawBody: raw,
  };
}

/**
 * Turns the raw matrix into the four readings AC7 asks for, and says which causes each reading
 * RULES OUT. Pure function of the rows — no I/O — so a reader can re-derive it from `results`.
 * @param {Array<Record<string, any>>} rows
 */
function classifyProbe(rows) {
  const U = 'unambiguous-command';
  const H = 'p0-hesitant-control';
  const find = (/** @type {string} */ clipId, /** @type {string} */ levelId) =>
    rows.find((r) => r.clipId === clipId && r.levelId === levelId) ?? null;
  const called = (/** @type {Record<string, any> | null} */ r) => Boolean(r && r.ok && r.emitted);

  const forced = find(U, 'explicit-forced');
  const uiImplicit = find(U, 'implicit-auto');
  const uiExplicit = find(U, 'explicit-auto');
  const hImplicit = find(H, 'implicit-auto');
  const hExplicit = find(H, 'explicit-auto');

  // ── reading 1: interface-structural support — read off the FORCED call, where the model has no
  // choice but to emit one. A conforming tool_call there proves the wire accepts audio+tools and the
  // schema is valid, whatever the auto-mode cells did.
  /** @type {Record<string, any>} */
  let interfaceReading;
  if (!forced) {
    interfaceReading = { verdict: 'NOT PROBED', rulesOut: [], evidence: 'no forced call in the matrix' };
  } else if (forced.status === 'failed-transport') {
    interfaceReading = { verdict: 'INCONCLUSIVE', rulesOut: [], evidence: `forced call failed at transport: ${forced.transportError}` };
  } else if (!forced.ok) {
    interfaceReading = {
      verdict: 'NO — the interface rejects audio+tools',
      rulesOut: [],
      evidence: `HTTP ${forced.httpStatus} on a FORCED tool_choice: ${JSON.stringify(forced.errorShape)}`,
    };
  } else if (called(forced) && forced.functionArgumentsParseError == null) {
    interfaceReading = {
      verdict: 'YES',
      rulesOut: ['interface-structural-support-absent', 'schema-problem'],
      evidence: `a forced tool_choice returned a conforming tool_call (name=${forced.functionName}, arguments parsed) — the non-realtime audio-native path accepts audio+tools and the declared schema`,
    };
  } else if (called(forced) && forced.functionArgumentsParseError != null) {
    interfaceReading = {
      verdict: 'PARTIAL — call emitted, arguments malformed',
      rulesOut: ['interface-structural-support-absent'],
      evidence: `forced call emitted but its arguments did not parse (${forced.functionArgumentsParseError}) ⇒ a SCHEMA/argument problem, not an interface one`,
    };
  } else {
    interfaceReading = {
      verdict: 'NO — accepted but still no call',
      rulesOut: [],
      evidence: 'HTTP 200 on a FORCED tool_choice with no tool_call and no function_call',
    };
  }

  // ── reading 2: prompt-not-triggered vs model-chose-not-to-call — the implicit→explicit flip.
  const flip = (/** @type {Record<string, any> | null} */ imp, /** @type {Record<string, any> | null} */ exp) => {
    if (!imp || !exp) return { reading: 'NOT PROBED' };
    if (called(imp) && called(exp)) return { reading: 'NO CHANGE — called at both levels' };
    if (!called(imp) && called(exp))
      return { reading: 'PROMPT WAS THE TRIGGER — implicit text ⇒ explicit call', rulesOut: ['model-chose-not-to-call'] };
    if (called(imp) && !called(exp)) return { reading: 'REGRESSION — implicit called but explicit did not (unexpected)' };
    return { reading: 'STILL TEXT at both levels', rulesOut: [] };
  };
  const promptReading = {
    onUnambiguousCommand: flip(uiImplicit, uiExplicit),
    onHesitantControl: flip(hImplicit, hExplicit),
  };

  // ── reading 3: model-chose-not-to-call — explicit prompt + unambiguous clip + auto ⇒ text.
  let modelChoseNotToCall;
  if (!uiExplicit) {
    modelChoseNotToCall = { verdict: 'NOT PROBED', evidence: 'no explicit/auto cell on the unambiguous clip' };
  } else if (called(uiExplicit)) {
    modelChoseNotToCall = {
      verdict: 'RULED OUT for the unambiguous clip',
      evidence: 'the explicit prompt on the unambiguous command DID produce a call, so "the model will not call" is not the standing explanation',
    };
  } else if (uiExplicit.ok) {
    modelChoseNotToCall = {
      verdict: 'STANDING for the unambiguous clip',
      evidence: `the prompt mandated a call on an unambiguous command and the model still answered in text ("${String(uiExplicit.textAnswer ?? '').slice(0, 80)}")`,
    };
  } else {
    modelChoseNotToCall = { verdict: 'INCONCLUSIVE', evidence: `HTTP ${uiExplicit.httpStatus}` };
  }

  // ── the headline the Go/No-Go row carries.
  let headline;
  let headlineNote;
  if (interfaceReading.verdict === 'YES' && called(uiExplicit)) {
    headline = 'SUPPORTED (with an explicit prompt on an unambiguous command)';
    headlineNote =
      'the non-realtime audio-native path accepts audio+tools (forced call conformed) and calls the tool when the instruction names it and the request is unambiguous';
  } else if (interfaceReading.verdict === 'YES') {
    headline = 'INTERFACE SUPPORTS TOOLS, BUT THIS MODEL DID NOT CALL';
    headlineNote =
      'a forced call conformed, so audio+tools and the schema are accepted; on the unambiguous clip the explicit/auto prompt still produced text ⇒ the remaining explanation is model-chose-not-to-call, not an interface or schema limit';
  } else if (String(interfaceReading.verdict).startsWith('NO —')) {
    headline = 'UNSUPPORTED (interface-level)';
    headlineNote = interfaceReading.evidence;
  } else {
    headline = 'INCONCLUSIVE';
    headlineNote = interfaceReading.evidence;
  }

  const rulesOut = [...new Set([...(interfaceReading.rulesOut ?? []), ...(promptReading.onUnambiguousCommand.rulesOut ?? []), ...(promptReading.onHesitantControl.rulesOut ?? [])])];

  // ── reading 4: does P0's recorded cell reproduce? P0 sent the identical request and got text;
  // if this batch now calls, P0's "unsupported" was one draw from a nondeterministic model.
  const p0Cell = find(P0_RECORDED_CELL.clipId, P0_RECORDED_CELL.levelId);
  const p0Reproduction = {
    p0Recorded: { cell: `${P0_RECORDED_CELL.clipId} × ${P0_RECORDED_CELL.levelId}`, outcome: P0_RECORDED_CELL.outcome, textAnswer: P0_RECORDED_CELL.textAnswer, recordedAt: P0_RECORDED_CELL.recordedAt },
    thisBatch: p0Cell ? { cell: `${P0_RECORDED_CELL.clipId} × ${P0_RECORDED_CELL.levelId}`, outcome: p0Cell.status, functionName: p0Cell.functionName ?? null } : null,
    requestIdentical: true,
    reproducible: p0Cell ? p0Cell.status === P0_RECORDED_CELL.outcome : null,
    note:
      'the same clip, the same implicit instruction, the same tool_choice=auto and temperature=0 — so a differing outcome is model nondeterminism, not a changed request. If this cell now calls, P0’s single-call "unsupported" is NOT reproducible and must not be quoted as a property of the non-realtime path.',
  };

  return {
    interfaceStructuralSupport: interfaceReading,
    promptNotTriggered: {
      ...promptReading,
      note: 'the implicit→explicit flip separates "the prompt did not trigger the call" from "the model saw a mandatory instruction and stayed in text"; a NO CHANGE where both are text pushes the explanation onto the model, and a PROMPT-WAS-THE-TRIGGER outcome rules the model out',
    },
    schemaProblem: {
      verdict: interfaceReading.rulesOut?.includes('schema-problem') ? 'RULED OUT' : 'NOT RULED OUT',
      evidence: interfaceReading.evidence,
    },
    modelChoseNotToCall,
    p0Reproduction,
    rulesOut,
    headline,
    headlineNote,
  };
}

/**
 * The probe proper: guard the BATCH, arm the record, send each matrix cell, record.
 * @param {{ key: string }} args
 */
async function runProbe(args) {
  const priorLedger = readResult().qwenProbe?.spendLedger ?? null;
  const clips = PROBE_CLIPS.map((c) => ({ ...c, ...readClip(c.rel) }));
  const clipsById = new Map(clips.map((c) => [c.id, c]));

  // The matrix: level × clip, in level-major order so the three levels read as a ladder.
  const plan = [];
  for (const level of PROBE_LEVELS) for (const clipId of level.onClips) plan.push({ clipId, levelId: level.id });

  const perCallWorst = clips.map((c) => ({ clipId: c.id, seconds: c.seconds, cny: worstCaseCost(c.seconds).cny }));
  const worstByClip = new Map(perCallWorst.map((w) => [w.clipId, w.cny]));
  const batchWorstCny = Number(plan.reduce((a, p) => a + (worstByClip.get(p.clipId) ?? 0), 0).toFixed(6));
  const priorHistoryUpperBoundCny =
    typeof priorLedger?.allCallsTotalUpperBoundCny === 'number' ? priorLedger.allCallsTotalUpperBoundCny : P0_PRIOR_TOTAL_UPPER_BOUND_CNY;
  const guardPassed = batchWorstCny <= PROBE_CAP_CNY;

  const base = {
    group: 'E',
    step: 'non-realtime qwen3.8-omni-flash audio-native function-call feasibility — AC7 redesign (2 clips × 3 prompt levels)',
    model: PROBE_MODEL,
    endpoint: CHAT_URL,
    redesign: {
      why: 'P0 ran ONE call on ONE hesitant clip; a text reply there is the expected behaviour and cannot separate an incapable interface from a clip/prompt that did not warrant a call. This is the SPEC §非实时探针 step 7 redesign.',
      p0ReadingCited: {
        cny: P0_PROBE_CNY,
        recordedAt: P0_PROBE_RECORDED_AT,
        verdict: 'unsupported (on that one clip)',
        note: 'P0’s clip is the p0-hesitant-control of this batch, re-run at all three prompt levels so the P0 reading is bounded rather than discarded',
      },
    },
    clips: clips.map((c) => ({ id: c.id, path: c.rel, sha256: c.sha256, seconds: c.seconds, bytes: c.bytes, reference: c.reference, language: c.language, kind: c.kind, why: c.why })),
    promptLevels: PROBE_LEVELS.map((l) => ({ id: l.id, label: l.label, instruction: l.instruction, toolChoice: l.toolChoice, onClips: l.onClips, isolates: l.isolates })),
    plan,
    budget: {
      capCny: PROBE_CAP_CNY,
      capBasis:
        'the SPEC §非实时探针 wrote ≤ ¥0.02 for P0’s SINGLE call; the AC7 matrix is ' +
        plan.length +
        ' calls, so the cap is scaled to the batch. It is a PRE-CALL bound and it is written here BEFORE the first request.',
      perCallWorstCase: perCallWorst,
      worstCaseBatchCny: batchWorstCny,
      guardPassed,
      cumulative: {
        p0ProbeCny: P0_PROBE_CNY,
        p0ProbeRecordedAt: P0_PROBE_RECORDED_AT,
        priorProbeHistoryUpperBoundCny: priorHistoryUpperBoundCny,
        cumulativeWorstCaseUpperBoundCny: Number((priorHistoryUpperBoundCny + batchWorstCny).toFixed(6)),
        basis:
          'cumulative = all non-realtime probe money: P0’s ledger (its build calls at its bound, plus the recorded ¥0.00242) plus this batch’s pre-call bound. The AC7 wording asks for the P0 ¥0.00242 to be in the cumulative figure.',
      },
      note:
        'the batch is refused entirely if worstCaseBatchCny exceeds capCny, and EACH cell is re-checked against the realised spend before it is sent, so a mid-batch over-run aborts the rest rather than the whole thing.',
    },
    request: {
      toolsDeclared: ['session_send'],
      toolDeclarationSource: 'server/modules/voice-realtime/voice-realtime-tools.ts:200',
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      audioPartType: 'input_audio',
      audioFormat: 'wav',
      audioInlinedAsDataUri: true,
    },
    credentials: 'the API key travels in a request header only and is never written into this artifact',
    armedAt: new Date().toISOString(),
  };

  if (!guardPassed) {
    const result = readResult();
    result.qwenProbe = { ...base, status: 'refused-over-budget' };
    writeResult(result, args.key);
    die(`probe: worst-case batch estimate ¥${batchWorstCny} exceeds the ¥${PROBE_CAP_CNY} cap — no request sent (recorded in RESULT.json)`);
  }

  // Phase 1 — the budget exists on the record BEFORE anything is billed.
  const armed = readResult();
  armed.qwenProbe = { ...base, status: 'armed' };
  writeResult(armed, args.key);
  console.log(`probe: armed — batch cap ¥${PROBE_CAP_CNY}, ${plan.length} calls, worst-case ¥${batchWorstCny}; clips ${clips.map((c) => `${c.id}:${c.seconds}s`).join(', ')}`);

  // Phase 2 — send each cell, re-checking the cumulative bound before it goes out.
  /** @type {Array<Record<string, any>>} */
  const results = [];
  let realisedCny = 0;
  let abortedOverBudget = false;
  for (const cell of plan) {
    const clip = clipsById.get(cell.clipId);
    const level = PROBE_LEVELS.find((l) => l.id === cell.levelId);
    if (!clip || !level) throw new Error(`probe: plan references unknown cell ${cell.clipId} × ${cell.levelId}`);
    const bound = worstCaseCost(clip.seconds).cny;
    if (realisedCny + bound > PROBE_CAP_CNY) {
      abortedOverBudget = true;
      results.push({ clipId: cell.clipId, levelId: cell.levelId, status: 'aborted-over-budget', emitted: false, costCny: null });
      console.log(`probe: ABORT ${cell.clipId} × ${cell.levelId} — realised ¥${realisedCny} + bound ¥${bound} would exceed ¥${PROBE_CAP_CNY}`);
      continue;
    }
    const row = await probeOnce(clip, level, args.key);
    results.push(row);
    if (typeof row.costCny === 'number') realisedCny = Number((realisedCny + row.costCny).toFixed(6));
    console.log(`probe: ${cell.clipId} × ${cell.levelId} → ${row.status} HTTP ${row.httpStatus ?? 'n/a'} ${row.wallClockMs}ms ${row.emitted ? `CALL ${row.functionName}` : ''} cost≈¥${row.costCny ?? '?'}`);
    // Persist after each cell: an interrupted batch leaves the cells already paid for.
    const mid = readResult();
    mid.qwenProbe = { ...base, status: 'in-progress', results };
    writeResult(mid, args.key);
  }

  // Phase 3 — readings, spend, and the Go/No-Go row.
  const readings = classifyProbe(results);
  const measured = results.filter((r) => typeof r.costCny === 'number');
  const batchMeasuredCny = Number(measured.reduce((a, r) => a + r.costCny, 0).toFixed(6));
  const result = readResult();
  result.qwenProbe = {
    ...base,
    status: abortedOverBudget ? 'completed-with-abort' : 'completed',
    completedAt: new Date().toISOString(),
    results,
    readings,
    actualSpend: {
      batchMeasuredCny,
      measuredCalls: measured.length,
      unmeasuredCalls: results.length - measured.length,
      withinCap: batchMeasuredCny <= PROBE_CAP_CNY,
      cumulativeMeasuredCny: Number((P0_PROBE_CNY + batchMeasuredCny).toFixed(6)),
      costBasis:
        'priced from each response’s own usage with the qwen3.8-omni-flash-realtime table as a proxy; the non-realtime omni price is not published in this repo, so reconcile against the invoice',
    },
    spendLedger: buildSpendLedger(priorLedger, results, batchWorstCny),
    realtimeComparison: readRealtimeComparison(),
  };
  // The Go/No-Go row for this probe is measured by the probe, so the probe writes it. run.mts
  // preserves the row across a re-run exactly as it preserves `qwenProbe`.
  applyProbeRow(result, result.qwenProbe);
  const scrubbed = writeResult(result, args.key);
  console.log(`probe: ${readings.headline}`);
  console.log(`probe: batch cost ≈ ¥${batchMeasuredCny} (cap ¥${PROBE_CAP_CNY}); cumulative ≈ ¥${P0_PROBE_CNY + batchMeasuredCny}; scrubbed=${scrubbed}`);
  console.log(`probe: rules out ${readings.rulesOut.join(', ') || '(none)'}`);
  console.log(`wrote ${RESULT_FILE}`);
}

/** @param {Array<Record<string, any>>} rows @param {string} clipId @param {string} levelId */
function findResult(rows, clipId, levelId) {
  return rows.find((r) => r.clipId === clipId && r.levelId === levelId) ?? null;
}

/**
 * Writes the probe's Go/No-Go row from its readings. Shared by `runProbe` and `reclassifyProbe` so
 * the two can never disagree about what the row says.
 * @param {Record<string, any>} result
 * @param {Record<string, any>} probe
 */
function applyProbeRow(result, probe) {
  const row = result.goNoGo?.nonRealtimeQwenFeasibility;
  if (!row) return;
  const readings = probe.readings;
  row.measured = `AC7 batch: ${probe.results.length} calls over ${probe.clips.length} clips × ${probe.promptLevels.length} prompt levels (forced tool_choice present: ${Boolean(findResult(probe.results, 'unambiguous-command', 'explicit-forced'))}); interface=${readings.interfaceStructuralSupport.verdict}`;
  row.verdict = readings.headline;
  row.note = readings.headlineNote;
}

/**
 * Offline: recompute the readings and the Go/No-Go row from the results ALREADY on the record. No
 * network, no spend — for iterating on the classification without re-billing the calls.
 */
function reclassifyProbe() {
  const result = readResult();
  const probe = result.qwenProbe;
  if (!probe || !Array.isArray(probe.results)) die('reclassify: qwenProbe.results is missing — run --probe-qwen first');
  probe.readings = classifyProbe(probe.results);
  applyProbeRow(result, probe);
  const scrubbed = writeResult(result, process.env.DASHSCOPE_API_KEY ?? '');
  console.log(`reclassify: ${probe.readings.headline}`);
  console.log(`reclassify: p0Reproduction reproducible=${probe.readings.p0Reproduction.reproducible}; rulesOut=${probe.readings.rulesOut.join(', ') || '(none)'}; scrubbed=${scrubbed}`);
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');
  const wantProbe = argv.includes('--probe-qwen') || argv.includes('--all');
  const wantHarness =
    argv.includes('--all') || (!wantProbe && !argv.includes('--emit-manifest') && !argv.includes('--reclassify'));

  if (argv.includes('--emit-manifest')) {
    emitManifest();
    return;
  }
  if (argv.includes('--reclassify')) {
    reclassifyProbe();
    return;
  }
  if (wantHarness) {
    const modelPath = await ensureModel({ offline });
    runHarness(modelPath);
  }
  if (wantProbe) {
    await runProbe({ key: readApiKey() });
  }
  if (!wantHarness && !wantProbe) {
    console.log('nothing to do: pass --probe-qwen, --all, --emit-manifest, or no flag (harness)');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
