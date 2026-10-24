/**
 * The architecture tile's structural delta — "what changed in the project's structure since the
 * snapshot you last saw".
 *
 * The reading is deliberately FACTUAL. It reports what moved between two
 * `ArchitectureStructureSnapshot`s: which package cycles appeared or disappeared (with their
 * members), which cross-package edges are new (and which of those reverse an existing dependency
 * or cross a declared layer the wrong way), and which packages grew the most. It never says
 * whether that is a regression — that is a semantic judgment, and it belongs to a reader (or a
 * later, explicitly advisory tier), not to this producer.
 *
 * SIZE CALIBER — `additionsShare`. A package's size is its Entity count in the merged ArchGuard
 * index (the same `idToFile` key space the architecture tab draws). Growth is the signed
 * difference between two snapshots; `additionsShare` is the package's share of ALL added
 * entities between those snapshots (`added / Σ added`, 0 when nothing was added). The caliber is
 * stated on every reading (`sizeCaliber`/`sizeUnit`) because a growth ranking without its unit is
 * not a reading. The blind-spot declaration in `blind-spots.ts` names the same caliber.
 *
 * "Growth returned to a central package" is mechanical too: the central package is the one with
 * the largest package-level fan-in; the reading says `true` when that package is among the
 * top-five growers, and reports the central package's own `additionsShare` either way.
 *
 * Consumers: `server/modules/observation/architecture-delta.producer.ts` (the write path) and
 * `server/modules/observation/tests/architecture-delta.test.ts` (the criterion).
 */
import type {
  ArchitectureStructureCycle,
  ArchitectureStructureEdge,
  ArchitectureStructureSnapshot,
} from '@/modules/architecture/index.js';

/** The size caliber every reading carries; spelled once so the digest and tests cannot drift. */
export const ARCHITECTURE_SIZE_CALIBER = 'additionsShare' as const;

/** How many growth rows the tile reports. */
export const ARCHITECTURE_GROWTH_TOP_N = 5;

/**
 * How many items of each kind the human-readable delta list spells out before it summarises the
 * rest. The full sets stay in the digest; this only bounds what a tile's delta rows show.
 */
const DELTA_ITEM_LIMIT = 5;

/** One package's growth between two snapshots, in the `additionsShare` caliber. */
export type ArchitectureGrowthRow = {
  readonly package: string;
  readonly added: number;
  readonly removed: number;
  readonly growth: number;
  /** `added / Σ added` across every package; 0 when no entity was added. */
  readonly additionsShare: number;
};

/** Two package edges as the preview passes them to the architecture tab's highlight set. */
export type ArchitectureDiffPackageEdge = {
  readonly from: string;
  readonly to: string;
};

