/**
 * The readings layer: per-session answers projected from host state.
 *
 * Extracted from `claude-host-driver.provider.ts` into the `lifecycle/` sink.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

import { notifyUserIfEnabled } from '@/modules/notifications/index.js';
import { readSessionAwaitingReplyPort } from '@/shared/ports/session-awaiting-reply.port.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  BackgroundWorkTrigger,
  ChatRunSource,
  ClaudeResidentDeliveryReason,
  ClaudeResidentDeliveryState,
  CommandLifecycleEvent,
  CommandLifecycleState,
  DeliveryEntry,
  DeliveryEntryReason,
  HostCloseReason,
  HostInputPriority,
  HostLease,
  HostPendingQueuedInputs,
  HostQueuedInputCancelResult,
  HostResidentLaunch,
  HostResidentStartResult,
  HostTurnInput,
  LLMProvider,
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  RemoteControlIsolation,
  ResidentDeliveryLookup,
  ResidentLedger,
  ResidentLedgerAnomaly,
  ResidentLedgerClosedTurn,
  ResidentLedgerDelivery,
  ResidentLedgerTurn,
  SessionBinding,
} from '@/shared/types.js';
import { DELIVERY_SOURCE_OPTION, DELIVERY_TEXT_MAX_CHARS, isTerminalDeliveryState } from '@/shared/types.js';
import type {
  ResidentLedgerEffect,
  ResidentLedgerEvent,
} from '@/modules/resident-ledger/index.js';
import {
  applyLedgerEvent,
  createResidentLedger,
  ledgerClosedTurns,
  ledgerDeliveries,
  ledgerDeliveryByUuid,
  ledgerPendingStart,
  ledgerTurn,
} from '@/modules/resident-ledger/index.js';
import {
  ClaudeSessionOccupiedError,
  createCompleteMessage,
  createNormalizedMessage,
  findBackgroundSessionOwner,
  residentRunIsTurn,
} from '@/shared/utils.js';
import { readVoiceRulesPort } from '@/shared/ports/voice-rules.port.js';

import { ClaudeResidentHostStateBase } from './resident-host.base.js';
import {
  CLAUDE_CANCEL_VERDICT_POLL_MS,
  CLAUDE_CANCEL_VERDICT_WAIT_MS,
  ClaudePermissionAnswer,
  ClaudePermissionDecision,
  ClaudePermissionEntry,
  ClaudePermissionScope,
  ClaudeResidentPermissions,
  buildNotificationEvent
} from './resident-process.types.js';
import {
  deriveBackgroundWorkTrigger
} from './resident-turn.types.js';
import {
  ResidentRound
} from './resident-ledger-runtime.js';
import {
  ResidentHostState
} from './resident-host.types.js';
export abstract class ClaudeResidentReadingsBase extends ClaudeResidentHostStateBase {
  /**
   * Binds a delivered turn to its run, through the host layer (run=turn only).
   *
   * Called at the two moments the ledger learns a delivery belongs to a turn —
   * the `init` that opens it (`openTurnAtInit`) and a `started` that folds a
   * command into a turn already open (`applyLifecycle`) — because the run's
   * delivery set and the writer its frames belong on are the same answer, and the
   * registry is the only place that can give it: the run registry lives across an
   * import edge this file may not cross, so the call goes through the manager's
   * turn seam the composition root has filled.
   *
   * `null` (no seam installed, or nothing to adopt and nothing to open) leaves the
   * state alone: frames then fall back to the round's writer, which is the
   * behaviour this mode had before the seam existed.
   */
  protected bindTurnRun(
    state: ResidentHostState,
    turn: ResidentLedgerTurn | null,
    deliveryIds?: string[],
  ): void {
    if (!residentRunIsTurn() || !turn) {
      return;
    }
    // An unattended turn's run is opened by the OTHER seam
    // (`openUnattendedTurnIfOwn`, with `kind: 'unattended'`): binding it here as a
    // delivered turn would mint a second run for a turn no delivery belongs to,
    // and the turn's frames would follow the wrong one. The ledger decides this
    // (`kind`), because the ledger is where "did anything of ours open this turn"
    // is answered (I5).
    if (turn.kind !== 'delivered') {
      return;
    }
    const ids =
      deliveryIds
      ?? ledgerDeliveries(state.turnLedger)
        .filter((delivery) => delivery.turnId === turn.id)
        .map((delivery) => delivery.commandUuid);
    const handle = this.host.openTurn({
      provider: this.provider,
      appSessionId: state.appSessionId,
      providerSessionId: state.providerSessionId,
      userId: state.lastUserId,
      sessionName: state.lastSessionName,
      kind: 'delivered',
      deliveryIds: ids,
    });
    if (!handle) {
      return;
    }
    state.turnRun = { runId: handle.runId, writer: handle.writer, startedAt: this.now() };
    // Every delivery of this turn keeps its terminal frame on this run's writer,
    // however the delivery was dispatched: the writer is driver-side bookkeeping
    // and lives with the rest of it, indexed by `commandUuid`.
    for (const delivery of ledgerDeliveries(state.turnLedger)) {
      if (delivery.turnId !== turn.id) {
        continue;
      }
      const runtime = state.runtimes.get(delivery.commandUuid);
      if (runtime) {
        runtime.turnWriter = handle.writer;
      }
    }
    // The run the delivery's turn is executing as, kept on the delivery so a
    // by-id read can still name it once the turn (and `state.turnRun`) is gone.
    // Applied directly rather than through `applyLedger`: this runs inside an
    // effect of a transition that is already running, and the tail that call
    // would run is the one the outer transition runs a moment from now.
    applyLedgerEvent(state.turnLedger, { kind: 'run-bound', turnId: turn.id, runId: handle.runId });
  }

  /**
   * Opens a run for a turn the process started by itself, at the moment that
   * turn announces itself.
   *
   * The reading is structural and has to be: a turn nobody pushed sends no
   * request, so there is nothing to correlate a run with. What the CLI does say
   * is that a conversation turn is beginning (`system/init`) at a moment when
   * **nothing this host pushed is waiting to be bound to it** and under a uuid
   * this host never pushed. The first half is the ledger's `pendingStart` — the
   * command uuids the CLI's own `started` named while no turn was open (C-2),
   * which is exactly I5's "no `started` waiting to be bound" — and it is the
   * ledger that answers it rather than a count of rounds in flight. That
   * distinction is the whole criterion: a merged turn leaves stale bookkeeping
   * on the FIFO, and reading `state.rounds.length` let one stale round mask
   * every later unattended turn — a background task's follow-up, a cron firing,
   * a peer message — so nothing reported that the work had finished.
   *
   * A command the CLI started under a uuid nothing here pushed (a cron firing,
   * E9 §9.4) is `foreign`, not a delivery waiting for a turn, so it never makes
   * the turn delivered; its uuid stays out of everything this host exposes.
   *
   * Never throws and never reports. An unattended turn that cannot be opened is
   * not a failure: the run registry may already hold a run for the session, and
   * in that case the frames stay with the last writer, which is what this mode
   * did before it could open runs at all.
   */
  protected openUnattendedTurnIfOwn(
    state: ResidentHostState,
    message: AnyRecord,
    sessionId: string | null,
    commandsWaitingForTurn: number,
  ): void {
    if (state.closed || state.unattended) {
      return;
    }
    if (message?.type !== 'system' || message.subtype !== 'init') {
      return;
    }
    // I5, read off the ledger rather than off the round FIFO. A command of ours
    // whose `started` the CLI stated while no turn was open is waiting for this
    // turn and makes it a delivered one; with nothing waiting, the turn is the
    // process's own. The count is passed in rather than read here because
    // `openTurn` has already bound — and so emptied — that waiting list by the
    // time this runs.
    if (commandsWaitingForTurn > 0) {
      return;
    }
    const commandUuid = typeof message.uuid === 'string' ? message.uuid : null;
    if (!commandUuid || state.pushedUuids.has(commandUuid)) {
      return;
    }

    // Run=turn states the same request through the generalized seam: the run
    // belongs to the TURN, so it is opened as an `unattended` turn's run rather
    // than as "a run nobody dispatched" — an unattended turn binds no delivery,
    // which is the fact the S2 criterion reads back as `deliveryIds` empty. With
    // the flag off the older, writer-shaped seam answers exactly as before.
    const handle = residentRunIsTurn()
      ? this.host.openTurn({
          provider: this.provider,
          appSessionId: state.appSessionId,
          providerSessionId: sessionId,
          userId: state.lastUserId,
          sessionName: state.lastSessionName,
          kind: 'unattended',
        })
      : this.host.openUnattendedRun({
          provider: this.provider,
          appSessionId: state.appSessionId,
          providerSessionId: sessionId,
          userId: state.lastUserId,
          sessionName: state.lastSessionName,
        });
    if (!handle) {
      return;
    }

    // Read at the opener and not at the end: the hook fires at every turn's
    // end, so by the time this turn's own `result` arrives the newest reading
    // is the empty list the turn itself left behind.
    const trigger = deriveBackgroundWorkTrigger(state.ledger.latest());
    state.unattended = { commandUuid, trigger, writer: handle.writer };
    state.lastUnattendedCommandUuid = commandUuid;
    if (sessionId) {
      handle.writer.setSessionId?.(sessionId);
    }
  }

  /** Thin delegation to the shipped `startIdentityReadback` handler; see `claude-resident-lifecycle-outcome-handlers.ts`. */
  protected startIdentityReadback(state: ResidentHostState, sessionId: string): void {
    this.dispatchLifecycle('startIdentityReadback', state, { sessionId });
  }

  /** Thin delegation to the shipped `publishIdentity` handler; see `claude-resident-lifecycle-outcome-handlers.ts`. */
  protected publishIdentity(state: ResidentHostState, value: string | null): void {
    this.dispatchLifecycle('publishIdentity', state, { value });
  }

  /** Thin delegation to the shipped `refreshIdentityAfterRename` handler; see `claude-resident-lifecycle-outcome-handlers.ts`. */
  protected refreshIdentityAfterRename(state: ResidentHostState): void {
    this.dispatchLifecycle('refreshIdentityAfterRename', state, undefined);
  }

  /** Thin delegation to the shipped `stopTitleMirror` handler; see `claude-resident-lifecycle-outcome-handlers.ts`. */
  protected stopTitleMirror(state: ResidentHostState): void {
    this.dispatchLifecycle('stopTitleMirror', state, undefined);
  }

  /** Thin delegation to the shipped `scheduleTitleMirror` handler; see `claude-resident-lifecycle-outcome-handlers.ts`. */
  protected scheduleTitleMirror(state: ResidentHostState): void {
    this.dispatchLifecycle('scheduleTitleMirror', state, undefined);
  }

  /** Thin delegation to the shipped `mirrorResidentTitle` handler; see `claude-resident-lifecycle-outcome-handlers.ts`. */
  protected mirrorResidentTitle(state: ResidentHostState, title: string): void {
    this.dispatchLifecycle('mirrorResidentTitle', state, { title });
  }

  /** Thin delegation to the shipped `finishUnattendedTurn` handler; see `claude-resident-lifecycle-outcome-handlers.ts`. */
  protected finishUnattendedTurn(state: ResidentHostState, sessionId: string | null, result: AnyRecord): void {
    this.dispatchLifecycle('finishUnattendedTurn', state, { sessionId, result });
  }

  /** The live resident state for a session, or null when it has no process. */
  protected liveStateFor(appSessionId: string): ResidentHostState | null {
    return this.dispatchReading<ResidentHostState | null>('liveState', appSessionId);
  }

  /**
   * The host state for a session whose ledger is still worth reading.
   *
   * The same lookup as {@link liveStateFor} with one difference, and it is the
   * difference between "what is this host doing" and "what did this host have
   * open when it stopped": a host that has ended — its stream finished under it,
   * or the manager closed it — keeps its ledger readable. Everything else this
   * driver reports is about a process it is still holding, which is why the live
   * readings refuse a closed host; the ledger is frozen at that point instead,
   * and it is the answer to "did anything stay open when it died?".
   *
   * The body is the `ledgerState` handler beside this file; the reading method
   * that used it ({@link ClaudeResidentHostDriver.ledgerReading}) now delegates to
   * that same handler directly.
   */
  protected ledgerStateFor(appSessionId: string): ResidentHostState | null {
    return this.dispatchReading<ResidentHostState | null>('ledgerState', appSessionId);
  }

  /**
   * Builds the three entries one resident process is launched with.
   *
   * One builder for the three because they are one policy — the same
   * attendance test, the same notification, the same decision log — and only the
   * *answer shape* differs: `canUseTool` speaks the SDK's `PermissionResult`,
   * `onElicitation` speaks `ElicitResult`, and `onUserDialog` speaks the dialog
   * result union. Those shapes are the SDK's own (`sdk.d.ts`) and are produced
   * here, in the one place that knows what the client's answer was.
   *
   * The per-run path's non-interactive branch is deliberately *not* mirrored. It
   * has an allow/deny list to consult before asking; a resident host launches
   * under `bypassPermissions` (where the CLI never refers a non-interactive tool
   * to a callback at all) and only reaches this branch after an explicit live
   * switch to a mode that means "ask me". Asking, there, is what the mode means.
   */
  protected createPermissionEntries(
    appSessionId: string,
    scope: ClaudePermissionScope,
  ): ClaudeResidentPermissions {
    const ask = async (
      entry: ClaudePermissionEntry,
      toolName: string | null,
      request: AnyRecord,
      options: AnyRecord,
    ): Promise<ClaudePermissionAnswer> =>
      this.answerPermissionRequest({
        appSessionId,
        scope,
        entry,
        toolName,
        request,
        signal: options?.signal as AbortSignal | undefined,
      });

    return {
      canUseTool: async (toolName, input, options) => {
        const answer = await ask('canUseTool', toolName, input, options);
        if (answer.kind === 'refused') {
          return { behavior: 'deny', message: answer.message };
        }
        const decision = answer.decision;
        if (!decision) {
          return { behavior: 'deny', message: 'Permission request timed out' };
        }
        if (decision.cancelled) {
          return { behavior: 'deny', message: 'Permission request cancelled' };
        }
        if (decision.allow) {
          return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
        }
        return {
          behavior: 'deny',
          message: typeof decision.message === 'string' ? decision.message : 'User denied tool use',
        };
      },

      onElicitation: async (request, options) => {
        const answer = await ask('onElicitation', null, request, options);
        // A refusal, an aborted wait and a timed-out one all have the same
        // meaning to the server that asked: no answer is coming. `cancel` is the
        // SDK's word for exactly that (`ElicitResult.action`).
        if (answer.kind === 'refused' || !answer.decision?.allow) {
          return { action: 'cancel' };
        }
        return typeof answer.decision.content === 'object' && answer.decision.content !== null
          ? { action: 'accept', content: answer.decision.content }
          : { action: 'accept' };
      },

      onUserDialog: async (request, options) => {
        const answer = await ask('onUserDialog', null, request, options);
        // `cancelled` is the answer the SDK documents as the safe one: for a
        // dialog kind the client did not fill in, the CLI applies the dialog's
        // own default rather than being told a result nobody produced.
        if (answer.kind === 'refused' || !answer.decision?.allow) {
          return { behavior: 'cancelled' };
        }
        return { behavior: 'completed', result: answer.decision.result ?? null };
      },
    };
  }

  /**
   * Whether this host has nobody to ask about one request.
   *
   * Two facts, and the conjunction is the whole of the mode's arrival at
   * "unattended": nobody is connected *and* no user turn is in flight. Neither
   * half stands alone — a browser watching while the process runs a cron turn of
   * its own is somebody who could answer, and a turn this host armed came from a
   * client even if that client has since gone (its prompt is buffered for
   * replay, exactly as a per-run prompt's is) — so the test is
   * `connected <= 0 && no round`.
   *
   * A host with no adopted state, or with no writer yet, is unattended by this
   * reading: the callbacks can fire in the window between `query()` and
   * `openHost` answering, and refusing there is what keeps that window from
   * parking a turn on a person this driver cannot reach.
   *
   * `writer` is passed in rather than looked up again so the one caller that has
   * to *use* it keeps the same value this decision was made about.
   */
  protected isUnattended(
    scope: ClaudePermissionScope,
    writer: ProviderRuntimeWriter | null,
  ): boolean {
    const connected = this.connectedClientCount();
    scope.lastConnectedCount = connected;
    const state = scope.state;
    if (!state || !writer) {
      return true;
    }
    if (state.rounds.length > 0) {
      return false;
    }
    return connected <= 0;
  }

  /**
   * The writer one request's frames belong on, or null when there is none yet.
   *
   * The unattended turn's own writer wins while it is open, for the reason the
   * read loop prefers it: that turn is the one running, so a request from it is
   * addressed to whoever opened *it*. After that the round in flight owns its
   * requests, and a host between turns falls back to the last writer it saw —
   * which is what lets a browser that is still watching answer for a process
   * running a turn of its own.
   */
  protected permissionWriter(scope: ClaudePermissionScope): ProviderRuntimeWriter | null {
    const state = scope.state;
    if (!state) {
      return null;
    }
    return state.unattended?.writer ?? state.rounds[0]?.writer ?? state.writer;
  }

  /**
   * Tells the session's user that a request was refused because nobody was there.
   *
   * The same `action_required` notification the per-run flow emits for a request
   * it is waiting on, under a code of its own: the user has to be able to tell
   * "Claude is waiting for you" from "Claude was told to carry on without you",
   * and the refusal's own words travel in the event rather than being restated.
   */
  protected notifyPermission(
    appSessionId: string,
    scope: ClaudePermissionScope,
    fact: { entry: ClaudePermissionEntry; toolName: string | null; reason: string },
  ): void {
    this.notifyUser({
      userId: scope.state?.lastUserId ?? null,
      event: buildNotificationEvent({
        provider: this.provider,
        sessionId: appSessionId,
        kind: 'action_required',
        code: 'permission.unattended_refused',
        meta: {
          entry: fact.entry,
          toolName: fact.toolName,
          sessionName: scope.state?.lastSessionName ?? null,
          reason: fact.reason,
        },
        severity: 'warning',
        requiresUserAction: true,
        // One per entry per refusal, so a turn that hits the same wall three
        // times does not collapse into a single notification.
        dedupeKey: `claude:permission-refused:${appSessionId}:${fact.entry}:${scope.decisions.length}`,
      }),
    });
  }

  /** Appends one answered request to its scope's log, dated on the host's clock. */
  protected recordPermissionDecision(
    scope: ClaudePermissionScope,
    decision: Omit<ClaudePermissionDecision, 'at'>,
  ): void {
    scope.decisions.push({ ...decision, at: this.now() });
  }

  /**
   * Waits for a specific lifecycle state to be read for a specific uuid.
   *
   * Polls the reading rather than being woken by the read loop: the stream is
   * consumed by one loop this class owns, and handing the queue a callback
   * registry so a withdrawal could be notified would make the wait a second
   * consumer of the same state. `true` only when the state was actually read;
   * the budget expiring is `false`, which the caller must interpret (and does,
   * from the reading — never from the expiry).
   */
  protected async waitForLifecycle(
    state: ResidentHostState,
    commandUuid: string,
    wanted: CommandLifecycleState,
  ): Promise<boolean> {
    const deadline = Date.now() + CLAUDE_CANCEL_VERDICT_WAIT_MS;
    for (;;) {
      if (state.lifecycle.some((event) => event.commandUuid === commandUuid && event.state === wanted)) {
        return true;
      }
      if (state.closed || Date.now() >= deadline) {
        return false;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, CLAUDE_CANCEL_VERDICT_POLL_MS);
      });
    }
  }

  /**
   * Reports one round's ending to the notification layer.
   *
   * The call the runtime's own read loop makes at its turn boundary, made from
   * the same place here for the same reason: a client listening for run-ended
   * events has to hear about a stopped resident turn as well as a completed one,
   * and this driver is where either ending is reached. The application session id
   * is preferred over the provider-native one (mirroring the runtime, which
   * prefers the app id in this report and the native one in the frame), and a
   * turn that carried no session name reports none rather than inventing one.
   */
  protected reportRoundEnd(
    round: ResidentRound,
    stopReason: 'completed' | 'aborted',
    providerSessionId: string | null,
  ): void {
    const sessionName = round.turn.options?.sessionSummary;
    this.notifyRunStopped({
      userId: round.writer.userId ?? null,
      provider: 'claude',
      sessionId: round.appSessionId || providerSessionId,
      sessionName: typeof sessionName === 'string' ? sessionName : null,
      stopReason,
    });

    // The same turn boundary, recorded for the sidebar: a resident process
    // never reaches the per-run runtime's terminal block, so this is where a
    // completed resident round puts the session on the awaiting-reply list. A
    // round the user stopped themselves leaves nothing waiting — the user was
    // present when it ended — and clears any mark an earlier permission prompt
    // put on the same session. Read through the shared port rather than
    // importing the providers service: this package already sits in a
    // directory-level cycle with `providers/services`, and a direct edge from
    // the lifecycle sink would join it.
    const sessionId = round.appSessionId || providerSessionId;
    const awaitingReplyPort = readSessionAwaitingReplyPort();
    if (stopReason === 'aborted') {
      awaitingReplyPort?.clearSessionAwaitingReply(sessionId);
    } else {
      awaitingReplyPort?.markSessionAwaitingReply(sessionId, 'completed');
    }
  }
}
