/**
 * Target resolution for MCP tool arguments (AC-246, extended by AC-333; SPEC
 * `docs/proposals/mcp-gateway-SPEC.md` v3.1 §259): a caller names a project by
 * `projectId`, by its absolute directory path, or by a name fragment, and a
 * session by `sessionId` or a title fragment, and the gateway turns that
 * reference into the ONE id a tool may act on. Typing a 40-character id on a
 * phone is not realistic, so the name path is the one that gets used — which is
 * exactly why it must never guess.
 *
 * {@link resolveMcpTarget} is the decision, pure over its injected data source.
 * It walks a PRECEDENCE of layers, and the first layer carrying any match
 * decides:
 *
 *  1. an exact id, compared verbatim (case-sensitive) against the RAW reference,
 *     wins outright BEFORE any name matching, so a session whose id happens to
 *     read like another session's title resolves to itself, not the lookalike;
 *  2. for a PROJECT only, an ABSOLUTE reference's normalized absolute-path
 *     equality — `path.resolve` with any trailing separator removed, symlinks NOT
 *     followed — so a caller already holding the directory path hits it directly,
 *     even when its title has several substring matches. A RELATIVE reference
 *     (a bare name, `./x`, `../x`) skips this layer entirely rather than being
 *     absolutized against the server's cwd, and then resolves by title; sessions
 *     have no path layer at all;
 *  3. a trimmed, case-SENSITIVE exact title that hits exactly one entry;
 *  4. failing that, a trimmed, case-INSENSITIVE exact title that hits exactly one
 *     entry — the narrower case-sensitive layer having already run;
 *  5. failing that, a trimmed, case-insensitive SUBSTRING of the title that hits
 *     exactly one entry (AC-246's original and least precise layer).
 *
 * Ambiguity STOPS the walk: a layer with more than one hit returns
 * `TARGET_AMBIGUOUS` listing every candidate and does NOT fall through to a
 * narrower layer, so a caller is never handed a "resolved" entry that a stricter
 * layer would have found ambiguous. Every candidate carries its id, its title,
 * its path (projects only) and the {@link McpResolveMatchType} of the layer it
 * matched on, so a caller can see HOW a target was found, not merely that it was.
 *
 * The success reading carries the same {@link McpResolveMatchType} as the layer
 * that decided, plus the matched candidate — the whole point of AC-333's strict
 * write rule below is to act on the LAYER, and a consumer cannot do that from the
 * id alone.
 *
 * The strictness split (AC-333): a name fragment is a fine way to DISCOVER a
 * target but not to ADDRESS one for a WRITE. {@link resolveInputTargets} derives
 * the current tool's read-only-ness from `MCP_TOOL_ANNOTATIONS`' `readOnlyHint`
 * and, for a write, refuses a target that only matched by the substring layer —
 * the one layer that can silently name a different entry than the caller meant.
 * The refusal reuses `TARGET_AMBIGUOUS` (never a new vocabulary entry) with
 * `details.reason === 'exact_target_required'` and the single matched candidate,
 * and the handler is never entered. Ids, full paths and exact titles still reach
 * a write's handler unchanged.
 *
 * {@link McpResolveDeps} is the whole data source and it is injected. Both of its
 * lists carry ACTIVE entries only, which is what makes "an archived project or
 * session is never matched" a property of the wiring rather than a special case
 * buried in the matching rules: the resolver has no archived row to match.
 *
 * A not-found failure names ONE code per category — `SESSION_NOT_FOUND` for a
 * session, `PROJECT_NOT_FOUND` for a project (AC-284) — never a single "target
 * not found" code that would make the same category two different codes.
 *
 * {@link resolveInputTargets} is the gate built on top of the decision. It
 * decorates a tool handler so that every `project` / `session` string argument is
 * resolved BEFORE the handler runs, and a failed resolution stops the call right
 * there — the handler body is never entered, so no write can reach the control
 * or host service against a target nobody named. The refusal is raised as a
 * {@link McpToolError}, which the audited seam AC-244 landed renders as the one
 * failure envelope (AC-284): the code, the query and the candidate list reach
 * the caller as `structuredContent`, and the audit row records `error` rather
 * than a misleading `ok`.
 *
 * A target argument may also be an ARRAY of references (gap-mcp-cross-project-
 * session-aggregation: `session_search` / `overview` accept several projects to
 * aggregate across). Each element resolves on its own, and the FIRST element that
 * is ambiguous or names nothing refuses the WHOLE call — the handler sees either
 * every element resolved or none, so a partially-resolved array is never handed
 * to a body that would silently read a subset. An empty array resolves to an
 * empty array (a caller naming no project); a non-string element is passed
 * through untouched, exactly as a non-string scalar is, because it is not a
 * reference at all and the tool's declared schema is what rejects it.
 *
 * Consumers: `mcp-gateway.transport.ts` applies the gate to every tool the
 * gateway registers — passing each tool's name so the strict write rule can read
 * its annotations; AC-245's read tools, AC-249–AC-251's write tools and AC-250's
 * `session_create` reuse {@link resolveMcpTarget} / {@link resolveInputTargets}
 * instead of re-deriving a target. This module's criterion drives both directly.
 */

