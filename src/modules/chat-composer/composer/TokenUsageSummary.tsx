import { memo } from 'react';
import { ActivityIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
  /**
   * `button` (default) is the standalone chip in the footer, which opens the
   * detailed panel itself. `inline` renders the same compact reading as plain
   * text instead, for the mobile "more" menu — there the whole row opens the
   * panel, and a button inside a menu row would nest two controls in one.
   */
  variant?: 'button' | 'inline';
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * An explicitly reported quantity, or `null` when the source reported none.
 * `readUsageNumber` collapses both cases to zero, which cannot tell an absent
 * request reading apart from a request that used nothing.
 */
const readReportedUsageNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Total tokens in a counts block, keeping "the source did not report a
 * quantity" (`null`) distinct from a reported zero. Prefers the source's own
 * total, then sums the two halves it reported.
 */
const readCountsTotal = (value: unknown): number | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const counts = value as Record<string, unknown>;
  const reportedTotal = readReportedUsageNumber(counts.totalTokens);
  if (reportedTotal !== null) {
    return reportedTotal;
  }
  const input = readReportedUsageNumber(counts.inputTokens);
  const output = readReportedUsageNumber(counts.outputTokens);
  if (input === null && output === null) {
    return null;
  }
  return (input ?? 0) + (output ?? 0);
};

/** `2m03s` — the turn's wall-clock, matching the CLI's own footer. */
const formatTurnDuration = (milliseconds: number) => {
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

/** Gateway costs are fractions of a cent, so keep four decimals below a cent. */
const formatTurnCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(4)}`);

/**
 * Rendered by chat's ChatComposer to show the session's context-window usage
 * and open the detailed token breakdown on click. Its `inline` variant is
 * rendered by ChatComposer's ComposerMobileMoreMenu, which shows the same
 * reading inside a menu row that opens the panel itself.
 *
 * The number is the newest request's occupancy for every provider. Providers
 * that can measure it put it in `contextOccupancy.used`; Codex only knows the
 * window and its rollout's newest `last_token_usage`, so that estimate is the
 * next choice. The legacy dual-meaning `used` comes last because it is the
 * session total for Codex/OpenCode and the newest request for Claude — reading
 * it first is what made one chip mean two things. Whenever the number is not a
 * measured occupancy, the chip names the scope it actually came from.
 */
function TokenUsageSummary({ usage, onClick, variant = 'button' }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const contextOccupancy =
    usage?.contextOccupancy && typeof usage.contextOccupancy === 'object'
      ? usage.contextOccupancy as Record<string, unknown>
      : null;
  const occupancyUsedTokens = readReportedUsageNumber(contextOccupancy?.used);
  const lastRequestTokens = readCountsTotal(usage?.lastRequest);
  const sessionSpendTokens = readCountsTotal(usage?.sessionSpend);
  const usedTokens = occupancyUsedTokens
    ?? lastRequestTokens
    ?? sessionSpendTokens
    ?? (readUsageNumber(usage?.used) || inputTokens + outputTokens);
  const scope: 'cumulative' | 'last-request' | null =
    occupancyUsedTokens !== null
      ? null
      : lastRequestTokens !== null
        ? 'last-request'
        : usage?.usageScope === 'session-cumulative' || sessionSpendTokens !== null
          ? 'cumulative'
          : null;
  const scopeLabel =
    scope === 'cumulative' ? 'session total' : scope === 'last-request' ? 'last request' : null;
  const title =
    scope === 'cumulative'
      ? `${usedTokens.toLocaleString()} tokens used this session (cumulative total)`
      : scope === 'last-request'
        ? `${usedTokens.toLocaleString()} tokens in the latest request (context estimate)`
        : t('chat:misc.tokensUsed', { count: usedTokens });

  // The turn block is the server's measurement of everything since the last
  // human prompt. Older transcripts carry none (the field is absent, not zero),
  // and the chip then shows exactly what it showed before.
  const turn = usage?.turn && typeof usage.turn === 'object'
    ? usage.turn as Record<string, unknown>
    : null;
  const turnTps = readReportedUsageNumber(turn?.tps) ?? 0;
  const turnElapsedMs = readReportedUsageNumber(turn?.elapsedMs) ?? 0;
  const turnCostUsd = readReportedUsageNumber(turn?.costUsd) ?? 0;
  const turnCacheHitRatio = readReportedUsageNumber(turn?.cacheHitRatio) ?? 0;
  const turnTotalTokens = readReportedUsageNumber(turn?.totalTokens) ?? 0;
  const hasTurn = turnTps > 0 || turnElapsedMs > 0 || turnCostUsd > 0;
  const turnTitle = hasTurn
    ? t('chat:misc.turnSummaryTitle', {
        tokens: turnTotalTokens.toLocaleString(),
        speed: t('chat:misc.turnSpeed', { value: Math.round(turnTps) }),
        time: formatTurnDuration(turnElapsedMs),
        cost: formatTurnCost(turnCostUsd),
      })
    : null;

  if (variant === 'inline') {
    // The row around it is the control, so this is a plain reading: no nested
    // button, and the count carries the same meaning the chip's label does.
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        title={turnTitle ?? title}
      >
        <ActivityIcon className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
        {scopeLabel && <span className="text-muted-foreground/70">{scopeLabel}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={turnTitle ?? title}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
      {scopeLabel ? (
        <span className="text-muted-foreground/70">{scopeLabel}</span>
      ) : (
        <span className="hidden text-muted-foreground/70 sm:inline">
          {t('chat:misc.tokensLabel', { count: usedTokens })}
        </span>
      )}
      {hasTurn && (
        // Wide screens only: the composer's footer already holds model, effort
        // and permission chips, and the turn reading is the first thing that
        // can go when there is no room for it.
        <span className="ml-1 hidden items-center gap-2 border-l border-border/60 pl-2 font-mono text-[11px] text-muted-foreground/80 lg:inline-flex">
          {turnTps > 0 && <span>{t('chat:misc.turnSpeed', { value: Math.round(turnTps) })}</span>}
          {turnElapsedMs > 0 && <span>{formatTurnDuration(turnElapsedMs)}</span>}
          {turnCacheHitRatio > 0 && (
            <span>{t('chat:misc.turnCacheHit', { percent: (turnCacheHitRatio * 100).toFixed(1) })}</span>
          )}
          {turnCostUsd > 0 && <span className="text-emerald-600 dark:text-emerald-400">{formatTurnCost(turnCostUsd)}</span>}
        </span>
      )}
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
