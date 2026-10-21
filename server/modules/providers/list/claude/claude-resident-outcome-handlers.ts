/**
 * The shipped reading handlers for `ClaudeResidentHostDriver`.
 *
 * Every body in this file was moved here verbatim from
 * `claude-host-driver.provider.ts` (the reading methods that used to be inlined
 * in the class). The move is a pure displacement: the expressions, the field
 * reads, the copies and the `null` answers are the originals, and the driver's
 * public methods are now one-line delegations to them. The criterion
 * `tests/claude-resident-outcome-registry.test.ts` spot-checks the simple
 * readings against the old answers and compares each handler's `source` with the
 * driver's own path.
 *
 * Registration lives here rather than in the driver: {@link
 * createDefaultClaudeResidentOutcomeRegistry} builds a fresh registry and
 * registers every handler below, so the shipped set is assembled by a file
 * beside the driver. The driver imports only the factory — it never names a
 * handler body.
 *
 * Consumers: `claude-host-driver.provider.ts` (its constructor builds the
 * default registry from here) and the criterion above (which drives both the
 * shipped handlers and a probe registered from the test file).
 */
import { fileURLToPath } from 'node:url';

import {
  ledgerAnomalies,
  ledgerClosedTurns,
  ledgerDeliveries,
  ledgerForeign,
  ledgerPendingStart,
  ledgerTurn,
} from '@/modules/resident-ledger/index.js';
import type { AnyRecord, HostPendingQueuedInputs } from '@/shared/types.js';

import type {
  ClaudeBusyInputReading,
  ClaudePermissionReading,
  ClaudeRemoteControlRefusal,
  ClaudeResidentLedgerReading,
  ClaudeResidentLifecycleReading,
  ClaudeUnattendedReading,
  ResidentHostState,
} from './claude-host-driver.provider.js';
import {
  ClaudeResidentOutcomeRegistry,
  type ClaudeResidentOutcomeContext,
  type ClaudeResidentOutcomeHandler,
} from './claude-resident-outcome-registry.js';

/**
 * The file this handler set was defined in.
 *
 * Read off the module's own URL rather than spelled as a literal, so the
 * criterion can compare it with the driver's own source path without either
 * side hard-coding a checkout location (and the comparison keeps working under
 * the compiled layout, where both end in `.js`).
 */
const HANDLERS_SOURCE = fileURLToPath(import.meta.url);

/**
 * The UTF-8 bytes of one queued frame's user text — moved here with
 * {@link pendingQueuedInputs}, its only caller.
 *
 * The frame is an SDK user message: `{ type:'user', message:{ role:'user',
 * content } }` where `content` is either the prompt string or the block array an
 * attachment-carrying turn expands to. Both shapes are read so the byte reading
 * describes the text the CLI is really holding, not the JSON envelope around it
 * — an envelope length would make the relay's budget and its own count disagree
 * by an order of magnitude. A frame with neither shape counts as zero: there are
 * no words to charge.
 */
function claudeQueuedFrameTextBytes(frame: AnyRecord): number {
  const content = (frame?.message as AnyRecord | undefined)?.content;
  if (typeof content === 'string') {
    return Buffer.byteLength(content, 'utf8');
  }
  if (Array.isArray(content)) {
    let bytes = 0;
    for (const block of content) {
      const text = (block as AnyRecord | undefined)?.text;
      if (typeof text === 'string') {
        bytes += Buffer.byteLength(text, 'utf8');
      }
    }
    return bytes;
  }
  return 0;
}

/** The live resident state for a session, or null when it has no process. */
function liveStateFor(context: ClaudeResidentOutcomeContext, appSessionId: string): ResidentHostState | null {
  for (const state of context.hosts.values()) {
    if (state.appSessionId === appSessionId && !state.closed) {
      return state;
    }
  }
  return null;
}

/**
 * The host state for a session whose ledger is still worth reading.
 *
 * The same lookup as {@link liveStateFor} with one difference, and it is the
 * difference between "what is this host doing" and "what did this host have
 * open when it stopped": a host that has ended — its stream finished under it,
 * or the manager closed it — keeps its ledger readable. Everything else the
 * driver reports is about a process it is still holding, which is why the live
 * readings refuse a closed host; the ledger is frozen at that point instead,
 * and it is the answer to "did anything stay open when it died?".
 */
function ledgerStateFor(context: ClaudeResidentOutcomeContext, appSessionId: string): ResidentHostState | null {
  for (const state of context.hosts.values()) {
    if (state.appSessionId === appSessionId) {
      return state;
    }
  }
  return null;
}

/** See {@link ClaudeUnattendedReading} on the driver — body moved verbatim. */
function unattendedReading(
  context: ClaudeResidentOutcomeContext,
  appSessionId: string,
): ClaudeUnattendedReading | null {
  const state = liveStateFor(context, appSessionId);
  if (!state) {
    return null;
  }

  const pushedUuids = [...state.pushedUuids];
  return {
    pushedUuids,
    lastPushedUuid: pushedUuids.at(-1) ?? null,
    unattendedCommandUuid: state.unattended?.commandUuid ?? state.lastUnattendedCommandUuid,
    initTools: [...state.initTools],
    backgroundTaskType: state.backgroundTaskType,
  };
}

