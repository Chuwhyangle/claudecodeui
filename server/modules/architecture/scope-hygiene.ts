/**
 * Scope hygiene — the "several `.archguard` scopes → one honest index" rules
 * (architecture-scope-hygiene).
 *
 * An ArchGuard manifest may carry scopes that overlap (a project-root scope, a
 * `src/` scope and a deep sub-directory scope all indexing the same files),
 * scopes whose ids are absolute paths (the upstream parser's `workspaceRoot`
 * never reached the id/file canonicaliser), and scopes that belong to a
 * DIFFERENT project entirely (the manifest's `globalScopeKey` is not a
 * containment guarantee, so it is deliberately never read here).
 *
 * This module owns the pure transform from those scopes to the single
 * {@link ArchIndex} the generator draws:
 *
 *  1. **id normalisation** — an entity id that starts with `/` loses the
 *     project root (or, failing that, its leading slashes), so the merged id
 *     never begins with `/` and never contains `//`;
 *  2. **overlap de-duplication** — entities are compared by the canonical key
 *     `(project-relative file, entity name)`; the copy coming from the OUTER
 *     source directory wins (an explicit `parentScopeKey` wins over the path
 *     heuristic), and every reference to a discarded id is re-pointed at the
 *     retained one (no self-loops, no duplicate edges, no dropped edges);
 *  3. **outside-root scopes** — a scope whose sources are all outside the
 *     project root contributes no entity at all and is reported as a
 *     diagnostic instead;
 *  4. **upstream metadata first** — `outsideProjectRoot`/`parentScopeKey`, when
 *     present on a manifest entry, are trusted instead of the heuristics; both
 *     are optional, so an old manifest (every manifest on disk today) keeps
 *     working through the heuristics.
 *
 * The rules only change the MERGED result: no scope's own `arch-index.json` or
 * `arch.json` is read differently, and a project with one scope, relative ids
 * and no overlap merges exactly as it did before (see {@link ScopeHygieneResult}).
 *
 * Consumers: `server/modules/architecture/service.ts` (the graph/mentions read
 * path), and `server/modules/architecture/tests/architecture-routes.test.ts`.
 */
import path from 'node:path';

import type { ArchIndex, EntityDetail, RelationType } from './generator.js';

/**
 * Version of the merge rules above.
 *
 * The compiled reading is memoised by content in `cache.ts`, so a rule change
 * that did not move the key would keep serving readings merged by the OLD
 * rules. This string is therefore part of the reading key: bump it whenever the
 * merge output for an unchanged input can change.
 *
 * Consumers: `service.ts` (passes it as `rulesVersion`) and
 * `tests/cache-invalidation.test.ts`.
 */
export const SCOPE_HYGIENE_RULES_VERSION = 'scope-hygiene@1';

//----------------- INPUT AND OUTPUT SHAPES ------------

/**
 * One manifest scope plus its parsed index, as the merge reads it.
 *
 * `sourcePrefix` is the project-relative directory the index's keys are
 * relative to (computed by the service from `sources`); `generatedAt` is the
 * analysis time the index itself records and is only used to break a tie
 * between two scopes indexing the SAME source directory.
 */
export type HygieneScope = {
  readonly key: string;
  readonly label?: string;
  /** The manifest's `sources`, verbatim (absolute or project-relative). */
  readonly sources: readonly string[];
  /** Project-relative POSIX prefix that makes an index key project-relative. */
  readonly sourcePrefix: string;
  /** `arch-index.json`'s `generatedAt`, or `null` when it recorded none. */
  readonly generatedAt: string | null;
  /** Upstream metadata: the scope was analysed from outside the project root. */
  readonly outsideProjectRoot?: boolean;
  /** Upstream metadata: the scope this one is nested inside. */
  readonly parentScopeKey?: string;
  readonly index: ArchIndex;
};

/** A scope ignored because it does not index this project at all. */
export type DroppedOutsideRootScope = {
  readonly scope: string;
  readonly label: string;
  readonly sources: readonly string[];
};

