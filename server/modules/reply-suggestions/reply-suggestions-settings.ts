/**
 * The reply-suggestions settings file: the shipped defaults, the ONE environment
 * entry ({@link REPLY_SUGGESTIONS_SETTINGS_PATH_ENV}), and a reader that re-reads
 * the file whenever its modification time changes.
 *
 * WHY A FILE AND NOT ENVIRONMENT KNOBS. The model, gateway, temperatures and caps
 * are the things an operator tunes while trying this feature out. They live behind
 * a named file so that an edit reaches the NEXT request without a restart or a
 * rebuild; the environment carries only the file's LOCATION. There is deliberately
 * no second spelling of any knob in the environment. The FILE FORMAT is flat (see
 * `config/reply-suggestions.settings.example.json`); the grouping below happens
 * only in memory, so every existing settings file keeps working unchanged.
 *
 * GROUPED BY RESPONSIBILITY. `upstream` is what a client needs to reach the
 * gateway, `generation` is what shapes the answer, `limits` is the call budget,
 * `usageLog` is the ledger switch and `diagnostics` is what the reader observed
 * (source, path, problems, the configured switch and where the key was named).
 * A consumer takes the one group it needs instead of picking fields out of a
 * flat 27-field object.
 *
 * THE KEY IS AN OPAQUE VALUE. `upstream.credential` is an {@link ApiCredential}:
 * its private field holds the secret, only `reveal()` returns it, and `toString`,
 * `toJSON` and `util.inspect` all answer `[redacted]`. A stray `JSON.stringify`,
 * log or `util.inspect` of the whole reading therefore cannot leak it. The key
 * file itself is read while the file is (re)parsed; the value is never echoed
 * into `problems`, logs, status objects or error messages. A key file wider than
 * mode 600 is reported as a problem but is NOT fatal. The file machinery (the `~`
 * expansion, the typed field readers, the key-file grammar and the mtime cache)
 * is `server/shared/settings-file.ts`; this module keeps only the file's schema.
 *
 * THE READING IS NEVER FATAL. A missing file is the normal "feature off" state; a
 * malformed known key falls back to its shipped default and is named in
 * `problems`; an unknown key is ignored. Nothing here throws, because the server
 * must start and serve every other route whatever this file says.
 *
 * Consumers: `reply-suggestions.service.ts` (through `readSettings`),
 * `reply-suggestions.module.ts` (which owns the one source instance),
 * `server/modules/observation/session-digest-llm-settings.ts` (the gateway
 * reading it merges under its own `observation.sessionDigest` block) and the
 * settings criterion in `tests/reply-suggestions-settings.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ApiCredential } from '@/modules/llm-gateway/index.js';
import type { LlmAuthScheme, LlmProtocolName } from '@/modules/llm-gateway/index.js';
import {
  createSettingsBlockSource,
  readBoolean,
  readEnum,
  readNumber,
  readString,
  resolveApiKey,
  resolveSettingsPath,
  writeSettingsFileAtomically,
  type SettingsBlockContext,
} from '@/shared/settings-file.js';
import { AppError } from '@/shared/utils.js';

/**
 * The only environment variable this module reads. It names the settings file.
 *
 * Consumers: the settings criterion in `tests/reply-suggestions-settings.test.ts`
 * (its environment leg) and this reader's own resolution below.
 */
export const REPLY_SUGGESTIONS_SETTINGS_PATH_ENV = 'REPLY_SUGGESTIONS_SETTINGS_PATH';

/**
 * The two upstream wire dialects the client supports. The vocabulary lives on the
 * gateway leaf now; this alias keeps the feature's settings type readable.
 *
 * Consumers: `reply-suggestions-usage-log.ts` (the shown row's `protocol`) and
 * `reply-suggestions-client.ts` (through the gateway's `LlmClientConfig`).
 */
export type ReplySuggestionsProtocol = LlmProtocolName;

/**
 * How the API key travels. The empty string means "the protocol's default":
 * `x-api-key` for anthropic, `bearer` for openai.
 *
 * Consumers: `reply-suggestions-client.ts`'s request type (through the gateway's
 * `LlmClientConfig`).
 */
export type ReplySuggestionsAuthScheme = LlmAuthScheme;

/** The experimental expansion switch; `vary` is parsed and surfaced, not implemented here. */
type ReplySuggestionsExpansion = 'off' | 'vary';

