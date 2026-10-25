import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '@/shared/api';

/**
 * 「本会话发起的事，现在走到哪一步了」 — the compact chain over the transcript.
 *
 * The component is deliberately a READ of one server reading
 * (`GET /api/quay/:projectId/session-task-chain`). It renders nothing for a conversation
 * that started no tasks, so an empty bar never takes the transcript's first row to say
 * nothing. Clicking the bar expands the per-task list; each task shows its stage and, when
 * the store carries one, the first line of its unlanded reason.
 *
 * Its former mount above the transcript in `ChatInterface` is paused
 * (gap-chat-banners-paused-pending-signal-redesign) until the chat page's signal design is
 * settled; the component and its criterion `src/modules/chat/tests/SessionTaskChain.test.tsx`
 * remain, so the reading stays testable.
 */

/** Mirrors the server's stage vocabulary; the UI never invents a stage the server cannot send. */
export type SessionTaskChainStage =
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

/** One task in the chain, as the server reports it. */
export type SessionTaskChainEntry = {
  taskId: string;
  title: string;
  status: string;
  stage: SessionTaskChainStage;
  origin: 'created' | 'edited';
  landCommit: string | null;
  blockedReason: string | null;
};

/** The server's counts; the compact sentence renders four of them. */
export type SessionTaskChainCounts = {
  total: number;
  filed: number;
  ready: number;
  inProgress: number;
  landed: number;
  built: number;
  running: number;
  blocked: number;
  needsHuman: number;
  superseded: number;
  unknown: number;
};

/** One session's whole chain reading. */
export type SessionTaskChainReading = {
  sessionId: string;
  projectId: string;
  created: string[];
  edited: string[];
  counts: SessionTaskChainCounts;
  tasks: SessionTaskChainEntry[];
  checkedAt: string;
};

/** The injection seam a criterion uses; the default talks to the quay API. */
export type SessionTaskChainPort = (input: {
  projectId: string;
  sessionId: string;
}) => Promise<SessionTaskChainReading>;

