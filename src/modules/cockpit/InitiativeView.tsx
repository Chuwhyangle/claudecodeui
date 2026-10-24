import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type { InitiativeReading } from '@/modules/cockpit/cockpitView';

/**
 * The cockpit's 「倡议」 view: one row per cross-project initiative.
 *
 * WHAT A ROW MUST ANSWER. An initiative is one thing spanning several projects, so the row is
 * projects-as-cells (each cell carries that project's task/goal progress) with the dependency
 * edges drawn between them. A BLOCKING edge is the row's loudest reading: it is highlighted and
 * states how long the question has been waiting, because 「在等什么、等了多久」 is the one fact
 * that decides whether the person drops everything.
 *
 * FOCUS AND PIN ARE THE FLEET'S ADDRESS. The row's focusable object is
 * `quay://fleet/initiative/<slug>` — the reserved address the fleet and the observation wall
 * both know — never a display name. Focusing reports that URI to the cockpit hub; pinning
 * writes the observation watch entry for the same string, so the object a person pins is the
 * object the focus contract moves over.
 *
 * Consumers: `CockpitPage` (the `/cockpit?view=initiatives` stage).
 */

/** Circled ordinals — the same spoken handles the rest of the cockpit uses. */
const CIRCLED_ORDINALS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

const EDGE_LABEL_KEYS: Record<string, string> = {
  blocks: 'cockpit.initiativeEdgeBlocks',
  contract: 'cockpit.initiativeEdgeContract',
  release: 'cockpit.initiativeEdgeRelease',
};

