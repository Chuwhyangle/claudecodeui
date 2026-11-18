/**
 * The local usage ledger for reply suggestions, and the ONE typed vocabulary of
 * the rows it holds.
 *
 * WHAT IT IS FOR. The chips a model offers are only half the story; whether a
 * person clicked one, cleared it, redrew or sent is the long-lived ground truth
 * an offline benchmark replays. This file appends one JSON object per line to a
 * local-only JSONL file under `~/.cloudpit` (the same root the attachment and
 * browser-profile stores use). Field names are the replay's contract: they are
 * unchanged from before this file owned the types.
 *
 * WHAT IT DOES NOT HOLD. The text a person ultimately sent is NOT stored: it can
 * be recovered from the session transcript, and copying it here would create a
 * second, drifting copy of the conversation. Only chips the SERVER showed and
 * the event names are written.
 *
 * CACHE HITS ARE STILL ROWS. A `shown` row carries `served`: `"upstream"` when
 * the batch came from a real model call, `"cache"` when the service returned the
 * batch it had already drawn for the same session, assistant message and
 * settings version. Both count as a display; only `"upstream"` is a paid call.
 * Rows written before this field existed have no `served` and must be read as
 * `"upstream"` (the offline replay does exactly that).
 *
 * SIZE IS BOUNDED. When the file would exceed the cap (5 MB by default) it is
 * rotated ONCE to `<file>.1`, replacing (and thereby discarding) the older
 * rotation. There is never a growing `.2`.
 *
 * Consumers: `reply-suggestions.service.ts` (the row builders and the writer);
 * the context-events tap in `server/index.ts` (the observer callback); the
 * service criterion and the context-events wiring criterion drive rotation and
 * field names.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultCloudpitDataRoot } from '@/shared/data-root.js';

import type {
  ReplySuggestionsEventName,
  ReplySuggestionsExpansionSource,
} from './reply-suggestions.service.js';
import type { ReplySuggestionsFailureCategory } from './reply-suggestions-failure-state.js';
import type { ReplySuggestionsProtocol, ReplySuggestionsSettings } from './reply-suggestions-settings.js';

/** The default cap for one ledger file: 5 MB, as the task's protection clause says. */
const REPLY_SUGGESTIONS_USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * How a `shown` row was produced: a real upstream call or a cache hit.
 *
 * Consumers: `reply-suggestions.service.ts` (the `shown` row's `served`).
 */
export type ReplySuggestionsServed = 'upstream' | 'cache';

/** One display of a batch. `expansion` is present only for an expansion draw. */
type ReplySuggestionsShownRecord = {
  at: string;
  type: 'shown';
  sessionId: string;
  draw: number;
  model: string;
  protocol: ReplySuggestionsProtocol;
  version: string;
  served: ReplySuggestionsServed;
  expansion?: ReplySuggestionsExpansionSource;
  chips: string[];
};

/** One client event. `index` is the chip position; `source` names an expansion. */
type ReplySuggestionsEventRecord = {
  at: string;
  type: ReplySuggestionsEventName;
  sessionId: string;
  draw: number;
  index?: number;
  source?: ReplySuggestionsExpansionSource;
};

/**
 * One failed draw. It carries the same correlation facts as the failure reading
 * (`requestId`/`category`/`httpStatus`/`durationMs`) so an offline replay can say
 * when the feature started failing without reading journalctl. It NEVER carries
 * the prompt, the answer body or the key.
 *
 * Consumers: `reply-suggestions.service.ts` (`failedRecord`) and the ledger
 * criterion.
 */
export type ReplySuggestionsFailedRecord = {
  at: string;
  type: 'failed';
  sessionId: string;
  requestId: string;
  category: ReplySuggestionsFailureCategory;
  httpStatus: number | null;
  durationMs: number;
  model: string;
  protocol: ReplySuggestionsProtocol;
};

/** One `/events` posting — the input half of the row above; `source` is present
 * only for an expansion chip.
 * Consumers: `reply-suggestions.routes.ts` (its parsed event shape) and
 * `reply-suggestions.service.ts` (`recordEvent`). */
export type ReplySuggestionsEventInput = {
  sessionId: string;
  draw: number;
  event: ReplySuggestionsEventName;
  index?: number;
  source?: ReplySuggestionsExpansionSource;
};

/**
 * The discriminated union every ledger line is one of.
 *
 * Consumers: `reply-suggestions.service.ts` (`writeUsage`) and the context-events
 * tap in `server/index.ts` (its `recordUsage` reads only a few fields).
 */
export type ReplySuggestionsUsageRecord =
  | ReplySuggestionsShownRecord
  | ReplySuggestionsEventRecord
  | ReplySuggestionsFailedRecord;

/**
 * Build one `shown` row. `chips` is copied so a caller mutating its array cannot
 * rewrite a row that has already been handed to the writer.
 *
 * Consumers: `reply-suggestions.service.ts` (`writeShownRow`).
 */
export function shownRecord(options: {
  at: string;
  sessionId: string;
  draw: number;
  model: string;
  protocol: ReplySuggestionsProtocol;
  version: string;
  served: ReplySuggestionsServed;
  expansion?: ReplySuggestionsExpansionSource;
  chips: readonly string[];
}): ReplySuggestionsShownRecord {
  return {
    at: options.at,
    type: 'shown',
    sessionId: options.sessionId,
    draw: options.draw,
    model: options.model,
    protocol: options.protocol,
    version: options.version,
    served: options.served,
    ...(options.expansion === undefined ? {} : { expansion: options.expansion }),
    chips: [...options.chips],
  };
}

/**
 * Build one client-event row.
 *
 * Consumers: `reply-suggestions.service.ts` (`recordEvent`).
 */
export function eventRecord(options: {
  at: string;
  sessionId: string;
  draw: number;
  event: ReplySuggestionsEventName;
  index?: number;
  source?: ReplySuggestionsExpansionSource;
}): ReplySuggestionsEventRecord {
  return {
    at: options.at,
    type: options.event,
    sessionId: options.sessionId,
    draw: options.draw,
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.source === undefined ? {} : { source: options.source }),
  };
}

