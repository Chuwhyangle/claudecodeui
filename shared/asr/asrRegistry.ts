/**
 * The ASR provider seam: the address book that hands an adapter out by id.
 *
 * THE CONTRACT IS NOT HERE ANY MORE. The types every adapter satisfies, the error vocabulary and
 * the guards (`baseMimeType`, `declaredAcceptsMime`, `classifyUpstreamFailure`) live in
 * `./contract/asrContract.ts`, a leaf directory that imports no adapter. They are re-exported below
 * so every consumer keeps its import specifier; the re-export is one-way, which is what makes this
 * file's dependency on the adapters acyclic.
 *
 * THE LEAF IS A SEPARATE PACKAGE-SIZED DIRECTORY, NOT A SIBLING FILE. ArchGuard reads dependencies
 * at directory granularity, so a contract that every adapter imports while sharing this directory
 * put adapters and registry in one seven-node SCC. Moving the contract files under `contract/`
 * gives the dependency a direction: `asr → {contract, list/*}` and `list/* → contract`.
 *
 * TWO COMPILER CONFIGURATIONS COMPILE THIS FILE (root and `server/tsconfig.json`), because both
 * ends of the seam read it. See `./contract/asrContract.ts` for what that constraint allows.
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

import type { AsrAdapter, AsrCapabilities, AsrProviderId } from './contract/asrContract.js';

export * from './contract/asrContract.js';

/**
 * The id of the recogniser that runs inside the user's own browser (`locality: 'local-client'`).
 *
 * IT IS NAMED HERE SO A CLIENT MODULE CAN NAME THE PROVIDER WITHOUT ENTERING ITS MODULE. A module
 * that imports the adapter only to read its `id` would otherwise take the adapter as its entry point
 * into the seam. Handing the id out from here lets such a caller take it through the module it must
 * enter first anyway, while keeping the one source of the string: the adapter's own `id`, read
 * rather than copied.
 *
 * A FUNCTION, NOT A CONST. The accessor was written while the registry and the adapters formed a
 * file cycle, and on a path that entered the registry through an adapter a `const` read
 * `sensevoiceWasmId` while that binding was still in its temporal dead zone. The contract split
 * (`./asrContract.ts`) removed that cycle, so the hazard is gone; the accessor stays a function
 * because its callers already read it at call time and this task moves definitions rather than API
 * shape.
 */
export function clientAsrProviderId(): AsrProviderId {
  return sensevoiceWasmId;
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

