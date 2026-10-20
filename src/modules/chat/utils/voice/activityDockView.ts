/**
 * What the activity dock should say, derived from two independent readings.
 *
 * The dock is the one surface that must never lie about a turn: it reads the
 * client's local "a turn is running" table *and* the freshness of the server's
 * evidence, and speaks about whichever is more honest. This module is that
 * decision, kept pure — it takes the local activity, the liveness the freshness
 * machine last computed, and the server-derived elapsed time, and returns the
 * state, the elapsed seconds to draw, and whether the stop control is operable.
 *
 * The rule it encodes: **a turn with no fresh evidence is `unreachable`, not
 * `in-turn`**. The benign default — keep showing the turn because the local
 * table still has it — is exactly what let a dead server keep the dock
 * "thinking". A second, narrower lie is closed the same way: a *fresh* turn the
 * server keeps proving it is there for, but which it has never described with a
 * phase, must not be drawn as `Working…` — the dock is waiting on the server's
 * own reading, and says so (`awaitingServer`). The elapsed reading is passed
 * through untouched and is never recomputed from a local clock here; when the
 * caller freezes it (because the server's `asOf` stopped advancing), it stays
 * frozen.
 *
 * Used by chat's activity dock (`ActivityIndicator`) and, for the composer's
 * stop entry, by `ChatComposer`; its criterion is
 * `src/modules/chat/tests/activityDockUnreachable.test.tsx`, and the honest
 * waiting wording is pinned by `activityDockHonestStatus.test.tsx`.
 */

import type { ActivityDockState, ActivityPhase, SessionActivity } from '@/shared/types';
import type { ActivityLiveness } from '@/modules/chat/utils/session/activityFreshness';

/** The i18n key (chat namespace) that explains why the stop is unavailable. */
export const UNREACHABLE_STOP_REASON_KEY = 'claudeStatus.unreachable.stopReason';

/**
 * How long a turn may run with the server naming no phase before the dock stops
 * claiming it is working.
 *
 * The dock's running word is the phase the server reduced, and `idle` means the
 * server has named nothing. A turn that has been running this long with no phase
 * from the server is not what `Working…` says it is — the local table still
 * holds the turn, but the server is reporting no activity for it — so the dock
 * says the honest thing instead: it is waiting on the server. The threshold is
 * what keeps the *other* reading honest too: a turn the server has just anchored
 * still reads the running word at t=0, so the two opposite-direction positive
 * controls (`activityDockUnreachable`, `activityDockProgressReading`) stay green.
 *
 * Measured on the server-derived elapsed — never a local clock — so the reading
 * cannot drift from the one the dock draws beside it.
 *
 * Read by this module's own decision (`deriveActivityDockView`) and, through the
 * `awaitingServer` reading it publishes, by `ActivityIndicator`'s label; the
 * criterion that drives it past the threshold is
 * `src/modules/chat/tests/activityDockHonestStatus.test.tsx`.
 */
export const UNCONFIRMED_TURN_LABEL_MS = 15_000;

