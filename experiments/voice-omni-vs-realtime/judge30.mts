// Independent semantic judge for the 30-item run: same ASR/R, candidate from N0 or N1.
// qwen3.8-flash (a different model from the omni candidate); temperature 0. The human read of
// every score 1/0 is still the final authority; this gives the first pass and the reason.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'out');
const ENDPOINT = (process.env.DASHSCOPE_ENDPOINT || 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com').replace(/\/$/, '');
const URL_ = `${ENDPOINT}/compatible-mode/v1/chat/completions`;
const KEY = process.env.DASHSCOPE_API_KEY || '';
const RES = path.join(OUT, process.env.JUDGE_OUT || 'judge30c.jsonl');
const fixtures = JSON.parse(readFileSync(path.join(OUT, process.env.FIXTURES30 || 'fixtures-30c.json'), 'utf8')).items as any[];
const results = readFileSync(path.join(OUT, process.env.RESULTS30 || 'results-30c.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const by = new Map<string, any>();
for (const r of results) by.set(`${r.arm}|${r.key}|${r.rep}`, r);
const SYSTEM = '你是一个严格的语音转写评审。A 是实时识别器听到的字幕；R 是实时 relay 当时真正投递的消息（参照）；C 是非实时模型给出的候选。只判断：C 是否与 R 传达同一个指令/意思，且没有实质增加或删掉内容。标点、空格、大小写、同义虚词不算差异。只输出一个 JSON 对象：{"score":2|1|0,"reason":"一句话"}。2=同义/同指令；1=部分相同（少/多一个从句，或指代未解决）；0=不同或误导。';
function prompt(item: any, cand: string) {
  return `A:\n${item.asr}\n\nR:\n${item.relay}\n\nC:\n${cand}`;
}
async function judge(item: any, cand: string) {
  const body = { model: 'qwen3.8-flash', stream: false, temperature: 0, enable_thinking: false,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt(item, cand) }] };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const j: any = await res.json().catch(() => null);
    const text = j?.choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]*\}/); let parsed: any = null;
    try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    return { status: res.status, ms: Date.now() - t0, score: parsed?.score ?? null, reason: parsed?.reason ?? '', raw: text };
  } catch (e: any) { return { status: 0, ms: Date.now() - t0, score: null, reason: String(e?.name ?? e), raw: '' }; }
}
const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.arm}|${r.key}|${r.rep}`; }) : []);
const jobs: Array<() => Promise<void>> = [];
const ARMS = (process.env.JUDGE_ARMS || 'N0,N1').split(',');
for (const item of fixtures) for (const arm of ARMS) for (const rep of [0, 1]) {
  const k = `${arm}|${item.key}|${rep}`;
  if (done.has(k)) continue;
  const r = by.get(k); if (!r || r.status !== 200) continue;
  jobs.push(async () => {
    const j = await judge(item, r.text);
    appendFileSync(RES, JSON.stringify({ arm, key: item.key, rep, at: new Date().toISOString(), ...j }) + '\n');
    console.log(arm, item.key, rep, j.status, j.score, j.reason.slice(0, 80));
  });
}
const worker = async () => { while (jobs.length) { const j = jobs.shift()!; try { await j(); } catch (e: any) { console.log('ERR', e?.message ?? e); } } };
await Promise.all([worker(), worker(), worker()]);
console.log('DONE judge');
