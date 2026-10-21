import type { ArchitectureRendererGraph } from '@/modules/architecture/rendererContract';

/**
 * The hierarchy index behind the architecture diagram's level-of-detail and
 * collapsed-package counts.
 *
 * The drawn PlantUML SVG carries, for every entity, the id of its innermost
 * package (`data-package-id`, produced by the renderer from the nested
 * `package` blocks `archguardToPlantUml` emits) and its ArchGuard id
 * (`data-entity-id`). Reading the two together with the neighbourhood JSON the
 * SVG was drawn from yields the full "root → package → subpackage → entity"
 * tree without any geometric point-in-rectangle inference: the package
 * containment is the model's own, not a guess from coordinates.
 *
 * Consumers: the diagram's zoom/visibility levels, which need a package's
 * direct and total entity counts, and its ancestor chain to decide what stays
 * visible at a given depth.
 */

/**
 * Package id of the root. Entities drawn without a package — a top-level file,
 * or a renderer that predates `data-package-id` — are assigned to it.
 */
export const ROOT_PACKAGE_ID = '';

/** One entity and the innermost package the SVG assigned it to. */
export type ArchitectureHierarchyEntity = {
  readonly id: string;
  readonly packageId: string;
  /**
   * Whether the transcript selected this entity as a seed (its BFS distance is
   * 0). Optional so a caller that only needs package counts — the explosion LOD
   * — keeps working unchanged; the readable-zoom default reads it to pick the
   * package to focus.
   */
  readonly seed?: boolean;
};

/**
 * One package in the hierarchy. `id` is the full path-form package id (also the
 * `data-package-id` value), which keeps ancestor identity stable when two
 * subpackages share a leaf name.
 */
export type ArchitectureHierarchyPackage = {
  readonly id: string;
  /** The last path segment; the root's name is the empty string. */
  readonly name: string;
  /** Enclosing package id, or `null` for the root. */
  readonly parentId: string | null;
  /**
   * Enclosing packages, root-first, EXCLUDING this package. The root id
   * (`ROOT_PACKAGE_ID`) is the first link of every non-root package's chain.
   */
  readonly ancestors: readonly string[];
  /** Direct child packages, sorted so the tree renders deterministically. */
  readonly childPackageIds: readonly string[];
  /** Entities whose innermost package is this one, in graph order. */
  readonly entityIds: readonly string[];
  /** Entities directly in this package. */
  readonly directEntityCount: number;
  /** Entities in this package plus every descendant package. */
  readonly descendantEntityCount: number;
  /** Transcript seeds whose innermost package is this one. */
  readonly directSeedCount: number;
  /** Transcript seeds in this package plus every descendant package. */
  readonly descendantSeedCount: number;
};

/** The complete entity→package tree read from one drawn diagram. */
export type ArchitectureHierarchyIndex = {
  readonly rootId: string;
  readonly packages: ReadonlyMap<string, ArchitectureHierarchyPackage>;
  /** Entity id → innermost package id (`ROOT_PACKAGE_ID` for the root). */
  readonly entityPackage: ReadonlyMap<string, string>;
};

/**
 * Normalise a raw `data-package-id` value into a path-form package id.
 * Surrounding slashes and empty segments are dropped (the renderer escapes the
 * name, but a hand-built fixture may not be canonical), and a missing or empty
 * value means the root.
 */
function normalizePackageId(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return ROOT_PACKAGE_ID;
  return raw.trim().split('/').filter(Boolean).join('/');
}

/** The parent path of a package id, or `null` for the root. */
function parentOf(packageId: string): string | null {
  if (packageId === ROOT_PACKAGE_ID) return null;
  const lastSlash = packageId.lastIndexOf('/');
  return lastSlash === -1 ? ROOT_PACKAGE_ID : packageId.slice(0, lastSlash);
}

/**
 * Build the hierarchy index from entity→package assignments.
 *
 * Every ancestor package is materialised even when it holds no entity of its
 * own, so a `a/b/c` entity yields the whole chain `a` → `a/b` → `a/b/c` and the
 * counts of `a` include the entity. Duplicate entity ids keep their first
 * assignment (the graph's own order wins).
 */
