import type {
  Clock,
  LogLine,
  LogLineLevel,
  LogSource,
  LogWindow,
  LogsResponse,
  LogSourcesResponse,
} from '@/shared/types';
import type { LogDrawerOpenFilter } from '@/shared/ports/log-drawer.port';
import { createExternalStore, defaultClock } from '@/shared/utils';

/**
 * The React-free owner of the log drawer's reads, filters, follow state and
 * copy action.
 *
 * WHAT IT OWNS. The open filter, the resolved source/level/search, the retained
 * line window the server returned, the source roster, loading/error, follow, how
 * many lines were requested, and the copy status.
 *
 * THE RULES.
 *  - Reads run only while the drawer is OPEN: `open` starts the poller and
 *    `close`/`dispose` stop it. A closed drawer performs no request at all.
 *  - A newer read supersedes an older one (sequence token), so a late answer
 *    from a superseded filter cannot overwrite the current window.
 *  - A failed read is a visible `error` and keeps the previous window; it never
 *    throws into the UI.
 *  - The requestId/keyword search is client-side over the retained window; the
 *    server-side filters are `source`, `level`, `since` and `limit`.
 *  - "Load earlier" widens the request up to the server's 500-line ceiling; the
 *    window is bounded, so this reads more of what the process still retains,
 *    never a file.
 *
 * Consumers: `useLogDrawer` (the React binding) and the controller criterion.
 */

/** Lines one page asks for. */
export const LOG_DRAWER_PAGE_SIZE = 100;
/** The server's hard ceiling; "load earlier" stops here. */
export const LOG_DRAWER_MAX_LINES = 500;
/** How often an open drawer refreshes its window. */
export const LOG_DRAWER_POLL_MS = 3000;

/** The three reads the drawer depends on. */
export type LogDrawerApi = {
  logs: (filter: { source?: string; level?: LogLineLevel; since?: string; limit?: number }) => Promise<LogsResponse>;
  logSources: () => Promise<LogSourcesResponse>;
  bundle: () => Promise<string>;
};

/** The copy action's visible state. */
export type LogDrawerCopyState = 'idle' | 'copying' | 'copied' | 'failed';

/** Everything the drawer renders through `useSyncExternalStore`. */
export type LogDrawerSnapshot = {
  open: boolean;
  filter: LogDrawerOpenFilter;
  /** The selected source tab; null means every source. */
  source: string | null;
  /** The selected severity; null means every level. */
  level: LogLineLevel | null;
  /** The requestId/keyword the person typed (or the one the opener pre-filled). */
  search: string;
  /** The retained window after the client-side search. */
  visibleLines: LogLine[];
  /** How many lines the server returned before the search. */
  retainedCount: number;
  sources: LogSource[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  window: LogWindow | null;
  follow: boolean;
  limit: number;
  canLoadEarlier: boolean;
  copyState: LogDrawerCopyState;
  lastLoadedAt: string | null;
};

/** The commands plus subscription surface the hook drives. */
export type LogDrawerController = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LogDrawerSnapshot;
  /** Opens (or re-filters) the drawer and starts polling; never rejects. */
  open: (filter?: LogDrawerOpenFilter) => void;
  /** Closes the drawer and stops polling. */
  close: () => void;
  setSource: (source: string | null) => void;
  setLevel: (level: LogLineLevel | null) => void;
  setSearch: (search: string) => void;
  setFollow: (follow: boolean) => void;
  /** Forces a re-read now; never rejects. */
  refresh: () => void;
  /** Widens the request by one page, up to the server ceiling. */
  loadEarlier: () => void;
  /** Copies the diagnostics bundle plus the visible window; never rejects. */
  copyBundle: () => void;
  resetCopyState: () => void;
  dispose: () => void;
};

/** The injected collaborators. */
export type LogDrawerControllerDeps = {
  api: LogDrawerApi;
  writeClipboard: (text: string) => Promise<void>;
  clock?: Clock;
  pollIntervalMs?: number;
  pageSize?: number;
};

/** Case-insensitive substring match; an empty search matches every line. */
function matchesSearch(line: LogLine, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return line.text.toLowerCase().includes(needle)
    || line.source.toLowerCase().includes(needle)
    || line.level.toLowerCase().includes(needle);
}

/** Builds one controller.
 *
 * Consumers: `useLogDrawer` (per mount) and the controller criterion.
 */
