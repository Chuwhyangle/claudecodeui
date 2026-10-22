/**
 * Architecture graph service — the "request → seeds → merged index → graph"
 * orchestration of ADR-005 decisions 2, 3, 4 and 6 (AC-418).
 *
 * This is the only part of the module that touches the filesystem: it reads the
 * project's `.archguard/query/manifest.json` and each scope's
 * `arch-index.json`, then hands the pure pieces over:
 *
 *   transcript (injected reader) → extractSeeds (AC-416) → merged ArchIndex →
 *   generateGraph (AC-415) → `{ graph, mmd, stats, provenance }`
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
import { createHash } from 'node:crypto';
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
  type EntityDetail,
  type EntityKind,
  type EntityMember,
  type EntityMemberKind,
  type GenerateGraphResult,
  type GraphSeeds,
  type GraphStats,
  type NeighborhoodGraph,
  type RelationType,
  type SeedMentionProvenance,
  type UnresolvedSeeds,
} from './generator.js';
import { extractSeeds, extractSeedMentions, type SeedMentionResult } from './seed-extraction.js';
import {
  mergeScopesWithHygiene,
  SCOPE_HYGIENE_RULES_VERSION,
  type HygieneScope,
  type ScopeHygiene,
} from './scope-hygiene.js';
import {
  buildMentionIndex,
  DEFAULT_MENTION_HIT_LIMIT,
  queryCoMentionIndex,
  queryMentionIndex,
  type MentionHit,
  type SessionMentionIndex,
} from './mentions.js';
import {
  resolveEntities,
  searchEntities,
  type ArchitectureSearchHit,
  type ArchitectureSearchTarget,
} from './search.js';

/** Where a project's ArchGuard manifest lives, relative to the project root. */
const MANIFEST_RELATIVE_PATH = path.join('.archguard', 'query', 'manifest.json');

/** Where each scope's pre-built adjacency lives, relative to the project root. */
const QUERY_RELATIVE_DIRECTORY = path.join('.archguard', 'query');

/**
 * Name of the per-scope archive that carries entity kinds and members. It sits
 * NEXT TO `arch-index.json` (the index deliberately does not repeat either),
 * and its content is what the index's `archJsonHash` fingerprints.
 */
const ARCHIVE_FILENAME = 'arch.json';

/**
 * Default cap on the members carried per entity node.
 *
 * The entity graph is a UML class-diagram source, and a box with more than a
 * couple of dozen rows is unreadable before it is slow, so the cap is a payload
 * bound rather than a display opinion: a 60-member god class ships its first 20
 * rows plus `membersTruncated: true`, which is enough to style the node and say
 * "there is more behind this" without a megabyte of signatures. It is a
 * generation knob (part of the content-addressed key), so a caller can raise it
 * without touching the cache by accident.
 */
export const DEFAULT_MAX_MEMBERS = 20;

/**
 * Default node budget for the ENTITY graph. It is deliberately LOOSE: the
 * neighbourhood is shipped whole (distance-annotated) so the frontend can
 * filter it locally without a network round-trip, and 2000 only bounds a
 * pathological 2-hop explosion. A caller may lower or raise it per request; the
 * client's `maxNodes` slider is a local view filter, not a request parameter.
 * `generateGraph` deliberately ships no default, so the product constant has to
 * live on the route-side caller.
 */
export const DEFAULT_MAX_NODES = 2000;

/**
 * Default node budget for the FILE graph, independent of {@link DEFAULT_MAX_NODES}.
 * A session's entity neighbourhood projects onto roughly a tenth as many files,
 * so this bound is effectively "whole" for the neighbourhoods the tab opens
 * (quay's two-hop readings are a few hundred files) while still bounding a
 * pathological scope. The file graph is projected from the FULL reachable entity
 * set, so an entity-budget cut never shortens it.
 */
export const DEFAULT_MAX_FILES = 2000;

/**
 * Default BFS depth. Two hops is the 2026-10-21 reading's "loose" neighbourhood:
 * one hop is often too little to show a module's context, while three hops in
 * this repo's 300–1000-node neighbourhoods grows past what a force layout can
 * usefully display. The client's `maxHops` slider filters this same payload.
 */
export const DEFAULT_HOPS = 2;

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
  /**
   * Upstream metadata (not yet shipped by every ArchGuard version): the scope
   * was analysed from a directory outside this project. When present it is
   * trusted verbatim; when absent the service compares canonicalised paths.
   */
  readonly outsideProjectRoot?: boolean;
  /**
   * Upstream metadata: the scope this one is nested inside. It decides which
   * copy of a duplicated entity is the "outer" one; absent means the path
   * heuristic decides.
   */
  readonly parentScopeKey?: string;
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
  /** Entity kinds to keep; omitted means no element filter (the old reading). */
  readonly kinds?: readonly EntityKind[];
  /** Relation types to keep; omitted means no relation filter (the old reading). */
  readonly relations?: readonly RelationType[];
  /**
   * Entity ids to add as manual roots (the reader's pins). Omitted means the
   * old reading; an id that names nothing rides back in `unresolved.ids`.
   */
  readonly extraSeeds?: readonly string[];
  /** Entity ids to remove before traversal. Omitted means nothing is removed. */
  readonly excludeIds?: readonly string[];
};

