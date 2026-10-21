/**
 * Architecture graph service — the "request → seeds → merged index → graph"
 * orchestration of ADR-005 decisions 2, 3, 4 and 6 (AC-418).
 *
 * This is the only part of the module that touches the filesystem: it reads the
 * project's `.archguard/query/manifest.json` and each scope's
 * `arch-index.json`, then hands the pure pieces over:
 *
 *   transcript (injected reader) → extractSeeds (AC-416) → merged ArchIndex →
 *   generateGraph (AC-415) → `{ mmd, stats, provenance }`
 *
 * The result layer of the AC-417 cache memoises the generated reading by the
 * full content key (project, session, seeds, params, every scope fingerprint),
 * so a repeated tab activation re-renders nothing while a new transcript, a new
 * `.archguard` analysis or a new node budget is a miss by construction.
 *
 * Consumers:
 *  · `server/modules/architecture/routes.js` — the thin HTTP face, and
 *    `server/modules/architecture/module.js`, the composition root that binds
 *    the injected transcript/project readers.
 *  · `server/modules/projects/services/projects-with-sessions-fetch.service.js`
 *    and `server/modules/mcp-gateway/mcp-overview-tools.js` call the Tier-1
 *    {@link hasArchguardCache} path check through this module's barrel.
 *  · `server/modules/architecture/tests/architecture-routes.test.js` (AC-418).
 */
import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  createArchitectureCache,
  type ArchitectureCache,
  type ArchitectureIndexRef,
} from './cache.js';
import {
  generateGraph,
  isRelationType,
  type ArchIndex,
  type GenerateGraphResult,
  type GraphStats,
  type RelationType,
  type UnresolvedSeeds,
} from './generator.js';
import { extractSeeds } from './seed-extraction.js';

/** Where a project's ArchGuard manifest lives, relative to the project root. */
const MANIFEST_RELATIVE_PATH = path.join('.archguard', 'query', 'manifest.json');

/** Where each scope's pre-built adjacency lives, relative to the project root. */
const QUERY_RELATIVE_DIRECTORY = path.join('.archguard', 'query');

/**
 * Default node budget. It only bounds a pathological neighbourhood; the caller
 * may lower or raise it per request. `generateGraph` deliberately ships no
 * default, so the product constant has to live on the route-side caller.
 */
export const DEFAULT_MAX_NODES = 200;

/** Default BFS depth: the seed's immediate neighbours in both directions. */
export const DEFAULT_HOPS = 1;

/**
 * The separator between the project root and the scope key inside the opaque
 * `ArchitectureIndexRef.scope` string. A NUL byte cannot occur in a path, so the
 * two halves decode unambiguously.
 */
const SCOPE_SEPARATOR = '\u0000';

/**
 * A valid, empty Mermaid flowchart for the "no seeds" reading.
 *
 * The generator is intentionally NOT called on an empty seed list (AC-418: an
 * empty transcript must not spend the generation step), but the response still
 * has to carry renderable documents. The directive and declaration match the
 * generator's own so the frontend renders both identically.
 */
const EMPTY_GRAPH_MMD =
  '%%{init: {"theme": "default", "flowchart": {"htmlLabels": false}}}%%\nflowchart LR\n';

/** One scope entry of `.archguard/query/manifest.json`, as this service reads it. */
export type ArchguardManifestScope = {
  readonly key: string;
  readonly label?: string;
  /**
   * Absolute (or project-relative) directories this scope indexed. Relative
   * index keys are resolved under the first/controlling source prefix, so the
   * merge can express every scope's files as one project-relative key space.
   */
  readonly sources?: readonly string[];
};

/** The subset of `.archguard/query/manifest.json` this service reads. */
export type ArchguardManifest = {
  readonly generatedAt: string | null;
  readonly scopes: readonly ArchguardManifestScope[];
};

/** The request the route parses and hands to {@link ArchitectureService.readGraph}. */
export type ArchitectureGraphInput = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly hops?: number;
  readonly maxNodes?: number;
};

/** The generation knobs that participate in the content-addressed cache key. */
export type ArchitectureGraphParams = {
  readonly hops: number;
  readonly maxNodes: number;
};

