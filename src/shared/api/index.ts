import type { VoiceProviderRow } from '@/shared/types';
import { readVoiceConfig, readVoiceFallbackPreference, voiceConfigHeaders, whenVoiceConfigReady } from '@/shared/api/voiceConfig';
// The endpoint map and the request plumbing live beside this barrel, not inside it: keeping
// them here made `index.ts` and `voiceConfig.ts` one file-level value SCC (see `client.ts`).
// They are re-exported under their original names, so call sites keep importing from here.
import { api } from '@/shared/api/client';
export { api };
export {
  ApiRequestError,
  authenticatedFetch,
  fetchSessionActivity,
  readApiJson,
  sessionMessagesUrl,
  voiceRealtimeSocketUrl,
} from '@/shared/api/requests';
export type { ApiRequestOptions } from '@/shared/api/requests';
// The pure voice-edit label rule lives in `src/shared/voice` now: it has no imports and no
// transport concern, so keeping it here made the API barrel carry a voice-domain module for no
// reason and pushed the package past the god-package entity budget. Re-exported under its
// original names so a caller that reaches it through this barrel keeps compiling, while call
// sites import the leaf directly (`@/shared/voice/labels/voiceEditLabels`).
// The extra `labels/` level is deliberate: `shared/api` importing the `shared/voice` node itself
// would close an api → voice → settings → api directory cycle (voiceDebug/voiceShortcuts read
// settings, userSettings reads this barrel). A zero-import leaf subpackage keeps the real file
// graph acyclic and the frontend directory-cycle ratchet pinned.
export * from '@/shared/voice/labels/voiceEditLabels';
// The direct path's request construction lives in the repository-root shared tree, the same
// module the server and the CLI compile — see shared/asr/contract/transcriptionWire.ts.
import {
  createTranscriptionRequest,
  parseTranscriptionResponse as readTranscriptionResponse,
} from '@shared/asr/contract/transcriptionWire';
// The provider address book, the same table the server's health reading republishes. The
// browser asks it whether an id exists rather than keeping its own list of the ids it knows.
import type { AsrCapabilities, AsrErrorCode, PauseCuesDeclaration } from '@shared/asr/asrRegistry';
import {
  baseMimeType,
  classifyUpstreamFailure,
  declaredAcceptsMime,
  extractUpstreamCode,
  pauseCuesDeclarationFor,
  tryResolve,
} from '@shared/asr/asrRegistry';

// ---------------------------

//----------------- VOICE TRANSCRIPTION AND SPEECH ------------

/**
 * Builds a URL against the user's own OpenAI-compatible voice endpoint. Private to the
 * voice helpers below, which bypass the Cloudpit proxy when a base URL is configured.
 */
function voiceDirectUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Serializes the active voice configuration so callers can detect a settings change and
 * drop cached synthesized audio.
 */
export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

/**
 * Transcribes recorded audio, posting directly to the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise going through the Cloudpit voice proxy.
 */
/**
 * The provider the last health reading named, held here because this is where the direct path
 * decides which endpoint a recording takes.
 *
 * It is a mirror of what `GET /api/voice/health` answered, never an independent opinion: the
 * capabilities in it are the registry's own declaration as the server republished them, so the
 * client has no second table to fall out of step with. The module keeps no copy of that
 * declaration of its own, which is what makes the health reading the only source.
 */
let voiceProviderProfile: { id: string; capabilities: AsrCapabilities } | null = null;

/**
 * Publishes the provider the health reading named. Called by the chat module's
 * `useVoiceAvailable` hook, which is the one place the payload is already parsed; nothing else
 * writes it.
 */
export function setVoiceProviderProfile(profile: { id: string; capabilities: AsrCapabilities } | null): void {
  voiceProviderProfile = profile;
}

/**
 * Every recogniser the last health reading published, in the deployment's own order.
 *
 * WHY A SECOND SLOT BESIDE `voiceProviderProfile`. The profile above answers "what did the deployment
 * say about the recogniser in use"; this one answers "which recognisers exist here at all, and what
 * does each declare" — the question a FALLBACK asks, because the recogniser that gave up is by
 * definition not the one to read a declaration off. Both come from one payload and one writer, so the
 * two cannot disagree about a row they both saw.
 */
