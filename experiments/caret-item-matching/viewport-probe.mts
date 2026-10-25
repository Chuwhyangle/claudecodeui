/**
 * Where do quoted/referenced passages actually come from?
 *
 * THE QUESTION. The composer feature under discussion competes with the quote
 * chip: the person scrolls to a passage, selects it, and the chip inserts it.
 * The token-completion prototype assumed the candidate pool is the LAST
 * assistant message. This probe tests that assumption on real transcripts by
 * finding every human turn that contains a verbatim run from an earlier
 * message, and recording where that run came from:
 *
 *   · role of the source (assistant / user)
 *   · how many messages back it is
 *   · whether it is the last assistant text message (the prototype's pool)
 *   · whether it is within the last three messages (a crude proxy for what is
 *     on screen beside the composer)
 *   · turns with a deictic phrase but no verbatim run (the semantic surface the
 *     annotation found: 「按方案 1 + 4」「这条提示」)
 *
 * A verbatim run of ≥20 normalised characters is the proxy for "the passage
 * was inserted or retyped". It cannot tell the chip from a manual copy, so it
 * is an UPPER bound on chip use; the role/distance split is the useful reading.
 *
 * Run: npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/viewport-probe.mts
 */

import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { normalizeReferenceTarget } from '@/modules/chat/utils/transcript/referenceTargets';

import { DEFAULT_CORPUS_ROOT } from './corpus.mts';

const DAYS = Number(process.env.DAYS ?? 21);
const WINDOW = 12;
const MIN_RUN = 20;
const MAX_MESSAGE_CHARS = 5_000;
const MAX_USER_CHARS = 2_000;

type WindowMessage = {
  role: 'user' | 'assistant';
  text: string;
  normalized: string;
  /** Position in the session's text-message sequence. */
  index: number;
};

