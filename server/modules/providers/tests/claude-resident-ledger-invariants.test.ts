/**
 * Criterion for the resident host's delivery/turn LEDGER (AC-378, SPEC §5 / §11).
 *
 * The driver used to keep two accounts of a run and reconcile them by POSITION:
 * the run registry opened a run per send, and the driver held a FIFO of rounds
 * whose front entry owned the frames — one `shift()` per `result`, plus a second
 * position proxy (`resultsSeenAtStart`, a count of turns already ended) to find
 * the rounds the CLI had folded into one turn. The CLI's measured contract makes
 * that unreliable by design: a folded command's terminal may arrive *before* its
 * `RESULT` and a first command's *after* it (C-3), a drained queue is one turn
 * under one `RESULT` (C-4), and an interrupt stops only the command in flight
 * (C-5). A turn ending could therefore close the wrong run and leave the newest
 * one running with its turn lease held — the `Working…` that outlived its turn.
 *
 * This criterion is the ledger's own reading, driven as a property test. It
 * replays a seeded generator of interleavings against the REAL
 * `ClaudeResidentHostDriver` over an injected scripted process seam (the
 * `createProcess` factory — no real `claude` binary is started), and asserts the
 * SPEC's I1–I6 on every sequence. What is generated is the CLI's contract, not a
 * happy path: cold sends and busy sends, `queued`/`started`/`completed`/
 * `cancelled`, a normal `RESULT` and an `is_error` one, unattended `init`s, a
 * cron-shaped foreign `started`, an interrupt, a process exit, and — because C-3
 * says the order is not fixed — every command's terminal on BOTH sides of its
 * `RESULT`.
 *
 * The two false forms this criterion must catch, and how:
 *
 *   (①) `closeTurn` is what settles the runs a `RESULT` covered. Put back the
 *        old single-`shift` settlement — close only the FRONT open run — and the
 *        fold legs leave a run open: its lease stays, its dispatcher never
 *        settles, and a sequence reds with `violation=I1` and a counterexample
 *        sequence, in the same run as the green readings.
 *   (②) The generator is the CLI here. Make it violate C-1 (a command that never
 *        reaches a terminal) and the ledger must not report zero violations: it
 *        reconciles the command `cancelled(owed-terminal-missing)` and records
 *        the anomaly, and the criterion reds on that reconciliation with
 *        `violation=I2` rather than passing it silently.
 *
 * Red lines:
 * - Every reading is taken before anything is asserted, and a failure names the
 *   invariant (`violation=I<n>`) plus the sequence that produced it, so a red
 *   lands on the reading that is wrong rather than on a timeout.
 * - A mid-run violation is reported as the SHORTEST PREFIX that still violates:
 *   a prefix only counts if it violates at a step strictly inside itself, which
 *   is what keeps "the sequence had not finished yet" from passing for a
 *   counterexample.
 * - The process budget guard kills the whole process with `exit 3` rather than
 *   failing one case, as in the sibling resident criteria.
 * - Nothing here reads a private field: every assertion comes from
 *   `ledgerReading` / `busyInputReading` / `runInFlight` and from the manager's
 *   own lease projection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_TURN_PRIORITY_OPTION,
  ClaudeResidentHostDriver,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentLedgerReading,
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/** The wall-clock bound this criterion reports the whole run against (AC (e): < 40s). */
const RUN_BUDGET_MS = 38_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${RUN_BUDGET_MS}ms elapsed=${elapsed}ms exit=3 — the ledger-invariants criterion did not ` +
      `finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, RUN_BUDGET_MS - 1_000);
budgetGuard.unref();

/** How many seeded sequences the criterion drives. The AC floors this at 200. */
const SEQUENCE_COUNT = 220;

/** The seed. Printed, so a red can be replayed exactly. */
const SEED = 0x5eed_0378;

/** The pid the scripted seam reports; it is read and never acted on. */
const PROCESS_PID = 4242;

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

/**
 * A 32-bit PRNG (mulberry32), so the sequences are a function of the seed alone.
 *
 * The criterion's own output must be byte-identical across two runs of the same
 * seed; nothing outside this generator may introduce variation, which is also why
 * no timestamp is ever printed.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length) % values.length] as T;
}

/**
 * When a command's frames were written, which is what decides whether the CLI
 * sees it as a queue entry behind a running turn or as the next piece of work.
 *
 * `cold` is the process's very first message; `preamble` is a second message of
 * the first turn, written while the cold one is running; `idle` is written in
 * the gap between the previous `RESULT` and this turn's `init`; `busy` is written
 * inside the previous turn's body.
 */
type DispatchWindow = 'cold' | 'preamble' | 'idle' | 'busy';

/** One accepted send, with everything the criterion expects the ledger to say about it. */
type DeliveryPlan = {
  /** Send order, which is the order the runs were opened in. */
  index: number;
  command: string;
  window: DispatchWindow;
  /** How the CLI reported its dequeue: before the turn it runs in, or folded into it. */
  startPlacement: 'pending' | 'fold' | 'none';
  priority: 'later' | 'next' | null;
  /** `null` is the generator violating C-1 — see false form (②). */
  terminal: 'completed' | 'cancelled' | null;
  terminalPlacement: 'before-result' | 'after-result' | 'never';
  /** The turn this command is bound to. */
  turn: number;
  /** The reason the ledger must record for a `cancelled`. */
  expectReason: 'cli' | 'interrupt' | null;
};

/** One turn the ledger must open and close, and what it must say about it. */
type TurnPlan = {
  index: number;
  kind: 'delivered' | 'unattended';
  /** The command that owns the turn's frames, or null for an unattended turn. */
  owner: number | null;
  /** Every command bound to this turn, in send order. */
  commands: number[];
  /** Probe frames emitted inside the turn, each carrying its own 1-based `seq`. */
  probes: number;
  outcome: 'completed' | 'aborted';
  interrupted: boolean;
  /** A `started` under a uuid nothing here pushed (the CLI's own cron), or null. */
  foreignUuid: string | null;
};

type SequencePlan = {
  deliveries: DeliveryPlan[];
  turns: TurnPlan[];
};

