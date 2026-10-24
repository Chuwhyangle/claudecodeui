/**
 * The direct-HTTP client for the two upstream wire dialects.
 *
 * The feature must NOT go through Claude Code, Codex or an Agent SDK: those
 * write transcripts and surface work in the sidebar. This file speaks plain
 * `fetch` to the operator's gateway, so a suggestion is one request with no
 * session, no transcript file and no host process.
 *
 * TWO DIALECTS, ONE READING. Anthropic's Messages API returns `content` blocks
 * and may include `thinking` blocks; OpenAI's Chat Completions returns
 * `choices[0].message.content` and may include `reasoning_content`. Both are
 * accepted by the local gateway, and both ignore the reasoning half here — only
 * the answer text is a suggestion.
 *
 * THE KEY IS REVEALED HERE, ONCE. The config is the settings' `upstream` group,
 * and its credential is an opaque value; `authHeaders` below is the single
 * production call site of `reveal()`. The key travels in a header and is never
 * copied into an error message: a failure carries its CATEGORY and, for HTTP
 * failures, the status code — never the request or response body.
 *
 * Consumers: `reply-suggestions.service.ts` (the default `complete` seam),
 * `server/modules/observation/session-digest-llm.ts` (the same completion call
 * for the digest tier) and the client criterion in
 * `tests/reply-suggestions-client.test.ts`.
 */
import type { ReplySuggestionsProtocol, ReplySuggestionsUpstream } from './reply-suggestions-settings.js';

/**
 * What the client needs to know about the gateway: exactly the settings'
 * `upstream` group.
 *
 * Consumers: the client criterion in `tests/reply-suggestions-client.test.ts`;
 * `reply-suggestions-draw.ts` passes the upstream group as this type.
 */
export type ReplySuggestionsClientConfig = ReplySuggestionsUpstream;

/**
 * One completion request: the resolved prompt and the decoding knobs.
 *
 * Consumers: `reply-suggestions.service.ts`, `reply-suggestions-draw.ts` and
 * `server/modules/observation/session-digest-llm.ts` (through the barrel).
 */
export type ReplySuggestionsCompletionRequest = {
  config: ReplySuggestionsClientConfig;
  system: string;
  user: string;
  temperature: number;
  maxOutputTokens: number;
};

/**
 * The answer text plus whichever token counts the upstream chose to report.
 *
 * Consumers: `reply-suggestions.service.ts`, `reply-suggestions-draw.ts` and
 * `server/modules/observation/session-digest-llm.ts` (through the barrel).
 */
export type ReplySuggestionsCompletion = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

/**
 * Why a completion failed. The service maps every category to the same 502
 * response, but the categories stay distinct so a log line (and a test) can say
 * whether the gateway answered badly, timed out, or was unreachable.
 */
type ReplySuggestionsClientErrorCategory = 'timeout' | 'http' | 'network' | 'parse' | 'shape';

/**
 * A categorised client failure. `message` never carries the key or a payload.
 *
 * Consumers: `reply-suggestions-chips.ts` (parse/shape), `reply-suggestions-draw.ts`
 * (the log category and the 502 mapping) and both criteria that fake an upstream.
 */
export class ReplySuggestionsClientError extends Error {
  readonly category: ReplySuggestionsClientErrorCategory;
  readonly httpStatus: number | null;

  constructor(category: ReplySuggestionsClientErrorCategory, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'ReplySuggestionsClientError';
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

/** The headers a reading's authorization scheme implies for its protocol. */
function authHeaders(config: ReplySuggestionsClientConfig): Record<string, string> {
  const scheme = config.authScheme === ''
    ? (config.protocol === 'anthropic' ? 'x-api-key' : 'bearer')
    : config.authScheme;
  // The ONLY production call to `reveal()`: the secret leaves the opaque value
  // here, into the header of the one request that needs it.
  const apiKey = config.credential.reveal();
  if (scheme === 'x-api-key') {
    return { 'x-api-key': apiKey };
  }
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * Build the completion endpoint. A `baseUrl` that already ends in `/v1` (with or
 * without a trailing slash) is not given a second `/v1`.
 *
 * Consumers: the client criterion in `tests/reply-suggestions-client.test.ts`.
 */
export function replySuggestionsEndpoint(baseUrl: string, protocol: ReplySuggestionsProtocol): string {
  const root = baseUrl.trim().replace(/\/+$/, '');
  const versioned = /\/v1$/.test(root) ? root : `${root}/v1`;
  return `${versioned}${protocol === 'anthropic' ? '/messages' : '/chat/completions'}`;
}

/** A finite number, or null when the upstream reported nothing usable. */
function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Pull the answer text out of an Anthropic Messages response. */
function readAnthropicText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReplySuggestionsClientError('shape', 'upstream response was not an object');
  }
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    throw new ReplySuggestionsClientError('shape', 'anthropic response carried no content array');
  }
  const texts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    // `thinking` blocks are deliberately skipped: only the answer is a suggestion.
    if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text);
  }
  const text = texts.join('\n').trim();
  if (text === '') {
    throw new ReplySuggestionsClientError('shape', 'anthropic response carried no text block');
  }
  return text;
}

