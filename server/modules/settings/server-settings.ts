/**
 * The SERVER-level settings file — one deployment-editable file for knobs that belong to the
 * server process rather than to a user.
 *
 * WHY A FILE. The deployment knobs this project owns are moving off per-key environment
 * variables and onto a file the operator can edit without a rebuild (the same direction
 * `voice-realtime-settings.ts` took). `SERVER_SETTINGS_PATH` is the ONLY environment entry:
 * it names the file, and exists as an escape hatch for a deployment that keeps its
 * configuration somewhere other than the shipped location. There are no per-key env
 * variables here — a knob is added by adding a key to this file and a reader to this module.
 *
 * WHAT IT IS NOT. This file carries SERVER-level knobs only. Per-user settings stay in the
 * existing user settings store; a knob that differs per user does not belong here.
 *
 * THE USER COPY. The shipped defaults live in code; `config/server.settings.example.json` is
 * the committed template and `~/.config/claudecodeui/server.settings.json` is the copy an
 * operator edits. A missing user copy is the normal state, not a problem: it means "keep the
 * shipped defaults", which is why it is reported with an empty `problems` list while an
 * EXPLICITLY named path that cannot be read is a problem the operator must see.
 *
 * READ ONCE, AT BOOT. `server/index.ts` calls {@link loadServerSettings} once, before it
 * decides whether to restore resident sessions. An edit therefore reaches the NEXT boot and
 * cannot change a running process underneath itself.
 *
 * SHAPE ERRORS. A file that names an unknown key is accepted — unknown keys are ignored, so a
 * file written for a newer build does not stop an older one from booting. A known key with a
 * malformed value falls back to its shipped default and the reason lands in `problems`
 * (the same shape-error rule the voice settings loader follows). None of that throws: a
 * malformed knob must never be able to stop the server from booting.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_RESIDENT_RESTORE_ENABLED,
  DEFAULT_RESIDENT_RESTORE_MAX,
  DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS,
} from '@/modules/session-hosts/index.js';
import {
  DEFAULT_OBSERVATION_WALL_LIMIT,
  DEFAULT_VIEW_EVENTS_ENABLED,
  defaultViewEventsPath,
  type ViewEventsSettings,
} from '@/modules/observation/index.js';

/**
 * The environment variable naming the settings file, or nothing when the shipped user-copy
 * path is the one to read.
 *
 * The single environment entry for this file: it points at the file and nothing else. An
 * unset value means {@link defaultServerSettingsPath}. Consumed by
 * {@link loadServerSettings} (and pinned by the resident-restore criterion, which names it
 * as the contract).
 */
export const SERVER_SETTINGS_ENV = 'SERVER_SETTINGS_PATH';

/**
 * The path an operator's copy of the settings file lives at when no other path is named.
 *
 * Resolved at call time rather than at module load, so a HOME set by the process (or by a
 * criterion) is the HOME this reading consults. Consumed by {@link loadServerSettings}.
 */
function defaultServerSettingsPath(): string {
  return path.join(homedir(), '.config', 'claudecodeui', 'server.settings.json');
}

/**
 * The start-up resident-session restore pass's policy, as read from this file.
 *
 * `enabled` is the switch, shipped on: the pass brings the recently active resident sessions
 * back at boot, launching one provider process per session, and an operator who does not want
 * that launch burst writes `false`. `max` is the per-pass ceiling. `maxAgeMs`
 * is the activity window, and its shipped default is the resident idle ceiling itself, so
 * "alive before the restart" cannot drift from the lifetime policy. Consumed by
 * `server/index.ts`, which hands the block to the restore pass, and by the resident-restore
 * criterion.
 */
export type ResidentRestoreSettings = {
  enabled: boolean;
  max: number;
  maxAgeMs: number;
};

/** Where a reading came from: the shipped defaults, or a file that was read and accepted. */
export type ServerSettingsSource = 'default' | 'file';

/**
 * The observation wall's and view instrumentation's server-level policy.
 *
 * `wallLimit` is the number of object blocks the wall renders before folding the rest. The
 * observation layer's own 「观察层自身」 entry is deliberately NOT part of this cap — a wall
 * that is quiet because its producers died must still say so. `viewEvents` controls the local
 * UI view-event log: `enabled` ships true (the log stays on this machine and never enters the
 * database), and `path` names the JSONL file the server appends to. Consumed by
 * `server/index.ts` when it composes the observation module.
 */
