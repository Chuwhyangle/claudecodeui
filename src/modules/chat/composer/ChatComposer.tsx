import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { PaperclipIcon, AudioLinesIcon, MessageSquareIcon, XIcon, Loader2, ArrowUpIcon, PencilIcon, Lock, Copy, Check, Sparkles, CircleAlert } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useActivityFreshness } from '@/modules/chat/hooks/useActivityFreshness';
import { useVoiceInput, type VoiceCaptureEngine } from '@/modules/chat/hooks/useVoiceInput';
import { useVoiceAvailable } from '@/modules/chat/hooks/useVoiceAvailable';
import { useSendOnEnter } from '@/modules/chat/hooks/useSendOnEnter';
import { useComposerCompactTier } from '@/modules/chat/hooks/useComposerCompactTier';
import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { findSessionHostState, findSessionOccupancy, useSessionHosts } from '@/shared/hooks/useSessionHosts';
import { loadProjectIdentifiers } from '@/shared/projectIdentifiers';
import { isVoiceDebugEnabled } from '@/shared/voiceDebug';
import type { ChatMessage, QueuedDraft, ScheduledMessage, SlashCommand,SessionActivity,PendingPermissionRequest,PermissionMode,ProviderModelOption,VoiceFailureReport } from '@/shared/types';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '@/modules/chat/composer/PromptInput';
import CommandMenu from '@/modules/chat/composer/CommandMenu';
import { deriveActivityDockView } from '@/modules/chat/utils/voice/activityDockView';
import type { VoiceInsertion } from '@/modules/chat/utils/voice/voiceInsertion';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import VoiceInputButton, { VoiceFailureNotice } from '@/modules/chat/composer/VoiceInputButton';
import VoiceUploadButton from '@/modules/chat/composer/VoiceUploadButton';
import VoiceClipButton from '@/modules/chat/composer/VoiceClipButton';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import { ScheduleMessagePopover } from '@/modules/chat/composer/ScheduleMessagePopover';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';
import ComposerMobileMoreMenu from '@/modules/chat/composer/ComposerMobileMoreMenu';
import { InputSuggestionChips } from '@/modules/chat/composer/InputSuggestionChips';
import ReplyReferencePreview from '@/modules/chat/composer/ReplyReferencePreview';
import { suggestionOptionId, truncateSuggestionLabel } from '@/modules/chat/utils/inputSuggestions';
import type { SuggestionChip } from '@/modules/chat/utils/inputSuggestions';
import type { ReplyItem, ReplyReference } from '@/modules/chat/utils/transcript/replyItems';

/** How long the occupied notice's copy control says "copied" before returning to its label. */
const RELEASE_COPIED_NOTICE_MS = 1500;

/** How long a tap on an unavailable Live Voice entry leaves its explanation on screen. */
const LIVE_VOICE_NOTICE_MS = 4000;

/** How long a failed Suggest draw keeps its visible failure reading before recovering. */
const REPLY_SUGGEST_FAILURE_DISPLAY_MS = 3000;

/**
 * The row a non-empty box reserves under the chip strip.
 *
 * The strip is an absolute overlay (`top-0`, `py-2`) holding 24px chips, and the
 * preview line below them ends at 44px. A 48px flow spacer (`h-12`) starts the
 * textarea below both. A spacer rather than textarea padding: the textarea's
 * auto-grow height is computed from `scrollHeight` when its value changes, which
 * is BEFORE this state's class lands — padding applied after that measurement
 * left the box too short and the browser scrolled the text back under the strip.
 * The overlay gets the same 48px (`pt-12`) so a dictation wash stays on the words
 * it covers. Both are applied only while text is present; the empty-box layout,
 * which the strip was designed for, keeps its original padding.
 */
const CHIP_ROW_CLEARANCE_SPACER_CLASS = 'h-12';
const CHIP_ROW_CLEARANCE_PADDING_CLASS = 'pt-12';

/**
 * The viewport width, in CSS pixels, below which the compact footer drops the clear control.
 *
 * The compact row is exactly the controls that send a message plus the clear ✕ while there is
 * a draft; a box narrower than this is already at its horizontal edge (the tool buttons shrink
 * to `w-7` below 360px for the same reason), and a seventh control there would push the send
 * button out rather than fit beside it.
 */
const NARROWEST_FOOTER_VIEWPORT_PX = 360;

type MentionableFile = {
  name: string;
  path: string;
};

/**
 * Hands a node to a ref, whichever of React's shapes it is.
 *
 * Needed because two refs have to reach the same element: the composer's box is measured by
 * `useComposerCompactTier`, and the form it sits on already carries react-dropzone's root ref —
 * spread onto the form as part of `getRootProps()`, where a plain `ref=` beside the spread would be
 * replaced by it. One callback ref can serve both, but it has to write to a ref it did not create,
 * and a ref of unknown shape is either a function or an object with `current`.
 */
const assignRef = <T,>(ref: unknown, node: T | null) => {
  if (typeof ref === 'function') {
    (ref as (value: T | null) => void)(node);
  } else if (ref && typeof ref === 'object') {
    (ref as { current: T | null }).current = node;
  }
};