/** How many seeds the transcript yielded, before any were resolved. */
export type ArchitectureSeedStats = {
  readonly seedFiles: number;
  readonly seedIdentifiers: number;
};

/**
 * The reading's counters: the generator's own two-graph counts, the seed counts,
 * the seeds that matched nothing, and `nodeCount`/`edgeCount` totals so a caller
 * does not have to add the four graphs up itself.
 */
export type ArchitectureGraphStats = GraphStats &
  ArchitectureSeedStats & {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly unresolved: UnresolvedSeeds;
  };

/**
 * Honesty payload (ADR-005 decision 7): when the ArchGuard analysis that backs
 * this reading was produced, which scope fingerprints were used, and whether
 * this response came from the result cache.
 */
export type ArchitectureProvenance = {
  /** `manifest.generatedAt` — the analysis time, not the request time. */
  readonly generatedAt: string | null;
  readonly fingerprints: readonly { readonly scope: string; readonly archJsonHash: string }[];
  readonly cacheHit: boolean;
};

/** The endpoint's complete body: both Mermaid documents, the counters, and provenance. */
export type ArchitectureGraphResult = {
  readonly mmd: { readonly file: string; readonly entity: string };
  readonly stats: ArchitectureGraphStats;
  readonly provenance: ArchitectureProvenance;
};

/**
 * The injected seams. Production binds them to the projects repository and the
 * providers module's full-history reader; the criterion binds temp directories
 * and a fixed transcript, and can replace `generateGraph` with a counter to
 * prove the empty-seed short circuit.
 */
export type ArchitectureServiceDeps = {
  /** Project id → absolute project root, or `null` when no such project exists. */
  readonly resolveProjectPath: (projectId: string) => string | null;
  /** One session's FULL normalized transcript. */
  readonly readSessionHistory: (sessionId: string) => Promise<readonly NormalizedMessage[]>;
  /** Generation step; overridable so a criterion can count calls. */
  readonly generateGraph?: typeof generateGraph;
};

/** The service surface consumed by the route. */
export type ArchitectureService = {
  readGraph(input: ArchitectureGraphInput): Promise<ArchitectureGraphResult>;
};

/**
 * Tier-1 gate (ADR-005 decision 1): whether a project has an ArchGuard query
 * cache. Mirrors `hasQuayConfig`: a pure path check, no parse, no subprocess.
 *
 * Consumers: the project listing (`projects-with-sessions-fetch.service.js`),
 * `mcp-overview-tools.js`, and this module's own endpoint.
 */
export function hasArchguardCache(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, MANIFEST_RELATIVE_PATH));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) => Array.isArray(entry) && entry.every((item) => typeof item === 'string'),
    )
  );
}

function requireField<T>(value: T | undefined, name: string, scope: string): T {
  if (value === undefined) {
    throw new TypeError(`arch-index for scope '${scope}' is missing '${name}'`);
  }
  return value;
}

/** Parse one scope's manifest entry, refusing the shapes this service cannot merge. */
function parseManifestScope(value: unknown): ArchguardManifestScope {
  if (!isRecord(value) || typeof value.key !== 'string' || value.key.length === 0) {
    throw new TypeError('manifest scope entries must carry a non-empty string key');
  }
  const sources = Array.isArray(value.sources)
    ? value.sources.filter((source): source is string => typeof source === 'string')
    : undefined;
  const label = typeof value.label === 'string' ? value.label : undefined;
  return { key: value.key, label, sources };
}

/**
 * Read the project's ArchGuard manifest, or `null` when the project has no
 * query cache. A present-but-unparseable manifest is an error, not "no cache":
 * reporting `hasArchguardCache: false` there would hide a broken analysis.
 */
