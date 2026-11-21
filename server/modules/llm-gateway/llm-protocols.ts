/**
 * The two upstream wire dialects, as strategy objects rather than branches.
 *
 * The feature must NOT go through Claude Code, Codex or an Agent SDK: those write
 * transcripts and surface work in the sidebar. This module speaks plain `fetch` to
 * the operator's gateway, so a completion is one request with no session, no
 * transcript file and no host process.
 *
 * TWO DIALECTS, TWO STRATEGIES. Anthropic's Messages API returns `content` blocks
 * and may include `thinking` blocks; OpenAI's Chat Completions returns
 * `choices[0].message.content` and may include `reasoning_content`. Both are
 * accepted by the local gateway, and both ignore the reasoning half here — only the
 * answer text is a completion. Everything that differs between them (endpoint
 * suffix, request body, default auth header, response parsing) lives on the
 * strategy: `llm-client.ts` has no protocol branch at all, and a third dialect is a
 * new table entry, not a new `if`.
 *
 * THE KEY STAYS OPAQUE. `authHeaders` is the single production call site of
 * `ApiCredential.reveal()`. The key travels in a header and is never copied into an
 * error message: a failure carries its CATEGORY and, for HTTP failures, the status
 * code — never the request or response body.
 *
 * Consumers: `llm-client.ts` (selects a strategy and drives it),
 * `voice-realtime-summary.ts` (names the OpenAI strategy to compose its default
 * endpoint) and the client criterion in `tests/llm-client.test.ts`.
 */
import type { ApiCredential } from './llm-credential.js';

/** The wire dialect names a settings file may carry. */
export type LlmProtocolName = 'anthropic' | 'openai';

/** How the API key travels. The empty string means "the protocol's default". */
export type LlmAuthScheme = '' | 'x-api-key' | 'bearer';

/** What every protocol has to know to reach the gateway. */
export type LlmClientConfig = {
  protocol: LlmProtocolName;
  baseUrl: string;
  model: string;
  authScheme: LlmAuthScheme;
  credential: ApiCredential;
  disableThinking: boolean;
  timeoutMs: number;
};

/**
 * Wire-shape hints a caller may set. A strategy ignores hints it does not use.
 *
 * `voice-realtime-summary.ts` needs OpenAI's richer content form (`[{type:'text',
 * text}]`) plus two top-level fields (`modalities`, `stream`) that the plain
 * chat-completions shape does not carry; expressing them here keeps the difference
 * on the caller's request instead of forking the strategy.
 */
export type LlmWireOptions = {
  /** Send the user turn as `[{ type: 'text', text }]` rather than a plain string. */
  userContentAsTextBlock?: boolean;
  /** Extra top-level body fields, spread last (e.g. `modalities`, `stream`). */
  extraBodyFields?: Record<string, unknown>;
};

/** One completion request: the resolved prompt and the decoding knobs. */
export type LlmCompletionRequest = {
  config: LlmClientConfig;
  system: string;
  user: string;
  temperature: number;
  maxOutputTokens: number;
  wire?: LlmWireOptions;
};

/** The answer text plus whichever token counts the upstream chose to report. */
export type LlmCompletion = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * The upstream's own completion stop/finish reason, verbatim (`end_turn`, `stop`, `max_tokens`,
   * `length`, …), or null when the dialect did not report one. A caller that must not accept a
   * truncated answer reads {@link LlmCompletion.truncated} instead of interpreting this string
   * itself; hand-built stubs may omit both fields.
   */
  stopReason?: string | null;
  /**
   * True when the stop reason means the answer was cut off (the output token ceiling was hit or
   * the provider reported a length/truncation finish). Optional so a hand-built stub without it
   * still satisfies the type; the parsers below always set it.
   */
  truncated?: boolean;
  /**
   * Anthropic prompt-cache reads and creations. Both are REPORTED but never added to
   * `inputTokens`: the cockpit brief's budget counts every class separately, so a consumer that
   * needs the true spend adds these to input + output itself. Absent on dialects (OpenAI) that do
   * not report them, so a hand-built stub without these fields still satisfies the type.
   */
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
};

