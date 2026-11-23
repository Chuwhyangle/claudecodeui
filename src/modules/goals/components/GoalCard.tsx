import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { GoalStatus } from '@/shared/goalLoopType';
import { Button } from '@/shared/ui';
import type { LLMProvider } from '@/shared/types';
import { cn } from '@/shared/utils';

import { AcRow } from '@/modules/goals/components/AcRow';
import { RoundTimeline } from '@/modules/goals/components/RoundTimeline';
import type { GoalView } from '@/modules/goals/hooks/useGoals';

/** Badge colours per lifecycle status; `achieved` is the only one that reads as "done". */
const STATUS_CLASSES: Record<GoalStatus, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300',
  active: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  paused: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  stalled: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  achieved: 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
  abandoned: 'bg-gray-100 text-gray-500 dark:bg-gray-900 dark:text-gray-500',
};

/**
 * The CLIs a goal's own session can be started with. Activation creates that session, so the
 * choice is made here and cannot be changed afterwards; the order is the one the rest of the app
 * lists providers in.
 */
const ACTIVATION_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode'];

/**
 * The first eight characters of a goal id. The card used to print the whole UUID next to the
 * title, which read as noise; the short form is enough to tell two goals apart, and the `title`
 * attribute still carries the full id for anything that needs to copy it.
 */
function shortenGoalId(goalId: string): string {
  return goalId.slice(0, 8);
}

type GoalCardProps = {
  /** The goal plus its detail reading (ACs, rounds, latest evidence). */
  item: GoalView;
  /** True while one of this goal's actions is in flight; every button is disabled so it cannot double-fire. */
  pending: boolean;
  /** Starts the loop; the provider is the CLI selected in the card's dropdown. */
  onActivate: (goalId: string, provider: LLMProvider) => void;
  onPause: (goalId: string) => void;
  onResume: (goalId: string) => void;
  onAbandon: (goalId: string) => void;
  onRunRound: (goalId: string) => void;
};

/**
 * One goal as a card: title, status badge, AC progress, the most recent round, the lifecycle
 * buttons this status allows, and an expandable body with the criteria and the round timeline.
 *
 * The expanded flag is local because nothing outside the card needs it: the panel renders a list,
 * not a selected-goal detail, and persisting the flag would make a reload restore cards the person
 * never opened.
 *
 * Used by `GoalPanel` in the Goals tab.
 */
