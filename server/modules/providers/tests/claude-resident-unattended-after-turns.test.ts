/**
 * Criterion for AC-381 — a resident host still recognising the process's OWN
 * turns once a conversation has been running for a while.
 *
 * A resident Claude host holds one CLI across turns. Some turns nobody at this
 * end sent: a background task the process started reports back on its own, a
 * cron prompt fires, a peer session writes a message in. Those turns arrive as
 * a `system/init` with no request in front of them, and the host opens a run
 * for them so their frames reach a client and so the turn's end reports "the
 * background work finished".
 *
 * `openUnattendedTurnIfOwn` used to decide that by asking whether the round
 * FIFO was empty. That reading is a count of work in flight, and a merged turn
 * leaves the FIFO one ahead of the CLI for good: it settles every command the
 * CLI folded into one turn, but a round the CLI drained into a *later* turn —
 * or one whose `started` had not been read yet — stays on the FIFO with its run
 * open. From then on every `init` met a non-empty FIFO, so every unattended
 * turn went unrecognised and nothing reported that the background work ended
 * (SPEC `resident-delivery-turn-ledger-SPEC.md` §1.4, first consequence).
 *
 * What the CLI actually states is structural and has nothing to do with a
 * count: a `system/init` is the process's own turn exactly when nothing this
 * host pushed is waiting to be bound to it (SPEC §4.4 I5). The ledger keeps
 * that in `pendingStart` — the command uuids the CLI's `started` named while no
 * turn was open, which the next `init` binds (SPEC §5.2) — so the reading is
 * the ledger's, and a stale round cannot mask it.
 *
 * The criterion drives a real `ClaudeResidentHostDriver` through the injected
 * `createProcess` seam (a scripted process, no real `claude` binary) and reads
 * the host's own public readings back:
 *
 * - `chatRunRegistry.getRun(session)` for the run an unattended turn opened —
 *   its `source` and its terminal frames;
 * - `driver.ledgerReading(session)` for the turn's kind, the delivery ids bound
 *   to it, the commands waiting to be bound, and which commands were foreign;
 * - `driver.unattendedReading(session)` for the opener uuid and the pushed set;
 * - the injected `notifyUnattendedWork` for the report the turn's end makes,
 *   and `driver.busyInputReading(session).roundsOpen` plus the manager's `turn`
 *   leases for the rest reading I1 is stated in.
 *
 * Four legs, all in one run:
 *
 * - **(a)** three ordinary turns first — a cold one, one with a `next` command
 *   folded into it at a tool boundary, and one the CLI drained two `later`
 *   commands into (C-4) — then, from rest, an `init` nothing pushed. It must be
 *   an unattended turn: `source=unattended`, no delivery bound to it, exactly
 *   one report, exactly one terminal `complete`, and rest afterwards. Run twice,
 *   once with the turn's `result` carrying `origin.kind=task-notification` and
 *   once with `peer`, because those are the two origins the CLI states and the
 *   two the report's trigger is read from.
 * - **(b)** the defect sequence first — a busy send folded into a turn in
 *   flight, and only the one `result` — which leaves a round on the FIFO. The
 *   same unattended sequence after it must still be recognised.
 * - **(c)** the two counter-examples: an `init` with a pushed command's
 *   `started` waiting for it is a delivered turn and opens no unattended run;
 *   a `started` under a uuid nothing here pushed (the cron shape, E9 §9.4) is
 *   `foreign` — it makes the turn unattended, not delivered, and its uuid stays
 *   out of every reading this host exposes.
 * - **(d)** the false form, run by hand and recorded with the task: restoring
 *   the old `state.rounds.length > 0` early return must red leg (b) on its
 *   `staleResidueUnattended` reading, and nothing earlier.
 *
 * Red lines:
 * - The process budget guard below kills the whole process with `exit 3` rather
 *   than failing one case, as in the sibling resident criteria.
 * - Every reading is taken before anything is asserted and printed on one line,
 *   so a red lands on the reading that is wrong rather than on a timeout or on
 *   an earlier leg.
 * - No real `claude` binary is started: the seam is the injected process.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionHostManager,
} from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  CLAUDE_TURN_PRIORITY_OPTION,
  ClaudeResidentHostDriver,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  ClaudeUnattendedWorkEvent,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/** The provider-native id the scripted turns key their frames by. */
