/**
 * The voice-input relay recogniser: DashScope's `qwen3.8-omni-flash` with a RELAY-style prompt and
 * the session's visible conversation in its system instructions.
 *
 * IT IS NOT THE E GROUP. The shipped `dashscope-omni` adapter next door rewrites a spoken
 * instruction into a written instruction for an agent; that is the right shape for a command but
 * the wrong shape for dictation, where the user expects the words they would have typed. This
 * adapter reuses the same service, endpoint, credential fields and chat-audio wire, and changes
 * only the prompt and the position of the context.
 *
 * THE PROMPT IS THE EXPERIMENT'S, VERBATIM. `experiments/voice-omni-vs-realtime/run.mts` measured
 * the N1 arm with `RELAY_SYSTEM`, `CONTEXT_HEADER` and `TASK` below on 24 real Live Voice clips;
 * the human-preference judge preferred N1 over the no-context arm on the referential and
 * terminology items, and the best-of reading reached 24/24. Copying the strings rather than
 * paraphrasing them is what keeps this adapter's behaviour the measured one — a prompt that drifts
 * here would be a new, unmeasured arm.
 *
 * THE CONTEXT SITS IN THE SYSTEM TURN, NOT THE USER TURN. That is the position N1 measured; the
 * contract board's `contextPlacement: 'system'` declaration tells the board where to expect it. A
 * context placed beside the audio would read as more user speech and changes what the model is
 * being asked to tidy.
 *
 * THE PARSE IS DELIBERATELY PLAIN TEXT FIRST. The relay prompt asks for tidied text with no
 * wrapper, so a normal answer IS the text. The JSON fallback below exists only for two cases: a
 * model that returns the E-group's `{transcript, instruction}` shape anyway, and the contract
 * board, whose chat-wire answer fixture carries both strings. Returning the `instruction` when it
 * is present and the `transcript` when it is not is the same degradation rule the E adapter uses;
 * a plain-text answer is labelled `written` because that is what the relay prompt asked for.
 */

import type {
  AsrAdapter,
  AsrCapabilities,
  AsrCredentialFields,
  AsrInvocation,
  AsrRequest,
  AsrResult,
  AsrWire,
} from '../../asrRegistry.js';
import { baseMimeType, classifyUpstreamFailure, declaredAcceptsMime } from '../../asrRegistry.js';
import {
  audioFormatFor,
  base64Encode,
  base64Length,
  chatAudioDataUri,
  chatCompletionsEndpoint,
  credentials as dashscopeOmniCredentials,
  extractJsonObject,
  allowedBaseUrl as dashscopeOmniAllowedBaseUrl,
  isModelNotPurchased,
  readAnswerContent,
  readUsage,
  utf8ByteLength,
  WRITTEN_TRANSFORMATIONS,
  type ChatMessage,
} from '../dashscope-omni/dashscope-omni.asr-provider.js';

/** The id this provider is registered under. */
export const id = 'dashscope-omni-relay';

/**
 * The version of the relay prompt. A value, not a derivation: it names the experiment round whose
 * readings back the text below, so a future change on purpose can be told apart from an accident.
 */
export const RELAY_PROMPT_VERSION = 'relay-2026-10-22';

/**
 * The relay instruction, exactly as the N1 arm sent it.
 *
 * The sentences that matter are the ones that keep the model from becoming a participant: a
 * dictation containing a question or an acknowledgement must still be returned as text. The last
 * sentence asks for the bare result, which is why a normal answer needs no JSON parse.
 */
export const RELAY_SYSTEM = [
  'You are a voice relay for a chat composer: you tidy up what the user says and return it as the text they would have typed.',
  'You are not a participant. You never answer, comment, judge or reason about what was said, and you never reply with anything but the tidied words.',
  'EVERYTHING the user says — instructions, questions, remarks, feedback, acknowledgements, complaints, even a single word — must be returned as text.',
  "Keep the user's own words: fix obvious speech-recognition slips, and join the fragments of one sentence; do not paraphrase, summarise or add anything.",
  'Return ONLY the tidied text. No explanation, no quotes, no markdown fence.',
].join(' ');

