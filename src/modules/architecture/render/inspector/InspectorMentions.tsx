/**
 * The inspector's mention reading: one transcript-hit row and the five-state
 * mention section. Extracted from `ArchitectureInspector` so the inspector's
 * entity and relation pages share one wording without carrying the row markup.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MENTION_HIT_LIMIT,
  type useMentions,
  type ArchitectureMentionHit,
} from '@/modules/architecture/hooks/useMentions';
import { formatAbsoluteTime, formatRelativeTime } from '@/shared/utils';

/** One transcript hit row: a TYPE badge, relative time, and the excerpt with the name marked. */
function MentionRow({
  hit,
  name,
  locale,
  onLocate,
  locateLabel,
}: {
  readonly hit: ArchitectureMentionHit;
  readonly name: string;
  readonly locale: string;
  readonly onLocate: () => void;
  readonly locateLabel: string;
}) {
  const { t } = useTranslation();
  // The badge says WHAT the row is, not who spoke: a Read-tool hit is not an
  // assistant message, and calling it one was half the reported confusion.
  const badgeKey = hit.kind === 'tool_result' ? 'tool' : hit.kind === 'tool_use' ? 'tool-file' : 'message';
  const badgeLabel = hit.kind === 'tool_result'
    ? t('architecture.mentions.roleTool', { defaultValue: 'Tool output' })
    : hit.kind === 'tool_use'
      ? t('architecture.copyFix.mentionBadgeToolFile', {
          defaultValue: 'Tool: {{tool}} file',
          tool: hit.toolName ?? t('architecture.copyFix.mentionBadgeToolUnknown', { defaultValue: 'file' }),
        })
      : t('architecture.copyFix.mentionBadgeMessage', { defaultValue: 'Message' });
  const fileOnly = hit.match === 'file';

  // Highlight every occurrence of the name in the excerpt. The split is
  // case-insensitive and keeps the original text, so a path hit highlights the
  // path exactly as the server excerpted it.
  const segments = useMemo(() => {
    if (name === '') return [{ text: hit.excerpt, marked: false }];
    const lower = hit.excerpt.toLowerCase();
    const needle = name.toLowerCase();
    const parts: { text: string; marked: boolean }[] = [];
    let from = 0;
    let index = lower.indexOf(needle);
    while (index !== -1) {
      if (index > from) parts.push({ text: hit.excerpt.slice(from, index), marked: false });
      parts.push({ text: hit.excerpt.slice(index, index + name.length), marked: true });
      from = index + name.length;
      index = lower.indexOf(needle, from);
    }
    if (from < hit.excerpt.length) parts.push({ text: hit.excerpt.slice(from), marked: false });
    return parts;
  }, [hit.excerpt, name]);

  return (
    <li>
      <button
        type="button"
        onClick={onLocate}
        aria-label={locateLabel}
        data-architecture-mention={hit.messageId}
        data-architecture-mention-role={hit.role ?? (hit.kind === 'tool_result' ? 'tool' : 'assistant')}
        data-architecture-mention-type={badgeKey}
        data-architecture-mention-match={hit.match ?? 'name'}
        className="flex w-full flex-col items-start gap-0.5 rounded px-1 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span className="flex items-center gap-1.5 text-[10px] font-medium">
          <span
            data-architecture-mention-badge={badgeKey}
            className="rounded bg-muted px-1 py-0.5 text-muted-foreground"
          >
            {badgeLabel}
          </span>
          <time
            dateTime={hit.at}
            title={formatAbsoluteTime(hit.at, locale)}
            className="text-muted-foreground"
          >
            {formatRelativeTime(hit.at, locale)}
          </time>
        </span>
        {fileOnly && (
          <span
            data-architecture-mention-file-only="true"
            className="text-[10px] italic text-muted-foreground"
          >
            {t('architecture.copyFix.mentionFileOnly', { defaultValue: 'mentioned the file, not the name' })}
          </span>
        )}
        <span className="line-clamp-2 text-[11px] text-foreground">
          {segments.map((segment, index) => (segment.marked ? (
            <mark
              // The excerpt is ordered and immutable; its index is a stable key.
              key={index}
              data-architecture-mention-mark="true"
              className="rounded bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30"
            >
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          )))}
        </span>
      </button>
    </li>
  );
}

