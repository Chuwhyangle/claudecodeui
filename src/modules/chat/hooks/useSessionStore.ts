/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { CommandLifecycleState, DeliveryView, LLMProvider, NormalizedMessage, SessionMessagesQuery, SessionTurnOutline } from '@/shared/types';
import { createLiveRowId, isLiveRowId } from '@/modules/chat/utils/liveRowIdentity';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';
import { messageAnchorId } from '@/modules/chat/utils/messageKeys';
import {
  hasReachedCachedTailTimeBoundary,
  mergeLatestServerPage,
  mergeOlderServerPage,
  messagesRepresentSamePersistedRow,
  planLatestPageBridge,
  resolveLatestPagePagination,
  SESSION_MESSAGES_PAGE_SIZE,
} from '@/modules/chat/utils/sessionMessagePagination';
import type { SessionMessagesRequestOptions } from '@/modules/chat/utils/sessionMessagePagination';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────


// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export type SessionSlot = {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  /**
   * The rows this session's pending deliveries draw, keyed by the host's own
   * `deliveryId`.
   *
   * A second, small row list beside `realtimeMessages` rather than part of it:
   * these rows are *derived* from the session's activity snapshot (see
   * `applyDeliveries`), so they are replaced wholesale whenever the snapshot is,
   * while `realtimeMessages` is appended to. Keeping them apart is what lets a
   * snapshot re-state the queue without touching anything this client streamed
   * from the run itself.
   */
  deliveryRows: NormalizedMessage[];
  merged: NormalizedMessage[];
  /**
   * The block a streamed row belongs to, by the id the row ended up carrying.
   *
   * A block's live row starts life under a `live:…` id and is handed over, when
   * its settled record arrives, to that record's own id (`<uuid>_0`). The
   * transcript keys the row by `blockKey`, so the identity has to survive the
   * handover and the refresh that later reclaims the realtime row by id — by
   * then the row that carried it is gone, and this map is the only record left.
   */
  blockKeyByRowId: Map<string, string>;
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  _lastDeliveryRowsRef: NormalizedMessage[];
  /**
   * @internal Serializes history reads for this session so an older-page
   * request calculates its offset after any latest-page refresh completes.
   */
  _historyMutationQueue: Promise<void>;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  /**
   * Absolute 0-based subscript of `serverMessages[0]` in the full normalized
   * history — the same array the tail page and the around read slice. It does
   * not move when a turn is appended, unlike the tail-relative `offset`.
   */
  startIndex: number;
  /** Absolute exclusive end: the subscript just past `serverMessages`'s last row. */
  endIndex: number;
  /**
   * True while the window is pinned to the newest row (`endIndex === total`).
   * Attached, `realtimeMessages` render with the window and every existing
   * action keeps its pre-window behavior. Detached, realtime rows buffer in
   * `realtimeMessages` and `getMessages` returns the window alone.
   */
  attached: boolean;
  /**
   * Absolute index of the message the window is centered on. The cap trims the
   * end farther from it, so the focus the reader jumped to stays loaded.
   */
  anchorIndex: number;
  tokenUsage: unknown;
  /**
   * The session's user-turn outline, once read. `null` means "not read yet" —
   * distinct from an outline that legitimately has no turns — so the rail can
   * tell a session it has not indexed from one with an empty conversation.
   */
  outline: SessionTurnOutline | null;
};

const EMPTY: NormalizedMessage[] = [];
const SESSION_HISTORY_REQUEST_TIMEOUT_MS = 30_000;

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    deliveryRows: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    _lastDeliveryRowsRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    startIndex: 0,
    endIndex: 0,
    attached: true,
    anchorIndex: 0,
    blockKeyByRowId: new Map(),
    // `undefined` means "no page has reported usage for this session yet", and
    // every consumer distinguishes that from a reported `null`. Initialising it
    // to `null` made the two indistinguishable, so a provider whose history
    // payload carries no usage looked like one reporting zero — and every
    // history refresh overwrote the value fetched from the token-usage
    // endpoint with it.
    tokenUsage: undefined,
    outline: null,
    _historyMutationQueue: Promise.resolve(),
  };
}

type SessionHistoryPage = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  tokenUsage?: unknown;
};

