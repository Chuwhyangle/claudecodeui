/**
 * The `voice-realtime` TTS leaf: the text Live Voice has to SAY converted into audio the browser
 * can play.
 *
 * WHY THIS LEAF EXISTS. Until now the Realtime session is text-only (`DEFAULT_SESSION_DEFAULTS`
 * declares `modalities: ['text']`) and therefore produces no sound at all: the relay's placeholder
 * acknowledgement and its run-end summary reached the page as words, never as voice. This module is
 * the other direction of the wire — text in, CosyVoice audio out — and it is deliberately a LEAF:
 * it opens no WebSocket, registers no route and reads no environment variable. The composition root
 * resolves the credential/voice and the `voice-realtime-ws-proxy.service.ts` downlink will call it;
 * a criterion drives it through an injected `fetch` and an injected downlink sink, so the whole
 * path (request shape, streamed bytes, frame order, error reporting) is provable offline.
 *
 * THE WIRE IS COSYVOICE'S OWN HTTP API, NOT THE OPENAI-COMPATIBLE ONE. `cosyvoice-v3.5-flash` is
 * served by `POST /api/v1/services/audio/tts/SpeechSynthesizer` with a `{model, input:{text, voice,
 * format, sample_rate}}` body. This task's proposal calls the API "HTTP 兼容模式"; the compatible
 * mode (`/compatible-mode/v1/...`) has no documented speech-synthesis route for CosyVoice, so a
 * client pointed there would 404 against the real service. The endpoint constant below is the
 * documented one, and the criterion pins it.
 *
 * WHY THE ANSWER IS READ AS SSE. With `X-DashScope-SSE: enable` the service streams
 * `sentence-synthesis` events whose `output.audio.data` is a base64 audio chunk; the non-streaming
 * answer carries only a 24-hour URL and requires a second, unauthenticated download. Streaming is
 * one request, gives the relay bytes it can forward while synthesis is still running, and lets the
 * criterion assert frame ORDER rather than a single blob.
 *
 * NOTHING HERE IS SILENT. The two failures that would otherwise look like success — a model the
 * service does not know, and a 200 answer that carries no audio — both resolve to a named code and
 * a `tts_error` frame. A caller never receives `ok: true` with zero bytes.
 */

/**
 * The CosyVoice model this leaf ships for the placeholder-confirmation / run-end-summary text.
 *
 * Exported so a later composition root and the AC-405 criterion read the same literal instead of
 * each spelling a model name that could drift from the other.
 */
export const DEFAULT_VOICE_REALTIME_TTS_MODEL = 'cosyvoice-v3.5-flash';

/** The DashScope host the documented HTTP TTS endpoint hangs off. Consumed by the composition root. */
export const DEFAULT_VOICE_REALTIME_TTS_BASE_URL = 'https://dashscope.aliyuncs.com';

/**
 * The documented non-realtime speech-synthesis path.
 *
 * Consumed by this module's request builder and by the AC-405 criterion, which asserts the request
 * reaches exactly this path rather than a compatible-mode `/audio/speech` route CosyVoice does not
 * serve.
 */
export const VOICE_REALTIME_TTS_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';

/** The audio container requested by default. WAV keeps the duration readable from the bytes. */
export const DEFAULT_VOICE_REALTIME_TTS_FORMAT = 'wav';

/** The sample rate requested by default (the CosyVoice HTTP API's own default). */
export const DEFAULT_VOICE_REALTIME_TTS_SAMPLE_RATE = 24_000;

/** How long one synthesis request may run before it is aborted. */
export const DEFAULT_VOICE_REALTIME_TTS_TIMEOUT_MS = 30_000;

/**
 * The largest audio payload one downlink frame carries.
 *
 * The browser concatenates frames in `seq` order, so the bound is a latency/buffer choice rather
 * than a protocol limit: 16 KiB of 24 kHz 16-bit PCM is ~341 ms, small enough to start playback
 * early and large enough that a short summary is a handful of frames.
 */
export const DEFAULT_VOICE_REALTIME_TTS_FRAME_BYTES = 16 * 1024;

