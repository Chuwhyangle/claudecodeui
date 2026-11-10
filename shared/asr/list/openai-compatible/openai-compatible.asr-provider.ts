/**
 * The FIRST recogniser adapter: the shipped OpenAI-compatible transcription service, multipart.
 *
 * WHY THIS MODULE EXISTS AT ALL. The shipped path has spoken to this service since before the seam
 * did — `shared/asr/transcriptionWire.ts` is its wire, and the browser's direct path, the server's
 * proxy path and the command line all go through it. What was missing was the ADDRESS: no adapter
 * was registered under this service's id, so nothing in the registry could answer for the
 * recogniser every recording actually reaches. The first symptom was the trim, which asks the
 * registry 裁不裁 and got no declaration at all (ADR-004 decision 1); the shape is general — a
 * provider the app uses but the address book does not list answers no question about itself.
 *
 * IT IS THE SHIPPED WIRE, NOT A SECOND IMPLEMENTATION OF IT. `transcribe` composes the two halves
 * of `../../contract/transcriptionWire.js` (`createTranscriptionRequest`, `parseTranscriptionResponse`) and
 * nothing else: the request construction and the answer parsing stay in the one module that
 * already owned them, so registering this adapter cannot make the app send something different
 * from what it sent yesterday. The guards below (container, budget) run BEFORE the wire is
 * touched, which is the discipline the second adapter shares and the invariant board measures.
 *
 * ENVIRONMENT NEUTRALITY, the same machine property `../../asrContract.ts` documents: this file is
 * compiled by BOTH compiler configurations (root: `lib: ES2020 + DOM`, `types: vite/client`;
 * server: `lib: ES2022`, NodeNext, `types: node`), so it uses no Node built-in and no ES2021+
 * library feature, and every environment dependency (base URL, credential, model, transport,
 * signal) arrives through `AsrInvocation`.
 */

import { measureRequestBytes } from '../../contract/transcriptionWire.js';
import {
  classifyUpstreamFailure,
  declaredAcceptsMime,
  honoredHints,
  type AsrAdapter,
  type AsrCapabilities,
  type AsrInvocation,
  type AsrRequest,
  type AsrResult,
} from '../../contract/asrContract.js';
import {
  createTranscriptionRequest,
  fetchWithTransportRetry,
  parseTranscriptionResponse,
} from '../../contract/transcriptionWire.js';

/** The id this provider is registered under — the id the shipped path has always been spoken of by. */
export const id: string = 'openai-compatible';

/**
 * This provider's capability declaration, every field read off what the shipped path does today.
 *
 *   · `acceptsMime` is the set of containers the seam already serves: the recorder's own
 *     `audio/webm;codecs=opus` (matched on the base type) and the files the pickers offer. A
 *     shorter list would refuse an upload the app accepts today; a longer one would admit a
 *     container the shipped path has never been handed.
 *   · `maxInlineRequestBytes` is this service's own published ceiling for one request, and it is
 *     the figure the transport layer was reading before the budget became a declaration (ADR-004
 *     §缺口②: the 25 MB global bound). It is a REQUEST maximum: the whole upload, not a share of it.
 *   · `honors` IS ALL FALSE, and that is a reading of the wire rather than a view about the
 *     service: `createTranscriptionRequest` puts the file and the model on the request and nothing
 *     else, so a hint this module declared it honored would be a hint no code knows how to send —
 *     and ADR-004 §二's paired measurement is the reason not to add one (a prompt collapses Chinese
 *     punctuation on the trimmed path, and the product carries no language to switch on).
 *   · `billing: 'audio-seconds'` and `style: 'verbatim'`: a saved second is a saved second here
 *     (this service bills by audio, with a per-request floor), and the answer comes back as spoken.
 *   · `pauseCues: 'destructive'` — the shipped default the trim was taken under: trimming hits this
 *     recogniser's Chinese punctuation (−89%, `docs/experiments/2026-09-22-voice-punctuation.md`),
 *     so its silence is removed before the audio is uploaded.
 */
export const capabilities: AsrCapabilities = {
  acceptsMime: [
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/aac',
    'audio/ogg',
    'audio/flac',
    'audio/webm',
  ],
  maxInlineRequestBytes: 25 * 1024 * 1024,
  oversize: 'reject',
  honors: { prompt: false, language: false, context: false },
  billing: 'audio-seconds',
  pauseCues: 'destructive',
  style: 'verbatim',
  oneShot: true,
  // 'direct' — the shipped path's own reading, and the reason this field is a declaration rather
  // than a special case: the browser has always addressed this service itself when the user set a
  // base URL, and every deployment that does so must keep doing it. The server's own rule for a
  // user-supplied address (`validateBackendBaseUrl`) is the only one that applies here — http and
  // private backends are deliberately legal — so no `allowedBaseUrl` is declared.
  transport: 'direct',
  // The sentence-level reading, declared rather than assumed: this wire returns one transcript for
  // the request and no per-word facts, so a token-aware caller is told not to look for any. The
  // invariant board reds this declaration if a success result ever carries one anyway.
  tokens: { confidence: false, timestamps: false },
  // 'remote': the audio leaves the device for this service's own endpoint. Transport answers which
  // network path reaches it; this answers whether it leaves at all.
  locality: 'remote',
};

// ── the audio part ──────────────────────────────────────────────────────────────────────────

