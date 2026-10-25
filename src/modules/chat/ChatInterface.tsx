import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { NextTaskBanner, useTasksSettings } from '@/modules/task-master';
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
import { useActivityDockTurn } from '@/modules/chat/hooks/useActivityDockTurn';
import { useTranscriptSelection } from '@/modules/chat/hooks/useTranscriptSelection';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useUiNavigate } from '@/modules/chat/hooks/useUiNavigate';
import { useUiStateResponder } from '@/modules/chat/hooks/useUiStateResponder';
import UiNavigatePrompt from '@/modules/chat/components/UiNavigatePrompt';
import { subscribeTargetFor } from '@/modules/chat/utils/session/replayCursor';
import { createChatSession } from '@/modules/chat/utils/session/sessionCreation';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';
import { useResidentProviders } from '@/shared/hooks/useProviderCapabilities';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { readSelectedProvider } from '@/shared/selectedProvider';
import {
  consumePendingLocateRequest,
  subscribeToLocateRequests,
} from '@/shared/chatMessageLocator';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import {
  VoicePendingMessageCard,
  VoiceRealtimeBar,
  collectUndeliveredUtterances,
  primeVoiceCues,
  releaseWarmMicrophoneSource,
  useFollowSentRun,
  useVoiceRealtimeSession,
  warmMicrophoneSource,
} from '@/modules/chat/voice-realtime';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import { downloadTranscriptExport } from '@/modules/chat/utils/transcript/chatExport';
import {
  findLatestReplyItems,
  resolveReplyReference,
} from '@/modules/chat/utils/transcript/replyItems';

import { useRegisterTranscriptExport } from '@/shared/context/TranscriptExportContext';

/** Stable empty list for a draft that points at no reply items. */
const NO_REPLY_ORDINALS: readonly number[] = [];

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

/**
 * True when a spec has declared that this page drives capture itself (the file-injection
 * seam). It means "this page never touches the microphone", so it has to hold for EVERY
 * microphone call site — the capture-start effect below AND the tap's warm-up — or entering
 * the mode still opens `getUserMedia` once.
 */
