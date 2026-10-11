/**
 * The MCP gateway's `session_search` handler (gap-mcp-session-search).
 *
 * The tool answers "which sessions mention this, and where" across EVERY
 * project, so a caller can find a past conversation by a phrase it remembers
 * without knowing which project or session it lived in. A hit carries the ids a
 * follow-up read needs — `sessionId` for `session_read` / `session_get`, and a
 * per-message `messageId` for `session_read({ mode: 'around' })` — so search and
 * read compose into one workflow instead of two disconnected listings.
 *
 * ## Full text, not meaning
 *
 * The scan behind this tool is the providers module's conversation search: a
 * fixed-string, case-insensitive, literal scan of the stored provider
 * transcripts (and of session titles). It is NOT semantic: a query is matched
 * against the text a session actually contains, so a synonym the transcript
 * never used does not match, and a phrase split across two messages does not
 * match either. The tool's description says so in the words a caller reads, and
 * tells them that several keyword sets are usually better than one — that is the
 * honest way to widen a literal search.
 *
 * ## What the reading is made of
 *
 * The engine streams its answer in two channels and this module merges them by
 * `sessionId`:
 *
 *  - `onTitleResults` carries the title search — the session's own title, its
 *    project and when it was last active. This is where `sessionTitle` and
 *    `lastActivity` come from, and it is the ONLY source of a title: the match
 *    channel never carries one.
 *  - `onProgress` carries one project bucket at a time with the sessions whose
 *    transcripts matched. This is where `matches[]` comes from.
 *
 * The engine returns `void`, so both channels are collected as they arrive
 * rather than read off a return value.
 *
 * ## One project, or several
 *
 * The optional `project` filter accepts ONE id or an ARRAY of ids
 * (gap-mcp-cross-project-session-aggregation). An array makes "the sessions in A
 * or B that mention this" a first-class reading: the hits are the union over the
 * named projects, each row still carries the `projectId` / `projectDisplayName`
 * it was found under, and the payload adds `byProject` — the same sessions
 * grouped by owning project, counts summing to `totalResults`. The array is
 * resolved element by element by the target gate, so a name is accepted in
 * either form and an element that is ambiguous or names nothing refuses the
 * whole call rather than returning a partial aggregate.
 *
 * ## Pagination, declared honestly
 *
 * `limit` bounds how many SESSIONS one page returns (not how many matches). The
 * `cursor` is a KEYSET over two positions, both required to page without loss or
 * duplication:
 *
 *  - a scan frontier `(updated_at, path)` — where the engine's capped scan
 *    stopped, so the next call resumes strictly after the files already read;
 *  - a within-slab anchor `(score, sessionId)` — the last hit of the page, so
 *    the next page starts strictly after it in the deterministic
 *    {@link sessionMatchScore}-then-id order.
 *
 * The engine scans at most 200 FILES or 3000 ms per call (whichever is reached
 * first) and reports `hasMore` / `scannedThrough`; when the slab is exhausted and
 * files remain, the anchor resets and the frontier advances to the next slab.
 * A session that gains or loses a match between two calls can still shift what
 * the anchor names, so the token is best-effort rather than a snapshot — the tool
 * description says so in words. The LEGACY skip-count cursor (base64 of an
 * integer, no version prefix) is still accepted and translated into the keyset
 * form, so a caller holding a token from before this task keeps paging.
 * `moreAvailable` remains the presence-of-cursor predicate it always was.
 *
 * ## What `score` is (and is not)
 *
 * `score` is a DETERMINISTIC sort key, not a relevance probability: the number
 * of matches in the session, plus a bonus for hits that contain the whole query
 * as one phrase, plus a small recency tier. It exists to put the session a
 * caller probably means first; nothing about it is learned, calibrated or
 * comparable across queries. The module documents it here so the output docs can
 * say the same thing.
 *
 * Everything the tool reads is injected ({@link McpSessionSearchDeps}), so the
 * gateway owns no database handle and the criterion drives the real engine over
 * its own fixture. The deps are OPTIONAL on {@link McpReadToolDeps}: a mount that
 * predates this task keeps the named `MCP_TOOL_NOT_IMPLEMENTED` refusal, exactly
 * like the overview / run_get placeholders before their tasks landed.
 */

