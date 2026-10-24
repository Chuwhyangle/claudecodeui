/**
 * The session → task flow chain: what the tasks this conversation started are doing now.
 *
 * 「检查进展」 is the habit this service answers without being asked. Two readings are joined:
 *
 *   1. WHICH TASKS THIS SESSION STARTED. Session commits carry `task_write by cli:<pid>`, which
 *      names the CLI process, not the conversation. The transcript is the only record that
 *      does name it: every `quay task create|edit|write` Bash call and every MCP `task_write`
 *      call is written there with its arguments. The scan is incremental (it remembers how
 *      many bytes of the JSONL it has consumed per session), so a transcript that grows while
 *      a turn runs is read once per appended chunk rather than whole on every poll.
 *
 *   2. WHERE EACH TASK STANDS. The task store gives status and the `## Blocker` reason; the
 *      project's git history gives the commit that landed a task; the deployment fingerprint
 *      files give what is built and what is running. A landed commit is compared to those two
 *      shas with `git merge-base --is-ancestor`, so 「已合入」 / 「已构建」 / 「线上运行」 are
 *      facts about the same commit, not three counters that may disagree.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing here builds, restarts or writes a task: every dependency
 * is a reader, and the service's only verb answers a reading.
 *
 * Consumers: `server/modules/quay/quay.routes.ts` (the `GET /api/quay/:projectId/session-task-chain`
 * endpoint) and `server/modules/quay/tests/session-task-chain.test.ts` (the criterion), which
 * drives this factory with injected transcript/task/git/deploy stubs and no subprocess.
 */

import { parseFrontMatter } from '@/shared/frontmatter.js';

// --------------------------- TRANSCRIPT SCAN ------------

/** Whether a task id was first seen as created or as edited by this session. */
export type SessionTaskOrigin = 'created' | 'edited';

/**
 * The stage one task sits at in this session's chain.
 *
 * The first six are the normal path in order; the last four are the exceptional branches the
 * Proposal calls out. `unknown` is a task the transcript names but the store no longer has.
 */
export type SessionTaskStage =
  | 'filed'
  | 'ready'
  | 'in-progress'
  | 'landed'
  | 'built'
  | 'running'
  | 'blocked'
  | 'needs-human'
  | 'superseded'
  | 'unknown';

/** One task the session created or edited, with the stage its store + git reading place it at. */
export type SessionTaskChainEntry = {
  taskId: string;
  title: string;
  /** The store's own status word, so a reader can see the raw fact behind `stage`. */
  status: string;
  stage: SessionTaskStage;
  origin: SessionTaskOrigin;
  /** The commit on the landing line whose message names this task, or `null` when none was found. */
  landCommit: string | null;
  /** The first line of the `未落地原因` bullet in `## Blocker`, or `null` when the task has none. */
  blockedReason: string | null;
};

/** Every stage's count, plus the total. The compact bar renders a subset of these. */
export type SessionTaskChainCounts = {
  total: number;
  filed: number;
  ready: number;
  inProgress: number;
  /** 已合入待生效: landed on the landing line but not in the built artifact. */
  landed: number;
  built: number;
  running: number;
  blocked: number;
  needsHuman: number;
  superseded: number;
  unknown: number;
};

/** The whole reading the route returns and the chat bar renders. */
export type SessionTaskChainReading = {
  sessionId: string;
  projectId: string;
  /** Task ids the session created, in first-seen order. */
  created: string[];
  /** Task ids the session edited but did not create, in first-seen order. */
  edited: string[];
  counts: SessionTaskChainCounts;
  tasks: SessionTaskChainEntry[];
  /** When this reading was assembled (ISO-8601). */
  checkedAt: string;
};

/** One task's store record, as the reader hands it over. */
export type SessionTaskStoreRecord = {
  status: string;
  title: string;
  /** The markdown body after the frontmatter, including a `## Blocker` section when present. */
  body: string;
};

/**
 * Everything the service reads from. All of it is injected so the criterion can drive the
 * production classification with stubs and no filesystem, git or deployment state.
 */
