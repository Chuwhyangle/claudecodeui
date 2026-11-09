
import path from 'node:path';

import type { QuayGanttInterval, QuayGanttLanes, QuayInFlightPhase, QuayInFlightTask } from '@/shared/types.js';
import { readNullableNumber, readNullableString } from '@/shared/utils.js';

import type { QuayFileReader } from './quay-command-port.js';
import { asRecord } from './quay-snapshot-summaries.js';

/**
 * The local `.quay/` carrier readers: a bounded tail window over an append-only JSONL file,
 * one task file's frontmatter/body, the drain-control flag and the in-flight projection on
 * top of the packed lane set. Every read goes through the injected read-only file boundary;
 * an absent or unreadable carrier is an empty reading, never a warning.
 *
 * Consumers: `service/quay-snapshot-read.service.ts` and
 * `service/quay-fleet-summary.service.ts`.
 */

/**
 * The worker driver's per-round heartbeat carrier. `quay serve`'s Live card reads this
 * same file for "which task is running"; this service reads its newest record only to supply
 * the In-flight card's supplementary fields (heartbeat, dispatch instant, worker pid) on top
 * of the task set the `lanes` reading already names.
 */
export const QUAY_WORKER_ROUND_FILE = 'worker-round.jsonl';

/**
 * Where the native task store keeps one file per task, relative to the project root.
 *
 * This is the store's default layout (the same directory `.quay/config.yml` names as
 * `providers.native.tasks_dir` in this workspace). A project that relocates the store simply
 * yields no dependency edges here — an honest absence, never a fabricated edge.
 */
export const QUAY_TASK_FILE_DIR = 'tasks';

/**
 * Bytes read per step when streaming a carrier file's tail. 64 KiB holds ten
 * lines of every carrier here except the per-file round history (whose lines run
 * tens of KB); there the window doubles a couple of times, still a few hundred KB
 * against a 16 MB file — never the whole file.
 */
const CARRIER_TAIL_WINDOW_BYTES = 64 * 1024;

/** Number of JSONL records a tail window currently holds, ignoring a possibly split leading line and blank segments. */
function countTailRecords(text: string, hasPartialLeadingLine: boolean): number {
  const lines = text.split('\n');
  if (hasPartialLeadingLine) {
    lines.shift();
  }
  return lines.filter((line) => line.trim() !== '').length;
}

/**
 * Reads a bounded trailing window of a JSONL carrier file and returns its non-blank
 * lines in file order. The byte window starts at `CARRIER_TAIL_WINDOW_BYTES` and doubles
 * until it holds at least `minLines` records or reaches the start of the file, so a
 * multi-megabyte history costs a fraction of its bytes rather than a whole-file read. A
 * non-zero window start can split one leading line in half, which is dropped (and not
 * counted by `countTailRecords`).
 */
async function readCarrierTailLines(
  reader: QuayFileReader,
  filePath: string,
  minLines: number,
): Promise<string[]> {
  if (minLines <= 0) {
    return [];
  }

  const size = await reader.size(filePath);
  if (size === null || size <= 0) {
    return [];
  }

  let windowBytes = Math.min(CARRIER_TAIL_WINDOW_BYTES, size);
  let text = '';
  let start = 0;
  // Grow the trailing window until it holds minLines records (a non-zero start can
  // split one leading line in half, which countTailRecords drops).
  for (;;) {
    start = Math.max(0, size - windowBytes);
    text = await reader.readChunk(filePath, start, size - start);
    if (start === 0 || countTailRecords(text, true) >= minLines) {
      break;
    }
    windowBytes *= 2;
  }

  const lines = text.split('\n');
  if (start > 0) {
    lines.shift();
  }

  return lines.filter((line) => line.trim() !== '');
}

/**
 * Reads the LAST parseable JSONL record from a carrier file's tail, or `null` when the
 * file is absent/empty or carries no parseable record at all.
 *
 * Used for the round heartbeat carrier, where only the newest record matters — the caller
 * wants "the most recent readable row" rather than a history. A malformed trailing line (a
 * torn append) is skipped in favour of the previous parseable record in the same bounded
 * window instead of blanking the reading.
 */
export async function readLastCarrierRecord(reader: QuayFileReader, filePath: string): Promise<unknown | null> {
  const lines = await readCarrierTailLines(reader, filePath, 1);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as unknown;
    } catch {
      // A torn/malformed line: keep scanning earlier records in the same window.
    }
  }
  return null;
}

