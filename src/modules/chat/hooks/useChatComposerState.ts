import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';

import { api } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import type { ChatAttachment, ChatMessage, MarkSessionIdle, MarkSessionProcessing, PendingPermissionRequest, PermissionMode, SessionActivityMap, SessionEstablishedContext, Project, ProjectSession, LLMProvider, SlashCommand, QueuedDraft, QueuedSendOptions, ServerEvent } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/session/chatPermissions';
import { createChatSession } from '@/modules/chat/utils/session/sessionCreation';
import { writeDraftText, writeQueuedMessage } from '@/shared/chatDrafts';
import { useAttachmentState, isImageAttachment, uploadAttachmentFiles } from '@/modules/chat/hooks/useAttachmentState';
import { useCommandMenuState } from '@/modules/chat/hooks/useCommandMenuState';
import { useDraftState } from '@/modules/chat/hooks/useDraftState';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useInputSuggestions } from '@/modules/chat/hooks/useInputSuggestions';
import { useReplySuggestions } from '@/modules/chat/hooks/useReplySuggestions';
import { suggestionConditionsHold } from '@/modules/chat/utils/inputSuggestions';
import type { SuggestionChip } from '@/modules/chat/utils/inputSuggestions';
import { useSendDeliveryState } from '@/modules/chat/hooks/useSendDeliveryState';
import { useSendOnEnter } from '@/modules/chat/hooks/useSendOnEnter';
import { useTextareaInteractionState } from '@/modules/chat/hooks/useTextareaInteractionState';
import { useVoiceInsertionState } from '@/modules/chat/hooks/useVoiceInsertionState';
import { findSessionHostState, findSessionOccupancy, useSessionHosts } from '@/shared/hooks/useSessionHosts';