/** A scope that lost at least one entity to an outer scope indexing the same file. */
export type SubsumedScope = {
  readonly scope: string;
  readonly label: string;
  /** The retained scope whose entity now represents the shared canonical keys. */
  readonly intoScope: string;
  readonly droppedEntities: number;
};

/**
 * What the merge did, in the shape the interface's "scope cleanup" readout and
 * the provenance carry.
 *
 * `total`/`kept` are scope counts; `subsumed` may describe a scope that still
 * contributes unique entities (it only lost the overlapping ones), so
 * `kept + subsumed.length + droppedOutsideRoot.length` is NOT necessarily
 * `total` — `kept` counts scopes that still place at least one entity.
 */
export type ScopeHygiene = {
  readonly total: number;
  readonly kept: number;
  readonly droppedOutsideRoot: readonly DroppedOutsideRootScope[];
  readonly subsumed: readonly SubsumedScope[];
  readonly normalizedAbsoluteIds: number;
};

/** The merged index plus the hygiene reading that explains it. */
export type ScopeHygieneResult = {
  readonly index: ArchIndex;
  readonly hygiene: ScopeHygiene;
};

/** Construction options for {@link mergeScopesWithHygiene}. */
export type ScopeHygieneOptions = {
  /** Absolute project root. */
  readonly projectPath: string;
  readonly scopes: readonly HygieneScope[];
  /**
   * Resolves a path for containment comparison. The service injects
   * `realpath` (falling back to `path.resolve`), because ArchGuard normalises
   * symlink aliases (`/home/...` vs `/data/...`) and a raw string comparison
   * would misread this project's own scope as "outside".
   *
   * Defaults to `path.resolve`, which is correct for a caller with no symlink
   * aliases in play (the criteria inject their own when they test one).
   */
  readonly canonicalizePath?: (value: string) => string;
};

// ---------------------------

/** The separator that keeps `(file, name)` keys unambiguous. */
const CANONICAL_KEY_SEPARATOR = '\u0000';

/** One entity placed by one scope, as the de-duplication compares it. */
type EntityCandidate = {
  readonly scopeKey: string;
  readonly mergedId: string;
  readonly file: string;
  readonly name: string;
};

/** A scope prepared for the merge: its normalised ids and whether it survives. */
type ScopePlan = {
  readonly scope: HygieneScope;
  readonly dropped: boolean;
  readonly mergedIds: Map<string, string>;
  readonly normalizedIds: Set<string>;
};

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Remove a trailing separator so `prefix + '/'` compares without doubling. */
function trimTrailingSeparator(value: string): string {
  return value.length > 1 && value.endsWith(path.sep) ? value.slice(0, -1) : value;
}

