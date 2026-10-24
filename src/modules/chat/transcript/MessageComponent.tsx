import { memo, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BotIcon, GitBranchIcon, PencilIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, LLMProvider,DiffLine,Project,MessageOrigin } from '@/shared/types';
import { formatUsageLimitText, stripProposedPlanEnvelope } from '@/modules/chat/utils/transcript/chatFormatting';
import { ToolRenderer, ToolErrorDisplay, SubagentPanel, shouldHideToolResult } from '@/modules/chat/tools';
import { useTaskByToolUseId } from '@/modules/chat/hooks/useSessionActivity';
import { LLMProviderLogo } from '@/shared/ui';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/modules/chat/transcript/Reasoning';
import ChatMessageImages from '@/modules/chat/transcript/ChatMessageImages';
import ChatMessageFiles from '@/modules/chat/transcript/ChatMessageFiles';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import StreamingMarkdown from '@/modules/chat/transcript/StreamingMarkdown';
import MessageCopyControl from '@/modules/chat/transcript/MessageCopyControl';
import MessageSpeakControl from '@/modules/chat/transcript/MessageSpeakControl';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { MemoryCitations } from '@/modules/chat/transcript/MemoryCitations';
import type { ReplyItemRenderContext } from '@/modules/chat/utils/transcript/replyItems';
import {
  UNATTENDED_DIVIDER_MESSAGE_TYPE,
  UNATTENDED_TURN_MESSAGE_TYPE,
} from '@/modules/chat/hooks/useChatMessages';

type MessageComponentProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: LLMProvider | string;
  /**
   * Loads this message back into the composer to be replaced. Absent when the
   * provider cannot re-run a conversation from a chosen point, which is what
   * hides the affordance rather than showing one that would fail.
   */
  onEditMessage?: (message: ChatMessage) => void;
  /**
   * Branches the conversation into a new session ending at this message.
   * Absent when the provider cannot copy a transcript prefix.
   */
  onForkFromMessage?: (message: ChatMessage) => void;
  /**
   * Whether this row belongs to the turn the session is still writing.
   *
   * A reply mid-turn has no `forkAnchorId` yet, but a stale page could still
   * carry the previous read's; this is the second half of the guarantee, so the
   * fork button never appears on a turn that is still being written. The caller
   * decides it per row — a row on an earlier, completed turn is not in flight
   * even while a later turn runs — so this is a fact about *this* row, not about
   * the session as a whole.
   */
  isInFlightTurn?: boolean;
  /**
   * Present only on the latest assistant text reply: the items the reply's own
   * text yields, and the ones the composer draft currently points at. Every
   * other row omits it and renders exactly as before.
   */
  replyItems?: ReplyItemRenderContext;
};

const COPY_HIDDEN_TOOL_NAMES = new Set(['Bash', 'Edit', 'Write', 'ApplyPatch']);

/**
 * The four terminal states a task-notification row can carry, as the words the
 * row shows.
 *
 * Held as literals rather than read from the locale: these are the SDK's own
 * status values (`completed`/`failed`/`stopped`/`ended`), the same tokens the
 * server frame's `status` and the CLI's `<status>` tag carry. A translated word
 * here would stop a reader from matching a row to the task state it names, and
 * would make the row's text depend on the UI language while its meaning does not.
 */
const TASK_STATUS_LABELS: Record<string, string> = {
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  ended: 'ended',
};

/** A status word already present in a summary, so it is not added twice. */
const TASK_STATUS_WORD = /\b(?:completed|failed|stopped|ended)\b/i;

/**
 * The text a task-notification row shows for one summary and status.
 *
 * A summary that already names its status — the server's own
 * `Background task completed: …` fallback, or a CLI notification that says
 * `stopped` — is shown as it is. A summary that is only the task's description or
 * command (which is what the SDK sends when nothing else is available) is
 * prefixed with the status word, so the row always says *what happened* and not
 * only *what ran*.
 *
 * Done here, at the row, rather than in the server's frame builder: the identical
 * branch renders the CLI's own `<task-notification>` rows too
 * (`useChatMessages.ts` → `parseTaskNotification`), and those never pass through
 * the server frame builder. One rule at the row covers both; a server-side rule
 * would leave the CLI-sourced half of the transcript with bare commands again.
 */
