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
  /** The entity's full label, kept so the DRAW pass can re-plan for its real width. */
  readonly label: string;
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
  /** The `<<kind>>` line drawn above the name, or null when it is hidden. */
  readonly stereotype: string | null;
  /**
   * The on-screen font size the stereotype is drawn at, or null when it is
   * hidden. When drawn it is ALWAYS the floor font (never a scaled-down 0.8×),
   * which is what the "visible text never drops below the floor" guard reads.
   */
  readonly stereotypeFontPx: number | null;
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
    return { label, lines: [label], form: 'single', minWidth: single, titleHeight: fontPx + 5 };
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
      label,
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
    label,
    lines: [middleEllipsis(label, CLASS_NAME_MAX_WIDTH_PX - inset, fontPx, minChars)],
    form: 'ellipsis',
    minWidth: CLASS_NAME_MAX_WIDTH_PX,
    titleHeight: fontPx + 5,
  };
}

/**
 * Re-plan a class name against the width the box ACTUALLY has, at draw time.
 *
 * `planEntityName` has to decide the fallback before the solver runs, so it can
 * only assume the 130px cap — which wraps a name that would fit on one line in
 * a wide mapped box (`VoiceFrameProcessor` at 615px still read `VoiceFrame /
 * Processor`). This function keeps the same fallback order but takes the real
 * width: single line if it fits, otherwise the best camel-case split, otherwise
 * a middle ellipsis. The returned `titleHeight` follows the chosen line count,
 * so a single line never reserves two lines of title space.
 */
