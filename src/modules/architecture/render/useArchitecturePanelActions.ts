/**
 * The panel's ACTION half: compose the selection into the chat draft, the
 * curation "remove selected" walk, and every export path (PlantUML, SVG, PNG,
 * Mermaid) plus the export notice sentence.
 *
 * Extracted from `ArchitecturePanel.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * Every rule still lives where it did — the draft seam, the curation store and
 * the fit/export controller; this hook only binds them to the panel's current
 * reading.
 */
import type { useTranslation } from 'react-i18next';

import type { ArchitectureExportNotice, ArchitectureFitExportController } from '@/modules/architecture/render/curation';
import type { ArchitectureSearchController } from '@/modules/architecture/render/architectureSearchController';
import type { ArchitectureGraphResult } from '@/modules/architecture/dom/planning/useArchitectureGraph';
import type { ArchitectureDiagramView } from '@/modules/architecture/layout/plantuml/archguardToPlantUml';
import type { ArchitectureGranularity } from '@/modules/architecture/layout/panel/panelFilters';
import type {
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
} from '@/modules/architecture/dom/rendererContract';
import {
  resolveDraftScope,
  type ArchitectureSelection,
  type ArchitectureSelectionAction,
} from '@/modules/architecture/dom/interaction/selectionModel';
import { readSvgNaturalSize } from '@/modules/architecture/layout/engine/svgViewport';
import { buildFullPlantUmlDocument } from '@/modules/architecture/layout/plantuml/plantUmlText';
import { architectureExportFilename, serializeSvgForExport } from '@/modules/architecture/render/curation/exportArtifacts';
import { buildSelectionMessage } from '@/modules/architecture/render/inspector';
import { sendArchitectureChatMessage } from '@/modules/architecture/render/architectureChatBridge';
import { readDraftText, writeDraftText } from '@/shared/api/chatDrafts';
import { nodeIdShapeOf } from '@/modules/architecture/render/architecturePanelShared';

/** Every reading the actions close over. */
export type ArchitecturePanelActionArgs = {
  readonly t: ReturnType<typeof useTranslation>['t'];
  readonly i18n: ReturnType<typeof useTranslation>['i18n'];
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly sessionId: string | null;
  readonly standalone: boolean;
  readonly onOpenChat?: () => void;
  readonly granularity: ArchitectureGranularity;
  readonly diagramView: ArchitectureDiagramView;
  readonly selections: readonly ArchitectureSelection[];
  readonly drawnGraph: ArchitectureRendererGraph;
  readonly provenance: ArchitectureGraphResult['provenance'];
  readonly mmd: ArchitectureGraphResult['mmd'];
  readonly search: ArchitectureSearchController;
  readonly fitExport: ArchitectureFitExportController;
  readonly exportStatus: ArchitectureExportNotice | null;
  readonly hideRelation: (edge: { readonly from: string; readonly to: string; readonly relationType: string }) => void;
  readonly removeNode: (node: ArchitectureRendererNode) => void;
  readonly showCurationToast: (message: string, undoable?: boolean) => void;
  readonly dispatchSelection: (action: ArchitectureSelectionAction) => void;
};

/** The compose/export actions the view modules call. */
export type ArchitecturePanelActions = {
  readonly composeSelectionText: (text: string) => void;
  readonly putSelectionInChat: () => void;
  readonly putNodeInChat: (node: ArchitectureRendererNode) => void;
  readonly removeSelected: () => void;
  readonly exportPlantUml: () => void;
  readonly copyPlantUml: () => Promise<void>;
  readonly exportSvg: () => void;
  readonly exportPng: () => Promise<void>;
  readonly exportMermaid: () => void;
  readonly exportStatusText: string;
  readonly canComposeSelection: boolean;
};

