/**
 * Shared helpers for the architecture panel and its extracted view modules.
 *
 * The residual-oversize split moved the panel's JSX into leaf modules; the few
 * pure helpers and storage keys every module agrees on live here so exactly one
 * definition of each survives (the id-shape rule, the session-storage keys and
 * the standalone deep link's diff parameters).
 */
import type { ArchitectureDiffHighlight, ArchitectureNodeIdShape } from '@/modules/architecture/dom/rendererContract';
import type { ArchitectureGranularity } from '@/modules/architecture/layout/panel/panelFilters';

/**
 * The id scheme the server used for a subgraph. File ids ARE project-relative
 * paths; entity ids are `<scopeKey>/<scope-relative path>.<Entity>`. The panel
 * is the only layer that knows which subgraph it is handing over, so it states
 * the shape for the renderer instead of letting the renderer guess.
 */
export function nodeIdShapeOf(granularity: ArchitectureGranularity): ArchitectureNodeIdShape {
  return granularity === 'file' ? 'project-relative' : 'scope-prefixed';
}

/**
 * How many unresolved file paths the "nothing to draw in this view" empty state
 * names before collapsing the rest into an "…and N more" count. The state exists
 * to explain a blank canvas, not to print the whole unresolved set.
 */
export const EMPTY_VIEW_UNRESOLVED_LIMIT = 5;

/**
 * The id of the "keep these shown…" hint paragraph. Every "keep mentioned"
 * switch points `aria-describedby` at it, so the visible name and the extra
 * explanation are separate readings instead of one overloaded `aria-label`.
 */
export const MENTIONED_HINT_ID = 'architecture-filter-mentioned-hint';
/**
 * Where the portrait phone's summary remembers whether it is expanded.
 *
 * `sessionStorage`, not `localStorage`: the requirement is "remembered within
 * the session", and a fresh browser session must start collapsed again — the
 * phone's scarce height is why the default is the one-line form.
 */
export const READOUT_EXPANDED_SESSION_KEY = 'architecture-readout-expanded';

/** The session's remembered expansion; storage being blocked reads as collapsed. */
export const readReadoutExpandedInSession = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(READOUT_EXPANDED_SESSION_KEY) === 'true';
  } catch {
    return false;
  }
};

/** One `from->to` pair from a diff deep link; null when either side is missing. */
export function parseDiffPair(raw: string): { from: string; to: string } | null {
  const separator = raw.indexOf('->');
  if (separator <= 0) return null;
  const from = raw.slice(0, separator).trim();
  const to = raw.slice(separator + 2).trim();
  return from === '' || to === '' ? null : { from, to };
}

/**
 * Parses the diff set a preview puts in the standalone URL.
 *
 * Repeatable parameters keep the link readable and avoid inventing a serialisation:
 * `diffNode=<drawn id>`, `diffEdge=<from>-><to>`, `diffPkg=<package id>`,
 * `diffPkgEdge=<from>-><to>`. Anything malformed is ignored, like every other deep-link
 * parameter — a shared URL must never break the page.
 */
export function parseDeepLinkDiffHighlight(search: string): ArchitectureDiffHighlight | null {
  const trimmed = search.trim();
  if (trimmed === '') return null;
  const params = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
  const strings = (name: string): string[] =>
    params.getAll(name).map((value) => value.trim()).filter((value) => value !== '');
  const pairs = (name: string): { from: string; to: string }[] =>
    strings(name)
      .map(parseDiffPair)
      .filter((pair): pair is { from: string; to: string } => pair !== null);

  const nodeIds = strings('diffNode');
  const edges = pairs('diffEdge');
  const packageIds = strings('diffPkg');
  const packageEdges = pairs('diffPkgEdge');
  if (nodeIds.length === 0 && edges.length === 0 && packageIds.length === 0 && packageEdges.length === 0) {
    return null;
  }
  return {
    ...(nodeIds.length === 0 ? {} : { nodeIds }),
    ...(edges.length === 0 ? {} : { edges }),
    ...(packageIds.length === 0 ? {} : { packageIds }),
    ...(packageEdges.length === 0 ? {} : { packageEdges }),
  };
}

/** How many distinct node/edge targets a highlight names, for the readout chip. */
export function diffHighlightCounts(highlight: ArchitectureDiffHighlight): { nodes: number; edges: number } {
  const nodes = new Set([...(highlight.nodeIds ?? []), ...(highlight.packageIds ?? [])]).size;
  const edges = new Set(
    [...(highlight.edges ?? []), ...(highlight.packageEdges ?? [])]
      .map((edge) => `${edge.from}->${edge.to}`),
  ).size;
  return { nodes, edges };
}

