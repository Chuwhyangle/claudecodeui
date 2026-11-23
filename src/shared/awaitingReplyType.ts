/**
 * The awaiting-reply wire types, a type-only leaf directly under `src/shared`.
 *
 * WHY NOT `src/shared/types.ts`: that file is an oversize-ratchet baseline entry
 * that may only shrink, and this is a new wire shape rather than an addition to
 * an existing one — the same reason `src/shared/ncLeaseType.ts` and
 * `src/shared/turnTokenUsageType.ts` sit here. Nothing imports these through
 * `@/shared/types`; every consumer names this leaf directly.
 *
 * Consumers: `src/shared/api/clientCore.ts` (the two endpoints), the sidebar's
 * awaiting-reply hook/controller and its view, and
 * `src/shared/tests/wireContractTypeSync.test.ts` (the two-end pin against
 * `server/shared/types/provider-launch.ts`).
 */
import type { LLMProvider } from '@/shared/types';

//----------------- AWAITING REPLY (sidebar inbox) ------------

/**
 * Why a session is waiting on the user. Mirrors the server's stored reason
 * (`server/shared/types/provider-launch.ts`), pinned by the wire-type sync test.
 *
 * The three answers are the three ways a session comes to rest with the user as
 * the next actor; a turn the user stopped themselves is deliberately not one of
 * them.
 */
export type AwaitingReplyReason = 'completed' | 'failed' | 'permission';

/**
 * One row of the sidebar's awaiting-reply list.
 *
 * Flat rather than a `ProjectSession` because the list spans projects and holds
 * sessions whose page the sidebar may never have loaded: a row has to be
 * drawable from this object alone. The server assembles it, and the same shape
 * arrives over the websocket as a whole-list snapshot.
 */
export type AwaitingReplyListItem = {
  sessionId: string;
  provider: LLMProvider;
  /** The owning project's database id, or null when its path has no project row. */
  projectId: string | null;
  projectPath: string | null;
  /** The project's display name; never empty. */
  projectDisplayName: string;
  /** The session's display name; never empty (falls back to its id). */
  sessionTitle: string;
  /** ISO-8601 instant the wait began. */
  awaitingSince: string;
  reason: AwaitingReplyReason;
};

/**
 * The `awaiting_reply_changed` server frame: the whole list, not one row's delta.
 *
 * A snapshot because the list is short and a client that missed a frame is
 * corrected by the next one — which also means a row removed in another browser
 * cannot linger here.
 */
export type AwaitingReplyChangedEvent = {
  kind: 'awaiting_reply_changed';
  sessions: AwaitingReplyListItem[];
  timestamp: string;
};

/**
 * What the awaiting-reply hook reads, as the sidebar controller hands it to the
 * header badge and the list view.
 *
 * Passed down rather than read twice: the badge and the view must agree, and a
 * second hook instance would own a second websocket subscription over the same
 * list.
 */
export type AwaitingReplyListState = {
  sessions: AwaitingReplyListItem[];
  /** `sessions.length`, for the header badge. */
  count: number;
  isLoading: boolean;
  /** A user-facing message when the last read failed, else null. */
  error: string | null;
  /** Whether the socket that pushes whole-list frames is up; false means the list may be stale. */
  isConnected: boolean;
  /** Takes one session off the list; restores the row if the server refuses. */
  dismiss: (sessionId: string) => Promise<void>;
  /** Re-reads the whole list from the server. */
  reload: () => Promise<void>;
};
