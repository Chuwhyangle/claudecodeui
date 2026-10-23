import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ArchitectureCurationHiddenEdge,
  ArchitectureCurationItem,
  ArchitectureCurationState,
} from '@/modules/architecture/curationStore';
import { TOUCH_TARGET_STYLE, useTouchLayout } from '@/modules/architecture/hooks/useTouchLayout';

/** The three pages the manager offers, in the task's order. */
export type ArchitectureCurationPage = 'pins' | 'excluded' | 'hiddenEdges';

const PAGES: readonly ArchitectureCurationPage[] = ['pins', 'excluded', 'hiddenEdges'];

type ArchitectureCurationManagerProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: ArchitectureCurationState;
  /** False without a session; every action is disabled and the reason shown. */
  readonly canEdit: boolean;
  readonly onRestoreItem: (page: 'pins' | 'excluded', id: string) => void;
  readonly onRestoreEdge: (edge: ArchitectureCurationHiddenEdge) => void;
  readonly onRestoreGroup: (page: ArchitectureCurationPage) => void;
  readonly onRestoreAll: () => void;
  readonly onClearItem: (page: 'pins' | 'excluded', id: string) => void;
  /** Whether there is a latest adjustment that can still be undone. */
  readonly canUndo: boolean;
  /**
   * Undo the latest adjustment — the SAME action the Toast's Undo button
   * performs, offered here so it survives the Toast's dismissal.
   */
  readonly onUndo: () => void;
};

function pageLabelKey(page: ArchitectureCurationPage): string {
  if (page === 'pins') return 'architecture.curation.pagePins';
  if (page === 'excluded') return 'architecture.curation.pageExcluded';
  return 'architecture.curation.pageHidden';
}

function itemKey(item: ArchitectureCurationItem): string {
  return `${item.id}\u0000${item.file}\u0000${item.name}`;
}

function edgeKey(edge: ArchitectureCurationHiddenEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
}

/**
 * The `已调整 N 项` manager: three pages, one row per item, a restore per row
 * and a page-level restore at the bottom.
 *
 * A stale item keeps its place (the reader's choice is never silently dropped)
 * with a `已失效` badge and a `清除` action instead of a restore. The manager is
 * a popover on the desktop tier and a bottom sheet on the compact tier; the
 * drawer geometry is the only thing the tier changes.
 *
 * Used by `ArchitecturePanel` only, as the `已调整 N 项 ▾` popover/sheet.
 */
