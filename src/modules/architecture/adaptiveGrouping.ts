/**
 * Directory-layer adaptive grouping for the architecture overview.
 *
 * The overview used to fold paths by a FIXED number of path segments. The
 * renderer's `groupByPathPrefix` slices the display name — which ends in the
 * FILE name — so a flat directory with hundreds of files produced one group per
 * file (`grp::scripts/anti-drift-touches-check.ts`): the file name was counted
 * as a directory level, so the directory could never collapse.
 *
 * The rule implemented here groups by DIRECTORY layers only, and picks how many
 * layers to keep from the graph itself: for depth d = 1..N count the distinct
 * `first d directory segments` prefixes (a path with fewer than d directory
 * segments is grouped by its own directory — a file name is never a segment),
 * and take the LARGEST d whose group count stays within `OVERVIEW_GROUP_LIMIT`.
 * A leaf directory such as `scripts/` is therefore exactly one group, and its
 * label carries the entity count (`scripts (229)`). A directory that ends up
 * with a single member is not a group at all: it is drawn as that one node, so
 * the overview never shows a `(1)` box.
 *
 * Paths are read according to the graph's id shape (`ArchitectureNodeIdShape`):
 * entity ids carry an opaque `<scopeKey>/` prefix, file ids are already
 * project-relative paths. Peeling a file id's first segment would delete a real
 * directory — which is why `scripts/stamp-version.ts` used to lose `scripts/`.
 *
 * Consumers: `archguardToPlantUml.ts`, which emits the collapsed overview and
 * the re-grouped group view, and the adaptive-grouping criteria test.
 */

import type { ArchitectureNodeIdShape } from '@/modules/architecture/rendererContract';

/** How many directory groups the overview may draw before a coarser depth is chosen. */
export const OVERVIEW_GROUP_LIMIT = 40;

/**
 * The id scheme assumed when a caller does not state one: the entity graph's
 * `<scopeKey>/<path>.<Entity>`, which is what the bridge's raw contract was
 * written against. A caller holding a FILE graph must pass
 * `'project-relative'`, or every group and label loses its top directory.
 */
export const DEFAULT_NODE_ID_SHAPE: ArchitectureNodeIdShape = 'scope-prefixed';

/** One collapsed directory group: the prefix its nodes share and every node in it. */
export type AdaptiveGroup = {
  /** Directory path of the group (`''` only when the scope root itself is grouped). */
  readonly prefix: string;
  /** Nodes in this group, including the ones in its deeper subdirectories. */
  readonly nodeIds: readonly string[];
  /** Convenience reading of `nodeIds.length`, carried so labels cannot drift from the set. */
  readonly count: number;
};

/** The depth the adaptive rule settled on, plus the groups that depth produces. */
export type AdaptiveGrouping = {
  /** Directory segments kept per group; `0` collapses the whole subtree into one group. */
  readonly depth: number;
  /** Prefix-sorted groups; empty when the input has no directory to group. */
  readonly groups: readonly AdaptiveGroup[];
  /**
   * Nodes drawn as individual entities rather than as part of a group: the
   * scope-root files the overview leaves out of the grouping, plus the sole
   * member of every single-member directory (a group of one is drawing noise —
   * opening it reveals exactly the node a plain node would have shown).
   */
  readonly ungroupedNodeIds: readonly string[];
};

export type AdaptiveGroupingOptions = {
  /** Upper bound on groups; defaults to `OVERVIEW_GROUP_LIMIT`. */
  readonly maxGroups?: number;
  /**
   * How the input ids are shaped; defaults to `DEFAULT_NODE_ID_SHAPE`. An
   * entity graph is `scope-prefixed` (the leading scope key is stripped); a
   * file graph is `project-relative` (nothing is stripped).
   */
  readonly idShape?: ArchitectureNodeIdShape;
  /** Restrict the input to this directory subtree (a group view's prefix). */
  readonly prefix?: string;
  /**
   * Group the nodes sitting directly in `prefix` under the prefix itself. The
   * overview leaves the scope-root files ungrouped; expanding a directory puts
   * its own files in that directory's group.
   */
  readonly groupDirectNodes?: boolean;
};

/**
 * The directory the project sees for an ArchGuard id.
 *
 * `scope-prefixed` (entity graph): the leading `<scopeKey>/` is an opaque
 * ArchGuard scope token — not a directory — so it is stripped and the
 * scope-relative path is returned (`src/modules/a.ts.Entity` →
 * `modules/a.ts.Entity`).
 *
 * `project-relative` (file graph): the id already IS the project-relative path
 * (`scripts/stamp-version.ts`); stripping its first segment would turn a real
 * directory into a missing scope key and drop `scripts/` from every label.
 */
