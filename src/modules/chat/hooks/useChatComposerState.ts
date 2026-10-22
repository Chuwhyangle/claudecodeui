import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { api } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import type { CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionIdle, MarkSessionProcessing, ModelCommandData, QueuedDraft, ServerEvent, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/session/chatPermissions';
import { createChatSession } from '@/modules/chat/utils/session/sessionCreation';
import { createSendDelivery } from '@/modules/chat/utils/session/sendDelivery';
import type { SendDelivery } from '@/modules/chat/utils/session/sendDelivery';

import {
  clearQueuedMessage,
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessage,
  subscribeToChatDrafts,
  writeDraftText,
  writeQueuedMessage,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/transcript/chatFormatting';
import { applyVoiceChange, beginVoiceInsertion } from '@/modules/chat/utils/voice/voiceInsertion';
import type { VoiceInsertion } from '@/modules/chat/utils/voice/voiceInsertion';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSendOnEnter } from '@/modules/chat/hooks/useSendOnEnter';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import { findSessionHostState, findSessionOccupancy, useSessionHosts } from '@/shared/hooks/useSessionHosts';

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
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};

const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved
    ? {
        content: saved.content,
        attachments: [],
        uploadedAttachments: saved.attachments ?? saved.images,
        options: saved.options,
      }
    : null;
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

/**
 * Enter that CONFIRMS an IME candidate must not also submit.
 *
 * `event.isComposing` alone is not enough: Safari fires `compositionend` BEFORE the confirming
 * Enter's `keydown`, so the flag is already `false` by the time the handler runs. Chrome and
 * Firefox fire it after, which is why the naive guard looks correct on those two and the bug
 * reads as Safari-only. A tight window after `compositionend` covers it — that sequence is
 * synchronous (microseconds), while a human pressing Enter a second time takes >= 100ms and
 * never lands inside it.
 */
