/**
 * The FIFTH recogniser adapter: SenseVoice-Small int8, RUN IN THE BROWSER, on onnxruntime-web's WASM
 * backend. It is the first recogniser in this registry whose engine is on the recording device.
 *
 * WHAT MAKES IT DIFFERENT FROM EVERY ROW ABOVE IT, said first because the rest of the file follows.
 * The three HTTP adapters send bytes to a service; `sensevoice-local` sends them down a pipe to a
 * Python process on this host. This one sends them NOWHERE: the model runs in the user's own tab, so
 * the audio never leaves the device at all — which is why it declares `locality: 'local-client'`
 * rather than `'local-server'`. The distinction is not cosmetic: a caller deciding whether a private
 * recording may be uploaded reads `locality` and nothing else, and folding "the browser runs it" into
 * "this host runs it" would make that decision answer about a machine the audio never reaches.
 *
 * SO THIS MODULE OWNS AN INSTALLABLE PORT AND NOT A TRANSPORT. `installWasmEngine` is where a host
 * hands this module the thing that can actually run the model — the browser composition root, whose
 * implementation posts to a Web Worker (`@/modules/chat/audio/voiceClientAsrWorker`), in the shipping
 * client, a fake in a test. `fetchImpl` is never called; that is a reading the contract board takes
 * (`requests=0`) rather than an omission. With nothing installed the adapter still ANSWERS, reporting
 * `ENGINE_UNAVAILABLE` — the same stable code a browser that cannot run the runtime gets. That is the
 * seam's existing fail-closed rule applied one level down, to the engine: no silent substitution, and
 * in particular no quiet routing of the audio to a server the user did not choose.
 *
 * WHY IT REGISTERS NO `runtime`/`ensureRuntime`, WHEN `sensevoice-local` REGISTERS BOTH. Those two
 * fields answer "is this recogniser's runtime ready" for the SERVER, off the health payload. This
 * recogniser's runtime is a property of the CLIENT's browser — a different device for every user of
 * the same deployment — so a server-side reading of it would be a claim about a machine that server
 * cannot see. The browser answers for itself (`useVoiceAvailable`, off the client engine's own
 * status), and the settings form's single "the local engine" row stays unambiguous. The two exported
 * accessors below are therefore NOT registered on the adapter object; they are for the client's
 * composition root, which is the only party that can truthfully answer them.
 *
 * WHY THE TWO GUARDS STILL RUN, AND RUN FIRST. An unaccepted container and an over-budget request are
 * refused before the engine is consulted, exactly as every other adapter refuses them. They are the
 * seam's own rules about what it will hand a recogniser, not properties of a wire, so an adapter that
 * speaks no wire does not get to skip them — and the board measures that it did not.
 *
 * WHY THIS FILE IMPORTS NOTHING FROM NODE. It is compiled by BOTH compiler configurations (the root
 * one, for the browser's direct path, and `server/tsconfig.json`, because the server publishes this
 * row on its health payload), so it may use no Node built-in, no DOM global and no ES2021+ library
 * feature. Everything that needs a runtime — the model bytes, the WASM runtime, the Cache API — is on
 * the far side of the port, which is why the port is a TYPE and not an import.
 *
 * WHAT THE DECLARATION SAYS, and each field is a claim the invariant board holds the result to:
 *   · `tokens: { confidence: true, timestamps: true }` — the CTC decoder's log-softmax gives a
 *     probability per emitted token and the frame index gives its time, so this adapter returns a
 *     token list and the board checks every confidence is in `(0, 1]` and every time is finite and
 *     non-negative.
 *   · `locality: 'local-client'` — the audio never leaves the recording device. The promise the whole
 *     feature exists for.
 *   · no `credentials` — there is no address and no key to store, so the settings form renders no
 *     credential block for it. That is the declaration the form reads, not a branch in the form.
 *   · `meta.buildId` — what the browser produced is a property of the ARTIFACTS (the ort-web build,
 *     the pinned checkpoint, this front end's version), not of a service, so every result names them
 *     and a reading taken on one build can be told apart from a reading taken on another.
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
export const id: string = 'sensevoice-wasm';

/**
 * This provider's capability declaration.
 *
 * THE TWO CONTAINER-SIDE FIELDS ARE THIS SEAM'S OWN CEILINGS rather than a service's published ones.
 * `maxInlineRequestBytes` bounds what this seam will hold in memory and hand to a recogniser; 32 MiB
 * is the same figure `sensevoice-local` declares, because the constraint is the same one — the bytes
 * are not uploaded anywhere, and the bound that matters is the one past which holding the whole
 * recording is a denial of service of its own. `acceptsMime` is the same audio family the other local
 * recogniser accepts, for the same reason: the front end decodes the container into PCM itself, so
 * the list is the set of containers the recorder and the file picker produce rather than a limit of
 * the model's.
 *
 * `honors` IS ALL FALSE BECAUSE THE MODEL HAS NO SUCH INPUTS. SenseVoice takes audio and nothing else
 * — there is no prompt, no language hint the decoder can be steered by, and no context to bias
 * towards. A caller's hint put on a wire would be a promise nothing downstream keeps, and for this
 * adapter there is not even a wire to put it on: a hint that changed the bytes the engine is handed
 * would be the module inventing an input the model does not have.
 *
 * `transport: 'direct'` rather than `'proxy-only'`, for the reason `sensevoice-local` gives: that
 * field asks which NETWORK path reaches a recogniser, and a recogniser with no address is not
 * restricted to a service-owned one. Declaring `'proxy-only'` would claim an `allowedBaseUrl` rule
 * this module has nothing to write, which is the pairing the seam's own criterion rejects.
 *
 * `pauseCues: 'destructive'` FOLLOWS FROM WHERE THE AUDIO COMES FROM. This adapter is handed the
 * audio the client's trim already removed pauses from — the same segments the other providers
 * receive — so the pauses are gone before the model sees the bytes. Recording the setting the
 * CALLER applied, rather than one this module chose, is what stops a reader of the declaration from
 * concluding the module spent a punctuation cue it never had.
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
  pauseCues: 'destructive',
  style: 'verbatim',
  oneShot: true,
  transport: 'direct',
  tokens: { confidence: true, timestamps: true },
  locality: 'local-client',
};

/**
 * What a `style: 'verbatim'` recogniser did to the text on its way to `AsrResult.text`.
 *
 * EMPTY, and that is a reading rather than a placeholder: the decoder's greedy output is what is
 * returned — no punctuation pass, no disfluency removal, no rewrite — so the transformations list is
 * the empty one. `['punctuate']` here would claim this module did something the model did, and a
 * reader could not tell the two apart.
 */
