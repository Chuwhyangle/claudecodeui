import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';

/**
 * The deployment strip: the cockpit's persistent answer to 「当前运行的版本包括驾驶舱的变更吗」
 * and 「重启成功了吗」, plus the one click that builds and restarts.
 *
 * It is deliberately a READ of the server's readiness service with a single confirmed write
 * (`POST /api/system/deploy`). The confirmation panel is a discrete human action — the design
 * explicitly refuses a voice 「是」 for a restart — so clicking the action only opens the panel;
 * only its confirm button sends the request.
 */

export type DeployCommitReading = {
  sha: string;
  subject: string;
  taskId: string | null;
};

export type DeployCheckReading = {
  name: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

export type DeployLastDeployReading = {
  targetSha: string;
  ok: boolean;
  checks: DeployCheckReading[];
  at: string;
};

export type DeployFailureReading = {
  step: 'build' | 'restart';
  outputTail: string;
  at: string;
};

export type DeployStatus =
  | 'fresh'
  | 'pending-build'
  | 'built-pending-restart'
  | 'building'
  | 'restarting'
  | 'unknown';

export type DeployReadinessReading = {
  status: DeployStatus;
  runningSha: string | null;
  builtSha: string | null;
  clientBuiltSha: string | null;
  headSha: string | null;
  pendingCommits: DeployCommitReading[];
  lastDeploy: DeployLastDeployReading | null;
  failure: DeployFailureReading | null;
  checkedAt: string;
};

/** Reads the current readiness; the default talks to `/api/system/deploy-readiness`. */
export type DeployReadinessPort = () => Promise<DeployReadinessReading>;

/** Sends the one confirmed build+restart request. */
export type DeployExecutePort = () => Promise<{ ok: boolean }>;

type DeployReadinessProps = {
  /** The session page's compact form; it hides itself entirely while the deployment is fresh. */
  compact?: boolean;
  read?: DeployReadinessPort;
  deploy?: DeployExecutePort;
  /** Injected in tests so the relative 「2 分钟前」 is deterministic. */
  now?: () => number;
};

const POLL_INTERVAL_MS = 15_000;

const defaultRead: DeployReadinessPort = async () => {
  const response = await api.system.deployReadiness();
  return (await response.json()) as DeployReadinessReading;
};

const defaultDeploy: DeployExecutePort = async () => {
  const response = await api.system.deploy();
  return (await response.json()) as { ok: boolean };
};

/** The first seven characters of a sha are enough to identify a build by eye. */
function shortSha(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 7);
}

/**
 * Used by `CockpitPage` (the persistent strip) and `ChatInterface` (the compact, non-fresh
 * only variant), so a person sees the same deployment sentence wherever they are.
 */
