/**
 * The one reader for the server's JSON settings files.
 *
 * WHY THIS FILE EXISTS. Four modules carried their own copy of the same "read one
 * block out of a JSON settings file" machinery — `~` expansion, the typed field
 * readers, the API-key file grammar and the mtime-cached source. The copies had
 * started to drift, so the mechanics live here once and each module keeps only
 * its block's schema (the `parse` callback) and its public types.
 *
 * ONE FILE AT A TIME. `createSettingsBlockSource` is deliberately parameterised by
 * the path instead of assuming `server.settings.json`: three modules read blocks
 * out of the deployment settings file (`cockpit.counterVoice`,
 * `observation.sessionDigest`, `architecture.refresh`) while reply-suggestions
 * reads its own flat settings file.
 *
 * THE READING IS NEVER FATAL. A missing default file is the ordinary "feature
 * off" state; a missing explicitly named file, a malformed document or a
 * malformed block field is named in `problems` and the caller's shipped defaults
 * are used. The readers never throw, because a bad knob must never stop the
 * server. `readExpectedVersion` is the deliberate exception: it validates a
 * WRITE's precondition and reports a caller mistake as a 400 `AppError`.
 *
 * Consumers: `modules/quay/counter-voice-settings.ts`,
 * `modules/observation/session-digest-llm-settings.ts`,
 * `modules/reply-suggestions/reply-suggestions-settings.ts` and
 * `modules/architecture/refresh-settings.ts`.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppError, errorMessage, isRecord } from '../utils/index.js';

// ---------------------------- SHARED SHAPES ----------------------------

/** The list a reader appends human-readable fallback reasons to. */
export type ValidationSink = string[];

/** What one read observed, handed to the block's `parse` callback. */
export type SettingsBlockContext = {
  /** `default` when no usable file was read; `file` once a document was parsed. */
  source: 'default' | 'file';
  /** The file this reading came from, or null when no file was consulted. */
  path: string | null;
  /** Every value that fell back to its shipped default, oldest first. */
  problems: ValidationSink;
};

/** The filesystem operations the source needs; injectable so a criterion can fake them. */
export type SettingsFileFs = {
  statSync(filePath: string): { mtimeMs: number; size: number };
  readFileSync(filePath: string, encoding: 'utf8'): string;
};

/** A stateful reader over one settings file. */
export type SettingsBlockSource<T> = {
  read(): T;
};

/**
 * What `createSettingsBlockSource` needs.
 *
 * Consumers: the four settings readers, each passing its own block path and
 * `parse` callback.
 */
export type SettingsBlockSourceOptions<T> = {
  /** The file to read; `null` means "no file at all". A leading `~` is expanded. */
  settingsPath?: string | null;
  /** The home `~` expands against; defaults to the process home. */
  homeDir?: string;
  /**
   * Dotted path of the block inside the JSON document (`architecture.refresh`).
   * `null`/the empty string means the document itself is the block
   * (reply-suggestions' flat file).
   */
  block?: string | null;
  /** A missing EXPLICITLY named file is a problem; a missing default file is not. */
  explicit?: boolean;
  /** The filesystem seam; defaults to `node:fs`. */
  fsImpl?: SettingsFileFs;
  /**
   * Build one reading from the selected block. `block` is null when the file does
   * not carry it (or there is no file); `context.problems` is the sink the
   * callback appends to, and the callback must not throw.
   */
  parse: (block: Record<string, unknown> | null, context: SettingsBlockContext) => T;
};

// ---------------------------- SHARED HELPERS ----------------------------

/**
 * Expand a leading `~` against `homeDir`; any other path is returned unchanged.
 *
 * Consumers: the four settings readers and
 * `modules/architecture/refresh-settings.ts`'s CLI resolver.
 */
export function expandHome(filePath: string, homeDir: string): string {
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/')) return path.join(homeDir, filePath.slice(2));
  return filePath;
}

