// Human-preference judge on the 23-item clean set. b836 is out; the only few-shot gold is 6c76.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'out');
const ENDPOINT = (process.env.DASHSCOPE_ENDPOINT || 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com').replace(/\/$/, '');
const URL_ = `${ENDPOINT}/compatible-mode/v1/chat/completions`;
const KEY = process.env.DASHSCOPE_API_KEY || '';
const RES = path.join(OUT, 'judge-human-clean.jsonl');
const ARMS = new Set((process.env.JUDGE_ARMS || 'N0,N1,N1-guard-strict,N1-guard-oracle-strict').split(','));
const fixtures = JSON.parse(readFileSync(path.join(OUT, 'fixtures-clean.json'), 'utf8')).items as any[];
const results = [];
for (const f of ['results-clean.jsonl', 'results-guard-clean.jsonl']) {
  for (const line of readFileSync(path.join(OUT, f), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line); if (r.status === 200 && String(r.text ?? '').trim() && ARMS.has(r.arm)) results.push(r);
  }
}
const SYSTEM = `你是语音听写质量评审。按“人读偏好”打分，不按“像不像 R”。
输入：A=识别器逐字稿（可能有误听）；R=当时 realtime relay 的投递文本（只是候选，不是标准答案，可能改写/误听/截断）；C=待评候选。
2=好：领域/上下文术语正确；没有实质性增删；读起来自然。标点、空格、大小写、同义虚词差异不算。
1=部分：一个从句或术语错，或多/少一个从句，但主要意思可恢复。
0=误导/不同：关键术语错、核心内容丢失/增加，或与 A/R 明显不符。
如果 C 比 A/R 更完整或更自然（例如 A/R 被截断或误听），给 2；不要因为 C 与 A/R 不同就扣分。只有 C 明显更差时才扣分。
只输出一个 JSON 对象：{"score":2|1|0,"reason":"一句话"}。

已确认的人读 gold 例（b836 组已作废，不再作为 few-shot）：
[G1] A=现在可以看到RTX TM这个图了，但是有问题，是在这个图中，只能看见都是一样箭头，看不出集成。
R=现在可以看到 architecture tab 了，但是有问题：这个图里所有箭头都一样，看不出层级。
C=现在可以看到 architecture tab 架构图了，但是有问题：是这里头所有节点都一样箭头，看不出继承关系。
=> 2。领域术语 architecture tab、继承关系、这里头所有节点都对；没有实质增删。R 的“层级”不是 gold。
[G1-bad1] C=现在可以看到architecture tab架构图了，但是有问题是这六层出来的图片都一样箭头看不出继承关系。 => 1。多出“六层”这一实质内容。
[G1-bad2] C=现在可以看到 architecture tab 架构图了，但是有问题：是这个图只能看见都一样箭头，看不出集成。 => 1。把更好的“继承关系/这里头所有节点”还原成 ASR 的误听“集成”，丢了领域术语。`;
async function judge(item: any, cand: string) {
  const user = `A:\n${item.asr}\n\nR:\n${item.relay}\n\nC:\n${cand}`;
  const body = { model: 'qwen3.8-flash', stream: false, temperature: 0, enable_thinking: false,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] };
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
for (const item of fixtures) for (const r of results.filter((x) => x.key === item.key)) {
  const k = `${r.arm}|${r.key}|${r.rep}`; if (done.has(k)) continue;
  jobs.push(async () => {
    const j = await judge(item, r.text);
    appendFileSync(RES, JSON.stringify({ arm: r.arm, key: r.key, rep: r.rep, at: new Date().toISOString(), ...j }) + '\n');
    console.log(r.arm, r.key, r.rep, j.status, j.score, j.reason.slice(0, 70));
  });
}
const worker = async () => { while (jobs.length) { const j = jobs.shift()!; try { await j(); } catch (e: any) { console.log('ERR', e?.message ?? e); } } };
await Promise.all(Array.from({ length: 6 }, worker));
console.log('DONE clean judge');