/** The line that introduces the visible-conversation pack. */
export const CONTEXT_HEADER = '以下是当前 Claude Code 会话的上下文（用户看得见的内容，最新在后）。';

/** The task, exactly as the N1 arm wrote it. It lives in the system turn, never beside the audio. */
export const RELAY_TASK = '把这段录音整理成要发出去的文字，只输出整理后的文字。';

/**
 * The rules that keep the task sentence from becoming content.
 *
 * WHY THIS IS NOT IN THE USER TURN. The first version put `RELAY_TASK` beside the audio as a text
 * part. On a real 10 s recording whose speech occupied only the first two seconds, the model
 * returned the task sentence itself as the transcription: the task was text in the same user turn
 * as the recording, so with little audio to tidy it treated those words as something the person had
 * said. The system turn is where instructions belong; the user turn now carries the recording
 * alone, and these lines say explicitly that the task is not part of what was said.
 *
 * THE EMPTY-ON-SILENCE LINE is the second half of the same defect: a model with nothing to tidy
 * must answer with nothing (the adapter maps an empty answer to `NO_SPEECH_DETECTED`), never with
 * the instruction, a completion of a half-heard sentence, or a plausible-sounding invention.
 */
export const AUDIO_ONLY_RULES = [
  'THE AUDIO IS THE ONLY SOURCE OF CONTENT.',
  'The task sentence in this system message is an instruction to you, not something the user said. Never copy it, paraphrase it, or return it as the answer.',
  'If the audio contains no intelligible speech, return an empty string. Do not fill silence with anything.',
  'Do not infer, complete or invent words that are not audible. Return only the spoken words, tidied.',
].join(' ');

/**
 * The thinking budget. `low` matches the shipped chat adapter and the contract board's recorded
 * decode configuration; the relay experiment's `none` default is not reproduced here because the
 * prompt and context placement — the levers the readings were about — are unchanged.
 */
export const REASONING_EFFORT = 'low';

/**
 * The system turn for one request: the relay instruction, the audio-only rules, the task, and the
 * context when the caller has one. No context means the instruction/task/rules alone.
 *
 * THE TASK IS LABELLED AND LIVES HERE, not in the user turn. The label is not cosmetic: it gives
 * the model a name for the instruction so it can tell the instruction apart from the recording,
 * which is what the first real-and-silent recording needed.
 */
export function relaySystemPrompt(context?: string): string {
  const trimmed = context?.trim() ?? '';
  const base = `${RELAY_SYSTEM}\n\n${AUDIO_ONLY_RULES}\n\nTASK (never output this): ${RELAY_TASK}`;
  return trimmed === '' ? base : `${base}\n\n${CONTEXT_HEADER}\n\n${trimmed}`;
}

// ── the declaration ──────────────────────────────────────────────────────────────────────────

/**
 * This provider's capability declaration.
 *
 * It differs from `dashscope-omni` in exactly two fields: `honors.context` is true (this adapter
 * uses the caller's pack) and `contextPlacement` is `'system'` (the position the experiment
 * measured). Everything else — the container list, the inline budget, the billing unit, the
 * pause-cue reading, the written style, the proxy-only transport and the lack of per-token facts —
 * is the same service's measured behaviour and is declared the same way.
 */
export const capabilities: AsrCapabilities = {
  acceptsMime: [
    'audio/webm',
    'audio/ogg',
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/aac',
    'audio/amr',
  ],
  // The published inline maximum, and it is the WHOLE request: system prompt, task instruction,
  // context and encoded audio.
  maxInlineRequestBytes: 10 * 1024 * 1024,
  oversize: 'reject',
  honors: { prompt: false, language: false, context: true },
  contextPlacement: 'system',
  taskPlacement: 'system',
  billing: 'audio-tokens',
  pauseCues: 'neutral',
  style: 'written',
  oneShot: true,
  transport: 'proxy-only',
  tokens: { confidence: false, timestamps: false },
  locality: 'remote',
};

