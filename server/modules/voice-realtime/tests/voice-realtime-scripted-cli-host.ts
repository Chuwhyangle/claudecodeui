/**
 * The ONE scripted CLI host — a stand-in for the CLI's own command queue, its `command_lifecycle`
 * and its in-flight-run activity, shared by the continuous-mode behaviour criteria (B-1..B-9).
 *
 * WHY IT EXISTS AS A MODULE. Two criteria files had each grown their own temporary host, and neither
 * could say what the continuous-mode criteria need to read:
 *
 *   · `voice-realtime-queue-depth-truth.test.ts` counts BYTES and depth, and can only ever `dequeue`
 *     from the FRONT — nothing in it can answer "which command is this, and is it still waiting?".
 *   · `voice-realtime-interrupt-fence.test.ts` keeps a `command_lifecycle` of `started` uuids, but has
 *     no queue at all behind it: `accept`ed commands are invisible until `start` is called by hand.
 *
 * Neither can express the five semantics the continuous-mode criteria are written against, and two
 * hosts that disagree about what "queued" means would make every cross-file reading a reading of the
 * stand-ins rather than of the relay. So they are unified here, and each semantic is self-tested in
 * `voice-realtime-scripted-scenarios.test.ts` (AC2) with a false form that reddens it.
 *
 * THE FIVE SEMANTICS, as measured on the real host (E10/U1..U4, decision doc §12):
 *
 *   1. TURN-BOUNDARY AGGREGATION. Everything waiting at a turn boundary becomes ONE request, in push
 *      order (E10/U3: three queued messages reached the CLI as one). `aggregateAtTurnBoundary: false`
 *      is the false form — one request per command — and is what reddens B1.
 *   2. THE QUEUE SURVIVES AN ABORT. `abort()` never discards what is waiting (E10/U1): the command
 *      that arrived before the stop is still there to be delivered by the turn the stop closed.
 *   3. THE STALE-FIRST WINDOW. A command pushed at least {@link DEFAULT_STALE_WINDOW_MS} AFTER an
 *      abort misses the abort-closing turn and lands in the one after it (E10/U2). At 49 ms it
 *      boards; at 50 ms it waits. That boundary is the whole reason the relay enqueues a correction
 *      BEFORE aborting rather than after.
 *   4. WITHDRAWAL BY UUID, ANY POSITION. `withdraw(uuid)` removes a QUEUED command wherever it sits
 *      — not only the tail (E10/U4: `cancel_async_message` withdrew a non-latest entry).
 *   5. `command_lifecycle`. Every command's `queued` / `started` / `completed` / `cancelled` events,
 *      in one log with a monotonic sequence number, so an ordering claim ("the correction was queued
 *      BEFORE the abort") is read off a counter rather than off a clock.
 *
 * WHAT IT IS NOT. It reads no clock: every method takes an optional `atMs`, defaults to `0`, and the
 * sequence counter is the only order it has. Nothing here knows about the relay; the three readings
 * the relay samples ({@link ScriptedCliHost.reading}, {@link ScriptedCliHost.commandLifecycle},
 * {@link ScriptedCliHost.runActivity}) are the whole of its published surface.
 */

import type {
  HostCommandLifecycleReading,
  HostQueueReading,
  HostRunActivityReading,
} from '../voice-realtime-ws-proxy.service.js';

/** What the CLI did with one command, in `command_lifecycle`'s own vocabulary. */
export type CliLifecycleEvent = 'queued' | 'started' | 'completed' | 'cancelled';

/** One `command_lifecycle` entry. */
export type CliLifecycleEntry = {
  /** The command's identity — the `queuedMessageUuid` a delivery result carries and the fence joins on. */
  readonly uuid: string;
  /** The command's text, so a lifecycle assertion can name what was queued, not only which id. */
  readonly text: string;
  readonly event: CliLifecycleEvent;
  /**
   * The host's own monotonically increasing operation counter at the moment of this event.
   *
   * This, and not {@link CliLifecycleEntry.atMs}, is what an ordering claim is read from: the host
   * takes a caller-supplied `atMs` (a scenario may want one), and two events inside one abort share
   * it. The counter is total and cannot tie.
   */
  readonly seq: number;
  /** The host's clock reading when the event happened. */
  readonly atMs: number;
};

/** One turn the CLI opened: what a delivery result reports as `runId`, and what it was handed. */
export type CliTurn = {
  /** The turn's id, unique per host. */
  readonly id: string;
  /** The commands that boarded it, in push order. */
  readonly uuids: readonly string[];
  /** The ONE message the turn was handed — the aggregated text, or a single command's text. */
  readonly message: string;
};

