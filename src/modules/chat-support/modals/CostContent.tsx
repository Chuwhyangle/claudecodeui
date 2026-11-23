import { Fragment } from 'react';
import { Activity, Coins, Gauge, Layers, Sparkles, TerminalSquare, Timer } from 'lucide-react';

import type { CostCommandData, CostViewSession, TokenUsageCounts } from '@/shared/types';
import type { TurnTokenUsage } from '@/shared/turnTokenUsageType';
import { getProviderLabel } from '@/shared/utils';

/**
 * The `/cost` panel's body. Used by `CommandResultModal`; kept in its own file
 * so the modal's command dispatcher stays under the source-size ratchet.
 *
 * The panel renders the server's `data.cost` view and derives nothing: the
 * session totals, the cache hit ratio, the fresh remainder and the provider's
 * accounting statement are all computed in the providers module. One layout
 * serves every provider, so there is no provider branch here.
 */

const formatNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toLocaleString();
};

/** One rendered usage line; `hint` names a subset relationship so the value is not read as another addend. */
type UsageRow = {
  label: string;
  value: string;
  icon: typeof Activity;
  hint?: string;
  /** Stable role for the scenario surface, when a step needs to read this exact row. */
  role?: string;
};

/** Reads a reported quantity, keeping "unknown" distinct from an explicit zero. */
const readTokenQuantity = (value: unknown): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Formats the server-derived `cacheRead / input` ratio, keeping one decimal below 10%. */
const formatRatio = (ratio: number): string => {
  const percent = ratio * 100;
  const rounded = percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10;
  return `${rounded}%`;
};

/** The cache quantities one session view reported, with "not reported" kept absent. */
type CacheSegments = {
  /** The denominator the ratio and segment widths use. */
  input: number;
  /** The uncached remainder, as the server derived it. */
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  /** Whether the source reported a cache-write quantity at all (absent is not zero). */
  cacheWriteReported: boolean;
};

/**
 * Picks the segments the server already derived out of the session view.
 *
 * Returns `null` when the panel has no positive input denominator or no
 * reported cache read — the same conditions under which the server omits the
 * ratio, so a missing numerator never renders as a claimed "0% cached".
 */
const toCacheSegments = (session: CostViewSession | undefined): CacheSegments | null => {
  if (
    !session
    || session.input === undefined || session.input <= 0
    || session.cacheRead === undefined || session.fresh === undefined
  ) {
    return null;
  }
  return {
    input: session.input,
    fresh: session.fresh,
    cacheRead: session.cacheRead,
    cacheWrite: session.cacheWrite ?? 0,
    cacheWriteReported: session.cacheWrite !== undefined,
  };
};

/** Renders one usage block's known quantities only. */
const buildCountRows = (counts: TokenUsageCounts | undefined, includeTotal = false): UsageRow[] => {
  if (!counts) {
    return [];
  }

  const rows: UsageRow[] = [];
  const input = readTokenQuantity(counts.inputTokens);
  if (input !== undefined) {
    rows.push({ label: 'Input tokens', value: formatNumber(input), icon: TerminalSquare });
  }
  const cacheRead = readTokenQuantity(counts.cacheReadTokens);
  if (cacheRead !== undefined) {
    rows.push({
      label: 'Cached input tokens',
      value: formatNumber(cacheRead),
      icon: Gauge,
      hint: 'subset of input — not added again',
    });
  }
  const cacheWrite = readTokenQuantity(counts.cacheWriteTokens);
  if (cacheWrite !== undefined) {
    rows.push({
      label: 'Cached write tokens',
      value: formatNumber(cacheWrite),
      icon: Layers,
      hint: 'subset of input — not added again',
    });
  }
  const output = readTokenQuantity(counts.outputTokens);
  if (output !== undefined) {
    rows.push({ label: 'Output tokens', value: formatNumber(output), icon: Coins });
  }
  const reasoning = readTokenQuantity(counts.reasoningOutputTokens);
  if (reasoning !== undefined) {
    rows.push({
      label: 'Reasoning output tokens',
      value: formatNumber(reasoning),
      icon: Sparkles,
      hint: 'subset of output — not added again',
    });
  }
  const total = readTokenQuantity(counts.totalTokens);
  if (includeTotal && total !== undefined) {
    rows.push({ label: 'Total tokens', value: formatNumber(total), icon: Activity });
  }
  return rows;
};

/** `2m03s` — the turn's wall-clock, matching the composer chip's formatter. */
const formatTurnDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
};

