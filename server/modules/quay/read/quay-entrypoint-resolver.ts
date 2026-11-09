import path from 'node:path';

import {
  parsePluginInstallRecords,
  readPluginEnabledFlag,
  resolveEnabledPluginScopes,
  selectPluginScopeCandidates,
  type PluginEnabledScopes,
  type PluginInstallRecord,
} from '@/shared/plugin-scope.js';
import type { QuayEntrypointDiagnostic } from '@/shared/types.js';

/**
 * Resolves the quay CLI a target project is driven with.
 *
 * WHY THIS EXISTS. A Claude Code plugin install only lays its version directory down under
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`; it never edits the user's `PATH`.
 * The adapter therefore cannot just spawn `quay`, and it must no longer depend on the
 * `<projectRoot>/.quay/plugin` symlink older `/quay:init` runs created: that link is eventually
 * retired, and on this host it already points at version directories that get cleaned up
 * (a dangling link used to read as `entrypoint-missing` for every project).
 *
 * The resolution order below is first-match-wins, and every filesystem read goes through the
 * injected {@link QuayEntrypointFileSystem} seam, so a criterion drives all four legs without
 * touching the machine's real home directory:
 *
 * 1. A per-project override in the SERVER settings file (`quay.entrypoints`, keyed by the
 *    absolute project root). This is the escape hatch for a project that deliberately pins a
 *    binary outside every plugin scope.
 * 2. Claude Code plugin scopes: every `quay@quay` record in `installed_plugins.json`, filtered
 *    by that scope's `enabledPlugins` value, prioritised local > project > user. A record whose
 *    `installPath` directory is gone is skipped with a warning and the next record is tried —
 *    a cleaned-up old version must degrade to the next scope, not to "no CLI".
 * 3. The legacy project pin `<projectRoot>/.quay/plugin/bin/quay`, but ONLY when its real target
 *    lies outside the Claude plugin cache. A link into the cache is exactly the retired
 *    mechanism and is ignored (including a dangling one).
 * 4. The bare `quay` on the server's `PATH`, with an explicit warning.
 *
 * CACHE. The reading is keyed by the mtime+size signature of `installed_plugins.json` and the
 * three settings files, so repeated snapshot reads do not re-read or re-parse them, while a
 * plugin install/upgrade (which rewrites `installed_plugins.json`) is picked up automatically.
 */

/**
 * One path's stat reading, as the resolver needs it. Kept to the fields the resolution rules
 * actually consult so a fake filesystem in a criterion is a plain object, not an `fs.Stats`.
 */
export type QuayEntrypointFileStat = {
  isFile: boolean;
  isDirectory: boolean;
  /** Modification time, epoch milliseconds — part of the cache signature. */
  mtimeMs: number;
  /** Byte size — part of the cache signature. */
  size: number;
};

/**
 * The read-only filesystem seam the resolver is built on. EVERY file read in this module goes
 * through it; `quay.module.ts` binds the production adapter and the criterion binds an
 * in-memory one.
 */
export type QuayEntrypointFileSystem = {
  /** Whole-file UTF-8 read, or `null` when the file is absent/unreadable. */
  readText(filePath: string): string | null;
  /** `stat`, or `null` when the path is absent/unreadable (a dangling symlink included). */
  stat(filePath: string): QuayEntrypointFileStat | null;
  /** Canonical target of a path, or `null` when it cannot be resolved (dangling link included). */
  realpath(filePath: string): string | null;
  /** One symlink hop's target text, or `null` when the path is not a symlink. */
  readlink(filePath: string): string | null;
};

/** The injectable boundaries of the resolver. */
export type QuayEntrypointResolverDependencies = {
  /** Every filesystem read the resolver performs. */
  fileSystem: QuayEntrypointFileSystem;
  /** Home directory carrying `.claude/plugins/installed_plugins.json` and `.claude/settings.json`. */
  homeDir: string;
  /** The SERVER settings file path (`SERVER_SETTINGS_PATH`, else the shipped user copy). */
  settingsPath: string;
};

/**
 * The resolution result. `path`, `version` and `source` are the public diagnostic the snapshot
 * reports; `warning` carries a skipped-record / bare-PATH explanation for the caller's log or
 * snapshot warnings (it is not part of the snapshot's compact diagnostic).
 */
export type QuayEntrypointResolution = QuayEntrypointDiagnostic & {
  /** Non-null when a higher-priority record was skipped or the bare PATH was used. */
  warning: string | null;
};

/** The resolver handed to the process adapter, the service, and the capability probe. */
export type QuayEntrypointResolver = {
  /** Resolves synchronously (every read is local); never throws, never returns `null`. */
  resolve(projectRoot: string): QuayEntrypointResolution;
};