export function scopeRelativePath(
  id: string,
  idShape: ArchitectureNodeIdShape = DEFAULT_NODE_ID_SHAPE,
): string {
  if (idShape === 'project-relative') return id;
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * The directory (package) path of a node: its scope-relative path without the
 * last segment. `src/a/b/c/D.ts.D` → `a/b/c`; a scope-root file → `''`.
 */
export function directoryPathOf(
  id: string,
  idShape: ArchitectureNodeIdShape = DEFAULT_NODE_ID_SHAPE,
): string {
  const rel = scopeRelativePath(id, idShape);
  const lastSlash = rel.lastIndexOf('/');
  return lastSlash === -1 ? '' : rel.slice(0, lastSlash);
}

/** The group key of a directory at `depth` segments below `prefix`. */
function prefixAt(prefix: string, relativeDir: string, depth: number): string {
  const kept = relativeDir.split('/').filter(Boolean).slice(0, depth);
  if (kept.length === 0) return prefix;
  const joined = kept.join('/');
  return prefix === '' ? joined : `${prefix}/${joined}`;
}

/** Count distinct group keys at one depth without materialising the groups. */
function countGroups(
  entries: readonly { readonly relativeDir: string }[],
  prefix: string,
  depth: number,
): number {
  const keys = new Set<string>();
  for (const entry of entries) keys.add(prefixAt(prefix, entry.relativeDir, depth));
  return keys.size;
}

/**
 * Group `ids` by directory layers, choosing the deepest depth that keeps the
 * group count at or below `maxGroups`.
 *
 * Depth 0 (one group, the prefix itself) is only a candidate for a group view;
 * the overview always keeps at least one directory layer, because a single
 * root group would hide the tree it is meant to summarise. If even depth 1
 * exceeds the bound (more top-level directories than the limit), depth 1 is
 * used anyway: no coarser directory grouping exists that still distinguishes
 * anything.
 *
 * A group that ends up holding exactly one node is drawn as that node instead
 * (`ungroupedNodeIds`), in both the overview and the group view: a `(1)` box
 * that opens onto a single entity is pure noise, and the depth rule above can
 * leave whole directories alone at a depth that only made sense for the
 * directories beside them.
 */
export function computeAdaptiveGrouping(
  ids: readonly string[],
  options: AdaptiveGroupingOptions = {},
): AdaptiveGrouping {
  const maxGroups = options.maxGroups ?? OVERVIEW_GROUP_LIMIT;
  const idShape = options.idShape ?? DEFAULT_NODE_ID_SHAPE;
  const prefix = options.prefix ?? '';
  const groupDirectNodes = options.groupDirectNodes ?? false;

  const entries: { readonly id: string; readonly relativeDir: string }[] = [];
  // Membership only; the returned list is rebuilt in input order so the
  // drawing stays deterministic in the server's (distance, id) order.
  const ungrouped = new Set<string>();
  for (const id of ids) {
    const directory = directoryPathOf(id, idShape);
    if (prefix !== '' && directory !== prefix && !directory.startsWith(`${prefix}/`)) continue;
    const relativeDir = prefix === '' || directory === prefix
      ? (prefix === '' ? directory : '')
      : directory.slice(prefix.length + 1);
    if (relativeDir === '' && !groupDirectNodes) {
      ungrouped.add(id);
      continue;
    }
    entries.push({ id, relativeDir });
  }

  if (entries.length === 0) return { depth: 0, groups: [], ungroupedNodeIds: [...ungrouped] };

  const maxRelativeDepth = entries.reduce((deepest, entry) => {
    const segments = entry.relativeDir.split('/').filter(Boolean).length;
    return Math.max(deepest, segments);
  }, 0);

  // Deeper slicing only ever refines a group, so the count is non-decreasing
  // with depth and the first depth that breaks the bound ends the search.
  let depth = 0;
  for (let candidate = 1; candidate <= maxRelativeDepth; candidate += 1) {
    if (countGroups(entries, prefix, candidate) > maxGroups) break;
    depth = candidate;
  }
  // The overview must keep a directory layer; a group view may collapse to the
  // prefix itself when the subtree has no deeper directory to show.
  if (depth === 0 && prefix === '') depth = maxRelativeDepth > 0 ? 1 : 0;

  const byPrefix = new Map<string, string[]>();
  for (const entry of entries) {
    const groupPrefix = prefixAt(prefix, entry.relativeDir, depth);
    const group = byPrefix.get(groupPrefix);
    if (group === undefined) byPrefix.set(groupPrefix, [entry.id]);
    else group.push(entry.id);
  }

  // Fold single-member directories back into the ungrouped set: their one node
  // is drawn as itself, so no `(1)` box survives into either view. Folding
  // happens AFTER the depth choice (the depth rule still answers how many
  // directory layers the graph needs) and before any drawing, so the caller's
  // edge aggregation simply sees those nodes as individual aliases.
  const groups: AdaptiveGroup[] = [];
  for (const [groupPrefix, nodeIds] of [...byPrefix.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (nodeIds.length < 2) {
      for (const id of nodeIds) ungrouped.add(id);
      continue;
    }
    groups.push({ prefix: groupPrefix, nodeIds, count: nodeIds.length });
  }

  const ungroupedNodeIds = ids.filter((id) => ungrouped.has(id));
  return { depth, groups, ungroupedNodeIds };
}
