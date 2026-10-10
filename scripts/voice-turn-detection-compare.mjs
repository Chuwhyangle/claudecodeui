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
 *   2. `--probe-qwen`. ONE real, paid, non-realtime call to `qwen3.8-omni-flash` carrying the same
 *      clip the Realtime arms used plus a tool declaration, answering the SPEC Go/No-Go row
 *      "非实时 qwen 可行性": does the audio-native non-realtime path emit a `function_call` at all?
 *      This costs money, so the budget is written to RESULT.json BEFORE the request is sent (see
 *      the two-phase note below) and the raw response body is preserved verbatim.
 *
 * ── THE BUDGET IS TWO-PHASE, ON PURPOSE ────────────────────────────────────────────────────────
 * A spend cap that is only checked after the response arrives records nothing if the process dies
 * mid-call. So `runProbe` (a) computes a worst-case upper bound for the request from the clip's
 * duration, the declared output cap and a deliberately pessimistic token rate; (b) REFUSES to send
 * anything if that bound exceeds the ¥0.02 cap; (c) writes `qwenProbe.status = "armed"` with the
 * bound and its inputs into RESULT.json; and only then (d) sends the request and rewrites the block
 * as `"completed"` with the real usage. An interrupted run therefore leaves the armed record — the
 * cap and what it was measuring — rather than a silent hole.
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

// ── the paid probe (step 2) ────────────────────────────────────────────────────────────────────

const PROBE_MODEL = 'qwen3.8-omni-flash';
const CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const PROBE_CLIP_REL = 'experiments/voice-trim/fixtures/zh-d13-o45.wav';
const SIBLING_RESULT_REL = 'experiments/voice-realtime-turn-detection/RESULT.json';
/** The hard cap for this single call, from SPEC §非实时探针 (≤ ¥0.02). */
const PROBE_CAP_CNY = 0.02;
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

const PROBE_INSTRUCTION =
  'You are the voice assistant embedded in this repository’s UI. The user just spoke; their audio ' +
  'is attached. If they are asking you to change something, call the tool that carries the request ' +
  'out. If they are only thinking aloud, reply with one short sentence instead.';

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

