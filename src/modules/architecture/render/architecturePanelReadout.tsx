/**
 * The panel READOUT fragments: the one-line readout / budget / hidden readings and
 * the provenance + scope-hygiene footer.
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 */
import { RefreshCw } from 'lucide-react';
import { ARCHITECTURE_DETAIL_TIERS, ARCHITECTURE_SCOPE_MIN } from '@/modules/architecture/dom/detailRanking';
import { ARCHITECTURE_ELEMENT_KINDS, hiddenTotal, resetFilter, showAllFilter } from '@/modules/architecture/dom/elementRelationFilter';

import { diffHighlightCounts } from '@/modules/architecture/render/architecturePanelShared';
import { formatRefreshElapsed } from '@/modules/architecture/render/useArchitectureRefresh';
import { formatAbsoluteTime, formatRelativeTime } from '@/shared/utils';
import type { ArchitecturePanelActions } from '@/modules/architecture/render/useArchitecturePanelActions';
import type { ArchitecturePanelScope } from '@/modules/architecture/render/ArchitecturePanel';

/** The ready arm of the panel model: every field these fragments read. */
type ReadyScope = Extract<ArchitecturePanelScope, { branch: 'ready' }> & ArchitecturePanelActions;

/** Build the readout fragments from the panel model. */
export function panelReadoutFragments(panel: ReadyScope): {
  readonly sourceFooter: React.ReactNode;
  readonly readoutPanel: React.ReactNode;
} {
  const {
    budgetOmitted,
    changeDetail,
    changeFilter,
    changeScope,
    chrome,
    compactTargetStyle,
    compactToolbar,
    curationState,
    detail,
    filter,
    granularity,
    hiddenReading,
    i18n,
    kindLabel,
    layoutFit,
    openRefreshDialog,
    projectId,
    provenance,
    readout,
    readoutOpen,
    refresh,
    refreshRunning,
    relationTypeLabel,
    resolvedDiffHighlight,
    scope,
    scopeHiddenDelta,
    scopeHygieneOpen,
    showHiddenMentioned,
    showScopeHiddenKinds,
    stats,
    t,
    truncation,
    unresolvedOpen,
    readoutSummary,
  } = panel;

const unresolvedNames = [...stats.unresolved.files, ...stats.unresolved.identifiers];
const unresolvedCount = unresolvedNames.length;
// The server's scope hygiene reading. Absent = the merge changed nothing, and
// the source line then shows no cleanup affordance at all.
const scopeHygiene = provenance.scopeHygiene;
const subsumedEntityCount = scopeHygiene === undefined
  ? 0
  : scopeHygiene.subsumed.reduce((total, entry) => total + entry.droppedEntities, 0);
// The kind tally is a factual reading of what the analysis contains, NOT a
// judgement about the drawing. `class` folds the UML flavours the class
// diagram draws the same way (class/abstract/enum).
// The kind tally is a factual reading of the ANALYSIS (pre-budget), NOT a
// description of the drawing — the readout's own line states the drawn mix.
// It is an entity-view reading only: a file graph has no entity kinds, so the
// class tally there described a different graph.
const kindCounts = stats.kindCounts;
const kindLine = kindCounts === undefined || granularity !== 'entity'
  ? null
  : [
      { count: kindCounts.function ?? 0, key: 'kindFunction', defaultValue: '{{count}} functions' },
      { count: kindCounts.interface ?? 0, key: 'kindInterface', defaultValue: '{{count}} interfaces' },
      {
        count: (kindCounts.class ?? 0) + (kindCounts.abstract ?? 0) + (kindCounts.enum ?? 0),
        key: 'kindClass',
        defaultValue: '{{count}} classes',
      },
    ]
      .filter((part) => part.count > 0)
      .map((part) => t(`architecture.readout.${part.key}`, { defaultValue: part.defaultValue, count: part.count }))
      .join(' · ');

// The amber marker's accessible name has to say WHICH budget is squeezing;
// the visible text stays one short word so the line does not grow back into
// the three-sentence block the task replaces.
const budgetLayerNames = readout.limitedLayers.map((layer) => {
  if (layer === 'detail') return t('architecture.readout.layerDetail', { defaultValue: 'detail level' });
  if (layer === 'layout') return t('architecture.readout.layerLayout', { defaultValue: 'layout budget' });
  return t('architecture.readout.layerServer', { defaultValue: 'node budget' });
});
const budgetLimitedLabel = t('architecture.readout.budgetLimitedAria', {
  defaultValue: 'Budget-limited by {{layers}}',
  layers: budgetLayerNames.join(', '),
});

// The filter's own reading, the readout's second line. The parts reuse the
// SAME labels the popover's checkboxes show, so the number and the control
// can never disagree, and `total` above is the FILTERED in-scope count.
// The mentioned subset of each hidden kind is a parenthetical on that kind's
// own part: "451 functions (35 mentioned in this session)". It never becomes
// a separate part, because it is a subset of the number beside it, not a
// second removal.
const hiddenMentionedByKind = hiddenReading.mentionedByKind ?? {};
const hiddenKindParts = Object.entries(hiddenReading.byKind)
  .filter(([, count]) => (count ?? 0) > 0)
  .map(([kind, count]) => {
    const label = `${String(count)} ${kindLabel(kind as (typeof ARCHITECTURE_ELEMENT_KINDS)[number])}`;
    const mentioned = hiddenMentionedByKind[kind as (typeof ARCHITECTURE_ELEMENT_KINDS)[number]] ?? 0;
    if (mentioned <= 0) return label;
    return `${label} (${t('architecture.filter.mentionedInKind', {
      defaultValue: '{{count}} mentioned in this session',
      count: mentioned,
    })})`;
  });
const hiddenMentionedKinds = ARCHITECTURE_ELEMENT_KINDS.filter(
  (kind) => (hiddenMentionedByKind[kind] ?? 0) > 0,
);
// How many hidden entities this session names. The collapsed readout states
// this as one inline action, so the one-click recovery never depends on the
// expanded area being open.
const hiddenMentionedTotal = hiddenMentionedKinds.reduce(
  (total, kind) => total + (hiddenMentionedByKind[kind] ?? 0),
  0,
);
const hiddenRelationParts = Object.entries(hiddenReading.byRelation)
  .filter(([, count]) => count > 0)
  .map(([type, count]) => t('architecture.filter.relationPart', {
    defaultValue: '{{count}} {{kind}} relations',
    count,
    kind: relationTypeLabel(type),
  }));
const hiddenParts = [
  ...hiddenKindParts,
  ...hiddenRelationParts,
  ...(hiddenReading.isolated > 0
    ? [t('architecture.filter.isolatedPart', {
        defaultValue: '{{count}} isolated nodes',
        count: hiddenReading.isolated,
      })]
    : []),
];
const hiddenCount = hiddenTotal(hiddenReading);

const raiseDetail = (): void => {
  const index = ARCHITECTURE_DETAIL_TIERS.indexOf(detail);
  changeDetail(ARCHITECTURE_DETAIL_TIERS[Math.min(index + 1, ARCHITECTURE_DETAIL_TIERS.length - 1)]);
};

/** The analysis/seed source line ... */
/**
 * The analysis/seed source line, now a FOOTER in the panel's document flow
 * BELOW the canvas instead of a pill floating over the drawing's bottom-left
 * corner. Relative time on the surface, the exact local instant in `title`.
 * Its detail lists expand UPWARDS out of the footer (`position: absolute;
 * bottom-full`), so opening one never changes the canvas's size. Extracted so
 * the empty-reading state shows it too (the provenance exists even when no
 * seed resolved).
 */
const sourceFooter = (
  // NO `overflow-hidden` on this row. Both of its disclosures (`names
  // mentioned …` and `Scope cleanup`) open UPWARDS out of it
  // (`absolute bottom-full`), and the clipping footer cut them down to a
  // zero-height sliver: the toggle flipped to ▾ while nothing appeared. The
  // row cannot overflow on its own — the source line is `min-w-0 truncate`
  // (which clips itself) and the cleanup pill is `shrink-0` — so the clip
  // bought nothing and cost both panels.
  //
  // `z-30`, not `z-20`: the disclosures are absolutely positioned out of
  // this row and therefore overlap the drawing's own corner chrome
  // (the zoom cluster at 20, the readable Focus/Overview switch at 24).
  // At an equal tier the later sibling already won, but the footer's
  // stacking context capped its children below the switch, so the list's
  // first rows were painted under it.
  <div
    data-architecture-source-footer="true"
    className="relative z-30 flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground"
  >
    <span
      data-architecture-source-line="true"
      className="min-w-0 truncate rounded-md border border-border/60 bg-background/90 px-2 py-1 shadow-sm"
    >
      {t('architecture.honesty.analysis', { defaultValue: 'Analysis' })}:{' '}
      {provenance.generatedAt ? (
        <time
          data-architecture-generated-at
          dateTime={provenance.generatedAt}
          title={formatAbsoluteTime(provenance.generatedAt, i18n.language)}
        >
          {formatRelativeTime(provenance.generatedAt, i18n.language)}
        </time>
      ) : (
        <span data-architecture-generated-at>unknown</span>
      )}
    </span>
    {/* The manual re-analysis entry. It sits beside the analysis time because
        that is the reading it changes; while a job runs it shows the elapsed
        time and is disabled, so a second tab (or a second press) cannot start
        a duplicate analysis. */}
    <button
      type="button"
      data-architecture-refresh="true"
      data-architecture-refresh-state={refresh.status.state}
      aria-label={t('architecture.refresh.action', { defaultValue: 'Refresh analysis' })}
      title={t('architecture.refresh.action', { defaultValue: 'Refresh analysis' })}
      disabled={refreshRunning || projectId === null}
      onClick={(event) => openRefreshDialog(event.currentTarget)}
      style={compactTargetStyle}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-background/90 px-1.5 py-1 text-[11px] text-muted-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <RefreshCw
        aria-hidden="true"
        className={refreshRunning ? 'h-3 w-3 animate-spin' : 'h-3 w-3'}
      />
      {refreshRunning && (
        <span data-architecture-refresh-footer-elapsed="true" className="tabular-nums">
          {formatRefreshElapsed(refresh.elapsedMs)}
        </span>
      )}
    </button>
    {/* The unresolved toggle is a SIBLING of the truncating source line, not
        its child: inside a `truncate` span its own 352px width was clipped by
        the span's `overflow: hidden`, so a phone showed "Analysis: 14 hours
        ago · …" and the names were neither visible nor tappable. As a
        `shrink-0` pill it keeps its whole hit box and the source line gives
        up width instead. The compact tier shortens the label to fit the same
        row; the full sentence moves to the top of the expanded list. */}
    <button
      type="button"
      aria-expanded={unresolvedOpen}
      data-architecture-unresolved={unresolvedCount}
      onClick={() => chrome.toggleUnresolved()}
      style={compactTargetStyle}
      className="shrink-0 whitespace-nowrap rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      {compactToolbar
        ? t('architecture.source.unresolvedShort', {
            defaultValue: '{{count}} unmatched',
            count: unresolvedCount,
          })
        : t('architecture.source.unresolved', {
            defaultValue: '{{count}} names mentioned in this session were not found in the analysis cache',
            count: unresolvedCount,
          })}
      <span aria-hidden="true">{unresolvedOpen ? ' ▾' : ' ▸'}</span>
    </button>
    {unresolvedOpen && (
      <div
        data-architecture-unresolved-panel="true"
        className="absolute bottom-full left-3 z-30 mb-1 rounded-md border border-border/60 bg-background/95 shadow-sm"
      >
        {/* The names that were not found are the honest-bar reading the manual
            refresh answers, so its action lives beside them as well as beside
            the analysis time. It is a SIBLING of the list: the list's items are
            names only, and a control among them would read as a name. */}
        {projectId !== null && (
          <div className="px-2 pb-1 pt-1">
            <button
              type="button"
              data-architecture-refresh-unresolved="true"
              disabled={refreshRunning}
              onClick={(event) => openRefreshDialog(event.currentTarget)}
              className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('architecture.refresh.action', { defaultValue: 'Refresh analysis' })}
            </button>
          </div>
        )}
        <ul
          data-architecture-unresolved-list="true"
          aria-label={t('architecture.source.listLabel', { defaultValue: 'Unresolved names' })}
          className="max-h-40 overflow-y-auto px-2 pb-1"
        >
          {/* The pill drops the full sentence on the compact tier; the reader
              still gets it here, above the names it describes. */}
          {compactToolbar && (
            <li data-architecture-unresolved-summary="true" className="pb-1 text-muted-foreground">
              {t('architecture.source.unresolved', {
                defaultValue: '{{count}} names mentioned in this session were not found in the analysis cache',
                count: unresolvedCount,
              })}
            </li>
          )}
          {unresolvedNames.map((name) => (
            <li key={name} data-architecture-unresolved-name="true">
              {name}
            </li>
          ))}
        </ul>
      </div>
    )}
    {/* Scope cleanup: what the server dropped or rewrote before drawing. It
        sits after the analysis/seed line because it explains that line's
        numbers, and it is absent entirely when the merge changed nothing. */}
    {scopeHygiene !== undefined && (
      <button
        type="button"
        aria-expanded={scopeHygieneOpen}
        data-architecture-scope-hygiene="true"
        data-architecture-scope-hygiene-total={scopeHygiene.total}
        data-architecture-scope-hygiene-kept={scopeHygiene.kept}
        onClick={() => chrome.toggleScopeHygiene()}
        style={compactTargetStyle}
        className="shrink-0 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {t('architecture.scopeHygiene.summary', { defaultValue: 'Scope cleanup' })}
        <span aria-hidden="true">{scopeHygieneOpen ? ' ▾' : ' ▸'}</span>
      </button>
    )}
    {scopeHygiene !== undefined && scopeHygieneOpen && (
      <ul
        data-architecture-scope-hygiene-detail="true"
        aria-label={t('architecture.scopeHygiene.detailLabel', {
          defaultValue: 'Scope cleanup details',
        })}
        className="absolute bottom-full right-3 z-30 mb-1 max-h-40 max-w-xs overflow-y-auto rounded-md border border-border/60 bg-background/95 px-2 py-1 shadow-sm"
      >
        <li data-architecture-scope-hygiene-counts="true">
          {t('architecture.scopeHygiene.scopeCount', {
            defaultValue: '{{total}} scopes, kept {{kept}}',
            total: scopeHygiene.total,
            kept: scopeHygiene.kept,
          })}
        </li>
        {scopeHygiene.subsumed.length > 0 && (
          <li data-architecture-scope-hygiene-subsumed={scopeHygiene.subsumed.length}>
            {t('architecture.scopeHygiene.subsumed', {
              defaultValue: '{{count}} merged into an outer scope ({{entities}} duplicate entities dropped)',
              count: scopeHygiene.subsumed.length,
              entities: subsumedEntityCount,
            })}
          </li>
        )}
        {scopeHygiene.droppedOutsideRoot.length > 0 && (
          <li data-architecture-scope-hygiene-outside={scopeHygiene.droppedOutsideRoot.length}>
            {t('architecture.scopeHygiene.outside', {
              defaultValue: '{{count}} outside the project directory were ignored',
              count: scopeHygiene.droppedOutsideRoot.length,
            })}
          </li>
        )}
        {scopeHygiene.normalizedAbsoluteIds > 0 && (
          <li data-architecture-scope-hygiene-normalized={scopeHygiene.normalizedAbsoluteIds}>
            {t('architecture.scopeHygiene.normalized', {
              defaultValue: '{{count}} absolute-path ids normalised',
              count: scopeHygiene.normalizedAbsoluteIds,
            })}
          </li>
        )}
        {scopeHygiene.droppedOutsideRoot.map((entry) => (
          <li key={entry.scope} data-architecture-scope-hygiene-outside-scope={entry.scope}>
            {t('architecture.scopeHygiene.outsideItem', {
              defaultValue: '{{label}} — {{sources}}',
              label: entry.label,
              sources: entry.sources.join(', '),
            })}
          </li>
        ))}
      </ul>
    )}
  </div>

);

