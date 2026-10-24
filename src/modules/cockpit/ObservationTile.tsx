import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type {
  ObservationKind,
  ObservationStatusState,
  ObservationWallEntry,
} from '@/modules/cockpit/hooks/useObservationWall';
import { useObservationPin } from '@/modules/cockpit/hooks/useObservationWall';

/**
 * One object on the observation wall.
 *
 * WHAT A TILE IS FOR. It has to answer three questions before a person reads a single word of
 * detail: what is this, what state is it in, and has anything changed since I last looked. So
 * the tile is title → status (with the reading's liveness timestamp) → answer-first summary →
 * 「自上次看过 N」. Only `attention` and `red` carry an emphasis colour: a wall where every tile
 * is green is a wall whose colour says nothing.
 *
 * THE THREE-STATE RULE IS STRUCTURAL. `unevaluated` is not a flavour of `ok`: it renders its
 * `reason` and never the green/neutral "healthy" treatment, because "we could not read this"
 * and "we read it and it is fine" are different facts (references: 读数三态).
 *
 * 「临时」 marks an AUTOMATIC tile — one that surfaced because it needs attention rather than
 * because the person pinned it. Pinned tiles are resident; automatic ones can be folded by the
 * block cap, which is why the mark names who put the tile there.
 */

/** The i18n key for each state's badge. */
const STATE_LABEL_KEYS: Record<ObservationStatusState, string> = {
  ok: 'cockpit.observationStateOk',
  attention: 'cockpit.observationStateAttention',
  red: 'cockpit.observationStateRed',
  unevaluated: 'cockpit.observationStateUnevaluated',
};

/** The i18n key for each object kind's badge. */
const KIND_LABEL_KEYS: Record<ObservationKind, string> = {
  session: 'cockpit.observationKindSession',
  project: 'cockpit.observationKindProject',
  architecture: 'cockpit.observationKindArchitecture',
};

/** Only the two states that ask something of the person use the emphasis colour. */
const STATE_IS_LOUD = (state: ObservationStatusState): boolean =>
  state === 'attention' || state === 'red';

/**
 * A tile's second line: the answer first. Producers put their own words in `digest.summary`;
 * a producer that did not is not summarised by the UI (the UI cannot know the object's story),
 * so the first unseen delta item — or an explicit "no summary" — is shown instead.
 */