/** Bind the actions to the panel's current reading. */
export function useArchitecturePanelActions(args: ArchitecturePanelActionArgs): ArchitecturePanelActions {
  const {
    diagramView,
    dispatchSelection,
    drawnGraph,
    exportStatus,
    fitExport,
    granularity,
    hideRelation,
    i18n,
    mmd,
    onOpenChat,
    projectId,
    projectName,
    provenance,
    removeNode,
    search,
    selections,
    sessionId,
    showCurationToast,
    standalone,
    t,
  } = args;

/**
 * Append the tray's composed text to the chat draft and switch to Chat.
 *
 * The write is deliberately an APPEND: the reader may already be half-way
 * through a message, and the tray adds context rather than replacing it. The
 * scope is the composer's own (`resolveDraftScope`), and the composer restores
 * the text through its draft subscription. Sending stays the reader's action.
 */
const composeSelectionText = (text: string): void => {
  // The standalone page has no composer of its own. The same composed text
  // travels to the session's workspace tab, which owns the draft AND the tab
  // switch; without an answer there is nothing to append to, so the reader is
  // handed the text on the clipboard instead of a silent no-op.
  if (standalone) {
    void (async () => {
      const delivered = await sendArchitectureChatMessage({ sessionId, text });
      if (delivered) {
        showCurationToast(
          t('architecture.standalone.sent', {
            defaultValue: 'Sent to the session’s chat input',
          }),
          false,
        );
        return;
      }
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        // The toast below still tells the reader the tab could not be reached;
        // a refused clipboard is the browser's own limit, not something this
        // page can repair.
      }
      showCurationToast(
        t('architecture.standalone.copied', {
          defaultValue: 'Main session tab not reachable — copied to the clipboard',
        }),
        false,
      );
    })();
    return;
  }
  const scope = resolveDraftScope(projectId, sessionId);
  if (scope === null) return;
  const existing = readDraftText(scope);
  const appended = existing.trim() === '';
  writeDraftText(scope, appended ? text : `${existing}\n\n${text}`);
  onOpenChat?.();
  // The composer belongs to a sibling module; focus it through its documented
  // slot rather than importing the chat module into this one.
  window.setTimeout(() => {
    document
      .querySelector<HTMLTextAreaElement>('textarea[data-slot="prompt-input-textarea"]')
      ?.focus();
  }, 0);
  showCurationToast(
    appended
      ? t('architecture.tray.toastAdded', { defaultValue: 'Put in the input box' })
      : t('architecture.tray.toastAppended', { defaultValue: 'Appended to the input box' }),
    false,
  );
};

/**
 * The selection message every non-tray entry point (the inspector's Adjust
 * row, the multi-select summary and the canvas context menu) appends.
 *
 * Built by the tray's own exported builder, so those three send the same
 * header, the same entity lines and the same relation lines the tray's
 * primary button would — the tray adds its memo and attachment on top.
 */
const selectionMessageFor = (entries: readonly ArchitectureSelection[]): string =>
  buildSelectionMessage(
    {
      selections: entries,
      graph: drawnGraph,
      idShape: nodeIdShapeOf(granularity),
      projectName,
      projectId,
      analyzedAt: provenance.generatedAt,
    },
    t,
    i18n.language,
  );

/** The shared "put the selection in the chat input" action. */
const putSelectionInChat = (): void => {
  composeSelectionText(selectionMessageFor(selections));
};

/**
 * The canvas context menu's "Put in chat input". A right-click on an entity
 * that is already part of the selection sends the whole set; on any other
 * entity it sends that entity alone, making it the selection first so the
 * drawing and the message agree.
 */
const putNodeInChat = (node: ArchitectureRendererNode): void => {
  const inSelection = selections.some((entry) => (entry.kind === 'entity'
    ? entry.nodeId === node.id
    : entry.from === node.id || entry.to === node.id));
  if (inSelection) {
    putSelectionInChat();
    return;
  }
  dispatchSelection({ type: 'select-entity', nodeId: node.id });
  composeSelectionText(selectionMessageFor([{ kind: 'entity', nodeId: node.id }]));
};