/** See {@link ClaudeBusyInputReading} on the driver — body moved verbatim. */
function busyInputReading(
  context: ClaudeResidentOutcomeContext,
  appSessionId: string,
): ClaudeBusyInputReading | null {
  const state = liveStateFor(context, appSessionId);
  if (!state) {
    return null;
  }

  return {
    queuedInputs: state.queuedInputs.map((input) => ({ ...input, frame: { ...input.frame } })),
    lifecycle: [...state.lifecycle],
    controlFrames: state.controlFrames.map((entry) => ({ ...entry, frame: { ...entry.frame } })),
    controlResponses: [...state.controlResponses],
    resultTimes: [...state.resultTimes],
    sessionStateChanged: state.sessionStateChanged,
    roundsOpen: state.rounds.length,
    hostPid: state.process.pid,
  };
}

/** See {@link ClaudeResidentLedgerReading} on the driver — body moved verbatim. */
function ledgerReading(
  context: ClaudeResidentOutcomeContext,
  appSessionId: string,
): ClaudeResidentLedgerReading | null {
  const state = ledgerStateFor(context, appSessionId);
  if (!state) {
    return null;
  }

  const turn = ledgerTurn(state.turnLedger);
  return {
    deliveries: ledgerDeliveries(state.turnLedger).map((delivery) => ({
      deliveryId: delivery.commandUuid,
      state: delivery.state,
      reason: delivery.reason,
      turnId: delivery.turnId,
      runOpen: delivery.runOpen,
      owed: delivery.owed,
      enqueuedAt: delivery.enqueuedAt,
      startedAt: delivery.startedAt,
      endedAt: delivery.endedAt,
      priority: delivery.priority,
    })),
    foreign: [...ledgerForeign(state.turnLedger)],
    turn: turn
      ? {
          id: turn.id,
          kind: turn.kind,
          open: turn.open,
          ownerDeliveryId: turn.ownerDeliveryId,
          interruptRequested: turn.interruptRequested,
        }
      : null,
    closedTurns: ledgerClosedTurns(state.turnLedger).map((closed) => ({ ...closed })),
    pendingStart: ledgerPendingStart(state.turnLedger).map((delivery) => delivery.commandUuid),
    anomalies: ledgerAnomalies(state.turnLedger).map((anomaly) => ({ ...anomaly })),
    openRuns: ledgerDeliveries(state.turnLedger).filter((delivery) => delivery.runOpen).length,
  };
}

/** See `queuedInputUuid` on the driver — body moved verbatim. */
function queuedInputUuid(context: ClaudeResidentOutcomeContext, appSessionId: string): string | null {
  const state = liveStateFor(context, appSessionId);
  if (!state || state.closed) {
    return null;
  }

  for (let index = state.queuedInputs.length - 1; index >= 0; index -= 1) {
    const input = state.queuedInputs[index];
    if (input.startedAt === null) {
      return input.uuid;
    }
  }
  return null;
}

/** See `pendingQueuedInputs` on the driver — body moved verbatim. */
function pendingQueuedInputs(
  context: ClaudeResidentOutcomeContext,
  appSessionId: string,
): HostPendingQueuedInputs | null {
  const state = liveStateFor(context, appSessionId);
  if (!state) {
    return null;
  }

  // The CLI's own account of what has left the queue, by uuid: any of these
  // states means the message is no longer waiting, whatever `startedAt` says.
  const departed = new Set<string>();
  for (const event of state.lifecycle) {
    if (event.state !== 'queued') {
      departed.add(event.commandUuid);
    }
  }

  let items = 0;
  let bytes = 0;
  for (const input of state.queuedInputs) {
    if (input.startedAt !== null || departed.has(input.uuid)) {
      continue;
    }
    items += 1;
    bytes += claudeQueuedFrameTextBytes(input.frame);
  }
  return { items, bytes };
}

/** See `startedQueuedCommands` on the driver — body moved verbatim. */
function startedQueuedCommands(
  context: ClaudeResidentOutcomeContext,
  appSessionId: string,
): readonly string[] | null {
  const state = liveStateFor(context, appSessionId);
  if (!state) {
    return null;
  }

  const started: string[] = [];
  const seen = new Set<string>();
  for (const event of state.lifecycle) {
    if (event.state !== 'started' || seen.has(event.commandUuid)) {
      continue;
    }
    seen.add(event.commandUuid);
    started.push(event.commandUuid);
  }
  return started;
}

/** See `runInFlight` on the driver — body moved verbatim. */
function runInFlight(context: ClaudeResidentOutcomeContext, appSessionId: string): boolean | null {
  const state = liveStateFor(context, appSessionId);
  if (!state) {
    return null;
  }
  return state.rounds.length > 0;
}

