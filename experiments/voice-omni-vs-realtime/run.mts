// Realtime relay vs non-realtime omni flash, on real LIVE Voice audio.
//   set -a; . ./.env; set +a; npx tsx --tsconfig=tsconfig.json experiments/voice-omni-vs-realtime/run.mts run
// The shipped `dashscope-omni` adapter is the N2 arm; N0/N1 are the same chat-audio wire with a
// relay-style prompt (the non-realtime model is the hypothesis under test, not a shipped path yet).
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolve as resolveAsr } from '../../shared/asr/asrRegistry.js';
import { audioFormatFor, chatAudioDataUri } from '../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(ROOT, 'out');
mkdirSync(OUT, { recursive: true });
const RES = process.env.RESULTS || path.join(OUT, 'results.jsonl');
const FIXTURES = process.env.FIXTURES || path.join(OUT, 'fixtures.json');
const ENDPOINT = (process.env.DASHSCOPE_ENDPOINT || 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com').replace(/\/$/, '');
const URL_ = `${ENDPOINT}/compatible-mode/v1/chat/completions`;
const KEY = process.env.DASHSCOPE_API_KEY || '';
const MODEL = 'qwen3.8-omni-flash';
const TEXT_MODEL = 'qwen3.8-flash';
const REPS = Number(process.env.REPS ?? 2);

type Fixture = {
  key: string; connectionId: string; sessionId: string; connectionAt: string;
  context: string; contextChars: number; contextRows: number;
  asr: string; relay: string; audio: string; audioSeconds: number;
};
const allFixtures: Fixture[] = JSON.parse(readFileSync(FIXTURES, 'utf8')).items;
const ONLY_ITEMS = process.env.ONLY_ITEMS ? new Set(process.env.ONLY_ITEMS.split(',')) : null;
const ONLY_ARMS = process.env.ONLY_ARMS ? new Set(process.env.ONLY_ARMS.split(',')) : null;
const wantArm = (a: string) => !ONLY_ARMS || ONLY_ARMS.has(a);
const fixtures: Fixture[] = ONLY_ITEMS ? allFixtures.filter((f) => ONLY_ITEMS.has(f.key)) : allFixtures;

// The relay prompt, reduced to the batch (text-returning) form. The clauses that matter are the
// shipped realtime relay's: never answer, fix obvious slips, join fragments, do not paraphrase.
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

// The shipped E-group prompt, reproduced only so N2 can be labelled; the actual call goes through
// the shipped adapter, whose constants are the source of truth.
const E_SYSTEM = [
  '你是编码 agent 的语音指令整理器。用户对着麦克风口述了一条给编码 agent 的指令，你收到的是这段录音。你的任务不是逐字转写，而是输出一条清晰、书面化、可以直接交给编码 agent 执行的指令。',
  `规则：
1. 说话人自我更正（如“嗯不对”“啊不”“不是…是…”）时，只保留更正后的意思，删掉被否定的部分。
2. 删掉口头禅和填充词（嗯、那个、就是、啊）。
3. 文件名、函数名、hook 名等代码标识符用反引号包起来，按听到的拼写写出，不要猜测或替换。
4. 数字一律用阿拉伯数字。
5. 不得添加录音里没有的信息，不得省略录音里的任何要求。
6. 只输出整理后的指令本身，不要解释。`,
].join('\n\n');

type CallResult = { status: number; ms: number; text: string; usage: any; err: string };

async function post(body: unknown, timeoutMs = 180000): Promise<CallResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j: any = await res.json().catch(() => null);
    return {
      status: res.status,
      ms: Date.now() - t0,
      text: j?.choices?.[0]?.message?.content ?? '',
      usage: j?.usage ?? null,
      err: res.ok ? '' : `${j?.error?.code ?? j?.code} ${String(j?.error?.message ?? j?.message).slice(0, 200)}`,
    };
  } catch (e: any) {
    return { status: 0, ms: Date.now() - t0, text: '', usage: null, err: e?.name ?? String(e) };
  }
}

function audioPart(item: Fixture) {
  const bytes = readFileSync(item.audio);
  const b64 = bytes.toString('base64');
  return { type: 'input_audio' as const, input_audio: { data: chatAudioDataUri('audio/wav', b64), format: audioFormatFor('audio/wav') } };
}