async function readArchguardManifest(projectPath: string): Promise<ArchguardManifest | null> {
  const manifestPath = path.join(projectPath, MANIFEST_RELATIVE_PATH);
  let text: string;
  try {
    text = await fsPromises.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`ArchGuard manifest at '${manifestPath}' is not valid JSON`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.scopes)) {
    throw new Error(`ArchGuard manifest at '${manifestPath}' does not carry a scopes array`);
  }

  const scopes = parsed.scopes.map(parseManifestScope);
  const generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null;
  return { generatedAt, scopes };
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** A project-relative POSIX path, or `null` when the source lies outside the project. */
function projectRelativeSource(projectPath: string, source: string): string | null {
  if (!path.isAbsolute(source)) return toPosix(path.normalize(source));
  const relative = path.relative(projectPath, source);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return relative === '' ? '' : null;
  }
  return toPosix(relative);
}

/**
 * The prefix that turns a scope-relative index key into a project-relative one.
 *
 * A scope may name several sources; their common ancestor is the directory the
 * index's keys are relative to. A scope with no usable source keeps its keys
 * as-is (prefix `''`), which is the pre-existing single-root behaviour.
 */
function scopeSourcePrefix(projectPath: string, sources: readonly string[] | undefined): string {
  const relatives = (sources ?? [])
    .map((source) => projectRelativeSource(projectPath, source))
    .filter((relative): relative is string => relative !== null);
  if (relatives.length === 0) return '';

  const segments = relatives.map((relative) => (relative === '' ? [] : relative.split('/')));
  const common: string[] = [];
  for (let index = 0; index < segments[0].length; index += 1) {
    const candidate = segments[0][index];
    if (segments.every((parts) => parts[index] === candidate)) common.push(candidate);
    else break;
  }
  return common.join('/');
}

/** Join a scope prefix and an index key into the merged project-relative key. */
function mergeFileKey(prefix: string, file: string): string {
  const normalized = toPosix(file).replace(/^\.\//, '');
  return prefix.length === 0 ? normalized : `${prefix}/${normalized}`;
}

/**
 * One parsed scope index plus the identity the merge needs: its fingerprint and
 * the directory its keys are relative to.
 *
 * `ArchitectureScopeIndex` is the cache's `TIndex`: it must carry
 * `archJsonHash`, and the merge reads the other two fields. `sourcePrefix`
 * belongs to the manifest, not to the file, so it is stamped on at read time.
 */
type ParsedScopeIndex = ArchIndex & {
  readonly archJsonHash: string;
  readonly scopeKey: string;
  readonly sourcePrefix: string;
};

/**
 * Parse the typed-edge map a scope index may carry.
 *
 * Tolerant by design: an absent field, a non-record value, an unknown type key
 * or a malformed pair are all dropped. The generator treats `relationsByType`
 * as optional provenance for edge styling, never as the adjacency — BFS still
 * runs on `dependencies`/`dependents`.
 */
function parseRelationsByType(
  value: unknown,
): Readonly<Partial<Record<RelationType, readonly (readonly [string, string])[]>>> {
  if (!isRecord(value)) return {};
  const out: Partial<Record<RelationType, readonly (readonly [string, string])[]>> = {};
  for (const [key, pairs] of Object.entries(value)) {
    if (!isRelationType(key) || !Array.isArray(pairs)) continue;
    const typed = pairs.filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string',
    );
    if (typed.length > 0) out[key] = typed;
  }
  return out;
}

/**
 * Parse one `.archguard/query/<scope>/arch-index.json`.
 *
 * Only the seven fields the AC-415 generator reads are validated. Anything
 * else in the file (`cycles`, ...) is irrelevant here and is dropped, which is
 * also what keeps the merge shape small for the generator.
 */
