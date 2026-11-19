/**
 * The session digest's second tier (LLM) settings: the shipped defaults, the ONE environment
 * entry (`SERVER_SETTINGS_PATH`, the same contract `server/modules/settings/server-settings.ts`
 * reads), and a reader that re-reads the file whenever its modification time changes.
 *
 * WHERE THE BLOCK LIVES. The task's independent block is `observation.sessionDigest` in the
 * SERVER settings file — the same deployment-editable file that already carries
 * `observation.wallLimit`. This reader owns that block alone; the server-settings loader keeps
 * ignoring it (unknown keys are ignored), so the two readers can land independently.
 *
 * WHAT IS REUSED, NOT COPIED. A digest call is an ordinary chat completion, so the gateway
 * (`protocol`, `baseUrl`, `authScheme`, `timeoutMs`, `temperature`, …) and, by default, the key
 * are the reply-suggestions module's. The independent block adds only the knobs that are about
 * THIS tier: `enabled`, `model`, `maxPerHour`, `minTurnChars` and an optional `apiKeyFile`
 * override. That is why no gateway key is duplicated here. The file machinery itself (the `~`
 * expansion, the typed field readers, the key-file grammar and the mtime cache) is
 * `server/shared/settings-file.ts`; this module keeps only the block's schema.
 *
 * THE READING IS NEVER FATAL. A missing file is the normal "feature off" state; a malformed
 * known key falls back to its shipped default and is named in `problems`; an unknown key is
 * ignored. Nothing here throws, because a bad knob must never stop the server or a chat turn.
 *
 * THE KEY IS NEVER REPORTED. The resolved key is kept in memory and never echoed into
 * `problems`, logs or status objects.
 *
 * Consumers: `session-digest-llm.ts` (through the process-wide source it builds) and the tier
 * criterion in `tests/session-digest-llm.test.ts`, which drives the reader over files it owns.
 */
import type { LlmAuthScheme, LlmProtocolName } from '@/modules/llm-gateway/index.js';
import {
  createReplySuggestionsSettingsSource,
  type ReplySuggestionsSettingsSource,
} from '@/modules/reply-suggestions/index.js';
import {
  createServerSettingsSource,
  readBoolean,
  readInteger,
  readString,
  resolveApiKey,
  type SettingsBlockContext,
} from '@/shared/settings-file.js';

/**
 * The environment variable naming the server settings file.
 *
 * Kept as a literal rather than imported from `modules/settings`: `modules/settings` imports
 * the observation barrel, so reaching back into it would close a directory import cycle
 * (AC-394). The string is the contract; the comment is the tie to its owner.
 */
export const SERVER_SETTINGS_PATH_ENV = 'SERVER_SETTINGS_PATH';

/** The shipped `observation.sessionDigest` values, mirrored by the example config. */
const DEFAULT_SESSION_DIGEST = {
  enabled: false,
  model: '',
  maxPerHour: 6,
  minTurnChars: 200,
  apiKeyFile: '',
  /**
   * The digest tier's OWN output ceiling. It must NOT inherit the reply-suggestions 400: a full
   * ask decision (restated question, situation, every option with implications, consequence
   * tags, and the judge's pick + reason) overruns that ceiling and the JSON is truncated mid
   * string. 1200 measured enough for the live quay asks; the knob stays editable per deployment.
   */
  maxOutputTokens: 1200,
} as const;

/** One reading of the tier settings, with every gateway field resolved to a concrete value. */
export type SessionDigestLlmSettings = {
  /** The EFFECTIVE switch: configured on AND a gateway, a model and a key all resolved. */
  enabled: boolean;
  /** What the file asked for, before the effective-switch checks. */
  configuredEnabled: boolean;
  /** The block's model, or the reply-suggestions model when the block leaves it empty. */
  model: string;
  /** The per-process hour ceiling; the tier skips (and says so) once it is reached. */
  maxPerHour: number;
  /** Turns whose readable conclusion is shorter than this are not sent to the model. */
  minTurnChars: number;
  /** The block's own key path, or the empty string to use the reply-suggestions key. */
  apiKeyFile: string;
  protocol: LlmProtocolName;
  baseUrl: string;
  authScheme: LlmAuthScheme;
  disableThinking: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  /** The resolved secret. Never logged, never returned over HTTP. */
  apiKey: string;
  source: 'default' | 'file';
  path: string | null;
  problems: string[];
};

/** The stateful reader both the tier and the criterion use. */
export type SessionDigestLlmSettingsSource = {
  read(): SessionDigestLlmSettings;
};

/**
 * Builds one reading from the already-selected `observation.sessionDigest` block, merging the
 * reply-suggestions gateway settings underneath. `block` is null when the file does not carry
 * the block (or there is no file), which is the shipped-defaults state.
 */
