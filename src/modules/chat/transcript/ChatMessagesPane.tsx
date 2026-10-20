import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, Ref, RefObject, SetStateAction } from 'react';

import type { ChatMessage,
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition,
  SessionActivity } from '@/shared/types';
import { RESIDENT_PENDING_MESSAGE_TYPE, UNATTENDED_TURN_MESSAGE_TYPE } from '@/modules/chat/hooks/useChatMessages';
import { getIntrinsicMessageKey, messageAnchorId } from '@/modules/chat/utils/transcript/messageKeys';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/transcript/workSegments';
import { findSearchTargetIndex } from '@/modules/chat/utils/transcript/searchTargetLocator';
import { nextPxPerMessage } from '@/modules/chat/utils/transcript/contentHeightModel';

import type { ContentRowInput } from '@/modules/chat/utils/transcript/contentHeightModel';
import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import { findPendingForegroundTool } from '@/modules/chat/hooks/useActivityControls';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import PendingResidentMessage from '@/modules/chat/transcript/PendingResidentMessage';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import type { NextTaskBannerComponent } from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import WorkSegmentRecord from '@/modules/chat/transcript/WorkSegmentRecord';
import LoadAllMessagesOverlay from '@/modules/chat/transcript/LoadAllMessagesOverlay';
import { ActivityIndicator } from '@/modules/chat/activity';

/**
 * How many of the newest rows mount with real content on the first commit,
 * before the lazy-row observer has had a chance to report what is actually
 * near the viewport. Covers a bit more than one screen of typical rows.
 */
const INITIAL_MOUNTED_TAIL_ROWS = 30;

/**
 * How long a burst of row measurements is folded into the placeholder estimate.
 *
 * Rows mount and unmount on nearly every scroll frame, and each one changes the
 * transcript's running average. Rebuilding on every frame would put a full-window
 * height read in the frame path; the debounce lets one rebuild answer a burst —
 * the same shape, and the same value, as the rail's own content rebuild.
 */
const PLACEHOLDER_ESTIMATE_DEBOUNCE_MS = 120;

/** How many messages a transcript row stands for, from its own `data-transcript-row-messages`. */
function rowMessageCount(row: HTMLElement): number {
  const declared = Number.parseInt(
    row.querySelector<HTMLElement>('[data-transcript-row-messages]')?.dataset.transcriptRowMessages ?? '1',
    10,
  );
  return Number.isFinite(declared) && declared > 0 ? declared : 1;
}

/**
 * The transcript's running average pixels per message, for sizing the
 * placeholders of rows that have never been measured.
 *
 * Read off the loaded rows the pane has actually measured, through the same
 * `nextPxPerMessage` model the rail and the drawn scrollbar use — so the height
 * a placeholder occupies and the height the scrollbar draws it at are one
 * estimate, not two. Rows are re-read when the content column mutates (a row
 * mounting, unmounting or recording its measured height) and when the pane
 * resizes, debounced so a burst of mounts costs one read.
 *
 * `0` means nothing is measurable yet; the caller falls back to the row's own
 * constant. Once a single row has been measured this bootstraps to the model's
 * own default and never returns to `0`, which is what keeps a placeholder from
 * flickering between two sizes.
 */
function useTranscriptPxPerMessage(scrollContainerRef: RefObject<HTMLDivElement>): number {
  const [pxPerMessage, setPxPerMessage] = useState(0);
  const runningRef = useRef(0);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    const measure = () => {
      const contentEl = container.querySelector<HTMLElement>('[data-transcript-content]');
      if (!contentEl) return;
      const rows = (Array.from(contentEl.children) as HTMLElement[]).filter((row) =>
        row.hasAttribute('data-message-timestamp'),
      );
      const inputs: ContentRowInput[] = rows.map((row) => {
        const height = row.offsetHeight;
        return {
          messages: rowMessageCount(row),
          measured: row.hasAttribute('data-row-measured') && height > 0,
          height,
        };
      });
      const next = nextPxPerMessage(runningRef.current, inputs);
      runningRef.current = next;
      setPxPerMessage((previous) => (Math.abs(previous - next) > 0.5 ? next : previous));
    };

    measure();
    const frame = requestAnimationFrame(measure);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        measure();
      }, PLACEHOLDER_ESTIMATE_DEBOUNCE_MS);
    };
    // jsdom ships no MutationObserver in some environments; there the mount
    // measurement and the resize listener below are the only remeasurement.
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    observer?.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-row-measured'],
    });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(container);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', schedule);
      if (timer !== null) clearTimeout(timer);
    };
  }, [scrollContainerRef]);

  return pxPerMessage;
}