async function readScopeIndex(
  projectPath: string,
  scopeKey: string,
  sourcePrefix: string,
): Promise<ParsedScopeIndex> {
  const indexPath = path.join(projectPath, QUERY_RELATIVE_DIRECTORY, scopeKey, 'arch-index.json');
  let text: string;
  try {
    text = await fsPromises.readFile(indexPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError(`ArchGuard scope '${scopeKey}' has no arch-index.json`, {
        code: 'ARCHGUARD_INDEX_MISSING',
        statusCode: 500,
        details: { scope: scopeKey, path: indexPath },
      });
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`ArchGuard index at '${indexPath}' is not valid JSON`);
  }
  if (!isRecord(parsed) || typeof parsed.archJsonHash !== 'string' || parsed.archJsonHash.length === 0) {
    throw new Error(`ArchGuard index at '${indexPath}' carries no archJsonHash`);
  }

  return {
    archJsonHash: parsed.archJsonHash,
    scopeKey,
    sourcePrefix,
    fileToIds: requireField(isStringArrayRecord(parsed.fileToIds) ? parsed.fileToIds : undefined, 'fileToIds', scopeKey),
    nameToIds: requireField(isStringArrayRecord(parsed.nameToIds) ? parsed.nameToIds : undefined, 'nameToIds', scopeKey),
    dependencies: requireField(isStringArrayRecord(parsed.dependencies) ? parsed.dependencies : undefined, 'dependencies', scopeKey),
    dependents: requireField(isStringArrayRecord(parsed.dependents) ? parsed.dependents : undefined, 'dependents', scopeKey),
    idToFile: requireField(isStringRecord(parsed.idToFile) ? parsed.idToFile : undefined, 'idToFile', scopeKey),
    idToName: requireField(isStringRecord(parsed.idToName) ? parsed.idToName : undefined, 'idToName', scopeKey),
    relationsByType: parseRelationsByType(parsed.relationsByType),
  };
}

function encodeScope(projectPath: string, scopeKey: string): string {
  return `${projectPath}${SCOPE_SEPARATOR}${scopeKey}`;
}

function decodeScope(scope: string): { projectPath: string; scopeKey: string } {
  const separator = scope.indexOf(SCOPE_SEPARATOR);
  if (separator < 0) throw new TypeError(`malformed architecture scope key '${scope}'`);
  return {
    projectPath: scope.slice(0, separator),
    scopeKey: scope.slice(separator + SCOPE_SEPARATOR.length),
  };
}

function pushUnique(target: string[], values: readonly string[]): void {
  const existing = new Set(target);
  for (const value of values) {
    if (existing.has(value)) continue;
    existing.add(value);
    target.push(value);
  }
}

/**
 * Merge every scope's index into the single `ArchIndex` the generator takes.
 *
 * Entity ids are namespaced by scope key (two scopes can index the same name)
 * and files are re-expressed as project-relative keys (the overlapping
 * `src`/`chat` scopes both point at `src/modules/chat/...`). Edges are rewritten
 * consistently; a neighbour that this scope does not place is kept in the
 * adjacency and dropped by the generator, exactly as for a single index.
 */
function mergeScopeIndexes(indexes: readonly ParsedScopeIndex[]): ArchIndex {
  const fileToIds: Record<string, string[]> = {};
  const nameToIds: Record<string, string[]> = {};
  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  const idToFile: Record<string, string> = {};
  const idToName: Record<string, string> = {};
  const relationsByType: Partial<Record<RelationType, [string, string][]>> = {};

  for (const index of indexes) {
    const mapFile = (file: string): string => mergeFileKey(index.sourcePrefix, file);
    const mapId = (id: string): string => `${index.scopeKey}/${id}`;

    for (const [file, ids] of Object.entries(index.fileToIds)) {
      const target = mergeFileKey(index.sourcePrefix, file);
      fileToIds[target] ??= [];
      pushUnique(fileToIds[target], ids.map(mapId));
    }
    for (const [name, ids] of Object.entries(index.nameToIds)) {
      nameToIds[name] ??= [];
      pushUnique(nameToIds[name], ids.map(mapId));
    }
    for (const [id, file] of Object.entries(index.idToFile)) idToFile[mapId(id)] = mapFile(file);
    for (const [id, name] of Object.entries(index.idToName)) idToName[mapId(id)] = name;
    for (const [from, neighbours] of Object.entries(index.dependencies)) {
      dependencies[mapId(from)] = neighbours.map(mapId);
    }
    for (const [to, neighbours] of Object.entries(index.dependents)) {
      dependents[mapId(to)] = neighbours.map(mapId);
    }
    for (const [type, pairs] of Object.entries(index.relationsByType ?? {})) {
      if (!isRelationType(type)) continue;
      const bucket = (relationsByType[type] ??= []);
      for (const [from, to] of pairs) bucket.push([mapId(from), mapId(to)]);
    }
  }

  return { fileToIds, nameToIds, dependencies, dependents, idToFile, idToName, relationsByType };
}

