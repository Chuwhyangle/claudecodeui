/**
 * The local usage ledger for reply suggestions, and the ONE typed vocabulary of
 * the rows it holds.
 *
 * WHAT IT IS FOR. The chips a model offers are only half the story; whether a
 * person clicked one, cleared it, redrew or sent is the long-lived ground truth
 * an offline benchmark replays. This file appends one JSON object per line to a
 * local-only JSONL file under `~/.cloudcli` (the same root the attachment and
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

import type { ReplySuggestionsProtocol } from './reply-suggestions-settings.js';

/** The default cap for one ledger file: 5 MB, as the task's protection clause says. */
const REPLY_SUGGESTIONS_USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * How a `shown` row was produced: a real upstream call or a cache hit.
 *
 * Consumers: `reply-suggestions.service.ts` (the `shown` row's `served`).
 */
export type ReplySuggestionsServed = 'upstream' | 'cache';

/**
 * What an expansion draw was anchored on: `seed` is the reply the person picked
 * (variants of it), `focus` is the quoted passage with no reply written yet.
 * Written into the ledger so a replay can tell the two apart without storing
 * either text twice.
 *
 * Consumers: `reply-suggestions.service.ts`, `reply-suggestions-draw.ts`,
 * `reply-suggestions-prompts.ts` and `reply-suggestions.routes.ts`.
 */
export type ReplySuggestionsExpansionSource = 'seed' | 'focus';

/**
 * The pointer-click ledger event names the client reports.
 *
 * Consumers: `reply-suggestions.service.ts` and `reply-suggestions.routes.ts`.
 */
export type ReplySuggestionsEventName = 'picked' | 'cleared' | 'redrawn' | 'sent';

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
 * The discriminated union every ledger line is one of.
 *
 * Consumers: `reply-suggestions.service.ts` (`writeUsage`) and the context-events
 * tap in `server/index.ts` (its `recordUsage` reads only a few fields).
 */
export type ReplySuggestionsUsageRecord = ReplySuggestionsShownRecord | ReplySuggestionsEventRecord;

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
  const filePath = options.filePath ?? path.join(homeDir, '.cloudcli', 'reply-suggestions-usage.jsonl');
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
