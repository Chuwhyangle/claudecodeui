import { AlertTriangle, Loader2, Plus, RefreshCw, Target } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CreateGoalAcRequest, GoalBudget } from '@/shared/goalLoopType';
import type { LLMProvider } from '@/shared/types';
import { Button } from '@/shared/ui';

import { GoalCard } from '@/modules/goals/components/GoalCard';
import { useGoals } from '@/modules/goals/hooks/useGoals';
import type { CreateGoalInput } from '@/modules/goals/hooks/useGoals';

type GoalPanelProps = {
  /** The selected project's id; every goal read and write is scoped to it. */
  projectId: string;
  /** The project directory, which activation resolves into the goal worktree. */
  projectPath: string;
  /** True while the Goals tab is on screen; a hidden tab stops polling. */
  isActive: boolean;
};

/** One criterion row being authored. `rowId` is a client-side key so removing a row cannot remount its neighbours. */
type DraftCriterion = CreateGoalAcRequest & { rowId: number };

/** An empty criterion row; every field is required by the route, so the form starts blank on purpose. */
function emptyCriterion(rowId: number): DraftCriterion {
  return { rowId, title: '', criterion: '', expect: '' };
}

/**
 * One optional numeric form field, already parsed. `value` is `null` when the person left it
 * blank — the server's default then applies — and `invalid` marks a non-empty entry that is not a
 * positive (integer) number, so the form can refuse to submit instead of silently dropping what
 * was typed.
 */
type OptionalNumber = { value: number | null; invalid: boolean };

/** Reads a positive integer field, or reports it blank/invalid; used by the round and no-progress limits. */
function readOptionalInteger(raw: string): OptionalNumber {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, invalid: false };
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? { value, invalid: false } : { value: null, invalid: true };
}

/** Reads a positive number field; the wall-clock limit is entered in (possibly fractional) hours. */
function readOptionalNumber(raw: string): OptionalNumber {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, invalid: false };
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? { value, invalid: false } : { value: null, invalid: true };
}

/**
 * The new-goal form: a title, an objective, and at least one acceptance criterion (title,
 * runnable command, and the failure it is meant to detect).
 *
 * It submits through `createGoal`, which creates the goal first and then adds each criterion —
 * the store mints AC ids, so they cannot be sent with the goal.
 *
 * Used by `GoalPanel` in the Goals tab.
 */
