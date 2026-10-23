/**
 * Content planning for the architecture canvas's semantic zoom.
 *
 * The semantic zoom keeps visible text at a FIXED screen font size and makes
 * room for it by stretching the layout (see `semanticZoomLayout.ts`). That
 * means every text that is still drawn needs a plan made at the minimum font
 * size, before the geometry solver runs: how the class name wraps, how tall the
 * title compartment therefore is, which compartment rules survive, what the
 * package tab says once the path is shortened and how many entities it hides.
 *
 * This file is deliberately pure: no DOM, no React, no layout engine. Widths are
 * computed with the same deterministic advance table the engine's constraint
 * solver uses, so unit tests can state an expectation without a browser.
 *
 * Consumers: `semanticZoomLayout.ts` (min sizes and the tier budget) and
 * `PlantUmlGraph.tsx` (what to draw for each mapped box). `tests/semanticZoomPlan.test.ts`
 * pins the three-level name fallback, the compartment rules and the label/tab plan.
 */

/** The minimum on-screen font size on a fine pointer (the design's PC floor). */
export const SEMANTIC_MIN_FONT_PX = 10;
/** The minimum on-screen font size on a coarse pointer (the design's phone floor). */
export const SEMANTIC_MIN_FONT_MOBILE_PX = 11;

/** The widest a class box may grow to fit its name; past this the name falls back. */
export const CLASS_NAME_MAX_WIDTH_PX = 130;
/** Horizontal breathing room inside a class box (5px a side). */
export const CLASS_NAME_INSET_PX = 10;
/** A class box never draws its frame under this on-screen width. */
export const CLASS_HIDDEN_WIDTH_PX = 10;
/** A class box never draws its frame under this on-screen height. */
export const CLASS_HIDDEN_HEIGHT_PX = 6;

/** A name that must be elided keeps at least this many characters. */
export const NAME_ELLIPSIS_MIN_CHARS = 9;
/** A session-mentioned ("highlighted") name keeps fewer, because it is the anchor. */
export const NAME_ELLIPSIS_MIN_CHARS_SEED = 6;

/** Height of a package tab's label band: the floor font plus 6px of air. */
export const PACKAGE_TAB_PADDING_PX = 6;
/** Inset of a package tab from its frame's left edge. */
export const PACKAGE_TAB_INSET_PX = 5;
/** Clearance the solver keeps right of a tab so its right closure is visible. */
export const PACKAGE_TAB_CLEARANCE_PX = 8;

/** The stretch budget: past this the tier steps down instead of stretching further. */
export const SEMANTIC_STRETCH_LIMIT = 1.8;
/**
 * The tier dead band, as a fraction of the stretch budget. A tier already on
 * screen is kept until the budget is exceeded by this much, so a scale resting
 * on a tier boundary does not flap between two drawings.
 */
export const SEMANTIC_TIER_DEADZONE_RATIO = 0.08;

/** The four edge-opacity bands (rule 5); the count is the VISIBLE edges. */
export const EDGE_OPACITY_QUIET = 0.85;
export const EDGE_OPACITY_BUSY = 0.5;
export const EDGE_OPACITY_DENSE = 0.3;
export const EDGE_OPACITY_VERY_DENSE = 0.18;

/** A glyph advance as a fraction of the em, by font family. */
const MONO_ADVANCE = 0.6;
const SANS_ADVANCE = 0.55;
/** Bold glyphs are a touch wider; kept small so the floor font still fits. */
const BOLD_FACTOR = 1.06;

/** Which face a planned text is measured in. */
export type PlanTextFace = 'mono' | 'mono-bold' | 'sans';

/** The three ways a class name can be drawn, in fallback order. */
export type PlanNameForm = 'single' | 'wrapped' | 'ellipsis';

/** One planned class name. */
export type PlannedName = {
  /** The lines to draw, top to bottom (one or two). */
  readonly lines: readonly string[];
  /** Which fallback produced the lines. */
  readonly form: PlanNameForm;
  /** The box width the name needs, including the inset, capped at the maximum. */
  readonly minWidth: number;
  /** The title compartment's height for this name (two lines grow it). */
  readonly titleHeight: number;
};

/** One class box's full content plan. */
export type PlannedEntityContent = {
  readonly name: PlannedName;
  readonly kind: 'class' | 'interface' | 'enum' | 'function';
  /** The `<<kind>>` line drawn above the name, or null for a plain class. */
  readonly stereotype: string | null;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly titleHeight: number;
  readonly hasAttributes: boolean;
  readonly hasOperations: boolean;
  /** How many horizontal compartment rules the frame always draws. */
  readonly ruleCount: 1 | 2;
};