/** A response that parsed as JSON but does not carry the protocol's declared shape. */
export class LlmShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmShapeError';
  }
}

/** The strategy surface: everything `llm-client.ts` would otherwise branch on. */
export type LlmProtocol = {
  readonly name: LlmProtocolName;
  /** The auth scheme a request uses when its settings leave `authScheme` empty. */
  readonly defaultAuthScheme: 'x-api-key' | 'bearer';
  /** The completion URL for this dialect. */
  endpoint(baseUrl: string): string;
  /** The serialised request body. */
  buildRequest(request: LlmCompletionRequest): Record<string, unknown>;
  /** The authorization headers the effective scheme implies. */
  authHeaders(credential: ApiCredential, scheme: LlmAuthScheme): Record<string, string>;
  /** Protocol-fixed headers (Anthropic's version pin lives here). */
  headers(): Record<string, string>;
  /** Read the answer text and usage out of one JSON payload. */
  parseResponse(payload: unknown): LlmCompletion;
  /** Read this dialect's stop/finish reason, or null when the payload names none. */
  readStopReason(payload: unknown): string | null;
};

/**
 * Build the completion endpoint. A `baseUrl` that already names this dialect's
 * endpoint is used as-is; one that ends in `/v1` (with or without a trailing slash)
 * is not given a second `/v1`.
 */
function completionEndpoint(baseUrl: string, dialect: 'messages' | 'chat/completions'): string {
  const root = baseUrl.trim().replace(/\/+$/, '');
  if (root.endsWith(`/${dialect}`)) return root;
  const versioned = /\/v1$/.test(root) ? root : `${root}/v1`;
  return `${versioned}/${dialect}`;
}

/** A finite number, or null when the upstream reported nothing usable. */
function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read the token counts under one dialect's field names. */
function readUsage(
  payload: unknown,
  inputKey: string,
  outputKey: string,
  cacheReadKey: string | null,
  cacheCreationKey: string | null,
): Pick<LlmCompletion, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'> {
  const empty = {
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  } as const;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return empty;
  const usage = (payload as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return empty;
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: tokenCount(record[inputKey]),
    outputTokens: tokenCount(record[outputKey]),
    cacheReadInputTokens: cacheReadKey === null ? null : tokenCount(record[cacheReadKey]),
    cacheCreationInputTokens: cacheCreationKey === null ? null : tokenCount(record[cacheCreationKey]),
  };
}

/** Pull the answer text out of an Anthropic Messages response. */
function readAnthropicText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LlmShapeError('upstream response was not an object');
  }
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    throw new LlmShapeError('anthropic response carried no content array');
  }
  const texts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    // `thinking` blocks are deliberately skipped: only the answer is a completion.
    if (record.type === 'text' && typeof record.text === 'string') texts.push(record.text);
  }
  const text = texts.join('\n').trim();
  if (text === '') {
    throw new LlmShapeError('anthropic response carried no text block');
  }
  return text;
}

/** Stop/finish reasons that mean the answer was cut off rather than finished. */
const TRUNCATING_STOP_REASONS: readonly string[] = ['max_tokens', 'length'];

/**
 * Whether a dialect's stop/finish reason says the answer was truncated.
 *
 * Both dialects spell the output-ceiling case with their own word (`max_tokens` for Anthropic,
 * `length` for OpenAI), so the table is shared and the strategies call it rather than each
 * carrying its own comparison. Any other reason — including null — is a finished answer.
 */
export function isTruncatingStopReason(stopReason: string | null): boolean {
  return stopReason !== null && TRUNCATING_STOP_REASONS.includes(stopReason);
}