/** `value` relative to `prefix`, or `null` when `value` is not under it. */
function stripPrefix(value: string, prefix: string): string | null {
  if (value === prefix) return '';
  const withSeparator = prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`;
  return value.startsWith(withSeparator) ? value.slice(withSeparator.length) : null;
}

/** Collapse empty path segments so a normalised id can never contain `//`. */
function collapseSeparators(value: string): string {
  return value
    .split('/')
    .filter((segment, index) => !(segment === '' && index > 0))
    .join('/');
}

/** A manifest scope's human label, falling back to its key. */
function labelOf(scope: HygieneScope): string {
  return scope.label ?? scope.key;
}

/**
 * True when a source directory lies inside the project root.
 *
 * Relative sources are read as project-relative (the manifest may record
 * either form); absolute ones are compared after canonicalisation, so a scope
 * reached through a symlink alias still counts as this project's.
 */
function isInsideProject(
  canonicalRoot: string,
  canonicalize: (value: string) => string,
  source: string,
): boolean {
  if (!path.isAbsolute(source)) {
    const relative = path.posix.normalize(toPosix(source));
    return relative !== '..' && !relative.startsWith('../');
  }
  const canonicalSource = canonicalize(source);
  return stripPrefix(canonicalSource, canonicalRoot) !== null;
}

/** The project-relative form of an absolute id/file, or `null` when it is outside. */
function projectRelativeValue(
  projectPath: string,
  canonicalRoot: string,
  value: string,
): string | null {
  const trimmedProjectPath = trimTrailingSeparator(projectPath);
  return stripPrefix(value, trimmedProjectPath) ?? stripPrefix(value, canonicalRoot);
}

/**
 * Normalise one scope-level path (an entity id or an index file key) into the
 * merged project-relative key space.
 *
 * A relative value keeps the legacy `sourcePrefix + '/' + value` shape. An
 * ABSOLUTE value already names a project-relative location once the root is
 * stripped, so it must NOT be prefixed again; an absolute value outside the
 * root loses its leading slash instead (the scope itself is normally dropped
 * by rule 3 before this matters).
 */
function normalizeScopeValue(
  projectPath: string,
  canonicalRoot: string,
  prefix: string,
  value: string,
  applyPrefix: boolean,
): string {
  const source = toPosix(value);
  if (!source.startsWith('/')) {
    const normalized = source.replace(/^\.\//, '');
    if (!applyPrefix || prefix.length === 0) return collapseSeparators(normalized);
    return collapseSeparators(`${prefix}/${normalized}`);
  }

  const relative = projectRelativeValue(projectPath, canonicalRoot, source);
  const stripped = relative ?? source.replace(/^\/+/, '');
  return collapseSeparators(stripped);
}

/** The canonical de-duplication key: project-relative file plus entity name. */
function canonicalKey(file: string, name: string): string {
  return `${file}${CANONICAL_KEY_SEPARATOR}${name}`;
}

/**
 * True when `ancestorKey` is an ancestor of `scopeKey` through the optional
 * upstream `parentScopeKey` links. A cycle (a malformed manifest) stops the
 * walk rather than looping.
 */
function isAncestorScope(
  scopes: ReadonlyMap<string, HygieneScope>,
  ancestorKey: string,
  scopeKey: string,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = scopes.get(scopeKey)?.parentScopeKey;
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestorKey) return true;
    seen.add(current);
    current = scopes.get(current)?.parentScopeKey;
  }
  return false;
}

/** Number of path segments in a prefix, used only to order "outer" scopes. */
function prefixDepth(prefix: string): number {
  return prefix.length === 0 ? 0 : prefix.split('/').length;
}

/**
 * Pick the entity a canonical-key group keeps.
 *
 * Upstream `parentScopeKey` wins when it names the relationship (an ancestor is
 * outer by construction). Otherwise the shorter source prefix is outer — the
 * sweep that produced the duplicates analysed the same file from a directory
 * higher up. Equal sources fall back to the newest analysis, then to the scope
 * key so the choice never depends on manifest order.
 */
function chooseKeeper(
  candidates: readonly EntityCandidate[],
  scopesByKey: ReadonlyMap<string, HygieneScope>,
): EntityCandidate {
  return candidates.reduce((best, candidate) => {
    if (candidate.scopeKey === best.scopeKey) return best;
    const candidateScopes = scopesByKey.get(candidate.scopeKey);
    const bestScopes = scopesByKey.get(best.scopeKey);
    if (candidateScopes !== undefined && bestScopes !== undefined) {
      if (isAncestorScope(scopesByKey, candidate.scopeKey, best.scopeKey)) return candidate;
      if (isAncestorScope(scopesByKey, best.scopeKey, candidate.scopeKey)) return best;
    }

    const candidatePrefix = candidateScopes?.sourcePrefix ?? '';
    const bestPrefix = bestScopes?.sourcePrefix ?? '';
    const candidateDepth = prefixDepth(candidatePrefix);
    const bestDepth = prefixDepth(bestPrefix);
    if (candidateDepth !== bestDepth) return candidateDepth < bestDepth ? candidate : best;
    if (candidatePrefix.length !== bestPrefix.length) {
      return candidatePrefix.length < bestPrefix.length ? candidate : best;
    }

    const candidateAt = candidateScopes?.generatedAt ?? '';
    const bestAt = bestScopes?.generatedAt ?? '';
    if (candidateAt !== bestAt) return candidateAt > bestAt ? candidate : best;
    return candidate.scopeKey < best.scopeKey ? candidate : best;
  });
}