/** One step of the replayed timeline, in the CLI's own vocabulary. */
type Step =
  | { kind: 'send'; delivery: number }
  | { kind: 'queued'; delivery: number }
  | { kind: 'started'; delivery: number }
  | { kind: 'foreign-started'; uuid: string }
  | { kind: 'init'; turn: number }
  | { kind: 'probe'; turn: number; seq: number }
  | { kind: 'terminal'; delivery: number }
  | { kind: 'interrupt' }
  | { kind: 'result'; turn: number };

type Sequence = { steps: Step[]; plan: SequencePlan };

/**
 * Builds one seeded sequence: which turns the CLI runs, which commands run in
 * them, when each command is dequeued, and where each terminal lands relative to
 * its `RESULT` (both orders, per C-3).
 */
function buildSequence(rng: () => number, index: number): Sequence {
  const turnCount = 1 + Math.floor(rng() * 4);
  const deliveries: DeliveryPlan[] = [];
  const turns: TurnPlan[] = [];
  let interruptUsed: boolean = false;

  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    // A turn with no command at all is the process's own: it must be read as
    // `unattended` (I5). The cron-shaped variant is that turn led by a `started`
    // under a uuid nobody here pushed.
    const shape =
      turnIndex === 0
        ? 'delivered'
        : pick(rng, ['delivered', 'delivered', 'delivered', 'unattended', 'foreign'] as const);
    const plan: TurnPlan = {
      index: turnIndex,
      kind: 'delivered',
      owner: null,
      commands: [],
      probes: 0,
      outcome: 'completed',
      interrupted: false,
      foreignUuid: null,
    };

    if (shape !== 'delivered') {
      plan.kind = 'unattended';
      if (shape === 'foreign') {
        plan.foreignUuid = `cron-${index}-${turnIndex}`;
      }
      turns.push(plan);
      continue;
    }

    const commandCount = 1 + Math.floor(rng() * 3);
    // C-5: an interrupt stops exactly one command, and only while one is in
    // flight — so it needs a turn that has one, and it is used at most once.
    const interrupted: boolean = !interruptUsed && turnIndex > 0 && rng() < 0.22;
    interruptUsed = interruptUsed || interrupted;
    plan.interrupted = interrupted;
    plan.outcome = interrupted ? 'aborted' : 'completed';
    // The window split is monotone in send order: the commands written while the
    // previous turn was still running come first, then the ones written in the
    // gap before this turn's `init`. That keeps the process's own send order the
    // same as this plan's order, which is what makes the turn's owner (its
    // earliest command) the earliest RUN the ledger can see — a turn whose first
    // command were dispatched after its second would have no single answer.
    const busyCount = turnIndex === 0 ? 0 : Math.floor(rng() * (commandCount + 1));

    for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
      const deliveryIndex = deliveries.length;
      const first = commandIndex === 0;
      const window: DispatchWindow =
        turnIndex === 0
          ? first
            ? 'cold'
            : 'preamble'
          : // A busy send is written while the previous turn is still running,
            // so the CLI sees it as a queue entry behind that turn.
            commandIndex < busyCount
            ? 'busy'
            : 'idle';
      // The process's first work is never a queue entry, so the CLI may not
      // report a dequeue for it at all — the cold-head shape, where only the
      // `init` binds the run.
      const startPlacement =
        window === 'cold'
          ? pick(rng, ['none', 'pending'] as const)
          : pick(rng, ['pending', 'pending', 'fold'] as const);
      // The interrupted turn's in-flight command is the one the CLI cancels.
      const terminal: DeliveryPlan['terminal'] = first && interrupted ? 'cancelled' : 'completed';
      deliveries.push({
        index: deliveryIndex,
        command: `cmd-${index}-${deliveryIndex}`,
        window,
        startPlacement,
        priority: pick(rng, [null, null, 'later', 'next'] as const),
        terminal,
        // C-3: the terminal and the `RESULT` are two independent events and
        // their order is not fixed. Both sides are generated for every command.
        terminalPlacement: pick(rng, ['before-result', 'after-result'] as const),
        turn: turnIndex,
        expectReason: terminal === 'cancelled' ? 'interrupt' : null,
      });
      plan.commands.push(deliveryIndex);
    }

    // The turn's owner is its earliest command: the earliest run still open when
    // the `init` arrives, which is the same round the old code reached by reading
    // `rounds[0]` — named here by its send order rather than by position.
    plan.owner = plan.commands[0] ?? null;
    plan.probes = 1 + Math.floor(rng() * 3);
    turns.push(plan);
  }

  return { steps: emitSequence(deliveries, turns), plan: { deliveries, turns } };
}

/**
 * Emits the timeline for a plan.
 *
 * The dispatch windows are what make the sequence a contract rather than a wish:
 * a command that runs in turn k is written either while turn k-1 is still open
 * (a busy send, so the CLI queues it behind that turn) or in the gap between
 * turn k-1's `RESULT` and turn k's `init` (an idle send, the process's next
 * work). Its `started` then lands either in that same gap — so it waits in the
 * pending set for the `init` that follows, which is the S2 contract — or after
 * the `init`, which is the CLI folding it into the turn it just announced.
 */