/** One task file's two pulse-relevant readings: its body (for the Blocker section) and its edges. */
export type QuayTaskFileReading = { body: string; dependsOn: string[] };

/**
 * Reads the `depends_on` list out of a task file's YAML frontmatter.
 *
 * Both spellings the store has shipped are accepted: a block list (`depends_on:\n  - a\n  - b`)
 * and an inline flow list (`depends_on: [a, b]`). A bare scalar is a one-element list. The block
 * scan stops at the first line that is neither blank nor a list item, so following frontmatter
 * keys are never mistaken for prerequisites. Anything else reads as "no edges" rather than a
 * guess.
 */
function parseDependsOnFrontmatter(frontmatter: string): string[] {
  const match = /^depends_on[ \t]*:[ \t]*(.*)$/m.exec(frontmatter);
  if (match === null) {
    return [];
  }

  const clean = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '').trim();
  const inline = match[1].trim();
  if (inline !== '') {
    const inner = inline.startsWith('[') && inline.endsWith(']') ? inline.slice(1, -1) : inline;
    return inner
      .split(',')
      .map(clean)
      .filter((value) => value !== '');
  }

  const rest = frontmatter.slice(match.index + match[0].length).split('\n');
  const items: string[] = [];
  let started = false;
  for (const line of rest) {
    if (line.trim() === '') {
      continue;
    }
    const item = /^[ \t]+-[ \t]+(.+?)[ \t]*$/.exec(line);
    if (item === null) {
      if (started) {
        break;
      }
      // A `depends_on:` key with no list is a shape this reader does not know; it contributes
      // no edges rather than swallowing the next key's items.
      break;
    }
    started = true;
    items.push(clean(item[1]));
  }
  return items;
}

/**
 * Splits one `tasks/<id>.md` file into its frontmatter and body. The store always writes the
 * opening delimiter at byte zero; a file without one is treated wholly as body (no edges).
 */
export function parseTaskFile(text: string): QuayTaskFileReading {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) {
    return { body: text, dependsOn: [] };
  }
  return { body: match[2], dependsOn: parseDependsOnFrontmatter(match[1]) };
}

/** A task status that is still live; `done`/`superseded` records no longer contribute edges. */
export function isLiveTaskStatus(value: unknown): boolean {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return status !== 'done' && status !== 'superseded';
}

/**
 * Reads a round-carrier field persisted under its snake_case key (e.g. `in_flight_task_starts`)
 * or, when that is absent, the camelCase spelling the in-memory round options use (e.g.
 * `inFlightTaskStarts`). Quay's `writeRound` builds each record from camelCase options but
 * persists it through a snake_case projection, and this reading's own notes referenced the
 * option spelling; accepting both keeps a fixture written either way reading identically.
 */
function readRoundField(record: Record<string, unknown>, snakeCase: string, camelCase: string): unknown {
  return record[snakeCase] !== undefined ? record[snakeCase] : record[camelCase];
}

/**
 * Narrows a lane interval's `phase` string to quay's published in-flight phases. The interval
 * is non-null (it was selected for being in flight), so the only question is which phase; any
 * value outside quay's published set — an older/newer kernel spelling — reads as the neutral
 * `implementing` rather than being misreported as a specific state.
 */
function narrowInFlightPhase(value: string | null): QuayInFlightPhase {
  return value === 'fan-in' || value === 'awaiting-land' || value === 'landed' ? value : 'implementing';
}

/**
 * The in-flight intervals of a packed lane set — those quay's kernel marks as still running
 * (`phase` non-null; a finished interval carries `finalState` instead). This is exactly the set
 * the Loop pulse gantt plots, so the In-flight card takes its task list from here and the two
 * readings share one source. De-duplicated by task id (a task dispatched more than once inside
 * the window keeps its latest interval), preserving each task's interval for phase and start.
 */
function inFlightIntervals(lanes: QuayGanttLanes): QuayGanttInterval[] {
  const byTask = new Map<string, QuayGanttInterval>();
  for (const lane of lanes.lanes) {
    for (const interval of lane) {
      if (interval.phase === null) {
        continue;
      }
      const existing = byTask.get(interval.taskId);
      if (!existing || interval.startMs > existing.startMs) {
        byTask.set(interval.taskId, interval);
      }
    }
  }
  return [...byTask.values()];
}

