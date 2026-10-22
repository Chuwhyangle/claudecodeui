/**
 * The voice settings and rules contract: the ONE place a voice setting's name, its default, and a
 * voice rule are written down.
 *
 * WHY THIS FILE EXISTS. The same user settings document used to be declared three times — as the
 * browser's `VoiceConfig`, as the server's `VoiceSettings`, and as the store's own field list and
 * empty row — and the Live Voice rules were a table each consumer re-spelled. The nearest working
 * example of the shape this replaces is `shared/asr/asrRegistry.ts`: a contract and its address
 * book in one module that BOTH compiler configurations compile, so the browser and the server read
 * the same declaration instead of keeping two copies of it in step by hand.
 *
 * TWO COMPILER CONFIGURATIONS COMPILE THIS FILE, and that is a machine property rather than a
 * style choice: the root configuration compiles it with `lib: ES2020 + DOM` and
 * `types: ["vite/client"]`, `server/tsconfig.json` compiles it with `lib: ES2022`, NodeNext and
 * `types: ["node"]`. So it may use neither Node built-ins nor ES2021+ library features, and it
 * imports nothing. `npm run typecheck` compiling this one file under both configurations is the
 * reading that says so.
 *
 * WHAT THIS FILE IS NOT. It is a TYPE AND DEFAULTS CONTRACT, not a shared runtime object. The
 * browser keeps its in-memory settings copy and the server keeps its per-connection reading; only
 * the names, the defaults and the rule text are shared. Folding the two runtime faces into one
 * mutable object here would make a settings write in one process observable in the other, which is
 * a different (and wrong) design.
 *
 * The rules section MIRRORS `asrRegistry`'s address-book shape rather than inventing a second
 * registration style: rules register by id, a caller resolves by id, and an unregistered id is
 * `null` rather than a silent default.
 */

// ── the user's voice settings document ──────────────────────────────────────────────────────────

/**
 * The per-user voice settings document, as it is stored and as the browser reads it.
 *
 * THE PROVIDER-OWNED FIELDS ARE OPTIONAL, and that is what lets one declaration serve both ends: a
 * stored row written by an older build carries none of them ("unset"), while the browser's copy is
 * the complete document it saves whole. The six original fields are required because every reader
 * has always read them as strings; the two user-data fields are optional because absent means "the
 * store's own default", which is a different reading from `false` or `0`.
 */
export type VoiceSettings = {
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  /** The recogniser this user selected, as it is spelled in user-level configuration. */
  providerId?: string;
  /** A provider-declared endpoint field: the address a `'proxy-only'` recogniser is reached at. */
  dashscopeEndpoint?: string;
  /** A provider-declared credential field: a key the server holds and the browser must never see. */
  dashscopeApiKey?: string;
  /** A provider-declared model field: the model the user selected for that recogniser. */
  dashscopeModel?: string;
  /**
   * The Live Voice realtime relay's own DashScope credential — INDEPENDENT of the voice-input
   * `dashscopeApiKey` above. Server-held, masked on readback.
   */
  liveVoiceDashscopeApiKey?: string;
  /**
   * Whether this user's recordings are KEPT on the machine that runs the server. Only the literal
   * `false` turns recording off, so an absent key records.
   */
  voiceDataRecording?: boolean;
  /** The ceiling, in bytes, on the voice-data directory. Absent means the shipped default. */
  voiceDataMaxBytes?: number;
};

/** The document with every field present — the shape the browser's store holds. */
export type VoiceSettingsDocument = Required<VoiceSettings>;

/**
 * The STRING fields of the document, the ones a blank value means "unset" for.
 *
 * THE TWO USER-DATA FIELDS ARE DELIBERATELY ABSENT: this list drives the trim-and-coerce loops on
 * both ends, and a boolean or a number in it would be a `.trim()` that does not compile. The
 * `satisfies` is what keeps a key added to the type from being silently forgotten here.
 */
export const VOICE_SETTINGS_STRING_FIELDS = [
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
  'liveVoiceDashscopeApiKey',
] as const satisfies readonly (keyof VoiceSettings)[];

/** One string field of the document. */
export type VoiceSettingsStringField = (typeof VOICE_SETTINGS_STRING_FIELDS)[number];

/** The stored document's empty shape: the eleven string fields, all blank. */
export type VoiceSettingsStringDocument = { [K in VoiceSettingsStringField]: string };

/**
 * What a user who has never saved voice settings reads back as, on the server's side.
 *
 * The two user-data fields are absent ON PURPOSE: a document that never named them and one that
 * carries the store's defaults mean the same thing to every reader, and the store applies its own
 * default (recording on, 2 GiB) rather than a value a saved document appears to have chosen.
 */
export const VOICE_SETTINGS_EMPTY_DOCUMENT: VoiceSettingsStringDocument = {
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
  liveVoiceDashscopeApiKey: '',
};

/**
 * The complete document a fresh browser copy starts from.
 *
 * D1's defaults live here rather than in the store's own module because the two ends must agree: a
 * fresh user and a fresh deployment read the same figure, and a change to one of them is a change
 * to the contract rather than to one side of it.
 */
