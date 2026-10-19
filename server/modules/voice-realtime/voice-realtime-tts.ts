/**
 * The `voice-realtime` TTS leaf: the text Live Voice has to SAY converted into audio the browser
 * can play.
 *
 * WHY THIS LEAF EXISTS. Until now the Realtime session is text-only (`DEFAULT_SESSION_DEFAULTS`
 * declares `modalities: ['text']`) and therefore produces no sound at all: the relay's placeholder
 * acknowledgement and its run-end summary reached the page as words, never as voice. This module is
 * the other direction of the wire — text in, Qwen3-TTS audio out — and it is deliberately a LEAF:
 * it opens no WebSocket, registers no route and reads no environment variable. The composition root
 * resolves the credential/voice and the `voice-realtime-ws-proxy.service.ts` downlink will call it;
 * a criterion drives it through an injected `fetch` and an injected downlink sink, so the whole
 * path (request shape, streamed bytes, frame order, error reporting) is provable offline.
 *
 * THE WIRE IS DASHSCOPE'S MULTIMODAL-GENERATION API. `qwen3-tts-flash` is served by
 * `POST /api/v1/services/aigc/multimodal-generation/generation` with a `{model, input:{text,
 * voice}}` body. It is NOT the CosyVoice `SpeechSynthesizer` route (which `cosyvoice-v3.5-flash`
 * used), and it is not the OpenAI-compatible `/audio/speech` route either. The endpoint constant
 * below is the documented one, and the criterion pins it.
 *
 * WHY THE ANSWER IS READ AS SSE. With `X-DashScope-SSE: enable` the service streams `result`
 * events whose `output.audio.data` is a base64 WAV chunk; the non-streaming answer carries a
 * 24-hour URL in `output.audio.url` and requires a second, unauthenticated download. Streaming is
 * one request, gives the relay bytes it can forward while synthesis is still running, and lets the
 * criterion assert frame ORDER rather than a single blob.
 *
 * NOTHING HERE IS SILENT. The two failures that would otherwise look like success — a model the
 * service does not know, and a 200 answer that carries no audio — both resolve to a named code and
 * a `tts_error` frame. A caller never receives `ok: true` with zero bytes.
 */

/**
 * The DashScope speech-synthesis model this leaf ships for the placeholder-confirmation /
 * run-end-summary text.
 *
 * Exported so the composition root and the AC-405 criterion read the same literal instead of each
 * spelling a model name that could drift from the other. `qwen3-tts-flash` is chosen over the
 * CosyVoice line because it ships SYSTEM voices: `cosyvoice-v3.5-flash` accepts only a
 * cloned/designed per-account voice id, which no deployment default can name.
 */
export const DEFAULT_VOICE_REALTIME_TTS_MODEL = 'qwen3-tts-flash';

/** The DashScope host the documented HTTP TTS endpoint hangs off. Consumed by the composition root. */
export const DEFAULT_VOICE_REALTIME_TTS_BASE_URL = 'https://dashscope.aliyuncs.com';

/**
 * The environment variable a deployment names its Qwen3-TTS voice id in.
 *
 * Read by `server/index.ts` at its assembly point. The default is a system voice (`Cherry`, see
 * {@link DEFAULT_VOICE_REALTIME_TTS_VOICE}); a deployment overrides it only to speak in a different
 * system voice or a cloned one it enrolled. An explicitly empty voice is still refused as
 * `TTS_NOT_CONFIGURED`, because speaking in an unnamed voice is indistinguishable from silence.
 */
export const VOICE_REALTIME_TTS_VOICE_ENV = 'VOICE_REALTIME_TTS_VOICE';

/**
 * The environment variable that points this leaf at a different HTTP base URL.
 *
 * It exists for ONE caller, exactly like `VOICE_REALTIME_ENDPOINT`: a criterion run whose stand-in
 * TTS server lives on loopback. Its presence is also the switch saying "no real credential" — a
 * stand-in accepts any bearer — so a run that names it never bills the cloud. Unset (the shipped
 * state) means the documented DashScope host above.
 */
export const VOICE_REALTIME_TTS_ENDPOINT_ENV = 'VOICE_REALTIME_TTS_ENDPOINT';

/**
 * The voice id resolved when the deployment names none.
 *
 * `Cherry` is a documented `qwen3-tts-flash` SYSTEM voice (see the Qwen-TTS voice list), so the
 * narrator can speak with no per-account enrollment. {@link synthesizeVoiceRealtimeSpeech} still
 * refuses an explicitly empty voice, so the page receives a named `tts_error` instead of silence
 * that looks like a successful utterance.
 */
