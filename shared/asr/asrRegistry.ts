/**
 * The ASR provider seam: the contract every adapter satisfies, and the address book that hands
 * one out by id.
 *
 * WHY THE CONTRACT AND THE REGISTRY SHARE A FILE. ADR-004 §L1 sketches the contract in its own
 * `shared/asr/asrContract.ts`. That module would be a third file both compiler configurations
 * compile, and it is not part of this task's declared write surface, so the types live here next
 * to the table that hands providers out. Splitting them later is a pure move with no behaviour in
 * it; the ordering that matters is the one this file keeps, which is that a provider cannot be
 * registered without satisfying the contract — the `AsrAdapter` annotation on the table below is
 * what enforces it.
 *
 * TWO COMPILER CONFIGURATIONS COMPILE THIS FILE, and that is a machine property rather than a
 * style choice: the root configuration compiles it with `lib: ES2020 + DOM` and
 * `types: ["vite/client"]`, `server/tsconfig.json` compiles it with `lib: ES2022`, NodeNext and
 * `types: ["node"]`. So it may use neither Node built-ins nor ES2021+ library features, and every
 * environment dependency (fetch, credentials, base URL, model) is injected at the call site
 * rather than read from the environment here. `npm run typecheck` compiling this one file under
 * both configurations is the reading that says so.
 *
 * UNKNOWN IDS ARE FAIL-CLOSED. The id is stored in user-level configuration, so a typo or a
 * version skew makes an unregistered id a reachable state. `resolve` throws rather than falling
 * back to a default provider: a silent fallback's worst case is a user who believes they are
 * transcribing with the service they chose while the previous one answers. `tryResolve` is the
 * non-throwing form for callers that want to report that state instead of catching it.
 */

import {
  allowedBaseUrl as dashscopeOmniAllowedBaseUrl,
  capabilities as dashscopeOmniCapabilities,
  credentials as dashscopeOmniCredentials,
  id as dashscopeOmniId,
  transcribe as dashscopeOmniTranscribe,
  wire as dashscopeOmniWire,
} from './list/dashscope-omni/dashscope-omni.asr-provider.js';
import {
  capabilities as dashscopeOmniRelayCapabilities,
  credentials as dashscopeOmniRelayCredentials,
  id as dashscopeOmniRelayId,
  transcribe as dashscopeOmniRelayTranscribe,
  wire as dashscopeOmniRelayWire,
} from './list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.js';
import {
  capabilities as multimodalCapabilities,
  id as multimodalId,
  transcribe as multimodalTranscribe,
} from './list/multimodal/multimodal.asr-provider.js';
import {
  capabilities as openaiCompatibleCapabilities,
  id as openaiCompatibleId,
  transcribe as openaiCompatibleTranscribe,
} from './list/openai-compatible/openai-compatible.asr-provider.js';
import {
  capabilities as sensevoiceLocalCapabilities,
  ensureRuntime as sensevoiceLocalEnsureRuntime,
  id as sensevoiceLocalId,
  runtime as sensevoiceLocalRuntime,
  transcribe as sensevoiceLocalTranscribe,
} from './list/sensevoice-local/sensevoice-local.asr-provider.js';
import {
  capabilities as sensevoiceWasmCapabilities,
  id as sensevoiceWasmId,
  transcribe as sensevoiceWasmTranscribe,
} from './list/sensevoice-wasm/sensevoice-wasm.asr-provider.js';
import type { TranscriptionTolerance } from './transcriptionWire.js';

/** A provider id, as it is written in user-level configuration. */
export type AsrProviderId = string;

/**
 * The id of the recogniser that runs inside the user's own browser (`locality: 'local-client'`).
 *
 * IT IS NAMED HERE SO A CLIENT MODULE CAN NAME THE PROVIDER WITHOUT ENTERING ITS MODULE. A module
 * that imports the adapter only to read its `id` enters the adapter BEFORE the registry, and the
 * registry's own static import of that adapter back then reads a binding that has not been
 * initialised yet — the cycle the registry-first ordering everywhere else exists to avoid. Handing
 * the id out from here lets such a caller take it through the module it must enter first anyway,
 * while keeping the one source of the string: the adapter's own `id`, read rather than copied.
 *
 * A FUNCTION, NOT A CONST, and that is the point rather than a style choice: a `const` would read
 * `sensevoiceWasmId` as the registry module is evaluated, which — on a path that entered the
 * registry through the adapter — is a binding that has not been assigned yet. Read at call time,
 * after every module in the cycle has settled, the value is always the adapter's own.
 */
export function clientAsrProviderId(): AsrProviderId {
  return sensevoiceWasmId;
}

/**
 * What a recogniser says about itself. Every field corresponds to a measured effect recorded in
 * ADR-004 §二 rather than to a guess about what a future provider might need.
 */