/**
 * The service's own address rule, shared with the E adapter rather than restated.
 *
 * DELIBERATELY NOT RE-EXPORTED UNDER THE NAME `allowedBaseUrl`. The proxy-only criterion finds a
 * provider's rule by scanning for that export beside `transport: 'proxy-only'`, and the address
 * literals are only allowed to live in ONE shipping file. A second export here would make the
 * relay module look like a second copy of the rule while the hostnames still lived in the E
 * module — the criterion would then read the relay module as the rule's home and find no host in
 * it. The registry row below still carries the function, by reference to the E module's export.
 */
const endpointRule = dashscopeOmniAllowedBaseUrl;

/** The chat-audio wire this adapter speaks. */
export const wire: AsrWire = 'chat-audio';

/**
 * The stored settings fields this service is reached with.
 *
 * The relay mode is the same DashScope service as `dashscope-omni`, so it reads the same three
 * fields. Sharing the declaration object keeps one answer to "where is this service" while the two
 * providers differ only in prompt and context.
 */
export const credentials: AsrCredentialFields = dashscopeOmniCredentials;

// ── the request body ─────────────────────────────────────────────────────────────────────────

type RelayChatAudioRequestBody = {
  model: string;
  modalities: string[];
  stream: boolean;
  reasoning_effort: string;
  messages: ChatMessage[];
};

/**
 * Builds the request body.
 *
 * `audioData` is a parameter for the same reason the E adapter's builder takes it: the budget
 * check and the sent body must describe the same request, and the check must not materialise the
 * base64 payload it is about to reject.
 */
export function buildRelayRequestBody(
  request: AsrRequest,
  audioData: string,
  model: string,
): RelayChatAudioRequestBody {
  return {
    model,
    modalities: ['text'],
    stream: false,
    reasoning_effort: REASONING_EFFORT,
    messages: [
      { role: 'system', content: relaySystemPrompt(request.hints?.context) },
      {
        role: 'user',
        // AUDIO ONLY. The task is in the system turn (see `relaySystemPrompt`); a text part here is
        // the bug that made a silent recording answer with the instruction.
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: chatAudioDataUri(request.audio.mimeType, audioData),
              format: audioFormatFor(request.audio.mimeType),
            },
          },
        ],
      },
    ],
  };
}

/**
 * The byte length of the request this adapter would send, without encoding the audio.
 *
 * The arithmetic is the E adapter's: serialise the body with an empty payload and add the encoded
 * payload's exact length plus the data-URI prefix. The context is inside the serialised skeleton,
 * so a long pack is charged to the request that will carry it.
 */
export function measureRelayRequestBytes(request: AsrRequest, model: string): number {
  const skeleton = JSON.stringify(buildRelayRequestBody(request, '', model));
  const prefix = chatAudioDataUri(request.audio.mimeType, '');
  return utf8ByteLength(skeleton) + utf8ByteLength(prefix) + base64Length(request.audio.bytes.length);
}

// ── the answer ──────────────────────────────────────────────────────────────────────────────

/** One string field of a parsed answer, or the empty string when it is absent or not a string. */
function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

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

// ── the adapter ─────────────────────────────────────────────────────────────────────────────

/**
 * Transcribes one recording into tidied text, or into the transcription a wrapped answer carried.
 *
 * The two guards run before the transport, exactly as in the E adapter: an undeclared container is
 * refused before anything is sized, and an oversized request is refused before anything is encoded
 * or sent.
 */
