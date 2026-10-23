/**
 * Whether the activity dock is currently telling the reader a turn is running.
 *
 * The dock has one decision (`deriveActivityDockView`) fed by the server-backed
 * freshness reading (`useActivityFreshness`). A second surface — the empty-box
 * suggestion chips — has to obey that same decision: while the dock says a turn
 * is running, the chips must not offer an idle-only affordance, and their key
 * handling must stay off the keyboard. This hook is that one answer, so the
 * chips never grow a second, locally-fed notion of "busy" that can diverge from
 * the status bar exactly when a server-confirmed turn is running without a local
 * processing mark (another client, a voice turn, a reload).
 *
 * The turn states are `in-turn` and `unreachable`: the first is the dock drawing
 * a fresh turn, the second is the dock still holding a turn anchor it cannot
 * refresh — both are "the dock says a turn is in progress", and both must keep
 * the chips away. Everything else is not a turn: `hidden`, `background` (live
 * tasks or plans between turns), and `send-failed` (a failed send with no turn)
 * all leave the chips available.
 *
 * Consumed by chat's `ChatInterface`, which hands the answer to the composer
 * state so the chips' display and their key handling share one `visible`.
 * `activity` is the caller's local processing entry; `sendFailed` is accepted so
 * the derivation matches the composer's own view, but it cannot change this
 * answer: a failed send only replaces the dock's reading when there is no turn
 * at all, and that reading is neither of the two turn states. `taskCount` and
 * `scheduleCount` default to the zero a composer-only surface reads; the dock
 * surface's counts may be supplied when the caller has them, which is what makes
 * the `background` case reachable here.
 */

import { useActivityFreshness } from '@/modules/chat/hooks/useActivityFreshness';
import { deriveActivityDockView } from '@/modules/chat/utils/voice/activityDockView';
import type { SessionActivity } from '@/shared/types';

export type UseActivityDockTurnInput = {
  /** The chat whose activity is being read; a change starts from no evidence. */
  sessionId?: string | null;
  /** The local "processing" entry for the session, or null when there is none. */
  activity: SessionActivity | null;
  /** Whether the last send was never taken. Kept for parity with the composer's view. */
  sendFailed?: boolean;
  /** Live (non-terminal) background tasks the session holds, as the snapshot reports. */
  taskCount?: number;
  /** Cron/wakeup plans the session holds, as the snapshot reports. */
  scheduleCount?: number;
};

/**
 * True while the activity dock is drawing a turn (`in-turn` or `unreachable`),
 * derived only from `deriveActivityDockView` so the chips cannot disagree with
 * the status bar about whether a turn is running.
 */
export const useActivityDockTurn = ({
  sessionId,
  activity,
  sendFailed = false,
  taskCount = 0,
  scheduleCount = 0,
}: UseActivityDockTurnInput): boolean => {
  const freshness = useActivityFreshness(sessionId);
  const dock = deriveActivityDockView({
    activity,
    liveness: freshness.liveness,
    elapsedMs: freshness.elapsedMs,
    hasTurnAnchor: freshness.hasTurnAnchor,
    wired: freshness.wired,
    hasAbort: true,
    sendFailed,
    taskCount,
    scheduleCount,
  });
  return dock.state === 'in-turn' || dock.state === 'unreachable';
};
