/**
 * The shipped lifecycle-outcome handlers for `ClaudeResidentHostDriver`.
 *
 * Every body in this file was moved here from `claude-host-driver.provider.ts`
 * (the run/turn endings, reconcile reaction, held-work reconciler, `[ledger]`
 * writers and title mirror that used to be inlined in the class). The move is a
 * pure displacement: the expressions, the field reads, the writes and the
 * `null`/early-return arms are the originals, and the driver's methods are now
 * one-line delegations to them. The criterion
 * `tests/claude-resident-lifecycle-outcome-registry.test.ts` spot-checks the
 * simple outcomes against the old answers and compares each handler's `source`
 * with the driver's own path.
 *
 * Registration lives here rather than in the driver: {@link
 * createDefaultClaudeResidentLifecycleOutcomeRegistry} builds a fresh registry
 * and registers every handler below, so the shipped set is assembled by a file
 * beside the driver. The driver imports only the factory — it never names a
 * reaction body.
 *
 * Consumers: `claude-host-driver.provider.ts` (its constructor builds the
 * default registry from here) and the criterion above (which drives both the
 * shipped handlers and a probe registered from the test file).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reconcileSessionHeldWork } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { readTranscriptAiTitle } from '@/modules/providers/services/session-ai-title.service.js';
import {
  ledgerClosedTurns,
  ledgerDeliveries,
  ledgerTurn,
} from '@/modules/resident-ledger/index.js';
import type { AnyRecord, BackgroundWorkTrigger } from '@/shared/types.js';
import { createCompleteMessage } from '@/shared/utils.js';

import type {
  ClaudeResidentReconcileReading,
  ResidentHostState,
} from './claude-host-driver.provider.js';
import {
  ClaudeResidentLifecycleOutcomeRegistry,
  type ClaudeResidentLifecycleBackgroundTaskLease,
  type ClaudeResidentLifecycleCronLease,
  type ClaudeResidentLifecycleOutcomeContext,
  type ClaudeResidentLifecycleOutcomeHandler,
  type ClaudeResidentLifecycleRound,
  type ClaudeResidentLifecycleHeldWorkLease,
} from './claude-resident-lifecycle-outcome-registry.js';


/**
 * The file this handler set was defined in.
 *
 * Read off the module's own URL rather than spelled as a literal, so the
 * criterion can compare it with the driver's own source path without either
 * side hard-coding a checkout location.
 */
const HANDLERS_SOURCE = fileURLToPath(import.meta.url);


/**
 * Whether two held-work lists are the same report.
 *
 * The comparison is what keeps a reconciliation from being an event: a `Stop`
 * firing at the end of a quiet turn names the same jobs it named last time, and
 * reporting them again would move the binding's `lastActivityAt` and push the
 * idle deadline out on nothing. `inferred` is part of the comparison because a
 * job first guessed at from a tool call and then named by the CLI is a different
 * fact even when the id matches.
 */
