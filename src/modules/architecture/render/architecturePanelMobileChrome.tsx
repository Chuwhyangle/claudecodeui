/**
 * The panel's MOBILE chrome: the shell sidebar-collapse entry, the landscape-phone
 * toolbar summary cell and that tier's selection tray.
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 */
import { ArchitectureSelectionTray } from '@/modules/architecture/render/ArchitectureSelectionTray';
import { nodeIdShapeOf } from '@/modules/architecture/render/architecturePanelShared';
import type { ArchitecturePanelActions } from '@/modules/architecture/render/useArchitecturePanelActions';
import type { ArchitecturePanelScope } from '@/modules/architecture/render/ArchitecturePanel';

/** The ready arm of the panel model. */
type ReadyScope = Extract<ArchitecturePanelScope, { branch: 'ready' }> & ArchitecturePanelActions;

/** Build the compact-tier chrome fragments from the panel model. */
export function panelMobileChromeFragments(panel: ReadyScope): {
  readonly sidebarCollapseButton: React.ReactNode;
  readonly shortTouchReadoutToggle: React.ReactNode;
  readonly shortTouchPanelTray: React.ReactNode;
} {
  const {
    canComposeSelection,
    canCurateEntities,
    chrome,
    clearSelectionOnCanvas,
    collapseShellSidebar,
    compactTargetStyle,
    compactToolbar,
    composeSelectionText,
    diagramView,
    drawnGraph,
    drawnPlantUml,
    granularity,
    headerButtonClass,
    multiSelectMode,
    projectId,
    projectName,
    provenance,
    readout,
    readoutOpen,
    readoutSummary,
    removeSelected,
    selections,
    shortTouch,
    t,
    toggleSelection,
    trayExpanded,
  } = panel;

const sidebarCollapseButton = (
  <button
    type="button"
    onClick={collapseShellSidebar}
    data-architecture-sidebar-collapse="true"
    style={compactTargetStyle}
    className={`${headerButtonClass} inline-flex items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
  >
    {t('versionUpdate.ariaLabels.closeSidebar', { defaultValue: 'Close sidebar' })}
  </button>
);

/**
 * The landscape-phone toolbar's summary cell. It states the SAME one-line
 * reading the other tiers draw in their canvas-header row and expands into
 * that row's full reading (plus the provenance footer) as an overlay. This is
 * the cell that lets the short tier spend no standing height on a summary
 * row: the drawing gets the 44px the row would have taken.
 */
const shortTouchReadoutToggle = (
  <button
    type="button"
    aria-expanded={readoutOpen}
    onClick={() => chrome.toggleReadout()}
    data-architecture-readout-toolbar-toggle="true"
    data-architecture-readout-toolbar-summary={readout.shown}
    data-architecture-readout-toolbar-total={readout.related}
    style={compactTargetStyle}
    className={`${headerButtonClass} inline-flex min-w-0 max-w-[38%] items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
  >
    <span className="min-w-0 truncate whitespace-nowrap">{readoutSummary}</span>
    <span aria-hidden="true">{readoutOpen ? '▾' : '▸'}</span>
  </button>
);

/**
 * The selection tray in its landscape-phone form: the TOP ROW of the
 * inspector column. It is never drawn across the canvas on this tier.
 */
const shortTouchPanelTray = shortTouch && selections.length > 0
  ? (
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
      panelRow
      onExpandedChange={chrome.setTrayExpanded}
      onExitMultiSelect={() => chrome.setMultiSelectMode(false)}
      onToggleItem={toggleSelection}
      onClear={clearSelectionOnCanvas}
      onCompose={composeSelectionText}
      onRemoveSelected={removeSelected}
    />
  )
  : undefined;

  return { sidebarCollapseButton, shortTouchReadoutToggle, shortTouchPanelTray };
}