export const DEFAULT_VOICE_REALTIME_TTS_VOICE = 'Cherry';

/**
 * The documented non-realtime speech-synthesis path.
 *
 * Consumed by this module's request builder and by the AC-405 criterion, which asserts the request
 * reaches exactly this path rather than the CosyVoice `/audio/tts/SpeechSynthesizer` route or an
 * OpenAI-compatible `/audio/speech` route this model does not serve.
 */
export const VOICE_REALTIME_TTS_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

/**
 * The audio container the service returns. `qwen3-tts-flash` streams a RIFF/WAVE payload, and WAV
 * keeps the duration readable from the bytes; the container is no longer a request parameter, only
 * the frame metadata the browser uses.
 */
export const DEFAULT_VOICE_REALTIME_TTS_FORMAT = 'wav';

/** The sample rate the service returns (`qwen3-tts-flash` streams 24 kHz WAV). */
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

/** One audio container the speech-synthesis service can return. */
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
 * `voice` is REQUIRED, and the composition root always resolves one — the deployment's
 * `VOICE_REALTIME_TTS_VOICE` or the {@link DEFAULT_VOICE_REALTIME_TTS_VOICE} system voice. An
 * explicitly empty voice is refused here as `TTS_NOT_CONFIGURED` rather than dialling a request
 * that would either fail upstream or speak in a voice the deployment never chose.
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
 * What one SSE event contributes to a synthesis, with every refusal already named.
 *
 * Shared by the two consumers below ({@link synthesizeVoiceRealtimeSpeech} and
 * {@link streamVoiceRealtimeSpeech}) so the "an event is JSON, an error can arrive inside a 2xx
 * stream, and audio data is base64" rules exist once. `characters` is reported even on an event
 * that carries no audio, because the billed usage can arrive on its own event.
 */
type VoiceRealtimeTtsEventReading =
  | { kind: 'audio'; bytes: Uint8Array; characters: number | null }
  | { kind: 'none'; characters: number | null }
  | { kind: 'failure'; failure: Extract<VoiceRealtimeTtsSynthesis, { ok: false }> };

/** Reads one `data:` payload as an event under the contract described above. */
function readSynthesisEvent(data: string): VoiceRealtimeTtsEventReading {
  const event = parseEvent(data);
  if (event === null) {
    return {
      kind: 'failure',
      failure: {
        ok: false,
        code: 'TTS_MALFORMED_RESPONSE',
        message: 'the TTS stream carried an event that is not JSON',
      },
    };
  }

  // An error can arrive INSIDE a 2xx stream (the service already committed the response).
  const eventCode = stringField(event, 'code') ?? nestedErrorCode(event);
  if (eventCode !== null) {
    const message =
      stringField(event, 'message') ?? nestedErrorMessage(event) ?? 'the TTS service reported an error';
    return {
      kind: 'failure',
      failure: {
        ok: false,
        code: 'TTS_UPSTREAM_ERROR',
        message: boundedMessage(message),
        upstreamCode: eventCode,
      },
    };
  }

  let characters: number | null = null;
  const usage = event.usage;
  if (typeof usage === 'object' && usage !== null) {
    const billed = (usage as Record<string, unknown>).characters;
    if (typeof billed === 'number' && Number.isFinite(billed) && billed >= 0) characters = billed;
  }

  const output = event.output;
  if (typeof output !== 'object' || output === null) return { kind: 'none', characters };
  const outputRecord = output as Record<string, unknown>;

  const audio = outputRecord.audio;
  if (typeof audio !== 'object' || audio === null) return { kind: 'none', characters };
  const audioData = stringField(audio as Record<string, unknown>, 'data');
  if (audioData === null || audioData.trim() === '') return { kind: 'none', characters };

  const decoded = decodeAudioChunk(audioData);
  if (decoded === null) {
    return {
      kind: 'failure',
      failure: {
        ok: false,
        code: 'TTS_MALFORMED_RESPONSE',
        message: 'the TTS stream carried audio data that is not base64',
      },
    };
  }
  if (decoded.length === 0) return { kind: 'none', characters };
  return { kind: 'audio', bytes: decoded, characters };
}

// ── the streaming half: a RIFF/WAVE header recognised while the SSE stream is still open ─────────