import path from 'node:path';

import { McpToolError } from './mcp-error-envelope.js';
import { readMcpToolAnnotations } from './mcp-tool-annotations.js';

// --------------------------- the decision ---------------------------

/** Which list of entries a reference is resolved against. */
export type McpTargetKind = 'project' | 'session';

/**
 * Which precedence layer resolved a target, so a consumer can tell an exact
 * address apart from a fuzzy one (AC-333). `id` and `path` are exact addresses;
 * `exact_title` and `exact_title_ci` are exact names; `substring` is the one
 * fuzzy layer, and the only one a write refuses.
 */
export type McpResolveMatchType = 'id' | 'path' | 'exact_title' | 'exact_title_ci' | 'substring';

/** One entry the caller may pick, as a resolution reports it. */
export type McpResolveCandidate = {
  id: string;
  title: string;
  /** The project's directory path; absent for a session (which has none). */
  path?: string;
  /** The precedence layer that matched this entry. */
  matchType: McpResolveMatchType;
};

/**
 * The outcome of resolving one reference.
 *
 * The successful arm carries the id, the layer it matched on, and the matched
 * candidate; the failed arms carry the query, the kind and the candidates so a
 * caller can retry or ask a human. There is deliberately no `id` field on a
 * failure, because a failure that also suggested a target would be the resolver
 * picking for the user.
 */
export type McpResolveResult =
  | { ok: true; id: string; matchType: McpResolveMatchType; matched: McpResolveCandidate }
  | {
      ok: false;
      code: 'TARGET_AMBIGUOUS' | 'SESSION_NOT_FOUND' | 'PROJECT_NOT_FOUND';
      /** The reference as it was matched: trimmed, since that is what was compared. */
      query: string;
      kind: McpTargetKind;
      /** Every entry the query matched, id and title. Empty for a not-found. */
      candidates: McpResolveCandidate[];
      message: string;
    };

/**
 * One entry a reference can resolve to: the stable id, the human-facing title,
 * and — for a project — the directory path the path layer compares against.
 */
export type McpResolveEntry = {
  id: string;
  title: string;
  /**
   * The project's directory path. Absent for a session, and absent for a project
   * whose caller did not supply one; either way the path layer simply has nothing
   * to compare for that entry, which degrades to the title layers rather than
   * matching every path.
   */
  path?: string;
};

/**
 * The data source {@link resolveMcpTarget} matches against, injected so the
 * resolver stays pure and so a criterion can supply its own entries.
 *
 * CONTRACT: both lists return ACTIVE entries only. A caller that fed an archived
 * project or session here would make it matchable; the gateway's own wiring
 * reads the active listings (`getProjectsWithSessions`,
 * `sessionsService.listRecentSessions`), which is where the "archived never
 * takes part" property lives.
 */
