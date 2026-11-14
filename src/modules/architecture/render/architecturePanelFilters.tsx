/**
 * The panel FILTER and SEARCH fragments: the element/relation filter popover, its
 * disclosure trigger, the in-graph + project-wide combobox, the curation-manager
 * trigger and the legend popover.
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 */
import { ARCHITECTURE_ELEMENT_KINDS, ARCHITECTURE_RELATION_PRESETS, activeFilterCount, keptMentionedCount, resetFilter } from '@/modules/architecture/dom/readout/elementRelationFilter';
import type { ArchitectureEntityKind } from '@/modules/architecture/dom/rendererContract';
import { TOUCH_CONTROL_GAP_PX, TOUCH_TARGET_STYLE } from '@/modules/architecture/hooks/useTouchLayout';
import { seedMarkerMode } from '@/modules/architecture/layout/plantuml/archguardToPlantUml';
import { MENTIONED_HINT_ID } from '@/modules/architecture/render/architecturePanelShared';
import { LegendSwatch } from '@/modules/architecture/render/LegendSwatch';
import type { ArchitectureSearchCommit } from '@/modules/architecture/render/architectureSearchController';
import type { ArchitecturePanelActions } from '@/modules/architecture/render/useArchitecturePanelActions';
import type { ArchitecturePanelScope } from '@/modules/architecture/render/ArchitecturePanel';

/** The ready arm of the panel model: every field these fragments read. */
type ReadyScope = Extract<ArchitecturePanelScope, { branch: 'ready' }> & ArchitecturePanelActions;

