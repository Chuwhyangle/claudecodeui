/**
 * The reply-suggestions settings file: the shipped defaults, the ONE environment
 * entry ({@link REPLY_SUGGESTIONS_SETTINGS_PATH}), and a reader that re-reads the
 * file whenever its modification time changes.
 *
 * WHY A FILE AND NOT ENVIRONMENT KNOBS. The model, gateway, temperatures and caps
 * are the things an operator tunes while trying this feature out. They live behind
 * a named file so that an edit reaches the NEXT request without a restart or a
 * rebuild; the environment carries only the file's LOCATION. There is deliberately
 * no second spelling of any knob in the environment.
 *
 * THE READING IS NEVER FATAL. A missing file is the normal "feature off" state; a
 * malformed known key falls back to its shipped default and is named in
 * `problems`; an unknown key is ignored. Nothing here throws, because the server
 * must start and serve every other route whatever this file says.
 *
 * THE KEY IS THE ONE VALUE THAT IS NEVER REPORTED. `apiKeyFile` is read while the
 * file is (re)parsed, kept only in memory, and never echoed into `problems`,
 * logs, status objects or error messages. A key file wider than mode 600 is
 * reported as a problem but is NOT fatal.
 *
 * Consumers: `reply-suggestions.service.ts` (through `readSettings`) and
 * `reply-suggestions.module.ts` (which owns the one source instance), plus the
 * settings criterion in `tests/reply-suggestions-settings.test.ts`.
 */
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The only environment variable this module reads. It names the settings file. */
export const REPLY_SUGGESTIONS_SETTINGS_PATH_ENV = 'REPLY_SUGGESTIONS_SETTINGS_PATH';

/** The two upstream wire dialects the client supports. */
export type ReplySuggestionsProtocol = 'anthropic' | 'openai';

/**
 * How the API key travels. The empty string means "the protocol's default":
 * `x-api-key` for anthropic, `bearer` for openai.
 */
export type ReplySuggestionsAuthScheme = '' | 'x-api-key' | 'bearer';

/** The experimental expansion switch; `vary` is parsed and surfaced, not implemented here. */
export type ReplySuggestionsExpansion = 'off' | 'vary';

/**
 * One reading of the settings file, with every known key resolved to a value
 * (the shipped default when the file omitted or invalidated it).
 *
 * `enabled` is the EFFECTIVE switch: a file that says true but leaves `baseUrl`,
 * `model` or the key unresolved reads as disabled and names the missing item in
 * `problems`. `apiKey` is the resolved secret and must never be logged or
 * returned over HTTP; `path` names the file that produced this reading.
 */
export type ReplySuggestionsSettings = {
  version: string;
  enabled: boolean;
  configuredEnabled: boolean;
  protocol: ReplySuggestionsProtocol;
  baseUrl: string;
  model: string;
  authScheme: ReplySuggestionsAuthScheme;
  apiKeyFile: string;
  apiKeyVar: string;
  disableThinking: boolean;
  temperature: number;
  redrawTemperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxChips: number;
  maxChipChars: number;
  maxTailChars: number;
  maxFocusChars: number;
  maxCallsPerMinute: number;
  maxCallsPerDay: number;
  expansion: ReplySuggestionsExpansion;
  usageLog: boolean;
  systemPrompt: string;
  apiKey: string;
  source: 'default' | 'file';
  path: string | null;
  problems: string[];
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
  maxOutputTokens: 400,
  timeoutMs: 5000,
  maxChips: 3,
  maxChipChars: 120,
  maxTailChars: 1500,
  maxFocusChars: 600,
  maxCallsPerMinute: 30,
  maxCallsPerDay: 3000,
  expansion: 'off',
  usageLog: true,
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

/** Expand a leading `~` against `homeDir`; any other path is returned unchanged. */
function expandHome(filePath: string, homeDir: string): string {
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/')) return path.join(homeDir, filePath.slice(2));
  return filePath;
}

/** Build a fresh defaults reading (problems empty, path not yet known). */
function defaultSettings(): ReplySuggestionsSettings {
  return {
    ...DEFAULT_SETTINGS,
    configuredEnabled: DEFAULT_SETTINGS.enabled,
    apiKey: '',
    source: 'default',
    path: null,
    problems: [],
  };
}

type ValidationSink = string[];

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
  problems: ValidationSink,
): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    problems.push(`\`${key}\` must be a boolean`);
    return fallback;
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
  problems: ValidationSink,
): string {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    problems.push(`\`${key}\` must be a string`);
    return fallback;
  }
  return value;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds: { minimum: number; maximum: number; integer: boolean },
  problems: ValidationSink,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`\`${key}\` must be a finite number`);
    return fallback;
  }
  if (bounds.integer && !Number.isInteger(value)) {
    problems.push(`\`${key}\` must be an integer`);
    return fallback;
  }
  if (value < bounds.minimum || value > bounds.maximum) {
    problems.push(`\`${key}\` must be between ${bounds.minimum} and ${bounds.maximum}`);
    return fallback;
  }
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  vocabulary: readonly T[],
  fallback: T,
  problems: ValidationSink,
): T {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !(vocabulary as readonly string[]).includes(value)) {
    problems.push(`\`${key}\` must be one of ${vocabulary.map((entry) => `"${entry}"`).join(', ')}`);
    return fallback;
  }
  return value as T;
}