/**
 * The default server settings location, resolved at call time so a process HOME
 * is honoured. Cloudpit is the write target; the legacy location stays readable
 * through {@link legacyServerSettingsPath}.
 *
 * Consumers: `counter-voice-settings.ts`, `session-digest-llm-settings.ts` and
 * `refresh-settings.ts` (reply-suggestions names its own file instead), plus
 * `modules/settings/server-settings-file.ts`, which re-exports it.
 */
export function defaultServerSettingsPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'cloudpit', 'server.settings.json');
}

/**
 * The pre-flip settings location. In v3.0 it is only a ONE-TIME MIGRATION SOURCE:
 * {@link migrateLegacyServerSettingsFile} copies it to
 * {@link defaultServerSettingsPath} when the Cloudpit file does not exist yet, and
 * every reader then reads only the Cloudpit file. A runtime read fallback to this
 * path was retired with the rest of the 2.x compatibility layer.
 */
export function legacyServerSettingsPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'claudecodeui', 'server.settings.json');
}

/**
 * Resolve which file a reader should use: an explicit path, then the named
 * environment entry, then the shipped default.
 *
 * Consumers: the four settings readers; each passes its own environment variable
 * and default path.
 */
export function resolveSettingsPath(options: {
  /** `undefined` = env-or-default, `null` = no file at all, a string = explicitly named. */
  settingsPath?: string | null;
  env?: Record<string, string | undefined>;
  envVar: string;
  homeDir: string;
  defaultPath: (homeDir: string) => string;
}): { filePath: string | null; explicit: boolean } {
  const env = options.env ?? process.env;
  if (options.settingsPath === null) return { filePath: null, explicit: false };
  if (typeof options.settingsPath === 'string') {
    return { filePath: expandHome(options.settingsPath, options.homeDir), explicit: true };
  }
  const named = env[options.envVar];
  if (typeof named === 'string' && named.trim() !== '') {
    return { filePath: expandHome(named.trim(), options.homeDir), explicit: true };
  }
  return { filePath: options.defaultPath(options.homeDir), explicit: false };
}

/** A predicate that accepts one value and narrows it to `T`. */
export type FieldGuard<T> = (value: unknown) => value is T;

/** The one `boolean` predicate the settings readers and route parsers share. */
export const isBooleanValue = (value: unknown): value is boolean => typeof value === 'boolean';

/** The one `string` predicate the settings readers and route parsers share. */
export const isStringValue = (value: unknown): value is string => typeof value === 'string';

/**
 * Read one typed field: an absent key yields `fallback`, and a present value the
 * `guard` rejects is reported through `onProblem` and also yields `fallback`.
 *
 * WHY THIS EXISTS. This is the ONE fallback ladder. It used to be written once
 * per field type inside this module and once per error style in
 * `reply-suggestions.routes.ts`; the copies are indistinguishable token-wise, so
 * they are the same mechanism written four times. The caller owns the wording
 * (`onProblem` receives the key and the type name) because a settings reader
 * appends to `problems` while a route parser throws a 400 `AppError`.
 *
 * Consumers: `readBoolean` / `readString` below and `readField` callers in
 * `modules/reply-suggestions/reply-suggestions.routes.ts`.
 */
export function readField<T>(
  record: Record<string, unknown>,
  key: string,
  fallback: T,
  typeName: string,
  guard: FieldGuard<T>,
  onProblem: (key: string, typeName: string) => void,
): T {
  const value = record[key];
  if (value === undefined) return fallback;
  if (!guard(value)) {
    onProblem(key, typeName);
    return fallback;
  }
  return value;
}

/** The settings readers' wording: `` `key` must be a typeName ``. */
function typeProblem(problems: ValidationSink): (key: string, typeName: string) => void {
  return (key, typeName) => {
    problems.push(`\`${key}\` must be a ${typeName}`);
  };
}