/** The generation knobs that participate in the content-addressed cache key. */
export type ArchitectureGraphParams = {
  readonly hops: number;
  readonly maxNodes: number;
  readonly maxFiles: number;
  /** Per-entity member cap; part of the key because it changes the payload. */
  readonly maxMembers: number;
  /**
   * The element filter, present only when the request asked for one. It is part
   * of the content key because it changes the graph itself (the BFS and the
   * budget run on the filtered graph), so two filters can never share a cached
   * reading. Omitted — not `undefined` — keeps the no-filter key byte-identical
   * to the pre-filter one.
   */
  readonly kinds?: readonly EntityKind[];
  /** The relation filter, same presence rule as {@link kinds}. */
  readonly relations?: readonly RelationType[];
  /**
   * Manual pins, normalised (sorted + deduplicated) so two requests naming the
   * same set in a different order share one content key. Omitted keeps the
   * pre-curation key byte-identical.
   */
  readonly extraSeeds?: readonly string[];
  /** Manual removals, same normalisation and presence rule as {@link extraSeeds}. */
  readonly excludeIds?: readonly string[];
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

/** Why a scope contributed no entity details. */
export type ArchitectureDiagnosticCode =
  /** The scope directory has an `arch-index.json` but no sibling `arch.json`. */
  | 'ARCH_JSON_MISSING'
  /** `arch.json` exists but the filesystem read failed (permissions, I/O). */
  | 'ARCH_JSON_UNREADABLE'
  /** `arch.json` was read but is not the documented shape (JSON or `entities`). */
  | 'ARCH_JSON_INVALID';

/**
 * One visible reading of a degraded detail source.
 *
 * The architecture tab still answers when `arch.json` is missing — the graph is
 * just drawn without kinds and members — but "degraded" must be distinguishable
 * from "this analysis has no classes", so the reason rides along in the
 * provenance instead of being swallowed by a bare `try { } catch { }`.
 */
export type ArchitectureDiagnostic = {
  readonly scope: string;
  readonly code: ArchitectureDiagnosticCode;
  readonly message: string;
};

/**
 * Honesty payload (ADR-005 decision 7): when the ArchGuard analysis that backs
 * this reading was produced, which scope fingerprints were used, whether this
 * response came from the result cache, and — new and optional — any detail
 * source that was degraded.
 */
export type ArchitectureProvenance = {
  /** `manifest.generatedAt` — the analysis time, not the request time. */
  readonly generatedAt: string | null;
  readonly fingerprints: readonly { readonly scope: string; readonly archJsonHash: string }[];
  readonly cacheHit: boolean;
  /**
   * One entry per scope whose `arch.json` could not be used. Omitted when every
   * source was intact, so a healthy payload keeps its exact old provenance.
   */
  readonly diagnostics?: readonly ArchitectureDiagnostic[];
  /**
   * What the scope merge cleaned up (absolute-path ids, overlapping scopes,
   * scopes outside the project). Omitted when the merge changed nothing, so a
   * healthy single-scope reading keeps its exact old provenance shape.
   */
  readonly scopeHygiene?: ScopeHygiene;
};

/**
 * The endpoint's complete body: the two render-ready subgraphs, both Mermaid
 * documents (the export path), the counters, and provenance.
 */
export type ArchitectureGraphResult = {
  readonly mmd: { readonly file: string; readonly entity: string };
  readonly graph: { readonly file: NeighborhoodGraph; readonly entity: NeighborhoodGraph };
  readonly stats: ArchitectureGraphStats;
  readonly provenance: ArchitectureProvenance;
};

/**
 * The on-demand provenance request behind `POST /api/architecture/mentions`.
 *
 * `entityIds` and `edge` are alternatives (the route refuses a request with
 * neither): the first asks "where was this entity named?", the second asks
 * "where did these two entities meet?". `includeToolResults` opts into the
 * noisy tier for this ONE query — the graph's own extraction stays unchanged.
 */
export type ArchitectureMentionsInput = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly entityIds?: readonly string[];
  readonly edge?: { readonly from: string; readonly to: string };
  readonly includeToolResults?: boolean;
  readonly limit?: number;
};

