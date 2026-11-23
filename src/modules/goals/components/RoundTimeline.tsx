import { useTranslation } from 'react-i18next';

import type { GoalRound, GoalRoundOutcome } from '@/shared/goalLoopType';
import { cn } from '@/shared/utils';

/**
 * Colour per round outcome. `null` is a round that is still running — it has no outcome yet, and
 * drawing it as any finished verdict would be a prediction.
 */
const OUTCOME_DOT_CLASSES: Record<GoalRoundOutcome, string> = {
  green: 'bg-green-500',
  progress: 'bg-blue-500',
  'no-progress': 'bg-amber-500',
  stalled: 'bg-amber-600',
  'budget-hit': 'bg-orange-600',
  error: 'bg-red-500',
};
const RUNNING_DOT_CLASS = 'bg-muted-foreground/40';

/** Formats a round's wall-clock duration; a round still running has none. */
function formatRoundDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) {
    return '—';
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return '—';
  }

  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

type RoundTimelineProps = {
  /** The goal's rounds; the timeline draws them oldest-first by `seq`. */
  rounds: GoalRound[];
};

/**
 * The goal's rounds as a compact vertical timeline: sequence number, outcome and how long the
 * round took. Oldest first, because a round's meaning comes from the one before it
 * (`no-progress` is a statement about `seq - 1`).
 *
 * Used by `GoalCard` in the Goals tab.
 */
export function RoundTimeline({ rounds }: RoundTimelineProps) {
  const { t } = useTranslation();

  if (rounds.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="goal-rounds-empty">
        {t('goals.noRounds')}
      </p>
    );
  }

  const ordered = [...rounds].sort((left, right) => left.seq - right.seq);

  return (
    <ol className="space-y-1" data-testid="goal-round-timeline">
      {ordered.map((round) => (
        <li
          key={round.id}
          className="flex items-center gap-2 rounded border border-border/40 px-2 py-1 text-[11px]"
          data-testid={`goal-round-${round.id}`}
          data-outcome={round.outcome ?? 'running'}
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              round.outcome === null ? RUNNING_DOT_CLASS : OUTCOME_DOT_CLASSES[round.outcome],
            )}
          />
          <span className="shrink-0 font-mono text-muted-foreground">#{round.seq}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">
            {round.outcome === null ? t('goals.outcomeRunning') : t(`goals.outcome.${round.outcome}`)}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground" title={round.startedAt}>
            {formatRoundDuration(round.startedAt, round.endedAt)}
          </span>
        </li>
      ))}
    </ol>
  );
}