function sameLeases(left: ClaudeResidentLifecycleHeldWorkLease[], right: ClaudeResidentLifecycleHeldWorkLease[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((lease, index) => {
    const other = right[index];
    if (!other || other.kind !== lease.kind) {
      return false;
    }
    if (lease.kind === 'cron' && other.kind === 'cron') {
      return (
        lease.id === other.id &&
        lease.recurring === other.recurring &&
        lease.expiresAt === other.expiresAt &&
        Boolean(lease.inferred) === Boolean(other.inferred)
      );
    }
    if (lease.kind !== 'cron' && other.kind !== 'cron') {
      return lease.id === other.id && Boolean(lease.inferred) === Boolean(other.inferred);
    }
    return false;
  });
}


/**
 * The `cron` reasons the CLI's own `session_crons` list asks for.
 *
 * `expiresAt` is preserved for an id the driver already holds: the CLI names no
 * instant, and the seven days a job lives are counted from its creation (E9's
 * receipt), so re-dating it on every firing would slide the deadline forward for
 * as long as the user kept talking. A job the list has stopped naming is simply
 * absent from the result, which is what makes "the list no longer names it" the
 * same event as "the reason went away".
 *
 * The entries carry no `inferred` flag: an id read off this list is the CLI's
 * own word for the job, and the absence of the flag is how that reads.
 */
function cronsFromStopList(
  list: unknown[],
  now: number,
  held: ClaudeResidentLifecycleCronLease[],
  cronMaxAgeMs: number,
): ClaudeResidentLifecycleCronLease[] {
  const heldById = new Map(held.map((lease) => [lease.id, lease]));
  return list.flatMap((entry): ClaudeResidentLifecycleCronLease[] => {
    const record = entry as AnyRecord | null;
    const id = typeof record?.id === 'string' ? record.id : '';
    if (!id) {
      return [];
    }
    return [
      {
        kind: 'cron',
        id,
        // `!== false` rather than `=== true`, the same reading the per-run
        // driver makes of `run_in_background`: what the CLI schedules is a
        // recurring job, and only an explicit denial says otherwise.
        recurring: record?.recurring !== false,
        expiresAt: heldById.get(id)?.expiresAt ?? now + cronMaxAgeMs,
      },
    ];
  });
}


/** The background-work reasons a CLI-held task list asks for, keyed by task id. */
function tasksFromStopList(list: unknown[]): ClaudeResidentLifecycleBackgroundTaskLease[] {
  return list.flatMap((entry): ClaudeResidentLifecycleBackgroundTaskLease[] => {
    const record = entry as AnyRecord | null;
    const id = typeof record?.id === 'string' ? record.id : '';
    return id ? [{ kind: 'background-task', id }] : [];
  });
}


/** The background-work reasons a `background_tasks_changed` payload asks for. */
function tasksFromChangedFrame(tasks: unknown[]): ClaudeResidentLifecycleBackgroundTaskLease[] {
  return tasks.flatMap((entry): ClaudeResidentLifecycleBackgroundTaskLease[] => {
    const record = entry as AnyRecord | null;
    const id = typeof record?.task_id === 'string' ? record.task_id : '';
    return id ? [{ kind: 'background-task', id }] : [];
  });
}


/** The `task_id` a `task_started` / `task_notification` frame is about. */
function taskIdOf(message: AnyRecord): string {
  return typeof message?.task_id === 'string' ? message.task_id : '';
}


/**
 * The transcript path the CLI files `providerSessionId` under, given the launch
 * working directory.
 *
 * The CLI names a project directory by replacing every character outside
 * `[a-zA-Z0-9-]` of the session's working directory with a hyphen, so
 * `/home/me/work` files under `-home-me-work`. That encoding is the CLI's own
 * (the fork path and the token-usage resolver both rely on it), which is why the
 * path is computed here rather than read back from a session row: a host holding
 * a live process has been writing for seconds, while the row's `jsonl_path` is
 * filled by a scan that may not have reached the file yet.
 */
function claudeProjectTranscriptPath(
  configDir: string,
  projectPath: string,
  providerSessionId: string,
): string {
  const encodedProjectDir = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
  return join(configDir, 'projects', encodedProjectDir, `${providerSessionId}.jsonl`);
}


/**
 * Takes one round out of the driver's FIFO, if it is still open.
 *
 * The three per-run endings (a withdrawn run, a run whose turn reached
 * `RESULT`, and a run that ends with no one left to tell) each settle the
 * round they close and then drop it here; {@link endLedger} sweeps whatever a
 * host teardown leaves behind. One copy of the `indexOf`/`splice` pair rather
 * than three, so the FIFO is only ever touched through the same guard.
 */
function dropRound(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { round: ClaudeResidentLifecycleRound },
): void {
  const { round } = payload;

  const index = state.rounds.indexOf(round);
  if (index >= 0) {
    state.rounds.splice(index, 1);
  }
}


/**
 * Ends the run a withdrawn message was armed as.
 *
 * A run exists per send the dispatcher asked for, and the dispatcher awaits
 * it: without this, a withdrawn message's run would stay open forever, because
 * the CLI never starts a message it cancelled and so never emits the
 * `system/init`/`result` pair the run would close on. Three things go wrong
 * while it sits open, and all three are the same bug seen from three sides:
 * the dispatcher's promise never settles, the next turn's `RESULT` closes the
 * wrong run (settling the withdrawal on a turn it never ran), and the open-run
 * projection is never empty — which is exactly the reading an unattended
 * turn's opener is refused by, so the process's own turn would be misread as a
 * queued one.
 *
 * The delivery's own terminal is the CLI's (already read: this is called only
 * after a `cancelled` was seen), so what happens here is the *run* half — the
 * terminal frame through the run's **own** writer, and the settlement. That
 * run was opened for this message and the message will now never run, so the
 * run is over and has to say so. `aborted` rather than a clean exit — the turn
 * did not run and was stopped by a person, which is what that flag means
 * everywhere else in this file. No round-end report is made: the caller of the
 * withdrawal is the person who asked for it and gets a verdict frame back, and
 * a "your run stopped" notification about their own withdrawal is noise about
 * a turn that never started.
 */
function endWithdrawnRun(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { deliveryId: string },
): void {
  const { deliveryId } = payload;

  const runtime = state.runtimes.get(deliveryId);
  if (!runtime) {
    // Either a run that was never a queue entry — a cold send's message is
    // the process's first work, not something the CLI can be asked to cancel
    // — or a run that already closed. Nothing to end: the CLI answered
    // `cancelled` for a uuid this host has no run waiting on. (The ledger makes
    // the same test before it emits this effect; this is the driver's own copy
    // of it, and it is the one that decides what gets written.)
    return;
  }

  runtime.round.writer.send(
    createCompleteMessage({
      provider: context.provider,
      sessionId: state.providerSessionId || runtime.round.appSessionId,
      exitCode: 0,
      aborted: true,
    }),
  );
  dropRound(context, state, { round: runtime.round });
  // Settles the dispatcher's await for this turn. `settled` also keeps a
  // `RESULT` that somehow arrives anyway from settling it a second time.
  runtime.round.settle();
}


/**
 * Converges the reported `cron` reasons onto one list.
 *
 * Remove-then-re-add rather than a diff, because the manager's removal verb is
 * by *kind* — a driver reports "the cron reason", not which cron — so a change
 * of any size is expressed the same way. {@link sameLeases} is what keeps an
 * unchanged list from being reported at all, which matters more than it looks:
 * the `Stop` hook fires at the end of every turn, and a rule that reported its
 * list unconditionally would move `lastActivityAt` and push the idle deadline
 * out once per turn, so a session the user keeps talking to would never go
 * idle and a session the CLI holds a cron for would never be observably held.
 */
function settleCrons(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { desired: ClaudeResidentLifecycleCronLease[] },
): void {
  const { desired } = payload;

  if (sameLeases(state.heldCrons, desired)) {
    return;
  }
  state.sink.leaseRemoved(state.appSessionId, 'cron');
  state.heldCrons = desired;
  for (const lease of desired) {
    state.sink.leaseAdded(state.appSessionId, lease);
  }
}


/** The same convergence for the background-work reasons, which carry no expiry. */
function settleBackgroundTasks(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { desired: ClaudeResidentLifecycleBackgroundTaskLease[] },
): void {
  const { desired } = payload;

  if (sameLeases(state.heldBackgroundTasks, desired)) {
    return;
  }
  state.sink.leaseRemoved(state.appSessionId, 'background-task');
  state.heldBackgroundTasks = desired;
  for (const lease of desired) {
    state.sink.leaseAdded(state.appSessionId, lease);
  }
}


/**
 * Reconciles one `Stop` hook firing into the binding's held-work reasons.
 *
 * A firing is authoritative only for the lists it actually carries: the hook
 * input has `session_crons` and `background_tasks` as separate keys, and one
 * absent key is the CLI saying nothing about that kind rather than saying it
 * holds none. That distinction is the whole reason the two `…Authoritative`
 * flags are separate — a build that reported `[]` for a list it never read
 * would drop a live cron's lease and let the host go idle under it.
 */
function reconcileHeldWork(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { input: AnyRecord },
): void {
  const { input } = payload;

  if (state.closed) {
    return;
  }

  const crons = input?.session_crons;
  if (Array.isArray(crons)) {
    state.cronsAuthoritative = true;
    settleCrons(context, state, {
      desired: cronsFromStopList(crons, context.now(), state.heldCrons, context.cronMaxAgeMs),
    });
  }

  const tasks = input?.background_tasks;
  if (Array.isArray(tasks)) {
    state.tasksAuthoritative = true;
    settleBackgroundTasks(context, state, { desired: tasksFromStopList(tasks) });
  }

  // The same firing feeds the activity dock's two read models (AC-194's wiring
  // leg), under the app session id the forwarder keys them by. Each list is
  // authoritative only when present, which the callee re-checks (`undefined`
  // is a no-op per kind) — the lease ledger and the read models must never
  // disagree about a list the CLI did not name.
  reconcileSessionHeldWork(state.appSessionId, {
    backgroundTasks: tasks,
    sessionCrons: crons,
  });
}


/**
 * Reads the two `system` frames that report background work, and counts the
 * subtypes it does not read.
 *
 * The stream's own account runs alongside the hook's because the two answer
 * different questions: the hook says what the process is still holding at the
 * end of a turn, while these frames say what it is doing in the middle of one
 * — a task that starts and finishes inside a single turn is never on any hook
 * list, and a host that only read the hook would look idle for the whole of
 * it. Neither list is gated on the other's authority: they converge on the
 * same ids, and the last one to speak at a turn's end is the hook's.
 */
function observeHeldWorkEvent(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { message: AnyRecord },
): void {
  const { message } = payload;

  switch (message.subtype) {
    case 'task_started': {
      const id = taskIdOf(message);
      if (id) {
        settleBackgroundTasks(context, state, {
          desired: [...state.heldBackgroundTasks, { kind: 'background-task', id }],
        });
      }
      return;
    }
    case 'task_notification': {
      const id = taskIdOf(message);
      if (id) {
        settleBackgroundTasks(context, state, {
          desired: state.heldBackgroundTasks.filter((lease) => lease.id !== id),
        });
      }
      return;
    }
    case 'background_tasks_changed': {
      if (Array.isArray(message.tasks)) {
        settleBackgroundTasks(context, state, { desired: tasksFromChangedFrame(message.tasks) });
      }
      return;
    }
    default:
      return;
  }
}


/**
 * The fallback for a CLI that never tells the host what it holds.
 *
 * `CronCreate` / `CronDelete` are the only stream-side evidence a cron exists,
 * and they are strictly worse evidence than the hook's list: the tool call says
 * a job was made, not that it is still there, and nothing in the stream names
 * the job's own id — the receipt's `7d58f90e` arrives on a `tool_result`, while
 * the block that made it carries only the SDK's `tool_use_id`. So the inferred
 * lease is keyed by that block id and flagged `inferred`, and it is only ever
 * consulted while no `session_crons` list has been seen: once the CLI has named
 * its jobs, a guess has nothing left to add.
 *
 * A `CronDelete` retracts the inferred reasons wholesale. It cannot be matched
 * to one of them — its `input.id` is the CLI's id for the job, which is exactly
 * the value an inferred lease never had — and while inference is live every
 * cron lease is inferred, so "the user cancelled a cron" and "the reason went
 * away" are the same event from this side.
 */
function inferHeldWork(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { message: AnyRecord },
): void {
  const { message } = payload;

  if (state.closed || state.cronsAuthoritative) {
    return;
  }

  const content = message?.message?.content;
  if (!Array.isArray(content)) {
    return;
  }

  for (const block of content) {
    if (block?.type !== 'tool_use') {
      continue;
    }
    if (block.name === 'CronCreate') {
      const id = typeof block.id === 'string' ? block.id : '';
      if (!id) {
        continue;
      }
      const input = block.input as AnyRecord | null | undefined;
      settleCrons(context, state, {
        desired: [
          ...state.heldCrons,
          {
            kind: 'cron',
            id,
            recurring: input?.recurring !== false,
            expiresAt: context.now() + context.cronMaxAgeMs,
            inferred: true,
          },
        ],
      });
    } else if (block.name === 'CronDelete') {
      settleCrons(context, state, { desired: [] });
    }
  }
}


/**
 * Runs §10.1's reconcile check for one session and answers what it read.
 *
 * THE READING IS TWO COUNTS THAT MUST AGREE: the run registry's "is a run
 * going" and this host's ledger. They answer different questions about
 * different clocks — the registry is told by the run's own opening and
 * closing, the ledger by what the CLI said — so a disagreement between them is
 * exactly the shape the `Working…` defect left behind: a run the registry
 * holds as `running` for a session whose ledger has stopped moving.
 *
 * The check runs at a `RESULT` (see {@link observe}) and on the host's own
 * beat (§10.1's "在 `RESULT` 之后与 heartbeat（既有 5 s 一拍）上检查 I1 / I4"):
 * {@link armReconcileBeat} arms it at `startHost` and every tick calls this
 * entry with the host's session. The beat is server-side and per-host rather
 * than the websocket module's per-socket activity heartbeat — the latter is
 * armed only for a subscribed browser, which is exactly the "somebody is
 * watching" condition §10.1 cannot depend on (a phantom run outlives its
 * client). A host without the beat armed (a non-positive
 * `reconcileBeatMs`, used only by a criterion) still gets the `RESULT` check.
 *
 * `T_q` ({@link ClaudeResidentHostDriverOptions.quiesceMs}) is the grace, and
 * an OPEN TURN is the guard — the two are not the same rule and the difference
 * is the whole of §10.1's warning. A ledger that has stood still is expected
 * between a turn's `RESULT` and the next work (the grace covers it), but a
 * ledger with a turn open is a turn that is RUNNING: `T_q` says nothing about
 * how long a turn takes, so a long turn's silence is not evidence of anything.
 * Removing the guard — the false form this stage is read against — closes real
 * turns, which is precisely the over-settlement §10.1 forbids ("不用 lease
 * 定时过期来「修」").
 *
 * `mode` decides what the check DOES about a divergence and nothing else:
 * `log` states it and changes no state (`enforce` is the arm that acts), which
 * is why the reading answers both `anomaly` and `closedRuns`.
 */
function reconcileTick(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { appSessionId: string },
): ClaudeResidentReconcileReading {
  const { appSessionId } = payload;

  const quiescentMs = context.now() - state.ledgerChangedAt;
  const turnOpen = ledgerTurn(state.turnLedger)?.open === true;
  const runningRuns = context.runRegistry.runningRuns().filter((run) => run.sessionId === appSessionId);
  const phantom =
    !turnOpen && quiescentMs > context.quiesceMs
      ? runningRuns.filter((run) => !state.reportedPhantomRuns.has(run.runId))
      : [];

  const closedRuns: string[] = [];
  for (const run of phantom) {
    // Marked before the line and before any close: the next beat re-reads the
    // same standing divergence, and §10.2's line is about the anomaly rather
    // than about how often the driver looked (see `reportedPhantomRuns`).
    state.reportedPhantomRuns.add(run.runId);
    writeReconcileLine(context, state, {
      anomaly: 'phantom-run',
      detail: `run ${run.runId} is still running after ${quiescentMs}ms with no open turn`,
    });
    if (context.reconcileMode === 'enforce') {
      context.runRegistry.closeRun({
        runId: run.runId,
        outcome: 'aborted',
        reason: context.reconciledReason,
      });
      closedRuns.push(run.runId);
    }
  }

  return {
    sessionId: appSessionId,
    mode: context.reconcileMode,
    quiescentMs,
    turnOpen,
    runningRuns: runningRuns.length,
    anomaly: phantom.length > 0 ? 'phantom-run' : null,
    closedRuns,
  };
}


/** How many deliveries the ledger has bound to one turn — §10.2's `deliveries=`. */
function boundDeliveryCount(state: ResidentHostState, turnId: string): number {
  return ledgerDeliveries(state.turnLedger).filter((delivery) => delivery.turnId === turnId).length;
}

/**
 * Writes one §10.2 `[ledger]` line per delivery whose state moved, and the
 * `[turn]` open/close line for a turn that opened or closed (SPEC §10.2).
 *
 * The reading is a DIFF against what the last line stated
 * ({@link ResidentHostState.loggedDeliveryStates}), so a projection re-read on
 * a frame that changed nothing writes nothing: the lines are about transitions,
 * and "one line per read" would be a log of how often the driver looked.
 *
 * `delivery=<8>` is the command uuid's prefix, as §10.2 spells it — the whole
 * uuid is in the ledger, and a line is meant to be correlatable with a frame's
 * `uuid`, not to be a second key.
 */
function emitLedgerLines(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
): void {
  const turn = ledgerTurn(state.turnLedger);
  if (turn !== null && turn.open && state.loggedOpenTurnId !== turn.id) {
    state.loggedOpenTurnId = turn.id;
    writeLogLine(context, state, {
      line:
        `[turn] session=${state.appSessionId} turn=${turn.id} kind=${turn.kind} open ` +
        `deliveries=${boundDeliveryCount(state, turn.id)}`,
    });
  } else if (turn !== null && !turn.open && state.loggedOpenTurnId === turn.id) {
    // The close line is written for the turn whose OPEN this host stated, and
    // the outcome is read from the ledger's own closed record rather than from
    // the frame that ended it — a `RUN-closed` record exists for every path.
    const closed = ledgerClosedTurns(state.turnLedger).at(-1) ?? null;
    state.loggedOpenTurnId = null;
    if (closed && closed.id === turn.id) {
      writeLogLine(context, state, {
        line:
          `[turn] session=${state.appSessionId} turn=${turn.id} kind=${turn.kind} close ` +
          `outcome=${closed.outcome} deliveries=${boundDeliveryCount(state, turn.id)}`,
      });
    }
  }

  for (const delivery of ledgerDeliveries(state.turnLedger)) {
    const stated = `${delivery.state}/${delivery.reason ?? '-'}`;
    if (state.loggedDeliveryStates.get(delivery.commandUuid) === stated) {
      continue;
    }
    state.loggedDeliveryStates.set(delivery.commandUuid, stated);
    writeLogLine(context, state, {
      line:
        `[ledger] session=${state.appSessionId} delivery=${delivery.commandUuid.slice(0, 8)} ` +
        `state=${delivery.state} turn=${delivery.turnId ?? '-'} source=${delivery.source}`,
    });
  }
}


/**
 * Hands one §10.2 line to the injected sink.
 *
 * The sink is the whole channel for the `[ledger]`/`[turn]` families: they are
 * per-turn traffic, so the default is nothing at all (see
 * {@link ClaudeResidentHostDriverOptions.logSink}).
 */
function writeLogLine(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { line: string },
): void {
  const { line } = payload;

  context.logSink(line);
}


/**
 * Writes the `[reconcile]` line for one anomaly, and mirrors it to the sink.
 *
 * §10.2's shape, and `session=` is in it for the reason the whole stage adds
 * it: the line has to be attributable to a conversation without cross-reading
 * the transcript. The line also goes to the sink — the criterion's channel —
 * while stdout stays its home, because that is where the operator reads an
 * anomaly and where the existing AC-380 criterion already reads this family.
 *
 * `anomaly` is taken as the code the site stated (`string`) rather than the
 * union: four of the five codes are the LEDGER's vocabulary
 * (`recordAnomaly`'s own argument), and re-declaring them here would be a
 * second list to keep in step.
 */
function writeReconcileLine(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { anomaly: string; detail: string },
): void {
  const { anomaly, detail } = payload;

  const line =
    `[reconcile] session=${state.appSessionId} mode=${context.reconcileMode} ` +
    `anomaly=${anomaly} detail=${detail}`;
  writeLogLine(context, state, { line });
  console.log(line);
}


/**
 * Reads the process's address out of the CLI's own registry and reports it.
 *
 * The app does not name the process, so there is no requested name to compare
 * a reading against — the address is simply whatever the CLI registered, read
 * back from `~/.claude/sessions/<pid>.json`. That is still a *checked* reading
 * rather than a prediction: the file is keyed by pid and carries the provider
 * `sessionId`, so a record that names another conversation is refused (see
 * `readCliSessionRegistration`), and an entry that never appears inside the
 * budget is reported as `null` rather than guessed at.
 *
 * Called once per host, at the first message that names the provider session —
 * the earliest point at which the process is far enough along to have written
 * its registry entry. It is the *startup* read rather than the whole story: a
 * launch handed no title settles on the CLI's derived name here, and the title
 * mirror moves that name later in the same turn, so
 * {@link refreshIdentityAfterRename} reads it back again once the frame is out.
 * The poll is bounded and unref'd: the entry is written at startup, so a
 * process that has not produced it within the budget has not registered an
 * address, and a driver must not hold the event loop open waiting for one that
 * is not coming.
 */
function startIdentityReadback(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { sessionId: string },
): void {
  const { sessionId } = payload;

  if (state.identityReadbackStarted) {
    return;
  }
  state.identityReadbackStarted = true;

  const pid = state.pid;
  if (pid === null) {
    // No pid was observed, so the registry cannot be addressed at all:
    // reporting `null` is a statement — "this binding has no address" — rather
    // than the absence a binding that was never asked about would show.
    publishIdentity(context, state, { value: null });
    return;
  }

  const deadline = Date.now() + context.identityBudgetMs;
  const poll = (): void => {
    if (state.closed) {
      return;
    }
    const registration = context.readCliSessionRegistration(state.configDir, pid, sessionId);
    // A launch that handed the session's own title over is registered twice:
    // the entry appears under the CLI's derived name as the process starts and
    // is rewritten when the title is adopted, which is later in the same turn.
    // Reporting that first sighting would publish an address the process stops
    // answering to a moment later, so on such a launch a `derived` reading is
    // read as "not settled yet" and the poll keeps going. A launch that handed
    // nothing over is left exactly as it was — there a derived name *is* the
    // settled answer, and waiting on one would stall every first boot.
    const settled = Boolean(registration?.name) && !(state.launchedTitle && registration?.nameSource === 'derived');
    if (!settled) {
      if (Date.now() >= deadline) {
        publishIdentity(context, state, { value: null });
        return;
      }
      const timer = setTimeout(poll, context.identityPollMs);
      timer.unref?.();
      return;
    }
    publishIdentity(context, state, { value: registration?.name ?? null });
  };

  poll();
}


/**
 * Publishes an address reading to the manager, and only when it moved.
 *
 * `recordIdentity` is the projection's only writer (see
 * `session-host-manager.service.ts`), and it treats "the process stated its
 * name" as a fact worth recording. The address is read more than once over a
 * host's life, so the same value can be offered twice — the startup read's
 * answer, then a re-read's — and a value that did not move is not news. `null`
 * is publishable when it differs (a host with no address at all), so a bounded
 * read that finds nothing settles the binding to "no address" rather than
 * leaving a stale one; but it can never *blank* an address a previous read
 * established, because a re-read that times out publishes nothing.
 */
function publishIdentity(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { value: string | null },
): void {
  const { value } = payload;

  if (state.reportedIdentity === value) {
    return;
  }
  state.reportedIdentity = value;
  state.sink.identity(state.appSessionId, value);
}


/**
 * Re-reads the process's registered address after the title mirror moved it.
 *
 * A cold-start launch registers under the CLI's derived name and settles there
 * (see {@link startIdentityReadback}), and the `rename_session` frame that
 * {@link mirrorResidentTitle} writes is the one event that moves it: the CLI
 * rewrites `~/.claude/sessions/<pid>.json` when it adopts the title. Without a
 * read here the projection keeps the startup snapshot for the process's whole
 * life, so every peer is handed the machine-shaped name long after the registry
 * stopped answering to it — the stale-address defect this pass exists for.
 *
 * The re-read is a bounded poll, not a watcher, and it is *armed by the frame*
 * rather than run for the life of the host. The registry rewrite is
 * asynchronous — the frame's bytes are out before the CLI has processed them —
 * so a single read would race it, and the window is the startup read's own
 * shape (50 ms interval, one budget) because it is the same kind of wait: the
 * entry is coming, or it is not. A watcher would instead pay a read per turn
 * forever for an event that happens at most once per process.
 *
 * The value published is the registry's, never the title the frame carried:
 * the criterion that guards this reads the file for itself, and "we sent this
 * string" is a prediction, not a reading. `derived` is still read as "not yet"
 * — the adoption has not landed — so a frame the CLI never processed leaves the
 * last honest reading in place instead of publishing a value nobody registered.
 */
function refreshIdentityAfterRename(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
): void {
  const pid = state.pid;
  const sessionId = state.providerSessionId;
  if (state.closed || pid === null) {
    return;
  }

  const deadline = Date.now() + context.identityBudgetMs;
  const poll = (): void => {
    if (state.closed) {
      return;
    }
    const registration = context.readCliSessionRegistration(state.configDir, pid, sessionId);
    // The CLI adopts the mirrored title as a name it did not derive itself
    // (`nameSource: "user"`), which is what "the rewrite landed" reads as. The
    // derived name it may still be showing is the pre-frame value, not the
    // answer; leaving it unpublished keeps `publishIdentity`'s dedup from even
    // considering it.
    const adopted = Boolean(registration?.name) && registration?.nameSource !== 'derived';
    if (adopted) {
      publishIdentity(context, state, { value: registration?.name ?? null });
      return;
    }
    if (Date.now() >= deadline) {
      return;
    }
    const timer = setTimeout(poll, context.identityPollMs);
    timer.unref?.();
  };

  poll();
}


/**
 * Cancels a settle window in flight.
 *
 * Called wherever the host stops being live — a close, a process exit — so the
 * poll cannot fire against a state whose process is gone. The mirror value
 * already written is left alone: it is a fact about what was sent, not about
 * whether more will be.
 */
function stopTitleMirror(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
): void {
  if (state.titleMirror.timer) {
    clearTimeout(state.titleMirror.timer);
    state.titleMirror.timer = null;
  }
  state.titleMirror.open = false;
}


/**
 * Opens a settle window that mirrors this session's generated title into the
 * process's registered name, once the title has stopped moving.
 *
 * The address this fixes is the one `ListAgents` and `SendMessage` use:
 * `~/.claude/sessions/<pid>.json`'s `name`, which the CLI derives from the
 * working directory plus two random characters and keeps for the process's
 * whole life. A resident process is launched with no title when the session has
 * none yet — deliberately, because a title handed over at creation suppresses
 * the CLI's own generation — so the readable title the session earns a moment
 * later never reaches the registry, and every peer keeps addressing it by the
 * machine-shaped name. The `rename_session` control frame is the one verb that
 * moves it without restarting the process (the SDK's `Query` has no method for
 * it; see {@link ClaudeResidentProcess.writeRaw}).
 *
 * Three rules, each one an invariant rather than a preference:
 *
 * - **Never before the title exists.** The frame is built only from a value
 *   read out of the transcript's own `ai-title` entries, so a title that has
 *   not been written cannot be sent. This is not politeness: a rename sent
 *   before generation makes the CLI skip generating a title at all (measured:
 *   the pre-renamed arm's transcript carries `custom-title` rows and zero
 *   `ai-title` rows), so an early frame would destroy the very title it was
 *   trying to mirror.
 * - **Mirror, never invent.** The string is the transcript's `ai-title`
 *   verbatim — no ladder rung, no display name, no placeholder. A transcript
 *   with no generated title leaves this silent rather than naming the process
 *   after its first prompt.
 * - **Once.** `titleMirror.mirrored` latches on the first frame, so the CLI
 *   appending the same title on later rounds does not write a second one.
 *
 * A process launched *with* a title is skipped outright: the CLI adopted that
 * title at startup (`nameSource: "auto"`), so there is nothing derived to
 * correct, and re-mirroring would be this driver naming a process a human or
 * the launch had already named.
 *
 * Called from every stream message, but a window is opened *once per turn* —
 * at the turn's first message, and not again until the next turn's `result`
 * clears the per-turn latch. That cadence is the old one (a window every turn)
 * with the opening moved off the `result` and onto the stream, where the title
 * it is waiting for actually lands: measured on a live session, the CLI writes
 * its `ai-title` row early in the first turn — before the first assistant
 * message — so a window that waited for the `result` left the sidebar's
 * readable name and the address peers dial apart for the whole first turn
 * (362 s on the session that filed this). Opening at the turn's first message
 * costs the same reads as opening at its `result` (one bounded window per turn)
 * and moves the address as soon as the title has settled.
 *
 * A window that finds nothing spends itself rather than polling for the life of
 * the host, and a message that arrives while one is open does not restart it —
 * otherwise a busy turn would buy a read per message instead of one poll per
 * interval.
 */
function scheduleTitleMirror(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
): void {
  if (state.closed || state.launchedTitle !== null || state.titleMirror.mirrored !== null) {
    return;
  }
  if (state.titleMirror.open || state.titleMirror.openedForTurn) {
    return;
  }
  state.titleMirror.open = true;
  state.titleMirror.openedForTurn = true;

  const deadline = Date.now() + context.titleMirrorWindowMs;
  const poll = (): void => {
    state.titleMirror.timer = null;
    if (state.closed || state.titleMirror.mirrored !== null) {
      state.titleMirror.open = false;
      return;
    }
    void readSettledTitle(state).then((title) => {
      if (state.closed || state.titleMirror.mirrored !== null) {
        state.titleMirror.open = false;
        return;
      }
      if (title !== null && title === state.titleMirror.lastSeen) {
        mirrorResidentTitle(context, state, { title });
        state.titleMirror.open = false;
        return;
      }
      // A null read is "no generated title in the transcript", not a value to
      // remember: the title already seen stays the one a later equal read has
      // to match, so a round that happened not to write one cannot reset the
      // settle test.
      if (title !== null) {
        state.titleMirror.lastSeen = title;
      }
      if (Date.now() < deadline) {
        const timer = setTimeout(poll, context.titleMirrorPollMs);
        timer.unref?.();
        state.titleMirror.timer = timer;
      } else {
        // The window is spent. `open` goes false so a later turn can open a
        // fresh one; `openedForTurn` stays set, so the rest of *this* turn does
        // not re-poll for a title it already spent a full window on.
        state.titleMirror.open = false;
      }
    });
  };

  poll();
}


/**
 * Reads the newest `ai-title` this process's transcript holds, or null.
 *
 * The transcript is located from the two facts the host already carries — the
 * config directory the child was launched under and its working directory —
 * plus the provider session id the stream named. A host that has not yet seen
 * a session id, or was launched with no working directory, has no transcript to
 * read and answers null.
 */
async function readSettledTitle(state: ResidentHostState): Promise<string | null> {
  const providerSessionId = state.providerSessionId;
  if (!providerSessionId || !state.projectPath) {
    return null;
  }
  const transcriptPath = claudeProjectTranscriptPath(state.configDir, state.projectPath, providerSessionId);
  return readTranscriptAiTitle(transcriptPath, providerSessionId);
}


/**
 * Writes the `rename_session` control frame that moves the process's registered
 * name onto `title`, and latches the mirror so it is written once.
 *
 * The frame is recorded before the write, like every other control frame this
 * host sends, so a criterion reading what the driver wrote holds the bytes even
 * if the process dies mid-write. A process with no raw-write seam (a scripted
 * stream, a substituted factory) simply does not mirror: the reading is "this
 * host wrote nothing", which is true, rather than a claim about a frame that
 * never left.
 *
 * The frame is what moves the registered name, so the same write arms the
 * *re-read* of it: the projection this frame exists to correct is refreshed
 * from the registry once the CLI has processed the frame (see
 * {@link refreshIdentityAfterRename}). Arming it here rather than on a timer
 * keeps the two in one place — a path that writes the rename is a path that
 * owes the projection a re-read.
 */
function mirrorResidentTitle(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { title: string },
): void {
  const { title } = payload;

  const writeRaw = state.process.writeRaw;
  if (typeof writeRaw !== 'function') {
    return;
  }
  const requestId = randomUUID();
  const frame: AnyRecord = {
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'rename_session',
      title,
      // `host` is the source the CLI lands as `user`; `auto` is its internal
      // lane for titles it adopted itself and is not reachable from here.
      source: 'host',
      session_id: state.providerSessionId,
    },
  };
  state.controlFrames.push({ at: Date.now(), requestId, frame });
  writeRaw.call(state.process, frame);
  state.titleMirror.mirrored = title;
  refreshIdentityAfterRename(context, state);
}