/**
 * One entity's provenance reading.
 *
 * `candidateCount` is how many entities carry this name in the merged index;
 * `ambiguous` is `candidateCount > 1`, which is what lets the UI say "the name
 * X matches N entities, so these hits may point at any of them". `hits` is the
 * already-limited list and the top-level `truncated` says whether any list or
 * the scan itself was cut.
 */
export type ArchitectureMentionEntity = {
  readonly entityId: string;
  readonly candidateCount: number;
  readonly ambiguous: boolean;
  readonly hits: readonly MentionHit[];
};

/** The `/mentions` response: per-entity hits plus the optional edge co-mentions. */
export type ArchitectureMentionsResult = {
  readonly mentions: readonly ArchitectureMentionEntity[];
  readonly edge?: { readonly coMentions: readonly MentionHit[] };
  readonly truncated: boolean;
};

/**
 * The `/search` request, a union of its two forms:
 *  · `{ projectId, query, limit?, kinds? }` searches the whole project index;
 *  · `{ projectId, resolve: [{ name, file }] }` re-anchors saved curation items
 *    onto the current ids after a re-analysis.
 *
 * The route refuses a body with neither (or with both), because the two forms
 * answer different questions and silently picking one would hide the mistake.
 */
export type ArchitectureSearchInput =
  | {
      readonly projectId: string;
      readonly query: string;
      readonly limit?: number;
      readonly kinds?: readonly EntityKind[];
    }
  | {
      readonly projectId: string;
      readonly resolve: readonly ArchitectureSearchTarget[];
    };

/**
 * The `/search` answer: the query form carries `results`/`truncated`, the
 * resolve form carries `resolved` in request order (`null` = no such entity).
 */
export type ArchitectureSearchResult =
  | {
      readonly results: readonly ArchitectureSearchHit[];
      readonly truncated: boolean;
    }
  | {
      readonly resolved: readonly (ArchitectureSearchHit | null)[];
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
  /**
   * Reads one scope's `arch.json` text. Optional: production leaves it unset and
   * the service reads the file itself, while a criterion injects a counter to
   * prove the content-addressed cache performs no second archive read.
   */
  readonly readArchiveFile?: (filePath: string) => Promise<string>;
  /**
   * Builds the `/mentions` inverted index. Optional: production leaves it set
   * to `mentions.ts`'s implementation, while a criterion injects a counting
   * wrapper to prove a repeated query on the same history does no rebuild.
   */
  readonly buildMentionIndex?: typeof buildMentionIndex;
};

