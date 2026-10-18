/**
 * Can a cheap model decide "omitted vs present vs junk" for a recogniser utterance, given only what the
 * relay forwarded in the next 20 s?  Scored against the human O/D labels in labels.json.
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-relay-qb/judge.mts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

const MODEL = process.env.JUDGE_MODEL ?? 'haiku';
const items = JSON.parse(readFileSync('/tmp/judge_items.json', 'utf8')) as Array<{ idx: number; chars: number; asr: string; messages: string[]; label: 'O' | 'D' | null }>;

const SYSTEM =
  'You audit a voice-to-text relay. A speech recogniser transcribes what a person says (it makes mistakes: homophones, garbled English, ' +
  'wrong numerals, cut-off fragments). A relay model then forwards REWRITTEN messages to a coding assistant. You decide, for one recogniser ' +
  'utterance, whether its content reached the assistant. Reply with exactly one line and nothing else.';
const prompt = (asr: string, msgs: string[]): string =>
  `UTTERANCE (recogniser text): ${asr}\n\nMESSAGES THE RELAY FORWARDED IN THE FOLLOWING SECONDS:\n` +
  (msgs.length ? msgs.map((m, i) => `${i + 1}. ${m}`).join('\n') : '(none)') +
  `\n\nIs the content of the UTTERANCE present in those messages? Count it as present if it is reworded, merged into a longer message, ` +
  `had recogniser mistakes corrected, or has numbers written as digits.\n` +
  `Answer with one line: PRESENT, OMITTED (real content the person said that is missing), or JUNK (the utterance looks like a recogniser ` +
  `hallucination or a meaningless fragment, so not forwarding it is fine), then " | " and a reason of at most 15 words.`;

const ask = async (asr: string, msgs: string[]): Promise<string> => {
  const q = query({ prompt: prompt(asr, msgs), options: { model: MODEL, maxTurns: 1, cwd: '/tmp', settingSources: [], systemPrompt: SYSTEM, tools: [], allowedTools: [] } as never });
  let text = '';
  for await (const m of q as AsyncIterable<any>) if (m.type === 'result') text = String(m.result ?? '');
  return text.trim().split('\n')[0] ?? '';
};
const out: Array<Record<string, unknown>> = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < items.length) {
    const it = items[next++]!;
    const verdict = await ask(it.asr, it.messages).catch((e) => `ERROR ${String(e).slice(0, 80)}`);
    out.push({ idx: it.idx, chars: it.chars, label: it.label, asr: it.asr, verdict });
  }
}));
out.sort((a, b) => (a.idx as number) - (b.idx as number));
writeFileSync('experiments/voice-relay-qb/traces/judge-' + MODEL + '.json', JSON.stringify(out, null, 1));
console.log(`judged ${out.length} with ${MODEL}`);
process.exit(0);