/** A plain-object record, or null for anything else (including arrays). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== 'object' || Array.isArray(value)
    ? null
    : value as Record<string, unknown>;
}

/** Read one string field out of a record, or null when it is absent or not a string. */
function readStringField(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The answer text and stop reason out of an OpenAI Chat Completions response. */
function readOpenAiChoice(payload: unknown): Record<string, unknown> | null {
  const first = asRecord(payload)?.choices;
  if (!Array.isArray(first) || first.length === 0) return null;
  return asRecord(first[0]);
}

/** Anthropic reports `stop_reason` at the top level of the Messages response. */
function readAnthropicStopReason(payload: unknown): string | null {
  return readStringField(asRecord(payload), 'stop_reason');
}

/** OpenAI reports `finish_reason` on the first choice. */
function readOpenAiStopReason(payload: unknown): string | null {
  return readStringField(readOpenAiChoice(payload), 'finish_reason');
}

/** Pull the answer text out of an OpenAI Chat Completions response. */
function readOpenAiText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LlmShapeError('upstream response was not an object');
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmShapeError('openai response carried no choices');
  }
  const first = choices[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) {
    throw new LlmShapeError('openai response carried a malformed choice');
  }
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new LlmShapeError('openai response carried no message');
  }
  // `reasoning_content` is deliberately ignored; only `content` is the answer.
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmShapeError('openai response carried no content string');
  }
  return content.trim();
}

/** The Anthropic Messages dialect. */
export const anthropicProtocol: LlmProtocol = {
  name: 'anthropic',
  defaultAuthScheme: 'x-api-key',
  endpoint(baseUrl) {
    return completionEndpoint(baseUrl, 'messages');
  },
  buildRequest(request) {
    const { config } = request;
    const thinking = config.disableThinking ? { thinking: { type: 'disabled' } } : {};
    return {
      model: config.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      temperature: request.temperature,
      ...thinking,
    };
  },
  authHeaders(credential, scheme) {
    const headers: Record<string, string> = {};
    const apiKey = credential.reveal();
    if (scheme === '' || scheme === 'x-api-key') headers['x-api-key'] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  },
  headers() {
    return { 'anthropic-version': '2023-06-01' };
  },
  parseResponse(payload) {
    const stopReason = readAnthropicStopReason(payload);
    return {
      text: readAnthropicText(payload),
      ...readUsage(payload, 'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'),
      stopReason,
      truncated: isTruncatingStopReason(stopReason),
    };
  },
  readStopReason: readAnthropicStopReason,
};

/** The OpenAI Chat Completions dialect. */
export const openaiProtocol: LlmProtocol = {
  name: 'openai',
  defaultAuthScheme: 'bearer',
  endpoint(baseUrl) {
    return completionEndpoint(baseUrl, 'chat/completions');
  },
  buildRequest(request) {
    const { config } = request;
    const thinking = config.disableThinking ? { thinking: { type: 'disabled' } } : {};
    const messages: Array<Record<string, unknown>> = [];
    // An empty system prompt means "no system turn"; a caller that only has one
    // user message (the voice summary leaf) then sends exactly that.
    if (request.system.trim() !== '') messages.push({ role: 'system', content: request.system });
    messages.push({
      role: 'user',
      content: request.wire?.userContentAsTextBlock
        ? [{ type: 'text', text: request.user }]
        : request.user,
    });
    return {
      model: config.model,
      max_tokens: request.maxOutputTokens,
      messages,
      temperature: request.temperature,
      ...thinking,
      ...(request.wire?.extraBodyFields ?? {}),
    };
  },
  authHeaders(credential, scheme) {
    const headers: Record<string, string> = {};
    const apiKey = credential.reveal();
    if (scheme === 'x-api-key') headers['x-api-key'] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  },
  headers() {
    return {};
  },
  parseResponse(payload) {
    const stopReason = readOpenAiStopReason(payload);
    return {
      text: readOpenAiText(payload),
      ...readUsage(payload, 'prompt_tokens', 'completion_tokens', null, null),
      stopReason,
      truncated: isTruncatingStopReason(stopReason),
    };
  },
  readStopReason: readOpenAiStopReason,
};

/** The protocol table. Adding a dialect is one entry here, never an `if` in the client. */
const LLM_PROTOCOLS: Record<LlmProtocolName, LlmProtocol> = {
  anthropic: anthropicProtocol,
  openai: openaiProtocol,
};

/** Select the strategy a protocol name names. */
export function selectProtocol(name: LlmProtocolName): LlmProtocol {
  return LLM_PROTOCOLS[name];
}