import { z } from 'zod';

import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import {
  MCP_SESSION_SEARCH_DEFAULT_LIMIT,
  readTimeField,
} from './mcp-gateway.read-tools.js';
import type { McpReadToolDeps, McpReadToolSeam, McpTime } from './mcp-gateway.read-tools.js';

// --------------------------- engine-facing vocabulary ---------------------------

/**
 * The slice of one title-search row this tool reads (structurally satisfied by
 * the engine's `SessionTitleSearchResult`). Only the fields the reading carries
 * are named, so the engine can grow without this module restating it.
 */
type McpSessionSearchTitleRow = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
};

/** The slice of one engine match this tool reads (structurally satisfied by `SessionConversationMatch`). */
type McpSessionSearchEngineMatch = {
  role: string;
  snippet: string;
  highlights: ReadonlyArray<{ start: number; end: number }>;
  timestamp: string | null;
  /** The provider's own per-row id; the engine sets it for Claude rows and leaves it absent otherwise. */
  messageUuid?: string | null;
};

/** The slice of one matched session this tool reads (structurally satisfied by `SessionConversationResult`). */
type McpSessionSearchEngineSession = {
  sessionId: string;
  provider: string;
  matches: ReadonlyArray<McpSessionSearchEngineMatch>;
};

/** The slice of one project bucket this tool reads (structurally satisfied by `ProjectConversationResult`). */
type McpSessionSearchEngineProject = {
  projectId: string | null;
  projectDisplayName: string;
  sessions: ReadonlyArray<McpSessionSearchEngineSession>;
};

/** The slice of one progress update this tool reads (structurally satisfied by `SessionConversationSearchProgressUpdate`). */
type McpSessionSearchProgressUpdate = {
  projectResult: McpSessionSearchEngineProject | null;
};

/** Where a scan stopped, as the engine reports it (structurally satisfied by `SessionScanFrontier`). */
type McpSessionSearchEngineFrontier = {
  atMs: number;
  path: string;
};

/** What one engine search reported about where its scan stopped (structurally satisfied by `SessionConversationSearchSummary`). */
type McpSessionSearchEngineSummary = {
  /** True when the scan hit its file/wall-clock ceiling or files remain past the slab it read. */
  hasMore: boolean;
  /** The oldest activity instant the scan actually read, as an ISO string, or null when it read nothing. */
  scannedThrough: string | null;
  /** The next call's `resumeFrom`, or null when there is nothing further to read. */
  nextScanFrom: McpSessionSearchEngineFrontier | null;
};

/** The engine call this tool makes (structurally satisfied by `SearchSessionConversationsInput`). */
type McpSessionSearchEngineInput = {
  query: string;
  limit: number;
  /** Inclusive lower bound on a session's last activity (ISO 8601); out-of-window sessions are never scanned. */
  since?: string;
  /** Inclusive upper bound on a session's last activity (ISO 8601). */
  until?: string;
  /** The `nextScanFrom` a previous call returned; the scan resumes strictly after it. */
  resumeFrom?: McpSessionSearchEngineFrontier | null;
  onProgress?: (update: McpSessionSearchProgressUpdate) => void;
  onTitleResults?: (results: ReadonlyArray<McpSessionSearchTitleRow>) => void;
  signal?: AbortSignal;
};

/**
 * The services `session_search` answers from, all injected.
 *
 * `search` is the providers module's conversation-search engine — the SAME
 * function the session-search route calls, so an MCP caller and the browser read
 * one scanner over one transcript store. In production `server/index.ts` binds
 * it to `sessionConversationsSearchService.search`, imported through the
 * providers barrel; this module never reaches that service by path, so the
 * gateway's dependency stays an injected verb. `now` is the clock the recency
 * half of {@link sessionMatchScore} is computed against, injected so a criterion
 * can pin an ordering instead of inferring one.
 *
 * `outlineFor` reads one session's user-turn outline — the SAME numbering
 * `session_read`'s `mode: "outline"` prints as `#index`, so a match's
 * `turnIndex` and that outline line up. Optional: a mount that predates this
 * field still answers, with every `turnIndex` reading null rather than a guessed
 * number.
 */
