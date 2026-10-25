/**
 * The session's mention reading: which tasks and goals this conversation NAMES in its message text.
 *
 * This is a different question from `session-task-chain.service.ts`. The chain asks "which tasks
 * did this session WRITE" and reads tool calls; this service asks "which tasks and goals does the
 * prose TALK ABOUT" and reads only the user/assistant message bodies. Tool calls, tool results,
 * thinking blocks and non-message rows (attachments, queue operations, snapshots) are deliberately
 * outside the scan: measured on this project's recent sessions, counting tool blocks multiplied
 * the reading by roughly ten and named nothing a person had actually said.
 *
 * The scan is over the WHOLE transcript, not a recent window: what a conversation mentioned an
 * hour ago is still what it mentioned, and a window would make the reading depend on how long the
 * turn had been running. It is incremental — each session remembers the byte offset it has
 * consumed (always on a line boundary), so a transcript that grows while a turn runs is read once
 * per appended chunk rather than whole on every poll.
 *
 * WHAT THE CACHE HOLDS: candidate tokens and their tallies, never the vocabulary join. Tasks are
 * created mid-conversation, so the vocabulary grows; a cache keyed to one vocabulary snapshot
 * would hide a task whose id was already spoken before it was filed. Every request joins the
 * cached tokens against the CURRENT task/goal index instead.
 *
 * READ-ONLY BY CONSTRUCTION. Every dependency is a reader, injected by `quay.module.ts`, and the
 * service's one verb answers a reading.
 *
 * Consumers: `server/modules/quay/quay.routes.ts` (the `GET /api/quay/:projectId/session-mentions`
 * endpoint) and `server/modules/quay/tests/session-mentions.test.ts` (the criterion), which drives
 * this factory with injected transcript/task/goal/lanes stubs and no subprocess.
 */

import type { QuayGanttLanes } from '@/shared/types.js';

// --------------------------- TRANSCRIPT TEXT ------------

/** One message body taken out of a transcript row, with the row's own instant. */
export type SessionMessageText = {
  text: string;
  /** The row's `timestamp` as the transcript printed it, or `null` when it carries none. */
  timestamp: string | null;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The text of one message `content` value: a plain string, or the `text` blocks of an array.
 *
 * A block is read only when its own `type` is `text`. That single condition is what keeps
 * `tool_use` inputs, `tool_result` contents and `thinking` blocks out of the reading — each of
 * them is a different block type in the same array, and a hit inside one of them is not
 * something the conversation said.
 */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'text') continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * The message body one transcript row carries, or `null` when the row is not a user/assistant
 * message.
 *
 * The row's own `type` is the gate: `attachment`, `queue-operation`, `file-history-snapshot`,
 * `summary` and the rest are not messages even when they happen to carry a `content` field, so
 * they are dropped before their content is ever looked at. Both the Claude shape
 * (`message.content`) and the flat shape (`content`) are accepted.
 */
export function readMessageText(row: unknown): SessionMessageText | null {
  if (!isRecord(row)) return null;
  if (row.type !== 'user' && row.type !== 'assistant') return null;

  const message = isRecord(row.message) ? row.message : row;
  const text = contentText(message.content);
  if (text === null) return null;

  return { text, timestamp: typeof row.timestamp === 'string' ? row.timestamp : null };
}

/**
 * The candidate tokens in one body of text: runs of `[A-Za-z0-9][A-Za-z0-9-]*` that CONTAIN a
 * hyphen.
 *
 * The hyphen requirement is what makes this cache affordable — prose is mostly English words,
 * and caching every one of them per session would grow the cache with the conversation instead
 * of with its mentions. Task ids in this project are all lower-kebab and goal ids are
 * `GOAL-NNN`, so the filter keeps every id-shaped token and almost nothing else. Trailing
 * hyphens are trimmed so an id followed by a dash reads as the id.
 */
export function mentionTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9][A-Za-z0-9-]*/g)) {
    const token = match[0].replace(/-+$/, '');
    if (token.includes('-')) tokens.push(token);
  }
  return tokens;
}

// --------------------------- READINGS ------------