/** The service surface consumed by the route. */
export type ArchitectureService = {
  readGraph(input: ArchitectureGraphInput): Promise<ArchitectureGraphResult>;
  readMentions(input: ArchitectureMentionsInput): Promise<ArchitectureMentionsResult>;
  readSearch(input: ArchitectureSearchInput): Promise<ArchitectureSearchResult>;
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
  // Upstream fields are OPTIONAL and appear only once ArchGuard ships them; an
  // old manifest must not fail here, so each is read only when well-typed.
  const outsideProjectRoot = typeof value.outsideProjectRoot === 'boolean'
    ? value.outsideProjectRoot
    : undefined;
  const parentScopeKey = typeof value.parentScopeKey === 'string' && value.parentScopeKey.length > 0
    ? value.parentScopeKey
    : undefined;
  return { key: value.key, label, sources, outsideProjectRoot, parentScopeKey };
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
function projectRelativeSource(
  projectPath: string,
  source: string,
  canonicalize: (value: string) => string,
): string | null {
  if (!path.isAbsolute(source)) return toPosix(path.normalize(source));
  // Canonicalise BOTH ends: a manifest may spell this repository through a
  // symlink alias (`/home/...` vs `/data/...`), and a raw `path.relative`
  // would then read the source as outside and lose its prefix.
  const relative = path.relative(canonicalize(projectPath), canonicalize(source));
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
function scopeSourcePrefix(
  projectPath: string,
  sources: readonly string[] | undefined,
  canonicalize: (value: string) => string,
): string {
  const relatives = (sources ?? [])
    .map((source) => projectRelativeSource(projectPath, source, canonicalize))
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

/**
 * One parsed scope index plus the identity the merge needs: its fingerprint,
 * the directory its keys are relative to, and when it was analysed.
 *
 * `ArchitectureScopeIndex` is the cache's `TIndex`: it must carry
 * `archJsonHash`, and the merge reads the other fields. `sourcePrefix` and the
 * manifest's upstream metadata belong to the manifest, not to the file, so
 * they are stamped on at merge time.
 *
 * `entityDetails`/`diagnostics` come from the sibling `arch.json`, read in the
 * SAME parse step (so they are memoised under the same `archJsonHash` and cost
 * one read per analysis, never one per request). `entityDetails` is absent when
 * that archive is missing or unusable; `diagnostics` says why.
 */
type ParsedScopeIndex = ArchIndex & {
  readonly archJsonHash: string;
  readonly scopeKey: string;
  readonly sourcePrefix: string;
  /** The index's own `generatedAt`; breaks a tie between equal-source scopes. */
  readonly generatedAt: string | null;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
};

/**
 * Canonicalise a path for the scope-containment comparison.
 *
 * `realpath` is what makes the check honest: ArchGuard normalises symlink
 * aliases (`/home/...` vs `/data/...`), so a raw string comparison would call
 * this project's own scope "outside the project". A path that does not exist
 * (a stale manifest entry) falls back to `path.resolve`, which still compares
 * the segments the manifest recorded.
 */
function canonicalizeForContainment(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  }
}

/**
 * Merge every scope's index into the single `ArchIndex` the generator takes.
 *
 * Entity ids are namespaced by scope key (two scopes can index the same name)
 * and files are re-expressed as project-relative keys (the overlapping
 * `src`/`chat` scopes both point at `src/modules/chat/...`). The hygiene rules
 * in `scope-hygiene.ts` then normalise absolute ids, drop scopes that do not
 * belong to this project, and collapse the same `(file, name)` indexed by a
 * nested scope into the outer scope's entity, re-pointing every edge.
 */
function mergeScopeIndexes(
  projectPath: string,
  cachedIndexes: readonly ParsedScopeIndex[],
  manifest: ArchguardManifest,
): { index: ArchIndex; hygiene: ScopeHygiene } {
  const scopeByKey = new Map(manifest.scopes.map((scope) => [scope.key, scope]));
  const scopes: HygieneScope[] = cachedIndexes.map((parsed) => {
    const manifestScope = scopeByKey.get(parsed.scopeKey);
    return {
      key: parsed.scopeKey,
      label: manifestScope?.label,
      sources: manifestScope?.sources ?? [],
      sourcePrefix: parsed.sourcePrefix,
      generatedAt: parsed.generatedAt,
      ...(manifestScope?.outsideProjectRoot === undefined
        ? {}
        : { outsideProjectRoot: manifestScope.outsideProjectRoot }),
      ...(manifestScope?.parentScopeKey === undefined
        ? {}
        : { parentScopeKey: manifestScope.parentScopeKey }),
      index: parsed,
    };
  });
  const { index, hygiene } = mergeScopesWithHygiene({
    projectPath,
    scopes,
    canonicalizePath: canonicalizeForContainment,
  });
  return { index, hygiene };
}

/**
 * Whether the hygiene reading describes an actual cleanup. A merge that dropped
 * nothing, collapsed nothing and normalised nothing is omitted from the
 * provenance entirely, which keeps a healthy payload byte-identical.
 */
function reportsCleanup(hygiene: ScopeHygiene): boolean {
  return hygiene.droppedOutsideRoot.length > 0
    || hygiene.subsumed.length > 0
    || hygiene.normalizedAbsoluteIds > 0;
}

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
 * Normalise an `arch.json` entity `type` plus its `isAbstract` flag onto the
 * wire's five-plus-one kind vocabulary.
 *
 * `abstract` is derived (a class flagged `isAbstract`), not an ArchGuard type,
 * so a renderer can style it without reading a second field. Unknown types map
 * to `other` instead of being dropped: the node is still real.
 */
function normalizeEntityKind(type: unknown, isAbstract: unknown): EntityKind {
  if (type === 'class') return isAbstract === true ? 'abstract' : 'class';
  if (type === 'interface') return 'interface';
  if (type === 'enum') return 'enum';
  if (type === 'function') return 'function';
  return 'other';
}

/**
 * Collapse ArchGuard's member vocabulary onto `field`/`method`.
 *
 * `property` is the spelling the TypeScript extractor uses for an interface
 * field, and constructors/getters/setters are callable members; everything else
 * (`static block`, future kinds) is skipped rather than mislabelled.
 */
function normalizeMemberKind(type: unknown): EntityMemberKind | null {
  if (type === 'field' || type === 'property') return 'field';
  if (type === 'method' || type === 'constructor' || type === 'getter' || type === 'setter') return 'method';
  return null;
}

/** Render one parameter of a method signature (`name?: type`, or just `name`). */
function renderParameter(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0) return null;
  const optional = value.isOptional === true ? '?' : '';
  const type = typeof value.type === 'string' && value.type.length > 0 ? `: ${value.type}` : '';
  return `${value.name}${optional}${type}`;
}

/**
 * A display-ready one-liner for a member.
 *
 * Methods get `name(a: T, b?: U): R`; fields get their declared type (ArchGuard
 * records it as `fieldType`) and nothing when it recorded none. This is the
 * `signature` a class box prints — it is never parsed back, so it stays a
 * string rather than a structured shape.
 */
function memberSignature(member: Record<string, unknown>, kind: EntityMemberKind): string | undefined {
  const name = typeof member.name === 'string' ? member.name : '';
  if (kind === 'field') {
    return typeof member.fieldType === 'string' && member.fieldType.length > 0 ? member.fieldType : undefined;
  }
  const parameters = Array.isArray(member.parameters)
    ? member.parameters.map(renderParameter).filter((part): part is string => part !== null)
    : [];
  const returns = typeof member.returnType === 'string' && member.returnType.length > 0 ? `: ${member.returnType}` : '';
  return `${name}(${parameters.join(', ')})${returns}`;
}

/** Parse one member record, or `null` when it is not a shape this module can name. */
function parseMember(value: unknown): EntityMember | null {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0) return null;
  const kind = normalizeMemberKind(value.type);
  if (kind === null) return null;
  const visibility = typeof value.visibility === 'string' ? value.visibility : undefined;
  const signature = memberSignature(value, kind);
  return {
    name: value.name,
    kind,
    ...(visibility === undefined ? {} : { visibility }),
    ...(signature === undefined ? {} : { signature }),
  };
}

