/**
 * The terminal taxonomy the fleet overview's "recently ended" feed is built on
 * (fleet-overview SPEC §5.1 event source 1, §11 risk 1).
 *
 * ## What this module answers
 *
 * One closed resident turn ended in exactly one way a person can act on. The
 * ledger already states the evidence — a delivery's `state`/`reason`, a turn's
 * `outcome`, and the anomalies the driver recorded beside them — but it states
 * it in the CLI's vocabulary and spread across three collections. This file
 * reduces that evidence to one word per ended turn:
 *
 *  - `success`     — the turn closed and every command bound to it completed.
 *  - `error`       — a command ended in a way nobody here asked for: the CLI
 *                    cancelled it on its own (`cli`), or the process went away
 *                    mid-delivery (`process-exit`).
 *  - `needs-human` — the ledger recorded a permission-scoped anomaly: a request
 *                    reached a wall only a person could clear.
 *  - `interrupted` — this host's interrupt is what ended it (`interrupt`), a
 *                    queued command was withdrawn, the turn closed `aborted`, or
 *                    an unanswered interrupt was recorded (`interrupt-no-result`).
 *  - `timeout`     — the terminal never arrived and the ledger settled it
 *                    (`owed-terminal-missing`).
 *
 * The suggestion in the task listed the same five and said they may be adjusted;
 * the adjustment made here is that `needs-human` is read from a *ledger anomaly*
 * rather than from a delivery reason, because a permission refusal is a fact
 * about a request, not about a command's lifecycle. The driver currently reports
 * that refusal as a notification rather than forwarding it to the ledger, so on
 * today's tree the state is reachable only by an injected anomaly (the event
 * backbone in P4 is what will forward it). The reduction classifies it now so
 * that event source has one place to land.
 *
 * ## Precedence, and why it is attention-first
 *
 * A turn can carry more than one piece of evidence (an interrupt that was
 * followed by the process exiting, a timeout reconciliation beside a completed
 * sibling command). The reduction reports the most attention-worthy evidence it
 * holds: `needs-human` > `error` > `timeout` > `interrupted` > `success`. The
 * ordering is not about frequency — it is about what a reader of the fleet
 * overview must not miss. A turn that needs a person is never reported as a
 * clean success because a different bound command completed.
 *
 * ## Anomalies have no timestamps
 *
 * `ResidentLedgerAnomaly` is `{ code, detail }` — the ledger records no instant
 * for it, so an anomaly cannot be ordered against a turn by time. Two of the
 * three terminal anomalies name their subject in `detail` (`delivery <uuid> …`,
 * `turn <id> …`), and those are attached through the named subject. The
 * permission anomaly names no subject; it is attached to the newest closed turn
 * (or, when no turn has closed, reported as a reading of its own with a null
 * turn id). That is stated here rather than inferred at each call site so a
 * future producer that adds a timestamp can tighten it in one place.
 *
 * ## What this module is not
 *
 * It does not read a clock, write the ledger, or decide what to do about the
 * result. It is a projection, and `resident-ledger` stays a leaf: this file
 * imports `@/shared/types.js` and nothing else.
 */
import type {
  ResidentLedger,
  ResidentLedgerAnomaly,
  ResidentLedgerClosedTurn,
  ResidentLedgerDelivery,
} from '@/shared/types.js';

// ---------------------------------------------------------------------------
// The taxonomy
// ---------------------------------------------------------------------------

/**
 * The word a turned-ended entry carries for a person reading the fleet overview.
 *
 * Deliberately a closed set: the feed groups and colours by it, and a producer
 * that invented a sixth word would render under no heading at all. A new ending
 * shape belongs in {@link ResidentTerminalState} with a case in
 * {@link classifyTurn}, not as a free-form string.
 */
export type ResidentTerminalState = 'success' | 'error' | 'needs-human' | 'interrupted' | 'timeout';

/** One ended turn, reduced to the word the overview draws and the evidence behind it. */
export type ResidentTerminalReading = {
  /** What the ending was, in the taxonomy above. */
  readonly state: ResidentTerminalState;
  /** The turn this reading is about, or null for an anomaly with no turn to attach to. */
  readonly turnId: string | null;
  /** The delivery whose ending decided the word, when a delivery decided it. */
  readonly deliveryId: string | null;
  /** When that delivery ended (the ledger's own clock), or null for an anomaly-only reading. */
  readonly at: number | null;
  /** The reason or anomaly code behind the word, so a reader can trace it. */
  readonly detail: string | null;
};