function taskNotificationText(summary: string, status: string): string {
  const label = TASK_STATUS_LABELS[status] ?? status;
  const text = summary.trim();
  if (!text) {
    return label;
  }
  if (TASK_STATUS_WORD.test(text)) {
    return text;
  }
  return `${label}: ${text}`;
}

/**
 * Collapses a row's text to one line.
 *
 * The summary can be a whole command (measured: up to 4040 characters over 72
 * lines), and the row is one line tall — so every run of whitespace, newlines
 * included, becomes a single space before the row is drawn.
 */
function collapseToSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The sentence a divider shows for the trigger behind a turn.
 *
 * Read from the locale at render time rather than kept as prose here: which words
 * a trigger gets is the user's language's answer, and a copy held in this file
 * would be a second one — the same reason the spec reads the shipped directories
 * instead of transcribing sentences.
 *
 * A trigger this build does not recognise reads as "not user-initiated", which is
 * §15.6's fallback for a cause that cannot be read. A divider has no other option:
 * it exists because the row below it is not a person's, and saying nothing would
 * leave that row unexplained rather than described.
 */
function readDividerLabel(
  origin: MessageOrigin | undefined,
  timestamp: ChatMessage['timestamp'],
  t: TFunction,
): string {
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (!origin) {
    return t('resident.divider.unknown');
  }

  switch (origin.trigger) {
    case 'cron':
      return t('resident.divider.cron', { time });
    case 'cross-session':
      // The sender is the address the sending conversation answers to. When one
      // is not stated the sentence still has to name a sender, so it says what
      // the divider would say about an unreadable cause.
      return t('resident.divider.crossSession', { sender: origin.sender ?? t('resident.divider.unknown'), time });
    case 'background-task':
      return t('resident.divider.backgroundTask', { time });
    default:
      return t('resident.divider.unknown');
  }
}

/**
 * Rendered by chat's ChatMessagesPane and ToolGroupContainer to draw one
 * transcript entry — user turn, assistant turn, or a tool call and its result.
 */