export type McpSessionSearchDeps = {
  /** Runs one conversation search, streaming its two channels to the callbacks the caller supplies, and reports where its capped scan stopped. */
  search(input: McpSessionSearchEngineInput): Promise<McpSessionSearchEngineSummary | void>;
  /** Clock seam, so the recency tier of the sort key is reproducible. */
  now: () => number;
  /** One session's user-turn outline (id → index), for aligning a hit's `turnIndex`. */
  outlineFor?: (sessionId: string) => Promise<ReadonlyArray<{ id: string; index: number }>>;
};

/** Whether the injected deps carry the search engine, i.e. this tool is wired. */
export function isSessionSearchWired(
  deps: McpReadToolDeps,
): deps is McpReadToolDeps & { sessionSearch: McpSessionSearchDeps } {
  return deps.sessionSearch !== undefined;
}

// --------------------------- weights ---------------------------

/**
 * The ceiling handed to the ENGINE, which caps its own scan at 200 matches.
 * Asking for the cap means the page this tool slices is drawn from everything
 * the engine can find in one pass, so `moreAvailable` reflects the engine's
 * ceiling only — and that limit is stated in the tool's description.
 */
const ENGINE_MATCH_LIMIT = 200;

/** Sort-key weight of one match in a session. */
const SCORE_PER_MATCH = 1;
/** Sort-key bonus added once when a match snippet contains the whole query verbatim (case-insensitive). */
const SCORE_EXACT_PHRASE = 2;
/** Recency tiers: a session active within this window scores highest, then the next, then the last. */
const RECENCY_DAY_MS = 24 * 60 * 60 * 1000;

// --------------------------- input ---------------------------

/** The `session_search` tool's typed input. */
export type McpSessionSearchInput = {
  query: string;
  /**
   * One project id, or several to aggregate across (gap-mcp-cross-project-
   * session-aggregation). The target gate has already resolved names to ids by
   * the time this reaches the handler; a name fragment is still auto-upgradeable
   * here without a schema change.
   */
  project?: string | string[];
  provider?: 'claude' | 'codex';
  speaker?: 'user' | 'assistant' | 'any';
  /** How many SESSIONS to return, 1..{@link MCP_SESSION_SEARCH_MAX_LIMIT}. */
  limit?: number;
  /**
   * Inclusive lower bound on a session's last activity (ISO 8601). A session
   * whose last activity is before this is pruned BEFORE the scan, so its
   * transcript is never handed to ripgrep.
   */
  since?: string;
  /** Inclusive upper bound on a session's last activity (ISO 8601). See {@link McpSessionSearchInput.since}. */
  until?: string;
  /** Opaque continuation token from a previous call (see the module doc). */
  cursor?: string;
  /** Reserved. The only accepted value today is `'fulltext'`. */
  mode?: 'fulltext';
};

/**
 * Reads the `project` argument: a single id, or an array of ids, or nothing.
 *
 * The declared schema already restricts this to `string | string[]`; a blank
 * string or an array whose every element is blank names nothing and reads as
 * absent, so a caller who passed an empty array gets the unscoped reading rather
 * than an empty result set.
 */
