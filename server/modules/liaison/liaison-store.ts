/**
 * The initiative inbox and the delivery log, on disk.
 *
 * The carrier is two append-only JSONL files under the fleet home's `liaison/` directory —
 * the same discipline the fleet's own outbox uses (`queued` is a fact about a row, a later
 * `delivered` mark is a second row, and a delivery is deduplicated by its id rather than by
 * rewriting anything already written). Nothing here reaches into the fleet's `outbox.jsonl`:
 * that queue is the fleet's push channel to a HUMAN, and a liaison message is a peer-to-peer
 * message addressed to one session. What is reused is the semantics — append-only rows, a
 * queued/delivered split, one id per delivery — not the file.
 *
 * Layout:
 *
 *   <directory>/inbox.jsonl       {kind:'queued', entry} | {kind:'delivered', deliveryId, mark}
 *   <directory>/deliveries.jsonl  {kind:'delivery', record}
 *
 * A malformed line THROWS rather than being skipped: an unreadable inbox read as an empty one
 * would silently drop messages the person believes are queued, which is exactly the failure
 * this store exists to prevent.
 *
 * Consumers: `server/index.ts` (builds one over `<fleet home>/liaison`), and the module's
 * criterion, which drives it over a temp directory.
 */

import fs from 'node:fs';
import path from 'node:path';

import type {
  LiaisonDeliveryMark,
  LiaisonDeliveryRecord,
  LiaisonInboxEntry,
  LiaisonStore,
} from './liaison-deliver.service.js';

export const LIAISON_INBOX_FILENAME = 'inbox.jsonl';
export const LIAISON_DELIVERIES_FILENAME = 'deliveries.jsonl';

type QueuedRow = { kind: 'queued'; entry: LiaisonInboxEntry };
type DeliveredRow = { kind: 'delivered'; deliveryId: string; mark: LiaisonDeliveryMark };
type DeliveryRow = { kind: 'delivery'; record: LiaisonDeliveryRecord };
type InboxRow = QueuedRow | DeliveredRow;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads one JSONL file into rows, naming the file and line of the first unreadable row. */
function readRows(filePath: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`liaison store is corrupt: ${filePath}:${index + 1} is not JSON`);
    }
  }
  return rows;
}

function appendRow(filePath: string, row: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function isInboxEntry(value: unknown): value is LiaisonInboxEntry {
  return (
    isRecord(value) &&
    typeof value.deliveryId === 'string' &&
    typeof value.initiative === 'string' &&
    typeof value.project === 'string' &&
    typeof value.from === 'string' &&
    typeof value.message === 'string'
  );
}

function isDeliveryRecord(value: unknown): value is LiaisonDeliveryRecord {
  return (
    isRecord(value) &&
    typeof value.deliveryId === 'string' &&
    typeof value.initiative === 'string' &&
    typeof value.outcome === 'string'
  );
}

/**
 * Builds the disk-backed store.
 *
 * Reads fold the append-only rows on every call: the files are small (one line per delivery)
 * and a cached in-memory projection would be a second source of truth across processes. The
 * directory is created on the first write, so a host with no liaison traffic carries no
 * directory at all.
 */
export function createFileLiaisonStore(options: { directory: string }): LiaisonStore {
  const inboxPath = path.join(options.directory, LIAISON_INBOX_FILENAME);
  const deliveriesPath = path.join(options.directory, LIAISON_DELIVERIES_FILENAME);

  const inboxRows = (): InboxRow[] =>
    readRows(inboxPath).filter((row): row is InboxRow => {
      if (!isRecord(row)) return false;
      if (row.kind === 'queued') return isInboxEntry(row.entry);
      return row.kind === 'delivered' && typeof row.deliveryId === 'string' && isRecord(row.mark);
    });

  return {
    enqueue(entry) {
      appendRow(inboxPath, { kind: 'queued', entry } satisfies QueuedRow);
    },
    pendingInbox() {
      const pending = new Map<string, LiaisonInboxEntry>();
      for (const row of inboxRows()) {
        if (row.kind === 'queued') {
          if (!pending.has(row.entry.deliveryId)) pending.set(row.entry.deliveryId, row.entry);
        } else {
          pending.delete(row.deliveryId);
        }
      }
      return [...pending.values()];
    },
    wasDelivered(deliveryId) {
      return inboxRows().some((row) => row.kind === 'delivered' && row.deliveryId === deliveryId);
    },
    markDelivered(deliveryId, mark) {
      appendRow(inboxPath, { kind: 'delivered', deliveryId, mark } satisfies DeliveredRow);
    },
    recordDelivery(record) {
      appendRow(deliveriesPath, { kind: 'delivery', record } satisfies DeliveryRow);
    },
    listDeliveries() {
      return readRows(deliveriesPath)
        .filter((row): row is DeliveryRow => isRecord(row) && row.kind === 'delivery' && isDeliveryRecord(row.record))
        .map((row) => row.record);
    },
  };
}
