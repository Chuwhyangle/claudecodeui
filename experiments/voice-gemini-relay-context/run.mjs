#!/usr/bin/env node
/**
 * Gemini 2.5 / 3.5 Flash Lite under the relay provider's CONTEXT METHOD.
 *
 * The prior Gemini record (docs/experiments/2026-09-23-gemini.md) measured the shipping
 * `multimodal` adapter's shape: the context is appended as a text part in the USER turn. On that
 * wire the model echoed the prompt as the transcript (3/8 clips returned the prompt itself).
 *
 * The relay recogniser (shared/asr/list/dashscope-omni-relay) put the same kind of pack in the
 * SYSTEM turn and made the user turn audio-only. This runner asks the same question for Gemini:
 * does that placement fix the echo, and how do 2.5/3.5 Flash Lite then perform?
 *
 * Arms, per model:
 *   none   — relay prompt, no context
 *   system — relay prompt + CONTEXT_HEADER + context in systemInstruction; user turn = audio only
 *   user   — relay prompt in systemInstruction; user turn = audio + CONTEXT_HEADER + context
 *            (the old multimodal placement, kept as the placement control)
 *
 * Corpora:
 *   tts  — the 8 frozen TTS clips + synthetic identifier context used by the prior Gemini record
 *   real — 8 real live-voice utterances + the exact C2 packs from voice-omni-vs-realtime
 *
 * The runner is an experiment, not shipping code: the request shape is runner-local because the
 * shipping adapter cannot express system placement. Readings are recorded as readings, not gates.
 *
 * Usage: node experiments/voice-gemini-relay-context/run.mjs [--tts] [--real] [--fresh]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const JSONL = join(OUT, 'results.jsonl');
const RUN_ID = new Date().toISOString();
const ARGS = new Set(process.argv.slice(2));
const FRESH = ARGS.has('--fresh');
const WANT_TTS = ARGS.has('--tts') || (!ARGS.has('--real'));
const WANT_REAL = ARGS.has('--real') || (!ARGS.has('--tts'));
const SMOKE = ARGS.has('--smoke');
const MODEL_FILTER = [...ARGS].find((a) => a.startsWith('--model='))?.slice(8) ?? null;
const ARM_FILTER = [...ARGS].find((a) => a.startsWith('--arms='))?.slice(7).split(',').filter(Boolean) ?? null;
const THINKING = [...ARGS].find((a) => a.startsWith('--thinking='))?.slice(11) ?? null;

// ── credentials ──────────────────────────────────────────────────────────────────────────────
function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!/^[A-Z_]+=/.test(line)) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}
const env = readEnvFile('/data/home/yale/work/claudecodeui/.env.test');
const API_KEY = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || '';
const BASE_URL = (process.env.GEMINI_BASE_URL || env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
if (!API_KEY) { console.error('no GEMINI_API_KEY in .env.test'); process.exit(2); }

// ── the relay prompt, imported rather than copied ────────────────────────────────────────────
// Registry FIRST: entering the adapter directly leaves the registry's own import of it
// uninitialised (the TDZ the provider-dispatch test documents).
await import(new URL('../../shared/asr/asrRegistry.ts', import.meta.url).href);
const relayModule = await import(
  new URL('../../shared/asr/list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.ts', import.meta.url).href
);
const { relaySystemPrompt, CONTEXT_HEADER } = relayModule;

// ── corpora ──────────────────────────────────────────────────────────────────────────────────
const TTS_FIXTURES = resolve(HERE, '..', 'voice-provider-paired-quality', 'fixtures');
const TTS_SNAPSHOT = JSON.parse(readFileSync(join(TTS_FIXTURES, 'paired.json'), 'utf8'));
const TTS_CONTEXT = '把 voice.service.ts 的超时改成三十秒。然后看一下 useVoiceInput 这个 hook，再更新 voice.routes.ts。';

const REAL_SNAPSHOT = JSON.parse(readFileSync(resolve(HERE, '..', 'voice-omni-vs-realtime', 'out', 'fixtures-24.json'), 'utf8'));
const REAL_KEYS = [
  '6c76e1cf-0', '711e54cc-0', 'acf7fc73-0', 'bf517472-0',
  'bf517472-1', 'e8df1709-2', '4eea7875-3', '47d5202d-0',
];
const REAL = REAL_SNAPSHOT.items.filter((it) => REAL_KEYS.includes(it.key));

const MODELS = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite']
  .filter((m) => MODEL_FILTER === null || m.includes(MODEL_FILTER));
const ARMS = ['none', 'system', 'user'].filter((a) => ARM_FILTER === null || ARM_FILTER.includes(a));

const ttsItems = TTS_SNAPSHOT.entries.map((entry) => ({
  corpus: 'tts',
  key: entry.clip.replace(/\.wav$/, ''),
  audioPath: join(TTS_FIXTURES, entry.clip),
  mimeType: 'audio/wav',
  reference: entry.reference,
  verbatim: entry.reference,
  tidy: entry.reference,
  context: TTS_CONTEXT,
}));

const realItems = REAL.map((it) => ({
  corpus: 'real',
  key: it.key,
  audioPath: it.audio,
  mimeType: 'audio/wav',
  reference: it.relay,
  verbatim: it.asr,
  tidy: it.relay,
  context: it.context,
}));

const ITEMS = (SMOKE ? ttsItems.slice(0, 1) : [...(WANT_TTS ? ttsItems : []), ...(WANT_REAL ? realItems : [])]);

// ── request shape ────────────────────────────────────────────────────────────────────────────
function bodyFor(item, arm, model) {
  const systemText = arm === 'system' ? relaySystemPrompt(item.context) : relaySystemPrompt(undefined);
  const parts = [{ inlineData: { mimeType: item.mimeType, data: readFileSync(item.audioPath).toString('base64') } }];
  if (arm === 'user') parts.push({ text: `${CONTEXT_HEADER}\n\n${item.context}` });
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ parts }],
    generationConfig: { temperature: 0, ...(model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : (THINKING ? { thinkingConfig: { thinkingLevel: THINKING } } : {})) },
  };
  return body;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_INTERVAL_MS = 4100;
let lastCallAt = 0;
async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function textFrom(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('').trim();
}

const HARD_TIMEOUT_MS = 60000;
async function call(item, arm, model, attempt = 0) {
  await throttle();
  const started = Date.now();
  let res, text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
  try {
    res = await fetch(`${BASE_URL}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(bodyFor(item, arm, model)),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (error) {
    clearTimeout(timer);
    const why = error?.name === 'AbortError' ? `hard timeout ${HARD_TIMEOUT_MS}ms` : String(error);
    if (attempt < 2) {
      console.log(`  retry ${item.key} ${model} ${arm} attempt=${attempt + 1} (${why})`);
      await sleep((attempt + 1) * 5000);
      return call(item, arm, model, attempt + 1);
    }
    return { status: 'TRANSPORT_ERROR', latencyMs: Date.now() - started, text: '', error: why };
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  if (RETRYABLE.has(res.status) && attempt < 3) {
    await sleep((attempt + 1) * 5000);
    return call(item, arm, model, attempt + 1);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    return { status: res.status, latencyMs, text: '', error: (json?.error?.message ?? text).slice(0, 500) };
  }
  return {
    status: res.status,
    latencyMs,
    text: textFrom(json),
    finishReason: json?.candidates?.[0]?.finishReason ?? null,
    blockReason: json?.promptFeedback?.blockReason ?? null,
  };
}

// ── metrics ──────────────────────────────────────────────────────────────────────────────────
const norm = (s) => (s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function cer(ref, out) {
  const r = norm(ref), o = norm(out);
  return r.length === 0 ? null : levenshtein(r, o) / r.length;
}
function ctxEcho(ctx, out) {
  const c = norm(ctx), o = norm(out);
  if (!c || !o) return false;
  if (o.includes(c)) return true;
  // A long context cannot be contained whole if the model truncates it; check 24-char windows.
  for (let i = 0; i + 24 <= c.length; i += 12) if (o.includes(c.slice(i, i + 24))) return true;
  return false;
}
const IDENTIFIERS = ['voice.service.ts', 'useVoiceInput', 'voice.routes.ts'];
function identifiers(out) {
  const o = (out || '').toLowerCase();
  return IDENTIFIERS.filter((id) => o.includes(id.toLowerCase())).length;
}
function termHits(out) {
  const o = (out || '').toLowerCase();
  const terms = ['architecture tab', 'live voice', 'pack'];
  return terms.filter((t) => o.includes(t));
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
if (FRESH && existsSync(JSONL)) writeFileSync(JSONL, '');
const already = new Set();
if (existsSync(JSONL)) {
  for (const line of readFileSync(JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); already.add(`${r.corpus}|${r.key}|${r.model}|${r.arm}`); } catch { /* skip */ }
  }
}
writeFileSync(join(OUT, `run-${MODELS[0] ?? 'all'}.json`), JSON.stringify({ runId: RUN_ID, models: MODELS, arms: ARMS, items: ITEMS.map((i) => `${i.corpus}:${i.key}`) }, null, 2));