export type AsrCapabilities = {
  /** Accepted container/coding types. Drives the recording container and the upload whitelist. */
  acceptsMime: string[];
  /**
   * The inline budget of ONE REQUEST, in bytes — prompt, context and every file together, not the
   * audio's own size. A multimodal service's published figure is a whole-request maximum, which is
   * why an implementation that sizes the request by its audio alone under-counts: it will send a
   * request the service rejects.
   */
  maxInlineRequestBytes: number;
  /** What happens past that budget. The first version only allows 'reject' (ADR-004 §缺口②.5). */
  oversize: 'reject' | 'files-api';
  /**
   * Which hint parameters the service acknowledges. `false` means "sending it achieves nothing":
   * the adapter must leave it off the wire rather than forward it and hope.
   */
  honors: { prompt: boolean; language: boolean; context: boolean };
  /**
   * Where a provider that honors `context` places it on the `chat-audio` wire.
   *
   * ABSENT MEANS `'user'`, the position the original chat adapters use: one more text part in the
   * user turn. `'system'` is the position the voice-relay experiment measured — the context is
   * appended to the system instructions so it frames the whole request instead of reading as one
   * more thing the user said. The distinction is DECLARED rather than inferred because the contract
   * board has to build the golden request the declaration promises: a board that assumed one
   * position would red a provider that deliberately chose the other.
   *
   * It is optional and has no effect unless `honors.context` is true; a provider that acknowledges
   * no context has nowhere to place one.
   */
  contextPlacement?: 'user' | 'system';
  /**
   * Where the adapter's own task turn sits on the `chat-audio` wire.
   *
   * ABSENT MEANS `'user'`, the shape every earlier chat adapter uses: a text part beside the audio
   * that tells the model what to do with it. `'system'` moves that instruction into the system turn
   * and leaves the user turn carrying the recording alone — the position a dictation relay needs,
   * because a task sentence sitting next to the audio is text the model can echo back as if the
   * person had said it. The distinction is DECLARED so the contract board knows which golden body
   * to build; it is optional and has no runtime meaning without the adapter honoring it.
   */
  taskPlacement?: 'user' | 'system';
  /** Billing unit. Decides how a saved-second reading converts into money. */
  billing: 'audio-seconds' | 'audio-tokens' | 'request';
  /** What trimming does to this recogniser's accuracy: pauses are punctuation cues (ADR-004 §二). */
  pauseCues: 'destructive' | 'neutral' | 'useful';
  /** Output-style ability. A service that can write up its answer declares 'written' (ADR-004 D3). */
  style: 'verbatim' | 'written';
  /** One-shot or streaming. The first version only allows one-shot. */
  oneShot: boolean;
  /**
   * From where this recogniser's endpoint may be addressed: the browser's own direct path
   * (`'direct'`) or this server's proxy path only (`'proxy-only'`).
   *
   * IT IS REQUIRED, AND THE ABSENCE OF A DEFAULT IS THE WHOLE POINT. A defaulted field is a second
   * source of truth: a service whose endpoint a browser cannot call — a site that answers no CORS
   * preflight, which is the measurement that named this capability — would answer `'direct'` by
   * omission and be addressed by the browser's direct path anyway, where the request either fails
   * opaquely or, worse, is sent with the user's credential. Requiring it makes each declaration
   * state the path its audio travels, and makes a new adapter's silence about it a compile error
   * rather than a route.
   */
  transport: 'direct' | 'proxy-only';
  /**
   * Whether this recogniser produces PER-TOKEN facts, and which ones.
   *
   * A recogniser that reports a confidence per word is a different instrument from one that
   * reports a sentence: the confidence is what a correction loop ranks its candidates by, so a
   * caller that wants to act on it has to know whether the answer carries it at all. `false` is
   * "do not read this field off my results" rather than "I forgot": the invariant board reds a
   * declaration that disagrees with the result it produced (see `asrInvariants.ts`).
   */
  tokens: { confidence: boolean; timestamps: boolean };
  /**
   * WHERE this recogniser runs, which is not the same question as `transport` (which asks which
   * network path reaches it). A `'local-client'` engine runs on the recording device, a
   * `'local-server'` one on this host, and `'remote'` one behind an HTTP endpoint. It is a
   * declaration because a caller deciding whether audio may leave the device reads it, and a
   * default would let an adapter that never thought about the question answer `'remote'` by
   * omission and send a private recording somewhere it should not go.
   */
  locality: 'remote' | 'local-server' | 'local-client';
};

/** The audio half of a request. Bytes travel as a `Uint8Array` so the browser and Node agree. */
export type AsrAudio = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  durationSec?: number;
};

/**
 * The caller's hints. A hint is a request, not an instruction: an adapter puts one on the wire
 * only when its own `honors` declaration says the service acknowledges it.
 */
export type AsrHints = {
  prompt?: string;
  language?: string;
  context?: string;
};

export type AsrRequest = {
  audio: AsrAudio;
  hints?: AsrHints;
};

/** What the recogniser did to the text, so the UI and the metrics can select an axis. */
export type AsrTransformation =
  | 'punctuate'
  | 'de-disfluency'
  | 'written-style'
  | 'markdown'
  | 'identifier-canonicalized'
  | 'self-correction-applied';

/**
 * The semantic error vocabulary. Adapters translate their upstream's transport-level failure into
 * one of these, so the route above them does a mechanical code-to-HTTP mapping instead of
 * re-deriving meaning from a status number that several services use differently.
 *
 * WHY SOME MEMBERS ARE FINER THAN AN HTTP STATUS. `403` is at least three different facts — a key
 * the service refuses, a model the account has not enabled, an account in arrears — and the sentence
 * a user needs is different for each, so the vocabulary separates what the number cannot. `429`
 * likewise covers "slow down" and "your quota is gone", which have different remedies. The evidence
 * that separates them is in the answer BODY, which is why the classifier below reads it
 * (`classifyUpstreamFailure`).
 *
 * WHY THE TRANSPORT FAILURES ARE COARSER THAN THEY LOOK. A 5xx, an aborted request and a transport
 * that never connected are ONE member here — `UPSTREAM_UNAVAILABLE` — rather than three. From this
 * side of the seam the caller's remedy is the same for all of them (wait and retry, or report a
 * broken provider), and the two paths that reach an adapter (the browser addressing a backend
 * itself, and the server proxying it) must answer one upstream failure with one code.
 *
 * THE MEMBERS ARE A CONTRACT WITH THE RUNTIME LIST BELOW, held together at type time rather than by
 * a test: see `ASR_ERROR_CODE_ALIGNMENT`.
 */
export type AsrErrorCode =
  | 'ACCOUNT_ACCESS'
  | 'UNAUTHORIZED'
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'MODEL_NOT_FOUND'
  | 'AUDIO_REJECTED'
  | 'CONTENT_FLAGGED'
  | 'NO_SPEECH_DETECTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'NOT_CONFIGURED'
  | 'INVALID_BASE_URL'
  | 'OVERSIZE'
  | 'UNSUPPORTED_MIME'
  /**
   * The recogniser this deployment selected cannot run HERE — and it is a member of its own rather
   * than a reuse of `UPSTREAM_UNAVAILABLE`, which is the one distinction this vocabulary was missing.
   *
   * `UPSTREAM_UNAVAILABLE` is about a SERVICE: it answered 5xx, it never accepted the connection, the
   * deadline passed. Every remedy it implies is a remedy at the far end — wait, retry, fix the
   * account. This member is about THIS HOST: the model directory is unset or does not hold the pinned
   * weights, the patched runtime is not the one on `PYTHONPATH`, no engine was wired at all. Nothing
   * at the far end is wrong, because in that case there is no far end; the remedy is entirely local
   * and an operator reads a different sentence for it. Folding the two together would tell a user to
   * retry a request that cannot succeed until the machine is fixed, and would leave
   * `GET /api/voice/health` unable to say which of the two it was reporting.
   *
   * IT IS NOT A FALLBACK TRIGGER. A deployment that reaches this code answers with it; it does not
   * quietly route the audio to another recogniser. For a `locality: 'local-server'` provider the
   * whole reason the user selected it is that the audio does not leave the host, so a substitution
   * would send it somewhere the user did not choose.
   */
  | 'ENGINE_UNAVAILABLE';

