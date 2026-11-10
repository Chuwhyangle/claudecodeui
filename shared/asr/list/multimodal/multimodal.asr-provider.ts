/**
 * The SECOND recogniser adapter: a multimodal service, inline only.
 *
 * WHY A SECOND ADAPTER IS THE DELIVERABLE RATHER THAN A NICER FIRST ONE. A capability table with
 * one instance in it is a claim nobody can falsify: every field could be wrong and no reading
 * would move, because there is no second shape to disagree with. This module is that second
 * shape, and the disagreement is the point — it is a whole-request-budget, JSON, verbatim-style,
 * context-honouring recogniser where the first one is an audio-seconds, multipart, verbatim,
 * prompt-shaped one. ADR-004 §S2 places it here; AC-132 is the criterion.
 *
 * THE THREE PROPERTIES THIS ADAPTER CARRIES, each one a place the first adapter cannot disagree:
 *
 *   · THE BUDGET IS THE WHOLE REQUEST. `maxInlineRequestBytes` is a request maximum — the
 *     instruction, the context and the audio share it — so the guard sizes the request that is
 *     about to be sent, not the audio inside it. An audio-only guard passes an audio of 14 MB and
 *     then ships a body the service rejects.
 *   · OVERSIZE IS A DECLARED REJECTION, taken BEFORE anything leaves. `oversize: 'reject'` is the
 *     only value the first version allows (ADR-004 §缺口②.5), and the rejection happens before
 *     `fetchImpl` is reached, so a rejected request costs no upstream call and no money.
 *   · AN UNACKNOWLEDGED HINT IS NOT SENT. This provider declares `honors.prompt: false` — the
 *     measured effect is that prompt biasing is harmful on Chinese audio under the shipped
 *     trimming (ADR-004 §二) — so a prompt is left off the wire entirely rather than forwarded as
 *     an empty value or silently dropped behind the caller's back. `honoredHints` is the single
 *     place that decision is made, and it reads the same declaration the capability table exports.
 *
 * THE WIRE IS THE REAL SERVICE'S, AND THAT IS A CORRECTION RATHER THAN A DESCRIPTION. This adapter
 * was written against a stand-in transport and had never been driven at a real endpoint; the first
 * reading taken against `generativelanguage.googleapis.com` (2026-09-23) disagreed with it in
 * three places, each of them a place the stand-in could not speak:
 *
 *   · AUTHENTICATION IS A HEADER, NOT A SCHEME. An API key travels in `x-goog-api-key`; the
 *     `Authorization: Bearer <key>` this adapter shipped was answered with
 *     `Request had invalid authentication credentials. Expected OAuth 2 access token…`. The bearer
 *     form is the OAuth form, which a bare API key is not.
 *   · THE MODEL NEEDS TO BE TOLD TO TRANSCRIBE. With only `inlineData` on the request the service
 *     answers in whatever format it likes — measured, a subtitle script (`00:00:00.420 -->
 *     00:00:00.800`) with a mean CER of 2.24 on the repository's own eight-clip corpus. The fixed,
 *     adapter-owned instruction below is therefore part of the REQUEST BODY (a text part of
 *     `contents[0]`, counted by the budget), not a caller hint: `honors.prompt: false` keeps
 *     meaning "the caller's prompt is not put on the wire", and never "nothing is asked for".
 *   · THE DECODE ITSELF NEEDS CONFIGURING. `temperature: 0` removes the sampling; the 2.5 series
 *     thinks by default (~700–980 thoughts tokens per call, ~9.7 s mean), so its
 *     `thinkingConfig.thinkingBudget: 0` is applied BY MODEL-NAME PREFIX — a model that does not
 *     take the field is sent no field, because guessing costs a 400.
 *
 * AND THE DECLARATION FOLLOWS THE WIRE, NOT THE OTHER WAY ROUND. The instruction is a verbatim
 * transcription instruction, so this adapter now declares `style: 'verbatim'` with
 * `transformations: ['punctuate']`. It previously declared `style: 'written'` while asking the
 * service for nothing of the kind — a claim about behaviour no request ever requested (measured:
 * written-style instructions on this corpus are worse, CER 0.456 with invented identifiers). The
 * written form is left to a task of its own, after its own paired measurement.
 *
 * ENVIRONMENT NEUTRALITY, the same machine property `../../asrContract.ts` documents: this file is
 * compiled by BOTH compiler configurations (root: `lib: ES2020 + DOM`, `types: vite/client`;
 * server: `lib: ES2022`, NodeNext, `types: node`), so it uses no Node built-in and no ES2021+
 * library feature, and every environment dependency arrives through `AsrInvocation`. That is also
 * what makes the adapter's budget arithmetic — and not merely its shape — testable offline.
 */