let voiceProviderRows: VoiceProviderRow[] = [];

/** Publishes the health reading's provider rows. Called by `useVoiceAvailable`, like the profile. */
export function setVoiceProviderRows(rows: VoiceProviderRow[]): void {
  voiceProviderRows = rows;
}

/** The published rows, for a caller that has to reason about more than the effective provider. */
export function readVoiceProviderRows(): VoiceProviderRow[] {
  return voiceProviderRows;
}

// The runtime-config SLOT (the effective context-pack size) lives in `src/shared/voice/voiceRuntimeConfig`
// rather than here: the hooks that build a pack are driven by criteria that replace this module
// with a partial double, so a name added here would arrive in those doubles as `undefined`. The
// endpoint itself is `api.voice.runtimeConfig` above; the cache sits beside its readers.

/**
 * The recogniser a clip the CLIENT gave up on is uploaded to, or `null` when this deployment has none.
 *
 * WHY THIS IS A DECISION AND NOT A DEFAULT. When the on-device recogniser cannot take a clip the
 * user's audio has to go somewhere, and every candidate is a disclosure the user did not ask for —
 * so the choice is made from what the deployment PUBLISHED rather than from a guess, and the answer
 * "nowhere" is a real one: a deployment that offers nothing but the browser recogniser has no
 * fallback, and telling the user so is better than uploading to a service nobody selected.
 *
 * THE RULE, in order:
 *   · the user's own stored preference, when it names a row that is eligible — a choice they made is
 *     the most specific statement available, and this is the only field the panel lets them make it in;
 *   · otherwise the first recogniser that runs on the SERVER's own host (`locality: 'local-server'`).
 *     Falling back to a local-server recogniser keeps the clip on the machine the audio was already
 *     going to be transcribed on, which is the smallest step away from "it never left this device";
 *     a remote service is only ever used when the user named one;
 *   · otherwise `null`.
 *
 * ELIGIBILITY IS THE SERVER'S OWN READING. `local-client` is excluded because such a row cannot serve
 * an upload at all — it is the recogniser that just gave up, and the server refuses a request that
 * names one (see `voice.service.ts`). `runtime.available === false` is excluded because that row's own
 * engine has said it cannot run; a row with no runtime reading is a remote recogniser, whose
 * readiness is a property of the user's settings and not of this machine.
 */
export function resolveVoiceFallbackProvider(): string | null {
  const eligible = voiceProviderRows.filter((row) =>
    row.capabilities !== null
    && row.capabilities.locality !== 'local-client'
    && (row.runtime === null || row.runtime.available),
  );

  const preferred = readVoiceFallbackPreference();
  if (preferred !== null) {
    const chosen = eligible.find((row) => row.id === preferred.trim());
    if (chosen !== undefined) {
      return chosen.id;
    }
  }

  return eligible.find((row) => row.capabilities?.locality === 'local-server')?.id ?? null;
}

/**
 * The pause-cue declaration of the provider a recording will actually be transcribed by, or
 * `null` when this build cannot name one.
 *
 * THE PROVIDER ID COMES FROM THE SAME READING THE UPLOAD ROUTES ON: the health payload's
 * effective provider, which the server derives from the user's stored configuration over the
 * server's own environment — the same id `transcribeVoice` below refuses an upload for. That is
 * deliberate. A trim gate that named its own provider would be answering about a recogniser the
 * request is not being sent to, which is exactly what the removed `OPENAI_COMPATIBLE_PROVIDER`
 * literal did: it named an id nothing is registered under, so the answer it produced said nothing
 * about the service on the other end.
 *
 * `null` RATHER THAN A DEFAULT DECLARATION, and the caller treats it as "leave the audio alone":
 * the value is only knowable once the health reading has published a profile, and an id the
 * registry does not claim has no declaration to read. Inventing one would recreate the second
 * source of truth this accessor exists to remove — and the action it would authorise is the
 * destructive one.
 */