/**
 * Read one boolean field, naming it in `problems` when it has the wrong type.
 *
 * Consumers: all four settings readers.
 */
export function readBoolean(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
  problems: ValidationSink,
): boolean {
  return readField(record, key, fallback, 'boolean', isBooleanValue, typeProblem(problems));
}

/**
 * Read one string field, naming it in `problems` when it has the wrong type.
 *
 * Consumers: all four settings readers.
 */
export function readString(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
  problems: ValidationSink,
): string {
  return readField(record, key, fallback, 'string', isStringValue, typeProblem(problems));
}

/**
 * Read one finite number field inside `bounds`, naming it in `problems` when it
 * is malformed or out of range. `integer` rejects fractional values.
 *
 * Consumers: `reply-suggestions-settings.ts` (its fractional temperatures and
 * integer caps) and, through it, the reply-suggestions service criterion.
 */
export function readNumber(
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

/**
 * Read one integer field inside `bounds`, naming it in `problems` when it is
 * malformed or out of range.
 *
 * Consumers: `counter-voice-settings.ts` and `session-digest-llm-settings.ts`.
 */
export function readInteger(
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

/**
 * Read one enum field from a fixed vocabulary, naming the allowed values in
 * `problems` when the value is outside it.
 *
 * Consumers: `reply-suggestions-settings.ts` (protocol, auth scheme, expansion).
 */
export function readEnum<T extends string>(
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
 * Resolve the API key named by an `apiKeyFile`.
 *
 * The file is either a bare key line or a shell-style `NAME=value` table (an
 * `export` prefix and one pair of quotes are accepted). With `apiKeyVar`, that
 * variable's assignment is selected. Without it, a file holding exactly one
 * assignment contributes that assignment; otherwise the first non-empty,
 * non-comment line wins. `warnOnWideMode` adds the reply-suggestions contract's
 * mode-600 problem (it is a warning, never fatal).
 *
 * Every failure is a `problems` entry; the key value itself is NEVER placed in
 * one, and an unreadable key file is not fatal by itself (the effective switch
 * turns off because the credential is empty).
 *
 * Consumers: the four settings readers (`counter-voice` and `session-digest`
 * use the bare-key form; `reply-suggestions` also selects `apiKeyVar` and warns
 * on a wide mode).
 */
export function resolveApiKey(
  apiKeyFile: string,
  homeDir: string,
  problems: ValidationSink,
  options: { apiKeyVar?: string; warnOnWideMode?: boolean } = {},
): string {
  if (apiKeyFile.trim() === '') {
    return '';
  }
  const resolvedPath = expandHome(apiKeyFile, homeDir);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (failure) {
    problems.push(`could not read the API key file ${resolvedPath}: ${errorMessage(failure)}`);
    return '';
  }

  if (options.warnOnWideMode === true) {
    try {
      const mode = statSync(resolvedPath).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        problems.push(
          `the API key file ${resolvedPath} has mode ${mode.toString(8)}; 600 is expected because the file holds a secret`,
        );
      }
    } catch {
      // A stat failure after a successful read is not worth a second problem;
      // the read above already decided whether the file is usable.
    }
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
    if (match) assignments.push({ name: match[1]!, value: unquote(match[2] ?? '') });
  }

  const apiKeyVar = (options.apiKeyVar ?? '').trim();
  if (apiKeyVar !== '') {
    const selected = assignments.find((assignment) => assignment.name === apiKeyVar);
    if (!selected) {
      problems.push(`the API key file ${resolvedPath} does not assign \`${apiKeyVar}\``);
      return '';
    }
    return selected.value.trim();
  }

  if (assignments.length === 1) {
    return assignments[0]!.value.trim();
  }

  const firstLine = lines[0]!;
  const firstMatch = KEY_ASSIGNMENT.exec(firstLine);
  return (firstMatch ? unquote(firstMatch[2] ?? '') : unquote(firstLine)).trim();
}

/**
 * Write one settings file by replacing it atomically.
 *
 * The bytes go to a sibling temp file (same directory, so the rename cannot cross a filesystem)
 * and are renamed over the target, so a reader never observes a half-written document. Without
 * an explicit `mode`, an existing file keeps its current permissions and a new file is created
 * `0600` — settings files can carry operator credentials. Callers that own a secret-bearing file
 * pass `mode: 0o600` to widen-proof it even when the file already existed.
 *
 * Throws the filesystem error unchanged: each caller wraps it in its own domain `AppError`, so
 * this shared helper does not invent a settings-specific error code.
 *
 * Consumers: `settings/server-settings-file.ts` (the cockpit session-start writer) and
 * `settings/codex-model-providers.store.ts` (the Codex provider settings and secret files).
 */
export function writeSettingsFileAtomically(
  filePath: string,
  contents: string,
  options: { mode?: number } = {},
): void {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    mkdirSync(directory, { recursive: true });
    const mode = options.mode ?? (existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600);
    writeFileSync(temporary, contents, { encoding: 'utf8', mode });
    renameSync(temporary, filePath);
  } finally {
    // The rename consumed the temp name on success; this removes it only after a failed write.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // A leftover temp file is not a reason to hide the write's own error.
    }
  }
}

