/**
 * Analysis for the 60-pair human annotation.
 *
 * READS. `annotation/sample.json` (the stratified sample + automatic labels) and
 * `annotation/annotations.json` (exported from `annotation/index.html`). If the
 * annotations are missing it prints how to produce them and exits 0.
 *
 * WHAT IT ANSWERS. The automatic replay can only see verbatim copies. The
 * annotation supplies the missing reading: what the person meant, including
 * semantic references and true negatives. Per item it resolves the annotated
 * quotation to an extracted target (all kinds, paragraphs included), then asks
 * whether the shipping matcher (paragraphs off) and a paragraph-enabled variant
 * ever offered that target while the utterance was typed.
 *
 * Outputs `annotation/ANNOTATION-RESULT.json` and prints a summary.
 *
 * Run: npx tsx --tsconfig=tsconfig.json experiments/caret-item-matching/analyze.mts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  extractReferenceTargets,
  matchReferenceTargets,
  normalizeReferenceTarget,
} from '@/modules/chat/utils/transcript/referenceTargets';
import type { ReferenceTarget } from '@/modules/chat/utils/transcript/referenceTargets';

import { percentile } from './stats.mts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SAMPLE_PATH = path.join(HERE, 'annotation', 'sample.json');
const ANNOTATIONS_PATH = process.env.ANNOTATIONS ?? path.join(HERE, 'annotation', 'annotations.json');
const OUT_PATH = path.join(HERE, 'annotation', 'ANNOTATION-RESULT.json');

type SampleItem = {
  id: string;
  stratum: 'strong' | 'numbered' | 'semantic' | 'control';
  utterance: string;
  reply: string;
  title: string;
  auto: { copied: string[]; numberedKind: string };
};

type Annotation = {
  id: string;
  reference: '' | 'specific' | 'whole' | 'none' | 'unclear';
  quote: string;
  help: '' | 'yes' | 'no' | 'unsure';
  comment: string;
};

type AnnotationFile = {
  schema: string;
  exportedAt: string;
  annotator: string;
  items: Annotation[];
};

type ResolvedTarget = {
  text: string;
  kind: ReferenceTarget['kind'];
  overlap: number;
};

/**
 * Two readings of the same quotation:
 * - `span` is what the annotator pointed at (a paragraph or heading, usually);
 * - `completion` is the strongest code-shaped token inside that span, if any —
 *   the thing a prefix-completion matcher could actually insert. Null means the
 *   reference is purely prose and completion is the wrong interaction.
 */
type Resolved = {
  span: ResolvedTarget;
  completion: ResolvedTarget | null;
} | null;

type MatcherReading = {
  offeredAny: boolean;
  firstOfferChars: number | null;
  targetFirstHit: number | null;
  targetRank: number | null;
  offeredAtSettle: boolean;
  offersAtFirstHit: string[];
};

function isTokenChar(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_./@-]/.test(character);
}

function isCjkChar(character: string | undefined): boolean {
  return character !== undefined && /[一-鿿]/.test(character);
}

function isSettlePosition(utterance: string, index: number): boolean {
  if (index >= utterance.length) {
    return true;
  }
  const next = utterance[index];
  return !isTokenChar(next) && !isCjkChar(next);
}

const KIND_RANK: Record<ReferenceTarget['kind'], number> = {
  path: 5,
  identifier: 4,
  'code-line': 3,
  heading: 2,
  paragraph: 1,
};

