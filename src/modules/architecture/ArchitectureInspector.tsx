import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { nodeFileOf } from '@/modules/architecture/archguardToPlantUml';
import {
  MENTION_HIT_LIMIT,
  useMentions,
  type ArchitectureMentionHit,
} from '@/modules/architecture/hooks/useMentions';
import type { ArchitectureSelection } from '@/modules/architecture/selectionModel';
import type {
  ArchitectureNodeIdShape,
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
} from '@/modules/architecture/rendererContract';
import { requestLocateMessage } from '@/shared/chatMessageLocator';
import { formatAbsoluteTime, formatRelativeTime } from '@/shared/utils';

/** How many leading members the overview page lists before "show all". */
const MEMBER_PREVIEW_COUNT = 8;

/** How many underlying edges a selected aggregate relation lists. */
const UNDERLYING_EDGE_LIMIT = 20;

/** The relation kinds the inspector names with a UML word (mirrors the server's vocabulary). */
const RELATION_LABEL_KEYS: Readonly<Record<string, string>> = {
  inheritance: 'architecture.relation.inheritance',
  implementation: 'architecture.relation.implementation',
  composition: 'architecture.relation.composition',
  aggregation: 'architecture.relation.aggregation',
  dependency: 'architecture.relation.dependency',
  call: 'architecture.relation.call',
};

type ArchitectureInspectorProps = {
  /** The one selected entity or relation. */
  readonly selection: ArchitectureSelection;
  /** The graph on screen (filtered payload), the source of degrees and endpoints. */
  readonly graph: ArchitectureRendererGraph;
  /** How node ids are shaped, so a file path is derived correctly. */
  readonly idShape: ArchitectureNodeIdShape;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  /** Whether tool output is searched too; the panel remembers this choice. */
  readonly includeToolResults: boolean;
  readonly onIncludeToolResultsChange: (value: boolean) => void;
  /** Selects a related node without leaving the inspector. */
  readonly onSelectNode: (nodeId: string) => void;
  /** Selects AND centres a related node in the drawing. */
  readonly onCenterNode: (nodeId: string) => void;
  /** Switches the workspace to the Chat tab (the message-locate seam's second half). */
  readonly onOpenChat?: () => void;
  /**
   * Manual curation hooks. All optional so the inspector keeps working without
   * a store (a shell embedding it, or the pre-curation tests): when omitted, no
   * adjustment section is drawn at all.
   */
  readonly canCurate?: boolean;
  readonly pinned?: boolean;
  readonly onPinNode?: (node: ArchitectureRendererNode) => void;
  readonly onUnpinNode?: (node: ArchitectureRendererNode) => void;
  readonly onRemoveNode?: (node: ArchitectureRendererNode) => void;
  readonly onHideRelation?: (edge: ArchitectureRendererEdge) => void;
  /**
   * Per node, the relations the filter hid, by relation type. The inspector
   * states them instead of printing a bare "0 in · 0 out"; omitted when the
   * caller has no hidden reading.
   */
  readonly hiddenRelations?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /**
   * Widens the relation filter to include one type — the "Show calls" action
   * beside a hidden-relation reading. Omitted when the host has no filter.
   */
  readonly onShowRelationType?: (relationType: string) => void;
};

/** The entity's display name: its label, or the id's tail when the label repeats the id. */
function nodeName(node: ArchitectureRendererNode): string {
  const label = node.label.trim();
  if (label !== '' && label !== node.id) return label;
  const dot = node.id.lastIndexOf('.');
  const slash = node.id.lastIndexOf('/');
  return node.id.slice(Math.max(dot, slash) + 1);
}