/** The complete structural difference between two snapshots. */
export type ArchitectureStructuralDiff = {
  /** The snapshot the reader last saw, or null for the project's first reading. */
  readonly fromSnapshotId: string | null;
  readonly toSnapshotId: string;
  readonly addedCycles: readonly ArchitectureStructureCycle[];
  readonly removedCycles: readonly ArchitectureStructureCycle[];
  /** Every package edge present now and absent before. */
  readonly newEdges: readonly ArchitectureStructureEdge[];
  /** New edges whose opposite direction existed before or now (a two-way dependency). */
  readonly newReverseEdges: readonly ArchitectureStructureEdge[];
  /** New edges whose two ends sit in different declared layers (declaration-only). */
  readonly newCrossLayerEdges: readonly ArchitectureStructureEdge[];
  /** New edges from an inner layer to an outer one — a declared-direction violation. */
  readonly newLayerViolations: readonly ArchitectureStructureEdge[];
  readonly growthTop5: readonly ArchitectureGrowthRow[];
  readonly sizeCaliber: typeof ARCHITECTURE_SIZE_CALIBER;
  readonly sizeUnit: 'entity';
  readonly totalAdded: number;
  /** The largest-fan-in package, or null when the snapshot has no cross-package edge. */
  readonly hubPackage: string | null;
  readonly hubAdditionsShare: number;
  readonly growthReturnedToHubs: boolean;
  /** Packages named anywhere in the diff; the architecture tab highlights them. */
  readonly diffPackages: readonly string[];
  /** New package edges, in the same shape the tab's deep link carries. */
  readonly diffPackageEdges: readonly ArchitectureDiffPackageEdge[];
  /** Tile-ready sentences stating the facts (bounded per kind). */
  readonly deltaItems: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a persisted snapshot back out of an observation digest.
 *
 * The digest is JSON an older release (or a hand-edited row) may have written, so every level is
 * checked: a malformed snapshot answers null, which the producer treats as "no previous reading"
 * instead of diffing against garbage.
 */
export function readStructureSnapshot(value: unknown): ArchitectureStructureSnapshot | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null;
  if (!Array.isArray(value.packages) || !Array.isArray(value.edges) || !Array.isArray(value.cycles)) {
    return null;
  }
  for (const entry of value.packages) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.entities !== 'number') return null;
    if (typeof entry.files !== 'number') return null;
  }
  for (const entry of value.edges) {
    if (!isRecord(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string') return null;
    if (typeof entry.weight !== 'number') return null;
  }
  for (const entry of value.cycles) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !Array.isArray(entry.members)) return null;
    if (!entry.members.every((member: unknown) => typeof member === 'string')) return null;
  }
  const layers = isRecord(value.layers) ? value.layers : null;
  return {
    id: value.id,
    packages: value.packages.map((entry) => ({
      id: String((entry as Record<string, unknown>).id),
      files: Number((entry as Record<string, unknown>).files),
      entities: Number((entry as Record<string, unknown>).entities),
      layer: typeof (entry as Record<string, unknown>).layer === 'string'
        ? String((entry as Record<string, unknown>).layer)
        : null,
    })),
    edges: value.edges.map((entry) => ({
      from: String((entry as Record<string, unknown>).from),
      to: String((entry as Record<string, unknown>).to),
      weight: Number((entry as Record<string, unknown>).weight),
    })),
    cycles: value.cycles.map((entry) => ({
      key: String((entry as Record<string, unknown>).key),
      members: ((entry as Record<string, unknown>).members as unknown[]).map(String),
    })),
    totals: {
      packages: value.packages.length,
      entities: value.packages.reduce(
        (total, entry) => total + Number((entry as Record<string, unknown>).entities),
        0,
      ),
      files: value.packages.reduce(
        (total, entry) => total + Number((entry as Record<string, unknown>).files),
        0,
      ),
      edges: value.edges.length,
    },
    layers: layers === null ? null : (layers as unknown as ArchitectureStructureSnapshot['layers']),
  };
}

function edgeKey(edge: { readonly from: string; readonly to: string }): string {
  return `${edge.from}\u0000${edge.to}`;
}

/** A stable, reader-friendly spelling of one cycle: every member, then back to the first. */
function cycleLabel(cycle: ArchitectureStructureCycle): string {
  return `${cycle.members.join(' → ')} → ${cycle.members[0] ?? ''}`;
}

/** Bounds one kind's rows and appends "另有 N 条" instead of dropping them silently. */
function capItems(items: readonly string[], label: string): string[] {
  if (items.length <= DELTA_ITEM_LIMIT) return [...items];
  const shown = items.slice(0, DELTA_ITEM_LIMIT);
  shown.push(`另有 ${items.length - DELTA_ITEM_LIMIT} 条${label}`);
  return shown;
}

/** The declared layer index of a package, or null when the declaration does not cover it. */
function layerIndexOf(
  packageId: string,
  snapshot: ArchitectureStructureSnapshot,
): number | null {
  const declaration = snapshot.layers;
  if (declaration === null) return null;
  for (let index = 0; index < declaration.layers.length; index += 1) {
    const layer = declaration.layers[index]!;
    for (const prefix of layer.packages) {
      if (packageId === prefix || packageId.startsWith(`${prefix}/`)) return index;
    }
  }
  return null;
}