/** Everything `deriveActivityDockView` needs, each from the source that owns it. */
export type ActivityDockInput = {
  /** The session's local "processing" entry, or null when the table has none. */
  activity: SessionActivity | null;
  /** Whether the client's last liveness reading was fresh or unreachable. */
  liveness: ActivityLiveness;
  /** Server-derived elapsed time of the turn in ms, or null when unknown. */
  elapsedMs: number | null;
  /** True while the freshness machine still holds a turn anchor for this session. */
  hasTurnAnchor: boolean;
  /**
   * True when the dock is wired to a liveness channel at all. Without one the
   * client cannot assert unreachability, so the dock keeps the legacy reading
   * of the local activity — this is the only branch that does not degrade.
   */
  wired: boolean;
  /**
   * True when this surface owns an interrupt handler. No dock surface does any
   * more — the composer's submit button is the one stop entry at every viewport —
   * but the composer still reads `stopReasonKey` off this view to explain its own
   * disabled stop, so the flag survives for that consumer.
   */
  hasAbort: boolean;
  /**
   * True when the last send was never taken — the socket was gone, or no answer
   * came back inside the send deadline. It only speaks while there is no turn
   * to speak about: a session the local table still reports as running has a
   * turn, and that reading is what the dock owes the user. This is also what
   * makes the failure honest — a retained "processing" mark (the defect this
   * state exists to replace) leaves the turn branch in force and the dock never
   * reaches here.
   */
  sendFailed?: boolean;
  /**
   * The phase the server last reported for this session's turn, or null/absent
   * when no server ever reported one. The dock never derives a phase itself —
   * this is a passthrough of the server's own frame reduction.
   */
  phase?: ActivityPhase | null;
  /** The pending tool's name while `phase` is `tool`; null otherwise. */
  toolName?: string | null;
  /**
   * How many *live* background tasks the session is holding, from the activity
   * snapshot. The caller filters terminal rows out before passing it (see
   * `selectActiveTasks`), because the dock speaks about current activity only:
   * a finished task must not hold the dock open. Drives the dock's task count
   * and — with no turn to speak about — whether the dock draws at all.
   */
  taskCount?: number;
  /** How many cron/wakeup plans the session is holding, from the activity snapshot. */
  scheduleCount?: number;
};

/** The dock's decision: which state to publish and what the controls may do. */
export type ActivityDockView = {
  state: ActivityDockState;
  /** Server-derived elapsed in ms; null when there is nothing honest to show. */
  elapsedMs: number | null;
  /** Whole seconds of `elapsedMs`, for the elapsed label; null when unknown. */
  elapsedSeconds: number | null;
  /** i18n key explaining a disabled stop; null when the stop is operable. */
  stopReasonKey: string | null;
  /** The phase the dock speaks for; `idle` when the server reported none. */
  phase: ActivityPhase;
  /** The pending tool's name, or null. Only meaningful while `phase` is `tool`. */
  toolName: string | null;
  /**
   * The chat-namespace i18n key for the phase's label, or null when the phase has
   * no running label (`idle`, or a server that reported no phase). The label is a
   * function of the phase alone — never of elapsed time.
   */
  phaseLabelKey: string | null;
  /**
   * True when the dock is a fresh, running turn whose phase the server has named
   * none of for longer than `UNCONFIRMED_TURN_LABEL_MS`. The caller draws its
   * "waiting for the server" wording for this instead of the running word, and
   * the state stays `in-turn` — the turn is real; only the server's description
   * of it is missing, so the turn's own Stop survives.
   */
  awaitingServer: boolean;
  /** Live (non-terminal) background tasks the session holds, as last reported. */
  taskCount: number;
  /** Cron/wakeup plans the session holds, as the snapshot last reported. */
  scheduleCount: number;
};

/**
 * The label key for one phase, or null when the phase has no running word.
 *
 * A `tool` phase with a name gets the `{{tool}}` key; without one it falls back
 * to the plain phase word rather than rendering a dangling placeholder.
 */
export function activityPhaseLabelKey(
  phase: ActivityPhase,
  toolName: string | null,
): string | null {
  switch (phase) {
    case 'thinking':
      return 'claudeStatus.phases.thinking';
    case 'writing':
      return 'claudeStatus.phases.writing';
    case 'tool':
      return toolName === null ? 'claudeStatus.phases.toolGeneric' : 'claudeStatus.phases.tool';
    case 'compacting':
      return 'claudeStatus.phases.compacting';
    case 'awaitingPermission':
      return 'claudeStatus.phases.awaitingPermission';
    default:
      return null;
  }
}

const HIDDEN: ActivityDockView = {
  state: 'hidden',
  elapsedMs: null,
  elapsedSeconds: null,
  stopReasonKey: null,
  phase: 'idle',
  toolName: null,
  phaseLabelKey: null,
  awaitingServer: false,
  taskCount: 0,
  scheduleCount: 0,
};

