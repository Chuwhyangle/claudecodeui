/**
 * The transcription wire protocol, in exactly one place.
 *
 * Three consumers reach this file and no consumer re-derives any of it:
 *
 *   · the browser's direct path (`src/shared/api/index.ts` builds the request, the chat hook
 *     reads the answer back),
 *   · the server's proxy path (`server/modules/voice/voice.service.ts`),
 *   · the command line (`experiments/voice-asr-cli/transcribe.ts`).
 *
 * Before this module existed the request construction and the response parsing were each
 * written twice, once per path, and the two copies had already drifted: the same upstream
 * answer that the direct path reports as an error is accepted as a transcript by the proxy
 * path. The divergence is not incidental, it is what two copies do — so the tolerance is
 * now an explicit argument (`TranscriptionTolerance`) that each path names at its call
 * site, rather than a property of whichever file you happen to be reading.
 *
 * ENVIRONMENT NEUTRALITY IS A MACHINE PROPERTY HERE, not a style choice. This file is
 * compiled by BOTH compiler configurations — the root one (lib ES2020 + DOM, types
 * `vite/client`, moduleResolution Bundler) and `server/tsconfig.json` (lib ES2022,
 * NodeNext, types `node`) — so it may use neither Node built-ins nor ES2021+ library
 * features, and every environment dependency (fetch, credentials, base URL) stays injected
 * at the call site. `npm run typecheck` compiling this one file under both configurations
 * is the reading that says so.
 */

import type { AsrHints, AsrRequest } from './asrContract.js';

/** The path every OpenAI-compatible transcription endpoint answers on. */
export const TRANSCRIPTION_PATH = '/audio/transcriptions';

/**
 * How much an upstream answer is allowed to be malformed before it is an error.
 *
 * `strict` is the direct path's historical behaviour: a body that is not JSON throws, and
 * the caller reports a failed transcription. `lenient` is the proxy path's: a body that is
 * not JSON is handed back verbatim as if it were a transcript. Both are kept because
 * collapsing them would change what one of the two paths does with a gateway error page.
 */
export type TranscriptionTolerance = 'strict' | 'lenient';

/** Where the request goes and who it authenticates as. */
export type TranscriptionTarget = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/**
 * The audio half of the request. Callers hand over a `Blob` so the bytes and their declared
 * container travel together: the browser passes the recorded (or trimmed) blob straight
 * through, and Node builds one around the bytes it already has.
 */
export type TranscriptionUpload = {
  audio: Blob;
  fileName: string;
};

/** A method-agnostic description of the one request this protocol defines. */
export type TranscriptionRequest = {
  url: string;
  init: RequestInit;
};

