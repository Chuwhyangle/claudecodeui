/**
 * The FOURTH recogniser adapter: SenseVoice-Small on this host, through a patched sherpa-onnx.
 *
 * WHY IT IS NOT WIRED LIKE THE OTHER THREE, said first because everything else in this file
 * follows from it. The three adapters before this one are HTTP clients: `transcribe` builds a
 * request out of `AsrInvocation`'s `baseUrl`, `apiKey` and `model` and reads an answer back off the
 * injected `fetchImpl`. This one speaks to no endpoint at all. Its recogniser is a Python process
 * on the same machine, running a *patched* sherpa-onnx build whose CTC log-probabilities are what
 * makes per-token confidence possible, and the socket between the two is a pipe rather than a URL.
 * `fetchImpl` is never called, which is a reading the contract board takes rather than an omission.
 *
 * SO THE ADAPTER OWNS AN INSTALLABLE PORT, NOT A TRANSPORT. `installSensevoiceEngine` is where a
 * host hands this module the thing that can actually run the model — the process manager in
 * `server/modules/voice/sensevoice-worker.ts` in the shipping deployment, a fake in a test. When
 * nothing has been installed the adapter still ANSWERS rather than throwing: it reports
 * `ENGINE_UNAVAILABLE`, which is the same stable code a deployment with a missing model directory
 * gets. That is the fail-closed rule this seam already keeps for provider ids — no silent
 * substitution — applied one level down, to the engine.
 *
 * THE TWO GUARDS STILL RUN, AND THEY RUN FIRST. An unaccepted container and an over-budget request
 * are refused before the engine is consulted, exactly as the OpenAI-compatible adapter refuses them
 * before it builds a multipart body. They are not properties of a wire — they are the seam's own
 * rules about what it will hand a recogniser — so an adapter that speaks no wire does not get to
 * skip them, and the board measures that it did not.
 *
 * WHY THIS FILE IMPORTS NOTHING FROM NODE. It is compiled by BOTH compiler configurations (the root
 * one, for the browser's direct path, and `server/tsconfig.json`), so it may use no Node built-in
 * and no ES2021+ library feature. Every environment dependency is therefore injected: the port
 * above supplies the model, and `transcribe` reads only what the contract hands it. `npm run
 * typecheck` compiling this file under both configurations is the reading that says so.
 *
 * WHAT THE DECLARATION SAYS, and each field is a claim the invariant board holds the result to:
 *   · `tokens: { confidence: true, timestamps: true }` — the whole reason this recogniser is being
 *     added. A patched runtime fills the decoder's `token_log_probs` and its per-token timestamps,
 *     so the adapter returns a token list and the board checks every confidence is in `(0, 1]` and
 *     every `startMs` is finite and non-negative.
 *   · `locality: 'local-server'` — the audio stays on this host. A caller deciding whether a
 *     recording may leave the device reads this and nothing else.
 *   · no `credentials` — there is no key and no address. The settings form renders the credential
 *     block only for a provider that declares one, so this declaration is what makes the key field
 *     disappear rather than a branch in the form.
 *   · `meta.buildId` — a local engine's text is a property of the BUILD, not of a service, so a
 *     reading taken here has to name the artifacts that produced it. The manifest in
 *     `scripts/sensevoice/manifest.json` is the frozen record the build id is checked against.
 */

import { measureRequestBytes } from '../../contract/transcriptionWire.js';
import {
  declaredAcceptsMime,
  honoredHints,
  type AsrAdapter,
  type AsrCapabilities,
  type AsrErrorCode,
  type AsrInvocation,
  type AsrRequest,
  type AsrResult,
  type AsrRuntimeStatus,
  type AsrToken,
  type AsrTransformation,
} from '../../contract/asrContract.js';

/** The id this provider is registered under. */
export const id: string = 'sensevoice-local';

/**
 * This provider's capability declaration.
 *
 * `maxInlineRequestBytes` IS THIS HOST'S OWN CEILING rather than a service's published one: the
 * bytes are not uploaded anywhere, they are base64-encoded onto a pipe to a local process, so the
 * bound that matters is the one past which holding the request in memory is a denial of service of
 * its own. 32 MiB is roughly seventeen minutes of 16 kHz mono PCM — comfortably past the client's
 * own 600-second recording cap and far below the point where one upload is a problem.
 *
 * `oversize: 'reject'` and `style: 'verbatim'` follow from what the engine is: it decodes what it is
 * given and returns the words it heard, so there is nothing to route elsewhere and nothing it
 * rewrites. `honors` is all `false` because the engine has no prompt, no language hint and no
 * context: `language: 'auto'` is the engine's own setting, and a caller's hint put on the wire
 * would be a promise nothing downstream keeps.
 */