/**
 * The one-line reading. It is the only place the shown/in-scope numbers are
 * stated, and it lives in the panel's in-flow row ABOVE the drawing (left
 * cell): as an overlay it covered the first row of the graph. The filter's
 * second line sits under it, so hiding and narrowing never share a number.
 */
// The diff set's size, for the one readout line; null when nothing is highlighted.
const diffCounts = resolvedDiffHighlight === null
  ? null
  : diffHighlightCounts(resolvedDiffHighlight);
const readoutPanel = (
  <div
    data-architecture-readout="true"
    aria-live="polite"
    // The collapsed card is ONE line on every tier: a desktop row that spends
    // two lines on readings costs the drawing height just like the phone's
    // 44px box does. The second/third lines (diff, scope-hidden, the filter
    // reading and its actions, curation) plus the budget detail live behind
    // the toggle in document flow.
    style={compactToolbar && !readoutOpen ? { height: '44px' } : undefined}
    className={compactToolbar
      ? 'pointer-events-auto max-w-full overflow-hidden rounded-md bg-background/90 px-2 text-[11px] text-muted-foreground'
      : 'pointer-events-auto max-w-full rounded-md border border-border/60 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm'}
  >
    {/* The toggle and the collapsed "Show mentioned (N)" action are SIBLINGS:
        a button inside a button is invalid HTML, and the action must be
        reachable without expanding the card. */}
    <div
      className={compactToolbar
        ? 'flex h-full w-full flex-nowrap items-center gap-2 overflow-hidden'
        : 'flex w-full flex-nowrap items-center gap-2 overflow-hidden'}
    >
    <button
      type="button"
      aria-expanded={readoutOpen}
      onClick={() => chrome.toggleReadout()}
      data-architecture-readout-toggle="true"
      style={compactTargetStyle}
      className={compactToolbar
        ? 'flex h-full min-w-0 flex-1 flex-nowrap items-center gap-x-2 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
        : 'flex min-w-0 flex-1 flex-nowrap items-center gap-x-2 overflow-hidden text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60'}
    >
      <span
        data-architecture-readout-summary={readout.shown}
        data-architecture-readout-total={readout.related}
        className="min-w-0 truncate whitespace-nowrap"
      >
        {readoutSummary}
      </span>
      {compactToolbar && truncation.truncated && (
        // The compact tier has no room for a second badge in its one header
        // row, so the budget reading travels with the floating readout chip.
        <span
          data-architecture-truncated-badge="true"
          data-architecture-truncated-granularity={granularity}
          data-architecture-truncated-omitted={budgetOmitted}
          className="whitespace-nowrap font-medium text-amber-600 dark:text-amber-400"
        >
          +{budgetOmitted} folded
        </span>
      )}
      {readout.limited && (
        // ONE short amber marker, never the three budget sentences the task
        // replaces: the layer-specific numbers live in the expanded area. The
        // accessible name still says which layer(s) are squeezing, and the
        // DOM readings the panel has always exposed stay on this element with
        // the new meaning (N = drawn entities, M = pre-budget related).
        <span
          data-architecture-budget-limited="true"
          aria-label={budgetLimitedLabel}
          {...(layoutFit?.limited === true
            ? {
                'data-architecture-layout-budget': layoutFit.graph.nodes.length,
                'data-architecture-layout-budget-tier': layoutFit.tier,
                'data-architecture-layout-budget-dropped': layoutFit.droppedCount,
              }
            : {})}
          {...(truncation.truncated
            ? {
                'data-architecture-truncated': 'true',
                'data-architecture-truncated-granularity': granularity,
                'data-architecture-truncated-shown': truncation.shown,
                'data-architecture-truncated-total': truncation.total,
                'data-architecture-truncated-omitted': budgetOmitted,
              }
            : {})}
          className="whitespace-nowrap text-amber-600 dark:text-amber-400"
        >
          {t('architecture.readout.budgetLimited', { defaultValue: 'Budget-limited' })}
        </span>
      )}
      <span aria-hidden="true">{readoutOpen ? '▾' : '▸'}</span>
    </button>
    {/* The one-click recovery for entities the session named but the default
        filter hides. It stays on the COLLAPSED line: burying it in the
        expanded area would make the reader open a disclosure to undo a
        default. The expanded filter row below carries the same action with
        the full reading, and the two never render at once. */}
    {!compactToolbar && !readoutOpen && hiddenMentionedTotal > 0 && (
      <button
        type="button"
        data-architecture-filter-show-mentioned="true"
        onClick={showHiddenMentioned}
        style={compactTargetStyle}
        className="shrink-0 whitespace-nowrap font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {t('architecture.filter.showMentionedCount', {
          defaultValue: '▸ Show mentioned ({{count}})',
          count: hiddenMentionedTotal,
        })}
      </button>
    )}
    </div>
    {/* The wall's structural diff: one line stating how many targets are marked. It is
        part of the expanded area on every tier. */}
    {readoutOpen && diffCounts !== null && (
      <div
        data-testid="architecture-diff-highlight"
        data-architecture-diff-nodes={diffCounts.nodes}
        data-architecture-diff-edges={diffCounts.edges}
        className="mt-0.5 text-amber-700 dark:text-amber-400"
      >
        {t('architecture.diffHighlight', {
          defaultValue: 'Diff highlight: {{nodes}} targets · {{edges}} relations',
          nodes: diffCounts.nodes,
          edges: diffCounts.edges,
        })}
      </div>
    )}
    {/* A scope step that found entities and then hid all of them: state the
        delta and offer the one click that brings them back. Part of the
        EXPANDED area — the collapsed card is one line by contract. */}
    {readoutOpen && scopeHiddenDelta !== null && (
      <div
        data-architecture-scope-hidden={scopeHiddenDelta.found}
        data-architecture-scope-hidden-scope={scopeHiddenDelta.scope}
        className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"
      >
        <span>
          {t('architecture.copyFix.scopeMoreHidden', {
            defaultValue: 'Scope +{{scope}} found {{count}} more related, all hidden by the filter ({{parts}})',
            scope: scopeHiddenDelta.scope,
            count: scopeHiddenDelta.found,
            parts: [
              ...scopeHiddenDelta.kinds.map((entry) => `${String(entry.count)} ${kindLabel(entry.kind)}`),
              ...scopeHiddenDelta.relations.map((entry) => `${String(entry.count)} ${relationTypeLabel(entry.type)} relations`),
            ].join(' · '),
          })}
        </span>
        {scopeHiddenDelta.kinds.length > 0 && (
          <button
            type="button"
            data-architecture-scope-show-kinds={scopeHiddenDelta.kinds.map((entry) => entry.kind).join(',')}
            onClick={showScopeHiddenKinds}
            style={compactTargetStyle}
            className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('architecture.copyFix.showKinds', {
              defaultValue: '▸ Show {{kinds}}',
              kinds: scopeHiddenDelta.kinds.map((entry) => kindLabel(entry.kind)).join(' · '),
            })}
          </button>
        )}
      </div>
    )}
    {/* The filter's second line: what the element/relation selection is
        hiding, and the one-click reset. Deliberately separate from the
        detail sentence above — the two knobs must not share a number. It is
        part of the expanded area on every tier, never in the one line. */}
    {readoutOpen && hiddenCount > 0 && (
      <div
        data-architecture-filter-hidden={hiddenCount}
        data-architecture-filter-hidden-kinds={JSON.stringify(hiddenReading.byKind)}
        data-architecture-filter-hidden-relations={JSON.stringify(hiddenReading.byRelation)}
        data-architecture-filter-hidden-isolated={hiddenReading.isolated}
        data-architecture-filter-hidden-mentioned={
          hiddenMentionedKinds.length === 0 ? '' : JSON.stringify(hiddenMentionedByKind)
        }
        className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5"
      >
        <span>
          {t('architecture.filter.hiddenPrefix', {
            defaultValue: 'Hidden {{parts}}',
            parts: hiddenParts.join(' · '),
          })}
        </span>
        {hiddenMentionedKinds.length > 0 && (
          // The one-click counterpart to the popover's switches: show exactly
          // the mentioned entities of the kinds this reading is hiding.
          <button
            type="button"
            data-architecture-filter-show-mentioned="true"
            onClick={showHiddenMentioned}
            style={compactTargetStyle}
            className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('architecture.filter.showMentioned', { defaultValue: '▸ Show mentioned' })}
          </button>
        )}
        <button
          type="button"
          data-architecture-filter-show-all="true"
          onClick={() => changeFilter(showAllFilter(filter))}
          // Show all is about the ELEMENT axis: it shows every kind and keeps
          // isolated nodes, and leaves the relation preset where the reader
          // put it (see `showAllFilter`).
          style={compactTargetStyle}
          className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.filter.showAll', { defaultValue: '▸ Show all' })}
        </button>
        <button
          type="button"
          data-architecture-filter-reset="true"
          onClick={() => changeFilter(resetFilter())}
          // The way back from a sequence of switches that no reader can
          // reconstruct from memory: one click, the project's shipped default.
          style={compactTargetStyle}
          className="font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.filter.reset', { defaultValue: '↺ Reset filters' })}
        </button>
      </div>
    )}
    {/* The curation reading joins the other second lines in the expanded
        area: the collapsed card states the drawing's numbers only. */}
    {readoutOpen && (curationState.excluded.length > 0 || curationState.pins.length > 0) && (
      <p
        data-architecture-curation-readout="true"
        data-architecture-curation-pinned={curationState.pins.length}
        data-architecture-curation-excluded={curationState.excluded.length}
        className="mt-0.5"
      >
        {t('architecture.curation.readout', {
          defaultValue: '{{excluded}} manually removed · {{pinned}} pinned',
          excluded: curationState.excluded.length,
          pinned: curationState.pins.length,
        })}
      </p>
    )}
    {readoutOpen && (
      <div data-architecture-readout-detail="true" className="mt-1 flex flex-col gap-1">
        {readout.lines.length > 0 && (
          // One line per budget layer that cut, each with its own number and
          // its "how to adjust" clause. Untriggered layers are absent.
          <div data-architecture-readout-budget-lines="true" className="flex flex-col gap-0.5">
            {readout.lines.map((line) => (
              <p
                key={line.layer}
                data-architecture-readout-line={line.layer}
                data-architecture-readout-line-count={line.count}
              >
                {line.layer === 'detail'
                  ? t('architecture.readout.detailLayer', {
                      defaultValue: 'Detail level kept {{value}}.',
                      value: line.countText,
                    })
                  : line.layer === 'layout'
                    ? t('architecture.readout.layoutLayer', {
                        defaultValue:
                          'The layout budget draws {{value}} — more would be slow; lower the detail to see more.',
                        value: line.countText,
                      })
                    : t('architecture.readout.serverLayer', {
                        defaultValue:
                          'The node budget left {{value}} out — reduce the scope to see them.',
                        value: line.countText,
                      })}
              </p>
            ))}
          </div>
        )}
        {kindLine !== null && kindLine.length > 0 && (
          <p data-architecture-kind-counts="true">{kindLine}</p>
        )}
        <span className="flex gap-2">
          <button
            type="button"
            onClick={raiseDetail}
            data-architecture-raise-detail="true"
            style={compactTargetStyle}
            className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('architecture.readout.raiseDetail', { defaultValue: 'Raise detail' })}
          </button>
          <button
            type="button"
            onClick={() => changeScope(scope - 1)}
            data-architecture-reduce-scope="true"
            disabled={scope <= ARCHITECTURE_SCOPE_MIN}
            style={compactTargetStyle}
            className="rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('architecture.readout.reduceScope', { defaultValue: 'Reduce scope' })}
          </button>
        </span>
      </div>
    )}
  </div>
);

  return {
    sourceFooter,
    readoutPanel,
  };
}
