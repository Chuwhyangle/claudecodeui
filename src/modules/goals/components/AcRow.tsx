import { useTranslation } from 'react-i18next';

import type { GoalAc, GoalEvidence } from '@/shared/goalLoopType';
import { cn } from '@/shared/utils';

type AcRowProps = {
  ac: GoalAc;
  /** The newest reading for this criterion, or `null` when no round has judged it yet. */
  evidence: GoalEvidence | null;
};

/**
 * The criterion's own half of its id. Ids are minted as `<goalId>-AC-001`, and the goal half is a
 * UUID the card no longer prints anywhere; naming only the suffix keeps a row readable without
 * losing which criterion it is.
 */
function criterionLabel(ac: GoalAc): string {
  const prefix = `${ac.goalId}-`;
  return ac.id.startsWith(prefix) ? ac.id.slice(prefix.length) : ac.id;
}

/**
 * One acceptance criterion: its pass/fail reading, the runnable command that decides it, the
 * failure it is meant to detect, and the tail of its last run.
 *
 * The dot is coloured by EVIDENCE, never by the AC's own `status`: an AC is `active` both before
 * its first run and after a failing one, so colouring by status would paint a never-run criterion
 * and a failing one the same green.
 *
 * Used by `GoalCard` in the Goals tab.
 */
export function AcRow({ ac, evidence }: AcRowProps) {
  const { t } = useTranslation();
  const verdict = evidence?.verdict ?? null;

  return (
    <li
      className="rounded border border-border/40 px-2 py-1.5"
      data-testid={`goal-ac-row-${ac.id}`}
      data-verdict={verdict ?? 'none'}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className={cn(
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            verdict === 'pass' ? 'bg-green-500' : verdict === 'fail' ? 'bg-red-500' : 'bg-muted-foreground/40',
          )}
          data-testid={`goal-ac-dot-${ac.id}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-foreground" title={ac.title}>
              {ac.title}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground" title={ac.id}>
              {criterionLabel(ac)}
            </span>
            {evidence === null && (
              <span className="text-[10px] text-muted-foreground" data-testid={`goal-ac-no-reading-${ac.id}`}>
                {t('goals.noReading')}
              </span>
            )}
          </div>
          <code
            className="mt-1 block overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/50 px-1.5 py-1 font-mono text-[11px] text-foreground"
            data-testid={`goal-ac-criterion-${ac.id}`}
          >
            {ac.criterion}
          </code>
          <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`goal-ac-expect-${ac.id}`}>
            <span className="uppercase tracking-wide">{t('goals.expect')}</span>
            {': '}
            {ac.expect}
          </p>
          {evidence !== null && (
            <div className="mt-1" data-testid={`goal-ac-evidence-${ac.id}`}>
              <p className="text-[10px] text-muted-foreground" data-testid={`goal-ac-evidence-line-${ac.id}`}>
                {t('goals.lastReading', {
                  verdict: t(`goals.verdict.${evidence.verdict}`),
                  code: evidence.exitCode === null ? '—' : evidence.exitCode,
                })}
                {evidence.timedOut ? ` · ${t('goals.timedOut')}` : ''}
              </p>
              {evidence.outputExcerpt !== '' && (
                <pre
                  className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 px-1.5 py-1 font-mono text-[10px] text-muted-foreground"
                  data-testid={`goal-ac-evidence-output-${ac.id}`}
                >
                  {evidence.outputExcerpt}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
