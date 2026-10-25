/**
 * Shared corpus loader for the caret-item-matching experiments.
 *
 * One unit is a human turn paired with the last assistant text record before
 * it — the same reply the composer would search. The filters are the earlier
 * voice-grounding probe's: one line, 1–200 characters, no injected
 * notifications, no command wrappers, no sidechains.
 *
 * Kept in one file so the replay and the annotation sampler cannot disagree
 * about what counts as a unit.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const DEFAULT_CORPUS_ROOT = path.join(
  homedir(),
  '.claude',
  'projects',
  '-data-home-yale-work-claudecodeui',
);

const MAX_REPLY_CHARS = 100_000;
const DAY_MS = 86_400_000;

/** One human turn and the assistant reply the composer would have searched. */
export type Pair = {
  reply: string;
  utterance: string;
  sessionId: string;
  file: string;
  timestamp: string;
};

export type Corpus = {
  pairs: Pair[];
  files: number;
  bytes: number;
  scanMs: number;
  root: string;
  days: number;
};

export type LoadPairOptions = {
  root?: string;
  days?: number;
  maxFiles?: number;
  /** Sessions excluded from the sample, e.g. the session doing the annotation. */
  excludeSessionIds?: readonly string[];
};

const SKIP_USER_TEXT = /(task-notification|cross-session|Caveat:|^\[|^\/|tool_use|Request interrupted|^<)/;

function userText(record: Record<string, unknown>): string | null {
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
  if (!text || text.includes('\n') || text.length > 200) {
    return null;
  }
  if (SKIP_USER_TEXT.test(text)) {
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
  return content.slice(0, MAX_REPLY_CHARS);
}

/** Loads the recent transcripts and pairs human turns with their last reply. */
export async function loadPairs(options: LoadPairOptions = {}): Promise<Corpus> {
  const root = options.root ?? DEFAULT_CORPUS_ROOT;
  const days = options.days ?? Number(process.env.DAYS ?? 14);
  const maxFiles = options.maxFiles ?? (process.env.MAX_FILES ? Number(process.env.MAX_FILES) : Infinity);
  const excluded = new Set(options.excludeSessionIds ?? []);
  const started = performance.now();
  const cutoff = Date.now() - days * DAY_MS;

  const files = readdirSync(root)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(root, name))
    .filter((file) => statSync(file).mtimeMs >= cutoff)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .slice(0, maxFiles);

  const pairs: Pair[] = [];
  let bytes = 0;
  for (const [index, file] of files.entries()) {
    bytes += statSync(file).size;
    const fallbackSessionId = path.basename(file, '.jsonl');
    let lastAssistant: string | null = null;
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
        const reply = assistantText(record);
        if (reply) {
          lastAssistant = reply;
        }
      } else if (record.type === 'user') {
        const utterance = userText(record);
        const sessionId = String(record.sessionId ?? fallbackSessionId);
        if (utterance && lastAssistant && !excluded.has(sessionId)) {
          pairs.push({
            reply: lastAssistant,
            utterance,
            sessionId,
            file: path.basename(file),
            timestamp: String(record.timestamp ?? ''),
          });
        }
      }
    }
    if ((index + 1) % 400 === 0) {
      process.stderr.write(`scanned ${index + 1}/${files.length} files, ${pairs.length} pairs\n`);
    }
  }

  return { pairs, files: files.length, bytes, scanMs: performance.now() - started, root, days };
}