/** The path, relative to a project root, of the legacy `/quay:init` pin. */
const LEGACY_PLUGIN_RELATIVE_PATH = path.join('.quay', 'plugin');

/** The bare command the final fallback uses; `resolveEntrypointSource` reports it as `path`. */
const BARE_QUAY_COMMAND = 'quay';

/** The plugin key in `installed_plugins.json` and `enabledPlugins`. */
const QUAY_PLUGIN_KEY = 'quay@quay';

/** The SERVER settings key carrying per-project entrypoint overrides. */
const OVERRIDES_KEY = 'quay';

/** One cached reading: the signature it was computed from, and the result. */
type CacheEntry = {
  signature: string;
  result: QuayEntrypointResolution;
};

/** Parses JSON, answering `null` (never throwing) for a missing or malformed document. */
function parseJson(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A non-empty string, trimmed; otherwise `null`. */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Whether `candidate` is `root` or sits below it, after normalisation. */
function isInside(candidate: string, root: string): boolean {
  const normalisedRoot = path.normalize(root);
  const normalisedCandidate = path.normalize(candidate);
  return (
    normalisedCandidate === normalisedRoot
    || normalisedCandidate.startsWith(`${normalisedRoot}${path.sep}`)
  );
}

/** Joins the warning lines collected during one resolution, or `null` when there are none. */
function joinWarnings(warnings: readonly string[]): string | null {
  return warnings.length === 0 ? null : warnings.join(' ');
}

/**
 * Creates the per-project quay entrypoint resolver.
 *
 * Consumers: `quay-process.ts` (the spawn boundary), `quay.module.ts` (the capability cache's
 * identity read) and `quay.service.ts` (the snapshot's optional `entrypoint` diagnostic). The
 * resolver never throws — a malformed settings or plugin document is a warning plus the next
 * resolution rule, because a broken configuration must not take the panel down.
 */
export function createQuayEntrypointResolver(
  dependencies: QuayEntrypointResolverDependencies,
): QuayEntrypointResolver {
  const { fileSystem } = dependencies;
  const claudeDir = path.join(dependencies.homeDir, '.claude');
  const installedPluginsPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  const userSettingsPath = path.join(claudeDir, 'settings.json');
  const pluginCacheDir = path.join(claudeDir, 'plugins', 'cache');

  const projectSettingsPath = (projectRoot: string): string =>
    path.join(projectRoot, '.claude', 'settings.json');
  const projectLocalSettingsPath = (projectRoot: string): string =>
    path.join(projectRoot, '.claude', 'settings.local.json');

  /**
   * Files whose mtime+size decide whether a cached reading is still valid. Missing files keep a
   * stable `-` marker, so "still absent" does not invalidate the cache on every read.
   */
  const watchedFiles = (projectRoot: string): string[] => [
    installedPluginsPath,
    userSettingsPath,
    projectSettingsPath(projectRoot),
    projectLocalSettingsPath(projectRoot),
    dependencies.settingsPath,
  ];

  const signatureFor = (projectRoot: string): string =>
    watchedFiles(projectRoot)
      .map((filePath) => {
        const stats = fileSystem.stat(filePath);
        return stats === null ? `${filePath}\u0000-` : `${filePath}\u0000${stats.mtimeMs}\u0000${stats.size}`;
      })
      .join('\u0001');

  /**
   * Reads the `quay.entrypoints` override map from the SERVER settings file. Keys are resolved
   * to absolute project roots; values must be absolute entrypoint paths (a relative value is a
   * malformed override and is reported rather than resolved against an unrelated cwd).
   */
  const readOverrides = (warnings: string[]): Map<string, string> => {
    const overrides = new Map<string, string>();
    const text = fileSystem.readText(dependencies.settingsPath);
    if (text === null) {
      return overrides;
    }

    const parsed = parseJson(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(
        `${dependencies.settingsPath} could not be read as a JSON object; ignoring quay.entrypoints.`,
      );
      return overrides;
    }

    const quayBlock = (parsed as Record<string, unknown>)[OVERRIDES_KEY];
    if (quayBlock === undefined) {
      return overrides;
    }
    if (typeof quayBlock !== 'object' || quayBlock === null || Array.isArray(quayBlock)) {
      warnings.push(`${dependencies.settingsPath}: \`quay\` must be a JSON object; ignoring overrides.`);
      return overrides;
    }

    const entrypoints = (quayBlock as Record<string, unknown>).entrypoints;
    if (entrypoints === undefined) {
      return overrides;
    }
    if (typeof entrypoints !== 'object' || entrypoints === null || Array.isArray(entrypoints)) {
      warnings.push(`${dependencies.settingsPath}: \`quay.entrypoints\` must be a JSON object.`);
      return overrides;
    }

    for (const [projectRoot, value] of Object.entries(entrypoints as Record<string, unknown>)) {
      const entrypoint = readNonEmptyString(value);
      if (entrypoint === null || !path.isAbsolute(entrypoint)) {
        warnings.push(
          `${dependencies.settingsPath}: quay.entrypoints["${projectRoot}"] must be an absolute path; ignored.`,
        );
        continue;
      }
      overrides.set(path.resolve(projectRoot), entrypoint);
    }
    return overrides;
  };

  /**
   * Reads one settings file's `enabledPlugins[quay@quay]` value; `undefined` means the file
   * said nothing (the shipped default is enabled). A malformed file is a warning, not a throw.
   */
  const readEnabledFlag = (filePath: string, warnings: string[]): boolean | undefined => {
    const text = fileSystem.readText(filePath);
    if (text === null) {
      return undefined;
    }
    const parsed = parseJson(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`${filePath} could not be read as a JSON object; enabledPlugins ignored.`);
      return undefined;
    }
    const enabledPlugins = (parsed as Record<string, unknown>).enabledPlugins;
    if (enabledPlugins === undefined) {
      return undefined;
    }
    if (typeof enabledPlugins !== 'object' || enabledPlugins === null || Array.isArray(enabledPlugins)) {
      warnings.push(`${filePath}: \`enabledPlugins\` must be a JSON object; ignored.`);
      return undefined;
    }
    return readPluginEnabledFlag(parsed, QUAY_PLUGIN_KEY);
  };

  /**
   * The enabled state of each scope, resolved with the documented precedence: a missing value
   * falls back to the next lower scope, and an absent everywhere reads as enabled. This makes
   * `enabledPlugins` in `settings.local.json` the project's final word while an unconfigured
   * deployment keeps the plugin on.
   */
  const readEnabledByScope = (
    projectRoot: string,
    warnings: string[],
  ): PluginEnabledScopes => {
    const user = readEnabledFlag(userSettingsPath, warnings);
    const project = readEnabledFlag(projectSettingsPath(projectRoot), warnings);
    const local = readEnabledFlag(projectLocalSettingsPath(projectRoot), warnings);
    return resolveEnabledPluginScopes({ user, project, local });
  };

  /** Reads the `quay@quay` records out of `installed_plugins.json`. */
  const readPluginRecords = (warnings: string[]): PluginInstallRecord[] => {
    const text = fileSystem.readText(installedPluginsPath);
    if (text === null) {
      return [];
    }
    const parsed = parseJson(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`${installedPluginsPath} could not be read as a JSON object; no plugin scopes.`);
      return [];
    }
    const plugins = (parsed as Record<string, unknown>).plugins;
    if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
      return [];
    }
    return parsePluginInstallRecords((plugins as Record<string, unknown>)[QUAY_PLUGIN_KEY]);
  };

  /**
   * Applies the project-root filter and the local > project > user ordering. Only a `user`
   * record applies everywhere; a `project`/`local` record whose `projectPath` is not this
   * project root belongs to some other project and is ignored. Within one scope the most
   * recently updated record wins, which is the version an install/upgrade just wrote.
   */
  const readCandidates = (
    projectRoot: string,
    records: readonly PluginInstallRecord[],
    enabledByScope: PluginEnabledScopes,
  ) => selectPluginScopeCandidates({ projectRoot, records, enabledByScope });

  /** Reads an install root's version carrier (`VERSION`, else the plugin manifest). */
  const readVersion = (installRoot: string): string => {
    const versionFile = readNonEmptyString(fileSystem.readText(path.join(installRoot, 'VERSION')));
    if (versionFile !== null) {
      return versionFile;
    }
    const manifest = parseJson(fileSystem.readText(path.join(installRoot, '.claude-plugin', 'plugin.json')));
    if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
      return readNonEmptyString((manifest as Record<string, unknown>).version) ?? '';
    }
    return '';
  };

  /** The install root two levels above an entrypoint at `<root>/bin/quay`. */
  const installRootForEntrypoint = (entrypoint: string): string =>
    path.dirname(path.dirname(entrypoint));

  /**
   * The legacy `<projectRoot>/.quay/plugin/bin/quay` pin, accepted only when its real target is
   * outside the Claude plugin cache. A link into the cache (dangling or not) is the retired
   * mechanism and is ignored; a real file or a link to a developer checkout is a genuine pin.
   */
  const resolveLegacyPin = (
    projectRoot: string,
    warnings: string[],
  ): QuayEntrypointResolution | null => {
    const legacyLink = path.join(projectRoot, LEGACY_PLUGIN_RELATIVE_PATH);
    const cacheRealpath = fileSystem.realpath(pluginCacheDir) ?? pluginCacheDir;

    const linkTarget = fileSystem.readlink(legacyLink);
    const realTarget = fileSystem.realpath(legacyLink);
    const resolvedLinkTarget = linkTarget === null
      ? null
      : path.resolve(path.dirname(legacyLink), linkTarget);

    // A link whose text OR canonical target is inside the cache is the retired pointer.
    if (
      (resolvedLinkTarget !== null && isInside(resolvedLinkTarget, cacheRealpath))
      || (realTarget !== null && isInside(realTarget, cacheRealpath))
    ) {
      return null;
    }

    // Dangling link (no canonical target and no stat) is unusable; fall through to PATH.
    const legacyStat = fileSystem.stat(legacyLink);
    if (legacyStat === null || !legacyStat.isDirectory) {
      return null;
    }
    // A directory whose canonical target still lands in the cache is the retired pointer too.
    if (realTarget !== null && isInside(realTarget, cacheRealpath)) {
      return null;
    }

    const entrypoint = path.join(legacyLink, 'bin', 'quay');
    const entrypointStat = fileSystem.stat(entrypoint);
    if (entrypointStat === null || !entrypointStat.isFile) {
      return null;
    }

    // `realTarget` is the plugin root itself; without a link, the project's own directory is.
    return {
      path: entrypoint,
      version: readVersion(realTarget ?? legacyLink),
      source: 'legacy-pin',
      warning: joinWarnings(warnings),
    };
  };

  /** One uncached resolution pass. */
  const resolveUncached = (projectRoot: string): QuayEntrypointResolution => {
    const warnings: string[] = [];
    const resolvedProjectRoot = path.resolve(projectRoot);

    // 1. Explicit per-project override.
    const overrides = readOverrides(warnings);
    const override = overrides.get(resolvedProjectRoot);
    if (override !== undefined) {
      return {
        path: override,
        version: readVersion(installRootForEntrypoint(override)),
        source: 'override',
        warning: joinWarnings(warnings),
      };
    }

    // 2. Claude Code plugin scopes, in local > project > user order.
    const enabledByScope = readEnabledByScope(resolvedProjectRoot, warnings);
    const records = readPluginRecords(warnings);
    for (const candidate of readCandidates(resolvedProjectRoot, records, enabledByScope)) {
      if (!candidate.enabled) {
        continue;
      }
      const { installPath, version } = candidate.record;
      const installStat = fileSystem.stat(installPath);
      if (installStat === null || !installStat.isDirectory) {
        warnings.push(
          `quay plugin ${candidate.record.scope} record for ${resolvedProjectRoot} points at `
          + `${installPath}, which no longer exists; skipping it.`,
        );
        continue;
      }
      const entrypoint = path.join(installPath, 'bin', 'quay');
      const entrypointStat = fileSystem.stat(entrypoint);
      if (entrypointStat === null || !entrypointStat.isFile) {
        warnings.push(
          `quay plugin ${candidate.record.scope} record for ${resolvedProjectRoot} has no `
          + `${entrypoint}; skipping it.`,
        );
        continue;
      }
      return {
        path: entrypoint,
        version: version !== '' ? version : readVersion(installPath),
        source: candidate.record.scope,
        warning: joinWarnings(warnings),
      };
    }

    // 3. Legacy project pin outside the plugin cache.
    const legacy = resolveLegacyPin(resolvedProjectRoot, warnings);
    if (legacy !== null) {
      return legacy;
    }

    // 4. Bare PATH fallback, explicitly warned.
    warnings.push(
      `no quay CLI resolved for project ${resolvedProjectRoot}; falling back to the bare `
      + `"${BARE_QUAY_COMMAND}" on PATH. Install the quay plugin or run /quay:init in this project `
      + `to pin a project-scoped CLI.`,
    );
    return { path: BARE_QUAY_COMMAND, version: '', source: 'path', warning: joinWarnings(warnings) };
  };

  const cache = new Map<string, CacheEntry>();

  return {
    resolve(projectRoot: string): QuayEntrypointResolution {
      const resolvedProjectRoot = path.resolve(projectRoot);
      const signature = signatureFor(resolvedProjectRoot);
      const cached = cache.get(resolvedProjectRoot);
      if (cached !== undefined && cached.signature === signature) {
        return cached.result;
      }
      const result = resolveUncached(resolvedProjectRoot);
      cache.set(resolvedProjectRoot, { signature, result });
      return result;
    },
  };
}