function readProjectArgument(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (Array.isArray(value)) {
    const ids = value.filter((element): element is string => typeof element === 'string' && element.length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  return undefined;
}

/**
 * Reads and validates `session_search`'s arguments.
 *
 * The transport has already validated the declared shape, so this reads the
 * typed values off it; the `query` check is repeated because {@link
 * buildSessionSearch} is also reachable directly from a criterion, and a blank
 * query is a caller mistake rather than an empty result.
 */
function readSessionSearchInput(args: Record<string, unknown>): McpSessionSearchInput {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length === 0) {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, '"query" is required and must be a non-empty string.');
  }
  return {
    query,
    project: readProjectArgument(args.project),
    provider: args.provider === 'claude' || args.provider === 'codex' ? args.provider : undefined,
    speaker:
      args.speaker === 'user' || args.speaker === 'assistant' || args.speaker === 'any' ? args.speaker : undefined,
    limit: typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined,
    since: typeof args.since === 'string' && args.since.length > 0 ? args.since : undefined,
    until: typeof args.until === 'string' && args.until.length > 0 ? args.until : undefined,
    cursor: typeof args.cursor === 'string' && args.cursor.length > 0 ? args.cursor : undefined,
    mode: args.mode === 'fulltext' ? 'fulltext' : undefined,
  };
}

// --------------------------- payload ---------------------------

/** One matching message inside a matched session. */
export type McpSessionSearchMatchReading = {
  /**
   * The provider's own per-row id for this message, or `null` when the provider
   * does not hand one out (Codex rows). A non-null value is exactly what
   * `session_read({ mode: 'around', aroundId })` accepts, so a caller can expand
   * the hit into its surrounding window.
   */
  messageId: string | null;
  role: string;
  timestamp: McpTime | null;
  /** The matched text, with the provider's own ANSI/control sequences stripped. */
  snippet: string;
  /** Where the query's words sit inside the snippet, as `[start, end)` character offsets. */
  highlights: Array<{ start: number; end: number }>;
  /**
   * The session's user-turn index this match belongs to — the SAME `#index`
   * `session_read({ mode: 'outline' })` prints for the turn whose id equals this
   * match's `messageId`. `null` when the match has no per-row id (Codex rows), or
   * when the id names no user turn in the outline (an assistant-only match), so
   * a caller never reads a guessed number as an alignment.
   */
  turnIndex: number | null;
};

/** One matched session, with the matches found inside it. */
export type McpSessionSearchHit = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: McpTime | null;
  /** The deterministic sort key (see the module doc); higher sorts first. */
  score: number;
  matches: McpSessionSearchMatchReading[];
};

/** One project's share of the filtered result set, for the `byProject` aggregate. */
export type McpSessionSearchProjectSummary = {
  /** The owning project's id, or `null` for a session no project claims. */
  projectId: string | null;
  projectDisplayName: string;
  /** How many matched SESSIONS this project owns in the filtered set. */
  count: number;
};

/** The `session_search` tool's success result. */
export type McpSessionSearchPayload = {
  query: string;
  /** Total matches across every session the FILTERS kept, before the page was cut. */
  totalMatches: number;
  /** How many SESSIONS every filter kept, before the page was cut (the page may be shorter). */
  totalResults: number;
  /**
   * The filtered sessions grouped by owning project, newest count first — the
   * aggregate a multi-project `project` filter exists to produce. The counts sum
   * to {@link McpSessionSearchPayload.totalResults}.
   */
  byProject: McpSessionSearchProjectSummary[];
  /** Whether sessions remain past this page; the presence of `cursor` says the same thing. */
  moreAvailable: boolean;
  /**
   * Whether sessions remain past this page. The same reading as
   * {@link McpSessionSearchPayload.moreAvailable}, named for the paging model
   * the engine's capped scan reports: true when this page did not exhaust
   * everything the scan can still reach.
   */
  hasMore: boolean;
  /**
   * The oldest activity instant this call's scan actually read (ISO 8601), or
   * null when it read nothing. A progress marker, not the cursor.
   */
  scannedThrough: McpTime | null;
  results: McpSessionSearchHit[];
  /** Present only when more sessions remain (see the module doc). */
  cursor?: string;
  /** The same token as {@link McpSessionSearchPayload.cursor}, under the name the capped-scan model uses. */
  nextCursor?: string;
};

// --------------------------- scoring ---------------------------

