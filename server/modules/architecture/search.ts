/**
 * Project-wide entity search and `(file, name)` resolution for manual curation.
 *
 * The graph endpoint only answers a session's neighbourhood, so an entity the
 * reader wants to PIN may not be in the payload at all. This module searches
 * the whole merged project index (every scope) instead, and it is also the
 * re-anchoring half of the curation store: after a re-analysis the entity ids
 * can change, while `(file, name)` is stable, so the client asks this module to
 * resolve its saved items back onto the CURRENT ids.
 *
 * Pure by design — it reads one merged `ArchIndex` and nothing else; the
 * service owns the project lookup, the scope merge and the cache. That keeps
 * the ranking rules testable without a filesystem and keeps this file from
 * importing a sibling module's orchestration.
 */
import type { ArchIndex, EntityKind } from './generator.js';

/** The most results one query answers ("最多 20 条"). */
export const SEARCH_MAX_RESULTS = 20;

/** The shortest query the endpoint accepts; below this, ranking is meaningless. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** One searchable entity, in the shape the client's curation list stores. */
export type ArchitectureSearchHit = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  /** The entity's normalised kind, when its scope's `arch.json` was readable. */
  readonly kind?: EntityKind;
};

/** The `(file, name)` pair a curation item re-anchors on. */
export type ArchitectureSearchTarget = {
  readonly name: string;
  readonly file: string;
};

/** The query form's answer. */
export type ArchitectureSearchQueryResult = {
  readonly results: readonly ArchitectureSearchHit[];
  /** True when more entities matched than the bounded result list carries. */
  readonly truncated: boolean;
};

export type ArchitectureSearchOptions = {
  /** Requested result cap; bounded to {@link SEARCH_MAX_RESULTS}. */
  readonly limit?: number;
  /** Restrict hits to these entity kinds. Omitted means every kind. */
  readonly kinds?: readonly EntityKind[];
};

/** One index entry with the match rank it earned (lower is better). */
type RankedHit = { readonly hit: ArchitectureSearchHit; readonly rank: number };

/**
 * Match rank for one entity; `null` means "does not match".
 *
 * The order is the task's: exact name, then name prefix, then a name/file
 * substring. A file-only hit ranks last because the reader typed an entity
 * name, not a path — but it still finds an entity whose box shows that path.
 */
function matchRank(name: string, file: string, needle: string): number | null {
  const lowerName = name.toLowerCase();
  if (lowerName === needle) return 0;
  if (lowerName.startsWith(needle)) return 1;
  if (lowerName.includes(needle)) return 2;
  if (file.toLowerCase().includes(needle)) return 3;
  return null;
}

/**
 * Search every entity in the merged index.
 *
 * Determinism: results are ordered by (rank, name, id), so two runs over the
 * same index are byte-identical. A `kinds` filter drops entities with no
 * readable detail: the axis was asked for explicitly, and "unknown kind" is not
 * a member of any kind the caller named.
 */
export function searchEntities(
  index: ArchIndex,
  query: string,
  options: ArchitectureSearchOptions = {},
): ArchitectureSearchQueryResult {
  const needle = query.trim().toLowerCase();
  const limit = Math.min(options.limit ?? SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS);
  const ranked: RankedHit[] = [];

  for (const id of Object.keys(index.idToName)) {
    const name = index.idToName[id];
    const file = index.idToFile[id];
    if (name === undefined || file === undefined) continue;
    const kind = index.entityDetails?.[id]?.kind;
    if (options.kinds !== undefined && (kind === undefined || !options.kinds.includes(kind))) continue;
    const rank = matchRank(name, file, needle);
    if (rank === null) continue;
    ranked.push({
      rank,
      hit: { id, name, file, ...(kind === undefined ? {} : { kind }) },
    });
  }

  ranked.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.hit.name !== right.hit.name) return left.hit.name < right.hit.name ? -1 : 1;
    return left.hit.id < right.hit.id ? -1 : left.hit.id > right.hit.id ? 1 : 0;
  });

  return {
    results: ranked.slice(0, limit).map((entry) => entry.hit),
    truncated: ranked.length > limit,
  };
}

/**
 * Resolve `(file, name)` pairs to the CURRENT ids, in request order.
 *
 * `null` means "this analysis has no such entity"; the caller keeps the saved
 * item and marks it stale rather than silently dropping the reader's choice.
 * When two ids share a file and a name (a duplicate the merge could not
 * collapse), the lexicographically smallest id wins, which keeps the answer
 * deterministic across runs.
 */
export function resolveEntities(
  index: ArchIndex,
  targets: readonly ArchitectureSearchTarget[],
): readonly (ArchitectureSearchHit | null)[] {
  const byIdentity = new Map<string, string[]>();
  for (const id of Object.keys(index.idToName)) {
    const name = index.idToName[id];
    const file = index.idToFile[id];
    if (name === undefined || file === undefined) continue;
    const key = `${file}\u0000${name}`;
    const ids = byIdentity.get(key);
    if (ids === undefined) byIdentity.set(key, [id]);
    else ids.push(id);
  }

  return targets.map((target) => {
    const ids = byIdentity.get(`${target.file}\u0000${target.name}`);
    if (ids === undefined || ids.length === 0) return null;
    const id = [...ids].sort()[0];
    const kind = index.entityDetails?.[id]?.kind;
    return { id, name: target.name, file: target.file, ...(kind === undefined ? {} : { kind }) };
  });
}