/**
 * One recognised token: the piece of text, and the per-token facts a token-aware recogniser can
 * attach to it. Every field but `text` is optional because whether they are present is exactly
 * what `AsrCapabilities.tokens` declares — a token from a word-level engine is what a correction
 * loop ranks its candidates by, and one from a sentence-level engine carries the text alone.
 */
export type AsrToken = {
  text: string;
  /** The recogniser's own confidence in this token, in `[0, 1]`. */
  confidence?: number;
  /** Where this token begins, in milliseconds from the start of the audio. Never negative. */
  startMs?: number;
};

export type AsrSuccess = {
  ok: true;
  /** Already processed according to `style`; the composer can use it as it stands. */
  text: string;
  style: 'verbatim' | 'written';
  transformations: AsrTransformation[];
  providerId: AsrProviderId;
  /**
   * The per-token view of `text`, when the recogniser produces one.
   *
   * OPTIONAL AND DECLARATION-GATED: a recogniser that declares `tokens.confidence: false` and
   * `tokens.timestamps: false` (`asrRegistry`'s `AsrCapabilities`) leaves this absent, and the
   * invariant board holds the declaration and the result to the same story. The text of the
   * tokens is redundant with `text` on purpose — a caller that has already stopped reading this
   * field must keep working, and a caller that needs the confidence needs the token boundary it
   * belongs to.
   */
  tokens?: AsrToken[];
  meta?: {
    model?: string;
    latencyMs?: number;
    usage?: Record<string, number>;
    /**
     * The identity of the build that produced this text, for a recogniser whose behavior is a
     * property of an artifact rather than of a service.
     *
     * A LOCAL engine's output is not reproducible across builds — the same audio through two
     * checkpoints can differ in both text and confidence — so a reading taken on one build has to
     * say which build it was. A remote service names its model instead (`meta.model`); this field
     * exists for the recognisers that have no model name to point at.
     */
    buildId?: string;
    /**
     * Which version of a recogniser's own frozen prompt produced this text, for the services that
     * carry one (`dashscope-omni`). A value the adapter holds, not a derivation: the point of
     * recording it is that a prompt which changed on purpose can be told apart in a reading from
     * one that changed by accident.
     */
    promptVersion?: string;
    /**
     * Set to `1` when a `style: 'written'` recogniser could not produce its rewrite and returned
     * the transcription instead.
     *
     * WHY THIS IS A FIELD AND NOT A STYLE. The result is genuinely verbatim — the text is the
     * words as they were spoken, `style` and `transformations` say so — but "the service did not do
     * what it was asked" is exactly the kind of thing a caller must be able to notice without
     * diffing the text, and the UI and the metrics select on it (ADR-004 decision 5's envelope
     * carries `style` for what the text IS, this for why). Absent means the rewrite happened.
     *
     * A number rather than a boolean so a future second degradation reason has somewhere to go
     * without changing this field's type under callers that already read it.
     */
    writtenFallback?: number;
  };
};

export type AsrFailure = {
  ok: false;
  code: AsrErrorCode;
  message: string;
  status?: number;
};

export type AsrResult = AsrSuccess | AsrFailure;

/**
 * The shape a string must have to travel as an `upstreamCode`: a letter, then up to 63 more
 * characters drawn from the alphabet every error-code spelling in this family uses.
 *
 * WHY THE BOUND IS 64 AND WHY IT IS A REJECTION RATHER THAN A TRUNCATION. The value's whole job is
 * to be shown to a user as the upstream's own words for what went wrong, so a value this module
 * shortened would be a quotation that is not a quotation — and the one case that produces a long
 * run of code-shaped characters is a body that is not a code at all (a stack trace, a base64 blob,
 * a whole sentence with its spaces stripped). Truncating would manufacture a plausible-looking code
 * out of it; refusing leaves the field absent, which is the honest reading. See
 * `extractUpstreamCode`.
 */
export const UPSTREAM_CODE_SHAPE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/**
 * A dotted token: at least two letter-led alphanumeric runs joined by `.` — the spelling every
 * service in this family gives its machine-readable failures (`AccessDenied.Unpurchased`,
 * `Throttling.RateQuota`, `Model.NotFound`).
 *
 * The dot is required, and that is what keeps a bare word out of the field: the prose in an error
 * body is full of single words, so a pattern that accepted one would answer with the first English
 * noun it met. A section of prose has no `x.y` adjacency either, because a sentence's dots are
 * followed by spaces — so a dotted token is overwhelmingly a code or a hostname, and the shape
 * check in `extractUpstreamCode` is what separates the rest.
 */
const DOTTED_CODE_TOKEN = /[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+/g;

/** One value offered as a code, or `undefined` when it is not shaped like one. */
function asUpstreamCode(value: unknown): string | undefined {
  return typeof value === 'string' && UPSTREAM_CODE_SHAPE.test(value) ? value : undefined;
}

/**
 * The upstream's own error code, read out of the body it answered with — or `undefined` when its
 * answer carries nothing code-shaped.
 *
 * THE ONE IMPLEMENTATION OF THIS EXTRACTION, here beside the vocabulary it feeds, for the same
 * reason the vocabulary itself lives in one file: the proxy path (the server's `transcribe`) and
 * the direct path (the browser addressing a backend itself) both need to say "the upstream named
 * this failure", and two extractors would be two answers to one question.
 *
 * WHAT IT DOES: it offers candidates and takes the first that satisfies `UPSTREAM_CODE_SHAPE`.
 * The candidate order is the body's own structure — the JSON `code` field, then the `code` field
 * of a nested `error` object (the two spellings this family's bodies use for a machine-readable
 * reason), then, for a body that is not JSON at all or puts its code only in prose, the first
 * dotted token in the text. The value returned is always a slice of the body it was given: the
 * caller can read `body.includes(code)` and it is true by construction.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   · It never copies the body. An answer that is not a code never becomes one: no slicing a
 *     sentence down to its first word, no falling back to the message field, no placeholder.
 *   · It does not truncate. A candidate past 64 characters is not the answer and neither is the
 *     first 64 of it; the scan moves on, and a body whose only candidate is too long yields
 *     `undefined`.
 *   · It does not classify. Which code an upstream failure MEANS — whether `AccessDenied.Unpurchased`
 *     is a rejected credential or an account that has not enabled the model — is the classifier's
 *     question, and this function hands it the string without answering it. When that classifier
 *     lands it must read the string THROUGH here rather than grow a second matching table.
 *
 * The empty string, a non-string, a body that parses to a scalar: all `undefined`, because none of
 * them is the upstream naming a failure.
 */
export function extractUpstreamCode(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const direct = asUpstreamCode(record.code);
    if (direct !== undefined) return direct;

    const nested = record.error;
    if (typeof nested === 'object' && nested !== null) {
      const nestedCode = asUpstreamCode((nested as Record<string, unknown>).code);
      if (nestedCode !== undefined) return nestedCode;
    }
  }

  for (const token of body.match(DOTTED_CODE_TOKEN) ?? []) {
    const candidate = asUpstreamCode(token);
    if (candidate !== undefined) return candidate;
  }

  return undefined;
}