/**
 * Ends the unattended turn a `result` closed: its terminal frame, then the
 * report that says what the turn was for.
 *
 * The frame comes first for the same reason a round's does — it is what flips
 * the run to completed in the registry, and a notification about a run that
 * has ended should not be able to arrive before the ending it describes. No
 * lease is touched: an unattended turn never held one, because nothing asked
 * the manager for it.
 *
 * The trigger is the one reading that cannot be taken at the opener. A turn
 * opened by a peer session leaves nothing in the process's own task list, so
 * the `Stop` hook's account of what it holds reads as an unexplained turn; a
 * turn the host layer itself opened to report a background task back leaves
 * nothing there either, for the same reason. Both are stated only on the
 * turn's `result`, as the message's origin, which is the turn's *end*. So the
 * hook's reading is kept as the answer for every other reason and is
 * overridden here — at the `result` — exactly when the CLI states one of the
 * two origins it can state: `peer` for a cross-session message, and
 * `task-notification` for the host layer's own turn reporting back (the CLI's
 * name for the shared vocabulary's `background-task`, the same mapping
 * `readClaudeNotificationOrigin` makes for the transcript row).
 */
function finishUnattendedTurn(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { sessionId: string | null; result: AnyRecord },
): void {
  const { sessionId, result } = payload;

  const unattended = state.unattended;
  if (!unattended) {
    return;
  }
  state.unattended = null;
  unattended.writer.send(
    createCompleteMessage({
      provider: 'claude',
      sessionId: sessionId || state.appSessionId,
      exitCode: 0,
      aborted: false,
    }),
  );
  const origin = (result?.origin ?? null) as AnyRecord | null;
  const statedTrigger: BackgroundWorkTrigger | null =
    origin?.kind === 'peer'
      ? 'cross-session-message'
      : origin?.kind === 'task-notification'
        ? 'background-task'
        : null;
  context.notifyUnattendedWork({
    appSessionId: state.appSessionId,
    provider: 'claude',
    userId: state.lastUserId,
    sessionId: state.appSessionId,
    sessionName: state.lastSessionName,
    trigger: statedTrigger ?? unattended.trigger,
  });
}