/**
 * A streamed WAV's header fields, read once the `data` chunk header is complete.
 *
 * `headerEnd` is the first PCM byte (the `data` chunk's body start). Everything before it is the
 * header frame the page hands back to the browser's decoder; everything after is PCM it can schedule
 * without waiting for the stream to close.
 */
type VoiceRealtimeTtsRiffHeader = {
  headerEnd: number;
  /** `fmt ` byte rate, or `null` when the stream never delivered a readable `fmt ` chunk. */
  byteRate: number | null;
};

/** The result of walking the bytes accumulated for a WAV header so far. */
type VoiceRealtimeTtsRiffScan =
  | { state: 'incomplete' }
  | { state: 'invalid' }
  | ({ state: 'done' } & VoiceRealtimeTtsRiffHeader);

/**
 * The largest header this leaf will buffer before calling the stream malformed.
 *
 * A legitimate RIFF header is tens of bytes; the cap bounds a stream whose declared chunk size is
 * absurd, so a malformed answer cannot grow the relay's memory until the timeout fires.
 */
const MAX_VOICE_REALTIME_TTS_HEADER_BYTES = 64 * 1024;

/** Reads one little-endian unsigned 16-bit integer, or `null` when the bytes are short. */
function readUint16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/**
 * Walks as much of a RIFF/WAVE header as `bytes` contains.
 *
 * The walk is incremental because the SSE stream splits the WAV at arbitrary boundaries: the first
 * event's audio can end in the middle of the `fmt ` chunk. `incomplete` means "feed me more bytes";
 * `done` means the `data` chunk's body starts at `headerEnd` and every byte from there on is PCM.
 * A streamed WAV may declare `0xFFFFFFFF` as its data size — the honest bound is the bytes that
 * actually arrive, which is why the data size is never used to decide when the header is complete.
 */
function scanVoiceRealtimeTtsRiffHeader(bytes: Uint8Array): VoiceRealtimeTtsRiffScan {
  if (bytes.length >= 4 && chunkId(bytes, 0) !== 'RIFF') return { state: 'invalid' };
  if (bytes.length < 12) return { state: 'incomplete' };
  if (chunkId(bytes, 8) !== 'WAVE') return { state: 'invalid' };

  let byteRate: number | null = null;
  let offset = 12;
  for (;;) {
    if (offset + 8 > bytes.length) {
      return bytes.length > MAX_VOICE_REALTIME_TTS_HEADER_BYTES ? { state: 'invalid' } : { state: 'incomplete' };
    }
    const id = chunkId(bytes, offset);
    const size = readUint32LE(bytes, offset + 4);
    if (id === null || size === null) return { state: 'invalid' };
    // The `data` chunk's size may be a placeholder; its body starts right after this header.
    if (id === 'data') return { state: 'done', headerEnd: offset + 8, byteRate };

    const bodyStart = offset + 8;
    const advance = 8 + size + (size % 2);
    if (bodyStart + size > bytes.length) {
      return bytes.length > MAX_VOICE_REALTIME_TTS_HEADER_BYTES ? { state: 'invalid' } : { state: 'incomplete' };
    }
    if (id === 'fmt ' && size >= 16) {
      byteRate = readUint32LE(bytes, bodyStart + 8);
    }
    if (advance <= 8) return { state: 'invalid' }; // a size that cannot advance would never terminate
    offset += advance;
  }
}

/** Concatenates two byte slices, leaving both inputs untouched. */
function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) return tail;
  if (tail.length === 0) return head;
  const merged = new Uint8Array(head.length + tail.length);
  merged.set(head, 0);
  merged.set(tail, head.length);
  return merged;
}

/**
 * The request body the documented multimodal-generation API expects for `qwen3-tts-flash`.
 *
 * `input` carries only `text` and `voice`; `format` and `sample_rate` are NOT parameters on this
 * endpoint (the service returns a 24 kHz WAV). The criterion reads the captured body so a client
 * that resurrected the old CosyVoice fields is red.
 */
function requestBody(text: string, model: string, voice: string): string {
  return JSON.stringify({
    model,
    input: { text, voice },
  });
}

/**
 * The resolved inputs of one synthesis request, after every pre-request refusal.
 *
 * Shared by both synthesis entry points so "no text", "no credential", "no voice" and "no fetch"
 * are refused identically and before any network call, whichever framing the caller wants.
 */
type VoiceRealtimeTtsPreflight = {
  text: string;
  fetchImpl: VoiceRealtimeTtsFetch;
  model: string;
  baseUrl: string;
  format: VoiceRealtimeTtsFormat;
  sampleRate: number;
  timeoutMs: number;
};