export function observationSummary(entry: ObservationWallEntry): string | null {
  const digest = entry.object.digest;
  for (const key of ['summary', 'answer', 'headline', 'latest']) {
    const value = digest[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const firstDelta = entry.deltaItems[0];
  return typeof firstDelta === 'string' && firstDelta.trim() !== '' ? firstDelta.trim() : null;
}

/** A short, human liveness line: "just now", "12 min ago", "3 h ago", "2 d ago". */
export function observationLiveness(
  updatedAt: number,
  now: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const minutes = Math.max(0, Math.round((now - updatedAt) / 60_000));
  if (minutes < 1) return t('cockpit.observationJustNow');
  if (minutes < 60) return t('cockpit.observationMinutesAgo', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('cockpit.observationHoursAgo', { n: hours });
  return t('cockpit.observationDaysAgo', { n: Math.round(hours / 24) });
}

export type ObservationTileProps = {
  entry: ObservationWallEntry;
  /** The spoken ordinal (①, ②, …) among the wall's declared objects. */
  ordinal: string;
  focused: boolean;
  /** True for an automatic (not pinned, attention/red) tile — drawn with the 「临时」 mark. */
  temporary: boolean;
  /** The reading clock, so every tile on one render uses the same "now". */
  now: number;
  onFocus: () => void;
  onOpen: () => void;
  onTogglePin: () => void;
  pinPending?: boolean;
};

/** One tile. Presentational: focus/preview/pin are the page's, not the tile's. */
export default function ObservationTile({
  entry,
  ordinal,
  focused,
  temporary,
  now,
  onFocus,
  onOpen,
  onTogglePin,
  pinPending = false,
}: ObservationTileProps) {
  const { t } = useTranslation();
  const { object } = entry;
  const state = object.status.state;
  const loud = STATE_IS_LOUD(state);
  const summary = observationSummary(entry);
  const unseen = entry.deltaItems.length;

  return (
    <li
      role="button"
      tabIndex={-1}
      aria-label={t('cockpit.observationTileLabel', {
        position: ordinal,
        title: object.title,
        state: t(STATE_LABEL_KEYS[state]),
      })}
      onClick={() => {
        onFocus();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'flex min-h-11 cursor-pointer list-none flex-col rounded-lg border bg-card p-3 text-left',
        'text-xs text-foreground transition-shadow focus:outline-none',
        loud ? 'border-amber-500/70' : 'border-border/50',
        state === 'red' && 'border-red-500/70',
        focused && 'ring-2 ring-primary',
      )}
      data-testid="observation-tile"
      data-observation-uri={object.uri}
      data-observation-kind={object.kind}
      data-observation-state={state}
      data-observation-pinned={entry.pinned ? 'true' : 'false'}
      data-observation-temporary={temporary ? 'true' : 'false'}
      data-observation-unseen={unseen}
      data-focused={focused ? 'true' : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className="shrink-0 text-sm font-semibold tabular-nums text-foreground"
            data-testid="observation-tile-ordinal"
          >
            {ordinal}
          </span>
          <span
            className="truncate text-sm font-medium text-foreground"
            title={object.title}
            data-testid="observation-tile-title"
          >
            {object.title}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {temporary && (
            <span
              className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              data-testid="observation-tile-temporary"
            >
              {t('cockpit.observationTemporary')}
            </span>
          )}
          <span
            className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            data-testid="observation-tile-kind"
          >
            {t(KIND_LABEL_KEYS[object.kind])}
          </span>
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The status badge is text AND colour: colour alone is not a reading, and only
            attention/red are allowed to be loud. */}
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium',
            state === 'ok' && 'bg-muted text-foreground',
            state === 'attention' && 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
            state === 'red' && 'bg-red-500/15 text-red-800 dark:text-red-200',
            state === 'unevaluated' && 'bg-muted text-foreground',
          )}
          data-testid="observation-tile-state"
          data-state={state}
        >
          {loud && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
          {t(STATE_LABEL_KEYS[state])}
        </span>
        {/* Every green light carries a liveness timestamp: a reading with no time is
            indistinguishable from a reading nobody took. */}
        <span
          className="text-xs text-muted-foreground"
          data-testid="observation-tile-liveness"
          data-updated-at={object.updatedAt}
          title={new Date(object.updatedAt).toISOString()}
        >
          {observationLiveness(object.updatedAt, now, t)}
        </span>
        {unseen > 0 && (
          <span
            className="text-xs font-medium text-foreground"
            data-testid="observation-tile-delta"
            data-unseen={unseen}
          >
            {t('cockpit.observationUnseen', { n: unseen })}
          </span>
        )}
      </div>

      {state === 'unevaluated' ? (
        <p className="mt-1.5 text-xs text-foreground" data-testid="observation-tile-reason">
          {object.status.reason ?? t('cockpit.observationNoReason')}
        </p>
      ) : summary !== null ? (
        <p className="mt-1.5 line-clamp-2 text-xs text-foreground" data-testid="observation-tile-summary">
          {summary}
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="observation-tile-summary">
          {t('cockpit.observationNoSummary')}
        </p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-foreground">
          {entry.pinned ? t('cockpit.observationPinned') : t('cockpit.observationAutoSurfaced')}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent sm:min-h-0 sm:py-0.5"
            data-testid="observation-tile-open"
          >
            {t('cockpit.observationOpen')}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
            disabled={pinPending}
            className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-0 sm:py-0.5"
            data-testid="observation-tile-pin"
            data-pinned={entry.pinned ? 'true' : 'false'}
          >
            {entry.pinned ? t('cockpit.observationUnpin') : t('cockpit.observationPin')}
          </button>
        </span>
      </div>
    </li>
  );
}

// ── The sidebar rows' action ────────────────────────────────────────────────

/**
 * 「钉到观察墙 / 取消」 for one object, used by the sidebar's project and session rows.
 *
 * It lives here, not in the sidebar, because the pin cache and the API are the observation
 * module's. It reads the shared cache (no request on mount — a sidebar has one row per
 * project/session and must not fan out HTTP), and writes through the same route the wall does,
 * so the row and the wall cannot disagree after a toggle.
 */
export function WatchPinToggle({
  uri,
  className,
  testId = 'observation-watch-toggle',
}: {
  uri: string;
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const { pinned, pending, toggle } = useObservationPin(uri);
  const label = pinned ? t('cockpit.observationUnpin') : t('cockpit.observationPin');
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void toggle();
      }}
      disabled={pending}
      title={label}
      aria-label={label}
      aria-pressed={pinned}
      className={cn(
        'flex min-h-11 min-w-11 items-center justify-center rounded text-xs text-muted-foreground',
        'hover:bg-accent disabled:opacity-50 sm:min-h-0 sm:min-w-0 sm:h-6 sm:w-6',
        className,
      )}
      data-testid={testId}
      data-observation-uri={uri}
      data-pinned={pinned ? 'true' : 'false'}
    >
      {/* A star is the same affordance the sidebar already uses for "keep this". */}
      <span aria-hidden>{pinned ? '★' : '☆'}</span>
    </button>
  );
}