/**
 * The opaque key value object, re-exported under its historical path so the rest of
 * this module and its criterion keep importing it from here. Its implementation —
 * `reveal()` as the only accessor, `[redacted]` for `toString`/`toJSON`/`inspect` —
 * lives on the gateway leaf.
 *
 * Consumers: the settings criterion (`new ApiCredential('sk-standalone')`) and
 * `reply-suggestions-client.ts`'s config type.
 */
export { ApiCredential };

/** Everything a client needs to reach the gateway; the client receives exactly this group.
 *
 * Consumers: `reply-suggestions-client.ts` (its `ReplySuggestionsClientConfig`
 * alias) and `reply-suggestions-draw.ts` (the completion request's `config`).
 */
export type ReplySuggestionsUpstream = {
  protocol: ReplySuggestionsProtocol;
  baseUrl: string;
  model: string;
  authScheme: ReplySuggestionsAuthScheme;
  credential: ApiCredential;
  disableThinking: boolean;
  timeoutMs: number;
};

/** Everything that shapes the answer: decoding knobs, chip budgets and the prompt. */
type ReplySuggestionsGeneration = {
  temperature: number;
  redrawTemperature: number;
  maxOutputTokens: number;
  maxChips: number;
  maxChipChars: number;
  maxTailChars: number;
  maxFocusChars: number;
  systemPrompt: string;
  expansion: ReplySuggestionsExpansion;
};

/** The sliding-window call budget the upstream guard enforces.
 *
 * Consumers: `reply-suggestions-guard.ts` (the `run` signature) and, through the
 * settings reading, `reply-suggestions.service.ts`.
 */
export type ReplySuggestionsLimits = {
  maxCallsPerMinute: number;
  maxCallsPerDay: number;
};

/** What the reader observed while producing this reading. */
type ReplySuggestionsDiagnostics = {
  source: 'default' | 'file';
  path: string | null;
  problems: string[];
  /** What the file asked for, before the effective-switch checks. */
  configuredEnabled: boolean;
  apiKeyFile: string;
  apiKeyVar: string;
};

/**
 * One reading of the settings file, grouped by responsibility and with every
 * known key resolved to a value (the shipped default when the file omitted or
 * invalidated it). `enabled` is the EFFECTIVE switch: a file that says true but
 * leaves `baseUrl`, `model` or the credential unresolved reads as disabled and
 * names the missing item in `diagnostics.problems`.
 *
 * Consumers: `reply-suggestions.service.ts`, `reply-suggestions-draw.ts` (the
 * `upstream`/`generation` groups), the observation settings reader (through the
 * source's return type), the settings criterion and the service criterion.
 */
export type ReplySuggestionsSettings = {
  version: string;
  enabled: boolean;
  upstream: ReplySuggestionsUpstream;
  generation: ReplySuggestionsGeneration;
  limits: ReplySuggestionsLimits;
  usageLog: boolean;
  /**
   * The OPT-IN local debug ledger switch: when true, each draft-rewrite attempt writes its full
   * draft and candidate to `~/.cloudpit/reply-suggestions-debug.jsonl`. Default false. It adds
   * no path/size/retention knob — the debug-log writer's rotation is the only policy.
   */
  debugLog: boolean;
  diagnostics: ReplySuggestionsDiagnostics;
};

/** The shipped defaults, mirrored by `config/reply-suggestions.settings.example.json`. */
const DEFAULT_SETTINGS = {
  version: 'example-1',
  enabled: false,
  protocol: 'anthropic',
  baseUrl: '',
  model: '',
  authScheme: '',
  apiKeyFile: '',
  apiKeyVar: '',
  disableThinking: true,
  temperature: 0.3,
  redrawTemperature: 1.0,
  maxOutputTokens: 2000,
  timeoutMs: 5000,
  maxChips: 3,
  maxChipChars: 120,
  maxTailChars: 1500,
  maxFocusChars: 600,
  maxCallsPerMinute: 30,
  maxCallsPerDay: 3000,
  expansion: 'off',
  usageLog: true,
  debugLog: false,
  systemPrompt: '',
} as const;

const PROTOCOLS: readonly ReplySuggestionsProtocol[] = ['anthropic', 'openai'];
const AUTH_SCHEMES: readonly ReplySuggestionsAuthScheme[] = ['', 'x-api-key', 'bearer'];
const EXPANSIONS: readonly ReplySuggestionsExpansion[] = ['off', 'vary'];