/** Strip one matching pair of surrounding single or double quotes. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

const KEY_ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Resolve the API key from `apiKeyFile` and `apiKeyVar`.
 *
 * The file is either a bare key line or a shell-style `NAME=value` table (an
 * `export` prefix and one pair of single/double quotes are accepted). With
 * `apiKeyVar`, that variable's assignment is the key. Without it, a file holding
 * exactly one assignment contributes that assignment; otherwise the first
 * non-empty, non-comment line wins (as a value when it is an assignment).
 *
 * Every failure is a `problems` entry: the key value itself is NEVER placed in
 * one, and an unreadable key file is not fatal by itself (the effective switch
 * turns off because no key resolved).
 */
function resolveApiKey(
  apiKeyFile: string,
  apiKeyVar: string,
  homeDir: string,
  problems: ValidationSink,
): string {
  if (apiKeyFile.trim() === '') {
    return '';
  }
  const resolvedPath = expandHome(apiKeyFile, homeDir);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    problems.push(`could not read the API key file ${resolvedPath}: ${reason}`);
    return '';
  }

  try {
    const stats = statSync(resolvedPath);
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      problems.push(
        `the API key file ${resolvedPath} has mode ${mode.toString(8)}; 600 is expected because the file holds a secret`,
      );
    }
  } catch {
    // A stat failure after a successful read is not worth a second problem; the
    // read above already decided whether the file is usable.
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  if (lines.length === 0) {
    problems.push(`the API key file ${resolvedPath} is empty`);
    return '';
  }

  const assignments: Array<{ name: string; value: string }> = [];
  for (const line of lines) {
    const match = KEY_ASSIGNMENT.exec(line);
    if (match) assignments.push({ name: match[1], value: unquote(match[2]) });
  }

  if (apiKeyVar.trim() !== '') {
    const selected = assignments.find((assignment) => assignment.name === apiKeyVar);
    if (!selected) {
      problems.push(`the API key file ${resolvedPath} does not assign \`${apiKeyVar}\``);
      return '';
    }
    return selected.value.trim();
  }

  if (assignments.length === 1) {
    return assignments[0].value.trim();
  }

  const firstLine = lines[0];
  const firstMatch = KEY_ASSIGNMENT.exec(firstLine);
  return (firstMatch ? unquote(firstMatch[2]) : unquote(firstLine)).trim();
}

/**
 * Parse one settings file into a reading. Never throws: an unreadable or
 * malformed file yields the defaults with the reason in `problems`.
 */