/**
 * The composer's state, assembled from one hook per concern.
 *
 * Every concern lives in its own hook — the textarea and its draft mirror
 * (`useTextareaInteractionState`), attachments (`useAttachmentState`), slash
 * commands and their modals (`useCommandMenuState`), dictation insertion
 * (`useVoiceInsertionState`), the queued-message card (`useDraftState`) and send
 * delivery (`useSendDeliveryState`). What remains here is the one thing that has
 * to see all of them at once: the send path (`handleSubmit`) and the handlers
 * that route a DOM event to the concern that owns it.
 */

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  /**
   * True while the activity dock is drawing a turn, from `useActivityDockTurn`.
   *
   * The chips are an idle-only affordance, and the dock is the surface that
   * knows whether a turn is running: a server-confirmed turn (another client, a
   * voice turn, a reloaded page) can outlive this client's local `isLoading`
   * mark. Fed into `useInputSuggestions` so the chips' display and their key
   * handling share that one reading. Optional for callers with no dock.
   */
  isDockTurnShown?: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  /**
   * Whether the app's socket is open right now. A closed socket cannot carry
   * the send at all, so the composer fails the send at once instead of arming a
   * deadline for an answer that cannot come. Defaults to connected (fail-open):
   * a caller that does not report the socket is not thereby disconnected.
   */
  isConnected?: boolean;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Clears the local "processing" mark for a session. The send path marks a
   * turn before the frame leaves the socket (the indicator must react at once),
   * so a send that is never taken has to take that mark back — otherwise the
   * dock keeps claiming a turn the server never started.
   */
  onSessionIdle?: MarkSessionIdle;
  /**
   * Subscribes to every server frame, so the send path can hear the answer to
   * the message it just sent. The first frame the server addresses to the
   * session is the delivery's acknowledgement; silence past the deadline is
   * the failure.
   */
  subscribe?: (listener: (event: ServerEvent) => void) => () => void;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  /**
   * Appends an optimistic row to the transcript. Returns the store row id it
   * was written under when the transcript store owns ids, so the send path can
   * take the row back if the send is never delivered; callers that render a
   * list without ids may return nothing.
   */
  addMessage: (msg: ChatMessage) => string | null | void;
  /**
   * Hides a row the send path added optimistically, because the send it stood
   * for was not delivered. Pair with {@link restoreUserTurn} on the retry.
   */
  markUserTurnUndelivered?: (id: string) => void;
  /** Puts a hidden optimistic row back on screen when its message is retried. */
  restoreUserTurn?: (id: string) => void;
  /**
   * Records a message handed to a resident process that has not started it yet.
   *
   * A third way for a sent message to enter the transcript, beside `addMessage`
   * (an ordinary turn) and the durable queue (`QueuedMessageCard`): this one is
   * neither, because the message is already the process's — what it needs is the
   * host's own account of where the command is, which is the session store's
   * `command_lifecycle` row. Optional so a caller with no store (a test harness)
   * can still drive the composer; an absent one drops the row, which is exactly
   * what a client with no transcript would show anyway.
   */
  addResidentPending?: (sessionId: string, text: string) => void;
  /**
   * Whether the next brand-new session should be created resident.
   *
   * The switch that sets it has one home — the new-session empty state's model card — and this hook's
   * send path is where the value has to act: the session row is allocated here, and the lifecycle-mode
   * write that keeps it running lands between that allocation and the first `chat.send`. Read only
   * when the send has no session to address (a brand-new conversation), never for one that already
   * exists: the composer no longer offers a switch on an open session, so a send addressed to one must
   * not convert it.
   */
  residentEnabled?: boolean;
  /** Clears the switch's position once the new session it applied to has been made resident. */
  clearResidentIntent?: () => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /**
   * Stable identity of the last assistant message in the open transcript.
   *
   * The model chips are drawn once per answer, so this is their extraction trigger: a new value
   * (the assistant replied again) asks the server for a fresh batch, the same value never does.
   * Optional so test harnesses and callers without a transcript keep working; absent means no
   * model chips, which is the same surface a disabled feature draws.
   */
  lastAssistantMessageId?: string | null;
  /**
   * The passage selected in the transcript, from `useTranscriptSelection`.
   *
   * Feeds the quoted chip (the first in the strip) and the `focus` of a redraw. Null is the
   * ordinary state; the transcript/textareas are the only producers.
   */
  quotedSelection?: string | null;
};