const SAFARI_IME_RACE_WINDOW_MS = 30;

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
}: UseChatComposerStateArgs) {
  // The stored lifecycle mode of the session this composer is addressing. The
  // same store the sidebar's mark and the status bar read — one poller, one
  // answer — because "is this session resident" has to mean one thing: this hook
  // decides whether a busy session gets the message handed over or stashed, and a
  // second reading that disagreed would put the two halves of one send in two
  // different places.
  const { snapshot: hostsSnapshot } = useSessionHosts();
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);
  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  /**
   * Whether the last send was never taken — the dock reports it in place of a
   * turn. Kept as state rather than derived from the delivery ref because the
   * machine settles outside React and the surface has to redraw when it does.
   */
  const [sendFailed, setSendFailed] = useState(false);
  // The one in-flight send whose acknowledgement (or deadline) is still being
  // awaited. Only ever one: a second submit while a send is unresolved is
  // ignored, so an answer can be attributed to the frame that produced it.
  const pendingDeliveryRef = useRef<{ sessionId: string; delivery: SendDelivery } | null>(null);
  // The optimistic row a failed send left behind, so its retry re-shows the same
  // row instead of adding a second one for the same text.
  const undeliveredTurnRef = useRef<{ id: string; text: string } | null>(null);

  // The server's answer to the send that is in flight. Any frame it addresses
  // to the session is the acknowledgement — it proves the socket is two-way and
  // the frame the send handed it was received. A `protocol_error` is the other
  // answer: the server read the send and refused it, so the send failed even
  // though frames are arriving. Frames for other sessions, and the synthetic
  // reconnect marker this client mints itself, prove nothing about this send.
  useEffect(() => {
    if (!subscribe) {
      return undefined;
    }
    return subscribe((event) => {
      const pending = pendingDeliveryRef.current;
      if (!pending || pending.delivery.getPhase() !== 'sending') return;
      if (!event.kind || event.kind === 'websocket_reconnected') return;
      if (event.sessionId !== pending.sessionId) return;
      if (event.kind === 'protocol_error') {
        pending.delivery.fail();
        return;
      }
      pending.delivery.ack();
    });
  }, [subscribe]);

  useEffect(() => () => {
    pendingDeliveryRef.current?.delivery.dispose();
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  /**
   * The tracked insertion range a continuous listen commits its text into, or null between listens.
   *
   * A ref rather than state: the range has to advance in step with `inputValueRef` on every edit and
   * every committed segment, and a value read asynchronously (the hook hands over text while the user
   * may be typing) cannot be a snapshot from an earlier render.
   */
  const voiceInsertionRef = useRef<VoiceInsertion | null>(null);
  /**
   * The interval `voiceInsertionRef` currently holds, as a value the composer can paint from.
   *
   * The ref above stays the source of truth — it is read and written from callbacks that outlive a
   * render — but a ref write does not redraw anything. This mirror exists for the one consumer that
   * has to SEE the range: the composer paints the provisional background behind the committed voice
   * text, and an overlay that only learned about the range on the next unrelated render would show
   * the highlight late and drop it late. Every write to the ref below writes this too, so the two
   * cannot describe different intervals.
   */
  const [voiceRange, setVoiceRange] = useState<Pick<VoiceInsertion, 'start' | 'end'> | null>(null);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  // Composition is tracked on `window` in the capture phase rather than on the textarea, so a
  // composition that starts in one field and ends after focus moves still closes cleanly.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  useEffect(() => {
    const onStart = () => {
      isComposingRef.current = true;
    };
    const onEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
    };
    // `blur` does not bubble, but a capture-phase listener on `window` still sees it on the way
    // down — otherwise a composition abandoned by clicking away would stay open forever.
    const onBlur = () => {
      isComposingRef.current = false;
    };
    window.addEventListener('compositionstart', onStart, true);
    window.addEventListener('compositionend', onEnd, true);
    window.addEventListener('blur', onBlur, true);
    return () => {
      window.removeEventListener('compositionstart', onStart, true);
      window.removeEventListener('compositionend', onEnd, true);
      window.removeEventListener('blur', onBlur, true);
    };
  }, []);

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while `queuedDraft` still holds the old session's draft; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

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
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

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

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

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
      const delivery = createSendDelivery({
        onSettle: (phase) => {
          if (pendingDeliveryRef.current?.delivery === delivery) {
            pendingDeliveryRef.current = null;
          }
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
        },
      });
      pendingDeliveryRef.current = { sessionId: targetSessionId, delivery };
      setSendFailed(false);
      delivery.begin();

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

  // The VPS dispatcher owns sending. While the card is visible, periodically
  // reconcile only its removal so the UI notices when the server claims it.
  useEffect(() => {
    if (!sessionKey || !queuedDraft) {
      return;
    }
    let cancelled = false;
    const reconcile = async () => {
      await hydrateChatDrafts();
      if (!cancelled && !readQueuedMessage(sessionKey)) {
        queuedDraftSessionRef.current = sessionKey;
        setQueuedDraft(null);
      }
    };
    const timer = setInterval(() => void reconcile(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [queuedDraft, sessionKey]);

  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    setQueuedDraft(null);
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedFiles(queuedDraft.attachments);
    textareaRef.current?.focus();
  }, [queuedDraft]);

  const deleteQueuedDraft = useCallback(() => {
    setQueuedDraft(null);
  }, []);

  /**
   * Opens the tracked insertion range where a listen starts.
   *
   * The composer calls this with the caret that was in the box when the microphone was pressed.
   * Everything the listen commits goes into this range, so edits the user makes elsewhere while
   * talking shift it rather than being overwritten.
   */
  const handleVoiceListeningStart = useCallback((cursor: number) => {
    const opening = beginVoiceInsertion(inputValueRef.current, cursor);
    voiceInsertionRef.current = opening;
    // An empty interval at the caret: the overlay has nothing to paint yet, and the range's opening
    // point is where the next committed segment will appear.
    setVoiceRange({ start: opening.start, end: opening.end });
  }, []);

  /**
   * Places the committed voice text.
   *
   * The continuous path hands over the whole committed dictation so far on every commit, and it is
   * written into the tracked range as a replacement rather than appended to the end of the box: the
   * range is where the listen began, which is not necessarily the end of the draft. Without an open
   * range — a caller that never signalled a listen start, or the single-shot shape before this
   * feature — the text is appended the way it always was.
   *
   * `send` submits once, after the text is in place. Mirror the value into inputValueRef
   * synchronously so handleSubmit reads the new text, not the stale state.
   */
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const range = voiceInsertionRef.current;
    let next: string;
    if (range) {
      next = range.text.slice(0, range.start) + text + range.text.slice(range.end);
      voiceInsertionRef.current = { text: next, start: range.start, end: range.start + text.length };
      setVoiceRange({ start: range.start, end: range.start + text.length });
    } else {
      const base = inputValueRef.current.trim();
      next = base ? `${base} ${text}` : text;
      // The append shape has no tracked interval, but the appended words are still this listen's
      // text, so the overlay highlights the tail it just wrote rather than nothing.
      setVoiceRange({ start: base ? base.length + 1 : 0, end: next.length });
    }
    setInput(next);
    inputValueRef.current = next;
    if (send) {
      // The listen is over once it is sent; the next one opens a fresh range at the new caret.
      voiceInsertionRef.current = null;
      setVoiceRange(null);
      handleSubmitRef.current?.(createFakeSubmitEvent());
    }
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  // Persist the queued draft under its session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDraft` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) {
      return;
    }
    if (
      queuedDraft
      && (queuedDraft.content.trim() || (queuedDraft.uploadedAttachments?.length ?? 0) > 0)
    ) {
      writeQueuedMessage(sessionKey, {
        content: queuedDraft.content,
        options: queuedDraft.options,
        attachments: queuedDraft.uploadedAttachments,
      });
    } else {
      clearQueuedMessage(sessionKey);
    }
  }, [queuedDraft, sessionKey]);

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      // Carry the voice insertion range through the edit before it lands in state. The range tracks
      // the draft it was opened against, so an edit that does not match it (a programmatic change
      // through some other path) drops the range rather than shifting it to the wrong place.
      const range = voiceInsertionRef.current;
      if (range) {
        const remapped = range.text === inputValueRef.current
          ? applyVoiceChange(range, newValue)
          : null;
        voiceInsertionRef.current = remapped;
        // The same value the ref now holds: an edit inside the committed words moves the highlight
        // with them, and an edit that invalidated the range drops it from the overlay too.
        setVoiceRange(remapped === null ? null : { start: remapped.start, end: remapped.end });
      }

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
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  // Resolved here rather than from the raw preference: on a touch-only device Enter inserts a
  // newline regardless of what the stored preference says, because a soft keyboard has no
  // Shift key to offer as the newline alternative.
  const { sendOnEnter } = useSendOnEnter(sendByCtrlEnter);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        const endedJustNow =
          performance.now() - lastCompositionEndAtRef.current < SAFARI_IME_RACE_WINDOW_MS;
        if (event.nativeEvent.isComposing || isComposingRef.current || endedJustNow) {
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
      handleHistoryKeyDown,
      sendOnEnter,
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

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

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

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [setInput]);

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
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
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
