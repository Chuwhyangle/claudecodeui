/**
 * The architecture readout's numbers, kept as one pure function so the panel
 * only renders what this module decides.
 *
 * Three independent budgets can keep an entity out of the drawing, and each
 * used to be reported with its own vocabulary (`Showing …`, `… within the
 * layout budget`, `… left out by the node budget`). The reader saw three
 * "shown" numbers and could not tell which one was the drawing. This module
 * gives every number exactly one meaning:
 *
 *  · N ("showing N") is the number of ENTITIES the renderer was handed after
 *    the detail tier AND the layout budget — a group box counts every member it
 *    stands for, so N is never a box count.
 *  · M ("M related") is every related entity in the current scope, taken from
 *    the server's pre-budget total when the payload carries one.
 *  · each budget layer gets at most one explanation line, and only the layers
 *    that actually cut something are named.
 */

import type { ArchitectureEntityKind, ArchitectureRendererNode } from '@/modules/architecture/rendererContract';

/** The three places in the pipeline where a budget can hold entities back. */
export type ArchitectureReadoutLayer = 'detail' | 'layout' | 'server';

/**
 * One box the layout budget handed to the renderer.
 *
 * A plain entity is `{}` (or omits `memberCount`); a group box counts every
 * member it stands for. N therefore stays an entity count even when the
 * drawing shows group boxes. Renderer nodes are accepted directly because they
 * are the common case: each one stands for exactly itself.
 */
export type ArchitectureReadoutBox = {
  readonly memberCount?: number;
};

/** A drawn box: a renderer node (one entity) or a group describing its members. */
export type ArchitectureReadoutDrawnBox = ArchitectureReadoutBox | ArchitectureRendererNode;

/** Everything the readout needs to state its two numbers and its layers. */
export type ArchitectureReadoutInputs = {
  /** Entities the detail tier retained after ranking the returned subgraph. */
  readonly detailRetained: number;
  /**
   * Entities the detail tier actually ranked — the in-scope count AFTER the
   * display filters (element kind, relation preset, hidden isolated nodes).
   *
   * The detail cut is measured against THIS number, not against what the
   * server returned: a node removed by a display filter never reached the
   * tier, so it must not be read as a detail-tier fold. Those removals already
   * have their own line in the readout ("3 isolated nodes"), and counting them
   * here as well made an untroubled graph read `Budget-limited`.
   *
   * Omit it when no display filter ran — the two counts then coincide.
   */
  readonly detailInScope?: number;
  /** Boxes the layout budget handed to the renderer (groups count members). */
  readonly drawnBoxes: readonly ArchitectureReadoutDrawnBox[];
  /** Entities the server returned for this subgraph (after its node budget). */
  readonly returnedCount: number;
  /**
   * Entities in the whole current scope before the server budget
   * (`stats.entityTotal`/`stats.fileTotal`). Absent on an older payload, in
   * which case M falls back to the returned count.
   */
  readonly relatedTotal?: number;
  /** Locale for thousands separators; defaults to English so tests are stable. */
  readonly locale?: string;
};

/** One explanation line: which layer, its count, and the formatted count. */
export type ArchitectureReadoutLine = {
  readonly layer: ArchitectureReadoutLayer;
  readonly count: number;
  readonly countText: string;
};

/** The render-ready reading: two numbers plus the budget layers that cut. */
export type ArchitectureReadout = {
  /** N — entities actually handed to the layout (group members included). */
  readonly shown: number;
  /** M — every related entity in the current scope. */
  readonly related: number;
  /** `shown` with the locale's thousands separators. */
  readonly shownText: string;
  /** `related` with the locale's thousands separators. */
  readonly relatedText: string;
  /** True when at least one budget layer is holding entities back. */
  readonly limited: boolean;
  /** The layers that cut, in pipeline order. */
  readonly limitedLayers: readonly ArchitectureReadoutLayer[];
  /** One line per layer the expanded explanation has to state. */
  readonly lines: readonly ArchitectureReadoutLine[];
};

/**
 * The four kind buckets the one-line reading names.
 *
 * `abstract`/`enum` fold into `class` because the drawing shows them as class
 * boxes with a UML keyword; `other` is a real entity whose ArchGuard kind this
 * client does not recognise. A node with NO kind (a legacy entity payload, an
 * overview group box) is not invented into a bucket — the reading names only
 * what it actually knows.
 */
export type ArchitectureReadoutKindBucket = 'function' | 'interface' | 'class' | 'other';

/** One kind bucket and how many DRAWN entities it stands for. */
export type ArchitectureReadoutKindCount = {
  readonly kind: ArchitectureReadoutKindBucket;
  readonly count: number;
};

