/**
 * Corpus replay for the reference-target prototype.
 *
 * THE QUESTION. If the composer offered to complete the token before the caret
 * with something the last assistant reply already said, would that offer be
 * right often enough to be worth showing — and what does it cost to compute?
 *
 * THE CORPUS. Real Claude Code transcripts under
 * `~/.claude/projects/-data-home-yale-work-claudecodeui`, the last N days. Each
 * unit is one human turn paired with the last assistant text record before it —
 * the same reply the composer would search. Worker prompts and injected
 * notifications are filtered exactly as the earlier voice-grounding probe did.
 *
 * WHAT IS MEASURED, AND WHY EACH READING.
 *
 *   · coverage / hit@1 / hit@3  — on turns that copy a target verbatim, is the
 *     copied target the first (or in the first three) offer at the end?
 *   · firstHitChars             — how many characters had to be typed before the
 *     target appeared; a suggestion that only arrives at the end is useless.
 *   · falseShown                — on turns that copy nothing, how often an offer
 *     appears at a settled position. This is the annoyance rate, and the number
 *     this feature lives or dies by.
 *   · candidateSizes            — one offer or a short list; ambiguity is why
 *     acceptance has to be a choice rather than a guess.
 *   · top1Changes               — how often the first offer changes while the
 *     person types the same token. A flickering banner is worse than none.
 *   · extract / match latency   — measured in Node (the same V8 class as the
 *     browser) so the budget is real, not a Python proxy.
 *
 * GROUND TRUTH IS DELIBERATELY CONSERVATIVE. Only a verbatim copy of a path or
 * identifier (normalised length ≥ 6) counts as "the person meant this". Prose
 * references that the matcher would also be right about are therefore scored as
 * false offers — the falseShown number is an UPPER bound, not a true negative
 * rate. The report says so.
 *
 * Run: npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/replay.mts
 *      MAX_FILES=80 … (smoke run)
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  extractReferenceTargets,
  matchReferenceTargets,
  normalizeReferenceTarget,
  readCaretQuery,
} from '@/modules/chat/utils/transcript/referenceTargets';
import type {
  ReferenceTarget,
  ReferenceTargetKind,
  ReferenceTargetOptions,
} from '@/modules/chat/utils/transcript/referenceTargets';
import {
  extractReplyItems,
  resolveReplyReference,
} from '@/modules/chat/utils/transcript/replyItems';

import { loadPairs } from './corpus.mts';
import type { Pair } from './corpus.mts';
import { percentile } from './stats.mts';
import type { Percentiles } from './stats.mts';

function isTokenChar(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_./@-]/.test(character);
}

function isCjkChar(character: string | undefined): boolean {
  return character !== undefined && /[一-鿿]/.test(character);
}

/** A settled position: the token has stopped growing, so a banner would hold. */
function isSettlePosition(utterance: string, index: number): boolean {
  if (index >= utterance.length) {
    return true;
  }
  const next = utterance[index];
  return !isTokenChar(next) && !isCjkChar(next);
}

/** Targets the utterance copies verbatim, strongest key first. */
function copiedTargets(
  targets: readonly ReferenceTarget[],
  utteranceNormalized: string,
  kinds: readonly ReferenceTargetKind[],
  minKeyLength: number,
): { target: ReferenceTarget; key: string; keyLength: number }[] {
  const copied: { target: ReferenceTarget; key: string; keyLength: number }[] = [];
  for (const target of targets) {
    if (!kinds.includes(target.kind)) {
      continue;
    }
    let best = 0;
    let bestKey = '';
    for (const key of target.matchKeys) {
      const normalizedKey = normalizeReferenceTarget(key);
      if (normalizedKey.length >= minKeyLength && utteranceNormalized.includes(normalizedKey) && normalizedKey.length > best) {
        best = normalizedKey.length;
        bestKey = key;
      }
    }
    if (best > 0) {
      copied.push({ target, key: bestKey, keyLength: best });
    }
  }
  return copied.sort((left, right) => right.keyLength - left.keyLength);
}