function readSettingsFile(filePath: string, source: 'default' | 'file', homeDir: string): ReplySuggestionsSettings {
  const base: ReplySuggestionsSettings = {
    ...defaultSettings(),
    source,
    path: filePath,
  };

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    return { ...base, problems: [`could not read ${filePath}: ${reason}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    return { ...base, problems: [`${filePath} is not valid JSON: ${reason}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, problems: [`${filePath} must contain a JSON object`] };
  }

  const record = parsed as Record<string, unknown>;
  const problems: ValidationSink = [];

  const settings: ReplySuggestionsSettings = {
    ...base,
    version: readString(record, 'version', DEFAULT_SETTINGS.version, problems),
    configuredEnabled: readBoolean(record, 'enabled', DEFAULT_SETTINGS.enabled, problems),
    protocol: readEnum(record, 'protocol', PROTOCOLS, DEFAULT_SETTINGS.protocol, problems),
    baseUrl: readString(record, 'baseUrl', DEFAULT_SETTINGS.baseUrl, problems),
    model: readString(record, 'model', DEFAULT_SETTINGS.model, problems),
    authScheme: readEnum(record, 'authScheme', AUTH_SCHEMES, DEFAULT_SETTINGS.authScheme, problems),
    apiKeyFile: readString(record, 'apiKeyFile', DEFAULT_SETTINGS.apiKeyFile, problems),
    apiKeyVar: readString(record, 'apiKeyVar', DEFAULT_SETTINGS.apiKeyVar, problems),
    disableThinking: readBoolean(record, 'disableThinking', DEFAULT_SETTINGS.disableThinking, problems),
    temperature: readNumber(record, 'temperature', DEFAULT_SETTINGS.temperature, { minimum: 0, maximum: 2, integer: false }, problems),
    redrawTemperature: readNumber(record, 'redrawTemperature', DEFAULT_SETTINGS.redrawTemperature, { minimum: 0, maximum: 2, integer: false }, problems),
    maxOutputTokens: readNumber(record, 'maxOutputTokens', DEFAULT_SETTINGS.maxOutputTokens, { minimum: 1, maximum: 8192, integer: true }, problems),
    timeoutMs: readNumber(record, 'timeoutMs', DEFAULT_SETTINGS.timeoutMs, { minimum: 1, maximum: 120000, integer: true }, problems),
    maxChips: readNumber(record, 'maxChips', DEFAULT_SETTINGS.maxChips, { minimum: 1, maximum: 10, integer: true }, problems),
    maxChipChars: readNumber(record, 'maxChipChars', DEFAULT_SETTINGS.maxChipChars, { minimum: 1, maximum: 2000, integer: true }, problems),
    maxTailChars: readNumber(record, 'maxTailChars', DEFAULT_SETTINGS.maxTailChars, { minimum: 1, maximum: 100000, integer: true }, problems),
    maxFocusChars: readNumber(record, 'maxFocusChars', DEFAULT_SETTINGS.maxFocusChars, { minimum: 0, maximum: 100000, integer: true }, problems),
    maxCallsPerMinute: readNumber(record, 'maxCallsPerMinute', DEFAULT_SETTINGS.maxCallsPerMinute, { minimum: 1, maximum: 100000, integer: true }, problems),
    maxCallsPerDay: readNumber(record, 'maxCallsPerDay', DEFAULT_SETTINGS.maxCallsPerDay, { minimum: 1, maximum: 1000000, integer: true }, problems),
    expansion: readEnum(record, 'expansion', EXPANSIONS, DEFAULT_SETTINGS.expansion, problems),
    usageLog: readBoolean(record, 'usageLog', DEFAULT_SETTINGS.usageLog, problems),
    systemPrompt: readString(record, 'systemPrompt', DEFAULT_SETTINGS.systemPrompt, problems),
  };

  // `version` is the one string key that must not be empty: it exists so an edit
  // is visible in every extraction's log line.
  if (settings.version.trim() === '') {
    problems.push('`version` must be a non-empty string');
    settings.version = DEFAULT_SETTINGS.version;
  }

  settings.apiKey = resolveApiKey(settings.apiKeyFile, settings.apiKeyVar, homeDir, problems);

  // The effective switch. A file that asks for the feature but cannot name a
  // gateway, a model or a key is treated as OFF, with the missing item named.
  let enabled = settings.configuredEnabled;
  if (enabled) {
    if (settings.baseUrl.trim() === '') {
      problems.push('`baseUrl` is required when `enabled` is true');
      enabled = false;
    }
    if (settings.model.trim() === '') {
      problems.push('`model` is required when `enabled` is true');
      enabled = false;
    }
    if (settings.apiKey === '') {
      problems.push('`apiKeyFile` (with `apiKeyVar`) must resolve to a key when `enabled` is true');
      enabled = false;
    }
  }
  settings.enabled = enabled;
  settings.problems = problems;
  return settings;
}

/**
 * A stateful settings reader. Each call re-stats the file and re-parses ONLY when
 * its modification time changed; a missing default file reads as "off" with no
 * problems, while a missing EXPLICITLY named file reports the problem.
 *
 * Consumers: `reply-suggestions.module.ts` creates one and hands `read` to the
 * service; the settings criterion drives it directly with a temp path.
 */
export type ReplySuggestionsSettingsSource = {
  read(): ReplySuggestionsSettings;
};

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

  let filePath: string | null;
  let explicit: boolean;
  if (options.settingsPath === null) {
    filePath = null;
    explicit = false;
  } else if (typeof options.settingsPath === 'string') {
    filePath = expandHome(options.settingsPath, homeDir);
    explicit = true;
  } else {
    const named = env[REPLY_SUGGESTIONS_SETTINGS_PATH_ENV];
    if (typeof named === 'string' && named.trim() !== '') {
      filePath = expandHome(named.trim(), homeDir);
      explicit = true;
    } else {
      filePath = defaultSettingsPath(homeDir);
      explicit = false;
    }
  }

  let cached: { filePath: string; mtimeMs: number; settings: ReplySuggestionsSettings } | null = null;

  return {
    read(): ReplySuggestionsSettings {
      if (filePath === null) {
        return defaultSettings();
      }

      let mtimeMs: number;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch (failure) {
        if (cached !== null && cached.filePath === filePath) {
          cached = null;
        }
        if (!explicit) {
          // A default path that does not exist is the ordinary "feature off" state.
          return { ...defaultSettings(), path: filePath };
        }
        const reason = failure instanceof Error ? failure.message : String(failure);
        return {
          ...defaultSettings(),
          path: filePath,
          problems: [`could not read ${filePath}: ${reason}`],
        };
      }

      if (cached !== null && cached.filePath === filePath && cached.mtimeMs === mtimeMs) {
        return cached.settings;
      }

      const settings = readSettingsFile(filePath, 'file', homeDir);
      cached = { filePath, mtimeMs, settings };
      return settings;
    },
  };
}
