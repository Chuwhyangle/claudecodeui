import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type {
  ObservationStatusState,
  ObservationWallEntry,
} from '@/modules/cockpit/hooks/useObservationWall';
import { observationLiveness } from '@/modules/cockpit/ObservationTile';

/**
 * The stage's in-place preview of one observed object.
 *
 * OPENING THIS IS SEEING IT. The page advances the server-side seen cursor exactly once when
 * the preview opens (`POST /seen`), which clears the object's deltas on every device. 「稍后再看」
 * closes without moving the cursor — that is the whole difference between the two doors.
 *
 * WHAT EACH KIND SHOWS, and the one navigation it owns:
 *
 *   session      — the latest turn in full, plus its changes and test reading.
 *                  「在会话中打开」 is the ONLY link into the conversation.
 *   project      — the five-layer truth and the delta items behind them.
 *   architecture — the diff list and 「在架构 tab 中打开（高亮差异）」.
 *
 * The digest is the producer's document and this component treats it as opaque: a field it does
 * not recognise is not invented into a sentence. The structured fields it does read are named
 * here, and a missing one simply omits its line.
 */

const STATE_LABEL_KEYS: Record<ObservationStatusState, string> = {
  ok: 'cockpit.observationStateOk',
  attention: 'cockpit.observationStateAttention',
  red: 'cockpit.observationStateRed',
  unevaluated: 'cockpit.observationStateUnevaluated',
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The digest's change/test readings, across the field names producers actually use. */
function sessionChanges(digest: Record<string, unknown>): string[] {
  return [...stringList(digest.changes), ...stringList(digest.diff)];
}

function sessionTests(digest: Record<string, unknown>): string[] {
  const direct = [...stringList(digest.tests), ...stringList(digest.testResults)];
  const summary = stringValue(digest.tests);
  if (summary !== null) direct.push(summary);
  return direct;
}

/** The project's five-layer truth: `digest.layers` as `{ name: reading }`, or a stated absence. */
function projectLayers(digest: Record<string, unknown>): Array<[string, string]> {
  const layers = digest.layers;
  if (layers === null || typeof layers !== 'object' || Array.isArray(layers)) return [];
  return Object.entries(layers as Record<string, unknown>).map(([name, reading]) => [
    name,
    typeof reading === 'string'
      ? reading
      : reading === null || reading === undefined
        ? ''
        : JSON.stringify(reading),
  ]);
}

function architectureDiffs(entry: ObservationWallEntry): string[] {
  const digest = entry.object.digest;
  const explicit = [...stringList(digest.diffs), ...stringList(digest.delta), ...stringList(digest.changes)];
  return explicit.length > 0 ? explicit : entry.deltaItems;
}

export type ObservationPreviewProps = {
  entry: ObservationWallEntry;
  now: number;
  /** Closes the preview WITHOUT advancing the seen cursor. */
  onLater: () => void;
  onTogglePin: () => void;
  pinPending?: boolean;
  /** Session only: the one door into the conversation. */
  onOpenSession?: () => void;
  /** Architecture only: open the architecture tab with the differences highlighted. */
  onOpenArchitecture?: () => void;
  /** Why 「在架构 tab 中打开」 cannot be offered, when it cannot. */
  architectureUnavailableReason?: string | null;
};

export default function ObservationPreview({
  entry,
  now,
  onLater,
  onTogglePin,
  pinPending = false,
  onOpenSession,
  onOpenArchitecture,
  architectureUnavailableReason = null,
}: ObservationPreviewProps) {
  const { t } = useTranslation();
  const { object } = entry;
  const state = object.status.state;
  const digest = object.digest;

  const recentTurn =
    stringValue(digest.recentTurn) ?? stringValue(digest.turn) ?? stringValue(digest.summary);
  const changes = sessionChanges(digest);
  const tests = sessionTests(digest);
  const layers = projectLayers(digest);
  const diffs = architectureDiffs(entry);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto border-l border-border/40 bg-card p-3 text-xs text-foreground"
      aria-label={t('cockpit.observationPreviewLabel')}
      data-testid="cockpit-observation-preview"
      data-observation-uri={object.uri}
      data-observation-kind={object.kind}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            className="truncate text-sm font-semibold text-foreground"
            title={object.title}
            data-testid="observation-preview-title"
          >
            {object.title}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span
              className={cn(
                'font-medium',
                state === 'attention' && 'text-amber-800 dark:text-amber-200',
                state === 'red' && 'text-red-800 dark:text-red-200',
                state !== 'attention' && state !== 'red' && 'text-foreground',
              )}
              data-testid="observation-preview-state"
              data-state={state}
            >
              {t(STATE_LABEL_KEYS[state])}
            </span>
            <span data-testid="observation-preview-liveness" data-updated-at={object.updatedAt}>
              {observationLiveness(object.updatedAt, now, t)}
            </span>
            <span>{t('cockpit.observationRevision', { revision: object.revision })}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onLater}
          className="min-h-11 shrink-0 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent sm:min-h-0 sm:py-0.5"
          data-testid="observation-preview-later"
        >
          {t('cockpit.observationLater')}
        </button>
      </header>

      {state === 'unevaluated' && (
        <p className="mt-2 rounded border border-border/60 bg-muted/40 px-2 py-1 text-xs text-foreground" data-testid="observation-preview-reason">
          {object.status.reason ?? t('cockpit.observationNoReason')}
        </p>
      )}

      {object.kind === 'session' && (
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationRecentTurn')}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-foreground" data-testid="observation-preview-recent-turn">
              {recentTurn ?? t('cockpit.observationNoDigest')}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationChanges')}</p>
            {changes.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-changes">
                {t('cockpit.observationNoChanges')}
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="observation-preview-changes">
                {changes.map((change, index) => (
                  <li key={`${index}-${change}`}>{change}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationTests')}</p>
            {tests.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-tests">
                {t('cockpit.observationNoTests')}
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="observation-preview-tests">
                {tests.map((test, index) => (
                  <li key={`${index}-${test}`}>{test}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {object.kind === 'project' && (
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationFiveLayers')}</p>
            {layers.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-layers">
                {t('cockpit.observationNoDigest')}
              </p>
            ) : (
              <dl className="mt-0.5 space-y-1" data-testid="observation-preview-layers">
                {layers.map(([name, reading]) => (
                  <div key={name} className="flex gap-2">
                    <dt className="w-24 shrink-0 font-medium text-foreground">{name}</dt>
                    <dd className="min-w-0 flex-1 text-foreground">{reading}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationDeltas')}</p>
            {entry.deltaItems.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-deltas">
                {t('cockpit.observationNoDeltas')}
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="observation-preview-deltas">
                {entry.deltaItems.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {object.kind === 'architecture' && (
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationDiffs')}</p>
            {diffs.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-diffs">
                {t('cockpit.observationNoDeltas')}
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="observation-preview-diffs">
                {diffs.map((diff, index) => (
                  <li key={`${index}-${diff}`}>{diff}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenArchitecture}
              disabled={onOpenArchitecture === undefined}
              title={architectureUnavailableReason ?? undefined}
              className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-0 sm:py-0.5"
              data-testid="observation-preview-open-architecture"
            >
              {t('cockpit.observationOpenArchitecture')}
            </button>
            {architectureUnavailableReason !== null && (
              <span className="text-xs text-muted-foreground" data-testid="observation-preview-architecture-reason">
                {architectureUnavailableReason}
              </span>
            )}
          </div>
        </div>
      )}

      <footer className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        {object.kind === 'session' && onOpenSession !== undefined && (
          <button
            type="button"
            onClick={onOpenSession}
            className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent sm:min-h-0 sm:py-0.5"
            data-testid="observation-preview-open-session"
          >
            {t('cockpit.observationOpenSession')}
          </button>
        )}
        <button
          type="button"
          onClick={onTogglePin}
          disabled={pinPending}
          className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-0 sm:py-0.5"
          data-testid="observation-preview-pin"
          data-pinned={entry.pinned ? 'true' : 'false'}
        >
          {entry.pinned ? t('cockpit.observationUnpin') : t('cockpit.observationPin')}
        </button>
      </footer>
    </section>
  );
}
