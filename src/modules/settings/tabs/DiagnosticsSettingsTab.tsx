import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DiagnosticsHealthList,
  RecentFailuresTable,
  useDiagnostics,
  type DiagnosticsApi,
} from '@/modules/diagnostics';
import { isLogDrawerAvailable, openLogDrawer } from '@/shared/ports/log-drawer.port';
import { Button } from '@/shared/ui';

/**
 * Settings → Diagnostics & Logs: the low-frequency operator view that answers
 * "is it broken now, why, and when did it last work" without reading raw logs.
 *
 * It composes the diagnostics module's health cards, recent-failures table and
 * copy action, and owns no rule itself (the controller does). It is reachable
 * from the Settings sidebar only — deliberately not a first-class navigation
 * entry.
 *
 * Consumers: `Settings.tsx` (the `diagnostics` tab body) and the Settings-tab
 * criterion, which injects a fake `api` and clipboard writer.
 */
type DiagnosticsSettingsTabProps = {
  /** Test seam: defaults to the shared API client's diagnostics group. */
  api?: DiagnosticsApi;
  /** Test seam: defaults to `navigator.clipboard.writeText`. */
  writeClipboard?: (text: string) => Promise<void>;
  /** Test seam: how many recent failures to ask for. */
  recentFailuresLimit?: number;
};

/** Rendered by Settings for the "diagnostics" tab. */
export default function DiagnosticsSettingsTab({
  api,
  writeClipboard,
  recentFailuresLimit,
}: DiagnosticsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { snapshot, refresh, copyBundle } = useDiagnostics({
    ...(api === undefined ? {} : { api }),
    ...(writeClipboard === undefined ? {} : { writeClipboard }),
    ...(recentFailuresLimit === undefined ? {} : { recentFailuresLimit }),
  });
  const failuresRef = useRef<HTMLDivElement | null>(null);
  // The page-level entry opens every source; each health card can open its own
  // feature pre-filtered. Both hide when no drawer host is mounted.
  const canViewLogs = isLogDrawerAvailable();

  const copyLabel = snapshot.copyState === 'copying'
    ? t('diagnostics.copy.copying')
    : t('diagnostics.copy.button');

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">{t('diagnostics.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('diagnostics.description')}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={refresh} disabled={snapshot.loading}>
          {snapshot.loading ? t('diagnostics.loading') : t('diagnostics.refresh')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={copyBundle}
          disabled={snapshot.copyState === 'copying'}
        >
          {copyLabel}
        </Button>
        {canViewLogs && (
          <Button variant="outline" size="sm" data-action="view-logs" onClick={() => openLogDrawer({})}>
            {tCommon('logDrawer.viewLogs')}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">{t('diagnostics.copy.hint')}</span>
      </div>

      {snapshot.copyState === 'copied' && (
        <p role="status" data-diagnostics-copy="copied" className="text-xs text-green-600 dark:text-green-400">
          {t('diagnostics.copy.copied')}
        </p>
      )}
      {snapshot.copyState === 'failed' && (
        <p role="alert" data-diagnostics-copy="failed" className="text-xs text-red-600 dark:text-red-400">
          {t('diagnostics.copy.failed')}
        </p>
      )}

      {snapshot.error !== null && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400"
        >
          <p>
            {t('diagnostics.error')}{' '}
            <span className="font-mono text-xs">{snapshot.error}</span>
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={refresh}>
            {t('diagnostics.retry')}
          </Button>
        </div>
      )}

      {snapshot.loading && snapshot.features.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('diagnostics.loading')}</p>
      ) : (
        <DiagnosticsHealthList features={snapshot.features} />
      )}

      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => failuresRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}
        >
          {t('diagnostics.viewRecentFailures')}
        </Button>
      </div>

      <div ref={failuresRef}>
        <RecentFailuresTable failures={snapshot.failures} />
      </div>
    </div>
  );
}