type SessionTaskChainProps = {
  projectId: string;
  sessionId: string;
  read?: SessionTaskChainPort;
  /** Injected by the test so a transition is observable without waiting 30 seconds. */
  pollIntervalMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;

const defaultRead: SessionTaskChainPort = async ({ projectId, sessionId }) => {
  const response = await authenticatedFetch(
    `/api/quay/${encodeURIComponent(projectId)}/session-task-chain`
      + `?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) {
    throw new Error(`session-task-chain ${response.status}`);
  }
  return (await response.json()) as SessionTaskChainReading;
};

/** The i18n key for a stage label; the compact list and the screen-reader text share it. */
const STAGE_LABEL_KEYS: Record<SessionTaskChainStage, string> = {
  filed: 'sessionTaskChain.stageFiled',
  ready: 'sessionTaskChain.stageReady',
  'in-progress': 'sessionTaskChain.stageInProgress',
  landed: 'sessionTaskChain.stageLanded',
  built: 'sessionTaskChain.stageBuilt',
  running: 'sessionTaskChain.stageRunning',
  blocked: 'sessionTaskChain.stageBlocked',
  'needs-human': 'sessionTaskChain.stageNeedsHuman',
  superseded: 'sessionTaskChain.stageSuperseded',
  unknown: 'sessionTaskChain.stageUnknown',
};

/**
 * The one transition worth interrupting for: a task this conversation started has gone from
 * 「已合入」 to 「线上运行」. Everything else in the chain can wait until the bar is opened.
 */
function isLandingToLive(previous: SessionTaskChainStage | undefined, next: SessionTaskChainStage): boolean {
  return previous === 'landed' && next === 'running';
}

export default function SessionTaskChain({
  projectId,
  sessionId,
  read = defaultRead,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: SessionTaskChainProps) {
  const { t } = useTranslation();
  // The latest reading. Essential: every label and count below is a projection of it, and it
  // is refreshed on a timer so a merge that lands elsewhere shows up without reopening the page.
  const [reading, setReading] = useState<SessionTaskChainReading | null>(null);
  // Why the reading could not be produced. Essential: a failed read must state itself rather
  // than render as the calm "no tasks" case, which would be a false all-clear.
  const [error, setError] = useState<string | null>(null);
  // Whether the per-task list is open. Essential: the bar is compact by default and the list is
  // the only place a person reads individual stages.
  const [expanded, setExpanded] = useState(false);
  // The one-time 「已上线」 lines. Essential: a landing-to-live transition is news only once.
  const [notices, setNotices] = useState<string[]>([]);
  // Each task's stage in the previous poll. A ref, not state: it exists only to diff readings
  // and must not trigger a render of its own.
  const previousStagesRef = useRef<Map<string, SessionTaskChainStage> | null>(null);
  // Transitions already announced. Essential: a later poll that still shows "running" must not
  // repeat the notice, so the announcement is remembered by (task, previous stage, next stage).
  const announcedTransitionsRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const next = await read({ projectId, sessionId });

      // Diff against the previous poll and announce each 已合入 → 线上运行 transition ONCE.
      // The diff lives here rather than in an effect: it is a consequence of this reading, and
      // keeping it with the read means a poll cannot render the new stage before the notice.
      const previous = previousStagesRef.current;
      const fresh: string[] = [];
      if (previous !== null) {
        for (const task of next.tasks) {
          if (!isLandingToLive(previous.get(task.taskId), task.stage)) continue;
          const transitionKey = `${task.taskId}\u0000landed\u0000running`;
          if (announcedTransitionsRef.current.has(transitionKey)) continue;
          announcedTransitionsRef.current.add(transitionKey);
          fresh.push(t('sessionTaskChain.liveNotice', { taskId: task.taskId }));
        }
      }
      previousStagesRef.current = new Map(
        next.tasks.map((task) => [task.taskId, task.stage]),
      );

      setReading(next);
      setError(null);
      if (fresh.length > 0) {
        setNotices((current) => [...current, ...fresh]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId, read, sessionId, t]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [load, pollIntervalMs]);

  const sortedTasks = useMemo(
    () => (reading === null ? [] : [...reading.tasks]),
    [reading],
  );

  if (error !== null) {
    return (
      <p
        role="status"
        data-testid="session-task-chain-unavailable"
        className="shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
      >
        {t('sessionTaskChain.unavailable', { reason: error })}
      </p>
    );
  }

  // A conversation that started no tasks gets no bar at all.
  if (reading === null || reading.counts.total === 0) {
    return null;
  }

  const { counts } = reading;

  return (
    <div
      data-testid="session-task-chain"
      data-total={counts.total}
      data-count-in-progress={counts.inProgress}
      data-count-landed={counts.landed}
      data-count-built={counts.built}
      data-count-running={counts.running}
      data-count-blocked={counts.blocked}
      className="shrink-0 border-b border-border/60 bg-muted/30"
    >
      {notices.map((notice) => (
        <p
          key={notice}
          role="status"
          data-testid="session-task-chain-notice"
          className="px-3 pt-1 text-xs text-emerald-600 dark:text-emerald-400"
        >
          {notice}
        </p>
      ))}

      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? t('sessionTaskChain.collapse') : t('sessionTaskChain.expand')}
        data-testid="session-task-chain-toggle"
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60"
      >
        <span data-testid="session-task-chain-summary">
          {t('sessionTaskChain.summary', {
            total: counts.total,
            inProgress: counts.inProgress,
            landed: counts.landed,
            running: counts.running,
            blocked: counts.blocked,
          })}
        </span>
        <span aria-hidden="true" className="ml-auto shrink-0">
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {expanded && (
        <ul className="px-3 pb-2" data-testid="session-task-chain-list">
          {sortedTasks.map((task) => (
            <li
              key={task.taskId}
              data-testid="session-task-chain-entry"
              data-task-id={task.taskId}
              data-stage={task.stage}
              className="flex items-baseline gap-2 py-0.5 text-xs"
            >
              <span className="font-mono text-[11px] text-foreground">{task.taskId}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={task.title}>
                {task.title}
              </span>
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                {t(STAGE_LABEL_KEYS[task.stage])}
              </span>
              {task.stage === 'blocked' && task.blockedReason !== null && (
                <span
                  data-testid="session-task-chain-blocked-reason"
                  className="basis-full truncate pl-2 text-[11px] text-amber-600 dark:text-amber-400"
                  title={task.blockedReason}
                >
                  {t('sessionTaskChain.blockedReason', { reason: task.blockedReason })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
