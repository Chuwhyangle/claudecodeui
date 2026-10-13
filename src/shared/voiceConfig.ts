/**
 * The user's voice backend settings, loaded from and saved to the server.
 *
 * These were plain localStorage readers, which meant the API key sat in
 * plaintext browser storage and — because localStorage is per origin — was lost
 * the moment the app was opened on another port, device or profile. The server
 * is now the source of truth and this module keeps the single in-memory copy
 * that `shared/api.ts` and the Settings tab read synchronously.
 *
 * It is deliberately still synchronous to read: `transcribeVoice` and
 * `useVoiceAvailable` decide "call the user's own backend, or fall back to the
 * proxy" from `readVoiceConfig()`, and a promise they could not await would
 * make that decision from a half-loaded copy. Callers that are about to *send*
 * something wait on `whenVoiceConfigReady()` first.
 *
 * The key is still handed to the browser at runtime — the user's own backend is
 * called directly, so the browser has to hold the credential. What this module
 * removes is the key persisting in browser storage and the settings dying with
 * the origin.
 */

// The client provider's id is taken from the REGISTRY, not from the adapter module directly. This
// module is entered before the registry on some paths (it is an import of `shared/api.ts`), and the
// adapter reaches back into the registry, so importing the adapter here would enter it first and
// leave the registry reading a binding that is still uninitialised.
import { clientAsrProviderId } from '@shared/asr/asrRegistry';
import { getStoredAuthToken } from '@/shared/authToken';
import { api } from '@/shared/api';

export type VoiceConfig = {
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  /**
   * The recogniser the user selected, and the fields that recogniser declared as its own.
   *
   * THEY ARE PART OF THIS DOCUMENT RATHER THAN A STORE OF THEIR OWN, and that is the whole
   * point: the settings are saved as ONE document (`flushServerWrite` sends the whole thing,
   * never a patch), so a field the client does not know about is a field the next save deletes —
   * the server reads an absent one as the empty string. Listing them here is what makes the
   * settings page's own writes preserve them, and it is the same reason the client has to know
   * the names at all: the form is what a user types them into.
   *
   * The three `dashscope*` names are the ones the recogniser in this checkout declares (see the
   * health payload's `credentialFields`), not a table the client keeps: which of them the form
   * shows is decided by the selected provider's own declaration. The names are fixed here because
   * the STORAGE is fixed here — one document, one set of columns — while the form is not.
   */
  providerId: string;
  dashscopeEndpoint: string;
  dashscopeApiKey: string;
  dashscopeModel: string;
  /**
   * Whether this user's recordings are KEPT on the machine that runs the server (D1).
   *
   * THE USER-DATA SWITCH, and the other half of the promise the settings page shows: default ON,
   * stored with the rest of this one document, and turned off by the user alone. It is a BOOLEAN
   * rather than a header like the fields above because nothing about it configures a backend — it
   * decides whether the server writes a record for a transcription at all.
   */
  voiceDataRecording: boolean;
  /**
   * How many bytes of recordings are kept before the store evicts the oldest.
   *
   * A NUMBER the form edits and the store enforces. The default is the store's own shipped ceiling
   * (2 GiB), so a user who never touched it reads the same figure the server would apply by
   * default. It is not a `VOICE_CONFIG_FIELDS` member: that list is the string fields whose blank
   * value means "unset", while this one is always a number.
   */
  voiceDataMaxBytes: number;
};

/** The localStorage key the six fields lived under before they moved server-side. */
export const VOICE_CONFIG_STORAGE_KEY = 'voiceConfig';

/** Emitted on write, so open voice consumers re-read in the same tab. */
export const VOICE_CONFIG_SYNC_EVENT = 'voice-config:sync';

export const VOICE_CONFIG_DEFAULTS: VoiceConfig = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
  // D1: recording on, at the store's own 2 GiB ceiling. The two figures live beside the store's
  // defaults rather than being invented here — a fresh user and a fresh deployment agree.
  voiceDataRecording: true,
  voiceDataMaxBytes: 2147483648,
};

/**
 * The STRING fields of the document, the ones a blank value means "unset" for.
 *
 * THE TWO USER-DATA FIELDS ARE DELIBERATELY ABSENT, and the `satisfies` below is what keeps that
 * honest: this list drives `isEmptyConfig` and `readVoiceConfigField`, both of which call `.trim()`
 * on the values they read, so a boolean in it would not compile. The union derived from it is the
 * set of fields `coerceConfig` and `updateVoiceConfig` treat as strings; the typed fields are read
 * and written beside that loop.
 */
