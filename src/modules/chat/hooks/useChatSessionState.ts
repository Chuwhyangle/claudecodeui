import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { api } from '@/shared/api';
import type { MarkSessionIdle, SessionActivityMap,Project,ProjectSession,LLMProvider,NormalizedMessage,ChatMessage,DiffCalculator,ChatReplayCursorMap,SessionTurnOutline } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { subscribeTargetFor } from '@/modules/chat/utils/session/replayCursor';
import { OLDER_MESSAGES_PAGE_SIZE, planOlderPagePrefetch, SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/session/sessionMessagePagination';
import { createMessageHistoryRefreshCoordinator } from '@/modules/chat/utils/session/messageHistoryRefreshCoordinator';

import { createCachedDiffCalculator } from '@/modules/chat/utils/transcript/messageTransforms';
import { MIN_SNIPPET_LENGTH, findSearchTargetIndex, normalizeSearchSnippet, resolveSearchWindowSize } from '@/modules/chat/utils/transcript/searchTargetLocator';
import { createJumpAnchorLock } from '@/modules/chat/utils/transcript/jumpAnchorLock';
import { messageAnchorId } from '@/modules/chat/utils/transcript/messageKeys';
import { collapseMonitorEventRows, normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import type { JumpAnchorLock } from '@/modules/chat/utils/transcript/jumpAnchorLock';
import type { SearchTarget } from '@/modules/chat/utils/transcript/searchTargetLocator';
import { readSelectedProvider } from '@/shared/selectedProvider';
const INITIAL_VISIBLE_MESSAGES = 100;

/** Messages kept below a search hit so it lands mid-viewport rather than at the edge. */
const SEARCH_TARGET_CONTEXT_MESSAGES = 20;

/**
 * How long the jump waits for the widened window to commit before it gives up.
 *
 * Widening the window can commit thousands of rows on an old hit, each running
 * the markdown pipeline, so the scroll waits about three seconds for that render
 * — the same budget the previous DOM scan used. The wait is spent on animation
 * frames rather than a fixed 150ms step, so a fast commit is placed on the next
 * frame instead of paying the step's whole latency for nothing.
 */
const SEARCH_SCROLL_BUDGET_MS = 3_000;

/**
 * How many messages are loaded on each side of a jump target.
 *
 * Bounded on purpose: a jump is one window read around the id, never a read of
 * the whole transcript. The reader extends the window from there by scrolling,
 * which is what the id-anchored `loadBefore`/`loadAfter` reads are for.
 */
const JUMP_WINDOW_BEFORE = 40;
const JUMP_WINDOW_AFTER = 40;

/**
 * How far above the bottom the viewport may sit and still count as being at the
 * bottom for the content-growth follow below.
 *
 * Deliberately far tighter than `isNearBottom`'s 50px. That threshold decides
 * whether a *new row* may pull the view down; this one decides whether content
 * that grew in place is followed, and the 1–50px band is exactly the drift a
 * wheel gesture creates — following it there is the "it dragged me back"
 * failure. A viewport sitting on the bottom measures 0.
 *
 * The same bound is what a gesture's *direction* is read with: a report that
 * moved the offset up by less than this is not a movement at all.
 */
const TRANSCRIPT_FOLLOW_TOLERANCE_PX = 1;

/**
 * How long a real input event keeps the transcript's `scroll` events attributable
 * to the user.
 *
 * Input does not move the viewport; the browser moves it and reports the move as
 * a `scroll` event, which can trail the wheel or key press by the length of a
 * smooth-scroll animation. Every scroll inside the window re-arms it, so it
 * closes on the frame the gesture really stopped — and a scroll that arrives
 * outside it is one the browser made on its own.
 */
const USER_SCROLL_GESTURE_QUIET_MS = 200;

/**
 * The keys a browser scrolls a scroller with. Counted as intent because pressing
 * one is the user asking to move the viewport, even though the movement itself
 * is the browser's — the same reason a wheel counts and a bare `scroll` does not.
 */
const SCROLL_INTENT_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

/**
 * The half of the set above that asks for *older* content — the keys a browser
 * moves a scroller's viewport up with.
 *
 * A key press is not a movement, and the two halves are not symmetrical in when
 * the movement it causes becomes readable: a key towards the bottom ends at the
 * bottom, which is where the follow wants the viewport anyway and where the
 * `scroll` that reports it is read as the user returning; a key towards the top
 * takes the viewport somewhere no later signal will confirm. So only these
 * detach at the press — see `onKeyDown`.
 *
 * `Home` belongs here and `End` does not: the pair move to opposite ends of the
 * scroller, and the transcript's follow is a claim about one of them.
 */
const SCROLL_UP_INTENT_KEYS = new Set([
  'ArrowUp',
  'PageUp',
  'Home',
]);

/** The scroll container's laid-out geometry, as of one resize. */
type TranscriptGeometry = {
  scrollHeight: number;
  clientHeight: number;
};

/**
 * Finds the rendered row addressed by `anchorId`.
 *
 * The id is read off the persistent row wrapper (`data-message-anchor-id`), so
 * a row whose content is not currently mounted is still found — which is what
 * lets a jump land on a turn the viewport has never reached. A timestamp lookup
 * cannot do this: the two turns a session may stamp with one millisecond are
 * two rows, and only the id tells them apart.
 */
function findRenderedMessageElementById(
  container: HTMLElement,
  anchorId: string,
): HTMLElement | null {
  const candidates = container.querySelectorAll<HTMLElement>('[data-message-anchor-id]');
  for (const candidate of candidates) {
    if (candidate.getAttribute('data-message-anchor-id') === anchorId) {
      return candidate;
    }
  }
  return null;
}

/**
 * The identity a transcript row is addressed by — the one rule the pane, the
 * store and the server all read, defined once in {@link messageAnchorId}. This
 * is the same key the server resolves an `around` read against, so a row found
 * in the DOM by this value is the row that read fetched — two turns sharing a
 * millisecond are still two keys.
 */
const anchorIdOf = (message: ChatMessage): string | null => messageAnchorId(message);

/**
 * Resolves a sidebar search hit to the transcript anchor id it should jump to.
 *
 * A hit carries a snippet and a timestamp but no id, so the id is derived from
 * what the client already holds: the loaded transcript first (an exact message
 * match), then the session's user-turn outline (a turn whose preview carries
 * the snippet, else the nearest turn by timestamp). Both reads are local — the
 * whole transcript is never pulled just to resolve one hit.
 *
 * The snippet is checked before the timestamp at both steps, because only a
 * snippet names one row: the loaded window is a slice, so the row nearest an
 * old hit's instant inside it is the window's oldest row; and two turns of a
 * session may share a millisecond, so within the outline the nearest instant is
 * the *first* of the pair while the addressed turn is the one whose preview
 * carries the hit's snippet. The timestamp is the fallback for a hit with no
 * snippet, or one whose snippet no preview carries.
 */
function resolveSearchTargetAnchorId(
  target: SearchTarget,
  loadedMessages: ChatMessage[],
  outline: SessionTurnOutline | null,
): string | null {
  const loadedIndex = findSearchTargetIndex(loadedMessages, target, { allowTimestampFallback: false });
  if (loadedIndex >= 0) {
    const anchorId = anchorIdOf(loadedMessages[loadedIndex]);
    if (anchorId) return anchorId;
  }

  if (!outline) return null;

  if (target.snippet) {
    // The same fragment the loaded-transcript match uses: the outline's preview
    // is capped at that same length, so the phrase has to be cut to it too.
    const phrase = normalizeSearchSnippet(target.snippet);
    if (phrase.length >= MIN_SNIPPET_LENGTH) {
      const turn = outline.turns.find((entry) => entry.preview.toLowerCase().includes(phrase));
      if (turn) return turn.id;
    }
  }

  if (target.timestamp) {
    const targetTime = new Date(target.timestamp).getTime();
    if (Number.isFinite(targetTime)) {
      let nearestId: string | null = null;
      let nearestDistance = Infinity;
      for (const turn of outline.turns) {
        const turnTime = new Date(turn.timestamp).getTime();
        if (!Number.isFinite(turnTime)) continue;
        const distance = Math.abs(turnTime - targetTime);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestId = turn.id;
        }
      }
      if (nearestId) return nearestId;
    }
  }

  return null;
}
/** Stable empty list so `chatMessages` keeps its identity while no session is selected. */
const NO_MESSAGES: NormalizedMessage[] = [];

type UseChatSessionStateArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Per-session replay cursor; sent as `lastSeq` (plus `runId`) on subscribe. */
  lastSeqRef: MutableRefObject<ChatReplayCursorMap>;
  sessionStore: SessionStore;
};