const MessageComponent = memo(({ message, prevMessage, createDiff, onFileOpen, showRawParameters, showThinking, selectedProject, provider, onEditMessage, onForkFromMessage, isInFlightTurn, replyItems }: MessageComponentProps) => {
  const { t } = useTranslation('chat');
  // The Task entity this row's tool call launched, read by the call's
  // `tool_use` id from the session's activity snapshot (AC-194). A tool row with
  // no task (or before any frame arrives) answers null and the card falls back to
  // the transcript's own status.
  const cardTask = useTaskByToolUseId(message.isToolUse ? message.toolId : null);
  const cardTaskState = cardTask?.state ?? null;
  const isGrouped = prevMessage && prevMessage.type === message.type &&
    ((prevMessage.type === 'assistant') ||
      (prevMessage.type === 'user') ||
      (prevMessage.type === 'tool') ||
      (prevMessage.type === 'error'));
  const messageRef = useRef<HTMLDivElement | null>(null);
  const userCopyContent = String(message.content || '');
  const formattedMessageContent = useMemo(
    () => {
      const content = formatUsageLimitText(String(message.content || ''));
      return provider === 'codex' && message.type === 'assistant' && !message.isThinking
        ? stripProposedPlanEnvelope(content)
        : content;
    },
    [message.content, message.isThinking, message.type, provider]
  );
  const assistantCopyContent = message.isToolUse
    ? String(message.displayText || message.content || '')
    : formattedMessageContent;
  const isCommandOrFileEditToolResponse = Boolean(
    message.isToolUse && COPY_HIDDEN_TOOL_NAMES.has(String(message.toolName || ''))
  );
  // Copy and speak are affordances for a live conversation. In an exported
  // document there is nothing to click, and rendering them statically would
  // also pull in browser-only voice state that a document render has no
  // provider for.
  const isExporting = useIsExportingTranscript();
  /**
   * Whether this row is drawn as a person's turn.
   *
   * One predicate rather than three copies of `message.type === 'user'`: the
   * className, the markup branch and the copy control all have to agree about
   * it, and it is also what the row publishes as `data-message-style` — a row
   * that took the user branch while that attribute said otherwise would be a
   * styling decision nothing could measure.
   */
  const rendersAsUser = message.type === 'user';
  const isUnattendedTurn = message.type === UNATTENDED_TURN_MESSAGE_TYPE;
  /**
   * Whether this row was written by an automation rather than by a person.
   *
   * `origin` is the server's own statement that nobody at a browser started this
   * turn — a scheduled task firing, a background task reporting back, or another
   * conversation writing in (which is how a message a fleet or any other
   * external system sends through `session_send` arrives). Reading it is what
   * makes the row's authorship a fact the transcript was told rather than one it
   * inferred: a client that guessed from a missing sender, or from the text
   * looking machine-written, would be inventing the distinction.
   *
   * Absence is equally meaningful and is the half that must not move: a message
   * with no `origin` is a person's, and it renders exactly as it always has.
   * This is therefore the whole of the condition — every machine treatment this
   * row gets is behind it, so an unmarked row cannot acquire one by accident.
   */
  const isMachineOrigin = Boolean(message.origin);
  const shouldShowUserCopyControl = !isExporting && rendersAsUser && userCopyContent.trim().length > 0;
  const shouldShowAssistantCopyControl = !isExporting &&
    message.type === 'assistant' &&
    assistantCopyContent.trim().length > 0 &&
    !isCommandOrFileEditToolResponse &&
    !message.isThinking;
  /**
   * Whether the assistant bar offers "fork from this answer".
   *
   * Keyed on `forkAnchorId`, not `transcriptAnchorId`: only a turn-ending reply
   * carries one, so the button lands on the answer rather than on the prompt.
   * The turn still being written is excluded even when a stale row still carries
   * an anchor, so the affordance never appears on a turn that is still being
   * written; a row on any completed turn carries it as usual.
   */
  const shouldShowForkControl = Boolean(
    onForkFromMessage && shouldShowAssistantCopyControl && message.forkAnchorId && !isInFlightTurn,
  );

  const formattedTime = useMemo(() => new Date(message.timestamp).toLocaleTimeString(), [message.timestamp]);
  const dividerLabel = useMemo(
    () => readDividerLabel(message.origin, message.timestamp, t),
    [message.origin, message.timestamp, t],
  );
  const shouldHideThinkingMessage = Boolean(message.isThinking && !showThinking);

  if (shouldHideThinkingMessage) {
    return null;
  }

  if (message.type === UNATTENDED_DIVIDER_MESSAGE_TYPE) {
    /*
     * The line that says what started the turn below it. It is drawn as a
     * transcript row of its own — a rule with the label centred on it — rather
     * than as a heading inside the message, so it keeps its position when the
     * turn is long, scrolled past, or grouped with nothing.
     */
    return (
      <div
        data-unattended-divider={message.origin?.trigger ?? 'unknown'}
        data-unattended-sender={message.origin?.sender ?? ''}
        className="chat-message unattended-divider flex items-center gap-2 px-3 py-1 sm:px-0"
      >
        <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
        <span className="flex-shrink-0 text-xs text-muted-foreground">{dividerLabel}</span>
        <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      ref={messageRef}
      data-message-timestamp={message.timestamp || undefined}
      data-message-style={rendersAsUser ? 'user' : message.type}
      // Only an unattended row carries these, so the selector names exactly one
      // row per turn: the styling decision this row is checked against is the
      // one made below, on this element.
      {...(isUnattendedTurn
        ? { 'data-unattended-row': 'true', 'data-unattended-sender': message.origin?.sender ?? '' }
        : {})}
      // The row's authorship, as one attribute on the row itself. The divider
      // above an unattended turn names what started it, but a divider scrolls
      // away, is not drawn for every machine-marked row, and is absent from a
      // single-row reading of the transcript — so "who wrote this" has to be
      // readable off the row, not only off its neighbour. Emitted only when the
      // server said so, which is what keeps an unmarked row's DOM unchanged.
      {...(isMachineOrigin ? { 'data-message-origin': 'machine' } : {})}
      className={`chat-message ${message.type} ${isGrouped ? 'grouped' : ''} ${rendersAsUser ? 'flex justify-end px-3 sm:px-0' : 'px-3 sm:px-0'}`}
    >
      {rendersAsUser ? (
        /* User turn on the right: claude.ai-style attachment cards above the bubble */
        <div className="flex w-full items-end space-x-0 sm:w-auto sm:max-w-[85%] sm:space-x-3 md:max-w-md lg:max-w-lg xl:max-w-xl">
          <div className="flex min-w-0 flex-1 flex-col items-end gap-2 sm:flex-initial">
            {message.images && message.images.length > 0 && (
              <ChatMessageImages
                images={message.images}
                projectId={selectedProject?.projectId}
              />
            )}
            {message.files && message.files.length > 0 && (
              <ChatMessageFiles files={message.files} />
            )}
            {userCopyContent.trim().length > 0 || (!message.images?.length && !message.files?.length) ? (
              <div className="group max-w-full rounded-2xl rounded-br-md border border-border/60 bg-muted/60 px-3 py-2 text-foreground shadow-sm dark:bg-gray-800/60 sm:px-4">
                <div dir="auto" className="break-words font-serif text-sm">
                  <Markdown
                    breaks
                    className="prose prose-sm max-w-none font-serif dark:prose-invert"
                  >
                    {message.content}
                  </Markdown>
                </div>
                <div className="mt-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
                  {onEditMessage && message.transcriptAnchorId && (
                    <button
                      type="button"
                      onClick={() => onEditMessage(message)}
                      title={t('message.editAndResend')}
                      aria-label={t('message.editAndResend')}
                      className="rounded p-1 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <PencilIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {shouldShowUserCopyControl && (
                    <MessageCopyControl content={userCopyContent} messageType="user" />
                  )}
                  <span>{formattedTime}</span>
                </div>
              </div>
            ) : (
              /* Attachment-only turn: no text bubble, but the timestamp still shows */
              <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                <span>{formattedTime}</span>
              </div>
            )}
          </div>
          {!isGrouped && (
            <div className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm text-white sm:flex">
              U
            </div>
          )}
        </div>
      ) : isUnattendedTurn ? (
        /*
         * A turn nobody typed: left-aligned like a reply, and visibly not the
         * reader's own. The dashed edge and the absence of the avatar are the
         * whole difference, and they are the difference between "this was said
         * to me" and "I said this" — which is the reading the divider above it
         * and this row's own styling have to agree about.
         *
         * The bot mark carries the same reading *on the row*. The dashed edge
         * says "not yours"; it does not say "not a person's", and it is the one
         * an automation's message shares with a debug agent's reply. The mark is
         * that second fact stated where it cannot scroll away with the divider.
         *
         * It is an icon and not a word on purpose. This row's text content is
         * the sender's own words — the whole point of the row is that it shows
         * them — so a label here would be read back as part of the message by
         * every reader of the row's text (the export, the search index, the
         * e2e walk). The accessible name sits on the icon instead, where it
         * reaches a screen reader without becoming a word in the message.
         */
        <div className="w-full">
          <div className="flex max-w-[85%] items-start gap-2 rounded-2xl rounded-bl-md border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-foreground sm:px-4">
            <BotIcon
              role="img"
              aria-label={t('resident.machineOrigin', {
                defaultValue: 'Automated message — not written by a person',
              })}
              data-machine-origin-mark="true"
              className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
            />
            <div className="min-w-0 flex-1">
              <Markdown
                breaks
                className="prose prose-sm max-w-none dark:prose-invert"
              >
                {message.content}
              </Markdown>
            </div>
          </div>
        </div>
      ) : message.compact ? (
        /* A compaction: one row, its numbers, and its summary folded into it */
        <div className="w-full">
          <div className="flex items-center gap-2 py-0.5">
            <span
              className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                message.compact.phase === 'running'
                  ? 'animate-pulse bg-amber-400 dark:bg-amber-500'
                  : message.compact.phase === 'failed'
                    ? 'bg-red-400 dark:bg-red-500'
                    : 'bg-gray-400 dark:bg-gray-500'
              }`}
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {message.content || t('chat:misc.compacted', 'Compacted')}
            </span>
          </div>
          {message.compactSummary && (
            <details className="ml-3.5 mt-0.5">
              <summary className="cursor-pointer text-xs text-gray-500 hover:text-foreground dark:text-gray-400">
                {t('chat:misc.compactionSummary', 'full summary')}
              </summary>
              <div className="mt-1">
                <Markdown className="prose prose-sm prose-gray max-w-none font-serif dark:prose-invert">
                  {message.compactSummary}
                </Markdown>
              </div>
            </details>
          )}
        </div>
      ) : message.isMonitorCollapse ? (
        /*
         * A run of Monitor events for one task: one line that says what is
         * being watched and how many events it produced, with the events
         * themselves folded into the disclosure below. A stopped monitor reads
         * as ended (amber), never as an error — it is a thing that finished, not
         * a thing that failed.
         */
        <div
          className="w-full"
          data-monitor-collapse="true"
          data-monitor-task-id={message.monitorTaskId}
          data-monitor-count={message.monitorEventCount ?? 0}
          data-monitor-status={message.monitorStatus}
        >
          <div className="flex items-center gap-2 py-0.5">
            <span
              className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                message.monitorStatus === 'stopped'
                  ? 'bg-amber-400 dark:bg-amber-500'
                  : 'bg-green-400 dark:bg-green-500'
              }`}
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {`📡 ${message.monitorDescription || t('chat:misc.monitorEvents', 'Monitor events')} · ${t('chat:misc.monitorEventsCount', { count: message.monitorEventCount ?? 0 })}`}
            </span>
            {message.monitorStatus === 'stopped' && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                {t('chat:misc.monitorStopped', 'Timed out / stopped')}
              </span>
            )}
          </div>
          <details className="ml-3.5 mt-0.5">
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-foreground dark:text-gray-400">
              {t('chat:misc.monitorEvents', 'Monitor events')}
            </summary>
            <ul className="mt-1 space-y-0.5">
              {(message.monitorEvents ?? []).map((event, index) => (
                <li
                  key={index}
                  className="whitespace-pre-wrap break-words font-mono text-xs text-gray-500 dark:text-gray-400"
                >
                  {event}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : message.isTaskNotification ? (
        /*
         * A background task's terminal line: one row, one line tall, saying
         * *which task and what state* rather than only *what ran*. The status is
         * part of the text (the SDK's own word), the whole summary is collapsed
         * onto that one line and truncated, and the untruncated text stays in
         * `title` so nothing is lost — a reader can still hover the row to read
         * the full command. The dot keeps its colour as a second, redundant cue.
         */
        <div className="w-full min-w-0">
          <div className="flex min-w-0 items-center gap-2 py-0.5">
            <span className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${message.taskStatus === 'completed' ? 'bg-green-400 dark:bg-green-500' : 'bg-amber-400 dark:bg-amber-500'}`} />
            <span
              className="min-w-0 flex-1 truncate whitespace-nowrap font-mono text-xs text-gray-500 dark:text-gray-400"
              data-task-notification-text
              title={taskNotificationText(String(message.content ?? ''), String(message.taskStatus ?? 'completed'))}
            >
              {collapseToSingleLine(taskNotificationText(String(message.content ?? ''), String(message.taskStatus ?? 'completed')))}
            </span>
          </div>
        </div>
      ) : (
        /* Claude/Error/Tool messages on the left */
        <div className="w-full">
          {!isGrouped && (
            <div className="mb-2 flex items-center space-x-3">
              {message.type === 'error' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">
                  !
                </div>
              ) : message.type === 'tool' ? (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-600 text-sm text-white dark:bg-gray-700">
                  🔧
                </div>
              ) : (
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-foreground">
                  <LLMProviderLogo provider={provider} className="h-full w-full" />
                </div>
              )}
              <div className="text-sm font-medium text-gray-900 dark:text-white">
                {message.type === 'error'
                  ? t('messageTypes.error')
                  : message.type === 'tool'
                    ? t('messageTypes.tool')
                    : (provider === 'cursor'
                        ? t('messageTypes.cursor')
                        : provider === 'codex'
                          ? t('messageTypes.codex')
                          : provider === 'opencode'
                              ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                              // A debug agent's replies are synthetic, and the mark beside this
                              // name already says so. Without a branch of its own the chain named
                              // them "Claude" — asserting a provenance the message does not have,
                              // which is worse than a missing name and undetectable by a reader.
                              // The fallback below stays for ids this build cannot name at all.
                              : provider === 'debug'
                                ? t('messageTypes.debug')
                                : t('messageTypes.claude'))}
              </div>
            </div>
          )}

          <div className="w-full">

            {message.isSubagentContainer ? (
              /* A spawned agent owns its whole card — header, timeline and
                 result — so it never goes through the tool input/result pair. */
              <SubagentPanel
                toolInput={message.toolInput}
                toolResult={message.toolResult}
                subagent={message.subagent}
                activity={message.subagentActivity}
                onFileOpen={onFileOpen}
                createDiff={createDiff}
                selectedProject={selectedProject}
                taskState={cardTaskState}
              />
            ) : message.isToolUse ? (
              <>
                <div className="flex flex-col">
                  <div className="flex flex-col">
                    <Markdown className="prose prose-sm max-w-none font-serif dark:prose-invert">
                      {String(message.displayText || '')}
                    </Markdown>
                  </div>
                </div>

                {message.toolInput && (
                  <ToolRenderer
                    toolName={message.toolName || 'UnknownTool'}
                    toolInput={message.toolInput}
                    toolResult={message.toolResult}
                    toolId={message.toolId}
                    mode="input"
                    onFileOpen={onFileOpen}
                    createDiff={createDiff}
                    selectedProject={selectedProject}
                    showRawParameters={showRawParameters}
                    rawToolInput={typeof message.toolInput === 'string' ? message.toolInput : undefined}
                    toolStatus={message.toolStatus}
                    taskState={cardTaskState}
                  />
                )}

                {/* Tool Result Section — Bash renders its output inside the command row above. */}
                {message.toolResult && message.toolName !== 'Bash' && !shouldHideToolResult(message.toolName || 'UnknownTool', message.toolResult) && (
                  message.toolResult.isError ? (
                    // Error results — collapsed red row that expands to the content
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolErrorDisplay
                        label={t('messageTypes.error')}
                        content={String(message.toolResult.content || '')}
                      />
                    </div>
                  ) : (
                    // Non-error results - route through ToolRenderer (single source of truth)
                    <div id={`tool-result-${message.toolId}`} className="scroll-mt-4">
                      <ToolRenderer
                        toolName={message.toolName || 'UnknownTool'}
                        toolInput={message.toolInput}
                        toolResult={message.toolResult}
                        toolId={message.toolId}
                        mode="result"
                        onFileOpen={onFileOpen}
                        createDiff={createDiff}
                        selectedProject={selectedProject}
                      />
                    </div>
                  )
                )}
              </>
            ) : message.isThinking ? (
              /* Thinking messages — Reasoning component (ai-elements pattern) */
              <Reasoning defaultOpen={isExporting}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <Markdown className="prose prose-sm prose-gray max-w-none font-serif dark:prose-invert">
                    {message.content}
                  </Markdown>
                  {!isExporting && (
                    <div className="mt-3 flex items-center text-[11px]">
                      <MessageCopyControl content={String(message.content || '')} messageType="assistant" />
                    </div>
                  )}
                </ReasoningContent>
              </Reasoning>
            ) : (
              <div dir="auto" className="text-sm text-gray-700 dark:text-gray-300">
                {/* Reasoning accordion */}
                {showThinking && message.reasoning && (
                  <Reasoning className="mb-3" defaultOpen={false}>
                    <ReasoningTrigger />
                    <ReasoningContent>
                      <div className="whitespace-pre-wrap">
                        {message.reasoning}
                      </div>
                    </ReasoningContent>
                  </Reasoning>
                )}

                {(() => {
                  const content = formattedMessageContent;

                  // Detect if content is pure JSON (starts with { or [)
                  const trimmedContent = content.trim();
                  if ((trimmedContent.startsWith('{') || trimmedContent.startsWith('[')) &&
                    (trimmedContent.endsWith('}') || trimmedContent.endsWith(']'))) {
                    try {
                      const parsed = JSON.parse(trimmedContent);
                      const formatted = JSON.stringify(parsed, null, 2);

                      return (
                        <div className="my-2">
                          <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                            </svg>
                            <span className="font-medium">{t('json.response')}</span>
                          </div>
                          <div className="overflow-hidden rounded-lg border border-border bg-muted">
                            <pre className="overflow-x-auto p-4">
                              <code className="block whitespace-pre font-mono text-sm text-foreground">
                                {formatted}
                              </code>
                            </pre>
                          </div>
                        </div>
                      );
                    } catch {
                      // Not valid JSON, fall through to normal rendering
                    }
                  }

                  // Normal rendering for non-JSON content
                  // One component for both states on purpose: swapping element
                  // types here remounted the whole reply the instant it finished.
                  return message.type === 'assistant' ? (
                    <StreamingMarkdown
                      content={content}
                      isStreaming={Boolean(message.isStreaming)}
                      className="prose prose-sm prose-gray max-w-none font-serif dark:prose-invert"
                      replyItems={replyItems}
                    />
                  ) : (
                    <div className="whitespace-pre-wrap">
                      {content}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Outside the branches on purpose: a provider can cite memory on a
                plain reply or on the plan card it turned that reply into. */}
            {Array.isArray(message.memoryCitations) && message.memoryCitations.length > 0 && (
              <MemoryCitations citations={message.memoryCitations} />
            )}

            {(shouldShowAssistantCopyControl || !isGrouped) && (
              <div className="mt-1 flex w-full items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
                {shouldShowAssistantCopyControl && (
                  <MessageCopyControl content={assistantCopyContent} messageType="assistant" />
                )}
                {shouldShowAssistantCopyControl && (
                  <MessageSpeakControl content={assistantCopyContent} />
                )}
                {shouldShowForkControl && (
                  // Permanently opaque, on purpose: this action bar's ancestor chain carries no `.group`, so a
                  // `group-hover:opacity-100` here would never fire and the control would sit at `opacity: 0`
                  // for every mouse and touch reader (keyboard focus was its only way out). It keeps the same
                  // always-drawn shape as the copy and speak controls beside it; `hover:bg-muted` supplies the
                  // feedback the old transition carried. The user bubble's own edit control keeps the hover-only
                  // style — its `.group` lives on the bubble and that behaviour is unchanged here.
                  <button
                    type="button"
                    onClick={() => onForkFromMessage?.(message)}
                    title={t('message.forkFromHere')}
                    aria-label={t('message.forkFromHere')}
                    className="rounded p-1 transition-colors hover:bg-muted"
                  >
                    <GitBranchIcon className="h-3.5 w-3.5" />
                  </button>
                )}
                {!isGrouped && <span>{formattedTime}</span>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default MessageComponent;