/**
 * The vocabulary as a VALUE, for the readings that have to count it.
 *
 * WHY THIS EXISTS AT ALL. `AsrErrorCode` is a type, and a type is erased: nothing at runtime can ask
 * "which codes are there". The two places that need the answer — the code→status table in
 * `server/modules/voice/voice.service.ts`, which must have exactly one row per member, and any
 * criterion reading that table — otherwise have no source to read it from, and would each have to
 * keep a hand-written list in step with the union by hand.
 *
 * THE ALIGNMENT IS TYPE-LEVEL, AND THAT IS THE POINT. This record is written out by hand with
 * `Readonly<Record<AsrErrorCode, true>>` as its declared type, so the compiler holds the two ends
 * together in BOTH directions: a member added to the union and left out here is a missing property,
 * and a key here that is not a member is an excess property. Neither reaches a run — `npm run
 * typecheck` reds on both. `Object.keys` of a record whose key set IS the union is therefore the
 * union, which is what lets `ASR_ERROR_CODES` be a restatement of the type rather than a second
 * source of truth that could drift from it.
 *
 * THE VALUES ARE ALL `true` BECAUSE ONLY THE KEYS CARRY INFORMATION. An array literal would have
 * needed a hand-written element type that nothing checks against the union; a record whose type IS
 * the union is checked by the compiler, key by key.
 */
export const ASR_ERROR_CODE_ALIGNMENT: Readonly<Record<AsrErrorCode, true>> = {
  ACCOUNT_ACCESS: true,
  UNAUTHORIZED: true,
  QUOTA_EXHAUSTED: true,
  RATE_LIMITED: true,
  MODEL_NOT_FOUND: true,
  AUDIO_REJECTED: true,
  CONTENT_FLAGGED: true,
  NO_SPEECH_DETECTED: true,
  UPSTREAM_UNAVAILABLE: true,
  NOT_CONFIGURED: true,
  INVALID_BASE_URL: true,
  OVERSIZE: true,
  UNSUPPORTED_MIME: true,
  ENGINE_UNAVAILABLE: true,
};

/** Every member of the vocabulary, in the order `ASR_ERROR_CODE_ALIGNMENT` declares them. */
export const ASR_ERROR_CODES: readonly AsrErrorCode[] = Object.keys(
  ASR_ERROR_CODE_ALIGNMENT,
) as AsrErrorCode[];

/**
 * The upstream's own error code strings, and what each one MEANS.
 *
 * THE ORDER IS PART OF THE RULE, and the list is written longest-token-first so that the order a
 * reader sees IS the order the matcher uses. These codes are hierarchical — `Throttling.
 * AllocationQuota` is a child of `Throttling`, `AllocationQuota.FreeTierOnly` is its sibling — so a
 * shorter rule reached first would take a failure away from the longer one that names it better.
 *
 * MATCHING IS BY SUBSTRING, because the upstream puts these strings in an `error.code` field or
 * inside the human-readable message depending on which layer produced the failure, and the two
 * spellings are the same fact.
 *
 * A CODE THAT IS NOT HERE IS NOT A CLASSIFICATION. The table is deliberately not exhaustive — the
 * service's published error page is a general one and this deployment reads one recogniser — so a
 * code this table does not know falls through to the status fallback below rather than being guessed
 * at by a looser pattern.
 *
 * TWO SPELLING FAMILIES, ONE TABLE. The dotted `PascalCase` codes are this service's own; the four
 * `snake_case` rows are the OpenAI-compatible family's, which the shared wire
 * (`shared/asr/transcriptionWire.ts`) also speaks to, so a deployment pointed at such a service
 * names its refusals differently for the same facts. They are rows here rather than a second table
 * because the CLASSIFICATION is the same — `insufficient_quota` and `AllocationQuota.FreeTierOnly`
 * are both "the quota is gone" and must reach `QUOTA_EXHAUSTED` — and a second table would be a
 * second answer to that question. Their positions follow the same longest-first discipline: the
 * four are shorter than every dotted rule above them and longer than, or equal to, the ones below,
 * so no rule can take a failure away from a longer one that names it better.
 */
const UPSTREAM_CODE_RULES: ReadonlyArray<{ token: string; code: AsrErrorCode }> = [
  { token: 'AllocationQuota.FreeTierOnly', code: 'QUOTA_EXHAUSTED' },
  { token: 'Throttling.AllocationQuota', code: 'QUOTA_EXHAUSTED' },
  { token: 'AccessDenied.Unpurchased', code: 'ACCOUNT_ACCESS' },
  { token: 'Throttling.RateQuota', code: 'RATE_LIMITED' },
  { token: 'DataInspectionFailed', code: 'CONTENT_FLAGGED' },
  { token: 'rate_limit_exceeded', code: 'RATE_LIMITED' },
  { token: 'insufficient_quota', code: 'QUOTA_EXHAUSTED' },
  { token: 'invalid_api_key', code: 'UNAUTHORIZED' },
  { token: 'model_not_found', code: 'MODEL_NOT_FOUND' },
  { token: 'ModelNotFound', code: 'MODEL_NOT_FOUND' },
  { token: 'InvalidApiKey', code: 'UNAUTHORIZED' },
  { token: 'Arrearage', code: 'ACCOUNT_ACCESS' },
];

/**
 * The one code string that means something only in company: `InvalidParameter` is the service's
 * generic "this request was malformed", and the recording's duration is one of the things it can be
 * malformed about.
 *
 * WHY THIS RULE NEEDS THE BODY AND THE OTHERS DO NOT. Every other rule is a fact about the code
 * string alone; this one narrows a general code by what the message says the problem was. The needles
 * are the words the service uses for the offending field (`audio`, `duration`, `seconds`) and the
 * literal phrase from its own documentation for the bound (`1 to 300`), so a body that names the
 * duration is a body whose `InvalidParameter` is about the recording rather than about the request
 * around it. A body that says neither is left to the status fallback, which is the honest reading:
 * the code alone does not say enough to classify.
 */
const AUDIO_DURATION_CODE = 'InvalidParameter';
const AUDIO_DURATION_NEEDLES = ['audio', 'duration', 'seconds', '1 to 300'];