/** One task the session mentioned, joined against the store index. */
export type SessionMentionTaskReading = {
  taskId: string;
  title: string;
  status: string;
  /** The phase of the task's in-flight lane interval, or `null` when it is not in flight. */
  phase: string | null;
  /** The goal this task belongs to (`goal_ac` → criterion row → `goal`), or `null`. */
  goalId: string | null;
  /** How many times the id appeared across the session's message bodies. */
  mentionCount: number;
  /** The instant of the most recent mention (the transcript row's `timestamp`), or `null`. */
  lastMentionAt: string | null;
};

/** One goal the session's reading names — directly in the text, through a task, or both. */
export type SessionMentionGoalReading = {
  goalId: string;
  title: string;
  status: string;
  /** How many of the listed tasks point at this goal. */
  viaTaskCount: number;
  /** Whether the goal's own id appeared in the message text. */
  mentionedDirectly: boolean;
};

/** The whole reading the route returns and the title-bar popover renders. */
export type SessionMentionsReading = {
  ok: true;
  sessionId: string;
  projectId: string;
  tasks: SessionMentionTaskReading[];
  goals: SessionMentionGoalReading[];
  /** When this reading was assembled (ISO-8601). */
  generatedAt: string;
};

/** One task row of the project's index, as the reader hands it over. */
export type SessionMentionsTaskRow = {
  taskId: string;
  title: string;
  status: string;
  /** The task's `goal_ac` field: an AC id, or `null` when the task carries none. */
  goalAc: string | null;
};

/**
 * One row of `quay goal list --json`. A `goal` row is a goal (`id` is `GOAL-NNN`); a `criterion`
 * row is an AC whose `goal` field names the goal it belongs to.
 */
export type SessionMentionsGoalRow = {
  id: string;
  title: string;
  status: string;
  kind: string | null;
  goal: string | null;
};

/**
 * Everything the service reads from. All of it is injected so the criterion can drive the
 * production join with stubs and no filesystem, CLI or lane state.
 *
 * `readTaskRows`/`readGoalRows` answer `null` when the read failed; a failed vocabulary read
 * degrades the reading to the arm it can still answer rather than inventing hits.
 */
export type SessionMentionsDependencies = {
  /** The project path for a project id, or `null` when the project is unknown. */
  resolveProjectPath(projectId: string): string | null;
  /** The session's transcript (JSONL) path, or `null` when the session is not known here. */
  resolveTranscriptPath(input: { projectId: string; sessionId: string }): string | null;
  /** The transcript's current size in bytes, or `null` when it cannot be stat-ed. */
  transcriptSize(transcriptPath: string): Promise<number | null>;
  /** Bytes from `start` to EOF, decoded as UTF-8, or `null` when the file cannot be read. */
  readTranscriptRange(transcriptPath: string, start: number): Promise<string | null>;
  /** The project's task index rows (ids/titles/statuses/`goal_ac`), or `null` on a failed read. */
  readTaskRows(projectPath: string): Promise<readonly SessionMentionsTaskRow[] | null>;
  /** The project's `quay goal list --json` rows (goals AND criteria), or `null` on a failed read. */
  readGoalRows(projectPath: string): Promise<readonly SessionMentionsGoalRow[] | null>;
  /** The project's packed lanes for the in-flight phase join, or `null` when unreadable. */
  readLanes(input: { projectId: string; projectPath: string }): Promise<QuayGanttLanes | null>;
  now(): number;
};

/** The service's one verb. `null` means the project (or its session) is not known here. */
export type SessionMentionsService = {
  readSessionMentions(input: { projectId: string; sessionId: string }): Promise<SessionMentionsReading | null>;
};

// --------------------------- SERVICE ------------

/** How many session scan caches to keep before dropping the least recently created. */
const MAX_CACHED_SESSIONS = 200;

/** One candidate token's tally across the consumed part of a transcript. */
type MentionTally = {
  count: number;
  /** The latest mention instant seen (a non-null transcript timestamp), or `null`. */
  lastMentionAt: string | null;
};

/** One session's incremental transcript scan. Holds tokens + tallies, never a vocabulary join. */
type TranscriptScanCache = {
  transcriptPath: string;
  /** The number of bytes already consumed; always sits on a line boundary. */
  offset: number;
  mentions: Map<string, MentionTally>;
};