function enqueueHistoryMutation<T>(
  slot: SessionSlot,
  operation: () => Promise<T>,
): Promise<T> {
  const result = slot._historyMutationQueue.then(operation);
  slot._historyMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function requestSessionHistoryPage(
  sessionId: string,
  options: SessionMessagesRequestOptions,
): Promise<SessionHistoryPage> {
  const response = await api.providers.sessionMessages(sessionId, options, {
    signal: AbortSignal.timeout(SESSION_HISTORY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  const data = body?.data ?? body;
  const messages: NormalizedMessage[] = Array.isArray(data.messages) ? data.messages : [];

  return {
    messages,
    total: typeof data.total === 'number' ? data.total : messages.length,
    hasMore: Boolean(data.hasMore),
    ...(
      data && typeof data === 'object' && 'tokenUsage' in data
        ? { tokenUsage: data.tokenUsage }
        : {}
    ),
  };
}

type SessionWindowPage = {
  messages: NormalizedMessage[];
  startIndex: number;
  total: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

/**
 * One id-anchored window the scrub has read, kept whole so a back-and-forth drag
 * can put it back on screen without reading the server again.
 *
 * `startIndex`/`endIndex` are the raw response's absolute subscripts — the scale
 * a scrub request's ordinal is compared against to decide whether a window the
 * client already holds covers the position being dragged to.
 */
export type ScrubWindowPage = {
  /** The anchor id the window was read around. */
  id: string;
  messages: NormalizedMessage[];
  startIndex: number;
  endIndex: number;
  total: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

/**
 * Reads the id-anchored window around one message id. Unlike the tail page this
 * response carries an absolute `startIndex`, so the caller positions its window
 * by id rather than by arithmetic on a total that may have moved underneath it.
 */
async function requestSessionWindow(
  sessionId: string,
  query: SessionMessagesQuery & { around: string },
): Promise<SessionWindowPage> {
  const response = await api.providers.sessionMessages(sessionId, query, {
    signal: AbortSignal.timeout(SESSION_HISTORY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  const data = body?.data ?? body;
  const messages: NormalizedMessage[] = Array.isArray(data.messages) ? data.messages : [];

  return {
    messages,
    startIndex: typeof data.startIndex === 'number' ? data.startIndex : 0,
    total: typeof data.total === 'number' ? data.total : messages.length,
    hasMoreBefore: Boolean(data.hasMoreBefore),
    hasMoreAfter: Boolean(data.hasMoreAfter),
  };
}

/**
 * Reads a session's user-turn outline — every user prompt in transcript order,
 * including the parts no client has loaded. Read-only and cached on the slot,
 * so the rail's index survives the pane unmounting and coming back.
 */
async function requestSessionOutline(sessionId: string): Promise<SessionTurnOutline> {
  const response = await api.providers.sessionOutline(sessionId, {
    signal: AbortSignal.timeout(SESSION_HISTORY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  const data = body?.data ?? body;
  const turns = Array.isArray(data?.turns) ? data.turns : [];

  return {
    total: typeof data?.total === 'number' ? data.total : turns.length,
    turns,
  };
}

/**
 * The identity the server resolves an `around` id against — the same rule the
 * pane publishes and the jump machinery looks a row up by, defined once in
 * {@link messageAnchorId}. A store row has no `transcriptRowId` (that field is
 * the rendered row's copy of this one), so the rule collapses to "anchor when
 * present, else id" here; the trailing `??` only restates the shape's own
 * guarantee that a store row always has an id, and keeps the return type total.
 */
function windowIdOf(message: NormalizedMessage): string {
  return messageAnchorId(message) ?? message.id;
}

/** Clamps an absolute subscript into the half-open window `[startIndex, endIndex)`. */
function clampIndex(index: number, startIndex: number, endIndex: number): number {
  const last = Math.max(startIndex, endIndex - 1);
  return Math.min(Math.max(index, startIndex), last);
}

/**
 * Applies an id-anchored window page to the slot. `offset` is recomputed from
 * the absolute indices so the older-page action (which counts back from the
 * tail) still points at the row just before the window.
 */
function applyWindowPage(slot: SessionSlot, page: SessionWindowPage, anchorIndex: number): void {
  slot.serverMessages = page.messages;
  slot.total = page.total;
  slot.startIndex = page.startIndex;
  slot.endIndex = page.startIndex + page.messages.length;
  slot.hasMore = page.hasMoreBefore;
  slot.offset = Math.max(0, page.total - page.startIndex);
  slot.attached = slot.endIndex >= page.total;
  slot.anchorIndex = clampIndex(anchorIndex, slot.startIndex, slot.endIndex);
}

/**
 * Keeps the window under {@link MAX_WINDOW_MESSAGES} by dropping the end farther
 * from the focus. Both absolute edges move by exactly what was dropped, so
 * `startIndex`/`endIndex` keep describing the retained rows.
 */
function trimWindowToCap(slot: SessionSlot): void {
  const length = slot.serverMessages.length;
  if (length <= MAX_WINDOW_MESSAGES) return;

  const anchor = clampIndex(slot.anchorIndex, slot.startIndex, slot.endIndex);
  const olderCount = anchor - slot.startIndex;
  const newerCount = slot.endIndex - 1 - anchor;
  const excess = length - MAX_WINDOW_MESSAGES;

  if (newerCount >= olderCount) {
    // The newer end is farther: drop from it, topping up from the older end only
    // if that alone could not bring the window under the cap.
    const dropNewer = Math.min(excess, newerCount);
    const dropOlder = excess - dropNewer;
    slot.serverMessages = slot.serverMessages.slice(dropOlder, length - dropNewer);
    slot.endIndex -= dropNewer;
    slot.startIndex += dropOlder;
  } else {
    const dropOlder = Math.min(excess, olderCount);
    const dropNewer = excess - dropOlder;
    slot.serverMessages = slot.serverMessages.slice(dropOlder, length - dropNewer);
    slot.startIndex += dropOlder;
    slot.endIndex -= dropNewer;
  }

  slot.offset = Math.max(0, slot.total - slot.startIndex);
}

/**
 * Stitches a page that ends on the cached window's first row in front of it. The
 * boundary row is shared (the page was read `around` it), so the overlap is
 * removed and the rows stay contiguous.
 */
function unionWindowFront(
  cached: NormalizedMessage[],
  pageMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const pageLast = pageMessages[pageMessages.length - 1];
  const cachedFirst = cached[0];
  const overlap = pageLast && cachedFirst && messagesRepresentSamePersistedRow(pageLast, cachedFirst) ? 1 : 0;
  return [...pageMessages.slice(0, pageMessages.length - overlap), ...cached];
}

/**
 * Stitches a page that starts on the cached window's last row after it, dropping
 * the shared boundary row so the result has no duplicate.
 */
function unionWindowBack(
  cached: NormalizedMessage[],
  pageMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const pageFirst = pageMessages[0];
  const cachedLast = cached[cached.length - 1];
  const overlap = pageFirst && cachedLast && messagesRepresentSamePersistedRow(pageFirst, cachedLast) ? 1 : 0;
  return [...cached, ...pageMessages.slice(overlap)];
}

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/**
 * The time a row sorts by, which is its own except for one case.
 *
 * The optimistic echo of an edited message is the row whose clock cannot be
 * trusted against the rows around it. Providers that rewind by branching —
 * Codex has no way to resume a transcript partway, so an edit copies the kept
 * history into a new one — write the copy with the timestamps of the copy. So
 * every turn that survived the cut comes back from the next refresh stamped a
 * moment *after* the replacement was typed, and the message the user just sent
 * jumps to the top of the conversation.
 *
 * A replacement is by definition the newest thing in the conversation, so it
 * is sorted as such instead of by what the clock said when it was typed.
 */
function readSortTime(message: NormalizedMessage, replacementFloor: number): number {
  const time = readMessageTime(message) ?? 0;
  return message.replacesAnchorId ? Math.max(time, replacementFloor) : time;
}

/**
 * Count how many user turns precede `message` in a chronologically merged view
 * of server + realtime rows. Used to match a realtime row to the correct turn
 * on disk when several turns share identical assistant text.
 */
function getUserTurnOrdinalBefore(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): number {
  const messageTime = readMessageTime(message);
  let userCount = 0;

  for (const candidate of [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically)) {
    if (candidate.id === message.id) {
      break;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      messageTime !== null
      && candidateTime !== null
      && candidateTime > messageTime
    ) {
      break;
    }

    if (candidate.kind === 'text' && candidate.role === 'user') {
      userCount++;
    }
  }

  return Math.max(0, userCount - 1);
}

function findServerTurnRangeByOrdinal(
  serverMessages: NormalizedMessage[],
  turnOrdinal: number,
): { start: number; end: number } | null {
  let userCount = -1;
  let start = -1;

  for (let index = 0; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      userCount++;
      if (userCount === turnOrdinal) {
        start = index;
        break;
      }
    }
  }

  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) =>
      serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').trim() === assistantText,
    );
}

/**
 * After `finalizeStreaming`, the client holds its own assistant `text` row while
 * the sessions API soon returns the same reply with a different id. Those sit
 * back-to-back in merged order and look like duplicate bubbles until a
 * persisted-tail refresh reconciles realtime. Collapse same-text assistant rows
 * and stream_placeholder → text when content matches.
 *
 * The collapse keeps the client's row of the pair, which is the whole point of
 * doing it here rather than letting the echo replace it — see the comment on the
 * survivor below.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev) {
      const streamsIntoEcho = prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant';
      // The same pair with the sides swapped: a persisted echo that already
      // landed, followed by the row still streaming the very segment it echoes.
      // This is the direction merged order actually produces — see the sort in
      // `computeMerged`, where the live row carries the newest flush time and so
      // can only ever come second. Both sides are pinned to the shape that means
      // one reply drawn twice: `m` is a live row (`updateStreaming` is the only
      // minter of `stream_delta`), and `prev` is not, because a live id on the
      // left is a previous turn that settled in place — a different reply that
      // merely reads the same, which must stay a row of its own.
      const echoesIntoStream = prev.kind === 'text'
        && prev.role === 'assistant'
        && m.kind === 'stream_delta'
        && isLiveRowId(m.id)
        && !isLiveRowId(prev.id);
      const echoesSettled = prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant';
      const sameReply = (() => {
        const ps = (prev.content || '').trim();
        return ps.length > 0 && ps === (m.content || '').trim();
      })();
      // Two rows the server named are two blocks, however alike they read: a
      // turn that says the same words twice is two segments, and folding them
      // would silently delete one. Only rows the server did not name (a
      // provider with no blocks, or a history read) fall back to text equality.
      const sameBlock = !prev.blockKey || !m.blockKey || prev.blockKey === m.blockKey;

      if ((streamsIntoEcho || echoesIntoStream || echoesSettled) && sameReply && sameBlock) {
        // One reply drawn twice: the row this client streamed the turn into,
        // and the server's persisted echo of it. Which of the two survives is
        // not a detail — the transcript keys a row by the store id it carries
        // (`getIntrinsicMessageKey`), so dropping the client's row re-keys that
        // turn, and a re-key is an unmount. The frame the two meet on is the one
        // the turn settles on, where the pane is pinned to the bottom and the
        // freshly inserted row is measured at its `content-visibility` intrinsic
        // height for that frame: the pane's content collapses under the viewport,
        // the browser clamps the offset, and the reader sees the transcript jump.
        // The client's row is therefore the survivor — the echo still supplies
        // its fields, being the persisted record, but not its identity.
        //
        // The block identity rides along with the survivor whatever else it
        // takes from the other side: it is the transcript's key, and a collapse
        // that dropped it would re-key the row on the very refresh this exists
        // to keep the row through.
        const carryingBlockKey = (survivor: NormalizedMessage, source: NormalizedMessage): NormalizedMessage =>
          survivor.blockKey || !source.blockKey ? survivor : { ...survivor, blockKey: source.blockKey };

        if (isLiveRowId(prev.id)) {
          // A row still streaming is not settled by the echo; its own
          // `stream_end` settles it, and settling it here would leave
          // `updateStreaming` with no row to find and a second one to mint.
          out[out.length - 1] = streamsIntoEcho ? prev : carryingBlockKey({ ...m, id: prev.id }, prev);
          continue;
        }
        if (isLiveRowId(m.id)) {
          out[out.length - 1] = carryingBlockKey(m, prev);
          continue;
        }
        if (streamsIntoEcho) {
          out[out.length - 1] = carryingBlockKey(m, prev);
          continue;
        }
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * Moves each streamed block's identity onto the persisted row that replaces it.
 *
 * The realtime row that carried the `blockKey` is about to be reclaimed by id,
 * and the history read that reclaims it never stamps one (a transcript row has
 * no live stream to belong to). So the key is copied from the block map onto
 * the server row here, while the store still holds both halves of the join. A
 * new array is returned only when something was actually carried, so a refresh
 * that changed nothing leaves the record objects — and their memoized
 * projections — alone.
 */
function withBlockKeysCarriedOntoServer(
  serverMessages: NormalizedMessage[],
  blockKeyByRowId: Map<string, string>,
): NormalizedMessage[] {
  if (blockKeyByRowId.size === 0) {
    return serverMessages;
  }

  let changed = false;
  const carried = serverMessages.map((message) => {
    if (message.blockKey) {
      return message;
    }
    const blockKey = blockKeyByRowId.get(message.id);
    if (!blockKey) {
      return message;
    }
    changed = true;
    return { ...message, blockKey };
  });

  return changed ? carried : serverMessages;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 *
 * `blockKeyByRowId` is both read and written here: a realtime row that is about
 * to be dropped is the last place its block's identity exists, so it is
 * recorded before the drop and carried onto the server row that superseded it.
 */
function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  blockKeyByRowId: Map<string, string>,
): { serverMessages: NormalizedMessage[]; realtimeMessages: NormalizedMessage[] } {
  for (const message of realtimeMessages) {
    if (message.blockKey && !blockKeyByRowId.has(message.id)) {
      blockKeyByRowId.set(message.id, message.blockKey);
    }
  }

  if (realtimeMessages.length === 0) {
    return {
      serverMessages: withBlockKeysCarriedOntoServer(serverMessages, blockKeyByRowId),
      realtimeMessages,
    };
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const reconciledRealtimeMessages = removeOptimisticUserEchoes(serverMessages, realtimeMessages);
  // A server page that now carries the turn a resident pending row stands for
  // reclaims that row here, exactly as it reclaims an optimistic echo above —
  // the message is on disk, so the client's own copy of it is done.
  const deliveredRealtimeMessages = retireDeliveredResidentPending(serverMessages, reconciledRealtimeMessages);

  const nextRealtimeMessages = deliveredRealtimeMessages.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }

    if (isLiveRowId(message.id)) {
      // The row this client streamed the turn into. It is what the transcript
      // keys that turn by, and the server's echo of the same reply does not
      // supersede it — the two are collapsed into one row, the client's, by
      // `dedupeAdjacentAssistantEchoes`. Pruning it here would take the turn's
      // identity with it and re-key the row on the refresh.
      return true;
    }

    if (message.kind === 'stream_delta') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return true;
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });

  return {
    serverMessages: withBlockKeysCarriedOntoServer(serverMessages, blockKeyByRowId),
    realtimeMessages: nextRealtimeMessages,
  };
}

/**
 * Keeps a `command_lifecycle` row out of the transcript unless this client is
 * the one drawing it.
 *
 * The dialect's lifecycle rows are the process's account of a queued command —
 * `queued`, `started`, `cancelled` — and the artifact keeps them, so they come
 * back over REST with every other row. They are not turns: a transcript that
 * rendered them would show "command started" as a message, and would show the
 * withdrawn command that the user already watched disappear. The one such row
 * the transcript does draw is this client's own live row (see
 * `addResidentPending`), which is the user's message plus the host's state for
 * it — and `isLiveRowId` is exactly the "this client made it" mark, because no
 * server row is ever minted with that id.
 */
function withoutServedLifecycleRows(messages: NormalizedMessage[]): NormalizedMessage[] {
  const kept = messages.filter(
    (message) => message.kind !== 'command_lifecycle' || isLiveRowId(message.id),
  );
  return kept.length === messages.length ? messages : kept;
}

/**
 * Whether a realtime row is the resident pending row this client minted for a
 * busy send — the user's message the composer wrote when it handed text to a
 * process that was already in a turn (see `addResidentPending`).
 *
 * The live id is the mark: a `command_lifecycle` row the dialect serves back over
 * REST is the process's account of a command, not this client's own row, and it
 * is filtered out of the transcript before this runs.
 */
function isResidentPendingRow(message: NormalizedMessage): boolean {
  return message.kind === 'command_lifecycle' && isLiveRowId(message.id);
}

/**
 * Whether a realtime row is this client's optimistic echo of a turn it just sent
 * (the `local_…` id `chatMessageToNormalized` mints).
 *
 * A send the process was NOT busy for mints one of these before the host says
 * anything about it. A busy send does not: it draws the host's delivery row
 * instead (see `addResidentPending`). That is what makes this row the mark of
 * "the page already shows this message", which the delivery suppression below
 * keys on.
 */
function isOptimisticUserTurnRow(message: NormalizedMessage): boolean {
  return message.kind === 'text'
    && message.role === 'user'
    && typeof message.id === 'string'
    && message.id.startsWith('local_');
}

/**
 * Whether a realtime row is one the activity snapshot drew for a delivery.
 *
 * The `deliveryId` half separates it from the legacy pending row the composer
 * minted itself (`addResidentPending`), which carries no delivery id — that row
 * is a busy send's only representative and must never be dropped by the rule
 * below.
 */
function isDeliverySnapshotRow(message: NormalizedMessage): boolean {
  return message.kind === 'command_lifecycle'
    && isLiveRowId(message.id)
    && typeof message.deliveryId === 'string';
}

/**
 * Drops the snapshot's delivery row when this client already draws the same
 * message as its own optimistic turn.
 *
 * ONE MESSAGE, ONE REPRESENTATIVE. An idle resident send produces two rows — the
 * client's `local_…` turn and the host's delivery for the same send — and
 * drawing both puts two identical bubbles on screen, the second without the `U`
 * avatar (live reading, 2026-10-17). The delivery row's state is a fact about a
 * message the page already shows, so where a client turn represents it the
 * delivery row draws NOTHING: no bubble, no annotation, no withdrawal.
 *
 * THE CLIENT TURN WINS because it is the row that becomes the persisted turn,
 * and because it carries the full text: a live delivery's words are capped
 * (`DELIVERY_TEXT_MAX_CHARS`), so a long send arrives as a PREFIX of what the
 * client wrote. Matching on the prefix is what keeps the capped case from
 * leaving the duplicate behind.
 *
 * CLAIMED ONE-TO-ONE, with a one-sided clock floor: each delivery retires one
 * client turn, and a delivery older than the client's row by more than the
 * pending-echo skew is a different send that merely shares its words (`yes`,
 * `continue`) — it must not take the new row's place. The busy-send path is
 * untouched: it has no optimistic turn, so its delivery row still draws.
 */
function withoutDeliveryRowsRepresentedByOptimisticTurn(
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const clientTurns = realtimeMessages.filter(isOptimisticUserTurnRow);
  if (clientTurns.length === 0) {
    return realtimeMessages;
  }

  const claimed = new Set<NormalizedMessage>();
  let dropped = false;
  const kept = realtimeMessages.filter((message) => {
    if (!isDeliverySnapshotRow(message)) {
      return true;
    }

    const words = (message.content || '').trim();
    const deliveredAt = readMessageTime(message);
    if (!words || deliveredAt === null) {
      return true;
    }

    const representative = clientTurns.find((candidate) => {
      if (claimed.has(candidate)) {
        return false;
      }
      const candidateWords = (candidate.content || '').trim();
      const sentAt = readMessageTime(candidate);
      if (!candidateWords || sentAt === null) {
        return false;
      }
      if (!candidateWords.startsWith(words)) {
        return false;
      }
      return deliveredAt >= sentAt - RESIDENT_PENDING_ECHO_FLOOR_SKEW_MS;
    });
    if (!representative) {
      return true;
    }

    claimed.add(representative);
    dropped = true;
    return false;
  });

  return dropped ? kept : realtimeMessages;
}

/**
 * Whether a row is the persisted copy of a user's turn — the shape a resident
 * pending row is waiting to be replaced by.
 *
 * Only rows the server wrote qualify: a `local_` echo this client minted and a
 * `live:` row it streams both name a message nothing has persisted, so neither
 * can stand for the turn the pending row will become.
 */
function isPersistedUserTurnRow(message: NormalizedMessage): boolean {
  return message.kind === 'text'
    && message.role === 'user'
    && typeof message.id === 'string'
    && !message.id.startsWith('local_')
    && !isLiveRowId(message.id);
}

/**
 * How far a persisted user row may sit *before* a resident pending row's own
 * clock and still be read as the turn that row became.
 *
 * The two timestamps come from different clocks — this client's at send, the
 * transcript's when the process wrote the turn — so a small skew is allowed. The
 * floor is one-sided on purpose: the replacement is the next persisted copy of
 * the message, which the queue may take an unbounded time to produce, but a turn
 * from earlier in the conversation (a second "yes", a repeated "continue") is
 * always *before* the send and must never retire a message the user has just
 * sent by sharing its words.
 */
const RESIDENT_PENDING_ECHO_FLOOR_SKEW_MS = 10_000;

/**
 * Drops a resident pending row once the turn it stands for is on screen.
 *
 * A message sent to a busy process enters the record as this client's own
 * `command_lifecycle` live row, carrying the user's text. The host's `started`
 * is not the moment that row stops being needed: it says the process dequeued
 * the command into a turn, while the turn's own user row reaches this client
 * asynchronously — over the socket or on the next history read — after that. A
 * row retired on `started` would empty the message before its replacement
 * existed, which is exactly the disappearance this fixes.
 *
 * So the key is the one the voice side uses for a delivered caption: the
 * replacement is *visible*. A persisted user row whose text matches and whose
 * clock is not before the send retires the pending row — one-to-one, so two
 * sends of the same words retire two rows rather than one row twice.
 */
function retireDeliveredResidentPending(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (!realtimeMessages.some(isResidentPendingRow)) {
    return realtimeMessages;
  }

  const echoCandidates = [...serverMessages, ...realtimeMessages].filter(isPersistedUserTurnRow);
  if (echoCandidates.length === 0) {
    return realtimeMessages;
  }

  const claimed = new Set<NormalizedMessage>();
  return realtimeMessages.filter((message) => {
    if (!isResidentPendingRow(message)) {
      return true;
    }

    const text = (message.content || '').trim();
    const pendingTime = readMessageTime(message);
    if (!text || pendingTime === null) {
      return true;
    }

    const echo = echoCandidates.find((candidate) => {
      if (claimed.has(candidate) || (candidate.content || '').trim() !== text) {
        return false;
      }
      const echoTime = readMessageTime(candidate);
      return echoTime !== null && echoTime >= pendingTime - RESIDENT_PENDING_ECHO_FLOOR_SKEW_MS;
    });

    if (!echo) {
      return true;
    }

    claimed.add(echo);
    return false;
  });
}

function computeMerged(serverSource: NormalizedMessage[], realtimeSource: NormalizedMessage[]): NormalizedMessage[] {
  const server = withoutServedLifecycleRows(serverSource);
  // Retire a pending row before the branches below, so a realtime list that is
  // nothing but a now-delivered pending row falls through to the server rows
  // instead of short-circuiting on a row that no longer renders.
  //
  // The suppression runs first and applies even while the history is empty: an
  // idle resident send's optimistic row and its delivery row can both arrive
  // before any server page does, and that is exactly the window the duplicate
  // was seen in.
  const realtime = retireDeliveredResidentPending(
    server,
    withoutDeliveryRowsRepresentedByOptimisticTurn(withoutServedLifecycleRows(realtimeSource)),
  );
  if (realtime.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIds = new Set(server.map((message) => message.id));
  const reconciledRealtime = removeOptimisticUserEchoes(server, realtime);
  const extra = reconciledRealtime.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }
    return true;
  });

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh. Sorting is stable and the
  // live rows come second, so a replacement that ties with the newest server
  // row still lands after it.
  const newestServerTime = server.reduce(
    (newest, message) => Math.max(newest, readMessageTime(message) ?? 0),
    0,
  );
  return dedupeAdjacentAssistantEchoes(
    [...server, ...extra].sort(
      (a, b) => readSortTime(a, newestServerTime) - readSortTime(b, newestServerTime),
    ),
  );
}

/**
 * Builds the resident pending row for a busy send.
 *
 * Extracted from {@link addResidentPending} so the row's shape has ONE
 * definition: the pure scenario surface mints the same row to drive the same
 * reduction, and a drift between the two would show up as a scenario that
 * passes while the composer's own row behaves differently.
 *
 * `timestamp` is injectable so a scenario can pin it; production leaves it at
 * the send instant.
 */
export function residentPendingRow(
  sessionId: string,
  text: string,
  timestamp: string = new Date().toISOString(),
): NormalizedMessage {
  return {
    id: createLiveRowId(sessionId),
    sessionId,
    timestamp,
    provider: 'claude',
    // See `addResidentPending`: the uuid is left to the host's first `queued`.
    commandState: 'queued',
    kind: 'command_lifecycle',
    role: 'user',
    content: text,
  } as NormalizedMessage;
}

/**
 * Folds one `command_lifecycle` event into a realtime row list, purely.
 *
 * Extracted from the {@link applyCommandLifecycle} callback so the reduction the
 * transcript depends on is testable without a store: the scenario surface
 * replays a timeline through this same function, and a scenario failure is then
 * a statement about this function rather than about a re-implementation of it.
 * Returns the SAME array reference when the event names no row (the caller's
 * change-guard relies on that), and a new array otherwise.
 */
export function applyCommandLifecycleToRows(
  rows: readonly NormalizedMessage[],
  event: { commandUuid: string; state: CommandLifecycleState },
): NormalizedMessage[] {
  let index = rows.findIndex(
    (row) => row.kind === 'command_lifecycle' && row.commandUuid === event.commandUuid,
  );
  if (index < 0 && event.commandUuid) {
    index = rows.findIndex((row) => row.kind === 'command_lifecycle' && !row.commandUuid);
  }
  if (index < 0) return rows as NormalizedMessage[];

  if (event.state === 'completed') {
    return rows.filter((_row, at) => at !== index);
  }

  const next = [...rows];
  next[index] = {
    ...rows[index],
    // Only the withdrawn state empties the text; `queued` and `started` both
    // keep the message on screen until the turn's own rows replace it.
    content: event.state === 'cancelled' ? '' : rows[index].content,
    commandUuid: event.commandUuid || rows[index].commandUuid,
    commandState: event.state,
  };
  return next;
}

/**
 * The merged transcript, exposed for the pure scenario surface.
 *
 * A thin alias of {@link computeMerged} — the very function the store's own
 * projection runs — so the "refresh / live / history merge is order-stable"
 * property is asserted against production code and not a copy of it.
 */
export function mergeSessionRows(
  server: NormalizedMessage[],
  realtime: NormalizedMessage[],
): NormalizedMessage[] {
  return computeMerged(server, realtime);
}

// ─── Pending deliveries, as the activity snapshot states them ────────────────

/**
 * Namespace for the row a delivery draws; no provider or server id uses it.
 *
 * The id is minted from the `deliveryId` alone rather than from a counter, so
 * one delivery draws under one id for its whole life — the transcript's row key
 * (and the DOM node behind it) survives the snapshot being restated, which a
 * counter-minted id would not.
 */
const DELIVERY_ROW_ID_PREFIX = 'live:delivery:';

const deliveryRowId = (deliveryId: string): string => `${DELIVERY_ROW_ID_PREFIX}${deliveryId}`;

/**
 * The row one snapshot delivery draws, or `null` when it draws none.
 *
 * This is the whole state machine of a pending row, and it is read from the
 * snapshot alone — no run stream, no local bookkeeping — so a client that
 * reconnects mid-queue draws exactly what the sender is looking at. The four
 * states, and why each draws what it does:
 *
 *  - `queued` — the command's own words, plus the "will be handled once this
 *    answer finishes" annotation the component derives from the state.
 *  - `started` — the words stay. `started` says the process dequeued the command
 *    into a turn, NOT that the turn's own rows have arrived: those reach this
 *    client asynchronously, over the socket or on the next history read, and
 *    until they do this row is the only thing carrying the message. Emptying it
 *    here is what made a busy-send message vanish while the process worked on it.
 *    The row is retired once the turn IS on screen
 *    ({@link retireDeliveredResidentPending}) — the same "the replacement is
 *    visible" key the voice side uses for a delivered caption.
 *  - `cancelled` — the row stays, with no words: the message left the record
 *    with the queue, and what is left to draw is that it was taken back
 *    (`id-relations` B-2, unchanged). A row that simply vanished would leave
 *    "did that go out?" unanswerable.
 *  - `completed` — no row at all. The command ran, so the turn's own rows are
 *    the record and this one has nothing left to say.
 *
 * The snapshot's `text` is authoritative once the delivery is known: it is the
 * command's own words as the host holds them, and reading them from the snapshot
 * — rather than from a local copy — is what lets a reconnect with no local copy
 * at all draw the same row.
 */
function residentDeliveryRow(sessionId: string, delivery: DeliveryView): NormalizedMessage | null {
  if (delivery.state === 'completed') {
    return null;
  }
  const enqueuedAt = Number.isFinite(delivery.enqueuedAt) ? delivery.enqueuedAt : Date.now();
  return {
    id: deliveryRowId(delivery.deliveryId),
    sessionId,
    timestamp: new Date(enqueuedAt).toISOString(),
    provider: 'claude',
    kind: 'command_lifecycle',
    role: 'user',
    // Only the withdrawal empties the words; a live delivery keeps the message
    // on screen — the same rule the legacy fold below applies.
    content: delivery.state === 'cancelled' ? '' : (delivery.text ?? ''),
    commandUuid: delivery.deliveryId,
    commandState: delivery.state,
    deliveryId: delivery.deliveryId,
  } as NormalizedMessage;
}

/**
 * The rows a whole snapshot draws: one per delivery, in send order.
 *
 * Deduplicated by `deliveryId`, and by nothing else. The run a command ends up
 * executing as is NOT its identity — one turn can carry several commands the
 * user sent one at a time, and keying rows by the turn (or by the run behind it)
 * would draw one row for all of them and let a withdrawal take back the wrong
 * one. A snapshot that repeated a delivery would still draw one row for it.
 */
function deliveryRowsFromSnapshot(
  sessionId: string,
  deliveries: readonly DeliveryView[],
): NormalizedMessage[] {
  const rows: NormalizedMessage[] = [];
  const seen = new Set<string>();
  for (const delivery of deliveries) {
    const deliveryId = typeof delivery?.deliveryId === 'string' ? delivery.deliveryId : '';
    if (!deliveryId || seen.has(deliveryId)) {
      continue;
    }
    seen.add(deliveryId);
    const row = residentDeliveryRow(sessionId, delivery);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

/** True when two derived row lists state the same thing, so the older one can be kept. */
function sameDeliveryRows(left: readonly NormalizedMessage[], right: readonly NormalizedMessage[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((row, at) => {
    const other = right[at];
    return row.id === other.id
      && row.commandState === other.commandState
      && row.content === other.content
      && row.timestamp === other.timestamp;
  });
}

/**
 * Drops the rows a snapshot has just spoken for.
 *
 * A snapshot does not only draw rows — it also answers for the rows this client
 * drew on its own, and those must leave as one delivery must never be two rows.
 * Two shapes are superseded, and both are this client's:
 *
 *  - the unkeyed row the composer minted at send, before any host named the
 *    command. It is claimed by a delivery in send order, on one of two readings:
 *    the delivery carries the same words (the ordinary case — the snapshot's
 *    `text` IS the command's own), or the delivery is a terminal whose clock is
 *    not before the row's, which is the only reading left for the one delivery
 *    that has no words to match (`cancelled` drops its text with the message).
 *    Claims are one-to-one, so two sends of the same words retire two rows
 *    rather than one row twice, and a row whose send the snapshot does not yet
 *    know about stays — it is newer than the snapshot, not superseded by it.
 *  - a row a legacy `command_lifecycle` frame already keyed, matched by that key
 *    (the frame's `commandUuid` is the delivery's own id).
 */
function withoutRowsSupersededBySnapshot(
  rows: NormalizedMessage[],
  deliveries: readonly DeliveryView[],
): NormalizedMessage[] {
  if (deliveries.length === 0) {
    return rows;
  }
  const named = new Set(deliveries.map((delivery) => delivery.deliveryId));
  const speakers = deliveries.filter((delivery) => delivery.state !== 'completed');

  let dropped = false;
  const kept = rows.filter((row) => {
    if (typeof row.commandUuid === 'string' && named.has(row.commandUuid)) {
      dropped = true;
      return false;
    }
    if (!isResidentPendingRow(row) || row.deliveryId) {
      return true;
    }

    const text = (row.content || '').trim();
    const clock = readMessageTime(row);
    const at = speakers.findIndex((delivery) => {
      const words = (delivery.text ?? '').trim();
      if (words.length > 0) {
        return text.length > 0 && words === text;
      }
      return clock !== null && delivery.enqueuedAt >= clock - RESIDENT_PENDING_ECHO_FLOOR_SKEW_MS;
    });
    if (at < 0) {
      return true;
    }
    speakers.splice(at, 1);
    dropped = true;
    return false;
  });
  return dropped ? kept : rows;
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 *
 * Detached from the tail, the realtime rows are buffer, not content: they are
 * excluded from the rendered list and only their own arrival bumps the store.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  const realtimeSource = slot.attached ? slot.realtimeMessages : EMPTY;
  if (slot.serverMessages === slot._lastServerRef
    && realtimeSource === slot._lastRealtimeRef
    && slot.deliveryRows === slot._lastDeliveryRowsRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = realtimeSource;
  slot._lastDeliveryRowsRef = slot.deliveryRows;
  // The delivery rows join the live end of the merge. They are rows about this
  // session's present, so they render while the window is pinned to the newest
  // turn and buffer with the rest of the realtime rows when it is not — a reader
  // scrolling through history must not see a queue drawn over an old turn.
  const realtime = slot.attached && slot.deliveryRows.length > 0
    ? [...slot.deliveryRows, ...realtimeSource]
    : realtimeSource;
  slot.merged = computeMerged(slot.serverMessages, realtime);
  return true;
}

type LatestHistoryRefreshResult = {
  applied: boolean;
  changed: boolean;
  deferred: boolean;
};

type CanRequestHistory = () => boolean;

// Token usage is JSON response data, so compare its serialized value instead
// of treating each freshly parsed response object as a state change.
function hasEquivalentTokenUsage(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function olderPagePrecedesCachedHistory(
  olderMessages: NormalizedMessage[],
  cachedMessages: NormalizedMessage[],
): boolean {
  const olderNewest = olderMessages[olderMessages.length - 1];
  const cachedOldest = cachedMessages[0];
  if (!olderNewest || !cachedOldest) return true;

  const olderTime = readMessageTime(olderNewest);
  const cachedTime = readMessageTime(cachedOldest);
  return olderTime === null || cachedTime === null || olderTime <= cachedTime;
}

/**
 * Fetches and atomically applies a bounded persisted-tail reconciliation.
 * Every request is finite. Claude/Codex bridge discovery may use more than one
 * bounded chunk because their response `total` omits paginated tool results.
 */
async function refreshLatestSlotFromServer(
  sessionId: string,
  slot: SessionSlot,
  limit: number,
  canRequest: CanRequestHistory = () => true,
): Promise<LatestHistoryRefreshResult> {
  if (!canRequest()) {
    return { applied: false, changed: false, deferred: true };
  }

  // A detached window is history the reader is holding still; refreshing the
  // persisted tail would replace it and yank the view out from under them.
  if (!slot.attached) {
    return { applied: false, changed: false, deferred: false };
  }

  const previousServerMessages = slot.serverMessages;
  const previousTotal = slot.total;
  const previousHasMore = slot.hasMore;
  const latestPage = await requestSessionHistoryPage(sessionId, {
    limit,
    offset: 0,
  });

  let nextServerMessages: NormalizedMessage[] | null = null;
  let nextHasMore = previousHasMore;

  // A page with no older rows is the complete authoritative transcript. This
  // also removes cached rows after a provider-side truncation.
  if (!latestPage.hasMore) {
    nextServerMessages = latestPage.messages;
    nextHasMore = false;
  } else if (previousServerMessages.length === 0) {
    nextServerMessages = latestPage.messages;
    nextHasMore = true;
  } else {
    let fetchedWindow = latestPage.messages;
    let oldestFetchedPage = latestPage;
    let bridgeRowsFetched = 0;
    let reachedStartOfHistory = false;
    let mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

    while (
      mergedPage.overlapLength === 0
      && !hasReachedCachedTailTimeBoundary(previousServerMessages, fetchedWindow)
    ) {
      const bridgeRequest = planLatestPageBridge(
        previousServerMessages,
        latestPage.messages,
        previousTotal,
        latestPage.total,
        bridgeRowsFetched,
      );
      if (!bridgeRequest) break;
      if (!canRequest()) {
        return { applied: false, changed: false, deferred: true };
      }

      const bridgePage = await requestSessionHistoryPage(sessionId, bridgeRequest);
      if (bridgePage.total !== latestPage.total) {
        console.warn(`[SessionStore] History changed while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false };
      }
      if (bridgePage.messages.length === 0) break;

      const bridgeMerge = mergeOlderServerPage(fetchedWindow, bridgePage.messages);
      if (
        bridgeMerge.overlapLength > 0
        || !olderPagePrecedesCachedHistory(bridgePage.messages, fetchedWindow)
      ) {
        console.warn(`[SessionStore] History shifted while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false };
      }

      fetchedWindow = bridgeMerge.messages;
      oldestFetchedPage = bridgePage;
      bridgeRowsFetched += bridgePage.messages.length;
      mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

      if (!bridgePage.hasMore) {
        reachedStartOfHistory = true;
        break;
      }
    }

    if (reachedStartOfHistory) {
      nextServerMessages = fetchedWindow;
      nextHasMore = false;
    } else if (mergedPage.overlapLength > 0) {
      nextServerMessages = mergedPage.messages;
      nextHasMore = resolveLatestPagePagination(
        previousServerMessages.length,
        nextServerMessages.length,
        previousHasMore,
        oldestFetchedPage.hasMore,
      ).hasMore;
    }
  }

  let changed = false;
  if (
    latestPage.tokenUsage !== undefined
    && !hasEquivalentTokenUsage(latestPage.tokenUsage, slot.tokenUsage)
  ) {
    slot.tokenUsage = latestPage.tokenUsage;
    changed = true;
  }

  if (!nextServerMessages) {
    console.warn(`[SessionStore] Could not bridge latest history for ${sessionId}; retaining cached suffix.`);
    return { applied: false, changed, deferred: false };
  }

  slot.serverMessages = nextServerMessages;
  slot.total = latestPage.total;
  slot.offset = nextServerMessages.length;
  slot.hasMore = nextHasMore;
  slot.startIndex = Math.max(0, slot.total - nextServerMessages.length);
  slot.endIndex = slot.total;
  slot.attached = true;
  slot.anchorIndex = Math.max(slot.startIndex, slot.endIndex - 1);
  slot.fetchedAt = Date.now();
  ({
    serverMessages: slot.serverMessages,
    realtimeMessages: slot.realtimeMessages,
  } = pruneRealtimeSupersededByServer(
    slot.serverMessages,
    slot.realtimeMessages,
    slot.blockKeyByRowId,
  ));
  recomputeMergedIfNeeded(slot);

  return { applied: true, changed: true, deferred: false };
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

/**
 * In-memory cap for a detached window. Past it the end farther from the focus
 * is dropped, so a session with thousands of rows never holds more than this
 * many normalized messages at once.
 */
const MAX_WINDOW_MESSAGES = 500;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    return store.get(sessionId)!;
  }, []);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   * The endpoint returns the standard `{ success, data }` envelope.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    slot.status = 'loading';
    notify(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      const { canRequest = () => true, ...requestOptions } = opts;
      if (!canRequest()) {
        slot.status = 'idle';
        notify(sessionId);
        return null;
      }

      try {
        const data = await requestSessionHistoryPage(sessionId, requestOptions);
        slot.serverMessages = data.messages;
        slot.total = data.total;
        slot.hasMore = data.hasMore;
        slot.offset = (requestOptions.offset ?? 0) + data.messages.length;
        // The tail page is counted back from the newest row, so its absolute start
        // is `total - offset`, not `total - length` (those agree only at offset 0).
        slot.startIndex = Math.max(0, slot.total - slot.offset);
        slot.endIndex = slot.total;
        slot.attached = true;
        slot.anchorIndex = Math.max(slot.startIndex, slot.endIndex - 1);
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        ({
          serverMessages: slot.serverMessages,
          realtimeMessages: slot.realtimeMessages,
        } = pruneRealtimeSupersededByServer(
          slot.serverMessages,
          slot.realtimeMessages,
          slot.blockKeyByRowId,
        ));
        recomputeMergedIfNeeded(slot);
        if (data.tokenUsage !== undefined) {
          slot.tokenUsage = data.tokenUsage;
        }

        notify(sessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
        slot.status = 'error';
        notify(sessionId);
        return slot;
      }
    });
  }, [getSlot, notify]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      let prependedCount = 0;
      let changed = false;
      const canRequest = opts.canRequest ?? (() => true);
      if (!slot.hasMore || !canRequest()) return { slot, prependedCount };

      try {
        // A tail-relative offset can shift while JSONL is still growing. One
        // bounded latest-page reconciliation realigns the cache, after which
        // the older-page request is retried once with the new raw-row offset.
        for (let attempt = 0; attempt < 2 && slot.hasMore; attempt++) {
          if (!canRequest()) break;

          const cachedMessages = slot.serverMessages;
          const expectedTotal = slot.total;
          const data = await requestSessionHistoryPage(sessionId, {
            limit: opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
            offset: slot.offset,
          });
          const olderMerge = mergeOlderServerPage(cachedMessages, data.messages);
          const shiftedWhileFetching = (
            data.total !== expectedTotal
            || olderMerge.overlapLength > 0
            || !olderPagePrecedesCachedHistory(data.messages, cachedMessages)
          );

          if (shiftedWhileFetching) {
            if (attempt > 0 || !canRequest()) break;
            const latestResult = await refreshLatestSlotFromServer(
              sessionId,
              slot,
              SESSION_MESSAGES_PAGE_SIZE,
              canRequest,
            );
            changed = changed || latestResult.changed;
            if (!latestResult.applied) break;
            continue;
          }

          slot.serverMessages = olderMerge.messages;
          slot.hasMore = data.hasMore;
          slot.total = data.total;
          slot.startIndex = Math.max(0, slot.startIndex - olderMerge.prependedCount);
          slot.endIndex = slot.startIndex + slot.serverMessages.length;
          slot.offset = Math.max(0, slot.total - slot.startIndex);
          slot.anchorIndex = clampIndex(slot.anchorIndex, slot.startIndex, slot.endIndex);
          prependedCount = olderMerge.prependedCount;
          if (data.tokenUsage !== undefined) {
            slot.tokenUsage = data.tokenUsage;
          }
          recomputeMergedIfNeeded(slot);
          changed = true;
          break;
        }

        if (changed) notify(sessionId);
        return { slot, prependedCount };
      } catch (error) {
        console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
        if (changed) notify(sessionId);
        return { slot, prependedCount };
      }
    });
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  /**
   * Drops the message carrying `anchorId` and everything after it.
   *
   * Sent when an already-sent message is edited: the replacement streams in
   * from the provider, so the rows it supersedes have to go first or the
   * transcript shows the question twice. Runs on every subscribed client, not
   * just the one that made the edit.
   */
  const truncateAt = useCallback((sessionId: string, anchorId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;

    const cutIndex = slot.serverMessages.findIndex(
      (message) => message.transcriptAnchorId === anchorId,
    );
    if (cutIndex < 0) return;

    slot.serverMessages = slot.serverMessages.slice(0, cutIndex);
    // Anything already streamed belonged to the turn being replaced — except
    // the replacement itself. The client that made the edit appends its
    // optimistic echo before the server acknowledges, so clearing live rows
    // outright took the message the user had just sent with it, and it only
    // came back when the run finished and the transcript was re-read.
    // Only the last one: a send that was refused leaves its echo behind, so a
    // second attempt at the same message would otherwise survive the cut
    // alongside the abandoned first and show the user both.
    const replacements = slot.realtimeMessages.filter(
      (message) => message.replacesAnchorId === anchorId,
    );
    slot.realtimeMessages = replacements.length > 0
      // Stamped here because this is the only place that knows how much of the
      // conversation survived, which is what tells the echo apart from the
      // turns it now sits after.
      ? [{ ...replacements[replacements.length - 1], replacesAfterRowCount: cutIndex }]
      : EMPTY;
    // `total` counts what the server would serve; it is about to be re-fetched
    // anyway, but leaving it high makes the pager offer pages that do not exist.
    // The window now ends at the cut, so its absolute end moves with it.
    slot.endIndex = slot.startIndex + slot.serverMessages.length;
    slot.total = slot.endIndex;
    slot.offset = slot.serverMessages.length;
    slot.attached = true;
    slot.anchorIndex = clampIndex(slot.anchorIndex, slot.startIndex, slot.endIndex);
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [notify]);

  /**
   * Adds one realtime row to the record.
   *
   * A block-keyed assistant `text` row is not added but *settles in place* when
   * this client is already streaming that same block: the server's terminal text
   * frame is the whole block's text, so appending it would draw the reply twice —
   * once as the live row still accumulating, once as the frame that just ended
   * it — with whatever tool row arrived between them keeping the two apart. The
   * live row is rewritten into the server's frame (its id, its text, its
   * timestamp), which is the same join the persisted row makes on the next
   * refresh, so the block is one row in all three states.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };

    if (normalizedMessage.blockKey && normalizedMessage.kind === 'text' && normalizedMessage.role === 'assistant') {
      const liveIndex = slot.realtimeMessages.findIndex(
        m => m.blockKey === normalizedMessage.blockKey && m.kind === 'stream_delta',
      );
      if (liveIndex >= 0) {
        const settled: NormalizedMessage = {
          ...normalizedMessage,
          blockKey: normalizedMessage.blockKey,
        };
        slot.realtimeMessages = [...slot.realtimeMessages];
        slot.realtimeMessages[liveIndex] = settled;
        slot.blockKeyByRowId.set(settled.id, settled.blockKey as string);
        recomputeMergedIfNeeded(slot);
        notify(sessionId);
        return;
      }
    }

    let updated = [...slot.realtimeMessages, normalizedMessage];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Refreshes only the persisted tail and stitches it onto the contiguous
   * cached suffix. Large turns request a small offset bridge rather than the
   * whole transcript, and the final state is applied atomically.
   */
  const refreshLatestFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const slot = getSlot(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      try {
        const result = await refreshLatestSlotFromServer(
          sessionId,
          slot,
          opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
          opts.canRequest,
        );
        if (result.changed) notify(sessionId);
        return { slot, ...result };
      } catch (error) {
        console.error(`[SessionStore] latest refresh failed for ${sessionId}:`, error);
        return { slot, applied: false, changed: false, deferred: false };
      }
    });
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create the message the session is streaming into (accumulated text
   * so far).
   *
   * The row is selected by what it *is* — the one turn in flight — rather than by
   * a per-session constant, because the id it is created with is the id it keeps
   * for the rest of its life: `finalizeStreaming` settles the row instead of
   * re-minting it, so a second turn must not find the first one's row here and
   * write over the reply it just finished.
   */
  const updateStreaming = useCallback((
    sessionId: string,
    accumulatedText: string,
    msgProvider: LLMProvider,
    opts: { blockKey?: string; timestamp?: string } = {},
  ) => {
    const slot = getSlot(sessionId);
    const { blockKey, timestamp } = opts;

    if (blockKey) {
      // A block that already settled must not be reopened by a straggling delta:
      // the terminal text frame is the block's whole content, and resurrecting
      // the live row here would put a second copy of it beside the settled one.
      const settled = slot.realtimeMessages.find(m => m.blockKey === blockKey);
      if (settled && settled.kind !== 'stream_delta') {
        return;
      }
      const existing = settled ?? null;
      const msg: NormalizedMessage = {
        ...existing,
        id: existing?.id ?? createLiveRowId(sessionId),
        blockKey,
        sessionId,
        // The block keeps the timestamp of its first frame. Re-stamping it on
        // every flush is what made the live row sort *after* the persisted echo
        // of the same reply, leaving the two non-adjacent (a tool row between
        // them) and so uncollapsible by the adjacent-echo pass.
        timestamp: existing?.timestamp ?? timestamp ?? new Date().toISOString(),
        provider: msgProvider,
        kind: 'stream_delta',
        content: accumulatedText,
      };
      slot.realtimeMessages = [...slot.realtimeMessages];
      if (existing) {
        slot.realtimeMessages[slot.realtimeMessages.findIndex(m => m.id === existing.id)] = msg;
      } else {
        slot.realtimeMessages.push(msg);
      }
      slot.blockKeyByRowId.set(msg.id, blockKey);
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return;
    }

    const existingIndex = slot.realtimeMessages.findIndex(m => m.kind === 'stream_delta' && isLiveRowId(m.id));
    const existing = existingIndex >= 0 ? slot.realtimeMessages[existingIndex] : null;
    const msg: NormalizedMessage = {
      ...existing,
      id: existing?.id ?? createLiveRowId(sessionId),
      sessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    if (existingIndex >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[existingIndex] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   *
   * The row's own id is kept. It is the transcript's React key, and a key that
   * changes here is an unmount followed by a mount on the very frame the turn
   * settles: the freshly inserted row is laid out at its `content-visibility`
   * intrinsic height for that frame, the pane's content collapses under a
   * viewport that is still on the bottom, and the browser clamps the offset to
   * the top — a jump the user sees and nothing reports. Settling the row in
   * place is what keeps the node it is drawn into.
   */
  const finalizeStreaming = useCallback((sessionId: string, opts: { blockKey?: string } = {}) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const { blockKey } = opts;
    const idx = blockKey
      ? slot.realtimeMessages.findIndex(m => m.blockKey === blockKey && m.kind === 'stream_delta')
      : slot.realtimeMessages.findIndex(m => m.kind === 'stream_delta' && isLiveRowId(m.id));
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Records a message this client sent into a resident process that was already
   * in a turn.
   *
   * The row is a realtime row like any other — it is what makes the message
   * appear in the record the moment it is sent, before the process has said
   * anything about it — but its kind is `command_lifecycle`, which is the
   * dialect's name for what it is: a command being held by a process, not a
   * turn. The id is a live-row id, which is what tells this client's own row
   * apart from the rows the same dialect serves back over REST.
   *
   * The uuid is left null. The host owns it and has not named it yet; the row
   * picks it up from the host's own `queued` event
   * ({@link applyCommandLifecycle}), which is also the only thing that makes the
   * withdrawal button addressable.
   */
  const addResidentPending = useCallback((sessionId: string, text: string) => {
    const slot = getSlot(sessionId);
    // The row's shape lives in `residentPendingRow`, the same builder the pure
    // scenario surface mints it with. The absent uuid is what
    // `applyCommandLifecycle` matches the host's first `queued` event against.
    slot.realtimeMessages = [...slot.realtimeMessages, residentPendingRow(sessionId, text)];
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Applies one `command_lifecycle` event from the host to the row it is about.
   *
   * The first `queued` event is also the adoption: the host's uuid names *a*
   * command, and the only row this client has that is waiting for one is the
   * oldest of its own without a uuid — a resident session accepts one command at
   * a time, and a process that had two in flight would have to answer which is
   * which, which its own queue does in order. Adopting in arrival order is
   * therefore the same order the host's queue reports.
   *
   * A command the session's activity snapshot has ALREADY named is a different
   * case, and takes the branch above: the frame's `commandUuid` is the delivery
   * `deliveryId` of a row the snapshot drew, so the event folds into that row
   * rather than minting a second one. Two channels, one row per delivery.
   *
   * What each state does to the row's text, and why the row itself stays:
   *
   *  - `queued` is the only state where the process has not taken the message
   *    yet, so it plainly holds the text.
   *  - `started` keeps the text too. It says the process dequeued the command
   *    into a turn, not that the turn's own rows are on screen — those reach
   *    this client asynchronously, over the socket or on the next history read,
   *    and until they do this row is the only thing carrying the message.
   *    Emptying it here is what made a busy-send message disappear before its
   *    replacement existed; the row is retired by
   *    {@link retireDeliveredResidentPending} once those rows are actually
   *    visible, which is the same "the replacement is visible" key the voice
   *    side uses for a delivered caption.
   *  - `cancelled` drops the text: the message left the record with the queue,
   *    and the state's own notice — the sentence saying it was taken back —
   *    leaves no message of its own to draw. The row stays especially here: a
   *    row that simply vanished would leave "did that go out?" unanswerable.
   *  - `completed` removes the row outright: the command ran, so the turn's own
   *    rows are the record and this one has nothing left to say.
   */
  const applyCommandLifecycle = useCallback((
    sessionId: string,
    event: { commandUuid: string; state: 'queued' | 'started' | 'cancelled' | 'completed' },
  ) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;

    // A delivery the snapshot already named: fold into THAT row. This is what
    // keeps the transition period honest — the legacy frame and the snapshot are
    // two statements about one delivery, and keying both on the delivery id is
    // what makes them one row instead of two.
    const at = event.commandUuid
      ? slot.deliveryRows.findIndex((row) => row.deliveryId === event.commandUuid)
      : -1;
    if (at >= 0) {
      const row = slot.deliveryRows[at];
      if (row.commandState === event.state) return;
      slot.deliveryRows = event.state === 'completed'
        ? slot.deliveryRows.filter((_candidate, index) => index !== at)
        : slot.deliveryRows.map((candidate, index) => (index === at
          ? { ...candidate, content: event.state === 'cancelled' ? '' : candidate.content, commandState: event.state }
          : candidate));
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return;
    }

    // The fold itself lives in `applyCommandLifecycleToRows`, which the pure
    // scenario surface replays the same timeline through. It hands back the same
    // array when the event names no row, which is this callback's no-op signal.
    const next = applyCommandLifecycleToRows(slot.realtimeMessages, event);
    if (next === slot.realtimeMessages) return;
    slot.realtimeMessages = next;

    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [notify]);

  /**
   * Replaces a session's pending-delivery rows with the rows a whole activity
   * snapshot states.
   *
   * The one writer of `slot.deliveryRows`, and the reason the transcript's
   * pending rows survive a reconnect: they are DERIVED from the snapshot rather
   * than accumulated from a run's frames, so a client that reconnects mid-queue
   * draws the queue the server just handed it, with nobody replaying a stream at
   * it. The session is created on demand — exactly as `appendRealtime` does —
   * because the activity feed and the history read are independent, and a
   * snapshot that arrives first must still draw.
   *
   * A no-op when the snapshot states what the session already holds: activity
   * frames ride every revision of the session, including ones about its task
   * table, and re-notifying the transcript for those would redraw it for free.
   */
  const applyDeliveries = useCallback((sessionId: string, deliveries: readonly DeliveryView[]) => {
    if (!sessionId) return;
    const slot = getSlot(sessionId);

    const derived = deliveryRowsFromSnapshot(sessionId, deliveries);
    const deliveryRows = sameDeliveryRows(derived, slot.deliveryRows) ? slot.deliveryRows : derived;
    const realtimeMessages = withoutRowsSupersededBySnapshot(slot.realtimeMessages, deliveries);
    if (deliveryRows === slot.deliveryRows && realtimeMessages === slot.realtimeMessages) {
      return;
    }

    slot.deliveryRows = deliveryRows;
    slot.realtimeMessages = realtimeMessages;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Loads the id-anchored window around one message id and detaches the slot
   * from the tail.
   *
   * Any realtime rows already held stay in the buffer — neither dropped nor
   * rendered — until a later window read reaches the newest row again, which
   * re-attaches the slot (see {@link loadAfter}). This is what lets a reader
   * jump into the middle of a running session without losing the turns arriving
   * behind them.
   */
  const loadWindowAround = useCallback(async (
    sessionId: string,
    id: string,
    opts: { before?: number; after?: number } = {},
  ) => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      slot.status = 'loading';
      notify(sessionId);
      try {
        const page = await requestSessionWindow(sessionId, {
          around: id,
          before: opts.before,
          after: opts.after,
        });
        const located = page.messages.findIndex((message) => windowIdOf(message) === id);
        applyWindowPage(slot, page, page.startIndex + Math.max(0, located));
        trimWindowToCap(slot);
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        recomputeMergedIfNeeded(slot);
        notify(sessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] window read failed for ${sessionId}:`, error);
        slot.status = 'error';
        notify(sessionId);
        return slot;
      }
    });
  }, [getSlot, notify]);

  /**
   * Reads an id-anchored window for the drawn scrollbar's drag and applies it,
   * returning the whole page so the scrub's loader can keep it for a later
   * back-and-forth drag. The navigation jump keeps using {@link loadWindowAround};
   * this exists only so a drag's window can be cached and re-applied.
   */
  const fetchScrubWindow = useCallback(async (
    sessionId: string,
    id: string,
    opts: { before?: number; after?: number } = {},
  ): Promise<ScrubWindowPage | null> => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      slot.status = 'loading';
      notify(sessionId);
      try {
        const page = await requestSessionWindow(sessionId, {
          around: id,
          before: opts.before,
          after: opts.after,
        });
        const located = page.messages.findIndex((message) => windowIdOf(message) === id);
        applyWindowPage(slot, page, page.startIndex + Math.max(0, located));
        trimWindowToCap(slot);
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        recomputeMergedIfNeeded(slot);
        notify(sessionId);
        return {
          id,
          messages: page.messages,
          startIndex: page.startIndex,
          endIndex: page.startIndex + page.messages.length,
          total: page.total,
          hasMoreBefore: page.hasMoreBefore,
          hasMoreAfter: page.hasMoreAfter,
        };
      } catch (error) {
        console.error(`[SessionStore] scrub window read failed for ${sessionId}:`, error);
        slot.status = 'error';
        notify(sessionId);
        return null;
      }
    });
  }, [getSlot, notify]);

  /**
   * Puts a window the scrub already read back on screen without a network read —
   * the cache hit a drag back into a previously visited stretch of the
   * conversation resolves to.
   */
  const applyScrubWindow = useCallback((sessionId: string, cached: ScrubWindowPage): void => {
    const slot = getSlot(sessionId);
    void enqueueHistoryMutation(slot, async () => {
      const anchor = cached.messages.findIndex((message) => windowIdOf(message) === cached.id);
      applyWindowPage(slot, cached, cached.startIndex + Math.max(0, anchor));
      trimWindowToCap(slot);
      slot.fetchedAt = Date.now();
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    });
  }, [getSlot, notify]);

  /**
   * Extends the window toward the front by re-reading around its first row with
   * `after: 0`. The anchor id — not an offset — is what keeps the extension
   * flush with the existing window when `total` moved underneath it.
   */
  const loadBefore = useCallback(async (
    sessionId: string,
    opts: { limit?: number } = {},
  ) => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      const first = slot.serverMessages[0];
      if (!first || slot.startIndex === 0) return slot;
      try {
        const page = await requestSessionWindow(sessionId, {
          around: windowIdOf(first),
          before: opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
          after: 0,
        });
        slot.serverMessages = unionWindowFront(slot.serverMessages, page.messages);
        slot.startIndex = page.startIndex;
        slot.endIndex = slot.startIndex + slot.serverMessages.length;
        slot.total = page.total;
        slot.hasMore = page.hasMoreBefore;
        slot.offset = Math.max(0, slot.total - slot.startIndex);
        slot.attached = slot.endIndex >= slot.total;
        slot.anchorIndex = clampIndex(slot.anchorIndex, slot.startIndex, slot.endIndex);
        trimWindowToCap(slot);
        slot.fetchedAt = Date.now();
        recomputeMergedIfNeeded(slot);
        notify(sessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] older window read failed for ${sessionId}:`, error);
        return slot;
      }
    });
  }, [getSlot, notify]);

  /**
   * Extends the window toward the newer rows by re-reading around its last row
   * with `before: 0`. When the extension reaches the newest row the slot
   * re-attaches and the buffered realtime rows fold back into the rendered list,
   * deduped against the window by id.
   */
  const loadAfter = useCallback(async (
    sessionId: string,
    opts: { limit?: number } = {},
  ) => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      const last = slot.serverMessages[slot.serverMessages.length - 1];
      if (!last || slot.endIndex >= slot.total) return slot;
      try {
        const page = await requestSessionWindow(sessionId, {
          around: windowIdOf(last),
          before: 0,
          after: opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
        });
        slot.serverMessages = unionWindowBack(slot.serverMessages, page.messages);
        slot.total = page.total;
        slot.endIndex = slot.startIndex + slot.serverMessages.length;
        slot.hasMore = slot.hasMore || page.hasMoreBefore;
        slot.offset = Math.max(0, slot.total - slot.startIndex);
        slot.attached = slot.endIndex >= slot.total;
        slot.anchorIndex = clampIndex(slot.anchorIndex, slot.startIndex, slot.endIndex);
        trimWindowToCap(slot);
        slot.fetchedAt = Date.now();
        recomputeMergedIfNeeded(slot);
        notify(sessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] newer window read failed for ${sessionId}:`, error);
        return slot;
      }
    });
  }, [getSlot, notify]);

  /**
   * Drops the held window and re-pins to the newest page, folding the realtime
   * buffer back into the rendered list. The explicit "take me to the end" move,
   * as opposed to {@link loadAfter}, which walks there one page at a time.
   */
  const jumpToLatest = useCallback(async (sessionId: string) => {
    const slot = getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      try {
        const data = await requestSessionHistoryPage(sessionId, {
          limit: SESSION_MESSAGES_PAGE_SIZE,
          offset: 0,
        });
        slot.serverMessages = data.messages;
        slot.total = data.total;
        slot.hasMore = data.hasMore;
        slot.offset = data.messages.length;
        slot.startIndex = Math.max(0, data.total - data.messages.length);
        slot.endIndex = data.total;
        slot.attached = true;
        slot.anchorIndex = Math.max(slot.startIndex, slot.endIndex - 1);
        slot.fetchedAt = Date.now();
        if (data.tokenUsage !== undefined) {
          slot.tokenUsage = data.tokenUsage;
        }
        ({
          serverMessages: slot.serverMessages,
          realtimeMessages: slot.realtimeMessages,
        } = pruneRealtimeSupersededByServer(
          slot.serverMessages,
          slot.realtimeMessages,
          slot.blockKeyByRowId,
        ));
        recomputeMergedIfNeeded(slot);
        notify(sessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] jump to latest failed for ${sessionId}:`, error);
        return slot;
      }
    });
  }, [getSlot, notify]);

  /**
   * How many realtime updates arrived while the session was detached from the
   * tail and are held, unrendered, in the buffer. Always zero when attached.
   */
  const getBufferedRealtimeCount = useCallback((sessionId: string): number => {
    const slot = storeRef.current.get(sessionId);
    if (!slot || slot.attached) return 0;
    return slot.realtimeMessages.length;
  }, []);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? EMPTY;
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  /**
   * Reads and caches a session's user-turn outline. Idempotent per session: a
   * call after a successful read is a no-op, so the rail can ask on every mount
   * without hitting the server again. Failures are swallowed to `null` rather
   * than thrown — a missing index hides the rail, it does not break the pane.
   */
  const fetchOutline = useCallback(async (sessionId: string): Promise<SessionTurnOutline | null> => {
    const slot = getSlot(sessionId);
    if (slot.outline) return slot.outline;
    try {
      slot.outline = await requestSessionOutline(sessionId);
      notify(sessionId);
    } catch (error) {
      console.error(`[SessionStore] outline read failed for ${sessionId}:`, error);
    }
    return slot.outline;
  }, [getSlot, notify]);

  /** The session's cached user-turn outline, or `null` while it has not been read. */
  const getOutline = useCallback((sessionId: string): SessionTurnOutline | null => {
    return storeRef.current.get(sessionId)?.outline ?? null;
  }, []);

  return useMemo(() => ({
    fetchFromServer,
    fetchMore,
    appendRealtime,
    truncateAt,
    refreshLatestFromServer,
    setActiveSession,
    isStale,
    updateStreaming,
    finalizeStreaming,
    addResidentPending,
    applyCommandLifecycle,
    applyDeliveries,
    loadWindowAround,
    fetchScrubWindow,
    applyScrubWindow,
    loadBefore,
    loadAfter,
    jumpToLatest,
    getBufferedRealtimeCount,
    getMessages,
    getSessionSlot,
    fetchOutline,
    getOutline,
  }), [
    fetchFromServer, fetchMore, appendRealtime, truncateAt, refreshLatestFromServer,
    setActiveSession, isStale, updateStreaming, finalizeStreaming,
    addResidentPending, applyCommandLifecycle,
    applyDeliveries,
    loadWindowAround, fetchScrubWindow, applyScrubWindow, loadBefore, loadAfter, jumpToLatest,
    getBufferedRealtimeCount, getMessages, getSessionSlot, fetchOutline, getOutline,
  ]);
}

/** Full store API returned by useSessionStore; chat hooks take it as a parameter. */
export type SessionStore = ReturnType<typeof useSessionStore>;