/** One audio container the CosyVoice HTTP API can return. */
export type VoiceRealtimeTtsFormat = 'wav' | 'pcm' | 'mp3' | 'opus';

/**
 * The named failures this leaf can report.
 *
 * A closed vocabulary on purpose: the page and the journal have to be able to tell "the credential
 * is absent" from "the service refused the model" from "the service answered with no audio", and a
 * free-form message alone cannot be counted. `TTS_UPSTREAM_ERROR` keeps the service's own code
 * beside it in `upstreamCode` — that is the reading that makes a fake model name attributable
 * rather than merely red.
 */
export type VoiceRealtimeTtsErrorCode =
  | 'TTS_NOT_CONFIGURED'
  | 'TTS_EMPTY_TEXT'
  | 'TTS_UNREACHABLE'
  | 'TTS_TIMEOUT'
  | 'TTS_UPSTREAM_ERROR'
  | 'TTS_MALFORMED_RESPONSE'
  | 'TTS_EMPTY_AUDIO'
  | 'TTS_DELIVERY_FAILED';

/**
 * The HTTP seam.
 *
 * Injected rather than reached globally for the same reason every other transport in this module
 * takes one: the criterion supplies a counting stand-in and can assert the request frame without a
 * socket, and a deployment supplies the process's own `fetch`.
 */
export type VoiceRealtimeTtsFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Everything one synthesis call needs.
 *
 * `voice` is REQUIRED and has no fallback. CosyVoice v3.5 voices are cloned/designed per account;
 * silently substituting a system voice would either fail upstream with a misleading error or speak
 * in a voice the deployment never chose, so an absent voice is refused here as
 * `TTS_NOT_CONFIGURED`.
 */
export type VoiceRealtimeTtsOptions = {
  /** Bearer credential. Never placed in a frame, a result or an error message. */
  apiKey: string;
  /** The provider voice id the deployment configured. */
  voice: string;
  /** Defaults to {@link DEFAULT_VOICE_REALTIME_TTS_MODEL}. */
  model?: string;
  /** Defaults to {@link DEFAULT_VOICE_REALTIME_TTS_BASE_URL}. */
  baseUrl?: string;
  /** Defaults to {@link DEFAULT_VOICE_REALTIME_TTS_FORMAT}. */
  format?: VoiceRealtimeTtsFormat;
  /** Defaults to {@link DEFAULT_VOICE_REALTIME_TTS_SAMPLE_RATE}. */
  sampleRate?: number;
  /** Defaults to the process's global `fetch`. */
  fetch?: VoiceRealtimeTtsFetch;
  /** Defaults to {@link DEFAULT_VOICE_REALTIME_TTS_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Defaults to {@link DEFAULT_VOICE_REALTIME_TTS_FRAME_BYTES}. */
  frameBytes?: number;
};

/**
 * One utterance to speak.
 *
 * `utteranceId` is the correlation id the page uses to join the frames of one synthesis (a late
 * frame from a cancelled announcement must not be appended to the next one). It is the caller's to
 * choose; this module never invents one.
 */
export type VoiceRealtimeTtsInput = { utteranceId: string; text: string };

/**
 * One downlink frame this leaf asks the transport to send to the browser.
 *
 * These are the frames a later wiring task adds to the `/voice-realtime` outbound union. They live
 * here, beside the producer, because this task's scope is the leaf: `tts_audio` carries a bounded
 * base64 slice in `seq` order, `tts_done` closes the utterance with the readings the page needs to
 * plan playback (total bytes and, for WAV, duration), and `tts_error` is the destination of every
 * refusal above — there is no attempt with neither audio nor error.
 */
