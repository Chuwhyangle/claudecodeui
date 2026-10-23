import { useCallback, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ARCHGUARD_RELATION_ARROWS } from '@yalehwang/plantuml-js/archguard';

import { nodeFileOf, type ArchitectureDiagramView } from '@/modules/architecture/archguardToPlantUml';
import { TOUCH_TARGET_STYLE, useTouchLayout } from '@/modules/architecture/hooks/useTouchLayout';
import {
  buildPlantUmlText,
  measurePlantUmlText,
  TEXT_HUGE_TOKEN_THRESHOLD,
  type ArchitectureTextScope,
} from '@/modules/architecture/plantUmlText';
import type {
  ArchitectureDrawnPlantUml,
  ArchitectureNodeIdShape,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';
import { selectionKey, type ArchitectureSelection } from '@/modules/architecture/selectionModel';
import { formatAbsoluteTime } from '@/shared/utils';

/**
 * How many selected tags the expanded tray draws before it folds the rest into
 * "…and N more". The design's cap: a hundred chips would push the input and the
 * primary action off the canvas.
 */
export const TRAY_VISIBLE_TAG_LIMIT = 20;

/**
 * How many selected ENTITIES still allow "attach the selected subgraph". Above
 * this the serialization itself becomes the problem, so the option is disabled
 * with the reason stated rather than silently producing a huge document.
 */
export const TRAY_ATTACH_ENTITY_LIMIT = 300;

/** One selected thing, resolved to the label the tray and the chat text show. */
type TrayItem = {
  readonly key: string;
  readonly selection: ArchitectureSelection;
  readonly kind: 'entity' | 'relation';
  /** The tag's visible text. */
  readonly label: string;
  /** The entity's kind glyph (an icon-like marker, never colour alone). */
  readonly glyph: string;
  /** A second line for the chat text (the entity's file). */
  readonly detail: string;
};

/** The one-line label for a relation kind, drawn from the same six-way vocabulary as the bridge. */
function relationTypeLabel(
  t: ReturnType<typeof useTranslation>['t'],
  relationType: string,
): string {
  switch (relationType) {
    case 'inheritance':
      return t('architecture.tray.relationInheritance', { defaultValue: 'inheritance' });
    case 'implementation':
      return t('architecture.tray.relationImplementation', { defaultValue: 'implementation' });
    case 'dependency':
      return t('architecture.tray.relationDependency', { defaultValue: 'dependency' });
    case 'call':
      return t('architecture.tray.relationCall', { defaultValue: 'call' });
    case 'composition':
      return t('architecture.tray.relationComposition', { defaultValue: 'composition' });
    case 'aggregation':
      return t('architecture.tray.relationAggregation', { defaultValue: 'aggregation' });
    default:
      return relationType === '' ? t('architecture.tray.relationOther', { defaultValue: 'relation' }) : relationType;
  }
}

/** The arrow the bridge itself uses for this relation kind (never a second mapping). */
function relationArrow(relationType: string): string {
  return ARCHGUARD_RELATION_ARROWS[relationType]?.arrow ?? '..>';
}

/** A short entity-kind marker; the tag's colour is never the only reading. */
function kindGlyph(kind: string | undefined): string {
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
}

/** Everything the selection message needs from the panel; pure, so every entry point shares it. */
export type ArchitectureSelectionMessageInput = {
  readonly selections: readonly ArchitectureSelection[];
  readonly graph: ArchitectureRendererGraph;
  readonly idShape: ArchitectureNodeIdShape;
  /** The project's display name: the header states it instead of the opaque id. */
  readonly projectName?: string | null;
  /** The fallback when the workspace does not know a display name. */
  readonly projectId: string | null;
  readonly analyzedAt: string | null;
};

/**
 * Build the message the "put in chat input" action appends.
 *
 * Exported because FOUR entry points send the same selection to the chat: the
 * tray's primary action, the inspector's Adjust row, the multi-select summary
 * and the canvas context menu. They must not each carry their own copy of this
 * format — the project's display name (never the UUID), the analysis time, one
 * line per selected thing, and, under each selected entity, its relations to
 * the OTHER selected entities.
 *
 * The tray passes its memo and attachment as `extras`; the other entry points
 * send the selection itself.
 */
export function buildSelectionMessage(
  {
    selections,
    graph,
    idShape,
    projectName,
    projectId,
    analyzedAt,
  }: ArchitectureSelectionMessageInput,
  t: TFunction,
  language: string,
  extras: { readonly note?: string; readonly attachment?: string } = {},
): string {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nameOf = (id: string): string => {
    const node = nodeById.get(id);
    return node !== undefined && node.label.trim() !== '' ? node.label : id;
  };
  const selectedEntityIds = new Set<string>();
  for (const selection of selections) {
    if (selection.kind === 'entity') selectedEntityIds.add(selection.nodeId);
  }

  const lines: string[] = [
    t('architecture.tray.messageHeader', {
      defaultValue: 'About these elements in the architecture diagram (project {{project}}, analyzed {{time}}):',
      // The display name is what a reader recognises; the id is only the
      // fallback for an embed that has no workspace context.
      project: projectName?.trim() || projectId || '',
      time: formatAbsoluteTime(analyzedAt, language) ?? analyzedAt ?? '',
    }),
  ];

  for (const selection of selections) {
    if (selection.kind === 'entity') {
      const node = nodeById.get(selection.nodeId);
      lines.push(`- ${t('architecture.tray.entityLine', {
        defaultValue: '{{kind}} `{{name}}`（{{file}}）',
        kind: node?.kind ?? (idShape === 'project-relative' ? 'file' : 'entity'),
        name: nameOf(selection.nodeId),
        file: node === undefined ? '' : nodeFileOf(node, idShape),
      })}`);
      // The relations to OTHER selected entities, stated in the direction the
      // drawing draws them. A relation to an unselected node is not part of
      // what the reader is describing, so it stays out.
      for (const edge of graph.edges) {
        if (edge.from !== selection.nodeId && edge.to !== selection.nodeId) continue;
        const other = edge.from === selection.nodeId ? edge.to : edge.from;
        if (other === selection.nodeId || !selectedEntityIds.has(other)) continue;
        lines.push(`  - ${edge.from === selection.nodeId
          ? t('architecture.tray.relatedOutLine', {
            defaultValue: '{{name}} → {{other}} ({{type}})',
            name: nameOf(selection.nodeId),
            other: nameOf(other),
            type: relationTypeLabel(t, edge.relationType),
          })
          : t('architecture.tray.relatedInLine', {
            defaultValue: '{{name}} ← {{other}} ({{type}})',
            name: nameOf(selection.nodeId),
            other: nameOf(other),
            type: relationTypeLabel(t, edge.relationType),
          })}`);
      }
    } else {
      lines.push(`- ${t('architecture.tray.relationLine', {
        defaultValue: 'Relation: `{{from}}` {{arrow}} `{{to}}` ({{type}})',
        from: nameOf(selection.from),
        arrow: relationArrow(selection.relationType),
        to: nameOf(selection.to),
        type: relationTypeLabel(t, selection.relationType),
      })}`);
    }
  }

  if (extras.note !== undefined && extras.note.trim() !== '') lines.push(extras.note);
  const body = lines.join('\n');
  return extras.attachment === undefined || extras.attachment === ''
    ? body
    : `${body}\n\n\`\`\`plantuml\n${extras.attachment}\n\`\`\``;
}

/**
 * The architecture canvas's selection tray. Used by `ArchitecturePanel` only.
 *
 * It is the "do something with the selection" surface: the selected tags (each
 * removable), a free-text box, an optional attachment of the selected
 * subgraph's PlantUML, and the action that APPENDS the composed text to the
 * current chat draft and switches to the Chat tab. It never sends.
 *
 * On the compact tier the tray merges into a bottom bar and expands into a
 * drawer; on the desktop it floats bottom-centre inside the canvas. The
 * expanded/collapsed state is owned by the panel because Escape collapses the
 * tray before it clears the selection.
 */
export function ArchitectureSelectionTray({
  selections,
  graph,
  idShape,
  view,
  grouping,
  drawn,
  projectId,
  projectName = null,
  analyzedAt,
  canCompose,
  canRemove,
  multiSelect,
  expanded,
  compact,
  bottomInset = 0,
  onExpandedChange,
  onExitMultiSelect,
  onToggleItem,
  onClear,
  onCompose,
  onRemoveSelected,
}: ArchitectureSelectionTrayProps) {
  const { t, i18n } = useTranslation();
  const { coarsePointer } = useTouchLayout();
  const targetStyle = coarsePointer ? TOUCH_TARGET_STYLE : undefined;
  // What the reader has typed in the tray's box. Local to the tray: the text is
  // only read when the primary action is pressed, and losing it when the tray
  // closes is the documented behaviour (the important half is the appended
  // draft, which lives in the shared draft store).
  const [text, setText] = useState('');
  // Whether the selected subgraph's PlantUML is attached to the composed text.
  const [attach, setAttach] = useState(false);
  // Which subgraph the attachment covers: exactly the selection, or its one-hop
  // neighbourhood. Only rendered while the attachment is on.
  const [attachScope, setAttachScope] = useState<'selected' | 'neighbours'>('selected');
  // The last copy attempt's status, announced through the live region. Local
  // because it only matters while the tray is on screen.
  const [copyStatus, setCopyStatus] = useState('');

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );
  const nameOf = useCallback((id: string): string => {
    const node = nodeById.get(id);
    return node !== undefined && node.label.trim() !== '' ? node.label : id;
  }, [nodeById]);

  const items = useMemo<TrayItem[]>(() => selections.map((selection) => {
    if (selection.kind === 'entity') {
      const node = nodeById.get(selection.nodeId);
      return {
        key: selectionKey(selection),
        selection,
        kind: 'entity',
        label: nameOf(selection.nodeId),
        glyph: kindGlyph(node?.kind),
        detail: node === undefined ? '' : nodeFileOf(node, idShape),
      };
    }
    return {
      key: selectionKey(selection),
      selection,
      kind: 'relation',
      label: `${nameOf(selection.from)} → ${nameOf(selection.to)}`,
      glyph: '→',
      detail: '',
    };
  }), [selections, nodeById, idShape, nameOf]);

  const entityCount = items.filter((item) => item.kind === 'entity').length;
  const selectedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const selection of selections) {
      if (selection.kind === 'entity') ids.add(selection.nodeId);
      else {
        ids.add(selection.from);
        ids.add(selection.to);
      }
    }
    return [...ids];
  }, [selections]);

  // The attachment document, and its volume reading. `buildPlantUmlText` is the
  // text page's own builder, and `measurePlantUmlText` its own volume grading,
  // so the tray cannot drift from what the Text tab would say.
  const attachedScope = useMemo<ArchitectureTextScope | null>(() => {
    if (selectedNodeIds.length === 0) return null;
    return attachScope === 'selected'
      ? { kind: 'selected', nodeIds: selectedNodeIds }
      : { kind: 'selection', nodeIds: selectedNodeIds };
  }, [attachScope, selectedNodeIds]);
  const attachedPuml = useMemo(() => {
    if (attachedScope === null) return '';
    try {
      return buildPlantUmlText(graph, attachedScope, { view, grouping, idShape, drawn });
    } catch {
      // The scope cannot be expressed (an anchor was folded away): omit the
      // attachment instead of blocking the compose action.
      return '';
    }
  }, [attachedScope, graph, view, grouping, idShape, drawn]);
  const volume = useMemo(
    () => (attachedPuml === '' ? null : measurePlantUmlText(attachedPuml)),
    [attachedPuml],
  );

  // Why the attachment cannot be offered, if it cannot. Both reasons are stated
  // in the UI; the compose action itself stays available without the fence.
  const tooManyEntities = entityCount > TRAY_ATTACH_ENTITY_LIMIT;
  const tooHuge = !tooManyEntities && volume !== null && volume.tokens > TEXT_HUGE_TOKEN_THRESHOLD;
  const attachDisabled = tooManyEntities || tooHuge;
  const attached = attach && !attachDisabled && attachedPuml !== '';

  // The tray's own contribution is the memo and the optional attachment; the
  // selection message itself is the shared builder above, so the inspector,
  // the context menu and the multi-select summary send the same text.
  const compose = (): void => {
    onCompose(buildSelectionMessage(
      { selections, graph, idShape, projectName, projectId, analyzedAt },
      t,
      i18n.language,
      attached ? { note: text, attachment: attachedPuml } : { note: text },
    ));
  };

  const copyPuml = async (): Promise<void> => {
    if (attachedPuml === '') return;
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(attachedPuml);
      setCopyStatus(t('architecture.tray.copied', { defaultValue: 'PlantUML copied' }));
    } catch {
      setCopyStatus(t('architecture.tray.copyFailed', { defaultValue: 'Could not copy the PlantUML' }));
    }
  };

  const visibleItems = items.slice(0, TRAY_VISIBLE_TAG_LIMIT);
  const hiddenCount = items.length - visibleItems.length;

  const volumeReading = volume !== null && (
    <span
      data-architecture-tray-volume={volume.tokens}
      data-architecture-tray-volume-level={volume.level}
      className={`text-[11px] tabular-nums ${
        volume.level === 'normal' ? 'text-muted-foreground' : 'font-medium text-amber-600'
      }`}
    >
      {t('architecture.tray.volume', {
        defaultValue: 'approx. {{tokens}} tokens',
        tokens: volume.tokens.toLocaleString(i18n.language),
      })}
    </span>
  );

  const body = (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-foreground" data-architecture-tray-count={items.length}>
          {t('architecture.tray.count', { defaultValue: '{{count}} selected', count: items.length })}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-architecture-tray-clear="true"
          onClick={onClear}
          style={targetStyle}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.tray.clear', { defaultValue: 'Clear selection' })}
        </button>
        <button
          type="button"
          data-architecture-tray-collapse="true"
          aria-expanded={expanded}
          aria-label={t('architecture.tray.collapse', { defaultValue: 'Collapse the selection tray' })}
          onClick={() => onExpandedChange(false)}
          style={targetStyle}
          className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          ▾
        </button>
      </div>

      <div className="flex min-h-0 flex-wrap gap-1 overflow-y-auto" data-architecture-tray-tags="true">
        {visibleItems.map((item) => (
          <span
            key={item.key}
            data-architecture-tray-item={item.key}
            data-architecture-tray-item-kind={item.kind}
            data-architecture-tray-item-label={item.label}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-foreground"
          >
            <span aria-hidden="true" className="font-mono text-[10px] text-muted-foreground">{item.glyph}</span>
            <span className="truncate">{item.label}</span>
            <button
              type="button"
              data-architecture-tray-remove={item.key}
              aria-label={t('architecture.tray.remove', {
                defaultValue: 'Deselect {{name}}',
                name: item.label,
              })}
              onClick={() => onToggleItem(item.selection)}
              style={targetStyle}
              className="rounded-full px-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              ×
            </button>
          </span>
        ))}
        {hiddenCount > 0 && (
          <span data-architecture-tray-more={hiddenCount} className="text-[11px] text-muted-foreground">
            {t('architecture.tray.more', { defaultValue: '…and {{count}} more', count: hiddenCount })}
          </span>
        )}
      </div>

      <textarea
        data-architecture-tray-input="true"
        aria-label={t('architecture.tray.inputLabel', { defaultValue: 'Message about the selection' })}
        placeholder={t('architecture.tray.placeholder', { defaultValue: 'Say something about these elements…' })}
        value={text}
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
        onChange={(event) => setText(event.target.value)}
        className="w-full resize-none rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-primary/60"
      />

      <div className="flex flex-col gap-1 text-[11px] text-foreground">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            data-architecture-tray-attach="true"
            checked={attach}
            disabled={attachDisabled}
            onChange={(event) => setAttach(event.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
          <span>{t('architecture.tray.attach', { defaultValue: "Attach the selected subgraph's PlantUML" })}</span>
        </label>
        {tooManyEntities && (
          <span data-architecture-tray-attach-disabled="too-many" className="text-amber-600">
            {t('architecture.tray.tooMany', {
              defaultValue: 'Attaching PlantUML is disabled: {{count}} entities are selected (limit {{limit}}). Select fewer.',
              count: entityCount,
              limit: TRAY_ATTACH_ENTITY_LIMIT,
            })}
          </span>
        )}
        {tooHuge && (
          <span data-architecture-tray-attach-disabled="too-huge" className="text-amber-600">
            {t('architecture.tray.tooHuge', {
              defaultValue: 'Too large to attach (approx. {{tokens}} tokens). Choose a smaller scope.',
              tokens: (volume?.tokens ?? 0).toLocaleString(i18n.language),
            })}
          </span>
        )}
        {attach && !attachDisabled && (
          <span className="flex flex-wrap items-center gap-2">
            <select
              data-architecture-tray-scope="true"
              aria-label={t('architecture.tray.scopeLabel', { defaultValue: 'Attachment scope' })}
              value={attachScope}
              onChange={(event) => setAttachScope(event.target.value === 'neighbours' ? 'neighbours' : 'selected')}
              className="rounded border border-border bg-background px-1 py-0.5 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <option value="selected">{t('architecture.tray.scopeSelected', { defaultValue: 'Selected only' })}</option>
              <option value="neighbours">{t('architecture.tray.scopeNeighbours', { defaultValue: 'With +1 neighbour' })}</option>
            </select>
            {volumeReading}
          </span>
        )}
        {attach && !attachDisabled && volume !== null && volume.level === 'large' && (
          <span data-architecture-tray-volume-warning="true" className="text-amber-600">
            {t('architecture.tray.volumeLarge', {
              defaultValue: 'This attachment is large (approx. {{tokens}} tokens).',
              tokens: volume.tokens.toLocaleString(i18n.language),
            })}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-architecture-tray-compose="true"
          disabled={!canCompose}
          onClick={compose}
          style={targetStyle}
          className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('architecture.tray.compose', { defaultValue: 'Put in the input and switch to chat' })}
        </button>
        <button
          type="button"
          data-architecture-tray-remove-selected="true"
          disabled={!canRemove}
          onClick={onRemoveSelected}
          style={targetStyle}
          className="rounded-lg border border-border px-2 py-1 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('architecture.tray.removeSelected', { defaultValue: 'Remove selected' })}
        </button>
        <button
          type="button"
          data-architecture-tray-copy="true"
          disabled={attachedPuml === ''}
          onClick={() => void copyPuml()}
          style={targetStyle}
          className="rounded-lg border border-border px-2 py-1 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('architecture.tray.copyPuml', { defaultValue: 'Copy PlantUML' })}
        </button>
      </div>
      {!canCompose && (
        <span data-architecture-tray-no-session="true" className="text-[11px] text-muted-foreground">
          {t('architecture.tray.noSession', {
            defaultValue: 'Select a session to put text in the input box.',
          })}
        </span>
      )}
    </div>
  );

  return (
    <div
      data-architecture-tray-root="true"
      data-architecture-tray-expanded={expanded ? 'true' : 'false'}
      data-architecture-tray-selected={items.length}
      style={{ position: 'absolute', inset: 0, zIndex: 45, pointerEvents: 'none' }}
    >
      {multiSelect && (
        <div
          data-architecture-multiselect-bar="true"
          role="status"
          style={{
            position: 'absolute',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            pointerEvents: 'auto',
          }}
          className="flex items-center gap-2 rounded-full border border-border bg-popover px-2 py-0.5 text-[11px] font-medium text-foreground shadow-sm"
        >
          <span data-architecture-multiselect-count={items.length}>
            {t('architecture.tray.multiSelectBar', {
              defaultValue: 'Multi-select · {{count}} selected',
              count: items.length,
            })}
          </span>
          <button
            type="button"
            data-architecture-multiselect-done="true"
            onClick={onExitMultiSelect}
            style={targetStyle}
            className="rounded-full border border-border px-1.5 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t('architecture.tray.done', { defaultValue: 'Done' })}
          </button>
        </div>
      )}

      {!expanded && (
        <button
          type="button"
          data-architecture-tray-pill="true"
          aria-expanded={expanded}
          aria-label={t('architecture.tray.expand', { defaultValue: 'Expand the selection tray' })}
          onClick={() => onExpandedChange(true)}
          style={{
            position: 'absolute',
            bottom: 8 + bottomInset,
            pointerEvents: 'auto',
            ...(compact
              ? { left: 0, right: 0, margin: '0 auto' }
              : { left: '50%', transform: 'translateX(-50%)' }),
            ...(targetStyle ?? {}),
          }}
          className="rounded-full border border-border bg-popover px-3 py-1 text-xs font-medium text-foreground shadow-lg outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.tray.pill', {
            // The pill is the only thing visible while the tray is collapsed, so
            // it names the action, not just the count.
            defaultValue: '{{count}} selected · Send to chat ▴',
            count: items.length,
          })}
        </button>
      )}

      {expanded && (
        <div
          role="region"
          aria-label={t('architecture.tray.region', { defaultValue: 'Selection' })}
          data-architecture-tray-expanded-panel="true"
          style={{
            position: 'absolute',
            bottom: compact ? bottomInset : 8 + bottomInset,
            left: compact ? 0 : '50%',
            right: compact ? 0 : undefined,
            transform: compact ? undefined : 'translateX(-50%)',
            width: compact ? undefined : 'min(560px, calc(100% - 24px))',
            maxHeight: compact
              // Lifted above an overlaid drawer, the panel may not run past the
              // top of the canvas: its old 60vh ceiling would, because the
              // drawer already owns the bottom share of the viewport.
              ? (bottomInset > 0 ? 'calc(55vh - 8px)' : '60vh')
              : '55%',
            pointerEvents: 'auto',
            ...(compact ? {} : { minWidth: 280 }),
          }}
          className="flex min-h-0 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-xl"
        >
          {body}
        </div>
      )}

      {/* The selection count changes are announced without moving focus. */}
      <span
        role="status"
        aria-live="polite"
        data-architecture-tray-live="true"
        className="sr-only"
      >
        {t('architecture.tray.live', {
          defaultValue: '{{count}} elements selected',
          count: items.length,
        })}
        {copyStatus === '' ? '' : ` ${copyStatus}`}
      </span>
    </div>
  );
}