import type {
  AsrAdapter,
  AsrCapabilities,
  AsrHints,
  AsrInvocation,
  AsrRequest,
  AsrResult,
} from '../../contract/asrContract.js';
import { classifyUpstreamFailure, honoredHints } from '../../contract/asrContract.js';
import { base64Encode, base64Length, fetchWithTransportRetry, utf8ByteLength } from '../../contract/transcriptionWire.js';

/** The id this provider is registered under. */
export const id: string = 'multimodal';

/**
 * This provider's capability declaration. The values that are NOT the first adapter's are the
 * load-bearing part: `billing: 'request'` (a whole request is the unit, so a saved second is not
 * a saved cent), `pauseCues: 'useful'` (pauses are punctuation cues, which is why this one is not
 * trimmed by default), `style: 'verbatim'` (the instruction below asks for the words as they were
 * spoken — see the module comment for why this is no longer `'written'`), and
 * `honors.prompt: false` (see the module comment).
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
  // The published inline maximum, and it is the WHOLE request: instruction, context and every file.
  maxInlineRequestBytes: 20 * 1024 * 1024,
  oversize: 'reject',
  honors: { prompt: false, language: false, context: true },
  billing: 'request',
  pauseCues: 'useful',
  style: 'verbatim',
  oneShot: true,
  // 'direct'. The real endpoint was driven from a bare script during the 2026-09-23 correction, and
  // nothing in that measurement says a browser cannot reach it; a declaration of 'proxy-only' here
  // would be a claim with no reading behind it, and it would move every existing caller's route.
  transport: 'direct',
  // The inline JSON answer is one transcript for the request, with no per-word confidence or
  // timing, so both token facts are declared absent. The board holds the declaration and the
  // result to the same story rather than trusting this comment.
  tokens: { confidence: false, timestamps: false },
  // 'remote': the audio is sent to the endpoint. A `'local-*'` engine would keep it on the device
  // or on this host; this one does not, and the declaration is where a caller learns that.
  locality: 'remote',
};

/** The transformations a `style: 'verbatim'` recogniser performs on its way to `AsrResult.text`. */
export const STYLE_TRANSFORMATIONS = ['punctuate'] as const;

/**
 * THE ADAPTER'S OWN INSTRUCTION, and the one thing this module asks the service for.
 *
 * It is a TEXT PART OF THE REQUEST rather than a `systemInstruction`, and that is the distinction
 * `honors.prompt: false` rests on: the contract suite identifies the caller's prompt by
 * `systemInstruction`, so an instruction sent as a content part cannot be mistaken for a hint the
 * declaration promised not to forward. It is also produced by `buildInlineRequestBody`, which is
 * what makes `measureInlineRequestBytes` charge it to the request budget instead of discovering it
 * after the request was sized.
 *
 * WHAT IT ASKS FOR, one clause per measured defect: the words as they were spoken (a subtitle
 * script came back when nothing was asked for), the language they were spoken in (the written-style
 * variant invented identifiers), and no timestamps or speaker labels (both are decoration the
 * composer below has no use for).
 */
