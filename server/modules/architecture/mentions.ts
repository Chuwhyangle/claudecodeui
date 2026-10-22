/**
 * On-demand mention provenance — the "where did this session mention that
 * entity?" search behind `POST /api/architecture/mentions`.
 *
 * The seed extractor (`seed-extraction.ts`) answers the EAGER question: which
 * entities did the transcript mention, and in which messages? This module
 * answers the LAZY one: given one or two entities the reader picked in the
 * graph, where in the transcript were they named? It is deliberately separate
 * from the extractor because its scope is different — the search runs over
 * arbitrary entity names (including ones the extractor filtered out), matches
 * paths as well as identifiers, and can include `tool_result`/Bash output when
 * the caller explicitly asks for it.
 *
 * The index is built once per (session history version, includeToolResults)
 * and cached by the service; a repeated click on the same transcript performs
 * no rescan. `MAX_MENTION_SCAN_MESSAGES` bounds one build so a pathological
 * transcript cannot stall the request.
 *
 * Consumers: `server/modules/architecture/service.ts` (the `/mentions`
 * service method) and, through the barrel, `tests/architecture-routes.test.ts`.
 */
import type { NormalizedMessage } from '@/shared/types.js';

import {
  FILE_SEED_TOOLS,
  IDENTIFIER_TOKEN,
  projectPathTokens,
  readCommand,
  readFilePath,
  seedMentionExcerpt,
  toolResultText,
  type SeedMentionHit,
  type SeedMentionKind,
} from './seed-extraction.js';

/**
 * Upper bound on the messages one index build scans.
 *
 * A transcript longer than this is read from its MOST RECENT end: provenance
 * for an old message matters less than not stalling the tab, and the flag
 * `truncated` says the reading is a prefix so the caller can be honest about it.
 */
export const MAX_MENTION_SCAN_MESSAGES = 20_000;

/** Default cap on the hits returned for one entity (the request's `limit`). */
export const DEFAULT_MENTION_HIT_LIMIT = 20;

/** One indexed transcript row, in the shape the query needs. */
type IndexedMessage = {
  readonly id: string;
  readonly role?: 'user' | 'assistant';
  readonly kind: SeedMentionKind;
  readonly at: string;
  readonly content: string;
};

/**
 * One session transcript's searchable index.
 *
 * `tokens` maps an identifier-shaped word to the message ordinals containing
 * it; `paths` maps every `/`-suffix of a path token to those ordinals, which is
 * what lets an absolute path in the transcript match the project-relative file
 * key the graph stores. Both maps point into `messages`.
 */
export type SessionMentionIndex = {
  /** Rows that can carry provenance, in transcript order. */
  readonly messages: readonly IndexedMessage[];
  readonly tokens: ReadonlyMap<string, readonly number[]>;
  readonly paths: ReadonlyMap<string, readonly number[]>;
  /** How many transcript rows were eligible to be scanned. */
  readonly scanned: number;
  /** How many transcript rows the history held (may exceed `scanned`). */
  readonly totalMessages: number;
  /** True when the scan limit dropped rows from the front of the history. */
  readonly truncated: boolean;
  readonly includeToolResults: boolean;
};

/** What one row contributes to the index, or `undefined` when it is not searchable. */
function indexedRow(
  message: NormalizedMessage,
  includeToolResults: boolean,
): { kind: SeedMentionKind; content: string } | undefined {
  if (message.kind === 'text') {
    if (message.role !== 'user' && message.role !== 'assistant') return undefined;
    return typeof message.content === 'string' && message.content.length > 0
      ? { kind: 'text', content: message.content }
      : undefined;
  }
  if (message.kind === 'tool_use') {
    if (typeof message.toolName === 'string' && FILE_SEED_TOOLS.has(message.toolName)) {
      const filePath = readFilePath(message.toolInput);
      return filePath === undefined ? undefined : { kind: 'tool_use', content: filePath };
    }
    if (includeToolResults && message.toolName === 'Bash') {
      const command = readCommand(message.toolInput);
      return command === undefined ? undefined : { kind: 'tool_result', content: command };
    }
    return undefined;
  }
  if (message.kind === 'tool_result' && includeToolResults) {
    const content = toolResultText(message);
    return content === undefined ? undefined : { kind: 'tool_result', content };
  }
  return undefined;
}

