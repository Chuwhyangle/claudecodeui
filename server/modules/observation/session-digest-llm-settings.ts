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
 * override. That is why no gateway key is duplicated here.
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
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createReplySuggestionsSettingsSource,
  type ReplySuggestionsAuthScheme,
  type ReplySuggestionsProtocol,
  type ReplySuggestionsSettingsSource,
} from '@/modules/reply-suggestions/index.js';

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
  protocol: ReplySuggestionsProtocol;
  baseUrl: string;
  authScheme: ReplySuggestionsAuthScheme;
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

type ValidationSink = string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** The default server settings location, resolved at call time so a process HOME is honoured. */
function defaultServerSettingsPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'claudecodeui', 'server.settings.json');
}

/** Expand a leading `~` against `homeDir`; any other path is returned unchanged. */
function expandHome(filePath: string, homeDir: string): string {
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/')) return path.join(homeDir, filePath.slice(2));
  return filePath;
}

/**
 * Resolves a key from a bare-key file or a shell-style `NAME=value` line.
 *
 * `apiKeyFile` is optional in this block; when it is empty the reply-suggestions key is used.
 * A failure is a `problems` entry and an empty key — the effective switch then turns off.
 */
function resolveApiKey(filePath: string, homeDir: string, problems: ValidationSink): string {
  const resolvedPath = expandHome(filePath, homeDir);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (failure) {
    problems.push(`could not read the API key file ${resolvedPath}: ${errorMessage(failure)}`);
    return '';
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (lines.length === 0) {
    problems.push(`the API key file ${resolvedPath} is empty`);
    return '';
  }
  const first = lines[0] ?? '';
  const assignment = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(first);
  let value = assignment === null ? first : (assignment[1] ?? '');
  value = value.trim();
  if (value.length >= 2) {
    const firstCharacter = value[0];
    const lastCharacter = value[value.length - 1];
    if (
      (firstCharacter === '"' && lastCharacter === '"') ||
      (firstCharacter === "'" && lastCharacter === "'")
    ) {
      value = value.slice(1, -1);
    }
  }
  return value.trim();
}

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

function readInteger(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds: { minimum: number; maximum: number },
  problems: ValidationSink,
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    problems.push(`\`${key}\` must be an integer`);
    return fallback;
  }
  if (value < bounds.minimum || value > bounds.maximum) {
    problems.push(`\`${key}\` must be between ${bounds.minimum} and ${bounds.maximum}`);
    return fallback;
  }
  return value;
}

/** The `observation.sessionDigest` object, or null when the file does not carry a block. */
function readDigestBlock(
  parsed: unknown,
  filePath: string,
  problems: ValidationSink,
): Record<string, unknown> | null {
  if (!isRecord(parsed)) {
    problems.push(`${filePath} must contain a JSON object`);
    return null;
  }
  const observation = parsed.observation;
  if (observation === undefined) return null;
  if (!isRecord(observation)) {
    problems.push('`observation` must be an object');
    return null;
  }
  const block = observation.sessionDigest;
  if (block === undefined) return null;
  if (!isRecord(block)) {
    problems.push('`observation.sessionDigest` must be an object');
    return null;
  }
  return block;
}

/**
 * Builds one reading from an already-parsed document, merging the reply-suggestions gateway
 * settings underneath. `parsed` is `{}` for the shipped defaults.
 */
function buildReading(
  parsed: unknown,
  filePath: string | null,
  source: 'default' | 'file',
  homeDir: string,
  reply: ReturnType<ReplySuggestionsSettingsSource['read']>,
  problems: ValidationSink,
): SessionDigestLlmSettings {
  const block = readDigestBlock(parsed, filePath ?? '(defaults)', problems);

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

  const model = blockModel.trim() === '' ? reply.model : blockModel.trim();
  const apiKey = apiKeyFile.trim() === '' ? reply.apiKey : resolveApiKey(apiKeyFile, homeDir, problems);

  const settings: SessionDigestLlmSettings = {
    enabled: false,
    configuredEnabled,
    model,
    maxPerHour,
    minTurnChars,
    apiKeyFile,
    protocol: reply.protocol,
    baseUrl: reply.baseUrl,
    authScheme: reply.authScheme,
    disableThinking: reply.disableThinking,
    timeoutMs: reply.timeoutMs,
    maxOutputTokens: reply.maxOutputTokens,
    temperature: reply.temperature,
    apiKey,
    source,
    path: filePath,
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

/**
 * Builds a stateful reader over the server settings file.
 *
 * `settingsPath` follows the same resolution order as the boot loader: an explicit path, then
 * `SERVER_SETTINGS_PATH`, then `~/.config/claudecodeui/server.settings.json`. `replySource` is
 * injectable so a criterion can supply the gateway without touching the operator's files.
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
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const replySource = options.replySource ?? createReplySuggestionsSettingsSource({ homeDir });

  let filePath: string | null;
  let explicit: boolean;
  if (options.settingsPath === null) {
    filePath = null;
    explicit = false;
  } else if (typeof options.settingsPath === 'string') {
    filePath = expandHome(options.settingsPath, homeDir);
    explicit = true;
  } else {
    const named = env[SERVER_SETTINGS_PATH_ENV];
    if (typeof named === 'string' && named.trim() !== '') {
      filePath = expandHome(named.trim(), homeDir);
      explicit = true;
    } else {
      filePath = defaultServerSettingsPath(homeDir);
      explicit = false;
    }
  }

  let cached: { filePath: string; mtimeMs: number; settings: SessionDigestLlmSettings } | null = null;

  return {
    read(): SessionDigestLlmSettings {
      const reply = replySource.read();
      if (filePath === null) {
        return buildReading({}, null, 'default', homeDir, reply, []);
      }

      let mtimeMs: number;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch (failure) {
        if (cached !== null && cached.filePath === filePath) cached = null;
        if (!explicit) {
          // A default path that does not exist is the ordinary "feature off" state.
          return buildReading({}, filePath, 'default', homeDir, reply, []);
        }
        return buildReading({}, filePath, 'default', homeDir, reply, [
          `could not read ${filePath}: ${errorMessage(failure)}`,
        ]);
      }

      // The reply-suggestions reading is mtime-cached by its own source; the tier file is
      // cached here on the same rule.
      if (cached !== null && cached.filePath === filePath && cached.mtimeMs === mtimeMs) {
        return cached.settings;
      }

      const problems: ValidationSink = [];
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch (failure) {
        problems.push(`could not read ${filePath}: ${errorMessage(failure)}`);
      }
      const settings = buildReading(parsed, filePath, 'file', homeDir, reply, problems);
      cached = { filePath, mtimeMs, settings };
      return settings;
    },
  };
}