/**
 * The deterministic sort key for one matched session.
 *
 * Three readable ingredients, no learned model: one point per match, a bonus of
 * {@link SCORE_EXACT_PHRASE} when a snippet contains the whole query as one
 * phrase (the strongest evidence a caller meant THIS session), and a recency
 * tier from the session's last activity — 3 within a day, 2 within a week, 1
 * within a month, 0 otherwise or when the session carries no activity stamp.
 *
 * Consumers: {@link buildSessionSearch}, which sorts by it, and the criterion,
 * which pins an expected ordering over a fixture rather than accepting whatever
 * order the engine happened to produce.
 */
export function sessionMatchScore(
  matchCount: number,
  exactPhraseHits: number,
  lastActivityMs: number | null,
  now: number,
): number {
  let score = matchCount * SCORE_PER_MATCH + exactPhraseHits * SCORE_EXACT_PHRASE;
  if (lastActivityMs !== null) {
    const age = Math.max(0, now - lastActivityMs);
    if (age < RECENCY_DAY_MS) score += 3;
    else if (age < 7 * RECENCY_DAY_MS) score += 2;
    else if (age < 30 * RECENCY_DAY_MS) score += 1;
  }
  return score;
}

// --------------------------- cursor ---------------------------

/**
 * A within-slab keyset position: the (score, sessionId) of a page's last hit.
 *
 * `score` is `sessionMatchScore`'s output and `sessionId` the tie-break, so
 * together they are a strict total order over the hits of one scan — the order
 * {@link buildSessionSearch} sorts by and pages through.
 */
type McpSessionSearchAnchor = {
  score: number;
  sessionId: string;
};

/** What one call's cursor names: where to resume the scan, and/or where to resume within the scanned slab. */
type DecodedSessionCursor =
  | { kind: 'keyset'; ss: McpSessionSearchEngineFrontier | null; a: McpSessionSearchAnchor | null }
  | { kind: 'legacy'; skip: number };

/** The version prefix that marks a keyset cursor; a token without it is the pre-task skip count. */
const SESSION_CURSOR_VERSION_PREFIX = 'v1:';

/** The cursor payload for a keyset token. */
type SessionCursorPayload = {
  v: 1;
  ss: McpSessionSearchEngineFrontier | null;
  a: McpSessionSearchAnchor | null;
};

/** Whether a value read off a decoded cursor is a well-formed scan frontier. */
function isFrontier(value: unknown): value is McpSessionSearchEngineFrontier {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.atMs === 'number' && typeof candidate.path === 'string';
}

/** Whether a value read off a decoded cursor is a well-formed keyset anchor. */
function isAnchor(value: unknown): value is McpSessionSearchAnchor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.score === 'number' && typeof candidate.sessionId === 'string';
}

/** Encodes a keyset cursor: base64 of `v1:` + the JSON payload, so the version is readable in the prefix byte. */
function encodeSessionCursor(payload: SessionCursorPayload): string {
  return Buffer.from(`${SESSION_CURSOR_VERSION_PREFIX}${JSON.stringify(payload)}`, 'utf8').toString('base64');
}

/**
 * Decodes a cursor, accepting BOTH encodings.
 *
 * A `v1:`-prefixed token is the keyset payload; anything else is read as the
 * pre-task skip count (base64 of an integer). Anything unreadable — a wrong
 * version, malformed JSON, or a non-numeric legacy token — restarts at the
 * beginning, exactly as the skip-count decoder always did.
 */
function decodeSessionCursor(cursor: string | undefined): DecodedSessionCursor {
  const fresh: DecodedSessionCursor = { kind: 'keyset', ss: null, a: null };
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return fresh;
  }
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  if (decoded.startsWith(SESSION_CURSOR_VERSION_PREFIX)) {
    try {
      const payload = JSON.parse(decoded.slice(SESSION_CURSOR_VERSION_PREFIX.length)) as Record<string, unknown>;
      if (payload.v === 1) {
        const ss = payload.ss;
        const a = payload.a;
        if ((ss === null || isFrontier(ss)) && (a === null || isAnchor(a))) {
          return { kind: 'keyset', ss: ss as McpSessionSearchEngineFrontier | null, a: a as McpSessionSearchAnchor | null };
        }
      }
    } catch {
      // fall through to the fresh cursor
    }
    return fresh;
  }
  const skip = Number.parseInt(decoded, 10);
  return Number.isFinite(skip) && skip > 0 ? { kind: 'legacy', skip } : fresh;
}