export function GoalCard({
  item,
  pending,
  onActivate,
  onPause,
  onResume,
  onAbandon,
  onRunRound,
}: GoalCardProps) {
  const { t } = useTranslation();
  const { goal, acs, rounds, latestEvidence } = item;
  // Whether this card's body (criteria + round timeline) is expanded; local UI state, not data.
  const [expanded, setExpanded] = useState(false);
  // The CLI the Activate button will start this goal's session with. It is local to the card
  // because activation is a one-shot choice made right before the click.
  const [provider, setProvider] = useState<LLMProvider>('claude');

  // Superseded criteria are history: they are drawn in the expanded body but they do not count
  // toward progress, or a replaced criterion would keep the bar short of full forever.
  const judged = acs.filter((ac) => ac.status !== 'superseded');
  const passing = judged.filter(
    (ac) => ac.status === 'achieved' || latestEvidence[ac.id]?.verdict === 'pass',
  ).length;
  const total = judged.length;
  const allPassing = total > 0 && passing === total;

  // Rounds arrive oldest-first from the store; the card names the newest one.
  const latestRound = rounds.reduce<(typeof rounds)[number] | null>(
    (newest, round) => (newest === null || round.seq > newest.seq ? round : newest),
    null,
  );

  const canActivate = goal.status === 'draft';
  const canPause = goal.status === 'active';
  const canResume = goal.status === 'paused' || goal.status === 'stalled';
  const canAbandon = goal.status !== 'achieved' && goal.status !== 'abandoned';
  const canRunRound = goal.status === 'active';

  return (
    <li
      className="rounded-lg border border-border/60 bg-card p-3"
      data-testid={`goal-card-${goal.id}`}
      data-status={goal.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS_CLASSES[goal.status])}
              data-testid={`goal-status-${goal.id}`}
            >
              {goal.status}
            </span>
            <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={goal.title}>
              {goal.title}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={goal.objective}>
            {goal.objective}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className={cn('font-medium', allPassing ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}
              data-testid={`goal-ac-progress-${goal.id}`}
            >
              {total === 0 ? t('goals.noCriteria') : t('goals.acProgress', { passing, total })}
            </span>
            <span className="text-muted-foreground" data-testid={`goal-latest-round-${goal.id}`}>
              {latestRound === null
                ? t('goals.noRounds')
                : t('goals.latestRound', {
                    seq: latestRound.seq,
                    outcome:
                      latestRound.outcome === null
                        ? t('goals.outcomeRunning')
                        : t(`goals.outcome.${latestRound.outcome}`),
                  })}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {canActivate && (
            <label className="flex items-center gap-1" title={t('goals.providerLabel')}>
              {/* The picker is narrow, so its name lives in the accessible tree only. */}
              <span className="sr-only">{t('goals.providerLabel')}</span>
              <select
                value={provider}
                disabled={pending}
                onChange={(event) => setProvider(event.target.value as LLMProvider)}
                className="rounded-md border border-input bg-card px-1.5 py-1 text-[11px] text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
                data-testid={`goal-provider-${goal.id}`}
              >
                {ACTIVATION_PROVIDERS.map((option) => (
                  <option key={option} value={option}>
                    {t(`goals.provider.${option}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canActivate && (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={pending}
              onClick={() => onActivate(goal.id, provider)}
              data-testid={`goal-activate-${goal.id}`}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('goals.activate')}
            </Button>
          )}
          {canRunRound && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => onRunRound(goal.id)}
              data-testid={`goal-run-round-${goal.id}`}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('goals.runRound')}
            </Button>
          )}
          {canPause && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onPause(goal.id)}
              data-testid={`goal-pause-${goal.id}`}
            >
              {t('goals.pause')}
            </Button>
          )}
          {canResume && (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={pending}
              onClick={() => onResume(goal.id)}
              data-testid={`goal-resume-${goal.id}`}
            >
              {t('goals.resume')}
            </Button>
          )}
          {canAbandon && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => onAbandon(goal.id)}
              data-testid={`goal-abandon-${goal.id}`}
            >
              {t('goals.abandon')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            data-testid={`goal-expand-${goal.id}`}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {expanded ? t('goals.collapse') : t('goals.expand')}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-border/40 pt-3 md:grid-cols-2">
          <section>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('goals.criteria')}
            </h4>
            {acs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground" data-testid={`goal-acs-empty-${goal.id}`}>
                {t('goals.noCriteria')}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {acs.map((ac) => (
                  <AcRow key={ac.id} ac={ac} evidence={latestEvidence[ac.id] ?? null} />
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('goals.rounds')}
            </h4>
            <RoundTimeline rounds={rounds} />
            <p className="mt-2 text-[10px] text-muted-foreground" data-testid={`goal-budget-${goal.id}`}>
              {t('goals.budget', {
                rounds: goal.budget.maxRounds,
                wallClock: Math.round(goal.budget.maxWallClockMs / 60_000),
                noProgress: goal.budget.maxNoProgress,
              })}
            </p>
          </section>
          {/* The full id stays available to hover and copy, but only its short form is printed:
              the whole UUID next to the title was unreadable. */}
          <p
            className="text-[10px] text-muted-foreground md:col-span-2"
            title={goal.id}
            data-testid={`goal-id-${goal.id}`}
          >
            {t('goals.goalId')}
            {' · '}
            <span className="font-mono">{shortenGoalId(goal.id)}</span>
          </p>
        </div>
      )}
    </li>
  );
}
