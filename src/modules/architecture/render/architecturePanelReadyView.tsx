/**
 * The panel's READY tree: the arrangement of the toolbar, the readout, the canvas
 * region, the dock and the dialogs, drawn once the graph is loaded.
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * This is a real component (not a builder) because it calls the compose/export
 * action hook: a hook may only run on the ready branch, so the branch decision
 * stays one level up in `architecturePanelShell.tsx`.
 */

import { TOUCH_CONTROL_GAP_PX } from '@/modules/architecture/hooks/useTouchLayout';
import { ArchitectureCurationManager, CurationToast } from '@/modules/architecture/render/curation';
import { ArchitectureDock, ArchitectureSheet } from '@/modules/architecture/render/viewport';
import {
  ArchitectureInspector,
  ArchitectureTextPanel,
} from '@/modules/architecture/render/inspector';
import { ArchitectureRefreshDialog } from '@/modules/architecture/render/ArchitectureRefreshDialog';

import { useArchitecturePanelActions, type ArchitecturePanelActions } from '@/modules/architecture/render/useArchitecturePanelActions';
import { ArchitecturePanelCanvas } from '@/modules/architecture/render/architecturePanelCanvas';
import { panelToolbarFragments } from '@/modules/architecture/render/architecturePanelToolbar';
import { panelGroupFragments } from '@/modules/architecture/render/architecturePanelGroups';
import { panelFilterFragments } from '@/modules/architecture/render/architecturePanelFilters';
import { panelReadoutFragments } from '@/modules/architecture/render/architecturePanelReadout';
import { panelMobileChromeFragments } from '@/modules/architecture/render/architecturePanelMobileChrome';
import { nodeIdShapeOf } from '@/modules/architecture/render/architecturePanelShared';
import type { ArchitecturePanelScope } from '@/modules/architecture/render/ArchitecturePanel';

/** The ready arm of the panel model. */
type ReadyScope = Extract<ArchitecturePanelScope, { branch: 'ready' }>;