type ScenarioOptions = {
  label: string;
  extract: ReferenceTargetOptions;
  match: ReferenceTargetOptions;
};

type ScenarioResult = {
  label: string;
  pairsWithTargets: number;
  targetsPerReply: Percentiles;
  copyableTurns: number;
  ambiguousTurns: number;
  uniqueIntendedTurns: number;
  firstHitTop1: number;
  firstHitRank: Record<string, number>;
  offersAtFirstHit: Record<string, number>;
  firstHitChars: Percentiles;
  charsIntoToken: Percentiles;
  savedChars: Percentiles;
  softCopyTurns: number;
  softUniqueTurns: number;
  softFirstHitTop1: number;
  softFirstHitRank: Record<string, number>;
  top1Changes: Percentiles;
  candidateSizes: Record<string, number>;
  falseOfferTopKinds: Record<string, number>;
  noCopyTurnsWithTargets: number;
  falseShownTurns: number;
  settleShownRatio: number;
  meanTargetsPerReply: number;
};

function runScenario(
  label: string,
  extractOptions: ReferenceTargetOptions,
  matchOptions: ReferenceTargetOptions,
  pairs: readonly Pair[],
  measureMatch: boolean,
): { result: ScenarioResult; matchTimes: number[]; examples: Record<string, unknown[]> } {
  const matchTimes: number[] = [];
  const examples: Record<string, unknown[]> = { hit: [], falseOffer: [], ambiguous: [], missed: [] };
  const targetsPerReply: number[] = [];
  let pairsWithTargets = 0;
  let copyableTurns = 0;
  let ambiguousTurns = 0;
  let uniqueIntendedTurns = 0;
  let firstHitTop1 = 0;
  const firstHitRank: Record<string, number> = {};
  const offersAtFirstHit: Record<string, number> = {};
  let noCopyTurnsWithTargets = 0;
  let falseShownTurns = 0;
  let settlePositions = 0;
  let settleShown = 0;
  const firstHitChars: number[] = [];
  const charsIntoToken: number[] = [];
  const savedChars: number[] = [];
  let softCopyTurns = 0;
  let softUniqueTurns = 0;
  let softFirstHitTop1 = 0;
  const softFirstHitRank: Record<string, number> = {};
  const top1Changes: number[] = [];
  const candidateSizes: Record<string, number> = {};
  const falseOfferTopKinds: Record<string, number> = {};

  for (const pair of pairs) {
    const targets = extractReferenceTargets(pair.reply, extractOptions);
    targetsPerReply.push(targets.length);
    if (targets.length > 0) {
      pairsWithTargets += 1;
    }

    const normalizedUtterance = normalizeReferenceTarget(pair.utterance);
    const copied = copiedTargets(targets, normalizedUtterance, ['path', 'identifier'], 6);
    const topLength = copied[0]?.keyLength ?? 0;
    const topCopies = copied.filter((candidate) => candidate.keyLength === topLength);
    const intended = topCopies.length === 1 ? topCopies[0].target : null;
    if (copied.length > 0) {
      copyableTurns += 1;
      if (topCopies.length > 1) {
        ambiguousTurns += 1;
      } else {
        uniqueIntendedTurns += 1;
      }
    }

    // Code lines and headings are a separate, softer surface: a person copying
    // a whole shell line or heading verbatim. Measured separately so the report
    // can say whether they earn their place rather than folding them into the
    // path/identifier rate.
    const softCopied = copied.length === 0
      ? copiedTargets(targets, normalizedUtterance, ['code-line', 'heading'], 10)
      : [];
    const softTopLength = softCopied[0]?.keyLength ?? 0;
    const softTopCopies = softCopied.filter((candidate) => candidate.keyLength === softTopLength);
    const softIntended = softTopCopies.length === 1 ? softTopCopies[0].target : null;
    if (softCopied.length > 0) {
      softCopyTurns += 1;
      if (softTopCopies.length === 1) {
        softUniqueTurns += 1;
      }
    }

    const intendedNormalized = intended ? normalizeReferenceTarget(intended.text) : null;
    let firstHit: number | null = null;
    let softFirstHit: number | null = null;
    let previousTop1: string | null = null;
    let changes = 0;
    let pairSettleShown = false;
    let firstShownPrefix: string | null = null;
    let firstShownOffers: string[] = [];
    let firstShownKinds: string[] = [];

    for (let index = 1; index <= pair.utterance.length; index += 1) {
      const prefix = pair.utterance.slice(0, index);
      const started = measureMatch ? performance.now() : 0;
      const matches = matchReferenceTargets(prefix, targets, matchOptions);
      if (measureMatch) {
        matchTimes.push((performance.now() - started) * 1000);
      }

      if (isSettlePosition(pair.utterance, index)) {
        settlePositions += 1;
        if (matches.length > 0) {
          settleShown += 1;
          pairSettleShown = true;
          if (firstShownPrefix === null) {
            firstShownPrefix = prefix;
            firstShownOffers = matches.map((match) => match.target.text);
            firstShownKinds = matches.map((match) => match.target.kind);
          }
          const bucket = String(Math.min(matches.length, 4));
          candidateSizes[bucket] = (candidateSizes[bucket] ?? 0) + 1;
        }
      }

      const currentTop1 = matches[0]?.target.text ?? null;
      if (currentTop1 !== previousTop1) {
        if (previousTop1 !== null && currentTop1 !== null) {
          changes += 1;
        }
        previousTop1 = currentTop1;
      }

      if (softIntended !== null && softFirstHit === null) {
        const softNormalized = normalizeReferenceTarget(softIntended.text);
        const softRankIndex = matches.findIndex(
          (match) => normalizeReferenceTarget(match.target.text) === softNormalized,
        );
        if (softRankIndex >= 0) {
          softFirstHit = index;
          if (softRankIndex === 0) {
            softFirstHitTop1 += 1;
          }
          softFirstHitRank[String(softRankIndex + 1)] = (softFirstHitRank[String(softRankIndex + 1)] ?? 0) + 1;
        }
      }

      if (intendedNormalized !== null && firstHit === null) {
        const rankIndex = matches.findIndex(
          (match) => normalizeReferenceTarget(match.target.text) === intendedNormalized,
        );
        if (rankIndex >= 0) {
          firstHit = index;
          if (rankIndex === 0) {
            firstHitTop1 += 1;
          }
          firstHitRank[String(rankIndex + 1)] = (firstHitRank[String(rankIndex + 1)] ?? 0) + 1;
          const offerBucket = String(Math.min(matches.length, 4));
          offersAtFirstHit[offerBucket] = (offersAtFirstHit[offerBucket] ?? 0) + 1;
          if (examples.ambiguous.length < 8 && matches.length > 1) {
            examples.ambiguous.push({
              utterance: pair.utterance,
              prefix,
              intended: intended.text,
              offers: matches.map((match) => match.target.text),
            });
          }
        }
      }
    }

    if (intended !== null) {
      if (firstHit !== null) {
        firstHitChars.push(firstHit);
        const key = topCopies[0].key;
        const rawStart = pair.utterance.toLowerCase().indexOf(key.toLowerCase());
        if (rawStart >= 0) {
          const typedIntoToken = firstHit - rawStart;
          charsIntoToken.push(typedIntoToken);
          savedChars.push(Math.max(0, key.length - typedIntoToken));
        }
      }
      top1Changes.push(changes);
      if (firstHit === null && examples.missed.length < 12) {
        const key = topCopies[0].key;
        const rawStart = pair.utterance.toLowerCase().indexOf(key.toLowerCase());
        const prefixAtToken = rawStart >= 0 ? pair.utterance.slice(0, rawStart + key.length) : pair.utterance;
        examples.missed.push({
          utterance: pair.utterance,
          intended: intended.text,
          key,
          queryAtToken: readCaretQuery(prefixAtToken).query,
          targetsOfKind: targets.filter((target) => target.kind === intended.kind).map((target) => target.text).slice(0, 10),
        });
      }
      if (examples.hit.length < 8 && firstHit !== null && firstHit < pair.utterance.length) {
        examples.hit.push({
          utterance: pair.utterance,
          intended: intended.text,
          firstHitChars: firstHit,
          prefixAtFirstHit: pair.utterance.slice(0, firstHit),
        });
      }
    } else if (copied.length === 0 && softCopied.length === 0 && targets.length > 0) {
      noCopyTurnsWithTargets += 1;
      if (pairSettleShown) {
        falseShownTurns += 1;
        const topKind = firstShownKinds[0] ?? 'none';
        falseOfferTopKinds[topKind] = (falseOfferTopKinds[topKind] ?? 0) + 1;
        if (examples.falseOffer.length < 12) {
          examples.falseOffer.push({
            utterance: pair.utterance,
            firstShownPrefix,
            offers: firstShownOffers,
            kinds: firstShownKinds,
          });
        }
      }
    }
  }

  return {
    result: {
      label,
      pairsWithTargets,
      targetsPerReply: percentile(targetsPerReply),
      copyableTurns,
      ambiguousTurns,
      uniqueIntendedTurns,
      firstHitTop1,
      firstHitRank,
      offersAtFirstHit,
      firstHitChars: percentile(firstHitChars),
      charsIntoToken: percentile(charsIntoToken),
      savedChars: percentile(savedChars),
      softCopyTurns,
      softUniqueTurns,
      softFirstHitTop1,
      softFirstHitRank,
      top1Changes: percentile(top1Changes),
      candidateSizes,
      falseOfferTopKinds,
      noCopyTurnsWithTargets,
      falseShownTurns,
      settleShownRatio: settlePositions === 0 ? 0 : settleShown / settlePositions,
      meanTargetsPerReply: targetsPerReply.reduce((sum, value) => sum + value, 0) / Math.max(1, targetsPerReply.length),
    },
    matchTimes,
    examples,
  };
}


