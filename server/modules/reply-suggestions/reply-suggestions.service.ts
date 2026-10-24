/**
 * Reply-suggestion generation: prompt construction, upstream calls, per-session
 * de-dup, rate limiting, the circuit breaker, logging and the local usage ledger.
 *
 * THE SESSION IS READ, NEVER RECEIVED. The browser sends only an id. The
 * assistant tail comes from the injected reader (`server/index.ts` binds the
 * providers module's full-history read), so a caller cannot make the server
 * echo arbitrary text to the gateway.
 *
 * WHAT PERSISTS IN MEMORY. For each session the service remembers the last
 * assistant message id, how many extractions it has served (`draw`), and which
 * chips it already showed. A new assistant message resets that state. Chips are
 * de-duplicated exactly after normalisation and filtered for near-duplicates
 * (character-set overlap >= 0.7) against what was already shown; a draw that
 * comes back with fewer than two chips is supplemented ONCE. Only chips that are
 * new in THIS draw are returned.
 *
 * ONE MESSAGE, ONE UPSTREAM DRAW. The batch last returned for a
 * (session id, last assistant message id, settings version) is cached in memory.
 * An ordinary first draw that hits the cache returns that batch unchanged: no
 * upstream call, no `draw` increment, no call-cap or circuit-breaker bookkeeping.
 * Only `redraw: true` buys a new batch (and replaces the cached one); an
 * expansion draw neither reads nor writes the cache. Failures and empty batches
 * are never cached, so the next request tries again. The cache has a 200-key LRU
 * bound and no time expiry; a restart simply loses it. Identical concurrent
 * requests still coalesce through `inflight`.
 *
 * PROTECTION. Sliding one-minute and one-day call caps; five consecutive upstream
 * failures open a 30-second circuit; every upstream attempt has a timeout owned
 * by the client. A log line carries only protocol, model, settings version,
 * duration, outcome and token counts the upstream reported — never conversation
 * text, chip text or the key.
 *
 * THE EXPANSION EXPERIMENT. When the settings say `expansion: "vary"`, a request
 * carrying `expand: true` is a second kind of draw: with a `seed` it asks for
 * variants of the reply the person already picked (the seed counts as already
 * shown, so an identical or near-duplicate answer is filtered before it reaches
 * them); with a quoted `focus` and no seed it asks for responses to that passage.
 * With `expansion: "off"` those requests are refused `400` before any upstream
 * call. The usage ledger's `shown` row names which of the two anchored the draw.
 *
 * Consumers: `reply-suggestions.routes.ts` (the HTTP face) and the service
 * criterion in `tests/reply-suggestions-service.test.ts`.
 */
import { AppError } from '@/shared/utils.js';

import {
  completeReplySuggestions,
  ReplySuggestionsClientError,
  type ReplySuggestionsCompletion,
  type ReplySuggestionsCompletionRequest,
} from './reply-suggestions-client.js';
import type { ReplySuggestionsSettings } from './reply-suggestions-settings.js';
import {
  createReplySuggestionsUsageLog,
  type ReplySuggestionsUsageLog,
} from './reply-suggestions-usage-log.js';

/** Five consecutive failures open the circuit (documented in `docs/operations/reply-suggestions.md`). */
export const REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD = 5;

/** How long the circuit stays open after the fifth consecutive failure. */
export const REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS = 30_000;

/** How many previously shown chips a redraw prompt may list as "do not repeat". */
export const REPLY_SUGGESTIONS_REDRAW_MEMORY = 12;

/** The character-set overlap at or above which a chip is "the same suggestion, reworded". */
export const REPLY_SUGGESTIONS_NEAR_DUPLICATE_OVERLAP = 0.7;

/**
 * How many `(session, message, settings version)` batches the service remembers.
 * Least-recently-used entries are evicted past this bound; there is no time
 * expiry, so a quiet batch stays until the bound pushes it out or the process
 * restarts.
 */
export const REPLY_SUGGESTIONS_BATCH_CACHE_SIZE = 200;

/** How a `shown` usage row was produced: a real upstream call or a cache hit. */
export type ReplySuggestionsServed = 'upstream' | 'cache';

/** The last assistant message, as the injected reader reports it. */
export type LastAssistantMessage = {
  id: string;
  text: string;
};