/** How wide a string draws at `fontPx` in `face`, in the engine's own units. */
export function planTextWidth(text: string, fontPx: number, face: PlanTextFace): number {
  const advance = face === 'sans' ? SANS_ADVANCE : MONO_ADVANCE;
  const bold = face === 'mono-bold' ? BOLD_FACTOR : 1;
  let units = 0;
  for (const char of text) {
    // A CJK glyph is a full em; the path-like names this diagram draws are
    // ASCII, but package labels can be localized, so count the wide ranges.
    units += (char.codePointAt(0) ?? 0) > 0x2e7f ? 1 : advance;
  }
  return units * fontPx * bold;
}

/** One line of a wrapped name and the width it needs. */
function wrapCandidates(label: string): readonly { readonly a: string; readonly b: string }[] {
  const tokens = label.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])|./g) ?? [label];
  const candidates: { a: string; b: string }[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    candidates.push({ a: tokens.slice(0, index).join(''), b: tokens.slice(index).join('') });
  }
  return candidates;
}

/**
 * The middle ellipsis: keep the head and the tail and drop the middle, down to
 * `minChars` visible characters. The tail is what a reader uses to tell
 * `...Graph.tsx` from `...Graph2.tsx`, so the split favours the end.
 */
export function middleEllipsis(text: string, maxWidth: number, fontPx: number, minChars: number): string {
  if (planTextWidth(text, fontPx, 'mono-bold') <= maxWidth) return text;
  for (let keep = text.length - 1; keep >= minChars; keep -= 1) {
    const head = Math.ceil((keep + 1) / 2);
    const tail = keep - head;
    const candidate = `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
    if (planTextWidth(candidate, fontPx, 'mono-bold') <= maxWidth) return candidate;
  }
  return `${text.slice(0, Math.max(1, minChars))}…`;
}

/**
 * Plan a class name at the floor font: one line when it fits the cap, two lines
 * split at a camel-case boundary when that fits, otherwise a middle ellipsis
 * that keeps `minChars` characters (fewer for the session-mentioned nodes, which
 * are the anchor the reader is following).
 */
export function planEntityName(label: string, fontPx: number, seed: boolean): PlannedName {
  const lineHeight = fontPx * 1.25;
  const inset = CLASS_NAME_INSET_PX;
  const single = planTextWidth(label, fontPx, 'mono-bold') + inset;
  if (single <= CLASS_NAME_MAX_WIDTH_PX) {
    return { lines: [label], form: 'single', minWidth: single, titleHeight: fontPx + 5 };
  }

  let best: { a: string; b: string; width: number } | null = null;
  for (const candidate of wrapCandidates(label)) {
    const width = Math.max(
      planTextWidth(candidate.a, fontPx, 'mono-bold'),
      planTextWidth(candidate.b, fontPx, 'mono-bold'),
    );
    if (best === null || width < best.width) best = { ...candidate, width };
  }
  if (best !== null && best.width + inset <= CLASS_NAME_MAX_WIDTH_PX) {
    return {
      lines: [best.a, best.b],
      form: 'wrapped',
      minWidth: best.width + inset,
      // Two lines need a taller title compartment; this is what pushes the
      // frame's first rule down (and the solver's y constraints up).
      titleHeight: 2 * lineHeight + 3,
    };
  }

  const minChars = seed ? NAME_ELLIPSIS_MIN_CHARS_SEED : NAME_ELLIPSIS_MIN_CHARS;
  return {
    lines: [middleEllipsis(label, CLASS_NAME_MAX_WIDTH_PX - inset, fontPx, minChars)],
    form: 'ellipsis',
    minWidth: CLASS_NAME_MAX_WIDTH_PX,
    titleHeight: fontPx + 5,
  };
}

/** Normalise the renderer's stereotype token to the four kinds this module plans. */
export function planEntityKind(raw: string | null | undefined): PlannedEntityContent['kind'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'interface':
      return 'interface';
    case 'enum':
      return 'enum';
    case 'function':
      return 'function';
    default:
      return 'class';
  }
}

/**
 * Plan one class box: name fallback, the two rules that must survive at every
 * size, and the minimum box that can hold the title plus both compartments.
 *
 * Attributes and operations are approximated from the member text alone — a
 * member containing `(` is an operation. The approximation is confined to this
 * function so it can be replaced by the renderer's own compartment elements
 * when plantuml-js publishes them.
 */
export function planEntityContent(
  input: {
    readonly label: string;
    readonly kind?: string | null;
    readonly stereotype?: string | null;
    /** Whether the renderer published any `uml-attr` member. */
    readonly hasAttributes: boolean;
    /** Whether the renderer published any `uml-op` member. */
    readonly hasOperations: boolean;
    readonly seed: boolean;
  },
  fontPx: number,
): PlannedEntityContent {
  const kind = planEntityKind(input.kind);
  const name = planEntityName(input.label, fontPx, input.seed);
  // The compartments come from the renderer's `uml-attr` / `uml-op` classes
  // (read in `semanticZoomRead.ts`); no member text is inspected here.
  const { hasAttributes, hasOperations } = input;
  // A non-class kind names itself in a `<<kind>>` line above the title, the way
  // a UML box states its stereotype. It earns its own row of title space.
  const stereotype = input.stereotype
    ?? (kind === 'interface' || kind === 'function' ? kind : null);
  const stereotypeHeight = stereotype === null ? 0 : fontPx * 0.9;
  // An interface with only operations draws one rule (title | operations); an
  // interface with attributes and operations — and every class — draws two. A
  // function is a single-compartment box.
  const ruleCount: 1 | 2 = kind === 'class' || kind === 'enum'
    ? 2
    : kind === 'interface' && hasAttributes
      ? 2
      : 1;
  const titleHeight = name.titleHeight + stereotypeHeight;
  const minHeight = titleHeight + (kind === 'class' || kind === 'enum' ? 10 : 6) + 2;
  return {
    name,
    kind,
    stereotype,
    minWidth: Math.max(name.minWidth, CLASS_HIDDEN_WIDTH_PX),
    minHeight: Math.max(minHeight, CLASS_HIDDEN_HEIGHT_PX),
    titleHeight,
    hasAttributes,
    hasOperations,
    ruleCount,
  };
}

/**
 * The y offsets (from the frame's top) of the horizontal compartment rules that
 * are ALWAYS drawn. Two rules for a class: below the title, and between the
 * attribute and operation compartments (the halfway point when both have
 * members). An interface with only operations keeps the single title rule.
 */
export function planCompartmentRules(args: {
  readonly height: number;
  readonly titleHeight: number;
  readonly hasAttributes: boolean;
  readonly hasOperations: boolean;
  readonly kind: PlannedEntityContent['kind'];
}): readonly number[] {
  const { height, titleHeight, hasAttributes, hasOperations, kind } = args;
  if (height < 12) return [];
  const rules: number[] = [titleHeight];
  if (kind === 'function') return rules;
  if (kind === 'interface' && !hasAttributes) return rules;
  const body = height - titleHeight;
  const split = hasAttributes && hasOperations
    ? body * 0.5
    : hasOperations
      ? Math.min(6, body * 0.4)
      : body - Math.min(6, body * 0.4);
  const y = titleHeight + split;
  if (y < height - 2) rules.push(y);
  return rules;
}

/** A package label split into its last path segment and its original count. */
export type PlannedPackageLabel = {
  readonly text: string;
  readonly count: number | null;
};

/** The trailing `(N)` the renderer may already carry, split off before shortening. */
export function planPackageLabel(raw: string): PlannedPackageLabel {
  const match = /^(.*?)(?:\s*\((\d+)\))?$/.exec(raw.trim());
  const path = (match?.[1] ?? raw).trim();
  const countText = match?.[2];
  const segments = path.split(/[\\/]/).filter(Boolean);
  return {
    text: segments.length > 0 ? segments[segments.length - 1] : path,
    count: countText === undefined ? null : Number(countText),
  };
}

/** One package's tab plan: the shortened name, its aggregate count, and the C-tier badge. */
export type PlannedPackageTab = {
  readonly text: string;
  readonly count: number | null;
  /** The orange `★N` badge shown at tier C; empty when the package mentions nothing. */
  readonly badge: string;
  readonly width: number;
  readonly height: number;
};

/**
 * Plan a package tab. The label is the LAST path segment plus `(N)` — the
 * information a collapsed package would otherwise hide — and at tier C it also
 * carries an orange `★N` counting the entities inside the package that the
 * session mentioned directly (rule 6: hidden information is aggregated upward,
 * never dropped silently).
 */
export function planPackageTab(args: {
  readonly raw: string;
  readonly entityCount: number;
  readonly mentionedCount: number;
  readonly tier: 'A' | 'B' | 'C';
  readonly fontPx: number;
}): PlannedPackageTab {
  const parsed = planPackageLabel(args.raw);
  const count = parsed.count ?? args.entityCount;
  const text = count > 0 ? `${parsed.text} (${count})` : parsed.text;
  const badge = args.tier === 'C' && args.mentionedCount > 0 ? ` ★${args.mentionedCount}` : '';
  const width = planTextWidth(`${text}${badge}`, args.fontPx, 'sans') + 10;
  return { text, count, badge, width, height: args.fontPx + PACKAGE_TAB_PADDING_PX };
}

/**
 * The edge opacity for a drawing with `visibleEdges` edges on screen (rule 5).
 * Boundaries are exclusive: exactly 22 edges still reads at the quiet 0.85.
 */
export function planEdgeOpacity(visibleEdges: number): number {
  if (visibleEdges > 100) return EDGE_OPACITY_VERY_DENSE;
  if (visibleEdges > 40) return EDGE_OPACITY_DENSE;
  if (visibleEdges > 22) return EDGE_OPACITY_BUSY;
  return EDGE_OPACITY_QUIET;
}

/** The member rows a compact class frame can show, plus its "… +N more" line. */
export type PlannedMemberRows = {
  readonly rows: readonly string[];
  readonly moreLabel: string | null;
};

/** Clip one member line with an ellipsis so it never leaves the frame. */
function clipMemberRow(text: string, maxWidth: number, fontPx: number): string {
  if (planTextWidth(text, fontPx, 'mono') <= maxWidth) return text;
  let keep = text.length;
  while (keep > 8 && planTextWidth(`${text.slice(0, keep)}…`, fontPx, 'mono') > maxWidth) keep -= 1;
  return keep < text.length ? `${text.slice(0, keep)}…` : text;
}

/**
 * Lay out the member lines inside a compact class frame. The room is
 * `floor((height - titleHeight - 10) / lineHeight)` lines; the caller only asks
 * when at least two rows fit, which is the tier-A member threshold.
 */
export function planMemberRows(args: {
  readonly members: readonly string[];
  readonly height: number;
  readonly titleHeight: number;
  readonly fontPx: number;
  readonly maxWidth: number;
  readonly moreLine: string | null;
}): PlannedMemberRows {
  const lineHeight = args.fontPx * 1.25;
  const room = Math.floor((args.height - args.titleHeight - 10) / lineHeight);
  if (room <= 0) return { rows: [], moreLabel: null };
  const total = args.members.length;
  const hasMore = total > room;
  // "… +N more" occupies one of the rows when it is needed.
  const fit = hasMore ? Math.max(0, room - 1) : Math.min(total, room);
  const rows = args.members.slice(0, fit).map((member) => clipMemberRow(member, args.maxWidth, args.fontPx));
  const moreLabel = hasMore ? `… +${total - rows.length} more` : args.moreLine;
  return { rows, moreLabel };
}

/** One frame whose top edge has scrolled above the visible box. */
export type StickyLabelCandidate = {
  readonly id: string;
  readonly depth: number;
  readonly top: number;
  readonly bottom: number;
};

/** At most two sticky package names may be pinned, per the design's limit. */
export const STICKY_LABEL_LIMIT = 2;

/**
 * Choose the package names that stick to the top of the viewport because their
 * frame's top edge has scrolled out of it. Ordered outermost-first and capped at
 * {@link STICKY_LABEL_LIMIT}, so a nested chain cannot paper over the drawing.
 */
export function planStickyLabels<T extends StickyLabelCandidate>(
  frames: readonly T[],
  viewportTop: number,
): readonly T[] {
  return frames
    .filter((frame) => frame.top < viewportTop && frame.bottom > viewportTop + 40)
    .sort((a, b) => a.depth - b.depth)
    .slice(-STICKY_LABEL_LIMIT);
}

/** A screen-space point, the unit both the layout and the edge follower work in. */
export type PlanPoint = { readonly x: number; readonly y: number };

/** A rect in the same screen space. */
export type PlanRect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/**
 * Follow a compacted class frame with an edge endpoint.
 *
 * When text is hidden the frame is drawn shorter than its layout cell. An
 * endpoint that attached to the cell's bottom edge (within `tolerance`) or to a
 * side below the drawn bottom is moved onto the drawn frame's own bottom or side
 * edge, so the line keeps touching the frame it points at instead of ending in
 * the blank space the compaction freed.
 */
export function followCompactedFrame(args: {
  readonly point: PlanPoint;
  readonly cell: PlanRect;
  readonly drawn: PlanRect;
  readonly tolerance?: number;
}): PlanPoint {
  const tolerance = args.tolerance ?? 2;
  const cellBottom = args.cell.y + args.cell.h;
  const drawnBottom = args.drawn.y + args.drawn.h;
  if (drawnBottom >= cellBottom - 0.5) return args.point;
  const withinX = args.point.x >= args.cell.x - tolerance
    && args.point.x <= args.cell.x + args.cell.w + tolerance;
  const nearBottom = args.point.y >= cellBottom - tolerance && args.point.y <= cellBottom + 22;
  if (withinX && nearBottom) {
    return { x: args.point.x, y: drawnBottom };
  }
  const nearSide = (
    Math.abs(args.point.x - args.cell.x) < tolerance + 0.5
    || Math.abs(args.point.x - (args.cell.x + args.cell.w)) < tolerance + 0.5
  ) && args.point.y > args.cell.y && args.point.y <= cellBottom;
  if (nearSide && args.point.y > drawnBottom - 3) {
    return { x: args.point.x, y: Math.max(drawnBottom - 4, args.drawn.y + args.drawn.h / 2) };
  }
  return args.point;
}
