import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, Mic } from 'lucide-react';

import { useTasksSettings } from '@/modules/task-master';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { api } from '@/shared/api';
import type {
  ChatMessage,
  ChatReplayCursorMap,
  Project,
  ProjectSession,
  SessionEstablishedContext,
  SessionNavigationOptions,
  TranscriptExportAction,
  UiNavigateReveal,
} from '@/shared/types';
import { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useInputOutline } from '@/modules/chat/outline/useInputOutline';
import InputOutlineDrawer from '@/modules/chat/outline/InputOutlineDrawer';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useUiNavigate } from '@/modules/chat/hooks/useUiNavigate';
import { useUiStateResponder } from '@/modules/chat/hooks/useUiStateResponder';
import UiNavigatePrompt from '@/modules/chat/components/UiNavigatePrompt';
import { subscribeTargetFor } from '@/modules/chat/utils/replayCursor';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import { useResidentProviders } from '@/shared/hooks/useProviderCapabilities';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { readSelectedProvider } from '@/shared/selectedProvider';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import {
  VoiceRealtimeBar,
  dropCaptionsDeliveredAsMessages,
  placeCaptionsChronologically,
  useFollowSentRun,
  useVoiceRealtimeSession,
  type VoiceRealtimeCaption,
} from '@/modules/chat/voice-realtime';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import { downloadTranscriptExport } from '@/modules/chat/utils/chatExport';
import { useRegisterTranscriptExport } from '@/shared/context/TranscriptExportContext';

/**
 * A request id for a control frame.
 *
 * `crypto.randomUUID` is only exposed in secure contexts, and this app can be
 * opened over plain HTTP on a LAN address, so the fallback keeps the withdrawal
 * path working there rather than throwing before the frame is sent.
 */
function newControlRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

type ChatInterfaceProps = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
  /**
   * Reveals a diff or a task an incoming MCP navigation asked for, switching the
   * workspace to the panel that owns it. Implemented by the workspace, which is
   * the only place that can switch tabs; answers false when it cannot.
   */
  onRevealNavigate?: (reveal: UiNavigateReveal) => boolean;
};

/**
 * Used by the project-workspace module (via the chat barrel) to render a
 * project session's chat tab; it owns the session, provider, realtime and
 * composer state that ChatMessagesPane and ChatComposer render.
 */