/** Whether the answer says the objection is to the recording's length. */
function namesAudioDuration(body: string): boolean {
  const lowered = body.toLowerCase();
  return AUDIO_DURATION_NEEDLES.some((needle) => lowered.includes(needle));
}

/**
 * The status fallback, for a body that names nothing this module knows.
 *
 * `401`/`403` are the credential code and `429` the rate-limit code because those two numbers have
 * one meaning each on every service in this family — and keeping them here rather than deleting them
 * is what leaves an ordinary `403` and an ordinary `429` classified at all. Everything else — the
 * other 4xx, the 5xx, `408`, and a failure that never reached a status because the transport refused
 * or the deadline passed — is `UPSTREAM_UNAVAILABLE`.
 */
function fallbackCodeForStatus(status: number | undefined): AsrErrorCode {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  return 'UPSTREAM_UNAVAILABLE';
}

/**
 * What an upstream failure MEANS, read from the answer's own error code and falling back to the
 * status it arrived with.
 *
 * THE ONE IMPLEMENTATION, here rather than in the adapters, for two reasons. (a) An adapter has two
 * callers — the browser's direct path and the server's proxy path — and both must answer one
 * upstream failure with one code; a copy per adapter would be two answers to one question even
 * before the two paths were compared. (b) The other placement would be the wrong direction of an
 * edge that already exists: every adapter reads `baseMimeType` and `declaredAcceptsMime` out of this
 * module, so a classifier living in an adapter and read from here would close a cycle, and one end of
 * it would be evaluated while the other was still in its temporal dead zone.
 *
 * THE BODY WINS OVER THE STATUS, which is the whole reason the function takes both. A `403` whose
 * body names `AccessDenied.Unpurchased` and a `403` whose body names nothing are the same number and
 * two different facts: the first is a model this account has not enabled, the second is a refused
 * credential.
 *
 * THE BODY IS READ THROUGH `extractUpstreamCode`, never re-parsed here. That function is this
 * module's one answer to "did this body name a failure, and what did it name"; a second reading of
 * the same bytes would be free to disagree with it. The full body is still handed to the
 * `InvalidParameter` qualifier, because that rule is about the MESSAGE rather than about the code.
 *
 * A failure with no status at all (`undefined`: the transport refused, or the caller's own deadline
 * passed) and a body that names nothing both reach the fallback.
 */
export function classifyUpstreamFailure(status: number | undefined, body: string): AsrErrorCode {
  const named = extractUpstreamCode(body);
  if (named !== undefined) {
    for (const rule of UPSTREAM_CODE_RULES) {
      if (named.includes(rule.token)) return rule.code;
    }
    if (named.includes(AUDIO_DURATION_CODE) && namesAudioDuration(body)) return 'AUDIO_REJECTED';
  }

  return fallbackCodeForStatus(status);
}

/**
 * Everything one invocation needs from its environment, injected rather than read. This is what
 * makes the same adapter runnable in the browser's direct path, in the server's proxy path and
 * from the command line — and what makes it testable against a stand-in transport.
 */
export type AsrInvocation = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  /**
   * How much of the upstream's answer the caller is willing to see as malformed before it is an
   * error, for the adapters whose wire reads an answer back (see `TranscriptionTolerance`).
   *
   * IT IS A FIELD OF THE INVOCATION BECAUSE IT IS A PROPERTY OF THE CALLER, NOT OF THE PROVIDER.
   * The same recogniser is reached by two callers whose historical readings differ — the browser's
   * direct path has always treated a body that is not the transcription envelope as a failed
   * transcription, and the server's proxy path has always handed that body back as the transcript
   * — so an adapter that hardcoded either one would change the other path's behaviour the moment
   * the two began sharing it. The proxy path therefore names `'lenient'` at its call site and
   * every other caller gets the absent-means-`'strict'` default it has always had, which keeps the
   * invariant board's and the experiments' invocations (this field absent) reading what they read
   * before.
   */
  tolerance?: TranscriptionTolerance;
};

/**
 * The request shape an adapter speaks, as a name the contract suite can select its expectations by.
 *
 * WHY THIS IS DECLARED RATHER THAN SNIFFED OFF THE REQUEST. A probe that read the shape off the
 * recorded request would score an adapter against whatever it happened to send, which is the one
 * thing a contract check must not do: an adapter that stopped base64-encoding its audio would
 * simply be measured as a different wire and stay green. Declared here, the tag is a CLAIM — the
 * suite pins the request against it, so `wire: 'multipart'` answered by a JSON body is a red
 * reading rather than a silently different set of expectations. It is the same discipline
 * `AsrCapabilities` follows: the table is under test, not documentation.
 *
 *   · `'multipart'` — the shipped `/audio/transcriptions` shape: a `FormData` body carrying the
 *     audio as a file part and the model as a field, the service's own JSON answer read back
 *     (`shared/asr/transcriptionWire.ts`, the single implementation of it).
 *   · `'inline-json'` — the multimodal shape: the audio base64-encoded into a JSON generation
 *     request, the transcript read out of the generation envelope.
 *   · `'chat-audio'` — the chat-completions shape: a JSON chat body whose user turn carries the
 *     recording as an `input_audio` data URI beside a text part, the answer read out of the
 *     assistant turn (`shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`). It is the
 *     third shape rather than a variant of the second because neither of the two above can express
 *     it: the form posts no JSON, and the generation request's parts are `inlineData` blocks.
 *
 * OMITTED MEANS `'inline-json'`, and that default is deliberately not a convenience: the tag was
 * added when the second adapter was already registered, and a module that predates the tag speaks
 * the inline shape. Reading an absent tag as anything else would have made that adapter's readings
 * move under a change it did not make.
 */
export type AsrWire = 'chat-audio' | 'inline-json' | 'multipart';

/**
 * Which fields of a user's stored settings ARE this provider's own address, credential and model.
 *
 * WHY THE PROVIDER NAMES THEM RATHER THAN THE SERVER. A second adapter that authenticates against a
 * service of its own needs a credential the first one's fields cannot carry — a different hostname
 * shape, a key that may only be used server-side — and the server has no way to know that beyond
 * being told. A table in the server indexed by provider id would be precisely the second copy of a
 * provider-owned fact that `allowedBaseUrl` above exists to remove, and it would go stale the day a
 * provider renamed a field. So the ownership is DECLARED here, next to the capability declaration,
 * and the server only ever reads the names off the adapter it has already selected.
 *
 * THE FIELD NAMES ARE SETTINGS KEYS, NOT VALUES, and that is what keeps this type free of any
 * provider's vocabulary: this module compiles under both compiler configurations (see the module
 * comment), so it may not import the server's settings type — and it does not need to, because the
 * names are data the provider supplies and the server looks them up on the document it holds.
 *
 * A provider that declares nothing is a provider whose address and credential come from the
 * deployment's own configuration, which is the behaviour every adapter had before this seam
 * existed: absent means "no fields of my own", never "read whatever is around".
 */