/** See {@link ClaudeResidentLifecycleReading} on the driver — body moved verbatim. */
function lifecycleReading(
  context: ClaudeResidentOutcomeContext,
  appSessionId: string,
): ClaudeResidentLifecycleReading | null {
  const state = liveStateFor(context, appSessionId);
  if (!state) {
    return null;
  }

  return {
    hostId: state.hostId,
    crons: state.heldCrons.map((lease) => ({ ...lease })),
    backgroundTasks: state.heldBackgroundTasks.map((lease) => ({ ...lease })),
    unhandledSystemSubtypes: [...state.unhandledSystemSubtypes],
    cronsAuthoritative: state.cronsAuthoritative,
    tasksAuthoritative: state.tasksAuthoritative,
  };
}

/** See {@link ClaudePermissionReading} on the driver — body moved verbatim. */
function permissionReading(
  context: ClaudeResidentOutcomeContext,
  appSessionId: string,
): ClaudePermissionReading | null {
  const state = liveStateFor(context, appSessionId);
  if (!state) {
    return null;
  }

  return {
    permissionMode: state.permissions.mode,
    decisions: state.permissions.decisions.map((decision) => ({ ...decision })),
    lastConnectedCount: state.permissions.lastConnectedCount,
  };
}

/** See `remoteControlRefusal` on the driver — body moved verbatim. */
function remoteControlRefusal(
  context: ClaudeResidentOutcomeContext,
  appSessionId: string,
): ClaudeRemoteControlRefusal | null {
  return context.refusals.get(appSessionId) ?? null;
}

/** The two private lookups, registered like every other reading so the driver delegates them too. */
const liveState: ClaudeResidentOutcomeHandler<ResidentHostState | null> = {
  name: 'liveState',
  label: 'claude-resident.live-state',
  source: HANDLERS_SOURCE,
  handle: liveStateFor,
};

const ledgerState: ClaudeResidentOutcomeHandler<ResidentHostState | null> = {
  name: 'ledgerState',
  label: 'claude-resident.ledger-state',
  source: HANDLERS_SOURCE,
  handle: ledgerStateFor,
};

/**
 * Every shipped reading handler, keyed by the kind it answers.
 *
 * Exported as data (rather than only through the factory) so the criterion can
 * enumerate the shipped set and assert each handler's `source` is this file —
 * the registration is a list a reader can see, not a side effect hidden in an
 * import.
 */
export const CLAUDE_RESIDENT_OUTCOME_HANDLERS: readonly ClaudeResidentOutcomeHandler[] = [
  liveState,
  ledgerState,
  {
    name: 'unattendedReading',
    label: 'claude-resident.unattended-reading',
    source: HANDLERS_SOURCE,
    handle: unattendedReading,
  },
  {
    name: 'busyInputReading',
    label: 'claude-resident.busy-input-reading',
    source: HANDLERS_SOURCE,
    handle: busyInputReading,
  },
  {
    name: 'ledgerReading',
    label: 'claude-resident.ledger-reading',
    source: HANDLERS_SOURCE,
    handle: ledgerReading,
  },
  {
    name: 'queuedInputUuid',
    label: 'claude-resident.queued-input-uuid',
    source: HANDLERS_SOURCE,
    handle: queuedInputUuid,
  },
  {
    name: 'pendingQueuedInputs',
    label: 'claude-resident.pending-queued-inputs',
    source: HANDLERS_SOURCE,
    handle: pendingQueuedInputs,
  },
  {
    name: 'startedQueuedCommands',
    label: 'claude-resident.started-queued-commands',
    source: HANDLERS_SOURCE,
    handle: startedQueuedCommands,
  },
  {
    name: 'runInFlight',
    label: 'claude-resident.run-in-flight',
    source: HANDLERS_SOURCE,
    handle: runInFlight,
  },
  {
    name: 'lifecycleReading',
    label: 'claude-resident.lifecycle-reading',
    source: HANDLERS_SOURCE,
    handle: lifecycleReading,
  },
  {
    name: 'permissionReading',
    label: 'claude-resident.permission-reading',
    source: HANDLERS_SOURCE,
    handle: permissionReading,
  },
  {
    name: 'remoteControlRefusal',
    label: 'claude-resident.remote-control-refusal',
    source: HANDLERS_SOURCE,
    handle: remoteControlRefusal,
  },
];

/**
 * Builds the registry the driver ships with.
 *
 * A fresh registry per driver (not a module-level singleton): a criterion's
 * probe registration must not leak into another driver, and the shipped set is
 * re-registered from {@link CLAUDE_RESIDENT_OUTCOME_HANDLERS} so the default
 * dispatch path is exactly this file's list.
 *
 * Consumers: `ClaudeResidentHostDriver`'s constructor, and the criterion, which
 * builds its own registry to register a probe over a shipped handler.
 */
export function createDefaultClaudeResidentOutcomeRegistry(): ClaudeResidentOutcomeRegistry {
  const registry = new ClaudeResidentOutcomeRegistry();
  for (const handler of CLAUDE_RESIDENT_OUTCOME_HANDLERS) {
    registry.register(handler);
  }
  return registry;
}