type ChatComposerProps = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  activity: SessionActivity | null;
  /** True when the last send was never delivered; the dock reports it instead of a turn. */
  sendFailed?: boolean;
  isLoading: boolean;
  onAbortSession: () => void;
  permissionMode: PermissionMode;
  availablePermissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  providerLabel: string;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  model: string;
  availableModelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  queuedDraft: QueuedDraft | null;
  /** Set while the composer is replacing an already-sent message. */
  isEditingSentMessage: boolean;
  onCancelEditMessage: () => void;
  /** Messages waiting to be sent to this session later. */
  scheduledMessages: ScheduledMessage[];
  onScheduleMessage: (scheduledFor: Date) => void;
  onCancelScheduledMessage: (id: string) => void;
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  attachedFiles: File[];
  onRemoveAttachment: (index: number) => void;
  fileErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openAttachmentPicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  /**
   * Called with the caret when a listen starts, so the state layer opens the tracked insertion range
   * where the dictation will be committed. Optional: a caller that does not own the draft (a
   * standalone render) leaves it out and the transcript is appended to the end instead.
   */
  onVoiceListeningStart?: (cursor: number) => void;
  /**
   * The interval of the box that the open listen's committed text occupies, or null.
   *
   * Handed back by the state layer that tracks the insertion range, because the overlay paints the
   * provisional background from it. A listen that has committed nothing yet reports an empty interval
   * at the caret; absent (a standalone render) means no highlight.
   */
  voiceRange?: Pick<VoiceInsertion, 'start' | 'end'> | null;
  /**
   * Enters Live Voice (continuous audio to the Realtime model). A separate control from the
   * dictation mic: it never goes through `onVoiceTranscript` or the draft. Absent hides the button.
   */
  onLiveVoice?: () => void;
  /**
   * True while Live Voice cannot start for this conversation (there is no session id to bind
   * the voice connection to yet).
   *
   * The button stays *tappable* in this state and answers the tap with `liveVoiceDisabledReason`:
   * a native `disabled` control takes `pointer-events: none`, so on a touch device the tap never
   * reaches it and produces no feedback whatsoever — which reads as a broken button rather than
   * as a precondition the reader could satisfy. `aria-disabled` carries the same state to
   * assistive tech without swallowing the event.
   */
  liveVoiceDisabled?: boolean;
  /** Why Live Voice cannot start, shown in place of a silent no-op when it is tapped. */
  liveVoiceDisabledReason?: string;
  /**
   * Overrides where a listen's audio comes from.
   *
   * Absent in the app, which uses the shipping `AudioWorklet` engine. A test supplies one so it can
   * push 20 ms PCM frames without a browser audio thread or a microphone — jsdom has neither.
   */
  voiceCaptureEngine?: VoiceCaptureEngine;
  /** Draft scope of the open chat; a change drops the recorded clip, which belongs to the chat it was recorded in. */
  scope: string | null;
  /**
   * The session transcript the relay-mode context pack is built from.
   *
   * The same rows Live Voice receives, handed in by the pane that renders them. Optional so the
   * standalone renders used by tests keep working; absent means a relay upload carries no context.
   */
  contextMessages?: readonly ChatMessage[];
  /**
   * The open project, whose file tree supplies the names a transcript gets repaired against.
   * Required rather than optional so a caller that forgets it is a type error instead of a
   * silently repair-less composer; `null` is the honest "no project open" value.
   */
  projectId: string | null;
  /** False while the composer is off screen (another workspace tab): it then stops audio it can no longer offer a control for. */
  isActive: boolean;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  /**
   * The session this composer is writing into, or null when none is open yet.
   * Used to read the session's stored residency, which decides what the stop
   * control says it is doing.
   *
   * Optional, and absent means "not resident": a caller that does not know which
   * session is open cannot claim the stop button leaves a process behind, and the
   * plain label is the one that promises nothing. Only the app's single live
   * caller ever knows the id; the rest of the value's readers are tests that
   * render this component standalone.
   */
  sessionId?: string | null;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  /**
   * Ranked empty-box suggestion labels from `useInputSuggestions`. Optional so
   * the standalone renders in tests keep working; absent means "no chips".
   */
  inputSuggestionCandidates?: string[];
  /**
   * True only while every display condition holds (empty box, idle assistant, no
   * menu, no queued draft or attachment, not occupied, not hidden this round).
   * The candidates may be non-empty while this is false — the box just has text.
   */
  inputSuggestionsVisible?: boolean;
  /** The chip the keyboard is on, or null. Mirrored into aria-activedescendant. */
  selectedInputSuggestionIndex?: number | null;
  /** Listbox id from the state hook; also prefixes each option id. */
  inputSuggestionListId?: string;
  /** Fills the draft with the chip's text; accepts a habit chip by index. */
  onAcceptInputSuggestion?: (index: number) => void;
  /**
   * The merged strip (quoted > model > habit) when the LLM tier is wired. Absent means the
   * standalone habit-only shape the existing renders use.
   */
  suggestionChips?: SuggestionChip[];
  /** Accepts a model chip: fills the draft and sends it. */
  onAcceptModelSuggestion?: (index: number) => void;
  /** Accepts the quoted chip: fills `> text` and focuses, without sending. */
  onAcceptQuotedSuggestion?: (text: string) => void;
  /** Whether the reply-suggestions feature is on; false hides the Suggest button entirely. */
  replySuggestionsEnabled?: boolean;
  /** A draw is in flight: the Suggest button is disabled and shows its progress label. */
  replySuggestionsLoading?: boolean;
  /**
   * Asks for a whole new batch of model chips. A promise that resolves false (or
   * rejects) is a failed draw: the control shows a short failure state instead of
   * appearing to have done nothing.
   */
  onRequestReplySuggestions?: () => void | Promise<boolean>;
  /**
   * The expansion experiment's variant/response chips for the draft in the box.
   * Drawn as their own row under the textarea (the empty-box strip cannot carry
   * them: they appear AFTER a chip has filled the body).
   */
  replyExpansionChips?: string[];
  /** Accepts one variant/response chip: replaces the body, keeping a `> quote` prefix. */
  onAcceptReplyExpansionChip?: (index: number) => void;
  /**
   * What the draft currently points at in the latest assistant reply, if
   * anything. Drawn as one line above the input box; `none` draws nothing.
   */
  replyReference?: ReplyReference | null;
  /** The latest reply's extracted items, supplying the preview's excerpts. */
  replyItems?: readonly ReplyItem[];
};

/**
 * Rendered by chat's ChatInterface as the whole input area: textarea, pending
 * attachments, queued message, permission banner, voice input and the
 * model/permission popovers that drive the next turn.
 */
