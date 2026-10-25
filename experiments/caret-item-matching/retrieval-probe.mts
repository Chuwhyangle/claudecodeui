/**
 * Can the typed opinion identify the passage the person just quoted?
 *
 * THE SCENARIO. The person scrolls to a passage, then types a comment around it.
 * The incumbent is the quote chip (select the passage, click). The keyboard
 * alternative has to find that passage from the draft alone and insert it. This
 * probe reconstructs the draft (the user message with the verbatim run removed)
 * and asks a lexical ranker over the visible-message window whether the quoted
 * passage is in the top three.
 *
 * WHAT IS MEASURED.
 *   · quote-only vs quote+opinion turns — a message that is just the passage has
 *     no draft to match and is the chip's job, not the keyboard's;
 *   · top-1 / top-3 passage retrieval, overall and by source distance;
 *   · the same with candidate windows of 3, 5 and 12 messages, because the
 *     real composer would use the viewport rather than the whole session.
 *
 * The ranker is deliberately cheap: character-bigram Dice + a distance prior.
 * If it already finds the passage, an LLM is not needed for the first cut. If it
 * does not, the gap is the budget an LLM arm has to close.
 *
 * Run: npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/retrieval-probe.mts
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
const MIN_DRAFT_CHARS = 5;
const WINDOWS = [3, 5, 12] as const;

type WindowMessage = {
  role: 'user' | 'assistant';
  text: string;
  normalized: string;
  index: number;
  passages: Passage[];
};

type Passage = {
  id: string;
  text: string;
  normalized: string;
};

const SKIP_USER = /(task-notification|cross-session|Caveat:|^\[|^\/|tool_use|Request interrupted|^<)/;
const AGENT_PROMPT = /^(You are (?:a|an)\b|你是(?:一个|一名)|任务正文|##\s*任务|#\s*任务|Task:)/i;

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

/** Normalises into the same alphabet matching uses, keeping a raw-index map. */
function normalizeWithMap(value: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index].toLowerCase();
    if (/[0-9a-z一-鿿]/.test(char)) {
      text += char;
      map.push(index);
    }
  }
  return { text, map };
}

function longestRunWithPositions(a: string, b: string): { length: number; aStart: number; bStart: number } {
  if (a.length < MIN_RUN || b.length < MIN_RUN) {
    return { length: 0, aStart: -1, bStart: -1 };
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
  let best = { length: 0, aStart: -1, bStart: -1 };
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
      if (length > best.length) {
        best = { length, aStart: index, bStart: start };
      }
    }
  }
  return best;
}

/** Splits one message into passages: paragraphs, list items, headings, code blocks. */
function segmentPassages(message: WindowMessage): Passage[] {
  const lines = message.text.split(/\r?\n/);
  const passages: Passage[] = [];
  let block: string[] = [];
  let inFence = false;
  let fence: string[] = [];
  let counter = 0;
  const push = (text: string): void => {
    const normalized = normalizeReferenceTarget(text);
    if (normalized.length < 8) {
      return;
    }
    counter += 1;
    passages.push({ id: `${message.index}:${counter}`, text: text.slice(0, 2_000), normalized });
  };
  const flush = (): void => {
    if (block.length > 0) {
      push(block.join('\n').trim());
      block = [];
    }
  };
  for (const line of lines) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      if (inFence) {
        push(fence.join('\n').trim());
        fence = [];
        inFence = false;
      } else {
        flush();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(line) || /^\s*(?:[-*+]|\d{1,2}[.)、）])\s+/.test(line)) {
      flush();
      push(line.trim());
      continue;
    }
    block.push(line);
  }
  flush();
  if (fence.length > 0) {
    push(fence.join('\n').trim());
  }
  return passages;
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index + 1 < text.length; index += 1) {
    const gram = text.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function dice(left: Map<string, number>, right: Map<string, number>): number {
  let overlap = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const count of left.values()) {
    leftTotal += count;
  }
  for (const [gram, count] of right) {
    rightTotal += count;
    overlap += Math.min(count, left.get(gram) ?? 0);
  }
  return leftTotal + rightTotal === 0 ? 0 : (2 * overlap) / (leftTotal + rightTotal);
}

type Turn = {
  draft: string;
  draftNormalized: string;
  quotedRun: string;
  sourceMessage: WindowMessage;
  sourcePassage: Passage;
  distance: number;
  quotedLength: number;
  window: WindowMessage[];
};

