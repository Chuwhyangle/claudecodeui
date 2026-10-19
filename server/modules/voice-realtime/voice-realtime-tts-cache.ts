/**
 * The per-connection TTS cache for the narrator's FIXED announce sentences.
 *
 * WHY THIS EXISTS. The announce closing turn speaks one of a handful of short, known sentences
 * (`voice-realtime-announce-phrases.ts`). Synthesizing each one when it is first needed pays a
 * network round trip and a service queue wait on every announcement (0.66–3.53 s on the
 * 2026-10-19 live capture). This cache pre-synthesizes the whole table as soon as a connection's
 * TTS credential is known ({@link VoiceRealtimeTtsCache.warm}) and replays the audio bytes when the
 * sentence is announced, so the browser receives frames with no synthesis request at all.
 *
 * CORRECTNESS BOUNDARY.
 *
 *  - A HIT AND A MISS REACH THE PAGE IDENTICALLY. Both are framed by the same
 *    `emitVoiceRealtimeSynthesisFrames()` the on-the-spot path uses, so `seq` order, frame sizes
 *    and the `tts_done` readings are the same whether or not the cache held the audio.
 *  - A MISS IS THE EXISTING PATH. `synthesizeVoiceRealtimeSpeech()` is called, its named failures
 *    are delivered as the same `tts_error` frame, and a failed synthesis is NEVER stored. A cache
 *    that was not warmed (or whose warm-up failed) therefore cannot add a new failure mode: it
 *    falls back to exactly the behaviour the narrator had before this module existed.
 *  - A FAILED WARM-UP IS OBSERVABLE AND RETRIED ONCE. Each failed warm-up attempt writes one
 *    `tts cache warm failed` line (attempt, code, upstream code, length) and a phrase that failed
 *    is retried once after {@link WARM_RETRY_DELAY_MS}; a success on that retry writes
 *    `tts cache warm recovered`. A second failure is logged and stops — warm-up never retries
 *    forever, never throws, and never blocks the connection. On-demand (`speak`) failures are NOT
 *    retried.
 *  - CONCURRENT REQUESTS FOR ONE TEXT SYNTHESIZE ONCE. The in-flight map is keyed with the cache
 *    key, so `warm()` and a racing `speak()` (or two simultaneous speaks) share one request.
 *  - THE KEY IS model + voice + text. A deployment that switches voice or model cannot replay audio
 *    spoken by the previous one; the table is otherwise connection-local, so entries never cross a
 *    connection.
 *
 * Nothing here reads the environment: the composition root resolves the credential, the voice and
 * the endpoint and passes them in as {@link VoiceRealtimeTtsCacheOptions.options}.
 */
import {
  DEFAULT_VOICE_REALTIME_TTS_MODEL,
  emitVoiceRealtimeSynthesisFrames,
  synthesizeVoiceRealtimeSpeech,
  type VoiceRealtimeTtsDownlink,
  type VoiceRealtimeTtsInput,
  type VoiceRealtimeTtsOptions,
  type VoiceRealtimeTtsResult,
  type VoiceRealtimeTtsSynthesis,
} from './voice-realtime-tts.js';

/** How many synthesized sentences one connection keeps before the oldest is discarded. */
export const DEFAULT_VOICE_REALTIME_TTS_CACHE_MAX_ENTRIES = 64;

/**
 * How long `warm()` waits before its single retry of a phrase whose first attempt failed, in
 * milliseconds. Short enough not to delay a connection that is already accepting traffic (warm-up
 * is fire-and-forget), long enough to clear a transient service hiccup.
 */
export const WARM_RETRY_DELAY_MS = 250;

/** The bytes of one successful synthesis, as the cache stores them. */
type CachedSynthesis = Extract<VoiceRealtimeTtsSynthesis, { ok: true }>;

/**
 * What one cache needs: the resolved TTS options, the sentences to pre-synthesize, and a logger.
 *
 * `options` is the SAME object the on-the-spot path would receive (credential, voice, endpoint,
 * optional injected `fetch`), so a criterion can count requests without a socket. `phrases` is the
 * warm-up set; `maxEntries` bounds the map, oldest-first. `log` is the composition root's sink: it
 * receives one `tts cache hit`/`tts cache miss` line per narration, plus one
 * `tts cache warm failed` per failed warm-up attempt and one `tts cache warm recovered` when the
 * retry succeeds — the readings that let an operator tell a failed warm-up from a missing one.
 *
 * Consumed by `server/index.ts` (one cache per connection) and by the cache criterion.
 */
export type VoiceRealtimeTtsCacheOptions = {
  options: VoiceRealtimeTtsOptions;
  phrases: readonly string[];
  /** Defaults to {@link DEFAULT_VOICE_REALTIME_TTS_CACHE_MAX_ENTRIES}; values below 1 are clamped to 1. */
  maxEntries?: number;
  log?: (line: string) => void;
};

/**
 * One connection's narrator TTS cache.
 *
 * `warm()` is deliberately non-throwing and safe to call while nothing is playing: a phrase that
 * could not be pre-synthesized is logged, retried once, and — if that also fails — simply misses
 * later and is synthesized on the spot. `speak()` never rejects either — every outcome, including a
 * thrown transport, is delivered as a frame or a named result.
 */
export type VoiceRealtimeTtsCache = {
  /**
   * Pre-synthesize every configured phrase, concurrently. Never rejects; safe to fire and forget.
   * A phrase whose first attempt fails is retried once after {@link WARM_RETRY_DELAY_MS}.
   */
  warm(): Promise<void>;
  /** Speak one utterance, from the cache when possible. Emits frames through `downlink`. */
  speak(input: VoiceRealtimeTtsInput, downlink: VoiceRealtimeTtsDownlink): Promise<VoiceRealtimeTtsResult>;
};