type ScrollRestoreState = {
  height: number;
  top: number;
  anchor: HTMLElement | null;
  anchorOffset: number | null;
};

function captureScrollRestoreState(container: HTMLDivElement): ScrollRestoreState {
  const containerBounds = container.getBoundingClientRect();
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('.chat-message'))
    .find((element) => element.getBoundingClientRect().bottom >= containerBounds.top)
    ?? null;

  return {
    height: container.scrollHeight,
    top: container.scrollTop,
    anchor,
    anchorOffset: anchor
      ? anchor.getBoundingClientRect().top - containerBounds.top
      : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
    // Survives the truncation that follows an edit, which clears every other
    // live row.
    replacesAnchorId: msg.replacesAnchorId,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
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
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  /**
   * Watches the transcript's geometry for growth that adds no row — a streaming
   * answer extending the row already on screen, a markdown re-render replacing
   * it with a taller one, an image loading into it. The row-count effects below
   * never see any of those, so they are the one path that keeps a pinned
   * transcript pinned. Torn down with the content column it is attached to.
   */
  const transcriptObserverRef = useRef<ResizeObserver | null>(null);
  /**
   * The pane the current observer has been pointed at, so the layout effect below
   * wires it exactly once and the baseline the follow judges against survives the
   * re-renders that follow.
   */
  const observedContainerRef = useRef<HTMLElement | null>(null);
  /**
   * The geometry of the last layout the follow judged against. `null` until
   * something has been measured, which is what tells the first callback that
   * there is no earlier layout to be "at the bottom" of.
   */
  const transcriptGeometryRef = useRef<TranscriptGeometry | null>(null);
  /** The frame the observer-driven follow writes its scroll offset in, so a burst of growths coalesces. */
  const followFrameRef = useRef<number | null>(null);
  const wasNearTopRef = useRef(false);
  // The jump owns the viewport until it has placed it. Ref rather than state
  // because the follow and the initial scroll read it synchronously inside
  // effects and layout effects, where a state update from this same commit
  // would not yet be visible.
  const searchScrollActiveRef = useRef(false);
  /**
   * The pending step of the search-jump retry chain, so a session change can
   * cancel a jump that belongs to the transcript the user just left.
   */
  const searchScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The animation frame the jump's placement retry chain is waiting on. A frame
   * rather than a timeout: the wait is for React to commit the widened window,
   * which happens on a frame, so the placement lands the moment it can without
   * a fixed step's dead time in front of it.
   */
  const searchScrollFrameRef = useRef<number | null>(null);
  /**
   * The correction window the jump opens once it has placed its target.
   *
   * The first write centres the target against the window's placeholders; the
   * frames that follow replace those placeholders with real content and move the
   * row, so the jump keeps correcting it until the window settles. Built once and
   * reused — one lock serves one jump at a time. Its end releases the jump's claim
   * on the viewport, whether the window timed out, the row left the DOM, or the
   * user took the pane back.
   */
  const jumpLockRef = useRef<JumpAnchorLock | null>(null);
  /**
   * `isUserScrolledUp` readable from a timer callback. Both deferred
   * scroll-to-bottom calls are armed while the user is at the bottom and fire
   * tens to hundreds of milliseconds later; without re-reading this at fire
   * time, a scroll-up inside that window is silently undone.
   */
  const isUserScrolledUpRef = useRef(false);
  /**
   * True while a real input gesture is moving the transcript. Only the input
   * handlers and the scroll events that follow them open it; a `scroll` the
   * browser raised for its own scroll anchoring or clamping does not, which is
   * what keeps a row shrinking above the viewport from reading as the user
   * leaving the bottom.
   */
  const userScrollGestureRef = useRef(false);
  /** Closes the gesture window once the scrolling it caused has stopped. */
  const userScrollGestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * How many `scroll` reports the app's own scrollTop writes still owe.
   *
   * A write and a gesture raise the same event, and the restore a prepend ends
   * with lands on the bottom — exactly where a user who scrolled there sits — so
   * the event cannot be told apart by where it landed. It can by knowing the app
   * just wrote one: every programmatic write adds to this, every `scroll` takes
   * one off instead of being read as intent, and every real input clears it, so a
   * wheel that arrives right after a write is still read normally. The browser
   * coalesces the reports a burst of writes raises, so the count can only ever be
   * too large — and the reports it swallows are ones the app caused anyway.
   */
  const programmaticScrollEchoesRef = useRef(0);
  /**
   * The offset the pane last reported, which a gesture's *direction* is read
   * against.
   *
   * A scroll report says the viewport moved, not where the user meant to put it:
   * a wheel of thirty pixels leaves the pane inside the band a distance
   * threshold still calls "at the bottom", and the size of the movement is
   * exactly what must not decide. Direction is the one thing the report still
   * carries on its own, so it is read here — against the offset the previous
   * report left, not against a distance to the bottom.
   *
   * Seeded with the pane's own offset when it is attached, so the first gesture
   * after a session opens is not compared against an offset the pane never had.
   */
  const observedScrollTopRef = useRef(0);
  /**
   * The offset the app last put the viewport at.
   *
   * A deferred placement is armed while the app is at the bottom and fires tens
   * to hundreds of milliseconds later, and the movement that took the viewport
   * away in that window is not always readable from the intent state yet: the
   * browser moves the offset as a key's default action and reports the `scroll`
   * with a later frame, so at fire time a keyboard gesture the app has already
   * seen still looks like "nobody touched the pane". Comparing the pane's offset
   * against the one the app itself placed last is what tells those two apart —
   * and it never consults the distance to the bottom, which is the band a small
   * gesture lands inside.
   *
   * Written after the assignment, so the value is the offset the browser
   * clamped to rather than the one that was asked for, and re-seated whenever
   * the follow is claimed (`isUserScrolledUp` turning off) or the session
   * changes, so a placement is judged against this transcript and this moment.
   */
  const lastPlacedTopRef = useRef(0);
  /**
   * Places the viewport on the app's behalf, and takes responsibility for the
   * `scroll` that follows.
   *
   * Every scrollTop the app writes goes through here, so the echo count above
   * stays true to what the pane reported: the restore that follows a prepend, a
   * pin, the scroll-to-bottom writes and the initial settle are one mechanism
   * from the intent listener's point of view.
   */
  const writeScrollTop = useCallback((container: HTMLElement, next: number) => {
    programmaticScrollEchoesRef.current += 1;
    container.scrollTop = next;
    lastPlacedTopRef.current = container.scrollTop;
  }, []);

  /**
   * Ends the jump's ownership of the viewport.
   *
   * Called when the jump cannot place its target at all, and — through the
   * correction window's own end — when the window times out, the row leaves the
   * DOM, or the user takes the pane back. The claim is what keeps the follow and
   * the window readers off the scrollTop the jump is driving, so releasing it is
   * the single point at which normal scrolling resumes.
   */
  const releaseJump = useCallback(() => {
    searchScrollActiveRef.current = false;
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    if (searchScrollFrameRef.current !== null) {
      cancelAnimationFrame(searchScrollFrameRef.current);
      searchScrollFrameRef.current = null;
    }
    // Idempotent: a window that already ended is left alone, so this never fires
    // the window's own end callback a second time.
    jumpLockRef.current?.release();
  }, []);

  if (jumpLockRef.current === null) {
    jumpLockRef.current = createJumpAnchorLock({
      writeScrollTop,
      onEnd: () => {
        searchScrollActiveRef.current = false;
        searchScrollTimerRef.current = null;
        searchScrollFrameRef.current = null;
      },
    });
  }
  const isLoadingMoreRef = useRef(false);
  /** Guards the detached-window's own newer-page read, the mirror of `isLoadingMoreRef`. */
  const isLoadingNewerRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  /**
   * The scroll position an older-page fetch was armed at, or null when none is in flight or
   * pending. Held as the position rather than a bare flag so the release can be "the anchor
   * restore moved the viewport back down past where the fetch started" — a flag released on a
   * fixed threshold would stall on a pane whose prepended page is shorter than the prefetch band.
   */
  const topLoadLockRef = useRef<number | null>(null);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * The session key whose first page this hook has requested but not yet seen
   * land, or null when no such request is outstanding.
   *
   * `lastLoadedSessionKeyRef` alone cannot answer "have we already asked for
   * this session's first page?": it is stamped when the request is *issued*, so
   * while that request is in flight the slot still has no `fetchedAt` and the
   * effect looks unhydrated. Any re-entry in that window — a session-list
   * refresh handing back a new `selectedProject` object, say — then issues a
   * second page. The duplicate is enqueued behind the first, so it lands last
   * and overwrites whatever window the store holds by then, including the one a
   * jump loaded in between. One outstanding first page per session, tracked
   * here, is what makes re-entry a no-op.
   */
  const inFlightFirstPageKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> ProjectWorkspaceRoute -> WorkspaceMain -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = null;
    pendingScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = true;
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  const isActiveRef = useRef(isActive);
  const activeSessionIdRef = useRef(activeSessionId);
  isActiveRef.current = isActive;
  activeSessionIdRef.current = activeSessionId;

  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<boolean | void>>(
    async () => true,
  );
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === sessionId
      ),
    });
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      if (slot.tokenUsage !== undefined) {
        setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
      }
    }
    return !result.deferred;
  };

  const refreshCoordinatorRef = useRef<ReturnType<typeof createMessageHistoryRefreshCoordinator> | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      (sessionId) => latestRefreshExecutorRef.current(sessionId),
      (sessionId) => isActiveRef.current && activeSessionIdRef.current === sessionId,
    );
  }

  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = isActiveRef.current) => {
    // A drag or a jump owns the viewport: refreshing the tail would replace the
    // very window the gesture is scrolling, and its read would race the window
    // read the gesture is waiting on.
    if (searchScrollActiveRef.current) return Promise.resolve();
    return refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve();
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  /**
   * Optimistic user rows whose send was never delivered, by store row id.
   *
   * A row the composer added at send time but the server never took is not part
   * of the conversation: it stays in the store — so a retry can re-show it
   * rather than mint a duplicate — but it is left out of the transcript until
   * then. The id is the one `addMessage` handed back, which is the same row the
   * retry puts back with {@link restoreUserTurn}.
   */
  const [undeliveredUserIds, setUndeliveredUserIds] = useState<readonly string[]>([]);

  const markUserTurnUndelivered = useCallback((id: string) => {
    setUndeliveredUserIds((previous) => (previous.includes(id) ? previous : [...previous, id]));
  }, []);

  const restoreUserTurn = useCallback((id: string) => {
    setUndeliveredUserIds((previous) => (previous.includes(id) ? previous.filter((rowId) => rowId !== id) : previous));
  }, []);

  // Hidden Chat tabs keep collecting realtime rows without re-rendering the
  // CSS-hidden tree. Activation itself renders once and reads the latest cache.
  const activeSessionForStore = isActive ? activeSessionId : null;
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionForStore !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionForStore;
    sessionStore.setActiveSession(activeSessionForStore);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : NO_MESSAGES;

  // A row whose send was never delivered is withheld from the transcript — it is
  // not a turn the conversation has. The store keeps it so a retry can re-show
  // the same row; this is the only place it is hidden.
  const visibleStoreMessages = useMemo(
    () => (undeliveredUserIds.length === 0
      ? storeMessages
      : storeMessages.filter((message) => !undeliveredUserIds.includes(message.id))),
    [storeMessages, undeliveredUserIds],
  );

  const chatMessages = useMemo(() => {
    // Monitor events fold into one row per task on the render path only; the
    // projection underneath stays lossless so search, export and anchors still
    // see every raw event.
    const all = collapseMonitorEventRows(normalizedToChatMessages(visibleStoreMessages));
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    return all;
  }, [visibleStoreMessages, pendingUserMessage]);

  /* ---------------------------------------------------------------- */
  /*  addMessage                                                       */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage): string | null => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one. An
      // unaddressed row has no store id to hand back, so a send that added it
      // cannot take it back; the composer falls back to leaving it in place.
      setPendingUserMessage(msg);
      return null;
    }
    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
      return normalized.id;
    }
    return null;
  }, [activeSessionId, sessionStore]);

  // Mirrors the state into a ref so the two deferred scroll-to-bottom timers
  // can re-read it at fire time. An effect rather than assignments next to each
  // `setIsUserScrolledUp` call, because the setter is also returned from this
  // hook and driven from the composer.
  useEffect(() => {
    const wasDetached = isUserScrolledUpRef.current;
    isUserScrolledUpRef.current = isUserScrolledUp;
    // Following again — the user arriving back at the bottom, a send, the
    // button, a search jump being superseded — re-seats what "where the app
    // last put it" means. The placements armed from this point are judged
    // against where the pane stands now, so a send made from part-way up still
    // lands on the bottom, and only a movement up *after* the claim counts as
    // the user leaving.
    if (wasDetached && !isUserScrolledUp) {
      const container = scrollContainerRef.current;
      if (container) lastPlacedTopRef.current = container.scrollTop;
    }
  }, [isUserScrolledUp]);

  /**
   * Judges a transcript resize: is this a growth the viewport was pinned across,
   * and if so, where does the viewport belong now?
   *
   * What this reads is geometry, and deliberately so: no branch below reads the
   * message count, the last row's text, or a store flush, because a judgement
   * made against those would be a judgement about the render rather than about
   * the box the user is looking at.
   *
   * The judgement is made against the layout *before* the resize, and against
   * the user's intent rather than the current geometry. By the time this runs the
   * box has already changed, so asking the current geometry "is the viewport at
   * the bottom?" would answer about the gap the resize itself just opened.
   * Instead the viewport's offset is compared with the bottom of the previously
   * measured layout: equal means the resize happened under a viewport that was
   * pinned and is followed, anything above means a gesture created that drift and
   * keeps it — the growth then simply opens the gap the user was holding. A
   * viewport the user has left is not followed at all, whatever the offset says.
   *
   * What the caller does with the answer is the caller's business: the two
   * triggers below want different things from the same judgement — one defers the
   * write to the frame, the other cannot defer it — so this returns the offset
   * rather than writing it. `null` is the answer for every resize that must be
   * left alone, including the one that is already at the bottom.
   */
  const judgeTranscriptGrowth = useCallback((): { container: HTMLDivElement; bottom: number } | null => {
    const container = scrollContainerRef.current;
    if (!container || !isActiveRef.current) return null;
    // A restore or a search jump owns the viewport until it has placed it. A pin
    // written first would land the transcript where the user did not ask to be,
    // and the restore would then read that offset as the position to keep.
    if (pendingScrollRestoreRef.current || searchScrollActiveRef.current) return null;
    if (isLoadingMoreRef.current) return null;

    const previous = transcriptGeometryRef.current;
    transcriptGeometryRef.current = {
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    };
    if (!previous) return null;

    // Whether the user is following is a question about intent, answered by the
    // input-source listener, and never re-derived from the geometry this call is
    // looking at: by the time it runs the box has already changed, so the gap it
    // measures is the one the change itself opened, and asking it "is the
    // viewport still at the bottom?" would answer no for every resize the follow
    // exists to answer yes to. The offset comparison below is a separate, second
    // guard for a viewport a gesture moved since the last layout.
    if (isUserScrolledUpRef.current) return null;

    const previousBottom = Math.max(previous.scrollHeight - previous.clientHeight, 0);
    // The second guard only fires while a gesture is in flight. A scrollTop that
    // drifted with no input in front of it is the browser's own — scroll
    // anchoring, a clamp — not the user taking the pane, and refusing the follow
    // over it is the bug: a new row lands a few pixels below the recorded bottom,
    // this guard calls that drift "the user left", and the whole reply is then
    // never followed.
    if (
      userScrollGestureRef.current
      && Math.abs(container.scrollTop - previousBottom) > TRANSCRIPT_FOLLOW_TOLERANCE_PX
    ) return null;

    const bottom = container.scrollHeight - container.clientHeight;
    if (Math.abs(container.scrollTop - bottom) <= TRANSCRIPT_FOLLOW_TOLERANCE_PX) return null;
    return { container, bottom };
  }, []);

  /**
   * Answers a resize the observer delivered, one frame after it was delivered.
   *
   * The deferral is the whole reason this trigger keeps its own copy of the
   * decision: the notification arrives with the frame's layout, and the frame is
   * where a gesture can still land, so the pane's offset is re-read at write time
   * and a viewport taken back in between is left where the gesture put it. The
   * cost is that the growth is painted once before the write lands — which is why
   * the growth this component committed itself is answered by the layout effect
   * below instead, in the commit, where there is no frame to lose it in.
   */
  const followTranscriptGrowth = useCallback(() => {
    const plan = judgeTranscriptGrowth();
    if (!plan) return;

    if (followFrameRef.current !== null) return;
    const observedTop = plan.container.scrollTop;
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      const current = scrollContainerRef.current;
      if (!current) return;
      // Content growth never moves scrollTop; only a gesture does. Anything
      // above where it sat when the resize was observed is the user taking the
      // viewport back — re-pinning over it is the bug, so it is checked here at
      // write time rather than assumed from the resize.
      if (current.scrollTop < observedTop - TRANSCRIPT_FOLLOW_TOLERANCE_PX) return;
      writeScrollTop(current, current.scrollHeight - current.clientHeight);
    });
  }, [judgeTranscriptGrowth, writeScrollTop]);

  /**
   * Starts watching the transcript's geometry.
   *
   * Handed to React as the content column's ref, so it is called with the node
   * when that column enters the tree and with null when it leaves — the whole
   * teardown, since the observer holds no reference to either node.
   */
  const attachScrollContent = useCallback((node: HTMLDivElement | null) => {
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
    transcriptObserverRef.current?.disconnect();
    transcriptObserverRef.current = null;
    transcriptGeometryRef.current = null;
    observedContainerRef.current = null;

    // jsdom ships no ResizeObserver; the follow is simply unavailable there
    // rather than a render-time crash for every test that mounts the pane.
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(followTranscriptGrowth);
    observer.observe(node);
    transcriptObserverRef.current = observer;
  }, [followTranscriptGrowth]);

  /**
   * Points the follow's observer at the pane the transcript scrolls in.
   *
   * The pane is watched as well as the content column: a box that gets shorter —
   * a growing composer, the activity indicator's padding, a software keyboard —
   * opens the same gap from the other side, while the content column's own height
   * never changes. Nothing else can see it either: a pane that got shorter needs
   * no clamp, so the browser raises no `scroll` for it, and every listener the
   * intent machinery has is behind one.
   *
   * Not done from the ref callback that builds the observer: the content column is
   * the pane's own child, and React commits a child's ref callback before its
   * parent's, so the pane's ref is still null there — and that callback's identity
   * never changes, so it is never called again to pick the pane up later. A layout
   * effect runs once the whole commit has landed, when both nodes are attached.
   */
  useLayoutEffect(() => {
    const observer = transcriptObserverRef.current;
    const container = scrollContainerRef.current;
    // Once per observer and pane: re-seeding the baseline on every render would
    // erase the layout the follow judges a resize against.
    if (!observer || !container || observedContainerRef.current === container) return;
    observedContainerRef.current = container;
    // The direction a gesture is read with is relative to where the pane already
    // is, so the baseline is seeded from the pane here rather than left at zero:
    // a session that opens part-way up would otherwise read its first wheel as a
    // move towards the bottom.
    observedScrollTopRef.current = container.scrollTop;
    if (!transcriptGeometryRef.current) {
      // Seeded rather than left to the observer's first callback, so a resize
      // delivered in the same batch as that callback cannot be mistaken for the
      // baseline.
      transcriptGeometryRef.current = {
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      };
    }
    observer.observe(container);
  });

  /**
   * Follows the growth this component itself just committed.
   *
   * A row that streams grows inside the commit that re-rendered it, and the
   * observer's report of that growth arrives with a later frame's layout — a
   * frame in which a reader sampling the pane from its own callback (how the
   * transcript's pinning is measured, and how anything else watching a stream
   * would read it) can still catch the box grown out from under a viewport that
   * was on the bottom. React runs this effect in the same task as the DOM change
   * it followed, before the browser gets the frame, so the offset is already at
   * the bottom by the time any other task reads the pane; the observer's own
   * callback then finds the pane already there and schedules nothing.
   *
   * Written immediately rather than deferred, and that is not a lost guard: a
   * gesture cannot run inside this task, so there is no window for one to land
   * in. A gesture made before the commit has already moved the offset, which is
   * what the judgement above reads as the user holding the gap.
   *
   * Depends on the transcript this render was handed rather than on the layout:
   * the growth of a streaming row *is* a change to that list, so the flush that
   * grew it is exactly the render this runs in, and the renders that cannot have
   * moved anything re-run it into an early return. Growth this component did not
   * commit — an image finishing, the composer changing height — is still the
   * observer's to answer.
   */
  useLayoutEffect(() => {
    const plan = judgeTranscriptGrowth();
    if (plan) writeScrollTop(plan.container, plan.bottom);
  }, [judgeTranscriptGrowth, chatMessages]);

  /**
   * Puts the viewport on the bottom and settles the intent itself.
   *
   * The app placing the viewport on the bottom is the app asserting that the
   * user is following: the scroll this write raises carries no gesture with it
   * and is deliberately not read as one, because a programmatic write is not
   * evidence either way.
   */
  const placeTranscriptAtBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    setIsUserScrolledUp(false);
    writeScrollTop(container, container.scrollHeight);
  }, [writeScrollTop]);

  /**
   * The placement the app defers: armed while the user was following — a send's
   * new row, an arriving row, an external refresh's tail — and fired a moment
   * later, by which time the pane may no longer belong to the follow.
   *
   * The state is what the app knows the intent to be; the offset is what the
   * pane has done since the app last placed it, and that is the half which
   * catches a gesture the app has *seen* but not yet been *told* about — a key
   * moves the offset as its default action while the `scroll` it raises waits
   * for the next frame, so at fire time the intent still reads "following" over
   * a pane the user has already taken. Firing there is exactly the bug this
   * refuses: the deferred write lands on top of a gesture the user just made,
   * inside the window a small gesture is asserting itself in.
   *
   * The offset guard is skipped when the pane is already at the bottom. A turn
   * settling shrinks the content — or grows the pane — by a couple of pixels,
   * and the browser clamps the offset down to that new bottom, a `scroll` nobody
   * caused. `lastPlacedTopRef` does not follow the clamp, so the offset reads as
   * "moved up" by exactly the few pixels the clamp took — the one case where
   * "below where the app last placed it" is still the bottom. At the bottom is
   * at the bottom, whichever of the two put it there.
   */
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (isUserScrolledUpRef.current) return;
    const atBottom = Math.abs(
      container.scrollHeight - container.scrollTop - container.clientHeight
    ) <= TRANSCRIPT_FOLLOW_TOLERANCE_PX;
    if (!atBottom && container.scrollTop < lastPlacedTopRef.current - TRANSCRIPT_FOLLOW_TOLERANCE_PX) return;
    placeTranscriptAtBottom();
  }, [placeTranscriptAtBottom]);

  const scrollToBottomAndReset = useCallback(() => {
    // Unguarded, unlike the deferred placement above: this is the control the
    // user pressed, and a control that says "to the bottom" is the user asking
    // to be there from wherever they are — the very state the guards refuse.
    //
    // When the reader jumped into the middle of the transcript the window no
    // longer holds the tail at all, so placing the viewport on the current
    // content's bottom would land on the *window's* bottom, not the
    // conversation's. The held window is dropped for the newest page first;
    // once it is re-attached the deferred placement settles on the real tail.
    const sessionId = activeSessionIdRef.current;
    const heldSlot = sessionId ? sessionStore.getSessionSlot(sessionId) : undefined;
    if (sessionId && heldSlot && heldSlot.attached === false) {
      void sessionStore.jumpToLatest(sessionId).then(() => {
        if (activeSessionIdRef.current === sessionId) placeTranscriptAtBottom();
      });
    } else {
      placeTranscriptAtBottom();
    }
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, placeTranscriptAtBottom, sessionStore]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  /**
   * Opens — and keeps open — the window in which the transcript's scroll events
   * count as the user's.
   */
  const noteUserScrollInput = useCallback(() => {
    userScrollGestureRef.current = true;
    if (userScrollGestureTimerRef.current) clearTimeout(userScrollGestureTimerRef.current);
    userScrollGestureTimerRef.current = setTimeout(() => {
      userScrollGestureTimerRef.current = null;
      userScrollGestureRef.current = false;
    }, USER_SCROLL_GESTURE_QUIET_MS);
  }, []);

  /**
   * Records the user's scroll intent from the events that can carry it.
   *
   * Which events those are is the whole judgement: a wheel, a touch drag or a
   * scroll key is the user asking to move the viewport, while a bare `scroll` is
   * only a report that it moved. The browser raises that report for its own work
   * too — scroll anchoring and clamping move the offset with nobody touching the
   * page — so a transcript that read every `scroll` as intent detaches when a row
   * above the viewport shrinks, and stops following the row that then grows.
   * Discriminating on the *source* rather than on the offset a report landed at
   * is therefore the point: the browser's scroll decreases scrollTop here,
   * exactly like a wheel-up would, so only the input in front of it says whose
   * movement it was. Which *way* it moved is the other half, and it is read from
   * the offset the report carries rather than from the distance to the bottom —
   * a gesture of a few pixels is a gesture.
   *
   * The listener is on the window so it also sees the input that starts a
   * gesture outside the pane, and so a scroll of the pane is attributed no matter
   * which of the pane's own listeners is attached.
   */
  useEffect(() => {
    const isPaneScroll = (event: Event) => (
      Boolean(scrollContainerRef.current) && event.target === scrollContainerRef.current
    );
    /** The listeners are on the window, so only a wheel aimed at the pane counts. */
    const isOverPane = (event: Event) => {
      const container = scrollContainerRef.current;
      const target = event.target;
      return container !== null && target instanceof Node && container.contains(target);
    };

    const onScroll = (event: Event) => {
      if (!isPaneScroll(event)) return;
      const container = scrollContainerRef.current;
      if (!container) return;
      // Every report moves the baseline the next direction is read against, and
      // that includes the reports the app's own writes owe: the offset they
      // carried is the one the user's next gesture starts from.
      const previousTop = observedScrollTopRef.current;
      observedScrollTopRef.current = container.scrollTop;
      // A report the app's own write owes is the app placing the viewport, not
      // the user. The restore a prepend ends with is the case this exists for:
      // it lands on the bottom — where a user who scrolled there sits — while
      // the gesture that asked for the prepend is still the newest input, so
      // reading it would hand the viewport straight back to the follow.
      if (programmaticScrollEchoesRef.current > 0) {
        programmaticScrollEchoesRef.current -= 1;
        return;
      }
      // A scroll inside the window is the gesture still moving the viewport —
      // smooth scrolling reports itself over many frames — so it extends the
      // window until the viewport really stops, and the intent it records is the
      // one the gesture ended on.
      if (!userScrollGestureRef.current) return;
      noteUserScrollInput();
      // The judgement is the direction of the movement, never the distance that
      // is left to the bottom. A wheel of a few pixels leaves the pane inside
      // the band a distance threshold still reads as "at the bottom", and
      // answering that with "still following" hands the viewport straight back
      // to the next growth: the user asked to be away from the bottom, however
      // slightly, and staying away until they come back is the whole contract.
      if (container.scrollTop < previousTop - TRANSCRIPT_FOLLOW_TOLERANCE_PX) {
        setIsUserScrolledUp(true);
        return;
      }
      // Coming back down is the user returning, and only an arrival counts: a
      // wheel down that stops short of the bottom leaves the intent where it
      // was, so the gap it did not close is not closed by the follow either.
      if (isNearBottom()) setIsUserScrolledUp(false);
    };
    /**
     * Real input: whatever the app wrote before this is no longer the newest
     * thing to have happened to the viewport, so the reports it owed stop being
     * owed. The wheel is the one handler that also carries a direction.
     *
     * A jump's correction window is ended here too, at the input: the window
     * exists to hold the viewport still while the jumped-to window settles, and a
     * gesture is the user saying they would rather it did not. Ending it at the
     * input rather than at the next frame is what keeps the correction from
     * pulling the pane back on top of the move the user just made.
     */
    const noteInput = () => {
      programmaticScrollEchoesRef.current = 0;
      jumpLockRef.current?.release();
      noteUserScrollInput();
    };
    const onWheel = (event: WheelEvent) => {
      noteInput();
      // A wheel up over the transcript is the user reaching for older messages.
      // On a first screen with nothing to scroll — the shape this exists for —
      // the pane reports no scroll at all: the offset never moves, so neither
      // the scroll-driven reading of intent nor any comparison of offsets can
      // see the gesture. The wheel is the whole evidence, and waiting for a
      // scroll that a pane with no scrollbar will never raise would leave the
      // intent on "follow" across the prepend and across the restore that
      // follows it.
      if (event.deltaY < 0 && isOverPane(event) && hasMoreMessages && !allMessagesLoadedRef.current) {
        setIsUserScrolledUp(true);
      }
    };
    const onTouch = (event: Event) => {
      if (isOverPane(event)) noteInput();
    };
    // A scrollbar drag is a gesture with no wheel and no key behind it: the
    // pointer press is the only evidence there is, and the scroll events that
    // follow it are what carry the intent.
    //
    // The press has to land on the pane for that to hold. A press anywhere else
    // — the composer's send button, a toolbar, the sidebar — is not evidence
    // about the transcript, and the window it opened would let the browser's own
    // scrolling be read as the user's: a row above the viewport collapsing while
    // the reply streams moves the offset up with nobody touching the page, and
    // the transcript then stops following the reply the user just sent.
    const onPointerDown = (event: Event) => {
      if (isOverPane(event)) noteInput();
    };
    /**
     * Records the user's intent from a scroll key, and takes the *up* half of it
     * at the key rather than at the report.
     *
     * The `scroll` a key raises is the one report that cannot be waited for. A
     * key moves the viewport as its *default action*, and the browser animates
     * that movement, so the report trails the press by a frame or more — and
     * over that frame the pane still sits wherever the app last placed it while
     * the app has already seen the input. A commit landing in the window passes
     * both of the follow's gates and pins the viewport back down over the key
     * the user is holding: the offset has not moved yet, so the comparison that
     * would read the drift has nothing to read, and the intent still says
     * "following", which is only true until the report arrives.
     *
     * So an up key over the pane detaches here, in the task the input landed in.
     * The ref is written beside the state because the two are read at different
     * points in a commit and the gap between them is exactly this window: the
     * pin is judged in a layout effect, while the ref is mirrored from the state
     * by a passive effect that React runs after it, so a state-only write would
     * still leave the very commit this exists for reading the old value.
     *
     * Only an up key, and only over the pane. A key towards the bottom is the
     * user returning, and the `scroll` it raises is read as that arrival exactly
     * as before — detaching on one would strand the follow until some later
     * input undid it. And an `ArrowUp` belongs to the composer's caret, or to
     * any other control on the page, unless it was aimed at the transcript.
     */
    const onKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_INTENT_KEYS.has(event.key)) return;
      noteInput();
      // `isOverPane` is true for the pane itself as well as its descendants,
      // which is what a focused scroller reports as the key's target.
      if (!SCROLL_UP_INTENT_KEYS.has(event.key) || !isOverPane(event)) return;
      setIsUserScrolledUp(true);
      isUserScrolledUpRef.current = true;
    };

    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('touchstart', onTouch, { capture: true, passive: true });
    window.addEventListener('touchmove', onTouch, { capture: true, passive: true });
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('touchstart', onTouch, true);
      window.removeEventListener('touchmove', onTouch, true);
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      if (userScrollGestureTimerRef.current) {
        clearTimeout(userScrollGestureTimerRef.current);
        userScrollGestureTimerRef.current = null;
      }
      userScrollGestureRef.current = false;
    };
  }, [hasMoreMessages, isNearBottom, noteUserScrollInput]);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!isActive) return false;
      // A drag owns the viewport: the reader is moving through the conversation,
      // and a page read armed by where its clamp landed would restore the offset
      // against the pointer's position.
      if (searchScrollActiveRef.current) return false;
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (!selectedSession || !selectedProject) return false;

      // Detached from the tail — the reader jumped into the middle of the
      // transcript — "older" means extending the held window toward its front,
      // not a tail-relative page. The window no longer starts at offset 0, so a
      // `fetchMore` page would be stitched into the middle of the conversation;
      // the id-anchored `loadBefore` re-reads around the window's first row and
      // keeps it flush however much `total` moved underneath.
      const heldSlot = sessionStore.getSessionSlot(selectedSession.id);
      if (heldSlot && heldSlot.attached === false) {
        if (heldSlot.startIndex === 0) return false;
        isLoadingMoreRef.current = true;
        setIsLoadingMoreMessages(true);
        const windowRestore = captureScrollRestoreState(container);
        try {
          await sessionStore.loadBefore(selectedSession.id, { limit: OLDER_MESSAGES_PAGE_SIZE });
          const after = sessionStore.getSessionSlot(selectedSession.id);
          if (after) {
            setHasMoreMessages(after.hasMore);
            setTotalMessages(after.total);
            messagesOffsetRef.current = after.offset;
          }
          pendingScrollRestoreRef.current = windowRestore;
          setVisibleMessageCount((prev) => prev + OLDER_MESSAGES_PAGE_SIZE);
          return true;
        } finally {
          isLoadingMoreRef.current = false;
          setIsLoadingMoreMessages(false);
        }
      }

      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages) return false;

      isLoadingMoreRef.current = true;
      setIsLoadingMoreMessages(true);
      const scrollRestoreState = captureScrollRestoreState(container);

      try {
        const result = await sessionStore.fetchMore(selectedSession.id, {
          limit: OLDER_MESSAGES_PAGE_SIZE,
          canRequest: () => (
            isActiveRef.current
            && activeSessionIdRef.current === selectedSession.id
          ),
        });
        const { slot, prependedCount } = result;
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }

        if (prependedCount === 0) {
          if (!slot.hasMore) {
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
          }
          return false;
        }

        pendingScrollRestoreRef.current = scrollRestoreState;
        setVisibleMessageCount((prev) => prev + OLDER_MESSAGES_PAGE_SIZE);
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
        setIsLoadingMoreMessages(false);
      }
    },
    [hasMoreMessages, isActive, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  /**
   * Extends the held window toward its tail while the reader is detached and
   * reaches its bottom.
   *
   * Nothing to do once attached: the tail is already there. When this read
   * reaches the newest row the slot re-attaches on its own and the rows that
   * arrived behind the reader fold back into the transcript.
   */
  const loadNewerMessages = useCallback(
    async () => {
      if (!isActive || !selectedSession) return false;
      // A drag owns the viewport (see loadOlderMessages).
      if (searchScrollActiveRef.current) return false;
      const slot = sessionStore.getSessionSlot(selectedSession.id);
      if (!slot || slot.attached !== false) return false;
      if (slot.endIndex >= slot.total) return false;
      if (isLoadingNewerRef.current) return false;

      isLoadingNewerRef.current = true;
      try {
        await sessionStore.loadAfter(selectedSession.id, { limit: OLDER_MESSAGES_PAGE_SIZE });
        const after = sessionStore.getSessionSlot(selectedSession.id);
        if (after) {
          setHasMoreMessages(after.hasMore);
          setTotalMessages(after.total);
          messagesOffsetRef.current = after.offset;
        }
        // Widening the render window is what shows the rows the read appended:
        // `visibleMessages` is a tail slice and the window just grew under it.
        setVisibleMessageCount((prev) => prev + OLDER_MESSAGES_PAGE_SIZE);
        return true;
      } finally {
        isLoadingNewerRef.current = false;
      }
    },
    [isActive, selectedSession, sessionStore],
  );

  const handleScroll = useCallback(async () => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    // Intent is deliberately not read here. This handler runs for every scroll
    // the pane reports, including the ones the browser made on its own, so the
    // attribution lives in the input-source listener above instead.
    scrollPositionRef.current = {
      height: container.scrollHeight,
      top: container.scrollTop,
    };
    // Re-baseline the content-growth follow. A scroll is the user (or a writer
    // above) choosing an offset, and the next growth must be judged against the
    // layout this offset was chosen in — otherwise a deliberate scroll between
    // two resizes would be read as drift the follow is free to correct.
    transcriptGeometryRef.current = {
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    };

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    // Detached from the tail, reaching the window's own bottom offers the newer
    // page — the mirror of the older-page prefetch below. The id-anchored read
    // extends the window flush, and when it reaches the newest row the slot
    // re-attaches, folding the rows that arrived behind the reader back in.
    const heldSlot = activeSessionIdRef.current
      ? sessionStore.getSessionSlot(activeSessionIdRef.current)
      : undefined;
    if (heldSlot && heldSlot.attached === false) {
      const gapToWindowBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (gapToWindowBottom < 200) {
        await loadNewerMessages();
      }
    }

    if (!allMessagesLoadedRef.current) {
      // The prefetch arms a couple of screens above the top edge, so a steady scroll up has
      // the next page in hand before the viewport reaches the loaded rows — the absolute
      // `scrollTop < 100` it replaces only asked once the blank above the rows was already
      // on screen. The armed position holds a second request for the same arrival and is
      // released by the anchor restore the completed prepend lands with.
      const prefetchPlan = planOlderPagePrefetch({
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        armedAtScrollTop: topLoadLockRef.current,
      });
      if (prefetchPlan === 'release') {
        topLoadLockRef.current = null;
        return;
      }
      if (prefetchPlan === 'hold') return;
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = container.scrollTop;
    }
  }, [hasMoreMessages, isActive, isNearBottom, loadNewerMessages, loadOlderMessages, sessionStore]);

  const wasChatActiveRef = useRef(isActive);
  useLayoutEffect(() => {
    const becameActive = isActive && !wasChatActiveRef.current;
    wasChatActiveRef.current = isActive;
    if (!isActive || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    if (pendingScrollRestoreRef.current) {
      const { height, top, anchor, anchorOffset } = pendingScrollRestoreRef.current;
      // A restore is the app placing the viewport, and where it lands says
      // nothing about who wants it there: the pane it was captured from was not
      // scrollable, so the clamp above puts the offset on the bottom — the same
      // place a user who scrolled there sits. `writeScrollTop` keeps the echo
      // this raises from being read as that user.
      if (anchor?.isConnected && anchorOffset !== null) {
        const nextAnchorOffset = (
          anchor.getBoundingClientRect().top
          - container.getBoundingClientRect().top
        );
        writeScrollTop(container, container.scrollTop + (nextAnchorOffset - anchorOffset));
      } else {
        writeScrollTop(container, top + Math.max(container.scrollHeight - height, 0));
      }
      pendingScrollRestoreRef.current = null;
      return;
    }

    if (becameActive) {
      container.scrollTop = isUserScrolledUp
        ? scrollPositionRef.current.top
        : container.scrollHeight;
    }
  }, [chatMessages.length, isActive, isUserScrolledUp, writeScrollTop]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    // A search jump belongs to the transcript it was requested against. Left
    // armed across a session change it did two visible things to the session
    // the user actually opened: the initial scroll bailed (it declines while a
    // jump is pending) so the transcript opened part-way up, and then, once the
    // retries ran out and started accepting the nearest row by timestamp, it
    // scrolled to an unrelated message and flashed the search highlight on it.
    //
    // Clearing it here is safe for the jump itself: the effect that reads
    // `__searchTargetSnippet` off the newly selected session runs after this
    // one, so a session opened *from* a search result re-arms immediately.
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    if (searchScrollFrameRef.current !== null) {
      cancelAnimationFrame(searchScrollFrameRef.current);
      searchScrollFrameRef.current = null;
    }
    // A correction window belongs to the transcript it was opened on; the row it
    // holds is about to leave the DOM, and its own `isConnected` check would only
    // notice on the next frame.
    jumpLockRef.current?.release();
    searchScrollActiveRef.current = false;

    pendingInitialScrollRef.current = true;
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    topLoadLockRef.current = null;
    pendingScrollRestoreRef.current = null;
    wasNearTopRef.current = false;
    // A doubled baseline would outlive its transcript: this hook keeps its pane
    // across a session change, so the offset the previous transcript was placed
    // at is far below anything the new one can reach, and every deferred
    // placement in the session that just opened would read as "the user has
    // taken the pane" and be refused. The initial settle re-seats it here anyway
    // — this only makes sure nothing fires against the stale value first.
    lastPlacedTopRef.current = 0;
    setIsUserScrolledUp(false);
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Initial scroll to bottom — robust to lazy content reflow.
  // The previous implementation fired one scrollToBottom() at +200ms and
  // cleared the pending flag. When markdown blocks, code highlighting, or
  // images finished rendering after that window, scrollHeight grew but
  // nothing re-anchored the viewport, leaving the chat tab visually
  // "scrolled way up" with the latest assistant message off-screen.
  //
  // This version re-scrolls every animation frame while scrollHeight is
  // still growing, capped at ~1s (60 frames) or 3 consecutive stable
  // frames. Cancels cleanly on session change via the pending flag.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    let frame = 0;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      writeScrollTop(container, container.scrollHeight);
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [chatMessages.length, isActive, isLoadingSessionMessages, scrollToBottom, writeScrollTop]);

  // Session replay/subscription remains active regardless of which main tab is
  // visible. Only persisted-history HTTP traffic is visibility-gated below.
  useEffect(() => {
    if (!selectedSession || !selectedProject || !ws) return;

    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [subscribeTargetFor(selectedSession.id, lastSeqRef.current.get(selectedSession.id))],
    });
  }, [lastSeqRef, selectedProject, selectedSession, sendMessage, statusCheckSentAtRef, ws]);

  // Main session loading effect — store-based.
  //
  // The dependency list is deliberately narrower than the values the body
  // reads. `selectedSession` is tracked by id only, so a websocket-driven list
  // refresh that hands back a new object for the same session does not reload
  // it; `currentSessionId` is read as the previously-loaded session (the body
  // itself is what advances it), so listing it would re-enter the effect right
  // after every load. Both are always current when the effect does run,
  // because React recreates the closure on each render.
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    if (!isActive) {
      setIsLoadingSessionMessages(false);
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const existingSlot = sessionStore.getSessionSlot(selectedSessionId);
    const isCurrentHydratedSession =
      lastLoadedSessionKeyRef.current === sessionKey
      && Boolean(existingSlot?.fetchedAt);

    // Returning from another tab must not reset pagination or scroll. Refresh
    // a stale hydrated session through the bounded tail path instead.
    if (isCurrentHydratedSession) {
      // Skip store refresh during active streaming — the same guard the
      // external-update path below carries, and the reason switching back to a
      // session that is still running used to be the way to see the reply
      // twice: a refresh that lands mid-turn brings the persisted echo of the
      // segment being streamed in beside the live row still writing it.
      if (!isProcessing && sessionStore.isStale(selectedSessionId)) {
        void requestLatestMessages(selectedSessionId);
      }
      return;
    }

    // A first page for this session is already in flight. Re-entering the
    // effect must not issue a second one: the duplicate is enqueued behind the
    // outstanding request, so it lands last and replaces whatever window the
    // store holds by then — including the one a jump loaded while the first
    // page was still travelling. Nothing below needs to run again either: the
    // resets it would do were already done when the request was issued.
    if (inFlightFirstPageKeyRef.current === sessionKey) return;

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;
    if (sessionChanged) {
      resetStreamingState();
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    inFlightFirstPageKeyRef.current = sessionKey;
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      offset: 0,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === selectedSessionId
      ),
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setIsLoadingSessionMessages(false);
    }).finally(() => {
      // Only the request that owns the key releases it: a later session change
      // may already have stamped its own key here.
      if (inFlightFirstPageKeyRef.current === sessionKey) {
        inFlightFirstPageKeyRef.current = null;
      }
    });
  }, [
    isActive,
    resetStreamingState,
    requestLatestMessages,
    selectedProject,
    selectedSession?.id,
    sessionStore,
  ]);

  // Hidden refresh signals are coalesced. An initial page load supersedes a
  // pending latest refresh for an unhydrated/loading slot; otherwise activation
  // flushes exactly one request for the selected session.
  useEffect(() => {
    if (!isActive || !activeSessionId) return;

    const slot = sessionStore.getSessionSlot(activeSessionId);
    if (!slot?.fetchedAt || slot.status === 'loading') {
      refreshCoordinatorRef.current?.discardPending(activeSessionId);
      return;
    }

    // Skip store refresh during active streaming: a refresh landed on the
    // activation of a session that is still running is the same mid-turn
    // refresh the switch-back path above refuses, and it is the turn's own
    // `complete` that reconciles the persisted tail either way.
    if (!isProcessing) {
      void refreshCoordinatorRef.current?.flushPending(activeSessionId);
    }
  }, [activeSessionId, isActive, sessionStore]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          const shouldStickToBottom = isActiveRef.current && isNearBottom();
          await requestLatestMessages(selectedSession.id);

          if (shouldStickToBottom) {
            setTimeout(() => {
              if (!isUserScrolledUpRef.current) {
                scrollToBottom();
              }
            }, 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    requestLatestMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
    isProcessing,
  ]);

  /**
   * Places one transcript row in the viewport, on the user's behalf.
   *
   * The id — the row's transcript anchor — is the whole of the target: a turn is
   * addressed the way the server addresses it, so two turns that share a
   * millisecond are still two distinct destinations. The window is read around
   * that id rather than by pulling the whole transcript, so jumping into a long
   * conversation costs one bounded read and leaves the slot detached from the
   * tail, where rows arriving behind the reader buffer instead of dragging the
   * viewport back down.
   *
   * This is the one jump the sidebar search and the navigation rail share; there
   * is no second copy of "load around, widen, wait for the commit, scroll,
   * detach, highlight".
   *
   * Answers whether the id was found in the window that was read. The scroll
   * itself is placed on a later animation frame, so the answer means "the
   * transcript now holds this message and the viewport is being moved to it" —
   * which is exactly what a caller relaying a location request back to an
   * external client needs to report a message it could not find.
   */
  const jumpToMessage = useCallback(async (anchorId: string): Promise<boolean> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || !anchorId) return false;

    // A superseding jump takes the viewport from the previous one: the old
    // correction window is abandoned before the new claim is laid down, so its
    // end callback cannot clear the claim this jump is about to make.
    jumpLockRef.current?.release();
    searchScrollActiveRef.current = true;
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    if (searchScrollFrameRef.current !== null) {
      cancelAnimationFrame(searchScrollFrameRef.current);
      searchScrollFrameRef.current = null;
    }
    const stillHere = () => isActiveRef.current && activeSessionIdRef.current === sessionId;

    try {
      const slot = await sessionStore.loadWindowAround(sessionId, anchorId, {
        before: JUMP_WINDOW_BEFORE,
        after: JUMP_WINDOW_AFTER,
      });
      if (!stillHere()) {
        releaseJump();
        return false;
      }

      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;

      // The store now holds the window the id was fetched into; resolving the
      // target's index there is what sizes the render window. `visibleMessages`
      // is a tail slice, so covering index N means rendering everything after it.
      const projected = collapseMonitorEventRows(
        normalizedToChatMessages(sessionStore.getMessages(sessionId)),
      );
      const targetIndex = projected.findIndex((message) => anchorIdOf(message) === anchorId);
      if (targetIndex < 0) {
        // The window came back without the id: the message does not exist (or is
        // past the end of the transcript), so nothing was placed.
        releaseJump();
        return false;
      }

      setVisibleMessageCount((previous) => Math.max(
        previous,
        resolveSearchWindowSize(projected.length, targetIndex, SEARCH_TARGET_CONTEXT_MESSAGES),
      ));

      // The target is inside the window by construction, so the wait is only for
      // React to commit the widened list — retried on animation frames, so the
      // placement lands on the first frame the row exists rather than after a
      // fixed step's dead time.
      const placementDeadline = performance.now() + SEARCH_SCROLL_BUDGET_MS;
      const scrollToRenderedTarget = () => {
        searchScrollFrameRef.current = null;
        if (!stillHere()) return releaseJump();
        const container = scrollContainerRef.current;
        if (!container) return releaseJump();

        const targetElement = findRenderedMessageElementById(container, anchorId);
        if (targetElement) {
          // Placed through the same channel every other scroll write uses, so
          // the move this raises is not read back as a user gesture — and
          // computed rather than handed to `scrollIntoView`, whose smooth
          // animation is a second mover that can still be travelling when the
          // criterion reads the pane, and which a window that ends at the tail
          // cannot honour anyway.
          const paneTop = container.getBoundingClientRect().top;
          const targetTop = container.scrollTop + (targetElement.getBoundingClientRect().top - paneTop);
          const centered = targetTop - (container.clientHeight - targetElement.offsetHeight) / 2;
          const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
          writeScrollTop(container, Math.max(0, Math.min(centered, maxTop)));
          // The jump deliberately places the viewport somewhere that is not the
          // bottom, on the user's behalf, so it settles the intent itself:
          // without this the next arriving row would be free to pull the reader
          // off the turn they jumped to.
          setIsUserScrolledUp(true);
          isUserScrolledUpRef.current = true;
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement.classList.remove('search-highlight-flash'), 4000);
          // The write above measured the target against the window's placeholders;
          // the frames that follow replace them with real content and move it. The
          // window keeps correcting until it settles, or until the user takes the
          // pane back — and it is the window's own end that releases the jump's
          // claim, so the follow resumes only once the target is really placed.
          jumpLockRef.current?.start(container, targetElement);
          return;
        }

        if (performance.now() < placementDeadline) {
          searchScrollFrameRef.current = requestAnimationFrame(scrollToRenderedTarget);
          return;
        }
        return releaseJump();
      };

      searchScrollFrameRef.current = requestAnimationFrame(scrollToRenderedTarget);
      // Found in the window and the placement is queued: the caller can report
      // the location as performed even though the scroll lands a frame later.
      return true;
    } catch (error) {
      console.error('Error jumping to a message:', error);
      releaseJump();
      return false;
    }
  }, [releaseJump, sessionStore, writeScrollTop]);

  // Search navigation target: the sidebar hands a hit over as a snippet and a
  // timestamp on the session object. It is resolved to an anchor id against
  // what the client already holds — the loaded transcript and the session's
  // outline — and then placed by the same jump the rail calls. The full
  // transcript is never read just to resolve one hit.
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    if (typeof targetSnippet !== 'string' || !targetSnippet) return;
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || !isActive) return;

    const targetTimestamp = session?.__searchTargetTimestamp;
    const target: SearchTarget = {
      snippet: targetSnippet,
      timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
    };

    let cancelled = false;
    const run = async () => {
      try {
        const loaded = collapseMonitorEventRows(
          normalizedToChatMessages(sessionStore.getMessages(sessionId)),
        );
        let anchorId = resolveSearchTargetAnchorId(target, loaded, sessionStore.getOutline(sessionId));
        if (!anchorId) {
          const outline = await sessionStore.fetchOutline(sessionId);
          if (cancelled) return;
          anchorId = resolveSearchTargetAnchorId(target, loaded, outline);
        }
        if (!anchorId || cancelled) return;
        void jumpToMessage(anchorId);
      } catch {
        // An unreachable outline leaves the hit unresolved rather than
        // scrolling somewhere plausible, which would claim a hit that is not.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSession, isActive]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      try {
        // The provider module resolves storage and provider details from the session id.
        const response = await api.providers.sessionTokenUsage(selectedSession.id);
        if (response.ok) {
          const payload = await response.json();
          setTokenBudget(payload.data ?? null);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [selectedSession?.id]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  useEffect(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
  });

  useEffect(() => {
    if (!isActive) return;
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) return;
    if (searchScrollActiveRef.current) return;

    if (!isUserScrolledUp) {
      setTimeout(() => {
        if (!isUserScrolledUpRef.current) {
          scrollToBottom();
        }
      }, 50);
    }
  }, [chatMessages.length, isActive, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!isActive) return;
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    const container = scrollContainerRef.current;
    const scrollRestoreState = container ? captureScrollRestoreState(container) : null;

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
        canRequest: () => (
          isActiveRef.current
          && activeSessionIdRef.current === requestSessionId
        ),
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        if (scrollRestoreState) {
          pendingScrollRestoreRef.current = scrollRestoreState;
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [isActive, selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  /**
   * Fetches the whole transcript into the store and returns it, without
   * touching the render window.
   *
   * Export needs every message; the screen does not. Keeping those separate is
   * why exporting a long conversation no longer silently produces a file
   * containing only its last page.
   */
  const loadFullTranscript = useCallback(async (): Promise<ChatMessage[]> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return [];
    }

    await sessionStore.fetchFromServer(sessionId, {
      limit: null,
      offset: 0,
      canRequest: () => activeSessionIdRef.current === sessionId,
    });

    return normalizedToChatMessages(sessionStore.getMessages(sessionId));
  }, [sessionStore]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  return {
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
    scrollContentRef: attachScrollContent,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
    jumpToMessage,
  };
}
