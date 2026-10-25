/**
 * Reference targets: the retype-able things in one assistant reply.
 *
 * A person composing a follow-up often retypes something the agent just
 * produced — a file path, an identifier, a shell line, occasionally a heading.
 * This module turns a reply into a stable list of those targets and resolves
 * the fragment before the caret against it, so the composer can offer the rest
 * of the word.
 *
 * Deliberately separate from `replyItems.ts`:
 *
 * - Numbered reply items are an ADDRESS (「第 1 点」, ①②, `#item-n`) and stay a
 *   small, ordered list. Reference targets are a SEARCH SET and are never
 *   numbered: a reply can carry a hundred of them and ① would mean nothing.
 * - The preview measured in the 2026-10-24 probe was used on 6% of turns and is
 *   not the surface this module serves. Nothing here imports or produces
 *   ordinals.
 *
 * Everything is a pure function of its inputs. The corpus replay in
 * `experiments/caret-item-matching/` and the (not yet wired) composer preview
 * would run the same functions, so their answers cannot disagree.
 *
 * Not wired into the composer: this module ships the mechanism only.
 */

/** The shapes a reply offers to a person who is about to retype one of them. */
export type ReferenceTargetKind = 'path' | 'identifier' | 'code-line' | 'heading' | 'paragraph';

/** One target extracted from a reply, in document order. */
export type ReferenceTarget = {
  kind: ReferenceTargetKind;
  /** The verbatim text an acceptance inserts. */
  text: string;
  /**
   * Keys the caret query may prefix-match, strongest first: the full text, and
   * for a path also its trailing segment joins and its basename (a person types
   * `referenceTargets`, not `src/modules/chat/utils/transcript/referenceTargets.ts`).
   */
  matchKeys: readonly string[];
  /** 0-based line in the reply; used for stable ordering and debugging. */
  line: number;
  /** The trimmed line it came from, for disambiguating two same-named targets. */
  context: string;
};

/** The fragment before the caret that matching runs on. */
export type CaretQuery = {
  query: string;
  /** Where the fragment starts in the prefix, so an acceptance can replace it. */
  start: number;
};

/** One ranked candidate for the caret fragment. */
export type CaretMatch = {
  target: ReferenceTarget;
  /** The match key the fragment hit. */
  matchedKey: string;
  /** Normalised characters the fragment covered; longer means more was typed. */
  matchedChars: number;
  /** Ranking score; the caller only orders by it and never reads a probability. */
  score: number;
};

/** Knobs the corpus replay sweeps; the defaults are the proposed v1. */
export type ReferenceTargetOptions = {
  /** Normalised characters the fragment must cover before anything is offered. */
  minQueryChars?: number;
  /** How many candidates the caller may show. */
  maxCandidates?: number;
  /** Paragraphs are off by default: arbitrary prose is where false offers explode. */
  includeParagraphs?: boolean;
  includeHeadings?: boolean;
  includeCodeLines?: boolean;
  /** Longest CJK suffix tried against a target; Chinese has no word boundary. */
  cjkSuffixMax?: number;
  /** Whether a path may be matched by its basename / trailing segments. */
  basenameKeys?: boolean;
  /**
   * Whether a fragment that is not code-shaped (`server`, `architecture`) may
   * offer anything at all. On by default: the corpus replay's false offers were
   * overwhelmingly plain technical nouns that also name a file or symbol.
   */
  requireCodeShape?: boolean;
};

const DEFAULT_MIN_QUERY_CHARS = 3;
const DEFAULT_MAX_CANDIDATES = 3;
const DEFAULT_CJK_SUFFIX_MAX = 8;
const DEFAULT_REQUIRE_CODE_SHAPE = true;
const MAX_TARGET_TEXT = 240;
const MAX_MATCH_KEYS = 12;