export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  activity,
  sendFailed = false,
  isLoading,
  onAbortSession,
  permissionMode,
  availablePermissionModes,
  onSelectPermissionMode,
  providerLabel,
  effort,
  availableEffortOptions,
  onSelectEffort,
  model,
  availableModelOptions,
  onSelectModel,
  modelsLoading,
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  queuedDraft,
  isEditingSentMessage,
  onCancelEditMessage,
  scheduledMessages,
  onScheduleMessage,
  onCancelScheduledMessage,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  attachedFiles,
  onRemoveAttachment,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openAttachmentPicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  onVoiceListeningStart,
  voiceRange,
  onLiveVoice,
  liveVoiceDisabled,
  liveVoiceDisabledReason,
  voiceCaptureEngine,
  scope,
  projectId,
  isActive,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  sessionId = null,
  contextMessages,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  inputSuggestionCandidates = [],
  inputSuggestionsVisible = false,
  selectedInputSuggestionIndex = null,
  inputSuggestionListId = '',
  onAcceptInputSuggestion,
  suggestionChips,
  onAcceptModelSuggestion,
  onAcceptQuotedSuggestion,
  replySuggestionsEnabled = false,
  replySuggestionsLoading = false,
  onRequestReplySuggestions,
  replyExpansionChips = [],
  onAcceptReplyExpansionChip,
  replyReference = null,
  replyItems = [],
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  /*
   * Whether the session this composer writes into is stored `resident`.
   *
   * The stop control does the same thing either way — it interrupts the turn in
   * flight, and it has no path that closes a process — but in a resident session
   * that is a promise the label has to make explicitly: the process and its
   * scheduled work outlive the turn, and a reader who cannot see that would
   * reasonably expect the stop button to end them. §15.4 puts the destructive
   * close in the status bar's popover and the session menu for exactly that
   * reason, and there is deliberately no second one here.
   */
  const { snapshot: hostsSnapshot } = useSessionHosts();
  const isResidentSession = sessionId
    ? findSessionHostState(hostsSnapshot, sessionId)?.lifecycleMode === 'resident'
    : false;
  /*
   * The Claude Code background job holding this conversation, if any.
   *
   * The conversation is not this app's to resume while the job runs: the CLI
   * exits 1 on a resume it cannot honour and says so only on stderr, which this
   * app drops, so the alternative to this state is a send that fails with
   * `Resident process exited (error)` after the user has typed. Read-only, and
   * read-only for as long as the job lives — the poll below picks the release up
   * without a reload, so nothing here is latched.
   *
   * The same reading gates the send path (`useChatComposerState`), which is what
   * makes this a state rather than a painted-over control: a disabled textarea
   * is a hint, and a form can be submitted from a script or a stale handler even
   * while its input is disabled.
   */
  const occupiedBy = findSessionOccupancy(hostsSnapshot, sessionId);
  const isOccupied = occupiedBy !== null;
  /** The command that frees the conversation, shown verbatim so it can be copied or typed. */
  const releaseCommand = occupiedBy ? `claude stop ${occupiedBy.jobId}` : '';
  const [copiedReleaseCommand, setCopiedReleaseCommand] = useState(false);

  /**
   * Puts the release command on the clipboard, and says so for a moment.
   *
   * The command is on screen as text as well, so a refused clipboard — an
   * insecure origin, a browser policy, jsdom — costs the user nothing: it is
   * still selectable. That is why the failure is swallowed rather than turned
   * into a second notice beside the one already explaining the state.
   */
  const copyReleaseCommand = useCallback(async (): Promise<void> => {
    if (!releaseCommand) {
      return;
    }
    try {
      await navigator.clipboard.writeText(releaseCommand);
      setCopiedReleaseCommand(true);
      window.setTimeout(() => setCopiedReleaseCommand(false), RELEASE_COPIED_NOTICE_MS);
    } catch {
      // See above: nothing to report, and the command remains visible.
    }
  }, [releaseCommand]);
  // Same resolution the keydown uses, so the hint below cannot describe a key that does
  // something else on this device.
  const { sendOnEnter, touchOnly } = useSendOnEnter(sendByCtrlEnter);
  // The window rule for the shell's bottom padding on a short touch viewport. The
  // status surface used to read `isMobile` beside it to decide which side of the
  // composer hung the tab; the pane's in-flow line is the only surface now, so the
  // width half has no reader here.
  const { isShortTouchViewport } = useDeviceSettings();
  // Drives the footer's layout branch below, and the replay row with it. Narrower than the desktop
  // arrangement needs is what it means, and the box can be that narrow inside a window that is not:
  // `md` (768px) is a rule of its own — the `sm` (640px) boundary this group used to switch on gave
  // the 640–767px band a third arrangement — but it is not the only signal, because the sidebar
  // takes 288px and more out of the box while the window stays wide. See the hook for the width.
  //
  // `areToolsInline` is the height tier's answer: a viewport too short to spend a row on the
  // controls, inside a box wide enough to hold them beside the input instead. It follows the box's
  // measurement, so it is false on the first render and in any environment that cannot measure —
  // see the hook for why that is the safe direction to be wrong in.
  const { containerRef, isCompactTier, areToolsInline } = useComposerCompactTier();
  // Whether the viewport is too narrow for the compact row's clear control. State read
  // from the window and followed on resize: the 360px crossing is narrower than the
  // compact-tier signal, so a rotation or a window drag can cross it without changing
  // `isCompactTier`.
  const [isNarrowestFooter, setIsNarrowestFooter] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < NARROWEST_FOOTER_VIEWPORT_PX,
  );
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const read = () => setIsNarrowestFooter(window.innerWidth < NARROWEST_FOOTER_VIEWPORT_PX);
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  // The dropzone's own root ref comes back out of its root props and is re-attached beside the
  // tier hook's: the props are spread onto the form, so a `ref=` written next to the spread is
  // silently replaced by the one inside it — which is how this hook's box went unmeasured. Both
  // refs want the same element, and both are load-bearing (the dropzone's reaches its
  // document-level containment checks), so the node is handed to them from one callback.
  const { ref: dropzoneFormRef, ...dropzoneFormProps } = getRootProps();
  const attachForm = useCallback((node: HTMLFormElement | null) => {
    containerRef.current = node;
    assignRef(dropzoneFormRef, node);
  }, [containerRef, dropzoneFormRef]);
  const fileDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedFileRef = useRef<HTMLDivElement | null>(null);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  useEffect(() => {
    const dropdown = fileDropdownRef.current;
    const selectedFile = selectedFileRef.current;
    if (!showFileDropdown || !dropdown || !selectedFile) {
      return;
    }

    const itemTop = selectedFile.offsetTop;
    const itemBottom = itemTop + selectedFile.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedFileIndex, showFileDropdown]);

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  // The last voice failure, held as the REPORT the chain produced rather than as a sentence: which
  // sentence a refusal gets is the user's language's answer, and this component does not know the
  // language any better than the button that renders it — both read the same translator.
  //
  // It stays until the user dismisses it or starts the next recording. The four-second timer that used
  // to clear it was the defect this surface was filed for: a notice that disappears on its own takes
  // the one thing the user needs — the sentence, and the codes behind it — away while they are still
  // reading it.
  const [voiceFailure, setVoiceFailure] = useState<VoiceFailureReport | null>(null);
  const handleVoiceError = useCallback((failure: VoiceFailureReport) => {
    setVoiceFailure(failure);
  }, []);

  /** The explanation a tap on an unavailable Live Voice entry produced, cleared on a timer. */
  const [liveVoiceNotice, setLiveVoiceNotice] = useState<string | null>(null);

  // What the entry says when it cannot start: the caller's reason, or a generic fallback when it
  // passed none. Derived rather than stored so the tap handler and the button's tooltip cannot
  // drift apart.
  const liveVoiceUnavailableNotice =
    liveVoiceDisabledReason ?? t('voice.realtime.unavailable', { defaultValue: 'Live Voice is unavailable right now.' });

  // The notice is a reply to one tap, not a standing banner: it clears itself so the composer
  // returns to its resting shape without the reader having to dismiss anything. Nothing is lost
  // by the timer — unlike the voice-failure notice above, which carries codes the reader may need
  // to report, this one is one repeatable sentence, and a second tap brings it straight back.
  useEffect(() => {
    if (!liveVoiceNotice) {
      return;
    }
    const timer = setTimeout(() => setLiveVoiceNotice(null), LIVE_VOICE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [liveVoiceNotice]);

  // A failed Suggest draw must not look like a press that did nothing: the control
  // switches to a failure reading for a few seconds, then recovers. The ref holds
  // the one timer so a second press supersedes the mark instead of stacking timers.
  const [replySuggestFailed, setReplySuggestFailed] = useState(false);
  const replySuggestFailureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (replySuggestFailureTimer.current !== null) {
      clearTimeout(replySuggestFailureTimer.current);
      replySuggestFailureTimer.current = null;
    }
  }, []);
  const requestReplySuggestions = useCallback(async () => {
    if (!onRequestReplySuggestions) {
      return;
    }
    if (replySuggestFailureTimer.current !== null) {
      clearTimeout(replySuggestFailureTimer.current);
      replySuggestFailureTimer.current = null;
    }
    setReplySuggestFailed(false);
    let succeeded = true;
    try {
      succeeded = (await onRequestReplySuggestions()) !== false;
    } catch {
      // A thrown request is a failed draw, not an error the composer should carry.
      succeeded = false;
    }
    if (succeeded) {
      return;
    }
    setReplySuggestFailed(true);
    replySuggestFailureTimer.current = setTimeout(() => {
      replySuggestFailureTimer.current = null;
      setReplySuggestFailed(false);
    }, REPLY_SUGGEST_FAILURE_DISPLAY_MS);
  }, [onRequestReplySuggestions]);
  const dismissVoiceFailure = useCallback(() => setVoiceFailure(null), []);
  const noopTranscript = useCallback(() => {}, []);
  // The names the transcript is repaired against. Fetched once per project (the module
  // memoises the request) and held as state so the repair sees the list on the next
  // dictation rather than on the next render. A project whose tree cannot be listed
  // resolves to `[]`, which the hook treats as "repair nothing".
  const [identifierCandidates, setIdentifierCandidates] = useState<readonly string[]>([]);
  useEffect(() => {
    let current = true;
    void loadProjectIdentifiers(projectId).then((names) => {
      if (current) setIdentifierCandidates(names);
    });
    return () => {
      current = false;
    };
  }, [projectId]);
  // The question panel replaces the whole footer, so a clip playing behind it would have
  // no visible control to stop it; folding it into `isActive` reuses the same stop path
  // rather than adding a second effect for the same rule.
  const {
    state: voiceState,
    inFlight: voiceInFlight,
    toggle: voiceToggle,
    stop: voiceStop,
    transcribeFile,
    clipSlot,
    clipPlayState,
    toggleClipPlayback,
    writeSentLabels,
  } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
    {
      scope,
      isActive: isActive && !hasQuestionPanel,
      candidates: identifierCandidates,
      captureEngine: voiceCaptureEngine,
      contextMessages,
    },
  );
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';
  /*
   * The slice of the box the open listen has committed into — painted, never edited.
   *
   * ONLY WHILE A LISTEN OWNS IT. The interval is where the dictation lands, so its background says
   * "these words came from the microphone and are still being written". Once the listen is over they
   * are the user's ordinary editable text, and a highlight that outlived the listen would claim the
   * composer still owns a range it no longer tracks.
   *
   * CLAMPED TO THE BOX, because the state layer and this render can be one commit apart and the
   * textarea is the single source of what the draft currently is: a range that no longer lies inside
   * it paints nothing rather than slicing past the end of the text.
   */
  const provisionalVoiceRange = voiceState !== 'idle'
    && voiceRange
    && voiceRange.start < voiceRange.end
    && voiceRange.end <= input.length
    ? voiceRange
    : null;
  // Starting the next recording is the user answering the last failure, so it dismisses the notice.
  // Wrapped here rather than inside the button because the failing attempt's message is the
  // composer's state: the button renders what it is handed and owns no memory of the last failure.
  const handleVoiceToggle = useCallback(() => {
    setVoiceFailure(null);
    // A press that starts a listen fixes where the dictation will be committed: the caret as it is
    // now. Signalled before the hook switches to recording, so the range is open before the first
    // segment can land. A press that stops needs no signal — the range is already open.
    if (voiceState === 'idle') {
      const cursor = textareaRef.current?.selectionStart ?? input.length;
      onVoiceListeningStart?.(cursor);
      // The box as it stands is this listen's context: the recogniser is told what the caret is in
      // the middle of, which is what a spoken 「这段」 points at. Read here rather than inside the
      // hook because only this render has the text and only this moment has the caret.
      voiceToggle({ text: input, cursor });
      return;
    }
    voiceToggle();
  }, [voiceToggle, voiceState, onVoiceListeningStart, textareaRef, input]);

  // The composer's stop entry reads the same liveness the dock does: a greyed
  // submit and a greyed dock control are one story about one unreachable server,
  // not two. `isLoading` alone would leave the submit live while the dock said
  // the connection was gone.
  const freshness = useActivityFreshness(sessionId);
  const composerDock = deriveActivityDockView({
    activity,
    liveness: freshness.liveness,
    elapsedMs: freshness.elapsedMs,
    hasTurnAnchor: freshness.hasTurnAnchor,
    wired: freshness.wired,
    hasAbort: true,
    sendFailed,
  });
  const stopUnreachable = composerDock.state === 'unreachable';
  const stopUnreachableReason = composerDock.stopReasonKey === null
    ? null
    : t(composerDock.stopReasonKey, { defaultValue: 'Stop is unavailable while the server is unreachable' });

  const hasQueuedDraft = Boolean(queuedDraft);
  // The chips occupy the textarea's one empty line. While they are on screen the
  // placeholder is blank so the two are not drawn over each other; the chips
  // themselves are absolutely positioned and add no row.
  // The merged strip when the caller wires it, otherwise the original habit-only list. The
  // difference is what lets the composer render quoted and model chips without a second
  // component: one listbox, three sources.
  const resolvedSuggestionCount = suggestionChips?.length ?? inputSuggestionCandidates.length;
  const showSuggestionChips = inputSuggestionsVisible && resolvedSuggestionCount > 0;
  // The strip overlays the box. It only needs clearance while the box holds text:
  // the quoted chip is the one chip allowed then, and without room made for the
  // row it covers the first line of the quote. The empty-box layout is unchanged.
  const chipRowOverText = showSuggestionChips && input !== '';
  const canQueueDraft = isLoading && Boolean(input.trim() || attachedFiles.length > 0);
  // The same button press, two different outcomes. For a per-run session the text waits in this
  // client's queue until the turn ends, which is why the button becomes a queue arrow and the hint
  // says so. For a resident session nothing waits — the process takes the message while its answer
  // is still being written — so the button is the same one that sends, and the words around it have
  // to say "send" rather than "queue" or they would be describing a wait that is not happening.
  const busySendGoesToProcess = canQueueDraft && isResidentSession;
  // The one entry into the composer's submit. The send button is a `type="submit"` control, so a click
  // and an Enter key press both arrive here as the form's own `submit` event; the key path is routed to
  // the form rather than given a send of its own (see `useChatComposerState`'s keydown). The resident
  // switch is not read here: it now lives only on the new-session empty state, and `ChatInterface`
  // passes its position to the send path directly, so the composer neither records nor forwards it.
  const handleComposerSubmit = useCallback((event: Parameters<typeof onSubmit>[0]) => {
    event.preventDefault();
    // THE WEAK LABEL IS TAKEN HERE, at the one moment both halves of it exist: `input` is what the
    // user is sending and the listen holds what the recogniser produced for the same words. It is
    // fired BEFORE the send and never awaited — the label is a side channel, and the message going
    // out is not conditional on it. A draft that was never dictated has no listen to compare
    // against, so this is a no-op for it.
    writeSentLabels(input);
    onSubmit(event);
  }, [input, onSubmit, writeSentLabels]);
  // Every sentence this hint can print names a keyboard key — Enter, Shift+Enter, Ctrl+Enter — and a
  // soft keyboard has none of them, so there is no wording that would be true on a touch-only device.
  // Such a device is given no hint at all rather than the wrong one: the button is the only way out
  // (the queued state included, where the button has become the queue arrow), and tapping it is the
  // universal convention, so the sentence would be describing what the user already assumes.
  const submitHint = canQueueDraft && !busySendGoesToProcess
    ? hasQueuedDraft
      ? t('input.hintText.updateQueued', { defaultValue: 'Enter to update queued message' })
      : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
    : sendOnEnter
      ? t('input.hintText.enter')
      : t('input.hintText.ctrlEnter');
  // The send button doubles as the Live Voice entry while the draft is empty (the ChatGPT pattern):
  // an empty composer has nothing to send, so the button that would be a disabled send becomes the
  // one control that starts a voice conversation. The dictation mic sits beside it for "dictate into
  // the draft" and is unaffected. Every busier tier above this one (loading / recording / transcribing
  // / queueing) is checked first and wins, and a session held by a background job is not offered
  // Live Voice either — the composer is read-only there, and the occupied notice explains why.
  const submitIsVoice = Boolean(
    onLiveVoice
      && !isLoading
      && !isRecording
      && !isTranscribing
      && !isOccupied
      && input.trim() === ''
      && attachedFiles.length === 0,
  );

  const submitAriaLabel = submitIsVoice
    ? t('voice.realtime.enter', { defaultValue: 'Start Live Voice' })
    : canQueueDraft
      ? busySendGoesToProcess
        ? t('input.send')
        : hasQueuedDraft
          ? t('input.queue.update', { defaultValue: 'Update queued message' })
          : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
      : isLoading
        ? isResidentSession
          ? t('resident.stopResident')
          : t('input.stop')
        : t('input.send');
  // The Esc hint used to sit in the dock's own Stop control. With that control gone
  // the global Escape listener's key is named on the one stop entry that remains —
  // the composer's submit button — so the hint survives the tab's removal. While the
  // server is unreachable the reason replaces the plain hint, but the key is still
  // named: Escape is handled globally and keeps working when the button does not.
  const submitTitle = submitIsVoice
    ? liveVoiceDisabled
      ? liveVoiceUnavailableNotice
      : submitAriaLabel
    : isLoading && !canQueueDraft
      ? stopUnreachable
        ? `${submitAriaLabel} (Esc) — ${stopUnreachableReason ?? ''}`.trim()
        : `${submitAriaLabel} (Esc)`
      : submitAriaLabel;

  // The replay pair's own row, drawn on the compact tier only — the wide tier keeps the pair in the
  // tools group. Held as a value rather than written inline because the inline-tools tier mounts it
  // in a different column: under the textarea instead of after the box. One renderer that moves is
  // what keeps exactly one set of replay controls on screen, and therefore exactly one set in the
  // accessibility tree, at every width and every height.
  const clipRow = clipSlot && isCompactTier ? (
    <div
      data-slot="prompt-input-clip-row"
      className="flex flex-wrap items-center gap-1 px-3 py-0.5"
    >
      <VoiceClipButton clips={clipSlot} state={clipPlayState} onToggle={toggleClipPlayback} />
    </div>
  ) : null;

  return (
    <div
      className={[
        'chat-composer-shell relative flex-shrink-0 pt-0',
        // `md:pb-6` is 24px of empty space under the input. On a 900px-tall desktop that is
        // invisible; on a 330px-tall landscape viewport it is 7% of the screen spent on nothing, so
        // the short tier takes the compact padding instead. The branch replaces the other rather
        // than layering on it, so no cascade order is being relied on.
        isShortTouchViewport ? 'px-2 pb-1.5' : 'px-2 pb-2 sm:px-4 sm:pb-4 md:px-4 md:pb-6',
      ].join(' ')}
    >
      {/*
        The failure notice, drawn from the shell rather than from inside the mic button that raised it.

        The mic lives in the form's footer, and the form is `relative overflow-hidden` so the textarea's
        highlight layer can be clipped to its rounded corners — a notice anchored to the button and drawn
        above it therefore leaves the form's box and is clipped, which puts its close control out of a
        pointer's reach. This layer is a sibling of the form for the same reason the activity indicator
        above is one, and `VoiceFailureNotice` carries the reading that made the placement necessary.
      */}
      {voiceFailure !== null && (
        <VoiceFailureNotice failure={voiceFailure} onDismiss={dismissVoiceFailure} />
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      <ScheduledMessageList
        scheduledMessages={scheduledMessages}
        onCancel={onCancelScheduledMessage}
      />

      {isEditingSentMessage && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
          <PencilIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            {t('composer.editing.title')}
            {' — '}
            <span className="text-muted-foreground">{t('composer.editing.filesNotReverted')}</span>
          </span>
          <button
            type="button"
            onClick={onCancelEditMessage}
            className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('composer.editing.cancel')}
          </button>
        </div>
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          attachmentCount={
            queuedDraft.uploadedAttachments?.length ?? queuedDraft.attachments.length
          }
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
        />
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-[54.25rem]">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div
            ref={fileDropdownRef}
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md"
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                ref={index === selectedFileIndex ? selectedFileRef : undefined}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        {/*
          Why this conversation is read-only, and the one command that changes that.

          A conversation a Claude Code background job is running cannot be resumed:
          the CLI exits 1 and says so only on stderr, which this app drops, so the
          send path would report `Resident process exited (error)` after the user
          had already typed. Saying it here, before anything is typed, is the whole
          point — the composer is disabled and this is the reason, not a refusal
          that arrives once the user has committed to a message.

          The command is drawn as text beside the sentence, not only inside it: the
          sentence is translated and the command is not, and a user who would rather
          type it than copy it needs it verbatim. `data-occupied-job-id` and
          `data-occupied-pid` publish the same two facts structurally, so a reader
          (or a criterion) can compare them with the listing that produced them
          without parsing copy.

          It disappears with `occupiedBy`: the poll behind `useSessionHosts` re-reads
          the listing every second, so the moment the job is stopped this notice, the
          disabled input and the status bar's Start button all come back together —
          no reload, and no local "dismissed" flag that could outlive the state it
          describes.
        */}
        {occupiedBy && (
          <div
            data-slot="occupied-session-notice"
            data-occupied-job-id={occupiedBy.jobId}
            data-occupied-pid={occupiedBy.pid}
            className="mx-auto mb-2 flex max-w-[54.25rem] flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
          >
            <Lock className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span data-occupied-notice-text="true" className="min-w-0 flex-1">
              {t('resident.occupied.notice', { jobId: occupiedBy.jobId, pid: occupiedBy.pid })}
            </span>
            <code
              data-occupied-release-command="true"
              className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]"
            >
              {releaseCommand}
            </code>
            <button
              type="button"
              data-occupied-copy-command="true"
              onClick={() => void copyReleaseCommand()}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-2 py-1 font-medium transition-colors hover:bg-accent/60"
            >
              {copiedReleaseCommand ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copiedReleaseCommand
                ? t('resident.occupied.copied')
                : t('resident.occupied.copyCommand')}
            </button>
          </div>
        )}

        {replyReference && replyReference.kind !== 'none' && (
          <ReplyReferencePreview reference={replyReference} items={replyItems} />
        )}

        <PromptInput
          onSubmit={handleComposerSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={[
            isTextareaExpanded ? 'chat-input-expanded' : '',
            // Nothing hangs off the input's top edge any more — the status is the
            // pane's in-flow line — so the box keeps its own rounding at every
            // viewport.
            // The controls are drawn beside the input rather than under it: two tracks, the input's
            // taking the slack and the controls' sized by their own content, with `items-end` on
            // the input's last line — where a send button is looked for.
            //
            // A grid rather than a row, because not every child of this form is a column of it. The
            // attachment strip is a header that spans both tracks, and in a flex row it is simply the
            // first column: it took the width the input was meant to have (the input measured 0px)
            // and the controls sat where the input should have been. Wrapping was tried and is not
            // enough — a wrapping row decides its lines from the items' *content* sizes before it
            // shrinks anything, so a wide enough control cluster moved the input onto a line of its
            // own and the arrangement silently became the stacked one while still reporting
            // `display: flex`. A grid has no such arithmetic: the header spans both tracks (see
            // below) and the second row is the input and the controls whatever either of them
            // measures.
            areToolsInline ? 'grid grid-cols-[minmax(0,1fr)_auto] items-end' : '',
          ].filter(Boolean).join(' ')}
          {...dropzoneFormProps}
          ref={attachForm}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop files here</p>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <PromptInputHeader className={areToolsInline ? 'col-span-full pt-1' : undefined}>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <ComposerAttachment
                      key={`${file.name}-${file.lastModified}-${index}`}
                      file={file}
                      onRemove={() => onRemoveAttachment(index)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          {/*
            `min-w-0` is the load-bearing half: the track is already allowed to shrink
            (`minmax(0, 1fr)` on the form), but a grid item's own automatic minimum is its content,
            which would put the floor back. The body still stacks its own children — the textarea,
            and the replay row when the tier moves it in here.
          */}
          <PromptInputBody className={areToolsInline ? 'flex min-w-0 flex-col' : undefined}>
            {chipRowOverText && (
              // A flow row, not textarea padding: see CHIP_ROW_CLEARANCE_SPACER_CLASS.
              // It is what keeps the first line of a filled quote out from under the strip.
              <div
                data-slot="chip-row-clearance"
                aria-hidden="true"
                className={CHIP_ROW_CLEARANCE_SPACER_CLASS}
              />
            )}
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className={cn(
                'chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent',
                // Mirrors the spacer so a dictation wash lands on the words it covers.
                chipRowOverText && CHIP_ROW_CLEARANCE_PADDING_CLASS,
              )}>
                {/*
                  The overlay is the textarea's own text, drawn transparently, so it can carry a
                  background the textarea itself cannot. The provisional span splits it into the
                  user's own draft, the words this listen committed, and the draft after them — the
                  middle one gets the low-contrast wash, and `box-decoration-clone` keeps it on every
                  line a wrapped dictation covers.
                */}
                {provisionalVoiceRange ? (
                  <>
                    {renderInputWithMentions(input.slice(0, provisionalVoiceRange.start))}
                    <span
                      data-voice-provisional="true"
                      className="rounded-sm bg-primary/10 box-decoration-clone"
                    >
                      {input.slice(provisionalVoiceRange.start, provisionalVoiceRange.end)}
                    </span>
                    {renderInputWithMentions(input.slice(provisionalVoiceRange.end))}
                  </>
                ) : renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={showSuggestionChips ? '' : placeholder}
              aria-activedescendant={
                showSuggestionChips && selectedInputSuggestionIndex !== null
                  ? suggestionOptionId(inputSuggestionListId, selectedInputSuggestionIndex)
                  : undefined
              }
              // Tighter than the class cap while the controls share this row: the row's height is
              // the textarea's own, so a long draft would spend the transcript's budget to grow.
              // An inline style rather than another class because the class cap carries `sm:`,
              // and a variant sorts after a bare utility — a plain `max-h-*` would lose to it.
              // Only `maxHeight` is written here, so the `height` `resizeTextarea` sets on the
              // element is never touched by React's style diffing.
              style={areToolsInline ? { maxHeight: 'min(300px,30vh)' } : undefined}
              // Read-only while a Claude Code background job holds the
              // conversation: there is no turn this input could start, and the
              // notice above it says so. `disabled` rather than `readOnly`
              // because the state is not the user's draft to edit — nothing here
              // can be sent until the job is stopped.
              disabled={isOccupied}
            />
            {showSuggestionChips && (
              <InputSuggestionChips
                listId={inputSuggestionListId}
                suggestions={inputSuggestionCandidates}
                chips={suggestionChips}
                selectedIndex={selectedInputSuggestionIndex}
                onAccept={onAcceptInputSuggestion ?? (() => undefined)}
                onAcceptModel={onAcceptModelSuggestion}
                onAcceptQuoted={onAcceptQuotedSuggestion}
                // The strip's background sits over the textarea; a press there
                // must focus the input instead of being eaten by the listbox.
                onBackgroundPress={() => textareaRef.current?.focus()}
              />
            )}
            {/*
              The expansion experiment's chips. They appear only after a chip has
              filled the body, so they cannot use the empty-box strip above; this
              row sits AFTER the textarea in flow (never over it) and scrolls on
              one line at narrow widths, exactly like the other chips. A press
              neither moves the caret nor steals focus from the textarea.
            */}
            {replyExpansionChips.length > 0 && (
              <div
                data-slot="reply-expansion-chips"
                className="flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap px-4 pb-2 [scrollbar-width:none]"
              >
                {replyExpansionChips.map((text, index) => (
                  <button
                    key={`${index}:${text}`}
                    type="button"
                    data-expansion-chip-index={index}
                    title={text}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onAcceptReplyExpansionChip?.(index)}
                    className="h-6 shrink-0 rounded-full border border-dashed border-border/70 px-2 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
                  >
                    {truncateSuggestionLabel(text)}
                  </button>
                ))}
              </div>
            )}
            {/* Inline tier only: the row below is a sibling of this body, and the form is a row on
                that tier, so a sibling here would become a third column of its own. It moves into
                this column instead, under the textarea, where it costs the input height rather than
                a full-width row across the composer. */}
            {areToolsInline && clipRow}
        </PromptInputBody>

        {/*
          On the compact tier the replay pair gets a row of its own between the box and the footer.

          It has nowhere to live inside the compact footer — that row is exactly the six controls that
          send a message and may not wrap — so without this the arrival of a recording is what pushed
          the footer into a second line. The row exists only while `clipSlot` holds something (a clip
          only exists because the mic produced one), and it is the row that grows and shrinks: the
          footer's own height and position are the same with a recording as without one. It may wrap
          *between* its two tracks, which is the move the footer is forbidden, not this row.

          One renderer, not two: the pair is drawn here on the compact tier and in the tools group on
          the wide one, off the same `clipSlot`/`clipPlayState` the hook owns, so exactly one set of
          replay controls is ever on screen — and therefore exactly one set in the accessibility tree.
          The draw itself is the `clipRow` value above, which the inline-tools tier mounts inside the
          body instead of here.
        */}
        {!areToolsInline && clipRow}

        {/*
          On the compact tier the row must never wrap: the six controls that
          send a message stay reachable without hunting, so both groups are
          `shrink-0` and the box is `flex-nowrap`. On the wide tier the previous
          wrapping row is kept exactly as it was.

          On the wide tier the *left group* may take a second line of its own, which is
          what `flex-wrap` here buys. The box's own `flex-wrap` only decides where the
          two groups go; it cannot break a group, and a group whose children may not
          shrink (the replay pair declares `shrink-0`, and an icon button cannot go
          below its own icon) then pushes the box's content past its edge instead of
          moving down. Measured with the window at 768 and the sidebar open — the box
          445px wide — one recording's pair in this group read
          `scrollWidth 470 / clientWidth 445`: 25px of content the box would have
          scrolled sideways, invisible without a horizontal scroll gesture. That box is
          narrower than `COMPACT_TIER_WIDTH_PX`, so the compact tier now takes it and
          the wrap never arises; and because the same measurement decides the boxed-in
          wide window (a 1024px window with the sidebar open leaves a 701px box, at
          which the pair wrapped too), the arrangement follows the box rather than the
          window. Wrapping the group is still the move the wide tier makes if a box
          between the threshold and the crossing ever reaches it, and it leaves every
          reading that has no pair to fit on one line: a recording only ever arrives
          because the mic produced one, and the two groups' placement, the 93px height
          and the 1280 footer are unchanged without it.
        */}
        <PromptInputFooter
          className={[
            isCompactTier ? 'flex-nowrap' : 'flex-wrap gap-y-1',
            // Beside the input rather than under it: the divider moves from the top edge to the
            // leading edge and the vertical padding goes — the row it used to need was the whole
            // point of moving it. Its width is the grid's `auto` track, which is what the content
            // measures. These override the primitive's own `border-t`/`py-2`/`px-3`, which `cn`
            // inside `PromptInputFooter` resolves in this string's favour by putting it last.
            areToolsInline ? 'border-l border-t-0 py-0 pl-2 pr-1' : '',
          ].filter(Boolean).join(' ')}
        >
          <PromptInputTools
            // Six controls now share the compact row (attach and more on the left; model, permission,
            // the dictation mic and send on the right). Below 360px the long-model-name reading
            // overflows the box by a few px, so the tool buttons narrow by 4px each there (height
            // stays, so the row alignment holds); wider widths are untouched.
            className={isCompactTier ? 'shrink-0 max-[359px]:[&_button]:w-7' : 'min-w-0 flex-wrap'}
          >
            <PromptInputButton
              tooltip={{ content: t('input.attachFiles') }}
              onClick={openAttachmentPicker}
              aria-label={t('input.attachFiles')}
            >
              <PaperclipIcon />
            </PromptInputButton>

            {/*
              The Suggest button lives in the footer on purpose: it is the one control that
              regenerates the chips above the input, and it must stay reachable while the
              textarea is covered by them. It is drawn only when the feature is on AND there
              is an assistant message to draw from (`replySuggestionsEnabled` folds both in;
              a new conversation has nothing to suggest from), and is disabled for the whole
              draw, so a second click cannot become a second request.

              A failed draw is not silent: the control shows a failure reading for a few
              seconds (`data-reply-suggest-state="failed"`) and then returns to idle.

              On the compact tier it is an icon button, the same 32px square as the controls
              beside it. The labelled version was 61px — twice an icon button — and with a
              draft's clear ✕ beside it the row's budget broke at 360 and 375px: 360px read
              `scrollWidth 368 / clientWidth 342` and the send button's right edge landed 25px
              past the form's. The accessible name and the tooltip keep the "Suggest" reading,
              and the in-flight state keeps its spinner + `aria-busy`, so dropping the visible
              text loses no state. The wide tier keeps the labelled button unchanged: it has
              the width to spend.
            */}
            {replySuggestionsEnabled && (isCompactTier ? (
              <PromptInputButton
                data-slot="reply-suggest-button"
                data-reply-suggest-state={replySuggestFailed ? 'failed' : replySuggestionsLoading ? 'loading' : 'idle'}
                tooltip={{
                  content: replySuggestFailed
                    ? t('input.suggestions.suggestFailed', { defaultValue: 'Suggest failed' })
                    : t('input.suggestions.suggest', { defaultValue: 'Suggest' }),
                }}
                onClick={requestReplySuggestions}
                disabled={replySuggestionsLoading}
                aria-label={replySuggestFailed
                  ? t('input.suggestions.suggestFailed', { defaultValue: 'Suggest failed' })
                  : t('input.suggestions.suggest', { defaultValue: 'Suggest' })}
                aria-busy={replySuggestionsLoading || undefined}
                // The <360px band shrinks every PromptInputButton to 28px to fit the long model
                // name; the icon control keeps its 32px hit target there and the right cluster
                // gives up 2px per gap instead (below), so the row still does not overflow.
                className={cn(
                  'shrink-0 rounded-full border border-dashed border-border/70 text-muted-foreground hover:border-primary/60 hover:text-foreground focus-visible:ring-2 max-[359px]:!w-8',
                  replySuggestFailed && 'border-destructive/60 text-destructive',
                )}
              >
                {replySuggestionsLoading
                  ? <Loader2 className="animate-spin" />
                  : replySuggestFailed ? <CircleAlert /> : <Sparkles />}
              </PromptInputButton>
            ) : (
              <button
                type="button"
                data-slot="reply-suggest-button"
                data-reply-suggest-state={replySuggestFailed ? 'failed' : replySuggestionsLoading ? 'loading' : 'idle'}
                onClick={requestReplySuggestions}
                disabled={replySuggestionsLoading}
                aria-label={replySuggestFailed
                  ? t('input.suggestions.suggestFailed', { defaultValue: 'Suggest failed' })
                  : t('input.suggestions.suggest', { defaultValue: 'Suggest' })}
                aria-busy={replySuggestionsLoading || undefined}
                className={cn(
                  'h-8 shrink-0 whitespace-nowrap rounded-full border border-dashed border-border/70 px-2 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
                  replySuggestFailed && 'border-destructive/60 text-destructive',
                )}
              >
                {replySuggestionsLoading
                  ? t('input.suggestions.suggesting', { defaultValue: 'Suggesting…' })
                  : replySuggestFailed
                    ? t('input.suggestions.suggestFailed', { defaultValue: 'Suggest failed' })
                    : t('input.suggestions.suggest', { defaultValue: 'Suggest' })}
              </button>
            ))}

            {/*
              The voice path's file entry, shown only while the debug switch asks for it: an install
              that never sets `?voiceDebug=1` renders the same composer it always has. The file goes
              through the same transcription chain as a recording.
            */}
            {onVoiceTranscript && voiceAvailable && isVoiceDebugEnabled() && (
              <VoiceUploadButton state={voiceState} onSelectFile={transcribeFile} />
            )}

            {/*
              A clip only exists because the mic produced it. On the wide tier it stays here, in the
              tools group, where it has always been. On the compact tier this row is exactly the six
              controls that send a message and may not wrap, so the pair goes to a row of its own
              instead — see the clip row between the box and the footer.
            */}
            {clipSlot && !isCompactTier && (
              <VoiceClipButton clips={clipSlot} state={clipPlayState} onToggle={toggleClipPlayback} />
            )}

            {isCompactTier ? (
              <>
                {/*
                  The three secondary controls move behind one entry on the compact
                  tier. That keeps the empty row at the six controls that send a
                  message; a draft adds the clear ✕ as the one extra, immediately
                  after this entry and before the model/permission group. Below 360px
                  the row has no width to spare, so the ✕ is dropped there.
                */}
                <ComposerMobileMoreMenu
                  tokenBudget={tokenBudget}
                  onShowTokenUsage={onShowTokenUsage}
                  slashCommandsCount={slashCommandsCount}
                  onToggleCommandMenu={onToggleCommandMenu}
                  canSchedule={Boolean(input.trim())}
                  onScheduleMessage={onScheduleMessage}
                />
                {hasInput && !isNarrowestFooter && (
                  <PromptInputButton
                    tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                    onClick={onClearInput}
                    aria-label={t('input.clearInput', { defaultValue: 'Clear input' })}
                    data-slot="composer-clear-input"
                    // The state gate above is the primary rule; this class is the same rule in
                    // CSS so a resize that has not re-rendered yet cannot leave the ✕ visible
                    // in the <360px band, where the row has no width to spare.
                    className="max-[359px]:hidden"
                  >
                    <XIcon />
                  </PromptInputButton>
                )}
              </>
            ) : (
              <>
                <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />

                <PromptInputButton
                  tooltip={{ content: t('input.showAllCommands') }}
                  onClick={onToggleCommandMenu}
                  className="relative"
                  aria-label={t('input.showAllCommands')}
                >
                  <MessageSquareIcon />
                  {slashCommandsCount > 0 && (
                    <span
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                    >
                      {slashCommandsCount}
                    </span>
                  )}
                </PromptInputButton>

                {/*
                  Wide tier's clear control. The compact tier draws the same control
                  in its own tools group (above), because the row there is a fixed set
                  and the ✕ belongs beside "more" rather than in a group that wraps.
                */}
                {hasInput && (
                  <PromptInputButton
                    tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                    onClick={onClearInput}
                    className="hidden sm:flex"
                    aria-label={t('input.clearInput', { defaultValue: 'Clear input' })}
                    data-slot="composer-clear-input"
                  >
                    <XIcon />
                  </PromptInputButton>
                )}
              </>
            )}

          </PromptInputTools>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 max-[359px]:gap-1 md:gap-2">
            {/*
              The schedule entry's desktop placement: on the compact tier it lives in the "more"
              menu instead, which is why it is not part of the six the compact row keeps.
            */}
            {!isCompactTier && (
              <ScheduleMessagePopover
                disabled={!input.trim()}
                onSchedule={onScheduleMessage}
              />
            )}

            <ComposerModelMenu
              effort={effort}
              effortOptions={availableEffortOptions}
              onSelectEffort={onSelectEffort}
              model={model}
              modelOptions={availableModelOptions}
              onSelectModel={onSelectModel}
              modelsLoading={modelsLoading}
            />

            <ComposerPermissionMenu
              permissionMode={permissionMode}
              permissionModes={availablePermissionModes}
              onSelectPermissionMode={onSelectPermissionMode}
              providerLabel={providerLabel}
            />

            {onVoiceTranscript && voiceAvailable && (
              <VoiceInputButton
                state={voiceState}
                inFlight={voiceInFlight}
                onToggle={handleVoiceToggle}
              />
            )}

            {/*
              The submit and its Live Voice double. While the draft is empty the submit becomes the
              Live Voice entry (see `submitIsVoice`), so the notice a refused start leaves behind is
              anchored to it rather than to a button of its own. `right-0` instead of `left-0`: the
              submit is the footer's last control, so a left-anchored notice would leave the box's
              right edge.
            */}
            <span className="relative inline-block">
              <PromptInputSubmit
                onClick={
                  canQueueDraft
                    ? (e: MouseEvent<HTMLButtonElement>) => {
                        e.preventDefault();
                        handleComposerSubmit(e);
                      }
                    : isLoading
                      ? onAbortSession
                      : isRecording
                        ? (e: MouseEvent<HTMLButtonElement>) => {
                            e.preventDefault();
                            voiceStop({ send: true });
                          }
                        : submitIsVoice
                          ? (e: MouseEvent<HTMLButtonElement>) => {
                              e.preventDefault();
                              if (liveVoiceDisabled) {
                                setLiveVoiceNotice(liveVoiceUnavailableNotice);
                                return;
                              }
                              onLiveVoice?.();
                            }
                          : undefined
                }
                disabled={
                  isLoading
                    ? canQueueDraft
                      ? false
                      : stopUnreachable
                    : isRecording
                      ? false
                      : isTranscribing
                        ? true
                        : submitIsVoice
                          ? false
                          : isOccupied || (!input.trim() && attachedFiles.length === 0)
                }
                aria-label={submitAriaLabel}
                title={submitTitle}
                aria-disabled={submitIsVoice && liveVoiceDisabled ? true : undefined}
                data-testid={submitIsVoice ? 'live-voice-button' : undefined}
                className={`h-10 w-10 sm:h-10 sm:w-10${submitIsVoice && liveVoiceDisabled ? ' opacity-50' : ''}`}
              >
                {isTranscribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : canQueueDraft ? (
                  <ArrowUpIcon className="h-4 w-4" />
                ) : submitIsVoice ? (
                  <AudioLinesIcon className="h-4 w-4" />
                ) : undefined}
              </PromptInputSubmit>
              {liveVoiceNotice && (
                <span
                  role="status"
                  data-testid="live-voice-notice"
                  className="absolute bottom-full right-0 z-50 mb-2 w-56 rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-md"
                >
                  {liveVoiceNotice}
                </span>
              )}
            </span>
          </div>

          {/*
            `basis-full` puts this line on a row of its own, so it costs the composer a whole
            `leading-4` line plus the footer's `gap-y-1` — 20px on the one class of device with the
            least vertical room to spare. A touch-only device therefore hides it at EVERY width:
            `hidden lg:block` alone would hand a ≥1024px tablet (landscape iPad, Surface) the
            keyboard wording, whose Shift a soft keyboard does not have. A keyboard device keeps the
            narrower behaviour it always had — hidden below lg, visible from lg up.

            The voice tier fades it too: while the draft is empty the submit is the Live Voice entry
            (`submitIsVoice`), and starting Live Voice has no keyboard key, so the key-naming line
            would describe a key that does nothing — the same wrong-wording the touch rule removes.
          */}
          <div
            className={`order-last basis-full px-2 text-center text-xs leading-4 text-muted-foreground/50 transition-opacity duration-200 ${touchOnly ? 'hidden' : 'hidden lg:block'} ${
              (input.trim() && !canQueueDraft) || submitIsVoice ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {submitHint}
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>}
    </div>
  );
}