function authorizationHeader(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Joins the configured base URL with the transcription path.
 *
 * A base URL typed with a trailing slash is a base URL, not a different endpoint, so the
 * slash is dropped before the join rather than doubled into the path. Both paths reach the
 * endpoint through this function: the server's own composition root already trims the
 * variable it reads, so this is the same string it built before, and the browser's settings
 * no longer decide whether the endpoint is reachable.
 */
export function transcriptionEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${TRANSCRIPTION_PATH}`;
}

/** Builds the multipart POST an OpenAI-compatible transcription endpoint expects. */
export function createTranscriptionRequest(
  target: TranscriptionTarget,
  upload: TranscriptionUpload,
): TranscriptionRequest {
  const body = new FormData();
  body.append('file', upload.audio, upload.fileName);
  body.append('model', target.model);

  return {
    url: transcriptionEndpoint(target.baseUrl),
    init: {
      method: 'POST',
      headers: authorizationHeader(target.apiKey),
      body,
    },
  };
}

/**
 * One token of a recogniser's answer: the piece of text, and the per-token facts a token-aware
 * recogniser can attach. This is the WIRE's spelling of `AsrToken` in `asrRegistry.ts`, kept local
 * because this file is compiled by both compiler configurations and deliberately imports nothing.
 * Every field but `text` is optional: whether a recogniser produces it is its own declaration.
 */
export type TranscriptionToken = {
  text: string;
  confidence?: number;
  startMs?: number;
};

/**
 * The successful-transcription envelope as it travels — richer than the `text` every caller before
 * this one read.
 *
 * `tokens` and `meta.buildId` are carried through VERBATIM when the answer has them. Whether a
 * recogniser produces per-token facts is its `AsrCapabilities.tokens` declaration rather than this
 * wire's guess, so the wire retains and never invents: an answer without them yields an envelope
 * with no such keys at all, which is what makes the historical answer's parse byte-identical to the
 * one it got before these fields existed.
 */
export type TranscriptionEnvelope = {
  text: string;
  tokens?: TranscriptionToken[];
  meta?: { buildId?: string };
};

/**
 * Builds the envelope from a decoded body WITHOUT inventing keys: a body that carries no `tokens`
 * and no `meta.buildId` yields `{ text }` and nothing else.
 */
function envelopeOf(text: string, decoded: unknown): TranscriptionEnvelope {
  const envelope: TranscriptionEnvelope = { text };
  if (typeof decoded !== 'object' || decoded === null) return envelope;
  const record = decoded as Record<string, unknown>;
  if (Array.isArray(record.tokens)) envelope.tokens = record.tokens as TranscriptionToken[];
  const meta = record.meta;
  if (typeof meta === 'object' && meta !== null) {
    const buildId = (meta as Record<string, unknown>).buildId;
    if (typeof buildId === 'string') envelope.meta = { buildId };
  }
  return envelope;
}

/**
 * Reads the WHOLE envelope out of a transcription response, under the named tolerance.
 *
 * This is the one implementation of the read; `parseTranscriptionResponse` is the text view of the
 * same result, so the two cannot drift. The two branches are the two historical implementations,
 * kept apart on purpose and selected by an argument rather than by which file the call is in.
 * `strict` propagates the parse failure (the caller's `catch` turns it into a failed
 * transcription); `lenient` treats an unparseable body as the transcript itself.
 *
 * This takes the `Response` and not a body already read out of it, because the two branches do not
 * read a body the same way: the direct path has always gone through `json()` and the proxy path
 * through `text()`. Handing over the response keeps each of them on the exact call it made before
 * — a shared `text()` (or a shared `json()`) would have been this refactor changing one of the two
 * paths rather than merging them. `strict` consumes the response as JSON, `lenient` as text, and
 * neither is read twice; each caller reads the body for its own error path before calling this.
 */
export async function readTranscriptionEnvelope(
  response: Response,
  tolerance: TranscriptionTolerance,
): Promise<TranscriptionEnvelope> {
  if (tolerance === 'lenient') {
    const responseText = await response.text();
    try {
      // The historical read, VERBATIM INCLUDING ITS THROW. The cast is what let the old body
      // access `.text` on whatever `JSON.parse` returned; a `null` body did not answer `''`, it
      // threw on the property access and the `catch` below handed the raw text back — which is
      // what makes the literal `null` a transcript on this path (`json-null` in the AC4 baseline).
      // A `parsed === null` guard here would be a one-character change that silently re-answers a
      // recorded reading, so the access is left exactly as it was and the envelope is built around
      // its result.
      const parsed = JSON.parse(responseText) as { text?: unknown };
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      return envelopeOf(text, parsed);
    } catch {
      return { text: responseText };
    }
  }

  // Cast rather than annotated: this file is compiled by both configurations, and the DOM lib
  // types `json()` as `any` while `@types/node` types it as `unknown`. The assertion is the one
  // the direct path's inline expression always relied on, now written where both compilers see it.
  const data = (await response.json()) as unknown;
  const text =
    typeof data === 'object' && data !== null
      ? String((data as { text?: unknown }).text || '')
      : '';
  return envelopeOf(text, data);
}

/**
 * Reads the transcript out of a transcription response, under the named tolerance.
 *
 * THE TEXT VIEW, UNCHANGED. Called with two arguments this returns exactly the string it always
 * returned — the envelope's `text` — which is what every existing caller (the browser's direct
 * path, the proxy path, the command line) continues to receive. Called with the literal
 * `'envelope'` as a third argument it returns the WHOLE envelope instead, so a caller that wants
 * the per-token facts or the build identity does not have to parse the body a second time and
 * cannot drift from the text view. The extra argument is a shape selector rather than a second
 * function so the two readings are one implementation by construction.
 */
export function parseTranscriptionResponse(
  response: Response,
  tolerance: TranscriptionTolerance,
): Promise<string>;
export function parseTranscriptionResponse(
  response: Response,
  tolerance: TranscriptionTolerance,
  shape: 'envelope',
): Promise<TranscriptionEnvelope>;
export async function parseTranscriptionResponse(
  response: Response,
  tolerance: TranscriptionTolerance,
  shape?: 'envelope',
): Promise<string | TranscriptionEnvelope> {
  const envelope = await readTranscriptionEnvelope(response, tolerance);
  return shape === 'envelope' ? envelope : envelope.text;
}

/**
 * Runs one transport call, retrying a PURE transport failure once.
 *
 * WHY THIS IS BESIDE THE WIRE AND NOT IN `asrContract.ts`: the contract leaf is at the repository's
 * 800-line ceiling, and this file is already the place every network adapter meets the wire. The
 * retry is the same fact about the seam in all four of them — an upstream that never answered is
 * not a refusal, so one reset connection must not cost a whole dictation — and writing it once here
 * is what keeps the four copies from drifting into four different retry policies.
 *
 * WHAT IS NOT RETRIED, and why the distinction is the whole point:
 *
 *   · an AbortError, or a call whose `init.signal` is already aborted — the deadline is the caller's
 *     budget (300 s at the service), and retrying would double it into 600 s;
 *   · any answer the transport DID deliver, including 401/403/429/5xx — a status is the upstream's
 *     verdict, and only the caller's classifier may decide what it means.
 *
 * So only a rejected promise with no answer behind it is retried, and only once by default. When
 * every attempt fails the LAST error is thrown, which is the one the adapter's `catch` was already
 * converting into `UPSTREAM_UNAVAILABLE`; the adapter's own readings are unchanged.
 */
export async function fetchWithTransportRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  retries = 1,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted) throw error;
      if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') {
        throw error;
      }
    }
  }
  throw lastError;
}

// ── the byte arithmetic the wire's budget guard and its encoder both read ────────────────────
//
// THESE LIVE BESIDE THE WIRE PROTOCOL, NOT IN THE CONTRACT LEAF. They are wire arithmetic — what
// a payload costs on the wire and what its encoding is — so this module is their subject. The
// contract leaf is also at the repository's 800-line oversize ceiling, and the contract is a
// vocabulary rather than a codec; putting the arithmetic back there would red the ratchet for a
// helper that has nothing to say about the contract. The only dependency is the two request types,
// taken as `import type` so neither module value-imports the other.

/**
 * The exact length a base64 encoding of `byteLength` bytes has, without encoding anything.
 *
 * THERE IS ONE COPY OF THIS ARITHMETIC. The budget guard and the encoder that actually puts the
 * audio on the wire have to agree on what the payload costs. Before the extraction the same
 * two-line formula existed byte-identically in the two JSON-audio adapters (archguard scope
 * `shared`, groups 3c3a920a4032ca45 and c84e98d9d48fd1af), so a change to one copy — or to
 * `base64Encode` without it — could leave a guard measuring a different encoding than the one it
 * was guarding.
 *
 * Both compiler configurations compile this file (see the module comment), so this is written with
 * ES5 syntax and no Node built-in.
 */
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/**
 * The UTF-8 length of `value`, counted directly so no encoder global is needed on either side.
 *
 * The budget subject is measured in the bytes a wire would carry, not in characters: a Chinese
 * context is three bytes per character, and a guard that counted characters would pass a request
 * the service rejects. Written out rather than reached for (`TextEncoder`) because this file is
 * compiled by both compiler configurations and the count must be the same on each.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 of `bytes`. Written out rather than reached for, for the neutrality reason above. */
export function base64Encode(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    encoded += BASE64_ALPHABET[first >> 2];
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    encoded += index + 1 < bytes.length ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
    encoded += index + 2 < bytes.length ? BASE64_ALPHABET[third & 0x3f] : '=';
  }
  return encoded;
}

/**
 * The budget subject: the audio bytes plus every hint the declaration acknowledges, measured as
 * the bytes the wire would carry them as.
 *
 * THERE IS ONE COPY OF THIS ARITHMETIC. The three adapters whose caller-controlled bytes are the
 * audio and the honoured hints carried byte-identical bodies (archguard scope `shared`, group
 * d2b08b77e331b8e4), so a change to the rule could be made in one and silently missed in another,
 * leaving that provider's guard sized differently from the request it guards.
 *
 * `Blob.size` is the byte length of a string part, which is why the hints are measured by encoding
 * them the way the wire would rather than by counting characters: a Chinese context is three bytes
 * per character, and a guard that counted characters would pass a request the service rejects.
 *
 * What this deliberately does not model is the constant transport envelope — the multipart
 * boundaries, the field names, the model, the endpoint — for the reason the JSON-audio adapters'
 * own measures give: it is fixed per call and carries no caller-controlled bytes.
 */
export function measureRequestBytes(request: AsrRequest, honored: AsrHints): number {
  let bytes = request.audio.bytes.length;
  if (honored.prompt !== undefined) bytes += new Blob([honored.prompt]).size;
  if (honored.language !== undefined) bytes += new Blob([honored.language]).size;
  if (honored.context !== undefined) bytes += new Blob([honored.context]).size;
  return bytes;
}