/** One log line's text field: whitespace collapsed so a multiline model sentence cannot break the line. */
function logText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Waits `ms` milliseconds; used only by the single warm-up retry. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds one connection's narrator TTS cache.
 *
 * Consumed by `server/index.ts`, which resolves the credential/voice/endpoint once per connection
 * and fires {@link VoiceRealtimeTtsCache.warm}; the criterion drives the same object with an
 * injected `fetch` and downlink sink.
 */
export function createVoiceRealtimeTtsCache(input: VoiceRealtimeTtsCacheOptions): VoiceRealtimeTtsCache {
  const maxEntries = Math.max(1, Math.floor(input.maxEntries ?? DEFAULT_VOICE_REALTIME_TTS_CACHE_MAX_ENTRIES));
  // A `Map` preserves insertion order, so the first key is the oldest entry — exactly the
  // eviction order the criterion reads ("超过上限按最旧淘汰"). Hits do NOT reinsert.
  const entries = new Map<string, CachedSynthesis>();
  /** One shared promise per key, so `warm()` and a racing `speak()` cannot dial twice. */
  const inFlight = new Map<string, Promise<VoiceRealtimeTtsSynthesis>>();
  const model = input.options.model ?? DEFAULT_VOICE_REALTIME_TTS_MODEL;

  /** The cache key: a deployment that changed model or voice must not replay the old audio. */
  const keyFor = (text: string): string => `${model}\u0000${input.options.voice}\u0000${text.trim()}`;

  /** Stores one successful synthesis, discarding the oldest entries beyond the bound. */
  const store = (key: string, synthesis: VoiceRealtimeTtsSynthesis): void => {
    if (!synthesis.ok) return;
    entries.set(key, synthesis);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  /**
   * Synthesizes one text at most once across every caller waiting on it.
   *
   * The returned promise NEVER rejects: anything the leaf throws is mapped to the same
   * `TTS_UNREACHABLE` failure the leaf itself reports for a transport that failed, so `warm()` can
   * skip it and `speak()` can emit one `tts_error` without a new error path.
   */
  const syntheses = (text: string, key: string): Promise<VoiceRealtimeTtsSynthesis> => {
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const promise = synthesizeVoiceRealtimeSpeech(text, input.options)
      .catch(
        (error: unknown): VoiceRealtimeTtsSynthesis => ({
          ok: false,
          code: 'TTS_UNREACHABLE',
          message: `the TTS service was unreachable: ${error instanceof Error ? error.message : String(error)}`,
        }),
      )
      .then((synthesis) => {
        store(key, synthesis);
        return synthesis;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  };

  /**
   * Runs one warm-up attempt and logs its outcome. A failure logs its attempt number, the leaf's
   * named code and the upstream code (or `none`) so an operator can tell "warm failed" from
   * "warm never ran"; a success on attempt 2 logs that the retry recovered.
   */
  const warmAttempt = async (
    phrase: string,
    key: string,
    attempt: 1 | 2,
  ): Promise<VoiceRealtimeTtsSynthesis> => {
    const synthesis = await syntheses(phrase, key);
    if (synthesis.ok) {
      if (attempt === 2) {
        input.log?.(`tts cache warm recovered text=${logText(phrase)} attempt=2`);
      }
      return synthesis;
    }
    const chars = phrase.trim().length;
    const upstream = synthesis.upstreamCode ?? 'none';
    input.log?.(
      `tts cache warm failed text=${logText(phrase)} attempt=${attempt} code=${synthesis.code} upstream=${upstream} chars=${chars}`,
    );
    return synthesis;
  };

  /**
   * Pre-synthesizes one phrase: skip blank/already-cached entries, then try once and — on failure —
   * retry exactly once after {@link WARM_RETRY_DELAY_MS}. A racing `speak()` that stored the
   * phrase during the delay satisfies the retry without a second request.
   */
  const warmPhrase = async (phrase: string): Promise<void> => {
    if (phrase.trim() === '') return;
    const key = keyFor(phrase);
    if (entries.has(key)) return;
    const first = await warmAttempt(phrase, key, 1);
    if (first.ok) return;
    await delay(WARM_RETRY_DELAY_MS);
    if (entries.has(key)) {
      input.log?.(`tts cache warm recovered text=${logText(phrase)} attempt=2`);
      return;
    }
    await warmAttempt(phrase, key, 2);
  };

  return {
    async warm(): Promise<void> {
      // Concurrent on purpose: the phrases are independent, and the caller does not await this
      // before accepting the connection. A phrase that fails both attempts is stored nowhere and
      // misses later; `speak()` is never retried here.
      await Promise.all(input.phrases.map((phrase) => warmPhrase(phrase)));
    },

    async speak(
      utterance: VoiceRealtimeTtsInput,
      downlink: VoiceRealtimeTtsDownlink,
    ): Promise<VoiceRealtimeTtsResult> {
      const key = keyFor(utterance.text);
      const chars = utterance.text.trim().length;
      const cached = entries.get(key);
      if (cached !== undefined) {
        input.log?.(`tts cache hit text=${logText(utterance.text)} chars=${chars}`);
        return emitVoiceRealtimeSynthesisFrames(utterance, input.options, cached, downlink);
      }
      input.log?.(`tts cache miss text=${logText(utterance.text)} chars=${chars}`);
      const synthesis = await syntheses(utterance.text, key);
      return emitVoiceRealtimeSynthesisFrames(utterance, input.options, synthesis, downlink);
    },
  };
}
