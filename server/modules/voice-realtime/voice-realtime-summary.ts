/**
 * The run-end summary's SIDE TEXT MODEL leaf: one short, spoken sentence about what a finished run
 * did, produced by the realtime model's HTTP twin instead of by the relay.
 *
 * WHY THIS FILE EXISTS. The narrator layer already owns WHEN a summary is spoken (the run-end
 * transition, see `voice-realtime-narrator.ts`) and the proxy already owns the quality gate (≤ 40
 * chars, no Markdown, no verbatim tail). What was missing is WHERE the words come from: the first
 * wiring answered with a fixed stand-in sentence. B-1 (see
 * `experiments/voice-realtime-announce-summary/summarize.mts`) showed that `qwen3.8-omni-flash` —
 * the HTTP twin of the realtime relay model — turns a real Claude Code output into a compliant
 * spoken summary under the `voice` prompt variant. This leaf is that probe's production shape: one
 * `chat/completions` request per run end, no streaming, no audio.
 *
 * A LEAF, NOT AN ASSEMBLY. Nothing here reads the environment, opens a socket at import time, or
 * knows which credential the deployment uses: the composition root (`server/index.ts`) decides
 * whether this leaf is active and hands it the user's DashScope key. The `fetch` option is the test
 * seam, exactly as the local TTS leaf's `loadDependency` is.
 *
 * FAILURE IS A NULL, NOT A THROW. An empty key, a non-2xx answer, an unreadable body, an empty
 * summary or a network error all resolve to `null`; the narrator then speaks nothing for that run.
 * A thrown error here would surface as an unhandled rejection in the proxy's run-end watcher, where
 * "there is nothing to say" is the correct and unremarkable answer.
 */

/** The environment variable that arms the side text model. Read by `server/index.ts`. */
export const VOICE_REALTIME_SUMMARY_MODEL_ENV = 'VOICE_REALTIME_SUMMARY_MODEL';

/**
 * The model used when the caller names none. `qwen3.8-omni-flash` is the realtime relay model's
 * HTTP twin and the variant B-1 measured on a real Claude Code output.
 */
export const DEFAULT_VOICE_REALTIME_SUMMARY_MODEL = 'qwen3.8-omni-flash';

/** The DashScope compatible-mode endpoint that serves the side text model. */
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

/** The B-1 `voice` prompt variant, verbatim. Its "不超过 40 字" is the length the gate then re-reads. */
const RUN_END_SUMMARY_PROMPT =
  '你是语音播报助手。下面是一段 Claude Code 的工作输出。请用一句简短、口语化的中文（不超过 40 字）说出它完成了什么、结论是什么。不要念原文，不要用 Markdown，不要列举，不要复述细节。';

/** The context a run-end ask carries: the latest context pack, and the run it belongs to. */
export type VoiceRealtimeRunEndSummarizerInput = {
  context: string;
  /** The run that just ended, when the host reported one. Not sent upstream — it only labels the ask. */
  runId: string | null;
};

/** Everything one summarizer needs, resolved by the composition root. */
export type VoiceRealtimeRunEndSummarizerOptions = {
  /** The DashScope credential. Blank means "no request at all"; the leaf answers `null`. */
  apiKey: string;
  /** The model id; defaults to {@link DEFAULT_VOICE_REALTIME_SUMMARY_MODEL}. */
  model?: string;
  /** Full `chat/completions` URL; defaults to the DashScope compatible-mode endpoint. */
  baseUrl?: string;
  /** Request budget; defaults to 60 s, the B-1 probe's own bound. */
  timeoutMs?: number;
  /** Test seam for the HTTP call; defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** The one method the narrator wiring consumes. */
export type VoiceRealtimeRunEndSummarizer = {
  /** Ask the side model for one spoken summary of `context`; `null` means "say nothing". */
  summarize(input: VoiceRealtimeRunEndSummarizerInput): Promise<string | null>;
};

/** The slice of the compatible-mode response this leaf reads. */
type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

/**
 * Builds the run-end summary producer backed by the side text model.
 *
 * Consumed by `server/index.ts`, which switches to this leaf when `VOICE_REALTIME_SUMMARY_MODEL` is
 * set and passes the user's Live Voice DashScope key. The returned `summarize` is a pure HTTP
 * adapter: every failure mode resolves to `null` so the narrator simply stays quiet.
 */
export function createVoiceRealtimeRunEndSummarizer(
  options: VoiceRealtimeRunEndSummarizerOptions,
): VoiceRealtimeRunEndSummarizer {
  const model = options.model?.trim() || DEFAULT_VOICE_REALTIME_SUMMARY_MODEL;
  const baseUrl = options.baseUrl?.trim() || DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const doFetch = options.fetch ?? fetch;
  return {
    summarize: async (input) => {
      const apiKey = options.apiKey.trim();
      // An empty key is a NAMED refusal to dial: no request, no timeout, no log noise.
      if (apiKey === '') return null;
      const body = {
        model,
        modalities: ['text'],
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${RUN_END_SUMMARY_PROMPT}\n\n<输出>\n${input.context}\n</输出>`,
              },
            ],
          },
        ],
      };
      try {
        const response = await doFetch(baseUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        const parsed = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') return null;
        const text = content.trim();
        return text === '' ? null : text;
      } catch {
        // Network error, timeout, unreadable body: nothing to say for this run.
        return null;
      }
    },
  };
}