/**
 * The default for `onToggleResident`, for a render that supplies no toggler.
 *
 * Stable rather than inline, so a render that omits the prop does not hand the empty state's switch a
 * new function on every commit. The switch draws either way — this only makes it inert.
 */
const noopResidentToggle = () => {};

type ChatMessagesPaneProps = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  /**
   * Attaches the content column — the box that grows when the last row gets
   * taller without a new row arriving — to chat's content-growth follow.
   */
  scrollContentRef: Ref<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /**
   * Whether the turn's status is the pane's to draw: true while a run is in
   * flight and no permission request has taken the status over. The pane uses it
   * only to decide whether the status line is handed `activity` or `null`; the
   * line is always mounted, so its exit animation always owns the collapse.
   */
  hasActivityIndicator?: boolean;
  /**
   * The running turn's activity, drawn as the in-flow status line at the end of
   * the message list. Passed rather than re-derived: the pane already receives
   * `hasActivityIndicator`, and this is the same turn's data, not a second account
   * of it.
   */
  activity?: SessionActivity | null;
  /** True when the last send was never delivered; the inline status line reports it. */
  sendFailed?: boolean;
  /**
   * Whether the running turn can be interrupted right now — the caller's own abort gate. The status
   * line draws its Stop from this together with `onStopTurn`; that Stop is the running turn's, so it
   * is present in Live Voice too, where the composer's submit-button Stop is not mounted.
   */
  canStopTurn?: boolean;
  /** Stops the running turn. Absent draws no Stop on the status line. */
  onStopTurn?: () => void;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  /** The next-task banner, handed in by the caller that owns the task feature — see `ProviderSelectionEmptyState`. */
  nextTaskBanner?: NextTaskBannerComponent;
  setInput: Dispatch<SetStateAction<string>>;
  /**
   * Whether the selected provider can hold a resident session; the empty state's switch is drawn
   * only when it can.
   *
   * Optional, and absent means "cannot": a caller that does not know the capability matrix cannot
   * claim it, and offering a switch for a provider that may refuse the mode would promise an action
   * the server would not keep. The app's own caller always knows — it reads the same matrix — so this
   * default exists for a standalone render, the way `sessionId`'s does on the composer.
   */
  canRunResident?: boolean;
  /** Whether the next brand-new session is meant to be resident; owned by ChatInterface and read here for the empty state's switch. */
  residentEnabled?: boolean;
  /** Flips `residentEnabled`. */
  onToggleResident?: () => void;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /**
   * Asks the resident process holding this message to take it back. Absent
   * hides the affordance rather than drawing one that would do nothing.
   */
  onWithdrawResidentCommand?: (message: ChatMessage) => void;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
};

/**
 * Rendered by chat's ChatInterface as the scrolling transcript: the message
 * list and tool groups, the export menu, the provider empty state and the
 * load-all-history overlay.
 */