/** Parse ArchGuard's `entities` array into the per-entity detail map. */
function parseEntities(entities: readonly unknown[]): Record<string, EntityDetail> {
  const details: Record<string, EntityDetail> = {};
  for (const value of entities) {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) continue;
    const members = Array.isArray(value.members)
      ? value.members.map(parseMember).filter((member): member is EntityMember => member !== null)
      : [];
    details[value.id] = { kind: normalizeEntityKind(value.type, value.isAbstract), members };
  }
  return details;
}

/**
 * Read one scope's `arch.json` for entity kinds and members.
 *
 * Never throws: the caller's reading degrades to the legacy node shape, and the
 * returned diagnostic is what keeps the degradation visible in the provenance.
 */
async function readScopeArchive(
  readArchiveFile: (filePath: string) => Promise<string>,
  archivePath: string,
  scopeKey: string,
): Promise<{ details?: Record<string, EntityDetail>; diagnostic?: ArchitectureDiagnostic }> {
  let text: string;
  try {
    text = await readArchiveFile(archivePath);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      diagnostic: {
        scope: scopeKey,
        code: missing ? 'ARCH_JSON_MISSING' : 'ARCH_JSON_UNREADABLE',
        message: missing
          ? `scope '${scopeKey}' has no ${ARCHIVE_FILENAME}; entity nodes carry no kind or members`
          : `scope '${scopeKey}' could not read ${ARCHIVE_FILENAME}: ${String(error)}`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entities)) {
    return {
      diagnostic: {
        scope: scopeKey,
        code: 'ARCH_JSON_INVALID',
        message: `scope '${scopeKey}' has an unreadable ${ARCHIVE_FILENAME} (no entities array); entity nodes carry no kind or members`,
      },
    };
  }
  return { details: parseEntities(parsed.entities) };
}

/**
 * Parse one `.archguard/query/<scope>/arch-index.json`.
 *
 * Only the seven fields the AC-415 generator reads are validated. Anything
 * else in the file (`cycles`, ...) is irrelevant here and is dropped, which is
 * also what keeps the merge shape small for the generator.
 *
 * After the index is validated, the sibling `arch.json` is read for entity
 * kinds and members. That read is deliberately TOLERANT: a missing or broken
 * archive degrades the reading (nodes keep `id`/`label`/`distance`) and records
 * a diagnostic, because an old analysis tree must not turn the whole tab into a
 * 500. The index itself stays strict — a broken index is the error it always was.
 */