/**
 * Whether a hit comes strictly after a keyset anchor in the (score DESC,
 * sessionId ASC) page order — the comparison a resumed page keys on, so no hit
 * is repeated or skipped.
 */
function isHitAfterAnchor(hit: McpSessionSearchHit, anchor: McpSessionSearchAnchor): boolean {
  if (hit.score !== anchor.score) {
    return hit.score < anchor.score;
  }
  return hit.sessionId.localeCompare(anchor.sessionId) > 0;
}

// --------------------------- the search ---------------------------

/** One session as the two engine channels together describe it. */
type CollectedSession = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  matches: McpSessionSearchEngineMatch[];
};

/** The parsed activity stamp behind a sort key, or `null` when there is none to read. */
function readActivityMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Groups the filtered hits by owning project.
 *
 * The aggregate a multi-project `project` filter exists to produce: one row per
 * project that owns at least one hit, carrying the display name and how many
 * matched SESSIONS it contributed. The counts sum to the number of hits, which is
 * the invariant the criterion pins. Ordered by count DESC then project id, so the
 * biggest contributor leads and ties are stable across calls (a project-less
 * session, `projectId: null`, sorts last when counts tie because its id reads
 * `null` first under the same comparator — the comparator is written to avoid
 * calling `localeCompare` on `null`).
 */
function summarizeByProject(hits: readonly McpSessionSearchHit[]): McpSessionSearchProjectSummary[] {
  const byId = new Map<string | null, McpSessionSearchProjectSummary>();
  for (const hit of hits) {
    const existing = byId.get(hit.projectId);
    if (existing === undefined) {
      byId.set(hit.projectId, {
        projectId: hit.projectId,
        projectDisplayName: hit.projectDisplayName,
        count: 1,
      });
    } else {
      existing.count += 1;
    }
  }
  return [...byId.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return (left.projectId ?? '').localeCompare(right.projectId ?? '');
  });
}

/** The summary a search that reported none reads as: nothing scanned, nothing more. */
const NO_SCAN_SUMMARY: McpSessionSearchEngineSummary = { hasMore: false, scannedThrough: null, nextScanFrom: null };

/**
 * Fills in each page hit's `turnIndex` from the injected outline reader.
 *
 * One outline read per session (cached across the page), and only for sessions
 * that actually have a match carrying a `messageId` — a Codex-only page costs no
 * reads. An outline that cannot be read leaves every `turnIndex` null rather
 * than failing the whole search: the alignment is an extra, not the reading.
 */
async function attachTurnIndexes(
  page: readonly McpSessionSearchHit[],
  deps: McpSessionSearchDeps,
): Promise<void> {
  const outlineFor = deps.outlineFor;
  if (outlineFor === undefined) {
    return;
  }

  const indexesBySession = new Map<string, Map<string, number>>();
  for (const hit of page) {
    const ids = hit.matches
      .map((match) => match.messageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) {
      continue;
    }

    let indexById = indexesBySession.get(hit.sessionId);
    if (indexById === undefined) {
      indexById = new Map<string, number>();
      try {
        for (const turn of await outlineFor(hit.sessionId)) {
          indexById.set(turn.id, turn.index);
        }
      } catch {
        // An unreadable outline leaves every turnIndex null.
      }
      indexesBySession.set(hit.sessionId, indexById);
    }

    for (const match of hit.matches) {
      match.turnIndex = typeof match.messageId === 'string' ? indexById.get(match.messageId) ?? null : null;
    }
  }
}

