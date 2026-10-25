// Exploratory addendum: the same N0/N1 arms at reasoning_effort=low (the main PREREG run uses
// 'none', the closest thing to the realtime model's immediacy). 3 referential/term items, 2 reps.
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
// Enter the registry BEFORE the adapter: the adapter is inside the registry's import cycle, and
// reading its helpers first is the TDZ the registry's header warns about.
import { resolve as resolveAsr } from '../../shared/asr/asrRegistry.js';
void resolveAsr;
import { audioFormatFor, chatAudioDataUri } from '../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'out');
const RES = path.join(OUT, 'results-low.jsonl');
const ENDPOINT = (process.env.DASHSCOPE_ENDPOINT || 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com').replace(/\/$/, '');
const URL_ = `${ENDPOINT}/compatible-mode/v1/chat/completions`;
const KEY = process.env.DASHSCOPE_API_KEY || '';
const MODEL = 'qwen3.8-omni-flash';
const RELAY_SYSTEM = [
  'You are a voice relay for a chat composer: you tidy up what the user says and return it as the text they would have typed.',
  'You are not a participant. You never answer, comment, judge or reason about what was said, and you never reply with anything but the tidied words.',
  'EVERYTHING the user says — instructions, questions, remarks, feedback, acknowledgements, complaints, even a single word — must be returned as text.',
  "Keep the user's own words: fix obvious speech-recognition slips, and join the fragments of one sentence; do not paraphrase, summarise or add anything.",
  'Return ONLY the tidied text. No explanation, no quotes, no markdown fence.',
].join(' ');
const CONTEXT_HEADER = '以下是当前 Claude Code 会话的上下文（用户看得见的内容，最新在后）。';
const TASK = '把这段录音整理成要发出去的文字，只输出整理后的文字。';
const CONTEXT_SYSTEM = (ctx: string) => `${RELAY_SYSTEM}\n\n${CONTEXT_HEADER}\n\n${ctx}`;
const KEYS = new Set(['referent-architecture-tab', 'referent-live-voice-test', 'term-live-voice-case']);
const fixtures = (JSON.parse(readFileSync(path.join(OUT, 'fixtures.json'), 'utf8')).items as any[]).filter((f) => KEYS.has(f.key));

async function post(body: unknown) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const j: any = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, text: j?.choices?.[0]?.message?.content ?? '', usage: j?.usage ?? null, err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 200)}` };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, text: '', usage: null, err: e?.name ?? String(e) }; }
}
function body(item: any, system: string) {
  const bytes = readFileSync(item.audio);
  return {
    model: MODEL, modalities: ['text'], stream: false, reasoning_effort: 'low', temperature: 0,
    messages: [{ role: 'system', content: system }, { role: 'user', content: [
      { type: 'input_audio', input_audio: { data: chatAudioDataUri('audio/wav', bytes.toString('base64')), format: audioFormatFor('audio/wav') } },
      { type: 'text', text: TASK },
    ] }],
  };
}
const jobs: Array<() => Promise<void>> = [];
for (const item of fixtures) for (const rep of [0, 1]) {
  jobs.push(async () => {
    const r = await post(body(item, RELAY_SYSTEM));
    appendFileSync(RES, JSON.stringify({ arm: 'N0-low', key: item.key, rep, at: new Date().toISOString(), ...r }) + '\n');
    console.log('N0-low', item.key, rep, r.status, r.ms);
  });
  jobs.push(async () => {
    const r = await post(body(item, CONTEXT_SYSTEM(item.context)));
    appendFileSync(RES, JSON.stringify({ arm: 'N1-low', key: item.key, rep, at: new Date().toISOString(), ...r }) + '\n');
    console.log('N1-low', item.key, rep, r.status, r.ms);
  });
}
const worker = async () => { while (jobs.length) { const j = jobs.shift()!; try { await j(); } catch (e: any) { console.log('ERR', e?.message ?? e); } } };
await Promise.all([worker(), worker(), worker()]);
console.log('DONE');