export type SessionTaskChainDependencies = {
  /** The CloudCLI project path for a project id, or `null` when the project is unknown. */
  resolveProjectPath(projectId: string): string | null;
  /** The session's transcript (JSONL) path, or `null` when it has none yet. */
  resolveTranscriptPath(input: { projectId: string; sessionId: string }): string | null;
  /** The transcript's current size in bytes, or `null` when it cannot be stat-ed. */
  transcriptSize(transcriptPath: string): Promise<number | null>;
  /** Bytes from `start` to EOF, decoded as UTF-8, or `null` when the file cannot be read. */
  readTranscriptRange(transcriptPath: string, start: number): Promise<string | null>;
  /** One task from the store, or `null` when the store no longer has it. */
  readTask(projectPath: string, taskId: string): SessionTaskStoreRecord | null;
  /** The task ids that currently have a worktree (or worker) in this project. */
  worktreeTaskIds(projectPath: string): ReadonlySet<string>;
  /** The landing-line commit whose message names this task, or `null` when none was found. */
  findLandCommit(projectPath: string, taskId: string): string | null;
  /** `git merge-base --is-ancestor <ancestor> <descendant>` in this project's repository. */
  isAncestor(projectPath: string, ancestor: string, descendant: string): boolean;
  /** What the last build compiled and what the running process was started from. */
  readDeployShas(): { builtSha: string | null; runningSha: string | null };
  now(): number;
};

/** The service's one verb. `null` means the project (or its session) is not known here. */
export type SessionTaskChainService = {
  readSessionTaskChain(input: { projectId: string; sessionId: string }): Promise<SessionTaskChainReading | null>;
};

/**
 * A task id safe to put in a filename or hand to git. Transcript content is untrusted input;
 * anything that is not this shape is dropped rather than path-joined or turned into an argv.
 */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** How many session scan caches to keep before dropping the oldest. */
const MAX_CACHED_SESSIONS = 200;

/** One session's incremental transcript scan. */
type TranscriptScanCache = {
  transcriptPath: string;
  /** The number of bytes already consumed; always sits on a line boundary. */
  offset: number;
  created: Set<string>;
  edited: Set<string>;
};

/** The `quay task <verb> <id>` forms that WRITE a task. Read verbs (`view`, `list`, …) do not match. */
const QUAY_TASK_WRITE_COMMAND = /\bquay\s+task\s+(create|edit|write)\b([^\n;&|]*)/g;

/** The tool-name suffix an MCP call uses. The provider's own tool is `task_write`. */
const MCP_TASK_WRITE_SUFFIX = 'task_write';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or `null`. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Strips one pair of matching quotes from a shell token. */
function stripQuotes(token: string): string {
  if (token.length >= 2 && (token.startsWith('"') || token.startsWith("'"))) {
    const quote = token[0];
    if (token.endsWith(quote)) return token.slice(1, -1);
  }
  return token;
}

/**
 * The task id a `quay task <verb> …` argument string names.
 *
 * The repository's own habit is `quay task create <id> --title …`, so the first bare token is
 * the id; `--id <id>` is accepted too. Flag values (`--title x`) are never mistaken for ids
 * because a flag is skipped together with its value only when the flag comes BEFORE the id.
 */
function taskIdFromCommandArguments(argumentText: string): string | null {
  const tokens = argumentText.trim().split(/\s+/).filter((token) => token !== '');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripQuotes(tokens[index]);
    if (token === '--id' || token === '--task') {
      const value = tokens[index + 1];
      const id = value === undefined ? null : stripQuotes(value);
      return id !== null && TASK_ID_PATTERN.test(id) ? id : null;
    }
    if (token.startsWith('-')) {
      // A value-taking flag before the id: skip the flag and the value it consumes.
      index += 1;
      continue;
    }
    return TASK_ID_PATTERN.test(token) ? token : null;
  }
  return null;
}

/** The base tool name: `mcp__plugin_quay_quay__task_write` → `task_write`. */
function toolBaseName(name: string): string {
  const separator = name.lastIndexOf('__');
  return separator === -1 ? name : name.slice(separator + 2);
}

/**
 * One tool call's contribution to the session → task map.
 *
 * Bash commands are parsed for `quay task create|edit|write <id>`; MCP task writes carry the id
 * in their input. A `quay task view <id>` is deliberately ignored — reading a task is not
 * starting it, and counting it would make every 「检查进展」 chip add noise to its own reading.
 */
function taskReferencesFromToolCall(name: string, input: UnknownRecord): { taskId: string; origin: SessionTaskOrigin }[] {
  const references: { taskId: string; origin: SessionTaskOrigin }[] = [];

  if ((name === 'Bash' || name === 'bash') && typeof input.command === 'string') {
    for (const match of input.command.matchAll(QUAY_TASK_WRITE_COMMAND)) {
      const verb = match[1];
      const argumentText = match[2] ?? '';
      const taskId = taskIdFromCommandArguments(argumentText);
      if (taskId === null) continue;
      references.push({ taskId, origin: verb === 'create' ? 'created' : 'edited' });
    }
  }

  if (toolBaseName(name) === MCP_TASK_WRITE_SUFFIX) {
    const taskId = nonEmptyString(input.id) ?? nonEmptyString(input.taskId);
    if (taskId !== null && TASK_ID_PATTERN.test(taskId)) {
      references.push({ taskId, origin: 'edited' });
    }
  }

  return references;
}