/**
 * Renders the server-measured current turn as its own usage lines.
 *
 * Every value is read from `cost.turn` as reported; nothing is re-derived. An
 * optional field the server omitted (an unreported cache read, an unconfigured
 * cost) draws no row rather than a zero.
 */
const buildTurnRows = (turn: TurnTokenUsage | undefined): UsageRow[] => {
  if (!turn) {
    return [];
  }
  const rows: UsageRow[] = [
    { label: 'This turn — tokens', value: formatNumber(turn.totalTokens), icon: Activity },
    { label: 'This turn — output', value: formatNumber(turn.outputTokens), icon: Coins },
  ];
  if (turn.cacheHitRatio !== undefined) {
    rows.push({
      label: 'This turn — cache hit',
      value: `${(turn.cacheHitRatio * 100).toFixed(1)}%`,
      icon: Gauge,
      hint: 'cache read ÷ turn input',
    });
  }
  rows.push({ label: 'This turn — duration', value: formatTurnDuration(turn.elapsedMs), icon: Timer });
  if (turn.tps !== undefined) {
    rows.push({ label: 'This turn — speed', value: `${Math.round(turn.tps)} t/s`, icon: Timer });
  }
  if (turn.costUsd !== undefined) {
    rows.push({ label: 'This turn — cost', value: `$${turn.costUsd.toFixed(4)}`, icon: Coins });
  }
  return rows;
};

/** Renders the server-derived session view as usage lines. */
const buildSessionRows = (session: CostViewSession | undefined): UsageRow[] => {
  if (!session) {
    return [];
  }

  const rows: UsageRow[] = [];
  if (session.total !== undefined) {
    rows.push({ label: 'Total tokens used', value: formatNumber(session.total), icon: Activity });
  }
  if (session.cacheHitRatio !== undefined) {
    rows.push({
      label: 'Cache hit rate',
      value: formatRatio(session.cacheHitRatio),
      icon: Gauge,
      hint: 'cache read ÷ input — free, comparable across providers',
      role: 'cache-hit-ratio',
    });
  }
  if (session.input !== undefined) {
    rows.push({ label: 'Input tokens', value: formatNumber(session.input), icon: TerminalSquare });
  }
  if (session.cacheRead !== undefined) {
    rows.push({
      label: 'Cached input tokens',
      value: formatNumber(session.cacheRead),
      icon: Gauge,
      hint: 'subset of input — not added again',
    });
  }
  if (session.cacheWrite !== undefined) {
    rows.push({
      label: 'Cached write tokens',
      value: formatNumber(session.cacheWrite),
      icon: Layers,
      hint: 'subset of input — not added again',
    });
  }
  if (session.output !== undefined) {
    rows.push({ label: 'Output tokens', value: formatNumber(session.output), icon: Coins });
  }
  if (session.reasoningOutput !== undefined) {
    rows.push({
      label: 'Reasoning output tokens',
      value: formatNumber(session.reasoningOutput),
      icon: Sparkles,
      hint: 'subset of output — not added again',
    });
  }
  return rows;
};

/** One usage line. */
function UsageRowView({ row }: { row: UsageRow }) {
  const Icon = row.icon;

  return (
    <div
      data-testid="cost-usage-row"
      data-cost-role={row.role}
      data-cost-label={row.label}
      data-cost-value={row.value}
      className="flex items-center justify-between gap-4 border-b border-border/60 px-4 py-3 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">{row.label}</span>
          {row.hint && (
            <span className="block text-[11px] leading-4 text-muted-foreground">{row.hint}</span>
          )}
        </span>
      </div>
      <span className="shrink-0 font-mono text-sm font-semibold text-foreground">{row.value}</span>
    </div>
  );
}

/** Segment fills, one per cache quantity; the three must stay visually distinct. */
const CACHE_SEGMENT_CLASSES = {
  fresh: 'bg-primary',
  cacheRead: 'bg-sky-500',
  cacheWrite: 'bg-amber-500',
} as const;

/**
 * The fresh/cacheRead/cacheWrite proportion bar.
 *
 * Widths are shares of the same input total the ratio uses, so the three
 * segments and the percentage describe one reading. The server omits a cache
 * write it never received, and the bar then draws no write segment.
 */