function buildReading(
  block: Record<string, unknown> | null,
  context: SettingsBlockContext,
  reply: ReturnType<ReplySuggestionsSettingsSource['read']>,
  homeDir: string,
): SessionDigestLlmSettings {
  const problems = context.problems;

  const configuredEnabled =
    block === null
      ? DEFAULT_SESSION_DIGEST.enabled
      : readBoolean(block, 'enabled', DEFAULT_SESSION_DIGEST.enabled, problems);
  const blockModel =
    block === null
      ? DEFAULT_SESSION_DIGEST.model
      : readString(block, 'model', DEFAULT_SESSION_DIGEST.model, problems);
  const maxPerHour =
    block === null
      ? DEFAULT_SESSION_DIGEST.maxPerHour
      : readInteger(block, 'maxPerHour', DEFAULT_SESSION_DIGEST.maxPerHour, { minimum: 1, maximum: 1000 }, problems);
  const minTurnChars =
    block === null
      ? DEFAULT_SESSION_DIGEST.minTurnChars
      : readInteger(block, 'minTurnChars', DEFAULT_SESSION_DIGEST.minTurnChars, { minimum: 0, maximum: 100000 }, problems);
  const apiKeyFile =
    block === null
      ? DEFAULT_SESSION_DIGEST.apiKeyFile
      : readString(block, 'apiKeyFile', DEFAULT_SESSION_DIGEST.apiKeyFile, problems);
  const maxOutputTokens =
    block === null
      ? DEFAULT_SESSION_DIGEST.maxOutputTokens
      : readInteger(block, 'maxOutputTokens', DEFAULT_SESSION_DIGEST.maxOutputTokens, { minimum: 1, maximum: 100000 }, problems);

  const model = blockModel.trim() === '' ? reply.upstream.model : blockModel.trim();
  // The reply-suggestions key is an opaque credential; this module keeps its own
  // flat `apiKey` contract, so it reveals the shared value once here.
  const apiKey = apiKeyFile.trim() === '' ? reply.upstream.credential.reveal() : resolveApiKey(apiKeyFile, homeDir, problems);

  const settings: SessionDigestLlmSettings = {
    enabled: false,
    configuredEnabled,
    model,
    maxPerHour,
    minTurnChars,
    apiKeyFile,
    protocol: reply.upstream.protocol,
    baseUrl: reply.upstream.baseUrl,
    authScheme: reply.upstream.authScheme,
    disableThinking: reply.upstream.disableThinking,
    timeoutMs: reply.upstream.timeoutMs,
    maxOutputTokens,
    temperature: reply.generation.temperature,
    apiKey,
    source: context.source,
    path: context.path,
    problems,
  };

  // The effective switch. A block that asks for the tier but cannot name a gateway, a model
  // or a key is treated as OFF, with the missing item named.
  let enabled = configuredEnabled;
  if (enabled) {
    if (settings.baseUrl.trim() === '') {
      problems.push('`observation.sessionDigest` requires a reply-suggestions `baseUrl` when enabled');
      enabled = false;
    }
    if (settings.model.trim() === '') {
      problems.push('`observation.sessionDigest.model` is required when enabled');
      enabled = false;
    }
    if (settings.apiKey === '') {
      problems.push('`observation.sessionDigest` requires an API key (its own `apiKeyFile` or the reply-suggestions key) when enabled');
      enabled = false;
    }
  }
  settings.enabled = enabled;
  return settings;
}

/** The collaborators every reading merges underneath the block. */
type SessionDigestLlmSourceDependencies = {
  /** The home `~` in an `apiKeyFile` expands against. */
  homeDir: string;
  /** The reply-suggestions reader whose gateway and key this tier falls back to. */
  replySource: ReplySuggestionsSettingsSource;
};

/**
 * Builds a stateful reader over the server settings file.
 *
 * `settingsPath` follows the same resolution order as the boot loader: an explicit path, then
 * `SERVER_SETTINGS_PATH`, then `~/.config/cloudpit/server.settings.json`. `replySource` is
 * injectable so a criterion can supply the gateway without touching the operator's files.
 * The file mechanics and the block selection are shared (`createServerSettingsSource`); this
 * declaration names only the two things that are this tier's own — the block and the gateway.
 *
 * Consumers: `session-digest-llm.ts`, the session-ask decision readers and the tier criterion.
 */
export function createSessionDigestLlmSettingsSource(
  options: {
    /** `undefined` = env-or-default, `null` = no file at all, a string = explicitly named. */
    settingsPath?: string | null;
    env?: Record<string, string | undefined>;
    homeDir?: string;
    replySource?: ReplySuggestionsSettingsSource;
  } = {},
): SessionDigestLlmSettingsSource {
  return createServerSettingsSource<SessionDigestLlmSettings, SessionDigestLlmSourceDependencies>({
    block: 'observation.sessionDigest',
    envVar: SERVER_SETTINGS_PATH_ENV,
    settingsPath: options.settingsPath,
    env: options.env,
    homeDir: options.homeDir,
    dependencies: (homeDir) => ({
      homeDir,
      replySource: options.replySource ?? createReplySuggestionsSettingsSource({ homeDir }),
    }),
    parse: (block, context, dependencies) =>
      buildReading(block, context, dependencies.replySource.read(), dependencies.homeDir),
  });
}