function ChatMessagesPane({
  scrollContainerRef,
  scrollContentRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  activity = null,
  sendFailed = false,
  canStopTurn = false,
  onStopTurn,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  nextTaskBanner,
  setInput,
  canRunResident = false,
  residentEnabled = false,
  onToggleResident = noopResidentToggle,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onWithdrawResidentCommand,
  onEditMessage,
  onForkFromMessage,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const activeSessionId = currentSessionId ?? selectedSession?.id ?? null;
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  // The placeholder estimate for never-measured rows: without it a jump centres
  // the target against 100px stand-ins in a conversation whose rows are 250px.
  const pxPerMessage = useTranscriptPxPerMessage(scrollContainerRef);
  // The right gutter, from what is drawn at the pane's edge: the scrollbar's own
  // column on mobile, the fixed tick band where the column needs room, nothing on
  // a wide viewport whose outer margin already clears the chrome.
  const groupedVisibleMessages = useMemo(
    () => groupWorkSegments(visibleMessages),
    [visibleMessages],
  );

  /**
   * The rows that belong to the turn still being written, or `null` when the
   * session is idle (nothing is in flight).
   *
   * A fork is withheld from a reply that is still arriving — a branch cut at a
   * half-written answer would copy a partial turn. That is a property of the
   * *turn*, not of the session: the server already withholds `forkAnchorId` from
   * the turn in flight and stamps it on every turn before it, so all the client
   * has to answer is "does this row sit after the last turn's opening?". Rows on
   * an earlier, completed turn keep their control even while a later turn runs —
   * which is what lets a resident session, whose last turn is almost always in
   * flight, expose its earlier turns at all.
   *
   * A turn opens either on a person's prompt (`user`) or on a turn nobody typed
   * (`unattended`) — the same pair the server's own turn walk treats as a turn
   * boundary. A work segment's member is answered by its own position in the
   * sequence, not by the segment's, so folding a run into one drawn row cannot
   * move a member's turn membership.
   */
  const inFlightTurnMessages = useMemo(() => {
    if (!isProcessing) {
      return null;
    }
    let lastTurnStartIndex = -1;
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      const row = visibleMessages[index];
      if (row.type === 'user' || row.type === UNATTENDED_TURN_MESSAGE_TYPE) {
        lastTurnStartIndex = index;
        break;
      }
    }
    const inFlight = new Set<ChatMessage>();
    for (let index = lastTurnStartIndex + 1; index < visibleMessages.length; index += 1) {
      inFlight.add(visibleMessages[index]);
    }
    return inFlight;
  }, [visibleMessages, isProcessing]);

  // The running foreground tool the dock can move to the background. Read off
  // the whole loaded transcript rather than the visible window: an unpaired
  // `tool_use` the reader has scrolled past is still the tool the server is
  // holding, and the dock's control must address that one.
  const foregroundTool = useMemo(
    () => findPendingForegroundTool(chatMessages),
    [chatMessages],
  );

  // Which work segments are open, keyed by the segment's anchor key. Held here —
  // in the pane's own React state — and not inside `WorkSegmentRecord`, whose
  // instances unmount whenever their `LazyMessageRow` scrolls out of the viewport:
  // an open segment has to stay open when its row leaves and comes back, while a
  // fresh pane mount has to start from nothing. State in either wrong place fails
  // one of those two readings (module scope survives the remount; the record's own
  // state dies with the row), which is why the empty set lives at exactly this
  // level and nowhere shorter- or longer-lived.
  const [expandedSegmentKeys, setExpandedSegmentKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const toggleSegment = useCallback((segmentKey: string, next: boolean) => {
    setExpandedSegmentKeys((current) => {
      const updated = new Set(current);
      if (next) {
        updated.add(segmentKey);
      } else {
        updated.delete(segmentKey);
      }
      return updated;
    });
  }, []);

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // A server refresh can replace source records with equivalent new objects, so
  // object identity is not a durable React key across pagination or hydration.
  // Deriving keys from this render's ordered messages (intrinsic key,
  // disambiguated by occurrence index on collision) preserves existing DOM
  // nodes and component state when older history is prepended.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isWorkSegment(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  /**
   * Opens the segment a sidebar search hit landed inside.
   *
   * The search jump resolves its target against the loaded transcript and scrolls
   * to the row carrying the target's timestamp. A hit that fell on a member of a
   * run is a member of a *collapsed* segment by default, so that row is not in the
   * DOM and the jump can only settle on the segment's own anchor — leaving the
   * matched content hidden behind the very collapse the jump was meant to reveal.
   *
   * The pane is the host because it already receives both the session (which
   * carries `__searchTargetSnippet`) and the grouped rows, and because the
   * expanded set lives here. Resolving the hit is the same pure locator the jump
   * itself uses, so the pane and the scroller cannot disagree about which row the
   * hit is on; the segment that owns that row is then opened, and only that one.
   */
  const searchTargetSnippet = (selectedSession as Record<string, unknown> | null)?.__searchTargetSnippet;
  const searchTargetTimestamp = (selectedSession as Record<string, unknown> | null)?.__searchTargetTimestamp;
  useEffect(() => {
    if (typeof searchTargetSnippet !== 'string' || searchTargetSnippet.length === 0) {
      return;
    }
    const targetIndex = findSearchTargetIndex(visibleMessages, {
      snippet: searchTargetSnippet,
      timestamp: typeof searchTargetTimestamp === 'string' ? searchTargetTimestamp : undefined,
    });
    if (targetIndex < 0) {
      return;
    }
    const targetMessage = visibleMessages[targetIndex];
    for (const item of groupedVisibleMessages) {
      if (!isWorkSegment(item) || !item.messages.includes(targetMessage)) {
        continue;
      }
      const segmentKey = item.key ?? getMessageKey(item.messages[0]);
      setExpandedSegmentKeys((current) => {
        if (current.has(segmentKey)) {
          return current;
        }
        const updated = new Set(current);
        updated.add(segmentKey);
        return updated;
      });
      break;
    }
  }, [
    searchTargetSnippet,
    searchTargetTimestamp,
    visibleMessages,
    groupedVisibleMessages,
    getMessageKey,
  ]);

  // The transcript row that precedes each message, repaired for the segment path.
  //
  // `MessageComponent` reads it only to decide whether a row is visually grouped
  // with the one above it. Rows a segment absorbed must keep the same predecessor
  // they had as free rows — the member before them, or the row before the segment
  // for its first member — so a member's own shape is the same inside a segment as
  // out of one.
  const prevMessageFor = useMemo(() => {
    const predecessors = new WeakMap<ChatMessage, ChatMessage | null>();
    let previous: ChatMessage | null = null;
    for (const item of groupedVisibleMessages) {
      if (isWorkSegment(item)) {
        for (const member of item.messages) {
          predecessors.set(member, previous);
          previous = member;
        }
      } else {
        predecessors.set(item, previous);
        previous = item;
      }
    }
    return predecessors;
  }, [groupedVisibleMessages]);

  return (
    // The resident process's facts used to sit on a row of their own, *above* the
    // scroll container, in a status bar of their own. They live in the dock's
    // expanded panel now — the dock is this pane's own status surface below `md`,
    // so the facts are one tap from the row that says what the session is doing —
    // and the row they used to occupy is gone with the bar.
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        // Focusable so the pane itself can be scrolled from the keyboard. A wheel
        // and a touch drag are delivered to whatever is under the pointer, but
        // PageUp and the arrow keys act on the element that has focus — without
        // this the browser scrolls the document instead, the pane reports no
        // `scroll` at all, and a keyboard gesture is invisible to the intent
        // machinery that keeps a transcript the user took over where they put it.
        // -1 rather than 0: the pane joins no tab order, it is only focusable.
        tabIndex={-1}
        onWheel={onWheel}
        onTouchMove={onTouchMove}
        className="chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3 pt-3 sm:pb-4 sm:pt-4"
        // The gutter the drawn chrome needs, measured rather than fixed — see the
        // CSS block for why the number moved out of `index.css`.
      >
        {/* Always rendered, so the follow's observer is attached for the empty and
            loading states too and never has to be re-attached mid-session. */}
        <div
          ref={scrollContentRef}
          data-transcript-content
          className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4"
        >
        {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
          <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
            <div className="flex items-center justify-center space-x-2">
              <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
              <p>{t('session.loading.sessionMessages')}</p>
            </div>
          </div>
        ) : chatMessages.length === 0 ? (
          <ProviderSelectionEmptyState
            selectedSession={selectedSession}
            currentSessionId={currentSessionId}
            provider={provider}
            setProvider={setProvider}
            textareaRef={textareaRef}
            providerModels={providerModels}
            setProviderModel={setProviderModel}
            providerModelCatalog={providerModelCatalog}
            providerModelActions={providerModelActions}
            providerModelsLoading={providerModelsLoading}
            tasksEnabled={tasksEnabled}
            isTaskMasterInstalled={isTaskMasterInstalled}
            onShowAllTasks={onShowAllTasks}
            nextTaskBanner={nextTaskBanner}
            setInput={setInput}
            canRunResident={canRunResident}
            residentEnabled={residentEnabled}
            onToggleResident={onToggleResident}
          />
        ) : (
          <>
            {/* Loading indicator for older messages (hide when load-all is active) */}
            {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
              <div className="py-3 text-center text-gray-500 dark:text-gray-400">
                <div className="flex items-center justify-center space-x-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                  <p className="text-sm">{t('session.loading.olderMessages')}</p>
                </div>
              </div>
            )}

            {/* Indicator showing there are more messages to load (hide when all loaded) */}
            {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
              <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {totalMessages > 0 && (
                  <span>
                    {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                    <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                  </span>
                )}
              </div>
            )}

            <LoadAllMessagesOverlay
              showLoadAllOverlay={showLoadAllOverlay}
              isLoadingAllMessages={isLoadingAllMessages}
              loadAllJustFinished={loadAllJustFinished}
              totalMessages={totalMessages}
              onLoadAllMessages={loadAllMessages}
            />

            {/* Legacy message count indicator (for non-paginated view) */}
            {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
              <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
                <button className="ml-1 text-blue-600 underline hover:text-blue-700" onClick={loadEarlierMessages}>
                  {t('session.messages.loadEarlier')}
                </button>
                {' | '}
                <button
                  className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  onClick={loadAllMessages}
                >
                  {t('session.messages.loadAll')}
                </button>
              </div>
            )}

            {groupedVisibleMessages.map((item, index) => {
              // Rows near the tail mount their content on first commit so the
              // initial scroll-to-bottom measures real heights; older rows
              // start as placeholders and mount when scrolled toward.
              const initiallyNearViewport = index >= groupedVisibleMessages.length - INITIAL_MOUNTED_TAIL_ROWS;

              // One run of adjacent work rows. Drawn as a single collapsible
              // record inside a LazyMessageRow, so the whole run — header and
              // members together — leaves and returns as one row. The pane wraps
              // it in an addressable `data-work-segment-key` box whose value is
              // the same anchor key as the React key, which is also the
              // timestamp the lazy row publishes as its placeholder anchor.
              if (isWorkSegment(item)) {
                const segmentKey = item.key ?? getMessageKey(item.messages[0]);
                const anchorTimestamp = item.messages[0]?.timestamp;

                return (
                  <LazyMessageRow
                    key={segmentKey}
                    lazyRows={lazyRows}
                    timestamp={anchorTimestamp}
                    anchorId={item.messages[0] ? messageAnchorId(item.messages[0]) : null}
                    initiallyNearViewport={initiallyNearViewport}
                    estimatedHeightPerMessage={pxPerMessage}
                    messageCount={item.messages.length}
                  >
                    {/* The scrollbar's drawn length is a share of how much of the
                        conversation the viewport shows, and a collapsed segment
                        stands for all of its members — so the count travels with
                        the row instead of being guessed from the row count. */}
                    <div data-work-segment-key={segmentKey} data-transcript-row-messages={item.messages.length}>
                      <WorkSegmentRecord
                        segment={item}
                        expanded={expandedSegmentKeys.has(segmentKey)}
                        onToggle={(next) => toggleSegment(segmentKey, next)}
                        renderMember={(message) => (
                          <MessageComponent
                            message={message}
                            prevMessage={prevMessageFor.get(message) ?? null}
                            createDiff={createDiff}
                            onFileOpen={onFileOpen}
                            onShowSettings={onShowSettings}
                            onGrantToolPermission={onGrantToolPermission}
                            showRawParameters={showRawParameters}
                            showThinking={showThinking}
                            selectedProject={selectedProject}
                            provider={provider}
                            onEditMessage={onEditMessage}
                            onForkFromMessage={onForkFromMessage}
                            isInFlightTurn={inFlightTurnMessages?.has(message) ?? false}
                          />
                        )}
                      />
                    </div>
                  </LazyMessageRow>
                );
              }

              // A message a resident process is holding. Its own component,
              // because it is not a turn: it has a state the host keeps
              // updating, an action no other row has, and — in two of its three
              // states — no message to draw at all.
              if (item.type === RESIDENT_PENDING_MESSAGE_TYPE) {
                return (
                  <LazyMessageRow
                    key={getMessageKey(item)}
                    lazyRows={lazyRows}
                    timestamp={item.timestamp}
                    initiallyNearViewport={initiallyNearViewport}
                  >
                    <PendingResidentMessage
                      message={item}
                      onWithdraw={onWithdrawResidentCommand}
                    />
                  </LazyMessageRow>
                );
              }

              return (
                <LazyMessageRow
                  key={getMessageKey(item)}
                  lazyRows={lazyRows}
                  timestamp={item.timestamp}
                  anchorId={messageAnchorId(item)}
                  initiallyNearViewport={initiallyNearViewport}
                  estimatedHeightPerMessage={pxPerMessage}
                >
                  <MessageComponent
                    message={item}
                    prevMessage={prevMessageFor.get(item) ?? null}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                    onEditMessage={onEditMessage}
                    onForkFromMessage={onForkFromMessage}
                    isInFlightTurn={inFlightTurnMessages?.has(item) ?? false}
                  />
                </LazyMessageRow>
              );
            })}
          </>
        )}

        {/*
          The running turn's status, in the message flow and after the last row, so
          it scrolls with the transcript and never covers a message. It is the only
          activity surface at every viewport now: the composer's floating tab is
          gone, and this row carries the running turn's own Stop. The Stop belongs
          to the TURN rather than to the composer, which is why it is here — Live
          Voice replaces the composer (and its submit-button Stop) with the voice
          bar, and the turn it started there must still be stoppable.

          Mounted for the whole time the pane is, with `activity` set to null while
          the turn is over or a permission request has taken over the status: the
          component owns the exit animation, and unmounting it here would cut that
          animation short and pop the row out instead of collapsing it.

          Inside the content column on purpose — that is the box the transcript's
          content-growth follow observes, so the row appearing and its elapsed
          reading widening are growth the follow answers for free, under the same
          "the user has not scrolled away" gate as every other growth.
        */}
        <ActivityIndicator
          activity={hasActivityIndicator ? activity : null}
          sessionId={activeSessionId}
          sendFailed={sendFailed}
          foregroundTool={foregroundTool}
          canStop={canStopTurn}
          onStop={onStopTurn}
        />
        </div>
      </div>

    </div>
  );
}

export default memo(ChatMessagesPane);
