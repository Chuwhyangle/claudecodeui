/**
 * The PlantUML renderer's DOM readings — navigation geometry, focus rings, the
 * diff overlay and the a11y control lever — extracted from PlantUmlGraph.tsx by
 * the architecture god-package split (task
 * gap-routine-architecture-analysis-god-package-src-architecture).
 *
 * These are geometry/DOM readings over a drawn SVG: they take elements and
 * measurements, never React state, so they stay out of the component's render
 * path. PlantUmlGraph re-exports the symbols its tests address so the renderer's
 * public surface is unchanged.
 */
import type { ArchitectureDiffHighlight } from '@/modules/architecture/dom/rendererContract';
import {
  PACKAGE_NAV_PREFIX,
  type EntityNavigationItem,
} from '@/modules/architecture/dom/entityNavigation';
import type { LayoutOrientation, OrientationSize } from '@/modules/architecture/dom/layoutOrientation';
import { memberDisplayLimits } from '@/modules/architecture/layout/archguardToPlantUml';
import { capDrawnMemberRows } from '@/modules/architecture/layout/drawnFit';
import { nodeElement, type PlantUmlRenderDetailed } from '@/modules/architecture/layout/graphDom';
import { GROUP_PREFIX, STUB_PREFIX } from '@/modules/architecture/dom/graphConstants';

const MEMBER_LIMITS_STORAGE_KEY = 'architecture-member-limits';

/** The member caps to hand the renderer: the shipped ones, or none for the control arm. */
export function drawnMemberLimits(): { memberMaxChars?: number } {
  if (import.meta.env.DEV) {
    try {
      if (window.localStorage.getItem(MEMBER_LIMITS_STORAGE_KEY) === 'off') return {};
    } catch {
      // Private mode: the store is unreadable, so the shipped caps apply.
    }
  }
  return memberDisplayLimits();
}

/**
 * The DEV-only lever the orientation criterion's control arms pull: forcing a
 * direction is the only way to measure what the canvas looks like for the
 * direction the policy did NOT choose — laid out for real, through the same
 * reading. `down` is the pre-feature state; `right` is the losing candidate
 * once the fit comparison is post-reclaim.
 *
 * DEV-gated exactly like the member-limit lever above — a production build does
 * not contain this branch, so no reader can turn the feature off.
 */
const LAYOUT_ORIENTATION_STORAGE_KEY = 'architecture-layout-orientation';

/** Whether this build's control arm asked for one fixed direction. */
export function forcedLayoutOrientation(): LayoutOrientation | null {
  if (import.meta.env.DEV) {
    try {
      const forced = window.localStorage.getItem(LAYOUT_ORIENTATION_STORAGE_KEY);
      if (forced === 'down') return 'DOWN';
      if (forced === 'right') return 'RIGHT';
    } catch {
      // Private mode: the store is unreadable, so the shipped policy applies.
    }
  }
  return null;
}

