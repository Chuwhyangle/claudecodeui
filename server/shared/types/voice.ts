import type { VoiceSettings } from '@shared/voice/voiceSettingsRegistry.js';
import type { AsrCapabilities, AsrCredentialFields, AsrErrorCode, AsrHints, AsrRuntimeStatus } from '../../../shared/asr/asrRegistry.js';

//----------------- VOICE MODULE CONTRACTS ------------
/**
 * Per-request voice settings parsed from authenticated HTTP headers.
 *
 * The Voice routes create this value from the optional `x-voice-*` headers and
 * pass it to the Voice service. Empty values mean "use the server-configured
 * default"; the backend base URL is intentionally absent because clients must
 * never control the server's outbound destination.
 */
export type VoiceRequestOverrides = {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
  /**
   * The recogniser this request must use, as it is spelled in user-level configuration.
   *
   * It is an override rather than a stored setting because it selects among the registered
   * adapters and changes with them, not with the user's backend. An id no adapter claims is
   * refused with an explicit error; it is never replaced by the default provider, because a
   * silent fallback's worst case is a user who believes they are transcribing with the service
   * they chose while the previous one answers.
   */
  providerId?: string;
};

/**
 * Uploaded audio accepted by the Voice transcription service.
 *
 * Routes translate Multer's transport-specific file object into this minimal
 * shape so the service does not depend on Express or Multer types.
 */
export type VoiceAudioUpload = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/**
 * Successful speech payload returned by the Voice service.
 *
 * The route copies `contentType` to the client response and pipes `body`
 * without buffering the complete synthesized audio in application memory.
 */