/** Re-point every stored reference at the id that survived de-duplication. */
function applyAliases(
  index: ArchIndex,
  aliases: ReadonlyMap<string, string>,
): ArchIndex {
  const resolveId = (id: string): string => aliases.get(id) ?? id;
  const unique = (values: readonly string[]): string[] => [...new Set(values)];

  const fileToIds: Record<string, string[]> = {};
  for (const [file, ids] of Object.entries(index.fileToIds)) {
    fileToIds[file] = unique(ids.map(resolveId));
  }
  const nameToIds: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(index.nameToIds)) {
    nameToIds[name] = unique(ids.map(resolveId));
  }

  // A discarded id's entry is redundant with the keeper's own entry; keeping it
  // would resurrect a node the graph no longer draws.
  const idToFile: Record<string, string> = {};
  for (const [id, file] of Object.entries(index.idToFile)) {
    if (aliases.has(id)) continue;
    idToFile[id] = file;
  }
  const idToName: Record<string, string> = {};
  for (const [id, name] of Object.entries(index.idToName)) {
    if (aliases.has(id)) continue;
    idToName[id] = name;
  }

  // Two adjacency keys can collapse into one (both scopes had a key for the
  // same entity); merge their lists, drop the self-loop the collapse may create,
  // and never drop a neighbour.
  const adjacency = (
    source: Readonly<Record<string, readonly string[]>>,
  ): Record<string, string[]> => {
    const target: Record<string, string[]> = {};
    for (const [from, neighbours] of Object.entries(source)) {
      const keptFrom = resolveId(from);
      const bucket = (target[keptFrom] ??= []);
      for (const neighbour of neighbours) {
        const keptTo = resolveId(neighbour);
        if (keptTo === keptFrom || bucket.includes(keptTo)) continue;
        bucket.push(keptTo);
      }
    }
    return target;
  };
  const dependencies = adjacency(index.dependencies);
  const dependents = adjacency(index.dependents);

  const relationsByType: Partial<Record<RelationType, [string, string][]>> = {};
  for (const [type, pairs] of Object.entries(index.relationsByType ?? {})) {
    if (!isRelationTypeKey(type) || pairs === undefined) continue;
    const seen = new Set<string>();
    const bucket: [string, string][] = [];
    for (const [from, to] of pairs) {
      const keptFrom = resolveId(from);
      const keptTo = resolveId(to);
      if (keptFrom === keptTo) continue;
      const key = `${keptFrom}${CANONICAL_KEY_SEPARATOR}${keptTo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bucket.push([keptFrom, keptTo]);
    }
    relationsByType[type] = bucket;
  }

  let entityDetails: Record<string, EntityDetail> | undefined;
  if (index.entityDetails !== undefined) {
    entityDetails = {};
    for (const [id, detail] of Object.entries(index.entityDetails)) {
      // A discarded id hands its detail to the keeper when the keeper has none
      // — the kind/members describe the same file+name either way.
      const keptId = aliases.get(id) ?? id;
      if (entityDetails[keptId] === undefined) entityDetails[keptId] = detail;
    }
  }

  return {
    fileToIds,
    nameToIds,
    dependencies,
    dependents,
    idToFile,
    idToName,
    ...(index.relationsByType === undefined ? {} : { relationsByType }),
    ...(entityDetails === undefined ? {} : { entityDetails }),
  };
}

/** The five relation kinds; mirrors `generator.ts` without importing a value. */
function isRelationTypeKey(value: string): value is RelationType {
  return value === 'dependency' || value === 'call' || value === 'composition'
    || value === 'inheritance' || value === 'implementation';
}

/**
 * Merge every scope's index into the single `ArchIndex` the generator takes,
 * applying the four hygiene rules and reporting what they did.
 *
 * Consumers: `service.ts` (the read path) and the architecture-routes criterion.
 */
export function mergeScopesWithHygiene(options: ScopeHygieneOptions): ScopeHygieneResult {
  const projectPath = trimTrailingSeparator(options.projectPath);
  const canonicalize = options.canonicalizePath ?? ((value: string) => path.resolve(value));
  const canonicalRoot = canonicalize(projectPath);
  const scopesByKey = new Map(options.scopes.map((scope) => [scope.key, scope]));

  const plans: ScopePlan[] = options.scopes.map((scope) => {
    const outsideProjectRoot = scope.outsideProjectRoot
      ?? (scope.sources.length > 0
        && scope.sources.every((source) => !isInsideProject(canonicalRoot, canonicalize, source)));
    return {
      scope,
      dropped: outsideProjectRoot,
      mergedIds: new Map<string, string>(),
      normalizedIds: new Set<string>(),
    };
  });

  const droppedPlans = plans.filter((plan) => plan.dropped);
  const keptPlans = plans.filter((plan) => !plan.dropped);

  /** Memoised id mapping for one scope: normalisation only, no aliasing yet. */
  const mergedIdOf = (plan: ScopePlan, rawId: string): string => {
    const memo = plan.mergedIds.get(rawId);
    if (memo !== undefined) return memo;
    const normalized = normalizeScopeValue(
      projectPath,
      canonicalRoot,
      plan.scope.sourcePrefix,
      rawId,
      false,
    );
    const merged = `${plan.scope.key}/${normalized}`;
    plan.mergedIds.set(rawId, merged);
    if (rawId.startsWith('/')) plan.normalizedIds.add(rawId);
    return merged;
  };

  const mergedFileOf = (plan: ScopePlan, rawFile: string): string =>
    normalizeScopeValue(projectPath, canonicalRoot, plan.scope.sourcePrefix, rawFile, true);

  // ---- rule 2, pass one: who survives each canonical key? -------------------
  const groups = new Map<string, EntityCandidate[]>();
  for (const plan of keptPlans) {
    const { index } = plan.scope;
    const ids = new Set([...Object.keys(index.idToFile), ...Object.keys(index.idToName)]);
    for (const rawId of ids) {
      const rawFile = index.idToFile[rawId];
      const name = index.idToName[rawId];
      if (rawFile === undefined || name === undefined) continue;
      const file = mergedFileOf(plan, rawFile);
      const key = canonicalKey(file, name);
      const bucket = groups.get(key) ?? [];
      bucket.push({
        scopeKey: plan.scope.key,
        mergedId: mergedIdOf(plan, rawId),
        file,
        name,
      });
      groups.set(key, bucket);
    }
  }

  const aliases = new Map<string, string>();
  const droppedByScopePair = new Map<string, { scope: string; intoScope: string; count: number }>();

  for (const candidates of groups.values()) {
    if (candidates.length < 2) continue;
    const keeper = chooseKeeper(candidates, scopesByKey);
    for (const candidate of candidates) {
      if (candidate.mergedId === keeper.mergedId) continue;
      aliases.set(candidate.mergedId, keeper.mergedId);
      const pairKey = `${candidate.scopeKey}${CANONICAL_KEY_SEPARATOR}${keeper.scopeKey}`;
      const entry = droppedByScopePair.get(pairKey) ?? {
        scope: candidate.scopeKey,
        intoScope: keeper.scopeKey,
        count: 0,
      };
      entry.count += 1;
      droppedByScopePair.set(pairKey, entry);
    }
  }

  // ---- the merge itself (same iteration order as the pre-hygiene merge) ------
  const fileToIds: Record<string, string[]> = {};
  const nameToIds: Record<string, string[]> = {};
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  const idToFile: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  const relationsByType: Partial<Record<RelationType, [string, string][]>> = {};
  const entityDetails: Record<string, EntityDetail> = {};
  let hasDetails = false;
  const placedByScope = new Map<string, number>();

  const pushUnique = (target: string[], values: readonly string[]): void => {
    const existing = new Set(target);
    for (const value of values) {
      if (existing.has(value)) continue;
      existing.add(value);
      target.push(value);
    }
  };

  for (const plan of keptPlans) {
    const { index } = plan.scope;
    const mapId = (rawId: string): string => mergedIdOf(plan, rawId);
    const mapFile = (rawFile: string): string => mergedFileOf(plan, rawFile);
    let placed = 0;

    for (const [file, ids] of Object.entries(index.fileToIds)) {
      const target = mapFile(file);
      fileToIds[target] ??= [];
      pushUnique(fileToIds[target], ids.map(mapId));
    }
    for (const [name, ids] of Object.entries(index.nameToIds)) {
      nameToIds[name] ??= [];
      pushUnique(nameToIds[name], ids.map(mapId));
    }
    for (const [id, file] of Object.entries(index.idToFile)) {
      idToFile[mapId(id)] = mapFile(file);
      placed += 1;
    }
    for (const [id, name] of Object.entries(index.idToName)) idToName[mapId(id)] = name;
    for (const [from, neighbours] of Object.entries(index.dependencies)) {
      dependencies[mapId(from)] = neighbours.map(mapId);
    }
    for (const [to, neighbours] of Object.entries(index.dependents)) {
      dependents[mapId(to)] = neighbours.map(mapId);
    }
    for (const [type, pairs] of Object.entries(index.relationsByType ?? {})) {
      if (!isRelationTypeKey(type)) continue;
      const bucket = (relationsByType[type] ??= []);
      for (const [from, to] of pairs) bucket.push([mapId(from), mapId(to)]);
    }
    if (index.entityDetails !== undefined) {
      hasDetails = true;
      for (const [id, detail] of Object.entries(index.entityDetails)) entityDetails[mapId(id)] = detail;
    }
    placedByScope.set(plan.scope.key, placed);
  }

  const normalizedAbsoluteIds = keptPlans.reduce(
    (total, plan) => total + plan.normalizedIds.size,
    0,
  );
  const rawIndex: ArchIndex = {
    fileToIds,
    nameToIds,
    dependencies,
    dependents,
    idToFile,
    idToName,
    relationsByType,
    ...(hasDetails ? { entityDetails } : {}),
  };

  // The rewrite only runs when it has something to do. That is what keeps a
  // single-scope, relative-id, non-overlapping project byte-identical to the
  // pre-hygiene merge (including the legacy tolerance for a self-loop).
  const index = aliases.size === 0 && normalizedAbsoluteIds === 0
    ? rawIndex
    : applyAliases(rawIndex, aliases);

  // ---- diagnostics ----------------------------------------------------------
  const droppedOutsideRoot: DroppedOutsideRootScope[] = droppedPlans.map((plan) => ({
    scope: plan.scope.key,
    label: labelOf(plan.scope),
    sources: plan.scope.sources,
  }));

  const subsumed: SubsumedScope[] = [...droppedByScopePair.values()].map((entry) => {
    const owner = scopesByKey.get(entry.scope);
    return {
      scope: entry.scope,
      label: owner === undefined ? entry.scope : labelOf(owner),
      intoScope: entry.intoScope,
      droppedEntities: entry.count,
    };
  });

  // A scope "keeps" when it still places at least one entity and is not
  // outside the root; a scope whose every placed entity was a duplicate of an
  // outer scope's is subsumed (still listed in `subsumed` with its count).
  const droppedIds = new Set(aliases.keys());
  const kept = keptPlans.filter((plan) => {
    const placed = placedByScope.get(plan.scope.key) ?? 0;
    if (placed === 0) return true;
    return [...plan.mergedIds.values()].some(
      (mergedId) => idToFile[mergedId] !== undefined && !droppedIds.has(mergedId),
    );
  }).length;

  return {
    index,
    hygiene: {
      total: plans.length,
      kept,
      droppedOutsideRoot,
      subsumed,
      normalizedAbsoluteIds,
    },
  };
}