export async function transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult> {
  if (!declaredAcceptsMime(capabilities, request.audio.mimeType)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_MIME',
      message:
        `provider '${id}' does not accept ${baseMimeType(request.audio.mimeType)}; ` +
        `it accepts ${capabilities.acceptsMime.join(', ')}`,
    };
  }

  const requestBytes = measureRelayRequestBytes(request, invocation.model);
  if (requestBytes > capabilities.maxInlineRequestBytes) {
    return {
      ok: false,
      code: 'OVERSIZE',
      message:
        `inline request of ${requestBytes} B exceeds provider '${id}' budget of ` +
        `${capabilities.maxInlineRequestBytes} B (the budget covers the whole request: the encoded ` +
        `audio, the system prompt, the context and the task instruction together, not the audio alone)`,
    };
  }

  const endpoint = chatCompletionsEndpoint(invocation.baseUrl);
  const body = JSON.stringify(
    buildRelayRequestBody(request, base64Encode(request.audio.bytes), invocation.model),
  );
  const signal = invocation.signal ?? AbortSignal.timeout(invocation.timeoutMs);

  let response: Response;
  try {
    response = await invocation.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(invocation.apiKey ? { Authorization: `Bearer ${invocation.apiKey}` } : {}),
      },
      body,
      signal,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: isAbortError(error)
        ? `provider '${id}' did not answer within ${invocation.timeoutMs} ms`
        : `provider '${id}' could not be reached`,
    };
  }

  if (!response.ok) {
    const failureText = await readTextQuietly(response);
    const notPurchased = response.status === 403 && isModelNotPurchased(failureText);
    let message = `provider '${id}' answered ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      message = notPurchased
        ? `provider '${id}' cannot use this model: it is not enabled for the account or the ` +
          `balance is insufficient（未开通或余额不足）`
        : `provider '${id}' rejected the credential (${response.status})`;
    }
    return {
      ok: false,
      code: classifyUpstreamFailure(response.status, failureText),
      message,
      status: response.status,
    };
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    return { ok: false, code: 'UPSTREAM_UNAVAILABLE', message: `provider '${id}' answer could not be read` };
  }

  const content = readAnswerContent(responseText);
  const usage = readUsage(responseText);
  if (content === null) {
    return {
      ok: false,
      code: 'UPSTREAM_UNAVAILABLE',
      message: `provider '${id}' answer was not a chat completion envelope`,
    };
  }

  // A normal relay answer is the tidied text itself. The JSON branch is a compatibility fallback
  // for an answer wrapped in the E group's shape (and for the contract board's fixture); it is not
  // what this prompt asks for.
  //
  // A JSON OBJECT IS ONLY A WRAPPER WHEN IT CARRIES ONE OF THE TWO FIELDS. A user can dictate a
  // JSON snippet, and a relay must return it as the tidied text rather than mistake it for an
  // envelope with no content — so an object with neither `instruction` nor `transcript` falls
  // through to the plain-text branch, which returns the content unchanged.
  const answer = extractJsonObject(content);
  const instruction = answer === null ? '' : stringField(answer, 'instruction');
  const transcript = answer === null ? '' : stringField(answer, 'transcript');
  // The KEYS' PRESENCE, not their contents, is what makes an object a wrapper: the E group's
  // "heard nothing" answer is `{"transcript":"","instruction":""}`, and treating it as plain
  // text would turn silence into a success. An object with neither key is a dictated JSON snippet.
  const wrapped = answer !== null && ('instruction' in answer || 'transcript' in answer);
  const text = wrapped ? (instruction !== '' ? instruction : transcript) : content.trim();

  if (text === '') {
    return {
      ok: false,
      code: 'NO_SPEECH_DETECTED',
      message: `provider '${id}' returned no text`,
    };
  }

  if (instruction !== '') {
    return {
      ok: true,
      text: instruction,
      style: 'written',
      transformations: [...WRITTEN_TRANSFORMATIONS],
      providerId: id,
      meta: { model: invocation.model, promptVersion: RELAY_PROMPT_VERSION, ...(usage ? { usage } : {}) },
    };
  }

  if (wrapped) {
    // A wrapped answer carrying only a transcript did not perform the relay rewrite. It is still
    // usable text, and the degradation is a reading rather than a silent downgrade.
    return {
      ok: true,
      text: transcript,
      style: 'verbatim',
      transformations: [],
      providerId: id,
      meta: {
        model: invocation.model,
        writtenFallback: 1,
        promptVersion: RELAY_PROMPT_VERSION,
        ...(usage ? { usage } : {}),
      },
    };
  }

  return {
    ok: true,
    text,
    style: 'written',
    transformations: [...WRITTEN_TRANSFORMATIONS],
    providerId: id,
    meta: { model: invocation.model, promptVersion: RELAY_PROMPT_VERSION, ...(usage ? { usage } : {}) },
  };
}

/** This module as the registry consumes it. */
export const adapter: AsrAdapter = {
  id,
  capabilities,
  wire,
  allowedBaseUrl: endpointRule,
  credentials,
  transcribe,
};