// ---------------------------- ONE-TIME MIGRATION ----------------------------

/** What one legacy-settings copy attempt decided. */
export type LegacyServerSettingsMigration = {
  /** True only when this call created the Cloudpit file from the legacy one. */
  migrated: boolean;
  /**
   * `copied` — the Cloudpit file was created from the legacy copy;
   * `target-exists` — the Cloudpit file is already there (idempotent second run);
   * `no-legacy` — there is no legacy file to copy;
   * `copy-failed` — the read or write threw; `error` carries the reason.
   */
  reason: 'copied' | 'target-exists' | 'no-legacy' | 'copy-failed';
  /** The failure message for `copy-failed`; never set for the other reasons. */
  error?: string;
};

/**
 * Copy the legacy `~/.config/claudecodeui/server.settings.json` to the Cloudpit
 * default exactly once.
 *
 * v3.0 REPLACEMENT FOR THE READ FALLBACK. Up to 2.x the boot loader read the
 * legacy file whenever the Cloudpit file was missing, so an upgrade kept its
 * effective configuration. The runtime fallback is gone; this one-time copy keeps
 * the upgrade working and then leaves only the Cloudpit file to be read.
 *
 * IDEMPOTENT BY CONSTRUCTION. The copy never overwrites: an existing Cloudpit
 * file is the user's current settings (`target-exists`), so a second run is a
 * no-op and a save made after the first run is never clobbered. The legacy file
 * stays on disk untouched.
 *
 * The copy goes through {@link writeSettingsFileAtomically} so the new file is
 * created `0600` and a reader never observes a half-written document. Every
 * outcome is returned, never thrown: a failed copy must not stop the server.
 *
 * Consumers: `modules/settings/server-settings-file.ts`'s target resolver (the
 * boot path) and the settings criteria.
 */
export function migrateLegacyServerSettingsFile(options: {
  /** The pre-flip file (`~/.config/claudecodeui/server.settings.json`). */
  legacyPath: string;
  /** The Cloudpit file (`~/.config/cloudpit/server.settings.json`). */
  targetPath: string;
  /** Existence seam; defaults to `node:fs`. */
  exists?: (filePath: string) => boolean;
  /** Read seam; defaults to `node:fs` UTF-8. */
  readFile?: (filePath: string) => string;
  /** Write seam; defaults to {@link writeSettingsFileAtomically} with mode 0600. */
  writeTarget?: (filePath: string, contents: string) => void;
}): LegacyServerSettingsMigration {
  const exists = options.exists ?? existsSync;
  if (exists(options.targetPath)) return { migrated: false, reason: 'target-exists' };
  if (!exists(options.legacyPath)) return { migrated: false, reason: 'no-legacy' };

  try {
    const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, 'utf8'));
    const writeTarget = options.writeTarget
      ?? ((filePath: string, contents: string) =>
        writeSettingsFileAtomically(filePath, contents, { mode: 0o600 }));
    writeTarget(options.targetPath, readFile(options.legacyPath));
    return { migrated: true, reason: 'copied' };
  } catch (failure) {
    return {
      migrated: false,
      reason: 'copy-failed',
      error: errorMessage(failure),
    };
  }
}

