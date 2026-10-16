/**
 * The resident host's delivery/turn ledger: its types, its transitions, and the
 * projections its owner reads it through (SPEC `resident-delivery-turn-ledger`
 * §5, AC-395).
 *
 * ## What lives here and what does not
 *
 * The ledger is the host's own account of what it sent and what the CLI said
 * came of it: which commands are outstanding, which turn is open, which turns
 * have closed and how. It used to be inline in `claude-host-driver.provider.ts`
 * — a bag of fields the driver reached into from fifty places, with the same
 * transition spelled out three times and the same anomaly written twice. This
 * module is that state and those transitions, extracted, so the driver holds one
 * instance per host and *forwards events* to it instead of editing it.
 *
 * Everything here is a pure function of the ledger plus the event: no clock, no
 * timers, no writer, no promise. The driver computes the readings an event needs
 * from its own state before calling (a `cancelled` reason, a turn's outcome) and
 * performs the awaited work its effects ask for after returning
 * (`stopResidentTurn`, `armInterruptWatchdog`, writing a run's terminal frame,
 * settling a dispatcher). That split is the point of the extraction: the ledger
 * decides *what the state is*, the driver decides *what to do about it*.
 *
 * ## The three rules that make it one ledger rather than fifty fields
 *
 *  - **one transition per event.** `applyLedgerEvent` is the only writer. A
 *    caller cannot reach the mutable state — `ResidentLedger` is the read-only
 *    view declared in `@/shared/types.ts`, so a driver-side write is a compile
 *    error (TS2540), not a review comment.
 *  - **the fixed tail belongs to the driver.** A transition returns whether the
 *    ledger changed and what the driver must do; it never syncs a lease or
 *    publishes a snapshot itself, and it carries no per-transition copy of that
 *    tail.
 *  - **effects are data.** {@link ResidentLedgerEffect} is a discriminated union
 *    of plain records — no function members — so a criterion can assert the
 *    transition's whole answer without running the driver's half of it.
 *
 * ## What the ledger does NOT carry
 *
 * No driver types: the dispatcher's round, the manager lease a delivery holds,
 * the run writer a terminal frame goes to. Those are indexed by `commandUuid` on
 * the driver side (AC-395 (d)). This module imports shared types and nothing
 * else, which is what keeps the ledger movable and lets AC-396 measure it.
 */
import {
  isTerminalDeliveryState,
  type ChatRunSource,
  type ClaudeResidentDeliveryReason,
  type CommandLifecycleState,
  type ResidentLedger,
  type ResidentLedgerAnomaly,
  type ResidentLedgerClosedTurn,
  type ResidentLedgerDelivery,
  type ResidentLedgerTurn,
} from '@/shared/types.js';

// ---------------------------------------------------------------------------
// The mutable shape the transitions write
//
// The exported `ResidentLedger` is deeply read-only; this is the same object
// seen from inside, where the transition functions are the only writers. The
// cast in {@link mutable} is the one place the two views meet, and it is
// deliberate: the compiler enforces "one writer" everywhere else.
// ---------------------------------------------------------------------------

/** The read-only modifiers stripped, one level deep. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type LedgerDeliveryState = Mutable<ResidentLedgerDelivery>;
type LedgerTurnState = Mutable<ResidentLedgerTurn>;
type LedgerClosedTurnState = Mutable<ResidentLedgerClosedTurn>;
type LedgerAnomalyState = Mutable<ResidentLedgerAnomaly>;

type LedgerState = {
  deliveries: LedgerDeliveryState[];
  byUuid: Map<string, LedgerDeliveryState>;
  foreign: Set<string>;
  turn: LedgerTurnState | null;
  closedTurns: LedgerClosedTurnState[];
  pendingStart: LedgerDeliveryState[];
  anomalies: LedgerAnomalyState[];
};

/**
 * The ledger seen from inside, where the transitions write it.
 *
 * `unknown` is needed because the read-only view and the mutable shape are
 * structurally different only in their modifiers; TypeScript will not narrow one
 * to the other directly. Every caller of this function is a transition in this
 * file, which is what the read-only view is protecting.
 */