export type McpResolveDeps = {
  listProjects(): readonly McpResolveEntry[];
  listSessions(): readonly McpResolveEntry[];
};

/** How each kind is named in a human-readable refusal. */
const KIND_LABELS: Record<McpTargetKind, string> = {
  project: 'project',
  session: 'session',
};

/**
 * The not-found code for a kind: "the session does not exist" and "the project
 * does not exist" are ONE category each, named by one code each (AC-284). Before
 * this, a missing session carried one code at the gate and another inside the
 * tools — two names for one category, which the criterion forbids.
 */
function notFoundCode(kind: McpTargetKind): 'SESSION_NOT_FOUND' | 'PROJECT_NOT_FOUND' {
  return kind === 'session' ? 'SESSION_NOT_FOUND' : 'PROJECT_NOT_FOUND';
}

/** The not-found reading: no entry matched, so there is nothing to guess between. */
function notFound(query: string, kind: McpTargetKind): McpResolveResult {
  return {
    ok: false,
    code: notFoundCode(kind),
    query,
    kind,
    candidates: [],
    message: `No ${KIND_LABELS[kind]} has a title containing "${query}".`,
  };
}

/** One entry as a candidate, stamping the layer it matched on. */
function toCandidate(entry: McpResolveEntry, matchType: McpResolveMatchType): McpResolveCandidate {
  return entry.path === undefined
    ? { id: entry.id, title: entry.title, matchType }
    : { id: entry.id, title: entry.title, path: entry.path, matchType };
}

/** The success reading: the id, the deciding layer, and the matched candidate. */
function resolved(entry: McpResolveEntry, matchType: McpResolveMatchType): McpResolveResult {
  return { ok: true, id: entry.id, matchType, matched: toCandidate(entry, matchType) };
}

/**
 * The ambiguity reading for ONE layer: every candidate the layer matched, stamped
 * with that layer's {@link McpResolveMatchType}, and no chosen id. The caller is
 * asked to name exactly one; the resolver will not pick for it. The message is
 * deliberately layer-agnostic — it must be the same English sentence whether the
 * collision came from a path, a title or a fragment — and it is the ONE place
 * that sentence is written.
 */
function ambiguous(
  kind: McpTargetKind,
  query: string,
  candidates: McpResolveCandidate[],
): McpResolveResult {
  return {
    ok: false,
    code: 'TARGET_AMBIGUOUS',
    query,
    kind,
    candidates,
    message: `${candidates.length} ${KIND_LABELS[kind]}s match "${query}"; name exactly one — the gateway will not pick for you.`,
  };
}

/**
 * The canonical form of a project path: `path.resolve` (absolutized and
 * normalized) with any trailing separator stripped, EXCEPT for the filesystem
 * root, which IS its own separator. Symlinks are not followed — `realpath` is
 * deliberately not used — so a path differing only by a trailing slash or a `..`
 * segment still compares equal to the stored one.
 */
function normalizeTargetPath(value: string): string {
  const absolute = path.resolve(value);
  if (absolute.length > 1) {
    return absolute.replace(/[\\/]+$/, '');
  }
  return absolute;
}

/**
 * Resolves one caller-supplied reference to a single entry id.
 *
 * Precedence, in order (AC-333): an exact (verbatim, case-sensitive) id; for a
 * project, a normalized absolute-path equality (ABSOLUTE references only, so a
 * bare name is never absolutized against the server's cwd); a trimmed
 * case-sensitive exact title; a trimmed case-insensitive exact title; a trimmed
 * case-insensitive substring of the title. A layer with several hits is ambiguity
 * and STOPS the walk; no layer resolves a target the caller did not name, and the
 * resolver never picks a winner on the caller's behalf. Never throws.
 *
 * Consumers: {@link resolveInputTargets}, and the read/write tools that accept a
 * `project` or `session` argument (AC-245, AC-249–AC-251).
 */