export default function DeployReadiness({
  compact = false,
  read = defaultRead,
  deploy = defaultDeploy,
  now = () => Date.now(),
}: DeployReadinessProps) {
  const { t } = useTranslation();
  // The server's current reading. Essential: every sentence and button below is a projection
  // of it, and it is refreshed on a timer so a build started elsewhere shows up here.
  const [reading, setReading] = useState<DeployReadinessReading | null>(null);
  // Why no reading could be produced. Essential: hiding a failed poll would make the strip
  // look deliberately absent rather than unable to answer.
  const [error, setError] = useState<string | null>(null);
  // Whether the confirmation panel is open. Essential: it is the gate between one click and a
  // restart, and it must be explicit rather than inferred from a pending request.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Whether the confirmed request is in flight. Essential: it turns the confirm button
  // non-repeatable while the same deploy is already running.
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await read();
      setReading(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [read]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const confirmAndDeploy = useCallback(async () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await deploy();
      setConfirmOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }, [deploy, load, submitting]);

  if (error !== null) {
    return compact ? null : (
      <p role="status" data-testid="deploy-readiness" data-status="unavailable" className="text-xs text-muted-foreground">
        {t('cockpit.deployUnavailable', { reason: error })}
      </p>
    );
  }

  if (reading === null) {
    return null;
  }

  // The session page only carries deployment news when there is some.
  if (compact && reading.status === 'fresh') {
    return null;
  }

  const statusLabel = (() => {
    switch (reading.status) {
      case 'fresh':
        return t('cockpit.deployFresh');
      case 'pending-build':
        return reading.pendingCommits.length === 1
          ? t('cockpit.deployPendingBuildOne', { n: 1 })
          : t('cockpit.deployPendingBuild', { n: reading.pendingCommits.length });
      case 'built-pending-restart':
        return t('cockpit.deployBuiltPendingRestart');
      case 'building':
        return t('cockpit.deployBuilding');
      case 'restarting':
        return t('cockpit.deployRestarting');
      default:
        return t('cockpit.deployUnknown');
    }
  })();

  const canDeploy = reading.status === 'pending-build' || reading.status === 'built-pending-restart';

  const lastDeployLine = reading.lastDeploy === null
    ? null
    : reading.lastDeploy.ok
      ? t('cockpit.deployLastOk', {
          sha: shortSha(reading.lastDeploy.targetSha),
          time: relativeTime(reading.lastDeploy.at, now(), t),
        })
      : t('cockpit.deployLastFailed', { sha: shortSha(reading.lastDeploy.targetSha) });

  const failedCheck = reading.lastDeploy?.ok === false
    ? reading.lastDeploy.checks.find((check) => !check.ok)?.name ?? null
    : null;

  return (
    <section
      data-testid="deploy-readiness"
      data-status={reading.status}
      className={
        compact
          ? 'relative shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs'
          : 'relative flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs'
      }
      aria-label={t('cockpit.deployStatus')}
    >
      <span data-testid="deploy-status" className="text-foreground">
        {statusLabel}
      </span>

      {reading.failure !== null && (
        <span data-testid="deploy-failure" className="text-destructive">
          {t('cockpit.deployFailingStep', { step: reading.failure.step })}
          <code className="ml-1 rounded bg-muted px-1 py-0.5 text-[11px]" data-testid="deploy-failure-output">
            {lastLine(reading.failure.outputTail)}
          </code>
        </span>
      )}

      {canDeploy && (
        <button
          type="button"
          data-testid="deploy-action"
          className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
          onClick={() => setConfirmOpen(true)}
        >
          {t('cockpit.deployAction')}
        </button>
      )}

      {lastDeployLine !== null && (
        <span data-testid="deploy-last" className="text-muted-foreground">
          {lastDeployLine}
          {failedCheck !== null && ` · ${t('cockpit.deployLastFailedCheck', { check: failedCheck })}`}
        </span>
      )}

      {confirmOpen && (
        <div
          data-testid="deploy-confirm-panel"
          role="dialog"
          aria-modal="true"
          aria-label={t('cockpit.deployConfirmTitle')}
          className="absolute inset-x-0 top-full z-30 mt-2 rounded-lg border border-border bg-card p-3 shadow-lg"
        >
          <p className="text-sm font-medium">{t('cockpit.deployConfirmTitle')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('cockpit.deployConfirmBody')}</p>
          {reading.pendingCommits.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="deploy-no-commits">
              {t('cockpit.deployNoCommits')}
            </p>
          ) : (
            <ul className="mt-1 max-h-40 space-y-1 overflow-auto" data-testid="deploy-commits">
              {reading.pendingCommits.map((commit) => (
                <li key={commit.sha} data-testid="deploy-commit" className="text-xs">
                  <code className="rounded bg-muted px-1">{shortSha(commit.sha)}</code>{' '}
                  {commit.subject}
                  {commit.taskId !== null && (
                    <span className="ml-1 text-muted-foreground">
                      {t('cockpit.deployCommitTask', { task: commit.taskId })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{t('cockpit.deployConfirmRestartHint')}</p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              data-testid="deploy-cancel"
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => setConfirmOpen(false)}
            >
              {t('cockpit.deployCancel')}
            </button>
            <button
              type="button"
              data-testid="deploy-confirm"
              disabled={submitting}
              className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              onClick={() => void confirmAndDeploy()}
            >
              {t('cockpit.deployConfirm')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The last non-empty line of a failure transcript: the tail without flooding the strip. */
function lastLine(outputTail: string): string {
  const lines = outputTail.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.at(-1) ?? '';
}

/**
 * A relative timestamp for the last verified deploy. The translation function is passed in so
 * the unit choices stay in the locale bundle rather than in this file.
 */
function relativeTime(
  at: string,
  now: number,
  t: TFunction,
): string {
  const elapsedMs = Math.max(0, now - Date.parse(at));
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return t('cockpit.deployJustNow');
  }
  if (minutes < 60) {
    return t('cockpit.deployMinutesAgo', { n: minutes });
  }
  return t('cockpit.deployHoursAgo', { n: Math.floor(minutes / 60) });
}
