import type {
  HostLease,
  HostResidentStartResult,
  LifecycleModeErrorCode,
} from '@/shared/types.js';

import type { SessionHostManager } from './session-host-manager.service.js';
import type {
  HostDriverResolver,
  ResidentSessionStarter,
  SessionLifecycleReading,
} from './session-hosts.routes.js';

/**
 * What the resident start/close services need, and nothing else.
 *
 * The same four seams the router is constructed with, under the same names and
 * the same types ({@link SessionLifecycleReading}, {@link HostDriverResolver},
 * {@link ResidentSessionStarter}) — deliberately not new synonyms, so the
 * route can hand its own dependencies straight through without a second shape
 * to keep in step. Consumed by this module's route (which passes its injected
 * seams unchanged) and by this module's criterion (which drives the services
 * over a manager and fakes it owns).
 */
export type ResidentHostServiceDeps = {
  sessionHostManager: SessionHostManager;
  /** See {@link SessionLifecycleReading}; absent means no session can be read. */
  readSession?: (appSessionId: string) => SessionLifecycleReading | null;
  /** See {@link HostDriverResolver}; absent means no provider has a driver. */
  resolveHostDriver?: HostDriverResolver;
  /** See {@link ResidentSessionStarter}; absent means the start falls back to `bindSession`. */
  startResidentSession?: ResidentSessionStarter;
};

/**
 * A resident start/close turned down, in the transport-agnostic form the route
 * translates back into its own refusal envelope.
 *
 * `status` is the HTTP status the route has always answered with — carried here
 * because it is part of the decision rather than of the transport, the same way
 * the code and the sentence are. Consumed by this module's route
 * (`sendRefusal`) and this module's criterion (which asserts `status`, `code`
 * and `message` together).
 */
export type ResidentHostRefusal = {
  ok: false;
  status: number;
  code: LifecycleModeErrorCode;
  message: string;
};

/**
 * The outcome of a resident start: the host that now serves the session, or a
 * refusal saying why none does.
 *
 * `mode` is the literal `'resident'` rather than a `HostMode` because only a
 * resident host reaches this branch — the union member is the type-level proof
 * of the route's own reading, and the route forwards it verbatim into the
 * response body it has always written. `pid` is nullable for the same reason
 * {@link ProcessHost.pid} is. Consumed by this module's route and criterion.
 */
export type ResidentHostStartOutcome =
  | { ok: true; hostId: string; sessionId: string; mode: 'resident'; pid: number | null }
  | ResidentHostRefusal;

/**
 * The outcome of a resident close: the host that was closed, why, and the
 * leases the binding held when it was.
 *
 * `leases` is the reading the HTTP body deliberately does not carry — the route
 * keeps its wire shape (`{ hostId, sessionId, mode, closeReason }`) — but a
 * future transport (the MCP `session_close`), which owes its caller the reason
 * the host was kept alive, needs exactly this. Consumed by this module's route
 * and criterion.
 */
export type ResidentHostCloseOutcome =
  | {
      ok: true;
      hostId: string;
      sessionId: string;
      mode: 'resident';
      closeReason: 'user';
      leases: HostLease[];
    }
  | ResidentHostRefusal;

/**
 * Starts the resident host for one session, or answers why it will not.
 *
 * The whole of the `POST /:sessionId/start` decision, lifted out of the route so
 * that the MCP gateway's `session_start` can reach the same code rather than a
 * second copy of it. The refusals keep the route's order — cheapest question
 * first: no such session, a host already serving it in another mode, a stored
 * preference that is not residential, and finally a resident session whose
 * provider mounts no driver — and every sentence is the route's own, verbatim.
 *
 * A session that already has a live resident host is a success, not a refusal:
 * "start" is a request for a state, and the state is already the one asked for,
 * so the live host is returned without asking the launch seam or opening a
 * second process. Consumed by this module's route and criterion.
 */
