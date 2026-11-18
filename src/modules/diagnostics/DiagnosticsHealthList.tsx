import { useTranslation } from 'react-i18next';

import type { DiagnosticsFeature, DiagnosticsFeatureState } from '@/shared/types';
import { isLogDrawerAvailable, openLogDrawer } from '@/shared/ports/log-drawer.port';
import { cn } from '@/shared/utils';

/**
 * The Settings → Diagnostics health cards.
 *
 * One card per registered feature: its name, a state pill, the configuration
 * source, the last success and the most recent failure, plus the problems the
 * settings reader reported. It renders whatever the controller's snapshot holds
 * and owns no decision.
 *
 * Consumers: `DiagnosticsSettingsTab` and the Settings-tab criterion.
 */

/** A known feature id's localized label; an unknown id falls back to the server's label. */
const FEATURE_LABEL_KEYS: Record<string, string | undefined> = {
  'reply-suggestions': 'diagnostics.features.replySuggestions',
};

/** The pill copy for each state. */
const STATE_LABEL_KEYS: Record<DiagnosticsFeatureState, string> = {
  off: 'diagnostics.state.off',
  misconfigured: 'diagnostics.state.misconfigured',
  ready: 'diagnostics.state.ready',
  degraded: 'diagnostics.state.degraded',
  ok: 'diagnostics.state.ok',
};

/** The pill's tone: configuration and health are visually distinct. */
const STATE_TONE: Record<DiagnosticsFeatureState, string> = {
  off: 'bg-muted text-muted-foreground',
  misconfigured: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  ready: 'bg-green-500/10 text-green-600 dark:text-green-400',
  degraded: 'bg-red-500/10 text-red-600 dark:text-red-400',
  ok: 'bg-green-500/10 text-green-600 dark:text-green-400',
};

/** The feature ids the log window publishes as source tabs. */
const KNOWN_LOG_SOURCES: readonly string[] = ['server', 'reply-suggestions', 'sessions', 'voice', 'other'];

type DiagnosticsHealthListProps = {
  features: DiagnosticsFeature[];
};

/** The one-line failure summary the card shows; correlation facts only, never a body. */
function failureSummary(failure: NonNullable<DiagnosticsFeature['lastFailure']>): string {
  const status = failure.httpStatus === null ? '' : ` · HTTP ${failure.httpStatus}`;
  return `${failure.category}${status} · ${failure.at}`;
}

export default function DiagnosticsHealthList({ features }: DiagnosticsHealthListProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  // A card may open the log drawer only when the page mounted one. The reading
  // is taken per render; the root host mounts before any card can be clicked.
  const canViewLogs = isLogDrawerAvailable();

  return (
    <section data-slot="diagnostics-health" className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">{t('diagnostics.featuresTitle')}</h3>
      {features.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('diagnostics.featuresEmpty')}</p>
      ) : (
        <ul className="space-y-3">
          {features.map((feature) => {
            const labelKey = FEATURE_LABEL_KEYS[feature.id];
            return (
              <li
                key={feature.id}
                data-diagnostics-feature={feature.id}
                className="rounded-xl border border-border bg-card/50 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {labelKey === undefined ? feature.label : t(labelKey)}
                  </span>
                  <span className="flex items-center gap-2">
                    {/* A misconfigured feature reads "配置不完整", not "已关闭": the
                        effective switch is off, but the person asked for it, so the
                        disabled chip would contradict the state pill. */}
                    {feature.state !== 'misconfigured' && (
                      <span className="text-xs text-muted-foreground">
                        {feature.enabled ? t('diagnostics.enabled') : t('diagnostics.disabled')}
                      </span>
                    )}
                    <span
                      data-diagnostics-state={feature.state}
                      className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATE_TONE[feature.state])}
                    >
                      {t(STATE_LABEL_KEYS[feature.state])}
                    </span>
                  </span>
                </div>
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">{t('diagnostics.configLabel')}</dt>
                    <dd className="break-all font-mono text-foreground">
                      {feature.configSource ?? t('diagnostics.defaultSource')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('diagnostics.lastSuccessLabel')}</dt>
                    <dd className="text-foreground">{feature.lastSuccessAt ?? t('diagnostics.never')}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">{t('diagnostics.lastFailureLabel')}</dt>
                    <dd className="break-all text-foreground">
                      {feature.lastFailure === null ? t('diagnostics.none') : failureSummary(feature.lastFailure)}
                    </dd>
                  </div>
                </dl>
                {feature.problems.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs font-medium text-muted-foreground">{t('diagnostics.problemsLabel')}</div>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-foreground">
                      {feature.problems.map((problem) => <li key={problem}>{problem}</li>)}
                    </ul>
                  </div>
                )}
                {canViewLogs && (
                  <button
                    type="button"
                    data-action="view-logs"
                    onClick={() => {
                      const failure = feature.lastFailure;
                      const failureAt = failure === null ? Number.NaN : Date.parse(failure.at);
                      openLogDrawer({
                        ...(KNOWN_LOG_SOURCES.includes(feature.id) ? { source: feature.id } : {}),
                        feature: feature.id,
                        ...(failure !== null && failure.requestId !== ''
                          ? { requestId: failure.requestId }
                          : {}),
                        ...(Number.isNaN(failureAt)
                          ? {}
                          : { since: new Date(failureAt - 60_000).toISOString() }),
                      });
                    }}
                    className="mt-3 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
                  >
                    {tCommon('logDrawer.viewLogs')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