const FENCE_LINE = /^\s{0,3}(?:```|~~~)/;
const TABLE_LINE = /^\s*\|/;
const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;
const LIST_LINE = /^\s*(?:[-*+]|\d{1,2}[.)、）])\s+/;
const ASCII_RUN_AT_END = /[A-Za-z0-9_./@-]+$/;
const CJK_RUN_AT_END = /[一-鿿]+$/;
const ASCII_TOKEN = /[A-Za-z0-9_@.~/\\-]+/g;
const URL_LIKE = /^(?:https?|cloudcli|file|ws|wss):\/\//i;
const FILE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|py|rb|go|rs|java|kt|kts|swift|yml|yaml|toml|ini|sh|bash|zsh|fish|css|scss|less|html|xml|svg|sql|proto|graphql|gql|lock|txt|csv|log|conf|env)$/i;
const ID_WITH_ISSUE = /^(?:AC|GOAL|ADR|DIR|RC|GAP|M)-\d+$/;
const SNAKE_CASE = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;
const CAMEL_CASE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const PASCAL_CASE = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/;
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const TRAILING_NOISE = /[.,:;!?)\]}>'"”’。，、；：！？）】》「」]+$/;

/** Kind priority: a path beats an identifier beats a code line beats a heading. */
const KIND_PRIORITY: Record<ReferenceTargetKind, number> = {
  path: 4,
  identifier: 3,
  'code-line': 2,
  heading: 1,
  paragraph: 0,
};

/**
 * The string matching actually compares: case-folded, with every separator
 * removed. `src/a.ts`, `src/A.ts` and `src/a` therefore share their first
 * characters, which is what makes a typed prefix stable across spelling.
 */
export function normalizeReferenceTarget(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^0-9a-z一-鿿]+/g, '');
}

/** Strips punctuation a reply wraps a token in, and a call's trailing `()`. */
function trimToken(token: string): string {
  return token
    .replace(TRAILING_NOISE, '')
    .replace(/^[("'「『【]+/, '')
    .replace(/\(\)$/, '')
    .trim();
}

/** Whether a token is a path-ish thing a person would retype whole. */
function isPathToken(token: string): boolean {
  if (token.length < 4 || token.length > MAX_TARGET_TEXT) {
    return false;
  }
  if (URL_LIKE.test(token)) {
    return false;
  }
  if (FILE_EXTENSION.test(token)) {
    return true;
  }
  // A bare directory (`src/modules/chat`) is addressable too, but `and/or` is
  // not: require at least one path segment that is not a one-word conjunction.
  return token.includes('/') && /[A-Za-z0-9]\/[A-Za-z0-9]/.test(token) && token.split('/').every((part) => part !== '');
}

/**
 * Whether a token is a code identifier rather than an English word.
 *
 * The markers are intentionally narrow: prose is full of capitalised products
 * (`GitHub`), and offering to complete one of those is noise. A token has to
 * carry a shape only source code uses — snake_case, camelCase with two humps,
 * a multi-segment kebab id, or an issue-style id.
 */
function isIdentifierToken(token: string): boolean {
  if (token.length < 5 || token.length > MAX_TARGET_TEXT) {
    return false;
  }
  if (URL_LIKE.test(token) || isPathToken(token)) {
    return false;
  }
  if (ID_WITH_ISSUE.test(token)) {
    return true;
  }
  if (SNAKE_CASE.test(token) || CAMEL_CASE.test(token) || PASCAL_CASE.test(token)) {
    return true;
  }
  return KEBAB_CASE.test(token) && (token.includes('-', 1) || /\d/.test(token));
}

/** Adds the full text, and for paths every trailing segment join plus the basename. */
function matchKeysFor(text: string, kind: ReferenceTargetKind, basenameKeys: boolean): string[] {
  if (kind !== 'path' || !basenameKeys) {
    return [text];
  }
  const segments = text.split('/').filter(Boolean);
  const keys: string[] = [];
  for (let index = 0; index < segments.length && keys.length < MAX_MATCH_KEYS; index += 1) {
    keys.push(segments.slice(index).join('/'));
  }
  const basename = segments[segments.length - 1];
  if (basename && !keys.includes(basename)) {
    keys.push(basename);
  }
  return keys;
}

/** One target, or the existing one when the same normalised text is already there. */
function pushTarget(
  targets: ReferenceTarget[],
  seen: Map<string, number>,
  kind: ReferenceTargetKind,
  text: string,
  line: number,
  context: string,
  basenameKeys: boolean,
): void {
  const trimmed = text.slice(0, MAX_TARGET_TEXT).trim();
  const normalized = normalizeReferenceTarget(trimmed);
  if (!normalized) {
    return;
  }
  const existingIndex = seen.get(normalized);
  if (existingIndex !== undefined) {
    const existing = targets[existingIndex];
    // Keep the stronger kind; a path found later must displace a plain identifier.
    if (KIND_PRIORITY[kind] > KIND_PRIORITY[existing.kind]) {
      targets[existingIndex] = {
        ...existing,
        kind,
        text: trimmed,
        matchKeys: matchKeysFor(trimmed, kind, basenameKeys),
      };
    }
    return;
  }
  seen.set(normalized, targets.length);
  targets.push({
    kind,
    text: trimmed,
    matchKeys: matchKeysFor(trimmed, kind, basenameKeys),
    line,
    context: context.slice(0, 160),
  });
}

/**
 * Extracts every reference target of one assistant reply, in document order.
 *
 * Paths and identifiers are collected from prose, headings, inline code and
 * fenced code. Code lines are the non-empty lines inside a fence. Headings are
 * their text without the `#` run. Paragraphs are opt-in.
 *
 * Inline code and fenced code are the strongest signal: an identifier inside
 * backticks is one the agent itself marked as literal.
 */
export function extractReferenceTargets(
  markdown: string,
  options: ReferenceTargetOptions = {},
): ReferenceTarget[] {
  const includeParagraphs = options.includeParagraphs ?? false;
  const includeHeadings = options.includeHeadings ?? true;
  const includeCodeLines = options.includeCodeLines ?? true;
  const basenameKeys = options.basenameKeys ?? true;

  const targets: ReferenceTarget[] = [];
  const seen = new Map<string, number>();
  const lines = String(markdown ?? '').split(/\r?\n/);
  let inFence = false;

  const collectTokens = (line: string, lineIndex: number, context: string): void => {
    for (const match of line.matchAll(ASCII_TOKEN)) {
      const token = trimToken(match[0]);
      if (!token) {
        continue;
      }
      if (isPathToken(token)) {
        pushTarget(targets, seen, 'path', token, lineIndex, context, basenameKeys);
      } else if (isIdentifierToken(token)) {
        pushTarget(targets, seen, 'identifier', token, lineIndex, context, basenameKeys);
      }
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const trimmed = line.trim();
      if (includeCodeLines && trimmed.length >= 3 && trimmed !== '}' && trimmed !== ');') {
        pushTarget(targets, seen, 'code-line', trimmed, index, trimmed, basenameKeys);
      }
      collectTokens(line, index, trimmed);
      continue;
    }
    if (TABLE_LINE.test(line)) {
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const text = heading[2].replace(/[`*_~]/g, '').trim();
      if (includeHeadings && text.length >= 3) {
        pushTarget(targets, seen, 'heading', text, index, text, basenameKeys);
      }
      collectTokens(line, index, line.trim());
      continue;
    }

    collectTokens(line, index, line.trim());

    if (includeParagraphs && line.trim().length >= 8 && !LIST_LINE.test(line)) {
      pushTarget(targets, seen, 'paragraph', line.trim(), index, line.trim(), basenameKeys);
    }
  }

  return targets;
}

/**
 * Whether a fragment looks like something a person is retyping rather than an
 * ordinary word of the sentence.
 *
 * This is the precision gate the replay asked for. `server`, `chip`, `task` and
 * `architecture` all appear both as English nouns and as paths/identifiers in
 * the reply, and offering `server/index.ts` to someone writing 「重启 server」
 * was the single largest source of wrong offers. A fragment qualifies when it
 * carries a separator, a digit, an acronym's all-caps shape, or a mixed-case
 * identifier of at least five characters (which excludes title-case products
 * like `Quay` while keeping `matchRef` and `ArchGuard`).
 */
function isCodeShapedQuery(query: string): boolean {
  if (/[\u4e00-\u9fff]/.test(query)) {
    return true;
  }
  if (/[\/\\._@-]/.test(query) || /\d/.test(query)) {
    return true;
  }
  const hasUpper = /[A-Z]/.test(query);
  const hasLower = /[a-z]/.test(query);
  if (hasUpper && !hasLower) {
    return true;
  }
  return hasUpper && hasLower && query.length >= 5;
}

/** How many leading characters agree on upper/lower case, as a tie-breaker. */
function matchingCaseCount(query: string, key: string): number {
  let matches = 0;
  const length = Math.min(query.length, key.length);
  for (let index = 0; index < length; index += 1) {
    const left = query[index];
    const right = key[index];
    if (!/[A-Za-z]/.test(left) || !/[A-Za-z]/.test(right)) {
      continue;
    }
    const leftUpper = left === left.toUpperCase();
    const rightUpper = right === right.toUpperCase();
    matches += leftUpper === rightUpper ? 1 : 0;
  }
  return matches;
}

/**
 * The fragment matching runs on: the token before the caret.
 *
 * ASCII/code text takes the trailing identifier/path run. Chinese has no spaces,
 * so it takes the trailing CJK run capped at {@link DEFAULT_CJK_SUFFIX_MAX};
 * the matcher then tries shorter suffixes of it, longest first.
 */
export function readCaretQuery(prefix: string): CaretQuery {
  const ascii = ASCII_RUN_AT_END.exec(prefix);
  if (ascii?.[0]) {
    return { query: ascii[0], start: prefix.length - ascii[0].length };
  }
  const cjk = CJK_RUN_AT_END.exec(prefix);
  if (cjk?.[0]) {
    const query = cjk[0].slice(-DEFAULT_CJK_SUFFIX_MAX);
    return { query, start: prefix.length - query.length };
  }
  return { query: '', start: prefix.length };
}

/** The variants tried against a target, longest first, duplicates removed. */
function queryVariants(query: string, cjkSuffixMax: number): string[] {
  const ascii = /^[A-Za-z0-9_./@-]+$/.test(query);
  if (ascii) {
    return [query];
  }
  const variants: string[] = [];
  const limit = Math.min(query.length, cjkSuffixMax);
  for (let length = limit; length >= 2; length -= 1) {
    variants.push(query.slice(-length));
  }
  return variants;
}

/**
 * Ranked targets whose key starts with the fragment before the caret.
 *
 * Pure prefix matching, no fuzz: the corpus replay showed fuzzy matching adds
 * false offers faster than it adds hits. An exact echo (the fragment already is
 * the whole target) is not a completion and is dropped, except when a path's
 * basename was typed and the full path is still worth inserting.
 */
export function matchReferenceTargets(
  prefix: string,
  targets: readonly ReferenceTarget[],
  options: ReferenceTargetOptions = {},
): CaretMatch[] {
  const minQueryChars = options.minQueryChars ?? DEFAULT_MIN_QUERY_CHARS;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const cjkSuffixMax = options.cjkSuffixMax ?? DEFAULT_CJK_SUFFIX_MAX;
  const requireCodeShape = options.requireCodeShape ?? DEFAULT_REQUIRE_CODE_SHAPE;

  const { query } = readCaretQuery(prefix);
  if (!query) {
    return [];
  }
  if (requireCodeShape && !isCodeShapedQuery(query)) {
    return [];
  }

  const queryWantsPath = /[\/\\]/.test(query) || /^\.[A-Za-z]/.test(query) || /\.[A-Za-z0-9]+$/.test(query);
  const queryWantsIdentifier = !queryWantsPath && /[A-Z]|[_\-]|\d/.test(query);

  const matches = new Map<string, CaretMatch>();
  for (const variant of queryVariants(query, cjkSuffixMax)) {
    const normalizedVariant = normalizeReferenceTarget(variant);
    if (normalizedVariant.length < minQueryChars) {
      continue;
    }
    for (const target of targets) {
      const targetNormalized = normalizeReferenceTarget(target.text);
      if (!targetNormalized) {
        continue;
      }
      for (const key of target.matchKeys) {
        const normalizedKey = normalizeReferenceTarget(key);
        if (!normalizedKey.startsWith(normalizedVariant)) {
          continue;
        }
        const isEcho = normalizedKey === normalizedVariant && targetNormalized === normalizedVariant;
        if (isEcho) {
          break;
        }
        const matchedChars = normalizedVariant.length;
        const shapeBonus = queryWantsPath && target.kind === 'path'
          ? 3
          : queryWantsIdentifier && target.kind === 'identifier'
            ? 3
            : 0;
        const score = matchedChars * 10
          + KIND_PRIORITY[target.kind]
          + shapeBonus
          + matchingCaseCount(query, key) * 0.3
          - Math.min(targetNormalized.length, 80) / 100;
        const previous = matches.get(targetNormalized);
        if (previous === undefined || score > previous.score) {
          matches.set(targetNormalized, {
            target,
            matchedKey: key,
            matchedChars,
            score,
          });
        }
        break;
      }
    }
  }

  return [...matches.values()]
    .sort(
      (left, right) =>
        right.matchedChars - left.matchedChars
        || right.score - left.score
        || left.target.text.length - right.target.text.length
        || left.target.line - right.target.line,
    )
    .slice(0, maxCandidates);
}