export const STYLE_TRANSFORMATIONS: readonly AsrTransformation[] = [];

// ── the engine port ──────────────────────────────────────────────────────────────────────────

/**
 * The errors this adapter can name. A subset of `AsrErrorCode`, written as its own union so the port
 * below cannot hand back a code this adapter has no business reporting (a `RATE_LIMITED` from a
 * worker on this device, say) — the compiler holds the two ends together at each return.
 *
 * `ENGINE_UNAVAILABLE` is the one that carries the weight here: the WASM runtime did not load, the
 * model could not be fetched or was found corrupt, the browser lacks the storage the model is cached
 * in. They are one code because from this side the remedy is one thing — this device cannot run the
 * recogniser — and the sentence the port carries says which of them happened.
 */
export type WasmEngineErrorCode = Extract<
  AsrErrorCode,
  'ENGINE_UNAVAILABLE' | 'AUDIO_REJECTED' | 'NO_SPEECH_DETECTED'
>;

/**
 * One recognition request, in the terms the engine port needs and no others.
 *
 * `durationSec` IS CARRIED EVEN THOUGH THE MODEL DOES NOT NEED IT. The caller's routing decides
 * whether one segment took too long relative to its own length — the realtime factor — and it can
 * only compute that if the engine reports how long the segment was. Passing it here keeps the engine
 * free of any need to measure the container a second time.
 */
export type WasmEngineRequest = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  durationSec?: number;
  /** The deadline for THIS request, already resolved by the caller. */
  timeoutMs: number;
};

/** The engine's answer: the recogniser's own fields, or a code and a sentence. */
export type WasmEngineAnswer =
  | {
      ok: true;
      text: string;
      tokens: AsrToken[];
      buildId: string;
      /** How long the engine took, for the caller's realtime-factor reading. */
      latencyMs?: number;
    }
  | { ok: false; code: WasmEngineErrorCode; message: string };

/**
 * The engine, as this module needs it.
 *
 * THREE METHODS, THE SAME THREE `sensevoice-local` DECLARES, so a caller written against one local
 * engine's port is written against both. `status` is synchronous and cheap so a caller can read the
 * runtime's state without paying for a model load; `ensureReady` is the one call that may pay for
 * one; `transcribe` is the work.
 *
 * THE PORT IS A TYPE AND NOT AN IMPORT on purpose — this file must not know that a Web Worker, a
 * `fetch`, or onnxruntime-web exists. The browser implementation lives in the chat module; a test's
 * fake implements the same three methods with a map.
 */
