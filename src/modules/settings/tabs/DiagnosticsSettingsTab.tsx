import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DiagnosticsHealthList,
  RecentFailuresTable,
  useDiagnostics,
  type DiagnosticsApi,
} from '@/modules/diagnostics';
import SettingsToggle from '@/modules/settings/ui/SettingsToggle';
import { api as sharedApi } from '@/shared/api';
import { isLogDrawerAvailable, openLogDrawer } from '@/shared/ports/log-drawer.port';
import { Button } from '@/shared/ui';

/**
 * The reply-suggestions debug-log seams the page needs. Typed structurally so a criterion can
 * inject a fake and the shared client's `replySuggestions` group satisfies it unchanged.
 */
export type ReplySuggestionsDebugLogApi = {
  status: () => Promise<{ debugLog?: boolean } | null>;
  setDebugLog: (enabled: boolean) => Promise<boolean>;
};

/** The fixed local path the warning names; there is no path knob to configure. */
const DEBUG_LOG_PATH = '~/.cloudpit/reply-suggestions-debug.jsonl';

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
  /** Test seam: the reply-suggestions debug-log switch; defaults to the shared API client. */
  replySuggestionsApi?: ReplySuggestionsDebugLogApi;
};

/** Rendered by Settings for the "diagnostics" tab. */
export default function DiagnosticsSettingsTab({
  api,
  writeClipboard,
  recentFailuresLimit,
  replySuggestionsApi,
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

  // The OPT-IN debug-ledger switch. `null` means the initial `/status` read is still in
  // flight; the toggle is disabled until it settles so a press cannot race that read.
  const debugLogApi = replySuggestionsApi ?? sharedApi.replySuggestions;
  const [debugLog, setDebugLog] = useState<boolean | null>(null);
  const [debugLogSaving, setDebugLogSaving] = useState(false);
  const [debugLogError, setDebugLogError] = useState<string | null>(null);
  const debugLogHintId = 'diagnostics-debug-log-hint';

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const reading = await debugLogApi.status();
        if (alive) setDebugLog(reading?.debugLog === true);
      } catch {
        // A refused status reads as OFF, the same fail-closed reading the composer uses.
        if (alive) setDebugLog(false);
      }
    })();
    return () => {
      alive = false;
    };
    // The api object is stable for the page's lifetime; the switch is loaded once per seam.
  }, [debugLogApi]);

  const toggleDebugLog = (next: boolean): void => {
    const previous = debugLog === true;
    setDebugLogSaving(true);
    setDebugLogError(null);
    void (async () => {
      try {
        const persisted = await debugLogApi.setDebugLog(next);
        setDebugLog(persisted);
      } catch {
        // Roll back the drawn value and say so; the server's file was not changed.
        setDebugLog(previous);
        setDebugLogError(t('diagnostics.debugLog.saveFailed'));
      } finally {
        setDebugLogSaving(false);
      }
    })();
  };

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

      {/*
        The reply-suggestions OPT-IN debug ledger. It is a local-only debugging aid, so the
        warning is INLINE (always visible, not a confirm dialog), the path is spelled out, and
        there is deliberately no "clear log" action — rotation is the only retention policy.
      */}
      <section
        data-slot="diagnostics-debug-log"
        className="rounded-xl border border-border bg-card/40 p-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-foreground">{t('diagnostics.debugLog.title')}</h3>
            <p id={debugLogHintId} className="text-xs text-muted-foreground">
              {t('diagnostics.debugLog.description')}{' '}
              <code className="font-mono text-[11px]">{DEBUG_LOG_PATH}</code>
            </p>
          </div>
          <SettingsToggle
            checked={debugLog === true}
            onChange={toggleDebugLog}
            ariaLabel={t('diagnostics.debugLog.label')}
            disabled={debugLog === null || debugLogSaving}
            describedBy={debugLogHintId}
          />
        </div>
        {debugLogError !== null && (
          <p role="alert" data-diagnostics-debug-log="failed" className="mt-2 text-xs text-red-600 dark:text-red-400">
            {debugLogError}
          </p>
        )}
      </section>

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