export type VoiceRealtimeTtsFrame =
  | {
      type: 'tts_audio';
      utteranceId: string;
      /** Zero-based order within this utterance. */
      seq: number;
      /** Base64 bytes of this slice. */
      audio: string;
      format: VoiceRealtimeTtsFormat;
      sampleRate: number;
    }
  | {
      type: 'tts_done';
      utteranceId: string;
      /** How many `tts_audio` frames this utterance produced. */
      frames: number;
      /** Total decoded audio bytes (not base64 length). */
      bytes: number;
      /** WAV duration read off the bytes; `null` for containers this module cannot measure. */
      durationMs: number | null;
      /** The billed character count the service reported, or the input length when it reported none. */
      characters: number;
    }
  | {
      type: 'tts_error';
      utteranceId: string;
      code: VoiceRealtimeTtsErrorCode;
      message: string;
      /** The service's own code (`InvalidParameter`, …) when the failure came from it. */
      upstreamCode?: string;
      /** The HTTP status when the failure was a non-2xx answer. */
      httpStatus?: number;
    };

/** What one synthesis produced, before any framing. Consumed by {@link speakVoiceRealtimeText}. */
export type VoiceRealtimeTtsSynthesis =
  | {
      ok: true;
      bytes: Uint8Array;
      format: VoiceRealtimeTtsFormat;
      sampleRate: number;
      durationMs: number | null;
      characters: number;
    }
  | {
      ok: false;
      code: VoiceRealtimeTtsErrorCode;
      message: string;
      upstreamCode?: string;
      httpStatus?: number;
    };

/** What one speak call produced. Consumed by the later proxy wiring and by the criterion. */
export type VoiceRealtimeTtsResult =
  | { ok: true; frames: number; bytes: number; durationMs: number | null; characters: number }
  | { ok: false; code: VoiceRealtimeTtsErrorCode; message: string; upstreamCode?: string; httpStatus?: number };

/** The downlink the caller supplies: one frame per call, in emission order. */
export type VoiceRealtimeTtsDownlink = (frame: VoiceRealtimeTtsFrame) => void;

/**
 * The longest upstream message this leaf repeats.
 *
 * The service's refusal text is the single most useful fact in a red report, so it is carried —
 * but a malformed answer could be megabytes, and an error frame is not a place to forward an
 * arbitrary body. The cap keeps the message attributable without making the frame unbounded.
 */
const MAX_UPSTREAM_MESSAGE_CHARS = 500;

const BASE64_PAYLOAD = /^[A-Za-z0-9+/]*$/;
const BASE64_PADDING = /^[A-Za-z0-9+/]*={0,2}$/;