/**
 * The inspector's mention reading: its five states (loading, empty, error,
 * truncated, ambiguous) and the hit list. Shared by the entity's sessions page
 * and the relation's co-mentions so the two can never drift in wording.
 */
export function MentionsSection({
  view,
  name,
  distance,
  truncated,
  ambiguousCount,
  locale,
  onRetry,
  onLocate,
}: {
  readonly view: ReturnType<typeof useMentions>['view'];
  readonly name: string;
  readonly distance: number | null;
  readonly truncated: boolean;
  /** How many same-named entities exist, or `null` when the name is unambiguous. */
  readonly ambiguousCount: number | null;
  readonly locale: string;
  readonly onRetry: () => void;
  readonly onLocate: (hit: ArchitectureMentionHit) => void;
}) {
  const { t } = useTranslation();

  if (view.status === 'idle') return null;
  if (view.status === 'loading') {
    return (
      <div
        data-architecture-mentions-loading="true"
        aria-busy="true"
        className="flex flex-col gap-1"
      >
        {[0, 1, 2].map((row) => (
          <span
            key={row}
            data-architecture-mentions-skeleton="true"
            className="h-6 animate-pulse rounded bg-muted"
          />
        ))}
      </div>
    );
  }
  if (view.status === 'error') {
    return (
      <div data-architecture-mentions-error="true" className="flex flex-col gap-1">
        <p role="alert" className="text-[11px] text-destructive">
          {t('architecture.mentions.error', { defaultValue: 'The mentions could not be loaded.' })}
        </p>
        <button
          type="button"
          onClick={onRetry}
          data-architecture-mentions-retry="true"
          className="self-start rounded border border-border px-2 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.mentions.retry', { defaultValue: 'Retry' })}
        </button>
      </div>
    );
  }

  const hits = view.result.edge?.coMentions ?? view.result.mentions[0]?.hits ?? [];
  const ambiguousEntity = view.result.mentions[0];

  return (
    <div className="flex flex-col gap-1" data-architecture-mentions="true">
      {ambiguousEntity?.ambiguous === true && ambiguousCount !== null && (
        <p
          role="note"
          data-architecture-mentions-ambiguous={ambiguousCount}
          className="rounded border border-border/60 bg-muted/50 px-1.5 py-1 text-[10px] text-muted-foreground"
        >
          {t('architecture.mentions.ambiguous', {
            defaultValue: 'The name {{name}} matches {{count}} entities, so a hit may point at any of them.',
            name,
            count: ambiguousCount,
          })}
        </p>
      )}
      {truncated && (
        <p
          data-architecture-mentions-truncated="true"
          className="text-[10px] text-muted-foreground"
        >
          {t('architecture.mentions.truncated', {
            defaultValue: 'Showing only the first {{count}}.',
            count: MENTION_HIT_LIMIT,
          })}
        </p>
      )}
      {hits.length === 0 ? (
        <p data-architecture-mentions-empty="true" className="text-[11px] text-muted-foreground">
          {t('architecture.mentions.empty', {
            defaultValue:
              'The conversation never names it directly. It is in the graph because it is {{count}} hop(s) from the nearest mention.',
            count: distance ?? 1,
          })}
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-architecture-mentions-list="true">
          {hits.map((hit) => (
            <MentionRow
              key={`${hit.messageId}:${hit.excerpt.slice(0, 16)}`}
              hit={hit}
              name={name}
              locale={locale}
              locateLabel={t('architecture.mentions.locate', { defaultValue: 'Locate this message' })}
              onLocate={() => onLocate(hit)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The tool-output opt-in, shared by both inspector shapes. */
export function ToolResultsToggle({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-architecture-include-tool-results="true"
      />
      {t('architecture.mentions.includeToolResults', { defaultValue: 'Include tool output' })}
    </label>
  );
}