type MentionableFile = {
  name: string;
  path: string;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  isDockTurnShown = false,
  canAbortSession,
  tokenBudget,
  sendMessage,
  isConnected = true,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionIdle,
  subscribe,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  markUserTurnUndelivered,
  restoreUserTurn,
  addResidentPending,
  residentEnabled = false,
  clearResidentIntent,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
  lastAssistantMessageId = null,
  quotedSelection = null,
}: UseChatComposerStateArgs) {
  // The stored lifecycle mode of the session this composer is addressing. The
  // same store the sidebar's mark and the status bar read — one poller, one
  // answer — because "is this session resident" has to mean one thing: this hook
  // decides whether a busy session gets the message handed over or stashed, and a
  // second reading that disagreed would put the two halves of one send in two
  // different places.
  const { snapshot: hostsSnapshot } = useSessionHosts();

  const {
    input,
    setInput,
    inputValueRef,
    sessionKey,
    sessionKeyRef,
    draftScope,
    draftScopeRef,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    setIsTextareaExpanded,
    resizeTextarea,
    syncInputOverlayScroll,
    isImeComposing,
    isInputFocused,
    handleInputFocusChange,
  } = useTextareaInteractionState({ selectedProject, selectedSession, currentSessionId });

  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);

  // The send path is defined at the bottom of this hook — it reads every
  // concern above — so the hooks that can fire a send (a custom command, a
  // dictation sent on commit) reach it through this ref and callback rather
  // than depending on it.
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
    ) => Promise<void>) | null
  >(null);
  const submitComposer = useCallback(() => {
    void handleSubmitRef.current?.(createFakeSubmitEvent());
  }, []);

  const { voiceRange, handleVoiceListeningStart, handleVoiceTranscript, remapVoiceRangeOnEdit } =
    useVoiceInsertionState({ setInput, inputValueRef, submit: submitComposer });

  const {
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    setFileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handlePaste,
  } = useAttachmentState();

  const { sendFailed, setSendFailed, beginDelivery, pendingDeliveryRef, undeliveredTurnRef } =
    useSendDeliveryState({ subscribe });

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    executeCommand,
  } = useCommandMenuState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    currentProviderModel,
    tokenBudget,
    input,
    setInput,
    inputValueRef,
    textareaRef,
    addMessage,
    onFileOpen,
    onShowSettings,
    submit: submitComposer,
  });

  const { queuedDraft, setQueuedDraft, queuedDraftSessionRef, editQueuedDraft, deleteQueuedDraft } =
    useDraftState({ sessionKey, setInput, inputValueRef, textareaRef, setAttachedFiles });

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput, inputValueRef]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });
  // An accepted chip is filled into the draft, not sent: the same pair of stores
  // a send reads is written so the very next Enter submits the new text rather
  // than a stale value. The caret goes to the end so the user can extend it.
  const acceptSuggestion = useCallback((text: string) => {
    setInputFromHistory(text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
    });
  }, [setInputFromHistory, textareaRef]);

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  // The idle conditions every chip shares. Read here, once, because the model
  // tier's extraction trigger and the strip `useInputSuggestions` draws must be
  // the same answer: asking the server while the dock says a turn is running is
  // a request nobody can see the result of.
  const suggestionConditions = {
    isLoading,
    isDockTurnShown,
    isOccupied: Boolean(findSessionOccupancy(hostsSnapshot, sessionKey)),
    isCommandMenuOpen: showCommandMenu,
    isFileMenuOpen: showFileDropdown,
    hasQueuedDraft: queuedDraft !== null,
    hasAttachments: attachedFiles.length > 0,
  };
  const trimmedQuotedSelection = quotedSelection?.trim() ? quotedSelection.trim() : null;

  /**
   * The passage a quoted chip pasted, held after the browser selection itself is gone.
   *
   * Clicking the chip focuses the textarea, and focusing it collapses the document
   * selection — which the selection hook correctly reports as "no selection". The
   * proposal still promises the chip stays while the box holds the quote (that is how
   * several passages are appended), so the accepted text is pinned here until the box
   * is emptied or a NEW transcript selection arrives. It is never a stale source: it is
   * set only from the chip that was just accepted.
   */
  const [pinnedQuote, setPinnedQuote] = useState<string | null>(null);
  // A fresh selection supersedes the pinned one. Clearing (null) deliberately does not:
  // that is the focus collapse the pin exists to survive.
  useEffect(() => {
    if (trimmedQuotedSelection) {
      setPinnedQuote(null);
    }
  }, [trimmedQuotedSelection]);
  // The composition's last chip fill, for the one undo this surface owns: a fill is a
  // programmatic value, so the browser has no native undo entry for it.
  const lastChipFillRef = useRef<{ before: string; after: string } | null>(null);

  const effectiveQuotedSelection = trimmedQuotedSelection
    ?? (input !== '' ? pinnedQuote : null);

  // Model chips: one draw per assistant message, only while the empty box would
  // show them, silent when the feature is off. The hook is called before the strip
  // because its chips are the strip's second source.
  const {
    enabled: replySuggestionsEnabled,
    chips: replySuggestionChips,
    loading: replySuggestionsLoading,
    redraw: redrawReplySuggestions,
    reportEvent: reportReplySuggestionEvent,
  } = useReplySuggestions({
    sessionId: currentSessionId,
    lastAssistantMessageId,
    active: suggestionConditionsHold(suggestionConditions) && input === '',
    focus: effectiveQuotedSelection,
  });

  // The text a model chip wrote into the draft, held until the send path confirms
  // it went out. That is what makes `sent` a report about a delivered chip rather
  // than about a click.
  const modelChipFillRef = useRef<string | null>(null);

  // Accepts one merged chip. The sources deliberately differ: a model reply is
  // complete, so clicking it fills AND sends; a quotation is pasted and focused so
  // the person can answer it; a habit is the original fill-only behaviour.
  const acceptSuggestionChip = useCallback((chip: SuggestionChip) => {
    if (chip.source === 'model') {
      modelChipFillRef.current = chip.text;
      reportReplySuggestionEvent('picked', chip.index);
      setInputFromHistory(chip.text);
      // The send path reads `inputValueRef`, not render state, so the fill above is
      // already visible to it on this same tick.
      submitComposer();
      return;
    }
    if (chip.source === 'quoted') {
      const quoted = `> ${chip.text.replace(/\r?\n/gu, '\n> ')}\n`;
      const current = inputValueRef.current;
      const next = current.trim() ? `${current.replace(/\s+$/u, '')}\n\n${quoted}` : quoted;
      modelChipFillRef.current = null;
      // Keep the chip after the focus collapse the fill itself causes.
      setPinnedQuote(chip.text);
      lastChipFillRef.current = { before: current, after: next };
      setInputFromHistory(next);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(next.length, next.length);
      });
      return;
    }
    acceptSuggestion(chip.text);
  }, [
    acceptSuggestion,
    inputValueRef,
    reportReplySuggestionEvent,
    setInputFromHistory,
    submitComposer,
    textareaRef,
  ]);

  // Empty-box suggestion chips. Every display condition the proposal names is
  // read here — the same values the composer itself paints from — and the hook
  // owns selection, the Esc round, the adoption counters and the Tab/Enter/Esc
  // semantics. It is called after the menu hooks because those decide two of the
  // conditions.
  const {
    candidates: inputSuggestionCandidates,
    chips: suggestionChips,
    selectedIndex: selectedInputSuggestionIndex,
    listId: inputSuggestionListId,
    visible: inputSuggestionsVisible,
    accept: acceptInputSuggestion,
    handleKeyDown: handleInputSuggestionsKeyDown,
  } = useInputSuggestions({
    input,
    ...suggestionConditions,
    draftScope,
    modelChips: replySuggestionChips,
    quotedText: effectiveQuotedSelection,
    onAccept: acceptSuggestionChip,
  });

  /** Accepts one model chip by its index in the current batch (the Suggest-button surface). */
  const acceptModelSuggestion = useCallback((index: number) => {
    const text = replySuggestionChips[index];
    if (text === undefined) {
      return;
    }
    modelChipFillRef.current = text;
    lastChipFillRef.current = { before: inputValueRef.current, after: text };
    reportReplySuggestionEvent('picked', index);
    setInputFromHistory(text);
    submitComposer();
  }, [inputValueRef, replySuggestionChips, reportReplySuggestionEvent, setInputFromHistory, submitComposer]);

  /**
   * Pastes a quotation as `> text` on its own line(s) and focuses. Never sends.
   *
   * The text is passed in by the strip rather than re-read from the selection: by the
   * time the click lands the selection may already be collapsing, and the chip's own
   * recorded text is the stable source (the same reason its label/title carry it).
   */
  const acceptQuotedSuggestion = useCallback((text?: string) => {
    const quote = (text ?? effectiveQuotedSelection)?.trim();
    if (!quote) {
      return;
    }
    acceptSuggestionChip({ id: 'quoted-0', text: quote, source: 'quoted', index: 0 });
  }, [acceptSuggestionChip, effectiveQuotedSelection]);

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
    ) => {
      event.preventDefault();
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachments = queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      // A Claude Code background job holds this session: the transcript is
      // being written by a process this composer has no handle on, so a message
      // sent from here would land in a conversation that is already owned. The
      // disabled input and the hidden Start/Restart button state the same thing,
      // but they are UI the user can walk around (a keyboard submit, a queued
      // voice transcript, an edit-and-resend); the refusal has to live here too,
      // on the one path every send funnels through, or the guard is only as
      // wide as the surface that happens to render it. Releasing the job on the
      // CLI side clears the row on the next poll and the same call goes through.
      if (sessionKey && findSessionOccupancy(hostsSnapshot, sessionKey)) {
        return;
      }

      // A send is already awaiting its answer. Its text has not been cleared
      // from the box (that happens only once the server takes it), so a second
      // submit would duplicate the same message and steal the first one's
      // acknowledgement — the send path is therefore closed until it settles.
      if (pendingDeliveryRef.current?.delivery.getPhase() === 'sending') {
        return;
      }

      // Whether this send is going to a process that is already running.
      //
      // Read before anything is uploaded, because it decides whether the message
      // is stashed at all. The mode is the session's own stored one — not a guess
      // from the composer's switch, which is an intent about what happens next
      // and says nothing about the process that is running now.
      const busySendToResidentProcess = Boolean(
        isLoading
        && sessionKey
        && findSessionHostState(hostsSnapshot, sessionKey)?.lifecycleMode === 'resident',
      );

      // A turn is already in flight: stash this message instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      //
      // A resident process is the one exception, and it is the opposite case: the
      // message does not have to wait for the turn to end, because the process
      // takes it while its answer is still being written and starts it when that
      // answer is done. So it goes out on this very frame, through the ordinary
      // send path below, and the transcript holds it with the host's own account
      // of where the command is. Stashing it here instead would be this client
      // keeping a queue the process already has.
      if (isLoading && !busySendToResidentProcess) {
        // A run can restart in the tiny gap between scheduling and flushing a
        // queued submission. Put the same durable draft back without uploading
        // its files again.
        if (queuedSubmission) {
          queuedDraftSessionRef.current = sessionKey;
          setQueuedDraft(queuedSubmission);
          return;
        }

        const queuedOptions = buildSendOptions(currentInput);
        const queuedSessionKey = sessionKey;
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        const durableDraft: QueuedDraft = {
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          options: queuedOptions,
        };
        if (queuedSessionKey) {
          // Write the claim ticket synchronously after upload; this closes the
          // gap before React's persistence effect runs.
          writeQueuedMessage(queuedSessionKey, {
            content: durableDraft.content,
            options: durableDraft.options,
            attachments: durableDraft.uploadedAttachments,
          });
        }

        // Recorded under the session the message was queued FOR, and before
        // the session-switch return below — the queued text must be
        // recallable even when it dispatches without this composer.
        recordSentMessage(currentInput, queuedSessionKey);

        // The server owns dispatch after persistence. If the user changed
        // sessions during upload, the durable record is already enough; do
        // not attach its UI card to the newly opened composer.
        if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
          return;
        }

        queuedDraftSessionRef.current = queuedSessionKey;
        setQueuedDraft(durableDraft);
        setInput('');
        inputValueRef.current = '';
        setAttachedFiles([]);
        setFileErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        if (draftScopeRef.current) {
          writeDraftText(draftScopeRef.current, '');
        }
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput;

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The draft scope this message was typed in. Captured before the first await, and in
      // particular before the session is allocated and established: a brand-new chat is navigated
      // to its session *during* the send, and every await after that point (the resident
      // lifecycle-mode write) lets the composer re-render onto the new scope. Read any
      // later, this is the new session's empty scope, the typed-in `project:` draft is never retired
      // and the next New Session opens on the message that was already sent. The clear belongs to
      // the scope the text was typed in.
      const sentDraftScope = draftScopeRef.current;

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const created = await createChatSession({
            provider,
            projectPath: resolvedProjectPath,
            initialMessage: messageContent,
            // The same three values the frame below carries, stated on the
            // allocation as well. This send records them itself, but the row is
            // minted here, and a session's selection has to belong to the session
            // rather than to whichever message happened to open it: Live Voice and
            // MCP open first turns that carry none (see `createChatSession`).
            model: currentProviderModel,
            effort: currentProviderEffort,
            permissionMode: String(permissionMode),
          });
          targetSessionId = created.sessionId;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          if (created.sessionName) {
            createdSessionName = created.sessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        // `createChatSession` throws on a blank id rather than returning one, so
        // this is always set on the path that reaches here; the guard keeps that
        // guarantee visible to the type checker.
        if (!targetSessionId) {
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
        });

        // The resident intent belongs to this brand-new session and nowhere else: the session row
        // now exists and the mode is written before the turn starts. Both halves of that window
        // matter — there is nothing to write a preference against earlier, and the server refuses a
        // mode change while a host is mid-turn, so a write that travelled with the send would race
        // the process the send itself opens. It is read here, inside the new-session branch, and
        // never for a send addressed to a session that already exists: the switch was removed from
        // the composer, so an open session must not be converted by a position the user set while
        // starting a different one.
        if (residentEnabled) {
          try {
            await api.providers.setSessionLifecycleMode(provider, targetSessionId, 'resident');
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Resident mode request failed:', error);
            addMessage({
              type: 'error',
              content: `Failed to keep this session running: ${message}`,
              timestamp: new Date(),
            });
          }
          // The intent has been spent on the session it was set for. Clearing it here is what keeps a
          // later send into an old per-run session from being converted silently: even though that
          // send never reads the switch, a stale "on" would still be drawn on the next New Session.
          clearResidentIntent?.();
        }
      }

      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
        // Tags this echo as the replacement, so the truncation the server
        // broadcasts a moment later cuts the turns being replaced without
        // taking the message the user just sent with them.
        ...(editingAnchorId ? { replacesAnchorId: editingAnchorId } : {}),
      };

      // The socket is not open: the frame cannot leave this client, so the send
      // has already failed and there is nothing to wait for. Declared now — no
      // local turn mark, no optimistic row, and the draft stays exactly where
      // the user typed it. The deadline below is for the other case: a socket
      // that looks open and then says nothing back.
      if (isConnected === false) {
        setSendFailed(true);
        return;
      }

      // The optimistic row this send stands for, when the transcript store owns
      // ids. A send that is never delivered takes it back; a retry of the same
      // text re-shows it instead of minting a second row for one message.
      let optimisticRowId: string | null = null;

      // A message handed to a running process is not a turn yet: it is a command
      // the process is holding, and what the transcript has to show about it is
      // the host's own account of where it is. So it enters the record as the
      // store's own lifecycle row — the user's text, drawn with the state and the
      // withdrawal that row's `command_lifecycle` updates bring with them —
      // rather than as a user turn this client would then have to take back when
      // the host said something else about it.
      if (busySendToResidentProcess) {
        addResidentPending?.(targetSessionId, messageContent);
      } else if (undeliveredTurnRef.current && undeliveredTurnRef.current.text === currentInput) {
        // The retry of a send that was never delivered. The row is already in
        // the transcript, hidden; put it back rather than mint a second one —
        // the transcript's user-turn dedupe pairs one local row with one
        // persisted turn, so two local rows for one message would leave one of
        // them permanently unretired and drawn beside the other.
        restoreUserTurn?.(undeliveredTurnRef.current.id);
        optimisticRowId = undeliveredTurnRef.current.id;
        undeliveredTurnRef.current = null;
      } else {
        const addedRowId = addMessage(userMessage);
        optimisticRowId = typeof addedRowId === 'string' ? addedRowId : null;
      }
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore. A send
      // that is never delivered takes this mark back in its settle handler.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      /**
       * The composer state a *delivered* message leaves behind: recorded in the
       * input history, removed from the box. Deferred out of the optimistic path
       * on purpose — a send the server never took must leave the draft where the
       * user typed it, or "try again" costs them the whole message.
       */
      const commitSentComposerState = () => {
        // `sent` is reported only when the text that went out is the one a model
        // chip wrote — a typed message is not this ledger's business.
        if (modelChipFillRef.current !== null && currentInput === modelChipFillRef.current) {
          reportReplySuggestionEvent('sent');
        }
        modelChipFillRef.current = null;
        recordSentMessage(currentInput, targetSessionId);
        // The box itself is cleared only while it still shows the scope the
        // message came from; a scope that has moved on (a new chat) already
        // shows its own, empty draft.
        if (draftScopeRef.current === sentDraftScope) {
          setInput('');
          inputValueRef.current = '';
        }
        // The stored draft of the sent scope is always retired — this is the
        // half the old, synchronous clear performed, and deferring it must not
        // leave the typed-in scope holding a message that has been delivered.
        if (sentDraftScope) {
          writeDraftText(sentDraftScope, '');
        }
        resetCommandMenuState();
        setAttachedFiles([]);
        setFileErrors(new Map());
        setIsTextareaExpanded(false);

        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
      };

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      const sendFrame = {
        // Replacing an already-sent message is its own frame: it changes the
        // shape of the conversation, so it gets validated separately and can
        // report why it was refused.
        type: editingAnchorId ? 'chat.edit-send' : 'chat.send',
        sessionId: targetSessionId,
        ...(editingAnchorId ? { anchorId: editingAnchorId } : {}),
        content: messageContent,
        options: {
          ...(queuedSubmission?.options ?? buildSendOptions(messageContent)),
          attachments: uploadedAttachments,
        },
      };

      if (busySendToResidentProcess) {
        // The process is already in a turn and takes the command itself, so the
        // message has left the composer whatever the process later says about
        // it; there is no delivery to await.
        sendMessage(sendFrame);
        setEditingAnchorId(null);
        commitSentComposerState();
        return;
      }

      // Watch this send to its answer. The first frame the server addresses to
      // the session settles it delivered — the composer clears and the marked
      // turn stands. The deadline with nothing said settles it failed — the
      // draft stays, the optimistic row is hidden, the local processing mark is
      // taken back, and the dock reports the failure instead of a turn.
      beginDelivery(targetSessionId, (phase) => {
        if (phase === 'delivered') {
          setSendFailed(false);
          undeliveredTurnRef.current = null;
          commitSentComposerState();
          return;
        }
        setSendFailed(true);
        onSessionIdle?.(targetSessionId);
        if (optimisticRowId) {
          markUserTurnUndelivered?.(optimisticRowId);
          undeliveredTurnRef.current = { id: optimisticRowId, text: currentInput };
        }
      });

      sendMessage(sendFrame);
      setEditingAnchorId(null);
    },
    [
      selectedSession,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      executeCommand,
      hostsSnapshot,
      isConnected,
      isLoading,
      onSessionProcessing,
      onSessionIdle,
      onSessionEstablished,
      provider,
      recordSentMessage,
      reportReplySuggestionEvent,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      markUserTurnUndelivered,
      restoreUserTurn,
      residentEnabled,
      clearResidentIntent,
      setIsUserScrolledUp,
      slashCommands,
      // The three selections the session allocation states. Read here rather than
      // only inside `buildSendOptions` (whose own memo carries them), because the
      // allocation is the write that has to be current: a submit holding a stale
      // model would mint the row with the model the page showed a render ago.
      currentProviderModel,
      currentProviderEffort,
      permissionMode,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      // Carry the voice insertion range through the edit before it lands in state.
      remapVoiceRangeOnEdit(inputValueRef.current, newValue);

      // Deliberately no `cleared` here. That event means "the person dismissed the
      // batch with the clear control or Escape"; deleting the text by hand is an edit,
      // not a dismissal, and reporting it would count every backspace as a clear.

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [
      handleCommandInputChange,
      inputValueRef,
      remapVoiceRangeOnEdit,
      resetCommandMenuState,
      setCursorPosition,
      setInput,
      setIsTextareaExpanded,
    ],
  );

  // Resolved here rather than from the raw preference: on a touch-only device Enter inserts a
  // newline regardless of what the stored preference says, because a soft keyboard has no
  // Shift key to offer as the newline alternative.
  const { sendOnEnter } = useSendOnEnter(sendByCtrlEnter);

  /**
   * The one clear action behind the footer's ✕ and the Esc gesture.
   *
   * `cleared` is reported HERE and nowhere else: it means the person dismissed the
   * draft with a clear control, not that the text happened to become empty. The
   * accepted quote and any chip fill are forgotten with it, and the caret returns
   * to the now-empty box.
   */
  const handleClearInput = useCallback(() => {
    if (inputValueRef.current !== '') {
      reportReplySuggestionEvent('cleared');
    }
    setInput('');
    inputValueRef.current = '';
    setPinnedQuote(null);
    lastChipFillRef.current = null;
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [
    inputValueRef,
    reportReplySuggestionEvent,
    resetCommandMenuState,
    setInput,
    setIsTextareaExpanded,
    textareaRef,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // A chip fill writes the draft programmatically, so the browser has no native
      // undo entry for it: Ctrl+Z would otherwise do nothing on the text the user just
      // got from a chip. Intercept exactly while the box still holds that fill, and
      // only then — every other edit keeps the browser's own undo.
      if (
        event.key.toLowerCase() === 'z'
        && (event.ctrlKey || event.metaKey)
        && !event.shiftKey
        && lastChipFillRef.current !== null
        && inputValueRef.current === lastChipFillRef.current.after
      ) {
        event.preventDefault();
        const restore = lastChipFillRef.current.before;
        lastChipFillRef.current = null;
        setInputFromHistory(restore);
        return;
      }

      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      // Suggestion chips sit between history recall and the existing Tab/Enter
      // branches: they own Tab only while visible (falling through, un-consumed,
      // once the selection walks past an end) and Enter only while a chip is
      // selected. A composition's Enter is never an acceptance.
      if (handleInputSuggestionsKeyDown(event, event.nativeEvent.isComposing || isImeComposing())) {
        return;
      }

      if (event.key === 'Escape') {
        // Escape is a clear gesture only when there is a draft to clear and nothing
        // else owns the key. The menu handlers above get it first (an open slash or
        // file menu closes, the box keeps its text); a running turn keeps the global
        // abort meaning, and an empty box keeps the chip-hide behaviour the suggestion
        // hook has already handled. Anything left here falls through un-consumed.
        if (
          inputValueRef.current !== ''
          && !isLoading
          && !isDockTurnShown
          && !showCommandMenu
          && !showFileDropdown
        ) {
          event.preventDefault();
          event.stopPropagation();
          handleClearInput();
        }
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing || isImeComposing()) {
          return;
        }

        // Both Enter bindings submit the composer form rather than calling this hook's `handleSubmit`
        // directly. The form's own submit handler is the composer's `handleComposerSubmit`, and the
        // send path it reaches is the one entry every path shares; the key press is routed to the
        // form instead of being given a send of its own so a click, Ctrl+Enter and a bare Enter all
        // end at the same `handleSubmit`.
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && sendOnEnter) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleClearInput,
      handleHistoryKeyDown,
      handleInputSuggestionsKeyDown,
      inputValueRef,
      isDockTurnShown,
      isImeComposing,
      isLoading,
      sendOnEnter,
      setInputFromHistory,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [inputValueRef, setInput, textareaRef]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [inputValueRef, setInput]);

  return {
    input,
    setInput,
    draftScope,
    /**
     * True when the last send was never delivered. The composer's dock reports
     * it in place of a turn while the draft waits to be retried.
     */
    sendFailed,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
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
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    inputSuggestionCandidates,
    inputSuggestionsVisible,
    selectedInputSuggestionIndex,
    inputSuggestionListId,
    acceptInputSuggestion,
    suggestionChips,
    acceptModelSuggestion,
    acceptQuotedSuggestion,
    replySuggestionsEnabled,
    replySuggestionsLoading,
    redrawReplySuggestions,
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
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