export function createLogDrawerController(deps: LogDrawerControllerDeps): LogDrawerController {
  const clock = deps.clock ?? defaultClock;
  const pollIntervalMs = deps.pollIntervalMs ?? LOG_DRAWER_POLL_MS;
  const pageSize = deps.pageSize ?? LOG_DRAWER_PAGE_SIZE;

  let openState = false;
  let filter: LogDrawerOpenFilter = {};
  let source: string | null = null;
  let level: LogLineLevel | null = null;
  let search = '';
  let lines: LogLine[] = [];
  let sources: LogSource[] = [];
  let loading = false;
  let error: string | null = null;
  let truncated = false;
  let window: LogWindow | null = null;
  let follow = true;
  let limit = pageSize;
  let copyState: LogDrawerCopyState = 'idle';
  let lastLoadedAt: string | null = null;

  // Sequence tokens and the poller handle; all owner state lives in this closure.
  let loadSeq = 0;
  let copySeq = 0;
  let pollHandle: ReturnType<Clock['setInterval']> | null = null;
  let disposed = false;

  const buildSnapshot = (): LogDrawerSnapshot => ({
    open: openState,
    filter,
    source,
    level,
    search,
    visibleLines: lines.filter((line) => matchesSearch(line, search)),
    retainedCount: lines.length,
    sources,
    loading,
    error,
    truncated,
    window,
    follow,
    limit,
    canLoadEarlier: limit < LOG_DRAWER_MAX_LINES,
    copyState,
    lastLoadedAt,
  });

  const store = createExternalStore<LogDrawerSnapshot>(buildSnapshot());
  const publish = (): void => {
    if (!disposed) store.set(buildSnapshot());
  };

  const requestFilter = (): { source?: string; level?: LogLineLevel; since?: string; limit: number } => ({
    ...(source === null ? {} : { source }),
    ...(level === null ? {} : { level }),
    ...(filter.since === undefined ? {} : { since: filter.since }),
    limit,
  });

  const load = (showLoading: boolean): void => {
    if (disposed || !openState) return;
    const seq = ++loadSeq;
    if (showLoading) {
      loading = true;
      error = null;
      publish();
    }
    void (async () => {
      try {
        const [reading, sourceReading] = await Promise.all([
          deps.api.logs(requestFilter()),
          deps.api.logSources(),
        ]);
        if (disposed || !openState || seq !== loadSeq) return;
        lines = reading.lines;
        truncated = reading.truncated;
        window = reading.window;
        sources = sourceReading.sources;
        lastLoadedAt = new Date(clock.now()).toISOString();
        loading = false;
        error = null;
        publish();
      } catch (reason) {
        if (disposed || !openState || seq !== loadSeq) return;
        loading = false;
        error = reason instanceof Error ? reason.message : String(reason);
        publish();
      }
    })();
  };

  const stopPolling = (): void => {
    if (pollHandle === null) return;
    clock.clearInterval(pollHandle);
    pollHandle = null;
  };

  const startPolling = (): void => {
    stopPolling();
    if (disposed || !openState) return;
    pollHandle = clock.setInterval(() => load(false), pollIntervalMs);
  };

  const open = (next: LogDrawerOpenFilter = {}): void => {
    if (disposed) return;
    openState = true;
    filter = { ...next };
    source = next.source ?? null;
    level = next.level ?? null;
    search = next.requestId ?? '';
    lines = [];
    truncated = false;
    window = null;
    loading = true;
    error = null;
    follow = true;
    limit = pageSize;
    load(true);
    startPolling();
    publish();
  };

  const close = (): void => {
    if (disposed) return;
    openState = false;
    loadSeq += 1;
    stopPolling();
    publish();
  };

  const refilter = (): void => {
    limit = pageSize;
    load(true);
  };

  const loadEarlier = (): void => {
    if (disposed || !openState || limit >= LOG_DRAWER_MAX_LINES) return;
    limit = Math.min(LOG_DRAWER_MAX_LINES, limit + pageSize);
    load(true);
  };

  const copyBundle = (): void => {
    if (disposed || copyState === 'copying') return;
    const seq = ++copySeq;
    const snapshot = buildSnapshot();
    copyState = 'copying';
    publish();
    void (async () => {
      try {
        const bundle = await deps.api.bundle();
        const header = `--- process log window: ${snapshot.visibleLines.length}/${snapshot.retainedCount} lines` +
          `${snapshot.truncated ? ', older lines dropped' : ''} ---`;
        const body = snapshot.visibleLines
          .map((line) => `${line.at} ${line.level.toUpperCase()} [${line.source}] ${line.text}`)
          .join('\n');
        await deps.writeClipboard(`${bundle}\n\n${header}\n${body}`);
        if (disposed || seq !== copySeq) return;
        copyState = 'copied';
      } catch {
        if (disposed || seq !== copySeq) return;
        copyState = 'failed';
      }
      publish();
    })();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    open,
    close,
    setSource: (next) => {
      if (disposed) return;
      source = next;
      refilter();
    },
    setLevel: (next) => {
      if (disposed) return;
      level = next;
      refilter();
    },
    setSearch: (next) => {
      if (disposed) return;
      search = next;
      publish();
    },
    setFollow: (next) => {
      if (disposed) return;
      follow = next;
      publish();
    },
    refresh: () => load(true),
    loadEarlier,
    copyBundle,
    resetCopyState: () => {
      if (disposed || copyState === 'idle') return;
      copySeq += 1;
      copyState = 'idle';
      publish();
    },
    dispose: () => {
      disposed = true;
      openState = false;
      loadSeq += 1;
      copySeq += 1;
      stopPolling();
    },
  };
}
