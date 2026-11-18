/**
 * The diagnostics log-window reading.
 *
 * It adapts the process-local `LogRing` into the two shapes the HTTP face
 * publishes: the source roster (with live counts and newest timestamps) and the
 * filtered line window. It owns no storage — the ring is injected — so this
 * module stays the leaf it already is and a criterion can drive it over a ring
 * built with fixture lines.
 *
 * INPUT DISCIPLINE. The only accepted query parameters are `source`, `level`,
 * `since` and `limit`. There is no path, filename or offset: an unknown source
 * simply matches nothing, while a malformed `level`/`since` is a 400 rather than
 * a silent default. `limit` is clamped to `[1, 500]` by the ring itself.
 *
 * Consumers: `diagnostics.routes.ts` (the HTTP face) and the diagnostics-logs
 * criterion.
 */
import { AppError } from '@/shared/utils.js';
import {
  clampLogLimit,
  DEFAULT_LOG_LIMIT,
  LOG_SOURCE_IDS,
  parseLogSince,
  type LogLevel,
  type LogLine,
  type LogReadQuery,
  type LogRing,
} from '@/shared/log-ring.js';

/** One source the drawer offers as a tab, with its live count. */
export type DiagnosticsLogSource = {
  id: string;
  label: string;
  count: number;
  lastAt: string | null;
};

/** The `/logs` answer: the retained window plus the caps the client displays. */
export type DiagnosticsLogsReading = {
  lines: LogLine[];
  truncated: boolean;
  window: { maxLines: number; maxBytes: number };
};

/** The four filters one read accepts, already parsed. */
export type DiagnosticsLogsQuery = {
  source?: string;
  level?: LogLevel;
  since?: number;
  limit: number;
};

/** The reader the route factory drives. */
export type DiagnosticsLogsReader = {
  sources: () => DiagnosticsLogSource[];
  read: (query: DiagnosticsLogsQuery) => DiagnosticsLogsReading;
};

/** The stable display labels; the UI localizes the known ids and falls back to these. */
const SOURCE_LABELS: Record<string, string> = {
  server: 'Server',
  'reply-suggestions': 'Reply suggestions',
  sessions: 'Sessions',
  voice: 'Voice',
  other: 'Other',
};

const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error'];

/** Reads the first value of an Express query entry (arrays collapse to their first). */
function firstQueryValue(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Reads `?source=`. Unknown ids are passed through and match nothing; the route
 * must not turn a bad source into an error because a stale tab is harmless.
 */
export function readLogsSource(raw: unknown): string | undefined {
  const value = firstQueryValue(raw);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Reads `?level=`; anything outside info/warn/error is a 400. */
export function readLogsLevel(raw: unknown): LogLevel | undefined {
  const value = firstQueryValue(raw);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !LOG_LEVELS.includes(value as LogLevel)) {
    throw new AppError('level must be one of info, warn or error', {
      code: 'INVALID_LOG_LEVEL',
      statusCode: 400,
    });
  }
  return value as LogLevel;
}

/** Reads `?since=` as ISO-8601 or epoch milliseconds; an unparseable value is a 400. */
export function readLogsSince(raw: unknown): number | undefined {
  const value = firstQueryValue(raw);
  if (value === undefined) return undefined;
  const parsed = parseLogSince(value);
  if (parsed === null) {
    throw new AppError('since must be an ISO-8601 timestamp or epoch milliseconds', {
      code: 'INVALID_LOG_SINCE',
      statusCode: 400,
    });
  }
  return parsed;
}

/** Reads `?limit=`; non-numeric takes the default and any number is clamped to `[1, 500]`. */
export function readLogsLimit(raw: unknown): number {
  const value = firstQueryValue(raw);
  const parsed = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : typeof value === 'number' ? value : Number.NaN;
  return clampLogLimit(Number.isFinite(parsed) ? parsed : DEFAULT_LOG_LIMIT);
}

/** Reads every supported parameter off a request query object. */
export function readLogsQuery(query: Record<string, unknown>): DiagnosticsLogsQuery {
  const source = readLogsSource(query.source);
  const level = readLogsLevel(query.level);
  const since = readLogsSince(query.since);
  return {
    ...(source === undefined ? {} : { source }),
    ...(level === undefined ? {} : { level }),
    ...(since === undefined ? {} : { since }),
    limit: readLogsLimit(query.limit),
  };
}

/**
 * Builds the reader over the injected ring.
 *
 * Consumers: `diagnostics.module.ts` only; the barrel exposes the module factory.
 */
export function createDiagnosticsLogsReader(ring: LogRing): DiagnosticsLogsReader {
  const sources = (): DiagnosticsLogSource[] => {
    const stats = ring.stats();
    const byId = new Map(stats.sources.map((source) => [source.id, source]));
    const ids = [...new Set([...LOG_SOURCE_IDS, ...stats.sources.map((source) => source.id)])];
    return ids.map((id) => {
      const source = byId.get(id);
      return {
        id,
        label: SOURCE_LABELS[id] ?? id,
        count: source?.count ?? 0,
        lastAt: source?.lastAt ?? null,
      };
    });
  };

  const read = (query: DiagnosticsLogsQuery): DiagnosticsLogsReading => {
    // An unknown source reaches `ring.read` as an exact filter and yields no
    // lines; it can never select a path or a file.
    const readQuery: LogReadQuery = {
      limit: query.limit,
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.level === undefined ? {} : { level: query.level }),
      ...(query.since === undefined ? {} : { since: query.since }),
    };
    const stats = ring.stats();
    return {
      lines: ring.read(readQuery),
      truncated: stats.truncated,
      window: { maxLines: stats.maxLines, maxBytes: stats.maxBytes },
    };
  };

  return { sources, read };
}