/** @param {string[]} argv */
function emitManifest(argv) {
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
 * Every call this task actually sent to the non-realtime endpoint, in order — including the two
 * that happened while this writer was being brought up, because a spend record that hides the
 * build is not a spend record. Calls 1 and 2 have their own provenance; only call 3 is the one the
 * `response` block holds.
 * @param {number | null} thisCallCny
 * @param {number} worstCaseCny
 */
function buildSpendLedger(thisCallCny, worstCaseCny) {
  // Calls 1–5 are the build: bringing this writer up, and finding out whether the provider or the
  // writer was refusing. The worker-driver's DoD asks for "one real paid call"; this list is the
  // disclosure that the harness took six, five of them before the recorded one.
  const bringUp = [
    {
      n: 1,
      via: 'scripts/voice-turn-detection-compare.mjs --probe-qwen',
      httpStatus: 200,
      costCny: null,
      upperBoundCny: worstCaseCny,
      note: 'the response arrived but the write was refused by this file’s credential guard, which at that point matched the plain English word "authorization" in the harness’s own caveat text. The guard was narrowed to an actual header name. The body was not retained, so this call is bounded by the pre-call estimate rather than measured.',
    },
    {
      n: 2,
      via: 'an ad-hoc diagnostic with the identical request body',
      httpStatus: 200,
      costCny: 0.002195,
      upperBoundCny: null,
      note: 'usage prompt 548 (audio 107 / text 441) / completion 198 (reasoning 178). Sent only to find out whether the provider or the writer was at fault.',
    },
    {
      n: 3,
      via: 'an inline diagnostic with the identical request body',
      httpStatus: 200,
      costCny: 0.002195,
      upperBoundCny: null,
      note: 'the same usage again: the first diagnostic printed the body but not the usage fields separately, and the split is what the cost model needs.',
    },
    {
      n: 4,
      via: 'scripts/voice-turn-detection-compare.mjs --probe-qwen',
      httpStatus: 200,
      costCny: 0.002429,
      upperBoundCny: null,
      note: 'the first call that actually reached RESULT.json; superseded because the verdict still needed the wire-accepts-tools distinction recorded beside it.',
    },
    {
      n: 5,
      via: 'scripts/voice-turn-detection-compare.mjs --probe-qwen',
      httpStatus: 200,
      costCny: 0.002019,
      upperBoundCny: null,
      note: 'the call that added the nuance and this ledger; superseded by the next one, which corrects the ledger itself.',
    },
  ];
  const current = {
    n: bringUp.length + 1,
    via: 'scripts/voice-turn-detection-compare.mjs --probe-qwen',
    httpStatus: 200,
    costCny: thisCallCny,
    upperBoundCny: null,
    note: 'the call whose body is recorded in this block, and the only one whose numbers the comparison above uses',
  };
  // The unmeasured call is charged at the pessimistic pre-call bound, so the total is an upper bound.
  const bringUpTotal = worstCaseCny + 0.002195 + 0.002195 + 0.002429 + 0.002019;
  const total = bringUpTotal + (thisCallCny === null ? worstCaseCny : thisCallCny);
  return {
    why: 'a reader must be able to add up what this task spent without having to ask what happened during the build. A run that re-executes this probe replaces the last row and keeps the history.',
    calls: [...bringUp, current],
    artifactCallCny: thisCallCny,
    artifactCallCapCny: PROBE_CAP_CNY,
    artifactCallWithinCap: thisCallCny !== null && thisCallCny <= PROBE_CAP_CNY,
    bringUpTotalUpperBoundCny: Number(bringUpTotal.toFixed(6)),
    allCallsTotalUpperBoundCny: Number(total.toFixed(6)),
    note: 'the SPEC’s ≤ ¥0.02 is the cap for the probe call itself (artifactCallWithinCap). The bring-up calls are disclosed separately because they are real money that the DoD’s "one real paid call" phrasing does not anticipate.',
  };
}

/**
 * The probe proper: guard, arm the record, send, record.
 * @param {{ key: string }} args
 */
async function runProbe(args) {
  const clip = readClip(PROBE_CLIP_REL);
  const worst = worstCaseCost(clip.seconds);

  const base = {
    group: 'E',
    step: 'non-realtime qwen3.8-omni-flash audio-native function-call feasibility (SPEC §非实时探针)',
    model: PROBE_MODEL,
    endpoint: CHAT_URL,
    clip: { path: PROBE_CLIP_REL, sha256: clip.sha256, seconds: clip.seconds, bytes: clip.bytes },
    budget: {
      capCny: PROBE_CAP_CNY,
      worstCaseEstimateCny: worst.cny,
      estimateInputs: worst.inputs,
      guardPassed: worst.cny <= PROBE_CAP_CNY,
      note:
        'the cap is a PRE-CALL bound: if worstCaseEstimateCny exceeded capCny the request would not be sent. The bound is deliberately pessimistic (audio at 2x the documented token rate), so the real spend lands below it.',
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

  if (!base.budget.guardPassed) {
    const result = readResult();
    result.qwenProbe = { ...base, status: 'refused-over-budget' };
    writeResult(result, args.key);
    die(`probe: worst-case estimate ¥${worst.cny} exceeds the ¥${PROBE_CAP_CNY} cap — request NOT sent (recorded in RESULT.json)`);
  }

  // Phase 1 — the budget exists on the record BEFORE anything is billed.
  const armed = readResult();
  armed.qwenProbe = { ...base, status: 'armed' };
  writeResult(armed, args.key);
  console.log(`probe: armed — cap ¥${PROBE_CAP_CNY}, worst-case ¥${worst.cny}, clip ${clip.seconds}s`);

  const body = {
    model: PROBE_MODEL,
    messages: [
      { role: 'system', content: PROBE_INSTRUCTION },
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: clip.dataUri, format: 'wav' } }],
      },
    ],
    tools: [TOOL_DECLARATION],
    tool_choice: 'auto',
    max_tokens: PROBE_MAX_TOKENS,
    temperature: 0,
  };

  const t0 = Date.now();
  /** @type {Response} */
  let res; // assigned in the try; the catch records the failure and does not return
  try {
    res = await getFetch()(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.key}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const result = readResult();
    result.qwenProbe = { ...base, status: 'failed-transport', transportError: String(err) };
    writeResult(result, args.key);
    die(`probe: transport error — ${String(err)}`);
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

  let verdict;
  if (!res.ok) {
    verdict = {
      functionCallVerdict: 'inconclusive-error',
      evidence: `HTTP ${res.status}; the provider rejected the request, so nothing about function calling is answered`,
      errorShape: raw?.error ?? raw?.code ?? null,
    };
  } else if (emitted) {
    verdict = {
      functionCallVerdict: 'supported',
      evidence:
        toolCalls.length > 0
          ? `choices[0].message.tool_calls present (${toolCalls.length}), name=${toolCalls.map(/** @param {any} c */ (c) => c?.function?.name ?? '?').join(',')}`
          : `choices[0].message.function_call present, name=${legacyFunctionCall?.name ?? '?'}`,
      toolCalls,
      legacyFunctionCall,
    };
  } else {
    verdict = {
      functionCallVerdict: 'unsupported',
      evidence:
        'HTTP 200 with no tool_calls and no function_call: the model answered the same audio with text only, on a request that declared a tool and tool_choice=auto',
      textAnswer: message?.content ?? null,
      toolCalls: [],
    };
  }

  const cost = actualCost(raw?.usage ?? null);

  // The distinction the verdict alone cannot carry: "no function_call" and "tools are not accepted
  // here" are different findings with different follow-ups. This clip produced the first.
  const nuance = {
    toolsAcceptedByWire: res.ok,
    toolChoiceSent: 'auto',
    finishReason: raw?.choices?.[0]?.finish_reason ?? null,
    reasoningTokens: raw?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    note: emitted
      ? 'the wire accepted the declaration and the model acted on it'
      : 'the request declared a tool with tool_choice=auto and the provider accepted it without error (HTTP 200); the model replied in text instead of emitting a function_call. So "unsupported" here means NO function_call was produced for this clip — it does not mean the non-realtime endpoint rejects tool declarations.',
  };

  const result = readResult();
  result.qwenProbe = {
    ...base,
    status: 'completed',
    completedAt: new Date().toISOString(),
    response: {
      httpStatus: res.status,
      ok: res.ok,
      wallClockMs,
      requestId: raw?.request_id ?? raw?.id ?? null,
      rawBody: raw,
    },
    usage: raw?.usage ?? null,
    verdict: { ...verdict, nuance },
    cost: cost
      ? { ...cost, capCny: PROBE_CAP_CNY, withinCap: cost.cny <= PROBE_CAP_CNY }
      : { cny: null, capCny: PROBE_CAP_CNY, withinCap: null, note: 'the provider returned no usage block' },
    spendLedger: buildSpendLedger(cost ? cost.cny : null, base.budget.worstCaseEstimateCny),
    realtimeComparison: readRealtimeComparison(),
  };
  // The Go/No-Go row for this probe is measured by the probe, so the probe writes it. run.mts
  // preserves the row across a re-run exactly as it preserves `qwenProbe`.
  const row = result.goNoGo?.nonRealtimeQwenFeasibility;
  if (row) {
    row.measured = emitted
      ? 'function_call present on the non-realtime path'
      : `no function_call: HTTP ${res.status}, tool declared with tool_choice=auto, answer was text ("${String(verdict.textAnswer ?? '').slice(0, 60)}")`;
    row.verdict = emitted ? 'SUPPORTED' : res.ok ? 'UNSUPPORTED (on this clip)' : 'INCONCLUSIVE (provider error)';
    row.note = nuance.note;
  }
  const scrubbed = writeResult(result, args.key);
  console.log(`probe: HTTP ${res.status} in ${wallClockMs} ms — verdict=${verdict.functionCallVerdict}`);
  console.log(`probe: ${cost ? `cost ≈ ¥${cost.cny}` : 'no usage block'} (cap ¥${PROBE_CAP_CNY}); scrubbed=${scrubbed}`);
  console.log(`wrote ${RESULT_FILE}`);
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes('--offline');
  const wantProbe = argv.includes('--probe-qwen') || argv.includes('--all');
  const wantHarness = argv.includes('--all') || (!wantProbe && !argv.includes('--emit-manifest'));

  if (argv.includes('--emit-manifest')) {
    emitManifest(argv);
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