/** The annotated quotation, read as a span and as a completion target inside it. */
function resolveQuote(quote: string, targets: readonly ReferenceTarget[]): Resolved {
  const normalizedQuote = normalizeReferenceTarget(quote);
  if (normalizedQuote.length < 2) {
    return null;
  }
  const candidates: { target: ReferenceTarget; overlap: number }[] = [];
  for (const target of targets) {
    const normalizedTarget = normalizeReferenceTarget(target.text);
    if (normalizedTarget.length < 2) {
      continue;
    }
    if (normalizedQuote.includes(normalizedTarget)) {
      candidates.push({ target, overlap: normalizedTarget.length });
    } else if (normalizedTarget.includes(normalizedQuote)) {
      candidates.push({ target, overlap: normalizedQuote.length });
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort(
    (left, right) =>
      right.overlap - left.overlap
      || KIND_RANK[right.target.kind] - KIND_RANK[left.target.kind]
      || left.target.text.length - right.target.text.length,
  );
  const span = candidates[0];
  const completionCandidates = candidates
    .filter((candidate) => candidate.target.kind === 'path'
      || candidate.target.kind === 'identifier'
      || candidate.target.kind === 'code-line')
    .sort(
      (left, right) =>
        right.overlap - left.overlap
        || KIND_RANK[right.target.kind] - KIND_RANK[left.target.kind]
        || left.target.text.length - right.target.text.length,
    );
  const completion = completionCandidates[0] ?? null;
  return {
    span: { text: span.target.text, kind: span.target.kind, overlap: span.overlap },
    completion: completion
      ? { text: completion.target.text, kind: completion.target.kind, overlap: completion.overlap }
      : null,
  };
}

function readMatcher(
  utterance: string,
  targets: readonly ReferenceTarget[],
  targetText: string | null,
): MatcherReading {
  const resolvedNormalized = targetText ? normalizeReferenceTarget(targetText) : null;
  let offeredAny = false;
  let firstOfferChars: number | null = null;
  let targetFirstHit: number | null = null;
  let targetRank: number | null = null;
  let offeredAtSettle = false;
  let offersAtFirstHit: string[] = [];

  for (let index = 1; index <= utterance.length; index += 1) {
    const matches = matchReferenceTargets(utterance.slice(0, index), targets);
    if (matches.length > 0) {
      offeredAny = true;
      if (firstOfferChars === null) {
        firstOfferChars = index;
      }
      if (isSettlePosition(utterance, index)) {
        offeredAtSettle = true;
      }
      if (resolvedNormalized !== null && targetFirstHit === null) {
        const rankIndex = matches.findIndex(
          (match) => normalizeReferenceTarget(match.target.text) === resolvedNormalized,
        );
        if (rankIndex >= 0) {
          targetFirstHit = index;
          targetRank = rankIndex + 1;
          offersAtFirstHit = matches.map((match) => match.target.text);
        }
      }
    }
  }

  return {
    offeredAny,
    firstOfferChars,
    targetFirstHit,
    targetRank,
    offeredAtSettle,
    offersAtFirstHit,
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(3));
}

function main(): void {
  const sample = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')) as {
    items: SampleItem[];
    seed: number;
    corpus: unknown;
  };
  if (!existsSync(ANNOTATIONS_PATH)) {
    process.stdout.write(
      `No annotations at ${ANNOTATIONS_PATH}\n\n`
      + 'Open experiments/caret-item-matching/annotation/index.html in a browser, '
      + 'fill the 60 cards, export the JSON, and save it to that path (or set ANNOTATIONS=…).\n',
    );
    return;
  }
  const annotations = JSON.parse(readFileSync(ANNOTATIONS_PATH, 'utf8')) as AnnotationFile;
  const byId = new Map(annotations.items.map((item) => [item.id, item]));

  const records = sample.items.map((item) => {
    const annotation = byId.get(item.id);
    const allTargets = extractReferenceTargets(item.reply, { includeParagraphs: true });
    // Paragraphs are off in shipping; keep a second target set for the ablation.
    const shippingTargets = extractReferenceTargets(item.reply);
    const resolved = annotation?.quote ? resolveQuote(annotation.quote, allTargets) : null;
    // Shipping offers code-shaped tokens; the paragraph arm is asked about the
    // span the annotator actually pointed at.
    const shipping = readMatcher(item.utterance, shippingTargets, resolved?.completion?.text ?? null);
    const withParagraphs = readMatcher(item.utterance, allTargets, resolved?.span.text ?? null);
    return {
      id: item.id,
      stratum: item.stratum,
      reference: annotation?.reference ?? '',
      help: annotation?.help ?? '',
      quote: annotation?.quote ?? '',
      resolved,
      auto: item.auto,
      shipping,
      withParagraphs,
    };
  });

  const complete = records.filter((record) => record.reference !== '');
  const specific = complete.filter((record) => record.reference === 'specific');
  const whole = complete.filter((record) => record.reference === 'whole');
  const none = complete.filter((record) => record.reference === 'none');
  const unclear = complete.filter((record) => record.reference === 'unclear');

  const specificResolved = specific.filter((record) => record.resolved !== null);
  const specificUnresolved = specific.filter((record) => record.resolved === null);
  const specificWithCompletion = specificResolved.filter((record) => record.resolved?.completion != null);
  const shippingHit = specificWithCompletion.filter((record) => record.shipping.targetFirstHit !== null).length;
  const shippingTop1 = specificWithCompletion.filter((record) => record.shipping.targetRank === 1).length;
  const shippingTop3 = specificWithCompletion.filter(
    (record) => record.shipping.targetRank !== null && record.shipping.targetRank <= 3,
  ).length;
  // The token exists in the quoted span but the utterance never types it: the
  // person is referring to it, not retyping it. Completion cannot serve these.
  const completionTargetsNeverTyped = specificWithCompletion.filter(
    (record) => record.shipping.targetFirstHit === null,
  ).length;
  const paragraphHit = specificResolved.filter((record) => record.withParagraphs.targetFirstHit !== null).length;
  const paragraphTop1 = specificResolved.filter((record) => record.withParagraphs.targetRank === 1).length;
  const spanKinds = Object.fromEntries(
    (['path', 'identifier', 'code-line', 'heading', 'paragraph'] as const).map((kind) => [
      kind,
      specificResolved.filter((record) => record.resolved?.span.kind === kind).length,
    ]),
  );

  const falseOffers = none.filter((record) => record.shipping.offeredAtSettle).length;
  const wouldUse = (records: typeof complete, value: 'yes' | 'no' | 'unsure'): number =>
    records.filter((record) => record.help === value).length;

  /** The cleanest reading in the sample: would-use separates specific from none. */
  const labelHelp = Object.fromEntries(
    (['specific', 'whole', 'none', 'unclear'] as const).map((label) => {
      const rows = complete.filter((record) => record.reference === label);
      return [label, {
        annotated: rows.length,
        yes: wouldUse(rows, 'yes'),
        no: wouldUse(rows, 'no'),
        unsure: wouldUse(rows, 'unsure'),
      }];
    }),
  );

  const byStratum = Object.fromEntries(
    (['strong', 'numbered', 'semantic', 'control'] as const).map((stratum) => {
      const rows = complete.filter((record) => record.stratum === stratum);
      return [stratum, {
        annotated: rows.length,
        specific: rows.filter((record) => record.reference === 'specific').length,
        whole: rows.filter((record) => record.reference === 'whole').length,
        none: rows.filter((record) => record.reference === 'none').length,
        unclear: rows.filter((record) => record.reference === 'unclear').length,
        wouldUseYes: wouldUse(rows, 'yes'),
        wouldUseNo: wouldUse(rows, 'no'),
        wouldUseUnsure: wouldUse(rows, 'unsure'),
      }];
    }),
  );

  const agreement = {
    humanSpecificAndAutoCopied: specific.filter((record) => record.auto.copied.length > 0).length,
    humanSpecificWithoutAutoCopied: specific.filter((record) => record.auto.copied.length === 0).length,
    humanSpecificUnresolvedQuote: specificUnresolved.length,
    humanNoneButAutoCopied: none.filter((record) => record.auto.copied.length > 0).length,
    humanWholeAndAutoNumbered: whole.filter((record) => record.auto.numberedKind !== 'none').length,
    humanNoneAndAutoNumbered: none.filter((record) => record.auto.numberedKind !== 'none').length,
  };

  const result = {
    schema: 'caret-item-matching/annotation-result/1',
    analyzedAt: new Date().toISOString(),
    annotationsPath: ANNOTATIONS_PATH,
    sampleSeed: sample.seed,
    completeness: {
      sample: sample.items.length,
      annotated: complete.length,
      missing: sample.items.length - complete.length,
      missingIds: records.filter((record) => record.reference === '').map((record) => record.id),
    },
    labels: {
      specific: specific.length,
      whole: whole.length,
      none: none.length,
      unclear: unclear.length,
    },
    specific: {
      resolved: specificResolved.length,
      unresolvedQuote: specificUnresolved.length,
      spanKinds,
      /** Spans that contain a path/identifier/code-line the completion arm could insert. */
      withCompletionTarget: specificWithCompletion.length,
      /** Spans that are pure prose: completion is the wrong interaction for them. */
      withoutCompletionTarget: specificResolved.length - specificWithCompletion.length,
      shippingOffered: shippingHit,
      shippingOfferedRate: rate(shippingHit, specificWithCompletion.length),
      shippingTop1,
      shippingTop1Rate: rate(shippingTop1, specificWithCompletion.length),
      shippingTop3,
      shippingTop3Rate: rate(shippingTop3, specificWithCompletion.length),
      completionTargetsNeverTyped,
      rankDistribution: Object.fromEntries(
        [1, 2, 3].map((rank) => [String(rank), specificWithCompletion.filter((record) => record.shipping.targetRank === rank).length]),
      ),
      paragraphTierOffered: paragraphHit,
      paragraphTierOfferedRate: rate(paragraphHit, specificResolved.length),
      paragraphTierTop1: paragraphTop1,
      paragraphTierTop1Rate: rate(paragraphTop1, specificResolved.length),
      firstOfferChars: percentile(
        specific.map((record) => record.shipping.firstOfferChars).filter((value): value is number => value !== null),
      ),
    },
    none: {
      annotated: none.length,
      falseOffersAtSettle: falseOffers,
      falseOfferRate: rate(falseOffers, none.length),
      wouldUseYes: wouldUse(none, 'yes'),
    },
    whole: {
      annotated: whole.length,
      matcherOfferedSomething: whole.filter((record) => record.shipping.offeredAny).length,
      wouldUseYes: wouldUse(whole, 'yes'),
    },
    wouldUse: {
      specific: {
        yes: wouldUse(specific, 'yes'),
        no: wouldUse(specific, 'no'),
        unsure: wouldUse(specific, 'unsure'),
      },
      semanticStratum: wouldUse(complete.filter((record) => record.stratum === 'semantic'), 'yes'),
      controlStratum: wouldUse(complete.filter((record) => record.stratum === 'control'), 'yes'),
    },
    labelHelp,
    byStratum,
    agreement,
    records,
  };

  writeFileSync(OUT_PATH, `${JSON.stringify(result, null, 2)}\n`);

  process.stdout.write([
    `annotated ${complete.length}/${sample.items.length}`,
    `labels: specific=${specific.length} whole=${whole.length} none=${none.length} unclear=${unclear.length}`,
    `specific resolved=${specificResolved.length} unresolvedQuote=${specificUnresolved.length} `
      + `spanKinds=${JSON.stringify(spanKinds)}`,
    `completion targets inside the span: ${specificWithCompletion.length} `
      + `(never typed: ${completionTargetsNeverTyped})`,
    `shipping matcher on those: offered=${shippingHit} (${rate(shippingHit, specificWithCompletion.length)}) `
      + `top1=${shippingTop1} (${rate(shippingTop1, specificWithCompletion.length)}) `
      + `top3=${shippingTop3} (${rate(shippingTop3, specificWithCompletion.length)})`,
    `paragraph tier on the span: offered=${paragraphHit} (${rate(paragraphHit, specificResolved.length)}) `
      + `top1=${paragraphTop1} (${rate(paragraphTop1, specificResolved.length)})`,
    `would-use by label: ${JSON.stringify(labelHelp)}`,
    `none: falseOffersAtSettle=${falseOffers}/${none.length} (${rate(falseOffers, none.length)})`,
    `wouldUse yes: specific=${wouldUse(specific, 'yes')} semantic=${result.wouldUse.semanticStratum} control=${result.wouldUse.controlStratum}`,
    `wrote ${OUT_PATH}`,
    '',
  ].join('\n'));
}

main();