const VOICE_CONFIG_FIELDS = [
  'baseUrl',
  'apiKey',
  'sttModel',
  'ttsModel',
  'ttsVoice',
  'ttsFormat',
  'providerId',
  'dashscopeEndpoint',
  'dashscopeApiKey',
  'dashscopeModel',
] as const satisfies readonly (keyof VoiceConfig)[];

/**
 * Long enough to collapse typing in the settings fields into one request,
 * short enough that closing the tab right after an edit rarely loses it.
 */
const SERVER_WRITE_DEBOUNCE_MS = 400;

let config: VoiceConfig = { ...VOICE_CONFIG_DEFAULTS };
let hasHydrated = false;
let hydrationRequest: Promise<void> | null = null;
/** Which session the in-memory copy belongs to, so a user switch can be noticed. */
let hydratedForToken: string | null = null;
let pendingWriteTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The deployment's raw (pre-VAD) capture switch, and the once-per-token read that answers it.
 *
 * IT IS NOT PART OF `VoiceConfig`. That document is the user's own backend settings and is saved
 * whole back to the server; this is a READ-ONLY fact about the PROCESS's environment, so folding it
 * into the saved document would make a save carry a field the user never chose. It lives here only
 * because this module already owns the once-per-session-token read the value needs.
 *
 * `false` until a server answer arrives, which is the safe reading: an unresolved capability must
 * never make the recording path upload pre-VAD audio — the audio a VAD deliberately removed is more
 * sensitive than what it kept, so "unknown" has to mean "do not send".
 */
let rawCaptureEnabled = false;
let rawCaptureToken: string | null = null;
let rawCaptureRequest: Promise<void> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/** Reads any loose value as a complete config, treating non-strings as unset. */
function coerceConfig(value: unknown): VoiceConfig {
  if (!isRecord(value)) {
    return { ...VOICE_CONFIG_DEFAULTS };
  }

  const next = { ...VOICE_CONFIG_DEFAULTS };
  for (const field of VOICE_CONFIG_FIELDS) {
    if (typeof value[field] === 'string') {
      next[field] = value[field];
    }
  }
  // The typed fields, read beside the string loop rather than inside it: a server that omitted the
  // recording switch — an older deployment, or a document saved before it existed — leaves the
  // default ON, which is the same reading the store itself gives an absent key. A value of the
  // wrong type is discarded rather than coerced, exactly as a non-string field is above.
  if (typeof value.voiceDataRecording === 'boolean') {
    next.voiceDataRecording = value.voiceDataRecording;
  }
  if (typeof value.voiceDataMaxBytes === 'number' && Number.isFinite(value.voiceDataMaxBytes)) {
    next.voiceDataMaxBytes = value.voiceDataMaxBytes;
  }
  return next;
}

/** True when every field is blank — the shape a user who never saved anything sees. */
function isEmptyConfig(candidate: VoiceConfig): boolean {
  return VOICE_CONFIG_FIELDS.every((field) => !candidate[field].trim());
}

function readCurrentToken(): string | null {
  try {
    return getStoredAuthToken();
  } catch {
    // No localStorage (or an unreadable one): treat the session as unknown and
    // let hydration run; the request itself will decide what it gets.
    return null;
  }
}

function applyConfig(next: VoiceConfig): void {
  config = { ...next };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
  }
}

/**
 * Reads the pre-server `voiceConfig` key, or null when it is not there.
 *
 * A migration *source* only: this module never writes it back, which is what
 * guarantees no API key survives in browser storage once a load has succeeded.
 * A key holding anything other than an object is reported as present-but-empty
 * so the caller can delete it rather than keep re-reading it.
 */
function readLegacyVoiceConfig(): VoiceConfig | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(VOICE_CONFIG_STORAGE_KEY);
  } catch {
    return null;
  }

  if (raw === null) {
    return null;
  }

  try {
    return coerceConfig(JSON.parse(raw));
  } catch {
    return { ...VOICE_CONFIG_DEFAULTS };
  }
}

/** Removes the legacy key. Called only once its contents are safely on the server. */
function clearLegacyVoiceConfig(): void {
  try {
    localStorage.removeItem(VOICE_CONFIG_STORAGE_KEY);
  } catch {
    // The setting itself is already server-side; a locked-down localStorage must
    // not turn that into a failed request.
  }
}