export function ArchitectureCurationManager({
  open,
  onClose,
  state,
  canEdit,
  onRestoreItem,
  onRestoreEdge,
  onRestoreGroup,
  onRestoreAll,
  onClearItem,
  canUndo,
  onUndo,
}: ArchitectureCurationManagerProps) {
  const { t } = useTranslation();
  const { compactToolbar, coarsePointer } = useTouchLayout();
  // Which of the three lists is on screen. Local to the manager; the first
  // open starts on `pins`, and staying mounted means a reopen keeps the page
  // the reader was auditing.
  const [page, setPage] = useState<ArchitectureCurationPage>('pins');
  const targetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;

  if (!open) return null;

  const total = state.pins.length + state.excluded.length + state.hiddenEdges.length;
  const rows = page === 'pins' ? state.pins : page === 'excluded' ? state.excluded : state.hiddenEdges;

  return (
    <div
      data-architecture-curation-manager="true"
      data-architecture-curation-page={page}
      role="dialog"
      aria-modal={compactToolbar ? 'true' : undefined}
      aria-label={t('architecture.curation.managerTitle', {
        defaultValue: 'Manual adjustments ({{count}})',
        count: total,
      })}
      className={
        compactToolbar
          ? 'absolute inset-x-0 bottom-0 z-50 flex max-h-[70vh] flex-col rounded-t-xl border-t border-border bg-popover p-3 shadow-xl'
          : 'absolute right-2 top-11 z-40 flex max-h-[70vh] w-80 flex-col rounded-lg border border-border bg-popover p-2 shadow-lg'
      }
    >
      <div className="flex items-center gap-1">
        <div role="tablist" aria-label={t('architecture.curation.managerTitle', { defaultValue: 'Manual adjustments' })} className="flex flex-1 gap-1">
          {PAGES.map((entry) => {
            const count = entry === 'pins'
              ? state.pins.length
              : entry === 'excluded'
                ? state.excluded.length
                : state.hiddenEdges.length;
            return (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={page === entry}
                data-architecture-curation-tab={entry}
                onClick={() => setPage(entry)}
                style={targetStyle}
                className={`rounded px-2 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                  page === entry ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(pageLabelKey(entry), { defaultValue: entry })}
                <span className="ml-1 tabular-nums text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </div>
        {/* The Toast's Undo, kept available after the Toast dismisses: the
            latest adjustment is still one click away while the reader audits
            the list. Rendered only when there IS something to undo. */}
        {canUndo && (
          <button
            type="button"
            data-architecture-curation-manager-undo="true"
            disabled={!canEdit}
            onClick={onUndo}
            style={targetStyle}
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('architecture.curation.undo', { defaultValue: 'Undo' })}
          </button>
        )}
        <button
          type="button"
          aria-label={t('architecture.curation.close', { defaultValue: 'Close adjustments' })}
          data-architecture-curation-close="true"
          onClick={onClose}
          style={targetStyle}
          className="rounded px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          ×
        </button>
      </div>

      {!canEdit && (
        <p role="status" data-architecture-curation-disabled-reason="true" className="mt-1 text-[11px] text-muted-foreground">
          {t('architecture.curation.noSession', {
            defaultValue: 'Manual adjustments need a session: they are stored per session.',
          })}
        </p>
      )}

      <div role="tabpanel" className="mt-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {t('architecture.curation.emptyPage', { defaultValue: 'Nothing here.' })}
          </p>
        ) : page === 'hiddenEdges' ? (
          (state.hiddenEdges as readonly ArchitectureCurationHiddenEdge[]).map((edge) => (
            <div
              key={edgeKey(edge)}
              data-architecture-curation-row={edgeKey(edge)}
              className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px] text-foreground"
            >
              <span className="min-w-0 flex-1 truncate">{`${edge.from} → ${edge.to} (${edge.type})`}</span>
              <button
                type="button"
                data-architecture-curation-restore={edgeKey(edge)}
                disabled={!canEdit}
                onClick={() => onRestoreEdge(edge)}
                style={targetStyle}
                className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('architecture.curation.restore', { defaultValue: 'Restore' })}
              </button>
            </div>
          ))
        ) : (
          (rows as readonly ArchitectureCurationItem[]).map((entry) => (
            <div
              key={itemKey(entry)}
              data-architecture-curation-row={entry.id}
              data-architecture-curation-stale={entry.stale === true ? 'true' : undefined}
              className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px] text-foreground"
            >
              <span className="min-w-0 flex-1 truncate" title={entry.file}>
                <span className="font-mono">{entry.name}</span>
                <span className="ml-1 text-muted-foreground">{entry.file}</span>
              </span>
              {entry.stale === true ? (
                <>
                  <span
                    data-architecture-curation-stale-badge="true"
                    className="shrink-0 rounded bg-amber-200/70 px-1 py-0.5 text-[10px] text-foreground dark:bg-amber-500/30"
                  >
                    {t('architecture.curation.stale', { defaultValue: 'Stale' })}
                  </span>
                  <button
                    type="button"
                    data-architecture-curation-clear={entry.id}
                    disabled={!canEdit}
                    onClick={() => onClearItem(page as 'pins' | 'excluded', entry.id)}
                    style={targetStyle}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('architecture.curation.clear', { defaultValue: 'Clear' })}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-architecture-curation-restore={entry.id}
                  disabled={!canEdit}
                  onClick={() => onRestoreItem(page as 'pins' | 'excluded', entry.id)}
                  style={targetStyle}
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('architecture.curation.restore', { defaultValue: 'Restore' })}
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/60 pt-1">
        <button
          type="button"
          data-architecture-curation-restore-group={page}
          disabled={!canEdit || rows.length === 0}
          onClick={() => onRestoreGroup(page)}
          style={targetStyle}
          className="rounded border border-border px-2 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('architecture.curation.restoreGroup', { defaultValue: 'Restore this page' })}
        </button>
        <button
          type="button"
          data-architecture-curation-restore-all="true"
          disabled={!canEdit || total === 0}
          onClick={onRestoreAll}
          style={targetStyle}
          className="rounded px-2 py-0.5 text-[11px] font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('architecture.curation.restoreAll', { defaultValue: 'Restore all' })}
        </button>
      </div>
    </div>
  );
}