export const TRANSCRIPTION_INSTRUCTION =
  '请逐字转写这段音频，保持原有语言，只输出转写文本，不要时间戳、说话人标签、翻译或总结。';

/**
 * Whether this model takes the 2.5 series' thinking configuration.
 *
 * The rule is a PREFIX rather than a list, and that is a deliberate refusal to enumerate: the
 * series gains names faster than this file will be edited, and a model that takes `thinkingBudget`
 * is exactly the model whose name starts with the series it belongs to. A model that is not in the
 * series is sent no such field at all — the service answers an unsupported field with a 400, which
 * would turn "configure the decode" into "the request was invalid".
 */
export function thinkingBudgetApplies(model: string): boolean {
  return model.startsWith('gemini-2.5');
}

// ── the request body ─────────────────────────────────────────────────────────────────────────

export type InlineTextPart = { text: string };
export type InlineDataPart = { inlineData: { mimeType: string; data: string } };

/** The decode settings this adapter asks for, spelled as the service's own `generationConfig`. */
export type InlineGenerationConfig = {
  temperature: number;
  thinkingConfig?: { thinkingBudget: number };
};

/** One inline request, as this service's JSON API expects it. */
export type MultimodalRequestBody = {
  contents: { parts: (InlineDataPart | InlineTextPart)[] }[];
  generationConfig: InlineGenerationConfig;
  systemInstruction?: { parts: InlineTextPart[] };
};

/**
 * Joins the configured base URL with the generation endpoint.
 *
 * The model name is part of the PATH here, which is one of the ways this service's wire differs
 * from an OpenAI-compatible one — a second reason the seam has to exist before a second provider
 * can be added at all.
 */
export function generateContentEndpoint(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
}

/** `audio/webm;codecs=opus` and `audio/webm` are the same container (ADR-004 §缺口①.3). */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/** Whether this provider accepts `mimeType`, matched on the base type. */
export function acceptsMime(mimeType: string): boolean {
  return capabilities.acceptsMime.indexOf(baseMimeType(mimeType)) !== -1;
}

/**
 * Builds the request body.
 *
 * `inlineData` is a PARAMETER rather than something this function computes, and that is what makes
 * the budget check below exact without materialising the encoded audio: the same builder produces
 * the skeleton the guard measures and the body that is sent, so the two can never describe
 * different requests. See `measureInlineRequestBytes`.
 *
 * `model` is a parameter for the same reason, one step further out: whether `thinkingBudget` is on
 * the request is a property of the model, so a skeleton built without it would size a different
 * request for every 2.5-series call.
 */
export function buildInlineRequestBody(
  request: AsrRequest,
  hints: AsrHints,
  inlineData: string,
  model: string,
): MultimodalRequestBody {
  const parts: (InlineDataPart | InlineTextPart)[] = [
    { text: TRANSCRIPTION_INSTRUCTION },
    { inlineData: { mimeType: baseMimeType(request.audio.mimeType), data: inlineData } },
  ];
  if (hints.context !== undefined && hints.context !== '') parts.push({ text: hints.context });

  const body: MultimodalRequestBody = {
    contents: [{ parts }],
    generationConfig: thinkingBudgetApplies(model)
      ? { temperature: 0, thinkingConfig: { thinkingBudget: 0 } }
      : { temperature: 0 },
  };
  if (hints.prompt !== undefined && hints.prompt !== '') {
    body.systemInstruction = { parts: [{ text: hints.prompt }] };
  }
  return body;
}

// ── the budget arithmetic ────────────────────────────────────────────────────────────────────