/**
 * How strongly each state asks for a person's attention.
 *
 * The numbers are only an ordering; they are never rendered. `success` is the
 * floor and `needs-human` the ceiling, for the reason stated in the module
 * comment: a turn that needs somebody must not be hidden behind a sibling
 * command's clean ending.
 */
const STATE_PRIORITY: Record<ResidentTerminalState, number> = {
  'needs-human': 4,
  error: 3,
  timeout: 2,
  interrupted: 1,
  success: 0,
};

/** The evidence one ending contributes, before precedence is applied. */
type Evidence = {
  readonly state: ResidentTerminalState;
  readonly deliveryId: string | null;
  readonly at: number | null;
  readonly detail: string;
};

// ---------------------------------------------------------------------------
// Delivery evidence
// ---------------------------------------------------------------------------

/**
 * What one delivery's own ending says about its turn, or null while it is not
 * terminal.
 *
 * `completed` is a clean ending. Of the cancelled reasons, only
 * `owed-terminal-missing` is a timeout — the run closed and the CLI never
 * stated a terminal before the next turn began (I4's reconciliation), which is
 * the ledger's own name for "the answer never came". `process-exit` and the
 * `cli` residual are errors: the process died mid-command, or the CLI withdrew a
 * command this host never asked it to withdraw. `interrupt` and `withdrawn` are
 * the two endings somebody here asked for, and both read `interrupted`.
 */
function deliveryEvidence(delivery: ResidentLedgerDelivery): Evidence | null {
  if (delivery.state === 'completed') {
    return {
      state: 'success',
      deliveryId: delivery.commandUuid,
      at: delivery.endedAt,
      detail: 'completed',
    };
  }

  if (delivery.state !== 'cancelled') {
    // `pushed`, `queued` and `started` are still running: they say nothing about
    // how the turn ended.
    return null;
  }

  switch (delivery.reason) {
    case 'interrupt':
    case 'withdrawn':
      return {
        state: 'interrupted',
        deliveryId: delivery.commandUuid,
        at: delivery.endedAt,
        detail: delivery.reason,
      };
    case 'owed-terminal-missing':
      return {
        state: 'timeout',
        deliveryId: delivery.commandUuid,
        at: delivery.endedAt,
        detail: delivery.reason,
      };
    case 'process-exit':
      return {
        state: 'error',
        deliveryId: delivery.commandUuid,
        at: delivery.endedAt,
        detail: delivery.reason,
      };
    case 'cli':
    case null:
    default:
      // A cancel nobody here asked for. The CLI states no reason beyond its own
      // withdrawal, which is an abnormal ending from this host's point of view.
      return {
        state: 'error',
        deliveryId: delivery.commandUuid,
        at: delivery.endedAt,
        detail: delivery.reason ?? 'cancelled-without-request',
      };
  }
}

// ---------------------------------------------------------------------------
// Anomaly evidence
// ---------------------------------------------------------------------------

/** The delivery uuid an `owed-terminal-missing` detail names, or null. */
function deliveryUuidFromDetail(detail: string): string | null {
  const match = /^delivery (\S+) reached/.exec(detail);
  return match ? match[1] : null;
}

/** The turn id an `interrupt-no-result` detail names, or null when it names none. */
function turnIdFromDetail(detail: string): string | null {
  const match = /^turn (\S+) got no RESULT/.exec(detail);
  return match ? match[1] : null;
}

type AnomalyEvidence = Evidence & {
  /** The closed turn the anomaly names, or null when it names none. */
  readonly turnId: string | null;
};

/**
 * What one recorded anomaly says about the ledger's ending, or null for the
 * anomalies that say nothing about one.
 *
 * `double-init`, `frame-without-turn` and the rest are contract violations the
 * driver records; they are facts about the stream, not endings, and treating
 * them as terminal evidence would make every later turn read as broken.
 */