/** Render the loaded panel. */
export function ArchitecturePanelReadyView({ model }: { readonly model: ReadyScope }) {
  const actions = useArchitecturePanelActions({
    t: model.t,
    i18n: model.i18n,
    projectId: model.projectId,
    projectName: model.projectName ?? null,
    sessionId: model.sessionId,
    standalone: model.standalone,
    ...(model.onOpenChat === undefined ? {} : { onOpenChat: model.onOpenChat }),
    granularity: model.granularity,
    diagramView: model.diagramView,
    selections: model.selections,
    drawnGraph: model.drawnGraph,
    provenance: model.provenance,
    mmd: model.mmd,
    search: model.search,
    fitExport: model.fitExport,
    exportStatus: model.exportStatus,
    hideRelation: model.hideRelation,
    removeNode: model.removeNode,
    showCurationToast: model.showCurationToast,
    dispatchSelection: model.dispatchSelection,
  });
  const panelScope: ReadyScope & ArchitecturePanelActions = { ...model, ...actions };

  const toolbar = panelToolbarFragments(panelScope);
  const groups = panelGroupFragments(panelScope);
  const filters = panelFilterFragments(panelScope);
  const readoutFragments = panelReadoutFragments(panelScope);
  const {
    exportMenu,
    overflowMenu,
    textToggle,
    fullscreenButton,
    fullscreenToolbarButton,
    adjustButton,
    openInNewTabButton,
    openInNewTabToolbarButton,
    openInNewTabSheetButton,
  } = toolbar;
  const { granularityGroup, scopeGroup, detailGroup } = groups;
  const { filterContent, filterDisclosure, searchBox, curationManagerButton, legendBody, legend } = filters;
  const { sourceFooter, readoutPanel } = readoutFragments;
  const mobileChrome = panelMobileChromeFragments(panelScope);
  const { sidebarCollapseButton, shortTouchReadoutToggle, shortTouchPanelTray } = mobileChrome;
  const {
    canComposeSelection,
    canCurate,
    canCurateEntities,
    changeFilter,
    chrome,
    clearCurationItem,
    closeDock,
    compactToolbar,
    composeSelectionText,
    copyFallbackText,
    copyFallbackTextareaRef,
    curation,
    curationCanUndo,
    curationManagerOpen,
    curationState,
    curationToast,
    diagramView,
    dispatchSelection,
    dockOpen,
    dockSummary,
    dockTab,
    dockTier,
    drawnGraph,
    drawnPlantUml,
    exportStatusText,
    fillsViewport,
    filter,
    fitExport,
    fullscreen,
    granularity,
    hasSeeds,
    hiddenReading,
    hideRelation,
    includeToolResults,
    inspectRelatedNode,
    onOpenChat,
    panelRootRef,
    pauseCurationToast,
    pinNode,
    pinnedIdSet,
    portraitPhone,
    projectId,
    projectName,
    provenance,
    putSelectionInChat,
    readoutOpen,
    refresh,
    refreshDialogOpen,
    refreshDialogReturnFocusRef,
    refreshFailureReason,
    removeNode,
    restoreEdge,
    restoreGroup,
    restoreItem,
    resumeCurationToast,
    search,
    selectedNodeId,
    selection,
    selections,
    sessionId,
    sessionTitle,
    settings,
    sheetOpen,
    sheetTriggerRef,
    shortTouch,
    soloNodeId,
    standalone,
    standaloneBackButton,
    t,
    textFilterSummary,
    textViewLabel,
    undoCuration,
    unpinNode,
  } = panelScope;



return (
  <div
    ref={panelRootRef}
    // A programmatic focus target for the no-canvas (empty state) reading;
    // the drawing region is preferred whenever it exists.
    tabIndex={-1}
    data-architecture-panel="true"
    data-architecture-fullscreen={fullscreen.active ? 'true' : undefined}
    data-architecture-standalone={standalone ? 'true' : undefined}
    data-architecture-viewport-fill={fillsViewport ? 'true' : undefined}
    // The overlay is the SAME element the panel always renders: `fixed;
    // inset: 0` restyles it in place, which is what lets the renderer keep
    // its zoom and the panel keep every reading through the toggle. The
    // standalone page starts in this geometry because it has no shell.
    style={fillsViewport ? { position: 'fixed', inset: 0, zIndex: 60 } : undefined}
    className={
      fillsViewport
        ? 'flex flex-col overflow-hidden bg-background outline-none'
        : 'relative flex h-full flex-col overflow-hidden'
    }
  >
    {/* The one-off touch bubble's own fade. It is keyed CSS (not a JS timer)
        so the dismissal runs off the animation end even in a background tab,
        and a test can drive it with a single animation event. */}
    <style>{'@keyframes architecture-touch-hint-fade { 0%, 70% { opacity: 1; } 100% { opacity: 0; } }'}</style>
    <div
      data-architecture-toolbar="true"
      data-architecture-toolbar-short-touch={shortTouch ? 'true' : undefined}
      data-architecture-toolbar-portrait={portraitPhone ? 'true' : undefined}
      // On the overlay the compact row is ONE 56px line (a 44px target plus
      // the row's 2×6px padding): `nowrap` and the stated height are the
      // contract that keeps a second row from covering the drawing again.
      // The landscape-phone tier states the same `nowrap` contract at 52px
      // (a 44px target plus the row's 2×4px padding), because its scarce axis
      // is height and a wrapped second row would cost the drawing ~44px. The
      // portrait tier states it at 56px: its scarce axis is WIDTH, but the row
      // it replaces wrapped into two 56px bands, so the pinned height is what
      // buys the 12.5% of the viewport the canvas share is read against.
      style={
        compactToolbar
          ? fullscreen.active
            ? { gap: TOUCH_CONTROL_GAP_PX, height: 56, flexWrap: 'nowrap' }
            : shortTouch
              ? { gap: TOUCH_CONTROL_GAP_PX, height: 52, flexWrap: 'nowrap' }
              : portraitPhone
                ? { gap: TOUCH_CONTROL_GAP_PX, height: 56, flexWrap: 'nowrap' }
                : { gap: TOUCH_CONTROL_GAP_PX }
          : undefined
      }
      // Over the overlay the row is chrome ON TOP of a viewport-sized
      // drawing, not a band that shortens it. Otherwise the row WRAPS rather
      // than scrolls: `overflow-x: auto` also makes the block axis a scroll
      // container, which clipped every absolutely positioned child — the
      // search results were cut to a 3px line. Wrapping keeps the popovers in
      // normal paint flow, and the desktop row still fits one line at its
      // breakpoint (it only wraps when the width really runs out, which is
      // preferable to hiding controls in a scroller).
      className={`relative flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 ${
        shortTouch && !fullscreen.active ? 'py-1' : 'py-1.5'
      } ${fillsViewport ? 'relative z-40 bg-background' : ''}`}
    >
      {compactToolbar ? (
        fullscreen.active ? (
          // The overlay keeps ONE row: leaving, and the one menu the view
          // switch and Text page moved into. Everything else would be a
          // second row over the drawing's top edge.
          <>
            {standaloneBackButton}
            <span className="flex-1" />
            {openInNewTabButton}
            {fullscreenButton}
            {adjustButton}
          </>
        ) : portraitPhone ? (
          // The portrait-phone row: the view switch, the Text door and the
          // one Adjust menu. Fullscreen and "Open in new tab" live INSIDE
          // that sheet (see the Adjust section below) because a second entry
          // is exactly what wrapped this row in the pre-task chrome. The
          // standalone page's Back door travels with them for the same
          // reason: it is a fifth 44px target otherwise.
          <>
            {granularityGroup}
            <span className="flex-1" />
            {textToggle}
            {adjustButton}
          </>
        ) : shortTouch ? (
          // The landscape-phone row: the view switch, the one-line summary
          // (expanding into the readout above the drawing), the Text door and
          // the one Adjust menu. Fullscreen and export move INTO that menu —
          // the design's "remaining controls live in Adjust".
          <>
            {standaloneBackButton}
            {granularityGroup}
            <span className="flex-1" />
            {shortTouchReadoutToggle}
            {openInNewTabButton}
            {textToggle}
            {adjustButton}
          </>
        ) : (
          <>
            {standaloneBackButton}
            {granularityGroup}
            <span className="flex-1" />
            {openInNewTabButton}
            {textToggle}
            {fullscreenButton}
            {adjustButton}
          </>
        )
      ) : (
        <>
          {standaloneBackButton}
          <h3 className="shrink-0 text-sm font-semibold text-foreground">
            {t('architecture.title', { defaultValue: 'Architecture' })}
          </h3>
          {granularityGroup}
          {scopeGroup}
          {detailGroup}
          {filterDisclosure}
          {searchBox}
          {curationManagerButton}
          <span className="flex-1" />
          {openInNewTabToolbarButton}
          {textToggle}
          {fullscreenToolbarButton}
          {overflowMenu}
        </>
      )}
      {/* The landscape-phone summary's expansion. It is an overlay anchored
          under the toolbar (not an in-flow row): opening it must not take
          height from the drawing the reader is inspecting, and closing it
          must return that height untouched. The provenance footer, which is a
          document-flow row on the other tiers, travels WITH the summary here
          — the short tier has no room for a standing footer. */}
      {shortTouch && readoutOpen && (
        <div
          data-architecture-readout-popover="true"
          className="absolute left-0 right-0 top-full z-50 max-h-[70vh] overflow-y-auto border-b border-border/60 bg-background shadow-lg"
        >
          {readoutPanel}
          {sourceFooter}
        </div>
      )}
    </div>

    {!canCurate && (
      <p
        role="status"
        data-architecture-curation-disabled="true"
        className="shrink-0 border-b border-border/60 px-3 py-1 text-[10px] text-muted-foreground"
      >
        {t('architecture.curation.noSession', {
          defaultValue: 'Manual adjustments need a session: they are stored per session.',
        })}
      </p>
    )}

    {/* The export reading lives outside the menu so it survives the menu
        closing: success, a downscale notice, or a failure is announced to
        screen readers without moving focus. */}
    <span role="status" aria-live="polite" data-architecture-export-status="true" className="sr-only">
      {exportStatusText}
    </span>

    {copyFallbackText !== null && (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('architecture.export.copyFallbackTitle', { defaultValue: 'Copy PlantUML manually' })}
        data-architecture-export-fallback="true"
        className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
      >
        <div className="w-full max-w-lg rounded-lg border border-border bg-popover p-4 shadow-xl">
          <p className="text-sm text-foreground">
            {t('architecture.export.copyFallbackHint', {
              defaultValue: 'Clipboard access is unavailable. Select and copy the text below.',
            })}
          </p>
          <textarea
            ref={copyFallbackTextareaRef}
            readOnly
            value={copyFallbackText}
            aria-label={t('architecture.export.plantUml', { defaultValue: 'PlantUML (.puml)' })}
            data-architecture-export-fallback-text="true"
            className="mt-2 h-48 w-full resize-none rounded border border-border bg-background p-2 font-mono text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={fitExport.dismissCopyFallback}
              data-architecture-export-fallback-close="true"
              className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.export.close', { defaultValue: 'Close' })}
            </button>
          </div>
        </div>
      </div>
    )}

    {compactToolbar && (
      <ArchitectureSheet
        open={sheetOpen}
        title={t('architecture.sheet.title', { defaultValue: 'Adjust' })}
        closeLabel={t('architecture.sheet.close', { defaultValue: 'Close adjust panel' })}
        handleLabel={t('architecture.sheet.dragHandle', { defaultValue: 'Drag to close' })}
        onClose={() => chrome.setSheetOpen(false)}
        returnFocusRef={sheetTriggerRef}
      >
        {/* Every group in the sheet is LABELLED. The unlabelled version made
            the reader read `Filter ▾` as a section title and the `− +2 +`
            stepper as an unlabelled mystery; the titles are the same words
            the desktop toolbar's tooltips use. */}
        <section data-architecture-sheet-view="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('architecture.sheet.view', { defaultValue: 'View' })}
          </span>
          {/* In the overlay the one toolbar row keeps only Exit fullscreen and
              Adjust, so the view switch and the Text page move in here. */}
          {fullscreen.active && (
            <div className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
              {granularityGroup}
              {textToggle}
            </div>
          )}
          {/* The landscape-phone toolbar keeps only the view switch, the
              summary, Text and Adjust, so the overlay entry and the shell's
              sidebar-collapse entry live here. The collapse button invokes
              the control the shell header already renders; the architecture
              module does not own or change the sidebar. */}
          {shortTouch && !fullscreen.active && (
            <div className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
              {fullscreenButton}
              {sidebarCollapseButton}
            </div>
          )}
          {/* The portrait row keeps only the view switch, Text and Adjust, so
              the entries it gave up live here: the standalone Back door, the
              second-screen door and the fullscreen overlay. */}
          {portraitPhone && !fullscreen.active && (
            <div className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
              {standaloneBackButton}
              {openInNewTabSheetButton}
              {fullscreenButton}
            </div>
          )}
          {/* The renderer's own view chrome (tier, scale, readable mode, Back,
              Drill in) is portaled in here; on the compact tier the sheet is
              the one menu, so those entries do not spend a second canvas row. */}
          <div
            ref={chrome.setCanvasHeaderHost}
            data-architecture-sheet-view-controls="true"
            className="flex flex-col"
            style={{ gap: TOUCH_CONTROL_GAP_PX }}
          />
        </section>
        <section data-architecture-sheet-scope="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('architecture.sheet.scope', { defaultValue: 'Scope' })}
          </span>
          {scopeGroup}
        </section>
        <section data-architecture-sheet-detail="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('architecture.sheet.detail', { defaultValue: 'Detail' })}
          </span>
          {detailGroup}
        </section>
        <section data-architecture-sheet-filter="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('architecture.sheet.filter', { defaultValue: 'Filter' })}
          </span>
          {filterContent}
        </section>
        {searchBox}
        {curationManagerButton}
        <section data-architecture-sheet-export="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('architecture.sheet.export', { defaultValue: 'Export' })}
          </span>
          {exportMenu}
        </section>
        <section data-architecture-sheet-legend="true" className="flex flex-col" style={{ gap: TOUCH_CONTROL_GAP_PX }}>
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('architecture.legend.title', { defaultValue: 'Legend' })}
          </span>
          {legendBody}
        </section>
        {/* The renderer's remaining controls (view label, export) are drawn
            inside the same sheet at the same 44px targets. */}
        <div
          ref={chrome.setSheetControlsHost}
          data-architecture-compact-graph-controls="true"
          className="flex flex-col border-t border-border/60 pt-2"
          style={{ gap: TOUCH_CONTROL_GAP_PX }}
        />
      </ArchitectureSheet>
    )}

    {/* The panel's remaining height is one flex COLUMN whose single child is
        the row below it: every `flex-1` and `h-full` further down resolves
        against a flex parent with a definite height only while that direct
        child stays a column (the canvas layout contract walks this chain). */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Inside it, the canvas and the dock share one flex ROW: opening the dock
          takes width from the drawing (320px) instead of covering it, which is
          why its open/close has to freeze aspect re-layout. On a coarse pointer
          the dock renders itself as an absolutely positioned bottom drawer
          inside this relative parent. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <ArchitecturePanelCanvas model={panelScope} legend={legend} readoutPanel={readoutPanel} />

    {hasSeeds && (
      // `contents` keeps the dock a direct flex item on the normal layout.
      // On the overlay it becomes a floating right-hand column instead: the
      // inspector/text pages overlay the drawing rather than narrowing it.
      // The coarse tier already draws its own bottom drawer, so only the
      // fine-pointer dock is wrapped.
      <div
        data-architecture-fullscreen-dock={
          fillsViewport && dockTier !== 'drawer' ? 'true' : undefined
        }
        className={
          fillsViewport && dockTier !== 'drawer'
            ? 'absolute inset-y-0 right-0 z-40 flex max-h-full flex-col'
            : 'contents'
        }
      >
      <ArchitectureDock
        open={dockOpen}
        tier={dockTier}
        panelHeader={shortTouchPanelTray}
        title={t('architecture.dock.title', { defaultValue: 'Inspector' })}
        closeLabel={t('architecture.dock.close', { defaultValue: 'Close inspector' })}
        returnFocusRef={search.canvasRegionRef}
        tabs={[
          {
            id: 'inspector',
            label: t('architecture.dock.title', { defaultValue: 'Inspector' }),
            content: selection === null ? (
              <p data-architecture-dock-empty="true" className="text-xs text-muted-foreground">
                {t('architecture.dock.empty', {
                  defaultValue: 'Select a node or a relation on the drawing.',
                })}
              </p>
            ) : selections.length > 1 ? (
              // A multi-selection has no single entity/relation detail to
              // show; the open-ended work belongs in the tray, so the
              // inspector states the count instead of picking a member.
              <div className="flex flex-col items-start gap-1">
                <p
                  data-architecture-inspector-summary={selections.length}
                  className="text-xs text-muted-foreground"
                >
                  {t('architecture.inspector.selectedCount', {
                    defaultValue: '{{count}} selected',
                    count: selections.length,
                  })}
                </p>
                {/* The same action the tray carries, with the count in its
                    label, so a multi-selection can be sent without expanding
                    the tray first. */}
                <button
                  type="button"
                  data-architecture-inspector-put-count-in-chat={selections.length}
                  disabled={!canComposeSelection}
                  onClick={putSelectionInChat}
                  className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('architecture.curation.putCountInChat', {
                    defaultValue: 'Put {{count}} in chat input',
                    count: selections.length,
                  })}
                </button>
              </div>
            ) : (
              <ArchitectureInspector
                selection={selection}
                graph={drawnGraph}
                idShape={nodeIdShapeOf(granularity)}
                projectId={projectId}
                sessionId={sessionId}
                includeToolResults={includeToolResults}
                onIncludeToolResultsChange={settings.setIncludeToolResults}
                onSelectNode={(nodeId) => dispatchSelection({ type: 'select-entity', nodeId })}
                onCenterNode={inspectRelatedNode}
                onOpenChat={onOpenChat}
                canCurate={canCurateEntities}
                pinned={selectedNodeId !== null && pinnedIdSet.has(selectedNodeId)}
                onPinNode={pinNode}
                onUnpinNode={unpinNode}
                onRemoveNode={removeNode}
                onHideRelation={hideRelation}
                // The tray's action, offered in the inspector; the panel's
                // compose handler is the one both call.
                {...(canComposeSelection ? { onPutInChat: putSelectionInChat } : {})}
                {...(hiddenReading.byNodeRelations === undefined
                  ? {}
                  : { hiddenRelations: hiddenReading.byNodeRelations })}
                // Widening: the preset that includes every relation type, so
                // a hidden call/structure edge is drawn again.
                onShowRelationType={() => changeFilter({ ...filter, relations: 'call' })}
              />
            ),
          },
          {
            id: 'text',
            label: t('architecture.text.tab', { defaultValue: 'Text' }),
            content: (
              <ArchitectureTextPanel
                graph={drawnGraph}
                drawn={drawnPlantUml}
                idShape={nodeIdShapeOf(granularity)}
                granularity={granularity}
                view={diagramView}
                grouping={granularity === 'file' ? 'adaptive' : 'raw'}
                selection={selection}
                projectId={projectId}
                sessionId={sessionId}
                projectName={projectName}
                sessionTitle={sessionTitle}
                analyzedAt={provenance.generatedAt}
                viewLabel={textViewLabel}
                filterSummary={textFilterSummary}
                canvasRef={search.canvasRegionRef}
                // The text scope's own body, appended by the same compose
                // handler the selection tray uses.
                {...(canComposeSelection ? { onPutInChat: composeSelectionText } : {})}
              />
            ),
          },
        ]}
        activeTabId={dockTab}
        onTabChange={(tabId) => chrome.setDockTab(tabId === 'text' ? 'text' : 'inspector')}
        onClose={closeDock}
        collapsedSummary={dockSummary}
        onTouchDrawerHeightChange={chrome.setDrawerHeight}
        snapLabels={{
          collapsed: t('architecture.dock.snapCollapsed', { defaultValue: 'Collapsed' }),
          half: t('architecture.dock.snapHalf', { defaultValue: 'Half' }),
          full: t('architecture.dock.snapFull', { defaultValue: 'Full' }),
        }}
      />
      </div>
    )}

    <ArchitectureCurationManager
      open={curationManagerOpen}
      onClose={() => curation.setManagerOpen(false)}
      state={curationState}
      canEdit={canCurate}
      onRestoreItem={restoreItem}
      onRestoreEdge={restoreEdge}
      onRestoreGroup={restoreGroup}
      onRestoreAll={() => curation.restoreAll()}
      onClearItem={clearCurationItem}
      // The Toast's Undo, offered in the popover header once the Toast is
      // gone; `undoCuration` is the one handler both entry points call.
      canUndo={curationCanUndo}
      onUndo={undoCuration}
    />

    {soloNodeId !== null && (
      <button
        type="button"
        data-architecture-curation-solo-clear="true"
        onClick={() => curation.setSoloNodeId(null)}
        className="absolute left-1/2 top-2 z-40 -translate-x-1/2 rounded-full border border-border bg-popover px-2 py-0.5 text-[11px] font-medium text-foreground shadow-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {t('architecture.curation.soloClear', { defaultValue: 'Show the whole graph' })}
      </button>
    )}

    {curationToast !== null && (
      <CurationToast
        toast={curationToast}
        undoLabel={t('architecture.curation.undo', { defaultValue: 'Undo' })}
        onUndo={undoCuration}
        onPause={pauseCurationToast}
        onResume={resumeCurationToast}
      />
    )}

    {/* The confirmation / running / failure dialog for the manual re-analysis.
        Escape is captured by the dialog so the chat page's abort never fires;
        the job itself is server-side and keeps running if the dialog closes. */}
    <ArchitectureRefreshDialog
      open={refreshDialogOpen}
      phase={
        refresh.status.state === 'running'
          ? 'running'
          : refresh.status.state === 'failed'
            ? 'failed'
            : 'confirm'
      }
      elapsedMs={refresh.elapsedMs}
      error={refreshFailureReason}
      onClose={fitExport.closeRefreshDialog}
      onStart={refresh.start}
      returnFocusRef={refreshDialogReturnFocusRef}
    />
    </div>
    {/* The provenance/cleanup row is the panel's FOOTER: in the document
        flow BELOW the canvas (and the dock), never a pill over the drawing.
        The canvas therefore keeps only the minimap and the zoom cluster as
        floating corner chrome. The landscape-phone tier has no standing
        footer: its reading travels inside the toolbar summary's expansion,
        which is the row that buys the drawing the 44px the footer would cost
        on a 390px-tall viewport. */}
    {!shortTouch && sourceFooter}
    </div>
  </div>
);
}