const SKIP_USER = /(task-notification|cross-session|Caveat:|^\[|^\/|tool_use|Request interrupted|^<)/;
// Worker/agent prompts are long, agent-shaped, and not human chat; they would
// otherwise dominate the deictic denominator and count task text as a quote.
const AGENT_PROMPT = /^(You are (?:a|an)\b|你是(?:一个|一名)|任务正文|##\s*任务|#\s*任务|Task:)/i;
const DEICTIC = /(这|那|它|该|上述|上面|前面|刚才|你的|方案|建议|思路|计划|意思|做法|第\s*(?:\d|[一二两三四五六七八九十百])|此处|这条|这个|那个)/;

function humanText(record: Record<string, unknown>): string | null {
  if (record.isMeta || record.isSidechain) {
    return null;
  }
  const message = record.message as { content?: unknown } | undefined;
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content
      .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
      .map((block) => block.text ?? '')
      .join(' ');
  }
  if (typeof content !== 'string') {
    return null;
  }
  const text = content.trim();
  if (!text || text.length > MAX_USER_CHARS) {
    return null;
  }
  if (SKIP_USER.test(text) || AGENT_PROMPT.test(text)) {
    return null;
  }
  if (!/[一-鿿A-Za-z]/.test(text)) {
    return null;
  }
  return text;
}

function assistantText(record: Record<string, unknown>): string | null {
  const message = record.message as { content?: unknown } | undefined;
  let content = message?.content;
  if (Array.isArray(content)) {
    content = content
      .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
      .map((block) => block.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content !== 'string' || !content.trim()) {
    return null;
  }
  return content.slice(0, MAX_MESSAGE_CHARS);
}

/** Longest common normalised run (capped for speed); 0 when below MIN_RUN. */
function longestRun(a: string, b: string): number {
  if (a.length < MIN_RUN || b.length < MIN_RUN) {
    return 0;
  }
  const positions = new Map<string, number[]>();
  for (let index = 0; index + MIN_RUN <= b.length; index += 1) {
    const shingle = b.slice(index, index + MIN_RUN);
    const bucket = positions.get(shingle);
    if (bucket) {
      if (bucket.length < 3) {
        bucket.push(index);
      }
    } else {
      positions.set(shingle, [index]);
    }
  }
  let best = 0;
  for (let index = 0; index + MIN_RUN <= a.length; index += 1) {
    const bucket = positions.get(a.slice(index, index + MIN_RUN));
    if (!bucket) {
      continue;
    }
    for (const start of bucket) {
      let length = MIN_RUN;
      while (index + length < a.length && start + length < b.length && a[index + length] === b[start + length]) {
        length += 1;
      }
      if (length > best) {
        best = length;
      }
    }
  }
  return best;
}

const counts = {
  turns: 0,
  deicticTurns: 0,
  quoteTurns: 0,
  quoteFromAssistant: 0,
  quoteFromUser: 0,
  quoteFromLastAssistant: 0,
  quoteFromEarlierThanLastAssistant: 0,
  quoteWithinLastThree: 0,
  quoteEarlierThanLastThree: 0,
  quoteTurnsAlsoDeictic: 0,
  deicticWithoutQuote: 0,
};
const distances: number[] = [];
const runLengths: number[] = [];
const examples: Record<string, { utterance: string; source: string; role: string; distance: number; run: number }[]> = {
  lastAssistant: [],
  earlier: [],
  deicticNoQuote: [],
};

async function main(): Promise<void> {
  const cutoff = Date.now() - DAYS * 86_400_000;
  const files = readdirSync(DEFAULT_CORPUS_ROOT)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(DEFAULT_CORPUS_ROOT, name))
    .filter((file) => statSync(file).mtimeMs >= cutoff);
  const started = performance.now();
  let bytes = 0;

  for (const [fileIndex, file] of files.entries()) {
    bytes += statSync(file).size;
    const window: WindowMessage[] = [];
    let messageIndex = 0;
    const reader = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.includes('"type"')) {
        continue;
      }
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (record.type === 'assistant') {
        const text = assistantText(record);
        if (text) {
          messageIndex += 1;
          window.push({ role: 'assistant', text, normalized: normalizeReferenceTarget(text), index: messageIndex });
          if (window.length > WINDOW) {
            window.shift();
          }
        }
        continue;
      }
      if (record.type !== 'user') {
        continue;
      }
      const text = humanText(record);
      if (!text) {
        continue;
      }
      messageIndex += 1;
      counts.turns += 1;
      const normalized = normalizeReferenceTarget(text);
      const deictic = DEICTIC.test(text);
      if (deictic) {
        counts.deicticTurns += 1;
      }

      let best: { message: WindowMessage; distance: number; run: number } | null = null;
      for (let index = 0; index < window.length; index += 1) {
        const message = window[index];
        const distance = window.length - index;
        const run = longestRun(normalized, message.normalized);
        if (run >= MIN_RUN && (best === null || run > best.run)) {
          best = { message, distance, run };
        }
      }

      if (best !== null) {
        counts.quoteTurns += 1;
        runLengths.push(best.run);
        distances.push(best.distance);
        if (deictic) {
          counts.quoteTurnsAlsoDeictic += 1;
        }
        if (best.message.role === 'assistant') {
          counts.quoteFromAssistant += 1;
        } else {
          counts.quoteFromUser += 1;
        }
        const lastAssistant = [...window].reverse().find((message) => message.role === 'assistant');
        if (lastAssistant && best.message.index === lastAssistant.index) {
          counts.quoteFromLastAssistant += 1;
          if (examples.lastAssistant.length < 10) {
            examples.lastAssistant.push({
              utterance: text.slice(0, 120),
              source: best.message.text.slice(0, 120),
              role: best.message.role,
              distance: best.distance,
              run: best.run,
            });
          }
        } else {
          counts.quoteFromEarlierThanLastAssistant += 1;
          if (examples.earlier.length < 12) {
            examples.earlier.push({
              utterance: text.slice(0, 120),
              source: best.message.text.slice(0, 120),
              role: best.message.role,
              distance: best.distance,
              run: best.run,
            });
          }
        }
        if (best.distance <= 3) {
          counts.quoteWithinLastThree += 1;
        } else {
          counts.quoteEarlierThanLastThree += 1;
        }
      } else if (deictic) {
        counts.deicticWithoutQuote += 1;
        if (examples.deicticNoQuote.length < 12) {
          examples.deicticNoQuote.push({
            utterance: text.slice(0, 120),
            source: '',
            role: '',
            distance: 0,
            run: 0,
          });
        }
      }

      window.push({ role: 'user', text, normalized, index: messageIndex });
      if (window.length > WINDOW) {
        window.shift();
      }
    }
    if ((fileIndex + 1) % 400 === 0) {
      process.stderr.write(`scanned ${fileIndex + 1}/${files.length} files, ${counts.turns} turns\n`);
    }
  }

  distances.sort((left, right) => left - right);
  runLengths.sort((left, right) => left - right);
  const at = (values: number[], q: number): number =>
    values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(values.length * q))];
  const report = {
    schema: 'caret-item-matching/viewport-probe/1',
    ranAt: new Date().toISOString(),
    corpus: {
      root: DEFAULT_CORPUS_ROOT,
      days: DAYS,
      files: files.length,
      megabytes: Number((bytes / 1048576).toFixed(1)),
      scanSeconds: Number(((performance.now() - started) / 1000).toFixed(1)),
      windowMessages: WINDOW,
      minRun: MIN_RUN,
    },
    counts,
    rates: {
      quoteTurnShare: Number((counts.quoteTurns / Math.max(1, counts.turns)).toFixed(4)),
      lastAssistantShareOfQuotes: Number((counts.quoteFromLastAssistant / Math.max(1, counts.quoteTurns)).toFixed(4)),
      earlierThanLastAssistantShare: Number((counts.quoteFromEarlierThanLastAssistant / Math.max(1, counts.quoteTurns)).toFixed(4)),
      withinLastThreeShare: Number((counts.quoteWithinLastThree / Math.max(1, counts.quoteTurns)).toFixed(4)),
      deicticShare: Number((counts.deicticTurns / Math.max(1, counts.turns)).toFixed(4)),
      deicticWithoutQuoteShare: Number((counts.deicticWithoutQuote / Math.max(1, counts.turns)).toFixed(4)),
    },
    distances: {
      p50: at(distances, 0.5),
      p90: at(distances, 0.9),
      p95: at(distances, 0.95),
      max: distances[distances.length - 1] ?? 0,
    },
    runLengths: {
      p50: at(runLengths, 0.5),
      p90: at(runLengths, 0.9),
      p95: at(runLengths, 0.95),
      max: runLengths[runLengths.length - 1] ?? 0,
    },
    examples,
  };
  const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'VIEWPORT-RESULT.json');
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${out}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