/**
 * Build one failed-draw row from the failure reading the service just recorded.
 *
 * Consumers: `reply-suggestions.service.ts` (`recordFailedDraw`).
 */
export function failedRecord(options: {
  at: string;
  sessionId: string;
  requestId: string;
  category: ReplySuggestionsFailureCategory;
  httpStatus: number | null;
  durationMs: number;
  model: string;
  protocol: ReplySuggestionsProtocol;
}): ReplySuggestionsFailedRecord {
  return {
    at: options.at,
    type: 'failed',
    sessionId: options.sessionId,
    requestId: options.requestId,
    category: options.category,
    httpStatus: options.httpStatus,
    durationMs: options.durationMs,
    model: options.model,
    protocol: options.protocol,
  };
}

/**
 * The writer seam the service depends on. `write` accepts only a typed row.
 *
 * Consumers: `reply-suggestions.service.ts` (its injected `usageLog`),
 * `reply-suggestions.module.ts` (builds one) and the context-events wiring
 * criterion.
 */
export type ReplySuggestionsUsageLog = {
  readonly path: string;
  write(record: ReplySuggestionsUsageRecord): void;
};

/**
 * The ONE observer the process composition root installs on this ledger.
 *
 * The ledger stays exactly what it was — its own file, its own rotation, its own
 * field names — and the observer is a read-only tap: the context-event bridge
 * mirrors `shown`/`picked`/`redrawn` into the host stream. Kept as a module-level
 * seam because the reply-suggestions service writes through the injected log;
 * adding the tap here avoids a sibling-module import in either direction.
 *
 * A throwing observer is contained: the ledger write has already happened, and
 * the usage readout must never be lost because a second consumer failed.
 */