/**
 * The byte length of the request this adapter would send for `request`, `hints` and `model` — the
 * budget subject, and an exact reading rather than an estimate.
 *
 * It is exact because the audio's contribution is not guessed at: the body is serialised once with
 * an EMPTY inline payload and the encoded payload's length is added on. Base64's alphabet contains
 * no character JSON would escape, so replacing `""` with the encoded audio changes the serialised
 * length by exactly `base64Length(bytes)`. The cost is that the audio is never encoded for a
 * request that is about to be rejected — which is the same discipline the guard's position
 * (before `fetchImpl`) enforces on the network side.
 *
 * The subject is the WHOLE request, and since the adapter's own instruction and the decode config
 * are produced by the same builder, they are charged here by construction rather than by a second
 * addition that could be forgotten: a budget that sized the audio alone would pass a request the
 * service rejects (AC-132's `BUDGET_IS_AUDIO_ONLY`).
 *
 * What this deliberately does not model: the constant transport envelope (URL, headers). It is
 * fixed per call and carries no caller-controlled bytes; everything a caller can grow — the audio,
 * the context, the prompt when it is honoured — is inside the number below.
 */
export function measureInlineRequestBytes(request: AsrRequest, hints: AsrHints, model: string): number {
  const skeleton = JSON.stringify(buildInlineRequestBody(request, hints, '', model));
  return utf8ByteLength(skeleton) + base64Length(request.audio.bytes.length);
}

// ── the response ─────────────────────────────────────────────────────────────────────────────

export type MultimodalResponse = {
  candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown };
};

/**
 * Whether the model stopped for a reason that is not "it finished" or "it ran out of room".
 *
 * The list is the service's own vocabulary of REFUSALS, and it is a list rather than "anything that
 * is not STOP" on purpose: `MAX_TOKENS` is a truncated answer, which is still an answer, and a
 * future reason the service adds should read as unmapped rather than as a refusal.
 */
const BLOCKING_FINISH_REASONS = [
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'LANGUAGE',
];

/**
 * The reason the service refused to answer with text, or `null` when nothing refused.
 *
 * A `200` with no text part is ambiguous on this wire — the model may simply have heard nothing, or
 * it may have been stopped — and the two are different outcomes for the caller. `promptFeedback`
 * is read first because it is the service saying so directly; a candidate that exists only to carry
 * a `finishReason` is the indirect form. `SAFETY` arriving here must not be reported as
 * `NO_SPEECH_DETECTED`: the caller's prompt was refused, and telling them nothing was said hides
 * that. Returns `null` on a body that is not JSON, so the caller's own parse failure stays the
 * caller's.
 */
export function readBlockReason(responseText: string): string | null {
  let parsed: MultimodalResponse;
  try {
    parsed = JSON.parse(responseText) as MultimodalResponse;
  } catch {
    return null;
  }
  const blockReason = parsed?.promptFeedback?.blockReason;
  if (typeof blockReason === 'string' && blockReason !== '') return blockReason;
  const finishReason = parsed?.candidates?.[0]?.finishReason;
  if (typeof finishReason === 'string' && BLOCKING_FINISH_REASONS.indexOf(finishReason) !== -1) {
    return finishReason;
  }
  return null;
}

/**
 * Whether a `400` body is the service saying the credential is wrong.
 *
 * WHY THIS IS A BODY READING RATHER THAN A STATUS READING. An invalid API key on this service comes
 * back as `400 INVALID_ARGUMENT`, not `401` — measured 2026-09-23 — so the status-only mapper below
 * files it as a generic upstream fault and the user is told nothing they can act on. The evidence
 * is in the body: the documented `reason` token, or one of the messages the service uses for it.
 * A `400` carrying neither is an ordinary rejected request and keeps the generic code, which is why
 * this is a predicate over the body rather than a rule about the number.
 */
const INVALID_API_KEY_REASONS = ['API_KEY_INVALID', 'API_KEY_EXPIRED', 'API_KEY_SERVICE_BLOCKED'];
const INVALID_API_KEY_MESSAGES = [
  // The 401 phrasing, kept because a wrapped gateway may pass it through with any status.
  'expected oauth 2 access token',
  'api key not valid',
  'api key expired',
  'invalid api key',
  'invalid authentication credentials',
];