/**
 * What an expansion draw is anchored on: `seed` is the reply the person picked
 * (variants of it), `focus` is the quoted passage with no reply written yet
 * (responses to it). The value is written into the usage ledger so a replay can
 * tell the two apart without storing either text twice.
 */
export type ReplySuggestionsExpansionSource = 'seed' | 'focus';

/** Input the route has already parsed and validated. */
export type ReplySuggestionsInput = {
  sessionId: string;
  redraw?: boolean;
  focus?: string;
  /**
   * The reply the person already picked. Only meaningful together with
   * `expand: true`; clipped to `maxChipChars` by the service.
   */
  seed?: string;
  /**
   * True for an expansion draw. Distinguishes it from an ordinary first draw or
   * redraw, which may also carry `focus`; the service refuses it unless the
   * settings say `expansion: "vary"`.
   */
  expand?: boolean;
};

/** The pointer-click ledger event names the client reports. */
export type ReplySuggestionsEventName = 'picked' | 'cleared' | 'redrawn' | 'sent';

/** One `/events` posting. `source` is present only when an expansion chip was picked. */
export type ReplySuggestionsEventInput = {
  sessionId: string;
  draw: number;
  event: ReplySuggestionsEventName;
  index?: number;
  source?: ReplySuggestionsExpansionSource;
};

/** The reading `GET /status` exposes — no paths and no key. */
export type ReplySuggestionsStatus = {
  enabled: boolean;
  expansion: ReplySuggestionsSettings['expansion'];
  maxChips: number;
  maxChipChars: number;
};

/** The public face of the service. */
export type ReplySuggestionsService = {
  status(): ReplySuggestionsStatus;
  suggest(input: ReplySuggestionsInput): Promise<{ chips: string[]; draw: number }>;
  recordEvent(input: ReplySuggestionsEventInput): void;
};

/**
 * The injected seams. `complete` defaults to the real client; criteria replace
 * it with a fake, exactly as the route criterion replaces the transcript reader.
 */
export type ReplySuggestionsServiceDeps = {
  readSettings: () => ReplySuggestionsSettings;
  readLastAssistantMessage: (sessionId: string) => Promise<LastAssistantMessage | null>;
  complete?: (request: ReplySuggestionsCompletionRequest) => Promise<ReplySuggestionsCompletion>;
  now?: () => number;
  logger?: (line: string) => void;
  usageLog?: ReplySuggestionsUsageLog;
  usageLogPath?: string;
  usageLogMaxBytes?: number;
  usageLogHomeDir?: string;
};

/** Whichever reading's chips this session has already been shown. */
type SessionState = {
  messageId: string;
  draw: number;
  shown: string[];
};

/** The batch last returned to the client for one cache key. */
type CachedBatch = {
  chips: string[];
  draw: number;
};

/** The built-in system prompt; `settings.systemPrompt` replaces it whole when non-empty. */
function builtInSystemPrompt(maxChipChars: number): string {
  return [
    '你在为用户起草聊天输入框里可直接发送的回复。用户刚看完助手最后一条消息，要从中挑一条。',
    '给出 3 条互不相同的完整回复：第 1 条用「；」分隔、简要回答所有待答点，助手给了推荐就采纳；',
    '单个要点时不要以分隔符结尾。',
    '第 2、3 条是真正的备选（不同的决定，或更短的确认），不是第 1 条的改写。',
    `用用户的语言和简短风格，每条不超过 ${maxChipChars} 个字符。`,
    '不得编造消息里没有的事实、数字或测量值：可以替人做决定，不可以编造事实。',
    '没有待答点时，建议最可能的下一条指令。',
    '只输出 JSON：{"chips": ["…", "…", "…"]}',
  ].join('\n');
}

/** Truncate by code point, so a surrogate pair is never cut in half. */
function truncateCodePoints(text: string, maximum: number): string {
  const characters = [...text];
  return characters.length <= maximum ? text : characters.slice(0, maximum).join('');
}

/** The last `maximum` code points of `text`. */
function tailCodePoints(text: string, maximum: number): string {
  const characters = [...text];
  return characters.length <= maximum ? text : characters.slice(-maximum).join('');
}

