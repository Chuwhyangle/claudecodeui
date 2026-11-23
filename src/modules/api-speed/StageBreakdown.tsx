import { useTranslation } from 'react-i18next';

import type { ApiLatencyStageTimings } from '@/shared/apiLatencyType';

/** One segment of the stacked bar; `className` is the fill and the legend dot. */
type StageSegment = {
  key: string;
  label: string;
  ms: number;
  className: string;
};

/**
 * Draws one probe's stage split as a single stacked bar, with each stage's value
 * underneath.
 *
 * A plain flex row rather than an SVG: the denominators are the probe's own
 * total, so the widths are exact and there is no scale to keep in sync. A reused
 * connection contributes 0 to the connection segment and the legend says
 * "reused" instead of printing three meaningless zeroes.
 *
 * Used by `ApiSpeedPanel`.
 */
export function StageBreakdown({ timings, transport }: {
  timings: ApiLatencyStageTimings;
  transport: 'fresh' | 'reused';
}) {
  const { t } = useTranslation();
  const connectMs = (timings.dnsMs ?? 0) + (timings.tcpMs ?? 0) + (timings.tlsMs ?? 0);

  const segments: StageSegment[] = [
    {
      key: 'connect',
      label: t('apiSpeed.stageConnect', { defaultValue: 'Connect + TLS' }),
      ms: connectMs,
      className: 'bg-sky-500',
    },
    {
      key: 'upload',
      label: t('apiSpeed.stageUpload', { defaultValue: 'Upload' }),
      ms: timings.uploadMs,
      className: 'bg-violet-500',
    },
    {
      key: 'gateway',
      label: t('apiSpeed.stageGateway', { defaultValue: 'Waiting on relay' }),
      ms: timings.firstByteMs,
      className: 'bg-amber-500',
    },
    {
      key: 'download',
      label: t('apiSpeed.stageDownload', { defaultValue: 'Download' }),
      ms: timings.downloadMs,
      className: 'bg-emerald-500',
    },
  ];

  const total = Math.max(timings.totalMs, 1);

  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={segment.className}
            style={{ width: `${(segment.ms / total) * 100}%` }}
            title={`${segment.label}: ${Math.round(segment.ms)} ms`}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        {segments.map((segment) => (
          <div key={segment.key} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${segment.className}`} />
            <span className="truncate text-muted-foreground">{segment.label}</span>
            <span className="ml-auto font-mono tabular-nums">
              {segment.key === 'connect' && transport === 'reused'
                ? t('apiSpeed.reused', { defaultValue: 'reused' })
                : `${Math.round(segment.ms)} ms`}
            </span>
          </div>
        ))}
      </div>
      <div className="flex justify-between border-t border-border/50 pt-1 text-xs">
        <span className="text-muted-foreground">{t('apiSpeed.total', { defaultValue: 'Total' })}</span>
        <span className="font-mono tabular-nums">{(timings.totalMs / 1000).toFixed(2)} s</span>
      </div>
    </div>
  );
}
