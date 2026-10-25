// Verbatim transcripts for the 30-item guard: same omni, no context, no rewriting.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolve as resolveAsr } from '../../shared/asr/asrRegistry.js';
void resolveAsr;
import { audioFormatFor, chatAudioDataUri } from '../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'out');
const ENDPOINT = (process.env.DASHSCOPE_ENDPOINT || 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com').replace(/\/$/, '');
const URL_ = `${ENDPOINT}/compatible-mode/v1/chat/completions`;
const KEY = process.env.DASHSCOPE_API_KEY || '';
const RES = path.join(OUT, process.env.RESULT_PATH || 'verbatim30.jsonl');
const fixtures = JSON.parse(readFileSync(process.env.FIXTURES_PATH || path.join(OUT, 'fixtures-30c.json'), 'utf8')).items as any[];
const VERBATIM = '逐字转写这段录音。只输出转写文本，不要解释。代码标识符、文件名、英文词逐字保留，不要翻译、不要编造、不要省略。';
async function call(item: any) {
  const bytes = readFileSync(item.audio);
  const body = {
    model: 'qwen3.8-omni-flash', modalities: ['text'], stream: false, reasoning_effort: 'none', temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'input_audio', input_audio: { data: chatAudioDataUri('audio/wav', bytes.toString('base64')), format: audioFormatFor('audio/wav') } },
      { type: 'text', text: VERBATIM },
    ] }],
  };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null, err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 200)}` };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', usage: null, err: e?.name ?? String(e) }; }
}
const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).key) : []);
const jobs = fixtures.filter((f) => !done.has(f.key));
const worker = async () => { while (jobs.length) { const item = jobs.shift()!; const r = await call(item); appendFileSync(RES, JSON.stringify({ key: item.key, at: new Date().toISOString(), ...r }) + '\n'); console.log('verbatim', item.key, r.status, r.ms, r.err); } };
await Promise.all([worker(), worker(), worker()]);
console.log('DONE verbatim');