/**
 * Reads the current settings.
 *
 * Returns its own object every time, because callers treat it as a value and a
 * shared reference would let one of them edit the live configuration.
 */
export function readVoiceConfig(): VoiceConfig {
  return { ...config };
}

/**
 * Whether the user's selected recogniser is the one that runs in this browser.
 *
 * THE ENABLE SWITCH FOR THE CLIENT PATH IS THE PROVIDER SELECTION, not a new field. A boolean in
 * this document would have to travel to the server and back (the store validates the document
 * field-by-field, so a field the server does not know is dropped on the next save), and it would be a
 * second answer to a question `providerId` already answers: a user who selects the on-device
 * recogniser has enabled it, and one who selects another has not. What the field would NOT have
 * carried is the one thing that makes this a helper rather than a comparison at each call site — the
 * ID ITSELF, still written in one place (the adapter's own `id`) and handed out by the registry as
 * `clientAsrProviderId()` rather than copied into this file. A second copy of that string would be
 * exactly the kind of fact that goes stale silently.
 */
export function isVoiceClientAsrSelected(): boolean {
  return readVoiceConfig().providerId === clientAsrProviderId();
}

/**
 * The localStorage key the FALLBACK recogniser's id is kept under.
 *
 * WHY THIS IS NOT A FIELD OF THE DOCUMENT ABOVE, which is the question the whole design turns on.
 * Every other setting here is a server-side document, saved as one whole object: a field the server's
 * store does not validate is dropped on the next save, so a new field means a new column, a
 * migration and a schema change on the server. What this setting IS is the answer to "where does a
 * clip go when the recogniser the user chose cannot take it" — a property of THIS BROWSER's choice,
 * meaningful only where the client recogniser is selected, and read at exactly one moment (a give-up)
 * by exactly one process (this tab). Sending it to the server would make it a deployment-wide fact
 * a second browser would then disagree with.
 */
export const VOICE_FALLBACK_STORAGE_KEY = 'voice-client-asr-fallback';

/**
 * The recogniser the user chose to fall back to, or `null` when they have not chosen one.
 *
 * `null` MEANS "NO CHOICE MADE", NOT "NO FALLBACK": the resolver that reads this has a default of its
 * own (see `resolveVoiceFallbackProvider`), and collapsing the two here would make a user who never
 * opened the settings panel indistinguishable from one who deliberately picked nothing.
 */
export function readVoiceFallbackPreference(): string | null {
  try {
    return localStorage.getItem(VOICE_FALLBACK_STORAGE_KEY);
  } catch {
    // No localStorage (a locked-down profile, an insecure context): there is no stored choice, and the
    // resolver's own default is the answer. Not an error — the preference is an override, not state.
    return null;
  }
}

/** Remembers the fallback recogniser, or forgets it when given the empty string. */
export function writeVoiceFallbackPreference(providerId: string): void {
  const id = providerId.trim();
  try {
    if (id === '') localStorage.removeItem(VOICE_FALLBACK_STORAGE_KEY);
    else localStorage.setItem(VOICE_FALLBACK_STORAGE_KEY, id);
  } catch {
    // The choice cannot be kept across reloads; it still applies to this session's uploads, which is
    // the visible behaviour. Failing loudly here would break a settings panel over a preference.
  }
}

/**
 * Whether `field` is one of the names this module stores.
 *
 * Exposed for the settings form, whose field names come from a provider's declaration rather than
 * from this type: a server whose registry declares a field this build does not store has to be
 * told apart from one declaring a field it does, because rendering an input whose edits are
 * dropped by the whole-document save is worse than not rendering it — the user would watch their
 * key disappear on the next reload with nothing to explain it.
 */
export function isVoiceConfigField(field: string): field is keyof VoiceConfig {
  return (VOICE_CONFIG_FIELDS as readonly string[]).includes(field);
}

/**
 * Reads one named field, for a caller whose field name came from a declaration.
 *
 * A name this module does not store reads as the empty string rather than as undefined, so a form
 * binding it renders an empty input instead of an uncontrolled one.
 */