/** Build the filtersearch fragments from the panel model. */
export function panelFilterFragments(panel: ReadyScope): {
  readonly filterContent: React.ReactNode;
  readonly filterDisclosure: React.ReactNode;
  readonly searchBox: React.ReactNode;
  readonly curationManagerButton: React.ReactNode;
  readonly legendBody: React.ReactNode;
  readonly legend: React.ReactNode;
} {
  const {
    activeNodeIds,
    activeSearchIndex,
    canCurate,
    changeFilter,
    coarsePointer,
    compactTargetStyle,
    compactToolbar,
    curation,
    curationManagerButtonRef,
    curationManagerOpen,
    curationState,
    drawnGraph,
    filter,
    filterButtonRef,
    filterMenuOpen,
    filterPosition,
    granularity,
    kindLabel,
    mentionedKindCounts,
    mentionedKinds,
    pinItem,
    projectSearch,
    relationPresetLabel,
    revealNode,
    search,
    searchMatches,
    searchOpen,
    searchPending,
    searchQuery,
    settings,
    showHiddenSearchMatch,
    stats,
    t,
    toggleKeepMentioned,
    toggleKind,
  } = panel;

/**
 * The filter popover's CONTENT, independent of the container that hosts it.
 * The desktop tier draws it under the `Filter ▾` disclosure; the compact tier
 * draws the same fragment inside the panel's overflow sheet (the mobile
 * bottom-drawer container is a later task's business, and this content must
 * not know about it).
 */
const filterContent = (
  <div data-architecture-filter-panel="true" className="flex flex-col gap-2 text-xs">
    {/* The element axis does not exist on the file graph: a file has no
        kind, so the section is not drawn there (rather than drawn disabled). */}
    {granularity === 'entity' && (
      <fieldset data-architecture-filter-elements="true" className="flex flex-col gap-1">
        <legend className="mb-1 text-[11px] font-medium text-muted-foreground">
          {t('architecture.filter.elements', { defaultValue: 'Elements' })}
        </legend>
        <div className="flex flex-wrap" style={{ gap: coarsePointer ? TOUCH_CONTROL_GAP_PX : 4 }}>
          {ARCHITECTURE_ELEMENT_KINDS.map((kind) => {
            const count = stats.kindCounts?.[kind];
            return (
              <button
                key={kind}
                type="button"
                role="checkbox"
                aria-checked={filter.kinds.includes(kind)}
                data-architecture-filter-kind={kind}
                data-architecture-filter-kind-count={count === undefined ? '' : String(count)}
                onClick={() => toggleKind(kind)}
                style={compactTargetStyle}
                className={`rounded border px-2 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                  filter.kinds.includes(kind)
                    ? 'border-primary/60 bg-accent text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {/* The on/off state is a glyph, not only a fill shade. */}
                <span aria-hidden="true" className="mr-1">{filter.kinds.includes(kind) ? '☑' : '☐'}</span>
                {count === undefined ? kindLabel(kind) : `${String(count)} ${kindLabel(kind)}`}
              </button>
            );
          })}
        </div>
      </fieldset>
    )}

    {granularity === 'entity' && mentionedKinds.length > 0 && (
      <fieldset data-architecture-filter-mentioned="true" className="flex flex-col gap-1">
        <legend className="mb-1 text-[11px] font-medium text-muted-foreground">
          {t('architecture.filter.mentioned', { defaultValue: 'Mentioned in this session' })}
        </legend>
        <p
          id={MENTIONED_HINT_ID}
          data-architecture-filter-mentioned-hint="true"
          className="text-[10px] text-muted-foreground"
        >
          {t('architecture.filter.mentionedHint', {
            defaultValue: 'Keep these shown even when their kind is hidden',
          })}
        </p>
        <div className="flex flex-wrap" style={{ gap: coarsePointer ? TOUCH_CONTROL_GAP_PX : 4 }}>
          {mentionedKinds.map((kind) => {
            const count = mentionedKindCounts[kind] ?? 0;
            const on = filter.keepMentionedKinds.includes(kind);
            // The visible text is "35 functions"; the accessible name must
            // START with exactly that (WCAG "label in name") and leave the
            // extra explanation to `aria-describedby`.
            const visible = `${String(count)} ${kindLabel(kind)}`;
            return (
              <button
                key={kind}
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={`${visible}, ${t('architecture.filter.mentionedToggleAria', {
                  defaultValue: 'mentioned in this session, kept visible even when the kind is hidden',
                })}`}
                aria-describedby={MENTIONED_HINT_ID}
                data-architecture-filter-mentioned-kind={kind}
                data-architecture-filter-mentioned-kind-count={String(count)}
                onClick={() => toggleKeepMentioned(kind)}
                style={compactTargetStyle}
                className={`flex items-center gap-1 rounded border px-2 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                  on
                    ? 'border-primary/60 bg-accent text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {/* The state is carried by a glyph AND the background, so it
                    does not depend on colour alone. */}
                <span aria-hidden="true">{on ? '☑' : '☐'}</span>
                {`${String(count)} ${kindLabel(kind)}`}
              </button>
            );
          })}
        </div>
      </fieldset>
    )}

    <div
      role="radiogroup"
      aria-label={t('architecture.filter.relations', { defaultValue: 'Relations' })}
      data-architecture-filter-relations="true"
      className="flex flex-col gap-1"
    >
      <span className="text-[11px] font-medium text-muted-foreground">
        {t('architecture.filter.relations', { defaultValue: 'Relations' })}
      </span>
      <div className="flex flex-wrap" style={{ gap: coarsePointer ? TOUCH_CONTROL_GAP_PX : 4 }}>
        {ARCHITECTURE_RELATION_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={filter.relations === preset}
            data-architecture-filter-relation={preset}
            onClick={() => changeFilter({
              ...filter,
              relations: preset,
              // The isolated toggle follows the preset's own default: a
              // narrowed relation set makes isolated nodes an artefact of the
              // filter, while "every relation" makes isolation a real fact.
              hideIsolated: preset !== 'call',
            })}
            style={compactTargetStyle}
            className={`rounded border px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
              filter.relations === preset
                ? 'border-primary/60 bg-accent text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {/* A radio's selected state is a glyph too, so it survives a
                colour-blind reader and a low-contrast theme. */}
            <span aria-hidden="true" className="mr-1">{filter.relations === preset ? '✓' : '○'}</span>
            {relationPresetLabel(preset)}
          </button>
        ))}
      </div>
    </div>

    <button
      type="button"
      role="checkbox"
      aria-checked={filter.hideIsolated}
      data-architecture-filter-isolated="true"
      onClick={() => changeFilter({ ...filter, hideIsolated: !filter.hideIsolated })}
      style={compactTargetStyle}
      className="flex items-center gap-1 text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <span aria-hidden="true">{filter.hideIsolated ? '☑' : '☐'}</span>
      {t('architecture.filter.isolated', { defaultValue: 'Hide isolated nodes' })}
    </button>

    {/* The way back to this project's shipped selection. It lives in the
        popover as well as in the readout row because the popover is where the
        reader made the changes; a sequence of switches has no other one-click
        undo, and the row is only drawn while something is hidden. */}
    <button
      type="button"
      data-architecture-filter-reset="true"
      onClick={() => changeFilter(resetFilter())}
      style={compactTargetStyle}
      className="mt-1 self-start rounded border border-border px-2 py-0.5 text-left text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      {t('architecture.filter.reset', { defaultValue: '↺ Reset filters' })}
    </button>
  </div>
);

const filterTriggerLabel = t('architecture.filter.menu', { defaultValue: 'Filter ▾' });
const filterBadge = activeFilterCount(filter);
// "Keeping N" is the OPPOSITE direction from "Hiding N": opening a "keep
// mentioned" switch shows more, so it must never raise the hidden count. The
// badge states the two readings separately.
const filterKept = keptMentionedCount(filter);
// The badge counts DECISIONS THAT HIDE SOMETHING, not "options that are on".
// The default filter has every kind enabled except functions/others, so the
// old "4 on" read as four visible things while four cuts were in force.
const filterBadgeAria = filterKept === 0
  ? t('architecture.copyFix.filterBadgeAria', {
    defaultValue: '{{count}} filter decisions are hiding content (elements, relations, isolated nodes)',
    count: filterBadge,
  })
  : t('architecture.copyFix.filterBadgeKeepingAria', {
    defaultValue: '{{count}} filter decisions are hiding content; {{kept}} kinds are kept visible',
    count: filterBadge,
    kept: filterKept,
  });
const openFilterMenu = (): void => {
  if (compactToolbar) {
    settings.openFilterMenu(null);
    return;
  }
  // Fixed positioning needs a measured anchor on the desktop tier.
  const rect = filterButtonRef.current?.getBoundingClientRect();
  settings.openFilterMenu(
    rect === undefined ? null : { left: Math.max(8, rect.left), top: rect.bottom + 4 },
  );
};
const filterDisclosure = (
  <div className={compactToolbar ? 'flex flex-col gap-1' : 'relative'} data-architecture-filter-root="true">
    <button
      ref={filterButtonRef}
      type="button"
      aria-haspopup="true"
      aria-expanded={filterMenuOpen}
      onClick={() => {
        if (filterMenuOpen) settings.closeFilterMenu();
        else openFilterMenu();
      }}
      data-architecture-filter-toggle="true"
      style={compactTargetStyle}
      className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 ${
        compactToolbar ? 'px-3 py-2 text-left text-sm' : 'px-2 py-0.5 text-xs'
      }`}
    >
      {filterTriggerLabel}
      <span
        data-architecture-filter-badge={filterBadge}
        title={filterBadgeAria}
        aria-label={filterBadgeAria}
        className="ml-1 rounded-full bg-accent px-1.5 text-[10px] tabular-nums text-foreground"
      >
        {filterKept === 0
          ? t('architecture.copyFix.filterBadge', { defaultValue: 'Hiding {{count}}', count: filterBadge })
          : t('architecture.copyFix.filterBadgeKeeping', {
            defaultValue: 'Hiding {{count}} · keeping {{kept}}',
            count: filterBadge,
            kept: filterKept,
          })}
      </span>
    </button>
    {filterMenuOpen && (
      <div
        role="group"
        aria-label={filterTriggerLabel}
        data-architecture-filter-menu="true"
        style={compactToolbar ? undefined : (filterPosition ?? { left: 8, top: 56 })}
        onKeyDown={(event) => {
          // Escape belongs to this panel while it is open; stopping it keeps
          // the chat page's document-level abort out of the interaction.
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          settings.closeFilterMenu();
        }}
        className={
          compactToolbar
            ? 'flex flex-col gap-1 rounded-lg border border-border bg-popover p-2'
            : 'fixed z-50 flex w-80 flex-col gap-1 rounded-lg border border-border bg-popover p-2 shadow-lg'
        }
      >
        {filterContent}
      </div>
    )}
  </div>
);

// The project-wide search's kind glyph. The same vocabulary the inspector
// prints, kept local so the toolbar row stays a one-line reading.
const searchKindGlyph = (kind: ArchitectureEntityKind | undefined): string => {
  switch (kind) {
    case 'interface':
      return 'I';
    case 'enum':
      return 'E';
    case 'abstract':
      return 'A';
    case 'function':
      return 'ƒ';
    case 'class':
      return 'C';
    default:
      return '•';
  }
};

// The search box. It draws TWO groups: "图中" (local matches, handled by
// revealing/focusing an arrived node) and, with a session, "项目其它" — the
// project-wide index behind the `＋` pin action. The second group appears
// only from two characters up, the endpoint's own floor.
//
// The widget is a real combobox: the input carries `role="combobox"` and
// `aria-activedescendant`, the results are a `listbox` of `option`s, the
// arrow keys move the active option and Enter chooses it. The first options
// are the in-graph matches; the project-wide hits follow in the same list.
const projectHits = canCurate
  && searchQuery.trim().length >= 2
  && projectSearch.search.status === 'ready'
  ? projectSearch.search.results
  : [];
const searchOptionCount = searchMatches.length + projectHits.length;
const searchListId = 'architecture-search-listbox';
const searchOptionId = (index: number): string => `architecture-search-option-${index}`;
// The controller decided what Enter chose; the panel performs the drawing
// command (it owns the reveal/selection effects, not the choice rule).
const applySearchChoice = (choice: ArchitectureSearchCommit | null): void => {
  if (choice === null) return;
  if (choice.kind === 'project') {
    const hit = projectHits[choice.projectIndex];
    if (hit !== undefined) pinItem(hit);
    return;
  }
  const { candidate, drill } = choice;
  // A match the filter removed is not drawn yet: "Show it" first, then
  // centre/select it. A drawn match is centred in place; only `drill` (the
  // explicit "view neighbourhood" command) replaces the drawing.
  if (!candidate.inGraph) showHiddenSearchMatch(candidate);
  else revealNode(candidate.node.id, !candidate.inRange, drill);
};
const searchBox = (
  <div ref={search.searchWidgetRef} className="relative" data-architecture-search-root="true">
    <input
      type="search"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={searchOpen && !searchPending && searchQuery.trim().length > 0}
      aria-controls={searchListId}
      aria-activedescendant={activeSearchIndex >= 0 && searchOpen ? searchOptionId(activeSearchIndex) : undefined}
      value={searchQuery}
      aria-label={t('architecture.search.label', { defaultValue: 'Search entities or files' })}
      placeholder={t('architecture.search.placeholder', { defaultValue: 'Search entities or files…' })}
      data-architecture-search="true"
      style={compactToolbar ? TOUCH_TARGET_STYLE : undefined}
      onChange={(event) => {
        search.setQuery(event.target.value);
      }}
      onFocus={() => {
        search.openList();
      }}
      onBlur={(event) => {
        // Focus moving INTO the listbox (a result press) keeps it open; any
        // other focus loss closes it.
        if (search.isInsideSearchWidget(event.relatedTarget as Node | null)) return;
        search.closeList();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          search.closeList();
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          search.moveActive(1, searchOptionCount);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          search.moveActive(-1, searchOptionCount);
          return;
        }
        if (event.key !== 'Enter') return;
        // Enter centres and selects the match IN the drawing on screen;
        // Shift+Enter is the explicit "open its neighbourhood" command.
        const choice = search.commit({ optionCount: searchOptionCount, drill: event.shiftKey });
        if (choice !== null) event.preventDefault();
        applySearchChoice(choice);
      }}
      className={`rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
        compactToolbar ? 'w-full text-sm' : 'w-40'
      }`}
    />
    {projectSearch.search.status === 'loading' && (
      <span
        data-architecture-search-loading="true"
        aria-hidden="true"
        className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground"
      />
    )}
    {/* While the query debounce is armed the matches for the NEW text are not
        ranked yet; drawing the listbox then would show an empty list a frame
        before its rows exist. The list is held back until the query settles. */}
    {searchOpen && !searchPending && searchQuery.trim().length > 0 && (
      <div
        id={searchListId}
        role="listbox"
        aria-label={t('architecture.search.label', { defaultValue: 'Search entities or files' })}
        data-architecture-search-results="true"
        className="absolute left-0 top-full z-30 mt-1 max-h-72 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
      >
        <p
          data-architecture-search-group="in-graph"
          className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {t('architecture.search.inGraph', { defaultValue: 'In the graph' })}
        </p>
        {searchMatches.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            {t('architecture.search.noMatches', { defaultValue: 'No matches' })}
          </p>
        ) : (
          searchMatches.map((match, index) => (
            <div
              key={match.node.id}
              id={searchOptionId(index)}
              role="option"
              aria-selected={activeSearchIndex === index}
              data-architecture-search-option-index={index}
              data-architecture-search-in-graph={match.inGraph}
              className="flex w-full items-start justify-between gap-1 rounded px-2 py-1 text-left text-[11px] text-foreground hover:bg-accent"
            >
              <button
                type="button"
                data-architecture-search-result={match.node.id}
                data-architecture-search-in-range={match.inRange}
                onClick={() => {
                  if (!match.inGraph) {
                    showHiddenSearchMatch(match);
                    return;
                  }
                  // A plain choose centres/selects in the drawing on screen;
                  // the secondary button below is the drill command.
                  revealNode(match.node.id, !match.inRange, false);
                }}
                className="flex min-w-0 flex-1 items-start justify-between gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                {/* The name wraps instead of truncating: it is how a reader
                    tells two similar results apart. */}
                <span data-architecture-search-result-name="true" className="min-w-0 break-words">
                  {match.node.label}
                </span>
                {!match.inGraph ? (
                  <span
                    data-architecture-search-hidden-reason="true"
                    className="shrink-0 text-amber-600 dark:text-amber-400"
                  >
                    {t('architecture.search.hiddenByFilter', { defaultValue: 'Hidden by the current filter' })}
                  </span>
                ) : !match.inRange ? (
                  <span className="shrink-0 text-amber-600 dark:text-amber-400">
                    {t('architecture.search.outOfRange', { defaultValue: 'Not in current range' })}
                  </span>
                ) : null}
              </button>
              {match.inGraph ? (
                <button
                  type="button"
                  aria-label={t('architecture.search.viewNeighbourhood', {
                    defaultValue: 'View neighbourhood of {{name}}',
                    name: match.node.label,
                  })}
                  data-architecture-search-neighbourhood={match.node.id}
                  onClick={() => revealNode(match.node.id, !match.inRange, true)}
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {t('architecture.search.viewNeighbourhoodShort', { defaultValue: 'Neighbourhood' })}
                </button>
              ) : (
                <button
                  type="button"
                  data-architecture-search-show={match.node.id}
                  onClick={() => showHiddenSearchMatch(match)}
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {t('architecture.search.showIt', { defaultValue: 'Show it' })}
                </button>
              )}
            </div>
          ))
        )}

        {canCurate && searchQuery.trim().length >= 2 && (
          <>
            <p
              data-architecture-search-group="project"
              className="mt-1 flex flex-wrap items-baseline gap-1 border-t border-border/60 px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              <span>{t('architecture.search.other', { defaultValue: 'Elsewhere in the project' })}</span>
              {/* Said ONCE, here, instead of on every row: a row repeated the
                  sentence and the repetition is what pushed the names so
                  narrow that they were cut to a few characters. */}
              {projectSearch.search.status === 'ready'
                && projectSearch.search.results.some((hit) => !activeNodeIds.has(hit.id)) && (
                <span
                  data-architecture-search-project-missing-note="true"
                  // Sentence case: this is a sentence, not a section title.
                  className="font-normal normal-case tracking-normal text-amber-600 dark:text-amber-400"
                >
                  {t('architecture.search.notInGraph', { defaultValue: 'Not in the current graph' })}
                </span>
              )}
            </p>
            {projectSearch.search.status === 'error' ? (
              <div data-architecture-search-error="true" className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate">{projectSearch.search.message}</span>
                <button
                  type="button"
                  data-architecture-search-retry="true"
                  onClick={projectSearch.retry}
                  className="shrink-0 rounded border border-border px-1.5 py-0.5 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {t('architecture.search.retry', { defaultValue: 'Retry' })}
                </button>
              </div>
            ) : projectSearch.search.status === 'ready' ? (
              <>
                {projectSearch.search.results.length === 0 ? (
                  <p data-architecture-search-project-empty="true" className="px-2 py-1 text-[11px] text-muted-foreground">
                    {t('architecture.search.noMatches', { defaultValue: 'No matches' })}
                  </p>
                ) : (
                  projectSearch.search.results.map((hit, projectIndex) => {
                    const inCurrentGraph = activeNodeIds.has(hit.id);
                    return (
                      <div
                        key={hit.id}
                        id={searchOptionId(searchMatches.length + projectIndex)}
                        role="option"
                        aria-selected={activeSearchIndex === searchMatches.length + projectIndex}
                        data-architecture-search-project-result={hit.id}
                        data-architecture-search-project-in-graph={inCurrentGraph}
                        // Top-aligned: the name and the path are two lines, so
                        // the actions stay beside the FIRST line.
                        className="flex items-start gap-1 rounded px-2 py-1 text-[11px] text-foreground hover:bg-accent"
                      >
                        <span aria-hidden="true" className="mt-0.5 w-3 shrink-0 text-center text-muted-foreground">
                          {searchKindGlyph(hit.kind)}
                        </span>
                        {/* The name is NEVER truncated: a reader distinguishes
                            results by the class name (and its kind glyph), so
                            it wraps onto a second line when it does not fit.
                            The path goes UNDER it and, when it is too long,
                            loses its left-hand directories — the file name is
                            the part that identifies the row. */}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span
                            data-architecture-search-project-name="true"
                            className="break-words font-medium"
                          >
                            {hit.name}
                          </span>
                          <span
                            data-architecture-search-project-file="true"
                            dir="rtl"
                            title={hit.file}
                            className="block truncate text-left text-muted-foreground"
                          >
                            {hit.file}
                          </span>
                        </span>
                        {!inCurrentGraph && (
                          <button
                            type="button"
                            // The visible label stays "Show it"; the accessible
                            // name adds WHICH entity, reusing the same key (no
                            // new i18n entry for a sentence no locale owns).
                            aria-label={`${t('architecture.search.showIt', { defaultValue: 'Show it' })}: ${hit.name}`}
                            data-architecture-search-show={hit.id}
                            // Pinning is what "show it" means for a server-side
                            // hidden entity: the next reading carries it.
                            onClick={() => pinItem(hit)}
                            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                          >
                            {t('architecture.search.showIt', { defaultValue: 'Show it' })}
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={t('architecture.curation.pinNamed', { defaultValue: 'Pin {{name}}', name: hit.name })}
                          data-architecture-search-pin={hit.id}
                          onClick={() => pinItem(hit)}
                          className="shrink-0 rounded border border-border px-1.5 py-0.5 font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                        >
                          ＋
                        </button>
                      </div>
                    );
                  })
                )}
                {projectSearch.search.truncated && (
                  <p data-architecture-search-truncated="true" className="px-2 py-1 text-[10px] text-muted-foreground">
                    {t('architecture.search.truncated', {
                      defaultValue: 'Showing the first 20 — narrow the query.',
                    })}
                  </p>
                )}
              </>
            ) : null}
          </>
        )}
      </div>
    )}
  </div>
);

// The `已调整 N 项 ▾` trigger: N is the sum of the three lists. The manager
// itself lists every entry with a restore, so this is the one place a reader
// can audit and undo a whole page of adjustments after a reload.
const curationCount = curationState.pins.length
  + curationState.excluded.length
  + curationState.hiddenEdges.length;
const curationManagerButton = (
  <button
    ref={curationManagerButtonRef}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={curationManagerOpen}
    disabled={!canCurate}
    title={canCurate
      ? undefined
      : t('architecture.curation.noSession', {
          defaultValue: 'Manual adjustments need a session: they are stored per session.',
        })}
    onClick={() => curation.setManagerOpen(!curationManagerOpen)}
    data-architecture-curation-manager-toggle="true"
    data-architecture-curation-count={curationCount}
    style={compactTargetStyle}
    className={`rounded-lg border border-border font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40 ${
      compactToolbar ? 'px-3 py-2 text-left text-sm' : 'px-2 py-0.5 text-xs'
    }`}
  >
    {t('architecture.curation.managerButton', {
      defaultValue: 'Adjusted {{count}} ▾',
      count: curationCount,
    })}
  </button>
);

// `?` used to open the legend: the place the two duplicated hover
// instructions and the meaning of every line, arrow, stereotype, seed marker
// and folded badge now live. On the desktop row it is now an entry in the
// `⋯` overflow (see `overflowMenu`) rather than a top-level button; the
// popover below is unchanged.

// The drawing's own seed reading, so the legend states the light marker
// exactly when the drawing uses it (seeds at half the drawn entities or
// more stop discriminating as a thick frame).
const seedMarkerIsLight = seedMarkerMode(drawnGraph.nodes) === 'light';
// The legend body names every visual vocabulary the drawing uses, including
// the text form of the old circular fold badge (`+N folded`). It is drawn in
// the desktop `?` popover and, on the compact tier, directly inside the
// bottom sheet (the sheet is the one place the phone's readings live).
const legendBody = (
  <div
    data-architecture-legend-content="true"
    className="whitespace-pre-line text-[11px] text-muted-foreground"
  >
    {/* The line-style and arrow vocabulary as PICTURES, not just the letters
        the old body printed (which used `△` for both inheritance and
        implementation and said "● seed" for an orange frame). */}
    <div
      data-architecture-legend-swatches="true"
      className="mb-1 grid grid-cols-3 gap-x-2 gap-y-1 not-italic"
    >
      {['association', 'dependency', 'inheritance', 'implementation', 'composition', 'aggregation', 'stereotype', 'seed', 'folded'].map((glyph) => (
        <LegendSwatch key={glyph} glyph={glyph} />
      ))}
    </div>
    {t('architecture.legend.body', {
      defaultValue:
        'Solid line: association or call.\nDashed line: dependency or implementation.\nArrows: △ inheritance · △ implementation · ◆ composition · ◇ aggregation · → dependency.\n«stereotype» marks the entity kind.\n● seed: named in this session.\n+N folded: hidden by the current detail level.',
    })}
    {seedMarkerIsLight && (
      <>
        {'\n'}
        {t('architecture.legend.seedLight', {
          defaultValue: 'Many seeds: they are marked with a thin frame and a small dot.',
        })}
      </>
    )}
  </div>
);

const legend = (
  <div
    data-architecture-legend="true"
    role="dialog"
    aria-label={t('architecture.legend.title', { defaultValue: 'Legend' })}
    className="absolute right-2 top-11 z-40 w-80 rounded-lg border border-border bg-popover p-3 text-[11px] text-muted-foreground shadow-lg"
  >
    {legendBody}
  </div>
);


  return {
    filterContent,
    filterDisclosure,
    searchBox,
    curationManagerButton,
    legendBody,
    legend,
  };
}