export type VoiceSpeechPayload = {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * One user's Voice backend settings as they are stored server-side.
 *
 * THE DECLARATION IS THE SHARED CONTRACT'S, NOT THIS FILE'S. Every field — the six the settings tab
 * has always edited, the provider-owned four, and the two user-data switches — is named once in
 * `shared/voice/voiceSettingsRegistry.ts`, the module both compiler configurations compile, so the
 * browser's copy and this one cannot drift field by field. It is re-exported here because this file
 * is the backend's type-contract barrel and every Voice module already reads its types from it; the
 * source of truth moved, the import path did not.
 *
 * `baseUrl` is still only stored, never fetched by the server: a client-configured backend is called
 * directly from the browser, so this value never becomes SSRF input on this side. The provider-owned
 * fields are still optional — a row written by an older build carries none of them, and absent means
 * "unset" — and which fields those are is still declared by the provider (`AsrCredentialFields` in
 * `shared/asr/asrRegistry.ts`) rather than by this type.
 */
export type { VoiceSettings };

/**
 * Explicit service result used by Voice routes instead of transport-aware
 * exceptions.
 *
 * Services return `ok: false` with the exact client status/message for expected
 * backend, validation, and timeout failures. Routes only translate the result
 * into HTTP output, while unexpected programming errors still reject normally.
 */
export type VoiceServiceResult<TValue> =
  | { ok: true; value: TValue }
  | {
    ok: false;
    status: number;
    error: string;
    /**
     * The semantic code for this failure, taken from the recogniser seam's own vocabulary
     * (`AsrErrorCode`). EVERY FAILURE OF AN ATTEMPT CARRIES ONE, and so does every refusal of an
     * upload that reached a gate — the three pre-request gates (container, budget, endpoint rule)
     * always did, and the failures read off the transport now do as well: an adapter already names
     * its upstream's refusal in the vocabulary (`UNAUTHORIZED` for a rejected key, `RATE_LIMITED`
     * for the upstream's own limit, `UPSTREAM_UNAVAILABLE` for a 5xx, a transport that never
     * answered and an answer that was not the service's envelope, and the finer members the answer's
     * own body earns it: `ACCOUNT_ACCESS`, `QUOTA_EXHAUSTED`, `MODEL_NOT_FOUND`, `AUDIO_REJECTED`,
     * `CONTENT_FLAGGED` — see `classifyUpstreamFailure`), and the route republishes
     * that name instead of dropping it. A client that has to choose the words for "you said nothing"
     * against "we could not reach the service" cannot do it from a status number — `422` and `502`
     * are the same two numbers for several different remedies — and the code is the one field that
     * survives the round trip with its meaning.
     *
     * THE FAILURES STILL WITHOUT ONE, named so the rule above is read as what it is rather than as a
     * promise the path does not keep: the format gate (`validateConfiguredBackend`), which refuses a
     * setting that is not a URL at all — a state of the deployment rather than a meaning about an
     * attempt, and the narrower endpoint rule above it is what carries `INVALID_BASE_URL`; a provider
     * id nothing in the registry claims, which is the same kind of state and has no member in the
     * vocabulary to be named by; and the TTS face, which shares this type but not the recogniser's
     * vocabulary.
     *
     * The route republishes it verbatim beside the message.
     */
    code?: AsrErrorCode;
    /**
     * The upstream's own error code, when it answered with one — the string its body used to name the
     * failure, such as `AccessDenied.Unpurchased` or `Throttling.RateQuota`.
     *
     * WHAT THIS IS FOR, given `code` above already says what went wrong. `code` is the CLASSIFIED
     * meaning, and the classification is this application's reading; `upstreamCode` is the evidence
     * it was read from, unclassified and unlocalised. A user (or a support thread, or the folded
     * technical detail in the UI) can compare it against the service's own error-code page, which is
     * the only place the exact row for a failure like an expired account exists — and a code the
     * classifier does not recognise still arrives with its evidence attached instead of being
     * swallowed into the generic `UPSTREAM_UNAVAILABLE`.
     *
     * IT IS ALWAYS A SLICE OF THE UPSTREAM'S BODY (`extractUpstreamCode` guarantees that) and it is
     * absent, never empty or invented, when the upstream named nothing, when this process never got
     * an answer to read (a transport that refused to connect), or when the answer held no string of
     * the shape a code has. It is a value the server read, not a value it composed — so it is also
     * not sanitised prose, and the two rules that keep it that way (never copy the body, never
     * truncate a candidate) are stated where it is extracted.
     */
    upstreamCode?: string;
  };

/**
 * One recogniser as the health payload publishes it.
 *
 * `capabilities` is the registry's own declaration for this id, republished unchanged: the
 * client reads the container, the inline budget and the hint switches from here instead of
 * keeping its own table, which is what stops the two from disagreeing after a provider changes.
 *
 * `configured` answers "if this provider were the effective one, would the current
 * configuration let a request through". Every registered provider reads the same user-level
 * backend in this version, so the entries agree today; the field is per-entry so a provider
 * that later needs its own credential does not force every consumer to special-case it.
 */
export type VoiceProviderSummary = {
  id: string;
  /**
   * The name to show a user. The first version has no separate display names, so the id is
   * its own label; the field exists so the UI never has to grow a translation table.
   */
  label: string;
  capabilities: AsrCapabilities;
  configured: boolean;
  /**
   * WHICH STORED SETTINGS FIELDS ARE THIS PROVIDER'S OWN, republished verbatim from the
   * registry's declaration (`AsrCredentialFields`), the same way `capabilities` is.
   *
   * The settings form has to render a different set of inputs per provider — a provider whose
   * address and key are its own gets their fields, one reached through the deployment's backend
   * gets the shared six — and neither of the two obvious ways to answer that is acceptable: a
   * table of ids in the client is a second source of truth that would silently disagree with the
   * registry after a provider changes, and a client that simply rendered all ten fields would ask
   * a user for an address that is never sent anywhere.
   *
   * `undefined` is the declaration's own answer for "no fields of its own" — the same absence
   * `providerConfigured` and `resolveRecognitionConfig` branch on server-side, so the client and
   * the request path read one shape rather than two.
   */
  credentialFields?: AsrCredentialFields;
  /**
   * THE ON-HOST ENGINE'S STATE, for a provider that runs one, republished verbatim from
   * `AsrAdapter.runtime` — the same way `capabilities` and `credentialFields` are.
   *
   * ABSENT FOR A PROVIDER THAT DECLARES NO RUNTIME, which today is every provider reached over the
   * network: their availability is a property of a service the client can reach itself, and this
   * field would have nothing to say about it. A provider that DOES declare one is a process this
   * deployment owns, so "is it up, and which build is it" is answerable here and nowhere else — and
   * `buildId` is the figure that makes a transcript's provenance checkable against the build a
   * deployment believes it is running.
   *
   * `state` is carried as well as `available` because the two are not the same reading for a
   * provider that is merely not started yet: `stopped` is a healthy engine nothing has asked to
   * run, and folding it into the unavailable form would report an idle deployment as a broken one.
   */
  runtime?: AsrRuntimeStatus;
};

/**
 * The answer `GET /api/voice/health` gives: the user's *effective* configuration, not the
 * server's environment.
 *
 * `configured` keeps the position and the meaning its only consumer already reads (
 * `useVoiceAvailable`): whether a recording would reach a recogniser right now. What changed is
 * whose configuration counts — a user who saved their own backend is configured even when the
 * server process has no environment variables set, which is the answer this endpoint gave
 * wrongly before.
 *
 * `provider` is the effective provider id, and `providers` is the whole registered list with
 * each one's capabilities. The list is the registry's, not a copy.
 */
export type VoiceHealth = {
  configured: boolean;
  /** The effective provider id, or the empty string when the registry is empty. */
  provider: string;
  providers: VoiceProviderSummary[];
};

/**
 * Complete application-service surface consumed by the Voice HTTP router.
 *
 * The composition root supplies a concrete implementation with environment
 * configuration and an injected outbound HTTP adapter. Unit tests use the same
 * contract with handwritten fetch fakes and never patch global state.
 */
export type VoiceService = {
  /**
   * Reads the health of the Voice link for one user's stored settings.
   *
   * The settings are an argument rather than something the service fetches, so the route owns
   * the storage lookup and the service stays free of the database. A user whose stored backend
   * is complete is `configured` even when the server has no environment configuration at all.
   *
   * Returns `ok: false` with `UNKNOWN_PROVIDER` when the effective provider id is not one the
   * registry knows: the link is unavailable and naming the id is the only useful answer, since
   * falling back would transcribe with a service the user did not choose.
   */
  getHealth(input: {
    settings: VoiceSettings;
  }): VoiceServiceResult<VoiceHealth>;
  transcribe(input: {
    audio: VoiceAudioUpload;
    overrides: VoiceRequestOverrides;
    /**
     * The user's stored settings, when the caller has them.
     *
     * IT IS AN ARGUMENT FOR THE SAME REASON `getHealth`'s is: which provider is effective, and what
     * a provider that declares credential fields of its own is reached with, are properties of the
     * USER's stored document, and the route owns the storage lookup so the service stays free of the
     * database. Optional because the document is not always at hand — a caller driving this service
     * without a user (a probe, an invariant board, the request path before the lookup) gets the
     * behaviour this path had before these fields existed, which is the deployment's own
     * configuration, and an absent document and an all-empty one are the same reading.
     */
    settings?: VoiceSettings;
    /**
     * The caller's hints for the selected recogniser, when it sent any.
     *
     * THE ONLY HINT THE TRANSPORT CARRIES TODAY IS `context`: the C2 conversation pack the voice
     * relay mode uses to resolve a spoken referent. It is passed through unchanged and the adapter
     * decides whether its own `honors.context` declaration acknowledges it; a provider that does
     * not must leave it off the wire. It is never written to a capture row or a log line.
     */
    hints?: AsrHints;
    /**
     * The pairing id this listen's recording client minted, when it sent one.
     *
     * WHEN PRESENT IT BECOMES A FIELD ON THIS ATTEMPT'S CAPTURE ROW, so the row can be joined with
     * the raw-corpus row (`voice.capture.raw`) of the same listen — see `VoiceCaptureRawInput`. WHEN
     * ABSENT THE ROW HAS NO `listenId` KEY AT ALL, this module's absence-not-placeholder convention,
     * so "not paired" and "paired with nothing" stay distinguishable.
     *
     * It is TRANSPORT TEXT the client chose, so it never reaches a file name: the raw sink builds the
     * file name from it through its own path-safe substitution, and this path only carries it into a
     * log row.
     */
    listenId?: string;
  }): Promise<VoiceServiceResult<{ text: string; recordId?: string }>>;
  synthesizeSpeech(input: {
    text: string;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<VoiceSpeechPayload>>;
  /**
   * Records one listen's raw (pre-VAD) upload, when this deployment collects raw audio.
   *
   * WHY IT IS ON THIS SERVICE AND NOT A ROUTE'S OWN LOGIC. The recording seam is the capture port the
   * transcription path already holds, and "does this deployment collect raw audio" is that port's own
   * switch (`VoiceCapturePort.raw`). So the route parses the upload and calls here, and the decision
   * to write — and the no-op when the switch is off — lives where the port is. `listenId` is required
   * by the caller: a raw row exists to be paired, so a request without one is refused at the route.
   *
   * `stored` is `false` when the deployment does not collect raw — a truthful "nothing was written"
   * rather than an error, because the route reaching here with the switch off is a client that asked
   * about a capability this deployment does not have, not a malformed request.
   */
  captureRaw(input: {
    listenId: string;
    audio: VoiceAudioUpload;
  }): VoiceServiceResult<{ stored: boolean }>;
  /**
   * Whether this deployment collects raw (pre-VAD) audio, for `GET /api/voice/capture`.
   *
   * A capability reading, not a per-user one: the switch is the deployment's own environment, so a
   * client asks once whether uploading raw audio is meaningful at all before it sends any.
   */
  captureState(): { raw: boolean };
  /**
   * Deletes every voice record this user's data store holds, for `DELETE /api/voice/data`.
   *
   * THE USER-DATA COUNTERPART OF `captureState`, and the other half of the D1 promise: the same
   * setting that makes recordings default-on makes them clearable in one action. The answer is the
   * number of RECORDS removed — not files, so it reads as "how many recordings" rather than
   * double-counting each one's audio — and a deployment or user with no store yet answers `0`
   * rather than failing, because "there is nothing here to clear" is a clear that succeeded.
   *
   * OPTIONAL LIKE THE STORE ITSELF, and for the same reason the deps carry `voiceData?`: the leaf
   * route tests build small `VoiceService` doubles that never clear anything, and a required member
   * would make every one of them a compile error for a behaviour they do not exercise. The shipping
   * service always implements it; a caller that does not reads as a store that held nothing, which
   * is the same answer the empty case gives.
   */
  clearVoiceData?(): { deleted: number };
  /**
   * Writes the text the user actually sent, and the `听到 → 想说` pairs derived from their edit, onto
   * the record the transcription already wrote — for `PATCH /api/voice/data/:recordId`.
   *
   * WHY A PATCH AND NOT A FIELD ON THE TRANSCRIBE REPLY. The correction does not exist when the
   * transcription is answered: the user edits the box afterwards, and may send much later or not at
   * all. The record id returned by `transcribe` is the handle that lets the two moments be joined,
   * and this is the write that closes the loop.
   *
   * A MISS IS THE EXPECTED FAILURE, not an error: the ceiling may have evicted the record, or the
   * user may have cleared their data, between the two moments. `404` is the honest answer to a
   * client that asked about a recording that is no longer there, and the client is expected to treat
   * it as "the label was not kept" rather than as a failed send.
   *
   * OPTIONAL LIKE THE STORE ITSELF: the leaf route tests build small doubles that never store
   * anything, and a caller that wired no store has no records to label — which the route answers as
   * the same `404` a vanished record gets.
   */
  labelVoiceData?(input: {
    recordId: string;
    finalText: string;
    labels: VoiceDataEditLabel[];
  }): VoiceServiceResult<{ recordId: string }>;
};

//----------------- VOICE DATA RECORDS ------------
/**
 * One `heard → final` pair, as it crosses the wire and as it is persisted.
 *
 * DECLARED HERE RATHER THAN ALONGSIDE THE STORE because it is the request body's shape as much as
 * the record's: the route parses a client's array into exactly this, and the store writes exactly
 * this back out. The producing module is `src/shared/voice/labels/voiceEditLabels.ts`, whose `VoiceEditLabel` is
 * this type plus the closed `op` vocabulary; the backend keeps `op` a string deliberately, because a
 * store that re-judged the client's correction/rewrite call would be a second authority on a
 * decision made where the segment text and the box were both in hand.
 */
export type VoiceDataEditLabel = {
  /** The ordinal of the speech segment this pair came from. */
  segmentIndex: number;
  /** What the recogniser produced, spanning whole tokens. */
  heard: string;
  /** What the user left in the box. Empty for a deletion. */
  final: string;
  /** Which kind of change it was — `replace`/`merge`/`split`/`delete`, or `rewrite`. */
  op: string;
};
//----------------- VOICE CLIENT ASSETS ------------

/**
 * One artifact the browser-side recogniser needs, as the server's readiness reading reports it.
 *
 * `bytes` is `null` until the file is there: an absent file has no length, and writing `0` would
 * collapse "missing" and "empty" into the same reading. `expectedBytes` is the pinned length for the
 * one artifact whose size is part of the contract — the 239 MB checkpoint — and `null` for a file
 * the deployment does not size-check.
 */
export type VoiceClientAssetFile = {
  /** The file name as it must appear in the resolved directory. */
  name: string;
  /** Whether a regular file of this name is present in the resolved directory. */
  present: boolean;
  /** The file's length in bytes, or `null` when it is not there. */
  bytes: number | null;
  /** The length this deployment requires, or `null` when the file has no required length. */
  expectedBytes: number | null;
};

/**
 * The server's reading of the on-device recogniser's provisioning, for `GET /api/voice/client-assets`.
 *
 * It exists so a browser can learn that the checkpoint is absent BEFORE it downloads anything: the
 * client path's failure mode is a first recognition that fetches a quarter of a gigabyte and then
 * cannot run it, and this reading turns that into a sentence naming the file and the directory.
 * `configured` is about the DIRECTORY VARIABLE, `source` names which one supplied the directory, and
 * `ready` is about the FILES inside it — so "no directory at all" and "a directory missing a file"
 * stay distinguishable to whoever has to fix it.
 */
export type VoiceClientAssetsReading = {
  /** Whether a directory variable supplied a directory at all. */
  configured: boolean;
  /** The resolved directory, or `null` when neither variable is set. */
  directory: string | null;
  /** Which variable supplied the directory, or `null` when none did. */
  source: 'VOICE_CLIENT_MODEL_DIR' | 'SENSEVOICE_MODEL_DIR' | null;
  /** The checkpoint's reading. */
  model: VoiceClientAssetFile;
  /** The token list's reading. */
  tokens: VoiceClientAssetFile;
  /** Whether this deployment can serve a browser-side recogniser right now. */
  ready: boolean;
};

/** A servable artifact: the path the route streams, and the number of bytes it holds. */
export type VoiceClientAssetFileRef = {
  path: string;
  size: number;
};

/**
 * The application-service surface behind the client-asset routes.
 *
 * ONE SERVICE FOR THE READING AND THE BYTES, because both are answered from one resolved directory:
 * the readiness route reports what `readiness()` reads, and the two serving routes stream what
 * `resolveModelFile`/`resolveOrtFile` whitelist. Both resolvers answer `null` for a name that is not
 * one of the pinned artifacts, which is what turns directory traversal into a plain 404 instead of a
 * path some later layer would have to sanitise.
 */
export type VoiceClientAssetsService = {
  /** The provisioning reading the authenticated readiness route republishes. */
  readiness(): VoiceClientAssetsReading;
  /** The model directory's file of this name, or `null` when it is not one of the two whitelisted. */
  resolveModelFile(name: string): VoiceClientAssetFileRef | null;
  /** The runtime distribution's file of this name, or `null` when it is not whitelisted. */
  resolveOrtFile(name: string): VoiceClientAssetFileRef | null;
};

// ---------------------------

/**
 * The persistence contract the Voice settings service writes through.
 *
 * Declared as a narrow port rather than imported from the database module so the
 * service can be unit-tested with an in-memory fake, and so the Voice module
 * keeps talking to the database through its public barrel only. The database
 * module's `voiceSettingsDb` is the production implementation.
 */
export type VoiceSettingsStore = {
  getSettings(userId: number): VoiceSettings;
  saveSettings(userId: number, settings: VoiceSettings): void;
};

/**
 * Application-service surface consumed by the Voice settings routes.
 *
 * Kept separate from `VoiceService` because it is a different concern with a
 * different dependency (a settings store rather than an outbound HTTP adapter),
 * and because the transcription service is constructed once at start-up with
 * environment defaults while this one only ever acts on a named user.
 */
export type VoiceSettingsService = {
  /**
   * Reads the authenticated user's stored settings, or the all-empty set when
   * they have never saved any. Synchronous because the store is a local SQLite
   * read on the request path, not a network call.
   */
  getSettings(userId: number): VoiceSettings;
  /**
   * Validates and stores a complete settings document, replacing what was
   * there. Returns `ok: false, status: 400` when a field is the wrong type, too
   * long, or names a backend URL the browser could not call directly — and when a
   * provider-declared endpoint field names an address that provider's own rule does not accept.
   */
  saveSettings(userId: number, input: unknown): VoiceServiceResult<VoiceSettings>;
  /**
   * The same document as it may be sent back over HTTP: every field a provider has declared as ITS
   * OWN credential is replaced by a mask, and every other field is returned verbatim.
   *
   * WHY IT IS A SEPARATE METHOD RATHER THAN WHAT `getSettings` RETURNS. The two readers want
   * opposite things. `getSettings` is the STORAGE face: the route's own health reading and the
   * transcription path have to see the credential as it will be presented upstream, so a masked
   * document there would authenticate with `••••`. `maskForReadback` is the READBACK face, applied
   * at the HTTP boundary and nowhere else, and the split is what makes "the mask exists" and "the
   * wire still carries the plaintext" two readings of one document rather than a contradiction.
   *
   * Which fields are masked is read off the registry's declarations, never off a list here: a
   * provider that declares `credentials.apiKeyField` gets that field masked, a provider that
   * declares nothing (the browser's own backend, whose `apiKey` the client must keep) is untouched.
   * The field is DECLARED by the provider and the mask is applied by this method — that is what
   * keeps one provider's secret from being handled by a rule written for another's.
   */
  maskForReadback(settings: VoiceSettings): VoiceSettings;
};

/**
 * Where one transcription attempt's structured reading goes.
 *
 * WHY A PORT AND NOT `console`. Two reasons, and both are readings rather than taste. A port can be
 * collected by a caller, which is the only way "this line does not contain the key" is checkable at
 * all — against the global console it is a claim about a stream no test can hold. And the process's
 * console is not one writer's to replace: patching `console.log` to intercept one service's lines
 * changes the output of every other module in the process for the duration.
 *
 * The default is resolved INSIDE `createVoiceService` (the injected port wins; `console` is the
 * fallback), so the composition root that wires the service to the process's real output does not
 * have to name this type or pass anything — which is also why the production wiring is unchanged by
 * the seam's existence.
 */
export type VoiceLogPort = {
  info(message: string): void;
  /**
   * Where a failure goes, when the deployment's port keeps the distinction.
   *
   * OPTIONAL, and the optionality is the point rather than an oversight. This port is implemented by
   * `console` and by three test doubles that build a literal with an `info` and stop there; a
   * REQUIRED `warn` would make every one of them incomplete for the sake of a severity one provider
   * prefers. What must not be optional is that the sentence SURVIVES — so a consumer that has a
   * failure to report routes it here when the port keeps a `warn` and through `info` when it does
   * not (`sensevoice-worker.ts`'s own log adapter is the one that does), and no deployment loses a
   * line because its port was written before this field existed.
   */
  warn?(message: string): void;
};

// ---------------------------
//----------------- VOICE USER-IDENTIFIER LEXICON ------------

/**
 * One stored frequency row of the U-source lexicon.
 *
 * `tokenLower` is the lookup key (`canonical` lowercased) and `canonical` is the
 * spelling first seen — the pair is what lets `Cloudpit` and `cloudcli` be one
 * token that still displays a real casing. `firstSeenAt` / `lastSeenAt` are epoch
 * milliseconds supplied by the service's clock, not `CURRENT_TIMESTAMP`, so a
 * caller can pin them. `projectKey` is the path the message was sent from, which
 * scopes the row; the listing sums across projects.
 */
export type VoiceIdentifierRow = {
  tokenLower: string;
  canonical: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  projectKey: string;
};

/**
 * One occurrence to add on the send path: which token, in which project, when.
 *
 * `at` is the epoch-millisecond instant the message was sent. It is carried per
 * entry rather than read from the clock inside the store, so the store stays a
 * pure writer and a criterion can deposit a row at a known instant.
 */
export type VoiceIdentifierIncrement = {
  tokenLower: string;
  canonical: string;
  projectKey: string;
  at: number;
};

/**
 * One row of the lexicon listing: a token, its summed frequency, and when it was
 * last seen. Deliberately carries no sentence and no message id — the API this
 * shape serves returns frequencies, and a field that could hold text is the one
 * thing that must never appear here.
 */
export type VoiceIdentifierListItem = {
  token: string;
  count: number;
  lastSeenAt: number;
};

/**
 * The persistence contract the lexicon service writes through.
 *
 * Declared as a narrow port rather than imported from the database module so the
 * service can be unit-tested with an in-memory fake, and so the Voice module
 * keeps talking to the database through its public barrel only. The database
 * module's `voiceUserIdentifiersDb` is the production implementation.
 */
export type VoiceIdentifierStore = {
  /** Adds one occurrence of each entry's token, creating rows on first sight. */
  incrementTokens(entries: VoiceIdentifierIncrement[]): void;
  /** Replaces the whole table with the derived rows; import's recompute write. */
  replaceAll(entries: VoiceIdentifierRow[]): void;
  /** The most frequent tokens, most frequent first, summed across projects. */
  listTop(limit: number): VoiceIdentifierListItem[];
  /** Empties the lexicon. */
  clear(): void;
  /** How many rows the table holds. */
  countRows(): number;
};

/**
 * One human-written message offered to the cold-start import.
 *
 * `id` is the message's stable identity (its app session id joined with the
 * provider's own message id), used to count a message once even when two reads
 * of the history return it. `projectKey` is the session's project path. `text` is
 * the raw message body — the import applies the same shape, prompt and credential
 * rules the live path does before any token is stored. `at` is the
 * epoch-millisecond timestamp when the transcript carries one.
 */
export type VoiceHumanMessage = {
  id: string;
  projectKey: string;
  text: string;
  at?: number;
};

/**
 * Application-service surface consumed by the Voice lexicon routes and by the
 * automatic recording hook the chat dispatch calls.
 *
 * Kept separate from `VoiceService` because it is a different concern with a
 * different dependency (a token store and a history source rather than an
 * outbound HTTP adapter), and because the recording hook is called on the send
 * path while the read/import surface is called on the request path.
 */
export type VoiceLexiconService = {
  /**
   * Records the identifier-shaped tokens of one message the user just sent.
   *
   * Credential-style messages and injected prompts contribute nothing — the same
   * rules the import applies, so a token can never enter through the live path
   * that the offline path would have refused.
   */
  observeSentText(text: string, projectKey: string): void;
  /**
   * Recomputes the lexicon from the whole indexed history: a cold start that
   * makes the first day usable. Idempotent — it replaces the table with the
   * derived rows, so running it twice leaves the same counts.
   */
  importFromHistory(): Promise<{ importedMessages: number; tokenCount: number }>;
  /** The most frequent tokens, most frequent first, capped at `limit`. */
  list(limit: number): VoiceIdentifierListItem[];
  /** Empties the lexicon. */
  clear(): void;
};

