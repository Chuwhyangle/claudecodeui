import { Plus } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import SessionFilterBar from '@/modules/sidebar/SessionFilterBar';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Stores the order a drag produced; absent where the list is read-only. */
  onReorderSessions?: (projectId: string, sessionIds: string[]) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  isShowingHiddenSessions?: boolean;
  onToggleShowHidden?: (projectId: string) => void;
  onEditSessionFilter?: (project: Project, seedSessionName?: string) => void;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onReorderSessions,
  onForkSession,
  onLoadMoreSessions,
  onNewSession,
  isShowingHiddenSessions = false,
  onToggleShowHidden,
  onEditSessionFilter,
  t,
}: SidebarProjectSessionsProps) {
  const isCompact = useCompactSidebar();
  // The row currently being dragged, and where it would land. React state so
  // the two affected rows redraw; the refs are the same values read
  // synchronously inside a drop, because React may not have re-rendered between
  // the last drag-over and the drop itself.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ id: string; position: 'before' | 'after' } | null>(null);
  // Set by a completed drag, cleared on the click that may follow it: a drag
  // that ends over the row it started on still produces a click in some
  // browsers, and that click must not navigate away from the list being
  // arranged.
  const suppressClickRef = useRef(false);

  /** The session id of the row under `target`, or null when it is not a row. */
  const rowSessionId = (target: EventTarget | null): string | null => {
    const element = target instanceof Element ? target.closest('[data-session-id]') : null;
    return element?.getAttribute('data-session-id') ?? null;
  };

  const clearDrag = () => {
    draggingIdRef.current = null;
    dropTargetRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (!onReorderSessions) {
      return;
    }
    const sessionId = rowSessionId(event.target);
    if (!sessionId) {
      return;
    }
    suppressClickRef.current = false;
    draggingIdRef.current = sessionId;
    setDraggingId(sessionId);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag that carries no data.
    event.dataTransfer.setData('text/plain', sessionId);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!draggingIdRef.current) {
      return;
    }
    // Without this the drop target never becomes valid and the row snaps back.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const sessionId = rowSessionId(event.target);
    if (!sessionId || sessionId === draggingIdRef.current) {
      dropTargetRef.current = null;
      setDropTarget(null);
      return;
    }

    const row = (event.target as Element).closest('[data-session-id]') as HTMLElement | null;
    const bounds = row?.getBoundingClientRect();
    const position: 'before' | 'after' = bounds && event.clientY > bounds.top + bounds.height / 2
      ? 'after'
      : 'before';
    const current = dropTargetRef.current;
    if (current?.id !== sessionId || current.position !== position) {
      const next = { id: sessionId, position };
      dropTargetRef.current = next;
      setDropTarget(next);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const fromId = draggingIdRef.current;
    const target = dropTargetRef.current;
    if (!fromId || !target || !onReorderSessions) {
      clearDrag();
      return;
    }
    event.preventDefault();
    suppressClickRef.current = true;

    const ids = sessions.map((session) => String(session.id));
    const reordered = ids.filter((id) => id !== fromId);
    const targetIndex = reordered.indexOf(target.id);
    if (targetIndex >= 0) {
      reordered.splice(target.position === 'after' ? targetIndex + 1 : targetIndex, 0, fromId);
      if (reordered.join('\u0000') !== ids.join('\u0000')) {
        onReorderSessions(project.projectId, reordered);
      }
    }
    clearDrag();
  };

  /** Swallows the click a finished drag can leave behind, then re-arms. */
  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) {
      return;
    }
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  const hiddenCount = Number(project.sessionMeta?.hiddenCount ?? 0);
  const filterBar = hiddenCount > 0 && onToggleShowHidden && onEditSessionFilter ? (
    <SessionFilterBar
      hiddenCount={hiddenCount}
      isShowingHidden={isShowingHiddenSessions}
      onToggleShowHidden={() => onToggleShowHidden(project.projectId)}
      onEditRules={() => onEditSessionFilter(project)}
      t={t}
    />
  ) : null;

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      {isCompact ? (
        <div className="px-3 pb-1 pt-1">
          <button
            className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
            onClick={() => {
              onProjectSelect(project);
              onNewSession(project);
            }}
          >
            <Plus className="h-3 w-3" />
            {t('sessions.newSession')}
          </button>
        </div>
      ) : (
        <Button
          variant="default"
          size="sm"
          className="flex h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => onNewSession(project)}
        >
          <Plus className="h-3 w-3" />
          {t('sessions.newSession')}
        </Button>
      )}

      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions ? (
        <>
          <div className="px-3 py-2 text-left">
            <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
          </div>
          {filterBar}
        </>
      ) : (
        <>
          {/*
            * Drag events are delegated to this one element: rows carry their id
            * in `data-session-id`, so adding reordering did not put four
            * handlers on every row and defeat SidebarSessionItem's memo
            * boundary.
            */}
          <div
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={clearDrag}
            onClickCapture={handleClickCapture}
          >
            {sessions.map((session) => (
              <SidebarSessionItem
                key={session.id}
                project={project}
                session={session}
                selectedSession={selectedSession}
                isProcessing={activeSessions.has(session.id)}
                needsAttention={attentionSessionIds.has(session.id)}
                currentTime={currentTime}
                onRenameDraftChange={onRenameDraftChange}
                isEditing={session.id === sessionRenameId}
                renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
                isDragging={draggingId !== null && draggingId === session.id}
                dropIndicator={dropTarget?.id === session.id ? dropTarget.position : null}
                onStartEditingSession={onStartEditingSession}
                onCancelEditingSession={onCancelEditingSession}
                onSaveEditingSession={onSaveEditingSession}
                onProjectSelect={onProjectSelect}
                onSessionSelect={onSessionSelect}
                onDeleteSession={onDeleteSession}
                onForkSession={onForkSession}
                onHideSimilar={onEditSessionFilter
                  ? (sessionName) => onEditSessionFilter(project, sessionName)
                  : undefined}
                t={t}
              />
            ))}
          </div>

          {hasMoreSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
            </Button>
          )}

          {filterBar}
        </>
      )}
    </div>
  );
}