export type ObservationSettings = {
  wallLimit: number;
  viewEvents: ViewEventsSettings;
};

/**
 * One reading of the server settings file, good for the whole boot.
 *
 * `residentRestore` and `observation` are ALWAYS concrete and always default-filled: a file
 * that said nothing — or named a malformed value — leaves the shipped default in place, so no
 * caller has to decide what a half-valid file means. `source` says whether a file was accepted;
 * `path` is the file this reading consulted (the user copy when nothing named one); `problems`
 * explains every value that fell back, oldest first, and is what `server/index.ts` logs.
 * Consumed by `server/index.ts`, by the resident-restore criterion, and by the observation
 * wall's composition.
 */
export type ServerSettings = {
  residentRestore: ResidentRestoreSettings;
  observation: ObservationSettings;
  source: ServerSettingsSource;
  path: string;
  problems: string[];
};

/**
 * Reads the server settings for this boot.
 *
 * Resolution order for the file: `options.settingsPath` (the criterion's and a caller's
 * override) > {@link SERVER_SETTINGS_ENV} > {@link defaultServerSettingsPath}. Never throws:
 * an unreadable explicitly named file, an invalid JSON document and every malformed knob come
 * back as the shipped defaults with the reason in `problems`.
 *
 * A missing file at the DEFAULT path is not a problem — it is the state of every deployment
 * that has not configured anything — so it returns the shipped defaults with an empty
 * `problems` list. An explicitly named path that does not exist IS a problem, because the
 * operator asked for that file and did not get it.
 *
 * `env` and `defaultPath` are injectable so the criterion can drive both branches without
 * mutating the process environment or depending on the operator's home directory.
 */