function anomalyEvidence(
  anomaly: ResidentLedgerAnomaly,
  ledger: ResidentLedger,
): AnomalyEvidence | null {
  if (anomaly.code.startsWith('permission.')) {
    return {
      state: 'needs-human',
      deliveryId: null,
      at: null,
      detail: anomaly.code,
      turnId: null,
    };
  }

  if (anomaly.code === 'owed-terminal-missing') {
    const uuid = deliveryUuidFromDetail(anomaly.detail);
    const delivery = uuid === null ? null : ledger.byUuid.get(uuid) ?? null;
    return {
      state: 'timeout',
      deliveryId: delivery?.commandUuid ?? null,
      at: delivery?.endedAt ?? null,
      detail: anomaly.code,
      turnId: delivery?.turnId ?? null,
    };
  }

  if (anomaly.code === 'interrupt-no-result') {
    return {
      state: 'interrupted',
      deliveryId: null,
      at: null,
      detail: anomaly.code,
      turnId: turnIdFromDetail(anomaly.detail),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Picks the evidence that asks for the most attention; ties go to the later ending. */
function strongest(evidence: readonly Evidence[]): Evidence | null {
  let best: Evidence | null = null;
  for (const candidate of evidence) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const priority = STATE_PRIORITY[candidate.state] - STATE_PRIORITY[best.state];
    if (priority > 0 || (priority === 0 && (candidate.at ?? -Infinity) > (best.at ?? -Infinity))) {
      best = candidate;
    }
  }
  return best;
}

/**
 * One closed turn's reading: the strongest evidence bound to it, or `success`
 * when nothing adverse was recorded.
 *
 * An unattended turn (one nothing here pushed) has no bound delivery; a clean
 * close is its success. An `aborted` close is interrupt evidence by definition
 * (the ledger reaches that outcome only for `is_error ∧ interruptRequested`), so
 * it contributes even when the delivery's own terminal has not been read yet.
 */
function classifyTurn(
  turn: ResidentLedgerClosedTurn,
  evidence: readonly Evidence[],
): ResidentTerminalReading {
  const bound = evidence.slice();
  if (turn.outcome === 'aborted') {
    bound.push({
      state: 'interrupted',
      deliveryId: turn.ownerDeliveryId,
      at: null,
      detail: 'aborted',
    });
  }

  const decided = strongest(bound);
  if (decided === null) {
    return {
      state: 'success',
      turnId: turn.id,
      deliveryId: turn.ownerDeliveryId,
      at: null,
      detail: 'completed',
    };
  }

  return {
    state: decided.state,
    turnId: turn.id,
    deliveryId: decided.deliveryId,
    at: decided.at,
    detail: decided.detail,
  };
}

/**
 * Reduces the ledger to one reading per closed turn, oldest first.
 *
 * This is the whole public surface: a caller that wants the most recent ending
 * reads the last entry. A ledger with no ended turn answers an empty array —
 * "nothing has ended" is not a terminal state and must not be invented as one.
 *
 * Anomalies that name their subject (`owed-terminal-missing`, whose detail
 * carries a delivery uuid, and `interrupt-no-result`, whose detail carries a turn
 * id) are attached to that subject's turn. A `permission.*` anomaly names no
 * subject and is attached to the newest closed turn; with no closed turn it is
 * reported as a reading of its own, because the ledger did record an ending even
 * though no turn was closed around it.
 */
export function deriveTerminalStates(ledger: ResidentLedger): readonly ResidentTerminalReading[] {
  const byTurn = new Map<string, Evidence[]>();
  const unattached: Evidence[] = [];

  const addToTurn = (turnId: string | null, item: Evidence): void => {
    if (turnId === null) {
      unattached.push(item);
      return;
    }
    const existing = byTurn.get(turnId);
    if (existing) {
      existing.push(item);
    } else {
      byTurn.set(turnId, [item]);
    }
  };

  for (const delivery of ledger.deliveries) {
    const item = deliveryEvidence(delivery);
    if (item !== null) {
      // A delivery with no turn (`turnId === null`) belongs to no closed turn;
      // it is evidence about a queued command, not about how one ended.
      if (delivery.turnId !== null) {
        addToTurn(delivery.turnId, item);
      }
    }
  }

  for (const anomaly of ledger.anomalies) {
    const item = anomalyEvidence(anomaly, ledger);
    if (item !== null) {
      addToTurn(item.turnId, item);
    }
  }

  const readings = ledger.closedTurns.map((turn) => classifyTurn(turn, byTurn.get(turn.id) ?? []));

  if (unattached.length > 0) {
    const decided = strongest(unattached);
    if (decided !== null) {
      const reading: ResidentTerminalReading = {
        state: decided.state,
        turnId: null,
        deliveryId: decided.deliveryId,
        at: decided.at,
        detail: decided.detail,
      };
      if (readings.length === 0) {
        return [reading];
      }
      // The newest closed turn is the one the unattached evidence is read
      // against — see the module comment on why anomalies carry no timestamp.
      const merged = strongest([
        {
          state: readings[readings.length - 1].state,
          deliveryId: readings[readings.length - 1].deliveryId,
          at: readings[readings.length - 1].at,
          detail: readings[readings.length - 1].detail ?? '',
        },
        ...unattached,
      ]);
      if (merged !== null) {
        readings[readings.length - 1] = {
          state: merged.state,
          turnId: readings[readings.length - 1].turnId,
          deliveryId: merged.deliveryId,
          at: merged.at,
          detail: merged.detail,
        };
      }
    }
  }

  return readings;
}