export function effectivePauseCuesDeclaration(): PauseCuesDeclaration | null {
  const profile = voiceProviderProfile;
  if (!profile) {
    return null;
  }

  return pauseCuesDeclarationFor(profile.id);
}

/**
 * The refusal the direct path owes an id this build does not register, or `null` when there is
 * nothing to refuse.
 *
 * Checked before the settings are awaited, because the answer does not depend on them: no
 * stored backend can make an unregistered id serveable. Falling through instead would send the
 * recording to an endpoint chosen for a provider the user is not using — the silent fallback
 * whose worst case is a user who believes the new service answered.
 */
function unregisteredProviderRefusal(): Response | null {
  const profile = voiceProviderProfile;
  if (!profile || tryResolve(profile.id) !== null) {
    return null;
  }

  return new Response(
    JSON.stringify({
      error: `Unknown voice provider id '${profile.id}': no ASR adapter is registered for it.`,
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * The refusal the direct path owes a recording whose container the effective provider does not
 * declare, or `null` when there is nothing to refuse.
 *
 * The whitelist is the health reading's own declaration — the registry's `AsrCapabilities` as the
 * server republished it — so the browser holds no second table of accepted containers that could
 * disagree with the server's. Matched on the base type, because the recorder's preferred type is
 * `audio/webm;codecs=opus`: an exact comparison against the published base types would refuse the
 * recording this app just made.
 *
 * Checked before the settings are awaited, like the unregistered-id refusal above and for the same
 * reason: the answer does not depend on the settings. The code is `UNSUPPORTED_MIME`, the same one
 * the proxy path returns, so a caller gets one answer about one recording rather than a different
 * one depending on which of the two endpoints it took.
 *
 * A profile that was never published — a health reading that has not happened yet, or a server too
 * old to send one — leaves this gate silent. It has no declaration to read, and inventing a
 * whitelist here would be exactly the second source of truth this function exists to not be; the
 * server's own gate is still ahead of the recogniser on the proxy path.
 */
function unsupportedContainerRefusal(mimeType: string): Response | null {
  const profile = voiceProviderProfile;
  if (!profile || declaredAcceptsMime(profile.capabilities, mimeType)) {
    return null;
  }

  const base = baseMimeType(mimeType);
  return new Response(
    JSON.stringify({
      error:
        `provider '${profile.id}' does not accept ${base}; ` +
        `it accepts ${profile.capabilities.acceptsMime.join(', ')}`,
      code: 'UNSUPPORTED_MIME',
    }),
    { status: 415, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * The failure envelope the direct path answers with, shaped exactly like the one the server's
 * proxy route builds (`server/modules/voice/voice.routes.ts`).
 *
 * WHY IT IS THE SAME SHAPE AND NOT A SHAPE OF ITS OWN. Both paths land at the SAME reader —
 * `refusalCode` in `src/modules/chat-voice/hooks/useVoiceInput.ts` reads `body.code` and nothing else —
 * so a second envelope here would be a second contract for one field, and the branch that read the
 * proxy's spelling would go blind on the direct path's. `upstreamCode` rides beside `code` when the
 * upstream named one, and is dropped rather than defaulted when it did not: a placeholder would
 * read as a classification, which is the same discipline the route's `sendFailure` follows.
 */
function voiceFailureEnvelope(
  code: AsrErrorCode,
  status: number,
  message: string,
  upstreamCode?: string,
): Response {
  return new Response(
    JSON.stringify({
      error: message,
      code,
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * The answer's body, read WITHOUT consuming the response the caller still uses.
 *
 * A clone is taken whenever the response offers one, which is what keeps this reading from being a
 * change of behaviour rather than a reading: `useVoiceInput` reads the same answer afterwards on
 * the success path. The fallback exists for the stand-in transports the suite drives this seam
 * with, which implement the five members the app reads (`ok`, `status`, `json`, `text`, `headers`)
 * and nothing else; there, and only there, the body is read from the response itself — and on those
 * rows the response is a failure the caller is handed a replacement for, so nothing is left spent.
 * An unreadable body is the empty string, which is the same thing the adapters' `readTextQuietly`
 * answers with, and it means the status fallback decides.
 */
async function readAnswerBody(response: Response): Promise<string> {
  try {
    const copy = typeof response.clone === 'function' ? response.clone() : response;
    return await copy.text();
  } catch {
    return '';
  }
}

/**
 * The text a `2xx` answer carries, or `null` when the body is not this family's envelope at all.
 *
 * The parse is the SHIPPED wire's (`readTranscriptionResponse`, `strict`), over a response built
 * from the body copy: `200` is read the same way here as it is by every other reader of this
 * protocol, so a recognised transcript is never re-described by a second parse. A body that is not
 * JSON at all answers `null` rather than throwing — that answer is not this seam's to reclassify,
 * and the caller's own parse already has an opinion about it.
 */
async function transcriptIn(body: string): Promise<string | null> {
  if (body === '') {
    return null;
  }
  try {
    return await readTranscriptionResponse(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      'strict',
    );
  } catch {
    return null;
  }
}

/**
 * The refusal the direct path owes an upstream answer, or `null` when the answer is a transcription
 * the caller can use as it stands.
 *
 * THIS IS THE DIRECT PATH'S CLASSIFICATION, AND IT HAS NO TABLE OF ITS OWN. The code comes from
 * `classifyUpstreamFailure` in `shared/asr/asrRegistry.ts` — the same call the three adapters make
 * — so an upstream failure means one thing on the browser's path and on the server's proxy path.
 * A client that decided this locally would be the second implementation this seam exists to not be,
 * and the two paths would be free to disagree about the same `403`.
 *
 * THE BODY DECIDES AND THE STATUS IS THE FALLBACK, which is the whole reason the upstream's own
 * code string is read out of the answer at all: `429 AllocationQuota.FreeTierOnly` and
 * `429 Throttling.RateQuota` are one number and two facts (a quota that is gone, a caller who is
 * going too fast), and the sentence a user needs is different for each.
 *
 * A `2xx` IS NOT A FAILURE, and this returns `null` for one that carries text. It reads the body
 * for the one case the status cannot answer — a well-formed answer that names neither `instruction`
 * nor `transcript` is `NO_SPEECH_DETECTED`, not a success with empty text. The proxy path already
 * answers that way (`server/modules/voice/voice.service.ts` maps the adapter's code to `422`), so
 * leaving it out here would be the two paths disagreeing about a silent recording, which is the one
 * failure a user is most likely to meet.
 */
async function voiceAnswerRefusal(response: Response): Promise<Response | null> {
  const body = await readAnswerBody(response);

  if (!response.ok) {
    return voiceFailureEnvelope(
      classifyUpstreamFailure(response.status, body),
      response.status,
      `the voice backend answered ${response.status}`,
      extractUpstreamCode(body),
    );
  }

  const text = await transcriptIn(body);
  if (text === null || text.trim() !== '') {
    return null;
  }

  return voiceFailureEnvelope('NO_SPEECH_DETECTED', 422, 'the voice backend returned no speech');
}

/**
 * The provider a recording is routed for: the stored Recognition service first, the published
 * health reading only when nothing is stored, or `null` when neither names one (the pre-provider
 * default, which keeps meaning "the shared backend").
 *
 * A stored id this build does not register is reported as such rather than resolved to something
 * else: falling through would send the recording to whatever the shared backend points at.
 */
function routedProvider(
  storedProviderId: string,
): { id: string; capabilities: AsrCapabilities } | { unregistered: string } | null {
  const id = storedProviderId.trim() || voiceProviderProfile?.id || '';
  if (!id) {
    return null;
  }

  const adapter = tryResolve(id);
  if (adapter !== null) {
    return { id, capabilities: adapter.capabilities };
  }

  return { unregistered: id };
}

/**
 * Whether the shared backend settings may be used for a recogniser with these capabilities: only a
 * remote recogniser the browser can address itself. A recogniser that runs on the server's own
 * machine has no address to be given one, and a proxy-only one is called by Cloudpit with its own
 * stored credentials.
 */
function sharedBackendApplies(capabilities: AsrCapabilities): boolean {
  return capabilities.transport === 'direct' && capabilities.locality === 'remote';
}

function unregisteredIdRefusal(providerId: string): Response {
  return new Response(
    JSON.stringify({
      error: `Unknown voice provider id '${providerId}': no ASR adapter is registered for it.`,
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Where an upload takes the recogniser it is addressed to from.
 *
 * `stored` IS THE ORDINARY CASE and the default: the recogniser the user saved is the one they asked
 * to have their recordings transcribed by, so the id travels in the usual settings header.
 *
 * `client-fallback` IS THE ON-DEVICE RECOGNISER'S HAND-OFF. The clip was going to be recognised in
 * this browser and the engine gave up, so the stored choice is exactly the id that cannot serve an
 * upload — it names a provider that runs in the caller's own browser. The address is therefore
 * RESOLVED here (`resolveVoiceFallbackProvider`) rather than passed in as a bare id, because the
 * resolution needs the deployment's published rows and this module is the one that holds them; a
 * caller that resolved it itself would be a second copy of the eligibility rule, and the two copies
 * would be a second answer to "may this audio leave the device".
 */
export type VoiceUploadAddress =
  | { kind: 'stored' }
  | { kind: 'client-fallback'; giveUpMessage: string };

/**
 * Uploads one recording, and answers with the recogniser's own response.
 *
 * `address` NAMES THE RECOGNISER FOR THIS REQUEST ALONE. The server reads the id off the same
 * `x-voice-provider` header the stored choice travels in, and applies the request override above the
 * stored document (see `effectiveProviderId`), so the two spellings are one mechanism rather than two.
 *
 * THE RESOLVED ID CANNOT RESURRECT THE SHARED BACKEND. It is resolved exactly like the stored id —
 * through `routedProvider`, and therefore through the same unregistered-id refusal — so an id this
 * build does not register is refused before a byte is sent, and a recogniser that is not a remote one
 * reached directly still takes the proxy branch rather than a base URL the user never set.
 *
 * A FALLBACK WITH NOWHERE TO GO UPLOADS NOTHING AND SAYS SO. The answer is a refusal response rather
 * than a throw, so the caller's existing refusal handling reports the reason without a request being
 * made: an upload addressed to a recogniser nobody published would reach the server's default
 * provider — a service the user did not select — which is precisely the disclosure this addressing
 * exists to avoid.
 *
 * `context` IS A HINT, NOT A ROUTING DECISION. The caller builds the conversation pack; this
 * function appends it to the multipart body only when the selected recogniser DECLARES
 * `honors.context`. A provider that does not acknowledge context must not receive it, and the
 * direct-backend branch has no wire field for it at all, so the field is simply absent there.
 */
export async function transcribeVoice(
  blob: Blob,
  filename: string,
  listenId?: string,
  address: VoiceUploadAddress = { kind: 'stored' },
  context?: string,
): Promise<Response> {
  const refusal = unregisteredProviderRefusal() ?? unsupportedContainerRefusal(blob.type);
  if (refusal) {
    return refusal;
  }

  // The settings are fetched from the server now, so the first call of a session
  // has to wait for them. Reading an un-hydrated copy would look exactly like
  // "no backend configured" and route the recording through the proxy instead of
  // the endpoint the user set up.
  await whenVoiceConfigReady();
  const config = readVoiceConfig();

  // THE ROUTE IS THE DECLARATION'S, NOT THE SETTINGS'. This is read BEFORE the direct branch
  // below, and that order is the whole deliverable: a provider declaring `transport: 'proxy-only'`
  // is one a browser cannot address itself — its service answers no CORS preflight for this origin
  // — so the base URL the user stored must be stepped over rather than called. An unresolved or
  // unpublished profile keeps the behaviour below unchanged, the same discipline
  // `unregisteredProviderRefusal` and `unsupportedContainerRefusal` follow: no readable declaration
  // means no change of route. Note what this is NOT: it is not a test of whether a base URL is set,
  // and it is not a fallback taken after the direct call failed — the request never goes out.
  //
  // THE RECOGNITION SERVICE THE USER SAVED DECIDES THE ROUTE, AND THE SHARED BACKEND IS THE LOWEST
  // PRIORITY. The shared fields (`baseUrl`, `apiKey`, `sttModel`) belong to the recognisers reached
  // through them; they are one flat set that outlives a change of provider, so a user who moved from
  // such a service to one that has its own settings (or none) still carries the old address and key.
  // `routedProvider` therefore reads the stored choice, not the health reading — which is only as
  // fresh as the last time the settings page was open — and `sharedBackendApplies` is false for any
  // recogniser that is not a remote one reached directly.
  // THE ADDRESS IS RESOLVED BEFORE ANY ROUTE IS TAKEN, because one of its two outcomes is "there is
  // no route": a clip the on-device recogniser gave up on is addressed to the fallback recogniser
  // this deployment publishes, and a deployment that publishes none gets a refusal with no request
  // behind it. Falls through to the stored id for every other upload, which is the shipped behaviour.
  let providerId = config.providerId;
  if (address.kind === 'client-fallback') {
    const target = resolveVoiceFallbackProvider();
    if (target === null) {
      return voiceFailureEnvelope(
        'ENGINE_UNAVAILABLE',
        503,
        `the on-device recogniser gave up on this clip (${address.giveUpMessage}) and this deployment `
        + 'publishes no recogniser to fall back to, so it was not uploaded',
      );
    }
    providerId = target;
  }

  const routed = routedProvider(providerId);
  if (routed !== null && 'unregistered' in routed) {
    return unregisteredIdRefusal(routed.unregistered);
  }
  const profile = routed;
  if (profile !== null && !sharedBackendApplies(profile.capabilities)) {
    // The proxy hop is a different protocol from the one below: this is the client talking to
    // Cloudpit (field `audio`, model and key in headers), not to the recogniser's endpoint. The
    // routing header is assembled HERE rather than inside `voiceConfigHeaders()`, which returns an
    // empty map when there is no window: a routing header that vanished there would hand the
    // recording to whatever provider the server defaults to, which is the very thing this branch
    // exists to prevent — silently, on the one path that cannot show it.
    const body = new FormData();
    body.append('audio', blob, filename);
    // The pairing id rides only on the two proxy branches: it is the SERVER's capture row that pairs
    // this upload with the listen's raw corpus row, and the direct branch below never reaches that
    // server — so appending it there would send a field no one reads.
    if (listenId !== undefined) body.append('listenId', listenId);
    // The context is the recogniser's call: a provider whose declaration says it acknowledges a
    // context receives it, and one that says otherwise never has it put on the wire.
    if (context !== undefined && profile.capabilities.honors.context) body.append('context', context);
    return api.voice.transcribe(body, { ...voiceConfigHeaders(), 'x-voice-provider': profile.id });
  }

  if (config.baseUrl.trim()) {
    // The outbound request is built by the one module that owns this protocol. What stays
    // here is what is genuinely local to the browser: which of the two endpoints this
    // recording takes, and the settings it takes its credentials and model from.
    const request = createTranscriptionRequest(
      {
        baseUrl: config.baseUrl.trim(),
        apiKey: config.apiKey,
        model: config.sttModel || 'whisper-1',
      },
      { audio: blob, fileName: filename },
    );

    let response: Response;
    try {
      response = await fetch(request.url, request.init);
    } catch {
      // A transport that never connected and a request the caller's own deadline ended are ONE
      // code on this side of the seam, exactly as they are inside every adapter: the remedy is
      // the same for both, and the proxy route answers both with the same member. There is no
      // status to carry — the request never reached one — so the envelope uses the code the
      // route uses for an unreachable upstream rather than inventing a number.
      return voiceFailureEnvelope(
        'UPSTREAM_UNAVAILABLE',
        502,
        'the voice backend could not be reached',
      );
    }

    // The answer is classified HERE, on the one path that has it, rather than handed back raw
    // for the caller to guess at: see `voiceAnswerRefusal`. A `2xx` that carries a transcript
    // comes back untouched, so the caller reads it exactly as it always has.
    return (await voiceAnswerRefusal(response)) ?? response;
  }

  // The proxy hop is a different protocol from the one above: this is the client talking to
  // Cloudpit (field `audio`, model and key in headers), not to the recogniser's endpoint.
  const body = new FormData();
  body.append('audio', blob, filename);
  if (listenId !== undefined) body.append('listenId', listenId);
  // The generic proxy branch keeps the server's own default. A context is appended only when the
  // resolved profile is one this client knows ACKNOWLEDGES it; with no profile there is no
  // declaration to read, and the safe reading is to send none.
  if (context !== undefined && profile !== null && profile.capabilities.honors.context) {
    body.append('context', context);
  }
  return api.voice.transcribe(body, voiceConfigHeaders());
}

/**
 * Uploads one listen's RAW (pre-VAD) audio into the deployment's passive corpus, paired by `listenId`.
 *
 * IT GOES THROUGH THE PROXY ONLY, and that is the whole routing decision: raw capture is the
 * DEPLOYMENT's corpus — kept by the server that owns the capture directory — so unlike a
 * transcription there is no user's own backend to send it to. A direct-backend deployment with raw
 * capture on still uploads raw here, to the Cloudpit it is already authenticated against.
 *
 * NOTHING IS READ FROM THE ANSWER. The server writes a row and (when the switch is on for it) a file;
 * the bytes of the response carry nothing the recording path acts on. The promise still rejects when
 * the transport fails, so the caller can decide not to care — see `useVoiceInput`, which never awaits
 * it and swallows the rejection, because a corpus upload must not become a dictation failure.
 */
export async function captureRawVoice(
  listenId: string,
  blob: Blob,
  filename: string,
): Promise<Response> {
  const body = new FormData();
  body.append('audio', blob, filename);
  body.append('listenId', listenId);
  return api.voice.captureRaw(body, voiceConfigHeaders());
}

/**
 * Reads the recogniser's answer out of a transcription response.
 *
 * Named and exported rather than left inline where the direct path is called: the
 * tolerance of this parse is half of what the voice chain promises, and the other
 * half lives on the server, so a reader has to be able to drive *this* parse on
 * the same response shapes the server-side one is driven on. An inline expression
 * could only be measured by a second implementation of it, which would be a
 * reading of the reader rather than of the app. `scripts/asr-extraction-parity-check.mjs`
 * drives this symbol; the proxy path reads its (tolerant) counterpart in
 * `server/modules/voice/voice.service.ts`.
 *
 * Behaviour is deliberately the direct path's strict one: a body that is not JSON
 * is an error, not text. The proxy's tolerance is applied where the proxy applies
 * it, not here.
 *
 * The parse itself is not written here. It is one of the two branches of the one
 * implementation of this wire protocol (`shared/asr/contract/transcriptionWire.ts`), named at this call
 * site rather than restated: this symbol is the frontend's address for it, kept because the
 * reader above drives it by name, and delegating because a copy here is the second
 * implementation that module exists to prevent.
 */
export async function parseTranscriptionResponse(response: Response): Promise<string> {
  return readTranscriptionResponse(response, 'strict');
}

/**
 * Synthesizes speech for the given text, using the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise the Cloudpit voice proxy.
 */
export async function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  // Same reason as transcribeVoice: choose the direct endpoint only from a copy
  // that has actually been loaded.
  await whenVoiceConfigReady();
  const config = readVoiceConfig();

  if (config.baseUrl.trim()) {
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel || 'tts-1',
        voice: config.ttsVoice || 'alloy',
        input: text,
        ...(config.ttsFormat.trim() ? { response_format: config.ttsFormat.trim() } : {}),
      }),
      signal,
    });
  }

  return api.voice.tts(text, { headers: voiceConfigHeaders(), signal });
}