/** The layer name at a declared index, for the sentence a violation writes. */
function layerNameOf(snapshot: ArchitectureStructureSnapshot, index: number): string {
  return snapshot.layers?.layers[index]?.name ?? String(index);
}

/**
 * Diffs two snapshots. `previous === null` is the project's FIRST reading: there is nothing to
 * compare against, so no cycle is called "new" and the delta says so explicitly.
 */
export function diffArchitectureStructures(
  previous: ArchitectureStructureSnapshot | null,
  current: ArchitectureStructureSnapshot,
): ArchitectureStructuralDiff {
  const previousEdges = new Set((previous?.edges ?? []).map(edgeKey));
  const currentEdges = new Set(current.edges.map(edgeKey));
  const previousCycles = new Map((previous?.cycles ?? []).map((cycle) => [cycle.key, cycle]));
  const currentCycles = new Map(current.cycles.map((cycle) => [cycle.key, cycle]));

  const newEdges = previous === null
    ? []
    : current.edges.filter((edge) => !previousEdges.has(edgeKey(edge)));
  const newReverseEdges = newEdges.filter((edge) => {
    const reverse = edgeKey({ from: edge.to, to: edge.from });
    return previousEdges.has(reverse) || currentEdges.has(reverse);
  });

  const addedCycles = previous === null
    ? []
    : current.cycles.filter((cycle) => !previousCycles.has(cycle.key));
  const removedCycles = previous === null
    ? []
    : (previous?.cycles ?? []).filter((cycle) => !currentCycles.has(cycle.key));

  // Layer readings exist only when the project declares layers; a project without a declaration
  // reports plain new edges, exactly as the task specifies.
  const newCrossLayerEdges: ArchitectureStructureEdge[] = [];
  const newLayerViolations: ArchitectureStructureEdge[] = [];
  if (current.layers !== null) {
    for (const edge of newEdges) {
      const fromLayer = layerIndexOf(edge.from, current);
      const toLayer = layerIndexOf(edge.to, current);
      if (fromLayer === null || toLayer === null || fromLayer === toLayer) continue;
      newCrossLayerEdges.push(edge);
      // Outer layers are listed first, so depending on an EARLIER entry is the declared
      // direction and depending on a LATER one is the violation.
      if (fromLayer > toLayer) newLayerViolations.push(edge);
    }
  }

  // ---- growth, in the additionsShare caliber ---------------------------------------------
  const previousSize = new Map((previous?.packages ?? []).map((entry) => [entry.id, entry.entities]));
  const currentSize = new Map(current.packages.map((entry) => [entry.id, entry.entities]));
  const packageIds = [...new Set([...previousSize.keys(), ...currentSize.keys()])].sort();
  const rawRows = packageIds.map((packageId) => {
    const before = previousSize.get(packageId) ?? 0;
    const after = currentSize.get(packageId) ?? 0;
    const growth = after - before;
    return {
      package: packageId,
      added: Math.max(0, growth),
      removed: Math.max(0, -growth),
      growth,
    };
  });
  const totalAdded = rawRows.reduce((total, row) => total + row.added, 0);
  const shareOf = (added: number): number =>
    totalAdded === 0 ? 0 : Math.round((added / totalAdded) * 1000) / 1000;
  const growthRows: ArchitectureGrowthRow[] = rawRows.map((row) => ({
    ...row,
    additionsShare: shareOf(row.added),
  }));
  const growthTop5 = growthRows
    .filter((row) => row.growth > 0)
    .sort((left, right) => right.growth - left.growth || left.package.localeCompare(right.package))
    .slice(0, ARCHITECTURE_GROWTH_TOP_N);

  const fanIn = new Map<string, number>();
  for (const edge of current.edges) fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  const hubPackage = [...fanIn.entries()]
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([packageId]) => packageId)[0] ?? null;
  const hubRow = hubPackage === null
    ? null
    : growthRows.find((row) => row.package === hubPackage) ?? null;
  const growthReturnedToHubs = hubPackage !== null
    && growthTop5.some((row) => row.package === hubPackage);
  const hubAdditionsShare = hubRow?.additionsShare ?? 0;

  // ---- the packages / edges the preview highlights ---------------------------------------
  const diffPackages = [...new Set([
    ...addedCycles.flatMap((cycle) => cycle.members),
    ...removedCycles.flatMap((cycle) => cycle.members),
    ...newEdges.flatMap((edge) => [edge.from, edge.to]),
    ...growthTop5.map((row) => row.package),
  ])].sort();
  const diffPackageEdges = [...new Map(
    newEdges.map((edge) => [edgeKey(edge), { from: edge.from, to: edge.to }]),
  ).values()].sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );

  // ---- tile-ready sentences ---------------------------------------------------------------
  const items: string[] = [];
  if (previous === null) {
    items.push(
      `首次结构快照：${current.totals.packages} 个包、${current.totals.edges} 条跨包依赖、`
      + `${current.cycles.length} 个环（规模口径：${ARCHITECTURE_SIZE_CALIBER}，单位：实体数）`,
    );
  } else {
    items.push(...capItems(addedCycles.map((cycle) => `新增环 ${cycleLabel(cycle)}`), '新增环'));
    items.push(...capItems(removedCycles.map((cycle) => `消失环 ${cycleLabel(cycle)}`), '消失环'));

    if (current.layers !== null) {
      items.push(
        ...capItems(
          newLayerViolations.map((edge) => {
            const fromLayer = layerIndexOf(edge.from, current);
            const toLayer = layerIndexOf(edge.to, current);
            return `新增反向跨层依赖 ${edge.from} → ${edge.to}（${layerNameOf(current, fromLayer!)} 依赖外层 ${layerNameOf(current, toLayer!)}）`;
          }),
          '跨层反向依赖',
        ),
      );
      const declaredDirection = newCrossLayerEdges.filter((edge) => !newLayerViolations.includes(edge));
      items.push(
        ...capItems(
          declaredDirection.map((edge) => {
            const fromLayer = layerIndexOf(edge.from, current);
            const toLayer = layerIndexOf(edge.to, current);
            return `新增跨层依赖 ${edge.from} → ${edge.to}（${layerNameOf(current, fromLayer!)} → ${layerNameOf(current, toLayer!)}）`;
          }),
          '跨层依赖',
        ),
      );
    } else {
      const reverseKeys = new Set(newReverseEdges.map(edgeKey));
      items.push(
        ...capItems(
          newEdges
            .filter((edge) => !reverseKeys.has(edgeKey(edge)))
            .map((edge) => `新增依赖 ${edge.from} → ${edge.to}`),
          '新增依赖',
        ),
      );
    }

    items.push(
      ...capItems(
        newReverseEdges.map((edge) => `新增反向依赖 ${edge.from} → ${edge.to}（${edge.to} → ${edge.from} 已在）`),
        '反向依赖',
      ),
    );

    if (growthTop5.length > 0) {
      items.push(
        `规模增长前 ${growthTop5.length}：${growthTop5
          .map((row) => `${row.package} +${row.growth}（占新增 ${Math.round(row.additionsShare * 100)}%）`)
          .join('；')}`,
      );
      if (hubPackage !== null) {
        items.push(
          growthReturnedToHubs
            ? `增长回流中心模块 ${hubPackage}（占新增 ${Math.round(hubAdditionsShare * 100)}%）`
            : `增长未回流中心模块 ${hubPackage}（占新增 ${Math.round(hubAdditionsShare * 100)}%）`,
        );
      }
    }
    if (items.length === 0) {
      items.push(`结构无变化（快照 ${current.id}）`);
    }
  }

  return {
    fromSnapshotId: previous?.id ?? null,
    toSnapshotId: current.id,
    addedCycles,
    removedCycles,
    newEdges,
    newReverseEdges,
    newCrossLayerEdges,
    newLayerViolations,
    growthTop5,
    sizeCaliber: ARCHITECTURE_SIZE_CALIBER,
    sizeUnit: 'entity',
    totalAdded,
    hubPackage,
    hubAdditionsShare,
    growthReturnedToHubs,
    diffPackages,
    diffPackageEdges,
    deltaItems: items,
  };
}