export async function startResidentHost(
  sessionId: string,
  deps: ResidentHostServiceDeps,
): Promise<ResidentHostStartOutcome> {
  const session = deps.readSession?.(sessionId) ?? null;
  if (!session) {
    return refuse(404, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
  }

  const running = deps.sessionHostManager.liveHostForSession(sessionId);
  if (running) {
    if (running.mode !== 'resident') {
      return refuse(
        409,
        'LIFECYCLE_MODE_NOT_RESIDENT',
        `Session "${sessionId}" already runs in "${running.mode}" mode; only a resident host can be started on demand.`,
      );
    }

    return {
      ok: true,
      hostId: running.hostId,
      sessionId,
      mode: 'resident',
      pid: running.pid,
    };
  }

  if (session.mode !== 'resident') {
    return refuse(
      409,
      'LIFECYCLE_MODE_NOT_RESIDENT',
      `Session "${sessionId}" is stored as "${session.mode}"; only a resident session can be started on demand.`,
    );
  }

  const driver = deps.resolveHostDriver?.(session.provider) ?? null;
  if (!driver) {
    return refuse(
      409,
      'LIFECYCLE_MODE_HOST_UNAVAILABLE',
      `Provider "${session.provider}" mounts no host driver, so session "${sessionId}" cannot be started.`,
    );
  }

  // A resident start opens the session's *own* process, which is the question
  // `bindSession` cannot answer: that verb asks which live process can take the
  // conversation, and its answer for a driver that declares
  // `multiplexedHost === false` is a refusal as soon as any other host of the
  // provider is alive — while with none alive it falls through to `openHost`,
  // where the same driver throws because a resident host is brought up by a
  // launch and not by a record. So the entry is the driver's own on-demand
  // verb, reached through the injected seam that assembles its launch options.
  //
  // Both halves are required: a driver that never implemented the verb cannot be
  // asked, and the seam that would assemble its options has nothing to hand it.
  // That combination keeps the binding path below live for every provider whose
  // process really can adopt a session — a multiplexing driver, and the fake
  // drivers criteria mount here.
  if (deps.startResidentSession && typeof driver.startResidentSession === 'function') {
    let started: HostResidentStartResult;
    try {
      started = await deps.startResidentSession(session.provider, sessionId);
    } catch (error) {
      // Nothing was started, and the reason is the useful part: a launch the
      // driver's own gate refused, or a process that could not be adopted. The
      // code stays the lifecycle one a client branches on (the same trade the
      // binding path below makes), and the driver's sentence travels verbatim
      // in the message rather than being replaced by "failed".
      return refuse(
        409,
        'LIFECYCLE_MODE_HOST_UNAVAILABLE',
        `Session "${sessionId}" could not be started (${errorMessage(error)}).`,
      );
    }

    return {
      ok: true,
      hostId: started.hostId,
      sessionId,
      mode: 'resident',
      pid: started.pid,
    };
  }

  const bound = await deps.sessionHostManager.bindSession({
    provider: session.provider,
    appSessionId: sessionId,
    driver,
  });

  if (!bound.ok) {
    // The manager refused to place the session on a process. The code it
    // answered with is a bind-refusal vocabulary (`session-already-bound` /
    // `host-not-multiplexed`), not a lifecycle one, so it travels in the
    // message and the response keeps the code a lifecycle client branches on:
    // nothing was started, which is what `HOST_UNAVAILABLE` says.
    return refuse(
      409,
      'LIFECYCLE_MODE_HOST_UNAVAILABLE',
      `Session "${sessionId}" could not be bound to a host (${bound.code}).`,
    );
  }

  const host = deps.sessionHostManager.liveHostForSession(sessionId);
  return {
    ok: true,
    hostId: bound.hostId,
    sessionId,
    mode: 'resident',
    pid: host?.pid ?? null,
  };
}

/**
 * Closes the resident host serving one session, or answers why it will not.
 *
 * The whole of the `POST /:sessionId/close` decision, lifted out of the route
 * for the same reason {@link startResidentHost} is. It records the close through
 * the manager (`closeHost(hostId, 'user')`) and answers with the reason, the
 * host, and the leases the binding held — the last of which is read back from
 * the binding *before* the close, because the manager empties leases as part of
 * closing. The four refusals keep the route's order: a host serving the session
 * in another mode is the first thing said, and only when nothing is serving it
 * does the session row decide between no session, a stored non-resident
 * preference, and a resident session with no live host. Consumed by this
 * module's route and criterion.
 */
export function closeResidentHost(
  sessionId: string,
  deps: ResidentHostServiceDeps,
): ResidentHostCloseOutcome {
  const host = deps.sessionHostManager.liveHostForSession(sessionId);

  if (host) {
    if (host.mode !== 'resident') {
      return refuse(
        409,
        'LIFECYCLE_MODE_NOT_RESIDENT',
        `Session "${sessionId}" runs in "${host.mode}" mode; only a resident host can be closed on demand.`,
      );
    }

    // Read the leases before closing: `closeHost` clears the binding's leases as
    // part of the teardown, so the reading is only available on the live record.
    // The resident host holds `resident-policy` (granted by `createBinding`), so
    // this is the mode's own statement that the process was meant to sit between
    // turns — not a field invented for this call.
    const leases = host.bindings.get(sessionId)?.leases ?? [];
    deps.sessionHostManager.closeHost(host.hostId, 'user');

    return {
      ok: true,
      hostId: host.hostId,
      sessionId,
      mode: 'resident',
      closeReason: 'user',
      leases,
    };
  }

  // Nothing is serving the session, so there is nothing to close. Which *kind*
  // of nothing decides the answer, and only the session row can tell them apart:
  // a per-run session is refused (the verb is resident-only, and a client asking
  // about one has misread the mode), a resident one is told there is no host,
  // and an unknown id is told there is no session.
  const session = deps.readSession?.(sessionId) ?? null;
  if (!session) {
    return refuse(404, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
  }

  if (session.mode !== 'resident') {
    return refuse(
      409,
      'LIFECYCLE_MODE_NOT_RESIDENT',
      `Session "${sessionId}" is stored as "${session.mode}"; only a resident session can be closed on demand.`,
    );
  }

  return refuse(
    404,
    'SESSION_HOST_NOT_FOUND',
    `Session "${sessionId}" is resident but no live host is serving it.`,
  );
}

/** One refusal, in the shared transport-agnostic shape. */
function refuse(
  status: number,
  code: LifecycleModeErrorCode,
  message: string,
): ResidentHostRefusal {
  return { ok: false, status, code, message };
}

/**
 * The sentence from a rejected start, whatever was thrown.
 *
 * A refusal's message is the only part of it a user can act on, so a non-`Error`
 * rejection is stringified rather than dropped: the alternative — a generic
 * "could not be started" — would leave the caller knowing nothing it did not
 * already know from the status code.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

