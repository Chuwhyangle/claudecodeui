/**
 * The one place the architecture canvas READS a rendered SVG into geometry.
 *
 * `plantuml-js` 0.4.0 publishes the facts this module needs instead of leaving
 * them to be guessed: the entity and package boxes carry `data-x` / `data-y` /
 * `data-w` / `data-h`, an entity's compartment heights are `data-title-h` /
 * `data-attrs-h` / `data-ops-h`, a package's tab is `data-tab-w` / `data-tab-h`
 * plus a closed `.uml-package-tab` path, members are classified as `uml-attr`
 * or `uml-op`, and compartment rules are `.uml-compartment-rule` elements with
 * `data-rule`. Nothing here infers a member's kind from its text.
 *
 * The engine (`semanticZoomLayout.ts`) is pure: this module is the only code
 * that touches the DOM, and it only reads. Consumers: `PlantUmlGraph.tsx` (once
 * per drawing) and `tests/semanticZoomRead.test.ts`.
 */

import type { PlanPoint } from '@/modules/architecture/semanticZoomPlan';

/** A rectangle in drawing user units. */
export type SemanticRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** The entity kinds the planner knows. */
export type SemanticEntityKind = 'class' | 'interface' | 'enum' | 'function';

/** One member row, already classified by the renderer. */
export type SemanticMember = {
  readonly text: string;
  /** `uml-attr` → attribute compartment; `uml-op` → operations compartment. */
  readonly compartment: 'attr' | 'op';
};

/** One entity as the renderer drew it. */
export type SemanticNodeGeometry = {
  readonly id: string;
  readonly rect: SemanticRect;
  readonly label: string;
  readonly kind: SemanticEntityKind;
  /** The `<<kind>>` token the renderer drew (if any). */
  readonly stereotype: string | null;
  readonly members: readonly SemanticMember[];
  readonly seed: boolean;
  readonly mentionTier: string | null;
  /** The title compartment's height, from `data-title-h`. */
  readonly titleHeight: number;
  /** The attribute and operation compartment heights, from the renderer. */
  readonly attributesHeight: number;
  readonly operationsHeight: number;
  /** How many `.uml-compartment-rule` elements the frame draws. */
  readonly ruleCount: number;
  /** The renderer's title-rule y, used to keep the ≥ 90 % view identical. */
  readonly titleRuleY: number | null;
};

/** One package frame as the renderer drew it. */
export type SemanticPackageGeometry = {
  readonly id: string;
  readonly rect: SemanticRect;
  readonly rawLabel: string;
  /** The tab's published size, or null when the renderer emitted none. */
  readonly tabWidth: number | null;
  readonly tabHeight: number | null;
  /** Whether the tab path closes its right side (a full `Z`-closed tab). */
  readonly tabClosed: boolean;
};

/** One edge as the renderer drew it: its polyline in drawing user units. */
export type SemanticEdgeGeometry = {
  readonly source: string;
  readonly target: string;
  readonly points: readonly PlanPoint[];
  /** How many original relations this (possibly bundled) edge stands for. */
  readonly bundleSize: number;
};

/**
 * The payload facts the SVG does not carry: an entity's kind (0.4.0 draws a
 * function and a class identically) and its members' field/method kind (the
 * renderer's own parser treats a field whose TYPE contains `(` as a method —
 * the server payload is authoritative and is overlaid here).
 */
export type SemanticReadHints = {
  readonly kindById?: ReadonlyMap<string, SemanticEntityKind>;
  readonly memberKindsById?: ReadonlyMap<string, readonly ('field' | 'method')[]>;
};

/** Everything the engine reads from one rendered drawing. */
export type SemanticDrawingGeometry = {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly SemanticNodeGeometry[];
  readonly packages: readonly SemanticPackageGeometry[];
  readonly edges: readonly SemanticEdgeGeometry[];
};

