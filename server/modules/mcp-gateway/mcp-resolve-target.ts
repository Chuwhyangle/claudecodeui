/**
 * Fuzzy resolution of MCP tool targets (AC-246; SPEC
 * `docs/proposals/mcp-gateway-SPEC.md` v3.1 §259): a caller names a project by
 * `projectId` or a name fragment, and a session by `sessionId` or a title
 * fragment, and the gateway turns that reference into the ONE id a tool may act
 * on. Typing a 40-character id on a phone is not realistic, so the name path is
 * the one that gets used — which is exactly why it must never guess.
 *
 * {@link resolveMcpTarget} is the decision, pure over its injected data source:
 *
 *  - an exact id wins outright, BEFORE any name matching, compared verbatim, so
 *    a session whose id happens to read like another session's title resolves to
 *    itself rather than to the lookalike;
 *  - otherwise a trimmed, case-insensitive SUBSTRING of the title has to hit
 *    EXACTLY ONE entry;
 *  - several hits are ambiguous: every candidate is listed with its id and its
 *    title, and NO id is chosen on the caller's behalf — the result carries no
 *    "selected" field at all, so a consumer cannot mistake a guess for a hit;
 *  - no hit — including an empty or whitespace-only reference — is a not-found
 *    reading that names the query and the kind, and is returned rather than
 *    thrown, because "there is no such session" is an answer, not a crash.
 *
 * {@link McpResolveDeps} is the whole data source and it is injected. Both of its
 * lists carry ACTIVE entries only, which is what makes "an archived project or
 * session is never matched" a property of the wiring rather than a special case
 * buried in the matching rules: the resolver has no archived row to match.
 *
 * A not-found failure names ONE code per category — `SESSION_NOT_FOUND` for a
 * session, `PROJECT_NOT_FOUND` for a project (AC-284) — never a shared
 * a single "target not found" code that would make the same category two
 * different codes.
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
 * gateway registers; AC-245's read tools, AC-249–AC-251's write tools and
 * AC-250's `session_create` reuse {@link resolveMcpTarget} /
 * {@link resolveInputTargets} instead of re-deriving a target. This module's
 * criterion drives both directly.
 */

import { McpToolError } from './mcp-error-envelope.js';

// --------------------------- the decision ---------------------------

/** Which list of entries a reference is resolved against. */
export type McpTargetKind = 'project' | 'session';

/** One entry the caller may pick, as a failed resolution reports it. */
export type McpResolveCandidate = {
  id: string;
  title: string;
};

/**
 * The outcome of resolving one reference.
 *
 * The successful arm carries the id and nothing else. The failed arms carry the
 * query, the kind and the candidates so a caller can retry or ask a human; there
 * is deliberately no `id` field on a failure, because a failure that also
 * suggested a target would be the resolver picking for the user.
 */
export type McpResolveResult =
  | { ok: true; id: string }
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

/** One entry a reference can resolve to: the stable id and the human-facing title. */
export type McpResolveEntry = {
  id: string;
  title: string;
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

/**
 * Resolves one caller-supplied reference to a single entry id.
 *
 * Precedence, in order: an exact (verbatim, case-sensitive) id match; then a
 * trimmed, case-insensitive substring of the title that hits exactly one entry;
 * then an ambiguity listing every hit; then not-found. Never throws and never
 * picks a winner on the caller's behalf.
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

  // An exact id is the caller already being unambiguous, so it wins before any
  // title is looked at — and the comparison is verbatim: an id that differs only
  // in case is a DIFFERENT id, not a fuzzy hit.
  const exact = entries.find((entry) => entry.id === ref);
  if (exact !== undefined) {
    return { ok: true, id: exact.id };
  }

  // An empty reference names nothing. Left to the substring rule it would match
  // EVERY entry (the empty string is a substring of everything), which would
  // turn "the caller said nothing" into "the caller said everything".
  if (query.length === 0) {
    return notFound(query, kind);
  }

  const needle = query.toLowerCase();
  const matches = entries.filter((entry) => entry.title.toLowerCase().includes(needle));

  if (matches.length === 1) {
    return { ok: true, id: matches[0].id };
  }
  if (matches.length === 0) {
    return notFound(query, kind);
  }
  return {
    ok: false,
    code: 'TARGET_AMBIGUOUS',
    query,
    kind,
    candidates: matches.map((entry) => ({ id: entry.id, title: entry.title })),
    message: `${matches.length} ${KIND_LABELS[kind]}s have a title containing "${query}"; name exactly one — the gateway will not pick for you.`,
  };
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
 * The envelope carries the same code, query and candidate list the resolver
 * produced, so a caller retries against the same reading.
 */
function resolveOrThrow(ref: string, kind: McpTargetKind, deps: McpResolveDeps): string {
  const result = resolveMcpTarget(ref, kind, deps);
  if (!result.ok) {
    throw new McpToolError(result.code, result.message, false, {
      query: result.query,
      kind: result.kind,
      candidates: result.candidates,
    });
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
 * A field that is absent, or is neither a string nor an array, belongs to some
 * other meaning and is passed through untouched; a field that IS a string
 * (including an empty one) is a target, and an empty one is refused rather than
 * silently ignored. An empty ARRAY is not a target at all — it resolves to an
 * empty array, because "name no project" is what an empty list says.
 *
 * Consumers: `mcp-gateway.transport.ts` wraps AC-245's read-tool handlers with
 * it; AC-249–AC-251's write tools and AC-250's `session_create` compose it the
 * same way instead of writing their own guard.
 */
export function resolveInputTargets(
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>,
  deps: McpResolveDeps,
): (args: Record<string, unknown>) => unknown | Promise<unknown> {
  return (args) => {
    const resolved: Record<string, unknown> = { ...args };
    for (const [field, kind] of TARGET_INPUT_FIELDS) {
      const value = resolved[field];
      if (typeof value === 'string') {
        resolved[field] = resolveOrThrow(value, kind, deps);
        continue;
      }
      if (Array.isArray(value)) {
        // Element-wise: the FIRST ambiguous or not-found element refuses the
        // whole call (gap-mcp-cross-project-session-aggregation), so no element
        // is dropped on the caller's behalf and the body never runs against a
        // subset. Non-strings ride through — the declared schema is the place a
        // wrong element type is rejected, not this gate.
        resolved[field] = value.map((element) =>
          typeof element === 'string' ? resolveOrThrow(element, kind, deps) : element,
        );
      }
    }
    return handler(resolved);
  };
}