export const capabilities: AsrCapabilities = {
  acceptsMime: [
    'audio/wav',
    'audio/x-wav',
    'audio/webm',
    'audio/ogg',
    'audio/mpeg',
    'audio/mp3',
    'audio/flac',
    'audio/aac',
  ],
  maxInlineRequestBytes: 32 * 1024 * 1024,
  oversize: 'reject',
  honors: { prompt: false, language: false, context: false },
  billing: 'request',
  // The engine is handed the audio the trim already removed pauses from, and it recognises what it
  // is given: the pauses are gone before this adapter sees the bytes, exactly as they are for the
  // OpenAI-compatible recogniser this deployment defaults to.
  pauseCues: 'destructive',
  style: 'verbatim',
  oneShot: true,
  // 'direct' rather than 'proxy-only'. `transport` asks which NETWORK path reaches a recogniser, and
  // a recogniser reached over a pipe is not restricted to a service-owned address — it has no
  // address. Declaring 'proxy-only' would claim an `allowedBaseUrl` rule this module has nothing to
  // write, which is the pairing the seam's own criterion rejects.
  transport: 'direct',
  // The whole point. See the module comment.
  tokens: { confidence: true, timestamps: true },
  locality: 'local-server',
};

/**
 * What a `style: 'verbatim'` recogniser did to the text on its way to `AsrResult.text`.
 *
 * EMPTY, and that is a reading rather than a placeholder: the engine's own output is what is
 * returned — no punctuation pass, no disfluency removal, no rewrite — so the transformations list
 * is the empty one. `transformations: ['punctuate']` here would claim this module did something the
 * model did and a reader could not tell the two apart.
 */
export const STYLE_TRANSFORMATIONS: readonly AsrTransformation[] = [];

// ── the engine port ──────────────────────────────────────────────────────────────────────────

/**
 * The errors this adapter can name. A subset of `AsrErrorCode`, written as its own union so the
 * port below cannot hand back a code this adapter has no business reporting (a `RATE_LIMITED` from
 * a local process, say) — the compiler holds the two ends together at each return.
 */
export type SensevoiceEngineErrorCode = Extract<
  AsrErrorCode,
  'ENGINE_UNAVAILABLE' | 'AUDIO_REJECTED' | 'UPSTREAM_UNAVAILABLE' | 'NO_SPEECH_DETECTED'
>;

/**
 * What a caller can learn about the engine WITHOUT running it.
 *
 * THE TYPE IS THE CONTRACT'S, not this module's: `AsrRuntimeStatus` is declared beside `AsrAdapter`
 * because it is the shape the server reads off whichever adapter it selected, and a second
 * definition here would be a second thing that could drift from what the server is checking. The
 * alias is kept so the port's own vocabulary still reads in this module's terms.
 */
export type SensevoiceEngineStatus = AsrRuntimeStatus;

/** One recognition request, in the terms the engine port needs and no others. */
export type SensevoiceEngineRequest = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  /** The deadline for THIS request, already resolved by the caller. */
  timeoutMs: number;
};

/** The engine's answer: the recogniser's own fields, or a code and a sentence. */
export type SensevoiceEngineAnswer =
  | {
      ok: true;
      text: string;
      tokens: AsrToken[];
      buildId: string;
      model?: string;
      durationMs?: number;
      latencyMs?: number;
    }
  | { ok: false; code: SensevoiceEngineErrorCode; message: string };

/**
 * The engine, as this module needs it.
 *
 * THREE METHODS AND NO MORE. `status` is synchronous and cheap so the health route can read the
 * runtime's state without spawning anything; `ensureReady` is the one call that may pay for a model
 * load, so it is the caller's to make at the moment it can afford to wait; `transcribe` is the work.
 *
 * THE PORT IS A TYPE AND NOT AN IMPORT on purpose — this file must not know that Node's
 * `child_process` exists. The manager that implements it lives in the server module; a test's fake
 * implements the same three methods with a map.
 */
export type SensevoiceEnginePort = {
  status(): SensevoiceEngineStatus;
  ensureReady(): Promise<SensevoiceEngineStatus>;
  transcribe(request: SensevoiceEngineRequest): Promise<SensevoiceEngineAnswer>;
};

/**
 * THE INSTALLED ENGINE, or `null` when this process hosts none.
 *
 * Module-level and mutable, which is the one kind of state this module keeps: the registry hands out
 * the adapter OBJECT, so `transcribe` has no receiver to carry a port on. A composition root
 * installs exactly one engine at start-up and never swaps it; a test installs its own fake and
 * removes it again, which is what makes the adapter testable without a model on disk.
 */
let installed: SensevoiceEnginePort | null = null;

/** Hands this module the engine that will serve its requests, or `null` to remove one. */
export function installSensevoiceEngine(engine: SensevoiceEnginePort | null): void {
  installed = engine;
}