export function buildHierarchyIndex(
  entities: readonly ArchitectureHierarchyEntity[],
): ArchitectureHierarchyIndex {
  const entityPackage = new Map<string, string>();
  const directEntities = new Map<string, string[]>([[ROOT_PACKAGE_ID, []]]);
  const directSeeds = new Map<string, number>([[ROOT_PACKAGE_ID, 0]]);
  const parents = new Map<string, string | null>([[ROOT_PACKAGE_ID, null]]);

  const ensurePackage = (packageId: string): void => {
    if (parents.has(packageId)) return;
    const parent = parentOf(packageId);
    if (parent !== null) ensurePackage(parent);
    parents.set(packageId, parent);
    directEntities.set(packageId, []);
    directSeeds.set(packageId, 0);
  };

  for (const entity of entities) {
    if (entityPackage.has(entity.id)) continue;
    const packageId = normalizePackageId(entity.packageId);
    ensurePackage(packageId);
    entityPackage.set(entity.id, packageId);
    directEntities.get(packageId)?.push(entity.id);
    if (entity.seed === true) directSeeds.set(packageId, (directSeeds.get(packageId) ?? 0) + 1);
  }

  const childPackageIds = new Map<string, string[]>();
  for (const packageId of parents.keys()) childPackageIds.set(packageId, []);
  for (const [packageId, parentId] of parents) {
    if (parentId === null) continue;
    childPackageIds.get(parentId)?.push(packageId);
  }
  for (const children of childPackageIds.values()) children.sort();

  // Root-first ancestor chain, memoised: `a/b/c` reuses `a/b`'s chain.
  const ancestors = new Map<string, readonly string[]>([[ROOT_PACKAGE_ID, []]]);
  const ancestorsOf = (packageId: string): readonly string[] => {
    const known = ancestors.get(packageId);
    if (known !== undefined) return known;
    const parent = parents.get(packageId) ?? null;
    const chain = parent === null ? [] : [...ancestorsOf(parent), parent];
    ancestors.set(packageId, chain);
    return chain;
  };

  // Post-order totals: a package's descendant count is its direct entities plus
  // every child's descendant count. Seed counts follow the same rule.
  const descendantCounts = new Map<string, number>();
  const descendantSeedCounts = new Map<string, number>();
  const countDescendants = (packageId: string): number => {
    const known = descendantCounts.get(packageId);
    if (known !== undefined) return known;
    const direct = directEntities.get(packageId)?.length ?? 0;
    const total = (childPackageIds.get(packageId) ?? []).reduce(
      (sum, childId) => sum + countDescendants(childId),
      direct,
    );
    descendantCounts.set(packageId, total);
    return total;
  };
  const countDescendantSeeds = (packageId: string): number => {
    const known = descendantSeedCounts.get(packageId);
    if (known !== undefined) return known;
    const direct = directSeeds.get(packageId) ?? 0;
    const total = (childPackageIds.get(packageId) ?? []).reduce(
      (sum, childId) => sum + countDescendantSeeds(childId),
      direct,
    );
    descendantSeedCounts.set(packageId, total);
    return total;
  };

  const packages = new Map<string, ArchitectureHierarchyPackage>();
  for (const [packageId, parentId] of parents) {
    const entityIds = directEntities.get(packageId) ?? [];
    const lastSlash = packageId.lastIndexOf('/');
    packages.set(packageId, {
      id: packageId,
      name: packageId === ROOT_PACKAGE_ID ? '' : packageId.slice(lastSlash + 1),
      parentId,
      ancestors: ancestorsOf(packageId),
      childPackageIds: childPackageIds.get(packageId) ?? [],
      entityIds,
      directEntityCount: entityIds.length,
      descendantEntityCount: countDescendants(packageId),
      directSeedCount: directSeeds.get(packageId) ?? 0,
      descendantSeedCount: countDescendantSeeds(packageId),
    });
  }

  return { rootId: ROOT_PACKAGE_ID, packages, entityPackage };
}

/**
 * Read the entity→package assignments from the drawn SVG, restricted to the
 * entities the neighbourhood JSON declares: overview `grp::` nodes and
 * neighbour stubs are view scaffolding with no JSON node, so they are ignored.
 */
function readHierarchyEntities(
  svg: ParentNode,
  graph: ArchitectureRendererGraph,
): ArchitectureHierarchyEntity[] {
  const packageOf = new Map<string, string>();
  for (const element of svg.querySelectorAll('[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id');
    if (id === null) continue;
    const packageId = element.getAttribute('data-package-id');
    if (packageId !== null) packageOf.set(id, packageId);
  }
  return graph.nodes.map((node) => ({
    id: node.id,
    packageId: packageOf.get(node.id) ?? ROOT_PACKAGE_ID,
  }));
}

/**
 * Build the hierarchy index for one drawn architecture view.
 *
 * `svg` is the renderer's output and `graph` is the neighbourhood JSON that
 * produced it (the source of the entity set and their order). An entity the
 * SVG drew without `data-package-id` belongs to the root by definition — there
 * is no geometric fallback.
 *
 * Consumers: the architecture diagram's zoom/visibility levels (explosion
 * zoom), which read package counts and ancestor chains from this index.
 */
export function buildHierarchyIndexFromSvg(
  svg: ParentNode,
  graph: ArchitectureRendererGraph,
): ArchitectureHierarchyIndex {
  return buildHierarchyIndex(readHierarchyEntities(svg, graph));
}