/** The comparison form used by exact de-duplication. */
function normalizeForCompare(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** The character set (whitespace removed) used by the near-duplicate filter. */
function characterSet(text: string): Set<string> {
  return new Set([...text.replace(/\s+/g, '').toLocaleLowerCase()]);
}

/** Jaccard overlap of two strings' character sets, in [0, 1]. */
export function characterSetOverlap(left: string, right: string): number {
  const a = characterSet(left);
  const b = characterSet(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const character of a) {
    if (b.has(character)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** The built-in instruction block plus the delivery-side context, as one request. */
function buildUserPrompt(options: {
  tail: string;
  focus: string;
  avoid: readonly string[];
  redraw: boolean;
}): string {
  const lines: string[] = ['助手最后一条消息（末尾节选，可能被截断）：', '"""', options.tail, '"""'];
  if (options.focus !== '') {
    lines.push('', '用户选中了消息里的这一段，想回应它：', '"""', options.focus, '"""');
  }
  const avoid = options.avoid.slice(-REPLY_SUGGESTIONS_REDRAW_MEMORY);
  if (options.redraw && avoid.length > 0) {
    lines.push('', '不要重复以下已经展示过的回复：');
    for (const chip of avoid) lines.push(`- ${chip}`);
  }
  return lines.join('\n');
}

/**
 * The built-in system prompt for an expansion draw.
 *
 * A seed draw asks for rewrites of a reply the person already picked; a focus
 * draw asks for replies to a passage they quoted. Both keep the same "no invented
 * facts" rule as the ordinary prompt, and both name the requested shape in the
 * user prompt as well, so a custom system prompt cannot silently drop it.
 */
function builtInExpansionSystemPrompt(maxChipChars: number, source: ReplySuggestionsExpansionSource): string {
  return [
    '你在为用户起草聊天输入框里可直接发送的回复。',
    source === 'seed'
      ? '用户已经选定了一条回复；请给出同话题的另一种写法（变体），保持它的决定与意图。'
      : '用户选中了助手消息里的一段；请给出针对这一段的回应。',
    '给出 2 到 3 条互不相同的完整回复，用用户的语言和简短风格，第 2、3 条必须在措辞或详略上与第 1 条不同。',
    `每条不超过 ${maxChipChars} 个字符。`,
    '不得编造消息里没有的事实、数字或测量值：可以替人做决定，不可以编造事实。',
    '只输出 JSON：{"chips": ["…", "…", "…"]}',
  ].join('\n');
}

/**
 * The user prompt for an expansion draw: the same assistant tail, the quoted
 * passage when there is one, and either the picked reply (seed, variants) or the
 * instruction to respond to the quotation.
 *
 * `avoid` lists the chips already shown in this draw, exactly as the redraw
 * prompt does, so a supplement never repeats the first answer.
 */
function buildExpansionPrompt(options: {
  tail: string;
  focus: string;
  seed: string;
  avoid: readonly string[];
}): string {
  const lines: string[] = ['助手最后一条消息（末尾节选，可能被截断）：', '"""', options.tail, '"""'];
  if (options.focus !== '') {
    lines.push('', '用户选中了消息里的这一段：', '"""', options.focus, '"""');
  }
  if (options.seed !== '') {
    lines.push('', '用户选定的回复（seed）：', '"""', options.seed, '"""');
    lines.push('', '请基于这条 seed 给出同话题的变体：保持它的决定与意图，只在措辞或详略上不同。');
  } else {
    lines.push('', '请针对上面选中的这一段给出 2 到 3 条回应。');
  }
  const avoid = options.avoid.slice(-REPLY_SUGGESTIONS_REDRAW_MEMORY);
  if (avoid.length > 0) {
    lines.push('', '不要重复以下已经展示过的回复：');
    for (const chip of avoid) lines.push(`- ${chip}`);
  }
  return lines.join('\n');
}

/**
 * Separator marks the prompt asks the model to put between answers to several
 * points. At the END of a chip they are noise: a chip is a complete reply, and a
 * trailing `；` reads as an unfinished sentence. Only these marks are stripped —
 * sentence endings (`。？！`) and closing brackets/quotes are part of the text.
 *
 * Consumers: `reply-suggestions.service.ts` (`parseSuggestionChips`) only.
 */
const TRAILING_SEPARATOR_MARKS = /[；;，,、]+$/u;

/** Drops separator marks at the very end of a chip; idempotent and safe on empty strings. */
function stripTrailingSeparatorMarks(text: string): string {
  return text.replace(TRAILING_SEPARATOR_MARKS, '').trimEnd();
}

/**
 * Parse the model's answer into a raw chip list.
 *
 * Accepts `{"chips": [...]}`, a bare array and either wrapped in a ``` fence.
 * Every element must be a string; anything else refuses the WHOLE answer (it is
 * an upstream-shape failure, mapped to 502 by the caller). Trailing separator
 * marks are stripped here, before exact de-duplication in `selectChips`, so
 * `甲；` and `甲` are the same chip. A chip that was only separator marks becomes
 * empty and is dropped, never passed on as an empty string.
 *
 * Consumers: `reply-suggestions.service.ts` (both the first and the supplement
 * call) and the service criterion.
 */
export function parseSuggestionChips(text: string): string[] {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = fenced ? [fenced[1].trim(), trimmed] : [trimmed];

  let parsed: unknown;
  let parsedAt = -1;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      parsedAt = candidates.indexOf(candidate);
      break;
    } catch {
      // Try the next spelling (raw text after a failed fenced parse, or vice versa).
    }
  }
  if (parsedAt === -1) {
    throw new ReplySuggestionsClientError('parse', 'the model did not answer with JSON');
  }

  let chips: unknown;
  if (Array.isArray(parsed)) {
    chips = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && 'chips' in parsed) {
    chips = (parsed as Record<string, unknown>).chips;
  } else {
    throw new ReplySuggestionsClientError('shape', 'the model answer was not an array or a {"chips": [...]} object');
  }

  if (!Array.isArray(chips)) {
    throw new ReplySuggestionsClientError('shape', 'the model answer\'s "chips" was not an array');
  }
  if (chips.some((chip) => typeof chip !== 'string')) {
    throw new ReplySuggestionsClientError('shape', 'the model answer contained a non-string chip');
  }
  return (chips as string[])
    .map((chip) => stripTrailingSeparatorMarks(chip.trim()))
    .filter((chip) => chip !== '');
}

/**
 * Clip, exact-deduplicate (after normalisation), filter near-duplicates against
 * the already-shown chips, and cap at `maxChips`.
 *
 * Consumers: `reply-suggestions.service.ts` only.
 */
function selectChips(
  raw: readonly string[],
  shown: readonly string[],
  settings: ReplySuggestionsSettings,
): string[] {
  const shownNormalized = shown.map(normalizeForCompare);
  const seen = new Set(shownNormalized);
  const selected: string[] = [];
  for (const chip of raw) {
    const clipped = truncateCodePoints(chip.trim(), settings.maxChipChars).trim();
    if (clipped === '') continue;
    const normalized = normalizeForCompare(clipped);
    if (seen.has(normalized)) continue;
    const nearDuplicate = shownNormalized.some(
      (prior) => characterSetOverlap(normalized, prior) >= REPLY_SUGGESTIONS_NEAR_DUPLICATE_OVERLAP,
    );
    if (nearDuplicate) continue;
    selected.push(clipped);
    seen.add(normalized);
    if (selected.length >= settings.maxChips) break;
  }
  return selected;
}

/** The AppError for each non-2xx path; messages never carry the key or a payload. */
function disabledError(): AppError {
  return new AppError('reply suggestions are disabled', {
    code: 'REPLY_SUGGESTIONS_DISABLED',
    statusCode: 503,
  });
}

function rateLimitedError(): AppError {
  return new AppError('reply suggestions are over their call limit', {
    code: 'REPLY_SUGGESTIONS_RATE_LIMITED',
    statusCode: 429,
  });
}

function upstreamError(category: string): AppError {
  return new AppError(`reply-suggestions upstream request failed (${category})`, {
    code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
    statusCode: 502,
  });
}

/** `expand: true` while the settings say `expansion: "off"`; refused before any upstream call. */
function expansionDisabledError(): AppError {
  return new AppError('reply-suggestions expansion is not enabled', {
    code: 'REPLY_SUGGESTIONS_EXPANSION_DISABLED',
    statusCode: 400,
  });
}

/** A structurally inconsistent expansion request (`expand` without a seed or focus, a seed without `expand`). */
function invalidInputError(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });
}