function GoalCreateForm({
  onCreate,
  onCancel,
}: {
  /** Creates the goal and resolves to its id, or `null` when the server refused. */
  onCreate: (input: CreateGoalInput) => Promise<string | null>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // The draft fields. They cannot be derived: nothing outside the person typing knows what this
  // goal is called, which is the whole input of the form.
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  // The criterion rows being authored, one entry per row the person has added.
  const [criteria, setCriteria] = useState<DraftCriterion[]>([emptyCriterion(0)]);
  // The three budget limits, as typed. They are strings so a blank field can mean "use the
  // server default" instead of collapsing to 0; the defaults shown here mirror the store's own
  // so the form states them without taking them over.
  const [maxRounds, setMaxRounds] = useState('20');
  const [wallClockHours, setWallClockHours] = useState('2');
  const [maxNoProgress, setMaxNoProgress] = useState('3');
  // True while the create + add-AC calls are in flight; it disables submit so a double click
  // cannot create the same goal twice.
  const [submitting, setSubmitting] = useState(false);

  const updateCriterion = (rowId: number, patch: Partial<CreateGoalAcRequest>) => {
    setCriteria((current) => current.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)));
  };

  const removeCriterion = (rowId: number) => {
    setCriteria((current) => (current.length <= 1 ? current : current.filter((row) => row.rowId !== rowId)));
  };

  const roundsField = readOptionalInteger(maxRounds);
  const hoursField = readOptionalNumber(wallClockHours);
  const noProgressField = readOptionalInteger(maxNoProgress);
  const budgetInvalid = roundsField.invalid || hoursField.invalid || noProgressField.invalid;

  // Every field the server requires, checked here so the submit button can state what is missing
  // instead of firing a 400 the person has to decode.
  const complete =
    title.trim() !== '' &&
    objective.trim() !== '' &&
    criteria.length > 0 &&
    criteria.every((row) => row.title.trim() !== '' && row.criterion.trim() !== '' && row.expect.trim() !== '') &&
    !budgetInvalid;

  /**
   * The budget body for `POST /api/goals`. Only the limits that were filled in are sent: an absent
   * field means "keep the store's default", which is not the same as sending 0.
   */
  const buildBudget = (): Partial<GoalBudget> | undefined => {
    const budget: Partial<GoalBudget> = {};
    if (roundsField.value !== null) budget.maxRounds = roundsField.value;
    if (hoursField.value !== null) budget.maxWallClockMs = Math.round(hoursField.value * 3_600_000);
    if (noProgressField.value !== null) budget.maxNoProgress = noProgressField.value;
    return Object.keys(budget).length === 0 ? undefined : budget;
  };

  const handleSubmit = async () => {
    if (!complete || submitting) return;
    setSubmitting(true);
    try {
      const created = await onCreate({
        title: title.trim(),
        objective: objective.trim(),
        // `rowId` is this form's own key; the wire body carries only the three fields.
        acs: criteria.map(({ title: acTitle, criterion, expect }) => ({
          title: acTitle.trim(),
          criterion: criterion.trim(),
          expect: expect.trim(),
        })),
        budget: buildBudget(),
      });
      if (created !== null) {
        onCancel();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fieldClass =
    'w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

  return (
    <form
      className="mb-3 rounded-lg border border-border/60 bg-muted/20 p-3"
      data-testid="goal-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('goals.formTitle')}
      </h3>

      <label className="mb-2 block">
        <span className="mb-1 block text-[11px] text-muted-foreground">{t('goals.fieldTitle')}</span>
        <input
          className={fieldClass}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          data-testid="goal-create-title"
          placeholder={t('goals.fieldTitlePlaceholder')}
        />
      </label>

      <label className="mb-2 block">
        <span className="mb-1 block text-[11px] text-muted-foreground">{t('goals.fieldObjective')}</span>
        <textarea
          className={fieldClass}
          rows={2}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          data-testid="goal-create-objective"
          placeholder={t('goals.fieldObjectivePlaceholder')}
        />
      </label>

      <div className="mb-2 grid grid-cols-3 gap-2" data-testid="goal-create-budget">
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted-foreground">{t('goals.fieldMaxRounds')}</span>
          <input
            className={fieldClass}
            type="number"
            min={1}
            step={1}
            value={maxRounds}
            onChange={(event) => setMaxRounds(event.target.value)}
            placeholder="20"
            data-testid="goal-create-budget-rounds"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted-foreground">{t('goals.fieldWallClockHours')}</span>
          <input
            className={fieldClass}
            type="number"
            min={0}
            step={0.5}
            value={wallClockHours}
            onChange={(event) => setWallClockHours(event.target.value)}
            placeholder="2"
            data-testid="goal-create-budget-hours"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-muted-foreground">{t('goals.fieldMaxNoProgress')}</span>
          <input
            className={fieldClass}
            type="number"
            min={1}
            step={1}
            value={maxNoProgress}
            onChange={(event) => setMaxNoProgress(event.target.value)}
            placeholder="3"
            data-testid="goal-create-budget-no-progress"
          />
        </label>
      </div>
      <p className="mb-2 text-[10px] text-muted-foreground" data-testid="goal-create-budget-hint">
        {t('goals.budgetHint')}
      </p>

      <div className="space-y-2" data-testid="goal-create-acs">
        {criteria.map((row, index) => (
          <div key={row.rowId} className="rounded border border-border/40 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t('goals.criterionNumber', { index: index + 1 })}
              </span>
              {criteria.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => removeCriterion(row.rowId)}
                  data-testid={`goal-create-ac-remove-${row.rowId}`}
                >
                  {t('goals.removeCriterion')}
                </Button>
              )}
            </div>
            <input
              className={`${fieldClass} mb-1`}
              value={row.title}
              onChange={(event) => updateCriterion(row.rowId, { title: event.target.value })}
              placeholder={t('goals.acTitlePlaceholder')}
              data-testid={`goal-create-ac-title-${row.rowId}`}
            />
            <input
              className={`${fieldClass} mb-1 font-mono`}
              value={row.criterion}
              onChange={(event) => updateCriterion(row.rowId, { criterion: event.target.value })}
              placeholder={t('goals.acCriterionPlaceholder')}
              data-testid={`goal-create-ac-criterion-${row.rowId}`}
            />
            <input
              className={fieldClass}
              value={row.expect}
              onChange={(event) => updateCriterion(row.rowId, { expect: event.target.value })}
              placeholder={t('goals.acExpectPlaceholder')}
              data-testid={`goal-create-ac-expect-${row.rowId}`}
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setCriteria((current) => [...current, emptyCriterion((current.at(-1)?.rowId ?? -1) + 1)])}
          data-testid="goal-create-add-ac"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('goals.addCriterion')}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="default"
          disabled={!complete || submitting}
          data-testid="goal-create-submit"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {submitting ? t('goals.creating') : t('goals.createSubmit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} data-testid="goal-create-cancel">
          {t('goals.createCancel')}
        </Button>
        {budgetInvalid ? (
          <span className="text-[11px] text-muted-foreground" data-testid="goal-create-incomplete">
            {t('goals.formBudgetInvalid')}
          </span>
        ) : (
          !complete && (
            <span className="text-[11px] text-muted-foreground" data-testid="goal-create-incomplete">
              {t('goals.formIncomplete')}
            </span>
          )
        )}
      </div>
    </form>
  );
}

/**
 * The Goals tab: the selected project's goals, each with its acceptance criteria and round
 * timeline, plus the person-triggered lifecycle actions (create, activate, pause, resume, abandon,
 * run one round).
 *
 * This panel is CloudCLI's own write surface, distinct from `QuayPanel`, which mirrors an external
 * quay project read-only (docs/proposals/goal-loop.md §8).
 *
 * A red-first activation refusal is rendered as a visible notice naming the criteria that already
 * pass, never as an error page: the call succeeded, the goal simply cannot start.
 *
 * Rendered by `WorkspaceMain` when the workspace tab is `goals`.
 */
export function GoalPanel({ projectId, projectPath, isActive }: GoalPanelProps) {
  const { t } = useTranslation();
  const {
    view,
    refresh,
    pendingGoalId,
    notice,
    createGoal,
    activate,
    pause,
    resume,
    abandon,
    runRound,
  } = useGoals(projectId, projectPath, isActive);
  // Whether the authoring form is open. It is local UI state — the list has no use for it and
  // closing the tab should not persist a half-written goal.
  const [isCreating, setIsCreating] = useState(false);

  const header = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Target className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">{t('goals.title')}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => setIsCreating((current) => !current)}
          data-testid="goal-create-button"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('goals.create')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={refresh} data-testid="goal-refresh">
          <RefreshCw className="h-3.5 w-3.5" />
          {t('goals.refresh')}
        </Button>
      </div>
    </div>
  );

  if (view.status === 'loading') {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="goal-panel-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('goals.loading')}
      </div>
    );
  }

  if (view.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="goal-panel-error">
        <div className="max-w-sm text-center text-sm text-muted-foreground">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-amber-500" />
          <p className="mb-3">{view.message}</p>
          <Button type="button" size="sm" variant="outline" onClick={refresh} data-testid="goal-panel-retry">
            <RefreshCw className="h-3.5 w-3.5" />
            {t('goals.retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4" data-testid="goal-panel-loaded">
      {header}

      {notice !== null && (
        <div
          className="mb-3 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid="goal-panel-notice"
          role="status"
        >
          <p>{notice.message}</p>
          {/* A refusal is not a failure: it says WHICH criteria already pass, so the person can
              decide whether the goal is already met or the criteria need rewriting. */}
          {notice.kind === 'refusal' && notice.greenAcIds.length > 0 && (
            <p className="mt-1" data-testid="goal-panel-refusal-green-acs">
              {t('goals.refusalGreenAcs', { ids: notice.greenAcIds.join(', ') })}
            </p>
          )}
        </div>
      )}

      {isCreating && <GoalCreateForm onCreate={createGoal} onCancel={() => setIsCreating(false)} />}

      {view.goals.length === 0 ? (
        <div className="flex flex-1 items-center justify-center" data-testid="goal-panel-empty">
          <div className="max-w-sm text-center text-sm text-muted-foreground">
            <Target className="mx-auto mb-2 h-5 w-5" />
            <p className="mb-1 font-medium text-foreground">{t('goals.emptyTitle')}</p>
            <p>{t('goals.emptyBody')}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setIsCreating(true)}
              data-testid="goal-empty-create"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('goals.create')}
            </Button>
          </div>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="goal-panel-list">
          {view.goals.map((item) => (
            <GoalCard
              key={item.goal.id}
              item={item}
              pending={pendingGoalId === item.goal.id}
              onActivate={(goalId: string, provider: LLMProvider) => void activate(goalId, provider)}
              onPause={(goalId) => void pause(goalId)}
              onResume={(goalId) => void resume(goalId)}
              onAbandon={(goalId) => void abandon(goalId)}
              onRunRound={(goalId) => void runRound(goalId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