/** Reads a string member without trusting the shape of an upstream JSON document. */
function stringField(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** The nested `error.code` shape some DashScope answers use instead of a top-level `code`. */
function nestedErrorCode(record: Record<string, unknown> | null): string | null {
  if (record === null) return null;
  const error = record.error;
  if (typeof error !== 'object' || error === null) return null;
  return stringField(error as Record<string, unknown>, 'code');
}

/** The nested `error.message` counterpart of {@link nestedErrorCode}. */
function nestedErrorMessage(record: Record<string, unknown> | null): string | null {
  if (record === null) return null;
  const error = record.error;
  if (typeof error !== 'object' || error === null) return null;
  return stringField(error as Record<string, unknown>, 'message');
}

/** One bounded message for a frame and a result. */
function boundedMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed === '') return 'the TTS service refused the request without a message';
  return trimmed.length <= MAX_UPSTREAM_MESSAGE_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_UPSTREAM_MESSAGE_CHARS)}…`;
}

/**
 * The named failure owed an HTTP answer the service refused.
 *
 * Exported through neither barrel nor here: it is an internal reading. The upstream code is taken
 * from the top-level `code` when present (the documented DashScope error envelope) and from
 * `error.code` otherwise, so a fake model name arrives with the service's own discriminator.
 */
function upstreamFailure(status: number, body: string): Extract<VoiceRealtimeTtsSynthesis, { ok: false }> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(body);
    if (typeof candidate === 'object' && candidate !== null) parsed = candidate as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  const upstreamCode = stringField(parsed, 'code') ?? nestedErrorCode(parsed);
  const message =
    stringField(parsed, 'message') ??
    nestedErrorMessage(parsed) ??
    (body.trim() === '' ? `the TTS service answered HTTP ${status} with no body` : body);

  return {
    ok: false,
    code: 'TTS_UPSTREAM_ERROR',
    message: boundedMessage(message),
    ...(upstreamCode === null ? {} : { upstreamCode }),
    httpStatus: status,
  };
}

/** The failure owed a configuration that cannot be sent anywhere. */
function configurationFailure(message: string): Extract<VoiceRealtimeTtsSynthesis, { ok: false }> {
  return { ok: false, code: 'TTS_NOT_CONFIGURED', message };
}

/**
 * Decodes one base64 audio chunk, or `null` when the data is not base64.
 *
 * `Buffer.from(value, 'base64')` silently skips illegal characters, so a malformed chunk would
 * otherwise decode to a shorter buffer and be delivered as if it were audio. The shape is checked
 * first, and missing padding is tolerated (some SSE producers omit it) before decoding.
 */
function decodeAudioChunk(data: string): Uint8Array | null {
  const compact = data.replace(/\s+/g, '');
  if (compact === '') return new Uint8Array(0);
  if (!BASE64_PADDING.test(compact)) return null;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const body = compact.slice(0, compact.length - padding);
  if (!BASE64_PAYLOAD.test(body)) return null;
  if (body.length % 4 === 1) return null;
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4);
  const decoded = Buffer.from(padded, 'base64');
  if (decoded.length === 0 && body !== '') return null;
  return new Uint8Array(decoded);
}

/** Reads one little-endian unsigned 32-bit integer, or `null` when the bytes are short. */
function readUint32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0
  );
}

/** Four ASCII bytes as a chunk id, or `null` when the range is short. */
function chunkId(bytes: Uint8Array, offset: number): string | null {
  if (offset + 4 > bytes.length) return null;
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/**
 * The duration of a RIFF/WAVE blob, in milliseconds, read from its own `fmt `/`data` chunks.
 *
 * WHY DURATION IS READ FROM THE BYTES. The AC's "the audio's duration is the same order of
 * magnitude as the text" is only meaningful if it is measured from what actually came back; a
 * caller-side estimate from the text would pass whatever the service returned. WAV is the default
 * container precisely because this reading is exact (data bytes ÷ byte rate); for mp3/opus the
 * function honestly answers `null` rather than guessing a bitrate.
 *
 * `null` also covers a truncated or non-RIFF blob, so an unmeasurable answer is never reported as
 * zero seconds.
 */
function wavDurationMs(bytes: Uint8Array): number | null {
  if (chunkId(bytes, 0) !== 'RIFF' || chunkId(bytes, 8) !== 'WAVE') return null;

  let byteRate: number | null = null;
  let dataSize: number | null = null;
  let offset = 12;
  // A RIFF file is a walk of `id + size + body`; the `fmt ` chunk carries the byte rate and the
  // `data` chunk its own payload length. Sizes are padded to an even boundary.
  while (offset + 8 <= bytes.length) {
    const id = chunkId(bytes, offset);
    const size = readUint32LE(bytes, offset + 4);
    if (id === null || size === null) return null;
    const bodyStart = offset + 8;
    if (id === 'fmt ' && bodyStart + 16 <= bytes.length) {
      byteRate = readUint32LE(bytes, bodyStart + 8);
    } else if (id === 'data') {
      // A streamed WAV may declare 0xFFFFFFFF; the bytes actually present are the honest bound.
      dataSize = Math.min(size, bytes.length - bodyStart);
    }
    const advance = 8 + size + (size % 2);
    if (advance <= 8) return null; // a zero/overflowing size would loop forever
    offset += advance;
  }

  if (byteRate === null || byteRate <= 0 || dataSize === null || dataSize <= 0) return null;
  return (dataSize / byteRate) * 1000;
}

/**
 * Yields the `data:` payload of every SSE event in a response body.
 *
 * DashScope emits one JSON object per `data:` line. Empty keep-alive payloads are skipped rather
 * than parsed, and a trailing line without a newline is still read (a stream that closes exactly
 * after the final event must not lose it). Multi-line `data:` events are not part of this API.
 */
async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data !== '') yield data;
        }
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    for (const raw of pending.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data !== '') yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** One parsed SSE event, or `null` when it is not a JSON object. */
function parseEvent(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The request body the documented CosyVoice HTTP API expects.
 *
 * `format` and `sample_rate` belong to `input` (not `parameters`) on this endpoint; the criterion
 * reads them out of the captured request so a client that put them anywhere else is red.
 */
function requestBody(
  text: string,
  model: string,
  voice: string,
  format: VoiceRealtimeTtsFormat,
  sampleRate: number,
): string {
  return JSON.stringify({
    model,
    input: { text, voice, format, sample_rate: sampleRate },
  });
}

/**
 * Synthesizes one piece of text into audio bytes.
 *
 * Consumed by {@link speakVoiceRealtimeText} and, later, by any caller that wants the bytes without
 * the frame contract (for example an on-disk probe). Pure of the environment: every input arrives
 * as an option. No request is made when the configuration cannot produce one, and a 2xx answer is
 * never `ok` with zero bytes — that is `TTS_EMPTY_AUDIO`.
 */
export async function synthesizeVoiceRealtimeSpeech(
  text: string,
  options: VoiceRealtimeTtsOptions,
): Promise<VoiceRealtimeTtsSynthesis> {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, code: 'TTS_EMPTY_TEXT', message: 'there is no text to speak' };
  }
  if (options.apiKey.trim() === '') {
    return configurationFailure('the TTS service needs an API key');
  }
  if (options.voice.trim() === '') {
    return configurationFailure('the TTS service needs a voice id');
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return configurationFailure('this process has no fetch implementation');
  }

  const model = options.model ?? DEFAULT_VOICE_REALTIME_TTS_MODEL;
  const baseUrl = (options.baseUrl ?? DEFAULT_VOICE_REALTIME_TTS_BASE_URL).replace(/\/+$/, '');
  const format = options.format ?? DEFAULT_VOICE_REALTIME_TTS_FORMAT;
  const sampleRate = options.sampleRate ?? DEFAULT_VOICE_REALTIME_TTS_SAMPLE_RATE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VOICE_REALTIME_TTS_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${VOICE_REALTIME_TTS_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // THE CREDENTIAL TRAVELS ONLY HERE. It is never placed in a frame, a result or a message.
        Authorization: `Bearer ${options.apiKey}`,
        // Ask for the streamed answer: one request, audio chunks inside it.
        'X-DashScope-SSE': 'enable',
      },
      body: requestBody(trimmed, model, options.voice, format, sampleRate),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return {
        ok: false,
        code: 'TTS_TIMEOUT',
        message: `the TTS service did not answer within ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'TTS_UNREACHABLE', message: boundedMessage(`the TTS service was unreachable: ${message}`) };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return upstreamFailure(response.status, body);
  }
  if (response.body === null) {
    return {
      ok: false,
      code: 'TTS_MALFORMED_RESPONSE',
      message: 'the TTS service answered without a body',
    };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let characters: number | null = null;

  try {
    for await (const data of sseDataLines(response.body)) {
      const event = parseEvent(data);
      if (event === null) {
        return {
          ok: false,
          code: 'TTS_MALFORMED_RESPONSE',
          message: 'the TTS stream carried an event that is not JSON',
        };
      }

      // An error can arrive INSIDE a 2xx stream (the service already committed the response).
      const eventCode = stringField(event, 'code') ?? nestedErrorCode(event);
      if (eventCode !== null) {
        const message =
          stringField(event, 'message') ?? nestedErrorMessage(event) ?? 'the TTS service reported an error';
        return {
          ok: false,
          code: 'TTS_UPSTREAM_ERROR',
          message: boundedMessage(message),
          upstreamCode: eventCode,
        };
      }

      const output = event.output;
      if (typeof output !== 'object' || output === null) continue;
      const outputRecord = output as Record<string, unknown>;

      const usage = event.usage;
      if (typeof usage === 'object' && usage !== null) {
        const billed = (usage as Record<string, unknown>).characters;
        if (typeof billed === 'number' && Number.isFinite(billed) && billed >= 0) characters = billed;
      }

      const audio = outputRecord.audio;
      if (typeof audio !== 'object' || audio === null) continue;
      const audioData = stringField(audio as Record<string, unknown>, 'data');
      if (audioData === null || audioData.trim() === '') continue;

      const decoded = decodeAudioChunk(audioData);
      if (decoded === null) {
        return {
          ok: false,
          code: 'TTS_MALFORMED_RESPONSE',
          message: 'the TTS stream carried audio data that is not base64',
        };
      }
      if (decoded.length === 0) continue;
      chunks.push(decoded);
      totalBytes += decoded.length;
    }
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return {
        ok: false,
        code: 'TTS_TIMEOUT',
        message: `the TTS service did not finish within ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'TTS_UNREACHABLE', message: boundedMessage(`the TTS stream failed: ${message}`) };
  }

  if (totalBytes === 0) {
    return {
      ok: false,
      code: 'TTS_EMPTY_AUDIO',
      message: 'the TTS service completed the request without producing any audio',
    };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    ok: true,
    bytes,
    format,
    sampleRate,
    durationMs: format === 'wav' ? wavDurationMs(bytes) : null,
    characters: characters ?? trimmed.length,
  };
}

/**
 * Synthesizes one text and sends its audio to the browser as ordered downlink frames.
 *
 * THE ORDER IS THE CONTRACT. Decoded audio is sliced into `frameBytes` pieces and each piece is one
 * `tts_audio` frame with a zero-based `seq`; `tts_done` follows with the total readings. Every
 * failure path emits exactly one `tts_error` frame and NO audio, so a page that joined whatever it
 * received can never mistake a refusal for a short utterance.
 *
 * A throwing downlink is reported as `TTS_DELIVERY_FAILED` rather than escaping: the sink is the
 * transport, and a closed browser socket must not turn into an unhandled rejection on the relay.
 * Consumed by the `/voice-realtime` proxy wiring (a later task) and by the AC-405 criterion.
 */
export async function speakVoiceRealtimeText(
  input: VoiceRealtimeTtsInput,
  options: VoiceRealtimeTtsOptions,
  downlink: VoiceRealtimeTtsDownlink,
): Promise<VoiceRealtimeTtsResult> {
  const synthesis = await synthesizeVoiceRealtimeSpeech(input.text, options);
  if (!synthesis.ok) {
    try {
      downlink({
        type: 'tts_error',
        utteranceId: input.utteranceId,
        code: synthesis.code,
        message: synthesis.message,
        ...(synthesis.upstreamCode === undefined ? {} : { upstreamCode: synthesis.upstreamCode }),
        ...(synthesis.httpStatus === undefined ? {} : { httpStatus: synthesis.httpStatus }),
      });
    } catch {
      return {
        ok: false,
        code: 'TTS_DELIVERY_FAILED',
        message: 'the downlink rejected the error frame',
      };
    }
    return synthesis;
  }

  const frameBytes = Math.max(1, Math.floor(options.frameBytes ?? DEFAULT_VOICE_REALTIME_TTS_FRAME_BYTES));
  let frames = 0;
  try {
    for (let offset = 0; offset < synthesis.bytes.length; offset += frameBytes) {
      const slice = synthesis.bytes.subarray(offset, Math.min(offset + frameBytes, synthesis.bytes.length));
      downlink({
        type: 'tts_audio',
        utteranceId: input.utteranceId,
        seq: frames,
        audio: Buffer.from(slice).toString('base64'),
        format: synthesis.format,
        sampleRate: synthesis.sampleRate,
      });
      frames += 1;
    }
    downlink({
      type: 'tts_done',
      utteranceId: input.utteranceId,
      frames,
      bytes: synthesis.bytes.length,
      durationMs: synthesis.durationMs,
      characters: synthesis.characters,
    });
  } catch {
    return { ok: false, code: 'TTS_DELIVERY_FAILED', message: 'the downlink rejected an audio frame' };
  }

  return {
    ok: true,
    frames,
    bytes: synthesis.bytes.length,
    durationMs: synthesis.durationMs,
    characters: synthesis.characters,
  };
}
