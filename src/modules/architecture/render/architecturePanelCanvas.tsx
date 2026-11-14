/**
 * The panel CANVAS region: the drawing, its empty states, the in-flow dock row and
 * the floating overlays (selection tray, hover hint, zoom/hint chrome).
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * The legend is a sibling fragment, so it arrives as a prop rather than through
 * the panel model.
 */
import { HOVER_HINT_MARGIN_PX } from '@/modules/architecture/dom/hoverHintPlacement';
import { CanvasHeaderSlotContext, CompactToolbarSlotContext } from '@/modules/architecture/hooks/useTouchLayout';
import { ArchitectureEmptyState } from '@/modules/architecture/render/ArchitectureEmptyState';
import { ArchitectureSelectionTray } from '@/modules/architecture/render/inspector';
import { nodeIdShapeOf } from '@/modules/architecture/render/architecturePanelShared';
import type { ArchitecturePanelActions } from '@/modules/architecture/render/useArchitecturePanelActions';
import type { ArchitecturePanelScope } from '@/modules/architecture/render/ArchitecturePanel';

/** The ready arm of the panel model. */
type ReadyScope = Extract<ArchitecturePanelScope, { branch: 'ready' }> & ArchitecturePanelActions;

/** One canvas region, drawn from the panel model. */
export function ArchitecturePanelCanvas({
  model,
  legend,
  readoutPanel,
}: {
  readonly model: ReadyScope;
  readonly legend: React.ReactNode;
  readonly readoutPanel: React.ReactNode;
}) {
  const {
    addBoxSelection,
    alternateGranularity,
    alternateTotal,
    canComposeSelection,
    canCurateEntities,
    canvasHeaderHost,
    changeGranularity,
    chrome,
    clearSelectionOnCanvas,
    coarsePointer,
    compactTargetStyle,
    compactToolbar,
    composeSelectionText,
    curation,
    detailRanking,
    detailReading,
    diagramView,
    dismissTouchHint,
    dockLayoutLocked,
    dockOpen,
    dockTier,
    drawnEmpty,
    drawnGraph,
    drawnPlantUml,
    emptyViewMessage,
    escapeSelection,
    fillsViewport,
    fitExport,
    fitRequest,
    focusTarget,
    fullscreen,
    granularity,
    handleCanvasFullscreenKey,
    handleNodeHover,
    hasSeeds,
    hideRelation,
    hoverHintPosition,
    hoverHintText,
    hoverReading,
    hoverVisible,
    layoutFit,
    legendOpen,
    multiSelectMode,
    neighbourhood,
    pinNode,
    pinnedIds,
    projectId,
    projectName,
    provenance,
    putNodeInChat,
    readoutRowRef,
    refreshing,
    removeNode,
    removeSelected,
    resolvedDiffHighlight,
    scope,
    search,
    selectNodeOnCanvas,
    selectRelationOnCanvas,
    selectedNodeId,
    selectedNodeIds,
    selectedRelation,
    selectedRelations,
    selections,
    sessionId,
    sheetControlsHost,
    shortTouch,
    startMultiSelect,
    t,
    toggleNodeOnCanvas,
    Renderer,
    toggleRelationOnCanvas,
    toggleSelection,
    topChromePx,
    touchDrawerHeight,
    touchHintDismissed,
    trayExpanded,
    undoCuration,
    unpinNode,
    visibleHover,
  } = model;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {hasSeeds ? (
        drawnEmpty ? (
          // Seeds resolved, but this granularity has nothing to draw. The
          // toolbar above keeps the granularity radios, so the switch here is
          // a shortcut, not the only way out of the blank canvas.
          <ArchitectureEmptyState
            message={emptyViewMessage}
            action={
              alternateTotal > 0 ? (
                <button
                  type="button"
                  data-architecture-empty-switch={alternateGranularity}
                  onClick={() => changeGranularity(alternateGranularity)}
                  style={compactTargetStyle}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {alternateGranularity === 'file'
                    ? t('architecture.emptyView.viewFileGraph', {
                      defaultValue: 'View the file graph ({{count}} files)',
                      count: alternateTotal,
                    })
                    : t('architecture.emptyView.viewEntityGraph', {
                      defaultValue: 'View the class diagram ({{count}} entities)',
                      count: alternateTotal,
                    })}
                </button>
              ) : undefined
            }
          />
        ) : (
        <>
          {/* Desktop keeps its in-flow row: the readout on the left, the
              renderer's zoom tier and scale on the right. The compact tier
              has no such row — its readout floats on the drawing and the
              renderer's view chrome is portaled into the bottom sheet. */}
          {!compactToolbar && (
            <div
              ref={readoutRowRef}
              data-architecture-canvas-header="true"
              // Floats above the overlay's viewport-sized drawing instead of
              // taking a band from it (see the graph region below).
              className={`flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1 ${
                fillsViewport ? 'relative z-30 bg-background' : ''
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1">{readoutPanel}</div>
              <div
                ref={chrome.setCanvasHeaderHost}
                data-architecture-canvas-header-actions="true"
                className="flex min-w-0 max-w-[65%] shrink-0 flex-nowrap items-center justify-end gap-1"
              />
            </div>
          )}
          {/* The compact tier's readout is an IN-FLOW row above the drawing,
              not a translucent card floating over its top-left corner (the
              card covered the drawing and collided with the corner chrome).
              It is marked as the canvas header so the layout contract treats
              it as chrome: the drawing's available height starts below it. */}
          {compactToolbar && (!shortTouch || fullscreen.active) && (
            <div
              ref={readoutRowRef}
              data-architecture-canvas-header="true"
              data-architecture-readout-overlay="true"
              className={`flex shrink-0 border-b border-border/60 px-3 py-1 ${
                fillsViewport ? 'relative z-30 bg-background' : ''
              }`}
            >
              {readoutPanel}
            </div>
          )}
          <div
            ref={search.canvasRegionRef}
            // Focus returns here when the dock closes (see ArchitectureDock's
            // focus management); a programmatic focus target needs a tabindex.
            tabIndex={-1}
            aria-busy={refreshing}
            data-architecture-refreshing={refreshing ? 'true' : undefined}
            data-architecture-canvas-region="true"
            // Which source the Text page and the Export menu will serialize:
            // the drawn model (complete, rendered with `detail: 'full'`) once
            // the renderer has reported one, or the local bridge before that.
            // The renderer nulls the model when a new drawing starts, so this
            // flips back to `bridge` for the duration of a re-render — a
            // reader (and a criterion) can wait for `drawn` instead of racing it.
            data-architecture-drawn-source={drawnPlantUml === null ? 'bridge' : 'drawn'}
            // The canvas region is an instrument, not prose: dragging it pans
            // and double-clicking drills, so neither gesture may paint a text
            // selection. Scoped to THIS region — the dock beside it (the
            // inspector and the Text page) stays fully selectable.
            style={{
              userSelect: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
            }}
            // `F` is the drawing's own shortcut while it owns the keyboard.
            onKeyDown={handleCanvasFullscreenKey}
            // On the overlay (and on the standalone page, which borrows the
            // same geometry) the REGION itself is viewport-sized: the toolbar
            // and readout rows above float over it with a higher z-index, so
            // "the drawing fills the screen" is literally its box, not a
            // share of the remaining column.
            className={
              fillsViewport
                ? `fixed inset-0 z-0 flex min-h-0 flex-col transition-opacity ${refreshing ? 'opacity-60' : ''}`
                : `relative flex min-h-0 flex-1 flex-col transition-opacity ${refreshing ? 'opacity-60' : ''}`
            }
          >
            {/* One-off, in-canvas instruction. It is an overlay bubble (not a
                row in the panel column), fades itself out after 3s, and the
                dismissal is remembered, so it can never become standing
                chrome. `role="status"` keeps it announceable. */}
            {compactToolbar && coarsePointer && !touchHintDismissed && (
              <div
                data-architecture-touch-hint="true"
                role="status"
                style={{
                  position: 'absolute',
                  right: 8,
                  top: 8,
                  zIndex: 30,
                  maxWidth: '55%',
                  animation: 'architecture-touch-hint-fade 3000ms ease forwards',
                }}
                onAnimationEnd={dismissTouchHint}
                className="pointer-events-auto flex items-start rounded-lg border border-border/60 bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm"
              >
                <span className="min-w-0 flex-1">
                  {t('architecture.plantuml.touchHintBubble', {
                    defaultValue: 'Drag with one finger to pan, pinch to zoom, double-tap a node to drill in.',
                  })}
                </span>
                <button
                  type="button"
                  aria-label={t('architecture.dismissHint', { defaultValue: 'Dismiss hint' })}
                  onClick={dismissTouchHint}
                  style={compactTargetStyle}
                  className="rounded border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  ×
                </button>
              </div>
            )}
            <CompactToolbarSlotContext.Provider value={sheetControlsHost}>
              <CanvasHeaderSlotContext.Provider value={canvasHeaderHost}>
                <Renderer
                  key={`${sessionId}:${granularity}:${scope}`}
                  graph={layoutFit?.graph ?? detailRanking?.graph ?? neighbourhood}
                  // The coarse drawer covers the canvas' bottom band while it
                  // is open; the drawing reserves that band and keeps the
                  // selected box above it. The landscape side column is in
                  // flow, so it covers nothing and reserves nothing. The one
                  // exception is the criterion's DEV drawer override: there
                  // the point IS that the restored overlay covers the drawing,
                  // so no band is reserved (reserving it would hide the
                  // defect the control arm exists to measure).
                  bottomObscuredPx={
                    dockTier === 'drawer' && dockOpen && !shortTouch ? touchDrawerHeight : 0
                  }
                  // On the overlay the chrome is painted OVER the viewport-
                  // sized canvas. The renderer measures the actual chrome
                  // rectangles and fits inside what is left; the standalone
                  // page keeps its own reserved-band reading (`fullscreen`
                  // stays false there).
                  topObscuredPx={topChromePx}
                  fullscreen={fullscreen.active}
                  // Which project the drawing belongs to; the renderer uses it
                  // to remember the reader's explicit readable mode.
                  projectId={projectId}
                  // The detail knob's two numbers, so a renderer that has a
                  // visible-summary slot can report shown/in-scope rather than
                  // its own drawn/total reading.
                  detailReading={detailReading}
                  // Which subgraph this is decides how ids are read (label and
                  // group prefixes). The renderer must not have to guess: see
                  // `nodeIdShapeOf`.
                  idShape={nodeIdShapeOf(granularity)}
                  diffHighlight={resolvedDiffHighlight}
                  onNodeHover={handleNodeHover}
                  // A SINGLE click only selects: the inspector opens on the
                  // right and the drawing must not re-lay out. Drilling is the
                  // renderer's own double-click / double-tap gesture.
                  onNodeClick={(node) => {
                    dismissTouchHint();
                    selectNodeOnCanvas(node);
                  }}
                  onEdgeClick={selectRelationOnCanvas}
                  onToggleNodeClick={toggleNodeOnCanvas}
                  onToggleEdgeClick={toggleRelationOnCanvas}
                  onBoxSelect={addBoxSelection}
                  onMultiSelectStart={startMultiSelect}
                  multiSelectMode={multiSelectMode}
                  selectedNodeIds={selectedNodeIds}
                  selectedRelations={selectedRelations}
                  onSelectionClear={clearSelectionOnCanvas}
                  onEscapeSelection={escapeSelection}
                  selectedNodeId={selectedNodeId}
                  selectedRelation={selectedRelation}
                  // The dock narrows the canvas; its transition must not be
                  // read as a container shape change.
                  relayoutLocked={dockLayoutLocked}
                  // The panel's own size change (the fullscreen overlay) is
                  // answered by an explicit fit, and only when the drawing is
                  // still fitted — a manual zoom survives the toggle.
                  fitRequest={fitRequest}
                  onZoomModeChange={fitExport.reportZoomMode}
                  // The renderer owns the drill-down view; reporting it keeps
                  // the export menu's PlantUML identical to the drawing.
                  onViewChange={fitExport.setDiagramView}
                  // The model it actually drew, for the text page.
                  onDrawnPlantUmlChange={fitExport.reportDrawn}
                  focusNodeId={focusTarget?.id ?? null}
                  focusToken={focusTarget?.token}
                  focusDrill={focusTarget?.drill ?? false}
                  // Manual curation: the drawing owns right-click/long-press
                  // and Delete/Backspace, and reports the result through the
                  // same store the inspector and the manager use.
                  canCurate={canCurateEntities}
                  pinnedNodeIds={pinnedIds}
                  onPinNode={pinNode}
                  onUnpinNode={unpinNode}
                  onRemoveNode={removeNode}
                  onHideRelation={hideRelation}
                  onSoloNode={(node) => curation.setSoloNodeId(node.id)}
                  // The right-click menu's entry. It sends the selection the
                  // right-clicked entity belongs to, or that entity alone.
                  {...(canComposeSelection ? { onPutNodeInChat: putNodeInChat } : {})}
                  onUndo={undoCuration}
                />
              </CanvasHeaderSlotContext.Provider>
            </CompactToolbarSlotContext.Provider>

            {/* The hover relation reading replaces the two duplicated
                standing instructions: it only exists while a node is under
                the pointer, so the page has no permanent hint sentence. It
                stays a transient overlay; the readout above does not.

                Its position is MEASURED, never pinned: the drawing paints a
                package tab (and the class names) along its top edge, and the
                old fixed `left-3 top-3` covered exactly that row. The panel's
                layout effect hands the hint the first free candidate. */}
            {hoverReading !== null && (
              <div
                data-architecture-hover-hint="true"
                data-architecture-hover-visible={hoverVisible ? 'true' : 'false'}
                style={{
                  left: hoverHintPosition?.left ?? HOVER_HINT_MARGIN_PX,
                  top: hoverHintPosition?.top ?? HOVER_HINT_MARGIN_PX,
                  // The reading never runs across the whole canvas: at 85% on
                  // a phone it would reach into the corner slot, and the
                  // measured placement has nothing left to choose from.
                  maxWidth: 'min(85%, 720px)',
                  // The dwell only gates what is PAINTED: the element stays
                  // mounted so the measured placement (and the reading the
                  // tests read synchronously) never waits on a timer.
                  opacity: hoverVisible ? 1 : 0,
                }}
                className="pointer-events-none absolute z-20 flex flex-col items-start gap-1"
              >
                <span
                  ref={search.hoverHintRef}
                  data-architecture-hover={hoverReading.id}
                  data-architecture-hover-name={hoverReading.label}
                  data-architecture-hover-relations={visibleHover?.relations.join(',') ?? ''}
                  data-architecture-hover-in={hoverReading.incoming}
                  data-architecture-hover-out={hoverReading.outgoing}
                  // The visible line is ONE line: when the reading does not
                  // fit it is ellipsized, never hard-clipped — and the title
                  // always carries the words the ellipsis hid.
                  title={hoverHintText}
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  className="pointer-events-none rounded bg-background/90 px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm"
                >
                  {hoverHintText}
                </span>
              </div>
            )}

            {/* The selection tray floats inside the canvas: tags, the memo,
                the optional PlantUML attachment and the append-to-draft
                action. On the compact tier it becomes a bottom bar/drawer.
                The landscape-phone tier draws it as the inspector column's
                top row instead (see `shortTouchPanelTray`), so it is not
                rendered over the drawing at all. */}
            {selections.length > 0 && !shortTouch && (
              <ArchitectureSelectionTray
                selections={selections}
                graph={drawnGraph}
                idShape={nodeIdShapeOf(granularity)}
                view={diagramView}
                grouping={granularity === 'file' ? 'adaptive' : 'raw'}
                drawn={drawnPlantUml}
                projectId={projectId}
                projectName={projectName}
                analyzedAt={provenance.generatedAt}
                canCompose={canComposeSelection}
                canRemove={canCurateEntities}
                multiSelect={multiSelectMode}
                expanded={trayExpanded}
                compact={compactToolbar}
                // The coarse drawer is drawn OVER the canvas: lift the tray
                // (pill and expanded panel) above its top edge so the two
                // never share screen space. The side column is in flow, so
                // there is nothing to lift above — and the DEV drawer override
                // deliberately keeps the overlay's covering behaviour.
                bottomInset={dockTier === 'drawer' && dockOpen && !shortTouch ? touchDrawerHeight : 0}
                onExpandedChange={chrome.setTrayExpanded}
                onExitMultiSelect={() => chrome.setMultiSelectMode(false)}
                onToggleItem={toggleSelection}
                onClear={clearSelectionOnCanvas}
                onCompose={composeSelectionText}
                onRemoveSelected={removeSelected}
              />
            )}
          </div>
        </>
        )
      ) : (
        <>
          <ArchitectureEmptyState
            message={t('architecture.noSeeds', {
              defaultValue: 'This session has not referenced any file or identifier that the analysis can place.',
            })}
          />
        </>
      )}

      {legendOpen && legend}
    </div>
  );
}