function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
  onRevealNavigate,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe, isConnected } = useWebSocket();
  const { t } = useTranslation('chat');
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing: onSessionProcessing,
    markSessionIdle: onSessionIdle,
  } = useSessionProtectionActions();

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Per-session replay cursor: which run this client's `seq` count belongs to,
  // and how far into it. Written by the realtime handler on every sequenced
  // frame and every `chat_subscribed` ack; read whenever a `chat.subscribe` is
  // sent so the server replays only the events this client actually missed —
  // and, when the run changed underneath the cursor, replays from the start.
  const lastSeqRef = useRef<ChatReplayCursorMap>(new Map());
  // The processing map as of the last commit, for the callbacks below that are
  // subscribed once and must not be resubscribed when a turn starts or ends.
  // Synced in an effect rather than during render: a render-time write to a ref
  // is exactly the pattern React's own lint rejects in a component body.
  const processingSessionsRef = useRef(processingSessions);
  useEffect(() => {
    processingSessionsRef.current = processingSessions;
  });

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    providerModels,
    setStoredProviderModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
    supportsMessageEditing,
    supportsSessionForking,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    markUserTurnUndelivered,
    restoreUserTurn,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollContentRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
    jumpToMessage,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // The input outline drawer's entries: the session's user inputs, each a jump
  // destination for the shared `jumpToMessage`.
  const inputOutline = useInputOutline({
    isActive,
    sessionId: currentSessionId ?? selectedSession?.id ?? null,
    sessionStore,
    chatMessages,
  });
  const { isMobile } = useDeviceSettings({ trackPWA: false });

  /** Opens a session on the workspace's route, the way a sidebar click would. */
  const handleUiNavigateToSession = useCallback((sessionId: string) => {
    onNavigateToSession?.(sessionId);
  }, [onNavigateToSession]);

  /**
   * Names the session an incoming navigation targets, for the confirmation bar.
   *
   * The project's own listing already carries every session's title, so the bar
   * can name a session that is not the open one; the open session is consulted
   * as well because a freshly created session reaches `selectedSession` before
   * the listing is refreshed.
   */
  const resolveUiNavigateSessionTitle = useCallback((sessionId: string): string | null => {
    const listed = selectedProject?.sessions?.find((session) => session.id === sessionId);
    const listedTitle = listed?.summary || listed?.title || listed?.name;
    if (listedTitle && listedTitle.trim()) {
      return listedTitle.trim();
    }
    if (selectedSession?.id === sessionId) {
      const openTitle = selectedSession.summary || selectedSession.title;
      return openTitle && openTitle.trim() ? openTitle.trim() : null;
    }
    return null;
  }, [selectedProject, selectedSession]);

  // Incoming MCP navigation requests: an external client asking this device to
  // open a session and place the transcript inside it. Mounted here rather than
  // in the websocket provider because the two entries that actually place the
  // transcript — `jumpToMessage` and `scrollToBottomAndReset` — live in this
  // component's session state, while the provider sits above the router and owns
  // no route of its own. `subscribe` is the provider's own fan-out, so this is
  // the same socket the rest of the app reads.
  const uiNavigate = useUiNavigate({
    subscribe,
    sendMessage,
    navigateToSession: handleUiNavigateToSession,
    activeSessionId: currentSessionId ?? selectedSession?.id ?? null,
    locateMessage: jumpToMessage,
    scrollToLatest: scrollToBottomAndReset,
    resolveSessionTitle: resolveUiNavigateSessionTitle,
    revealTarget: onRevealNavigate,
  });

  // How many of this session's messages are still waiting to be sent, read off the
  // transcript the chat state owns. The conversation's live state — the open
  // project and session, the pending approvals, the queue — is what an MCP caller's
  // `ui_visible_context` reads, so the answer to a `ui.state_request` is composed
  // here where that state lives, alongside the navigation responder above.
  const queuedMessageCount = useMemo(
    () => chatMessages.filter((message) => message.commandState === 'queued').length,
    [chatMessages],
  );
  useUiStateResponder({
    subscribe,
    sendMessage,
    selectedProject: selectedProject?.projectId ?? null,
    selectedSession: currentSessionId ?? selectedSession?.id ?? null,
    pendingApprovals: pendingPermissionRequests.length,
    queuedMessages: queuedMessageCount,
  });

  // Publish this conversation's export into the shared seam the workspace
  // header's overflow menu reads, so the menu can offer Export without either
  // module importing the other. Null while there is nothing to export, and the
  // menu then hides its export group entirely.
  const transcriptExport = useMemo<TranscriptExportAction | null>(() => {
    if (chatMessages.length === 0) return null;
    const sessionTitle = selectedSession?.summary || selectedSession?.title;
    return {
      messages: chatMessages,
      sessionTitle,
      provider,
      selectedProject,
      createDiff,
      onLoadFullTranscript: loadFullTranscript,
      runExport: async (format) => {
        // The transcript is paged; without this the export would silently be the
        // last page rather than the conversation.
        const fullMessages = (await loadFullTranscript?.()) ?? chatMessages;
        await downloadTranscriptExport(format, {
          messages: fullMessages.length > 0 ? fullMessages : chatMessages,
          sessionTitle: sessionTitle?.trim() || t('export.untitled'),
          provider,
          selectedProject,
          createDiff,
        });
      },
    };
  }, [chatMessages, createDiff, loadFullTranscript, provider, selectedProject, selectedSession, t]);
  useRegisterTranscriptExport(transcriptExport);

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  /*
   * The resident switch, held here because its one home — the new-session empty state's model card —
   * is rendered below this component through `ChatMessagesPane`, while the send that has to act on it
   * lives in `useChatComposerState`. Lifting the value to the one ancestor both surfaces share keeps a
   * single intent: the empty state flips it, and the send path reads it to write the new session's
   * lifecycle mode.
   *
   * It is the intent of the *next brand-new session only*. Declared before the composer hook so the
   * send path can take it as an argument, and cleared by that path once a new session has been made
   * resident — a send into an existing session never consults it, so a stale position cannot silently
   * convert a session the user only navigated to.
   */
  const [residentEnabled, setResidentEnabled] = useState(false);
  /**
   * Live Voice and the ordinary text composer are mutually exclusive inputs
   * (GOAL-033 / AC-316) sharing this one pane's session/transcript. Defaults
   * to `'text'` so no session is surprised into an open microphone by
   * reloading or switching sessions — entering Live Voice is always an
   * explicit action.
   */
  const voiceSessionId = currentSessionId ?? selectedSession?.id ?? null;
  /**
   * Which session Live Voice was entered for, or `null` while the text composer
   * is showing.
   *
   * The mode is DERIVED from this rather than stored as its own flag: storing a
   * `'voice'` flag and clearing it from an effect on session change meant every
   * session switch rendered the bar once before the effect corrected it, and a
   * live microphone connection briefly outlived the session it was bound to. Held
   * this way, switching sessions falls back to the text composer in the same
   * render, because the remembered id simply stops matching.
   */
  const [voiceModeSession, setVoiceModeSession] = useState<string | null>(null);
  const composerMode: 'text' | 'voice' = voiceModeSession !== null && voiceModeSession === voiceSessionId ? 'voice' : 'text';
  const enterVoiceMode = useCallback(() => setVoiceModeSession(voiceSessionId), [voiceSessionId]);
  const exitVoiceMode = useCallback(() => setVoiceModeSession(null), []);

  /**
   * The Live Voice connection is owned HERE, not by the bar that renders its
   * controls (GOAL-033 / AC-316-317). AC-317 requires the model's transcription
   * of the user's own audio to appear in the TRANSCRIPT — a sibling of the bar —
   * so the state has to live at the pane that renders both.
   */
  // A spoken instruction opens its run on the server, with no socket of this page bound to it,
  // so none of the reply's frames stream in. Re-reading once on `sent` showed only the first words
  // of the answer; this keeps reading until the run ends.
  const { follow: followSentVoiceRun } = useFollowSentRun({
    sessionId: voiceSessionId,
    isWorking: isProcessing,
    refresh: (sessionId) => {
      void requestLatestMessages(sessionId, isActive);
    },
  });
  const voice = useVoiceRealtimeSession({
    sessionId: voiceSessionId,
    onSent: followSentVoiceRun,
  });
  const { start: startVoiceCapture, end: endVoiceCapture } = voice;

  /**
   * The rows the transcript actually renders: the session's own messages plus, in
   * Live Voice mode, one provisional row per utterance the model has heard (AC-317).
   *
   * These caption rows are DISPLAY ONLY and exist solely in this array — never
   * persisted, never sent anywhere. The model receives the raw audio; this is the
   * user being shown their own words, which is why dropping the array on End (and
   * on reload) leaves exactly the transcript the server holds.
   */
  const transcriptMessages = useMemo(() => {
    if (composerMode !== 'voice' || voice.captions.length === 0) {
      return visibleMessages;
    }
    const captionRows = voice.captions.map(
      (caption: VoiceRealtimeCaption): ChatMessage => ({
        type: 'user',
        content: caption.text,
        displayText: caption.text,
        // Stable per utterance, so React keys it on the utterance rather than on
        // text that changes on every interim delta.
        id: `voice-caption-${caption.itemId}`,
        timestamp: caption.at,
      }),
    );
    // Words already delivered as a real message are not shown a second time.
    return placeCaptionsChronologically(visibleMessages, dropCaptionsDeliveredAsMessages(visibleMessages, captionRows));
  }, [visibleMessages, composerMode, voice.captions]);

  // Live Voice captures continuously from the moment the mode is entered — there
  // is no "press start" gesture in the shipped UI. The skip flag lets a spec that
  // wants the file-injection path instead suppress this and drive
  // `startWithFile` itself.
  useEffect(() => {
    if (composerMode !== 'voice') {
      return;
    }
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__voiceRealtimeSkipAutoStart) {
      return;
    }
    startVoiceCapture();
    // Leaving voice mode — an explicit End, or the pane moving to another session, which
    // makes `composerMode` fall back to 'text' in the same render — must also end the
    // connection. Nothing did: the bar unmounted, the microphone and the upstream session
    // stayed up, and the next mode entry opened a second one beside them.
    return () => endVoiceCapture();
  }, [composerMode, voiceSessionId, startVoiceCapture, endVoiceCapture]);
  const clearResidentIntent = useCallback(() => {
    setResidentEnabled(false);
  }, []);
  /** Flips the switch. The position is the whole of the intent — there is no acknowledgement to record or withdraw. */
  const toggleResident = useCallback(() => {
    setResidentEnabled((enabled) => !enabled);
  }, []);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleVoiceListeningStart,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    draftScope,
    sendFailed,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    // A closed socket cannot carry the send, so the composer has to know: it
    // fails such a send at once rather than arming a deadline for an answer
    // that cannot arrive.
    isConnected,
    sendByCtrlEnter,
    onSessionProcessing,
    // The send path marks a turn before the frame leaves the socket, so it needs
    // the other half of that pair: a send the server never took takes the mark
    // back, or the dock keeps claiming a turn that was never started.
    onSessionIdle,
    // The answer to the send that is in flight arrives as a socket frame; the
    // composer listens for the first one the server addresses to the session.
    subscribe,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    // A send that was never delivered hides the row it added; its retry puts the
    // same row back rather than minting a second one for one message.
    markUserTurnUndelivered,
    restoreUserTurn,
    // The composer hands a message to a resident process through the same store
    // the live `command_lifecycle` events land in, so the row it writes is the
    // row those events update — one object per held command, not two halves
    // that a refresh could separate.
    addResidentPending: sessionStore.addResidentPending,
    // The switch's position for the next brand-new session, and the way the send path clears it once
    // that session has been made resident. Handed in rather than read from a module-level one-shot so
    // the intent travels with the component tree the switch is drawn in, and a send into an existing
    // session has nothing to consult.
    residentEnabled,
    clearResidentIntent,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    // Skip store refresh during active streaming — the same guard the
    // session-state hook's refresh paths carry. The re-subscribe below still
    // runs: it is what replays the events missed while the socket was down,
    // and the turn's own `complete` is what reconciles the persisted tail.
    if (!processingSessionsRef.current?.get(selectedSession.id)) {
      await requestLatestMessages(selectedSession.id, isActive);
    }
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [subscribeTargetFor(selectedSession.id, lastSeqRef.current.get(selectedSession.id))],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  /**
   * Branches the conversation into a new session that ends at this message,
   * then opens it. The session being viewed is left exactly as it was.
   */
  const handleForkFromMessage = useCallback(async (message: ChatMessage) => {
    // The fork anchor names the *answer*, so the branch ends at this reply
    // rather than at the prompt that produced it. `transcriptAnchorId` is the
    // user-input anchor and belongs to editing, not to this.
    const anchorId = message.forkAnchorId;
    const sourceSessionId = selectedSession?.id;
    if (!anchorId || !sourceSessionId) return;

    try {
      const response = await api.forkSession(sourceSessionId, { upToAnchorId: anchorId });
      const payload = await response.json();
      const forkedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof forkedSessionId !== 'string') {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      onNavigateToSession?.(forkedSessionId);
    } catch (error) {
      console.error('Error forking session:', error);
    }
  }, [onNavigateToSession, selectedSession?.id]);

  /**
   * Asks the resident process holding one of this client's messages to take it
   * back.
   *
   * The uuid is the message's own — the host assigned it and the client adopted
   * it off the host's `queued` event — because that is the only name the
   * process's queue answers to. Nothing here reports whether the withdrawal
   * worked: this frame is a request, and the process's answer arrives as a
   * `command_lifecycle` event, which is what the transcript draws. Reading the
   * acknowledgement instead would make the UI's state a claim about a request
   * rather than about the queue.
   */
  const handleWithdrawResidentCommand = useCallback((message: ChatMessage) => {
    const targetSessionId = currentSessionId || selectedSession?.id || null;
    const commandUuid = message.residentCommandUuid;
    if (!targetSessionId || !commandUuid) return;

    sendMessage({
      type: 'chat.cancel-queued',
      sessionId: targetSessionId,
      messageUuid: commandUuid,
      // The gateway requires it: without a requestId the withdrawal is refused
      // with a protocol error before it can reach the queue.
      requestId: newControlRequestId(),
    });
  }, [currentSessionId, selectedSession?.id, sendMessage]);

  const { scheduledMessages, schedule: scheduleMessage, cancel: cancelScheduledMessage } =
    useScheduledMessages(currentSessionId || selectedSession?.id || null);

  /**
   * Hands the composer's current text to the server to send later, and clears
   * the box as a send would — the message has left the composer either way.
   */
  const handleScheduleMessage = useCallback(async (scheduledFor: Date) => {
    const content = input.trim();
    if (!content) return;

    const scheduled = await scheduleMessage({
      content,
      scheduledFor,
      options: { model: currentProviderModel, effort: currentProviderEffort, permissionMode },
    });
    if (scheduled) {
      setInput('');
    }
  }, [currentProviderEffort, currentProviderModel, input, permissionMode, scheduleMessage, setInput]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // Lets markdown image paths in the transcript resolve against this project.
  const markdownWorkspaceValue = useMemo(() => ({
    projectId: selectedProject?.projectId ?? null,
  }), [selectedProject?.projectId]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  // The pane draws the turn's status as an in-flow line at the end of the message
  // list; this is its reading of whether that line is handed the turn or `null`.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  /*
   * Whether the selected provider can hold a resident session.
   *
   * Read here rather than passed down as a resolved boolean because the empty state needs it: the
   * switch under the model card is drawn only for a provider the capability matrix lists `resident`
   * for. Same matrix, same reading, one answer.
   */
  const residentProviders = useResidentProviders();
  const canRunResident = residentProviders.has(readSelectedProvider());

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }


  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        {uiNavigate.prompt && (
          <UiNavigatePrompt
            requester={uiNavigate.prompt.requester}
            sessionTitle={uiNavigate.prompt.sessionTitle}
            target={uiNavigate.prompt.target}
            onJump={uiNavigate.accept}
            onIgnore={uiNavigate.ignore}
            onAlwaysAccept={uiNavigate.alwaysAccept}
            onAlwaysReject={uiNavigate.alwaysReject}
          />
        )}

        <MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}>
          <ChatMessagesPane
            scrollContainerRef={scrollContainerRef}
            scrollContentRef={scrollContentRef}
            // Not redundant with the `scroll` listener. A first page is 20 rows,
            // tool results fold into their calls, and the "load earlier" link is
            // hidden while more pages exist — so a short transcript is often not
            // scrollable at all and never emits `scroll`. Wheel and touch are
            // then the only way to reach the top pager or the "load all" overlay.
            onWheel={handleScroll}
            onTouchMove={handleScroll}
            isLoadingSessionMessages={isLoadingSessionMessages}
            isProcessing={isProcessing}
            hasActivityIndicator={hasActivityIndicator}
            activity={sessionActivity}
            sendFailed={sendFailed}
            chatMessages={chatMessages}
            selectedSession={selectedSession}
            currentSessionId={currentSessionId}
            provider={provider}
            setProvider={setProvider}
            textareaRef={textareaRef}
            providerModels={providerModels}
            setProviderModel={setStoredProviderModel}
            providerModelCatalog={providerModelCatalog}
            providerModelActions={providerModelActions}
            providerModelsLoading={providerModelsLoading}
            tasksEnabled={tasksEnabled}
            isTaskMasterInstalled={isTaskMasterInstalled}
            onShowAllTasks={onShowAllTasks}
            setInput={setInput}
            canRunResident={canRunResident}
            residentEnabled={residentEnabled}
            onToggleResident={toggleResident}
            isLoadingMoreMessages={isLoadingMoreMessages}
            hasMoreMessages={hasMoreMessages}
            totalMessages={totalMessages}
            sessionMessagesCount={chatMessages.length}
            visibleMessageCount={visibleMessageCount}
            visibleMessages={transcriptMessages}
            loadEarlierMessages={loadEarlierMessages}
            loadAllMessages={loadAllMessages}
            allMessagesLoaded={allMessagesLoaded}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            showLoadAllOverlay={showLoadAllOverlay}
            createDiff={createDiff}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantToolPermission={handleGrantToolPermission}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            // Editing replaces the turn and everything after it, so it is only
            // offered when the session is idle — a half-truncated transcript with
            // a live stream writing into it is not recoverable.
            onWithdrawResidentCommand={handleWithdrawResidentCommand}
            onEditMessage={supportsMessageEditing && !isProcessing ? beginEditMessage : undefined}
            onForkFromMessage={supportsSessionForking ? handleForkFromMessage : undefined}
          />
        </MarkdownWorkspaceContext.Provider>

        {isActive && <InputOutlineDrawer entries={inputOutline} isMobile={isMobile} onJump={jumpToMessage} />}

        {/* data-chat-composer lets the outline handle measure where the input starts.
            Live Voice and the ordinary text composer are mutually exclusive
            (GOAL-033 / AC-316): exactly one of them renders here, sharing the
            same transcript/session below. `onSent` re-reads the transcript
            because an MCP-source run writes into history rather than into
            this page's live connection. */}
        <div className="relative flex-shrink-0" data-chat-composer>
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          {isActive && composerMode === 'voice' ? (
            <VoiceRealtimeBar voice={voice} onExit={exitVoiceMode} />
          ) : (
            <>
              {isActive && (
                <div className="flex justify-end px-3 pt-1.5">
                  <button
                    type="button"
                    data-testid="live-voice-enter"
                    onClick={enterVoiceMode}
                    disabled={!voiceSessionId}
                    title={t('voice.realtime.enter', { defaultValue: 'Switch to Live Voice' })}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Mic className="h-3.5 w-3.5" aria-hidden />
                    {t('voice.realtime.enter', { defaultValue: 'Live Voice' })}
                  </button>
                </div>
              )}
              <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          sendFailed={sendFailed}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={selectPermissionMode}
          providerLabel={selectedProviderLabel}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          isEditingSentMessage={Boolean(editingAnchorId)}
          onCancelEditMessage={cancelEditMessage}
          scheduledMessages={scheduledMessages}
          onScheduleMessage={handleScheduleMessage}
          onCancelScheduledMessage={cancelScheduledMessage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onVoiceListeningStart={handleVoiceListeningStart}
          scope={draftScope}
          sessionId={currentSessionId || selectedSession?.id || null}
          projectId={selectedProject?.projectId ?? null}
          isActive={isActive}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
            </>
          )}
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
