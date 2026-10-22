import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ArchitectureDiagramView } from '@/modules/architecture/archguardToPlantUml';
import {
  architectureExportFilename,
  downloadTextFile,
} from '@/modules/architecture/exportArtifacts';
import { TOUCH_TARGET_STYLE, useTouchLayout } from '@/modules/architecture/hooks/useTouchLayout';
import {
  buildPlantUmlText,
  measurePlantUmlText,
  nodesIntersectingViewport,
  NoSelectionScopeError,
  previewPlantUmlText,
  VIEWPORT_RECOMPUTE_DELAY_MS,
  wrapSessionContext,
  type ArchitectureTextRect,
  type ArchitectureTextScope,
} from '@/modules/architecture/plantUmlText';
import type {
  ArchitectureNodeIdShape,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';
import type { ArchitectureSelection } from '@/modules/architecture/selectionModel';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/Dialog';
import { formatAbsoluteTime } from '@/shared/utils';

/**
 * The dock's second page: the PlantUML text of the drawing, a scope selector,
 * the document's size reading, and the copy/download actions.
 *
 * The page never re-derives the picture: `graph` is the same object the
 * renderer was handed (filters, detail tier and layout budget already applied),
 * and {@link buildPlantUmlText} runs the same bridge the drawing used. The scope
 * only chooses a subset of that graph.
 *
 * The render cost is bounded on purpose: the `<pre>` shows at most 300 lines
 * (copy and download always use the full document), so a 211k-character diagram
 * is one string in memory rather than one enormous DOM subtree.
 *
 * Used by `ArchitecturePanel.tsx` as the dock's `text` tab, and by
 * `tests/textPanel.test.tsx`.
 */

/** How long a view/filter/scope change waits before the document is rebuilt. */
const TEXT_REGENERATE_DEBOUNCE_MS = 300;

/** How long the "Updated" marker stays beside the reading after a rebuild. */
const TEXT_UPDATED_VISIBLE_MS = 1500;

/** The three scopes, in the radiogroup's order. */
type ArchitectureTextScopeKind = 'full' | 'viewport' | 'selection';

type ArchitectureTextPanelProps = {
  /** The exact graph the renderer drew (after filters, detail tier and budget). */
  readonly graph: ArchitectureRendererGraph;
  /** The subgraph's id scheme, forwarded to the bridge's path reading. */
  readonly idShape: ArchitectureNodeIdShape;
  /** Which subgraph is on screen; decides the download filename and view label. */
  readonly granularity: 'file' | 'entity';
  /** The diagram view the renderer is drawing (overview/group/hierarchy/neighbourhood). */
  readonly view: ArchitectureDiagramView;
  /** The bridge grouping the drawing used (`adaptive` for the file overview). */
  readonly grouping: 'raw' | 'adaptive';
  /** The panel's one selection; the `+1` scope centres on it (or on both relation ends). */
  readonly selection: ArchitectureSelection | null;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  /** The reading's `provenance.generatedAt`, shown in the session-context header. */
  readonly analyzedAt: string | null;
  /** The panel's translated class/file label for the header. */
  readonly viewLabel: string;
  /** The panel's translated "what the filter hides" sentence for the header. */
  readonly filterSummary: string;
  /** The canvas region; the viewport scope measures node boxes against it. */
  readonly canvasRef: RefObject<HTMLElement | null>;
};

/** The read-only syntax reading the badge shows. */
type SyntaxReading =
  | { readonly ok: true }
  | { readonly ok: false; readonly line: number; readonly message: string };

/**
 * The syntax badge: plantuml-js's own `checkSyntax` over the generated text,
 * shown as a pass or as the first error's line and message.
 *
 * The package is imported lazily (the same discipline the renderer uses for
 * `plantuml-js/elk`) so the tab's first-screen chunk does not grow by the
 * Graphviz entry. It is read-only — a diagnostic never blocks copy or download.
 *
 * Exported for `tests/textPanel.test.tsx`, which feeds it a valid and an invalid
 * document directly; `ArchitectureTextPanel` is its real consumer.
 */
export function ArchitectureTextSyntaxBadge({ text }: { readonly text: string }) {
  const { t } = useTranslation();
  const [reading, setReading] = useState<SyntaxReading | null>(null);

  useEffect(() => {
    if (text === '') {
      setReading(null);
      return;
    }
    let cancelled = false;
    void import('@yalehwang/plantuml-js')
      .then(({ checkSyntax }) => {
        if (cancelled) return;
        const first = checkSyntax(text).errors[0];
        setReading(
          first === undefined
            ? { ok: true }
            : { ok: false, line: first.line, message: first.message },
        );
      })
      .catch(() => {
        // A browser that cannot load the checker simply shows no badge; the
        // text itself is still copyable.
        if (!cancelled) setReading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (reading === null) return null;
  return reading.ok ? (
    <span
      data-architecture-text-syntax="ok"
      className="rounded border border-emerald-600/40 px-1 text-[11px] text-emerald-700 dark:text-emerald-400"
    >
      {t('architecture.text.syntaxOk', { defaultValue: 'Syntax OK' })}
    </span>
  ) : (
    <span
      data-architecture-text-syntax="error"
      data-architecture-text-syntax-line={reading.line}
      className="rounded border border-amber-600/40 px-1 text-[11px] text-amber-600 dark:text-amber-400"
    >
      {t('architecture.text.syntaxError', {
        defaultValue: 'Line {{line}}: {{message}}',
        line: reading.line,
        message: reading.message,
      })}
    </span>
  );
}

export function ArchitectureTextPanel({
  graph,
  idShape,
  granularity,
  view,
  grouping,
  selection,
  projectId,
  sessionId,
  analyzedAt,
  viewLabel,
  filterSummary,
  canvasRef,
}: ArchitectureTextPanelProps) {
  const { t, i18n } = useTranslation();
  const { coarsePointer } = useTouchLayout();
  // A coarse pointer gets a real 44×44 target on every control; inline so the
  // reading does not depend on a stylesheet (same rule as the dock shell).
  const targetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;

  // Which slice of the drawing the text describes. The page opens on the whole
  // filtered graph, the scope the reader asked for first.
  const [scopeKind, setScopeKind] = useState<ArchitectureTextScopeKind>('full');
  // The node ids the viewport scope currently covers. Measured from the live
  // SVG (never from the payload) so panning/zooming is what changes the text.
  const [viewportNodeIds, setViewportNodeIds] = useState<readonly string[]>([]);
  // The document as last REBUILT (after the debounce). It is state, not a memo,
  // because a rebuild must not run on every intermediate filter/view render.
  const [text, setText] = useState<string>(() => {
    try {
      return buildPlantUmlText(graph, { kind: 'full' }, { view, grouping, idShape });
    } catch {
      return '';
    }
  });
  // Whether "Updated" shows beside the reading. Transient by design: it marks a
  // recomputation, it is not a standing status.
  const [updatedVisible, setUpdatedVisible] = useState(false);
  // The aria-live reading of the last copy (success or fallback), kept out of
  // the buttons so it survives their label changes.
  const [copyNotice, setCopyNotice] = useState('');
  // Whether the >30k-token explanation dialog is open. Only "copy as session
  // context" consults it; plain copy always proceeds.
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  // The document offered for manual copying when the Clipboard API refuses.
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  // The last document the reader was shown. Seeded with the mount build below,
  // so the first debounced rebuild of an unchanged document is a no-op and
  // "Updated" only ever marks a real change.
  const lastBuiltTextRef = useRef<string | null>(text);

  // The anchors the `+1` scope centres on: the selected entity, or both ends of
  // the selected relation. Empty means the scope is unavailable — a state the
  // radio states in place instead of emitting an empty document.
  const anchorIds = useMemo<readonly string[]>(() => {
    if (selection === null) return [];
    return selection.kind === 'entity' ? [selection.nodeId] : [selection.from, selection.to];
  }, [selection]);

  // A selection that disappears (Escape, a view switch) must not leave the page
  // on a scope it can no longer build; fall back to the whole graph visibly.
  useEffect(() => {
    if (selection === null && scopeKind === 'selection') setScopeKind('full');
  }, [selection, scopeKind]);

  // The scope spec the rebuild effect reads. Kept out of the effect body so the
  // dependency list names the same facts the build uses.
  const scope = useMemo<ArchitectureTextScope | null>(() => {
    if (scopeKind === 'selection') {
      return anchorIds.length === 0 ? null : { kind: 'selection', nodeIds: anchorIds };
    }
    if (scopeKind === 'viewport') return { kind: 'viewport', nodeIds: viewportNodeIds };
    return { kind: 'full' };
  }, [scopeKind, anchorIds, viewportNodeIds]);

  // Rebuild the document after the debounce. The 300ms window is the task's:
  // dragging the scope stepper or flipping the detail tier is one gesture, and
  // a 211k-character document must not be regenerated once per step.
  useEffect(() => {
    if (scope === null) {
      setText('');
      return;
    }
    const timer = setTimeout(() => {
      let next: string;
      try {
        next = buildPlantUmlText(graph, scope, { view, grouping, idShape });
      } catch (error) {
        if (error instanceof NoSelectionScopeError) {
          setText('');
          return;
        }
        // Any other failure is a real defect: let it surface rather than
        // showing an empty page as if the scope were empty.
        throw error;
      }
      if (lastBuiltTextRef.current === next) return;
      lastBuiltTextRef.current = next;
      setText(next);
      setUpdatedVisible(true);
    }, TEXT_REGENERATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [graph, scope, view, grouping, idShape]);

  // "Updated" is a short-lived marker, not a state the reader can leave on.
  useEffect(() => {
    if (!updatedVisible) return;
    const timer = setTimeout(() => setUpdatedVisible(false), TEXT_UPDATED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [updatedVisible]);

  /**
   * Read the drawn nodes' boxes once and keep the ones inside the canvas box.
   * Node rectangles come from the rendered SVG (the drawing is what decides
   * where they are); the measurement is cached in state until the next
   * pan/zoom settles, so a re-render does not re-read 5k nodes.
   */
  const measureViewport = useCallback((): void => {
    const canvas = canvasRef.current;
    const host = canvas?.querySelector<HTMLElement>('[data-architecture-plantuml]') ?? null;
    if (host === null) {
      setViewportNodeIds([]);
      return;
    }
    const bounds = host.getBoundingClientRect();
    const viewport: ArchitectureTextRect = {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
    };
    const entries: (readonly [string, ArchitectureTextRect])[] = [];
    for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
      const id = element.getAttribute('data-entity-id');
      if (id === null) continue;
      const rect = element.getBoundingClientRect();
      entries.push([id, {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      }]);
    }
    setViewportNodeIds(nodesIntersectingViewport(entries, viewport));
  }, [canvasRef]);

  // The viewport scope re-measures 400ms after each pan/zoom gesture (and when
  // the drawing itself changes), never during it: the reading follows the
  // settled view, not every wheel tick.
  useEffect(() => {
    if (scopeKind !== 'viewport') return;
    const canvas = canvasRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        measureViewport();
      }, VIEWPORT_RECOMPUTE_DELAY_MS);
    };
    measureViewport();
    if (canvas === null) return;
    const events = ['wheel', 'pointerup', 'pointercancel', 'keyup', 'scroll'] as const;
    for (const type of events) canvas.addEventListener(type, schedule, { capture: true, passive: true });
    return () => {
      if (timer !== null) clearTimeout(timer);
      for (const type of events) {
        canvas.removeEventListener(type, schedule, { capture: true });
      }
    };
  }, [scopeKind, canvasRef, measureViewport, graph, view]);

  // The fallback dialog opens with its text already selected, so the documented
  // "select and copy" path is one keystroke rather than a drag.
  useEffect(() => {
    if (fallbackText === null) return;
    fallbackRef.current?.focus();
    fallbackRef.current?.select();
  }, [fallbackText]);

  const volume = useMemo(() => measurePlantUmlText(text), [text]);
  const preview = useMemo(() => previewPlantUmlText(text), [text]);
  // A filtered-to-empty graph is an honest empty state, not a document to copy.
  const empty = graph.nodes.length === 0;

  const scopeLabels: Readonly<Record<ArchitectureTextScopeKind, string>> = {
    full: t('architecture.text.scopeFull', { defaultValue: 'Whole filtered graph' }),
    viewport: t('architecture.text.scopeViewport', { defaultValue: 'Current viewport' }),
    selection: t('architecture.text.scopeSelection', { defaultValue: 'Selected + 1 neighbour' }),
  };

  const analyzedLabel = formatAbsoluteTime(analyzedAt, i18n.language)
    ?? t('architecture.text.unknownTime', { defaultValue: 'unknown' });
  // The header the chat receives. It states the four facts a reader needs to
  // know what the pasted document describes, so the text is not orphaned from
  // its project/session/view/filter once it leaves this page.
  const contextHeader = t('architecture.text.sessionHeader', {
    defaultValue:
      'About the architecture diagram (project {{project}}, session {{session}}, analysed at {{analyzedAt}}; scope: {{scope}}; view: {{view}}; filter: {{filter}}):',
    project: projectId ?? t('architecture.text.unknownProject', { defaultValue: 'unknown' }),
    session: sessionId ?? t('architecture.text.unknownSession', { defaultValue: 'unknown' }),
    analyzedAt: analyzedLabel,
    scope: scopeLabels[scopeKind],
    view: viewLabel,
    filter: filterSummary,
  });
  const contextText = wrapSessionContext(contextHeader, text);

  const copy = async (value: string, successNotice: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(value);
      setCopyNotice(successNotice);
    } catch {
      // Documented fallback: the same text, selected, in a dialog.
      setFallbackText(value);
    }
  };

  const copyAll = (): void => {
    if (empty) return;
    void copy(text, t('architecture.text.copied', { defaultValue: 'PlantUML copied to the clipboard' }));
  };

  const copyAsContext = (): void => {
    if (empty) return;
    // Above 30k tokens the header + document is a large share of a chat's
    // context, so the reader confirms before it lands on the clipboard.
    if (volume.level === 'huge' && !confirmationOpen) {
      setConfirmationOpen(true);
      return;
    }
    setConfirmationOpen(false);
    void copy(
      contextText,
      t('architecture.text.contextCopied', {
        defaultValue: 'PlantUML and its session header copied to the clipboard',
      }),
    );
  };

  const download = (): void => {
    if (empty) return;
    downloadTextFile(text, architectureExportFilename(granularity, projectId, new Date(), 'puml'));
  };

  const scopeOptions: readonly { readonly id: ArchitectureTextScopeKind; readonly disabled: boolean }[] = [
    { id: 'full', disabled: false },
    { id: 'viewport', disabled: false },
    { id: 'selection', disabled: selection === null },
  ];

  const volumeText = t('architecture.text.volume', {
    defaultValue: '{{characters}} characters · {{lines}} lines · approx. {{tokens}} tokens',
    characters: volume.characters.toLocaleString(i18n.language),
    lines: volume.lines.toLocaleString(i18n.language),
    // The token estimate is the one reading a reader scans rather than counts,
    // so it is compact (`1.2K`); the exact count stays on the data attribute.
    tokens: volume.tokens.toLocaleString(i18n.language, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }),
  });

  return (
    <div data-architecture-text-panel="true" className="flex flex-col gap-2 text-xs text-foreground">
      <div
        role="radiogroup"
        aria-label={t('architecture.text.scope', { defaultValue: 'Text scope' })}
        data-architecture-text-scope="true"
        className="flex flex-wrap items-center gap-1"
      >
        {scopeOptions.map((option) => {
          const selected = option.id === scopeKind;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={option.disabled}
              data-architecture-text-scope-option={option.id}
              style={targetStyle}
              onClick={() => setScopeKind(option.id)}
              className={`rounded border border-border px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40 ${
                selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {scopeLabels[option.id]}
            </button>
          );
        })}
      </div>
      {selection === null && (
        <p data-architecture-text-selection-disabled="true" className="text-[11px] text-muted-foreground">
          {t('architecture.text.scopeSelectionDisabled', {
            defaultValue: 'Select a node or a relation to use this scope.',
          })}
        </p>
      )}

      {empty && (
        <p data-architecture-text-empty="true" className="text-muted-foreground">
          {t('architecture.text.empty', { defaultValue: 'There is nothing to show in the current scope.' })}
        </p>
      )}

      {!empty && (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <span
              data-architecture-text-volume={volume.level}
              data-architecture-text-characters={volume.characters}
              data-architecture-text-lines={volume.lines}
              data-architecture-text-tokens={volume.tokens}
              className={`tabular-nums ${
                volume.level === 'normal'
                  ? 'text-muted-foreground'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            >
              {volumeText}
            </span>
            {updatedVisible && (
              <span data-architecture-text-updated="true" className="text-muted-foreground">
                {t('architecture.text.updated', { defaultValue: 'Updated' })}
              </span>
            )}
            <ArchitectureTextSyntaxBadge text={text} />
          </div>
          {volume.level !== 'normal' && (
            <p
              data-architecture-text-large-hint={volume.level}
              className="text-[11px] text-amber-600 dark:text-amber-400"
            >
              {t('architecture.text.largeHint', {
                defaultValue: 'This is a large document; choosing a smaller scope is usually better.',
              })}
            </p>
          )}
          {preview.truncated && (
            <p data-architecture-text-preview-note="true" className="text-[11px] text-muted-foreground">
              {t('architecture.text.previewNote', {
                defaultValue: 'Showing {{shown}} of {{total}} lines',
                shown: preview.shownLines.toLocaleString(i18n.language),
                total: preview.totalLines.toLocaleString(i18n.language),
              })}
            </p>
          )}
          <pre
            // The dock's tabpanel is a polite live region; the preview itself
            // must not be read aloud line by line on every rebuild.
            aria-live="off"
            data-architecture-text-preview="true"
            className="max-h-[45vh] overflow-auto whitespace-pre rounded border border-border/60 bg-muted/30 p-2 font-mono text-xs"
          >
            {preview.text}
          </pre>
        </>
      )}

      {/* The actions stay on screen in the empty state, disabled: a reader
          whose filter hid everything must be able to see what would be copied
          and why it cannot be. */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-architecture-text-copy="all"
          disabled={empty}
          style={targetStyle}
          onClick={copyAll}
          className="rounded border border-border px-2 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('architecture.text.copy', { defaultValue: 'Copy' })}
        </button>
        <button
          type="button"
          data-architecture-text-copy="context"
          disabled={empty}
          style={targetStyle}
          onClick={copyAsContext}
          className="rounded border border-border px-2 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('architecture.text.copyAsContext', { defaultValue: 'Copy as session context' })}
        </button>
        <button
          type="button"
          data-architecture-text-download="true"
          disabled={empty}
          style={targetStyle}
          onClick={download}
          className="rounded border border-border px-2 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('architecture.text.download', { defaultValue: 'Download .puml' })}
        </button>
      </div>
      <span role="status" aria-live="polite" data-architecture-text-copy-status="true" className="sr-only">
        {copyNotice}
      </span>

      <Dialog
        open={confirmationOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmationOpen(false);
        }}
      >
        <DialogContent
          aria-label={t('architecture.text.confirmTitle', { defaultValue: 'Large PlantUML document' })}
        >
          <div data-architecture-text-confirm="true" className="flex flex-col gap-2 p-4">
            <DialogTitle>
              {t('architecture.text.confirmTitle', { defaultValue: 'Large PlantUML document' })}
            </DialogTitle>
            <p className="text-sm text-foreground">
              {t('architecture.text.confirmBody', {
                defaultValue:
                  'This document is about {{tokens}} tokens. Copying it into a chat will use a large share of the context.',
                tokens: volume.tokens.toLocaleString(i18n.language),
              })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-architecture-text-confirm-cancel="true"
                onClick={() => setConfirmationOpen(false)}
                className="rounded border border-border px-3 py-1 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                {t('architecture.text.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                data-architecture-text-confirm-copy="true"
                onClick={() => {
                  setConfirmationOpen(false);
                  void copy(
                    contextText,
                    t('architecture.text.contextCopied', {
                      defaultValue: 'PlantUML and its session header copied to the clipboard',
                    }),
                  );
                }}
                className="rounded border border-border bg-accent px-3 py-1 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                {t('architecture.text.confirmCopy', { defaultValue: 'Copy anyway' })}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={fallbackText !== null}
        onOpenChange={(open) => {
          if (!open) setFallbackText(null);
        }}
      >
        <DialogContent
          aria-label={t('architecture.text.copyFallbackTitle', {
            defaultValue: 'Copy the PlantUML manually',
          })}
        >
          <div data-architecture-text-fallback="true" className="flex flex-col gap-2 p-4">
            <DialogTitle>
              {t('architecture.text.copyFallbackTitle', {
                defaultValue: 'Copy the PlantUML manually',
              })}
            </DialogTitle>
            <p className="text-sm text-foreground">
              {t('architecture.text.copyFallbackHint', {
                defaultValue: 'Clipboard access is unavailable. Select and copy the text below.',
              })}
            </p>
            <textarea
              ref={fallbackRef}
              readOnly
              value={fallbackText ?? ''}
              aria-label={t('architecture.text.copyFallbackTitle', {
                defaultValue: 'Copy the PlantUML manually',
              })}
              data-architecture-text-fallback-text="true"
              className="h-48 w-full resize-none rounded border border-border bg-background p-2 font-mono text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            />
            <div className="flex justify-end">
              <button
                type="button"
                data-architecture-text-fallback-close="true"
                onClick={() => setFallbackText(null)}
                className="rounded border border-border px-3 py-1 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                {t('architecture.text.close', { defaultValue: 'Close' })}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