/**
 * The audio as the `File` part the multipart body carries.
 *
 * THE COPY IS THE POINT, not a workaround. `bytes` may be a view into a larger buffer — the trim
 * path hands over slices of the recording it decoded — and a `Blob` built from the view's own
 * `.buffer` would carry the neighbours of that slice as well as the slice. Reading exactly
 * `byteLength` bytes into a fresh buffer makes the part carry the audio and nothing else. It is
 * also what the two compiler configurations agree on: the root configuration types a `BlobPart` as
 * an `ArrayBufferView<ArrayBuffer>` while `AsrAudio.bytes` is a `Uint8Array<ArrayBufferLike>`, so
 * the plain `ArrayBuffer` is the portable form of the same bytes.
 */
export function filePart(bytes: Uint8Array, mimeType: string): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: mimeType });
}

// ── the response ─────────────────────────────────────────────────────────────────────────────

/**
 * The semantic code this answer means, read by the ONE classifier in the registry.
 *
 * WHY THERE IS NO LOCAL STATUS TABLE HERE ANY MORE. There used to be one — a three-line
 * `errorCodeForStatus(status)` in this file, and a copy of it in each of the other two adapters —
 * and the copies were the defect: a `403` whose body named a model the account has not enabled was
 * filed as a refused credential by all three, because a status-only mapper cannot see the body. The
 * implementation now lives where the vocabulary does (`classifyUpstreamFailure`), so an adapter that
 * wanted a second table would have to write one on purpose.
 */

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** A failure body, read for its evidence and never for its text: an unreadable one is empty. */
async function readTextQuietly(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// ── the adapter ──────────────────────────────────────────────────────────────────────────────

/**
 * Transcribes one multipart request.
 *
 * The two guards run before the transport is touched, in this order: an unaccepted container is
 * refused before anything is sized, and an oversized request is refused before anything is sent.
 * Neither produces an upstream call. The wire itself is built by `transcriptionWire.ts`.
 *
 * THE READING OF THE ANSWER IS THE CALLER'S, not this module's, and that is why it arrives on the
 * invocation. This wire has two callers with two historical readings of the same bytes — the
 * browser's direct path takes a body that is not this service's JSON as a failed transcription,
 * the server's proxy path has always handed it back verbatim as the transcript — and
 * `TranscriptionTolerance` is that difference written down once (`../../transcriptionWire.ts`).
 * The default is `strict`, so a caller that says nothing about tolerance (the direct path, the
 * invariant probes) keeps the reading it had before; the proxy path names `lenient` at its call
 * site instead of this module guessing from who is asking.
 *
 * The empty answer is read by the same tolerance, and it is the second half of that difference
 * rather than a separate rule: `lenient` means "whatever came back is the transcript", and an
 * empty transcript is a successful transcription of silence — the proxy path has always answered
 * `ok` with an empty string there. `strict` keeps calling it `NO_SPEECH_DETECTED`, because the
 * direct path's caller needs the distinction to tell "you said nothing" from "the service failed".
 */
export async function transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult> {
  if (!declaredAcceptsMime(capabilities, request.audio.mimeType)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MIME',
      message:
        `provider '${id}' does not accept ${request.audio.mimeType}; ` +
        `it accepts ${capabilities.acceptsMime.join(', ')}`,
    };
  }

  const requestBytes = measureRequestBytes(request, honoredHints(capabilities, request.hints));
  if (requestBytes > capabilities.maxInlineRequestBytes) {
    return {
      ok: false,
      code: 'OVERSIZE',
      message:
        `request of ${requestBytes} B exceeds provider '${id}' budget of ` +
        `${capabilities.maxInlineRequestBytes} B (the budget covers the whole request, not the audio alone)`,
    };
  }

  const wire = createTranscriptionRequest(
    { baseUrl: invocation.baseUrl, apiKey: invocation.apiKey, model: invocation.model },
    {
      audio: filePart(request.audio.bytes, request.audio.mimeType),
      fileName: request.audio.fileName,
    },
  );
  const signal = invocation.signal ?? AbortSignal.timeout(invocation.timeoutMs);

  let response: Response;
  try {
    response = await fetchWithTransportRetry(invocation.fetchImpl, wire.url, { ...wire.init, signal });
  } catch (error) {
    // A transport that never connected and a request the invocation's deadline (or the caller's own
    // signal) ended are ONE code here and two messages: from this side of the seam they are the same
    // fact about the upstream (`UPSTREAM_UNAVAILABLE`), and the message is what keeps them apart for
    // the reader.
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: isAbortError(error)
        ? `provider '${id}' did not answer within ${invocation.timeoutMs} ms`
        : `provider '${id}' could not be reached`,
    };
  }

  if (!response.ok) {
    // The body decides what the refusal MEANS and the status is the fallback; see
    // `classifyUpstreamFailure`. Reading it here rather than from the status alone is what lets a
    // body naming an unenabled model, an exhausted quota or a rejected key be told apart.
    return {
      ok: false,
      code: classifyUpstreamFailure(response.status, await readTextQuietly(response)),
      message: `provider '${id}' answered ${response.status}`,
      status: response.status,
    };
  }

  const tolerance = invocation.tolerance ?? 'strict';

  let transcript: string;
  try {
    transcript = await parseTranscriptionResponse(response, tolerance);
  } catch {
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: `provider '${id}' answer was not the transcription envelope`,
    };
  }

  if (transcript === '' && tolerance === 'strict') {
    return { ok: false, code: 'NO_SPEECH_DETECTED', message: `provider '${id}' returned no text` };
  }

  return {
    ok: true,
    text: transcript,
    style: 'verbatim',
    transformations: [],
    providerId: id,
    meta: { model: invocation.model },
  };
}

/** This module as the registry consumes it. */
export const adapter: AsrAdapter = { id, capabilities, transcribe };