// ---------------------------- SAVE PRECONDITIONS ----------------------------

/**
 * The version a settings write was based on: the body's `expectedVersion`, else
 * the `If-Match` header value.
 *
 * A save without a version, or with a non-string one, is a caller mistake and is
 * refused as a 400 `AppError` (`VERSION_REQUIRED` / `INVALID_VERSION`) so a
 * stale write can never silently overwrite another editor's save. This validates
 * a REQUEST, not a settings document, so it deliberately throws where the
 * readers above never do.
 *
 * Consumers: `modules/settings/settings.service.ts` (the cockpit session-start
 * save) and `modules/settings/codex-model-providers.service.ts` (the Codex
 * upstream provider registry save) — both save contracts require this same
 * proof before touching their file.
 */
export function readExpectedVersion(
  body: Record<string, unknown>,
  headerVersion: string | undefined,
): string {
  if (body.expectedVersion !== undefined && typeof body.expectedVersion !== 'string') {
    throw new AppError('expectedVersion must be a string', {
      code: 'INVALID_VERSION',
      statusCode: 400,
    });
  }
  const fromBody = typeof body.expectedVersion === 'string' ? body.expectedVersion.trim() : '';
  const version = fromBody || (headerVersion ?? '').trim();
  if (!version) {
    throw new AppError('expectedVersion is required to save', {
      code: 'VERSION_REQUIRED',
      statusCode: 400,
    });
  }
  return version;
}

/**
 * Build a stateful reader over one JSON settings file.
 *
 * Each `read()` re-stats the file and re-parses ONLY when its modification time
 * or size changed; a missing default file reads as the caller's defaults with no
 * problems, while a missing explicitly named file reports the problem. A
 * malformed document or block is reported and the defaults are used, never a
 * thrown error.
 *
 * Consumers: the four settings readers (`counter-voice-settings.ts`,
 * `session-digest-llm-settings.ts`, `reply-suggestions-settings.ts`,
 * `refresh-settings.ts`), each supplying only its block path and `parse`.
 */
export function createSettingsBlockSource<T>(
  options: SettingsBlockSourceOptions<T>,
): SettingsBlockSource<T> {
  const homeDir = options.homeDir ?? os.homedir();
  const fsImpl: SettingsFileFs = options.fsImpl ?? { statSync, readFileSync };
  const blockPath = options.block === undefined || options.block === '' ? null : options.block;
  const filePath = options.settingsPath === undefined || options.settingsPath === null
    ? null
    : expandHome(options.settingsPath, homeDir);
  const explicit = options.explicit ?? false;

  let cached: { mtimeMs: number; size: number; reading: T } | null = null;

  /** Walk the dotted block path, naming each malformed level it meets. */
  function selectBlock(
    parsed: unknown,
    pathForMessage: string,
    problems: ValidationSink,
  ): Record<string, unknown> | null {
    if (!isRecord(parsed)) {
      problems.push(`${pathForMessage} must contain a JSON object`);
      return null;
    }
    if (blockPath === null) return parsed;
    let current: Record<string, unknown> = parsed;
    const segments = blockPath.split('.');
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index]!;
      const value = current[name];
      if (value === undefined) return null;
      if (!isRecord(value)) {
        problems.push(`\`${segments.slice(0, index + 1).join('.')}\` must be an object`);
        return null;
      }
      current = value;
    }
    return current;
  }

  return {
    read(): T {
      if (filePath === null) {
        return options.parse(null, { source: 'default', path: null, problems: [] });
      }

      let stats: { mtimeMs: number; size: number };
      try {
        stats = fsImpl.statSync(filePath);
      } catch (failure) {
        cached = null;
        const problems: ValidationSink = explicit
          ? [`could not read ${filePath}: ${errorMessage(failure)}`]
          : [];
        return options.parse(null, { source: 'default', path: filePath, problems });
      }

      if (cached !== null && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        return cached.reading;
      }

      const problems: ValidationSink = [];
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      } catch (failure) {
        problems.push(`could not read ${filePath}: ${errorMessage(failure)}`);
      }
      const reading = options.parse(selectBlock(parsed, filePath, problems), {
        source: 'file',
        path: filePath,
        problems,
      });
      cached = { mtimeMs: stats.mtimeMs, size: stats.size, reading };
      return reading;
    },
  };
}