/** The in-flight phase of each task named by a lane set; the latest interval wins. */
function inFlightPhases(lanes: QuayGanttLanes | null): Map<string, string> {
  const phases = new Map<string, string>();
  if (lanes === null) return phases;

  const latestStart = new Map<string, number>();
  for (const lane of lanes.lanes) {
    for (const interval of lane) {
      if (interval.phase === null) continue;
      const key = interval.taskId.toLowerCase();
      const previous = latestStart.get(key);
      if (previous !== undefined && previous >= interval.startMs) continue;
      latestStart.set(key, interval.startMs);
      phases.set(key, interval.phase);
    }
  }
  return phases;
}

/** The instant a transcript timestamp names, or `null` when it is absent/unparseable. */
function timestampEpochMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The deterministic task order: most recently mentioned first, ties (and rows with no timestamp)
 * broken by task id. A row with no instant has no position on the time axis, so it sorts after
 * every dated row rather than at an arbitrary end of it.
 */
function compareTaskReadings(a: SessionMentionTaskReading, b: SessionMentionTaskReading): number {
  const aMs = timestampEpochMs(a.lastMentionAt);
  const bMs = timestampEpochMs(b.lastMentionAt);
  if (aMs !== bMs) {
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    return bMs - aMs;
  }
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** The deterministic goal order: by goal id. */
function compareGoalReadings(a: SessionMentionGoalReading, b: SessionMentionGoalReading): number {
  return a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0;
}

/**
 * Creates the session → mentions reader over its injected world.
 *
 * A session's transcript is scanned incrementally: the cache records the byte offset consumed so
 * far, and only complete JSONL lines are consumed (a trailing partial line waits for the next
 * poll). Re-reading therefore cannot double-count. A transcript that shrank — a new session file
 * reusing the id — resets the scan instead of reading from the middle of a row.
 */
export function createSessionMentionsService(
  dependencies: SessionMentionsDependencies,
): SessionMentionsService {
  const scans = new Map<string, TranscriptScanCache>();

  const scanCacheKey = (projectId: string, sessionId: string): string => `${projectId}\u0000${sessionId}`;

  const scanFor = (cacheKey: string, transcriptPath: string): TranscriptScanCache => {
    const existing = scans.get(cacheKey);
    if (existing !== undefined && existing.transcriptPath === transcriptPath) {
      return existing;
    }
    const fresh: TranscriptScanCache = {
      transcriptPath,
      offset: 0,
      mentions: new Map(),
    };
    // Re-inserting keeps Map order as "least recently created", which is the eviction order.
    scans.delete(cacheKey);
    scans.set(cacheKey, fresh);
    if (scans.size > MAX_CACHED_SESSIONS) {
      const oldest = scans.keys().next().value;
      if (oldest !== undefined) scans.delete(oldest);
    }
    return fresh;
  };

  /** Tallies one body of text's candidate tokens; the latest non-null instant is kept. */
  const recordText = (scan: TranscriptScanCache, text: string, timestamp: string | null): void => {
    for (const token of mentionTokens(text)) {
      const key = token.toLowerCase();
      const existing = scan.mentions.get(key);
      if (existing === undefined) {
        scan.mentions.set(key, { count: 1, lastMentionAt: timestamp });
        continue;
      }
      existing.count += 1;
      if (timestamp !== null) existing.lastMentionAt = timestamp;
    }
  };

  /** Consumes whatever the transcript appended since the last scan. */
  const readNewTranscriptLines = async (scan: TranscriptScanCache): Promise<void> => {
    const size = await dependencies.transcriptSize(scan.transcriptPath);
    if (size === null) return;

    if (size < scan.offset) {
      // The file was replaced under the same session id: start over rather than read mid-row.
      scan.offset = 0;
      scan.mentions.clear();
    }
    if (size === scan.offset) return;

    const appended = await dependencies.readTranscriptRange(scan.transcriptPath, scan.offset);
    if (appended === null) return;

    // Only complete lines are consumed; a turn still streaming its last line is read next time.
    const lastNewline = appended.lastIndexOf('\n');
    if (lastNewline === -1) return;
    const complete = appended.slice(0, lastNewline + 1);
    scan.offset += Buffer.byteLength(complete, 'utf8');

    for (const line of complete.split('\n')) {
      if (line.trim() === '') continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        // A torn line is not a reason to drop the rest of the transcript.
        continue;
      }
      const message = readMessageText(row);
      if (message === null) continue;
      recordText(scan, message.text, message.timestamp);
    }
  };

  const readSessionMentions = async (input: {
    projectId: string;
    sessionId: string;
  }): Promise<SessionMentionsReading | null> => {
    const projectPath = dependencies.resolveProjectPath(input.projectId);
    if (projectPath === null) return null;

    const transcriptPath = dependencies.resolveTranscriptPath(input);
    if (transcriptPath === null) return null;

    const scan = scanFor(scanCacheKey(input.projectId, input.sessionId), transcriptPath);
    await readNewTranscriptLines(scan);

    const [taskRows, goalRows, lanes] = await Promise.all([
      dependencies.readTaskRows(projectPath),
      dependencies.readGoalRows(projectPath),
      dependencies.readLanes({ projectId: input.projectId, projectPath }),
    ]);

    // The vocabulary. Task ids are lower-kebab (already lower-case); goal ids are `GOAL-NNN`,
    // so every lookup is case-insensitive against a lower-cased key while the reading keeps the
    // vocabulary's canonical spelling.
    const tasksById = new Map<string, SessionMentionsTaskRow>();
    for (const row of taskRows ?? []) {
      tasksById.set(row.taskId.toLowerCase(), row);
    }

    const goalsById = new Map<string, SessionMentionsGoalRow>();
    const goalIdByCriterion = new Map<string, string>();
    for (const row of goalRows ?? []) {
      if (row.kind === 'criterion') {
        if (row.goal !== null && row.goal.trim() !== '') {
          goalIdByCriterion.set(row.id.toUpperCase(), row.goal);
        }
        continue;
      }
      if (row.kind === 'goal') {
        goalsById.set(row.id.toLowerCase(), row);
      }
    }

    const phases = inFlightPhases(lanes);

    const tasks: SessionMentionTaskReading[] = [];
    const directGoalIds = new Set<string>();
    for (const [token, tally] of scan.mentions) {
      const taskRow = tasksById.get(token);
      if (taskRow !== undefined) {
        tasks.push({
          taskId: taskRow.taskId,
          title: taskRow.title,
          status: taskRow.status,
          phase: phases.get(taskRow.taskId.toLowerCase()) ?? null,
          goalId: taskRow.goalAc === null ? null : (goalIdByCriterion.get(taskRow.goalAc.toUpperCase()) ?? null),
          mentionCount: tally.count,
          lastMentionAt: tally.lastMentionAt,
        });
      }
      const goalRow = goalsById.get(token);
      if (goalRow !== undefined) {
        directGoalIds.add(goalRow.id);
      }
    }
    tasks.sort(compareTaskReadings);

    // A goal is listed when the text names it or when a listed task belongs to it. A goal the
    // current goal list no longer holds cannot be given a title/status, so it is not fabricated
    // into a row; the task that points at it still carries its goal id.
    const goalTally = new Map<string, { goalRow: SessionMentionsGoalRow; viaTaskCount: number; mentionedDirectly: boolean }>();
    const noteGoal = (goalId: string): { goalRow: SessionMentionsGoalRow; viaTaskCount: number; mentionedDirectly: boolean } | null => {
      const existing = goalTally.get(goalId);
      if (existing !== undefined) return existing;
      const goalRow = goalsById.get(goalId.toLowerCase());
      if (goalRow === undefined) return null;
      const entry = { goalRow, viaTaskCount: 0, mentionedDirectly: false };
      goalTally.set(goalId, entry);
      return entry;
    };
    for (const goalId of directGoalIds) {
      const entry = noteGoal(goalId);
      if (entry !== null) entry.mentionedDirectly = true;
    }
    for (const task of tasks) {
      if (task.goalId === null) continue;
      const entry = noteGoal(task.goalId);
      if (entry !== null) entry.viaTaskCount += 1;
    }

    const goals: SessionMentionGoalReading[] = [...goalTally.values()]
      .map(({ goalRow, viaTaskCount, mentionedDirectly }) => ({
        goalId: goalRow.id,
        title: goalRow.title,
        status: goalRow.status,
        viaTaskCount,
        mentionedDirectly,
      }))
      .sort(compareGoalReadings);

    return {
      ok: true,
      sessionId: input.sessionId,
      projectId: input.projectId,
      tasks,
      goals,
      generatedAt: new Date(dependencies.now()).toISOString(),
    };
  };

  return { readSessionMentions };
}