export function resolveMcpTarget(
  ref: string,
  kind: McpTargetKind,
  deps: McpResolveDeps,
): McpResolveResult {
  const entries = kind === 'project' ? deps.listProjects() : deps.listSessions();
  const query = ref.trim();

  // Layer 1 — exact id. The caller already being unambiguous wins before any
  // title is looked at, and the comparison is verbatim against the RAW reference:
  // an id that differs only in case is a DIFFERENT id, not a fuzzy hit.
  const exact = entries.find((entry) => entry.id === ref);
  if (exact !== undefined) {
    return resolved(exact, 'id');
  }

  // An empty reference names nothing. Left to the substring layer it would match
  // EVERY entry (the empty string is a substring of everything), which would turn
  // "the caller said nothing" into "the caller said everything".
  if (query.length === 0) {
    return notFound(query, kind);
  }

  // Layer 2 — a project's normalized absolute path. Sessions have no path layer.
  // ONLY an ABSOLUTE reference participates. `path.resolve` would otherwise
  // absolutize a bare name (`app`) or a `./`-relative one against the SERVER
  // PROCESS's cwd, so `app` could silently resolve to `<cwd>/app` by the exact
  // `path` layer — which a write accepts — instead of falling through to the
  // title layer that names the project actually titled `app`. The reading would
  // then depend on which directory the server was started from rather than on
  // what the caller asked for (gap-mcp-resolve-target-path-layer-resolves-
  // relative-names-against-server-cwd). No `~` expansion.
  if (kind === 'project' && path.isAbsolute(query)) {
    const wanted = normalizeTargetPath(query);
    const pathMatches = entries.filter(
      (entry) => entry.path !== undefined && normalizeTargetPath(entry.path) === wanted,
    );
    if (pathMatches.length === 1) {
      return resolved(pathMatches[0], 'path');
    }
    if (pathMatches.length > 1) {
      return ambiguous(kind, query, pathMatches.map((entry) => toCandidate(entry, 'path')));
    }
  }

  // Layer 3 — a trimmed, case-SENSITIVE exact title.
  const exactTitle = entries.filter((entry) => entry.title.trim() === query);
  if (exactTitle.length === 1) {
    return resolved(exactTitle[0], 'exact_title');
  }
  if (exactTitle.length > 1) {
    return ambiguous(kind, query, exactTitle.map((entry) => toCandidate(entry, 'exact_title')));
  }

  // Layer 4 — a trimmed, case-INSENSITIVE exact title. It runs only after the
  // case-sensitive layer found nothing, so `quay` picks `quay` even when `Quay`
  // also exists.
  const needle = query.toLowerCase();
  const exactTitleCi = entries.filter((entry) => entry.title.trim().toLowerCase() === needle);
  if (exactTitleCi.length === 1) {
    return resolved(exactTitleCi[0], 'exact_title_ci');
  }
  if (exactTitleCi.length > 1) {
    return ambiguous(kind, query, exactTitleCi.map((entry) => toCandidate(entry, 'exact_title_ci')));
  }

  // Layer 5 — the original, least precise layer: a case-insensitive substring of
  // the title. It is the only layer a WRITE refuses (AC-333), because it is the
  // only one that can resolve to an entry the caller did not mean.
  const substring = entries.filter((entry) => entry.title.toLowerCase().includes(needle));
  if (substring.length === 1) {
    return resolved(substring[0], 'substring');
  }
  if (substring.length === 0) {
    return notFound(query, kind);
  }
  return ambiguous(kind, query, substring.map((entry) => toCandidate(entry, 'substring')));
}

// --------------------------- the gate ---------------------------

/**
 * The tool input fields that name a target, and the kind each one names. This is
 * the ONE place the mapping is written down: a tool that takes a `project` or a
 * `session` argument is gated by that fact alone, and no tool restates it.
 */
const TARGET_INPUT_FIELDS: ReadonlyArray<readonly [field: string, kind: McpTargetKind]> = [
  ['project', 'project'],
  ['session', 'session'],
];

