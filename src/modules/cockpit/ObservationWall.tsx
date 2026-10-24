import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { ObservationWall as ObservationWallData } from '@/modules/cockpit/hooks/useObservationWall';
import { deriveSelfReading } from '@/modules/cockpit/hooks/useObservationWall';
import { observationLiveness } from '@/modules/cockpit/ObservationTile';
import ObservationTile from '@/modules/cockpit/ObservationTile';

/**
 * The cockpit's home: the observation wall.
 *
 * THREE KINDS, ONE SHAPE. Sessions, projects and architecture views are all `ObservedObject`s,
 * so the wall draws one tile component for all three and only the digest differs. The wall does
 * not compose that choice — the server already ordered the entries (red → attention → ok →
 * unevaluated, then most-recently-revised) and applied the twelve-block cap; this file draws
 * exactly what it was given.
 *
 * THE LAYER'S OWN TILE. When a producer is not `ok`, the top of the wall carries a
 * 「观察层自身」 tile: the wall is quiet because the machinery that fills it is not running, and
 * that fact must be the first thing on the page. It is drawn OUTSIDE the capped list — it is not
 * an entry and never consumes one of the twelve slots. When every producer is `ok` the tile is
 * absent; the page header carries a quiet timestamp instead.
 */

/** Circled ordinals — the same spoken handles the rest of the cockpit uses. */
const CIRCLED_ORDINALS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/**
 * The shipped block cap. The server applies the same twelve (a `observation.wallLimit` setting
 * can raise it), and the UI applies it AGAIN so a wall that arrives with more entries than the
 * cap is folded rather than silently drawn past the limit. The 「观察层自身」 tile is outside
 * this list and therefore never consumes a slot.
 */
export const OBSERVATION_WALL_LIMIT = 12;

export type ObservationWallProps = {
  wall: ObservationWallData;
  focusUri: string | null;
  now: number;
  onFocus: (uri: string) => void;
  onOpen: (uri: string) => void;
  onTogglePin: (uri: string) => void;
  /** The object whose pin write is in flight, if any. */
  pinPendingUri?: string | null;
};

export default function ObservationWall({
  wall,
  focusUri,
  now,
  onFocus,
  onOpen,
  onTogglePin,
  pinPendingUri = null,
}: ObservationWallProps) {
  const { t } = useTranslation();
  const self = deriveSelfReading(wall.producers);
  // Fold at the cap even if the server sent more: the wall's promise is "twelve tiles", and a
  // surface that draws past it would make the collapsed count disagree with what is on screen.
  const drawnEntries = wall.entries.slice(0, OBSERVATION_WALL_LIMIT);
  const foldedCount = wall.entries.length - drawnEntries.length + wall.collapsedCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="observation-wall">
      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="observation-wall-scroll">
        {self !== null && (
          <SelfTile self={self} now={now} />
        )}

        {drawnEntries.length === 0 ? (
          /*
            AN EMPTY WALL MUST SAY WHY IT IS EMPTY. 「Nothing to observe right now.」 beside a
            running session reads like a broken wall; the reason sentence says what the wall
            admits, and the next sentence says how to put something on it (pin a session or a
            project) or what will fill it on its own.
          */
          <div className="p-3" data-testid="observation-wall-empty">
            <p className="text-xs font-medium text-foreground">{t('cockpit.observationEmpty')}</p>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="observation-wall-empty-reason"
            >
              {t('cockpit.observationEmptyReason')}
            </p>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="observation-wall-empty-next"
            >
              {t('cockpit.observationEmptyNext')}
            </p>
          </div>
        ) : (
          <ul
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="observation-wall-tiles"
          >
            {drawnEntries.map((entry, index) => (
              <ObservationTile
                key={entry.object.uri}
                entry={entry}
                ordinal={CIRCLED_ORDINALS[index] ?? `(${index + 1})`}
                focused={entry.object.uri === focusUri}
                // An automatic tile is one the wall surfaced for you: not pinned, and loud.
                temporary={
                  !entry.pinned &&
                  (entry.object.status.state === 'attention' || entry.object.status.state === 'red')
                }
                now={now}
                onFocus={() => onFocus(entry.object.uri)}
                onOpen={() => onOpen(entry.object.uri)}
                onTogglePin={() => onTogglePin(entry.object.uri)}
                pinPending={pinPendingUri === entry.object.uri}
              />
            ))}
          </ul>
        )}

        {foldedCount > 0 && (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="observation-wall-collapsed"
            data-collapsed={foldedCount}
          >
            {t('cockpit.observationCollapsed', { n: foldedCount })}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The observation layer's own reading.
 *
 * `state` is the strongest non-ok reading among the producers (red outranks stale outranks
 * never-run), and the reason names EVERY offender — a single "producer failed" sentence would
 * hide the second one. The last attempt time is the reading's own liveness: a wall that says
 * "the layer is not running" must also say when it last tried.
 */
function SelfTile({
  self,
  now,
}: {
  self: NonNullable<ReturnType<typeof deriveSelfReading>>;
  now: number;
}) {
  const { t } = useTranslation();
  const labelKey =
    self.state === 'red'
      ? 'cockpit.observationStateRed'
      : self.state === 'unevaluated'
        ? 'cockpit.observationStateUnevaluated'
        : 'cockpit.observationStateAttention';
  return (
    <div
      className={cn(
        'mb-2 rounded-lg border p-3 text-xs',
        self.state === 'red'
          ? 'border-red-500/70 bg-red-500/10'
          : 'border-amber-500/70 bg-amber-500/10',
      )}
      data-testid="observation-self-tile"
      data-state={self.state}
      data-producer-count={self.offenders.length}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-foreground">{t('cockpit.observationSelfTitle')}</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-xs font-medium',
            self.state === 'red'
              ? 'bg-red-500/15 text-red-800 dark:text-red-200'
              : 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
          )}
          data-testid="observation-self-state"
        >
          {t(labelKey)}
        </span>
        <span className="text-xs text-muted-foreground" data-testid="observation-self-last-run">
          {self.lastRunAt === null
            ? t('cockpit.observationSelfNeverRan')
            : t('cockpit.observationSelfLastRun', {
                time: observationLiveness(self.lastRunAt, now, t),
              })}
        </span>
      </div>
      <p className="mt-1 text-xs text-foreground" data-testid="observation-self-reason">
        {self.reason}
      </p>
    </div>
  );
}