/** The installed engine, for a caller that has to consult it directly. */
export function sensevoiceEngine(): SensevoiceEnginePort | null {
  return installed;
}

/**
 * The sentence owed a process that hosts no engine at all.
 *
 * A NAMED CONSTANT RATHER THAN A LITERAL IN TWO PLACES, and the second place is the reason: both
 * `sensevoiceEngineStatus` below and `transcribe`'s null-engine branch report this same state, and
 * the second of them arrives there by a path the compiler cannot narrow across (it knows `installed`
 * is null, but not that the call it would otherwise make returns the unavailable branch). Reading
 * `.reason` off the union is a type error, and restating the sentence at the call site would be a
 * second copy that could drift. One sentence, one name, both readers.
 */
export const NO_ENGINE_REASON =
  'no SenseVoice engine is installed in this process; the server composition root wires one '
  + 'from SENSEVOICE_MODEL_DIR and SENSEVOICE_PYTHON.';

/**
 * The engine's state, or the fail-closed one when nothing is installed.
 *
 * THE REASON IS WRITTEN HERE RATHER THAN AT EACH CALL SITE so a deployment that forgot to wire the
 * engine reads the same sentence everywhere it is reported.
 */
export function sensevoiceEngineStatus(): SensevoiceEngineStatus {
  if (installed === null) {
    return { available: false, state: 'unavailable', reason: NO_ENGINE_REASON };
  }
  return installed.status();
}

/**
 * The engine's state, as the registry declares it.
 *
 * NAMED AND EXPORTED rather than written as an arrow inside the adapter object below, because the
 * registry registers this provider's fields by name (as it does every other provider's) and a
 * function defined inline in that object would have no name to register.
 */
export function runtime(): AsrRuntimeStatus {
  return sensevoiceEngineStatus();
}

/** The one call that may pay for a model load; see `AsrAdapter.ensureRuntime`. */
export async function ensureRuntime(): Promise<AsrRuntimeStatus> {
  if (installed === null) return sensevoiceEngineStatus();
  return installed.ensureReady();
}

// ── the guards that run before the engine ────────────────────────────────────────────────────

/** The refusal owed an engine that cannot serve this request, in the seam's vocabulary. */
function engineFailure(message: string): AsrResult {
  return { ok: false, code: 'ENGINE_UNAVAILABLE', message };
}

// ── the adapter ──────────────────────────────────────────────────────────────────────────────

/**
 * Recognise one clip, through the installed engine.
 *
 * THE ORDER IS THE CONTRACT AND THE BOARD MEASURES IT. Container first, then budget, then the
 * engine — the same order the OpenAI-compatible adapter runs its two guards in, for the same reason:
 * a request this seam will not accept is refused before anything expensive is touched, and an
 * unaccepted container is refused before the request is even sized. Both guards produce no engine
 * call, which is the reading `requests=0` on the board.
 *
 * NO FALLBACK, EVER. A request that cannot be served by this engine fails; it is not answered by
 * another recogniser. The whole point of selecting `sensevoice-local` is that the audio stays on
 * this host, and a silent substitution would send it somewhere the user did not choose.
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

  const engine = installed;
  if (engine === null) return engineFailure(NO_ENGINE_REASON);

  const status = engine.status();
  if (!status.available) {
    return engineFailure(status.reason);
  }

  const answer = await engine.transcribe({
    bytes: request.audio.bytes,
    mimeType: request.audio.mimeType,
    fileName: request.audio.fileName,
    timeoutMs: invocation.timeoutMs,
  });

  if (!answer.ok) {
    return { ok: false, code: answer.code, message: answer.message };
  }

  const meta: { model?: string; latencyMs?: number; buildId: string } = { buildId: answer.buildId };
  if (answer.model !== undefined) meta.model = answer.model;
  if (answer.latencyMs !== undefined) meta.latencyMs = answer.latencyMs;

  return {
    ok: true,
    text: answer.text,
    style: capabilities.style,
    transformations: [...STYLE_TRANSFORMATIONS],
    providerId: id,
    tokens: answer.tokens,
    meta,
  };
}

/**
 * This module as the registry consumes it.
 *
 * `runtime` and `ensureRuntime` are the two fields no other adapter carries, and they exist because
 * this is the first recogniser whose availability is NOT a property of the user's settings. Whether
 * an HTTP recogniser is ready is answered by reading the stored document; whether this one is ready
 * is answered by asking the process on this host. The server asks the ADAPTER it has already
 * selected, so a second local engine is a declaration in its own module rather than a branch in the
 * service — the same discipline `credentials` and `allowedBaseUrl` already follow.
 */
export const adapter: AsrAdapter = {
  id,
  capabilities,
  transcribe,
  runtime,
  ensureRuntime,
};
