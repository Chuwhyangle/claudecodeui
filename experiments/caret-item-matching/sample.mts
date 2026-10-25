/**
 * Draws the 60-pair human-annotation sample.
 *
 * STRATA. The annotation has to answer a question the automatic replay cannot:
 * what did the person actually mean, including semantic references and true
 * negatives. Four strata, sampled independently and shuffled into opaque ids so
 * the annotator cannot see which is which:
 *
 *   · strong   — the utterance copies a path/identifier verbatim (the surface
 *                the matcher is already measured on; a calibration stratum).
 *   · numbered — the utterance uses 「第 N 点」/「按你的方案」 and no strong copy
 *                (the surface being disabled).
 *   · semantic — no verbatim copy, no numbered reference, but the utterance
 *                carries a deictic/noun phrase or shares a run with a heading
 *                or paragraph (the surface the annotation exists for).
 *   · control  — none of the above (true negatives; an offer here is noise).
 *
 * The sample excludes the session running the annotation, dedupes identical
 * utterances, and keeps replies under 15k characters so one card is readable.
 *
 * Run: npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/sample.mts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  extractReferenceTargets,
  normalizeReferenceTarget,
} from '@/modules/chat/utils/transcript/referenceTargets';
import type { ReferenceTarget } from '@/modules/chat/utils/transcript/referenceTargets';
import {
  extractReplyItems,
  resolveReplyReference,
} from '@/modules/chat/utils/transcript/replyItems';

import { loadPairs } from './corpus.mts';
import type { Pair } from './corpus.mts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT_DIR = path.join(HERE, 'annotation');
const CURRENT_SESSION = process.env.EXCLUDE_SESSION ?? '19d13448-61c4-4f10-bce0-bbc980704e72';
const SEED = Number(process.env.SEED ?? 20261025);
const MAX_REPLY_CHARS_FOR_ANNOTATION = 15_000;
const COUNTS = { strong: 10, numbered: 10, semantic: 20, control: 20 } as const;

type Stratum = keyof typeof COUNTS;

/** Deterministic PRNG: mulberry32. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function copiedKeys(targets: readonly ReferenceTarget[], utteranceNormalized: string): string[] {
  const keys: string[] = [];
  for (const target of targets) {
    if (target.kind !== 'path' && target.kind !== 'identifier') {
      continue;
    }
    for (const key of target.matchKeys) {
      const normalized = normalizeReferenceTarget(key);
      if (normalized.length >= 6 && utteranceNormalized.includes(normalized)) {
        keys.push(key);
      }
    }
  }
  return [...new Set(keys)];
}

const DEICTIC = /(这|那|它|该|上述|上面|前面|刚才|你的|方案|建议|思路|计划|意思|做法|第\s*(?:\d|[一二两三四五六七八九十百]))/;
const QUESTION = /(为什么|怎么|如何|什么|哪里|哪个|吗|？)/;
const COMMAND_START = /^(重启|提交|继续|好的|可以|建|执行|删除|关闭|打开|停|跑|测|看一下|同意|不用|先|再)/;

function sharesRunWithProse(reply: string, utterance: string): boolean {
  const prose = extractReferenceTargets(reply, {
    includeHeadings: true,
    includeCodeLines: false,
    includeParagraphs: true,
  }).filter((target) => target.kind === 'heading' || target.kind === 'paragraph');
  const normalizedUtterance = normalizeReferenceTarget(utterance);
  for (const target of prose) {
    const normalizedTarget = normalizeReferenceTarget(target.text);
    // A shared run of four CJK characters, or a five-character Latin token.
    for (let index = 0; index + 4 <= normalizedUtterance.length; index += 1) {
      const run = normalizedUtterance.slice(index, index + 4);
      if (/^[一-鿿]{4}$/.test(run) && normalizedTarget.includes(run)) {
        return true;
      }
    }
    const latinTokens = target.text.match(/[A-Za-z][A-Za-z0-9_-]{4,}/g) ?? [];
    for (const token of latinTokens) {
      if (utterance.toLowerCase().includes(token.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function classify(
  pair: Pair,
  targets: readonly ReferenceTarget[],
  copied: readonly string[],
  numberedKind: string,
): Stratum | null {
  if (copied.length > 0) {
    return 'strong';
  }
  if (numberedKind !== 'none') {
    return 'numbered';
  }
  if (DEICTIC.test(pair.utterance) || QUESTION.test(pair.utterance) || sharesRunWithProse(pair.reply, pair.utterance)) {
    return 'semantic';
  }
  return 'control';
}

function firstLine(reply: string): string {
  const heading = reply.split(/\r?\n/).find((line) => /^#{1,6}\s+/.test(line));
  const text = (heading ?? reply).replace(/^#{1,6}\s+/, '').replace(/[`*_~]/g, '').trim();
  return text.slice(0, 90);
}

async function main(): Promise<void> {
  const corpus = await loadPairs({ excludeSessionIds: [CURRENT_SESSION] });
  const seenUtterances = new Set<string>();
  const pools: Record<Stratum, { pair: Pair; copied: string[]; numberedKind: string }[]> = {
    strong: [], numbered: [], semantic: [], control: [],
  };
  let skippedLongReply = 0;

  for (const pair of corpus.pairs) {
    if (pair.reply.length > MAX_REPLY_CHARS_FOR_ANNOTATION) {
      skippedLongReply += 1;
      continue;
    }
    if (seenUtterances.has(pair.utterance)) {
      continue;
    }
    seenUtterances.add(pair.utterance);
    const targets = extractReferenceTargets(pair.reply);
    const copied = copiedKeys(targets, normalizeReferenceTarget(pair.utterance));
    const items = extractReplyItems(pair.reply);
    const numberedKind = items.length > 0 ? resolveReplyReference(pair.utterance, items).kind : 'none';
    const stratum = classify(pair, targets, copied, numberedKind);
    if (stratum) {
      pools[stratum].push({ pair, copied, numberedKind });
    }
  }

  const random = makeRandom(SEED);
  const selected: { stratum: Stratum; entry: { pair: Pair; copied: string[]; numberedKind: string } }[] = [];
  for (const stratum of Object.keys(COUNTS) as Stratum[]) {
    const pool = shuffle(pools[stratum], random);
    const take = Math.min(COUNTS[stratum], pool.length);
    if (take < COUNTS[stratum]) {
      process.stderr.write(`WARN stratum ${stratum}: wanted ${COUNTS[stratum]}, pool has ${pool.length}\n`);
    }
    for (const entry of pool.slice(0, take)) {
      selected.push({ stratum, entry });
    }
  }

  // Shuffle across strata so the id order leaks nothing; the mapping stays in sample.json.
  const ordered = shuffle(selected, random);
  const items = ordered.map(({ stratum, entry }, index) => ({
    id: `P${String(index + 1).padStart(2, '0')}`,
    stratum,
    utterance: entry.pair.utterance,
    reply: entry.pair.reply,
    title: firstLine(entry.pair.reply),
    sessionId: entry.pair.sessionId,
    file: entry.pair.file,
    timestamp: entry.pair.timestamp,
    auto: {
      copied: entry.copied,
      numberedKind: entry.numberedKind,
    },
  }));

  mkdirSync(OUT_DIR, { recursive: true });
  const sample = {
    schema: 'caret-item-matching/annotation-sample/1',
    seed: SEED,
    createdAt: new Date().toISOString(),
    corpus: {
      root: corpus.root,
      days: corpus.days,
      pairs: corpus.pairs.length,
      excludedSessionId: CURRENT_SESSION,
      skippedLongReply,
      poolSizes: Object.fromEntries(
        (Object.keys(pools) as Stratum[]).map((stratum) => [stratum, pools[stratum].length]),
      ),
    },
    counts: Object.fromEntries((Object.keys(COUNTS) as Stratum[]).map((stratum) => [stratum, COUNTS[stratum]])),
    items,
  };
  writeFileSync(path.join(OUT_DIR, 'sample.json'), `${JSON.stringify(sample, null, 2)}\n`);

  const publicItems = items.map(({ id, utterance, reply, title }) => ({ id, utterance, reply, title }));
  const template = readFileSync(path.join(OUT_DIR, 'template.html'), 'utf8');
  // `</script>` inside a reply would terminate the inline script; escaping `<`
  // keeps the JSON parseable and the HTML intact.
  const embedded = JSON.stringify(publicItems).replace(/</g, '\\u003c');
  const html = template.replace('__ITEMS__', embedded);
  writeFileSync(path.join(OUT_DIR, 'index.html'), html);

  process.stdout.write(`${JSON.stringify({
    poolSizes: sample.corpus.poolSizes,
    selected: items.length,
    byStratum: Object.fromEntries(
      (Object.keys(COUNTS) as Stratum[]).map((stratum) => [
        stratum,
        items.filter((item) => item.stratum === stratum).length,
      ]),
    ),
    skippedLongReply,
    out: path.join(OUT_DIR, 'index.html'),
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