/**
 * The `session_search` reading.
 *
 * Runs one engine search, merges the two channels by `sessionId`, applies the
 * caller's `project` / `provider` / `speaker` / `since` / `until` filters, sorts
 * by {@link sessionMatchScore}, then cuts the requested page. `project` may name
 * ONE project or SEVERAL (gap-mcp-cross-project-session-aggregation): the hits
 * are the union over those projects, each row still carrying its own
 * `projectId` / `projectDisplayName`, and {@link summarizeByProject} adds the
 * per-project aggregate. A single-string call therefore reads exactly as it did
 * before the array form existed.
 *
 * `since` / `until` are handed to the ENGINE, not applied here: the engine
 * prunes sessions by `updated_at` before it scans, so an out-of-window session's
 * transcript is never read at all. The same goes for the scan ceiling — the
 * engine scans at most its file/time cap per call and reports
 * {@link McpSessionSearchEngineSummary.hasMore}, which this function turns into
 * a cursor. `scannedThrough` is passed straight through.
 *
 * An empty result is a legitimate reading, not a failure: "nothing mentions this
 * phrase" is exactly what the caller asked, so `results: []` with
 * `totalMatches: 0` is a success. The engine is called with
 * {@link ENGINE_MATCH_LIMIT} so the page is drawn from everything its single
 * scan can find.
 *
 * Consumers: {@link registerMcpSessionSearchTool}, and the criterion, which
 * drives it over a real transcript fixture.
 */