/** Resolves the request inputs, or names the configuration that cannot produce one. */
function resolveVoiceRealtimeTtsPreflight(
  text: string,
  options: VoiceRealtimeTtsOptions,
): { ok: true; request: VoiceRealtimeTtsPreflight } | { ok: false; failure: Extract<VoiceRealtimeTtsSynthesis, { ok: false }> } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, failure: { ok: false, code: 'TTS_EMPTY_TEXT', message: 'there is no text to speak' } };
  }
  if (options.apiKey.trim() === '') {
    return { ok: false, failure: configurationFailure('the TTS service needs an API key') };
  }
  if (options.voice.trim() === '') {
    return { ok: false, failure: configurationFailure('the TTS service needs a voice id') };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, failure: configurationFailure('this process has no fetch implementation') };
  }

  return {
    ok: true,
    request: {
      text: trimmed,
      fetchImpl,
      model: options.model ?? DEFAULT_VOICE_REALTIME_TTS_MODEL,
      baseUrl: (options.baseUrl ?? DEFAULT_VOICE_REALTIME_TTS_BASE_URL).replace(/\/+$/, ''),
      format: options.format ?? DEFAULT_VOICE_REALTIME_TTS_FORMAT,
      sampleRate: options.sampleRate ?? DEFAULT_VOICE_REALTIME_TTS_SAMPLE_RATE,
      timeoutMs: options.timeoutMs ?? DEFAULT_VOICE_REALTIME_TTS_TIMEOUT_MS,
    },
  };
}

/** The SSE body of an opened synthesis request, or the named refusal that replaced it. */
type VoiceRealtimeTtsOpenedStream =
  | { ok: true; body: ReadableStream<Uint8Array> }
  | { ok: false; failure: Extract<VoiceRealtimeTtsSynthesis, { ok: false }> };

/**
 * Opens the documented synthesis request and returns its SSE body.
 *
 * The request shape, the credential placement, the SSE opt-in and the transport failures exist
 * here once: both the whole-blob assembler and the streaming framer open the same call, so a change
 * to the wire cannot drift between them.
 */