type ArchitectureSelectionTrayProps = {
  /** The ordered selection set (the panel's state). */
  readonly selections: readonly ArchitectureSelection[];
  /** The drawn graph, used to resolve names and to scope the attachment. */
  readonly graph: ArchitectureRendererGraph;
  readonly idShape: ArchitectureNodeIdShape;
  /** The view on screen, so the attached document matches the drawing. */
  readonly view: ArchitectureDiagramView;
  readonly grouping: 'raw' | 'adaptive';
  readonly drawn: ArchitectureDrawnPlantUml | null;
  readonly projectId: string | null;
  /** The project's display name for the message header; the id is only the fallback. */
  readonly projectName?: string | null;
  /** The analysis time the message header states (null when the payload has none). */
  readonly analyzedAt: string | null;
  /** False when there is no chat to write to (no session); disables the primary action. */
  readonly canCompose: boolean;
  /** False when curation cannot run (no session); disables "Remove selected". */
  readonly canRemove: boolean;
  /** Whether the touch multi-select mode is on (draws the top bar). */
  readonly multiSelect: boolean;
  /** Whether the body is expanded instead of the pill. Owned by the panel (Escape). */
  readonly expanded: boolean;
  /** True on the compact tier: bottom bar + drawer instead of the floating panel. */
  readonly compact: boolean;
  /**
   * How much of the tray root's bottom edge is covered by chrome drawn OVER the
   * canvas (the coarse-tier inspector drawer). The tray is lifted by this many
   * pixels so its pill and its expanded panel never sit underneath the drawer's
   * content. 0 on the desktop tier, where the dock narrows the canvas instead.
   */
  readonly bottomInset?: number;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onExitMultiSelect: () => void;
  readonly onToggleItem: (selection: ArchitectureSelection) => void;
  readonly onClear: () => void;
  /** Receives the finished message body; the panel appends it to the chat draft. */
  readonly onCompose: (text: string) => void;
  readonly onRemoveSelected: () => void;
};