/** The bucket order the summary line states, most specific first. */
const KIND_BUCKET_ORDER: readonly ArchitectureReadoutKindBucket[] = [
  'function',
  'interface',
  'class',
  'other',
];

/** The bucket one entity kind folds into. */
function kindBucketOf(kind: ArchitectureEntityKind): ArchitectureReadoutKindBucket {
  switch (kind) {
    case 'function':
      return 'function';
    case 'interface':
      return 'interface';
    case 'class':
    case 'abstract':
    case 'enum':
      return 'class';
    default:
      return 'other';
  }
}

/**
 * Count the entities the DRAWING shows, by kind.
 *
 * The one-line reading used to say "Showing 40 classes" while every box was an
 * orange-framed `<<function>>`: the noun was a view label, not a reading. This
 * function counts the boxes actually drawn (group boxes count the members they
 * stand for, exactly like N) so the sentence can name the real mix.
 */
export function drawnKindCounts(
  boxes: readonly ArchitectureReadoutDrawnBox[],
): readonly ArchitectureReadoutKindCount[] {
  const counts: Record<ArchitectureReadoutKindBucket, number> = {
    function: 0,
    interface: 0,
    class: 0,
    other: 0,
  };
  for (const box of boxes) {
    // Only a renderer node carries a kind; a group box stands for members whose
    // kinds this reading does not know, so it contributes no bucket.
    const kind = 'kind' in box ? box.kind : undefined;
    if (kind === undefined) continue;
    counts[kindBucketOf(kind)] += 1;
  }
  return KIND_BUCKET_ORDER
    .filter((kind) => counts[kind] > 0)
    .map((kind) => ({ kind, count: counts[kind] }));
}

/**
 * A count that cannot go below zero or leak a fraction into the reading.
 */
function normaliseCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** How many entities the drawn boxes stand for; a group counts its members. */
function entityCountOf(boxes: readonly ArchitectureReadoutDrawnBox[]): number {
  return boxes.reduce((total, box) => {
    const memberCount = 'memberCount' in box ? box.memberCount : undefined;
    return total + normaliseCount(memberCount ?? 1);
  }, 0);
}

/**
 * Build the one-line reading and its layered explanation.
 *
 * The detail tier cannot retain more than the server returned, so its reading
 * is clamped to that ceiling before any comparison.
 *
 * Explanation lines: a layer is named when it actually cut. The detail line is
 * additionally stated when BOTH the layout budget and the server budget cut,
 * because the reader then needs the retained count to reconcile N with M
 * (`M − omitted = retained`, and the layout drew `N` of those).
 */
export function buildReadout(inputs: ArchitectureReadoutInputs): ArchitectureReadout {
  const returned = normaliseCount(inputs.returnedCount);
  // The detail tier ranks the subgraph the filters left, so it can never
  // retain more than that (nor more than arrived); a caller that passes a
  // pre-filter or pre-server count is clamped here.
  const detailInScope = Math.min(
    normaliseCount(inputs.detailInScope ?? returned),
    returned,
  );
  const detailRetained = Math.min(normaliseCount(inputs.detailRetained), detailInScope);
  const shown = entityCountOf(inputs.drawnBoxes);
  // M is the pre-budget total when the payload carries one; an older payload
  // (or an impossible smaller total) falls back to what actually arrived.
  const related = Math.max(returned, normaliseCount(inputs.relatedTotal ?? returned));

  // Each layer is named only when IT cut: the detail tier against the set it
  // ranked, the layout budget against the set the tier retained, the server
  // against the whole scope.
  const detailCut = detailRetained < detailInScope;
  const layoutCut = shown < detailRetained;
  const serverCut = related > returned;

  const format = new Intl.NumberFormat(inputs.locale ?? 'en');
  const line = (layer: ArchitectureReadoutLayer, count: number): ArchitectureReadoutLine => ({
    layer,
    count,
    countText: format.format(count),
  });

  const limitedLayers: ArchitectureReadoutLayer[] = [];
  if (detailCut) limitedLayers.push('detail');
  if (layoutCut) limitedLayers.push('layout');
  if (serverCut) limitedLayers.push('server');

  const lines: ArchitectureReadoutLine[] = [];
  // The detail line is stated when the tier folded entities, or when the two
  // later budgets both cut and the full retained → drawn → omitted chain is the
  // only way to explain the gap between N and M.
  if (detailCut || (layoutCut && serverCut)) lines.push(line('detail', detailRetained));
  if (layoutCut) lines.push(line('layout', shown));
  if (serverCut) lines.push(line('server', related - returned));

  return {
    shown,
    related,
    shownText: format.format(shown),
    relatedText: format.format(related),
    limited: lines.length > 0,
    limitedLayers,
    lines,
  };
}