/**
 * The default location of the local copy. Development points the one environment
 * entry at `config/reply-suggestions.settings.json` instead; this path is what an
 * installed deployment uses without any environment at all.
 */
function defaultSettingsPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'claudecodeui', 'reply-suggestions.settings.json');
}

/**
 * Parse one settings document into a reading. Never throws: an unreadable or
 * malformed file yields the defaults with the reason in `problems`.
 *
 * The shared source selects the document itself (this file is flat) and hands it
 * here as `block`; a null block means the file was missing or unparseable, and
 * `context.problems` already carries the reason.
 */
function parseSettings(
  block: Record<string, unknown> | null,
  context: SettingsBlockContext,
  homeDir: string,
): ReplySuggestionsSettings {
  const record = block ?? {};
  const problems = context.problems;

  const settings: ReplySuggestionsSettings = {
    version: readString(record, 'version', DEFAULT_SETTINGS.version, problems),
    enabled: false,
    upstream: {
      protocol: readEnum(record, 'protocol', PROTOCOLS, DEFAULT_SETTINGS.protocol, problems),
      baseUrl: readString(record, 'baseUrl', DEFAULT_SETTINGS.baseUrl, problems),
      model: readString(record, 'model', DEFAULT_SETTINGS.model, problems),
      authScheme: readEnum(record, 'authScheme', AUTH_SCHEMES, DEFAULT_SETTINGS.authScheme, problems),
      credential: new ApiCredential(''),
      disableThinking: readBoolean(record, 'disableThinking', DEFAULT_SETTINGS.disableThinking, problems),
      timeoutMs: readNumber(record, 'timeoutMs', DEFAULT_SETTINGS.timeoutMs, { minimum: 1, maximum: 120000, integer: true }, problems),
    },
    generation: {
      temperature: readNumber(record, 'temperature', DEFAULT_SETTINGS.temperature, { minimum: 0, maximum: 2, integer: false }, problems),
      redrawTemperature: readNumber(record, 'redrawTemperature', DEFAULT_SETTINGS.redrawTemperature, { minimum: 0, maximum: 2, integer: false }, problems),
      maxOutputTokens: readNumber(record, 'maxOutputTokens', DEFAULT_SETTINGS.maxOutputTokens, { minimum: 1, maximum: 8192, integer: true }, problems),
      maxChips: readNumber(record, 'maxChips', DEFAULT_SETTINGS.maxChips, { minimum: 1, maximum: 10, integer: true }, problems),
      maxChipChars: readNumber(record, 'maxChipChars', DEFAULT_SETTINGS.maxChipChars, { minimum: 1, maximum: 2000, integer: true }, problems),
      maxTailChars: readNumber(record, 'maxTailChars', DEFAULT_SETTINGS.maxTailChars, { minimum: 1, maximum: 100000, integer: true }, problems),
      maxFocusChars: readNumber(record, 'maxFocusChars', DEFAULT_SETTINGS.maxFocusChars, { minimum: 0, maximum: 100000, integer: true }, problems),
      systemPrompt: readString(record, 'systemPrompt', DEFAULT_SETTINGS.systemPrompt, problems),
      expansion: readEnum(record, 'expansion', EXPANSIONS, DEFAULT_SETTINGS.expansion, problems),
    },
    limits: {
      maxCallsPerMinute: readNumber(record, 'maxCallsPerMinute', DEFAULT_SETTINGS.maxCallsPerMinute, { minimum: 1, maximum: 100000, integer: true }, problems),
      maxCallsPerDay: readNumber(record, 'maxCallsPerDay', DEFAULT_SETTINGS.maxCallsPerDay, { minimum: 1, maximum: 1000000, integer: true }, problems),
    },
    usageLog: readBoolean(record, 'usageLog', DEFAULT_SETTINGS.usageLog, problems),
    debugLog: readBoolean(record, 'debugLog', DEFAULT_SETTINGS.debugLog, problems),
    diagnostics: {
      source: context.source,
      path: context.path,
      problems,
      configuredEnabled: readBoolean(record, 'enabled', DEFAULT_SETTINGS.enabled, problems),
      apiKeyFile: readString(record, 'apiKeyFile', DEFAULT_SETTINGS.apiKeyFile, problems),
      apiKeyVar: readString(record, 'apiKeyVar', DEFAULT_SETTINGS.apiKeyVar, problems),
    },
  };

  // `version` is the one string key that must not be empty: it exists so an edit
  // is visible in every extraction's log line.
  if (settings.version.trim() === '') {
    problems.push('`version` must be a non-empty string');
    settings.version = DEFAULT_SETTINGS.version;
  }

  const apiKey = resolveApiKey(settings.diagnostics.apiKeyFile, homeDir, problems, {
    apiKeyVar: settings.diagnostics.apiKeyVar,
    warnOnWideMode: true,
  });
  settings.upstream.credential = new ApiCredential(apiKey);

  // The effective switch. A file that asks for the feature but cannot name a
  // gateway, a model or a key is treated as OFF, with the missing item named.
  let enabled = settings.diagnostics.configuredEnabled;
  if (enabled) {
    if (settings.upstream.baseUrl.trim() === '') {
      problems.push('`baseUrl` is required when `enabled` is true');
      enabled = false;
    }
    if (settings.upstream.model.trim() === '') {
      problems.push('`model` is required when `enabled` is true');
      enabled = false;
    }
    if (apiKey === '') {
      problems.push('`apiKeyFile` (with `apiKeyVar`) must resolve to a key when `enabled` is true');
      enabled = false;
    }
  }
  settings.enabled = enabled;
  return settings;
}