function skipsVoiceAutoStart(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as Record<string, unknown>).__voiceRealtimeSkipAutoStart)
  );
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
  /**
   * The notice slot mounted above the transcript, supplied by the workspace. The notices module
   * owns it; chat must not import that feature module's slot itself (char supplied by the
   * workspace, which already imports both barrels), so the workspace hands the node down.
   */
  noticeSlot?: React.ReactNode;
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
  noticeSlot,
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

  // A "locate this message" request from another module (the architecture
  // inspector's mention hits). The subscription only bumps a counter; the
  // request is CONSUMED once this pane is active, because centring a message in
  // a hidden pane does nothing (`WorkspaceMain` keeps Chat mounted behind the
  // architecture tab). A request made while hidden therefore waits in the
  // shared store until the tab becomes visible.
  const [locateSignal, setLocateSignal] = useState(0);
  // The id of the last locate request that found no message. `null` hides the
  // light status line; a new request clears it before the jump is attempted.
  const [locateMissId, setLocateMissId] = useState<string | null>(null);
  useEffect(
    () => subscribeToLocateRequests(() => setLocateSignal((signal) => signal + 1)),
    [],
  );
  useEffect(() => {
    if (!isActive) return undefined;
    const request = consumePendingLocateRequest();
    if (request === null) return undefined;
    let cancelled = false;
    setLocateMissId(null);
    void jumpToMessage(request.messageId).then((found) => {
      if (!cancelled && !found) setLocateMissId(request.messageId);
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, locateSignal, jumpToMessage]);

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
  /**
   * True only for the window in which a brand-new conversation's Live Voice
   * entry is asking the session gateway for the id the voice connection has to
   * bind to. The entry is held unavailable for that window alone — it used to
   * be unavailable whenever no id existed yet, which made it dead in the very
   * conversation a reader most wants it in.
   */
  const [voiceEntryAllocating, setVoiceEntryAllocating] = useState(false);
  /**
   * The visible reply an allocation that failed leaves behind, or `null`.
   *
   * A notice rather than a disable: the entry stays tappable so the reader can
   * try again, and answerless taps are exactly what the visible-notice contract
   * on `ChatComposer` exists to prevent.
   */
  const [voiceEntryNotice, setVoiceEntryNotice] = useState<string | null>(null);

  /**
   * Spends the resident intent — declared here, above the callbacks that read it
   * (`enterVoiceMode` below and the composer hook further down), because a
   * `useCallback` dependency array is evaluated on the render that reaches it,
   * and a `const` referenced before its own declaration would be in its TDZ.
   */
  const clearResidentIntent = useCallback(() => {
    setResidentEnabled(false);
  }, []);
  /** Flips the switch. The position is the whole of the intent — there is no acknowledgement to record or withdraw. */
  const toggleResident = useCallback(() => {
    setResidentEnabled((enabled) => !enabled);
  }, []);

  // A brand-new conversation (New Session, no row allocated yet) has no id to
  // bind a voice connection to. The server keys `session_send` on the id, so
  // the entry allocates one FIRST — through the same session gateway the
  // composer's first send uses — and then enters voice mode on the id it
  // returned. The mode has to be set to that NEW id, not to the still-null
  // `voiceSessionId` captured at tap time: `composerMode` is derived by matching
  // the two, so the stale null would leave the composer in 'text' after the
  // re-render and the bar would never appear.
  const enterVoiceMode = useCallback(async () => {
    // The microphone is the slow leg of the first "Connecting voice…" window: permission, the
    // capture `AudioContext`, and the worklet bundle load all happen before the first frame can
    // be captured. Begin that on the TAP itself — in parallel with the allocation below — instead
    // of after it; `useVoiceRealtimeSession`'s `start()` adopts this warmed acquisition, so what
    // is said while the socket is still dialing reaches the hook's pending-frame buffer.
    // ...but a spec that injects a file instead (the seam below) has declared that this page never
    // touches the microphone, and its criterion reads the `getUserMedia` count as 0 — so the
    // warm-up obeys the same seam as the capture start rather than opening the microphone anyway.
    if (!skipsVoiceAutoStart()) void warmMicrophoneSource();
    // The Live Voice cues are synthesized locally, but a browser only lets this document start audio
    // from a gesture — this tap. Primed here, beside the microphone warm-up, so the entry cue is
    // already allowed to sound by the time the first captured frame arrives.
    primeVoiceCues();
    if (voiceSessionId) {
      setVoiceEntryNotice(null);
      setVoiceModeSession(voiceSessionId);
      return;
    }
    setVoiceEntryNotice(null);
    setVoiceEntryAllocating(true);
    try {
      if (!selectedProject) {
        throw new Error('no project open to allocate a session for');
      }
      const created = await createChatSession({
        provider,
        projectPath: selectedProject.fullPath || selectedProject.path || '',
        // The selection the page is showing, stated on the allocation itself. This
        // conversation's first turn is the relay's `session_send` — an utterance,
        // not a composer send — so it carries no model, and this call is the only
        // chance to record one before the child process exists. Without it the
        // session runs the provider CLI's default with none of the custom model's
        // env rows applied (measured 2026-10-15: `--model default`, no
        // ANTHROPIC_BASE_URL, host account spent instead of the entry's gateway).
        model: currentProviderModel,
        effort: currentProviderEffort,
        permissionMode,
      });
      handleSessionEstablished(created.sessionId, {
        provider,
        project: selectedProject,
        summary: created.sessionName || undefined,
      });
      // The resident switch on the empty state is this intent's only home, and
      // the composer's first send is its other consumer — the two must read it
      // the same way, in the same order. The session row exists now and the mode
      // is written before the first turn: the server refuses a mode change while
      // a host is mid-turn, and the voice connection this entry is about to open
      // is exactly such a turn, so the write has to complete first. Mirrors
      // `useChatComposerState`'s new-session branch.
      if (residentEnabled) {
        try {
          await api.providers.setSessionLifecycleMode(provider, created.sessionId, 'resident');
        } catch (error) {
          console.error('Resident mode request failed:', error);
          // Visible, not silent: the switch was drawn "on", so a session that
          // came out per-run has to say why. The transcript is on screen in
          // voice mode (the entry's own notice is not rendered there), so the
          // error rides there — the same channel the composer path uses.
          const message = error instanceof Error ? error.message : 'Unknown error';
          addMessage({
            type: 'error',
            content: `Failed to keep this session running: ${message}`,
            timestamp: new Date(),
          });
        }
        // The intent has been spent on the session it was set for. Clearing it
        // here is what keeps the next New Session's empty state from drawing a
        // stale "on" — the same reason the composer path clears it.
        clearResidentIntent();
      }
      setVoiceModeSession(created.sessionId);
    } catch (error) {
      // The tap ended without voice mode ever starting, so nothing will adopt the microphone
      // opened above: release it rather than leave the capture running behind a notice.
      releaseWarmMicrophoneSource();
      console.error('Live Voice session allocation failed:', error);
      // The same notice the entry shows when it cannot start a connection for
      // this conversation — now answering a failed ALLOCATION rather than the
      // absence of a conversation, since the entry no longer needs one to exist.
      setVoiceEntryNotice(
        t('voice.realtime.needsSession', {
          defaultValue: 'Live Voice needs a conversation. Send a message first, then start Live Voice.',
        }),
      );
    } finally {
      setVoiceEntryAllocating(false);
    }
  }, [
    voiceSessionId,
    selectedProject,
    provider,
    handleSessionEstablished,
    t,
    residentEnabled,
    clearResidentIntent,
    addMessage,
    // The three selections the allocation states; a callback that read them from a
    // stale render would mint the row with the model the page showed a moment ago.
    currentProviderModel,
    currentProviderEffort,
    permissionMode,
  ]);
  const exitVoiceMode = useCallback(() => setVoiceModeSession(null), []);

  // A tap whose allocation is still in flight when the pane goes away would otherwise leave the
  // prewarmed microphone running with no owner. Once capture has started the hook owns the source
  // and its own unmount cleanup ends it, so this only ever releases an unstarted warm-up.
  useEffect(() => () => releaseWarmMicrophoneSource(), []);

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
    // The session's own transcript, exactly what the pane renders — Live Voice adds no rows of its
    // own to it any more. The hook reads this through a ref, so passing the array by identity on
    // every render is free.
    contextMessages: visibleMessages,
  });
  const { start: startVoiceCapture, end: endVoiceCapture } = voice;

  /**
   * THE TRANSCRIPT IS THE TRANSCRIPT (operator's ruling, 2026-10-14).
   *
   * There is no voice-specific row algebra here any more. What the person said reaches the
   * conversation the one way anything does — as the ordinary message the model relayed — and this
   * pane renders exactly the session's own messages, in Live Voice mode as in any other. The rows
   * this used to add (a line per refused utterance, per segment with no transcript, per segment the
   * ACK reported lost, and a closing line counting the words that never reached the screen) are
   * gone: they were a second, voice-only account of a conversation that already has one, and they
   * were what made the mode read as a different, noisier page. The live transcript of what is being
   * said right now is still on screen — on the bar's own caption line, where it belongs.
   *
   * Nothing replaces it. A refusal, a lost segment and a dead connection are reported on the bar
   * (the phase, and the one failure sentence), and the words a leave never delivered are handed back
   * to the composer's draft on the way out — see `handleVoiceExit`.
   */
  // Live Voice captures continuously from the moment the mode is entered — there
  // is no "press start" gesture in the shipped UI. The skip flag lets a spec that
  // wants the file-injection path instead suppress this and drive
  // `startWithFile` itself.
  useEffect(() => {
    if (composerMode !== 'voice') {
      return;
    }
    if (skipsVoiceAutoStart()) {
      // This spec drives `startWithFile` itself, so nothing will adopt the tap's warm-up.
      releaseWarmMicrophoneSource();
      return;
    }
    startVoiceCapture();
    // Leaving voice mode — an explicit End, or the pane moving to another session, which
    // makes `composerMode` fall back to 'text' in the same render — must also end the
    // connection. Nothing did: the bar unmounted, the microphone and the upstream session
    // stayed up, and the next mode entry opened a second one beside them.
    return () => endVoiceCapture();
  }, [composerMode, voiceSessionId, startVoiceCapture, endVoiceCapture]);

  /**
   * Whether the activity dock is drawing a turn, from the dock's own decision
   * (server-backed freshness plus this client's processing entry). The empty-box
   * suggestion chips obey it: the local `isLoading` mark can already be clear
   * while a server-confirmed turn — a voice turn, another client's turn, a
   * reloaded page — is still running, and the chips must follow the status bar
   * rather than the local mark. Read here, above the composer hook, because the
   * chips' `visible` is an input to it. `sendFailed` is deliberately not passed:
   * it lives inside the composer hook and cannot change this answer, since it
   * only replaces the dock's reading when there is no turn at all.
   */
  const isDockTurnShown = useActivityDockTurn({
    sessionId: currentSessionId ?? selectedSession?.id ?? null,
    activity: sessionActivity,
  });

  /**
   * The passage selected inside the transcript, for the composer's quoted chip.
   * The hook reads only selections whose two ends lie in `[data-transcript-content]`,
   * so selecting text in the input box or a sidebar is not a quote.
   */
  const { selectionText: quotedSelection } = useTranscriptSelection();

  /**
   * Stable identity of the last assistant reply, the model chips' draw key.
   *
   * The provider's own id is preferred (`id` for a streamed row, `transcriptRowId`
   * for a read one); a row carrying neither falls back to its timestamp and index,
   * which is stable across re-renders of the same transcript. A new value means
   * the assistant answered again, and that is the only thing that asks the server
   * for another batch.
   */
  const lastAssistantMessageId = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index];
      if (message.type !== 'assistant') {
        continue;
      }
      return message.id
        ?? message.transcriptRowId
        ?? message.blockKey
        ?? `assistant-${index}-${String(message.timestamp)}`;
    }
    return null;
  }, [chatMessages]);

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
    voiceRange,
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
    chipStrip,
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
    // The chips' idle-only reading comes from the dock, not from the local
    // processing mark alone: a server-confirmed turn outlives that mark.
    isDockTurnShown,
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
    lastAssistantMessageId,
    quotedSelection,
  });

  /**
   * What the draft points at in the latest assistant reply.
   *
   * One derivation for both surfaces: the composer's preview line and the
   * transcript's item highlight read this same reference, so they cannot
   * disagree about which point 「1–2」 means. `findLatestReplyItems` answers
   * null when the last reply has no numbered structure — the preview then says
   * nothing rather than reaching back to an older reply.
   */
  const latestReplyItems = useMemo(
    () => findLatestReplyItems(visibleMessages),
    [visibleMessages],
  );
  const replyReference = useMemo(
    () =>
      latestReplyItems && input.trim()
        ? resolveReplyReference(input, latestReplyItems.items)
        : null,
    [latestReplyItems, input],
  );
  /** The ordinals the draft names, for the transcript's highlight. */
  const highlightedReplyOrdinals = useMemo(
    () =>
      replyReference && replyReference.kind === 'items'
        ? replyReference.ordinals
        : NO_REPLY_ORDINALS,
    [replyReference],
  );

  /**
   * Leaves Live Voice, carrying what was heard but never delivered into the composer's draft.
   *
   * The words the model heard and never had sent to Claude go nowhere when the mode ends — the
   * relay's pending parts are per-connection and die with it. Instead of dropping them, they are
   * handed to the composer as a DRAFT: the person can read, edit and send them, and nothing is
   * re-delivered automatically (the criterion reads the duplicate-delivery count as 0). Appended
   * under whatever was already typed rather than overwriting it, and only when there is a backlog:
   * an orderly leave with nothing unheard must leave the box exactly as it was.
   *
   * The relay's own HELD message is the one exception to "the parts die with the connection": the
   * proxy delivers it on teardown, so its words are on their way and must NOT come back as a draft.
   * `collectUndeliveredUtterances` is told what is held so it can leave those words out.
   */
  const handleVoiceExit = useCallback(() => {
    // The message the relay is STILL HOLDING is excluded: those words are undelivered by the
    // delivery test, but the proxy delivers the hold once on teardown, exactly as it does on this
    // leave — offering them back to the composer would put the same words out twice.
    const backlog = collectUndeliveredUtterances(voice.captions, voice.deliveries, voice.pendingMessage);
    if (backlog !== '') {
      setInput((previous) => (previous.trim() === '' ? backlog : `${previous}\n${backlog}`));
    }
    exitVoiceMode();
  }, [voice.captions, voice.deliveries, voice.pendingMessage, setInput, exitVoiceMode]);

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

    // Escape stops the turn only when the composer is where the user is and nothing is floating
    // over it. It runs on the document's capture phase, ahead of every floating layer's own
    // Escape handling, and both the resident pill's panel and the shared Dialog leave the event's
    // `defaultPrevented` false — so a bare "is Escape" test here closed the layer *and* aborted a
    // turn the user never asked to stop, leaving the round running server-side behind a page that
    // had already given up on it. Two premises are read before the key is claimed:
    //
    //   1. focus is inside the composer's textarea (the node ChatComposer binds), not on a button,
    //      the transcript, or the page;
    //   2. no floating layer is open.
    //
    // Failing either, the event is left completely alone — no `preventDefault`, so the layer above
    // still closes itself — rather than being handled and re-fired.
    //
    // The layer selector is the set of open-layer roles this app renders (the Dialog and the pill
    // panel use `dialog`, the composer popovers `menu`, the command menu `listbox`), each present
    // in the DOM only while open. A layer that stops propagation earlier on the way in (the
    // composer's own `useComposerMenuAnchor` listens on `window` capture) never reaches here at
    // all.
    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      const textarea = textareaRef.current;
      const active = document.activeElement;
      if (!textarea || !active || !textarea.contains(active)) {
        return;
      }

      if (document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]') !== null) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, textareaRef]);

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

        {/* A locate request that found no message must not fail silently: the
            reader asked for a specific message and gets a status line instead. */}
        {locateMissId !== null && (
          <p
            role="status"
            data-chat-locate-notice={locateMissId}
            className="shrink-0 border-b border-border/60 bg-muted/50 px-3 py-1 text-xs text-muted-foreground"
          >
            {t('messageNotFound', { defaultValue: 'No message with that id was found.' })}
          </p>
        )}

        {/* 暂停中，待 Chat 页信号设计定稿：会话任务链不再挂载在聊天页。 */}

        {/* The interrupt slot: at most one notice, the rest folded behind a count. Supplied by
            the workspace rather than imported here — see `noticeSlot`. */}
        {noticeSlot}

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
            // The running turn's Stop belongs to the row, not to the composer: this is what keeps it
            // reachable in Live Voice, where the composer's submit-button Stop is not on screen.
            canStopTurn={canAbortSession}
            onStopTurn={handleAbortSession}
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
            // The empty state is in the transcript package, which must not depend on
            // task-master; the banner is handed in from here, which already does.
            nextTaskBanner={NextTaskBanner}
            setInput={setInput}
            canRunResident={canRunResident}
            residentEnabled={residentEnabled}
            onToggleResident={toggleResident}
            isLoadingMoreMessages={isLoadingMoreMessages}
            hasMoreMessages={hasMoreMessages}
            totalMessages={totalMessages}
            sessionMessagesCount={chatMessages.length}
            visibleMessageCount={visibleMessageCount}
            visibleMessages={visibleMessages}
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
            highlightedReplyOrdinals={highlightedReplyOrdinals}
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
            <VoiceRealtimeBar
              voice={voice}
              // Leaving the mode is not stopping the turn: the exit re-homes anything still undelivered
              // into the composer and drops the live connection, while a running turn keeps running.
              onExit={handleVoiceExit}
              // The session's own "a turn is in flight" reading: while it is true the person's next
              // words can only wait, so the bar shows how long it has been busy and how many bytes of
              // their speech are queued — the backlog the byte budget is measured against, before it
              // overflows and a refusal is what finally says so.
              busy={isProcessing}
              // The same answerable surface the text composer draws, kept on screen above the
              // voice bar: replacing the composer must not take the only way to answer a
              // pending permission/question request with it. Answering here runs the ordinary
              // decision path — it neither leaves voice mode nor touches the connection.
              banner={
                pendingPermissionRequests.length > 0 ? (
                  <PermissionRequestsBanner
                    pendingPermissionRequests={pendingPermissionRequests}
                    handlePermissionDecision={handlePermissionDecision}
                    handleGrantToolPermission={handleGrantToolPermission}
                  />
                ) : null
              }
              // THE ONE message waiting, in its two states (ruling 2026-10-14). `text` is the relay's
              // hold — every sentence spoken since the run started is merged into it, and the card is
              // read-only: the per-sentence withdrawal stack it replaces is gone, because there is one
              // bubble and nothing to press. `queuedText` is the delivered-but-not-yet-started wait the
              // hold leaves behind (2026-10-14 evening reading): the words are in the CLI's queue and
              // the page has no row of its own for them until the host reports `started`. The card
              // prefers the hold, so the two never both draw — still ONE card at any moment.
              pendingMessage={<VoicePendingMessageCard text={voice.pendingMessage} queuedText={voice.queuedDeliveryText} />}
              modelMenu={
                <ComposerModelMenu
                  effort={currentProviderEffort}
                  effortOptions={currentProviderEffortOptions}
                  onSelectEffort={handleSelectComposerEffort}
                  model={currentProviderModel}
                  modelOptions={currentProviderModelOptions}
                  onSelectModel={handleSelectComposerModel}
                  modelsLoading={providerModelsLoading}
                />
              }
            />
          ) : (
            <>
              {voiceEntryNotice && (
                // The entry's own reply to a tap it could not fulfil: a session
                // allocation that failed. Visible rather than a state on the
                // button, because the button stays available to try again.
                <div
                  role="status"
                  data-testid="live-voice-notice"
                  className="px-4 pb-2 text-[11px] leading-snug text-muted-foreground"
                >
                  {voiceEntryNotice}
                </div>
              )}
              <ChatComposer
          onLiveVoice={enterVoiceMode}
          liveVoiceDisabled={voiceEntryAllocating}
          // Only while an allocation is in flight, not for the whole of a
          // brand-new conversation: the entry now allocates a session itself
          // instead of asking for one to exist. A tap is answered rather than
          // silently swallowed, per the entry's visible-notice contract.
          liveVoiceDisabledReason={t('voice.realtime.needsSession', {
            defaultValue: 'Live Voice needs a conversation. Send a message first, then start Live Voice.',
          })}
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
          voiceRange={voiceRange}
          contextMessages={visibleMessages}
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
          chipStrip={chipStrip}
          replyReference={replyReference}
          replyItems={latestReplyItems?.items}
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
