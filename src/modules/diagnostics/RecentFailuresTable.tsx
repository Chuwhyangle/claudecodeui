import { useTranslation } from 'react-i18next';

import type { DiagnosticsFailure } from '@/shared/types';

/**
 * The Settings → Diagnostics recent-failures table.
 *
 * Desktop renders one row per failure: time, feature, error category, upstream
 * status, duration and request id. The narrow viewport renders the same facts as
 * stacked cards (a six-column table cannot be read on a phone).
 *
 * Consumers: `DiagnosticsSettingsTab` and the Settings-tab criterion.
 */

type RecentFailuresTableProps = {
  failures: DiagnosticsFailure[];
};

/** The upstream status column; `null` means the failure never got an HTTP answer. */
function statusText(failure: DiagnosticsFailure, noneLabel: string): string {
  return failure.httpStatus === null ? noneLabel : String(failure.httpStatus);
}

export default function RecentFailuresTable({ failures }: RecentFailuresTableProps) {
  const { t } = useTranslation('settings');

  return (
    <section data-slot="diagnostics-recent-failures" className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">{t('diagnostics.failuresTitle')}</h3>
      {failures.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('diagnostics.failuresEmpty')}</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-border sm:block">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('diagnostics.table.time')}</th>
                  <th className="px-3 py-2 font-medium">{t('diagnostics.table.feature')}</th>
                  <th className="px-3 py-2 font-medium">{t('diagnostics.table.category')}</th>
                  <th className="px-3 py-2 font-medium">{t('diagnostics.table.httpStatus')}</th>
                  <th className="px-3 py-2 font-medium">{t('diagnostics.table.duration')}</th>
                  <th className="px-3 py-2 font-medium">{t('diagnostics.table.requestId')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {failures.map((failure) => (
                  <tr key={`${failure.featureId}:${failure.requestId}:${failure.at}`}>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{failure.at}</td>
                    <td className="px-3 py-2">{failure.feature}</td>
                    <td className="px-3 py-2 font-mono">{failure.category}</td>
                    <td className="px-3 py-2 font-mono">{statusText(failure, t('diagnostics.none'))}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono">{failure.durationMs} ms</td>
                    <td className="px-3 py-2 font-mono">{failure.requestId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 sm:hidden">
            {failures.map((failure) => (
              <li
                key={`${failure.featureId}:${failure.requestId}:${failure.at}`}
                className="rounded-xl border border-border bg-card/50 p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{failure.feature}</span>
                  <span className="font-mono text-muted-foreground">{failure.at}</span>
                </div>
                <dl className="mt-2 space-y-1">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t('diagnostics.table.category')}</dt>
                    <dd className="font-mono text-foreground">{failure.category}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t('diagnostics.table.httpStatus')}</dt>
                    <dd className="font-mono text-foreground">{statusText(failure, t('diagnostics.none'))}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t('diagnostics.table.duration')}</dt>
                    <dd className="font-mono text-foreground">{failure.durationMs} ms</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t('diagnostics.table.requestId')}</dt>
                    <dd className="break-all font-mono text-foreground">{failure.requestId}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