/**
 * Parse one answer, mapping a malformed answer to the same 502 as a failed
 * request: from the caller's point of view both mean "this draw produced
 * nothing usable upstream".
 *
 * Consumers: `reply-suggestions.service.ts` only.
 */
function parseChipsOrUpstreamFailure(text: string): string[] {
  try {
    return parseSuggestionChips(text);
  } catch (failure) {
    const category = failure instanceof ReplySuggestionsClientError ? failure.category : 'shape';
    throw upstreamError(category);
  }
}

/**
 * Build the service over one settings source and one transcript reader.
 *
 * Consumers: `reply-suggestions.module.ts` only.
 */
export function createReplySuggestionsService(deps: ReplySuggestionsServiceDeps): ReplySuggestionsService {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? ((line: string) => console.log(line));
  const complete = deps.complete ?? ((request: ReplySuggestionsCompletionRequest) => completeReplySuggestions(request));
  const usageLog = deps.usageLog ?? createReplySuggestionsUsageLog({
    ...(deps.usageLogPath === undefined ? {} : { filePath: deps.usageLogPath }),
    ...(deps.usageLogMaxBytes === undefined ? {} : { maxBytes: deps.usageLogMaxBytes }),
    ...(deps.usageLogHomeDir === undefined ? {} : { homeDir: deps.usageLogHomeDir }),
  });

  const sessionStates = new Map<string, SessionState>();
  const inflight = new Map<string, Promise<{ chips: string[]; draw: number }>>();
  // The last batch returned for a (session, message, settings version). Map
  // insertion order is the LRU order: a read moves its entry to the end.
  const batchCache = new Map<string, CachedBatch>();

  // Sliding-window call ledgers. Kept as sorted arrays of timestamps; pruned on
  // every check, so a quiet server carries only the last minute/day of entries.
  const minuteCalls: number[] = [];
  const dayCalls: number[] = [];

  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;

  /** The cache key: session id + last assistant message id + settings version. */
  function batchCacheKey(sessionId: string, messageId: string, settings: ReplySuggestionsSettings): string {
    return [sessionId, messageId, settings.version].join('\u0000');
  }

  /** An LRU read: a hit is moved to the most-recently-used end. */
  function readCachedBatch(key: string): CachedBatch | undefined {
    const cached = batchCache.get(key);
    if (cached === undefined) return undefined;
    batchCache.delete(key);
    batchCache.set(key, cached);
    return cached;
  }

  /** Stores a batch and evicts the least-recently-used entry past the bound. */
  function writeCachedBatch(key: string, batch: CachedBatch): void {
    batchCache.delete(key);
    batchCache.set(key, batch);
    while (batchCache.size > REPLY_SUGGESTIONS_BATCH_CACHE_SIZE) {
      const oldest = batchCache.keys().next().value;
      if (oldest === undefined) break;
      batchCache.delete(oldest);
    }
  }

  function pruneCalls(window: number[], span: number, at: number): void {
    while (window.length > 0 && window[0] <= at - span) window.shift();
  }

  function writeUsage(record: Record<string, unknown> & { type: string }): void {
    try {
      usageLog.write(record);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      logger(`[reply-suggestions] usage log write failed: ${reason}`);
    }
  }

  /** One upstream attempt: circuit, limits, call, log, breaker bookkeeping. */
  async function callUpstream(
    request: ReplySuggestionsCompletionRequest,
    settings: ReplySuggestionsSettings,
  ): Promise<ReplySuggestionsCompletion> {
    const at = now();
    if (consecutiveFailures >= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD) {
      if (at < circuitOpenUntil) throw upstreamError('circuit-open');
      // Cooldown elapsed: one trial call is allowed; a success closes the circuit.
      consecutiveFailures = 0;
      circuitOpenUntil = 0;
    }

    pruneCalls(minuteCalls, 60_000, at);
    pruneCalls(dayCalls, 86_400_000, at);
    if (minuteCalls.length >= settings.maxCallsPerMinute || dayCalls.length >= settings.maxCallsPerDay) {
      throw rateLimitedError();
    }
    minuteCalls.push(at);
    dayCalls.push(at);

    const startedAt = now();
    try {
      const completion = await complete(request);
      consecutiveFailures = 0;
      circuitOpenUntil = 0;
      logCompletion(settings, now() - startedAt, 'ok', completion);
      return completion;
    } catch (failure) {
      const category = failure instanceof ReplySuggestionsClientError ? failure.category : 'unknown';
      consecutiveFailures += 1;
      if (consecutiveFailures >= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD) {
        circuitOpenUntil = now() + REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS;
      }
      logCompletion(settings, now() - startedAt, `error:${category}`, null);
      if (failure instanceof AppError) throw failure;
      throw upstreamError(category);
    }
  }

  function logCompletion(
    settings: ReplySuggestionsSettings,
    durationMs: number,
    outcome: string,
    completion: ReplySuggestionsCompletion | null,
  ): void {
    const tokens: string[] = [];
    const inputTokens = completion?.inputTokens ?? null;
    const outputTokens = completion?.outputTokens ?? null;
    if (inputTokens !== null) tokens.push(`inputTokens=${inputTokens}`);
    if (outputTokens !== null) tokens.push(`outputTokens=${outputTokens}`);
    const tokenPart = tokens.length === 0 ? '' : ` ${tokens.join(' ')}`;
    logger(
      `[reply-suggestions] protocol=${settings.protocol} model=${settings.model} version=${settings.version} ` +
        `durationMs=${durationMs}${tokenPart} outcome=${outcome}`,
    );
  }

  /**
   * Append one `shown` row. `served` says whether the batch came from a real
   * upstream call or from the cache, so a replay can count both the number of
   * batches shown and the number of paid calls. Older rows without the field
   * read as `"upstream"`.
   */
  function writeShownRow(
    sessionId: string,
    settings: ReplySuggestionsSettings,
    chips: readonly string[],
    draw: number,
    served: ReplySuggestionsServed,
    expansionSource: ReplySuggestionsExpansionSource | null,
  ): void {
    if (!settings.usageLog) return;
    writeUsage({
      at: new Date(now()).toISOString(),
      type: 'shown',
      sessionId,
      draw,
      model: settings.model,
      protocol: settings.protocol,
      version: settings.version,
      served,
      // The marker a replay reads to know this draw was an expansion, and
      // which text anchored it. The text itself is not copied into the ledger.
      ...(expansionSource === null ? {} : { expansion: expansionSource }),
      chips: [...chips],
    });
  }

  async function generate(input: ReplySuggestionsInput, settings: ReplySuggestionsSettings): Promise<{ chips: string[]; draw: number }> {
    const message = await deps.readLastAssistantMessage(input.sessionId);
    if (message === null || message.text.trim() === '') {
      return { chips: [], draw: 0 };
    }

    const redraw = input.redraw === true;
    const focus = input.focus === undefined ? '' : truncateCodePoints(input.focus, settings.maxFocusChars);
    // An expansion draw is one of two shapes: variants of the picked reply (a
    // non-empty seed wins) or responses to the quoted passage. `seed` is clipped
    // to maxChipChars because it is chip text, the same budget as the answer.
    const expand = input.expand === true;
    const seed = expand && input.seed !== undefined
      ? truncateCodePoints(input.seed.trim(), settings.maxChipChars)
      : '';
    const expansionSource: ReplySuggestionsExpansionSource | null = expand
      ? (seed !== '' ? 'seed' : 'focus')
      : null;
    const cacheKey = batchCacheKey(input.sessionId, message.id, settings);
    // Only an ordinary first draw may be served from the cache. A redraw asks
    // for a new batch by definition, and an expansion draw is anchored on the
    // draft rather than on the message; neither reads the cache. A hit returns
    // the batch unchanged — no upstream call, no draw increment, no call-cap or
    // circuit-breaker bookkeeping — and still leaves a `shown` row so the
    // ledger counts the display separately from the paid call.
    if (!redraw && !expand) {
      const cached = readCachedBatch(cacheKey);
      if (cached !== undefined) {
        writeShownRow(input.sessionId, settings, cached.chips, cached.draw, 'cache', null);
        return { chips: [...cached.chips], draw: cached.draw };
      }
    }
    const inflightKey = [
      input.sessionId,
      message.id,
      redraw ? 'redraw' : 'first',
      focus,
      expansionSource === null ? '' : `${expansionSource}:${seed}`,
    ].join('\u0000');
    const alreadyRunning = inflight.get(inflightKey);
    if (alreadyRunning !== undefined) return alreadyRunning;

    const task = (async (): Promise<{ chips: string[]; draw: number }> => {
      const previous = sessionStates.get(input.sessionId);
      const state: SessionState = previous !== undefined && previous.messageId === message.id
        ? previous
        : { messageId: message.id, draw: 0, shown: [] };

      const draw = state.draw + 1;
      const tail = tailCodePoints(message.text, settings.maxTailChars);
      const avoid = redraw ? state.shown.slice(-REPLY_SUGGESTIONS_REDRAW_MEMORY) : [];
      // An expansion is a diversification draw: the redraw temperature produces
      // genuinely different wording, which is the point of offering variants.
      const temperature = redraw || expansionSource !== null ? settings.redrawTemperature : settings.temperature;
      const config = {
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        model: settings.model,
        authScheme: settings.authScheme,
        apiKey: settings.apiKey,
        disableThinking: settings.disableThinking,
        timeoutMs: settings.timeoutMs,
      };
      const system = settings.systemPrompt.trim() !== ''
        ? settings.systemPrompt
        : expansionSource === null
          ? builtInSystemPrompt(settings.maxChipChars)
          : builtInExpansionSystemPrompt(settings.maxChipChars, expansionSource);
      const buildUser = (avoided: readonly string[], isRedraw: boolean): string =>
        expansionSource === null
          ? buildUserPrompt({ tail, focus, avoid: avoided, redraw: isRedraw })
          : buildExpansionPrompt({ tail, focus, seed, avoid: avoided });
      const request: ReplySuggestionsCompletionRequest = {
        config,
        system,
        user: buildUser(avoid, redraw),
        temperature,
        maxOutputTokens: settings.maxOutputTokens,
      };

      const first = await callUpstream(request, settings);
      const firstChips = parseChipsOrUpstreamFailure(first.text);
      // The seed is "already shown" for this draw by definition: a variant that
      // repeats it exactly, or nearly so, is not a variant at all.
      const seenBefore = expansionSource === 'seed' ? [...state.shown, seed] : state.shown;
      let selected = selectChips(firstChips, seenBefore, settings);

      // Fewer than two usable chips is a failed draw: supplement exactly ONCE.
      if (settings.maxChips >= 2 && selected.length < 2) {
        const supplement = await callUpstream(
          {
            ...request,
            user: buildUser([...avoid, ...firstChips], true),
          },
          settings,
        );
        selected = selectChips([...firstChips, ...parseChipsOrUpstreamFailure(supplement.text)], seenBefore, settings);
      }

      state.draw = draw;
      state.shown = [...state.shown, ...selected];
      sessionStates.set(input.sessionId, state);

      // A failure (thrown above) and an empty batch never enter the cache, so
      // the next request tries upstream again. A redraw replaces the cached
      // batch; an expansion draw leaves it untouched.
      if (!expand) {
        if (selected.length > 0) {
          writeCachedBatch(cacheKey, { chips: [...selected], draw });
        } else {
          batchCache.delete(cacheKey);
        }
      }

      writeShownRow(input.sessionId, settings, selected, draw, 'upstream', expansionSource);

      return { chips: selected, draw };
    })().finally(() => {
      inflight.delete(inflightKey);
    });

    inflight.set(inflightKey, task);
    return task;
  }

  return {
    status(): ReplySuggestionsStatus {
      const settings = deps.readSettings();
      return {
        enabled: settings.enabled,
        expansion: settings.expansion,
        maxChips: settings.maxChips,
        maxChipChars: settings.maxChipChars,
      };
    },

    async suggest(input: ReplySuggestionsInput): Promise<{ chips: string[]; draw: number }> {
      const settings = deps.readSettings();
      if (!settings.enabled) throw disabledError();
      if (input.expand === true) {
        if (settings.expansion !== 'vary') throw expansionDisabledError();
        const seed = input.seed?.trim() ?? '';
        const focus = input.focus?.trim() ?? '';
        if (seed === '' && focus === '') {
          throw invalidInputError('an expansion request needs a "seed" or a "focus"');
        }
      } else if ((input.seed?.trim() ?? '') !== '') {
        throw invalidInputError('"seed" is only valid with "expand": true');
      }
      return generate(input, settings);
    },

    recordEvent(input: ReplySuggestionsEventInput): void {
      const settings = deps.readSettings();
      if (!settings.usageLog) return;
      writeUsage({
        at: new Date(now()).toISOString(),
        type: input.event,
        sessionId: input.sessionId,
        draw: input.draw,
        ...(input.index === undefined ? {} : { index: input.index }),
        ...(input.source === undefined ? {} : { source: input.source }),
      });
    },
  };
}
