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

import type { ArchitectureRendererNode } from '@/modules/architecture/rendererContract';

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

/** A count that cannot go below zero or leak a fraction into the reading. */
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
  // The detail tier ranks the returned subgraph, so it can never retain more
  // than arrived; a caller that passes a pre-server count is clamped here.
  const detailRetained = Math.min(normaliseCount(inputs.detailRetained), returned);
  const shown = entityCountOf(inputs.drawnBoxes);
  // M is the pre-budget total when the payload carries one; an older payload
  // (or an impossible smaller total) falls back to what actually arrived.
  const related = Math.max(returned, normaliseCount(inputs.relatedTotal ?? returned));

  const detailCut = detailRetained < returned;
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