/**
 * Drops an unattended run whose turn will never end.
 *
 * The process is gone (or the manager closed the host), so no `result` is
 * coming and the run would otherwise stay open for its session forever. The
 * frame is terminal and says `aborted` rather than claiming an exit the turn
 * never had, and no report is made — the notification is about background work
 * that *completed*, and a turn that never finished is not that.
 */
function abandonUnattendedTurn(
  context: ClaudeResidentLifecycleOutcomeContext,
  state: ResidentHostState,
  payload: { exitCode: number },
): void {
  const { exitCode } = payload;

  const unattended = state.unattended;
  if (!unattended) {
    return;
  }
  state.unattended = null;
  unattended.writer.send(
    createCompleteMessage({
      provider: 'claude',
      sessionId: state.providerSessionId || state.appSessionId,
      exitCode,
      aborted: true,
    }),
  );
}


/**
 * Every shipped lifecycle-outcome handler, keyed by the kind it answers.
 *
 * Exported as data (rather than only through the factory) so the criterion can
 * enumerate the shipped set and assert each handler's `source` is this file —
 * the registration is a list a reader can see, not a side effect hidden in an
 * import.
 */
export const CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS: readonly ClaudeResidentLifecycleOutcomeHandler[] = [
  {
    name: 'dropRound',
    label: 'claude-resident.lifecycle.drop-round',
    source: HANDLERS_SOURCE,
    handle: dropRound,
  },
  {
    name: 'endWithdrawnRun',
    label: 'claude-resident.lifecycle.end-withdrawn-run',
    source: HANDLERS_SOURCE,
    handle: endWithdrawnRun,
  },
  {
    name: 'settleCrons',
    label: 'claude-resident.lifecycle.settle-crons',
    source: HANDLERS_SOURCE,
    handle: settleCrons,
  },
  {
    name: 'settleBackgroundTasks',
    label: 'claude-resident.lifecycle.settle-background-tasks',
    source: HANDLERS_SOURCE,
    handle: settleBackgroundTasks,
  },
  {
    name: 'reconcileHeldWork',
    label: 'claude-resident.lifecycle.reconcile-held-work',
    source: HANDLERS_SOURCE,
    handle: reconcileHeldWork,
  },
  {
    name: 'observeHeldWorkEvent',
    label: 'claude-resident.lifecycle.observe-held-work-event',
    source: HANDLERS_SOURCE,
    handle: observeHeldWorkEvent,
  },
  {
    name: 'inferHeldWork',
    label: 'claude-resident.lifecycle.infer-held-work',
    source: HANDLERS_SOURCE,
    handle: inferHeldWork,
  },
  {
    name: 'reconcileTick',
    label: 'claude-resident.lifecycle.reconcile-tick',
    source: HANDLERS_SOURCE,
    handle: reconcileTick,
  },
  {
    name: 'emitLedgerLines',
    label: 'claude-resident.lifecycle.emit-ledger-lines',
    source: HANDLERS_SOURCE,
    handle: emitLedgerLines,
  },
  {
    name: 'writeLogLine',
    label: 'claude-resident.lifecycle.write-log-line',
    source: HANDLERS_SOURCE,
    handle: writeLogLine,
  },
  {
    name: 'writeReconcileLine',
    label: 'claude-resident.lifecycle.write-reconcile-line',
    source: HANDLERS_SOURCE,
    handle: writeReconcileLine,
  },
  {
    name: 'startIdentityReadback',
    label: 'claude-resident.lifecycle.start-identity-readback',
    source: HANDLERS_SOURCE,
    handle: startIdentityReadback,
  },
  {
    name: 'publishIdentity',
    label: 'claude-resident.lifecycle.publish-identity',
    source: HANDLERS_SOURCE,
    handle: publishIdentity,
  },
  {
    name: 'refreshIdentityAfterRename',
    label: 'claude-resident.lifecycle.refresh-identity-after-rename',
    source: HANDLERS_SOURCE,
    handle: refreshIdentityAfterRename,
  },
  {
    name: 'stopTitleMirror',
    label: 'claude-resident.lifecycle.stop-title-mirror',
    source: HANDLERS_SOURCE,
    handle: stopTitleMirror,
  },
  {
    name: 'scheduleTitleMirror',
    label: 'claude-resident.lifecycle.schedule-title-mirror',
    source: HANDLERS_SOURCE,
    handle: scheduleTitleMirror,
  },
  {
    name: 'mirrorResidentTitle',
    label: 'claude-resident.lifecycle.mirror-resident-title',
    source: HANDLERS_SOURCE,
    handle: mirrorResidentTitle,
  },
  {
    name: 'finishUnattendedTurn',
    label: 'claude-resident.lifecycle.finish-unattended-turn',
    source: HANDLERS_SOURCE,
    handle: finishUnattendedTurn,
  },
  {
    name: 'abandonUnattendedTurn',
    label: 'claude-resident.lifecycle.abandon-unattended-turn',
    source: HANDLERS_SOURCE,
    handle: abandonUnattendedTurn,
  },
];

/**
 * Builds the registry the driver ships with.
 *
 * A fresh registry per driver (not a module-level singleton): a criterion's
 * probe registration must not leak into another driver, and the shipped set is
 * re-registered from {@link CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS} so the
 * default dispatch path is exactly this file's list.
 */
export function createDefaultClaudeResidentLifecycleOutcomeRegistry(): ClaudeResidentLifecycleOutcomeRegistry {
  const registry = new ClaudeResidentLifecycleOutcomeRegistry();
  for (const handler of CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS) {
    registry.register(handler);
  }
  return registry;
}