/** The host's knobs. Both have a default that is the deployed shape. */
export type ScriptedCliHostOptions = {
  /**
   * Whether a turn boundary aggregates every eligible command into ONE request. `true` is the real
   * host's behaviour (E10/U3). `false` is the FALSE FORM — one request per command — used to prove
   * B1's aggregation assertion reddens when the aggregation is removed.
   */
  aggregateAtTurnBoundary?: boolean;
  /** How long after an abort a pushed command still rides the abort-closing turn. Default 50 ms. */
  staleWindowMs?: number;
};

/** The measured stale-first window (E10/U2): at Δ≥50 ms the words land a whole turn late. */
export const DEFAULT_STALE_WINDOW_MS = 50;

/** A command waiting in the CLI's own queue. */
type QueuedCommand = {
  readonly uuid: string;
  readonly text: string;
  readonly atMs: number;
  /** `true` for a command pushed inside the stale-first window: it misses the NEXT boundary. */
  stale: boolean;
};

/** The scripted host's published surface. */
export type ScriptedCliHost = {
  /** The CLI accepts one message into its own queue. Returns the uuid a delivery result reports. */
  accept(text: string, options?: { atMs?: number }): { uuid: string; queued: true };
  /**
   * A turn boundary. The eligible queued commands board; the CLI is then busy with that turn.
   *
   * Returns `[]` when the CLI is ALREADY in a turn (its queue waits for the run to finish) or when
   * nothing was eligible — a boundary that boards nothing is the boundary the stale-first window
   * needs, so it still counts as having happened.
   */
  advanceTurn(options?: { atMs?: number }): CliTurn[];
  /**
   * The run in flight is aborted. THE QUEUE IS RETAINED — nothing waiting is discarded (E10/U1).
   * The abort-closing turn is opened by the CLI's own next {@link advanceTurn}, not by this call.
   */
  abort(options?: { atMs?: number }): { aborted: boolean; keptQueued: number };
  /** Withdraw one QUEUED command by uuid — any position, not only the tail. */
  withdraw(uuid: string): boolean;
  /** The run in flight finished. */
  complete(options?: { atMs?: number }): void;
  /** The turn in flight, or `null`. */
  inFlight(): CliTurn | null;
  /** Every turn this host opened, in order. */
  turns(): readonly CliTurn[];
  /** The `command_lifecycle` log, in order. */
  lifecycle(): readonly CliLifecycleEntry[];
  /** The sequence number of the most recent abort, or `null` if none — the ordering anchor. */
  lastAbortSeq(): number | null;
  /** How many commands are QUEUED and not started — what "排队未开始" counts. */
  queuedNotStarted(): number;
  /** The tool the in-flight run is executing, or `null`. */
  setInFlightTool(tool: string | null): void;
  /** The depth reading the relay samples through its `hostQueueReading` seam. */
  reading(): HostQueueReading;
  /** The lifecycle reading the relay samples through its `hostCommandLifecycle` seam. */
  commandLifecycle(): HostCommandLifecycleReading;
  /** The activity reading the relay samples through its `hostRunActivity` seam. */
  runActivity(): HostRunActivityReading;
};

/** UTF-8 bytes, the unit the relay's own queue budget is measured in. */
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Builds one scripted CLI host. Used by `voice-realtime-scripted-scenarios.test.ts` — both for its
 * own five self-tests and as the host behind every B-1..B-9 scenario.
 */