function mutable(ledger: ResidentLedger): LedgerState {
  return ledger as unknown as LedgerState;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One thing that can happen to the ledger (SPEC §5.2).
 *
 * `at` is the moment the driver read, passed in rather than read here: the
 * ledger has no clock, and a criterion that drives these transitions directly
 * has to be able to state the timestamps it is asserting about.
 */
export type ResidentLedgerEvent =
  | {
      /** A send this host accepted: the CLI has not spoken about it yet. */
      readonly kind: 'send';
      readonly at: number;
      readonly commandUuid: string;
      readonly uuids: readonly string[];
      readonly text: string;
      readonly source: ChatRunSource;
      readonly priority: string | null;
    }
  | {
      /** One `command_lifecycle` statement from the CLI. */
      readonly kind: 'lifecycle';
      readonly at: number;
      readonly commandUuid: string;
      readonly lifecycle: CommandLifecycleState;
      /**
       * The `cancelled` reason, computed by the driver from what it asked for.
       *
       * The CLI's `cancelled` never says why — it is the same frame whether a
       * person withdrew a queued message or an interrupt took a running one — so
       * this is the driver's own record of the request, read off its ledger view
       * and stated here rather than inferred.
       */
      readonly cancelledReason: ClaudeResidentDeliveryReason;
    }
  | {
      /** The CLI's own statement that a turn is beginning. */
      readonly kind: 'turn-init';
      readonly at: number;
      /** The `system/init` frame's own uuid, for the double-init anomaly's detail. */
      readonly initFrameUuid: string;
    }
  | {
      /** The CLI's `result`: the turn that was open ends here, and so do its runs. */
      readonly kind: 'turn-result';
      readonly at: number;
      readonly isError: boolean;
    }
  | {
      /** This host asked the CLI to interrupt. The ledger only marks the request. */
      readonly kind: 'interrupt-request';
    }
  | {
      /** This host asked the CLI to withdraw one queued command. */
      readonly kind: 'withdraw-request';
      readonly commandUuid: string;
    }
  | {
      /**
       * The command a withdrawal asked about really was cancelled, so the run
       * armed for it never ran and is over.
       *
       * A run exists per send the dispatcher asked for, and the dispatcher awaits
       * it: the CLI never starts a cancelled message, so it never emits the
       * `system/init`/`result` pair that would close the run on its own. Nothing
       * is closed for a delivery whose run already ended, or whose uuid this host
       * never armed — a cold send's message is the process's first work and is not
       * something the CLI can be asked to cancel.
       */
      readonly kind: 'withdrawn-run';
      readonly commandUuid: string;
    }
  | {
      /**
       * The host layer answered a turn's run, so every delivery bound to that
       * turn now names it.
       *
       * The run is the host layer's to mint (the registry lives across an import
       * edge the ledger may not cross), so its id arrives here rather than being
       * produced here — but the fact that each bound command belongs to it is the
       * ledger's, and a by-id read has to be able to name that run after the turn
       * itself is gone (C-3).
       */
      readonly kind: 'run-bound';
      readonly turnId: string;
      readonly runId: string;
    }
  | {
      /**
       * The boundary a still-owed command may not cross (I4).
       *
       * Reached either by the `init`/`started` that opens the next piece of work
       * or by the driver asking directly; both are the same transition.
       */
      readonly kind: 'owed-boundary';
      readonly at: number;
    }
  | {
      /** The process is gone (or the host is closing): nothing more will be said. */
      readonly kind: 'process-exit';
      readonly at: number;
      readonly reason: ClaudeResidentDeliveryReason;
    }
  | {
      /**
       * The ledger records a state it could not make consistent (§10.1).
       *
       * THE anomaly entry point, and the reason the driver has no other one: the
       * interrupt that got no `RESULT` states its own detail and comes in here,
       * while the double-`init` and the never-arrived terminal are raised by the
       * transitions that meet them — all three through {@link recordAnomaly}, so
       * there is one shape of `reportAnomaly` rather than three hand-written
       * pushes.
       */
      readonly kind: 'anomaly';
      readonly code: string;
      readonly detail: string;
    };

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Something the driver must do about a transition, stated as data.
 *
 * Deliberately a discriminated union of plain records with no function members
 * (AC-395 (b)): a function here would be the transition reaching back into the
 * driver, which is exactly the coupling the extraction removes. It also makes
 * the answer assertable — a criterion drives the transitions and reads the
 * effects without standing up a driver at all.
 *
 * There is no `sync-leases`, no `publish`, and no per-transition variant of
 * either: the lease projection and the delivery channel are the driver's fixed
 * tail, run after *every* transition (AC-395 (g)), not an effect one transition
 * remembers to ask for.
 */
export type ResidentLedgerEffect =
  | {
      /** A send was recorded. The driver registers the runtime it dispatched. */
      readonly kind: 'delivery-opened';
      readonly deliveryId: string;
    }
  | {
      /** A turn opened; the driver binds its run through the host layer. */
      readonly kind: 'turn-opened';
      readonly turnId: string;
      readonly turnKind: 'delivered' | 'unattended';
      readonly ownerDeliveryId: string | null;
    }
  | {
      /**
       * The commands bound to a turn, for the run the turn executes as.
       *
       * Run=turn only, and the driver still decides whether the seam is
       * installed: the ledger's part is naming the ids whose terminal frames must
       * end up on this run.
       */
      readonly kind: 'bind-turn-run';
      readonly turnId: string;
      readonly deliveryIds: readonly string[];
    }
  | {
      /**
       * A delivery's run has ended and its dispatcher is awaiting it.
       *
       * `ending` says WHICH ending this is, because there are three and they are
       * not interchangeable in what the driver owes the registry:
       *
       *  - `turn-result` — the turn ended and announced it, so the terminal frame
       *    goes through the turn's run writer and the round end is reported;
       *  - `withdrawn` — the host withdrew a queued command that never ran, so the
       *    frame goes through the round's OWN writer and nothing is reported (a
       *    "your run stopped" notice about the withdrawal somebody just asked for
       *    would be noise about a turn that never started);
       *  - `host-gone` — the process is going away, so there is no stream left to
       *    state anything on and the only thing still owed is the dispatcher's
       *    promise, settled or failed.
       *
       * The ledger knows which one it is because it knows which event said so;
       * what the driver does about each is entirely the driver's.
       */
      readonly kind: 'run-closed';
      readonly deliveryId: string;
      readonly owed: boolean;
      readonly ending: 'turn-result' | 'withdrawn' | 'host-gone';
    }
  | {
      /** A turn closed. The driver clears the routing that belonged to it. */
      readonly kind: 'turn-closed';
      readonly turnId: string;
      readonly outcome: 'completed' | 'aborted';
      readonly closedTurn: ResidentLedgerClosedTurn;
    }
  | {
      /**
       * The ledger recorded a state it could not make consistent (§10.1).
       *
       * One effect for every site — the interrupt that got no `RESULT`, the
       * second `init`, the terminal that never arrived — so the three of them
       * converge on one shape instead of three hand-written pushes.
       */
      readonly kind: 'anomaly';
      readonly code: string;
      readonly detail: string;
    };

/** What one transition answers: did anything move, and what must the driver do. */
export type ResidentLedgerTransition = {
  readonly changed: boolean;
  readonly effects: readonly ResidentLedgerEffect[];
};

// ---------------------------------------------------------------------------
// Construction and read-only access
// ---------------------------------------------------------------------------

/** A fresh, empty ledger — one per resident host. */
export function createResidentLedger(): ResidentLedger {
  return {
    deliveries: [],
    byUuid: new Map<string, ResidentLedgerDelivery>(),
    foreign: new Set<string>(),
    turn: null,
    closedTurns: [],
    pendingStart: [],
    anomalies: [],
  };
}

/**
 * Turns are minted here rather than by the driver because the ledger is what
 * states a turn boundary (SPEC §4.1: `turnId` has one production surface). The
 * counter is module-level and monotonic; the ids are opaque keys, never parsed.
 */
let turnSerial = 0;

function mintTurnId(): string {
  return `turn-${++turnSerial}`;
}

/** Every delivery, in send order. */
export function ledgerDeliveries(ledger: ResidentLedger): readonly ResidentLedgerDelivery[] {
  return ledger.deliveries;
}

/** The delivery addressed by any frame uuid it wrote, or `null`. */
export function ledgerDeliveryByUuid(
  ledger: ResidentLedger,
  uuid: string,
): ResidentLedgerDelivery | null {
  return ledger.byUuid.get(uuid) ?? null;
}

/** The turn the CLI is working on, or the one most recently closed. */
export function ledgerTurn(ledger: ResidentLedger): ResidentLedgerTurn | null {
  return ledger.turn;
}

/** The commands the CLI started while no turn was open. */
export function ledgerPendingStart(ledger: ResidentLedger): readonly ResidentLedgerDelivery[] {
  return ledger.pendingStart;
}

/** The uuids of commands the CLI started that this host never pushed. */
export function ledgerForeign(ledger: ResidentLedger): ReadonlySet<string> {
  return ledger.foreign;
}

/** Every turn that has closed, in order. */
export function ledgerClosedTurns(ledger: ResidentLedger): readonly ResidentLedgerClosedTurn[] {
  return ledger.closedTurns;
}

/** Every anomaly the ledger recorded. */
export function ledgerAnomalies(ledger: ResidentLedger): readonly ResidentLedgerAnomaly[] {
  return ledger.anomalies;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * The one writer (I6).
 *
 * Applies one event and answers what changed and what the driver must do about
 * it. Every branch below is one row of SPEC §5.2; the three spellings of "close
 * a turn" and the two of "record an anomaly" are each one branch, reached by
 * every path that used to spell them out again.
 */
export function applyLedgerEvent(
  ledger: ResidentLedger,
  event: ResidentLedgerEvent,
): ResidentLedgerTransition {
  const state = mutable(ledger);
  const effects: ResidentLedgerEffect[] = [];
  let changed = false;

  switch (event.kind) {
    case 'send': {
      const delivery: LedgerDeliveryState = {
        commandUuid: event.commandUuid,
        uuids: event.uuids.length > 0 ? [...event.uuids] : [event.commandUuid],
        // The host's own mark on the send: the CLI has not spoken about it yet.
        state: 'pushed',
        reason: null,
        source: event.source,
        text: event.text,
        turnId: null,
        runId: null,
        runOpen: true,
        owed: false,
        withdrawalRequested: false,
        enqueuedAt: event.at,
        startedAt: null,
        endedAt: null,
        priority: event.priority,
      };
      state.deliveries.push(delivery);
      for (const uuid of delivery.uuids) {
        state.byUuid.set(uuid, delivery);
      }
      effects.push({ kind: 'delivery-opened', deliveryId: delivery.commandUuid });
      changed = true;
      break;
    }

    case 'lifecycle': {
      const delivery = state.byUuid.get(event.commandUuid) ?? null;
      if (!delivery) {
        // A uuid nothing here has a record for can only be the CLI's own — a
        // cron firing (E9 §9.4) — so it is noted as foreign and left alone.
        if (!state.foreign.has(event.commandUuid)) {
          state.foreign.add(event.commandUuid);
          changed = true;
        }
        break;
      }

      if (event.lifecycle === 'queued') {
        // Idempotent, and never a step back: a `queued` that arrives after a
        // `started` (the stream is not obliged to be ordered that way) does not
        // put a running command back in the queue.
        if (delivery.state === 'pushed') {
          delivery.state = 'queued';
          changed = true;
        }
        break;
      }

      if (event.lifecycle === 'started') {
        if (delivery.state === 'pushed' || delivery.state === 'queued') {
          delivery.state = 'started';
          changed = true;
        }
        if (delivery.startedAt === null) {
          delivery.startedAt = event.at;
          changed = true;
        }
        const turn = state.turn;
        // A turn this host did not open is not a fold target. The CLI runs one
        // turn at a time, and a command of ours written during the process's own
        // turn is drained at that turn's boundary into a turn of its own, so it
        // belongs to the turn that opens next — which is where `pendingStart`
        // puts it. Binding it here would tie the run to a turn whose ending
        // nobody here reports.
        const foldable = turn !== null && turn.open && turn.kind === 'delivered';
        if (foldable) {
          if (delivery.turnId !== turn.id) {
            delivery.turnId = turn.id;
          }
          turn.ownerDeliveryId ??= delivery.commandUuid;
          effects.push({
            kind: 'bind-turn-run',
            turnId: turn.id,
            deliveryIds: [delivery.commandUuid],
          });
          changed = true;
          break;
        }
        // No turn to fold into: this command belongs to the turn that opens
        // next. The boundary is also where an owed delivery from the previous
        // turn is reconciled — the turn it was waiting on is over and its
        // terminal never came (I4).
        const owed = reconcileOwed(state, event.at);
        if (owed.changed || owed.effects.length > 0) {
          changed = true;
          effects.push(...owed.effects);
        }
        if (!state.pendingStart.includes(delivery)) {
          state.pendingStart.push(delivery);
          changed = true;
        }
        break;
      }

      // `completed` | `cancelled`. A terminal is written once (C-1): a second
      // one for the same command is the CLI contradicting itself, and
      // overwriting the first would hide it.
      if (!isTerminalDeliveryState(delivery.state)) {
        delivery.state = event.lifecycle;
        delivery.reason = event.lifecycle === 'cancelled' ? event.cancelledReason : null;
        delivery.endedAt = event.at;
        delivery.owed = false;
        changed = true;
      }
      break;
    }

    case 'turn-init': {
      // The turn boundary is also I4's boundary: a delivery still owed its
      // terminal when the next turn begins will not get one.
      const owed = reconcileOwed(state, event.at);
      if (owed.changed || owed.effects.length > 0) {
        changed = true;
        effects.push(...owed.effects);
      }

      const existing = state.turn;
      if (existing !== null && existing.open) {
        // A second `init` before the first turn's `RESULT` is the CLI
        // contradicting C-6 (the handle is `init … RESULT` and nothing in
        // between), so it is recorded and the open turn is left where it is:
        // minting a second turn would move the frame routing onto a turn whose
        // `RESULT` the first one's `init` never announced.
        recordAnomaly(
          state,
          effects,
          'double-init',
          `system/init ${event.initFrameUuid} arrived before turn ${existing.id} ended`,
        );
        break;
      }

      const opened = openTurn(state);
      effects.push({
        kind: 'turn-opened',
        turnId: opened.id,
        turnKind: opened.kind,
        ownerDeliveryId: opened.ownerDeliveryId,
      });
      if (opened.kind === 'delivered') {
        effects.push({
          kind: 'bind-turn-run',
          turnId: opened.id,
          deliveryIds: boundDeliveryIds(state, opened.id),
        });
      }
      changed = true;
      break;
    }

    case 'turn-result': {
      const existing = state.turn;
      // A `RESULT` with no open turn is still the CLI saying a turn just ended —
      // the announcement of that turn's `init` is a frame this build may not
      // have read (a scripted stream, or a stream that began mid-turn) — so the
      // turn is opened and closed at once around the commands waiting for it
      // rather than dropped on the floor.
      const turn = existing !== null && existing.open ? existing : openTurn(state);
      const outcome: 'completed' | 'aborted' =
        event.isError && turn.interruptRequested ? 'aborted' : 'completed';

      const closedTurn = closeTurnRecord(state, turn, outcome);

      // The runs of this turn are closed BEFORE the turn itself is announced as
      // closed: the driver writes each run's terminal frame while the turn that
      // owns it is still the open one, which is the order the frames and the
      // routing have always been written in.
      for (const delivery of state.deliveries) {
        if (!delivery.runOpen || delivery.turnId !== turn.id) {
          continue;
        }
        delivery.runOpen = false;
        // `owed` is the cross-check C-3 requires: a run closed while the CLI has
        // not yet stated the command's terminal is held as owed until that
        // terminal arrives, and reconciled if the next turn begins first (I4).
        delivery.owed = !isTerminalDeliveryState(delivery.state);
        effects.push({
          kind: 'run-closed',
          deliveryId: delivery.commandUuid,
          owed: delivery.owed,
          ending: 'turn-result',
        });
      }
      effects.push({ kind: 'turn-closed', turnId: turn.id, outcome, closedTurn });
      changed = true;
      break;
    }

    case 'interrupt-request': {
      // The ledger does not change any delivery state here: the CLI's own
      // `cancelled` and the `RESULT` that follows are what drive it (C-5). What
      // this marks is the request, which is what makes that `RESULT` read
      // `aborted` and what names the reason a `cancelled` carries.
      const turn = state.turn;
      if (turn !== null && turn.open && !turn.interruptRequested) {
        turn.interruptRequested = true;
        changed = true;
      }
      break;
    }

    case 'withdraw-request': {
      const delivery = state.byUuid.get(event.commandUuid) ?? null;
      if (delivery && !delivery.withdrawalRequested) {
        delivery.withdrawalRequested = true;
        changed = true;
      }
      break;
    }

    case 'run-bound': {
      for (const delivery of state.deliveries) {
        if (delivery.turnId === event.turnId && delivery.runId !== event.runId) {
          delivery.runId = event.runId;
          changed = true;
        }
      }
      break;
    }

    case 'withdrawn-run': {
      const delivery = state.byUuid.get(event.commandUuid) ?? null;
      if (delivery && delivery.runOpen) {
        delivery.runOpen = false;
        // A withdrawn command's terminal was just read, so nothing is owed for it.
        delivery.owed = false;
        effects.push({
          kind: 'run-closed',
          deliveryId: delivery.commandUuid,
          owed: false,
          ending: 'withdrawn',
        });
        changed = true;
      }
      break;
    }

    case 'owed-boundary': {
      const owed = reconcileOwed(state, event.at);
      changed = owed.changed;
      effects.push(...owed.effects);
      break;
    }

    case 'anomaly': {
      recordAnomaly(state, effects, event.code, event.detail);
      changed = true;
      break;
    }

    case 'process-exit': {
      // No `RESULT` and no `command_lifecycle` is coming, so what is left is to
      // say so: every run still open ends here (the driver settles or fails the
      // dispatcher's promise), every command still without a terminal is written
      // `cancelled(reason)`, and an open turn reads `aborted`.
      for (const delivery of state.deliveries) {
        if (delivery.runOpen) {
          delivery.runOpen = false;
          delivery.owed = false;
          effects.push({
            kind: 'run-closed',
            deliveryId: delivery.commandUuid,
            owed: false,
            ending: 'host-gone',
          });
        }
        if (!isTerminalDeliveryState(delivery.state)) {
          delivery.state = 'cancelled';
          delivery.reason = event.reason;
          delivery.endedAt = event.at;
          delivery.owed = false;
        }
      }
      const turn = state.turn;
      if (turn !== null && turn.open) {
        const closedTurn = closeTurnRecord(state, turn, 'aborted');
        effects.push({ kind: 'turn-closed', turnId: turn.id, outcome: 'aborted', closedTurn });
      }
      state.pendingStart.length = 0;
      changed = true;
      break;
    }
  }

  return { changed, effects };
}

/**
 * Opens the turn the CLI has just announced, binding the commands waiting for it.
 *
 * `kind` is the whole of I5, read at this one moment: a turn whose opener came
 * from a command this host pushed is `delivered`, and one that bound nothing is
 * `unattended` — the process's own turn, which no caller here opened. The owner
 * is the earliest command bound.
 *
 * A turn with nothing waiting can still be a delivered turn: a cold send whose
 * `init` is the first thing the CLI says never emits a `started` for it before
 * the announcement, so the earliest open run is bound as the owner here. That is
 * the same round the FIFO code reached by reading `rounds[0]`, expressed as an
 * id.
 */
function openTurn(state: LedgerState): LedgerTurnState {
  const bound = state.pendingStart.splice(0);
  const owner = state.deliveries.find((delivery) => delivery.runOpen) ?? null;
  if (owner && !bound.includes(owner)) {
    bound.unshift(owner);
  }

  const turn: LedgerTurnState = {
    id: mintTurnId(),
    kind: bound.length > 0 ? 'delivered' : 'unattended',
    open: true,
    ownerDeliveryId: null,
    interruptRequested: false,
  };
  for (const delivery of bound) {
    delivery.turnId = turn.id;
    turn.ownerDeliveryId ??= delivery.commandUuid;
  }
  state.turn = turn;
  return turn;
}

/**
 * Records one anomaly — THE single `reportAnomaly`.
 *
 * The ledger records rather than throws: a stream that breaks one of the CLI's
 * rules is a fact about the CLI, and ending the read loop over it would take the
 * whole process down on a frame the CLI is entitled to send. Every site that
 * states one comes through here, so the record and the effect it produces have
 * one shape (AC-395 (c)).
 */
function recordAnomaly(
  state: LedgerState,
  effects: ResidentLedgerEffect[],
  code: string,
  detail: string,
): void {
  state.anomalies.push({ code, detail });
  effects.push({ kind: 'anomaly', code, detail });
}

/** The ids of the deliveries the ledger has bound to one turn, in send order. */
function boundDeliveryIds(state: LedgerState, turnId: string): string[] {
  return state.deliveries
    .filter((delivery) => delivery.turnId === turnId)
    .map((delivery) => delivery.commandUuid);
}

/**
 * Shuts one turn and records it — THE single spelling of "close a turn".
 *
 * Three call sites used to write this record out by hand (the process exit, the
 * `RESULT`, and the unattended turn's ending), which is three places for the
 * same terminal to be spelled differently. There is one now (AC-395 (c)): given
 * the same turn and the same outcome, every path produces a byte-identical
 * `closedTurns` entry because there is only one expression that produces one.
 */
function closeTurnRecord(
  state: LedgerState,
  turn: LedgerTurnState,
  outcome: 'completed' | 'aborted',
): ResidentLedgerClosedTurn {
  turn.open = false;
  const closedTurn: LedgerClosedTurnState = {
    id: turn.id,
    kind: turn.kind,
    outcome,
    ownerDeliveryId: turn.ownerDeliveryId,
  };
  state.closedTurns.push(closedTurn);
  return closedTurn;
}

/**
 * Settles the deliveries whose terminal never arrived (I4).
 *
 * The rule is a boundary rule, not a timeout: a command whose run closed while
 * the CLI had not yet stated its ending may stay owed only until the next turn
 * begins. Reaching that boundary still owed means the terminal is not coming, so
 * it is written `cancelled(owed-terminal-missing)` — the honest name for it —
 * and recorded as an anomaly rather than left quietly non-terminal.
 */
function reconcileOwed(state: LedgerState, at: number): ResidentLedgerTransition {
  const effects: ResidentLedgerEffect[] = [];
  let changed = false;
  for (const delivery of state.deliveries) {
    if (!delivery.owed || isTerminalDeliveryState(delivery.state)) {
      continue;
    }
    delivery.state = 'cancelled';
    delivery.reason = 'owed-terminal-missing';
    delivery.endedAt = at;
    delivery.owed = false;
    recordAnomaly(
      state,
      effects,
      'owed-terminal-missing',
      `delivery ${delivery.commandUuid} reached the next turn with no terminal`,
    );
    changed = true;
  }
  return { changed, effects };
}