/** The points of a path's `d` attribute, in order (curves keep their control points). */
export function pathPointsOf(d: string | null): PlanPoint[] {
  if (d === null) return [];
  const numbers = [...d.matchAll(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)].map((match) => Number(match[0]));
  const points: PlanPoint[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

/** Direct-child elements of one tag, without descending into nested groups. */
function directChildren(element: Element, tag: string): Element[] {
  return [...element.children].filter((child) => child.tagName.toLowerCase() === tag);
}

/** One numeric attribute, or null when absent/non-finite. */
function numericAttribute(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The entity's drawn label and kind.
 *
 * 0.4.0 marks an interface/abstract title with `font-style: italic`; the
 * stereotype prefix is still parsed when a document (or an older renderer)
 * puts `<<kind>>` in the text. Function/enum are not distinguishable from the
 * SVG alone — `PlantUmlGraph` overlays the graph payload's own `kind` when it
 * draws the box.
 */
function entityLabelOf(group: Element): {
  label: string;
  kind: SemanticEntityKind;
  stereotype: string | null;
} {
  const texts = directChildren(group, 'text');
  const first = texts.find((text) => !/uml-(attr|op|edge-label)/.test(text.getAttribute('class') ?? ''))
    ?? texts[0];
  const text = first?.textContent ?? group.getAttribute('data-entity-id') ?? '';
  const match = /^(?:<<\s*([\w]+)\s*>>|«\s*([\w]+)\s*»)\s*/.exec(text);
  const stereotype = match?.[1] ?? match?.[2] ?? null;
  const italic = /italic/.test(first?.getAttribute('font-style') ?? '');
  const kind: SemanticEntityKind = stereotype === 'interface' || (stereotype === null && italic)
    ? 'interface'
    : stereotype === 'enum'
      ? 'enum'
      : stereotype === 'function'
        ? 'function'
        : 'class';
  return {
    kind,
    label: text.replace(/^(?:<<\s*[\w]+\s*>>|«\s*[\w]+\s*»)\s*/, ''),
    stereotype,
  };
}

/** Whether a drawn node carries the session-seed marker. */
function nodeIsSeed(group: Element): boolean {
  const marker = group.getAttribute('data-architecture-seed');
  return marker === 'true' || marker === 'light'
    || group.classList.contains('arch-seed')
    || group.classList.contains('arch-seed-light');
}

/** The members the renderer classified, in drawing order. */
function membersOf(
  group: Element,
  kinds: readonly ('field' | 'method')[] | undefined,
): SemanticMember[] {
  return directChildren(group, 'text')
    .map((text) => {
      const classes = text.getAttribute('class') ?? '';
      if (!/\buml-(attr|op)\b/.test(classes)) return null;
      return {
        text: text.textContent ?? '',
        // The payload's own kind wins when present (a field whose type has
        // parentheses is a `field` there); the renderer class is the fallback.
        compartment: 'attr' as const,
        drawnAsOperation: /\buml-op\b/.test(classes),
      };
    })
    .filter((member): member is { text: string; compartment: 'attr'; drawnAsOperation: boolean } => member !== null)
    .map((member, index) => {
      const payloadKind = kinds?.[index];
      const asOperation = payloadKind === 'method'
        || (payloadKind === undefined && member.drawnAsOperation);
      return { text: member.text, compartment: asOperation ? 'op' : 'attr' } as const;
    });
}

/** The entity box: published data attributes first, the rect element as fallback. */
function nodeRectOf(group: Element): SemanticRect | null {
  const rect = group.querySelector('rect');
  const x = numericAttribute(group, 'data-x') ?? (rect === null ? null : numericAttribute(rect, 'x'));
  const y = numericAttribute(group, 'data-y') ?? (rect === null ? null : numericAttribute(rect, 'y'));
  const width = numericAttribute(group, 'data-w') ?? (rect === null ? null : numericAttribute(rect, 'width'));
  const height = numericAttribute(group, 'data-h') ?? (rect === null ? null : numericAttribute(rect, 'height'));
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

/** Read the geometry of one rendered drawing. Read-only; never mutates the SVG. */
export function readSemanticDrawingGeometry(
  svg: Element,
  hints: SemanticReadHints = {},
): SemanticDrawingGeometry {
  const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = Number(svg.getAttribute('width'));
  const height = Number(svg.getAttribute('height'));
  const boxWidth = Number.isFinite(viewBox[2]) && viewBox[2] > 0
    ? viewBox[2]
    : Number.isFinite(width) && width > 0 ? width : 0;
  const boxHeight = Number.isFinite(viewBox[3]) && viewBox[3] > 0
    ? viewBox[3]
    : Number.isFinite(height) && height > 0 ? height : 0;

  const packages: SemanticPackageGeometry[] = [];
  for (const group of svg.querySelectorAll('.uml-package[data-package-id]')) {
    const rect = nodeRectOf(group);
    if (rect === null) continue;
    const tab = group.querySelector('.uml-package-tab');
    packages.push({
      id: group.getAttribute('data-package-id') ?? '',
      rect,
      rawLabel: directChildren(group, 'text')[0]?.textContent ?? group.getAttribute('data-package-id') ?? '',
      tabWidth: numericAttribute(group, 'data-tab-w'),
      tabHeight: numericAttribute(group, 'data-tab-h'),
      tabClosed: tab !== null && /z/i.test(tab.getAttribute('d') ?? ''),
    });
  }

  const nodes: SemanticNodeGeometry[] = [];
  for (const group of svg.querySelectorAll('.uml-node[data-entity-id]')) {
    const rect = nodeRectOf(group);
    if (rect === null) continue;
    const labelled = entityLabelOf(group);
    const payloadKind = hints.kindById?.get(group.getAttribute('data-entity-id') ?? '');
    const kind = payloadKind ?? labelled.kind;
    const rule = [...group.querySelectorAll('.uml-compartment-rule')]
      .find((line) => line.getAttribute('data-rule') === 'title');
    const ruleY = rule === undefined ? Number.NaN : Number(rule.getAttribute('y1'));
    nodes.push({
      id: group.getAttribute('data-entity-id') ?? '',
      rect,
      label: labelled.label,
      kind,
      stereotype: labelled.stereotype,
      members: membersOf(group, hints.memberKindsById?.get(group.getAttribute('data-entity-id') ?? '')),
      seed: nodeIsSeed(group),
      mentionTier: group.getAttribute('data-architecture-pinned') === 'true' ? 'pinned' : null,
      titleHeight: numericAttribute(group, 'data-title-h') ?? 0,
      attributesHeight: numericAttribute(group, 'data-attrs-h') ?? 0,
      operationsHeight: numericAttribute(group, 'data-ops-h') ?? 0,
      ruleCount: group.querySelectorAll('.uml-compartment-rule').length,
      titleRuleY: Number.isFinite(ruleY) ? ruleY : null,
    });
  }

  const edges: SemanticEdgeGeometry[] = [];
  // A bundled edge carries its source and bundle size but no single target.
  for (const group of svg.querySelectorAll('.uml-edge[data-edge-source]')) {
    const path = directChildren(group, 'path')[0];
    const points = pathPointsOf(path?.getAttribute('d') ?? null);
    if (points.length < 2) continue;
    edges.push({
      source: group.getAttribute('data-edge-source') ?? '',
      target: group.getAttribute('data-edge-target') ?? '',
      points,
      bundleSize: numericAttribute(group, 'data-bundle-size') ?? numericAttribute(group, 'data-weight') ?? 1,
    });
  }

  return { width: boxWidth, height: boxHeight, nodes, packages, edges };
}