async function readScopeIndex(
  projectPath: string,
  scopeKey: string,
  sourcePrefix: string,
  readArchiveFile: (filePath: string) => Promise<string>,
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

  const archive = await readScopeArchive(
    readArchiveFile,
    path.join(projectPath, QUERY_RELATIVE_DIRECTORY, scopeKey, ARCHIVE_FILENAME),
    scopeKey,
  );

  return {
    archJsonHash: parsed.archJsonHash,
    scopeKey,
    sourcePrefix,
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
    diagnostics: archive.diagnostic === undefined ? [] : [archive.diagnostic],
    fileToIds: requireField(isStringArrayRecord(parsed.fileToIds) ? parsed.fileToIds : undefined, 'fileToIds', scopeKey),
    nameToIds: requireField(isStringArrayRecord(parsed.nameToIds) ? parsed.nameToIds : undefined, 'nameToIds', scopeKey),
    dependencies: requireField(isStringArrayRecord(parsed.dependencies) ? parsed.dependencies : undefined, 'dependencies', scopeKey),
    dependents: requireField(isStringArrayRecord(parsed.dependents) ? parsed.dependents : undefined, 'dependents', scopeKey),
    idToFile: requireField(isStringRecord(parsed.idToFile) ? parsed.idToFile : undefined, 'idToFile', scopeKey),
    idToName: requireField(isStringRecord(parsed.idToName) ? parsed.idToName : undefined, 'idToName', scopeKey),
    relationsByType: parseRelationsByType(parsed.relationsByType),
    // Spread rather than assign, so the key is ABSENT (not `undefined`) when the
    // archive was unusable — the generator keys its legacy shape on presence.
    ...(archive.details === undefined ? {} : { entityDetails: archive.details }),
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

/**
 * Turn the extractor's provenance into the generator's tiering summary.
 *
 * File traces are keyed by the RAW path text the transcript used, so every one
 * is resolved to the project-relative key the index stores first. A file's
 * resolved key may appear in several rows; the counts add up, which is what
 * `mentionCount` reports.
 *
 * Identifier co-occurrence is read from the SAME message: a row that names
 * `main` and spells `src/main.ts` disambiguates the name, so every file that
 * row mentions is attributed to that identifier's co-occurrence set.
 *
 * Consumers: `createArchitectureService` (the graph path only; `/mentions`
 * answers the same question lazily through `mentions.ts`).
 */
function buildSeedMentionProvenance(
  extracted: SeedMentionResult,
  projectPath: string,
): SeedMentionProvenance {
  const filesByMessage = new Map<string, Set<string>>();
  const fileCounts: Record<string, number> = {};

  for (const [rawFile, trace] of extracted.files) {
    const resolved = resolveSeedFile(projectPath, rawFile);
    if (resolved === null) continue;
    fileCounts[resolved] = (fileCounts[resolved] ?? 0) + trace.hits.length;
    for (const hit of trace.hits) {
      const files = filesByMessage.get(hit.messageId) ?? new Set<string>();
      files.add(resolved);
      filesByMessage.set(hit.messageId, files);
    }
  }

  const identifierFiles: Record<string, readonly string[]> = {};
  const identifierCounts: Record<string, number> = {};
  for (const [identifier, trace] of extracted.identifiers) {
    identifierCounts[identifier] = trace.hits.length;
    const files = new Set<string>();
    for (const hit of trace.hits) {
      for (const file of filesByMessage.get(hit.messageId) ?? []) files.add(file);
    }
    if (files.size > 0) identifierFiles[identifier] = [...files].sort();
  }

  return { identifierFiles, identifierCounts, fileCounts };
}

function emptyReading(): GenerateGraphResult {
  return {
    mmd: { file: EMPTY_GRAPH_MMD, entity: EMPTY_GRAPH_MMD },
    graph: {
      file: { nodes: [], edges: [] },
      entity: { nodes: [], edges: [] },
    },
    stats: {
      entityNodes: 0,
      fileNodes: 0,
      entityEdges: 0,
      fileEdges: 0,
      truncated: false,
      entityTruncated: false,
      fileTruncated: false,
      entityTotal: 0,
      fileTotal: 0,
    },
    unresolved: { files: [], identifiers: [] },
  };
}

/**
 * Normalise a curation id list for the content-addressed key.
 *
 * Sorting and de-duplication make two requests that name the same set in a
 * different order the SAME reading — the generator is order-insensitive, so the
 * key has to be too, or a re-render would be paid for a reordered array.
 */
function normalizeCurationIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
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
  // Production reads the archive with the same `fs.promises` the index uses; a
  // criterion injects a counter here to observe the cache's disk behaviour.
  const readArchiveFile = deps.readArchiveFile ?? ((filePath: string) => fsPromises.readFile(filePath, 'utf8'));

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
    if (stamp === null) return readScopeIndex(projectPath, scopeKey, sourcePrefix, readArchiveFile);
    const memo = fingerprints.get(indexPath);
    if (memo !== undefined && memo.stamp === stamp) return memo.parsed;
    const parsed = await readScopeIndex(projectPath, scopeKey, sourcePrefix, readArchiveFile);
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
          canonicalizeForContainment,
        );
        const indexPath = path.join(projectPath, QUERY_RELATIVE_DIRECTORY, scopeKey, 'arch-index.json');
        const stamp = await statStamp(indexPath);
        const memo = fingerprints.get(indexPath);
        if (stamp !== null && memo !== undefined && memo.stamp === stamp) return memo.parsed;
        const parsed = await readScopeIndex(projectPath, scopeKey, sourcePrefix, readArchiveFile);
        if (stamp !== null) fingerprints.set(indexPath, { stamp, parsed });
        return parsed;
      },
    });

  // The `/mentions` index lives one build per (session history version,
  // includeToolResults). The version is the row count plus a digest of the last
  // row's id, which is enough to tell "the transcript grew/changed" from "the
  // same history is being queried again" without hashing the whole transcript.
  const mentionIndexCache = new Map<
    string,
    { version: string; includeToolResults: boolean; index: SessionMentionIndex }
  >();
  const buildMentions = deps.buildMentionIndex ?? buildMentionIndex;

  function historyVersion(messages: readonly NormalizedMessage[]): string {
    const last = messages.at(-1);
    const digest = createHash('sha1').update(last?.id ?? '').digest('hex');
    return `${messages.length}:${digest}`;
  }

  async function mentionIndexFor(
    sessionId: string,
    messages: readonly NormalizedMessage[],
    includeToolResults: boolean,
  ): Promise<SessionMentionIndex> {
    const version = historyVersion(messages);
    const memo = mentionIndexCache.get(sessionId);
    if (memo !== undefined && memo.version === version && memo.includeToolResults === includeToolResults) {
      return memo.index;
    }
    const index = buildMentions(messages, { includeToolResults });
    mentionIndexCache.set(sessionId, { version, includeToolResults, index });
    return index;
  }

  /** The project lookup + manifest + merged index every architecture read needs. */
  async function loadIndex(
    projectPath: string,
    projectId: string,
  ): Promise<{
    manifest: ArchguardManifest;
    merged: ArchIndex;
    /** What the scope merge cleaned up; the caller omits it when nothing was. */
    hygiene: ScopeHygiene;
    refs: ArchitectureIndexRef[];
    scopeKeys: readonly string[];
    diagnostics: readonly ArchitectureDiagnostic[];
  }> {
    const manifest = await readArchguardManifest(projectPath);    if (manifest === null) {
      throw new AppError(
        `Project "${projectId}" has no .archguard/query/manifest.json — the architecture tab is unavailable.`,
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
      manifest.scopes.map((scope) => [
        scope.key,
        scopeSourcePrefix(projectPath, scope.sources, canonicalizeForContainment),
      ]),
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
    const { index: merged, hygiene } = mergeScopeIndexes(projectPath, cachedIndexes, manifest);
    const diagnostics = cachedIndexes.flatMap((index) => index.diagnostics);
    return { manifest, merged, hygiene, refs, scopeKeys, diagnostics };
  }

  return {
    async readGraph(input: ArchitectureGraphInput): Promise<ArchitectureGraphResult> {
      const projectPath = deps.resolveProjectPath(input.projectId);
      if (projectPath === null) {
        throw new AppError(`Project "${input.projectId}" was not found.`, {
          code: 'PROJECT_NOT_FOUND',
          statusCode: 404,
        });
      }

      const { manifest, merged, hygiene, refs, scopeKeys, diagnostics } = await loadIndex(projectPath, input.projectId);
      const knownIdentifiers = new Set(Object.keys(merged.nameToIds));

      const messages = await deps.readSessionHistory(input.sessionId);
      const extracted = extractSeeds(messages, knownIdentifiers);
      // Extraction runs once more for provenance: the same rows, the same
      // qualification rules, so a tier can never claim a mention the seed lists
      // did not see.
      const mentionExtraction = extractSeedMentions(messages, knownIdentifiers);

      const seedFiles = extracted.files
        .map((file) => resolveSeedFile(projectPath, file))
        .filter((file): file is string => file !== null);
      const seeds: GraphSeeds = {
        files: seedFiles,
        identifiers: extracted.identifiers,
        mentions: buildSeedMentionProvenance(mentionExtraction, projectPath),
      };

      const params: ArchitectureGraphParams = {
        hops: input.hops ?? DEFAULT_HOPS,
        maxNodes: input.maxNodes ?? DEFAULT_MAX_NODES,
        maxFiles: DEFAULT_MAX_FILES,
        maxMembers: DEFAULT_MAX_MEMBERS,
        // Spread rather than assign: an absent filter must not put a `kinds:
        // undefined` key into the content-addressed params, or the same reading
        // would hash differently from the pre-filter one.
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        ...(input.relations === undefined ? {} : { relations: input.relations }),
        ...(input.extraSeeds === undefined
          ? {}
          : { extraSeeds: normalizeCurationIds(input.extraSeeds) }),
        ...(input.excludeIds === undefined
          ? {}
          : { excludeIds: normalizeCurationIds(input.excludeIds) }),
      };
      const fingerprints = refs.map((ref, index) => ({
        scope: scopeKeys[index],
        archJsonHash: ref.archJsonHash,
      }));

      // An empty transcript has nothing to expand. Short-circuit BEFORE the
      // cache/generator: there is no content key worth memoising and no
      // generation step worth spending (AC-418). Manual pins are roots of their
      // own, so a curated request with no transcript seeds is NOT empty.
      const hasExtraSeeds = (input.extraSeeds?.length ?? 0) > 0;
      if (
        seeds.files.length === 0
        && seeds.identifiers.length === 0
        && !hasExtraSeeds
      ) {
        const reading = emptyReading();
        const curated = input.extraSeeds !== undefined || input.excludeIds !== undefined;
        return {
          mmd: reading.mmd,
          graph: reading.graph,
          stats: {
            ...buildStats(reading, seeds),
            ...(curated
              ? {
                  curation: {
                    pinned: 0,
                    excluded: (input.excludeIds ?? []).filter((id) => Object.hasOwn(merged.idToFile, id)).length,
                  },
                }
              : {}),
            ...(input.extraSeeds === undefined
              ? {}
              : { unresolved: { ...reading.unresolved, ids: [] } }),
          },
          provenance: {
            generatedAt: manifest.generatedAt,
            fingerprints,
            cacheHit: false,
            ...(diagnostics.length === 0 ? {} : { diagnostics }),
            ...(reportsCleanup(hygiene) ? { scopeHygiene: hygiene } : {}),
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
          // The merge rules shape the reading but none of the other key parts
          // do, so the version is what makes a rule change a cache miss.
          rulesVersion: SCOPE_HYGIENE_RULES_VERSION,
        },
        () => {
          built = true;
          return generate(merged, seeds, params);
        },
      );

      return {
        mmd: reading.mmd,
        graph: reading.graph,
        stats: buildStats(reading, seeds),
        provenance: {
          generatedAt: manifest.generatedAt,
          fingerprints,
          // `build` runs only on a result-layer miss, so this is a reading of
          // the cache itself rather than a guess about its internals.
          cacheHit: !built,
          ...(diagnostics.length === 0 ? {} : { diagnostics }),
          ...(reportsCleanup(hygiene) ? { scopeHygiene: hygiene } : {}),
        },
      };
    },

    async readMentions(input: ArchitectureMentionsInput): Promise<ArchitectureMentionsResult> {
      const projectPath = deps.resolveProjectPath(input.projectId);
      if (projectPath === null) {
        throw new AppError(`Project "${input.projectId}" was not found.`, {
          code: 'PROJECT_NOT_FOUND',
          statusCode: 404,
        });
      }

      // The names and files a hit is matched against come from the same merged
      // index the graph was built from, so an entity id in the graph payload is
      // directly addressable here.
      const { merged } = await loadIndex(projectPath, input.projectId);
      const messages = await deps.readSessionHistory(input.sessionId);
      const includeToolResults = input.includeToolResults === true;
      const index = await mentionIndexFor(input.sessionId, messages, includeToolResults);
      const limit = input.limit ?? DEFAULT_MENTION_HIT_LIMIT;

      let truncated = index.truncated;
      const mentions: ArchitectureMentionEntity[] = [];
      for (const entityId of input.entityIds ?? []) {
        const name = merged.idToName[entityId];
        const file = merged.idToFile[entityId];
        const candidates = name === undefined ? 0 : (merged.nameToIds[name]?.length ?? 0);
        const reading = queryMentionIndex(index, {
          ...(name === undefined ? {} : { name }),
          ...(file === undefined ? {} : { file }),
          limit,
        });
        truncated ||= reading.truncated;
        mentions.push({
          entityId,
          candidateCount: candidates,
          ambiguous: candidates > 1,
          hits: reading.hits,
        });
      }

      // An edge's reading needs BOTH endpoint names; an id the index cannot
      // name contributes nothing rather than failing the whole request.
      let edge: { coMentions: readonly MentionHit[] } | undefined;
      if (input.edge !== undefined) {
        const fromName = merged.idToName[input.edge.from];
        const toName = merged.idToName[input.edge.to];
        const reading = fromName === undefined || toName === undefined
          ? { hits: [], truncated: false }
          : queryCoMentionIndex(index, fromName, toName, limit);
        truncated ||= reading.truncated;
        edge = { coMentions: reading.hits };
      }

      return {
        mentions,
        ...(edge === undefined ? {} : { edge }),
        truncated,
      };
    },

    async readSearch(input: ArchitectureSearchInput): Promise<ArchitectureSearchResult> {
      const projectPath = deps.resolveProjectPath(input.projectId);
      if (projectPath === null) {
        throw new AppError(`Project "${input.projectId}" was not found.`, {
          code: 'PROJECT_NOT_FOUND',
          statusCode: 404,
        });
      }

      // Search runs over the SAME merged index the graph was built from, so an
      // id from a result is directly addressable as an `extraSeeds` entry.
      const { merged } = await loadIndex(projectPath, input.projectId);
      if ('resolve' in input) {
        return { resolved: resolveEntities(merged, input.resolve) };
      }
      return searchEntities(merged, input.query, {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
      });
    },
  };
}