/**
 * Rewrite a transcript's `file_path` seed as a project-relative POSIX key.
 *
 * Absolute paths under the project root lose the root; relative paths are read
 * as project-relative (a provider hands the tool the session's working
 * directory). An absolute path outside the project cannot be placed in any
 * scope's index, so it stays unresolved — the caller reports it rather than
 * guessing.
 */
function resolveSeedFile(projectPath: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!path.isAbsolute(trimmed)) {
    return toPosix(path.normalize(trimmed)).replace(/^\.\//, '');
  }
  const relative = path.relative(projectPath, trimmed);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return toPosix(relative);
}

function emptyReading(): GenerateGraphResult {
  return {
    mmd: { file: EMPTY_GRAPH_MMD, entity: EMPTY_GRAPH_MMD },
    stats: { entityNodes: 0, fileNodes: 0, entityEdges: 0, fileEdges: 0, truncated: false },
    unresolved: { files: [], identifiers: [] },
  };
}

function buildStats(
  reading: GenerateGraphResult,
  seeds: { readonly files: readonly string[]; readonly identifiers: readonly string[] },
): ArchitectureGraphStats {
  return {
    ...reading.stats,
    seedFiles: seeds.files.length,
    seedIdentifiers: seeds.identifiers.length,
    nodeCount: reading.stats.entityNodes + reading.stats.fileNodes,
    edgeCount: reading.stats.entityEdges + reading.stats.fileEdges,
    unresolved: reading.unresolved,
  };
}

/**
 * Create the service over its injected readers.
 *
 * Consumers: `server/modules/architecture/module.js` (production composition)
 * and `server/modules/architecture/tests/architecture-routes.test.js`.
 */