/** Every `tool_use` block in one transcript row, whichever provider shape the row uses. */
function toolUsesInRow(row: unknown): { name: string; input: UnknownRecord }[] {
  if (!isRecord(row)) return [];

  // Claude rows carry `message.content`; a few providers put content at the row's top level.
  const message = isRecord(row.message) ? row.message : row;
  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(row.content)
      ? row.content
      : [];

  const calls: { name: string; input: UnknownRecord }[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'tool_use') continue;
    const name = nonEmptyString(block.name);
    if (name === null) continue;
    calls.push({ name, input: isRecord(block.input) ? block.input : {} });
  }

  // A flat `{type:'tool_use', name, input}` row (an older/hand-built shape).
  if (calls.length === 0 && row.type === 'tool_use') {
    const name = nonEmptyString(row.name);
    if (name !== null) {
      calls.push({ name, input: isRecord(row.input) ? row.input : {} });
    }
  }

  return calls;
}

/** Records one reference, keeping a task the session created out of the edited list. */
function recordReference(
  scan: { created: Set<string>; edited: Set<string> },
  reference: { taskId: string; origin: SessionTaskOrigin },
): void {
  if (reference.origin === 'created') {
    scan.created.add(reference.taskId);
    scan.edited.delete(reference.taskId);
    return;
  }
  if (!scan.created.has(reference.taskId)) {
    scan.edited.add(reference.taskId);
  }
}

// --------------------------- TASK STORE / GIT READING ------------

/**
 * The first line of the `未落地原因` bullet under `## Blocker`, or `null`.
 *
 * A `## Blocker` section without that bullet (a historical note, a "无") is NOT a blocked
 * reading: the task's unlanded reason is the one thing the chain shows, and inventing it from
 * unrelated prose would make `blocked` a guess. The value's first line stops at the line break
 * so a long stack trace does not take over the compact bar.
 */
export function readBlockedReason(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Blocker\s*$/.test(line.trim()));
  if (headingIndex === -1) return null;

  const section: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/.test(line)) break;
    section.push(line);
  }

  const reasonBullet = section.find((line) => line.includes('未落地原因'));
  if (reasonBullet === undefined) return null;

  const reason = reasonBullet
    .slice(reasonBullet.indexOf('未落地原因') + '未落地原因'.length)
    .replace(/^[：:\s]+/, '')
    .split(/\r?\n/)[0]
    .trim();
  return reason === '' ? null : reason;
}

/** Every stage's count from the entries, plus the total. */
function countStages(entries: readonly SessionTaskChainEntry[]): SessionTaskChainCounts {
  const counts: SessionTaskChainCounts = {
    total: entries.length,
    filed: 0,
    ready: 0,
    inProgress: 0,
    landed: 0,
    built: 0,
    running: 0,
    blocked: 0,
    needsHuman: 0,
    superseded: 0,
    unknown: 0,
  };
  for (const entry of entries) {
    switch (entry.stage) {
      case 'filed':
        counts.filed += 1;
        break;
      case 'ready':
        counts.ready += 1;
        break;
      case 'in-progress':
        counts.inProgress += 1;
        break;
      case 'landed':
        counts.landed += 1;
        break;
      case 'built':
        counts.built += 1;
        break;
      case 'running':
        counts.running += 1;
        break;
      case 'blocked':
        counts.blocked += 1;
        break;
      case 'needs-human':
        counts.needsHuman += 1;
        break;
      case 'superseded':
        counts.superseded += 1;
        break;
      case 'unknown':
        counts.unknown += 1;
        break;
    }
  }
  return counts;
}

type StageInput = {
  status: string;
  blockedReason: string | null;
  hasWorktree: boolean;
  landCommit: string | null;
  builtSha: string | null;
  runningSha: string | null;
  isAncestor(ancestor: string, descendant: string): boolean;
};

/**
 * The one stage rule. Kept free-standing so the criterion exercises exactly the production
 * decision rather than a re-implementation.
 *
 * Order matters. `superseded` and `needs-human` are terminal states of their own. A task that
 * has not landed and carries an unlanded reason is `blocked` before its store status is read,
 * because "todo" and "ready" both look actionable while the reason says nothing can advance it.
 * For a landed task, the running reading wins over the built one: a commit that is an ancestor
 * of the running sha is also (normally) an ancestor of the built sha, and the newer fact is
 * the one a person asked about.
 */