export function planEntityNameForWidth(
  label: string,
  maxWidth: number,
  fontPx: number,
  seed: boolean,
): PlannedName {
  const lineHeight = fontPx * 1.25;
  const inset = CLASS_NAME_INSET_PX;
  const budget = Math.max(fontPx, maxWidth - inset);
  const single = planTextWidth(label, fontPx, 'mono-bold') + inset;
  if (single <= maxWidth) {
    return { label, lines: [label], form: 'single', minWidth: single, titleHeight: fontPx + 5 };
  }
  let best: { a: string; b: string; width: number } | null = null;
  for (const candidate of wrapCandidates(label)) {
    const width = Math.max(
      planTextWidth(candidate.a, fontPx, 'mono-bold'),
      planTextWidth(candidate.b, fontPx, 'mono-bold'),
    );
    if (best === null || width < best.width) best = { ...candidate, width };
  }
  if (best !== null && best.width + inset <= maxWidth) {
    return {
      label,
      lines: [best.a, best.b],
      form: 'wrapped',
      minWidth: best.width + inset,
      titleHeight: 2 * lineHeight + 3,
    };
  }
  const minChars = seed ? NAME_ELLIPSIS_MIN_CHARS_SEED : NAME_ELLIPSIS_MIN_CHARS;
  const line = middleEllipsis(label, budget, fontPx, minChars);
  return {
    label,
    lines: [line],
    form: 'ellipsis',
    minWidth: planTextWidth(line, fontPx, 'mono-bold') + inset,
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
  //
  // The stereotype is TEXT like every other label: it is drawn at the floor
  // font, never scaled down (a 0.8× stereotype is 8px on the PC tier — below
  // the 10px floor). So the title compartment grows by a full line for it.
  //
  // When the token itself cannot fit the box's width cap it is HIDDEN instead
  // (the design allows both; the hide path never fires for `interface` /
  // `function` / `enum`, whose tokens fit, so a real UML box keeps its token).
  const stereotype = input.stereotype
    ?? (kind === 'interface' || kind === 'function' || kind === 'enum' ? kind : null);
  const stereotypeLine = stereotype === null ? 0
    : planTextWidth(`<<${stereotype}>>`, fontPx, 'sans') + CLASS_NAME_INSET_PX;
  const drawnStereotype = stereotype !== null && stereotypeLine <= CLASS_NAME_MAX_WIDTH_PX
    ? stereotype
    : null;
  const stereotypeHeight = drawnStereotype === null ? 0 : fontPx * 1.25;
  const stereotypeWidth = drawnStereotype === null ? 0 : stereotypeLine;
  // An interface with only operations draws one rule (title | operations); an
  // interface with attributes and operations — and every class — draws two. A
  // function is a single-compartment box.
  const ruleCount: 1 | 2 = kind === 'class' || kind === 'enum'
    ? 2
    : kind === 'interface' && hasAttributes
      ? 2
      : 1;
  const titleHeight = name.titleHeight + stereotypeHeight;
  // The solver must make room for the WORST name form the draw-time width
  // decision can pick. A name that does not fit on one line at the fixed
  // planning cap may still draw on two lines in a wide mapped box, so its box
  // reserves two lines even when the planner itself chose the single-line
  // ellipsis. The drawn title uses the ACTUAL line count, so a box that has the
  // extra room does not have to spend it.
  const worstNameHeight = name.form === 'single' ? name.titleHeight : 2 * (fontPx * 1.25) + 3;
  const minTitleHeight = worstNameHeight + stereotypeHeight;
  const minHeight = minTitleHeight + (kind === 'class' || kind === 'enum' ? 10 : 6) + 2;
  return {
    name,
    kind,
    stereotype: drawnStereotype,
    stereotypeFontPx: drawnStereotype === null ? null : fontPx,
    minWidth: Math.max(name.minWidth, stereotypeWidth, CLASS_HIDDEN_WIDTH_PX),
    minHeight: Math.max(minHeight, CLASS_HIDDEN_HEIGHT_PX),
    titleHeight,
    hasAttributes,
    hasOperations,
    ruleCount,
  };
}

/** Padding the member-based compartment rule keeps from the last member line. */
export const MEMBER_COMPARTMENT_PADDING_PX = 2;

/**
 * The y (from the frame's top) of the attr/op rule when member text is drawn:
 * one line pitch per attribute row (plus an attrs-block overflow hint), then
 * the padding. The operations block starts one pitch below this.
 */
export function memberRuleOffset(
  rows: { readonly linesBeforeRule: number; readonly lineHeight: number },
  titleHeight: number,
): number {
  return titleHeight + rows.linesBeforeRule * rows.lineHeight + MEMBER_COMPARTMENT_PADDING_PX;
}

/**
 * The y offsets (from the frame's top) of the horizontal compartment rules that
 * are ALWAYS drawn. Two rules for a class: below the title, and between the
 * attribute and operation compartments. An interface with only operations keeps
 * the single title rule; a function keeps one rule too.
 *
 * When member TEXT is drawn, the second rule is positioned from the member
 * rows (`memberLines`), not from a fraction of the body: a 50 % rule cuts
 * through the rows whenever the title/body split is not symmetric. Without
 * member text the old compact proportions are kept exactly.
 */
export function planCompartmentRules(args: {
  readonly height: number;
  readonly titleHeight: number;
  readonly hasAttributes: boolean;
  readonly hasOperations: boolean;
  readonly kind: PlannedEntityContent['kind'];
  /** Present only when member text is visible: where the attr/op rule goes. */
  readonly memberLines?: { readonly linesBeforeRule: number; readonly lineHeight: number } | null;
}): readonly number[] {
  const { height, titleHeight, hasAttributes, hasOperations, kind, memberLines } = args;
  if (height < 12) return [];
  const rules: number[] = [titleHeight];
  if (kind === 'function') return rules;
  if (kind === 'interface' && !hasAttributes) return rules;
  let y: number;
  if (memberLines !== undefined && memberLines !== null) {
    // Attribute rows (and an attrs-block "… +N more") then padding, then the
    // operations block starts one line below. With no attributes the rule sits
    // just under the title rule so the empty attribute band stays visible.
    y = memberRuleOffset(memberLines, titleHeight);
  } else {
    const body = height - titleHeight;
    const split = hasAttributes && hasOperations
      ? body * 0.5
      : hasOperations
        ? Math.min(6, body * 0.4)
        : body - Math.min(6, body * 0.4);
    y = titleHeight + split;
  }
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
  /** Visible MEMBER rows, attributes first then operations (drawing order). */
  readonly rows: readonly string[];
  /** Each visible row's compartment, parallel to `rows`. */
  readonly compartments: readonly ('attr' | 'op')[];
  /** How many visible rows are attributes (the compartment rule goes after them). */
  readonly attrCount: number;
  readonly moreLabel: string | null;
  /** Which compartment the "… +N more" line belongs to (it follows that block). */
  readonly moreCompartment: 'attr' | 'op' | null;
  /**
   * Lines drawn above the attribute/operation rule: the attribute rows plus an
   * attrs-block overflow hint. The rule itself is placed from this, which is
   * what keeps it off the member text.
   */
  readonly linesBeforeRule: number;
  /** The row pitch these rows are drawn at (font × 1.25). */
  readonly lineHeight: number;
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
 *
 * Members are grouped by the READ layer's compartment (`attr` before `op`),
 * never by their drawing order: the compartment rule is drawn between the two
 * groups, so the grouping is part of the layout, not a rendering detail.
 *
 * `totalMembers` is the renderer's own count. When its compact detail dropped
 * rows, `members` is shorter than that total, and the "… +N more" line must
 * count the DROPPED rows too — so the single overflow hint is ours and its N is
 * the upstream total (never a second upstream row).
 */
export function planMemberRows(args: {
  readonly members: readonly string[];
  readonly height: number;
  readonly titleHeight: number;
  readonly fontPx: number;
  readonly maxWidth: number;
  readonly moreLine: string | null;
  readonly totalMembers?: number;
  /** The read layer's compartment per member; omitted means all attributes. */
  readonly compartments?: readonly ('attr' | 'op')[];
}): PlannedMemberRows {
  const lineHeight = args.fontPx * 1.25;
  const room = Math.floor((args.height - args.titleHeight - 10) / lineHeight);
  const empty: PlannedMemberRows = {
    rows: [],
    compartments: [],
    attrCount: 0,
    moreLabel: null,
    moreCompartment: null,
    linesBeforeRule: 0,
    lineHeight,
  };
  if (room <= 0) return empty;

  const compartmentOf = (index: number): 'attr' | 'op' => args.compartments?.[index] === 'op' ? 'op' : 'attr';
  const ordered = args.members.map((text, index) => ({ text, compartment: compartmentOf(index) }));
  const attributes = ordered.filter((member) => member.compartment === 'attr');
  const operations = ordered.filter((member) => member.compartment === 'op');
  const orderedMembers = [...attributes, ...operations];

  const total = Math.max(args.totalMembers ?? orderedMembers.length, orderedMembers.length);
  const withoutMore = Math.min(orderedMembers.length, room);
  const needsMore = total > withoutMore;
  const fit = needsMore ? Math.min(orderedMembers.length, Math.max(0, room - 1)) : withoutMore;
  const shown = orderedMembers.slice(0, fit).map((member) => ({
    text: clipMemberRow(member.text, args.maxWidth, args.fontPx),
    compartment: member.compartment,
  }));
  const attrCount = shown.filter((member) => member.compartment === 'attr').length;
  // The hint stands in for the rows the frame cannot show. If the cut fell
  // inside the attribute block it belongs THERE (before the rule); otherwise it
  // trails the operations block.
  const moreCompartment: 'attr' | 'op' | null = needsMore
    ? (attrCount < attributes.length ? 'attr' : 'op')
    : null;
  const moreLabel = needsMore ? `… +${total - shown.length} more` : args.moreLine;
  if (moreLabel !== null && moreCompartment === null) {
    // A caller-supplied trailing line (the server's own `… +N`) draws after the
    // last visible row; keep the invariant that it is counted in the block.
    return {
      rows: shown.map((member) => member.text),
      compartments: shown.map((member) => member.compartment),
      attrCount,
      moreLabel,
      moreCompartment: 'op',
      linesBeforeRule: attrCount,
      lineHeight,
    };
  }
  return {
    rows: shown.map((member) => member.text),
    compartments: shown.map((member) => member.compartment),
    attrCount,
    moreLabel,
    moreCompartment,
    linesBeforeRule: attrCount + (moreCompartment === 'attr' ? 1 : 0),
    lineHeight,
  };
}

/** One frame whose top edge has scrolled above the visible box. */
export type StickyLabelCandidate = {
  readonly id: string;
  readonly depth: number;
  readonly top: number;
  readonly bottom: number;
  /**
   * The package's own tab rectangle, in the same coordinate space as
   * `top`/`bottom`. A ghost label is only allowed once this rect has left the
   * viewport: while the real tab is still on screen it IS the label (drawing a
   * second one over it is the "重影" defect).
   */
  readonly tab?: PlanRect | null;
};

/** At most two sticky package names may be pinned, per the design's limit. */
export const STICKY_LABEL_LIMIT = 2;

/** Clearance a sticky label keeps from the viewport's edges. */
export const STICKY_LABEL_MARGIN_PX = 2;

/** Whether two rectangles share any area (touching edges do not count). */
export function planRectsIntersect(a: PlanRect, b: PlanRect): boolean {
  return a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0
    && a.x < b.x + b.w && b.x < a.x + a.w
    && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Choose the package names that stick to the top of the viewport because their
 * frame's top edge has scrolled out of it. Ordered outermost-first and capped at
 * {@link STICKY_LABEL_LIMIT}, so a nested chain cannot paper over the drawing.
 *
 * When a `viewport` is given, a frame whose own tab still intersects it is NOT
 * a candidate: the visible tab already names the package, and the ghost copy
 * would paint over it (or over a sibling's tab).
 */
export function planStickyLabels<T extends StickyLabelCandidate>(
  frames: readonly T[],
  viewportTop: number,
  viewport?: PlanRect | null,
): readonly T[] {
  return frames
    .filter((frame) => frame.top < viewportTop && frame.bottom > viewportTop + 40)
    .filter((frame) => viewport === undefined || viewport === null
      || frame.tab === undefined || frame.tab === null
      || !planRectsIntersect(frame.tab, viewport))
    .sort((a, b) => a.depth - b.depth)
    .slice(-STICKY_LABEL_LIMIT);
}

/** One sticky label to place: its drawn size and the frame edge it follows. */
export type StickyLabelRequest = {
  readonly id: string;
  /** The package frame's left edge, in the placement coordinate space. */
  readonly anchorX: number;
  readonly width: number;
  readonly height: number;
};

/** One chosen sticky label: where its pill is drawn. */
export type StickyLabelPlacement = {
  readonly id: string;
  readonly rect: PlanRect;
};

/**
 * Place sticky labels down the viewport's top edge, fully inside it.
 *
 * A candidate is SKIPPED (not moved) when its pill cannot sit without covering
 * a visible class name, a real package tab, or another sticky: the design
 * allows hiding a sticky label, never drawing it over something readable. The
 * horizontal anchor follows the package's own left edge, clamped so the pill is
 * never clipped by the viewport's side.
 */
export function placeStickyLabels(args: {
  readonly candidates: readonly StickyLabelRequest[];
  readonly viewport: PlanRect;
  readonly obstacles?: readonly PlanRect[];
  readonly margin?: number;
}): readonly StickyLabelPlacement[] {
  const margin = args.margin ?? STICKY_LABEL_MARGIN_PX;
  const obstacles = args.obstacles ?? [];
  const placements: StickyLabelPlacement[] = [];
  let top = args.viewport.y + margin;
  for (const candidate of args.candidates) {
    if (!(candidate.width > 0) || !(candidate.height > 0)) continue;
    if (candidate.width + 2 * margin > args.viewport.w) continue;
    if (top + candidate.height + margin > args.viewport.y + args.viewport.h) continue;
    const left = Math.min(
      Math.max(candidate.anchorX, args.viewport.x + margin),
      args.viewport.x + args.viewport.w - candidate.width - margin,
    );
    const rect: PlanRect = { x: left, y: top, w: candidate.width, h: candidate.height };
    if (
      obstacles.some((obstacle) => planRectsIntersect(rect, obstacle))
      || placements.some((placement) => planRectsIntersect(rect, placement.rect))
    ) continue;
    placements.push({ id: candidate.id, rect });
    top += candidate.height + margin;
  }
  return placements;
}

/** Where the overview hint pill is drawn, in the same space as its obstacles. */
export type HintPlacement = { readonly x: number; readonly y: number };

/**
 * Place the overview hint pill where it covers no package tab.
 *
 * The hint previously sat at a fixed top-left corner and, at the 6 % phone
 * level, painted over the `modules`/`chat` tabs. It tries the four corners and
 * both side mid-points, then the least-overlapping candidate if every one is
 * blocked (a hint that is slightly overlapping is still better than hiding the
 * way back to the whole graph). `obstacles` are package-tab rects in the hint's
 * own coordinate space.
 */
export function planHintPlacement(args: {
  readonly width: number;
  readonly height: number;
  readonly viewport: PlanRect;
  readonly obstacles?: readonly PlanRect[];
  readonly margin?: number;
}): HintPlacement {
  const margin = args.margin ?? 8;
  const width = Math.min(args.width, Math.max(0, args.viewport.w - 2 * margin));
  const height = Math.min(args.height, Math.max(0, args.viewport.h - 2 * margin));
  const left = args.viewport.x + margin;
  const right = args.viewport.x + args.viewport.w - width - margin;
  const top = args.viewport.y + margin;
  const bottom = args.viewport.y + args.viewport.h - height - margin;
  const middle = args.viewport.y + (args.viewport.h - height) / 2;
  const candidates: HintPlacement[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: left, y: middle },
    { x: right, y: middle },
  ];
  const obstacles = args.obstacles ?? [];
  const free = candidates.find((candidate) => !obstacles.some((obstacle) => planRectsIntersect(
    { x: candidate.x, y: candidate.y, w: width, h: height },
    obstacle,
  )));
  if (free !== undefined) return free;
  const overlapArea = (candidate: HintPlacement): number => obstacles.reduce((total, obstacle) => {
    const left2 = Math.max(candidate.x, obstacle.x);
    const right2 = Math.min(candidate.x + width, obstacle.x + obstacle.w);
    const top2 = Math.max(candidate.y, obstacle.y);
    const bottom2 = Math.min(candidate.y + height, obstacle.y + obstacle.h);
    return total + (right2 > left2 && bottom2 > top2 ? (right2 - left2) * (bottom2 - top2) : 0);
  }, 0);
  return candidates.reduce((best, candidate) => (
    overlapArea(candidate) < overlapArea(best) ? candidate : best
  ), candidates[0]);
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
