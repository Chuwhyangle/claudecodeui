/**
 * The local usage ledger for reply suggestions.
 *
 * WHAT IT IS FOR. The chips a model offers are only half the story; whether a
 * person clicked one, cleared it, redrew or sent is the long-lived ground truth
 * an offline benchmark replays. This file appends one JSON object per line to a
 * local-only JSONL file under the project's existing local data directory
 * (`~/.cloudcli`, the same root the attachment and browser-profile stores use).
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
 * Consumers: `reply-suggestions.service.ts`, which writes the `shown` record on
 * every extraction and the `picked`/`cleared`/`redrawn`/`sent` records from
 * `POST /events`; the service criterion in
 * `tests/reply-suggestions-service.test.ts` drives rotation and field names.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The default cap for one ledger file: 5 MB, as the task's protection clause says. */
export const REPLY_SUGGESTIONS_USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** One line of the ledger. `type` separates the server's `shown` row from the client events. */
export type ReplySuggestionsUsageRecord = Record<string, unknown> & { type: string };

/** The writer seam the service depends on. */
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
 * seam because the reply-suggestions SERVICE constructs the writer internally;
 * adding the tap here avoids a sibling-module import in either direction.
 *
 * A throwing observer is contained: the ledger write has already happened, and
 * the usage readout must never be lost because a second consumer failed.
 */
let usageObserver: ((record: ReplySuggestionsUsageRecord) => void) | null = null;

/** Installs (or clears, with `null`) the process-wide usage observer. */
export function setReplySuggestionsUsageObserver(
  observer: ((record: ReplySuggestionsUsageRecord) => void) | null,
): void {
  usageObserver = observer;
}

/**
 * Build a ledger writer for one file.
 *
 * `filePath` is injectable for criteria; production takes the default under
 * `~/.cloudcli`. The parent directory is created on the first write, so the
 * server's start-up never does filesystem work for a feature that is off.
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
