/**
 * Architecture seed extraction — the pure "messages → seeds" step of ADR-005
 * decision 3 (AC-416).
 *
 * The caller (AC-418, wiring the architecture route) reads a session's full
 * `NormalizedMessage[]` through the providers module's public surface and
 * hands it here together with the union of the three scopes' `nameToIds` keys.
 * This module never touches the filesystem, `.archguard/`, routes or caches:
 * it turns one transcript into the two ordered seed lists the graph
 * generator (AC-415) expands from. Keeping it pure is what lets the
 * content-addressed cache (AC-417) key on a stable, reproducible ordering.
 *
 * Seeds are tiered by SOURCE VISIBILITY, because a transcript's rows are not
 * equally intentional:
 *  · user text + assistant text — the intent core. Both go through the same
 *    rules (backtick span OR camelCase, then an EXACT `nameToIds` hit), and
 *    user text additionally contributes file seeds for pasted project-relative
 *    paths (a URL is not a path, see `projectPathCandidates`).
 *  · `tool_use` of the four file tools — Read/Edit/Write/NotebookEdit's
 *    `file_path`, kept but strictly capped: it is evidence of what was touched,
 *    not of what the person was asking about.
 *  · `tool_result` and Bash command text — nothing. They are the deepest-folded
 *    and noisiest rows (50–70% of the old entity hits); extracting from them is
 *    what turned the default view into a noise pool.
 *
 * Consumers:
 *  · `server/modules/architecture/index.ts` (this module's barrel) and, through
 *    it, the AC-418 route wiring and the graph generator.
 *  · `server/modules/architecture/tests/seed-extraction.test.ts` (AC-416).
 */
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * The two ordered seed lists `extractSeeds` returns.
 *
 * Both arrays hold first-occurrence order and contain no duplicates. `files`
 * is capped (module-private `MAX_FILE_SEEDS`); `identifiers` is capped too
 * (`MAX_IDENTIFIER_SEEDS`) so a chatty transcript cannot flood the graph.
 */
export type SeedExtractionResult = {
  files: string[];
  identifiers: string[];
};

/** Tools whose `toolInput.file_path` names a file the conversation touched. */
const FILE_SEED_TOOLS: ReadonlySet<string> = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);

/**
 * Upper bound on file seeds, applied AFTER de-duplication so a path that is
 * read repeatedly never consumes a second slot. Strict on purpose: a session
 * that reads a hundred files is a session whose *files* are incidental.
 * Module-private: a caller that needs the number should derive it from the
 * returned list.
 */
const MAX_FILE_SEEDS = 20;

/**
 * Upper bound on identifier seeds, applied AFTER de-duplication and after the
 * exact `nameToIds` filter. Same rationale as `MAX_FILE_SEEDS`: the intent core
 * stays small even when a very long session mentions many real entities.
 */
const MAX_IDENTIFIER_SEEDS = 40;

/** Identifier-shaped tokens: `[A-Za-z_$][A-Za-z0-9_$]*` (AC-416). */
const IDENTIFIER_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Inline code spans — everything between a pair of backticks is one span. */
const BACKTICK_SPAN = /`[^`]*`/g;

/**
 * A path-shaped token in prose: at least one `/`-joined segment followed by a
 * dotted extension, e.g. `src/App.tsx` or `./server/modules/architecture/x.ts`.
 *
 * The token must begin at a boundary (start of text, whitespace, or an opening
 * quote/bracket). That boundary rule — not a URL-specific check — is what keeps
 * `https://example.com/a/b.html` out: the scheme's `//` puts a `/` immediately
 * before the host, so the host never starts a match. A scheme-less URL
 * (`www.example.com/a/b.html`) is rejected by `projectPathCandidates`, which
 * refuses a first segment shaped like a hostname.
 */