export type WasmEnginePort = {
  status(): AsrRuntimeStatus;
  ensureReady(): Promise<AsrRuntimeStatus>;
  transcribe(request: WasmEngineRequest): Promise<WasmEngineAnswer>;
};

/**
 * THE INSTALLED ENGINE, or `null` when this tab hosts none.
 *
 * Module-level and mutable, which is the one kind of state this module keeps: the registry hands out
 * the adapter OBJECT, so `transcribe` has no receiver to carry a port on. A composition root installs
 * exactly one engine and never swaps it; a test installs its own fake and removes it again, which is
 * what makes the adapter testable with no model, no WASM and no browser.
 */
let installed: WasmEnginePort | null = null;

/** Hands this module the engine that will serve its requests, or `null` to remove one. */
export function installWasmEngine(engine: WasmEnginePort | null): void {
  installed = engine;
}

/** The installed engine, for a caller that has to consult it directly. */
export function wasmEngine(): WasmEnginePort | null {
  return installed;
}

/**
 * The sentence owed a tab that hosts no engine.
 *
 * A NAMED CONSTANT RATHER THAN A LITERAL IN TWO PLACES, for the reason the local-server adapter
 * gives: both `wasmEngineStatus` below and `transcribe`'s null-engine branch report this state, and
 * the second arrives there by a path the compiler cannot narrow across — it knows `installed` is
 * null, but not that the call it would otherwise make returns the unavailable branch, so reading
 * `.reason` off the union is a type error. One sentence, one name, both readers.
 */
export const NO_ENGINE_REASON =
  'no on-device recogniser engine is installed in this tab; the client composition root wires one '
  + 'from the Web Worker that owns onnxruntime-web and the cached int8 model.';

/**
 * The engine's state, or the fail-closed one when nothing is installed.
 *
 * EXPORTED BUT NOT REGISTERED ON THE ADAPTER, deliberately: the server publishes a `runtime` reading
 * for the adapters whose readiness is a property of THIS HOST, and a browser's WASM runtime is not.
 * The client's own availability hook is the reader — see the module comment.
 */
export function wasmEngineStatus(): AsrRuntimeStatus {
  if (installed === null) {
    return { available: false, state: 'unavailable', reason: NO_ENGINE_REASON };
  }
  return installed.status();
}

/** The one call that may pay for a model load or a runtime start-up; read by the client's hook. */
export async function ensureWasmEngineReady(): Promise<AsrRuntimeStatus> {
  if (installed === null) return wasmEngineStatus();
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
 * engine — the same order every adapter in this registry runs its guards in, for the same reason: a
 * request this seam will not accept is refused before anything expensive is touched, and an
 * unaccepted container is refused before the request is even sized. Both guards produce no engine
 * call, which is the reading `requests=0` on the board.
 *
 * NO FALLBACK, EVER. A request this engine cannot serve FAILS; it is not answered by another
 * recogniser here. The whole reason a user selects an on-device recogniser is that the audio stays on
 * the device, so a silent substitution would undo the one thing the choice was about. The caller's
 * routing may decide to fall back — it knows it is doing so and can say so — but this module, which
 * cannot see the user's decision, must not.
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
    durationSec: request.audio.durationSec,
    timeoutMs: invocation.timeoutMs,
  });

  if (!answer.ok) {
    return { ok: false, code: answer.code, message: answer.message };
  }

  // `latencyMs` is forwarded rather than dropped: the caller's per-segment realtime-factor reading
  // is what decides whether a slow segment falls back, and it needs the engine's own number to be
  // measured against the segment's length.
  const meta: { buildId: string; latencyMs?: number } = { buildId: answer.buildId };
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
 * FOUR FIELDS, AND THE ABSENT FOURTH-KIND ONES ARE THE READING. No `wire` (there is no wire to
 * name), no `allowedBaseUrl` (there is no address to hold to a rule), no `credentials` (there is no
 * key, which is what makes the settings form render no credential block), and no `runtime` /
 * `ensureRuntime` (the readiness of a browser's runtime is not a fact this server can report; see the
 * module comment).
 */
export const adapter: AsrAdapter = {
  id,
  capabilities,
  transcribe,
};