function CacheUsageBar({ segments }: { segments: CacheSegments }) {
  const segmentShare = (value: number) =>
    segments.input > 0 ? `${(value / segments.input) * 100}%` : '0%';
  const drawn = [
    { key: 'fresh' as const, label: 'Fresh', value: segments.fresh },
    { key: 'cacheRead' as const, label: 'Cache read', value: segments.cacheRead },
    ...(segments.cacheWriteReported
      ? [{ key: 'cacheWrite' as const, label: 'Cache write', value: segments.cacheWrite }]
      : []),
  ];

  return (
    <div data-testid="cost-cache-usage-bar" className="border-b border-border/60 px-4 py-3">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {drawn.map((segment) => (
          <div
            key={segment.key}
            data-cost-segment={segment.key}
            data-cost-percent={String((segment.value / segments.input) * 100)}
            className={`h-full ${CACHE_SEGMENT_CLASSES[segment.key]}`}
            style={{ width: segmentShare(segment.value) }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {drawn.map((segment) => (
          <span key={segment.key} className="text-[11px] leading-4 text-muted-foreground">
            {segment.label} <span className="font-mono font-semibold text-foreground">{formatNumber(segment.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** The provider/model/ai-title card shared by every `/cost` reading. */
function CostMetaCard({
  provider,
  model,
  aiTitle,
  accountingNote,
}: {
  provider: string;
  model: string;
  aiTitle: string;
  accountingNote: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{provider}</p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Model</p>
          <p className="mt-1 break-all font-mono text-sm text-foreground">{model}</p>
        </div>
        {/* Under the pair it describes, and across both columns: this is a
            sentence Claude wrote, not a short identifier, so it wraps rather
            than truncates. Sessions without one render nothing instead of a
            placeholder. */}
        {aiTitle && (
          <div className="sm:col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">AI title</p>
            <p className="mt-1 break-words text-sm font-semibold text-foreground">{aiTitle}</p>
          </div>
        )}
        {/* The provider's accounting statement, across both columns: the
            cache rows above are a breakdown of input, and which quantities
            make up that breakdown differs by provider. It is the server's
            statement, not one this panel chooses. */}
        {accountingNote && (
          <div className="sm:col-span-2" data-testid="cost-cache-accounting-note">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Cache accounting
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{accountingNote}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Used by `CommandResultModal` to render the `/cost` command's server-derived view. */
export function CostContent({ data }: { data: CostCommandData }) {
  const cost = data.cost;
  const model = data.model || 'Unknown';
  const providerLabel = getProviderLabel(data.provider, data.provider || 'Unknown');
  const accountingNote = cost?.accountingNote ?? '';
  // A blank title is as absent as a missing one: the server only omits the
  // field when the transcript carries none, and an empty string in it would
  // otherwise render a labelled row saying nothing.
  const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle.trim() : '';

  const session = cost?.session;
  const context = cost?.context;
  const cacheSegments = toCacheSegments(session);

  const sections: Array<{
    title: string;
    note: string;
    rows: UsageRow[];
    cacheSegments?: CacheSegments;
  }> = [
    {
      title: 'Session cumulative',
      note: 'Whole-session spend. Cached input, cache writes and reasoning output are already inside input and output.',
      rows: buildSessionRows(session),
      ...(cacheSegments ? { cacheSegments } : {}),
    },
    {
      title: 'This turn',
      note: 'Everything since your last prompt: token spend, speed, wall-clock time, cache share and cost.',
      rows: buildTurnRows(cost?.turn),
    },
    {
      title: 'Latest request (context estimate)',
      note: 'Approximate context occupancy from the newest request; not a measured window reading.',
      rows: buildCountRows(cost?.lastRequest, true),
    },
    {
      title: 'Context window',
      note: 'Newest-turn occupancy and window capacity, independent of the cumulative total.',
      rows: [
        ...(context?.used !== undefined
          ? [{ label: 'Context used', value: formatNumber(context.used), icon: Activity }]
          : []),
        ...(context?.window !== undefined
          ? [{ label: 'Window capacity', value: formatNumber(context.window), icon: Gauge }]
          : []),
      ],
    },
  ].filter((section) => section.rows.length > 0);

  return (
    <div
      data-testid="cost-panel"
      className="scrollbar-thin h-full space-y-4 overflow-y-auto pr-1"
    >
      {sections.map((section) => (
        <div
          key={section.title}
          className="overflow-hidden rounded-2xl border border-border/70 bg-background/75"
        >
          <div className="border-b border-border/60 px-4 py-3">
            <p className="text-sm font-semibold text-foreground">{section.title}</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{section.note}</p>
          </div>
          {section.rows.map((row) => (
            <Fragment key={row.label}>
              <UsageRowView row={row} />
              {section.cacheSegments && row.role === 'cache-hit-ratio' && (
                <CacheUsageBar segments={section.cacheSegments} />
              )}
            </Fragment>
          ))}
        </div>
      ))}

      <CostMetaCard
        provider={providerLabel}
        model={model}
        aiTitle={aiTitle}
        accountingNote={accountingNote}
      />
    </div>
  );
}
