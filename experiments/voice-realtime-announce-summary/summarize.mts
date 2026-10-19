/**
 * B-1: can the realtime model turn a REAL Claude Code output into a short,
 * voice-friendly summary — rather than reading the output back?
 *
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-realtime-announce-summary/summarize.mts
 *
 * Material: one REAL assistant output from this project's own sessions
 * (fixtures/real-claude-output.json, 3057 chars — a UI review with findings and a
 * plan). The probe feeds it to `qwen3.8-omni-flash` — the HTTP twin of the
 * realtime relay model — under a few prompt variants, and prints each summary
 * with mechanical quality readings a gate can later pin:
 *
 *   · chars        — is it short enough to say aloud?  (target ≤ 40)
 *   · markdown     — does it carry glyphs a voice cannot pronounce?  (`# * | - \``)
 *   · verbatimTail — does it just paste the output's own words?  (longest shared tail)
 *
 * ¥0, no upstream audio: one text request per prompt variant.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.DASHSCOPE_API_KEY ?? '';
if (API_KEY === '') {
  throw new Error('DASHSCOPE_API_KEY is not set — run `set -a; . ./.env.test; set +a` first.');
}

const URL_ = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen3.8-omni-flash';

const fixture = JSON.parse(readFileSync(path.join(HERE, 'fixtures/real-claude-output.json'), 'utf8')) as {
  source_session: string;
  chars: number;
  text: string;
};
const OUTPUT = fixture.text;

/** The prompt variants. `voice` is the one that mirrors what the relay's announce mode asks for. */
const PROMPTS: Record<string, string> = {
  plain:
    '把下面这段 Claude Code 的工作输出压缩成一句适合语音播报的简短小结（中文，不超过 40 字），只讲结果和结论。',
  voice:
    '你是语音播报助手。下面是一段 Claude Code 的工作输出。请用一句简短、口语化的中文（不超过 40 字）说出它完成了什么、结论是什么。不要念原文，不要用 Markdown，不要列举，不要复述细节。',
};

/** Mechanical quality readings, so a gate can be pinned later without a human re-reading every run. */
function readings(summary: string): { chars: number; markdown: string[]; verbatimTail: number } {
  const markdown: string[] = [];
  for (const ch of summary) {
    if ('#*`|'.includes(ch) || (ch === '-' && !markdown.includes('-'))) markdown.push(ch);
  }
  // Longest suffix the summary shares with the source — the "it just pasted the output" reading.
  let verbatimTail = 0;
  for (let n = 1; n <= Math.min(summary.length, OUTPUT.length); n++) {
    if (summary.slice(-n) === OUTPUT.slice(-n)) verbatimTail = n;
    else break;
  }
  return { chars: summary.length, markdown, verbatimTail };
}

async function summarize(prompt: string): Promise<{ status: number; ms: number; text: string; err: string }> {
  const body = {
    model: MODEL,
    modalities: ['text'],
    stream: false,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${prompt}\n\n<输出>\n${OUTPUT}\n</输出>` }] }],
  };
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const j = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: unknown;
    } | null;
    const text = j?.choices?.[0]?.message?.content ?? '';
    return { status: res.status, ms: Date.now() - t0, text, err: res.ok ? '' : JSON.stringify(j?.error ?? j).slice(0, 200) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: '', err: String(e) };
  }
}

console.log(`fixture: session ${fixture.source_session}, ${fixture.chars} chars, model ${MODEL}\n`);
for (const [key, prompt] of Object.entries(PROMPTS)) {
  const r = await summarize(prompt);
  const q = readings(r.text.trim());
  console.log(`── ${key} ──  status=${r.status} ${r.ms}ms  ${r.err === '' ? '' : `ERR ${r.err}`}`);
  if (r.text.trim() === '') {
    console.log('  (empty)\n');
    continue;
  }
  console.log(`  chars=${q.chars}  markdown=[${q.markdown.join('')}]  verbatimTail=${q.verbatimTail}`);
  console.log(`  → ${r.text.trim()}\n`);
}