let done = 0;
const total = MODELS.length * ARMS.length * ITEMS.length;
for (const item of ITEMS) {
  for (const model of MODELS) {
    for (const arm of ARMS) {
      const label = THINKING ? `${arm}@${THINKING}` : arm;
      if (already.has(`${item.corpus}|${item.key}|${model}|${label}`)) { done += 1; continue; }
      const result = await call(item, arm, model);
      const row = {
        runId: RUN_ID,
        corpus: item.corpus,
        key: item.key,
        model,
        arm: label,
        contextChars: item.context.length,
        status: result.status,
        latencyMs: result.latencyMs,
        text: result.text,
        error: result.error ?? null,
        finishReason: result.finishReason ?? null,
        blockReason: result.blockReason ?? null,
        cerVerbatim: cer(item.verbatim, result.text),
        cerTidy: cer(item.tidy, result.text),
        ctxEcho: ctxEcho(item.context, result.text),
        identifiers: identifiers(result.text),
        terms: termHits(result.text),
      };
      appendFileSync(JSONL, `${JSON.stringify(row)}\n`);
      done += 1;
      console.log(`[${done}/${total}] ${item.corpus}:${item.key} ${model} ${arm} status=${result.status} ms=${result.latencyMs} echo=${row.ctxEcho} ids=${row.identifiers} terms=${row.terms.join(',') || '-'} out=${(result.text || result.error || '').slice(0, 80).replace(/\n/g, ' ')}`);
    }
  }
}
console.log(`done run=${RUN_ID} rows=${total} -> ${JSONL}`);