export async function buildSessionSearch(
  input: McpSessionSearchInput,
  deps: McpSessionSearchDeps,
): Promise<McpSessionSearchPayload> {
  const cursor = decodeSessionCursor(input.cursor);
  const collected = new Map<string, CollectedSession>();
  const titles = new Map<string, McpSessionSearchTitleRow>();

  const engineResult = await deps.search({
    query: input.query,
    limit: ENGINE_MATCH_LIMIT,
    since: input.since,
    until: input.until,
    resumeFrom: cursor.kind === 'keyset' ? cursor.ss : null,
    onTitleResults: (results) => {
      for (const row of results) {
        titles.set(row.sessionId, row);
      }
    },
    onProgress: (update) => {
      const project = update.projectResult;
      if (project === null) {
        return;
      }
      for (const session of project.sessions) {
        collected.set(session.sessionId, {
          sessionId: session.sessionId,
          provider: session.provider,
          projectId: project.projectId,
          projectDisplayName: project.projectDisplayName,
          matches: [...session.matches],
        });
      }
    },
  });
  // Tolerant of a mount whose `search` still returns void (an older stub): the
  // page then has no ceiling and simply reports "nothing more".
  const summary: McpSessionSearchEngineSummary = engineResult ?? NO_SCAN_SUMMARY;

  const now = deps.now();
  // The project filter as a SET, so one id and an array of ids take the one
  // path: `null` is "no filter", anything else is the set of projects in scope.
  // A scoped session whose project is unknown (`null`) is out of scope, exactly
  // as a single-project filter has always treated it.
  const projectFilter: Set<string> | null =
    input.project === undefined
      ? null
      : new Set(Array.isArray(input.project) ? input.project : [input.project]);
  const hits: McpSessionSearchHit[] = [];
  for (const session of collected.values()) {
    if (input.provider !== undefined && session.provider !== input.provider) {
      continue;
    }
    if (projectFilter !== null && (session.projectId === null || !projectFilter.has(session.projectId))) {
      continue;
    }
    // `speaker: 'any'` (and an omitted `speaker`) keeps every match; a named role
    // narrows the matches THEMSELVES, because a caller asking for what the user
    // said does not want the assistant's half of the same session.
    const matches = input.speaker === undefined || input.speaker === 'any'
      ? session.matches
      : session.matches.filter((match) => match.role === input.speaker);
    if (matches.length === 0) {
      continue;
    }

    const title = titles.get(session.sessionId);
    const lastActivityMs = readActivityMs(title?.lastActivity);
    const loweredQuery = input.query.toLowerCase();
    const exactPhraseHits = matches.filter((match) => match.snippet.toLowerCase().includes(loweredQuery)).length;

    hits.push({
      sessionId: session.sessionId,
      provider: session.provider,
      projectId: session.projectId,
      projectDisplayName: session.projectDisplayName,
      // A session whose title the title channel did not report still answers:
      // the reading keeps a row rather than dropping a session the transcript
      // scan proved exists.
      sessionTitle: title?.sessionTitle ?? '',
      lastActivity: readTimeField(title?.lastActivity, deps.now),
      score: sessionMatchScore(matches.length, exactPhraseHits, lastActivityMs, now),
      matches: matches.map((match) => ({
        messageId: typeof match.messageUuid === 'string' && match.messageUuid.length > 0 ? match.messageUuid : null,
        role: match.role,
        timestamp: readTimeField(match.timestamp, deps.now),
        snippet: match.snippet,
        highlights: match.highlights.map((highlight) => ({ start: highlight.start, end: highlight.end })),
        turnIndex: null,
      })),
    });
  }

  // Deterministic ordering: score first, then session id, so two sessions with
  // the same score always page in the same order across calls.
  hits.sort((left, right) => right.score - left.score || left.sessionId.localeCompare(right.sessionId));

  const totalMatches = hits.reduce((sum, hit) => sum + hit.matches.length, 0);
  const totalResults = hits.length;
  const byProject = summarizeByProject(hits);
  const limit = input.limit ?? MCP_SESSION_SEARCH_DEFAULT_LIMIT;

  // Where this page starts: a legacy token skips that many hits in the fresh
  // order (the pre-task reading); a keyset token starts strictly after its
  // anchor; a fresh token starts at the top of the scanned slab.
  const candidates = cursor.kind === 'legacy'
    ? hits.slice(cursor.skip)
    : cursor.a === null
      ? hits
      : hits.filter((hit) => isHitAfterAnchor(hit, cursor.a as McpSessionSearchAnchor));
  const page = candidates.slice(0, limit);
  const remainingInSlab = candidates.length - page.length;
  const lastPageHit = page.length > 0 ? page[page.length - 1] : null;

  // Two ways a further page exists: hits remain in THIS scan's slab (advance the
  // anchor), or the scan stopped short and left files unread (advance the
  // frontier, reset the anchor).
  let nextToken: string | null = null;
  if (remainingInSlab > 0 && lastPageHit !== null) {
    nextToken = encodeSessionCursor({
      v: 1,
      ss: cursor.kind === 'keyset' ? cursor.ss : null,
      a: { score: lastPageHit.score, sessionId: lastPageHit.sessionId },
    });
  } else if (summary.hasMore && summary.nextScanFrom !== null) {
    nextToken = encodeSessionCursor({ v: 1, ss: summary.nextScanFrom, a: null });
  }
  const moreAvailable = nextToken !== null;

  await attachTurnIndexes(page, deps);

  return {
    query: input.query,
    totalMatches,
    totalResults,
    byProject,
    moreAvailable,
    hasMore: moreAvailable,
    scannedThrough: readTimeField(summary.scannedThrough, deps.now),
    results: page,
    ...(nextToken !== null ? { cursor: nextToken, nextCursor: nextToken } : {}),
  };
}

// --------------------------- registration ---------------------------

/**
 * One tool's metadata as `registerMcpReadTools` hands it down: the name,
 * description and scope read from the stage-3 table, plus the two schemas. No
 * handler — this module owns the behaviour.
 */
export type McpSessionSearchRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /** A raw shape, or a built schema carrying a constraint (the shared body-table type). */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

/**
 * Registers `session_search` through the audited read seam.
 *
 * The name, description, scope and both schemas come from the caller (the
 * stage-3 table plus its body-table entry), so this module owns the BEHAVIOUR
 * and `mcp-gateway.read-tools.js` remains the one statement of the name set.
 * `registerMcpReadTools` calls this only when the deps carry the search engine;
 * an unwired mount keeps the body-table's named refusal instead.
 *
 * Consumers: `mcp-gateway.read-tools.js`'s `registerMcpReadTools` (the single
 * call site).
 */
export function registerMcpSessionSearchTool(
  seam: McpReadToolSeam,
  deps: McpSessionSearchDeps,
  registration: McpSessionSearchRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: (args) => buildSessionSearch(readSessionSearchInput(args), deps),
  });
}