async function main(): Promise<void> {
  const corpus = await loadPairs();
  const { pairs, files, bytes, scanMs } = corpus;
  process.stderr.write(`corpus: ${files} files, ${(bytes / 1048576).toFixed(1)} MB, ${pairs.length} pairs, ${(scanMs / 1000).toFixed(1)} s\n`);

  // Warm the JIT before the measured extraction pass.
  for (const pair of pairs.slice(0, 30)) {
    extractReferenceTargets(pair.reply);
    matchReferenceTargets(pair.utterance.slice(0, Math.min(20, pair.utterance.length)), extractReferenceTargets(pair.reply));
  }

  const extractTimes: number[] = [];
  const targetKindTotals: Record<ReferenceTargetKind, number> = {
    path: 0, identifier: 0, 'code-line': 0, heading: 0, paragraph: 0,
  };
  const repliesWithKind: Record<string, number> = {};
  const targetCounts: number[] = [];
  for (const pair of pairs) {
    const started = performance.now();
    const targets = extractReferenceTargets(pair.reply);
    extractTimes.push(performance.now() - started);
    targetCounts.push(targets.length);
    const kinds = new Set<ReferenceTargetKind>();
    for (const target of targets) {
      targetKindTotals[target.kind] += 1;
      kinds.add(target.kind);
    }
    for (const kind of kinds) {
      repliesWithKind[kind] = (repliesWithKind[kind] ?? 0) + 1;
    }
  }

  // What disabling numbered items costs: the old preview's own coverage.
  let numberedPreviewTurns = 0;
  let repliesWithNumberedItems = 0;
  let bothSurfaces = 0;
  let numberedOnly = 0;
  let referenceTargetsOnly = 0;
  for (const pair of pairs) {
    const items = extractReplyItems(pair.reply);
    if (items.length > 0) {
      repliesWithNumberedItems += 1;
    }
    const numberedShown = items.length > 0 && resolveReplyReference(pair.utterance, items).kind !== 'none';
    if (numberedShown) {
      numberedPreviewTurns += 1;
    }
    const copied = copiedTargets(
      extractReferenceTargets(pair.reply),
      normalizeReferenceTarget(pair.utterance),
      ['path', 'identifier'],
      6,
    );
    const targetsShown = copied.length > 0;
    if (numberedShown && targetsShown) {
      bothSurfaces += 1;
    } else if (numberedShown) {
      numberedOnly += 1;
    } else if (targetsShown) {
      referenceTargetsOnly += 1;
    }
  }

  const scenarios: ScenarioOptions[] = [
    {
      label: 'v1-default (code-shape gate, path+identifier+code+heading, min3, basename)',
      extract: {},
      match: {},
    },
    {
      label: 'allow-plain-words (gate off)',
      extract: {},
      match: { requireCodeShape: false },
    },
    { label: 'min2', extract: {}, match: { minQueryChars: 2 } },
    { label: 'min4', extract: {}, match: { minQueryChars: 4 } },
    { label: 'min5', extract: {}, match: { minQueryChars: 5 } },
    { label: 'kinds:path+identifier', extract: { includeCodeLines: false, includeHeadings: false }, match: {} },
    { label: 'kinds:+paragraph', extract: { includeParagraphs: true }, match: {} },
    { label: 'no-basename-keys', extract: { basenameKeys: false }, match: {} },
    { label: 'cjk-suffix-4', extract: {}, match: { cjkSuffixMax: 4 } },
    { label: 'max-candidates-5', extract: {}, match: { maxCandidates: 5 } },
  ];

  const results: ScenarioResult[] = [];
  const allExamples: Record<string, unknown[]> = {};
  let measuredMatchTimes: number[] = [];
  for (const scenario of scenarios) {
    const { result, matchTimes, examples } = runScenario(
      scenario.label,
      scenario.extract,
      scenario.match,
      pairs,
      scenario.label.startsWith('v1-default'),
    );
    results.push(result);
    allExamples[scenario.label] = examples;
    if (scenario.label.startsWith('v1-default')) {
      measuredMatchTimes = matchTimes;
    }
    process.stderr.write(`scenario done: ${scenario.label}\n`);
  }

  const report = {
    schema: 'caret-item-matching/replay/1',
    ranAt: new Date().toISOString(),
    corpus: {
      root: corpus.root,
      days: corpus.days,
      files,
      megabytes: Number((bytes / 1048576).toFixed(1)),
      pairs: pairs.length,
      scanSeconds: Number((scanMs / 1000).toFixed(1)),
      filter: 'one-line human user turns (1–200 chars) paired with the last assistant text record; isMeta/isSidechain and injected notifications excluded',
    },
    extraction: {
      milliseconds: percentile(extractTimes),
      targetsPerReply: percentile(targetCounts),
      meanTargetsPerReply: targetCounts.reduce((sum, value) => sum + value, 0) / Math.max(1, targetCounts.length),
      totalsByKind: targetKindTotals,
      repliesWithKind,
    },
    matchingLatencyMicroseconds: percentile(measuredMatchTimes),
    numberedItemsDisabled: {
      repliesWithItems: repliesWithNumberedItems,
      turnsTheOldPreviewWouldShow: numberedPreviewTurns,
      shareOfPairs: Number((numberedPreviewTurns / Math.max(1, pairs.length)).toFixed(4)),
      overlap: {
        bothSurfaces,
        numberedOnly,
        referenceTargetsOnly,
      },
    },
    scenarios: results,
    examples: allExamples,
  };

  const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'RESULT.json');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${outPath}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