/** The glyph the header draws beside the kind word (never the only signal: the kind is written). */
function kindGlyph(node: ArchitectureRendererNode): string {
  switch (node.kind) {
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

/** The localized kind word, reusing the filter's vocabulary so the two readings agree. */
function kindLabelKey(node: ArchitectureRendererNode): string {
  switch (node.kind) {
    case 'interface':
      return 'architecture.filter.kindInterface';
    case 'enum':
      return 'architecture.filter.kindEnum';
    case 'abstract':
      return 'architecture.filter.kindAbstract';
    case 'function':
      return 'architecture.filter.kindFunction';
    case 'class':
      return 'architecture.filter.kindClass';
    default:
      return 'architecture.filter.kindOther';
  }
}

/** One transcript hit row: a TYPE badge, relative time, and the excerpt with the name marked. */
function MentionRow({
  hit,
  name,
  locale,
  onLocate,
  locateLabel,
}: {
  readonly hit: ArchitectureMentionHit;
  readonly name: string;
  readonly locale: string;
  readonly onLocate: () => void;
  readonly locateLabel: string;
}) {
  const { t } = useTranslation();
  // The badge says WHAT the row is, not who spoke: a Read-tool hit is not an
  // assistant message, and calling it one was half the reported confusion.
  const badgeKey = hit.kind === 'tool_result' ? 'tool' : hit.kind === 'tool_use' ? 'tool-file' : 'message';
  const badgeLabel = hit.kind === 'tool_result'
    ? t('architecture.mentions.roleTool', { defaultValue: 'Tool output' })
    : hit.kind === 'tool_use'
      ? t('architecture.copyFix.mentionBadgeToolFile', {
          defaultValue: 'Tool: {{tool}} file',
          tool: hit.toolName ?? t('architecture.copyFix.mentionBadgeToolUnknown', { defaultValue: 'file' }),
        })
      : t('architecture.copyFix.mentionBadgeMessage', { defaultValue: 'Message' });
  const fileOnly = hit.match === 'file';

  // Highlight every occurrence of the name in the excerpt. The split is
  // case-insensitive and keeps the original text, so a path hit highlights the
  // path exactly as the server excerpted it.
  const segments = useMemo(() => {
    if (name === '') return [{ text: hit.excerpt, marked: false }];
    const lower = hit.excerpt.toLowerCase();
    const needle = name.toLowerCase();
    const parts: { text: string; marked: boolean }[] = [];
    let from = 0;
    let index = lower.indexOf(needle);
    while (index !== -1) {
      if (index > from) parts.push({ text: hit.excerpt.slice(from, index), marked: false });
      parts.push({ text: hit.excerpt.slice(index, index + name.length), marked: true });
      from = index + name.length;
      index = lower.indexOf(needle, from);
    }
    if (from < hit.excerpt.length) parts.push({ text: hit.excerpt.slice(from), marked: false });
    return parts;
  }, [hit.excerpt, name]);

  return (
    <li>
      <button
        type="button"
        onClick={onLocate}
        aria-label={locateLabel}
        data-architecture-mention={hit.messageId}
        data-architecture-mention-role={hit.role ?? (hit.kind === 'tool_result' ? 'tool' : 'assistant')}
        data-architecture-mention-type={badgeKey}
        data-architecture-mention-match={hit.match ?? 'name'}
        className="flex w-full flex-col items-start gap-0.5 rounded px-1 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span className="flex items-center gap-1.5 text-[10px] font-medium">
          <span
            data-architecture-mention-badge={badgeKey}
            className="rounded bg-muted px-1 py-0.5 text-muted-foreground"
          >
            {badgeLabel}
          </span>
          <time
            dateTime={hit.at}
            title={formatAbsoluteTime(hit.at, locale)}
            className="text-muted-foreground"
          >
            {formatRelativeTime(hit.at, locale)}
          </time>
        </span>
        {fileOnly && (
          <span
            data-architecture-mention-file-only="true"
            className="text-[10px] italic text-muted-foreground"
          >
            {t('architecture.copyFix.mentionFileOnly', { defaultValue: 'mentioned the file, not the name' })}
          </span>
        )}
        <span className="line-clamp-2 text-[11px] text-foreground">
          {segments.map((segment, index) => (segment.marked ? (
            <mark
              // The excerpt is ordered and immutable; its index is a stable key.
              key={index}
              data-architecture-mention-mark="true"
              className="rounded bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30"
            >
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          )))}
        </span>
      </button>
    </li>
  );
}

/**
 * The inspector's mention reading: its five states (loading, empty, error,
 * truncated, ambiguous) and the hit list. Shared by the entity's sessions page
 * and the relation's co-mentions so the two can never drift in wording.
 */
function MentionsSection({
  view,
  name,
  distance,
  truncated,
  ambiguousCount,
  locale,
  onRetry,
  onLocate,
}: {
  readonly view: ReturnType<typeof useMentions>['view'];
  readonly name: string;
  readonly distance: number | null;
  readonly truncated: boolean;
  /** How many same-named entities exist, or `null` when the name is unambiguous. */
  readonly ambiguousCount: number | null;
  readonly locale: string;
  readonly onRetry: () => void;
  readonly onLocate: (hit: ArchitectureMentionHit) => void;
}) {
  const { t } = useTranslation();

  if (view.status === 'idle') return null;
  if (view.status === 'loading') {
    return (
      <div
        data-architecture-mentions-loading="true"
        aria-busy="true"
        className="flex flex-col gap-1"
      >
        {[0, 1, 2].map((row) => (
          <span
            key={row}
            data-architecture-mentions-skeleton="true"
            className="h-6 animate-pulse rounded bg-muted"
          />
        ))}
      </div>
    );
  }
  if (view.status === 'error') {
    return (
      <div data-architecture-mentions-error="true" className="flex flex-col gap-1">
        <p role="alert" className="text-[11px] text-destructive">
          {t('architecture.mentions.error', { defaultValue: 'The mentions could not be loaded.' })}
        </p>
        <button
          type="button"
          onClick={onRetry}
          data-architecture-mentions-retry="true"
          className="self-start rounded border border-border px-2 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('architecture.mentions.retry', { defaultValue: 'Retry' })}
        </button>
      </div>
    );
  }

  const hits = view.result.edge?.coMentions ?? view.result.mentions[0]?.hits ?? [];
  const ambiguousEntity = view.result.mentions[0];

  return (
    <div className="flex flex-col gap-1" data-architecture-mentions="true">
      {ambiguousEntity?.ambiguous === true && ambiguousCount !== null && (
        <p
          role="note"
          data-architecture-mentions-ambiguous={ambiguousCount}
          className="rounded border border-border/60 bg-muted/50 px-1.5 py-1 text-[10px] text-muted-foreground"
        >
          {t('architecture.mentions.ambiguous', {
            defaultValue: 'The name {{name}} matches {{count}} entities, so a hit may point at any of them.',
            name,
            count: ambiguousCount,
          })}
        </p>
      )}
      {truncated && (
        <p
          data-architecture-mentions-truncated="true"
          className="text-[10px] text-muted-foreground"
        >
          {t('architecture.mentions.truncated', {
            defaultValue: 'Showing only the first {{count}}.',
            count: MENTION_HIT_LIMIT,
          })}
        </p>
      )}
      {hits.length === 0 ? (
        <p data-architecture-mentions-empty="true" className="text-[11px] text-muted-foreground">
          {t('architecture.mentions.empty', {
            defaultValue:
              'The conversation never names it directly. It is in the graph because it is {{count}} hop(s) from the nearest mention.',
            count: distance ?? 1,
          })}
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-architecture-mentions-list="true">
          {hits.map((hit) => (
            <MentionRow
              key={`${hit.messageId}:${hit.excerpt.slice(0, 16)}`}
              hit={hit}
              name={name}
              locale={locale}
              locateLabel={t('architecture.mentions.locate', { defaultValue: 'Locate this message' })}
              onLocate={() => onLocate(hit)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The tool-output opt-in, shared by both inspector shapes. */
function ToolResultsToggle({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-architecture-include-tool-results="true"
      />
      {t('architecture.mentions.includeToolResults', { defaultValue: 'Include tool output' })}
    </label>
  );
}

/** The entity inspector: header, overview page and sessions page. */
function EntityInspector({
  node,
  graph,
  idShape,
  projectId,
  sessionId,
  includeToolResults,
  onIncludeToolResultsChange,
  onSelectNode,
  onCenterNode,
  onOpenChat,
  canCurate = false,
  pinned = false,
  onPinNode,
  onUnpinNode,
  onRemoveNode,
  hiddenRelations,
  onShowRelationType,
}: {
  readonly node: ArchitectureRendererNode;
  readonly graph: ArchitectureRendererGraph;
  readonly idShape: ArchitectureNodeIdShape;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly includeToolResults: boolean;
  readonly onIncludeToolResultsChange: (value: boolean) => void;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onCenterNode: (nodeId: string) => void;
  readonly onOpenChat?: () => void;
  readonly canCurate?: boolean;
  readonly pinned?: boolean;
  readonly onPinNode?: (node: ArchitectureRendererNode) => void;
  readonly onUnpinNode?: (node: ArchitectureRendererNode) => void;
  readonly onRemoveNode?: (node: ArchitectureRendererNode) => void;
  readonly hiddenRelations?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly onShowRelationType?: (relationType: string) => void;
}) {
  const { t, i18n } = useTranslation();
  // Which page the inspector shows. Session-scoped (not remembered): a new
  // selection opens on the overview, the page that answers "what is this?".
  const [page, setPage] = useState<'overview' | 'sessions'>('overview');
  // The members list's expansion. It only grows the overview page, so it is
  // local to the inspector rather than panel state.
  const [membersExpanded, setMembersExpanded] = useState(false);

  const name = nodeName(node);
  const file = nodeFileOf(node, idShape);

  const { incoming, outgoing, relatedByType } = useMemo(() => {    const inEdges: ArchitectureRendererEdge[] = [];
    const outEdges: ArchitectureRendererEdge[] = [];
    const grouped = new Map<string, { node: ArchitectureRendererNode; direction: 'in' | 'out' }[]>();
    const byId = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
    for (const edge of graph.edges) {
      const direction = edge.to === node.id ? 'in' : edge.from === node.id ? 'out' : null;
      if (direction === null) continue;
      if (direction === 'in') inEdges.push(edge);
      else outEdges.push(edge);
      const otherId = direction === 'in' ? edge.from : edge.to;
      const other = byId.get(otherId);
      if (other === undefined) continue;
      const list = grouped.get(edge.relationType) ?? [];
      list.push({ node: other, direction });
      grouped.set(edge.relationType, list);
    }
    return { incoming: inEdges.length, outgoing: outEdges.length, relatedByType: grouped };
  }, [graph, node.id]);

  // The relation axis's removals for THIS box: a function with "0 in · 0 out"
  // usually lost its calls to the filter, not to the analysis.
  const hiddenRelationsOfNode = hiddenRelations?.[node.id] ?? {};
  const hiddenRelationTypes = Object.keys(hiddenRelationsOfNode)
    .filter((type) => (hiddenRelationsOfNode[type] ?? 0) > 0)
    .sort();
  const hiddenRelationTotal = hiddenRelationTypes
    .reduce((total, type) => total + (hiddenRelationsOfNode[type] ?? 0), 0);

  const { view, reload } = useMentions({
    projectId,
    sessionId,
    entityIds: [node.id],
    includeToolResults,
    enabled: projectId !== null && sessionId !== null,
  });
  const hitCount = view.status === 'loaded'
    ? (view.result.mentions[0]?.hits.length ?? 0)
    : undefined;
  const ambiguousCount = view.status === 'loaded' && view.result.mentions[0]?.ambiguous === true
    ? view.result.mentions[0].candidateCount
    : null;

  const members = node.members ?? [];
  const visibleMembers = membersExpanded ? members : members.slice(0, MEMBER_PREVIEW_COUNT);

  const relationLabel = (relationType: string): string => {
    const key = RELATION_LABEL_KEYS[relationType];
    return key === undefined ? relationType : t(key, { defaultValue: relationType });
  };

  return (
    <div data-architecture-inspector="true" data-architecture-inspector-kind="entity">
      <header data-architecture-inspector-header="true" className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            data-architecture-inspector-glyph="true"
            className="flex h-4 w-4 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground"
          >
            {kindGlyph(node)}
          </span>
          <span
            data-architecture-inspector-name={name}
            className="truncate text-sm font-semibold text-foreground"
          >
            {name}
          </span>
        </span>
        {/* The path is front-truncated by CSS (the tail is what identifies the
            file), with the full path one hover away. */}
        {file !== '' && (
          <span
            title={file}
            data-architecture-inspector-path={file}
            className="truncate text-[10px] text-muted-foreground"
            dir="rtl"
          >
            {file}
          </span>
        )}
      </header>

      <div role="tablist" aria-label={t('architecture.dock.title', { defaultValue: 'Inspector' })} className="mt-2 flex gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={page === 'overview'}
          data-architecture-inspector-tab="overview"
          onClick={() => setPage('overview')}
          className={`rounded px-2 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
            page === 'overview' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('architecture.inspector.overview', { defaultValue: 'Overview' })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={page === 'sessions'}
          data-architecture-inspector-tab="sessions"
          onClick={() => setPage('sessions')}
          className={`rounded px-2 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
            page === 'sessions' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('architecture.inspector.sessions', { defaultValue: 'Sessions' })}
          {hitCount !== undefined && (
            <span data-architecture-inspector-hit-count={hitCount} className="ml-1 tabular-nums text-muted-foreground">
              {hitCount}
            </span>
          )}
        </button>
      </div>

      {page === 'overview' ? (
        <div data-architecture-inspector-page="overview" className="mt-2 flex flex-col gap-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            <dt className="text-muted-foreground">{t('architecture.inspector.kind', { defaultValue: 'Kind' })}</dt>
            <dd data-architecture-inspector-kind-label={node.kind ?? 'other'}>
              {t(kindLabelKey(node), { defaultValue: node.kind ?? 'other' })}
            </dd>
            <dt className="text-muted-foreground">{t('architecture.inspector.degree', { defaultValue: 'Relations' })}</dt>
            <dd>
              <span data-architecture-inspector-in-degree={incoming}>
                {t('architecture.inspector.inDegree', { defaultValue: '{{count}} in', count: incoming })}
              </span>
              {' · '}
              <span data-architecture-inspector-out-degree={outgoing}>
                {t('architecture.inspector.outDegree', { defaultValue: '{{count}} out', count: outgoing })}
              </span>
              {hiddenRelationTotal > 0 && (
                <>
                  {' · '}
                  <span
                    data-architecture-inspector-hidden-relations={hiddenRelationTotal}
                    data-architecture-inspector-hidden-relation-types={hiddenRelationTypes.join(',')}
                    title={hiddenRelationTypes.map(relationLabel).join(', ')}
                  >
                    {t('architecture.copyFix.inspectorHiddenRelations', {
                      defaultValue: '{{count}} hidden by the filter ({{relations}})',
                      count: hiddenRelationTotal,
                      relations: hiddenRelationTypes.map(relationLabel).join(', '),
                    })}
                  </span>
                  {onShowRelationType !== undefined && hiddenRelationTypes.length > 0 && (
                    <button
                      type="button"
                      data-architecture-inspector-show-relation={hiddenRelationTypes[0]}
                      onClick={() => onShowRelationType(hiddenRelationTypes[0])}
                      className="ml-1 font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      {t('architecture.copyFix.showRelation', {
                        defaultValue: '▸ Show {{relation}}',
                        relation: relationLabel(hiddenRelationTypes[0]),
                      })}
                    </button>
                  )}
                </>
              )}
            </dd>
          </dl>

          {(onPinNode !== undefined || onUnpinNode !== undefined || onRemoveNode !== undefined) && (
            <section data-architecture-inspector-curation="true" className="flex flex-col gap-1">
              <h4 className="text-[11px] font-medium text-muted-foreground">
                {t('architecture.curation.heading', { defaultValue: 'Adjust' })}
              </h4>
              <span className="flex flex-wrap gap-1">
                {pinned
                  ? onUnpinNode !== undefined && (
                      <button
                        type="button"
                        data-architecture-inspector-unpin={node.id}
                        disabled={!canCurate}
                        onClick={() => onUnpinNode(node)}
                        className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {t('architecture.curation.unpin', { defaultValue: 'Unpin' })}
                      </button>
                    )
                  : onPinNode !== undefined && (
                      <button
                        type="button"
                        data-architecture-inspector-pin={node.id}
                        disabled={!canCurate}
                        onClick={() => onPinNode(node)}
                        className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {t('architecture.curation.pin', { defaultValue: 'Pin to graph' })}
                      </button>
                    )}
                {pinned && (
                  <span
                    data-architecture-inspector-pinned-badge="true"
                    className="rounded bg-accent px-1 py-0.5 text-[10px] text-foreground"
                  >
                    {t('architecture.curation.pinnedBadge', { defaultValue: 'Pinned' })}
                  </span>
                )}
                {onRemoveNode !== undefined && (
                  <button
                    type="button"
                    data-architecture-inspector-remove={node.id}
                    disabled={!canCurate}
                    onClick={() => onRemoveNode(node)}
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('architecture.curation.removeEntity', { defaultValue: 'Remove from graph' })}
                  </button>
                )}
              </span>
            </section>
          )}

          {members.length > 0 && (
            <section data-architecture-inspector-members={members.length}>
              <h4 className="text-[11px] font-medium text-muted-foreground">
                {t('architecture.inspector.members', { defaultValue: 'Members' })}
              </h4>
              <ul className="flex flex-col gap-0.5 text-[11px] text-foreground">
                {visibleMembers.map((member) => (
                  <li key={`${member.kind}:${member.name}`} className="truncate">
                    <span className="font-mono">{member.name}</span>
                    {member.signature !== undefined && (
                      <span className="text-muted-foreground"> — {member.signature}</span>
                    )}
                  </li>
                ))}
              </ul>
              {members.length > MEMBER_PREVIEW_COUNT && (
                <button
                  type="button"
                  onClick={() => setMembersExpanded((current) => !current)}
                  data-architecture-inspector-members-toggle="true"
                  className="mt-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {membersExpanded
                    ? t('architecture.inspector.showFewerMembers', { defaultValue: 'Show fewer' })
                    : t('architecture.inspector.showAllMembers', {
                        defaultValue: 'Show all {{count}}',
                        count: members.length,
                      })}
                </button>
              )}
            </section>
          )}

          <section data-architecture-inspector-related="true">
            <h4 className="text-[11px] font-medium text-muted-foreground">
              {t('architecture.inspector.related', { defaultValue: 'Related' })}
            </h4>
            {relatedByType.size === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {t('architecture.inspector.noRelated', { defaultValue: 'No drawn relations' })}
              </p>
            ) : (
              [...relatedByType.entries()].map(([relationType, entries]) => (
                <div key={relationType} data-architecture-inspector-related-group={relationType}>
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {relationLabel(relationType)}
                  </span>
                  <ul className="flex flex-col gap-0.5">
                    {entries.map(({ node: other, direction }) => (
                      <li key={`${direction}:${other.id}`}>
                        <button
                          type="button"
                          data-architecture-inspector-related-node={other.id}
                          data-architecture-inspector-related-direction={direction}
                          onClick={() => {
                            onSelectNode(other.id);
                            onCenterNode(other.id);
                          }}
                          className="w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                        >
                          {direction === 'in' ? '← ' : '→ '}
                          {nodeName(other)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </div>
      ) : (
        <div data-architecture-inspector-page="sessions" className="mt-2 flex flex-col gap-1.5">
          <ToolResultsToggle checked={includeToolResults} onChange={onIncludeToolResultsChange} />
          <MentionsSection
            view={view}
            name={name}
            distance={node.distance}
            truncated={view.status === 'loaded' && view.result.truncated}
            ambiguousCount={ambiguousCount}
            locale={i18n.language}
            onRetry={reload}
            onLocate={(hit) => {
              requestLocateMessage(hit.messageId);
              onOpenChat?.();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** A relation's endpoints plus its type; used by the relation inspector and its lists. */
function endpointName(graph: ArchitectureRendererGraph, id: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node !== undefined) return nodeName(node);
  // A group edge's endpoint is the group id; print the group prefix it stands for.
  return id.startsWith('grp::') ? id.slice('grp::'.length) : id;
}

/** Every real node a drawn endpoint stands for (a group node stands for its members). */
function endpointMembers(graph: ArchitectureRendererGraph, id: string): Set<string> {
  if (!id.startsWith('grp::')) return new Set([id]);
  const prefix = id.slice('grp::'.length);
  return new Set(
    graph.nodes
      .filter((candidate) => candidate.id.startsWith(prefix) && !candidate.id.startsWith('grp::'))
      .map((candidate) => candidate.id),
  );
}

/** The relation inspector: both ends, the UML type, underlying edges and co-mentions. */
function RelationInspector({
  selection,
  graph,
  projectId,
  sessionId,
  includeToolResults,
  onIncludeToolResultsChange,
  onOpenChat,
  canCurate = false,
  onHideRelation,
}: {
  readonly selection: Extract<ArchitectureSelection, { kind: 'relation' }>;
  readonly graph: ArchitectureRendererGraph;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly includeToolResults: boolean;
  readonly onIncludeToolResultsChange: (value: boolean) => void;
  readonly onOpenChat?: () => void;
  readonly canCurate?: boolean;
  readonly onHideRelation?: (edge: ArchitectureRendererEdge) => void;
}) {
  const { t, i18n } = useTranslation();
  const fromName = endpointName(graph, selection.from);
  const toName = endpointName(graph, selection.to);

  // The aggregate edge the reader clicked may stand for many underlying edges
  // (a group view folds them); resolve the group endpoints back to real nodes.
  const underlying = useMemo(() => {
    const fromSet = endpointMembers(graph, selection.from);
    const toSet = endpointMembers(graph, selection.to);
    return graph.edges
      .filter((edge) => fromSet.has(edge.from) && toSet.has(edge.to))
      .slice(0, UNDERLYING_EDGE_LIMIT);
  }, [graph, selection.from, selection.to]);

  const { view, reload } = useMentions({
    projectId,
    sessionId,
    edge: { from: selection.from, to: selection.to },
    includeToolResults,
    enabled: true,
  });

  const typeKey = RELATION_LABEL_KEYS[selection.relationType];
  const typeLabel = typeKey === undefined
    ? selection.relationType
    : t(typeKey, { defaultValue: selection.relationType });

  return (
    <div data-architecture-inspector="true" data-architecture-inspector-kind="relation">
      <header data-architecture-inspector-header="true" className="flex flex-col gap-0.5">
        <span
          data-architecture-inspector-relation-ends={`${selection.from} -> ${selection.to}`}
          className="text-sm font-semibold text-foreground"
        >
          {fromName} → {toName}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {t('architecture.inspector.relationType', { defaultValue: 'Type' })}
          {': '}
          <span data-architecture-inspector-relation-type={selection.relationType}>{typeLabel}</span>
        </span>
      </header>

      {onHideRelation !== undefined && (
        <section data-architecture-inspector-curation="true" className="mt-2 flex flex-col gap-1">
          <h4 className="text-[11px] font-medium text-muted-foreground">
            {t('architecture.curation.heading', { defaultValue: 'Adjust' })}
          </h4>
          <button
            type="button"
            data-architecture-inspector-hide-relation={`${selection.from} -> ${selection.to}`}
            disabled={!canCurate}
            onClick={() => onHideRelation({
              from: selection.from,
              to: selection.to,
              relationType: selection.relationType,
            })}
            className="self-start rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('architecture.curation.hideRelation', { defaultValue: 'Hide relation' })}
          </button>
          <p className="text-[10px] text-muted-foreground">
            {t('architecture.curation.hideRelationNote', {
              defaultValue: 'Hides the display only; the code is unchanged.',
            })}
          </p>
        </section>
      )}

      <section className="mt-2" data-architecture-inspector-underlying={underlying.length}>
        <h4 className="text-[11px] font-medium text-muted-foreground">
          {t('architecture.inspector.underlyingEdges', { defaultValue: 'Underlying edges' })}
        </h4>
        {underlying.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {t('architecture.inspector.noUnderlyingEdges', { defaultValue: 'No underlying edges in this view' })}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-[11px] text-foreground">
            {underlying.map((edge) => (
              <li key={`${edge.from}->${edge.to}:${edge.relationType}`} className="truncate">
                {endpointName(graph, edge.from)} → {endpointName(graph, edge.to)}
                <span className="text-muted-foreground"> ({edge.relationType})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-2 flex flex-col gap-1.5" data-architecture-inspector-comentions="true">
        <ToolResultsToggle checked={includeToolResults} onChange={onIncludeToolResultsChange} />
        <h4 className="text-[11px] font-medium text-muted-foreground">
          {t('architecture.inspector.coMentions', { defaultValue: 'Messages mentioning both' })}
        </h4>
        <MentionsSection
          view={view}
          name={fromName}
          distance={null}
          truncated={view.status === 'loaded' && view.result.truncated}
          ambiguousCount={null}
          locale={i18n.language}
          onRetry={reload}
          onLocate={(hit) => {
            requestLocateMessage(hit.messageId);
            onOpenChat?.();
          }}
        />
      </section>
    </div>
  );
}

/**
 * The dock's inspector page: what the reader selected, in enough detail to
 * understand it without leaving the drawing.
 *
 * Used by `ArchitecturePanel` only, as the content of the dock's one shipped
 * tab. An entity gets a header plus the overview/sessions pages; a relation
 * gets its two ends, the UML type, the underlying edges and the messages that
 * mention both. The mention search itself lives in `hooks/useMentions.ts`; this
 * component only renders its states and raises the "locate this message" seam.
 */
export function ArchitectureInspector({
  selection,
  graph,
  idShape,
  projectId,
  sessionId,
  includeToolResults,
  onIncludeToolResultsChange,
  onSelectNode,
  onCenterNode,
  onOpenChat,
  canCurate = false,
  pinned = false,
  onPinNode,
  onUnpinNode,
  onRemoveNode,
  onHideRelation,
  hiddenRelations,
  onShowRelationType,
}: ArchitectureInspectorProps) {
  if (selection.kind === 'relation') {
    return (
      <RelationInspector
        selection={selection}
        graph={graph}
        projectId={projectId}
        sessionId={sessionId}
        includeToolResults={includeToolResults}
        onIncludeToolResultsChange={onIncludeToolResultsChange}
        onOpenChat={onOpenChat}
        canCurate={canCurate}
        onHideRelation={onHideRelation}
      />
    );
  }

  const node = graph.nodes.find((candidate) => candidate.id === selection.nodeId);
  if (node === undefined) {
    // The selection outlived its node (a filter or a re-layout removed it); the
    // panel clears it on the next scope sync. Draw nothing rather than a stale
    // name.
    return null;
  }

  return (
    <EntityInspector
      node={node}
      graph={graph}
      idShape={idShape}
      projectId={projectId}
      sessionId={sessionId}
      includeToolResults={includeToolResults}
      onIncludeToolResultsChange={onIncludeToolResultsChange}
      onSelectNode={onSelectNode}
      onCenterNode={onCenterNode}
      onOpenChat={onOpenChat}
      canCurate={canCurate}
      pinned={pinned}
      {...(onPinNode === undefined ? {} : { onPinNode })}
      {...(onUnpinNode === undefined ? {} : { onUnpinNode })}
      {...(onRemoveNode === undefined ? {} : { onRemoveNode })}
      {...(hiddenRelations === undefined ? {} : { hiddenRelations })}
      {...(onShowRelationType === undefined ? {} : { onShowRelationType })}
    />
  );
}