export function classifySessionTaskStage(input: StageInput): SessionTaskStage {
  if (input.status === 'superseded') return 'superseded';
  if (input.status === 'needs-human') return 'needs-human';
  if (input.status !== 'done' && input.blockedReason !== null) return 'blocked';

  switch (input.status) {
    case 'todo':
      return 'filed';
    case 'ready':
      return input.hasWorktree ? 'in-progress' : 'ready';
    case 'done': {
      if (input.landCommit === null) return 'landed';
      if (input.runningSha !== null && input.isAncestor(input.landCommit, input.runningSha)) {
        return 'running';
      }
      if (input.builtSha !== null && input.isAncestor(input.landCommit, input.builtSha)) {
        return 'built';
      }
      return 'landed';
    }
    default:
      return 'unknown';
  }
}

// --------------------------- SERVICE ------------

/**
 * Creates the session → task chain reader over its injected world.
 *
 * A session's transcript is scanned incrementally: the cache records the byte offset consumed
 * so far, and only complete JSONL lines are consumed (the trailing partial line waits for the
 * next poll). Re-reading therefore cannot double-count, and a file that shrank (a new session
 * file reusing the id) resets the scan instead of reading garbage.
 */
export function createSessionTaskChainService(
  dependencies: SessionTaskChainDependencies,
): SessionTaskChainService {
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
      created: new Set(),
      edited: new Set(),
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

  /** Consumes whatever the transcript appended since the last scan. */
  const readNewTranscriptLines = async (scan: TranscriptScanCache): Promise<void> => {
    const size = await dependencies.transcriptSize(scan.transcriptPath);
    if (size === null) return;

    if (size < scan.offset) {
      // The file was replaced under the same session id: start over rather than read mid-row.
      scan.offset = 0;
      scan.created.clear();
      scan.edited.clear();
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
      for (const call of toolUsesInRow(row)) {
        for (const reference of taskReferencesFromToolCall(call.name, call.input)) {
          recordReference(scan, reference);
        }
      }
    }
  };

  const readSessionTaskChain = async (input: {
    projectId: string;
    sessionId: string;
  }): Promise<SessionTaskChainReading | null> => {
    const projectPath = dependencies.resolveProjectPath(input.projectId);
    if (projectPath === null) return null;

    const transcriptPath = dependencies.resolveTranscriptPath(input);
    const cacheKey = scanCacheKey(input.projectId, input.sessionId);
    const scan = transcriptPath === null
      ? { transcriptPath: '', offset: 0, created: new Set<string>(), edited: new Set<string>() }
      : scanFor(cacheKey, transcriptPath);

    if (transcriptPath !== null) {
      await readNewTranscriptLines(scan);
    }

    const created = [...scan.created];
    const edited = [...scan.edited];
    const worktreeTaskIds = dependencies.worktreeTaskIds(projectPath);
    const deploy = dependencies.readDeployShas();

    const entries: SessionTaskChainEntry[] = [];
    for (const taskId of [...created, ...edited]) {
      const origin: SessionTaskOrigin = scan.created.has(taskId) ? 'created' : 'edited';
      const record = dependencies.readTask(projectPath, taskId);
      if (record === null) {
        entries.push({
          taskId,
          title: taskId,
          status: 'unknown',
          stage: 'unknown',
          origin,
          landCommit: null,
          blockedReason: null,
        });
        continue;
      }

      const blockedReason = readBlockedReason(record.body);
      const landCommit = record.status === 'done' ? dependencies.findLandCommit(projectPath, taskId) : null;
      const stage = classifySessionTaskStage({
        status: record.status,
        blockedReason,
        hasWorktree: worktreeTaskIds.has(taskId),
        landCommit,
        builtSha: deploy.builtSha,
        runningSha: deploy.runningSha,
        isAncestor: (ancestor, descendant) =>
          dependencies.isAncestor(projectPath, ancestor, descendant),
      });

      entries.push({
        taskId,
        title: record.title,
        status: record.status,
        stage,
        origin,
        landCommit,
        blockedReason,
      });
    }

    return {
      sessionId: input.sessionId,
      projectId: input.projectId,
      created,
      edited,
      counts: countStages(entries),
      tasks: entries,
      checkedAt: new Date(dependencies.now()).toISOString(),
    };
  };

  return { readSessionTaskChain };
}
