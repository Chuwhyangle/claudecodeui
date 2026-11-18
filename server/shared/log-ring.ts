/**
 * The process-local, structured, redacted log window.
 *
 * WHY THIS EXISTS. The diagnostics surfaces can report *that* a draw failed and
 * the correlation facts of the failure, but an operator recovering an incident
 * still needs the surrounding lines. A journald proxy or an arbitrary file read
 * would add a second log source (and a path-traversal surface) to a server whose
 * disk is nearly full; this module instead keeps a small bounded window of the
 * lines the process already prints, in memory, for the life of the process.
 *
 * WHAT IT IS. `createLogRing` owns one bounded ring (line and byte caps, oldest
 * dropped first) and the redaction that runs at APPEND time, so a secret never
 * enters the stored line. `installConsoleLogTee` is the one adapter that feeds
 * the process's `console.log/warn/error` into a ring; it is installed by the
 * composition root and is idempotent. Neither the ring nor its `read`/`stats`
 * methods print, so the tee cannot recurse.
 *
 * HARD BOUNDS. `maxLines` defaults to 1000 and `maxBytes` to 512 KiB, both
 * clamped to a fixed ceiling; one stored line is additionally capped at
 * `MAX_LOG_LINE_CHARS`. `read().limit` is clamped to `[1, 500]` and a request may
 * never name a path or a file — the only inputs are `since`, `level`, `source`
 * and `limit`.
 *
 * Consumers: `server/index.ts` (creates the one ring, installs the tee and
 * injects the ring into the diagnostics module) and `server/modules/diagnostics`
 * (reads it through the injected ring). The log-ring criterion drives it
 * directly.
 */

// --------------------------- WIRE SHAPES ---------------------------

/** The three severities the window keeps; there is no debug level by design. */
export type LogLevel = 'info' | 'warn' | 'error';

/** One stored line: when, how severe, which subsystem, and the redacted text. */
export type LogLine = {
  at: string;
  level: LogLevel;
  source: string;
  text: string;
};

/** What a producer appends. `at` defaults to now and `source` is derived when absent. */
export type LogAppendInput = {
  at?: string;
  level: LogLevel;
  source?: string;
  text: string;
};

/** What a reader may filter on. `limit` is clamped to `[1, 500]`. */
export type LogReadQuery = {
  since?: string | number;
  level?: LogLevel;
  source?: string;
  limit?: number;
};

/** One source's live count and newest timestamp. */
export type LogSourceStat = {
  id: string;
  count: number;
  lastAt: string | null;
};

/** The ring's readings; `truncated` is true once any line was dropped for a cap. */
export type LogRingStats = {
  size: number;
  bytes: number;
  maxLines: number;
  maxBytes: number;
  truncated: boolean;
  sources: LogSourceStat[];
};

/** The lifecycle-owning surface the composition root and the reader share. */
export type LogRing = {
  append: (input: LogAppendInput) => LogLine;
  read: (query?: LogReadQuery) => LogLine[];
  stats: () => LogRingStats;
};

// --------------------------- BOUNDS ---------------------------

/** Lines one request gets when it names no `limit`. */
export const DEFAULT_LOG_LIMIT = 200;
/** The hard ceiling a request may ask for. */
export const MAX_LOG_LIMIT = 500;
/** Default line cap; a restart begins a fresh window. */
export const DEFAULT_MAX_LOG_LINES = 1000;
/** Default byte cap for the whole window (512 KiB). */
export const DEFAULT_MAX_LOG_BYTES = 512 * 1024;
/** One stored line may not exceed this many characters, whatever the caller passes. */
export const MAX_LOG_LINE_CHARS = 4000;

/** The source ids the diagnostics surface always lists. */
export const LOG_SOURCE_IDS: readonly string[] = [
  'server',
  'reply-suggestions',
  'sessions',
  'voice',
  'other',
];

/** Clamps a caller-supplied limit into `[1, 500]`; a non-finite value takes the default. */
export function clampLogLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LOG_LIMIT;
  return Math.min(MAX_LOG_LIMIT, Math.max(1, Math.trunc(value)));
}

/**
 * Reads an ISO-8601 timestamp or epoch milliseconds into epoch milliseconds.
 * Returns null for anything unparseable, which the HTTP route turns into a 400.
 */