export const VOICE_SETTINGS_DEFAULTS: VoiceSettingsDocument = {
  ...VOICE_SETTINGS_EMPTY_DOCUMENT,
  voiceDataRecording: true,
  voiceDataMaxBytes: 2147483648,
};

/**
 * The longest value each string field accepts, as the server's settings route enforces it.
 *
 * A bound rather than a default, but it belongs to the same declaration: which fields exist, which
 * of them are strings, and how long each may be is one fact about one document, and splitting it
 * across modules is how a field ends up unbounded on one side.
 */
export const VOICE_SETTINGS_MAX_LENGTHS: Readonly<Record<VoiceSettingsStringField, number>> = {
  baseUrl: 2048,
  apiKey: 4096,
  sttModel: 256,
  ttsModel: 256,
  ttsVoice: 256,
  ttsFormat: 64,
  providerId: 128,
  dashscopeEndpoint: 2048,
  dashscopeApiKey: 4096,
  dashscopeModel: 256,
  liveVoiceDashscopeApiKey: 4096,
};

// ── the Live Voice settings-file contract ──────────────────────────────────────────────────────

/**
 * The top-level keys `voice-realtime-settings.ts` reads from its settings file, and reads ONLY.
 *
 * The list is shared because it is a contract with whoever edits that file: a key the loader does
 * not read is ignored, so the set of readable keys has to be one declaration rather than a habit
 * of the module that happens to parse it today. Every key is optional in the file itself.
 */
export const VOICE_REALTIME_SETTINGS_FILE_KEYS = [
  'version',
  'instructions',
  'contextTemplate',
  'turnDetection',
  'omissionFill',
  'announcePhrases',
  'runEndAck',
  'summaryModel',
  'speakerTracking',
] as const;

/** One top-level key of a Live Voice settings file. */
export type VoiceRealtimeSettingsFileKey = (typeof VOICE_REALTIME_SETTINGS_FILE_KEYS)[number];

/** The name `{{…}}` carries in a settings file's `contextTemplate`. */
export const VOICE_REALTIME_CONTEXT_VARIABLE_NAME = 'context';

/** The ONE template variable a settings file may use. Anything else in braces is refused. */
export const VOICE_REALTIME_CONTEXT_VARIABLE = `{{${VOICE_REALTIME_CONTEXT_VARIABLE_NAME}}}`;

// ── the rules address book ─────────────────────────────────────────────────────────────────────

/** A rule's id, as it is requested by a caller. */
export type VoiceRuleId = string;

/** One rule: its id, and the text a consumer injects or renders. */
export type VoiceRule = {
  id: VoiceRuleId;
  text: string;
};

/**
 * The registered rules, in registration order.
 *
 * A registry rather than a table imported by each consumer, for the same reason `asrRegistry` is
 * one: the consumer asks for an id and the owner of the rule registers it, so a second copy of the
 * text cannot be written down by the consumer without replacing the registered one.
 *
 * Registration is idempotent by id: registering the same id again REPLACES the row, so a module
 * re-evaluated by a test runner does not accumulate duplicates and a deliberate override is a
 * one-line call rather than an edit to another module's file.
 */
const REGISTERED_VOICE_RULES: VoiceRule[] = [];

/** Registers a rule, replacing any row already registered under the same id. */
export function registerVoiceRule(rule: VoiceRule): void {
  const existing = REGISTERED_VOICE_RULES.findIndex((candidate) => candidate.id === rule.id);
  if (existing === -1) {
    REGISTERED_VOICE_RULES.push(rule);
  } else {
    REGISTERED_VOICE_RULES[existing] = rule;
  }
}

/** The registered rules, in registration order. */
export function listVoiceRules(): readonly VoiceRule[] {
  return REGISTERED_VOICE_RULES;
}

/** The rule registered under `id`, or `null` when nothing claims it. Never a default. */
export function tryResolveVoiceRule(id: VoiceRuleId): VoiceRule | null {
  return REGISTERED_VOICE_RULES.find((rule) => rule.id === id) ?? null;
}

// ── the voice-rules port: the process's installed rules reader ────────────────────────────────

/**
 * The two voice-realtime functions the resident dispatch hook needs.
 *
 * `isSessionActive` is the process-state read of whether a session is in Live Voice, and `rulesFor`
 * selects the rules text. Naming them as a port is what keeps the Claude provider from importing
 * the voice-realtime module — a cycle the dispatch hook used to close.
 */
export type VoiceRulesPort = {
  isSessionActive(sessionId: string): boolean;
  rulesFor(variant: string | undefined): string;
};

/** The installed voice rules, or null before the voice-realtime module evaluates. */
let installedVoiceRules: VoiceRulesPort | null = null;

/** Installs the process's voice-rules reader. Re-installing the same object is a no-op. */
export function installVoiceRules(port: VoiceRulesPort): void {
  installedVoiceRules = port;
}

/**
 * Reads the installed voice rules, or null when the voice-realtime module has not been loaded in
 * this process. Null is the documented "no Live Voice connection" answer.
 */
export function readVoiceRules(): VoiceRulesPort | null {
  return installedVoiceRules;
}
