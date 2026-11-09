/**
 * The blocker reading behind the pulse strip's fourth row.
 *
 * A task is *blocked* when it is not finished and either (a) its body carries a `## Blocker`
 * section — the record a worker writes when a round did not land — or (b) its status is
 * `needs-human`. Both are live facts about the store, so `done`/`superseded` tasks are excluded:
 * a landed task keeps its historical Blocker section (workers are told not to strip it), and
 * plotting that history as a current obstruction would make the strip report a permanently red
 * system.
 *
 * Identity is the FAILURE SIGNATURE, not the task id. Two tasks red at the same step with the
 * same reason are one obstruction with two occurrences, so the summary merges them into one
 * segment (`occurrences`) instead of drawing two identical lines. Digits are normalised before
 * comparing so "checked 0/6" and "checked 0/4" are the same step, not two signatures.
 *
 * `dependents` is the impact side: the unfinished tasks whose `depends_on` names a member of the
 * group. A prerequisite nobody waits for is a fact about one task; one with dependents is a fact
 * about the board, which is what the number after the ⛔ mark answers.
 *
 * The input is the parsed `quay task list --json` array (unknown-shaped, since it crosses a CLI
 * boundary). `null` — not `[]` — is returned when the caller handed no array at all: an unread
 * task store and a store with no blockers are different readings, and only the second may render
 * "nothing is blocked".
 */

/** One blocked stretch the pulse strip draws: a failure signature, its age, and who waits on it. */
export type QuayBlockerSummary = {
  /** Representative task id (the earliest occurrence in the group), used by the tooltip/click. */
  taskId: string;
  /** When the obstruction started, ISO-8601. The earliest occurrence in the group. */
  since: string;
  /** The normalised failure signature the group is keyed by. */
  signature: string;
  /** How many tasks currently carry this signature. */
  occurrences: number;
  /** Unfinished tasks whose `depends_on` names one of the group's tasks, sorted, unique. */
  dependents: string[];
};

/** Statuses that mean "this is no longer live": a done task's Blocker section is history. */
const TERMINAL_STATUSES = new Set(['done', 'superseded']);

/** Tasks whose status asks a person to act, even when no Blocker section was written. */
const NEEDS_HUMAN_STATUS = 'needs-human';

/** A markdown level-2 `## Blocker` heading, tolerating surrounding whitespace. */
const BLOCKER_HEADING = /^##\s+Blocker\s*$/m;

/** The start of the next markdown heading, which ends the Blocker section. */
const NEXT_HEADING = /^#{1,6}\s/m;

/** A bold-only line: the timestamped entry heading workers/agents write into the section. */
const BOLD_LINE = /^\*\*(.+?)\*\*\s*$/;

/** `- 未落地原因：…` — the step/why line the entry carries. */
const NOT_LANDED_REASON = /^[-*]\s*未落地原因[：:]\s*(.+)$/;

/** The same reason under an English spelling some entries use. */
const NOT_LANDED_REASON_EN = /^[-*]\s*(?:reason (?:not )?landed|why not landed)[：:]\s*(.+)$/i;

/** A leading ISO-8601 date, optionally with a time (the entry heading's timestamp). */
const INSTANT_PREFIX =
  /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)/;

/** Digits are normalised away, so the same failure with different counts is one signature. */
const DIGIT_RUN = /\d+/g;

/** Collapses whitespace so a wrapped sentence does not split one signature into two. */
const WHITESPACE_RUN = /\s+/g;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

/** The task's id, or `null` when the record is not a task-shaped object. */
function readTaskId(record: UnknownRecord): string | null {
  return typeof record.id === 'string' && record.id.trim() !== '' ? record.id : null;
}

function readStatus(record: UnknownRecord): string {
  return typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
}

/** A non-empty string body, or `''` when the reading carries none. */
function readBody(record: UnknownRecord): string {
  return typeof record.body === 'string' ? record.body : '';
}

/**
 * Parses a store instant to ISO-8601. The CLI writes `updatedAt` as epoch **milliseconds**
 * (a float); a hand-built fixture may spell it as an ISO string. Anything unparseable yields
 * `null` rather than `Invalid Date`, so the caller can decide to skip the record.
 */
