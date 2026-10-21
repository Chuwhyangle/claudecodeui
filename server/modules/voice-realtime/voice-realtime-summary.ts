/**
 * The run-end summary's SIDE TEXT MODEL leaf: one short, spoken sentence about what a finished run
 * did, produced by the realtime model's HTTP twin instead of by the relay.
 *
 * WHY THIS FILE EXISTS. The narrator layer already owns WHEN a summary is spoken (the run-end
 * transition, see `voice-realtime-narrator.ts`) and the proxy already owns the quality gate (no
 * Markdown, no verbatim tail; length is a READING, not a refusal — see the 2026-10-20 measurement
 * below). What was missing is WHERE the words come from: the first wiring answered with a fixed
 * stand-in sentence. B-1 (see `experiments/voice-realtime-announce-summary/summarize.mts`) showed
 * that an omni flash model — the HTTP twin of the realtime relay model — turns a real Claude Code
 * output into a compliant spoken summary under the `voice` prompt variant. This leaf is that
 * probe's production shape: one `chat/completions` request per run end, no streaming, no audio.
 *
 * WHY `qwen-flash` (2026-10-20). The omni twin took 5.9 s on a single ask and 7.4 s / 12.3 s in the
 * two production turns; `qwen-flash` answered the same request in 0.58–0.69 s. Its answers run
 * 42–44 chars, which the old ≤40-character gate refused — so the gate was dropped (the prompt now
 * asks for terseness rather than counting) and the model was swapped. The context pack is NOT
 * trimmed: 1400 → 600 chars saved ~80 ms and the pack also serves the relay's coreference.
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

// The service's address has ONE shipping source: the endpoint rule module. AC-140's
// `endpoint-rule.single-implementation` reading scans `src/`, `shared/` and `server/` for a second
// copy of the host, so this leaf composes its endpoint from that export instead of spelling it.
//
// Read through the transport sibling rather than the rule module: the transport already enters the
// registry before the rule module (the ordering that avoids the provider's TDZ) and already pays
// the two repo-root `shared/` imports that AC-394's unresolved-internal budget counts. A pair of its
// own here would push that ratchet reading from 19 to 21.
import { DASHSCOPE_PUBLIC_HOSTNAME } from './voice-realtime-dashscope-transport.js';

/** The environment variable that arms the side text model. Read by `server/index.ts`. */
export const VOICE_REALTIME_SUMMARY_MODEL_ENV = 'VOICE_REALTIME_SUMMARY_MODEL';

/**
 * The model used when the caller names none. `qwen-flash` measured ~9× faster than the previous
 * omni twin on the same ~1400-char context (0.58–0.69 s vs 5.9 s, 2026-10-20) and its 42–44-char
 * answers are now accepted (the length gate was dropped).
 */
export const DEFAULT_VOICE_REALTIME_SUMMARY_MODEL = 'qwen-flash';

/**
 * The DashScope compatible-mode endpoint that serves the side text model.
 *
 * Composed from the endpoint rule module's `PUBLIC_HOSTNAME` rather than spelling the host again:
 * AC-140's `endpoint-rule.single-implementation` reading holds that the addresses this service is
 * reached at live in exactly one shipping file (the rule module), and this leaf used to be a second
 * one. The composed value is byte-for-byte the endpoint this leaf shipped with.
 */
const DEFAULT_BASE_URL = `https://${DASHSCOPE_PUBLIC_HOSTNAME}/compatible-mode/v1/chat/completions`;

/**
 * The summary prompt. The old "不超过 40 字" bound was dropped with the gate it mirrored: the model
 * is asked to be terse and to say the RESULT rather than walk through the process, but no hard
 * character count is imposed. Markdown and reading the output back are still refused downstream.
 */
const RUN_END_SUMMARY_PROMPT =
  '你是语音播报助手。下面是一段 Claude Code 的工作输出。请用一句简短、口语化的中文说出它完成了什么、结论是什么。要精简，讲结果不讲过程，不设硬性字数；不要念原文，不要用 Markdown，不要列举，不要复述细节。';

/** The one run's OWN output a run-end ask carries, and the run it belongs to. */
export type VoiceRealtimeRunEndSummarizerInput = {
  output: string;
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
  /** Ask the side model for one spoken summary of the run's `output`; `null` means "say nothing". */
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
        // A runaway guard only — the prompt sets no hard length and the gate no longer counts.
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${RUN_END_SUMMARY_PROMPT}\n\n<输出>\n${input.output}\n</输出>`,
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