/**
 * Resolves one string reference to its id, or throws the refusal envelope.
 *
 * A failed resolution throws the envelope carrying the same code, query and
 * candidate list the resolver produced, so a caller retries against the same
 * reading. When `strict` is set (a write tool, AC-333) a target that only matched
 * by the substring layer is refused the same way, with the extra marker
 * `details.reason === 'exact_target_required'` and the single matched candidate —
 * a write needs an id, a full path, or an exact title, never a fragment.
 */
function resolveOrThrow(ref: string, kind: McpTargetKind, deps: McpResolveDeps, strict: boolean): string {
  const result = resolveMcpTarget(ref, kind, deps);
  if (!result.ok) {
    throw new McpToolError(result.code, result.message, false, {
      query: result.query,
      kind: result.kind,
      candidates: result.candidates,
    });
  }
  if (strict && result.matchType === 'substring') {
    throw new McpToolError(
      'TARGET_AMBIGUOUS',
      `The ${KIND_LABELS[kind]} "${ref.trim()}" was matched only by title substring; a write needs an exact target — an id, a full path, or an exact title.`,
      false,
      {
        query: ref.trim(),
        kind,
        reason: 'exact_target_required',
        candidates: [result.matched],
      },
    );
  }
  return result.id;
}

/**
 * Decorates a tool handler so its `project` / `session` arguments are resolved
 * before it runs.
 *
 * On success the argument is rewritten to the resolved id and the handler is
 * called with the rewritten bag, so the body deals in ids only. An ARRAY
 * argument is rewritten element by element; a failure on ANY element throws
 * before the handler runs, so the body never sees a partially-resolved list. On
 * failure the handler is NOT called at all — the refusal is thrown as an error
 * whose message is the JSON encoding of the failed {@link McpResolveResult} —
 * which is what makes "an unnamed target performs no write" a property of this
 * one wrapper rather than a pre-check each write tool has to remember.
 *
 * `toolName` (AC-333) is the tool being gated. When it is supplied and its
 * `MCP_TOOL_ANNOTATIONS` row has `readOnlyHint === false` — a WRITE — a target
 * that only the substring layer can resolve is refused (`exact_target_required`)
 * rather than passed on: a fragment is a way to DISCOVER a target, not to address
 * one for a mutation. The read-only-ness is DERIVED from the one annotations
 * table, never a second hand-kept name list, so a new write tool is strict the
 * moment its annotation says so. Omitting `toolName` keeps the pre-AC-333
 * behaviour (no strictness), which is what the criteria that gate a bare handler
 * still read.
 *
 * A field that is absent, or is neither a string nor an array, belongs to some
 * other meaning and is passed through untouched; a field that IS a string
 * (including an empty one) is a target, and an empty one is refused rather than
 * silently ignored. An empty ARRAY is not a target at all — it resolves to an
 * empty array, because "name no project" is what an empty list says.
 *
 * Consumers: `mcp-gateway.transport.ts` wraps AC-245's read-tool handlers with it
 * (passing the tool name); AC-249–AC-251's write tools and AC-250's
 * `session_create` compose it the same way instead of writing their own guard.
 */
export function resolveInputTargets(
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  deps: McpResolveDeps,
  toolName?: string,
): (args: Record<string, unknown>) => unknown | Promise<unknown> {
  const strict = toolName !== undefined && readMcpToolAnnotations(toolName).readOnlyHint === false;
  return (args) => {
    const resolved: Record<string, unknown> = { ...args };
    for (const [field, kind] of TARGET_INPUT_FIELDS) {
      const value = resolved[field];
      if (typeof value === 'string') {
        resolved[field] = resolveOrThrow(value, kind, deps, strict);
        continue;
      }
      if (Array.isArray(value)) {
        // Element-wise: the FIRST ambiguous or not-found element refuses the
        // whole call (gap-mcp-cross-project-session-aggregation), so no element
        // is dropped on the caller's behalf and the body never runs against a
        // subset. Non-strings ride through — the declared schema is the place a
        // wrong element type is rejected, not this gate.
        resolved[field] = value.map((element) =>
          typeof element === 'string' ? resolveOrThrow(element, kind, deps, strict) : element,
        );
      }
    }
    return handler(resolved);
  };
}