function readInstant(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      return null;
    }
    const date = new Date(parsed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/** `depends_on` as a string array; a missing/foreign-shaped value reads as "no edges". */
function readDependsOn(record: UnknownRecord): string[] {
  // Some providers nest the relation under `extra`; accept the flat spelling first.
  const flat = Array.isArray(record.depends_on) ? record.depends_on : null;
  const extra = asRecord(record.extra);
  const nested = extra !== null && Array.isArray(extra.depends_on) ? extra.depends_on : null;
  return (flat ?? nested ?? []).filter((value): value is string => typeof value === 'string' && value !== '');
}

/** The `## Blocker` section's text (without the heading), or `null` when there is none. */
function blockerSection(body: string): string | null {
  const heading = BLOCKER_HEADING.exec(body);
  if (heading === null) {
    return null;
  }
  const rest = body.slice(heading.index + heading[0].length);
  const next = NEXT_HEADING.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * Normalises a signature's prose: digits are replaced with `#` and whitespace collapsed. This is
 * the whole merging rule — two rounds of the same failure differ only in counts.
 */
function normalizeSignature(text: string): string {
  return text.replace(DIGIT_RUN, '#').replace(WHITESPACE_RUN, ' ').trim();
}

/** The step part of a `未落地原因` line: the text before the first dash-suffixed explanation. */
function reasonStep(reason: string): string {
  const cut = reason.split(/\s*(?:——|—|--)\s*/)[0] ?? reason;
  return cut.trim();
}

type ParsedBlocker = { signature: string; since: string };

/**
 * Extracts the entry a Blocker section describes. The LAST entry wins: a task retried after a
 * blocker keeps the earlier entries as history, and the current obstruction is the newest one.
 */
function parseBlockerEntry(section: string): ParsedBlocker | null {
  const lines = section.split('\n');
  let headingText: string | null = null;
  let reason: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const bold = BOLD_LINE.exec(line);
    if (bold !== null) {
      headingText = bold[1].trim();
      continue;
    }
    const stepLine = NOT_LANDED_REASON.exec(line) ?? NOT_LANDED_REASON_EN.exec(line);
    if (stepLine !== null) {
      reason = stepLine[1].trim();
    }
  }

  if (headingText === null) {
    return null;
  }

  const instant = INSTANT_PREFIX.exec(headingText);
  const since = instant === null ? null : readInstant(instant[1]);
  if (since === null) {
    return null;
  }

  // The heading is `**<instant> — <what failed>**`; drop the instant before it becomes prose.
  const headline = headingText.slice(instant?.[0]?.length ?? 0).replace(/^[\s—–-]+/, '').trim();
  const step = reason === null ? '' : reasonStep(reason);
  const signature = normalizeSignature([headline, step].filter((part) => part !== '').join(' :: '));
  if (signature === '') {
    return null;
  }

  return { signature, since };
}

/**
 * Summarises the task store's live blockers for the pulse strip.
 *
 * @param value the parsed `quay task list --json` payload (unknown-shaped: it crosses a CLI).
 * @returns `null` when `value` is not a task array; otherwise the merged blocker groups, oldest
 *   first. An empty array means the store was read and nothing is currently blocked.
 */
export function summarizeBlockers(value: unknown): QuayBlockerSummary[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  type Candidate = { taskId: string; status: string; signature: string; since: string };
  const candidates: Candidate[] = [];
  // Reverse dependency edges over the UNFINISHED tasks only: a done dependent no longer waits.
  const dependentsByTask = new Map<string, Set<string>>();
  const unfinishedDependents: { taskId: string; dependsOn: string[] }[] = [];

  for (const item of value) {
    const record = asRecord(item);
    const taskId = record === null ? null : readTaskId(record);
    if (record === null || taskId === null) {
      continue;
    }

    const status = readStatus(record);
    if (TERMINAL_STATUSES.has(status)) {
      continue;
    }

    unfinishedDependents.push({ taskId, dependsOn: readDependsOn(record) });

    const section = blockerSection(readBody(record));
    const entry = section === null ? null : parseBlockerEntry(section);
    if (entry !== null) {
      candidates.push({ taskId, status, ...entry });
      continue;
    }

    if (status === NEEDS_HUMAN_STATUS) {
      // No Blocker section: the status itself is the obstruction. Its age is the last update —
      // the instant the task entered (or was last touched in) this state.
      const since = readInstant(record.updatedAt);
      if (since !== null) {
        candidates.push({ taskId, status, signature: 'needs-human', since });
      }
    }
  }

  for (const { taskId, dependsOn } of unfinishedDependents) {
    for (const prerequisite of dependsOn) {
      const waiting = dependentsByTask.get(prerequisite) ?? new Set<string>();
      waiting.add(taskId);
      dependentsByTask.set(prerequisite, waiting);
    }
  }

  type Group = QuayBlockerSummary & { memberIds: string[] };
  const groups = new Map<string, Group>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.signature);
    if (existing === undefined) {
      groups.set(candidate.signature, {
        taskId: candidate.taskId,
        since: candidate.since,
        signature: candidate.signature,
        occurrences: 1,
        dependents: [],
        memberIds: [candidate.taskId],
      });
      continue;
    }
    existing.occurrences += 1;
    existing.memberIds.push(candidate.taskId);
    // The segment starts when the FIRST task hit this signature; later occurrences extend it.
    if (Date.parse(candidate.since) < Date.parse(existing.since)) {
      existing.since = candidate.since;
      existing.taskId = candidate.taskId;
    }
  }

  return [...groups.values()]
    .map(({ memberIds, ...group }) => {
      const dependents = new Set<string>();
      for (const taskId of memberIds) {
        for (const dependent of dependentsByTask.get(taskId) ?? []) {
          dependents.add(dependent);
        }
      }
      return { ...group, dependents: [...dependents].sort() };
    })
    .sort((left, right) => Date.parse(left.since) - Date.parse(right.since));
}