const PROVIDER_SESSION_ID = 'ac381-unattended-after-turns-provider-session';

/** The bound the criterion reports the whole run against (SPEC §11: under 45 s). */
const ELAPSED_LIMIT_MS = 44_000;

const STARTED_AT = Date.now();

const budgetGuard = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget=${ELAPSED_LIMIT_MS}ms elapsed=${elapsed}ms exit=3 — the unattended-after-turns criterion ` +
      `did not finish inside its process budget (a process-level kill, not a node:test case failure).`,
  );
  process.exit(3);
}, ELAPSED_LIMIT_MS - 1_000);
budgetGuard.unref();

// ---------------------------------------------------------------------------
// Scripted process seam
// ---------------------------------------------------------------------------

/** A scheduler whose deadlines never fire: this criterion is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/**
 * A resident process the criterion owns: a stream it pushes into, in order.
 *
 * The query never ends on its own — an iterable that finished would make the
 * driver's read loop call `reportExit` and close the host, turning every
 * reading into a reading of a dead process.
 */
function createFakeProcess(): { factory: ClaudeResidentProcessFactory; emit(frame: AnyRecord): void } {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];

  const push = (frame: AnyRecord): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    pending.push(frame);
  };

  const iterator: AsyncIterator<AnyRecord> = {
    next(): Promise<IteratorResult<AnyRecord>> {
      const frame = pending.shift();
      if (frame) {
        return Promise.resolve({ value: frame, done: false });
      }
      return new Promise<IteratorResult<AnyRecord>>((resolve) => {
        waiters.push((queued) => resolve({ value: queued, done: false }));
      });
    },
    return(): Promise<IteratorResult<AnyRecord>> {
      return new Promise<IteratorResult<AnyRecord>>(() => undefined);
    },
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };

  return {
    factory: () => ({ query, pid: 4242 }) satisfies ClaudeResidentProcess,
    emit: push,
  };
}

/** The runtime's own turn inputs, stubbed to the facts this criterion's driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  // The frame pipeline has its own criteria; this one measures which turn a
  // frame belongs to, and an empty normalizer keeps the recording writers free
  // of forwarded frames.
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

/** A writer that records every frame it is handed. */
function createRecordingWriter(): { writer: ProviderRuntimeWriter; frames: AnyRecord[] } {
  const frames: AnyRecord[] = [];
  const writer: ProviderRuntimeWriter = {
    send: (message) => {
      frames.push(message as AnyRecord);
    },
    setSessionId: () => undefined,
    userId: 1,
  };
  return { writer, frames };
}

// ---------------------------------------------------------------------------
// CLI-shaped frames
// ---------------------------------------------------------------------------

/** The CLI's statement that a turn is beginning. */
function initFrame(uuid: string): AnyRecord {
  return { type: 'system', subtype: 'init', uuid };
}

/** The CLI's account of accepting a pushed command into its queue. */
function queuedFrame(commandUuid: string): AnyRecord {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state: 'queued' };
}

/** The CLI's account of dequeuing a command into a turn. */
function startedFrame(commandUuid: string): AnyRecord {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state: 'started' };
}

/** The CLI's terminal for one command (C-1). */
function completedFrame(commandUuid: string): AnyRecord {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state: 'completed' };
}

/** A frame of the turn's own content. */
function assistantFrame(): AnyRecord {
  return {
    type: 'assistant',
    uuid: 'assistant-frame',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  };
}

/**
 * The turn's terminal, with the origin the CLI states about it or `null`.
 *
 * `origin` is where a peer message (`peer`) and the host layer's own turn
 * reporting back (`task-notification`) are stated, and nowhere else — the
 * `Stop` hook's task list explains neither (SPEC §4.4, and the mapping
 * `readClaudeNotificationOrigin` makes for the transcript row).
 */
function resultFrame(originKind: string | null): AnyRecord {
  return {
    type: 'result',
    subtype: 'success',
    session_id: PROVIDER_SESSION_ID,
    is_error: false,
    origin: originKind ? { kind: originKind } : null,
  };
}

/** Yields the microtask queue enough times for the read loop to drain what was pushed. */
async function settle(hops = 400): Promise<void> {
  for (let hop = 0; hop < hops; hop += 1) {
    await Promise.resolve();
  }
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

/** Polls the manager's lease reading, letting the async `run` entry make progress. */
async function waitForTurnLeases(
  manager: SessionHostManager,
  sessionId: string,
  count: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (turnLeaseCount(manager, sessionId) >= count) {
      return true;
    }
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  return false;
}

// ---------------------------------------------------------------------------
// The arm
// ---------------------------------------------------------------------------

type Arm = {
  manager: SessionHostManager;
  driver: ClaudeResidentHostDriver;
  process: { emit(frame: AnyRecord): void };
  /** Every report an unattended turn's end made, in order. */
  notifications: ClaudeUnattendedWorkEvent[];
  /** How many times the host asked for an unattended run, accepted or not. */
  openedRuns(): number;
  sessionId: string;
};

/**
 * Builds one arm: a real driver over a scripted process, the manager wired to
 * the real run registry, and the unattended-report seam captured.
 */
function buildArm(sessionId: string): Arm {
  const manager = createSessionHostManager({ now: () => 1_700_000_000_000, scheduler: inertScheduler() });
  let openedRuns = 0;
  // The production wiring (`server/index.ts` installs the same opener): without
  // it the host's request for an unattended run is answered `null` and there is
  // nothing to read a `source` or a terminal frame back from.
  manager.setUnattendedRunOpener((input) => {
    openedRuns += 1;
    return chatRunRegistry.openUnattendedRun(input);
  });
  const notifications: ClaudeUnattendedWorkEvent[] = [];
  const process = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: (event) => {
      notifications.push(event);
    },
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => 1_700_000_000_000,
  });

  return {
    manager,
    driver,
    process,
    notifications,
    openedRuns: () => openedRuns,
    sessionId,
  };
}

/**
 * Dispatches one turn into the arm and answers with the command uuid the CLI
 * will name it by.
 *
 * `run` is not awaited: a round settles only once the arm has pushed the frames
 * that end it, so awaiting it here would deadlock. The promise is handled (it
 * is settled by the frames, or never — the residue leg leaves one round open on
 * purpose) so a failure surfaces as a rejected promise nobody reads rather than
 * an unhandled one.
 */
async function armRound(arm: Arm, command: string, options: Record<string, unknown> = {}): Promise<string> {
  const leasesBefore = turnLeaseCount(arm.manager, arm.sessionId);
  const writer = createRecordingWriter();
  void arm.driver
    .run(arm.sessionId, { command, options }, writer.writer, CONTEXT)
    .catch(() => undefined);
  const armed = await waitForTurnLeases(arm.manager, arm.sessionId, leasesBefore + 1, 5_000);
  assert.ok(armed, `the round '${command}' must arm its turn lease`);
  const commandUuid = arm.driver.unattendedReading(arm.sessionId)?.lastPushedUuid ?? null;
  assert.ok(commandUuid, `the round '${command}' must push a command uuid`);
  return commandUuid;
}

// ---------------------------------------------------------------------------
// (a) ordinary turns, then a turn nobody pushed
// ---------------------------------------------------------------------------

/**
 * Three ordinary turns, taking the arm to rest:
 *
 * - a cold send (`A`): `queued → started → init → … → RESULT → completed`;
 * - a warm send (`B`) with a `next` command (`C`) started at a tool boundary
 *   and folded into it (C-2), so one `init` and one `RESULT` cover both;
 * - two `later` sends (`D`, `E`) queued behind it and drained at its boundary
 *   into ONE turn (C-4), with their `started` after that turn's `RESULT` and a
 *   single new `init` binding them.
 */
async function runThreeOrdinaryTurns(arm: Arm): Promise<void> {
  const uuidA = await armRound(arm, 'A cold');
  arm.process.emit(queuedFrame(uuidA));
  arm.process.emit(startedFrame(uuidA));
  arm.process.emit(initFrame('init-1'));
  arm.process.emit(assistantFrame());
  arm.process.emit(resultFrame(null));
  arm.process.emit(completedFrame(uuidA));
  await settle();

  const uuidB = await armRound(arm, 'B next-turn opener');
  arm.process.emit(queuedFrame(uuidB));
  arm.process.emit(startedFrame(uuidB));
  arm.process.emit(initFrame('init-2'));
  arm.process.emit(assistantFrame());

  // The `next` shape: started while the turn is open, so it folds into it and
  // its terminal lands before the turn's `RESULT` (C-3).
  const uuidC = await armRound(arm, 'C next', { [CLAUDE_TURN_PRIORITY_OPTION]: 'next' });
  arm.process.emit(queuedFrame(uuidC));
  arm.process.emit(startedFrame(uuidC));

  // The `later` shape: two more sends queued behind the turn in flight.
  const uuidD = await armRound(arm, 'D later', { [CLAUDE_TURN_PRIORITY_OPTION]: 'later' });
  const uuidE = await armRound(arm, 'E later', { [CLAUDE_TURN_PRIORITY_OPTION]: 'later' });
  arm.process.emit(queuedFrame(uuidD));
  arm.process.emit(queuedFrame(uuidE));

  arm.process.emit(completedFrame(uuidC));
  arm.process.emit(resultFrame(null));
  arm.process.emit(completedFrame(uuidB));
  await settle();

  // The drained pair opens one turn of its own.
  arm.process.emit(startedFrame(uuidD));
  arm.process.emit(startedFrame(uuidE));
  arm.process.emit(initFrame('init-3'));
  arm.process.emit(assistantFrame());
  arm.process.emit(resultFrame(null));
  arm.process.emit(completedFrame(uuidD));
  arm.process.emit(completedFrame(uuidE));
  await settle();
}

/** What one unattended sequence read back. */
type UnattendedReading = {
  source: string;
  deliveryIds: number;
  notifications: number;
  trigger: string;
  completes: number;
  roundsOpen: number;
  turnLeasesOpen: number;
  openerUuid: string | null;
};

/**
 * Feeds one `init` nothing pushed, an assistant frame, and the `result` that
 * ends it, and reads the run, its terminal frames, the report and the rest
 * reading back.
 */
async function runUnattendedSequence(arm: Arm, originKind: string): Promise<UnattendedReading> {
  const notificationsBefore = arm.notifications.length;
  arm.process.emit(initFrame('init-unattended'));
  await settle();
  const openerUuid = arm.driver.unattendedReading(arm.sessionId)?.unattendedCommandUuid ?? null;
  arm.process.emit(assistantFrame());
  await settle();
  arm.process.emit(resultFrame(originKind));
  await settle();

  const run = chatRunRegistry.getRun(arm.sessionId);
  const ledger = arm.driver.ledgerReading(arm.sessionId);
  const turn = ledger?.turn ?? null;
  return {
    source: run?.source ?? 'none',
    // The delivery ids bound to the turn just ended: an unattended turn binds
    // none, so this is the reading an unattended turn's delivery list is empty.
    deliveryIds: turn ? (ledger?.deliveries ?? []).filter((delivery) => delivery.turnId === turn.id).length : -1,
    notifications: arm.notifications.length - notificationsBefore,
    trigger: arm.notifications.at(-1)?.trigger ?? 'none',
    // The run's own terminal frames: exactly one, because a turn ends once.
    completes: run ? run.events.filter((event) => (event as AnyRecord).kind === 'complete').length : -1,
    roundsOpen: arm.driver.busyInputReading(arm.sessionId)?.roundsOpen ?? -1,
    turnLeasesOpen: turnLeaseCount(arm.manager, arm.sessionId),
    openerUuid,
  };
}

test('AC381-a an `init` nothing pushed is an unattended turn after several ordinary turns', async () => {
  const arm = buildArm('ac381-unattended-after-turns-a');
  await runThreeOrdinaryTurns(arm);

  const atRest = {
    roundsOpen: arm.driver.busyInputReading(arm.sessionId)?.roundsOpen ?? -1,
    turnLeasesOpen: turnLeaseCount(arm.manager, arm.sessionId),
    pendingStart: arm.driver.ledgerReading(arm.sessionId)?.pendingStart.length ?? -1,
  };
  assert.strictEqual(atRest.roundsOpen, 0, 'three ordinary turns must reach rest before the unattended one');
  assert.strictEqual(atRest.pendingStart, 0, 'nothing may be waiting to be bound at rest');

  const backgroundTask = await runUnattendedSequence(arm, 'task-notification');
  const backgroundTaskRest = `roundsOpen=${backgroundTask.roundsOpen} turnLeasesOpen=${backgroundTask.turnLeasesOpen}`;

  const peerArm = buildArm('ac381-unattended-after-turns-a-peer');
  await runThreeOrdinaryTurns(peerArm);
  const peer = await runUnattendedSequence(peerArm, 'peer');

  console.log(
    `unattendedSource=${backgroundTask.source} unattendedDeliveryIds=${backgroundTask.deliveryIds} ` +
      `unattendedNotifications=${backgroundTask.notifications} unattendedTrigger=${backgroundTask.trigger} ` +
      `unattendedCompletes=${backgroundTask.completes}`,
  );
  console.log(
    `peerSource=${peer.source} peerDeliveryIds=${peer.deliveryIds} peerNotifications=${peer.notifications} ` +
      `peerTrigger=${peer.trigger} peerCompletes=${peer.completes}`,
  );
  console.log(`[rest] ${backgroundTaskRest}`);

  assert.ok(backgroundTask.openerUuid, 'the unattended turn must be identified by the opener uuid the CLI minted');
  assert.strictEqual(backgroundTask.source, 'unattended', 'the run must be marked as the host layer\'s own turn');
  assert.strictEqual(backgroundTask.deliveryIds, 0, 'an unattended turn must bind no delivery');
  assert.strictEqual(backgroundTask.notifications, 1, 'the turn\'s end must report exactly once');
  assert.strictEqual(
    backgroundTask.trigger,
    'background-task',
    'a `task-notification` origin is the host layer\'s own turn reporting back',
  );
  assert.strictEqual(backgroundTask.completes, 1, 'the run must read exactly one terminal complete');
  assert.strictEqual(backgroundTaskRest, 'roundsOpen=0 turnLeasesOpen=0', 'the host must be at rest (I1)');

  assert.ok(peer.openerUuid, 'the peer-origin leg must open an unattended turn too');
  assert.strictEqual(peer.source, 'unattended', 'the peer-origin leg must be an unattended run as well');
  assert.strictEqual(peer.deliveryIds, 0, 'the peer-origin leg must bind no delivery');
  assert.strictEqual(peer.notifications, 1, 'the peer-origin leg must report exactly once');
  assert.strictEqual(peer.trigger, 'cross-session-message', 'a `peer` origin names the cross-session trigger');
  assert.strictEqual(peer.completes, 1, 'the peer-origin leg must read exactly one terminal complete');
});

// ---------------------------------------------------------------------------
// (b) a stale round must not mask the unattended turn
// ---------------------------------------------------------------------------

test('AC381-b a round left behind by a merged turn does not mask the next unattended turn', async () => {
  const arm = buildArm('ac381-unattended-after-turns-b');

  // The defect sequence: a cold turn (`A`) in flight, a busy send (`B`) the CLI
  // folds into it, and only the ONE `result` that ends that turn — so `B`'s run
  // stays open and its round stays on the FIFO with nothing to close it.
  const uuidA = await armRound(arm, 'A cold');
  arm.process.emit(queuedFrame(uuidA));
  arm.process.emit(startedFrame(uuidA));
  arm.process.emit(initFrame('init-1'));
  arm.process.emit(assistantFrame());
  const uuidB = await armRound(arm, 'B busy send');
  arm.process.emit(queuedFrame(uuidB));
  arm.process.emit(resultFrame(null));
  arm.process.emit(completedFrame(uuidA));
  await settle();

  const residueRoundsOpen = arm.driver.busyInputReading(arm.sessionId)?.roundsOpen ?? -1;
  const residuePendingStart = arm.driver.ledgerReading(arm.sessionId)?.pendingStart.length ?? -1;

  arm.process.emit(initFrame('init-unattended'));
  await settle();
  const staleResidueUnattended = Boolean(arm.driver.unattendedReading(arm.sessionId)?.unattendedCommandUuid);
  arm.process.emit(assistantFrame());
  await settle();
  arm.process.emit(resultFrame('task-notification'));
  await settle();
  const staleResidueUnattendedNotifications = arm.notifications.length;

  console.log(
    `staleResidueUnattended=${staleResidueUnattended} ` +
      `staleResidueUnattendedNotifications=${staleResidueUnattendedNotifications} ` +
      `residueRoundsOpen=${residueRoundsOpen} residuePendingStart=${residuePendingStart}`,
  );

  assert.strictEqual(residueRoundsOpen, 1, 'the defect sequence must leave exactly one stale round behind');
  assert.strictEqual(
    residuePendingStart,
    0,
    'the stale round must not be a command the CLI started — the reading is the FIFO, not `pendingStart`',
  );
  assert.strictEqual(
    staleResidueUnattended,
    true,
    'a stale round must not mask the unattended turn the CLI announced after it',
  );
  assert.strictEqual(
    staleResidueUnattendedNotifications,
    1,
    'the unattended turn reached through the stale round must still report exactly once',
  );
});

// ---------------------------------------------------------------------------
// (c) the two counter-examples
// ---------------------------------------------------------------------------

test('AC381-c a waiting `started` makes the turn delivered, and a foreign one does not', async () => {
  const arm = buildArm('ac381-unattended-after-turns-c');

  // (c1) A pushed command whose `started` is waiting: the `init` binds it, so
  // the turn is delivered and no unattended run may be opened for it.
  const uuidA = await armRound(arm, 'A cold');
  arm.process.emit(queuedFrame(uuidA));
  arm.process.emit(startedFrame(uuidA));
  const openedBefore = arm.openedRuns();
  arm.process.emit(initFrame('init-1'));
  await settle();
  const deliveredLedger = arm.driver.ledgerReading(arm.sessionId);
  const deliveredTurn =
    deliveredLedger?.turn?.kind === 'delivered' && deliveredLedger.turn.ownerDeliveryId === uuidA;
  const unattendedRunsOpened = arm.openedRuns() - openedBefore;
  arm.process.emit(assistantFrame());
  arm.process.emit(resultFrame(null));
  arm.process.emit(completedFrame(uuidA));
  await settle();

  // (c2) The cron shape: a `started` under a uuid nothing here pushed. It is
  // `foreign` — it makes the turn unattended rather than delivered, and its
  // uuid is not a delivery, not a pushed uuid, and not exposed anywhere.
  const cronUuid = 'cli-cron-fired-command-uuid';
  arm.process.emit(startedFrame(cronUuid));
  await settle();
  arm.process.emit(initFrame('init-2'));
  await settle();
  const cronReading = arm.driver.unattendedReading(arm.sessionId);
  const cronLedger = arm.driver.ledgerReading(arm.sessionId);
  const cronUnattended = Boolean(cronReading?.unattendedCommandUuid);
  const cronIsForeign = (cronLedger?.foreign ?? []).includes(cronUuid);
  const cronIsDelivery = (cronLedger?.deliveries ?? []).some((delivery) => delivery.deliveryId === cronUuid);
  const cronIsPushed = (cronReading?.pushedUuids ?? []).includes(cronUuid);
  const foreignUuidInPublicReadings = cronIsDelivery || cronIsPushed;
  arm.process.emit(assistantFrame());
  arm.process.emit(resultFrame('peer'));
  await settle();

  console.log(
    `deliveredTurn=${deliveredTurn} unattendedRunsOpened=${unattendedRunsOpened} ` +
      `cronUnattended=${cronUnattended} cronIsForeign=${cronIsForeign} ` +
      `foreignUuidInPublicReadings=${foreignUuidInPublicReadings}`,
  );

  assert.strictEqual(deliveredTurn, true, 'an `init` with a waiting `started` must bind it as a delivered turn');
  assert.strictEqual(unattendedRunsOpened, 0, 'a delivered turn must not open an unattended run');
  assert.strictEqual(cronUnattended, true, 'a foreign `started` does not make the turn delivered');
  assert.strictEqual(cronIsForeign, true, 'the cron command must be recorded as foreign, not as a delivery');
  assert.strictEqual(foreignUuidInPublicReadings, false, 'a foreign uuid must not reach any exposed reading');
});