function rank(
  turn: Turn,
  windowSize: number,
): { top1: boolean; top3: boolean; topScore: number; candidateCount: number } {
  const candidates: { passage: Passage; score: number; distance: number; messageIndex: number }[] = [];
  const start = Math.max(0, turn.window.length - windowSize);
  for (let index = start; index < turn.window.length; index += 1) {
    const message = turn.window[index];
    const distance = turn.window.length - index;
    for (const passage of message.passages) {
      const score = dice(bigrams(turn.draftNormalized), bigrams(passage.normalized)) + 0.02 / distance;
      candidates.push({ passage, score, distance, messageIndex: index });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.distance - right.distance);
  const top = candidates.slice(0, 3);
  const top1 = top[0]?.passage.id === turn.sourcePassage.id;
  const top3 = top.some((candidate) => candidate.passage.id === turn.sourcePassage.id);
  return { top1, top3, topScore: top[0]?.score ?? 0, candidateCount: candidates.length };
}

type Stats = Record<string, { turns: number; top1: number; top3: number }>;

const stats: Stats = {};
const bump = (key: string, top1: boolean, top3: boolean): void => {
  const row = stats[key] ?? { turns: 0, top1: 0, top3: 0 };
  row.turns += 1;
  row.top1 += top1 ? 1 : 0;
  row.top3 += top3 ? 1 : 0;
  stats[key] = row;
};

async function main(): Promise<void> {
  const cutoff = Date.now() - DAYS * 86_400_000;
  const files = readdirSync(DEFAULT_CORPUS_ROOT)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(DEFAULT_CORPUS_ROOT, name))
    .filter((file) => statSync(file).mtimeMs >= cutoff);
  const started = performance.now();
  let bytes = 0;
  const counts = {
    turns: 0,
    quoteTurns: 0,
    quoteOnlyTurns: 0,
    opinionTurns: 0,
    opinionWithGroundTruth: 0,
    skippedNoGroundTruth: 0,
  };
  const examples: Record<string, unknown[]> = { hit: [], miss: [] };

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
          const message: WindowMessage = {
            role: 'assistant', text, normalized: normalizeReferenceTarget(text), index: messageIndex, passages: [],
          };
          message.passages = segmentPassages(message);
          window.push(message);
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
      const { text: normalized, map } = normalizeWithMap(text);

      let best: { message: WindowMessage; distance: number; run: number; aStart: number; bStart: number } | null = null;
      for (let index = 0; index < window.length; index += 1) {
        const message = window[index];
        const distance = window.length - index;
        const run = longestRunWithPositions(normalized, message.normalized);
        if (run.length >= MIN_RUN && (best === null || run.length > best.run)) {
          best = { message, distance, run: run.length, aStart: run.aStart, bStart: run.bStart };
        }
      }

      if (best !== null) {
        counts.quoteTurns += 1;
        // Remove the quoted raw span from the message to recover the draft.
        const rawStart = map[best.aStart];
        const rawEnd = map[best.aStart + best.run - 1] + 1;
        const draft = `${text.slice(0, rawStart)} ${text.slice(rawEnd)}`.trim();
        const draftNormalized = normalizeReferenceTarget(draft);
        const quotedRun = best.message.normalized.slice(best.bStart, best.bStart + best.run);

        if (draftNormalized.length < MIN_DRAFT_CHARS) {
          counts.quoteOnlyTurns += 1;
        } else {
          counts.opinionTurns += 1;
          // The ground-truth passage is the one carrying the quoted run.
          let ground: { passage: Passage; overlap: number } | null = null;
          for (const passage of best.message.passages) {
            const overlap = longestRunWithPositions(quotedRun, passage.normalized).length;
            if (overlap > 0 && (ground === null || overlap > ground.overlap)) {
              ground = { passage, overlap };
            }
          }
          if (ground === null) {
            counts.skippedNoGroundTruth += 1;
          } else {
            counts.opinionWithGroundTruth += 1;
            const turn: Turn = {
              draft,
              draftNormalized,
              quotedRun,
              sourceMessage: best.message,
              sourcePassage: ground.passage,
              distance: best.distance,
              quotedLength: best.run,
              window: [...window],
            };
            for (const size of WINDOWS) {
              const reading = rank(turn, size);
              bump(`window-${size}`, reading.top1, reading.top3);
              bump(`window-${size}-distance-${best.distance <= 3 ? 'near' : 'far'}`, reading.top1, reading.top3);
              bump(`window-${size}-quote-${best.run >= 40 ? 'long' : 'short'}`, reading.top1, reading.top3);
            }
            const wide = rank(turn, 12);
            if (examples.hit.length < 6 && wide.top1) {
              examples.hit.push({
                draft: draft.slice(0, 140),
                quoted: quotedRun.slice(0, 140),
                distance: best.distance,
                topScore: Number(wide.topScore.toFixed(3)),
              });
            }
            if (examples.miss.length < 6 && !wide.top3) {
              examples.miss.push({
                draft: draft.slice(0, 140),
                quoted: quotedRun.slice(0, 140),
                distance: best.distance,
                topScore: Number(wide.topScore.toFixed(3)),
              });
            }
          }
        }
      }

      const userMessage: WindowMessage = {
        role: 'user', text, normalized, index: messageIndex, passages: [],
      };
      userMessage.passages = segmentPassages(userMessage);
      window.push(userMessage);
      if (window.length > WINDOW) {
        window.shift();
      }
    }
    if ((fileIndex + 1) % 400 === 0) {
      process.stderr.write(`scanned ${fileIndex + 1}/${files.length} files, ${counts.turns} turns\n`);
    }
  }

  const rates = Object.fromEntries(
    Object.entries(stats).map(([key, row]) => [key, {
      turns: row.turns,
      top1: Number((row.top1 / Math.max(1, row.turns)).toFixed(3)),
      top3: Number((row.top3 / Math.max(1, row.turns)).toFixed(3)),
    }]),
  );
  const report = {
    schema: 'caret-item-matching/retrieval-probe/1',
    ranAt: new Date().toISOString(),
    corpus: {
      root: DEFAULT_CORPUS_ROOT,
      days: DAYS,
      files: files.length,
      megabytes: Number((bytes / 1048576).toFixed(1)),
      scanSeconds: Number(((performance.now() - started) / 1000).toFixed(1)),
    },
    counts,
    rates,
    examples,
  };
  const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'RETRIEVAL-RESULT.json');
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${out}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