/** The natural size a finished layout reports, or `null` when it is unusable. */
export function layoutSizeOf(detailed: { readonly layout: unknown }): OrientationSize | null {
  const layout = detailed.layout as { readonly width?: unknown; readonly height?: unknown } | null;
  const width = Number(layout?.width);
  const height = Number(layout?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/**
 * The row-cap and drawn-fit readings live in `drawnFit.ts` (this panel is
 * size-ratcheted); `capDrawnMemberRows` stays re-exported here because the
 * renderer is where its consumers expect to find it.
 */
export { capDrawnMemberRows };

/**
 * The member detail every drawing is rendered with.
 *
 * The package's default picks a level from the entity count (`≤40` full,
 * `≤150` compact, else names). Compact replaces every box's tail with a
 * synthetic `… +N more (M members)` row and, more importantly, writes that row
 * into the drawn MODEL — so `renderDetailed(...).model`, which the text page
 * serializes, was already lossy on any diagram past 40 entities. The text the
 * reader copies, downloads or sends must carry every member, so the detail is
 * pinned here instead of left to the entity count. The on-screen row cap is the
 * semantic-zoom layout's job (`planMemberRows`), independent of this value.
 *
 * Consumers: `PlantUmlGraph.tsx` (the render call) and
 * `tests/plantUmlText.test.ts` (the completeness criteria).
 */
export const PLANTUML_MEMBER_DETAIL = 'full' as const;

/**
 * Call `renderDetailed` with {@link PLANTUML_MEMBER_DETAIL} added to its
 * options.
 *
 * `type PlantUmlRenderDetailed` in `graphDom.ts` models only the structural
 * subset the renderer needs (`layout`/`view`); the package's own `detail`
 * option is added here, once, so every drawing — and therefore every drawn
 * model the text page serializes — is complete. Kept as a named function so a
 * unit test can assert the option the real renderer receives without mounting
 * the component.
 *
 * Consumers: `PlantUmlGraph.tsx` (the only render call) and
 * `tests/plantUmlText.test.ts`.
 */
export function renderWithMemberDetail(
  render: PlantUmlRenderDetailed,
  puml: string,
  options: Partial<Parameters<PlantUmlRenderDetailed>[1]> = {},
): ReturnType<PlantUmlRenderDetailed> {
  // A variable, not a fresh literal: the structural options type deliberately
  // does not name `detail`, and an object with the extra key is assignable to
  // it (the package reads the key at runtime).
  const detailedOptions = { ...options, detail: PLANTUML_MEMBER_DETAIL };
  return render(puml, detailedOptions as Parameters<PlantUmlRenderDetailed>[1]);
}

/** The class the keyboard cursor paints on the drawn box it stands on. */
const NAV_FOCUS_CLASS = 'arch-nav-focus';
/** The class the focus RING carries (distinct from the selection class). */
const NAV_RING_CLASS = 'arch-nav-ring';
/** The id prefix the cursor's DOM elements carry, for `aria-activedescendant`. */
const NAV_DOM_ID_PREFIX = 'arch-nav-';
/** How far the focus ring sits outside the box, in SVG user units. */
const NAV_RING_GAP = 2;

/**
 * Resolve after the browser has had the chance to PAINT what React just
 * committed.
 *
 * The layout this guards is one blocking call on the main thread: once it
 * starts, nothing — not a status line, not an animation — can be committed or
 * painted until it returns. The status must therefore be in the document and
 * on screen BEFORE the layout is entered, which is what the frame + task pair
 * here buys: the frame callback runs after the commit, and the timeout yields
 * to the paint that follows it.
 */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    window.requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * The id `aria-activedescendant` names. Derived from the cursor id alone, so the
 * React attribute and the element's own `id` are written from one source and
 * cannot disagree.
 */
export function navigationDomId(cursorId: string): string {
  return `${NAV_DOM_ID_PREFIX}${cursorId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** A positive numeric attribute, or `null` when absent/unparseable. */
function numericAttribute(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The item's rectangle in the SVG's own user coordinates.
 *
 * The leading `rect` is read FIRST: the semantic pass rebuilds every group's
 * children in the mapped layout but leaves the group's original `data-x/y/w/h`
 * (published by the renderer before that rewrite) in place, so a ring painted
 * from those would sit at the pre-semantic position. A drawing the semantic
 * pass has not touched has the two in agreement, and the attributes remain the
 * fallback for a group without a rect.
 */
function navigationRectOf(element: Element): { x: number; y: number; width: number; height: number } | null {
  const rect = element.querySelector('rect');
  const x = (rect === null ? null : numericAttribute(rect, 'x')) ?? numericAttribute(element, 'data-x');
  const y = (rect === null ? null : numericAttribute(rect, 'y')) ?? numericAttribute(element, 'data-y');
  const width = (rect === null ? null : numericAttribute(rect, 'width')) ?? numericAttribute(element, 'data-w');
  const height = (rect === null ? null : numericAttribute(rect, 'height')) ?? numericAttribute(element, 'data-h');
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

/** The package a node id lives in, when the drawing did not publish one. */
export function packageIdOfNodeId(id: string): string {
  const path = id.startsWith(GROUP_PREFIX) ? id.slice(GROUP_PREFIX.length) : id;
  const slash = path.lastIndexOf('/');
  if (slash === -1) return '';
  // An entity id is `<file path>.<Entity>`; its file's directory is the package.
  return path.slice(0, slash);
}

export function normalizedPackageId(raw: string | null): string | null {
  if (raw === null) return null;
  const normalized = raw.trim().split('/').filter(Boolean).join('/');
  return normalized;
}

// ── the observation wall's structural diff ──────────────────────────────────

/** The attribute/class a diff-marked element carries; both are removed on clear. */
const DIFF_MARK_ATTRIBUTE = 'data-architecture-diff';
const DIFF_NODE_CLASS = 'arch-diff-node';
const DIFF_EDGE_CLASS = 'arch-diff-edge';

/** The marker's stylesheet: an amber dashed frame/line, distinct from selection blue. */
export const DIFF_HIGHLIGHT_STYLE = `
  [data-architecture-plantuml] .${DIFF_NODE_CLASS} > rect { stroke: #c2410c; stroke-width: 2.5; stroke-dasharray: 5,3; }
  [data-architecture-plantuml] .${DIFF_EDGE_CLASS} path,
  [data-architecture-plantuml] .${DIFF_EDGE_CLASS} polyline,
  [data-architecture-plantuml] .${DIFF_EDGE_CLASS} line { stroke: #c2410c; stroke-width: 2.5; stroke-dasharray: 6,3; }
`;

/**
 * Whether a drawn package id is the declared package (or lives inside it).
 *
 * The two sides spell a package from different roots on purpose: the snapshot's ids are
 * project-relative (`server/modules/observation`), while the drawing publishes the scope's own
 * path (`modules/observation`, sometimes with the opaque scope key in front). Neither side is
 * wrong, so the match accepts a suffix on EITHER side at a path boundary rather than an exact
 * string — anything looser would mark a neighbour.
 */
function packageMatches(candidate: string | null, wanted: string): boolean {
  if (candidate === null) return false;
  const normalizedCandidate = candidate.replace(/^\/+|\/+$/g, '');
  const normalizedWanted = wanted.trim().replace(/^\/+|\/+$/g, '');
  if (normalizedCandidate === '' || normalizedWanted === '') return false;
  return normalizedCandidate === normalizedWanted
    || normalizedCandidate.endsWith(`/${normalizedWanted}`)
    || normalizedCandidate.startsWith(`${normalizedWanted}/`)
    || normalizedWanted.endsWith(`/${normalizedCandidate}`);
}

/** The package a drawn node id belongs to, as the drawing published it. */
function drawnPackageOf(host: HTMLElement, nodeId: string): string | null {
  const element = nodeElement(host, nodeId);
  const published = element === null ? null : normalizedPackageId(element.getAttribute('data-package-id'));
  return published ?? packageOfDrawnId(nodeId);
}

/**
 * The package a drawn id names, for a node that carries no `data-package-id`.
 *
 * A collapsed overview draws PACKAGE boxes (`grp::server/modules/observation`) rather than files;
 * that box IS the package, so its whole id is the package id. Everything else is a file/entity id
 * and its directory is the package.
 */
function packageOfDrawnId(nodeId: string): string | null {
  if (nodeId === '') return null;
  if (nodeId.startsWith(GROUP_PREFIX)) return normalizedPackageId(nodeId.slice(GROUP_PREFIX.length));
  return packageIdOfNodeId(nodeId);
}

/** Removes every diff marker from a drawing (a fresh SVG never carries any). */
function clearDiffStyles(host: HTMLElement): void {
  for (const element of host.querySelectorAll(`[${DIFF_MARK_ATTRIBUTE}]`)) {
    element.removeAttribute(DIFF_MARK_ATTRIBUTE);
    element.classList.remove(DIFF_NODE_CLASS, DIFF_EDGE_CLASS);
  }
}

/**
 * Marks the structural differences the observation tile passed in.
 *
 * Package ids mark their member nodes; package EDGES mark every drawn relation crossing that
 * pair; the exact `nodeIds`/`edges` forms mark the ids verbatim. With no highlight (or an empty
 * one) the drawing is left exactly as it was — the pre-highlight rendering.
 */
export function applyDiffStyles(host: HTMLElement, highlight: ArchitectureDiffHighlight | null): void {
  clearDiffStyles(host);
  if (highlight === null) return;

  const exactNodeIds = new Set(highlight.nodeIds ?? []);
  const packageIds = (highlight.packageIds ?? []).filter((entry) => entry.trim() !== '');
  for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id') ?? '';
    const packageId = normalizedPackageId(element.getAttribute('data-package-id'))
      ?? packageOfDrawnId(id);
    const marked = exactNodeIds.has(id)
      || packageIds.some((wanted) => packageMatches(packageId, wanted));
    if (!marked) continue;
    element.setAttribute(DIFF_MARK_ATTRIBUTE, 'node');
    element.classList.add(DIFF_NODE_CLASS);
  }

  const exactEdges = highlight.edges ?? [];
  const packageEdges = (highlight.packageEdges ?? []).filter(
    (entry) => entry.from.trim() !== '' && entry.to.trim() !== '',
  );
  for (const element of host.querySelectorAll('.uml-edge[data-edge-source]')) {
    const from = element.getAttribute('data-edge-source') ?? '';
    const to = element.getAttribute('data-edge-target') ?? '';
    const marked = exactEdges.some((entry) => entry.from === from && entry.to === to)
      || (packageEdges.length > 0 && packageEdges.some(
        (entry) => packageMatches(drawnPackageOf(host, from), entry.from)
          && packageMatches(drawnPackageOf(host, to), entry.to),
      ));
    if (!marked) continue;
    element.setAttribute(DIFF_MARK_ATTRIBUTE, 'edge');
    element.classList.add(DIFF_EDGE_CLASS);
  }
}

/**
 * Everything the keyboard can stand on in the drawing just laid out: its entity
 * boxes (group and stub nodes included, since `[`/`]` and Enter act on whatever
 * is drawn) and the package frames that contain them.
 *
 * Read from the DOM rather than the payload on purpose: the drawing is the
 * visible slice, and a node that the semantic tier hid must not be a keyboard
 * target the reader cannot see.
 */
export function collectNavigationItems(host: HTMLElement): EntityNavigationItem[] {
  const items: EntityNavigationItem[] = [];
  for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id') ?? '';
    if (id === '' || id.startsWith(STUB_PREFIX)) continue;
    if ((element as SVGElement).style?.display === 'none') continue;
    const rect = navigationRectOf(element);
    if (rect === null) continue;
    const packageId = normalizedPackageId(element.getAttribute('data-package-id'))
      ?? packageIdOfNodeId(id);
    items.push({ id, kind: 'entity', packageId, ...rect });
  }
  for (const element of host.querySelectorAll('.uml-package[data-package-id]')) {
    const packageId = normalizedPackageId(element.getAttribute('data-package-id'));
    if (packageId === null || packageId === '') continue;
    if ((element as SVGElement).style?.display === 'none') continue;
    const rect = navigationRectOf(element);
    if (rect === null) continue;
    items.push({ id: `${PACKAGE_NAV_PREFIX}${packageId}`, kind: 'package', packageId, ...rect });
  }
  return items;
}

/** The drawn element a cursor id names. */
export function navigationElementOf(host: HTMLElement, cursorId: string): Element | null {
  if (!cursorId.startsWith(PACKAGE_NAV_PREFIX)) return nodeElement(host, cursorId);
  const packageId = cursorId.slice(PACKAGE_NAV_PREFIX.length);
  for (const frame of host.querySelectorAll('.uml-package[data-package-id]')) {
    if (normalizedPackageId(frame.getAttribute('data-package-id')) === packageId) return frame;
  }
  return null;
}

/**
 * Paint the keyboard cursor: remove the previous ring, mark the new element for
 * `aria-activedescendant`, and draw a 3px ring with a 2px gap around its box —
 * a shape cue, not a colour-only one. The ring is a separate SVG rect so a
 * reader (and the e2e guard) can read its screen rectangle.
 */
export function paintNavigationFocus(host: HTMLElement, cursorId: string | null): void {
  for (const ring of host.querySelectorAll('[data-architecture-nav-ring]')) ring.remove();
  for (const marked of host.querySelectorAll(`.${NAV_FOCUS_CLASS}`)) {
    marked.classList.remove(NAV_FOCUS_CLASS);
    marked.removeAttribute('data-architecture-nav-focus');
  }
  if (cursorId === null) return;
  const element = navigationElementOf(host, cursorId);
  if (element === null) return;
  element.id = navigationDomId(cursorId);
  element.classList.add(NAV_FOCUS_CLASS);
  element.setAttribute('data-architecture-nav-focus', 'true');
  const rect = navigationRectOf(element);
  const svg = host.querySelector('svg');
  if (rect === null || svg === null) return;
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  ring.setAttribute('data-architecture-nav-ring', 'true');
  // The ring's class is the FOCUS style. It is deliberately not the selection
  // class (`.arch-selected`): focus is an outer, dashed outline, selection is
  // the solid, thicker edge the renderer's own stylesheet paints. A reader can
  // therefore tell "where the keyboard is" from "what is selected" without
  // relying on colour alone.
  ring.setAttribute('class', NAV_RING_CLASS);
  ring.setAttribute('x', String(rect.x - NAV_RING_GAP));
  ring.setAttribute('y', String(rect.y - NAV_RING_GAP));
  ring.setAttribute('width', String(rect.width + NAV_RING_GAP * 2));
  ring.setAttribute('height', String(rect.height + NAV_RING_GAP * 2));
  ring.setAttribute('rx', '4');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', '#1d4ed8');
  ring.setAttribute('stroke-width', '3');
  // Dashed: the visual half of the focus/selection split above.
  ring.setAttribute('stroke-dasharray', '5 3');
  ring.setAttribute('pointer-events', 'none');
  svg.appendChild(ring);
}

/** Remove every trace of the keyboard cursor from a drawing. */
export function clearNavigationFocus(host: HTMLElement): void {
  paintNavigationFocus(host, null);
}

/** Re-pin the focus marker after a rewrite dropped its element; returns the node for centring. */
export function pinFocusMarker(host: HTMLElement, focusNodeId: string | null): Element | null {
  const node = focusNodeId === null ? null : nodeElement(host, focusNodeId);
  node?.classList.add('arch-focus');
  node?.setAttribute('data-architecture-focus-target', focusNodeId ?? '');
  return node;
}

/**
 * The DEV-only lever the keyboard/a11y criterion's control arm pulls. Each
 * value restores one defect the shipped path removes, so the criterion's own
 * reading can be shown going red on the same code the main arm reads green:
 *
 *  · `farthest-start` — start the cursor on the entity FARTHEST from the
 *    viewport centre instead of the nearest one (an arbitrary start);
 *  · `verbose-announce` — restore the old whole-reading announcement
 *    (package name, outgoing/incoming counts) in the live region;
 *  · `keep-ring-on-blur` — keep the keyboard ring painted after the canvas
 *    loses focus.
 *
 * Production builds contain none of these branches.
 */
export type KeyboardA11yDefect = 'farthest-start' | 'verbose-announce' | 'keep-ring-on-blur';

/** The localStorage key the control arm writes. */
export const KEYBOARD_A11Y_STORAGE_KEY = 'architecture-keyboard-a11y';

/** Which defect the DEV lever restores, or `null` for the shipped behaviour. */
export function keyboardA11yDefect(): KeyboardA11yDefect | null {
  if (import.meta.env.DEV) {
    try {
      const stored = window.localStorage.getItem(KEYBOARD_A11Y_STORAGE_KEY);
      return stored === 'farthest-start' || stored === 'verbose-announce' || stored === 'keep-ring-on-blur'
        ? stored
        : null;
    } catch {
      // Private mode: the shipped behaviour applies.
    }
  }
  return null;
}

/** A point in the same space as a navigation item's rectangle. */
export type NavigationPoint = { readonly x: number; readonly y: number };

/**
 * The stable reading order the start tie-break uses: top to bottom, then left
 * to right, with the id last. It is a total order, so two runs over the same
 * rectangles always choose the same entity.
 */
function readingOrderLess(
  left: { readonly x: number; readonly y: number; readonly id: string },
  right: { readonly x: number; readonly y: number; readonly id: string },
): boolean {
  if (left.y !== right.y) return left.y < right.y;
  if (left.x !== right.x) return left.x < right.x;
  return left.id < right.id;
}

/**
 * The entity the keyboard cursor starts on when the canvas receives keyboard
 * focus.
 *
 * Contract:
 *  · the last entity the reader stood on (or the current selection) wins while
 *    it is still drawn — re-entering the canvas does not yank the cursor away;
 *  · otherwise the entity whose centre is NEAREST to `centre` (the viewport
 *    centre, in the same space as the rectangles) is chosen;
 *  · when the drawing has no entity box at all (the folded package map) the
 *    nearest FRAME is the start, so a keyboard user still gets a visible
 *    cursor on a canvas that answered the Tab;
 *  · equal distances are broken by {@link readingOrderLess}, so the choice is
 *    stable for identical input;
 *  · an empty drawing answers `null`.
 *
 * Pure: no DOM, no state. The caller measures the rectangles and the centre.
 */
export function pickNavigationStart(
  items: readonly EntityNavigationItem[],
  preferredId: string | null,
  centre: NavigationPoint,
): string | null {
  const entities = items.filter((item) => item.kind === 'entity');
  // With entities drawn, frames are places (reachable by `[`), never starts.
  const candidates = entities.length > 0 ? entities : [...items];
  if (candidates.length === 0) return null;
  if (preferredId !== null) {
    const preferred = candidates.find((item) => item.id === preferredId);
    if (preferred !== undefined) return preferred.id;
  }
  let best: EntityNavigationItem | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const dx = candidate.x + candidate.width / 2 - centre.x;
    const dy = candidate.y + candidate.height / 2 - centre.y;
    const distance = Math.hypot(dx, dy);
    if (
      best === null
      || distance < bestDistance
      || (distance === bestDistance && readingOrderLess(candidate, best))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best?.id ?? null;
}

/** The control arm's arbitrary start: the entity farthest from the centre. */
export function farthestNavigationStart(
  items: readonly EntityNavigationItem[],
  centre: NavigationPoint,
): string | null {
  let best: EntityNavigationItem | null = null;
  let bestDistance = -1;
  for (const entity of items) {
    if (entity.kind !== 'entity') continue;
    const dx = entity.x + entity.width / 2 - centre.x;
    const dy = entity.y + entity.height / 2 - centre.y;
    const distance = Math.hypot(dx, dy);
    if (best === null || distance > bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best?.id ?? null;
}