async function openVoiceRealtimeTtsStream(
  request: VoiceRealtimeTtsPreflight,
  options: VoiceRealtimeTtsOptions,
): Promise<VoiceRealtimeTtsOpenedStream> {
  let response: Response;
  try {
    response = await request.fetchImpl(`${request.baseUrl}${VOICE_REALTIME_TTS_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // THE CREDENTIAL TRAVELS ONLY HERE. It is never placed in a frame, a result or a message.
        Authorization: `Bearer ${options.apiKey}`,
        // Ask for the streamed answer: one request, audio chunks inside it.
        'X-DashScope-SSE': 'enable',
      },
      body: requestBody(request.text, request.model, options.voice),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: 'TTS_TIMEOUT',
          message: `the TTS service did not answer within ${Math.round(request.timeoutMs / 1000)}s`,
        },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'TTS_UNREACHABLE',
        message: boundedMessage(`the TTS service was unreachable: ${message}`),
      },
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, failure: upstreamFailure(response.status, body) };
  }
  if (response.body === null) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'TTS_MALFORMED_RESPONSE',
        message: 'the TTS service answered without a body',
      },
    };
  }
  return { ok: true, body: response.body };
}

/** The named failure owed a stream that stopped before its last event. */
function streamFailure(error: unknown, timeoutMs: number): Extract<VoiceRealtimeTtsSynthesis, { ok: false }> {
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
  const preflight = resolveVoiceRealtimeTtsPreflight(text, options);
  if (!preflight.ok) return preflight.failure;
  const request = preflight.request;

  const opened = await openVoiceRealtimeTtsStream(request, options);
  if (!opened.ok) return opened.failure;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let characters: number | null = null;

  try {
    for await (const data of sseDataLines(opened.body)) {
      const reading = readSynthesisEvent(data);
      if (reading.kind === 'failure') return reading.failure;
      if (reading.characters !== null) characters = reading.characters;
      if (reading.kind === 'audio') {
        chunks.push(reading.bytes);
        totalBytes += reading.bytes.length;
      }
    }
  } catch (error) {
    return streamFailure(error, request.timeoutMs);
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
    format: request.format,
    sampleRate: request.sampleRate,
    durationMs: request.format === 'wav' ? wavDurationMs(bytes) : null,
    characters: characters ?? request.text.length,
  };
}

/**
 * Emits exactly one `tts_error` frame for a named failure.
 *
 * EVERY refusal goes through here, so "a failure is one error frame and no `tts_done`" is a single
 * implementation rather than a rule each caller re-states. A downlink that rejects the error frame
 * is reported as `TTS_DELIVERY_FAILED` instead of escaping.
 */
function deliverVoiceRealtimeTtsFailure(
  input: VoiceRealtimeTtsInput,
  failure: Extract<VoiceRealtimeTtsSynthesis, { ok: false }>,
  downlink: VoiceRealtimeTtsDownlink,
): VoiceRealtimeTtsResult {
  try {
    downlink({
      type: 'tts_error',
      utteranceId: input.utteranceId,
      code: failure.code,
      message: failure.message,
      ...(failure.upstreamCode === undefined ? {} : { upstreamCode: failure.upstreamCode }),
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    });
  } catch {
    return {
      ok: false,
      code: 'TTS_DELIVERY_FAILED',
      message: 'the downlink rejected the error frame',
    };
  }
  return failure;
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
 * Consumed by the AC-405 criterion; the shipped narrator path uses
 * {@link streamVoiceRealtimeSpeech} so the first frame does not wait for the last byte.
 */
export async function speakVoiceRealtimeText(
  input: VoiceRealtimeTtsInput,
  options: VoiceRealtimeTtsOptions,
  downlink: VoiceRealtimeTtsDownlink,
): Promise<VoiceRealtimeTtsResult> {
  const synthesis = await synthesizeVoiceRealtimeSpeech(input.text, options);
  if (!synthesis.ok) return deliverVoiceRealtimeTtsFailure(input, synthesis, downlink);

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

/** A downlink rejection, distinguished from an upstream/stream failure inside the streaming loop. */
class VoiceRealtimeTtsDownlinkError extends Error {}

/**
 * Synthesizes one text and streams its audio to the browser WHILE the SSE answer is still open.
 *
 * WHY THIS EXISTS. {@link speakVoiceRealtimeText} awaits the complete WAV before it slices a single
 * frame, so a nine-character announcement pays a full synthesis round trip before the page hears
 * anything (measured 1.2–3.5 s of synthesis on the 2026-10-19 live capture). This function reads the
 * SSE events as they arrive, recognises the RIFF/WAVE header incrementally, and emits:
 *
 *   · `seq: 0` — the header bytes, the moment the `data` chunk header is complete;
 *   · `seq: 1..n` — PCM slices of at most `frameBytes`, as events carrying PCM arrive;
 *   · `tts_done` — last, when the stream closes.
 *
 * The frame type and the reassembly contract are unchanged: a page that joins every `tts_audio`
 * frame still holds exactly the WAV the service produced. That is what keeps an old page working
 * against this producer, and what the criterion reads back byte-for-byte.
 *
 * NON-WAV CONTAINERS keep the whole-blob path: this function frames RIFF/WAVE only, and a caller
 * that asked for another format is answered by {@link speakVoiceRealtimeText} unchanged.
 *
 * FAILURE SEMANTICS ARE THE SAME AS THE WHOLE-BLOB PATH: exactly one `tts_error` and no `tts_done`.
 * A failure after audio has already been sent still terminates with that one error frame, which the
 * page treats as "stop and ack" — a partial utterance is never presented as a complete one.
 */
export async function streamVoiceRealtimeSpeech(
  input: VoiceRealtimeTtsInput,
  options: VoiceRealtimeTtsOptions,
  downlink: VoiceRealtimeTtsDownlink,
): Promise<VoiceRealtimeTtsResult> {
  const preflight = resolveVoiceRealtimeTtsPreflight(input.text, options);
  if (!preflight.ok) return deliverVoiceRealtimeTtsFailure(input, preflight.failure, downlink);
  const request = preflight.request;

  // The incremental framer speaks RIFF/WAVE. Any other container keeps the whole-blob contract.
  if (request.format !== 'wav') return speakVoiceRealtimeText(input, options, downlink);

  const opened = await openVoiceRealtimeTtsStream(request, options);
  if (!opened.ok) return deliverVoiceRealtimeTtsFailure(input, opened.failure, downlink);

  const frameBytes = Math.max(1, Math.floor(options.frameBytes ?? DEFAULT_VOICE_REALTIME_TTS_FRAME_BYTES));
  let characters: number | null = null;
  // Held in one-element arrays rather than `let … | null` variables: the assignments happen inside
  // the closures below, and the compiler's flow analysis cannot see through them (it would narrow a
  // plain `let` to `null` and read the post-loop checks as unreachable).
  const headers: VoiceRealtimeTtsRiffHeader[] = [];
  const failures: Array<Extract<VoiceRealtimeTtsSynthesis, { ok: false }>> = [];
  let headerBuffer: Uint8Array = new Uint8Array(0);
  let pendingPcm: Uint8Array = new Uint8Array(0);
  let seq = 0;
  let headerBytes = 0;
  let pcmBytes = 0;

  const emitAudio = (slice: Uint8Array): void => {
    try {
      downlink({
        type: 'tts_audio',
        utteranceId: input.utteranceId,
        seq,
        audio: Buffer.from(slice).toString('base64'),
        format: request.format,
        sampleRate: request.sampleRate,
      });
    } catch {
      throw new VoiceRealtimeTtsDownlinkError('the downlink rejected an audio frame');
    }
    seq += 1;
  };

  const flushPcm = (final: boolean): void => {
    for (;;) {
      if (pendingPcm.length === 0) return;
      if (!final && pendingPcm.length < frameBytes) return;
      const take = Math.min(frameBytes, pendingPcm.length);
      emitAudio(pendingPcm.subarray(0, take));
      pendingPcm = pendingPcm.subarray(take);
      pcmBytes += take;
    }
  };

  const feed = (bytes: Uint8Array): void => {
    if (headers.length > 0) {
      pendingPcm = concatBytes(pendingPcm, bytes);
      flushPcm(false);
      return;
    }
    headerBuffer = concatBytes(headerBuffer, bytes);
    const scan = scanVoiceRealtimeTtsRiffHeader(headerBuffer);
    if (scan.state === 'invalid') {
      failures.push({
        ok: false,
        code: 'TTS_MALFORMED_RESPONSE',
        message: 'the TTS stream did not carry a readable RIFF/WAVE header',
      });
      return;
    }
    if (scan.state === 'incomplete') return;
    headers.push({ headerEnd: scan.headerEnd, byteRate: scan.byteRate });
    headerBytes = scan.headerEnd;
    emitAudio(headerBuffer.subarray(0, scan.headerEnd));
    pendingPcm = concatBytes(pendingPcm, headerBuffer.subarray(scan.headerEnd));
    headerBuffer = new Uint8Array(0);
    flushPcm(false);
  };

  try {
    for await (const data of sseDataLines(opened.body)) {
      const reading = readSynthesisEvent(data);
      if (reading.kind === 'failure') {
        failures.push(reading.failure);
        break;
      }
      if (reading.characters !== null) characters = reading.characters;
      if (reading.kind === 'audio') {
        feed(reading.bytes);
        if (failures.length > 0) break;
      }
    }
  } catch (error) {
    if (error instanceof VoiceRealtimeTtsDownlinkError) {
      return { ok: false, code: 'TTS_DELIVERY_FAILED', message: 'the downlink rejected an audio frame' };
    }
    failures.push(streamFailure(error, request.timeoutMs));
  }

  if (failures.length > 0) return deliverVoiceRealtimeTtsFailure(input, failures[0]!, downlink);

  if (headers.length === 0) {
    // No readable header at all: an empty stream never produced audio; anything else is malformed.
    const code = headerBuffer.length === 0 ? 'TTS_EMPTY_AUDIO' : 'TTS_MALFORMED_RESPONSE';
    const message =
      headerBuffer.length === 0
        ? 'the TTS service completed the request without producing any audio'
        : 'the TTS stream did not carry a readable RIFF/WAVE header';
    return deliverVoiceRealtimeTtsFailure(input, { ok: false, code, message }, downlink);
  }
  const header = headers[0]!;

  try {
    flushPcm(true);
  } catch {
    return { ok: false, code: 'TTS_DELIVERY_FAILED', message: 'the downlink rejected an audio frame' };
  }

  const bytes = headerBytes + pcmBytes;
  const durationMs =
    header.byteRate !== null && header.byteRate > 0 ? (pcmBytes / header.byteRate) * 1000 : null;
  const reportedCharacters = characters ?? request.text.length;

  try {
    downlink({
      type: 'tts_done',
      utteranceId: input.utteranceId,
      frames: seq,
      bytes,
      durationMs,
      characters: reportedCharacters,
    });
  } catch {
    return { ok: false, code: 'TTS_DELIVERY_FAILED', message: 'the downlink rejected an audio frame' };
  }

  return { ok: true, frames: seq, bytes, durationMs, characters: reportedCharacters };
}
