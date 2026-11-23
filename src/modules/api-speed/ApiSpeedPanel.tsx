import { Activity, Gauge, RefreshCw, Upload } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, Card } from '@/shared/ui';
import type { ApiLatencyProbeResult } from '@/shared/apiLatencyType';
import { StageBreakdown } from '@/modules/api-speed/StageBreakdown';
import { useApiLatency } from '@/modules/api-speed/hooks/useApiLatency';

/** How many recent samples the percentile row summarises. */
const STATS_WINDOW = 20;

/** How many samples the trend strip draws. */
const TREND_WINDOW = 40;

/**
 * Nearest-rank percentile over a small sample set; `null` when there is nothing to
 * summarise yet, so the caller can render a dash instead of a fake zero.
 */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? null;
}

function formatMs(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

/**
 * The API-speed view: one staged breakdown of the latest probe, percentile
 * readings over the recent window, a trend strip and the sample table.
 *
 * Rendered by `WorkspaceMain` when the workspace tab is `api-speed`; the outer
 * wrapper owns the `data-workspace-view` marker, so this component carries no
 * layout chrome beyond its own scroll container.
 */
export function ApiSpeedPanel() {
  const { t } = useTranslation();
  const { series, error, isLoading, isProbing, autoProbe, setAutoProbe, probe } = useApiLatency();

  // A stable array per series keeps the percentile memo below from recomputing
  // on every unrelated render.
  const probes = useMemo(() => series?.probes ?? [], [series]);
  const latest = probes.length > 0 ? probes[probes.length - 1] : null;

  const stats = useMemo(() => {
    const window = probes.filter((item) => item.ok).slice(-STATS_WINDOW);
    const totals = window.map((item) => item.timings.totalMs);
    const gateways = window.map((item) => item.timings.firstByteMs);
    const uploads = window.filter((item) => item.mode === 'upload').map((item) => item.timings.uploadMs);
    return {
      count: window.length,
      totalP50: percentile(totals, 50),
      totalP90: percentile(totals, 90),
      gatewayP50: percentile(gateways, 50),
      gatewayP90: percentile(gateways, 90),
      uploadP50: percentile(uploads, 50),
    };
  }, [probes]);

  const trend = probes.slice(-TREND_WINDOW);
  const trendMax = Math.max(1, ...trend.map((item) => item.timings.totalMs));

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Gauge className="h-4 w-4" />
              {t('apiSpeed.title', { defaultValue: 'API speed' })}
            </h2>
            <p className="text-xs text-muted-foreground">
              {series === null
                ? t('apiSpeed.loadingTarget', { defaultValue: 'Reading the gateway configuration…' })
                : t('apiSpeed.targetLine', {
                  defaultValue: '{{host}} · model {{model}} · credential: {{source}}',
                  host: series.target.host,
                  model: series.target.model,
                  source: series.target.credentialSource
                    ?? t('apiSpeed.noCredentialShort', { defaultValue: 'none' }),
                })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={isProbing}
              onClick={() => void probe({ mode: 'ping', stream: true })}
            >
              <Activity className={`mr-1.5 h-3.5 w-3.5 ${isProbing ? 'animate-pulse' : ''}`} />
              {t('apiSpeed.probePing', { defaultValue: 'Ping' })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isProbing}
              onClick={() => void probe({ mode: 'upload', stream: false })}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t('apiSpeed.probeUpload', { defaultValue: 'Test upload (300 KB)' })}
            </Button>
            <Button
              size="sm"
              variant={autoProbe ? 'default' : 'outline'}
              onClick={() => setAutoProbe(!autoProbe)}
              aria-pressed={autoProbe}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${autoProbe ? 'animate-spin' : ''}`} />
              {autoProbe
                ? t('apiSpeed.autoOn', { defaultValue: 'Every 30 s' })
                : t('apiSpeed.autoOff', { defaultValue: 'Auto off' })}
            </Button>
          </div>
        </div>

        {series !== null && !series.target.hasCredential && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t('apiSpeed.noCredential', {
              defaultValue:
                'No gateway credential found. Set ANTHROPIC_AUTH_TOKEN in the service environment '
                + 'or in the CLI settings file.',
            })}
          </p>
        )}

        {error !== null && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <Card className="space-y-4 p-4">
          {latest === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {isLoading
                ? t('apiSpeed.loading', { defaultValue: 'Loading…' })
                : t('apiSpeed.empty', {
                  defaultValue: 'No samples yet. Press Ping to take the first measurement.',
                })}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{latest.mode === 'upload' ? 'upload' : 'ping'}</Badge>
                <Badge variant="secondary">{latest.transport}</Badge>
                <span>{new Date(latest.at).toLocaleTimeString()}</span>
                {latest.status !== null && (
                  <span className={latest.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                    HTTP {latest.status}
                  </span>
                )}
                {latest.firstTokenMs !== null && (
                  <span>
                    {t('apiSpeed.firstToken', { defaultValue: 'first token' })} {formatMs(latest.firstTokenMs)}
                  </span>
                )}
              </div>
              {/* A probe that reached the gateway but failed carries its own reason;
                  it is a property of that sample, not a banner over the whole page. */}
              {latest.error !== null && (
                <p className="text-xs text-destructive">{latest.error}</p>
              )}
              <StageBreakdown timings={latest.timings} transport={latest.transport} />
            </>
          )}
        </Card>

        {stats.count > 0 && (
          <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <Stat
              label={t('apiSpeed.statTotalP50', { defaultValue: 'Total p50' })}
              value={formatMs(stats.totalP50)}
            />
            <Stat
              label={t('apiSpeed.statTotalP90', { defaultValue: 'Total p90' })}
              value={formatMs(stats.totalP90)}
            />
            <Stat
              label={t('apiSpeed.statGatewayP50', { defaultValue: 'Relay p50' })}
              value={formatMs(stats.gatewayP50)}
            />
            <Stat
              label={t('apiSpeed.statUploadP50', { defaultValue: 'Upload p50' })}
              value={stats.uploadP50 === null ? '—' : formatMs(stats.uploadP50)}
            />
          </Card>
        )}

        {trend.length > 1 && (
          <Card className="space-y-2 p-4">
            <div className="text-xs text-muted-foreground">
              {t('apiSpeed.trend', {
                defaultValue: 'Total time, last {{count}} samples',
                count: trend.length,
              })}
            </div>
            <div className="flex h-16 items-end gap-1">
              {trend.map((item) => (
                <div
                  key={item.id}
                  className={`min-w-0 flex-1 rounded-t-sm ${item.ok ? 'bg-primary/70' : 'bg-destructive/70'}`}
                  style={{ height: `${Math.max(4, (item.timings.totalMs / trendMax) * 100)}%` }}
                  title={`${new Date(item.at).toLocaleTimeString()} · ${formatMs(item.timings.totalMs)}`}
                />
              ))}
            </div>
          </Card>
        )}

        {probes.length > 0 && (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t('apiSpeed.colTime', { defaultValue: 'Time' })}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('apiSpeed.colMode', { defaultValue: 'Mode' })}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('apiSpeed.colLink', { defaultValue: 'Link' })}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('apiSpeed.stageConnect', { defaultValue: 'Connect + TLS' })}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('apiSpeed.stageUpload', { defaultValue: 'Upload' })}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('apiSpeed.stageGateway', { defaultValue: 'Waiting on relay' })}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('apiSpeed.total', { defaultValue: 'Total' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...probes].reverse().slice(0, 12).map((item) => (
                    <ProbeRow key={item.id} probe={item} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

/** One row of the sample table; split out so the table body stays readable above. */
function ProbeRow({ probe }: { probe: ApiLatencyProbeResult }) {
  const connect = (probe.timings.dnsMs ?? 0) + (probe.timings.tcpMs ?? 0) + (probe.timings.tlsMs ?? 0);
  return (
    <tr className="border-t border-border/50">
      <td className="px-3 py-1.5 font-mono tabular-nums">{new Date(probe.at).toLocaleTimeString()}</td>
      <td className="px-3 py-1.5">{probe.mode}</td>
      <td className="px-3 py-1.5">{probe.transport}</td>
      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
        {probe.transport === 'reused' ? '—' : formatMs(connect)}
      </td>
      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{formatMs(probe.timings.uploadMs)}</td>
      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{formatMs(probe.timings.firstByteMs)}</td>
      <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${probe.ok ? '' : 'text-destructive'}`}>
        {formatMs(probe.timings.totalMs)}
      </td>
    </tr>
  );
}

/** One number in the percentile card. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-lg tabular-nums">{value}</div>
    </div>
  );
}