export function looksLikeInvalidApiKey(responseText: string): boolean {
  for (const reason of INVALID_API_KEY_REASONS) {
    if (responseText.indexOf(reason) !== -1) return true;
  }
  const lowered = responseText.toLowerCase();
  for (const needle of INVALID_API_KEY_MESSAGES) {
    if (lowered.indexOf(needle) !== -1) return true;
  }
  return false;
}

/**
 * Whether a character is one this adapter joins WITHOUT a separator when it carries a line break.
 *
 * CJK scripts do not delimit words with spaces, so a break between two CJK characters is the
 * model's line wrapping and not a word boundary: `模块下的⏎目录` is one phrase, and putting a space
 * inside it would be an edit the speaker never made. Latin text is the other case — `把默认模型换成⏎
 * whisper` needs the space, or two words fuse.
 */
function isCjkCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // fullwidth forms
  );
}

/**
 * Joins the model's line breaks away, so a pause at the source is not a break in the transcript.
 *
 * MEASURED, and the reason it exists: on the corpus's longer pauses the service answered in lines —
 * `server⏎的⏎voice.se` — which is a transcript a reader has to reassemble by hand. The rule is the
 * one the two scripts need: a break between two CJK characters is joined with nothing, every other
 * break becomes a single space, and the result is trimmed. Segments are trimmed and empty ones
 * dropped first, so a run of blank lines cannot become a run of spaces.
 */
export function mergeTranscriptLines(text: string): string {
  const segments: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const segment = raw.trim();
    if (segment !== '') segments.push(segment);
  }
  if (segments.length === 0) return '';
  let merged = segments[0];
  for (let index = 1; index < segments.length; index += 1) {
    const left = merged.charAt(merged.length - 1);
    const right = segments[index].charAt(0);
    const joinsWithoutSpace = left !== '' && right !== '' && isCjkCharacter(left) && isCjkCharacter(right);
    merged += `${joinsWithoutSpace ? '' : ' '}${segments[index]}`;
  }
  return merged;
}

/**
 * The transcript out of this service's answer envelope.
 *
 * A loop over the first candidate's text parts, and nothing else: a body that is not this envelope
 * yields the empty string, and a body that is not JSON at all throws — the caller turns the throw
 * into `UPSTREAM_UNAVAILABLE`. Handing the raw response back as if it were a transcript is the shape
 * this function exists to not have (ADR-004 §一 records the proxy path already doing exactly that
 * for the first provider); `scripts/asr-second-adapter-check.mjs` pins it with a baseline.
 *
 * The parts are concatenated FIRST and the line breaks merged after, rather than merging part by
 * part: whether the service wrapped a pause inside one part or split it across two, the join is
 * between the same two characters.
 */
export function readTranscriptText(responseText: string): string {
  const parsed = JSON.parse(responseText) as MultimodalResponse;
  const parts = parsed?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let transcript = '';
  for (const part of parts) {
    if (typeof part?.text === 'string') transcript += part.text;
  }
  return mergeTranscriptLines(transcript);
}

/**
 * The semantic code this answer means, read by the ONE classifier in the registry.
 *
 * WHAT WAS HERE INSTEAD, and why it was the defect: a three-line `errorCodeForStatus(status)` reading
 * only the number, copied into each of the three adapters. A `403` that named a model the account had
 * not enabled, an `Arrearage` and an ordinary malformed request were all one code to it, because the
 * separating evidence is in the body and a status-only mapper cannot see the body. The
 * implementation now lives beside the vocabulary (`classifyUpstreamFailure`).
 */

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

// ── the adapter ──────────────────────────────────────────────────────────────────────────────

/**
 * Transcribes one inline request.
 *
 * The two guards run before the transport is touched, in this order: an unaccepted container is
 * refused before anything is sized, and an oversized request is refused before anything is
 * encoded or sent. Neither produces an upstream call.
 */
