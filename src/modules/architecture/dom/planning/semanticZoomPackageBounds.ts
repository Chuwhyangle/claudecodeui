/**
 * Package frame bottoms under the shared semantic y axis.
 *
 * The y axis is one shared solve: every class's `yElements` contribute to the
 * same breakpoints, and a `minLength` constraint can only widen a breakpoint
 * gap — it cannot lengthen one class's column alone. A member-hidden class
 * (tier A with no room for rows) still feeds its `plan.minHeight` into that
 * solve, so a SIDE-BY-SIDE neighbour on the same y interval can be held taller
 * than the rows it actually draws. The neighbour's frame is drawn row-tight in
 * `semanticZoomLayout.evaluateTier`; without this module the package that
 * contains it would still follow the taller cell, leaving a blank strip below
 * the package's lowest class.
 *
 * The rule: a package ends at the DRAWN bottom of its deepest visible child,
 * keeping the renderer's own bottom padding (the raw distance from the deepest
 * child to the package edge, scaled with the drawing so the 100 % reading is
 * unchanged). It never grows past the mapped frame (the bug is a strip that is
 * too large) and never shrinks above the tab band the frame still has to carry.
 * Packages are computed deepest-first so a parent can follow a folded child.
 *
 * This lives in a leaf module rather than in `semanticZoomLayout.ts` because
 * that file is over the 800-line architecture-ratchet limit and the ratchet may
 * only fall: the logic is additive and gets its own (sub-limit) file.
 */
import type { PlannedPackageTab } from '@/modules/architecture/dom/planning/semanticZoomPlan';
import type { SemanticRect } from '@/modules/architecture/dom/planning/semanticZoomRead';

/** The content tiers; tier `C` draws packages only and keeps the mapped box. */
export type PackageBoundsTier = 'A' | 'B' | 'C' | 'D';

type PackageTreeEntry = {
  readonly geometry: { readonly id: string; readonly rect: SemanticRect };
  readonly depth: number;
  readonly childPackageIds: readonly string[];
  readonly nodeIds: readonly string[];
};

type DrawnNode = { readonly id: string; readonly drawn: SemanticRect };

/** One package frame's layout, with its tab plan (structurally the panel's `SemanticPackageLayout`). */
export type PackageBoundsLayout = {
  readonly id: string;
  readonly depth: number;
  readonly frame: SemanticRect;
  readonly tab: PlannedPackageTab;
  /** The tab's rectangle, or null when the frame is too small to carry it. */
  readonly tabRect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null;
  readonly mentionedCount: number;
};

export type PackageBoundsInput = {
  readonly tier: PackageBoundsTier;
  readonly scale: number;
  readonly tree: readonly PackageTreeEntry[];
  /** The materialised class layouts (only `id` and the drawn frame are read). */
  readonly nodes: readonly DrawnNode[];
  /** The raw source rect of every class, by id — the pre-solve geometry. */
  readonly rawRectById: ReadonlyMap<string, SemanticRect>;
  readonly mapX: (value: number) => number;
  readonly mapY: (value: number) => number;
  readonly tabOf: (packageId: string, entityCount: number, mentionedCount: number) => PlannedPackageTab;
  readonly mentionedIn: (nodeIds: readonly string[]) => number;
};

/** Map every package frame, folding the drawn-bottom rule into its height. */
export function computePackageBounds(input: PackageBoundsInput): PackageBoundsLayout[] {
  const { tier, scale, tree, nodes, rawRectById, mapX, mapY, tabOf, mentionedIn } = input;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const treeById = new Map(tree.map((entry) => [entry.geometry.id, entry]));
  const packageBottom = new Map<string, number>();
  for (const entry of [...tree].sort((a, b) => b.depth - a.depth)) {
    const rect = entry.geometry.rect;
    const frameTop = mapY(rect.y);
    const frameBottom = mapY(rect.y + rect.height);
    // Tier C draws no class box: its package-only drawing keeps the mapped box.
    if (tier === 'C') {
      packageBottom.set(entry.geometry.id, frameBottom);
      continue;
    }
    let drawnBottom = Number.NEGATIVE_INFINITY;
    let deepestRawBottom = Number.NEGATIVE_INFINITY;
    for (const nodeId of entry.nodeIds) {
      const node = nodeById.get(nodeId);
      const raw = rawRectById.get(nodeId);
      if (node === undefined || raw === undefined) continue;
      drawnBottom = Math.max(drawnBottom, node.drawn.y + node.drawn.height);
      deepestRawBottom = Math.max(deepestRawBottom, raw.y + raw.height);
    }
    for (const childId of entry.childPackageIds) {
      const child = treeById.get(childId);
      if (child === undefined) continue;
      const childBottom = packageBottom.get(childId);
      if (childBottom !== undefined) drawnBottom = Math.max(drawnBottom, childBottom);
      deepestRawBottom = Math.max(
        deepestRawBottom,
        child.geometry.rect.y + child.geometry.rect.height,
      );
    }
    if (!Number.isFinite(drawnBottom) || !Number.isFinite(deepestRawBottom)) {
      packageBottom.set(entry.geometry.id, frameBottom);
      continue;
    }
    const tab = tabOf(entry.geometry.id, entry.nodeIds.length, mentionedIn(entry.nodeIds));
    const padding = Math.max(0, scale * (rect.y + rect.height - deepestRawBottom));
    // Never grow past the mapped box (the bug is a strip that is too large),
    // and never shrink above the tab band the frame still has to carry.
    packageBottom.set(
      entry.geometry.id,
      Math.min(frameBottom, Math.max(drawnBottom + padding, frameTop + tab.height)),
    );
  }

  return tree.map((entry) => {
    const mentionedCount = mentionedIn(entry.nodeIds);
    const tab = tabOf(entry.geometry.id, entry.nodeIds.length, mentionedCount);
    const rect = entry.geometry.rect;
    const frame: SemanticRect = {
      x: mapX(rect.x),
      y: mapY(rect.y),
      width: mapX(rect.x + rect.width) - mapX(rect.x),
      height: (packageBottom.get(entry.geometry.id) ?? mapY(rect.y + rect.height)) - mapY(rect.y),
    };
    const fits = frame.width >= tab.width + 4 && frame.height >= tab.height + 4;
    return {
      id: entry.geometry.id,
      depth: entry.depth,
      frame,
      tab,
      tabRect: fits ? { x: frame.x + 5, y: frame.y, w: tab.width, h: tab.height } : null,
      mentionedCount,
    };
  });
}
