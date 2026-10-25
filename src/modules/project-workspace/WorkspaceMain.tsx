import React, { useCallback, useEffect, useRef, type Dispatch, type SetStateAction, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { ChatInterface } from '@/modules/chat';
import { NoticeSlot } from '@/modules/notices';
import { FileTree } from '@/modules/file-tree';
import { StandaloneShell } from '@/modules/standalone-shell';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { TaskMasterPanel, useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import { isQuayTabVisible, QuayPanel, useEnsureQuayTabVisible, useQuayStatus } from '@/modules/quay';
import {
  ArchitecturePanel,
  isArchitectureTabVisible,
  useArchitectureChatBridge,
  useEnsureArchitectureTabVisible,
} from '@/modules/architecture';
import type { AppTab, DirectoryRevealRequest, Project, ProjectSession, SessionEstablishedContext, SessionNavigationOptions, SettingsMainTab, UiNavigateReveal } from '@/shared/types';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { EditorSidebar, useEditorSidebar } from '@/modules/code-editor';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import { RESIDENT_SHELL_NOTICE_ID } from '@/modules/project-workspace/WorkspaceTabs';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';

/**
 * How often the workspace re-reads the selected session's lifecycle mode. The
 * mode is changed from outside this view — the sidebar's session menu — and
 * nothing broadcasts that change, so the reading has to be a poll. Two seconds is
 * the shortest interval that still keeps the request rate unremarkable.
 */
const LIFECYCLE_MODE_POLL_MS = 2_000;

type WorkspaceMainProps = {
  /** The whole sidebar listing, drawn by the landing overview when no project is selected. */
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Switches the app to another project — used by the git panel's Worktrees view. */
  onProjectSelect: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
};

/** Rendered by ProjectMainRegion to show the selected project's active tab: chat, files, shell, git, tasks, browser or a plugin. */
function WorkspaceMain({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
}: WorkspaceMainProps) {
  const { t } = useTranslation();
  const preferences = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();

  useTaskMasterProjectSync(selectedProject);
  // The folder an in-chat `path/` reference asked to reveal. Held as an object
  // so that re-clicking the same folder is a new request the tree acts on.
  const [revealDirectory, setRevealDirectory] = useState<DirectoryRevealRequest | null>(null);

  // The diff or task an incoming MCP `ui.navigate` asked this workspace to show.
  // The counter makes a repeat of the same target a new request, so the panel's
  // effect re-runs after the user has collapsed or closed it by hand.
  const [revealNavigate, setRevealNavigate] = useState<{ requestId: number; reveal: UiNavigateReveal } | null>(null);
  const revealNavigateRequestId = useRef(0);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;
  // Tier 1 gates the tab exactly like hasTaskmaster/install gates Tasks: only a
  // project whose listing says it has `.quay/config.yml` offers the Quay view.
  const shouldShowQuayTab = isQuayTabVisible(selectedProject);
  // Owns the `.archguard/query/manifest.json` reading, exactly like the Quay
  // gate above owns `.quay/config.yml`.
  const shouldShowArchitectureTab = isArchitectureTabVisible(selectedProject);

  /**
   * The workspace tab's half of the standalone architecture page's bridge.
   *
   * Mounted HERE rather than inside the panel: after the first "Put in chat
   * input" the workspace is on Chat, and the panel is unmounted, but a
   * standalone page must still be able to send the next selection while this
   * tab remains open. The panel's own in-page actions keep writing the draft
   * directly; this only serves the cross-tab transport.
   */
  const switchToChat = useCallback((): void => setActiveTab('chat'), [setActiveTab]);
  useArchitectureChatBridge({
    projectId: selectedProject?.projectId ?? null,
    sessionId: selectedSession?.id ?? null,
    onSwitchToChat: switchToChat,
  });

  const {
    view: quayView,
    refresh: refreshQuay,
    // The selected window and the card's busy marker are the hook's own state, NOT the
    // snapshot's: while a window re-read is in flight the snapshot still describes the OLD
    // window, so a selector driven by it would keep highlighting the previous button for the
    // whole (cold) read and show no busy state at all.
    windowHours: quayWindowHours,
    setWindowHours: setQuayWindowHours,
    ganttRefreshing: quayGanttRefreshing,
  } = useQuayStatus(
    selectedProject?.projectId ?? null,
    shouldShowQuayTab,
    activeTab === 'quay',
  );

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  useEnsureQuayTabVisible(shouldShowQuayTab, activeTab, setActiveTab);
  useEnsureArchitectureTabVisible(shouldShowArchitectureTab, activeTab, setActiveTab);

  // The selected session's stored lifecycle mode. The mode belongs to the session
  // row, not to any process: a resident session whose process was never started has
  // no host and still reads `resident`, and that is exactly the state the Shell view
  // has to stay closed for — so `running` is not the reading this asks for. The
  // workspace's own session objects do not carry the mode at all, and the host
  // listing is the only face that publishes it.
  const [lifecycleMode, setLifecycleMode] = useState<{ sessionId: string; mode: string } | null>(null);

  const selectedSessionId = selectedSession?.id ?? null;

  useEffect(() => {
    // Nothing selected, nothing to ask about. The reading is left where it stands rather
    // than cleared: it is tagged with the session it was taken for, so a stale one cannot
    // be mistaken for this session's (see `isResidentSession` below).
    if (!selectedSessionId) return;

    let cancelled = false;

    const readMode = async () => {
      try {
        const response = await api.sessionHostState(selectedSessionId);
        if (!response.ok) return;
        const body = (await response.json()) as {
          data?: { sessions?: { appSessionId?: string; lifecycleMode?: string }[] };
        };
        if (cancelled) return;
        const row = body.data?.sessions?.find((entry) => entry.appSessionId === selectedSessionId);
        // A row the listing does not know is per-run: that is the column's own
        // default, and guessing `resident` would close a tab nobody asked to close.
        setLifecycleMode({ sessionId: selectedSessionId, mode: row?.lifecycleMode ?? 'per-run' });
      } catch (error) {
        // The last reading stands. Re-opening Shell because one poll failed would be
        // the one failure mode this whole guard exists to prevent, and a resident
        // session is not made per-run by a flaky request.
        console.error('Error reading the session lifecycle mode:', error);
      }
    };

    void readMode();
    const timer = window.setInterval(() => {
      void readMode();
    }, LIFECYCLE_MODE_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedSessionId]);

  // A reading speaks only for the session it was taken for: while the first poll
  // for a newly selected session is in flight, the previous session's mode must not
  // decide this session's tabs.
  const isResidentSession =
    lifecycleMode !== null && lifecycleMode.sessionId === selectedSessionId && lifecycleMode.mode === 'resident';

  // A resident session's whole point is that the app holds the process, so handing
  // the user a terminal onto that process is the opposite of the mode. The tab is
  // disabled, but a session that was already on Shell when its mode changed would
  // keep the terminal it had — the mode is what decides, so this has to be reactive
  // rather than a mount-time check.
  useEffect(() => {
    if (isResidentSession && activeTab === 'shell') {
      setActiveTab('chat');
    }
  }, [isResidentSession, activeTab, setActiveTab]);

  // Stable so React.memo(ChatInterface) can bail out: an inline arrow here made
  // every WorkspaceMain render re-render the whole chat tree, including during
  // an editor-divider drag.
  const showAllTasks = useCallback(() => {
    setActiveTab('tasks');
  }, [setActiveTab]);

  const openFile = useCallback((filePath: string) => {
    setActiveTab('files');
    handleFileOpen(filePath);
  }, [handleFileOpen, setActiveTab]);

  // Opens the editor side panel in place, keeping the current tab (e.g. chat).
  const openFileInEditor = useCallback((filePath: string, line?: number | null) => {
    resolvedFileOpen(filePath, undefined, line);
  }, [resolvedFileOpen]);

  // Directories cannot be read as text: reveal them in the file tree instead.
  const openDirectory = useCallback((directoryPath: string) => {
    setActiveTab('files');
    setRevealDirectory({ path: directoryPath });
  }, [setActiveTab]);

  /**
   * Shows the diff or task an external MCP client asked for.
   *
   * The workspace owns the tabs, so this is where "reveal in the git panel" and
   * "open the task's detail" can be answered: it switches to the owning tab and
   * hands the request down as a prop. It is synchronous by contract — the caller
   * acknowledges the navigation as soon as the tab is switched, and the panel
   * applies the reveal on the render that follows.
   */
  const revealNavigateTarget = useCallback((reveal: UiNavigateReveal): boolean => {
    revealNavigateRequestId.current += 1;
    setRevealNavigate({ requestId: revealNavigateRequestId.current, reveal });
    setActiveTab(reveal.kind === 'diff' ? 'git' : 'tasks');
    return true;
  }, [setActiveTab]);

  // Stable arguments keep usePaletteOpsRegister's effect from tearing down and
  // rewriting the whole palette registry on every render.
  usePaletteOpsRegister({ openFile, openFileInEditor, openDirectory });

  if (isLoading) {
    return (
      <WorkspaceStateView
        mode="loading"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        projects={projects}
      />
    );
  }

  if (!selectedProject) {
    return (
      <WorkspaceStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        projects={projects}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <WorkspaceHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowQuayTab={shouldShowQuayTab}
        shouldShowArchitectureTab={shouldShowArchitectureTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isResidentSession={isResidentSession}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />

      {/* Why the Shell tab is closed to this session — not a workspace banner: every
          other tab already shows the reason through the disabled tab's own `title`
          and `aria-describedby`, so a sighted user on Chat has no use for it and a
          screen reader only needs it read when it focuses that tab. Kept `sr-only`
          rather than inside the Shell view: the view never mounts for a resident
          session, so a notice living in it would be a notice nobody's reader reaches. */}
      {isResidentSession && (
        <p
          id={RESIDENT_SHELL_NOTICE_ID}
          data-resident-shell-notice="true"
          role="note"
          aria-label={t('tabs.shellResidentDisabledLabel')}
          className="sr-only"
        >
          {t('tabs.shellResidentDisabled')}
        </p>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <WorkspaceErrorBoundary showDetails>
              <ChatInterface
                isActive={activeTab === 'chat'}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onShowAllTasks={tasksEnabled ? showAllTasks : null}
                onRevealNavigate={revealNavigateTarget}
                noticeSlot={<NoticeSlot />}
              />
            </WorkspaceErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <FileTree
                selectedProject={selectedProject}
                onFileOpen={handleFileOpen}
                revealDirectory={revealDirectory}
              />
            </div>
          )}

          {/* `!isResidentSession` is not redundant with the guard effect above: it
              closes the view on the very render the reading arrives, before the
              effect that moves the tab away has had a chance to run. */}
          {activeTab === 'shell' && !isResidentSession && (
            <div className="h-full w-full overflow-hidden" data-workspace-view="shell">
              <StandaloneShell
                project={selectedProject}
                session={selectedSession}
                showHeader={false}
                isActive={activeTab === 'shell'}
              />
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <GitPanel
                selectedProject={selectedProject}
                isMobile={isMobile}
                onFileOpen={handleFileOpen}
                onProjectSelect={onProjectSelect}
                onProjectsRefresh={onProjectsRefresh}
                revealFilePath={revealNavigate && revealNavigate.reveal.kind === 'diff' ? revealNavigate.reveal.filePath : null}
                revealRequestId={revealNavigate && revealNavigate.reveal.kind === 'diff' ? revealNavigate.requestId : null}
              />
            </div>
          )}

          {shouldShowTasksTab && (
            <TaskMasterPanel
              isVisible={activeTab === 'tasks'}
              revealTaskId={revealNavigate && revealNavigate.reveal.kind === 'task' ? revealNavigate.reveal.taskId : null}
              revealRequestId={revealNavigate && revealNavigate.reveal.kind === 'task' ? revealNavigate.requestId : null}
            />
          )}

          {shouldShowQuayTab && activeTab === 'quay' && (
            <div className="h-full overflow-hidden" data-workspace-view="quay">
              <QuayPanel
                projectId={selectedProject.projectId}
                view={quayView}
                onRefresh={refreshQuay}
                // The dashboard link comes from the snapshot itself: the backend
                // discovers the live `quay serve` web endpoint. Until a snapshot
                // is loaded there is nothing to link to, so pass null.
                dashboardUrl={quayView.status === 'loaded' ? quayView.snapshot.dashboardUrl : null}
                // The window is a data filter: changing it re-reads the snapshot, so the
                // gantt and the rest of the panel can never describe different windows.
                onWindowChange={setQuayWindowHours}
                // The requested window (not the one the loaded snapshot still carries) marks
                // the active button the instant it is clicked, and the busy marker stays on
                // the card for the length of the re-read.
                windowHours={quayWindowHours}
                ganttRefreshing={quayGanttRefreshing}
              />
            </div>
          )}

          {shouldShowArchitectureTab && activeTab === 'architecture' && (
            <div className="h-full overflow-hidden" data-workspace-view="architecture">
              <ArchitecturePanel
                projectId={selectedProject.projectId}
                sessionId={selectedSession?.id ?? null}
                // The copied header names the project and session the way the
                // workspace labels them; the ids are only a fallback.
                projectName={selectedProject.displayName}
                sessionTitle={selectedSession?.title ?? selectedSession?.summary ?? null}
                // The inspector's mention hits switch the workspace to Chat
                // after asking the shared locator seam to centre the message;
                // the architecture module never imports the chat module.
                onOpenChat={() => setActiveTab('chat')}
              />
            </div>
          )}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="h-full overflow-hidden">
              <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.path}
          fillSpace={activeTab === 'files'}
        />
      </div>
    </div>
  );
}

export default React.memo(WorkspaceMain);
