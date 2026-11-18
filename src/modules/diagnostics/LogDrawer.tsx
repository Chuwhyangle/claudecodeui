import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { LogLineLevel } from '@/shared/types';
import { cn } from '@/shared/utils';
import type { LogDrawerSnapshot } from '@/modules/diagnostics/logDrawerController';

/**
 * The log drawer's presentation: a right-hand panel on a wide screen (the chat
 * stays visible behind it, so it is NOT a modal) and a full-screen sheet on a
 * phone. It renders a controller snapshot and forwards events; every rule —
 * when to read, what to filter, whether to follow — lives in the controller.
 *
 * The retention note is part of the contract, not decoration: the window is the
 * current process's memory only, and the drawer must not pretend otherwise.
 *
 * Consumers: `LogDrawerHost` (the only renderer) and the drawer criterion.
 */

export type LogDrawerActions = {
  onClose: () => void;
  onSource: (source: string | null) => void;
  onLevel: (level: LogLineLevel | null) => void;
  onSearch: (search: string) => void;
  onFollow: (follow: boolean) => void;
  onLoadEarlier: () => void;
  onCopy: () => void;
  onRefresh: () => void;
};

type LogDrawerProps = {
  snapshot: LogDrawerSnapshot;
  actions: LogDrawerActions;
};

/** Source tabs, with the localized label key for each known id. */
const SOURCE_LABEL_KEYS: Record<string, string> = {
  '__all__': 'logDrawer.sources.all',
  server: 'logDrawer.sources.server',
  'reply-suggestions': 'logDrawer.sources.replySuggestions',
  sessions: 'logDrawer.sources.sessions',
  voice: 'logDrawer.sources.voice',
  other: 'logDrawer.sources.other',
};

/** The severity filter's options. */
const LEVEL_LABEL_KEYS: Record<string, string> = {
  all: 'logDrawer.levels.all',
  info: 'logDrawer.levels.info',
  warn: 'logDrawer.levels.warn',
  error: 'logDrawer.levels.error',
};