export function createArchitectureService(deps: ArchitectureServiceDeps): ArchitectureService {
  const generate = deps.generateGraph ?? generateGraph;

  /**
   * Fingerprint memo, keyed by the index FILE and stamped with `mtime`/size.
   * It lets a steady-state request learn each scope's `archJsonHash` from one
   * `stat` instead of parsing megabytes of JSON again; a re-analysis changes the
   * stamp, so the next request re-reads and the content-addressed key moves.
   */
  const fingerprints = new Map<string, { stamp: string; parsed: ParsedScopeIndex }>();

  async function statStamp(indexPath: string): Promise<string | null> {
    try {
      const stat = await fsPromises.stat(indexPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async function readScope(
    projectPath: string,
    scopeKey: string,
    sourcePrefix: string,
  ): Promise<ParsedScopeIndex> {
    const indexPath = path.join(projectPath, QUERY_RELATIVE_DIRECTORY, scopeKey, 'arch-index.json');
    const stamp = await statStamp(indexPath);
    if (stamp === null) return readScopeIndex(projectPath, scopeKey, sourcePrefix);
    const memo = fingerprints.get(indexPath);
    if (memo !== undefined && memo.stamp === stamp) return memo.parsed;
    const parsed = await readScopeIndex(projectPath, scopeKey, sourcePrefix);
    fingerprints.set(indexPath, { stamp, parsed });
    return parsed;
  }

  const cache: ArchitectureCache<ParsedScopeIndex, GenerateGraphResult, ArchitectureGraphParams> =
    createArchitectureCache<ParsedScopeIndex, GenerateGraphResult, ArchitectureGraphParams>({
      // A parse-layer miss means the scope's content changed (or this is the
      // first request for it); the file is read and the fingerprint is checked
      // against the reference the key was built from.
      readIndex: async (scope) => {
        const { projectPath, scopeKey } = decodeScope(scope);
        const manifest = await readArchguardManifest(projectPath);
        const sourcePrefix = scopeSourcePrefix(
          projectPath,
          manifest?.scopes.find((entry) => entry.key === scopeKey)?.sources,
        );
        const indexPath = path.join(projectPath, QUERY_RELATIVE_DIRECTORY, scopeKey, 'arch-index.json');
        const stamp = await statStamp(indexPath);
        const memo = fingerprints.get(indexPath);
        if (stamp !== null && memo !== undefined && memo.stamp === stamp) return memo.parsed;
        const parsed = await readScopeIndex(projectPath, scopeKey, sourcePrefix);
        if (stamp !== null) fingerprints.set(indexPath, { stamp, parsed });
        return parsed;
      },
    });

  return {
    async readGraph(input: ArchitectureGraphInput): Promise<ArchitectureGraphResult> {
      const projectPath = deps.resolveProjectPath(input.projectId);
      if (projectPath === null) {
        throw new AppError(`Project "${input.projectId}" was not found.`, {
          code: 'PROJECT_NOT_FOUND',
          statusCode: 404,
        });
      }

      const manifest = await readArchguardManifest(projectPath);
      if (manifest === null) {
        throw new AppError(
          `Project "${input.projectId}" has no .archguard/query/manifest.json — the architecture tab is unavailable.`,
          {
            code: 'ARCHGUARD_CACHE_NOT_FOUND',
            statusCode: 404,
            details: { hasArchguardCache: false },
          },
        );
      }

      const scopeKeys: string[] = [];
      for (const scope of manifest.scopes) {
        if (!scopeKeys.includes(scope.key)) scopeKeys.push(scope.key);
      }

      // Read each scope (one stat in the steady state) so the merge can answer
      // `nameToIds` and the seeds can be extracted before the content key exists.
      const sourcePrefixByKey = new Map(
        manifest.scopes.map((scope) => [scope.key, scopeSourcePrefix(projectPath, scope.sources)]),
      );
      const parsedIndexes = await Promise.all(
        scopeKeys.map((scopeKey) => readScope(projectPath, scopeKey, sourcePrefixByKey.get(scopeKey) ?? '')),
      );
      const refs: ArchitectureIndexRef[] = parsedIndexes.map((parsed, index) => ({
        scope: encodeScope(projectPath, scopeKeys[index]),
        archJsonHash: parsed.archJsonHash,
      }));

      // Route the references through the parse layer so a same-fingerprint hit
      // never re-reads the file inside the cache either.
      const cachedIndexes = await Promise.all(refs.map((ref) => cache.getIndex(ref)));
      const merged = mergeScopeIndexes(cachedIndexes);
      const knownIdentifiers = new Set(Object.keys(merged.nameToIds));

      const messages = await deps.readSessionHistory(input.sessionId);
      const extracted = extractSeeds(messages, knownIdentifiers);

      const seeds = {
        files: extracted.files
          .map((file) => resolveSeedFile(projectPath, file))
          .filter((file): file is string => file !== null),
        identifiers: extracted.identifiers,
      };

      const params: ArchitectureGraphParams = {
        hops: input.hops ?? DEFAULT_HOPS,
        maxNodes: input.maxNodes ?? DEFAULT_MAX_NODES,
      };
      const fingerprints = refs.map((ref, index) => ({
        scope: scopeKeys[index],
        archJsonHash: ref.archJsonHash,
      }));

      // An empty transcript has nothing to expand. Short-circuit BEFORE the
      // cache/generator: there is no content key worth memoising and no
      // generation step worth spending (AC-418).
      if (seeds.files.length === 0 && seeds.identifiers.length === 0) {
        const reading = emptyReading();
        return {
          mmd: reading.mmd,
          stats: buildStats(reading, seeds),
          provenance: {
            generatedAt: manifest.generatedAt,
            fingerprints,
            cacheHit: false,
          },
        };
      }

      let built = false;
      const reading = await cache.getReading(
        {
          projectId: input.projectId,
          sessionId: input.sessionId,
          seeds,
          params,
          indexes: refs,
        },
        () => {
          built = true;
          return generate(merged, seeds, params);
        },
      );

      return {
        mmd: reading.mmd,
        stats: buildStats(reading, seeds),
        provenance: {
          generatedAt: manifest.generatedAt,
          fingerprints,
          // `build` runs only on a result-layer miss, so this is a reading of
          // the cache itself rather than a guess about its internals.
          cacheHit: !built,
        },
      };
    },
  };
}