function omniBody(item: Fixture, system: string, temperature = 0) {
  const user: any[] = [audioPart(item), { type: 'text', text: TASK }];
  return {
    model: MODEL, modalities: ['text'], stream: false,
    reasoning_effort: process.env.OMNI_EFFORT || 'none',
    ...(temperature === 0 ? { temperature: 0 } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
}

async function callOmni(item: Fixture, system: string): Promise<CallResult> {
  let r = await post(omniBody(item, system));
  if (r.status === 400 && /temperature/i.test(r.err)) r = await post(omniBody(item, system, -1));
  if (r.status !== 200) {
    await new Promise((s) => setTimeout(s, 3000));
    r = await post(omniBody(item, system));
  }
  return r;
}

async function callShippedOmni(item: Fixture): Promise<CallResult> {
  const adapter = resolveAsr('dashscope-omni');
  const t0 = Date.now();
  const result: any = await adapter.transcribe(
    { audio: { bytes: new Uint8Array(readFileSync(item.audio)), mimeType: 'audio/wav', fileName: path.basename(item.audio) } },
    { baseUrl: ENDPOINT, apiKey: KEY, model: MODEL, timeoutMs: 180000, fetchImpl: fetch },
  );
  return {
    status: result.ok ? 200 : (result.status ?? 500),
    ms: Date.now() - t0,
    text: result.ok ? result.text : '',
    usage: result.meta?.usage ?? null,
    err: result.ok ? '' : `${result.code} ${String(result.message).slice(0, 200)}`,
  };
}

async function callText(system: string, user: string): Promise<CallResult> {
  const body = {
    model: TEXT_MODEL, stream: false, enable_thinking: false,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  let r = await post(body);
  if (r.status === 400 && /enable_thinking|thinking/i.test(r.err)) {
    r = await post({ model: TEXT_MODEL, stream: false, messages: body.messages });
  }
  return r;
}

// ── the two-stage text arm (voice-draft D): a replacement table, machine-validated ─────────────
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function editRatio(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x.length && !y.length) return 0;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  }
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}
let repoNames: Set<string> | null = null;
function names() {
  if (repoNames) return repoNames;
  const paths = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  repoNames = new Set<string>();
  for (const p of paths) {
    const b = p.split('/').pop()!;
    repoNames.add(b); repoNames.add(b.replace(/\.[a-z]{1,6}$/i, ''));
  }
  return repoNames;
}
function applyReplacements(text: string, ctx: string, raw: string): { text: string; applied: any[]; rejected: any[] } {
  let parsed: any = null;
  const m = raw.match(/\{[\s\S]*\}/);
  try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  const list = Array.isArray(parsed?.replacements) ? parsed.replacements : [];
  let out = text;
  const applied: any[] = []; const rejected: any[] = [];
  for (const r of list) {
    const from = typeof r?.from === 'string' ? r.from : '';
    const to = typeof r?.to === 'string' ? r.to : '';
    if (!from || !to || !out.includes(from)) { rejected.push({ ...r, why: 'from-not-in-text' }); continue; }
    if (!ctx.includes(to) && !names().has(to)) { rejected.push({ ...r, why: 'to-not-in-context-or-repo' }); continue; }
    if (editRatio(from, to) > 0.5) { rejected.push({ ...r, why: 'edit-distance' }); continue; }
    if (names().has(from)) { rejected.push({ ...r, why: 'from-is-valid-name' }); continue; }
    out = out.replace(from, to);
    applied.push({ from, to });
  }
  return { text: out, applied, rejected };
}
async function callTwoStage(item: Fixture, n0: string): Promise<CallResult & { applied?: any[]; rejected?: any[] }> {
  const system = '你在做语音听写的文本校正。A 是识别器整理后的文本，B 是当前会话上下文。只输出一个 JSON 对象 {"replacements":[{"from":"...","to":"..."}]}。每个 from 必须是 A 中逐字出现的子串；每个 to 必须出现在 B 中；不要改写、不要补充、不要删除；没有需要改的就输出 {"replacements":[]}。';
  const user = `A:\n${n0}\n\nB:\n${item.context}`;
  const r = await callText(system, user);
  if (r.status !== 200) return r;
  const applied = applyReplacements(n0, item.context, r.text);
  return { ...r, text: applied.text, applied: applied.applied, rejected: applied.rejected };
}

function keyOf(arm: string, item: Fixture, rep: number) { return `${arm}|${item.key}|${rep}`; }
function loadDone(): Set<string> {
  return new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => {
    const r = JSON.parse(l); return keyOf(r.arm, { key: r.key } as Fixture, r.rep);
  }) : []);
}
function save(arm: string, item: Fixture, rep: number, r: CallResult & Record<string, any>) {
  appendFileSync(RES, JSON.stringify({ arm, key: item.key, rep, at: new Date().toISOString(), ...r }) + '\n');
}