let usageObserver: ((record: ReplySuggestionsUsageRecord) => void) | null = null;

/**
 * Installs (or clears, with `null`) the process-wide usage observer.
 *
 * Consumers: `server/index.ts` (installs the context-events tap) and the
 * context-events wiring criterion.
 */
export function setReplySuggestionsUsageObserver(
  observer: ((record: ReplySuggestionsUsageRecord) => void) | null,
): void {
  usageObserver = observer;
}

/**
 * Build a ledger writer for one file.
 *
 * `filePath`/`maxBytes`/`homeDir` are injected by the module composition root
 * (criteria pass their own). The parent directory is created on the first write,
 * so the server's start-up never does filesystem work for a feature that is off.
 *
 * Consumers: `reply-suggestions.module.ts` (production), `reply-suggestions.service.ts`
 * (the default when a criterion does not inject one) and the context-events
 * wiring criterion (its own temp file).
 */
export function createReplySuggestionsUsageLog(
  options: { filePath?: string; maxBytes?: number; homeDir?: string } = {},
): ReplySuggestionsUsageLog {
  const homeDir = options.homeDir ?? os.homedir();
  const filePath = options.filePath
    ?? path.join(defaultCloudpitDataRoot(homeDir), 'reply-suggestions-usage.jsonl');
  const maxBytes = options.maxBytes ?? REPLY_SUGGESTIONS_USAGE_LOG_MAX_BYTES;

  return {
    path: filePath,
    write(record: ReplySuggestionsUsageRecord): void {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      mkdirSync(path.dirname(filePath), { recursive: true });

      // Rotate BEFORE appending, so one file never grows past its cap by more
      // than a single line. Renaming over an existing `.1` is the discard.
      if (existsSync(filePath)) {
        const size = statSync(filePath).size;
        if (size > 0 && size + bytes > maxBytes) {
          renameSync(filePath, `${filePath}.1`);
        }
      }

      appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      try {
        usageObserver?.(record);
      } catch {
        // The ledger is the durable record; the tap is best-effort.
      }
    },
  };
}

/**
 * The service's ledger surface: one write path that contains a refused file write,
 * plus the `shown` row's assembly (which needs the settings reading). Kept here —
 * the ledger's owning file — so the orchestration service stays at its line
 * ratchet and no row shape is assembled at a second site.
 *
 * Consumers: `reply-suggestions.service.ts` only.
 */
export type ReplySuggestionsLedger = {
  write: (record: ReplySuggestionsUsageRecord) => void;
  shown: (options: {
    sessionId: string;
    settings: ReplySuggestionsSettings;
    chips: readonly string[];
    draw: number;
    served: ReplySuggestionsServed;
    expansionSource: ReplySuggestionsExpansionSource | null;
  }) => void;
};

/**
 * Build the service's ledger surface over one writer. A refused write is logged
 * and swallowed: the draw must never fail because its readout could not land.
 *
 * Consumers: `reply-suggestions.service.ts` only.
 */
export function createReplySuggestionsLedger(
  usageLog: ReplySuggestionsUsageLog,
  logger: (line: string) => void,
  now: () => number,
): ReplySuggestionsLedger {
  const write = (record: ReplySuggestionsUsageRecord): void => {
    try {
      usageLog.write(record);
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      logger(`[reply-suggestions] usage log write failed: ${reason}`);
    }
  };

  return {
    write,
    shown({ sessionId, settings, chips, draw, served, expansionSource }) {
      if (!settings.usageLog) return;
      write(shownRecord({
        at: new Date(now()).toISOString(),
        sessionId,
        draw,
        model: settings.upstream.model,
        protocol: settings.upstream.protocol,
        version: settings.version,
        served,
        ...(expansionSource === null ? {} : { expansion: expansionSource }),
        chips,
      }));
    },
  };
}