/** Add `ordinal` to `map[key]`, de-duplicated for the same row. */
function pushOrdinal(map: Map<string, number[]>, key: string, ordinal: number): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [ordinal]);
    return;
  }
  if (list.at(-1) !== ordinal) list.push(ordinal);
}

/** Index every identifier-shaped token and every path suffix of one row. */
function indexContent(tokens: Map<string, number[]>, paths: Map<string, number[]>, ordinal: number, content: string): void {
  const seenTokens = new Set<string>();
  for (const match of content.matchAll(IDENTIFIER_TOKEN)) {
    if (seenTokens.has(match[0])) continue;
    seenTokens.add(match[0]);
    pushOrdinal(tokens, match[0], ordinal);
  }

  const seenPaths = new Set<string>();
  for (const candidate of projectPathTokens(content)) {
    const normalized = candidate.token.replace(/^\.{1,2}\//, '');
    if (seenPaths.has(normalized)) continue;
    seenPaths.add(normalized);
    const segments = normalized.split('/');
    for (let start = 0; start < segments.length; start += 1) {
      pushOrdinal(paths, segments.slice(start).join('/'), ordinal);
    }
  }
}

/**
 * Build one transcript's searchable index.
 *
 * Pure and deterministic: the same rows and options always produce the same
 * maps, which is what makes the service's version key sufficient. Rows beyond
 * the scan limit are dropped from the FRONT so the reading covers the most
 * recent history.
 *
 * Consumers: `service.ts` (with an injectable wrapper so a criterion can count
 * builds) and `tests/architecture-routes.test.ts`.
 */
export function buildMentionIndex(
  messages: readonly NormalizedMessage[],
  options: { readonly includeToolResults?: boolean } = {},
): SessionMentionIndex {
  const includeToolResults = options.includeToolResults === true;
  const start = Math.max(0, messages.length - MAX_MENTION_SCAN_MESSAGES);
  const scannedRows = messages.slice(start);

  const indexed: IndexedMessage[] = [];
  const tokens = new Map<string, number[]>();
  const paths = new Map<string, number[]>();

  for (const message of scannedRows) {
    const row = indexedRow(message, includeToolResults);
    if (row === undefined) continue;
    const ordinal = indexed.length;
    indexed.push({
      id: message.id,
      ...(message.role === undefined ? {} : { role: message.role }),
      kind: row.kind,
      at: message.timestamp,
      content: row.content,
    });
    indexContent(tokens, paths, ordinal, row.content);
  }

  return {
    messages: indexed,
    tokens,
    paths,
    scanned: scannedRows.length,
    totalMessages: messages.length,
    truncated: start > 0,
    includeToolResults,
  };
}

/**
 * One provenance hit, in the wire shape both the graph tiers and `/mentions`
 * share. Aliased from the extractor's type so the two readings cannot drift.
 */
export type MentionHit = SeedMentionHit;

/** What one entity lookup found. `truncated` means the hit list was capped. */
export type MentionHitResult = {
  readonly hits: readonly MentionHit[];
  readonly truncated: boolean;
};

/**
 * Whether `name` occurs inside a backtick span of `content`.
 *
 * A backtick-wrapped name is the strongest reading (someone deliberately
 * formatted an identifier), so hits from those rows sort first. The check is
 * done per candidate row, never over the whole transcript.
 */
function isBackticked(content: string, name: string): boolean {
  for (const match of content.matchAll(/`[^`]*`/g)) {
    const span = match[0];
    if (span.includes(name)) return true;
  }
  return false;
}

/** The first offset at which `name` occurs as a whole token in `content`. */
function tokenOffset(content: string, name: string): number {
  for (const match of content.matchAll(IDENTIFIER_TOKEN)) {
    if (match[0] === name) return match.index ?? 0;
  }
  return -1;
}

/**
 * The first offset of a name OR a path in one row.
 *
 * A file query is not a single identifier token, so the literal substring is
 * tried first; a name falls back to the token scan. `-1` (no offset) is
 * normalised to 0 by the caller, which still yields a usable excerpt head.
 */
function hitOffset(content: string, text: string): number {
  const literal = content.indexOf(text);
  return literal >= 0 ? literal : tokenOffset(content, text);
}

/**
 * Candidates for one file query: rows whose content contains the file path.
 *
 * `paths` already indexes every `/`-suffix, so `file` only needs the
 * project-relative form the graph stores; an absolute path in the transcript
 * matched its suffix at build time.
 */
function fileCandidates(index: SessionMentionIndex, file: string): number[] {
  const normalized = file.replace(/^\.{1,2}\//, '');
  return [...(index.paths.get(normalized) ?? [])];
}

/** A candidate row plus the text offset and backtick priority used to order it. */
type Candidate = {
  readonly ordinal: number;
  readonly start: number;
  /** Mutated only when a name hit upgrades an earlier path-only reading. */
  backticked: boolean;
};

/** Build the hit for one candidate row. */
function candidateHit(index: SessionMentionIndex, candidate: Candidate, name: string): MentionHit {
  const row = index.messages[candidate.ordinal];
  return {
    messageId: row.id,
    ...(row.role === undefined ? {} : { role: row.role }),
    kind: row.kind,
    excerpt: seedMentionExcerpt(row.content, Math.max(0, candidate.start), name.length),
    at: row.at,
  };
}

/** Sort by backtick priority first, then transcript order. */
function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.backticked !== right.backticked) return left.backticked ? -1 : 1;
  return left.ordinal - right.ordinal;
}

/**
 * Search one entity name and/or its file path.
 *
 * The two searches are UNIONED per message (a sentence that names the entity
 * and spells its path is one hit, not two), named hits win the excerpt, and
 * backtick-wrapped rows come first. `limit` caps the returned list per entity;
 * `truncated` reports the cap.
 *
 * Consumers: `service.ts` (`readMentions`) and the route criterion.
 */
export function queryMentionIndex(
  index: SessionMentionIndex,
  query: { readonly name?: string; readonly file?: string; readonly limit?: number },
): MentionHitResult {
  const limit = query.limit ?? DEFAULT_MENTION_HIT_LIMIT;
  const byOrdinal = new Map<number, Candidate>();
  const add = (ordinal: number, name: string): void => {
    const row = index.messages[ordinal];
    if (row === undefined) return;
    const existing = byOrdinal.get(ordinal);
    const backticked = isBackticked(row.content, name);
    if (existing !== undefined) {
      existing.backticked ||= backticked;
      return;
    }
    byOrdinal.set(ordinal, { ordinal, start: hitOffset(row.content, name), backticked });
  };

  if (query.name !== undefined && query.name.length > 0) {
    for (const ordinal of index.tokens.get(query.name) ?? []) add(ordinal, query.name);
  }
  if (query.file !== undefined && query.file.length > 0) {
    for (const ordinal of fileCandidates(index, query.file)) add(ordinal, query.file);
  }

  const name = query.name ?? query.file ?? '';
  const candidates = [...byOrdinal.values()].sort(compareCandidates);
  const hits = candidates.slice(0, limit).map((candidate) => candidateHit(index, candidate, name));
  return { hits, truncated: candidates.length > limit };
}

/**
 * Messages that name BOTH endpoints of an edge.
 *
 * An edge's provenance is the sentence where the two entities meet, so the
 * intersection (not the union) is the reading; a missing endpoint name yields
 * an empty list rather than an error, because the graph may carry an id this
 * index cannot name.
 *
 * Consumers: `service.ts` (`readMentions`' `edge` arm).
 */
export function queryCoMentionIndex(
  index: SessionMentionIndex,
  first: string,
  second: string,
  limit = DEFAULT_MENTION_HIT_LIMIT,
): MentionHitResult {
  if (first.length === 0 || second.length === 0) return { hits: [], truncated: false };

  const firstRows = new Set(index.tokens.get(first) ?? []);
  const shared = (index.tokens.get(second) ?? []).filter((ordinal) => firstRows.has(ordinal));
  const candidates = shared.map((ordinal): Candidate => {
    const row = index.messages[ordinal];
    return {
      ordinal,
      start: tokenOffset(row?.content ?? '', first),
      backticked: row === undefined ? false : isBackticked(row.content, first),
    };
  }).sort(compareCandidates);

  const hits = candidates.slice(0, limit).map((candidate) => candidateHit(index, candidate, first));
  return { hits, truncated: candidates.length > limit };
}