export type AsrCredentialFields = {
  /** The settings field carrying the address this provider is reached at. */
  endpointField: string;
  /** The settings field carrying the credential this provider authenticates with. */
  apiKeyField: string;
  /**
   * The settings field carrying the model the user selected, or absent when the provider has no
   * per-user model of its own — a service with one frozen model has nothing for a user to choose.
   */
  modelField?: string;
  /**
   * The model this provider uses when the user left `modelField` empty, or absent when the provider
   * has none of its own.
   *
   * It is the PROVIDER'S name for its own model, and it is what stops an unset per-user model from
   * falling through to the shared backend's `sttModel`: that value names a model of a DIFFERENT
   * service (a Whisper id, for a user who also has an OpenAI-compatible backend configured), and
   * sending it to this provider is a request for a model it has never heard of. The settings form
   * shows it as the empty field's placeholder, so what a blank field will do is on screen.
   */
  defaultModel?: string;
};

/**
 * What a caller can learn about a provider's OWN RUNTIME without running it.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `AsrInvocation`. Every adapter before the fourth is an HTTP
 * client, and for those "is this provider ready" is a question about the USER'S SETTINGS: an address
 * and a key, read off a stored document, answered by `voice.service.ts` without touching the network.
 * A recogniser that runs ON THIS HOST has no such document. Whether it is ready is a fact about this
 * machine — is the model directory there, is the pinned build the one on the path, did the process
 * come up — and no amount of reading the user's settings can answer it. The first three fields below
 * are therefore the shape of an answer that only a local provider can give, and the reason the
 * service asks the ADAPTER rather than a table keyed by provider id.
 *
 * `buildId` IS ON THE AVAILABLE ARM AND NOT THE UNAVAILABLE ONE, deliberately. A local engine's text
 * is a property of the exact artifacts that produced it — the engine version, the model weights, the
 * capability the patch added — so a reading taken here has to be attributable to a build; an engine
 * that cannot run has no build to name and says why instead. That asymmetry is the type doing the
 * work: a caller cannot report a build id for an engine that is not available, because the compiler
 * does not hand it one.
 */
export type AsrRuntimeStatus =
  | { available: true; state: 'stopped' | 'starting' | 'ready'; buildId: string }
  | { available: false; state: 'unavailable'; reason: string };

/** What a provider module must supply to be registered. */
export type AsrAdapter = {
  id: AsrProviderId;
  capabilities: AsrCapabilities;
  /** The request shape this adapter speaks. Absent means `'inline-json'` (see `AsrWire`). */
  wire?: AsrWire;
  /**
   * Whether `baseUrl` is an address THIS provider's endpoint may be reached at, or absent when the
   * provider has no rule of its own.
   *
   * WHY THE RULE TRAVELS WITH THE ADAPTER RATHER THAN WITH THE SERVER. What counts as this
   * service's address is a property of the service — its hostname scheme, the transport it speaks
   * — and a caller-side table indexed by provider id would be a second copy of a fact the provider
   * already knows, which is the failing shape this seam exists to remove. Required of every
   * `transport: 'proxy-only'` adapter in practice: the server refuses a proxy-only provider's
   * configured address when this predicate answers false, so a proxy-only adapter that omitted it
   * would have no rule to be held to.
   *
   * Absent means "no rule", never "allow everything by construction": a `'direct'` provider is not
   * asked, and the server's own `validateBackendBaseUrl` remains the only rule that applies to it
   * (http and private backends are deliberately legal on that side).
   */
  allowedBaseUrl?: (baseUrl: string) => boolean;
  /**
   * Which of a user's stored settings fields are THIS provider's own address, credential and model,
   * or absent when this provider has none of its own and is reached through the deployment's
   * configuration (see `AsrCredentialFields`).
   *
   * IT IS DECLARED HERE, BESIDE `allowedBaseUrl`, FOR THE SAME REASON THAT FIELD IS: both are
   * facts about the service, and a caller-side table keyed by provider id would be a second copy of
   * them. The server never asks "which fields belong to dashscope-omni"; it asks the adapter it has
   * ALREADY selected which fields are its own, so a provider whose credential moves to another
   * settings key is a one-line change in that provider's module and nothing else.
   */
  credentials?: AsrCredentialFields;
  /**
   * What this provider's own runtime can say about itself WITHOUT being run, or absent for a
   * provider whose readiness is a property of the user's settings rather than of this machine.
   *
   * SYNCHRONOUS ON PURPOSE. It is read on the health path, which must answer in a request and must
   * not be able to hang on a model load; a provider that has nothing to say synchronously simply
   * omits this field and the server keeps the answer it has always given for it.
   */
  runtime?: () => AsrRuntimeStatus;
  /**
   * The one call that may pay for bringing this provider's runtime up, or absent for a provider that
   * has no runtime to bring up.
   *
   * IT IS SEPARATE FROM `runtime` BECAUSE THE TWO QUESTIONS HAVE DIFFERENT COSTS. "Is it ready" is
   * cheap and must stay cheap; "make it ready" can take as long as a quarter-gigabyte model takes to
   * load, so only a caller that has decided it can wait asks it. Keeping them one method would force
   * every status read to be either slow or a lie.
   */
  ensureRuntime?: () => Promise<AsrRuntimeStatus>;
  transcribe(request: AsrRequest, invocation: AsrInvocation): Promise<AsrResult>;
};

// ── the container rule, read off a declaration ───────────────────────────────────────────────