export function readVoiceConfigField(candidate: VoiceConfig, field: string): string {
  const value = (candidate as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

/**
 * True once the server's copy has been read at least one time this session.
 *
 * Exposed so a caller can tell "the user configured nothing" apart from "the
 * answer has not arrived yet" without awaiting.
 */
export function hasHydratedVoiceConfig(): boolean {
  return hasHydrated;
}

/** Makes `value` the settings, and pushes the whole document to the server. */
function writeAndPersist(next: VoiceConfig): void {
  applyConfig(next);
  queueServerWrite();
}

/**
 * Applies a patch from the Settings tab and schedules the save.
 *
 * Only string fields are accepted, so a stray `undefined` from a partially
 * built patch cannot blank a field the user did not touch.
 */
export function updateVoiceConfig(patch: Partial<VoiceConfig>): void {
  const next = { ...config };
  for (const field of VOICE_CONFIG_FIELDS) {
    const value = patch[field];
    if (typeof value === 'string') {
      next[field] = value;
    }
  }
  // The recording switch and the capacity, applied only when the patch carries the right type: a
  // stray `undefined` from a partially built patch must not blank a field the user did not touch,
  // which is the same rule the string loop above follows. The capacity is required to be a positive
  // finite number here so a form mid-edit cannot store a zero the store would then re-normalise.
  if (typeof patch.voiceDataRecording === 'boolean') {
    next.voiceDataRecording = patch.voiceDataRecording;
  }
  if (
    typeof patch.voiceDataMaxBytes === 'number' &&
    Number.isFinite(patch.voiceDataMaxBytes) &&
    patch.voiceDataMaxBytes > 0
  ) {
    next.voiceDataMaxBytes = patch.voiceDataMaxBytes;
  }
  writeAndPersist(next);
}

function queueServerWrite(): void {
  if (pendingWriteTimer !== null) {
    clearTimeout(pendingWriteTimer);
  }
  pendingWriteTimer = setTimeout(() => {
    pendingWriteTimer = null;
    void flushServerWrite();
  }, SERVER_WRITE_DEBOUNCE_MS);
}

async function flushServerWrite(): Promise<void> {
  const snapshot = { ...config };
  try {
    const response = await api.voice.saveConfig(snapshot);
    if (!response.ok) {
      // A refused save is not a saved setting. The in-memory copy is right and
      // the legacy key — if this was the migration's own write — stays behind so
      // a later load can retry it.
      console.error(`Failed to save voice settings (${response.status}).`);
      return;
    }
    // The values are server-side now, so the migration source is spent.
    clearLegacyVoiceConfig();
  } catch (error) {
    // The in-memory copy is already right, and the next edit re-sends the whole
    // document, so a dropped save costs this change rather than the setting.
    console.error('Failed to save voice settings:', error);
  }
}

/** Reads the server's copy, or null when the request did not produce one. */
async function loadServerConfig(): Promise<VoiceConfig | null> {
  try {
    const response = await api.voice.config();
    if (!response.ok) {
      return null;
    }
    return coerceConfig(await response.json());
  } catch (error) {
    console.error('Failed to load voice settings:', error);
    return null;
  }
}

/**
 * Adopts the server's copy as the source of truth, importing the legacy
 * localStorage key on the one load where the server has nothing yet.
 *
 * Never rejects: a failed hydration must degrade to "no server configuration",
 * not to a rejected promise on the voice-call path.
 */
async function runHydration(): Promise<void> {
  const serverConfig = await loadServerConfig();
  if (serverConfig === null) {
    // The server never answered. Whatever is in memory stays; the legacy key is
    // left alone so the next load can retry importing it.
    return;
  }

  if (!isEmptyConfig(serverConfig)) {
    // The server already knows this user's settings, so they win — including
    // over a legacy key on this device, which would otherwise push this
    // profile's older values over the ones saved somewhere else.
    clearLegacyVoiceConfig();
    applyConfig(serverConfig);
    return;
  }

  const legacyConfig = readLegacyVoiceConfig();
  if (legacyConfig === null) {
    applyConfig(serverConfig);
    return;
  }

  if (isEmptyConfig(legacyConfig)) {
    // Present but unusable (blank, or JSON that is not a settings object).
    clearLegacyVoiceConfig();
    applyConfig(serverConfig);
    return;
  }

  try {
    const response = await api.voice.saveConfig(legacyConfig);
    if (!response.ok) {
      throw new Error(`the server answered ${response.status}`);
    }
    clearLegacyVoiceConfig();
  } catch (error) {
    // The key stays behind so a later load can retry the import. The values are
    // still adopted in memory, so voice keeps working in the meantime.
    console.error('Failed to import legacy voice settings:', error);
  }
  applyConfig(legacyConfig);
}

/**
 * Loads the settings for the current session, at most one request at a time.
 *
 * Safe to call from anywhere and more than once: concurrent callers share the
 * in-flight request, and once it has settled the copy is only re-fetched when
 * the session it belongs to changes.
 */
export function hydrateVoiceConfig(): Promise<void> {
  if (hydrationRequest) {
    return hydrationRequest;
  }

  const token = readCurrentToken();
  const request = runHydration()
    .then(
      () => undefined,
      (error: unknown) => {
        console.error('Failed to hydrate voice settings:', error);
      },
    )
    .finally(() => {
      hydrationRequest = null;
      hasHydrated = true;
      hydratedForToken = token;
    });

  hydrationRequest = request;
  return request;
}

/**
 * Resolves once the settings for the session that is active *now* are loaded.
 *
 * A voice call awaits this before choosing between the user's own backend and
 * the proxy: reading an un-hydrated copy would look exactly like "no backend
 * configured" and quietly route the recording through the server instead of the
 * endpoint the user set up.
 *
 * A session change — a second user signing in on this tab, or the first one
 * signing out — discards the in-memory copy first, so nothing can read or send
 * the previous user's key while the new fetch is in flight.
 */
export function whenVoiceConfigReady(): Promise<void> {
  const token = readCurrentToken();
  if (hasHydrated && hydratedForToken === token) {
    return Promise.resolve();
  }

  if (hasHydrated) {
    applyConfig({ ...VOICE_CONFIG_DEFAULTS });
    hasHydrated = false;
  }

  return hydrateVoiceConfig();
}

/**
 * Drops the in-memory copy, so a different user on this device never starts out
 * holding the previous user's key. Awaited by nothing: the next
 * `whenVoiceConfigReady()` re-fetches for whoever is signed in.
 */
export function resetVoiceConfig(): void {
  if (pendingWriteTimer !== null) {
    clearTimeout(pendingWriteTimer);
    pendingWriteTimer = null;
  }
  config = { ...VOICE_CONFIG_DEFAULTS };
  hasHydrated = false;
  hydratedForToken = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
  }
}

/**
 * Reads the cached raw-capture switch. `false` until `hydrateVoiceRawCapture` has a server answer.
 */
export function isVoiceRawCaptureEnabled(): boolean {
  return rawCaptureEnabled;
}

/**
 * Loads the deployment's raw-capture switch for the session active now, at most once per token.
 *
 * THE TOKEN KEYING IS THE SAME DISCIPLINE `whenVoiceConfigReady` USES: a second user on this tab gets
 * a fresh read rather than the previous session's answer, and every listen in one session reuses the
 * one answer instead of putting a request in front of each recording. A call for a token already
 * being read returns the in-flight request; a call after it settled returns at once.
 *
 * NEVER REJECTS, for the reason `hydrateVoiceConfig` does not: a failed read has to degrade to "raw
 * capture is off" — the safe reading — rather than to a rejected promise on the recording path.
 */
export function hydrateVoiceRawCapture(): Promise<void> {
  const token = readCurrentToken();
  if (rawCaptureToken === token) {
    return rawCaptureRequest ?? Promise.resolve();
  }

  rawCaptureToken = token;
  rawCaptureEnabled = false;
  const request = loadRawCaptureState().finally(() => {
    if (rawCaptureRequest === request) {
      rawCaptureRequest = null;
    }
  });
  rawCaptureRequest = request;
  return request;
}

/** Reads `GET /api/voice/capture` and records whether this deployment collects raw audio. */
async function loadRawCaptureState(): Promise<void> {
  try {
    const response = await api.voice.capture();
    if (!response.ok) {
      return;
    }
    const body: unknown = await response.json();
    rawCaptureEnabled =
      body !== null && typeof body === 'object' && (body as { raw?: unknown }).raw === true;
  } catch (error) {
    console.error('Failed to load raw capture state:', error);
  }
}

// Headers the voice proxy reads to target a per-user OpenAI-compatible backend.
// Empty fields are omitted so the server's env defaults apply.
export function voiceConfigHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const c = readVoiceConfig();
  const h: Record<string, string> = {};
  if (c.apiKey) h['x-voice-api-key'] = c.apiKey;
  if (c.sttModel) h['x-voice-stt-model'] = c.sttModel;
  if (c.ttsModel) h['x-voice-tts-model'] = c.ttsModel;
  if (c.ttsVoice) h['x-voice-tts-voice'] = c.ttsVoice;
  if (c.ttsFormat.trim()) h['x-voice-tts-format'] = c.ttsFormat.trim();
  return h;
}