export function createScriptedCliHost(options: ScriptedCliHostOptions = {}): ScriptedCliHost {
  const aggregate = options.aggregateAtTurnBoundary ?? true;
  const staleWindowMs = options.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;

  /** What is waiting: accepted, not yet started, not withdrawn. */
  let pending: QueuedCommand[] = [];
  /** The turn the CLI is in, or `null`. Exactly one — the CLI works one turn at a time. */
  let turn: CliTurn | null = null;
  let inFlightTool: string | null = null;
  /** The clock reading of the last abort, while its stale-first window is still open. */
  let abortedAtMs: number | null = null;
  let abortSeq: number | null = null;
  let turnCounter = 0;
  let seq = 0;

  const log: CliLifecycleEntry[] = [];
  const opened: CliTurn[] = [];

  /** Appends one lifecycle entry and returns the sequence number it was written at. */
  const record = (uuid: string, text: string, event: CliLifecycleEvent, atMs: number): number => {
    seq += 1;
    log.push({ uuid, text, event, seq, atMs });
    return seq;
  };

  /**
   * Boards `commands` at a turn boundary and opens the turn(s), returning what it opened.
   *
   * `aggregate` is the ONE switch the false form flips: with it off, each command gets its own turn,
   * which is exactly the shape B1's aggregation assertion must redden on.
   */
  const openTurns = (commands: QueuedCommand[], atMs: number): CliTurn[] => {
    const groups = aggregate ? [commands] : commands.map((command) => [command]);
    const made: CliTurn[] = [];
    for (const group of groups) {
      turnCounter += 1;
      const created: CliTurn = {
        id: `turn-${turnCounter}`,
        uuids: group.map((command) => command.uuid),
        // Push order, joined: the CLI hands its next turn ONE message made of everything that was
        // waiting on it, which is the aggregation E10/U3 measured.
        message: group.map((command) => command.text).join(''),
      };
      for (const command of group) {
        record(command.uuid, command.text, 'started', atMs);
      }
      opened.push(created);
      made.push(created);
    }
    if (made.length > 0) {
      turn = made[made.length - 1]!;
    }
    return made;
  };

  return {
    accept(text: string, acceptOptions: { atMs?: number } = {}): { uuid: string; queued: true } {
      const atMs = acceptOptions.atMs ?? 0;
      // Decided at PUSH time, which is what the measured window is about: a correction the relay
      // enqueues before aborting is inside the window by construction, and one pushed 50 ms later
      // is not.
      const stale = abortedAtMs !== null && atMs - abortedAtMs >= staleWindowMs;
      seq += 1;
      const uuid = `cmd-${seq}`;
      pending.push({ uuid, text, atMs, stale });
      log.push({ uuid, text, event: 'queued', seq, atMs });
      return { uuid, queued: true };
    },

    advanceTurn(advanceOptions: { atMs?: number } = {}): CliTurn[] {
      const atMs = advanceOptions.atMs ?? 0;
      // The CLI works one turn at a time: with a run in flight its queue waits, and the boundary it
      // is waiting for has not happened yet — so nothing is un-staled either.
      if (turn !== null) {
        return [];
      }
      const eligible = pending.filter((command) => !command.stale);
      // This boundary HAS happened. A command that missed it is eligible for the next one, so the
      // stale flag is spent here rather than carried — and the abort's window closes with it.
      pending = pending.filter((command) => command.stale).map((command) => ({ ...command, stale: false }));
      abortedAtMs = null;
      return openTurns(eligible, atMs);
    },

    abort(abortOptions: { atMs?: number } = {}): { aborted: boolean; keptQueued: number } {
      const atMs = abortOptions.atMs ?? 0;
      const aborted = turn !== null;
      if (turn !== null) {
        for (const uuid of turn.uuids) {
          record(uuid, turn.message, 'cancelled', atMs);
        }
        turn = null;
      }
      inFlightTool = null;
      abortedAtMs = atMs;
      seq += 1;
      abortSeq = seq;
      return { aborted, keptQueued: pending.length };
    },

    withdraw(uuid: string): boolean {
      const at = pending.findIndex((command) => command.uuid === uuid);
      if (at < 0) {
        return false;
      }
      const [command] = pending.splice(at, 1);
      record(command!.uuid, command!.text, 'cancelled', command!.atMs);
      return true;
    },

    complete(completeOptions: { atMs?: number } = {}): void {
      const atMs = completeOptions.atMs ?? 0;
      if (turn === null) {
        return;
      }
      for (const uuid of turn.uuids) {
        record(uuid, turn.message, 'completed', atMs);
      }
      turn = null;
      inFlightTool = null;
    },

    inFlight(): CliTurn | null {
      return turn;
    },

    turns(): readonly CliTurn[] {
      return opened;
    },

    lifecycle(): readonly CliLifecycleEntry[] {
      return log;
    },

    lastAbortSeq(): number | null {
      return abortSeq;
    },

    queuedNotStarted(): number {
      return pending.length;
    },

    setInFlightTool(tool: string | null): void {
      inFlightTool = tool;
    },

    reading(): HostQueueReading {
      return {
        items: pending.length,
        bytes: pending.reduce((sum, command) => sum + byteLength(command.text), 0),
      };
    },

    commandLifecycle(): HostCommandLifecycleReading {
      return { started: turn === null ? [] : [...turn.uuids] };
    },

    runActivity(): HostRunActivityReading {
      return { inFlightTool: turn === null ? null : inFlightTool };
    },
  };
}