export function loadServerSettings(options: {
  settingsPath?: string | undefined;
  env?: Record<string, string | undefined>;
  defaultPath?: string | undefined;
} = {}): ServerSettings {
  const env = options.env ?? process.env;
  const named = options.settingsPath ?? env[SERVER_SETTINGS_ENV];
  const explicit = typeof named === 'string' && named.trim() !== '';
  const filePath = explicit ? named.trim() : (options.defaultPath ?? defaultServerSettingsPath());
  const defaults = defaultServerSettings(filePath);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (failure) {
    // The user copy is optional: its absence is "use the shipped defaults", not a bad config.
    if (!explicit && isMissingFile(failure)) {
      return defaults;
    }
    return { ...defaults, problems: [`could not read ${filePath}: ${errorMessage(failure)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (failure) {
    return {
      ...defaults,
      problems: [`${filePath} is not valid JSON: ${errorMessage(failure)}`],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...defaults, problems: [`${filePath} must contain a JSON object`] };
  }

  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];
  // Only the keys this module knows are read; every other top-level key is ignored, so a file
  // carrying knobs for a newer build still boots an older one.
  const residentRestore = readResidentRestore(record.residentRestore, problems);
  const observation = readObservation(record.observation, problems);

  return { residentRestore, observation, source: 'file', path: filePath, problems };
}

/**
 * The shipped reading, used when nothing is configured and as the fallback every malformed
 * value lands on.
 */
function defaultServerSettings(filePath: string): ServerSettings {
  return {
    residentRestore: {
      enabled: DEFAULT_RESIDENT_RESTORE_ENABLED,
      max: DEFAULT_RESIDENT_RESTORE_MAX,
      maxAgeMs: DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS,
    },
    observation: {
      wallLimit: DEFAULT_OBSERVATION_WALL_LIMIT,
      viewEvents: { enabled: DEFAULT_VIEW_EVENTS_ENABLED, path: defaultViewEventsPath() },
    },
    source: 'default',
    path: filePath,
    problems: [],
  };
}

/**
 * The `residentRestore` block, field by field over the shipped defaults.
 *
 * A malformed field falls back on its OWN rather than refusing the whole block: a typo in
 * `max` must not silently turn off a pass the operator explicitly enabled. A value that is
 * not an object at all cannot be read field by field, so the whole block keeps its defaults
 * and says why.
 */
function readResidentRestore(raw: unknown, problems: string[]): ResidentRestoreSettings {
  const settings: ResidentRestoreSettings = {
    enabled: DEFAULT_RESIDENT_RESTORE_ENABLED,
    max: DEFAULT_RESIDENT_RESTORE_MAX,
    maxAgeMs: DEFAULT_RESIDENT_RESTORE_MAX_AGE_MS,
  };

  if (raw === undefined) {
    return settings;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push('`residentRestore` must be a JSON object');
    return settings;
  }

  const record = raw as Record<string, unknown>;
  if (record.enabled !== undefined) {
    if (typeof record.enabled === 'boolean') {
      settings.enabled = record.enabled;
    } else {
      problems.push('`residentRestore.enabled` must be a boolean');
    }
  }
  if (record.max !== undefined) {
    if (isPositiveInteger(record.max)) {
      settings.max = record.max;
    } else {
      problems.push('`residentRestore.max` must be a positive integer');
    }
  }
  if (record.maxAgeMs !== undefined) {
    if (isPositiveInteger(record.maxAgeMs)) {
      settings.maxAgeMs = record.maxAgeMs;
    } else {
      problems.push('`residentRestore.maxAgeMs` must be a positive integer');
    }
  }
  return settings;
}

/** A JSON number that is a whole count of sessions or milliseconds; anything else falls back. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * The `observation` block, field by field over the shipped defaults.
 *
 * A malformed block keeps the shipped values and says why in `problems`. The wall limit must be
 * a positive integer: zero would render an empty wall while everything behind it is healthy,
 * which is the exact "quiet looks fine" failure the layer exists to rule out. `viewEvents` is
 * read by {@link readViewEvents}.
 */
function readObservation(raw: unknown, problems: string[]): ObservationSettings {
  const settings: ObservationSettings = {
    wallLimit: DEFAULT_OBSERVATION_WALL_LIMIT,
    viewEvents: { enabled: DEFAULT_VIEW_EVENTS_ENABLED, path: defaultViewEventsPath() },
  };

  if (raw === undefined) {
    return settings;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push('`observation` must be a JSON object');
    return settings;
  }

  const record = raw as Record<string, unknown>;
  if (record.wallLimit !== undefined) {
    if (isPositiveInteger(record.wallLimit)) {
      settings.wallLimit = record.wallLimit;
    } else {
      problems.push('`observation.wallLimit` must be a positive integer');
    }
  }
  settings.viewEvents = readViewEvents(record.viewEvents, problems);
  return settings;
}

/**
 * The `observation.viewEvents` block, field by field over the shipped defaults.
 *
 * The switch must be a real boolean: a string `"false"` is a malformed value, not an opt-out,
 * so it falls back to the shipped `true` and is reported — the same "silently off looks like a
 * quiet machine" failure the wall itself rules out. A `path` must be a non-empty string; it is
 * used as written, so an operator who names a relative path gets it resolved from the server's
 * working directory.
 */
function readViewEvents(raw: unknown, problems: string[]): ViewEventsSettings {
  const settings: ViewEventsSettings = {
    enabled: DEFAULT_VIEW_EVENTS_ENABLED,
    path: defaultViewEventsPath(),
  };
  if (raw === undefined) {
    return settings;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push('`observation.viewEvents` must be a JSON object');
    return settings;
  }

  const record = raw as Record<string, unknown>;
  if (record.enabled !== undefined) {
    if (typeof record.enabled === 'boolean') {
      settings.enabled = record.enabled;
    } else {
      problems.push('`observation.viewEvents.enabled` must be a boolean');
    }
  }
  if (record.path !== undefined) {
    if (typeof record.path === 'string' && record.path.trim() !== '') {
      settings.path = record.path;
    } else {
      problems.push('`observation.viewEvents.path` must be a non-empty string');
    }
  }
  return settings;
}

/** Whether the read failure was "the file is not there", the one benign case for the user copy. */
function isMissingFile(failure: unknown): boolean {
  return (failure as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** The sentence from a failed read or parse, whatever was thrown. */
function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