/**
 * A stateful settings reader. Each call re-stats the file and re-parses ONLY when
 * its modification time changed; a missing default file reads as "off" with no
 * problems, while a missing EXPLICITLY named file reports the problem.
 *
 * Consumers: `reply-suggestions.module.ts` creates one and hands `read` to the
 * service; `server/modules/observation/session-digest-llm-settings.ts` defaults
 * to one; the settings criterion drives it directly with a temp path.
 */
export type ReplySuggestionsSettingsSource = {
  read(): ReplySuggestionsSettings;
  /**
   * Persist the debug-log switch. This module owns the file path, so it owns the write: the
   * existing document is read, UNKNOWN KEYS ARE KEPT and only `debugLog` changes; the bytes go
   * to a sibling temp file and are renamed over the target (0600), so a reader never sees half
   * a JSON document and the next `read()` picks the change up without a restart.
   *
   * A file that exists but does not parse is REFUSED (a safe {@link AppError}) and left
   * untouched — overwriting it would destroy whatever the operator was editing.
   */
  writeDebugLog(enabled: boolean): boolean;
};

/** A safe, content-free error for a settings write this module refuses. */
function settingsUnwritableError(reason: string): AppError {
  return new AppError(`could not update the reply-suggestions settings file: ${reason}`, {
    code: 'REPLY_SUGGESTIONS_SETTINGS_UNWRITABLE',
    statusCode: 500,
  });
}

/**
 * Build the stateful reader.
 *
 * Consumers: `reply-suggestions.module.ts`, `server/modules/observation/session-digest-llm-settings.ts`
 * and the settings criterion.
 */
export function createReplySuggestionsSettingsSource(
  options: {
    /** `undefined` = env-or-default, `null` = no file at all, a string = explicitly named. */
    settingsPath?: string | null;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  } = {},
): ReplySuggestionsSettingsSource {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const { filePath, explicit } = resolveSettingsPath({
    settingsPath: options.settingsPath,
    env,
    envVar: REPLY_SUGGESTIONS_SETTINGS_PATH_ENV,
    homeDir,
    defaultPath: defaultSettingsPath,
  });

  const source = createSettingsBlockSource({
    settingsPath: filePath,
    homeDir,
    explicit,
    parse: (block, context) => parseSettings(block, context, homeDir),
  });

  return {
    read: () => source.read(),
    writeDebugLog(enabled: boolean): boolean {
      if (filePath === null) {
        throw settingsUnwritableError('no settings file is configured');
      }
      let document: Record<string, unknown> = {};
      if (existsSync(filePath)) {
        let raw: string;
        try {
          raw = readFileSync(filePath, 'utf8');
        } catch {
          throw settingsUnwritableError('the settings file could not be read');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Never echo the parser's message: it can quote file content.
          throw settingsUnwritableError('the settings file is not valid JSON');
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw settingsUnwritableError('the settings file must contain a JSON object');
        }
        document = parsed as Record<string, unknown>;
      }
      const next = { ...document, debugLog: enabled };
      try {
        writeSettingsFileAtomically(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      } catch {
        throw settingsUnwritableError('the settings file could not be written');
      }
      return enabled;
    },
  };
}