const LEVEL_TONE: Record<LogLineLevel, string> = {
  info: 'text-muted-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

export default function LogDrawer({ snapshot, actions }: LogDrawerProps) {
  const { t } = useTranslation('common');
  const listRef = useRef<HTMLDivElement | null>(null);

  // Escape closes from anywhere in the drawer, matching the other dismissible
  // surfaces. The drawer is the only mounted copy while open, so a document
  // listener cannot leak past its lifetime.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        actions.onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [actions]);

  // Only a followed drawer chases the newest line; pausing leaves the reading
  // exactly where the person scrolled to.
  useEffect(() => {
    if (!snapshot.follow) return;
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [snapshot.follow, snapshot.visibleLines.length]);

  const sourceIds = ['__all__', ...snapshot.sources.map((source) => source.id)];
  const copyLabel = snapshot.copyState === 'copying'
    ? t('logDrawer.copying')
    : t('logDrawer.copyBundle');

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={t('logDrawer.title')}
      data-slot="log-drawer"
      className={cn(
        'fixed inset-y-0 right-0 z-[90] flex w-full max-w-md flex-col border-l border-border bg-background shadow-xl',
        // Phone: the same drawer becomes a full-screen sheet.
        'max-[480px]:inset-0 max-[480px]:h-full max-[480px]:max-w-none',
        'pointer-coarse:inset-0 pointer-coarse:h-full pointer-coarse:max-w-none',
      )}
    >
      <header className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('logDrawer.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('logDrawer.retentionNote', { count: snapshot.window?.maxLines ?? 0 })}
          </p>
        </div>
        <button
          type="button"
          data-action="close"
          aria-label={t('logDrawer.close')}
          onClick={actions.onClose}
          className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent"
        >
          {t('logDrawer.close')}
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <div role="tablist" aria-label={t('logDrawer.sourcesLabel')} className="flex flex-wrap gap-1">
          {sourceIds.map((id) => {
            const selected = id === '__all__' ? snapshot.source === null : snapshot.source === id;
            const label = t(SOURCE_LABEL_KEYS[id] ?? 'logDrawer.sources.other');
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-log-source={id}
                onClick={() => actions.onSource(id === '__all__' ? null : id)}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-xs transition-colors',
                  selected ? 'bg-foreground text-background' : 'hover:bg-accent',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          {t('logDrawer.levelLabel')}
          <select
            data-slot="log-level-filter"
            value={snapshot.level ?? 'all'}
            onChange={(event) => actions.onLevel(event.target.value === 'all' ? null : event.target.value as LogLineLevel)}
            className="rounded border bg-background px-1 py-0.5 text-xs"
          >
            {Object.entries(LEVEL_LABEL_KEYS).map(([value, key]) => (
              <option key={value} value={value}>{t(key)}</option>
            ))}
          </select>
        </label>

        <input
          type="search"
          data-slot="log-search"
          value={snapshot.search}
          placeholder={t('logDrawer.searchPlaceholder')}
          onChange={(event) => actions.onSearch(event.target.value)}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
        />

        <button
          type="button"
          data-action="follow"
          aria-pressed={snapshot.follow}
          onClick={() => actions.onFollow(!snapshot.follow)}
          className={cn('rounded border px-2 py-1 text-xs', snapshot.follow ? 'bg-accent' : '')}
        >
          {snapshot.follow ? t('logDrawer.follow') : t('logDrawer.followPaused')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <button
          type="button"
          data-action="refresh"
          onClick={actions.onRefresh}
          disabled={snapshot.loading}
          className="rounded border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
        >
          {t('logDrawer.refresh')}
        </button>
        <button
          type="button"
          data-action="load-earlier"
          onClick={actions.onLoadEarlier}
          disabled={!snapshot.canLoadEarlier}
          className="rounded border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
        >
          {t('logDrawer.loadEarlier')}
        </button>
        <button
          type="button"
          data-action="copy-bundle"
          onClick={actions.onCopy}
          disabled={snapshot.copyState === 'copying'}
          className="rounded border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
        >
          {copyLabel}
        </button>
        {snapshot.copyState === 'copied' && (
          <span role="status" data-log-copy="copied" className="text-xs text-green-600 dark:text-green-400">
            {t('logDrawer.copied')}
          </span>
        )}
        {snapshot.copyState === 'failed' && (
          <span role="alert" data-log-copy="failed" className="text-xs text-red-600 dark:text-red-400">
            {t('logDrawer.copyFailed')}
          </span>
        )}
        {snapshot.truncated && (
          <span data-log-truncated="true" className="text-xs text-muted-foreground">
            {t('logDrawer.truncatedNote', { count: snapshot.window?.maxLines ?? 0 })}
          </span>
        )}
      </div>

      {snapshot.error !== null && (
        <p role="alert" data-log-error="true" className="border-b border-border p-2 text-xs text-red-600 dark:text-red-400">
          {t('logDrawer.error')} <span className="font-mono">{snapshot.error}</span>
        </p>
      )}

      <div
        ref={listRef}
        data-slot="log-lines"
        className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-xs"
        onScroll={(event) => {
          if (event.currentTarget.scrollTop === 0 && snapshot.follow) actions.onFollow(false);
        }}
      >
        {snapshot.visibleLines.length === 0 ? (
          <p data-log-empty="true" className="p-2 text-muted-foreground">
            {t('logDrawer.empty')}
          </p>
        ) : (
          <ol className="space-y-1">
            {snapshot.visibleLines.map((line, index) => (
              <li
                key={`${line.at}-${index}`}
                data-log-line="true"
                data-level={line.level}
                data-source={line.source}
                className="whitespace-pre-wrap break-all"
              >
                <span className="text-muted-foreground">{line.at}</span>{' '}
                <span className={LEVEL_TONE[line.level]}>{line.level.toUpperCase()}</span>{' '}
                <span className="text-muted-foreground">[{line.source}]</span>{' '}
                <span className="text-foreground">{line.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