const PROJECT_PATH_TOKEN =
  /(?:^|[\s`'"([{<])((?:\.{1,2}\/|\/)?[A-Za-z0-9_.@+-]+\/[A-Za-z0-9_.@+/-]*\.[A-Za-z][A-Za-z0-9]*)/g;

/** A first path segment shaped like a hostname (`example.com`, `www.example.com`). */
const HOSTNAME_SEGMENT = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * Read `file_path` out of a `tool_use` message's input.
 *
 * Provider histories hand `toolInput` over in two shapes: an already-parsed
 * object (Claude) and a JSON string (Codex rows that survived as text). A
 * string that does not parse — or one whose `file_path` is absent, empty or
 * not a string — means "this tool use names no file", never an error: the
 * transcript is untrusted input, and one malformed row must not abort the
 * extraction. The path is returned VERBATIM (no absolute/relative conversion,
 * no scope-prefix splitting) — that belongs to the caller.
 */
function readFilePath(toolInput: unknown): string | undefined {
  let parsed = toolInput;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const filePath = (parsed as { file_path?: unknown }).file_path;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
}

/**
 * Project-relative file paths pasted into one user text message, in
 * first-occurrence order (duplicates kept; the caller de-duplicates and caps).
 *
 * Only user text is scanned: an assistant answer usually spells paths inside
 * its tool calls anyway, while a path a person typed is a direct statement of
 * which file the conversation is about. Hostname-shaped first segments are
 * rejected so `www.example.com/a/b.html` is not mistaken for `a/b.html`.
 */
function projectPathCandidates(content: string): string[] {
  const candidates: string[] = [];
  for (const match of content.matchAll(PROJECT_PATH_TOKEN)) {
    const token = match[1];
    const firstSegment = token.replace(/^\.{0,2}\//, '').split('/')[0];
    if (HOSTNAME_SEGMENT.test(firstSegment)) continue;
    // A dot-directory (`…/yale/.claude`) satisfies the trailing-extension shape
    // because its name starts with the dot, but it is not a file: require a
    // non-empty stem before the extension.
    const lastSegment = token.split('/').at(-1) ?? '';
    const dot = lastSegment.lastIndexOf('.');
    if (dot <= 0 || !/^[A-Za-z][A-Za-z0-9]*$/.test(lastSegment.slice(dot + 1))) continue;
    candidates.push(token);
  }
  return candidates;
}

/**
 * Candidate identifier tokens from one text message, in first-occurrence order
 * (duplicates kept; the caller filters and de-duplicates).
 *
 * A token qualifies when EITHER of the two AC-416 rules names it:
 *  ① it sits inside a backtick span — any case counts, so an all-lowercase
 *    name like `` `reassemble` `` is still a candidate;
 *  ② it occurs anywhere in the text and contains at least one uppercase
 *    letter — the PascalCase / camelCase shape.
 *
 * The union is taken in a single left-to-right token walk so the result keeps
 * first-occurrence order across both rules rather than emitting one rule's
 * tokens ahead of the other's.
 */
function identifierCandidates(content: string): string[] {
  const spanRanges: Array<{ start: number; end: number }> = [];
  for (const match of content.matchAll(BACKTICK_SPAN)) {
    const start = match.index;
    spanRanges.push({ start, end: start + match[0].length });
  }

  const candidates: string[] = [];
  for (const match of content.matchAll(IDENTIFIER_TOKEN)) {
    const token = match[0];
    const start = match.index;
    const inSpan = spanRanges.some((range) => start >= range.start && start < range.end);
    if (inSpan || /[A-Z]/.test(token)) candidates.push(token);
  }
  return candidates;
}

/**
 * Extract file and identifier seeds from one session's normalized history.
 *
 * Pure and order-preserving: the same input always yields the same output, so
 * the AC-417 cache can key on it. `knownIdentifiers` is the union of the three
 * scopes' `nameToIds` keys, supplied by the caller — this module neither merges
 * scopes nor reads the manifest. A candidate survives only on an EXACT,
 * case-sensitive membership match, which is what filters ordinary prose and
 * external symbols out without any tokenizer guesswork.
 *
 * Rows outside the two seed tiers contribute nothing: `tool_result`, thinking
 * rows, and tool_use rows other than the four file tools (Bash included) are
 * skipped before any extraction runs.
 *
 * Consumers: `server/modules/architecture/index.ts` (barrel) → AC-418 route
 * wiring and the AC-415 graph generator; `tests/seed-extraction.test.ts`.
 */
export function extractSeeds(
  messages: readonly NormalizedMessage[],
  knownIdentifiers: ReadonlySet<string>,
): SeedExtractionResult {
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const identifiers: string[] = [];
  const seenIdentifiers = new Set<string>();

  const addFile = (filePath: string): void => {
    if (files.length >= MAX_FILE_SEEDS) return;
    if (seenFiles.has(filePath)) return;
    seenFiles.add(filePath);
    files.push(filePath);
  };

  for (const message of messages) {
    if (message.kind === 'tool_use') {
      if (typeof message.toolName !== 'string' || !FILE_SEED_TOOLS.has(message.toolName)) continue;
      const filePath = readFilePath(message.toolInput);
      if (filePath !== undefined) addFile(filePath);
      continue;
    }

    if (message.kind !== 'text') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string') continue;

    // A user's pasted project path is a file seed; an assistant's prose path is
    // not (its file evidence arrives as a `tool_use` row instead).
    if (message.role === 'user') {
      for (const filePath of projectPathCandidates(message.content)) addFile(filePath);
    }

    if (identifiers.length >= MAX_IDENTIFIER_SEEDS) continue;
    for (const token of identifierCandidates(message.content)) {
      if (identifiers.length >= MAX_IDENTIFIER_SEEDS) break;
      if (seenIdentifiers.has(token) || !knownIdentifiers.has(token)) continue;
      seenIdentifiers.add(token);
      identifiers.push(token);
    }
  }

  return { files, identifiers };
}