function emitSequence(deliveries: DeliveryPlan[], turns: TurnPlan[]): Step[] {
  const steps: Step[] = [];
  const send = (delivery: DeliveryPlan): void => {
    steps.push({ kind: 'send', delivery: delivery.index });
    steps.push({ kind: 'queued', delivery: delivery.index });
  };

  const cold = deliveries.find((delivery) => delivery.window === 'cold');
  if (cold) {
    send(cold);
  }

  for (const turn of turns) {
    const commands = turn.commands.map((index) => deliveries[index] as DeliveryPlan);
    const next = turns[turn.index + 1];
    // A message written while an earlier one was already running is a queue
    // entry, so its `queued` is what the CLI says about it now — before the turn
    // it will run in has even been announced.
    for (const command of commands) {
      if (command.window === 'preamble') {
        send(command);
      }
    }
    if (turn.foreignUuid) {
      steps.push({ kind: 'foreign-started', uuid: turn.foreignUuid });
    }
    // The gap between turns: the idle sends, and every command dequeued in it.
    for (const command of commands) {
      if (command.window === 'idle') {
        send(command);
      }
    }
    for (const command of commands) {
      if (command.startPlacement === 'pending') {
        steps.push({ kind: 'started', delivery: command.index });
      }
    }
    steps.push({ kind: 'init', turn: turn.index });
    for (const command of commands) {
      if (command.startPlacement === 'fold') {
        steps.push({ kind: 'started', delivery: command.index });
      }
    }
    for (let seq = 1; seq <= turn.probes; seq += 1) {
      steps.push({ kind: 'probe', turn: turn.index, seq });
    }
    // The next turn's busy sends: written while THIS turn is running, so the CLI
    // queues them behind it and they run after this turn's `RESULT`.
    if (next) {
      for (const index of next.commands) {
        const command = deliveries[index] as DeliveryPlan;
        if (command.window === 'busy') {
          send(command);
        }
      }
    }
    if (turn.interrupted) {
      steps.push({ kind: 'interrupt' });
    }
    for (const command of commands) {
      if (command.terminalPlacement === 'before-result') {
        steps.push({ kind: 'terminal', delivery: command.index });
      }
    }
    steps.push({ kind: 'result', turn: turn.index });
    for (const command of commands) {
      if (command.terminalPlacement === 'after-result') {
        steps.push({ kind: 'terminal', delivery: command.index });
      }
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Scripted-process arm
// ---------------------------------------------------------------------------

/** A scheduler whose deadlines never fire: this arm is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/**
 * A resident process the arm owns: a stream it pushes into, in order, plus the
 * driver's own write side read back off the queue it seeds and writes.
 *
 * `end` finishes the stream, which is the only way to drive the process-exit
 * leg: the driver's read loop ends and `reportExit` settles the ledger. The
 * query never ends on its own otherwise — an iterable that finished would turn
 * every later reading into a reading of a dead process.
 */
function createFakeProcess(): {
  factory: ClaudeResidentProcessFactory;
  emit(frame: AnyRecord): void;
  pushed(): AnyRecord[];
  end(): void;
} {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];
  const enders: Array<() => void> = [];
  const pushed: AnyRecord[] = [];
  let done = false;

  const push = (frame: AnyRecord): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    pending.push(frame);
  };

  const finish = (): void => {
    done = true;
    for (const end of enders.splice(0)) {
      end();
    }
  };

  const iterator: AsyncIterator<AnyRecord> = {
    next(): Promise<IteratorResult<AnyRecord>> {
      const frame = pending.shift();
      if (frame) {
        return Promise.resolve({ value: frame, done: false });
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise<IteratorResult<AnyRecord>>((resolve) => {
        waiters.push((queued) => resolve({ value: queued, done: false }));
        enders.push(() => resolve({ value: undefined, done: true }));
      });
    },
    return(): Promise<IteratorResult<AnyRecord>> {
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };

  const factory: ClaudeResidentProcessFactory = (input) => {
    // One reader, for the process's whole life: every frame the driver writes is
    // recorded in write order, which is the order the arm reads uuids in.
    void (async () => {
      for await (const frame of input.prompt) {
        pushed.push(frame);
      }
    })();
    return { query, pid: PROCESS_PID } satisfies ClaudeResidentProcess;
  };

  return { factory, emit: push, pushed: () => pushed, end: finish };
}

/** The runtime's own turn inputs, stubbed to the facts this arm's driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  // The frame pipeline has its own criteria. This arm measures ROUTING (I3), so
  // the normalizer turns a probe frame into exactly one normalized frame and
  // everything else into nothing — which keeps each writer's recorded frames the
  // ones the generator put there and no others. The probe rides along on a
  // carrier field, so a frame is recognisable as this criterion's own wherever it
  // lands (the run registry's `seq` no other frame carries is AC-382's leg).
  normalizeMessage: (raw) => {
    const probe = (raw as AnyRecord | undefined)?.probe as { turn: number; seq: number } | undefined;
    if (!probe) {
      return [];
    }
    return [
      {
        id: `probe-${probe.turn}-${probe.seq}`,
        sessionId: '',
        timestamp: '1970-01-01T00:00:00.000Z',
        provider: 'claude',
        kind: 'text',
        text: `probe ${probe.seq}`,
        probe,
      } as unknown as NormalizedMessage,
    ];
  },
  isProviderInstalled: async () => true,
};

/** A writer that records every frame it is handed. */
type RecordingWriter = {
  writer: ProviderRuntimeWriter;
  frames: AnyRecord[];
  completeCount(): number;
};

function createRecordingWriter(): RecordingWriter {
  const frames: AnyRecord[] = [];
  const writer: ProviderRuntimeWriter = {
    send: (message) => {
      frames.push(message as AnyRecord);
    },
    setSessionId: () => undefined,
    userId: 1,
  };
  return { writer, frames, completeCount: () => frames.filter((frame) => frame.kind === 'complete').length };
}

/** The `turn`-lease projection the driver reported through its sink, by kind. */
type LeaseModel = { turn: Set<string> };

type Harness = {
  sessionId: string;
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: { emit(frame: AnyRecord): void; pushed(): AnyRecord[]; end(): void };
  leases: LeaseModel;
  writers: RecordingWriter[];
  runs: Promise<void>[];
  /** The ledger as it stood when the driver reported the process gone. */
  exitLedger: ClaudeResidentLedgerReading | null;
};

/**
 * Builds one arm: a real driver over a scripted process, and the sink captured
 * so the lease projection the driver actually emitted can be modelled exactly
 * (add by `turn:<runId>`, removal by kind — the manager's own semantics).
 *
 * Capture is by wrapping `startHost`, the one moment the manager hands the driver
 * its sink. The wrapper binds every other member to the real sink, so the
 * manager's behaviour is untouched; it also snapshots the ledger when `exited` is
 * reported, which is the last moment the host is still readable.
 */
function createHarness(sequenceIndex: number, sessionId?: string): Harness {
  const session = sessionId ?? `ac378-ledger-${sequenceIndex}`;
  const manager = createSessionHostManager({ now: () => 1_700_000_000_000, scheduler: inertScheduler() });
  const process = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => 1_700_000_000_000,
  });

  const harness: Harness = {
    sessionId: session,
    manager,
    driver,
    process,
    leases: { turn: new Set<string>() },
    writers: [],
    runs: [],
    exitLedger: null,
  };

  const startHost = driver.startHost.bind(driver);
  driver.startHost = async (host: ProcessHost, sink: IProviderHostDriverSink): Promise<ProcessHost> => {
    const wrapped = new Proxy(sink as unknown as Record<string, unknown>, {
      get(target, property) {
        if (property === 'leaseAdded') {
          return (appSessionId: string, lease: { kind: string; runId?: string }) => {
            if (lease.kind === 'turn' && typeof lease.runId === 'string') {
              harness.leases.turn.add(lease.runId);
            }
            return (target.leaseAdded as (id: string, value: unknown) => void)(appSessionId, lease);
          };
        }
        if (property === 'leaseRemoved') {
          return (appSessionId: string, kind: string) => {
            if (kind === 'turn') {
              harness.leases.turn.clear();
            }
            return (target.leaseRemoved as (id: string, value: string) => void)(appSessionId, kind);
          };
        }
        if (property === 'exited') {
          return (detail: unknown) => {
            harness.exitLedger = driver.ledgerReading(session);
            return (target.exited as (value: unknown) => void)(detail);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as IProviderHostDriverSink;
    return startHost(host, wrapped);
  };

  return harness;
}

// ---------------------------------------------------------------------------
// Driving the walk
// ---------------------------------------------------------------------------

/** Yields the microtask queue enough times for the driver to drain what was pushed. */
async function drain(): Promise<void> {
  for (let hop = 0; hop < 24; hop += 1) {
    await Promise.resolve();
  }
}

/** Waits for a condition, yielding microtasks and (rarely) a macrotask. */
async function until(condition: () => boolean, label: string, budget = 6_000): Promise<void> {
  for (let attempt = 0; attempt < budget; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
    if (attempt % 24 === 23) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  throw new Error(`harness: ${label} never became true`);
}

/** How many `turn` leases the manager is holding for one session's binding. */
function turnLeaseCount(manager: SessionHostManager, sessionId: string): number {
  for (const host of manager.snapshot()) {
    const binding = host.bindings.get(sessionId);
    if (binding) {
      return binding.leases.filter((lease) => lease.kind === 'turn').length;
    }
  }
  return 0;
}

/** Reads the ledger, insisting the host is live (a violation if it is not). */
function ledgerOf(harness: Harness): ClaudeResidentLedgerReading {
  const reading = harness.driver.ledgerReading(harness.sessionId);
  if (!reading) {
    throw new Error('violation=I1 the ledger must be readable while the host is live');
  }
  return reading;
}

/** Writes one frame into the process and lets the driver read it. */
async function emit(harness: Harness, frame: AnyRecord): Promise<void> {
  harness.process.emit(frame);
  await drain();
}

/** Dispatches one send and answers with the uuid its frame was written under. */
async function sendOne(
  harness: Harness,
  command: string,
  priority: 'later' | 'next' | null,
): Promise<string> {
  const recording = createRecordingWriter();
  const before = harness.process.pushed().length;
  harness.writers.push(recording);
  const options = priority === null ? {} : { [CLAUDE_TURN_PRIORITY_OPTION]: priority };
  const run = harness.driver.run(harness.sessionId, { command, options }, recording.writer, CONTEXT);
  // A run may be failed by the process-exit leg, where nothing awaits it.
  run.catch(() => undefined);
  harness.runs.push(run);
  const expected = harness.writers.length;
  // Two waits, and both are needed: the ledger holds the delivery as soon as the
  // run is armed, while the frame itself is handed to the process through the
  // input queue the scripted seam is reading — asynchronously, one task later.
  await until(
    () =>
      (harness.driver.ledgerReading(harness.sessionId)?.deliveries.length ?? 0) >= expected &&
      harness.process.pushed().length > before,
    `the resident host to accept send #${expected}`,
  );
  const frame = harness.process.pushed()[before] as AnyRecord | undefined;
  const uuid = typeof frame?.uuid === 'string' ? frame.uuid : null;
  if (!uuid) {
    throw new Error(`harness: the driver accepted send #${expected} without writing a frame for it`);
  }
  return uuid;
}

/** The host as the manager sees it, for the interrupt verb. */
function hostOf(harness: Harness): ProcessHost {
  const host = harness.manager.snapshot().find((candidate) => candidate.bindings.has(harness.sessionId));
  if (!host) {
    throw new Error('harness: the resident host must be open');
  }
  return host;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** A violation: the invariant, what was read, and the step it was read at. */
class Violation extends Error {
  readonly invariant: string;
  readonly stepIndex: number;
  constructor(invariant: string, detail: string, stepIndex: number, ledger?: ClaudeResidentLedgerReading) {
    super(`violation=${invariant} ${detail}${ledger ? `\n  ledger=${JSON.stringify(ledger)}` : ''}`);
    this.name = 'Violation';
    this.invariant = invariant;
    this.stepIndex = stepIndex;
  }
}

/** One step, rendered compactly so a counterexample fits on a line. */
function describeStep(step: Step): string {
  switch (step.kind) {
    case 'send':
      return `SEND#${step.delivery}`;
    case 'queued':
      return `queued#${step.delivery}`;
    case 'started':
      return `started#${step.delivery}`;
    case 'foreign-started':
      return `foreign-started(${step.uuid})`;
    case 'init':
      return `INIT(t${step.turn})`;
    case 'probe':
      return `probe(t${step.turn}.${step.seq})`;
    case 'terminal':
      return `terminal#${step.delivery}`;
    case 'interrupt':
      return 'INTERRUPT';
    case 'result':
      return `RESULT(t${step.turn})`;
  }
}

function renderSteps(steps: Step[]): string {
  return steps.map(describeStep).join(' ');
}

/**
 * I6, read after every step: the `turn` leases the host holds are exactly the
 * ledger's open work.
 *
 * One per open run, PLUS one for an unattended turn — a turn with no delivery
 * behind it, which the per-run projection cannot express and which AC-384 added
 * (§5.4: the host is busy for a turn it was never handed). At rest that is zero
 * for every host.
 *
 * Read twice, and the two are independent: once from the calls the driver
 * actually emitted into its sink, and once from the manager's own binding. A
 * lease that lingers (or is missing) shows up here at the step that caused it.
 */
function checkStepInvariants(harness: Harness, stepIndex: number): void {
  const ledger = ledgerOf(harness);
  const unattendedTurnLease = ledger.turn?.open === true && ledger.openRuns === 0 ? 1 : 0;
  const expectedLeases = ledger.openRuns + unattendedTurnLease;
  const sinkCount = harness.leases.turn.size;
  if (sinkCount !== expectedLeases) {
    throw new Violation(
      'I6',
      `after step ${stepIndex}: the host holds ${sinkCount} turn leases but the ledger projects ` +
        `${ledger.openRuns} open runs${unattendedTurnLease === 1 ? ' and an unattended open turn' : ''}`,
      stepIndex,
      ledger,
    );
  }
  const managerCount = turnLeaseCount(harness.manager, harness.sessionId);
  if (managerCount !== expectedLeases) {
    throw new Violation(
      'I6',
      `after step ${stepIndex}: the manager reads ${managerCount} turn leases for a ledger projecting ` +
        `${ledger.openRuns} open runs${unattendedTurnLease === 1 ? ' and an unattended open turn' : ''}`,
      stepIndex,
      ledger,
    );
  }
}

/**
 * What one replayed sequence produced, for the criterion's own summary.
 *
 * The shape counters are the corpus's coverage claim: the AC requires both
 * orders of terminal-versus-`RESULT` to be generated, and the DoD names the
 * operations that have to be walked. They are aggregated and asserted non-zero
 * so a generator that quietly stopped producing one of them reds here instead of
 * leaving a hole in the property.
 */
type SequenceReading = {
  turns: number;
  deliveries: number;
  probes: number;
  /** Deliveries the CLI dequeued before the turn it ran in (the S2 contract). */
  pendingStarts: number;
  /** Deliveries the CLI folded into the turn already running. */
  foldedStarts: number;
  /** Deliveries the CLI never dequeued at all (the cold head). */
  unstartedCommands: number;
  /** Deliveries whose terminal was read before their `RESULT`. */
  terminalsBeforeResult: number;
  /** Deliveries whose terminal was read after it — the C-3 order that leaves one owed. */
  terminalsAfterResult: number;
  /** Turns opened by an `init` with nothing bound into it. */
  unattendedTurns: number;
  /** Turns led by a `started` under a uuid nobody here pushed. */
  foreignCommands: number;
  /** Turns a person interrupted while a command was in flight. */
  interruptedTurns: number;
  /** Whether this sequence ever held a delivery owed at a closed turn's boundary. */
  sawOwed: boolean;
};

/**
 * Replays one sequence, checking I1–I6 as it goes, and returns what it read.
 *
 * Throws a {@link Violation} at the first reading that breaks, carrying the step
 * index so the caller can print the shortest prefix that still violates.
 */
async function runSequence(sequence: Sequence, sequenceIndex: number): Promise<SequenceReading> {
  const harness = createHarness(sequenceIndex);
  const { plan } = sequence;
  const uuids = new Map<number, string>();
  /** Deliveries whose frames have already been written into the process. */
  const dispatched = new Set<number>();
  let probes = 0;
  let sawOwed = false;

  for (let stepIndex = 0; stepIndex < sequence.steps.length; stepIndex += 1) {
    const step = sequence.steps[stepIndex] as Step;

    switch (step.kind) {
      case 'send': {
        const delivery = plan.deliveries[step.delivery] as DeliveryPlan;
        uuids.set(step.delivery, await sendOne(harness, delivery.command, delivery.priority));
        dispatched.add(step.delivery);
        break;
      }
      case 'queued': {
        await emit(harness, { type: 'command_lifecycle', command_uuid: uuids.get(step.delivery), state: 'queued' });
        break;
      }
      case 'started': {
        await emit(harness, { type: 'command_lifecycle', command_uuid: uuids.get(step.delivery), state: 'started' });
        break;
      }
      case 'foreign-started': {
        await emit(harness, { type: 'command_lifecycle', command_uuid: step.uuid, state: 'started' });
        break;
      }
      case 'init': {
        const turn = plan.turns.find((candidate) => candidate.index === step.turn) as TurnPlan;
        await emit(harness, { type: 'system', subtype: 'init', uuid: `init-${sequenceIndex}-${step.turn}` });
        const ledger = ledgerOf(harness);
        // I5: a turn nobody here opened is exactly one this `init` bound nothing
        // into — no command of ours was waiting for it, and no run of ours was
        // open for it.
        if (ledger.turn?.kind !== turn.kind) {
          throw new Violation(
            'I5',
            `after step ${stepIndex}: init of turn ${step.turn} opened a ${ledger.turn?.kind ?? 'null'} turn, expected ${turn.kind}`,
            stepIndex,
            ledger,
          );
        }
        if (turn.kind === 'delivered' && ledger.turn?.ownerDeliveryId === null) {
          throw new Violation('I5', `turn ${turn.index} is delivered but bound no owner`, stepIndex, ledger);
        }
        break;
      }
      case 'probe': {
        probes += 1;
        await emit(harness, {
          type: 'assistant',
          probe: { turn: step.turn, seq: step.seq },
          message: { role: 'assistant', content: [{ type: 'text', text: `probe ${step.seq}` }] },
        });
        break;
      }
      case 'terminal': {
        const delivery = plan.deliveries[step.delivery] as DeliveryPlan;
        if (delivery.terminal === null) {
          // The generator is the CLI here and it is breaking C-1: no terminal is
          // ever written for this command. False form (②) — see the file header.
          break;
        }
        await emit(harness, {
          type: 'command_lifecycle',
          command_uuid: uuids.get(step.delivery),
          state: delivery.terminal,
        });
        break;
      }
      case 'interrupt': {
        const stopped = await harness.driver.interrupt(hostOf(harness), harness.sessionId);
        if (stopped !== true) {
          throw new Error(`harness: the interrupt verb refused while a turn was in flight (step ${stepIndex})`);
        }
        await drain();
        break;
      }
      case 'result': {
        const turn = plan.turns.find((candidate) => candidate.index === step.turn) as TurnPlan;
        await emit(harness, { type: 'result', subtype: 'success', is_error: turn.outcome === 'aborted' });
        // I1 read at the boundary where it is *about* something: a turn ending
        // must leave nothing of its own open. The runs still waiting after this
        // `RESULT` are exactly the commands of later turns — the ones the CLI
        // was already handed while this turn ran — and not one more. This is the
        // shape the old FIFO broke: one `result` closed the front round, so a
        // folded command's run stayed open for good, and the offset never healed.
        // Only the commands already written count: a later turn's sends happen in
        // that turn's own window, so at this boundary they are not open yet.
        const expectedOpen = plan.deliveries.filter(
          (delivery) => dispatched.has(delivery.index) && delivery.turn > step.turn,
        ).length;
        const openNow = ledgerOf(harness).openRuns;
        if (openNow !== expectedOpen) {
          throw new Violation(
            'I1',
            `after step ${stepIndex}: turn ${step.turn} ended with ${openNow} runs open, ` +
              `but only ${expectedOpen} belong to later turns — a run covered by this turn is still open`,
            stepIndex,
            ledgerOf(harness),
          );
        }
        break;
      }
    }

    checkStepInvariants(harness, stepIndex);
    // The owed state is a reading of the moment, not of the end: a delivery whose
    // run closed before its terminal arrived is owed here and settled later, and
    // the sequence is only interesting if that actually happened somewhere.
    if (ledgerOf(harness).deliveries.some((delivery) => delivery.owed)) {
      sawOwed = true;
    }
  }

  // ---- at rest: I1 through I6 ----------------------------------------------
  const ledger = ledgerOf(harness);
  const at = sequence.steps.length;

  if (ledger.turn?.open) {
    throw new Violation('I1', 'the last turn must be closed at rest', at, ledger);
  }
  if (ledger.openRuns !== 0) {
    throw new Violation('I1', `every run must be settled at rest (openRuns=${ledger.openRuns})`, at, ledger);
  }
  if (ledger.pendingStart.length > 0) {
    throw new Violation(
      'I1',
      `no command may still wait to be bound at rest (pendingStart=${ledger.pendingStart.join(',')})`,
      at,
      ledger,
    );
  }
  if (harness.leases.turn.size !== 0) {
    throw new Violation('I1', `no turn lease may be held at rest (held=${harness.leases.turn.size})`, at, ledger);
  }
  if (turnLeaseCount(harness.manager, harness.sessionId) !== 0) {
    throw new Violation('I1', 'the manager must read no turn lease at rest', at, ledger);
  }
  if (harness.driver.runInFlight(harness.sessionId) !== false) {
    throw new Violation('I1', 'the host must not report a run in flight at rest', at, ledger);
  }
  if (harness.driver.busyInputReading(harness.sessionId)?.roundsOpen !== 0) {
    throw new Violation('I1', 'the open-run projection must be empty at rest', at, ledger);
  }

  // I2 — every turn and every delivery has exactly one terminal, and it is the
  // one the CLI stated. Turns are compared by ORDER, which is the order the CLI
  // announced and ended them in; the ledger's turn ids are its own.
  if (ledger.closedTurns.length !== plan.turns.length) {
    throw new Violation(
      'I2',
      `${plan.turns.length} turns were announced but ${ledger.closedTurns.length} closed`,
      at,
      ledger,
    );
  }
  for (const turn of plan.turns) {
    const closed = ledger.closedTurns[turn.index] as ClaudeResidentLedgerReading['closedTurns'][number];
    if (closed.kind !== turn.kind) {
      throw new Violation('I5', `turn ${turn.index} closed as ${closed.kind}, expected ${turn.kind}`, at, ledger);
    }
    if (closed.outcome !== turn.outcome) {
      throw new Violation(
        'I2',
        `turn ${turn.index} closed ${closed.outcome}, expected ${turn.outcome}`,
        at,
        ledger,
      );
    }
    const expectedOwner = turn.owner === null ? null : (uuids.get(turn.owner) as string);
    if (closed.ownerDeliveryId !== expectedOwner) {
      throw new Violation(
        'I3',
        `turn ${turn.index} names owner ${String(closed.ownerDeliveryId)}, expected ${String(expectedOwner)}`,
        at,
        ledger,
      );
    }
  }
  for (const delivery of plan.deliveries) {
    const read = ledger.deliveries[delivery.index];
    if (!read) {
      throw new Violation('I2', `delivery #${delivery.index} is missing from the ledger`, at, ledger);
    }
    if (read.turnId !== (ledger.closedTurns[delivery.turn] as { id: string }).id) {
      throw new Violation(
        'I2',
        `delivery #${delivery.index} is bound to ${String(read.turnId)}, expected turn ${delivery.turn}`,
        at,
        ledger,
      );
    }
    if (delivery.terminal === null) {
      // False form (②): I2 can only have been met by the ledger reconciling a
      // command the CLI never terminal'd. That has to be visible — the
      // reconciliation named and the anomaly recorded — and it is a violation of
      // the contract the sequence claims, so it must NOT pass silently.
      const reconciled = read.state === 'cancelled' && read.reason === 'owed-terminal-missing';
      const recorded = ledger.anomalies.some((anomaly) => anomaly.code === 'owed-terminal-missing');
      if (!reconciled || !recorded) {
        throw new Violation(
          'I2',
          `delivery #${delivery.index} never received a terminal from the CLI and was not reconciled as ` +
            `owed-terminal-missing (state=${read.state}, reason=${String(read.reason)}, ` +
            `anomalies=${ledger.anomalies.map((anomaly) => anomaly.code).join(',') || 'none'})`,
          at,
          ledger,
        );
      }
      throw new Violation(
        'I2',
        `the generator stated no terminal for delivery #${delivery.index} (C-1 breach); the ledger reconciled it ` +
          `as ${read.state}/${String(read.reason)} and recorded the anomaly, so the breach is not silent`,
        at,
        ledger,
      );
    }
    if (read.state !== delivery.terminal) {
      throw new Violation(
        'I2',
        `delivery #${delivery.index} ended ${read.state}, the CLI stated ${delivery.terminal}`,
        at,
        ledger,
      );
    }
    if (read.reason !== delivery.expectReason) {
      throw new Violation(
        'I2',
        `delivery #${delivery.index} carries reason ${String(read.reason)}, expected ${String(delivery.expectReason)}`,
        at,
        ledger,
      );
    }
    if (read.endedAt === null) {
      throw new Violation('I2', `delivery #${delivery.index} has a terminal with no ending time`, at, ledger);
    }
  }
  // I2's other half, at the run rather than the ledger: a run is ended by exactly
  // one terminal frame. Two would mean the settlement ran twice (the registry
  // drops the second, which is why only the writer can show it), and none would
  // mean a run was closed without telling the client.
  for (const [index, writer] of harness.writers.entries()) {
    if (writer.completeCount() !== 1) {
      throw new Violation(
        'I2',
        `the run for send #${index} wrote ${writer.completeCount()} terminal completes, expected exactly 1`,
        at,
        ledger,
      );
    }
  }
  for (const turn of plan.turns) {
    if (turn.foreignUuid !== null && ledger.deliveries.some((delivery) => delivery.deliveryId === turn.foreignUuid)) {
      throw new Violation('I5', `a foreign command (${turn.foreignUuid}) reached the delivery reading`, at, ledger);
    }
  }
  if (ledger.foreign.length !== plan.turns.filter((turn) => turn.foreignUuid !== null).length) {
    throw new Violation(
      'I2',
      `the CLI started ${plan.turns.filter((turn) => turn.foreignUuid !== null).length} commands nobody here pushed, the ledger noted ${ledger.foreign.length}`,
      at,
      ledger,
    );
  }

  // I3 — a turn's frames go into that turn's own run. The probes the generator
  // emitted inside turn k are exactly the probes turn k's OWNER writer received,
  // in order and with no hole in their `seq`: the driver-level form of "the run's
  // stream starts at 1 and is contiguous", which for the frontend cursor is
  // `{runId, seq}`. (The run registry's own `seq` is AC-382's leg.)
  for (const turn of plan.turns) {
    if (turn.kind !== 'delivered' || turn.owner === null) {
      continue;
    }
    const ownerWriter = harness.writers[turn.owner] as RecordingWriter;
    const received = ownerWriter.frames
      .filter((frame) => frame.probe !== undefined)
      .map((frame) => frame.probe as { turn: number; seq: number });
    const expected = Array.from({ length: turn.probes }, (_, position) => position + 1);
    const got = received.filter((probe) => probe.turn === turn.index).map((probe) => probe.seq);
    if (received.some((probe) => probe.turn !== turn.index)) {
      throw new Violation(
        'I3',
        `turn ${turn.index}'s owner writer received a frame belonging to another turn (${JSON.stringify(received)})`,
        at,
        ledger,
      );
    }
    if (got.length !== expected.length || got.some((seq, position) => seq !== expected[position])) {
      throw new Violation(
        'I3',
        `turn ${turn.index}'s owner writer received seqs ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
        at,
        ledger,
      );
    }
  }

  // I4 — binding is stable and nothing stays owed. Every command whose run closed
  // before its terminal was read received that terminal before the next turn
  // began, so no reconciliation was needed and none was recorded.
  for (const delivery of ledger.deliveries) {
    if (delivery.owed) {
      throw new Violation('I4', `delivery ${delivery.deliveryId} is still owed its terminal at rest`, at, ledger);
    }
  }
  const owedAnomalies = ledger.anomalies.filter((anomaly) => anomaly.code === 'owed-terminal-missing').length;
  const breached = plan.deliveries.filter((delivery) => delivery.terminal === null).length;
  if (owedAnomalies !== breached) {
    throw new Violation(
      'I4',
      `${breached} commands were left without a terminal but ${owedAnomalies} owed-terminal-missing anomalies were recorded`,
      at,
      ledger,
    );
  }

  const settled = await Promise.allSettled(harness.runs);
  if (settled.some((result) => result.status !== 'fulfilled')) {
    throw new Violation('I1', 'every dispatched run must settle at rest', at, ledger);
  }

  return {
    turns: ledger.closedTurns.length,
    deliveries: ledger.deliveries.length,
    probes,
    pendingStarts: plan.deliveries.filter((delivery) => delivery.startPlacement === 'pending').length,
    foldedStarts: plan.deliveries.filter((delivery) => delivery.startPlacement === 'fold').length,
    unstartedCommands: plan.deliveries.filter((delivery) => delivery.startPlacement === 'none').length,
    terminalsBeforeResult: plan.deliveries.filter((delivery) => delivery.terminalPlacement === 'before-result').length,
    terminalsAfterResult: plan.deliveries.filter((delivery) => delivery.terminalPlacement === 'after-result').length,
    unattendedTurns: plan.turns.filter((turn) => turn.kind === 'unattended').length,
    foreignCommands: plan.turns.filter((turn) => turn.foreignUuid !== null).length,
    interruptedTurns: plan.turns.filter((turn) => turn.interrupted).length,
    sawOwed,
  };
}

// ---------------------------------------------------------------------------
// The criterion
// ---------------------------------------------------------------------------

test('AC-378 seeded interleavings of the CLI contract satisfy I1-I6 on the delivery/turn ledger', async () => {
  let sequencesRun = 0;
  let violations = 0;
  const totals = {
    turns: 0,
    deliveries: 0,
    probes: 0,
    pendingStarts: 0,
    foldedStarts: 0,
    unstartedCommands: 0,
    terminalsBeforeResult: 0,
    terminalsAfterResult: 0,
    unattendedTurns: 0,
    foreignCommands: 0,
    interruptedTurns: 0,
    owedSequences: 0,
  };
  let counterexample: string | null = null;
  let failure: string | null = null;

  for (let index = 0; index < SEQUENCE_COUNT; index += 1) {
    const rng = makeRandom(SEED + index);
    const sequence = buildSequence(rng, index);
    sequencesRun += 1;
    try {
      const reading = await runSequence(sequence, index);
      totals.turns += reading.turns;
      totals.deliveries += reading.deliveries;
      totals.probes += reading.probes;
      totals.pendingStarts += reading.pendingStarts;
      totals.foldedStarts += reading.foldedStarts;
      totals.unstartedCommands += reading.unstartedCommands;
      totals.terminalsBeforeResult += reading.terminalsBeforeResult;
      totals.terminalsAfterResult += reading.terminalsAfterResult;
      totals.unattendedTurns += reading.unattendedTurns;
      totals.foreignCommands += reading.foreignCommands;
      totals.interruptedTurns += reading.interruptedTurns;
      totals.owedSequences += reading.sawOwed ? 1 : 0;
    } catch (error) {
      violations += 1;
      const violation = error as Violation;
      failure = violation.message;
      counterexample = renderSteps(sequence.steps);
      // The counterexample is the SHORTEST PREFIX that still violates *inside
      // itself*: a prefix is only accepted when the violation lands at a step
      // strictly before its own end, which is what keeps "the sequence had not
      // finished yet" from passing for a counterexample. The invariant must be
      // the same one, so the prefix reds for the reason the sequence did.
      if (typeof violation.stepIndex === 'number' && violation.stepIndex < sequence.steps.length) {
        // A prefix shorter than the step the violation was read at cannot
        // reproduce it, so the search starts there: the first length that still
        // violates is the shortest one.
        for (let end = violation.stepIndex + 1; end <= sequence.steps.length; end += 1) {
          try {
            await runSequence({ steps: sequence.steps.slice(0, end), plan: sequence.plan }, index);
          } catch (candidate) {
            const inner = candidate as Violation;
            if (inner.invariant === violation.invariant && inner.stepIndex < end) {
              counterexample = renderSteps(sequence.steps.slice(0, end));
              break;
            }
          }
        }
      }
      break;
    }
  }

  console.log(
    `ledger-invariants: seed=${SEED} sequences=${sequencesRun} violations=${violations} ` +
      `turns=${totals.turns} deliveries=${totals.deliveries} probes=${totals.probes} ` +
      `pendingStarts=${totals.pendingStarts} foldedStarts=${totals.foldedStarts} ` +
      `unstartedCommands=${totals.unstartedCommands} terminalBeforeResult=${totals.terminalsBeforeResult} ` +
      `terminalAfterResult=${totals.terminalsAfterResult} unattendedTurns=${totals.unattendedTurns} ` +
      `foreignCommands=${totals.foreignCommands} interruptedTurns=${totals.interruptedTurns} ` +
      `owedSequences=${totals.owedSequences} anomalies=0`,
  );

  if (violations > 0) {
    console.error(`ledger-invariants: counterexample-sequence=${counterexample ?? ''}`);
    assert.fail(`violations=${violations}\n${failure ?? ''}`);
  }

  assert.strictEqual(violations, 0, 'every seeded sequence must satisfy I1-I6');
  assert.ok(sequencesRun >= 200, `the AC floors the seeded corpus at 200 sequences (ran ${sequencesRun})`);

  // The corpus has to have walked every shape the AC and the DoD name — a
  // generator that stopped producing one of them would leave the invariant it
  // exercises untested while still printing `violations=0`.
  const walked: Array<[string, number]> = [
    ['pending starts (the S2 contract)', totals.pendingStarts],
    ['folded starts (C-2)', totals.foldedStarts],
    ['commands never dequeued (the cold head)', totals.unstartedCommands],
    ['terminals before the RESULT (C-3)', totals.terminalsBeforeResult],
    ['terminals after the RESULT (C-3)', totals.terminalsAfterResult],
    ['unattended turns (I5)', totals.unattendedTurns],
    ['foreign cron starts', totals.foreignCommands],
    ['interrupted turns (C-5)', totals.interruptedTurns],
    ['sequences that held a delivery owed at a boundary (I4)', totals.owedSequences],
  ];
  const missing = walked.filter(([, count]) => count === 0).map(([label]) => label);
  assert.deepStrictEqual(missing, [], `the corpus must walk every named shape (missing: ${missing.join('; ')})`);
});

// ---------------------------------------------------------------------------
// The process-exit leg: every open run and turn is settled, and the ledger says
// so on its way out (the sink's `exited` is the last moment it is readable).
// ---------------------------------------------------------------------------

test('AC-378 a process that ends mid-turn cancels its deliveries and aborts its turn', async () => {
  const harness = createHarness(0, 'ac378-ledger-exit');
  const aUuid = await sendOne(harness, 'exit-A', null);
  await emit(harness, { type: 'command_lifecycle', command_uuid: aUuid, state: 'queued' });
  await emit(harness, { type: 'command_lifecycle', command_uuid: aUuid, state: 'started' });
  await emit(harness, { type: 'system', subtype: 'init', uuid: 'exit-init-0' });
  await emit(harness, { type: 'assistant', probe: { turn: 0, seq: 1 } });

  // A second send while that turn is in flight: a queue entry the CLI will never
  // drain, because the process goes away first.
  const bUuid = await sendOne(harness, 'exit-B', 'later');
  await emit(harness, { type: 'command_lifecycle', command_uuid: bUuid, state: 'queued' });

  const before = ledgerOf(harness);
  assert.strictEqual(before.openRuns, 2, 'both runs must be open before the exit');

  harness.process.end();
  await until(() => harness.exitLedger !== null, 'the driver to report the process gone');
  const ledger = harness.exitLedger as ClaudeResidentLedgerReading;
  console.log(
    `ledger-invariants/exit: openRuns=${ledger.openRuns} deliveries=` +
      `${ledger.deliveries.map((delivery) => `${delivery.state}/${String(delivery.reason)}`).join(',')} ` +
      `turns=${ledger.closedTurns.map((turn) => turn.outcome).join(',')} turnLeases=${harness.leases.turn.size}`,
  );

  // A, the turn opened for it, and the queued B all lose the process that was
  // going to answer them.
  assert.strictEqual(harness.leases.turn.size, 0, 'no turn lease may be held once the process is gone');
  assert.strictEqual(ledger.openRuns, 0, 'no run may stay open once the process is gone');
  assert.deepStrictEqual(
    ledger.deliveries.map((delivery) => `${delivery.state}/${String(delivery.reason)}`),
    ['cancelled/process-exit', 'cancelled/process-exit'],
    'every command without a terminal is cancelled(process-exit)',
  );
  assert.deepStrictEqual(
    ledger.closedTurns.map((turn) => turn.outcome),
    ['aborted'],
    'the turn that never reached a RESULT reads aborted',
  );

  const settled = await Promise.allSettled(harness.runs);
  assert.deepStrictEqual(
    settled.map((result) => result.status),
    ['rejected', 'rejected'],
    'every dispatcher is told its run did not finish',
  );
});