/** The failed-send reading: a state of its own, and deliberately no turn. */
const SEND_FAILED: ActivityDockView = {
  state: 'send-failed',
  elapsedMs: null,
  elapsedSeconds: null,
  stopReasonKey: null,
  phase: 'idle',
  toolName: null,
  phaseLabelKey: null,
  awaitingServer: false,
  taskCount: 0,
  scheduleCount: 0,
};

/** The elapsed fields both visible states share. */
const elapsedFields = (elapsedMs: number | null) => {
  const elapsed = elapsedMs !== null && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null;
  return {
    elapsedMs: elapsed,
    elapsedSeconds: elapsed === null ? null : Math.floor(elapsed / 1000),
  };
};

/**
 * Decide what the dock shows. Pure: same input, same output, no clock of its own.
 */
export const deriveActivityDockView = (input: ActivityDockInput): ActivityDockView => {
  const {
    activity,
    liveness,
    elapsedMs,
    hasTurnAnchor,
    wired,
    hasAbort,
    sendFailed = false,
    phase = 'idle',
    toolName = null,
    taskCount = 0,
    scheduleCount = 0,
  } = input;
  const elapsed = elapsedFields(elapsedMs);
  // The background readings are carried onto every view so the dock and its
  // panel read the counts from one place. Clamped at zero: a negative count is
  // not a reading this surface can draw, and a snapshot never produces one.
  const counts = {
    taskCount: Math.max(0, Math.trunc(taskCount)),
    scheduleCount: Math.max(0, Math.trunc(scheduleCount)),
  };
  // The phase the server reported, carried onto every view so the dock can
  // publish it verbatim — the label and the `data-activity-phase` attribute then
  // come from one source instead of two.
  const phaseFields = {
    phase: phase ?? 'idle',
    toolName: phase === 'tool' ? toolName : null,
    phaseLabelKey: activityPhaseLabelKey(phase ?? 'idle', toolName),
  } as const;

  // Nothing to speak about: no local turn and no anchor the server ever confirmed.
  // A send that was never taken is the one thing there is to say in that void —
  // reporting the failure is the honest reading, not staying silent as the old
  // indicator did while the message was already gone. Background work is the
  // second thing to say: a *live* task or plan is worth a surface between turns,
  // which is what the `background` state is for. `taskCount` is the caller's
  // `selectActiveTasks` reading, so a session whose tasks have all finished
  // falls through to `hidden` and the dock retires itself.
  if (activity === null && !hasTurnAnchor) {
    if (sendFailed) {
      return { ...SEND_FAILED, ...counts };
    }
    if (counts.taskCount > 0 || counts.scheduleCount > 0) {
      return {
        state: 'background',
        ...elapsed,
        stopReasonKey: null,
        ...phaseFields,
        awaitingServer: false,
        ...counts,
      };
    }
    return HIDDEN;
  }

  // A wired dock with no fresh evidence reports the connection, not the turn. The
  // reason a stop cannot be used is still published, because the composer's own
  // stop entry reads it to explain its disabled state.
  if (wired && liveness === 'unreachable') {
    return {
      state: 'unreachable',
      ...elapsed,
      stopReasonKey: hasAbort ? UNREACHABLE_STOP_REASON_KEY : null,
      ...phaseFields,
      awaitingServer: false,
      ...counts,
    };
  }

  // Fresh (or unwired, where no liveness claim can be made): the turn is the story.
  // The one thing the turn owes the reader is not to claim work the server is not
  // reporting: a phase the server has never named, held this long, is the dock
  // waiting on the server, not the session working.
  return {
    state: 'in-turn',
    ...elapsed,
    stopReasonKey: null,
    ...phaseFields,
    awaitingServer:
      phaseFields.phase === 'idle' &&
      elapsed.elapsedMs !== null &&
      elapsed.elapsedMs >= UNCONFIRMED_TURN_LABEL_MS,
    ...counts,
  };
};