export function parseLogSince(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

// --------------------------- SOURCE DERIVATION ---------------------------

/**
 * Derives a source from a leading `[feature]` token. The ids the diagnostics
 * surface lists are stable; a prefix the process prints but this table does not
 * know collapses to `other` rather than inventing a tab.
 */
export function deriveLogSource(text: string): string {
  const match = /^\s*\[([A-Za-z0-9][A-Za-z0-9._-]*)\]/.exec(text);
  if (match === null) return 'other';
  const token = match[1].toLowerCase();
  if (token === 'reply-suggestions' || token === 'reply_suggestions') return 'reply-suggestions';
  if (token === 'server') return 'server';
  if (token === 'sessions' || token === 'session') return 'sessions';
  if (token === 'voice' || token.startsWith('voice-')) return 'voice';
  return 'other';
}

// --------------------------- REDACTION ---------------------------

/**
 * Strings that must never be stored. Specific header/assignment forms run before
 * the generic `token=` rule so a substituted `[redacted]` is not re-matched.
 */
const REDACTION_RULES: readonly (readonly [RegExp, string])[] = [
  [/x-api-key\s*[:=]\s*[^\s,;]+/gi, '[redacted]'],
  [/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{3,}/gi, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/[A-Z][A-Z0-9_]*_API_KEY\s*=\s*\S+/g, '[redacted]'],
  [/\b(?:api[_-]?key|client_secret)\b\s*[:=]\s*[^\s,;]+/gi, '[redacted]'],
  [/\b(?:token|secret|password)\b\s*[:=]\s*[^\s,;]+/gi, '[redacted]'],
];

/** Scrubs one line. Exported because the redaction criterion pins it directly. */
export function redactLogText(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

// --------------------------- RING ---------------------------

/** One stored entry plus its byte cost (the text dominates; the rest is fixed). */
type StoredLine = { line: LogLine; bytes: number };

/** The safest rendering of one console argument; never throws and never logs. */
function stringifyArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (value === null || typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Builds one bounded, redacting ring. All state lives in this closure — there is
 * no module-level singleton, so a criterion may build any number of rings.
 *
 * Consumers: `server/index.ts` (the process ring) and the log-ring criterion.
 */
export function createLogRing(options: {
  maxLines?: number;
  maxBytes?: number;
  now?: () => number;
  redact?: (text: string) => string;
} = {}): LogRing {
  const maxLines = Math.max(1, Math.trunc(options.maxLines ?? DEFAULT_MAX_LOG_LINES));
  const maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? DEFAULT_MAX_LOG_BYTES));
  const now = options.now ?? Date.now;
  const redact = options.redact ?? redactLogText;

  const entries: StoredLine[] = [];
  let bytes = 0;
  let truncated = false;

  const dropOldest = (): void => {
    const removed = entries.shift();
    if (removed === undefined) return;
    bytes -= removed.bytes;
    truncated = true;
  };

  const append = (input: LogAppendInput): LogLine => {
    const parsedAt = typeof input.at === 'string' ? Date.parse(input.at) : Number.NaN;
    const at = Number.isNaN(parsedAt) ? new Date(now()).toISOString() : input.at as string;
    const rawText = String(input.text ?? '');
    const text = redact(rawText).slice(0, MAX_LOG_LINE_CHARS);
    const source = input.source === undefined || input.source.trim() === ''
      ? deriveLogSource(text)
      : input.source.trim();
    const line: LogLine = { at, level: input.level, source, text };
    const size = Buffer.byteLength(JSON.stringify(line), 'utf8');
    entries.push({ line, bytes: size });
    bytes += size;
    // Drop oldest until BOTH caps hold. A line larger than `maxBytes` empties the
    // ring rather than being stored unbounded.
    while (entries.length > maxLines || bytes > maxBytes) {
      if (entries.length === 0) break;
      dropOldest();
    }
    return { ...line };
  };

  const read = (query: LogReadQuery = {}): LogLine[] => {
    const limit = clampLogLimit(query.limit);
    const since = query.since === undefined ? null : parseLogSince(query.since);
    const selected = entries
      .filter(({ line }) => query.level === undefined || line.level === query.level)
      .filter(({ line }) => query.source === undefined || line.source === query.source)
      .filter(({ line }) => since === null || Date.parse(line.at) >= since);
    return selected.slice(-limit).map(({ line }) => ({ ...line }));
  };

  const stats = (): LogRingStats => {
    const bySource = new Map<string, LogSourceStat>();
    for (const id of LOG_SOURCE_IDS) bySource.set(id, { id, count: 0, lastAt: null });
    for (const { line } of entries) {
      const existing = bySource.get(line.source) ?? { id: line.source, count: 0, lastAt: null };
      bySource.set(line.source, { id: existing.id, count: existing.count + 1, lastAt: line.at });
    }
    return {
      size: entries.length,
      bytes,
      maxLines,
      maxBytes,
      truncated,
      sources: [...bySource.values()],
    };
  };

  return { append, read, stats };
}

// --------------------------- CONSOLE TEE ---------------------------

/** The installed tee's handle; `uninstall` restores the original console methods. */
export type ConsoleLogTee = { uninstall: () => void };

/** Marker stored on the console object so a second install cannot double-wrap. */
const TEE_MARKER = Symbol.for('cloudpit.logRing.consoleTeeInstalled');

/**
 * Wraps `console.log/warn/error` once: every line is appended to the ring
 * (redacted) and then forwarded to the original method. Idempotent — a second
 * call on an already-wrapped console is a no-op — and the ring never prints, so
 * there is no recursion.
 *
 * Consumers: `server/index.ts` only. Criteria install their own ring when they
 * mean to exercise the tee, and never in a suite-wide setup.
 */
export function installConsoleLogTee(ring: LogRing, label = 'console'): ConsoleLogTee {
  const holder = console as Console & { [TEE_MARKER]?: boolean };
  if (holder[TEE_MARKER] === true) return { uninstall: () => {} };
  holder[TEE_MARKER] = true;

  // Cleared while appending so an argument's own `toString` that somehow prints
  // cannot re-enter the ring.
  let forwarding = true;
  const originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const wrap = (level: LogLevel, original: (...data: unknown[]) => void) => {
    return (...args: unknown[]): void => {
      if (forwarding) {
        forwarding = false;
        try {
          const text = args.map(stringifyArgument).join(' ');
          const source = label === 'console' ? deriveLogSource(text) : label;
          ring.append({ level, source, text });
        } catch {
          // A log line must never break the process.
        } finally {
          forwarding = true;
        }
      }
      original(...args);
    };
  };

  console.log = wrap('info', originals.log);
  console.warn = wrap('warn', originals.warn);
  console.error = wrap('error', originals.error);

  let installed = true;
  return {
    uninstall: (): void => {
      if (!installed) return;
      installed = false;
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
      delete holder[TEE_MARKER];
    },
  };
}
