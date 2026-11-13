/**
 * The panel TOOLBAR render fragments: the export menu, the compact overflow menu,
 * the Text/Adjust/fullscreen/open-in-new-tab buttons and the standalone Back entry.
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * They are assembled by `architecturePanelShell.tsx`; each fragment is the same JSX
 * the panel used to build inline, with every closed-over reading coming from the
 * panel model (`scope`) instead of a component-local closure.
 */
import { ArchitectureExportMenu } from '@/modules/architecture/render/ArchitectureExportMenu';
import { buildArchitectureStandaloneHref } from '@/modules/architecture/render/architectureDeepLink';
import type { ArchitectureDeepLinkState } from '@/modules/architecture/render/architectureDeepLink';
import { Tooltip } from '@/shared/ui';
import { ExternalLink, Maximize2, Minimize2 } from 'lucide-react';
import type { ArchitecturePanelScope } from '@/modules/architecture/render/ArchitecturePanel';

/** The ready arm of the panel model: every field these fragments read. */
type ReadyScope = Extract<ArchitecturePanelScope, { branch: 'ready' }>;

/** Build the toolbar fragments from the panel model. */
export function panelToolbarFragments(panel: ReadyScope): {
  readonly exportMenu: React.ReactNode;
  readonly overflowMenu: React.ReactNode;
  readonly textToggle: React.ReactNode;
  readonly fullscreenButton: React.ReactNode;
  readonly fullscreenButtonContents: React.ReactNode;
  readonly fullscreenToolbarButton: React.ReactNode;
  readonly adjustButton: React.ReactNode;
  readonly openInNewTabButton: React.ReactNode;
  readonly openInNewTabToolbarButton: React.ReactNode;
  readonly openInNewTabSheetButton: React.ReactNode;
} {
  const {
    chrome,
    closeDock,
    closeLegend,
    compactHeaderButtonClass,
    compactTargetStyle,
    compactToolbar,
    copyPlantUml,
    diagramView,
    dockOpen,
    dockTab,
    exportMermaid,
    exportPlantUml,
    exportPng,
    exportSvg,
    fullscreen,
    fullscreenButtonRef,
    granularity,
    headerButtonClass,
    hiddenReading,
    legendButtonRef,
    relationPresetLabel,
    scope,
    detail,
    selection,
    sessionId,
    sheetOpen,
    sheetTriggerRef,
    t,
    textViewLabel,
    textFilterSummary,
  } = panel;

const exportMenu = (
  <ArchitectureExportMenu
    compact={compactToolbar}
    onExportPlantUml={exportPlantUml}
    onCopyPlantUml={() => {
      void copyPlantUml();
    }}
    onExportSvg={exportSvg}
    onExportPng={() => {
      void exportPng();
    }}
    onExportMermaid={exportMermaid}
    onAction={() => chrome.setSheetOpen(false)}
  />
);

/**
 * The desktop row's single `⋯`: the five export formats and the legend door.
 *
 * `Export ▾` and `Legend` used to take two slots of their own on the right of
 * this row; at 1440px with the sidebar open their labels pushed the row into a
 * second line, which cost the drawing ~28px of height. The menu keeps every
 * entry — the legend popover's body is untouched — and the trigger carries the
 * `legendButtonRef` so the legend's Escape dismissal returns focus to the
 * control that opened it.
 */
const overflowMenu = (
  <ArchitectureExportMenu
    variant="overflow"
    onExportPlantUml={exportPlantUml}
    onCopyPlantUml={() => {
      void copyPlantUml();
    }}
    onExportSvg={exportSvg}
    onExportPng={() => {
      void exportPng();
    }}
    onExportMermaid={exportMermaid}
    onShowLegend={() => chrome.setLegendOpen(true)}
    // Opening the overflow is a different disclosure: a legend left open
    // behind it would sit over the menu.
    onOpen={closeLegend}
    triggerRef={legendButtonRef}
  />
);

/**
 * The toolbar's door to the text page. The dock otherwise opens only on a
 * selection, but the whole-graph text is exactly what a reader wants with
 * nothing selected — so the page gets its own entry, and it toggles: while
 * the dock shows this page, pressing it closes the dock.
 */
const textToggle = (
  <button
    type="button"
    aria-expanded={dockOpen && dockTab === 'text'}
    // The visible word is the name; the explicit label keeps the control
    // readable to an assistive reader that only gets the accessible name
    // (and to the toolbar criterion that requires one on every action).
    aria-label={t('architecture.text.open', { defaultValue: 'Text' })}
    onClick={() => {
      if (dockOpen && dockTab === 'text') {
        closeDock();
        return;
      }
      // This is the reader's own door, so the open is explicit: with nothing
      // selected it may legitimately show the empty inspector page.
      chrome.openDock({ explicit: true, tab: 'text' });
    }}
    data-architecture-text-toggle="true"
    style={compactTargetStyle}
    className={`${compactHeaderButtonClass} border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
  >
    {t('architecture.text.open', { defaultValue: 'Text' })}
  </button>
);

/**
 * The overlay's one control. It carries an icon AND the visible word (the
 * icon alone is not a label), flips to "Exit fullscreen" while the overlay is
 * up, and lives on both toolbar tiers: the landscape-phone row draws it in
 * the Adjust sheet because the row has no width for a fifth target, and the
 * portrait row draws it there too — while the overlay is up each tier draws
 * it in the one-row overlay toolbar, so leaving never needs the sheet.
 *
 * The desktop row draws it WITHOUT the word (the icon plus a tooltip), because
 * that row has to stay one line at 1440px with the sidebar open; the compact
 * tiers keep the word, where the row has the width for it.
 */
const fullscreenLabel = fullscreen.active
  ? t('architecture.fullscreen.exit', { defaultValue: 'Exit fullscreen' })
  : t('architecture.fullscreen.enter', { defaultValue: 'Fullscreen' });
const fullscreenButtonContents = (
  <>
    {fullscreen.active
      ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
      : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
    <span>
      {fullscreenLabel}
    </span>
  </>
);
const fullscreenButton = (
  <button
    ref={fullscreenButtonRef}
    type="button"
    aria-pressed={fullscreen.active}
    aria-label={fullscreenLabel}
    // The phone tiers put this control INSIDE the Adjust sheet. Pressing it
    // must dismiss that modal in the same gesture: the sheet is chrome for
    // the inline layout (its entries are even hidden while the overlay is
    // up), and leaving it on screen would hide the drawing the press just
    // asked for. Same commit as the toggle, so the panel's focus-into-the-
    // canvas effect still runs after the sheet's focus restore.
    onClick={() => {
      if (sheetOpen) chrome.setSheetOpen(false);
      fullscreen.toggle();
    }}
    data-architecture-fullscreen-toggle="true"
    data-architecture-fullscreen-active={fullscreen.active ? 'true' : undefined}
    style={compactTargetStyle}
    className={`${headerButtonClass} inline-flex items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
  >
    {fullscreenButtonContents}
  </button>
);
const fullscreenToolbarButton = (
  <Tooltip content={fullscreenLabel} position="bottom">
    <button
      ref={fullscreenButtonRef}
      type="button"
      aria-pressed={fullscreen.active}
      aria-label={fullscreenLabel}
      onClick={fullscreen.toggle}
      data-architecture-fullscreen-toggle="true"
      data-architecture-fullscreen-active={fullscreen.active ? 'true' : undefined}
      style={compactTargetStyle}
      // Block-level (not `inline-flex`) so the Tooltip's wrapper is exactly
      // this button's box: an inline-level child grows the wrapper's line box
      // by its descent, and the four row actions then sit a pixel apart even
      // though they share one flex row.
      className={`${headerButtonClass} flex items-center justify-center border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
    >
      {fullscreen.active
        ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
        : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
    </button>
  </Tooltip>
);

/**
 * The compact tier's one menu button. It is the row's rightmost control
 * normally, and in the fullscreen overlay it is one of only two: the view
 * switch and the Text page move INSIDE the sheet there, so the overlay spends
 * one 56px row on chrome instead of the two 44px rows that used to cover the
 * drawing's top nodes.
 */
const adjustButton = (
  <button
    ref={sheetTriggerRef}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={sheetOpen}
    aria-label={t('architecture.sheet.open', { defaultValue: 'Adjust' })}
    onClick={() => chrome.setSheetOpen(true)}
    data-architecture-sheet-toggle="true"
    style={compactTargetStyle}
    className={`${compactHeaderButtonClass} rounded-lg border border-border text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60`}
  >
    {t('architecture.sheet.open', { defaultValue: 'Adjust' })}
  </button>
);

/**
 * The view on screen, as the standalone link describes it.
 *
 * The panel is the only layer that knows which subgraph, depth, tier and
 * selection are current, so "Open in new tab" states the reading here rather
 * than letting the route guess. `entity` prefers the current selection and
 * falls back to the entity a drilled neighbourhood is centred on;
 * `mode=neighbourhood` is written only when the drawing IS that drill.
 */
const currentDeepLinkState = (): ArchitectureDeepLinkState => ({
  view: granularity === 'entity' ? 'class' : 'file',
  scope,
  detail,
  entity: selection?.kind === 'entity'
    ? selection.nodeId
    : diagramView.kind === 'neighborhood'
      ? diagramView.entityId
      : null,
  mode: diagramView.kind === 'neighborhood' ? 'neighbourhood' : null,
});

/**
 * The toolbar's door to a standalone page for the SAME reading.
 *
 * The href is built from the current pathname so the deployment's router
 * basename survives, and carries only the FIRST-paint parameters; the new tab
 * shares the project's remembered knobs through localStorage afterwards. Also
 * offered in the fullscreen overlay, where a reader is most likely to want
 * the drawing on a second screen.
 */
const openInNewTab = (): void => {
  if (sessionId === null || typeof window === 'undefined') return;
  const href = buildArchitectureStandaloneHref({
    pathname: window.location.pathname,
    sessionId,
    state: currentDeepLinkState(),
  });
  window.open(href, '_blank', 'noopener');
};

const openInNewTabButton = (
  <button
    type="button"
    onClick={openInNewTab}
    disabled={sessionId === null}
    aria-label={t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}
    title={t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}
    data-architecture-open-in-new-tab="true"
    style={compactTargetStyle}
    className={`${headerButtonClass} inline-flex items-center gap-1 border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
  >
    <ExternalLink className="h-4 w-4" aria-hidden="true" />
    {!compactToolbar && (
      <span>{t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}</span>
    )}
  </button>
);

/**
 * The desktop row's form of the same door: the external-link glyph alone,
 * named by `aria-label` and a hover tooltip. The word is what pushed the row
 * into a second line at 1440px; the compact tiers keep the labelled form
 * above because their sheets stack full-width rows.
 */
const openInNewTabToolbarButton = (
  <Tooltip
    content={t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}
    position="bottom"
  >
    <button
      type="button"
      onClick={openInNewTab}
      disabled={sessionId === null}
      aria-label={t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}
      data-architecture-open-in-new-tab="true"
      style={compactTargetStyle}
      // Block-level for the same reason as the Fullscreen control above: the
      // Tooltip wrapper must equal the button's box so all four row actions
      // share one top.
      className={`${headerButtonClass} flex items-center justify-center border border-border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
    </button>
  </Tooltip>
);

/**
 * The same door in the portrait Adjust sheet. The sheet stacks full-width
 * rows, so the entry states its name instead of the toolbar's icon alone —
 * an unlabelled external-link glyph is not a readable "Open in new tab".
 */
const openInNewTabSheetButton = (
  <button
    type="button"
    onClick={openInNewTab}
    disabled={sessionId === null}
    aria-label={t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}
    data-architecture-open-in-new-tab="true"
    style={compactTargetStyle}
    className={`${headerButtonClass} inline-flex items-center justify-start gap-2 border border-border text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40`}
  >
    <ExternalLink className="h-4 w-4" aria-hidden="true" />
    <span>{t('architecture.standalone.openInNewTab', { defaultValue: 'Open in new tab' })}</span>
  </button>
);


  return {
    exportMenu,
    overflowMenu,
    textToggle,
    fullscreenButton,
    fullscreenButtonContents,
    fullscreenToolbarButton,
    adjustButton,
    openInNewTabButton,
    openInNewTabToolbarButton,
    openInNewTabSheetButton,
  };
}