export async function transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult> {
  if (!acceptsMime(request.audio.mimeType)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MIME',
      message:
        `provider '${id}' does not accept ${baseMimeType(request.audio.mimeType)}; ` +
        `it accepts ${capabilities.acceptsMime.join(', ')}`,
    };
  }

  const hints = honoredHints(capabilities, request.hints);
  const requestBytes = measureInlineRequestBytes(request, hints, invocation.model);
  if (requestBytes > capabilities.maxInlineRequestBytes) {
    return {
      ok: false,
      code: 'OVERSIZE',
      message:
        `inline request of ${requestBytes} B exceeds provider '${id}' budget of ` +
        `${capabilities.maxInlineRequestBytes} B (the budget covers the whole request: audio, context ` +
        `and instruction together, not the audio alone)`,
    };
  }

  const endpoint = generateContentEndpoint(invocation.baseUrl, invocation.model);
  const body = JSON.stringify(
    buildInlineRequestBody(request, hints, base64Encode(request.audio.bytes), invocation.model),
  );
  const signal = invocation.signal ?? AbortSignal.timeout(invocation.timeoutMs);

  let response: Response;
  try {
    response = await fetchWithTransportRetry(invocation.fetchImpl, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The API-key header, not `Authorization: Bearer` — see the module comment. Sent only when
        // there is a credential, so an unconfigured call is not an unauthenticated claim.
        ...(invocation.apiKey ? { 'x-goog-api-key': invocation.apiKey } : {}),
      },
      body,
      signal,
    });
  } catch (error) {
    // One code, two messages: a transport that never connected and a request the deadline ended are
    // the same fact about the upstream from this side of the seam (`UPSTREAM_UNAVAILABLE`).
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: isAbortError(error)
        ? `provider '${id}' did not answer within ${invocation.timeoutMs} ms`
        : `provider '${id}' could not be reached`,
    };
  }

  if (!response.ok) {
    // The body decides whether a 400 is a credential failure; see `looksLikeInvalidApiKey`. It is
    // also what the classifier reads, so the two do not disagree about the same bytes: the predicate
    // above narrows one case to a code the classifier's own table cannot see (the key is named in the
    // body, not in a code string), and everything else goes through `classifyUpstreamFailure`.
    const failureText = await readTextQuietly(response);
    if (response.status === 400 && looksLikeInvalidApiKey(failureText)) {
      return {
        ok: false,
        code: 'UNAUTHORIZED',
        message: `provider '${id}' rejected the credential (400)`,
        status: 400,
      };
    }
    return {
      ok: false,
      code: classifyUpstreamFailure(response.status, failureText),
      message: `provider '${id}' answered ${response.status}`,
      status: response.status,
    };
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: `provider '${id}' answer could not be read` };
  }

  let transcript: string;
  try {
    transcript = readTranscriptText(responseText);
  } catch {
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: `provider '${id}' answer was not the inline generation envelope`,
    };
  }

  if (transcript === '') {
    // A refusal is not an empty answer: the service saying it will not transcribe this must reach
    // the caller as an upstream fault naming the reason, never as "no speech was detected".
    const blockReason = readBlockReason(responseText);
    if (blockReason !== null) {
      return {
        ok: false,
        code: 'UPSTREAM_UNAVAILABLE',
        message: `provider '${id}' did not answer with text (finishReason ${blockReason})`,
      };
    }
    return { ok: false, code: 'NO_SPEECH_DETECTED', message: `provider '${id}' returned no text part` };
  }

  return {
    ok: true,
    text: transcript,
    style: 'verbatim',
    transformations: [...STYLE_TRANSFORMATIONS],
    providerId: id,
    meta: { model: invocation.model },
  };
}

/** A failure body, read for its evidence and never for its text: an unreadable one is empty. */
async function readTextQuietly(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** This module as the registry consumes it. */
export const adapter: AsrAdapter = { id, capabilities, transcribe };
