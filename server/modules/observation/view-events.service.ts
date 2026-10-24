/**
 * The local UI view-event log — persistence half of the view instrumentation.
 *
 * The browser reports the viewing episodes it leaves (`{ at, kind, target, fromTarget,
 * dwellMs, deviceId }`) and this service appends them, one JSON object per line, to a file that
 * never leaves this machine. It is deliberately NOT a database table: the log is per-host
 * observation data for the weekly report, not user state that should synchronise across devices.
 *
 * The path and the switch come from the server settings file's `observation.viewEvents` block.
 * The switch is enforced HERE, not only in the browser: with it off the route still answers
 * 204 (the caller did nothing wrong) and nothing is written.
 *
 * Consumers: `server/modules/observation/view-events.routes.ts` (the HTTP face) and
 * `server/modules/observation/observation.module.ts` (composition). The shipped defaults are
 * re-exported through the module barrel for `server/modules/settings/server-settings.ts`.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/** The kind of reading the reader left. Mirrors the frontend's `ViewEventKind`. */
export type ViewEventKind = 'session' | 'tab' | 'cockpit-tile' | 'cockpit-preview';

/**
 * One validated viewing episode, with exactly the fields the log keeps.
 *
 * `at` is the leave timestamp in ms since epoch, `dwellMs` the visible time of the episode,
 * `fromTarget` the target the reader came from (null for the first episode of a page), and
 * `deviceId` the browser's stable identity from the MCP client registry.
 */
export type ViewEventRecord = {
  at: number;
  kind: ViewEventKind;
  target: string;
  fromTarget: string | null;
  dwellMs: number;
  deviceId: string;
};

/** The `observation.viewEvents` server setting, as the module consumes it. */
export type ViewEventsSettings = {
  enabled: boolean;
  path: string;
};

/** The shipped switch: recording starts on, an operator turns it off in the settings file. */
export const DEFAULT_VIEW_EVENTS_ENABLED = true;

/**
 * The shipped log path, resolved at call time so a HOME set by the process (or by a criterion)
 * is the HOME consulted. `~/.cloudcli/` is the same local state directory the server already
 * uses; the file stays outside the repository and outside the synced database.
 */
export function defaultViewEventsPath(): string {
  return path.join(homedir(), '.cloudcli', 'ui-view-events.jsonl');
}

/** Expands a leading `~` so the example file's `~/.cloudcli/...` path is usable as written. */
function expandHome(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return path.join(homedir(), filePath.slice(2));
  return filePath;
}

/** Fills a partial reading with the shipped defaults (used by the module's own composition). */
export function resolveViewEventsSettings(partial: Partial<ViewEventsSettings> = {}): ViewEventsSettings {
  return {
    enabled: partial.enabled ?? DEFAULT_VIEW_EVENTS_ENABLED,
    path: expandHome(partial.path ?? defaultViewEventsPath()),
  };
}

/** One batch's size ceiling. An oversized body is refused whole rather than truncated. */
export const MAX_VIEW_EVENTS_PER_BATCH = 200;

/** Longest accepted free-text field, so one bad caller cannot write an unbounded line. */
const MAX_TEXT_LENGTH = 512;

/** Longest accepted device id; the registry's ids are UUIDs. */
const MAX_DEVICE_ID_LENGTH = 200;

const VIEW_EVENT_KINDS: ReadonlySet<string> = new Set<ViewEventKind>([
  'session',
  'tab',
  'cockpit-tile',
  'cockpit-preview',
]);

/** The service the routes call: validate one batch, append it, or explain why not. */
export type ViewEventService = {
  /** Appends a validated batch and resolves the number of lines written (0 when disabled). */
  appendBatch: (body: unknown) => Promise<number>;
};

function invalid(message: string, statusCode = 400, code = 'INVALID_REQUEST'): AppError {
  return new AppError(message, { code, statusCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A bounded, non-empty string, or null when the value is not one. */
function readText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLength) return null;
  return trimmed;
}

/** One raw event reduced to the fields the log keeps, or an AppError naming the field. */
function parseViewEvent(raw: unknown, index: number): ViewEventRecord {
  if (!isRecord(raw)) throw invalid(`\`events[${index}]\` must be a JSON object`);

  const at = raw.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    throw invalid(`\`events[${index}].at\` must be a non-negative number`);
  }

  const kind = typeof raw.kind === 'string' && VIEW_EVENT_KINDS.has(raw.kind) ? (raw.kind as ViewEventKind) : null;
  if (kind === null) {
    throw invalid(`\`events[${index}].kind\` must be one of session, tab, cockpit-tile, cockpit-preview`);
  }

  const target = readText(raw.target, MAX_TEXT_LENGTH);
  if (target === null) throw invalid(`\`events[${index}].target\` must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);

  const fromTarget = raw.fromTarget === null || raw.fromTarget === undefined ? null : readText(raw.fromTarget, MAX_TEXT_LENGTH);
  if (raw.fromTarget !== null && raw.fromTarget !== undefined && fromTarget === null) {
    throw invalid(`\`events[${index}].fromTarget\` must be null or a non-empty string of at most ${MAX_TEXT_LENGTH} characters`);
  }

  const dwellMs = raw.dwellMs;
  if (typeof dwellMs !== 'number' || !Number.isFinite(dwellMs) || dwellMs < 0) {
    throw invalid(`\`events[${index}].dwellMs\` must be a non-negative number`);
  }

  const deviceId = readText(raw.deviceId, MAX_DEVICE_ID_LENGTH);
  if (deviceId === null) throw invalid(`\`events[${index}].deviceId\` must be a non-empty string of at most ${MAX_DEVICE_ID_LENGTH} characters`);

  // Only the known fields are written; extras are ignored rather than persisted.
  return { at, kind, target, fromTarget, dwellMs, deviceId };
}

/**
 * Validates one request body into the records to append.
 *
 * The batch shape is `{ events: [...] }`. An empty array is accepted as a no-op; an oversized
 * one is refused whole (413) so a client that ignores the ceiling learns about it instead of
 * having its history silently truncated.
 */
export function parseViewEventBatch(body: unknown): ViewEventRecord[] {
  if (!isRecord(body)) throw invalid('body must be a JSON object with an `events` array');
  const events = body.events;
  if (!Array.isArray(events)) throw invalid('`events` must be an array');
  if (events.length > MAX_VIEW_EVENTS_PER_BATCH) {
    throw invalid(
      `\`events\` carries ${events.length} records, over the batch limit of ${MAX_VIEW_EVENTS_PER_BATCH}`,
      413,
      'BATCH_TOO_LARGE',
    );
  }
  return events.map(parseViewEvent);
}

/**
 * Builds the service over one reading of `observation.viewEvents`.
 *
 * Consumers: `server/modules/observation/observation.module.ts`.
 */
export function createViewEventService(settings: ViewEventsSettings): ViewEventService {
  const filePath = settings.path;

  return {
    appendBatch: async (body: unknown): Promise<number> => {
      if (!settings.enabled) return 0;
      const records = parseViewEventBatch(body);
      if (records.length === 0) return 0;
      const line = records.map((record) => `${JSON.stringify(record)}\n`).join('');
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        await appendFile(filePath, line, 'utf8');
      } catch (failure) {
        const reason = failure instanceof Error ? failure.message : String(failure);
        throw new AppError(`could not append to ${filePath}: ${reason}`, {
          code: 'VIEW_EVENT_WRITE_FAILED',
          statusCode: 500,
        });
      }
      return records.length;
    },
  };
}