// ---------------------------- SERVER SETTINGS SOURCES ----------------------------

/**
 * What {@link createServerSettingsSource} needs.
 *
 * `T` is the reading the caller's `parse` callback returns; `D` is the bag of per-source
 * collaborators the callback needs (for the reply-suggestions-backed blocks, the gateway
 * reader and the home `~` expands against). The bag is built ONCE, against the effective
 * home, and handed to every `read()`.
 */
export type ServerSettingsSourceOptions<T, D> = {
  /** Dotted path of the block inside the server settings document (`cockpit.counterVoice`). */
  block: string;
  /** The environment variable naming the file (`SERVER_SETTINGS_PATH`). */
  envVar: string;
  /** `undefined` = env-or-default, `null` = no file at all, a string = explicitly named. */
  settingsPath?: string | null;
  /** The environment to read `envVar` from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** The home `~` expands against; defaults to the process home. */
  homeDir?: string;
  /** The filesystem seam; defaults to `node:fs`. */
  fsImpl?: SettingsFileFs;
  /** Build the per-source collaborators once, against the effective home. */
  dependencies: (homeDir: string) => D;
  /** Build one reading from the block, the read context and the collaborators. */
  parse: (block: Record<string, unknown> | null, context: SettingsBlockContext, dependencies: D) => T;
};

/**
 * Build a stateful reader for ONE block of the server settings file.
 *
 * WHY THIS EXISTS. The observation digest and counter-voice readers carried the same
 * 28-line factory: default `env`/`homeDir`, default the reply-suggestions source, resolve
 * the file through {@link resolveSettingsPath}, then wrap it in
 * {@link createSettingsBlockSource}. Only the block path, the reading type and the
 * collaborators differed. The mechanics live here once; each module keeps its shipped
 * defaults, its reading type, its `parse` and a thin declaration of the two things that
 * are actually its own (block path and gateway dependency).
 *
 * The file resolution order is the boot loader's: an explicit path, then `envVar`, then
 * `defaultServerSettingsPath`. A missing default file stays the ordinary "feature off"
 * state; a missing explicitly named file is named in `problems` (see
 * {@link createSettingsBlockSource}).
 *
 * Consumers: `modules/observation/core/session-digest-llm-settings.ts` and
 * `modules/quay/counter-voice-settings.ts`.
 */
export function createServerSettingsSource<T, D>(
  options: ServerSettingsSourceOptions<T, D>,
): SettingsBlockSource<T> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const dependencies = options.dependencies(homeDir);
  const { filePath, explicit } = resolveSettingsPath({
    settingsPath: options.settingsPath,
    env,
    envVar: options.envVar,
    homeDir,
    defaultPath: defaultServerSettingsPath,
  });

  return createSettingsBlockSource({
    settingsPath: filePath,
    homeDir,
    block: options.block,
    explicit,
    fsImpl: options.fsImpl,
    parse: (block, context) => options.parse(block, context, dependencies),
  });
}