/** A short duration reading for a blocked edge: minutes, hours, or days. */
export function initiativeBlockedFor(
  blockedSince: string | null,
  now: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (blockedSince === null) return null;
  const started = Date.parse(blockedSince);
  if (!Number.isFinite(started)) return null;
  const minutes = Math.max(0, Math.round((now - started) / 60_000));
  if (minutes < 1) return t('cockpit.initiativeDurationJustNow');
  if (minutes < 60) return t('cockpit.initiativeDurationMinutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('cockpit.initiativeDurationHours', { n: hours });
  return t('cockpit.initiativeDurationDays', { n: Math.round(hours / 24) });
}

export type InitiativeViewProps = {
  initiatives: readonly InitiativeReading[];
  /** The hub's focused URI, or null. */
  focusUri: string | null;
  /** The observation wall's pinned URI cache. */
  pinnedUris: ReadonlySet<string>;
  /** The initiative whose pin write is in flight. */
  pinPendingUri: string | null;
  /** The reading clock, so every duration on one render uses the same "now". */
  now: number;
  onFocus: (uri: string) => void;
  onPin: (uri: string) => void;
};

/** One initiative row. Presentational: focus and pin are the page's, not the view's. */
export default function InitiativeView({
  initiatives,
  focusUri,
  pinnedUris,
  pinPendingUri,
  now,
  onFocus,
  onPin,
}: InitiativeViewProps) {
  const { t } = useTranslation();

  if (initiatives.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground" data-testid="initiative-empty">
        {t('cockpit.initiativeEmpty')}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="initiative-view">
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="initiative-rows">
        {initiatives.map((initiative, index) => {
          const focused = initiative.uri === focusUri;
          const pinned = pinnedUris.has(initiative.uri);
          const pending = pinPendingUri === initiative.uri;
          const ordinal = CIRCLED_ORDINALS[index] ?? `(${index + 1})`;
          const blocked = initiative.edges.some((edge) => edge.blocked);
          return (
            <li
              key={initiative.slug}
              className={cn(
                'rounded-lg border p-3',
                blocked
                  ? 'border-amber-500/70 bg-amber-500/5'
                  : 'border-border/60 bg-background',
                focused && 'ring-2 ring-foreground/40',
              )}
              data-testid="initiative-row"
              data-initiative-slug={initiative.slug}
              data-initiative-uri={initiative.uri}
              data-initiative-status={initiative.status}
              data-initiative-focused={focused ? 'true' : 'false'}
              data-initiative-blocked={blocked ? 'true' : 'false'}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <button
                  type="button"
                  onClick={() => onFocus(initiative.uri)}
                  aria-pressed={focused}
                  className="min-h-11 rounded px-1 text-left text-sm font-semibold text-foreground hover:bg-accent md:min-h-0"
                  data-testid="initiative-focus"
                >
                  <span aria-hidden="true">{ordinal} </span>
                  {initiative.slug}
                </button>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-xs font-medium',
                    initiative.status === 'active'
                      ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
                      : 'bg-muted text-muted-foreground',
                  )}
                  data-testid="initiative-status"
                  data-status={initiative.status}
                >
                  {initiative.status === 'active'
                    ? t('cockpit.initiativeStatusActive')
                    : t('cockpit.initiativeStatusClosed')}
                </span>
                <button
                  type="button"
                  onClick={() => onPin(initiative.uri)}
                  disabled={pending}
                  aria-pressed={pinned}
                  className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50 md:min-h-0"
                  data-testid="initiative-pin"
                  data-pinned={pinned ? 'true' : 'false'}
                >
                  {pinned ? t('cockpit.initiativeUnpin') : t('cockpit.initiativePin')}
                </button>
                {initiative.charter.expiresAt !== '' && (
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="initiative-expires"
                    data-expires-at={initiative.charter.expiresAt}
                  >
                    {t('cockpit.initiativeExpiresAt', { time: initiative.charter.expiresAt })}
                  </span>
                )}
              </div>

              {initiative.charter.intent !== '' && (
                <p className="mt-1 text-xs text-foreground" data-testid="initiative-intent">
                  {initiative.charter.intent}
                </p>
              )}

              <div
                className="mt-2 flex flex-wrap gap-2"
                data-testid="initiative-projects"
                aria-label={t('cockpit.initiativeProjects')}
              >
                {initiative.members.map((member) => (
                  <div
                    key={member.project}
                    className="min-w-32 rounded border border-border/60 bg-muted/30 px-2 py-1 text-xs"
                    data-testid="initiative-project-cell"
                    data-project={member.project}
                    data-tasks={member.taskRefs.length}
                    data-goals={member.goalRefs.length}
                  >
                    <span className="block font-medium text-foreground">{member.project}</span>
                    <span className="block text-muted-foreground" data-testid="initiative-project-progress">
                      {t('cockpit.initiativeTasksCount', { n: member.taskRefs.length })}
                      {' · '}
                      {t('cockpit.initiativeGoalsCount', { n: member.goalRefs.length })}
                    </span>
                    {member.liaison !== null && (
                      <span className="block truncate text-muted-foreground" title={member.liaison}>
                        {t('cockpit.initiativeLiaison', { liaison: member.liaison })}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {initiative.edges.length > 0 && (
                <ul className="mt-2 space-y-0.5" data-testid="initiative-edges">
                  {initiative.edges.map((edge) => {
                    const duration = edge.blocked
                      ? initiativeBlockedFor(edge.blockedSince, now, t)
                      : null;
                    return (
                      <li
                        key={`${edge.from}|${edge.to}|${edge.kind}`}
                        className={cn(
                          'flex flex-wrap items-center gap-x-2 text-[11px]',
                          edge.blocked
                            ? 'font-medium text-amber-700 dark:text-amber-300'
                            : 'text-muted-foreground',
                        )}
                        data-testid="initiative-edge"
                        data-edge-kind={edge.kind}
                        data-edge-from={edge.from}
                        data-edge-to={edge.to}
                        data-edge-blocked={edge.blocked ? 'true' : 'false'}
                      >
                        <span data-testid="initiative-edge-endpoints">
                          {edge.from} → {edge.to}
                        </span>
                        <span data-testid="initiative-edge-kind">
                          {EDGE_LABEL_KEYS[edge.kind] === undefined
                            ? edge.kind
                            : t(EDGE_LABEL_KEYS[edge.kind]!)}
                        </span>
                        {edge.blocked && (
                          <span data-testid="initiative-edge-blocked-for" data-blocked-since={edge.blockedSince ?? ''}>
                            {t('cockpit.initiativeBlockedFor', { duration: duration ?? '' })}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <details className="mt-2 text-xs" data-testid="initiative-charter">
                <summary className="cursor-pointer text-muted-foreground">
                  {t('cockpit.initiativeCharter')}
                </summary>
                <dl className="mt-1 space-y-0.5 text-muted-foreground">
                  <div>
                    <dt className="inline font-medium text-foreground">{t('cockpit.initiativeCharterIntent')}: </dt>
                    <dd className="inline">{initiative.charter.intent}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-foreground">{t('cockpit.initiativeCharterCompletion')}: </dt>
                    <dd className="inline">{initiative.charter.completionCriteria.join('；')}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-foreground">{t('cockpit.initiativeCharterExit')}: </dt>
                    <dd className="inline">{initiative.charter.exitConditions.join('；')}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-foreground">{t('cockpit.initiativeCharterGrant')}: </dt>
                    <dd className="inline">
                      {initiative.charter.grantScope.mayDecide.join('，')}
                      {initiative.charter.grantScope.mustEscalate.length > 0
                        ? ` · ${t('cockpit.initiativeCharterEscalate')}: ${initiative.charter.grantScope.mustEscalate.join('，')}`
                        : ''}
                    </dd>
                  </div>
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