/**
 * The base type of a media type header: everything before the first `;`, trimmed and lower-cased.
 *
 * WHY THE PARAMETERS HAVE TO COME OFF. The browser's preferred recording type is
 * `audio/webm;codecs=opus` — the shipped recorder's own output (ADR-004 §缺口①.3) — while every
 * published figure is a base type. Comparing a raw header against a published list therefore
 * refuses the very recording the app produced, which is a whitelist that rejects its own input.
 * The comparison is case-insensitive for the same reason: `AUDIO/WEBM` is the same container.
 *
 * Both compiler configurations compile this file (see the module comment), so this is written
 * with ES5 string operations only.
 */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Whether `capabilities` declares `mimeType` acceptable, matched on the base type.
 *
 * The declaration is a PARAMETER and not read from this module's registry: the caller has already
 * selected the provider the request will use, and a rule that re-resolved the provider itself
 * could answer about a different one than the request is served by. Every consumer of a
 * declaration — the browser's direct path, the server's proxy path, the adapter's own guard —
 * asks this one function, so "which containers are allowed" has one answer per declaration
 * instead of one per call site.
 *
 * Used by `server/modules/voice/voice.service.ts` (the proxy path) and `src/shared/api.ts` (the
 * browser's direct path), which is what makes one refusal code mean the same thing on both.
 */
export function declaredAcceptsMime(capabilities: AsrCapabilities, mimeType: string): boolean {
  const base = baseMimeType(mimeType);
  // An unlabelled container is not a refused one. `Blob` defaults its type to the empty string, so
  // a file the user picked that carries no media type arrives naming no container at all — and
  // there is nothing for a declaration to be compared against. Refusing it would repeat the fault
  // the base-type match above removes: turning an upload away for something that is not its
  // container. The server's route reads an absent header the same way, defaulting it to
  // `audio/webm` rather than refusing an upload that never made a claim.
  if (!base) {
    return true;
  }

  return capabilities.acceptsMime.indexOf(base) !== -1;
}

// ── the address book ─────────────────────────────────────────────────────────────────────────

/** Thrown by `resolve` for an id no adapter claims. */
export class UnknownAsrProviderError extends Error {
  readonly providerId: AsrProviderId;

  constructor(providerId: AsrProviderId) {
    super(`no ASR adapter is registered for provider id '${providerId}'`);
    this.name = 'UnknownAsrProviderError';
    this.providerId = providerId;
  }
}

/**
 * Every registered adapter. The `AsrAdapter` annotation is load-bearing: a provider whose
 * capability declaration or `transcribe` signature does not satisfy the contract fails to compile
 * here rather than at the first call.
 *
 * THE SHIPPED RECOGNISER IS FIRST, AND THE ORDER IS LOAD-BEARING RATHER THAN COSMETIC. A
 * deployment that names no provider — the shipped default, since `VOICE_PROVIDER_ID` defaults to
 * the empty string and the user-level configuration carries no provider id — resolves its
 * effective provider as the first row (`server/modules/voice/voice.service.ts`). With only the
 * multimodal adapter registered, that deployment reported itself as `multimodal` while its audio
 * went to the OpenAI-compatible endpoint, so every question asked of "the effective provider" was
 * answered about a service the audio never reached. Registering the shipped recogniser first makes
 * the reported identity and the wire the same thing again; the order is the fix, not a detail of
 * it, which is why it is written here instead of left to the reader.
 */
const REGISTERED: readonly AsrAdapter[] = [
  {
    id: openaiCompatibleId,
    capabilities: openaiCompatibleCapabilities,
    wire: 'multipart',
    transcribe: openaiCompatibleTranscribe,
  },
  {
    id: multimodalId,
    capabilities: multimodalCapabilities,
    wire: 'inline-json',
    transcribe: multimodalTranscribe,
  },
  // APPENDED LAST, and the position is the whole point of this row. An id-less deployment
  // resolves its effective provider as the FIRST row (see the comment above), and the client
  // publishes that same row as "the recogniser a trim decision is about"; the third recogniser
  // is a service a user must select, so registering it first would silently move every default
  // reading in the repository onto a service no shipped configuration points at. Last is also
  // its own reading: `listProviders()` now ends with this id, which is what the criterion prints.
  //
  // The four fields are the module's own exports and not a second copy of them — the declaration
  // the registry hands out IS the object the adapter declares, so a field changed in the module
  // changes what every consumer sees without a second edit here. `allowedBaseUrl` is the fifth for
  // the same reason: the endpoint rule a proxy-only provider's address is held to is the one the
  // provider module exports, so there is exactly one copy of it and no table in between.
  //
  // `credentials` is the sixth, and it follows the same discipline for the same reason: which
  // stored settings fields carry this service's address, key and model is this service's own fact.
  // What that buys is visible one level up — the server reads the field NAMES off whichever adapter
  // it selected, so it has no branch and no literal naming this id anywhere (the criterion greps
  // for exactly that), and a second provider with fields of its own is registered by declaring them
  // in its own module.
  {
    id: dashscopeOmniId,
    capabilities: dashscopeOmniCapabilities,
    wire: dashscopeOmniWire,
    allowedBaseUrl: dashscopeOmniAllowedBaseUrl,
    credentials: dashscopeOmniCredentials,
    transcribe: dashscopeOmniTranscribe,
  },
  // APPENDED LAST, for the reason the row above gives and one of its own.
  //
  // The shared half: `listProviders()[0]` is the recogniser an id-less deployment resolves to and the
  // row the client reads a trim decision off (see the comment on `REGISTERED`), so a new selectable
  // provider goes at the END and the shipped default does not move.
  //
  // THIS ROW'S OWN HALF IS THAT IT IS NOT REACHED THE SAME WAY AT ALL. The three above are HTTP
  // clients whose address, key and model the user stores; this one runs on this host, over a pipe to
  // a Python process, and has no address to store. That is why this row carries two fields no other
  // row does — `runtime` and `ensureRuntime` — and why it declares no `wire` (there is no wire to
  // name), no `allowedBaseUrl` (there is no address to hold to a rule) and no `credentials` (there is
  // no key, which is the declaration the settings form reads to decide not to render one).
  //
  // The two new fields are registered HERE, by name, exactly as every other provider's are, and the
  // server reads them off whichever adapter it has already selected — so a second local engine is a
  // declaration in its own module and not a branch in the service.
  {
    id: sensevoiceLocalId,
    capabilities: sensevoiceLocalCapabilities,
    transcribe: sensevoiceLocalTranscribe,
    runtime: sensevoiceLocalRuntime,
    ensureRuntime: sensevoiceLocalEnsureRuntime,
  },
  // APPENDED LAST, for the reason the two rows above give and one of its own.
  //
  // The shared half: `listProviders()[0]` is the recogniser an id-less deployment resolves to and the
  // row the client reads a trim decision off (see the comment on `REGISTERED`), so a new selectable
  // provider goes at the END and the shipped default does not move.
  //
  // THIS ROW'S OWN HALF IS THAT ITS ENGINE RUNS ON A DIFFERENT MACHINE FROM EVERY OTHER ROW'S. The
  // four above run on a service or on this host; this one runs in the user's own browser, which is
  // what its `locality: 'local-client'` declares. The consequence a reader of THIS list has to know
  // is that its readiness is NOT readable from here: there is one engine per browser, so unlike the
  // `sensevoice-local` row above it registers no `runtime` and no `ensureRuntime` — the server cannot
  // report a fact about a device it cannot see, and a row that claimed otherwise would put a second,
  // ambiguous "local engine" status into the health payload the settings form renders. The client's
  // own availability hook asks the browser instead. It likewise declares no `wire` (there is no wire
  // to name), no `allowedBaseUrl` (there is no address to hold to a rule) and no `credentials` (there
  // is no key, which is the declaration the settings form reads to decide not to render one).
  {
    id: sensevoiceWasmId,
    capabilities: sensevoiceWasmCapabilities,
    transcribe: sensevoiceWasmTranscribe,
  },
  // APPENDED LAST, for the reason the rows above give: the first row is what an id-less
  // deployment resolves to, so this selectable recogniser must not move it.
  //
  // THIS ROW IS THE SAME SERVICE AS `dashscope-omni` WITH A DIFFERENT PROMPT AND CONTEXT
  // PLACEMENT. It is a separate provider rather than a mode on the E adapter because the E
  // prompt is a frozen measured artefact (`scripts/asr-omni-prompt-frozen-check.mjs`), and a
  // second behaviour behind the same id would make every reading of that id ambiguous. The
  // credential fields and the address rule are the E module's own, shared by reference.
  {
    id: dashscopeOmniRelayId,
    capabilities: dashscopeOmniRelayCapabilities,
    wire: dashscopeOmniRelayWire,
    // The E module's own rule, by reference: the relay provider is the same service, and the
    // criterion's single-copy reading requires the hostname-bearing function to have one home.
    allowedBaseUrl: dashscopeOmniAllowedBaseUrl,
    credentials: dashscopeOmniRelayCredentials,
    transcribe: dashscopeOmniRelayTranscribe,
  },
];

/** The registered adapters, in registration order. */
export function listProviders(): readonly AsrAdapter[] {
  return REGISTERED;
}

/** The adapter for `providerId`, or `null` when nothing claims it. Never a default. */
export function tryResolve(providerId: AsrProviderId): AsrAdapter | null {
  return REGISTERED.find((adapter) => adapter.id === providerId) ?? null;
}

/** The adapter for `providerId`; throws `UnknownAsrProviderError` when nothing claims it. */
export function resolve(providerId: AsrProviderId): AsrAdapter {
  const adapter = tryResolve(providerId);
  if (adapter === null) throw new UnknownAsrProviderError(providerId);
  return adapter;
}

// ── the pause-cue declaration, as an identity plus its value ──────────────────────────────────

/**
 * One registered provider's own declaration of what trimming does to its pauses, carrying the
 * provider id beside the value.
 *
 * WHY THE ID TRAVELS WITH THE VALUE. `AsrCapabilities.pauseCues` is a bare value; a caller that
 * carries it around on its own loses which recogniser it was read from, and two abilities read
 * from two providers become two interchangeable strings. Everything downstream that has to say
 * *whose* capability it acted on — a reading, a log line, an error — needs the pair.
 *
 * The field is `capability` rather than a repeat of the capability's name so that the CLIENT side
 * has no text of the form `pauseCues: <value>` anywhere in it: the declaration lives on the
 * provider side (in `AsrCapabilities`), and a client that spelled the vocabulary again — even to
 * re-publish a value it was handed — is the second table this seam exists to not have.
 */
export type PauseCuesDeclaration = {
  provider: AsrProviderId;
  /** The provider's own `AsrCapabilities.pauseCues`, verbatim. */
  capability: AsrCapabilities['pauseCues'];
  /** The paired experiment a non-default value rests on (ADR-004 decision 1). */
  evidence?: string;
};

/**
 * The paired experiment each registered provider's declaration rests on, keyed by provider id.
 *
 * A declared value that is not the shipped default is a CLAIM: ADR-004 decision 1 lets a provider
 * change what gets uploaded, but only on the strength of that provider's own paired measurement,
 * so the record is named beside the declaration rather than left implicit in a commit message.
 * The lookups that read it — `scripts/asr-pause-cues-source-check.mjs` and
 * `scripts/asr-trim-capability-check.mjs` — require the named file to exist.
 *
 * ONE ROW PER PROVIDER, AND NOT THE SAME RECORD TWICE. Decision 1 is an obligation on the provider,
 * so a row that names a record measured against a *different* service satisfies the existence check
 * while leaving the claim itself unmeasured — the check cannot tell the two apart, which is why the
 * distinction has to be kept here. The three rows below name three different runs on purpose: the
 * whisper-family record for the multipart recogniser, the Gemini record `multimodal` was actually
 * measured in (the one that declares `pauseCues: 'useful'`), and the omni record `dashscope-omni`
 * was measured in — the third recogniser declares `pauseCues: 'neutral'`, so it is the second row
 * decision 1 is about, and until its record existed the check that reads this table was red on it.
 */
const PAUSE_CUES_EVIDENCE: Readonly<Record<string, string>> = {
  [openaiCompatibleId]: 'docs/experiments/2026-09-22-voice-provider-paired-quality.md',
  [multimodalId]: 'docs/experiments/2026-09-23-gemini.md',
  [dashscopeOmniId]: 'docs/experiments/2026-09-24-omni-written.md',
  // The relay row is the same service and model as the row above, so the audio-axis measurement
  // transfers; its own record explains why, and when that inheritance would stop holding.
  [dashscopeOmniRelayId]: 'docs/experiments/2026-10-22-omni-relay-pause-cues.md',
};

/**
 * The pause-cue declaration of the adapter registered under `providerId`, or `null` when nothing
 * is registered under it.
 *
 * THIS IS A LOOKUP, NOT A TABLE. The value returned is the adapter's own `capabilities.pauseCues`,
 * read off the declaration the adapter module exports, so there is exactly one place a provider's
 * answer to 裁不裁 can be written down and no way for a caller to hold a different one.
 *
 * `null` RATHER THAN A DEFAULT ROW, deliberately, and the difference matters: a default row makes
 * an id nobody registered answerable — a caller that mistyped a provider id, or read one from a
 * version that had since changed, would get the shipped behaviour and never learn it was asking
 * about a provider that does not exist. The caller decides what an unnameable provider means for
 * its own action; for a trim the only safe answer is "do not change the audio".
 */
export function pauseCuesDeclarationFor(providerId: AsrProviderId): PauseCuesDeclaration | null {
  const adapter = tryResolve(providerId);
  if (adapter === null) {
    return null;
  }
  return {
    provider: adapter.id,
    capability: adapter.capabilities.pauseCues,
    evidence: PAUSE_CUES_EVIDENCE[adapter.id],
  };
}