async function main() {
  if (!KEY) throw new Error('DASHSCOPE_API_KEY is not set');
  const done = loadDone();
  const deadline = Date.now() + Number(process.env.BUDGET_MS ?? 1200000);
  let calls = 0;
  const maxCalls = Number(process.env.MAX_CALLS ?? 90);
  const canRun = () => Date.now() < deadline && calls < maxCalls;

  const jobs: Array<() => Promise<void>> = [];
  for (const item of fixtures) for (let rep = 0; rep < REPS; rep++) {
    if (wantArm('N0') && !done.has(keyOf('N0', item, rep))) jobs.push(async () => {
      const r = await callOmni(item, RELAY_SYSTEM); calls++; save('N0', item, rep, r);
      console.log('N0', item.key, rep, r.status, r.ms, r.err);
    });
    if (wantArm('N1') && !done.has(keyOf('N1', item, rep))) jobs.push(async () => {
      const r = await callOmni(item, CONTEXT_SYSTEM(item.context)); calls++; save('N1', item, rep, r);
      console.log('N1', item.key, rep, r.status, r.ms, r.err);
    });
    if (wantArm('N2') && !done.has(keyOf('N2', item, rep))) jobs.push(async () => {
      const r = await callShippedOmni(item); calls++; save('N2', item, rep, r);
      console.log('N2', item.key, rep, r.status, r.ms, r.err);
    });
  }
  // The negative control: the two referential items get another item's context.
  const wrongFor: Record<string, string> = {
    'referent-architecture-tab': 'referent-live-voice-test',
    'referent-live-voice-test': 'referent-architecture-tab',
  };
  for (const item of fixtures) {
    const from = wrongFor[item.key];
    if (!from) continue;
    if (wantArm('N1-wrong') && !done.has(keyOf('N1-wrong', item, 0))) jobs.push(async () => {
      const other = fixtures.find((f) => f.key === from)!;
      const r = await callOmni(item, CONTEXT_SYSTEM(other.context)); calls++; save('N1-wrong', item, 0, r);
      console.log('N1-wrong', item.key, 0, r.status, r.ms, r.err);
    });
  }

  const worker = async () => {
    while (jobs.length && canRun()) {
      const job = jobs.shift()!;
      try { await job(); } catch (e: any) { console.log('JOB-ERROR', e?.message ?? e); }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));

  // T depends on N0's output, so it runs after the first wave.
  const n0 = new Map<string, string>();
  if (existsSync(RES)) for (const line of readFileSync(RES, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.arm === 'N0' && r.status === 200) n0.set(`${r.key}|${r.rep}`, r.text);
  }
  const tjobs: Array<() => Promise<void>> = [];
  for (const item of fixtures) for (let rep = 0; rep < REPS; rep++) {
    if (!wantArm('T')) break;
    if (done.has(keyOf('T', item, rep))) continue;
    const src = n0.get(`${item.key}|${rep}`);
    if (src === undefined) continue;
    tjobs.push(async () => {
      const r = await callTwoStage(item, src); calls++; save('T', item, rep, { ...r, source: src });
      console.log('T', item.key, rep, r.status, r.ms, r.err, (r as any).applied?.length ?? 0);
    });
  }
  const tworker = async () => { while (tjobs.length && canRun()) { const j = tjobs.shift()!; try { await j(); } catch (e: any) { console.log('T-ERROR', e?.message ?? e); } } };
  await Promise.all(Array.from({ length: 3 }, tworker));
  console.log(`DONE calls=${calls} left=${jobs.length + tjobs.length}${canRun() ? '' : ' (budget stop)'}`);
}

if (process.argv[2] === 'run') await main();
