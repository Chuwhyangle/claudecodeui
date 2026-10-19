import { useEffect, useState } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

/**
 * The five ways a turn can end, as the fleet overview names them.
 *
 * Mirrors `ResidentTerminalState` in `server/modules/resident-ledger/terminal-state.ts`.
 * The client cannot import the server module (it is compiled by a different
 * tsconfig and never reaches the bundle), so the closed set is stated here for
 * the same reason `ServerEvent` and `SessionActivitySnapshot` are: the wire is
 * the seam, and each side names its half of it.
 *
 * `needs-human` is defined here for completeness, but no delivery reason states
 * it — a permission refusal is a notification today, and the P4 event store is
 * what will carry it to a feed. The hook therefore does not invent the state
 * from a heuristic; it appears when that signal arrives.
 */
export type RecentTerminalState = 'success' | 'error' | 'needs-human' | 'interrupted' | 'timeout';

/** One turn that ended, as the landing overview's "recently ended" panel draws it. */
export type RecentSessionEnding = {
  /** `sessionId:deliveryId` — the ledger's own identity for the ending, used to dedupe snapshots. */
  readonly key: string;
  readonly sessionId: string;
  readonly deliveryId: string;
  readonly state: RecentTerminalState;
  /** The ledger's reason word behind the state, for tracing; null for a clean completion. */
  readonly reason: string | null;
  /** When the CLI stated the terminal, from the ledger's clock. */
  readonly endedAt: number;
};

/**
 * How many endings the feed keeps. The panel is a glance, not a log: the
 * persistent history belongs to the event store (P4), and a landing page that
 * grew without bound would be a second, half-correct one.
 */
const MAX_ENDINGS = 12;

/** The session activity frames that carry a ledger's delivery projection. */
const ACTIVITY_FRAME_KINDS = new Set(['activity.snapshot', 'activity.upsert']);

/**
 * Classifies one delivery entry from an activity snapshot.
 *
 * Only a terminal entry classifies; a queued or running command says nothing
 * about how a turn ended. The reasons are the ledger's own words, so this maps
 * them one-for-one rather than inferring: `process-exit` and a CLI-stated
 * cancellation nobody here asked for are errors, `owed-terminal-missing` is the
 * terminal that never came, and the two requested endings (interrupt and
 * withdrawal) are interruptions.
 */
function classifyDelivery(entry: Record<string, unknown>): RecentTerminalState | null {
  const state = entry.state;
  if (state === 'completed') {
    return 'success';
  }
  if (state !== 'cancelled') {
    return null;
  }

  switch (entry.reason) {
    case 'interrupt':
    case 'withdrawn':
      return 'interrupted';
    case 'owed-terminal-missing':
      return 'timeout';
    case 'process-exit':
      return 'error';
    default:
      // A cancel with no reason this host caused — the CLI's own residual.
      return 'error';
  }
}

/**
 * Folds a frame's `deliveries` into terminal endings.
 *
 * The snapshot is a whole-body read, re-sent on every change, so every ended
 * delivery inside the retention window appears in every frame. Endings are
 * therefore keyed by `sessionId:deliveryId` and deduped; a repeated frame is a
 * no-op rather than a second row.
 */
function endingsFromFrame(event: ServerEvent): RecentSessionEnding[] {
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
  const deliveries = event.deliveries;
  if (!sessionId || !Array.isArray(deliveries)) {
    return [];
  }

  const endings: RecentSessionEnding[] = [];
  for (const value of deliveries) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const deliveryId = typeof entry.deliveryId === 'string' ? entry.deliveryId : '';
    const endedAt = typeof entry.endedAt === 'number' ? entry.endedAt : null;
    const state = classifyDelivery(entry);
    if (!deliveryId || endedAt === null || state === null) {
      continue;
    }
    endings.push({
      key: `${sessionId}:${deliveryId}`,
      sessionId,
      deliveryId,
      state,
      reason: typeof entry.reason === 'string' ? entry.reason : null,
      endedAt,
    });
  }
  return endings;
}

/**
 * The page's "recently ended" feed, folded from the activity frames it already
 * receives.
 *
 * The delivery projection travels inside the same `activity.snapshot` /
 * `activity.upsert` bodies P1's sidebar reads for a turn's phase, so the landing
 * needs no second subscription and no new endpoint: a session whose activity is
 * being followed has its endings observed here as well. The subscription itself
 * is the provider's (`activity.subscribe` for every running session), not this
 * hook's — asking twice would be two cursors for one reading.
 *
 * The feed is forward-only: it starts empty on a page load and fills as turns
 * end while the page is open. That is the honest shape for a client-side
 * projection whose source has no history endpoint; the persistent feed is P4's
 * event store. Keeping it forward-only is also what makes it impossible for this
 * panel to claim it knows about a session that ended before this tab existed.
 */
export function useRecentSessionEndings(): readonly RecentSessionEnding[] {
  const { subscribe } = useWebSocket();
  const [endings, setEndings] = useState<readonly RecentSessionEnding[]>([]);

  useEffect(() => subscribe((event: ServerEvent) => {
    if (typeof event.kind !== 'string' || !ACTIVITY_FRAME_KINDS.has(event.kind)) {
      return;
    }
    const observed = endingsFromFrame(event);
    if (observed.length === 0) {
      return;
    }

    setEndings((previous) => {
      const known = new Set(previous.map((ending) => ending.key));
      const fresh = observed.filter((ending) => !known.has(ending.key));
      if (fresh.length === 0) {
        return previous;
      }
      return [...fresh, ...previous]
        .sort((left, right) => right.endedAt - left.endedAt)
        .slice(0, MAX_ENDINGS);
    });
  }), [subscribe]);

  return endings;
}