/**
 * Projects the in-flight reading onto the snapshot's `inFlight` list.
 *
 * The task set and each row's `phase` come from the packed lane set (`inFlightIntervals`) — the
 * SAME reading the Loop pulse gantt plots — so a landed task (which quay's `readLive` drops and
 * the gantt therefore never draws) can never appear in the card, and the two readings cannot
 * disagree about which tasks are running. The round carrier is consulted only for the fields
 * the lanes do not carry: the ISO dispatch instant, the heartbeat and the worker pid.
 *
 * Returns `null` when there is no lane reading at all: with no lane set there is no authoritative
 * in-flight set to name, so the card reads "no reading" rather than inventing one from the round
 * carrier. A usable lane set always yields an array — `[]` when nothing is in flight — so "no
 * reading" and "nothing running" stay distinguishable.
 *
 * `roundRecord` is the newest `.quay/worker-round.jsonl` record, or `null` when the carrier is
 * absent/unreadable; when it carries no heartbeat the lane clock's own read instant stands in,
 * which never reads as stale because it is the instant the reading was taken.
 */
export function summarizeInFlightTasks(
  ganttLanes: QuayGanttLanes | null,
  roundRecord: unknown,
): QuayInFlightTask[] | null {
  if (ganttLanes === null) {
    return null;
  }

  const record = asRecord(roundRecord);
  // `ts` is the persisted heartbeat key; `at` is the option spelling `writeRound` is
  // called with. Either names the same instant.
  const lastHeartbeat = record ? readNullableString(readRoundField(record, 'ts', 'at')) : null;
  const starts = record ? asRecord(readRoundField(record, 'in_flight_task_starts', 'inFlightTaskStarts')) : null;
  const workerPid = record ? readNullableNumber(record.pid) : null;
  const readAt = new Date(ganttLanes.nowMs).toISOString();

  return inFlightIntervals(ganttLanes).map((interval) => ({
    taskId: interval.taskId,
    phase: narrowInFlightPhase(interval.phase),
    startedAt: (starts ? readNullableString(starts[interval.taskId]) : null) ?? new Date(interval.startMs).toISOString(),
    lastHeartbeat: lastHeartbeat ?? readAt,
    workerPid,
  }));
}

/**
 * Adds each unfinished task's store-side `depends_on` edges (and its body, when the caller's
 * reading omitted it) to the CLI records.
 *
 * WHY THIS EXISTS: the installed CLI's `task list --json` document omits `depends_on` — the
 * native provider keeps that relation in the task file's frontmatter only. The pulse strip's
 * "blocked, and N tasks are waiting" reading therefore cannot be built from the CLI payload
 * alone. Reading the files for the UNFINISHED tasks only (a handful on a healthy store) keeps
 * this to a few small reads instead of a second full-store pass; a project whose task files
 * live elsewhere yields no edges rather than a fabricated one.
 *
 * A record that already carries a non-empty body keeps it (the CLI reading is authoritative
 * for content); only the missing edge list is filled in from the file.
 */
export async function enrichTaskRecordsWithStoreEdges(
  reader: QuayFileReader,
  projectPath: string,
  records: unknown,
): Promise<unknown> {
  if (!Array.isArray(records)) {
    return records;
  }

  const live = records.filter((item) => {
    const record = asRecord(item);
    return record !== null && typeof record.id === 'string' && isLiveTaskStatus(record.status);
  });
  if (live.length === 0) {
    return records;
  }

  const readings = new Map<string, QuayTaskFileReading | null>(
    await Promise.all(
      live.map(async (item): Promise<[string, QuayTaskFileReading | null]> => {
        const id = String((item as { id: string }).id);
        try {
          const text = await reader.readText(
            path.join(projectPath, QUAY_TASK_FILE_DIR, `${id}.md`),
          );
          return [id, parseTaskFile(text)];
        } catch {
          // A relocatable store (or an id whose file was removed): no edges, no failure.
          return [id, null];
        }
      }),
    ),
  );

  return records.map((item) => {
    const record = asRecord(item);
    if (record === null || typeof record.id !== 'string') {
      return item;
    }
    const reading = readings.get(record.id);
    if (reading === undefined || reading === null) {
      return item;
    }
    return {
      ...record,
      depends_on: Array.isArray(record.depends_on) ? record.depends_on : reading.dependsOn,
      body: typeof record.body === 'string' && record.body !== '' ? record.body : reading.body,
    };
  });
}