/** Pull the answer text out of an OpenAI Chat Completions response. */
function readOpenAiText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ReplySuggestionsClientError('shape', 'upstream response was not an object');
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ReplySuggestionsClientError('shape', 'openai response carried no choices');
  }
  const first = choices[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) {
    throw new ReplySuggestionsClientError('shape', 'openai response carried a malformed choice');
  }
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new ReplySuggestionsClientError('shape', 'openai response carried no message');
  }
  // `reasoning_content` is deliberately ignored; only `content` is the answer.
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new ReplySuggestionsClientError('shape', 'openai response carried no content string');
  }
  return content.trim();
}

function readUsage(payload: unknown, protocol: ReplySuggestionsProtocol): {
  inputTokens: number | null;
  outputTokens: number | null;
} {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { inputTokens: null, outputTokens: null };
  }
  const usage = (payload as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return { inputTokens: null, outputTokens: null };
  }
  const record = usage as Record<string, unknown>;
  return protocol === 'anthropic'
    ? { inputTokens: tokenCount(record.input_tokens), outputTokens: tokenCount(record.output_tokens) }
    : { inputTokens: tokenCount(record.prompt_tokens), outputTokens: tokenCount(record.completion_tokens) };
}

/** Serialise the request body for one dialect, including `thinking` only when asked. */
function requestBody(
  request: ReplySuggestionsCompletionRequest,
): Record<string, unknown> {
  const { config } = request;
  const thinking = config.disableThinking ? { thinking: { type: 'disabled' } } : {};
  if (config.protocol === 'anthropic') {
    return {
      model: config.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      temperature: request.temperature,
      ...thinking,
    };
  }
  return {
    model: config.model,
    max_tokens: request.maxOutputTokens,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    temperature: request.temperature,
    ...thinking,
  };
}

/**
 * Run one completion against the configured gateway.
 *
 * `fetchImpl` is injectable so a criterion can drive the real request/response
 * path without a network; production leaves it undefined and uses the global
 * `fetch`. The timeout aborts the request and reports `category: 'timeout'`.
 */
export async function completeReplySuggestions(
  request: ReplySuggestionsCompletionRequest,
  dependencies: { fetchImpl?: typeof fetch } = {},
): Promise<ReplySuggestionsCompletion> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const endpoint = replySuggestionsEndpoint(request.config.baseUrl, request.config.protocol);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...authHeaders(request.config),
  };
  if (request.config.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.config.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody(request)),
      signal: controller.signal,
    });
  } catch (failure) {
    if (controller.signal.aborted) {
      throw new ReplySuggestionsClientError('timeout', `upstream request timed out after ${request.config.timeoutMs} ms`);
    }
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw new ReplySuggestionsClientError('network', `upstream request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ReplySuggestionsClientError('http', `upstream returned HTTP ${response.status}`, response.status);
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (failure) {
    if (controller.signal.aborted) {
      throw new ReplySuggestionsClientError('timeout', `upstream request timed out after ${request.config.timeoutMs} ms`);
    }
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw new ReplySuggestionsClientError('network', `could not read the upstream response: ${reason}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ReplySuggestionsClientError('parse', 'upstream response was not JSON');
  }

  const text = request.config.protocol === 'anthropic' ? readAnthropicText(payload) : readOpenAiText(payload);
  const usage = readUsage(payload, request.config.protocol);
  return { text, ...usage };
}
