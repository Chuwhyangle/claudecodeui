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
 * label carries the entity count (`scripts (229)`).
 *
 * Consumers: `archguardToPlantUml.ts`, which emits the collapsed overview and
 * the re-grouped group view, and the adaptive-grouping criteria test.
 */

/** How many directory groups the overview may draw before a coarser depth is chosen. */
export const OVERVIEW_GROUP_LIMIT = 40;

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
   * Nodes left out of the grouping because they sit directly in the scope root
   * (`prefix === ''` and `groupDirectNodes === false`). The overview draws them
   * as individual entities, exactly as the renderer used to.
   */
  readonly ungroupedNodeIds: readonly string[];
};

export type AdaptiveGroupingOptions = {
  /** Upper bound on groups; defaults to `OVERVIEW_GROUP_LIMIT`. */
  readonly maxGroups?: number;
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
 * Strip the leading `<scopeKey>/` from an ArchGuard id, keeping the
 * project-relative path (`src/modules/a.ts.Entity` → `modules/a.ts.Entity`).
 */
export function scopeRelativePath(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * The directory (package) path of a node: the scope-relative path without its
 * last segment. `src/a/b/c/D.ts.D` → `a/b/c`; a scope-root file → `''`.
 */
export function directoryPathOf(id: string): string {
  const rel = scopeRelativePath(id);
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
 */
export function computeAdaptiveGrouping(
  ids: readonly string[],
  options: AdaptiveGroupingOptions = {},
): AdaptiveGrouping {
  const maxGroups = options.maxGroups ?? OVERVIEW_GROUP_LIMIT;
  const prefix = options.prefix ?? '';
  const groupDirectNodes = options.groupDirectNodes ?? false;

  const entries: { readonly id: string; readonly relativeDir: string }[] = [];
  const ungroupedNodeIds: string[] = [];
  for (const id of ids) {
    const directory = directoryPathOf(id);
    if (prefix !== '' && directory !== prefix && !directory.startsWith(`${prefix}/`)) continue;
    const relativeDir = prefix === '' || directory === prefix
      ? (prefix === '' ? directory : '')
      : directory.slice(prefix.length + 1);
    if (relativeDir === '' && !groupDirectNodes) {
      ungroupedNodeIds.push(id);
      continue;
    }
    entries.push({ id, relativeDir });
  }

  if (entries.length === 0) return { depth: 0, groups: [], ungroupedNodeIds };

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

  const groups = [...byPrefix.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([groupPrefix, nodeIds]) => ({ prefix: groupPrefix, nodeIds, count: nodeIds.length }));

  return { depth, groups, ungroupedNodeIds };
}