/** "Remove selected" walks the curation actions: exclude entities, hide relations. */
const removeSelected = (): void => {
  for (const entry of selections) {
    if (entry.kind === 'entity') {
      const node = drawnGraph.nodes.find((candidate) => candidate.id === entry.nodeId);
      if (node !== undefined) removeNode(node);
    } else {
      hideRelation(entry);
    }
  }
  dispatchSelection({ type: 'clear' });
};

// A pin/unpin action on a single entity reads the same store the tray's
// removal does, so the two can never disagree.
const canComposeSelection = resolveDraftScope(projectId, sessionId) !== null;

/**
 * The PlantUML document for the view on screen — the SAME document the Text
 * page's "Whole filtered graph" scope shows.
 *
 * Both entry points call {@link buildFullPlantUmlDocument} with the same graph,
 * view, grouping, id shape and drawn model (the renderer renders that model
 * with `detail: 'full'`, so its members are complete), which is what makes
 * the exported file and the copyable text byte-identical instead of two
 * spellings of the same drawing. Before a drawing exists the builder falls
 * back to the local bridge — the same fallback the text page takes, so the
 * two are still equal.
 */
const currentPlantUml = (): string =>
  buildFullPlantUmlDocument(drawnGraph, {
    view: diagramView,
    grouping: granularity === 'file' ? 'adaptive' : 'raw',
    idShape: nodeIdShapeOf(granularity),
    drawn: fitExport.getDrawnPlantUml(),
  }).text;

/** The live drawing, read from the panel's own subtree at export time. */
const renderedSvg = (): SVGSVGElement | null =>
  search.canvasRegionRef.current?.querySelector<SVGSVGElement>('[data-architecture-plantuml] svg') ?? null;

const artifactFilename = (extension: string): string =>
  architectureExportFilename(granularity, projectId, new Date(), extension);

const exportPlantUml = (): void => {
  fitExport.exportPlantUml(currentPlantUml(), artifactFilename('puml'));
};

const copyPlantUml = async (): Promise<void> => {
  await fitExport.copyPlantUml(currentPlantUml());
};

const exportSvg = (): void => {
  const svg = renderedSvg();
  fitExport.exportSvg(
    svg === null ? null : serializeSvgForExport(svg),
    artifactFilename('svg'),
  );
};

const exportPng = async (): Promise<void> => {
  const svg = renderedSvg();
  const natural = svg === null ? null : readSvgNaturalSize(svg);
  await fitExport.exportPng(
    svg === null || natural === null ? null : serializeSvgForExport(svg),
    natural,
    artifactFilename('png'),
  );
};

// The Mermaid pair is the LEGACY export and deliberately unchanged: the same
// server-returned document under the same pre-menu filename.
const exportMermaid = (): void => {
  fitExport.exportMermaid(
    granularity === 'file' ? mmd.file : mmd.entity,
    `architecture-${granularity}.mmd`,
  );
};

// The notice the menu's aria-live region states. The owner publishes a kind;
// the sentence stays here so the controller needs no translator.
const exportStatusText = exportStatus === null
  ? ''
  : exportStatus.kind === 'copied'
    ? t('architecture.export.copied', { defaultValue: 'PlantUML copied to the clipboard' })
    : exportStatus.kind === 'notReady'
      ? t('architecture.export.notReady', { defaultValue: 'The diagram is not ready to export yet.' })
      : exportStatus.kind === 'pngScaled'
        ? t('architecture.export.pngScaled', {
          defaultValue: 'The PNG was scaled down so its longest side is {{edge}} px.',
          edge: exportStatus.edge,
        })
        : t('architecture.export.pngFailed', { defaultValue: 'The PNG could not be created.' });

  return {
    composeSelectionText,
    putSelectionInChat,
    putNodeInChat,
    removeSelected,
    exportPlantUml,
    copyPlantUml,
    exportSvg,
    exportPng,
    exportMermaid,
    exportStatusText,
    canComposeSelection,
  };
}
