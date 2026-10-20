import express from 'express';
import type { Request, Response } from 'express';

import type { IProviderHostDriver } from '@/shared/interfaces.js';
import type {
  HostLease,
  HostMode,
  HostResidentStartResult,
  LifecycleModeErrorCode,
  LLMProvider,
  ProcessHost,
  SessionBinding,
} from '@/shared/types.js';
import { asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
// The close route applies the ONE lease judgement both transports share rather
// than a second copy of it: `blockingLeases` is the definition of which leases
// block a close, `leasesBlockingMessage` its one refusal sentence, and
// `SESSION_HAS_ACTIVE_LEASES_CODE` the one code; the alternative — restating the
// predicate and the string here — is exactly the drift this task exists to
// prevent. `readLiveHost` is the same read-only live-host port the MCP handler's
// gate reads, so both transports see the same host.
//
// The definitions live in the SHARED layer, not in the gateway module, and that
// is load-bearing rather than a style choice. This file is reached from
// `session-hosts/index.ts`, which `claude.provider.ts` imports while
// `provider.registry.ts` is still evaluating. The gateway barrel pulls the
// providers barrel back in (`mcp-gateway.write-tools.js` →
// `@/modules/providers/index.js`), so naming it here would close the eval cycle
// `providerRegistry` → `claude.provider` → session-hosts barrel → this route →
// gateway barrel → providers barrel → `provider-models.service.js`, whose module
// body reads `providerRegistry` before the registry has initialised — the TDZ
// that reds every test entering the providers graph (`ReferenceError: Cannot
// access 'providerRegistry' before initialization`). Naming the gateway's leaf
// module avoided that TDZ at the cost of a module edge that kept the two
// modules' evaluation order coupled; importing the shared port removes the edge
// entirely, so neither side can constrain the other's initialization.
import {
  blockingLeases,
  leasesBlockingMessage,
  readLiveHost,
  SESSION_HAS_ACTIVE_LEASES_CODE,
} from '@/shared/ports/session-host-control.port.js';

import { closeResidentHost, startResidentHost } from './resident-host.service.js';
import type { SessionHostManager } from './session-host-manager.service.js';

/**
 * One host as the listing endpoint reports it.
 *
 * A projection rather than the manager's own record, for two reasons. The
 * record's `bindings` is a `Map`, which `JSON.stringify` would flatten to `{}`
 * — the one shape a browser cannot read — and the record carries fields
 * (`closeDetail`, `quietDeadlineAt`, `quietWindowStartAt`) whose meaning is the
 * state machine's internal bookkeeping. What a client is owed is the host's
 * identity, what it is, whether it is still there, and who is on it.
 *
 * `closeReason` is null on a host that is still open, which is also the only
 * way a reader can tell "still running" from "closed" without a second field:
 * a closed host always has a reason (`closeHost` sets the two together).
 */
type HostView = {
  hostId: string;
  provider: LLMProvider;
  mode: ProcessHost['mode'];
  state: ProcessHost['state'];
  /** The child process id, or null for a host that was never given one. */
  pid: number | null;
  startedAt: number;
  closeReason: ProcessHost['closeReason'];
  /**
   * The extra fact `closeReason` carries, or null when it carries none.
   *
   * Published because it is the only thing that tells a process that exited
   * from one that was stopped: `closeReason: 'exited'` says the process ended on
   * its own, and this says whether it was killed for memory (`oom`), died of a
   * signal, or failed — which is the difference between a banner the user can
   * act on and one that only reports. It travels with `closeReason` in the
   * manager's own record (set together, never one without the other), so
   * projecting it here does not invent a state the host can be in.
   */
  closeDetail: ProcessHost['closeDetail'];
  bindings: BindingView[];
};

/** One session on a host, as the listing endpoint reports it. */
type BindingView = {
  appSessionId: string;
  providerSessionId: string | null;
  state: SessionBinding['state'];
  leases: HostLease[];
  lastActivityAt: number;
  /**
   * The address this conversation's process answers to, or null when it has
   * none. Published because it is the one fact about a resident process that
   * cannot be derived from anything the client already holds: the name is
   * registered inside the process, so a reader that wants to send to this
   * session has nowhere else to read it from.
   */
  peerName: string | null;
};

/**
 * One session's host state, as the listing endpoint reports it — including the
 * sessions no host is serving.
 *
 * `hosts` answers "what processes are there"; this answers "what should be
 * running, and isn't". The two are different questions and neither is a subset
 * of the other: a host can exist for a session whose row is gone, and after a
 * restart every resident session has no host at all. Reporting only the first
 * was what made a restart indistinguishable from a fresh install.
 *
 * `lifecycleMode` is the stored preference, which is why it survives the
 * restart that `hosts` does not.
 */
type SessionHostStateView = {
  appSessionId: string;
  provider: LLMProvider;
  lifecycleMode: HostMode;
  /** True while a live (not closed) host holds this session. */
  running: boolean;
  /**
   * Why a resident session has no process, or null when the question does not
   * apply — a running session, or a per-run one, whose process is its turn's
   * and whose absence between turns means nothing.
   */
  reason: string | null;
  /**
   * The Claude Code background job holding this conversation, or null.
   *
   * The key is on *every* row, per-run sessions included, because the two halves
   * of this listing are read by different clients: `running`/`reason` are about
   * the process this server owns, and this is about a process it does not. A
   * per-run session can be occupied just as a resident one can, and the read-only
   * state it implies is the same — so the field is never absent, only null.
   */
  occupiedBy: SessionOccupiedBy | null;
};

/**
 * The Claude Code background job occupying one conversation, as the listing
 * reports it.
 *
 * Exactly the two facts a client acts on: `jobId` is the handle `claude stop`
 * takes, and `pid` is the process behind it, so a reader can say *what* to stop
 * as well as *that* something has to be. The job's display name is deliberately
 * not here — the server's own refusal carries it, and a listing row is a
 * contract the client renders rather than a copy of the CLI's registry row.
 *
 * Mirrored in `src/shared/types.ts` as `SessionOccupiedBy`, which is the same
 * shape under the same name for the browser.
 */
export type SessionOccupiedBy = {
  jobId: string;
  pid: number;
};

/**
 * Reads which conversations a Claude Code background job is holding.
 *
 * A dependency rather than an import, for the reason {@link SessionReader} is
 * one: the CLI's registry is the `providers` layer's business, and that module
 * already imports this one, so reaching for it here would close a cycle.
 * `server/index.ts` supplies the real reader.
 *
 * Batch, not per-session, and that is the point of the shape: this route is
 * polled once a second, and the answer costs one scan of the registry directory.
 * A reader asked once per row would scan it once per row. It is called exactly
 * once per request, whatever the listing holds — including when it holds nothing,
 * so "one scan per request" is a property of the route rather than of the data.
 *
 * A conversation the reader knows nothing about is simply absent from the map:
 * absence and `null` say the same thing, so there is no second value to invent.
 */
export type SessionOccupancyReader = () => Map<string, SessionOccupiedBy>;

/**
 * What one route needs to know about a session, and nothing else.
 *
 * The `/start` route cannot answer its own question from the host layer — a
 * session that has never been started has no host to look up — so it asks the
 * module that owns session rows for the two facts that decide the request: the
 * provider whose driver would serve it, and the mode the user asked for. Narrow
 * on purpose: a route that received the whole row could be tempted to branch on
 * a field that is not its business, and the mode read has to come through
 * `getSessionLifecycleMode` (the reader that supplies `per-run` for a row that
 * has never been written) rather than off the raw column.
 */
export type SessionLifecycleReading = {
  provider: LLMProvider;
  mode: HostMode;
};

/**
 * Resolves the host driver a provider mounts, or null when it mounts none.
 *
 * A dependency rather than an import because the driving module
 * (`providers`) already imports this one: reaching back for
 * `providerRegistry` here would close an import cycle, which is the same reason
 * `provider.registry` keeps its own consumers at arm's length. `server/index.ts`
 * — the composition root, which imports both — supplies the real one.
 */
export type HostDriverResolver = (provider: LLMProvider) => IProviderHostDriver | null;

/**
 * Opens one session's own resident process, without a turn.
 *
 * A dependency for the same reason {@link HostDriverResolver} is one, one step
 * further along: starting a resident process needs a launch options bag and a
 * provider runtime context, and both are assembled from facts this module does
 * not own — the session row's project path and the model/effort/permission mode
 * the user last sent, read by the `providers` layer, which already imports this
 * module and so cannot be imported back. `server/index.ts` supplies the real one
 * over `providerRuntimeService.startResidentSession`.
 *
 * Only meaningful together with a driver that implements
 * `IProviderHostDriver.startResidentSession`; a caller that has the seam but a
 * driver without the verb must not call it (see the start route's branch), since
 * a driver that cannot be asked would otherwise have its options assembled and
 * thrown away.
 *
 * Rejects rather than answering a refusal value: every failure it can report is
 * one the route turns into its own named refusal with the sentence kept.
 */
export type ResidentSessionStarter = (
  provider: LLMProvider,
  appSessionId: string,
) => Promise<HostResidentStartResult>;

/**
 * What a session's own row says about whether a host *should* be serving it.
 *
 * The listing needs one fact the host layer cannot hold: a session's stored
 * lifecycle mode. Hosts are derived state — they exist exactly as long as a
 * process does — so after a restart the host table is empty and every resident
 * session is indistinguishable from a session that never ran. The mode is on
 * the row, which is why the composition root reads it there.
 */
export type SessionHostStateReading = {
  appSessionId: string;
  provider: LLMProvider;
  mode: HostMode;
  /**
   * The provider's own id for this conversation, or null/absent when it has none.
   *
   * This is the key an occupancy reading is looked up by: the CLI's registry
   * files a background job under the conversation the *provider* knows, and the
   * app's session id never appears in one. Optional rather than required so a
   * reader that reports sessions for a criterion which never mentions a provider
   * id still typechecks — the route treats an absent value exactly as a null one,
   * and a session with no provider id simply has no occupancy to look up.
   */
  providerSessionId?: string | null;
};

/**
 * Reads the sessions the listing reports state for.
 *
 * A dependency for the same reason {@link HostDriverResolver} is one: the rows
 * belong to the sessions module, and this module cannot import it (providers
 * imports this one, so the edge back would close a cycle). `server/index.ts`
 * supplies the real reader.
 *
 * Optional, and an absent reader means "no sessions to report" rather than a
 * refusal: the two criteria that mount this router over a manager they drove
 * themselves care about hosts, and a listing that answered `sessions: []` for
 * them is the honest answer — they never told it about any session.
 */
export type SessionReader = () => SessionHostStateReading[];

/**
 * The reason a resident session carries when no host is serving it.
 *
 * Derived, never stored — which is the whole reason it is a constant here and
 * not a column. `lifecycle_mode` says a session *wants* a long-lived process;
 * only the host layer knows whether one is there right now, and that answer is
 * true for as long as the process is. Persisting it would mean writing a row on
 * every host open and close, and would still be wrong after a SIGKILL — the one
 * case it exists for — because nothing survives to write it.
 *
 * The text names both of the ways a resident session can be hostless, because
 * the listing cannot tell them apart: a process closed by the server's own stop
 * path and one that was never started look identical after a restart, and a
 * client that needs the difference has the transcript for it.
 */
export const RESIDENT_NOT_RUNNING_REASON =
  'No resident host is running for this session; the last server stop or restart dropped it.';

/**
 * The HTTP face of the host layer: `GET /api/session-hosts`,
 * `POST /api/session-hosts/:sessionId/start`, and
 * `POST /api/session-hosts/:sessionId/close`.
 *
 * Exported as a factory rather than as a ready-made router because the manager
 * is a dependency, not a module-level constant: `server/index.ts` mounts it
 * over the process-wide singleton, and a criterion mounts it over a manager it
 * built and drove itself, so the listing it reads is the same table the
 * dispatch under test wrote.
 *
 * The listing does one thing — read the manager's snapshot and the injected
 * session reader, project both, wrap them in the standard envelope — and
 * deliberately does not import `chatRunRegistry` or touch the database. That is
 * not stylistic: the hosts are the host layer's own state, and a listing built
 * from the run registry would silently omit the hosts that exist *after* their
 * run ended (a `lingering` process, a held-stdin window), which is exactly the
 * state this endpoint exists to show. The session reader is a seam for the same
 * reason, from the other side: the rows are the sessions module's, so they
 * arrive as a value rather than as an import, and this module still reads no
 * database of its own.
 *
 * The listing reports two arrays for that one reason. `hosts` alone cannot show
 * a session whose process is gone, and "the server restarted and dropped my
 * resident sessions" is precisely a statement about a process that is *not*
 * there — a client could not tell it from "the session never existed", because
 * after a restart both look like an empty host table.
 *
 * The close route is the same principle from the other side: it addresses a host
 * by the *session* it serves (which is what a client knows), and relays a
 * decision the manager records. It does not terminate anything itself — ending
 * the process is the driver's answer to being closed, and for a resident host
 * that answer is stdin EOF. It is also the only route here that is mode-restricted,
 * and deliberately so: a `per-run` host's life is its turn's, and a caller closing
 * one would be reaching past the run that owns it.
 *
 * `/start` is that restriction's mirror image. A resident session's process is
 * opened lazily — on the first turn, or when the user asks for it here — and the
 * decision that reaches it (the four refusals, the idempotent already-running
 * branch, the launch-versus-bind choice) lives in
 * {@link startResidentHost}, this module's own service. `/close` relays
 * {@link closeResidentHost} the same way. Both service functions answer with a
 * named `LifecycleModeErrorCode` in a transport-agnostic result, so a client
 * tells "this session is not resident" from "there is no such session" from
 * "nothing is running for it" without reading prose, and a second transport (the
 * MCP gateway) can reuse the decision rather than restate it here.
 */
export function createSessionHostsRouter({
  sessionHostManager,
  readSession,
  resolveHostDriver,
  startResidentSession,
  listSessions,
  readSessionState,
  readSessionOccupancy,
}: {
  sessionHostManager: SessionHostManager;
  /**
   * Reads the session a lifecycle verb addresses, or null when no row exists.
   *
   * Optional, and fail-closed when absent: a route with no reader cannot tell
   * "not resident" from "no such session", so it refuses rather than guessing.
   * That keeps the listing router (which never reads a session) constructible
   * with the manager alone, which is how the routes criterion and the resident
   * criterion both mount it.
   */
  readSession?: (appSessionId: string) => SessionLifecycleReading | null;
  /** See {@link HostDriverResolver}; absent means "no provider has a driver". */
  resolveHostDriver?: HostDriverResolver;
  /** See {@link ResidentSessionStarter}; absent means the start route binds instead. */
  startResidentSession?: ResidentSessionStarter;
  /** See {@link SessionReader}; absent means the listing reports no sessions. */
  listSessions?: SessionReader;
  /**
   * Reads one session's row, or null when no visible row exists.
   *
   * The single-row twin of `listSessions`, for `GET /:sessionId`: a caller that
   * wants one session's mode must not make the server read (and the client
   * receive) every stored session. Absent means the single read reports no row,
   * the same fail-open shape `listSessions` has.
   */
  readSessionState?: (appSessionId: string) => SessionHostStateReading | null;
  /**
   * See {@link SessionOccupancyReader}; absent means no session is reported as
   * occupied — the same fail-open shape `listSessions` has, and honest for the
   * same reason: a router mounted without the seam was told about no provider,
   * so it has nothing to read an occupancy from.
   */
  readSessionOccupancy?: SessionOccupancyReader;
}) {
  const router = express.Router();

  /**
   * Builds one listing answer from the manager's snapshot and a set of session rows.
   *
   * The two reads below share it so they cannot disagree about what a row means:
   * `holding` narrows the `hosts` half to the hosts serving one session and
   * `onlyActive` narrows the `sessions` half, and everything else — "running" read
   * off the same snapshot, one registry scan per request — is one rule stated once.
   */
  const answer = (
    response: Response,
    rows: () => SessionHostStateReading[],
    options: { holding?: string; onlyActive?: boolean } = {},
  ) => {
    const hosts = sessionHostManager.snapshot();

    // "Running" is read off the same snapshot the hosts array is projected
    // from, so the two halves of this payload cannot disagree: a session is
    // running here exactly when a host in this response is holding it. A closed
    // host is not running — its record stays in the snapshot for a retention
    // window, and a client reading it as a live process would get the opposite
    // answer from the process's own /proc entry.
    const running = new Set<string>();
    for (const host of hosts) {
      if (host.state === 'closed') {
        continue;
      }
      for (const appSessionId of host.bindings.keys()) {
        running.add(appSessionId);
      }
    }

    // One scan of the CLI's registry for the whole response, asked for before
    // the rows are projected and never asked again inside the loop: this route is
    // polled once a second, and a per-row reader would scan the directory once per
    // row. It is asked unconditionally — a listing with no session to report still
    // costs exactly one scan, which is what makes "one per request" a property of
    // the route rather than of whatever the database happens to hold.
    //
    // A session is looked up only when it is Claude's and has a provider id:
    // the registry is Claude's, and a row with no provider session id has no
    // conversation for a job to be holding. That is a lookup guard, not a claim
    // that only resident sessions can be occupied — a per-run session can be, and
    // the read-only state it implies is the same.
    const occupancy = readSessionOccupancy?.() ?? null;

    let sessions = rows().map((session) => toSessionHostStateView(session, running, occupancy));

    // A row that is per-run, has no live host and has no occupant says exactly
    // what a client already assumes of a session the listing does not mention
    // (`findSessionHostState` answers null for it), so it is the one kind of row
    // a client loses nothing by not receiving. Resident rows are kept even when
    // nothing runs them: "should be running and is not" is a finding.
    if (options.onlyActive) {
      sessions = sessions.filter(
        (view) => view.running || view.lifecycleMode === 'resident' || view.occupiedBy !== null,
      );
    }

    const holding = options.holding;
    const shownHosts = holding === undefined ? hosts : hosts.filter((host) => host.bindings.has(holding));

    response.json(createApiSuccessResponse({ hosts: shownHosts.map(toHostView), sessions }));
  };

  /**
   * The whole listing, or — with `?scope=active` — the rows worth sending.
   *
   * Any other `scope` value is the whole listing: an unknown word must not hide
   * a row a caller was counting on. The unscoped answer is unchanged, which is
   * what scripts and the MCP smoke legs read.
   */
  router.get('/', (request: Request, response: Response) => {
    answer(response, () => listSessions?.() ?? [], { onlyActive: request.query.scope === 'active' });
  });

  /**
   * One session: its row, and the hosts holding it.
   *
   * Same envelope and element shapes as the list, so a client reads it with the
   * parser it already has. An unknown session is `sessions: []` rather than a
   * 404 — the list reports a not-yet-listed session as absent and the client
   * defaults it to per-run, and a single read keeps that reading instead of
   * inventing a failure for the first poll after a session is created.
   */
  router.get('/:sessionId', (request: Request, response: Response) => {
    const sessionId = routeParameter(request.params.sessionId);
    answer(
      response,
      () => {
        const row = readSessionState?.(sessionId) ?? null;
        return row ? [row] : [];
      },
      { holding: sessionId },
    );
  });

  /**
   * Starts the resident host for one session, or relays the service's refusal.
   *
   * The route does three things and nothing else: it parses the path parameter,
   * calls `startResidentHost` (which owns the whole decision — the four
   * refusals, the idempotent already-running branch, the launch/bind choice),
   * and translates the transport-agnostic result into the existing HTTP
   * envelope. A refusal keeps its code and sentence verbatim via `sendRefusal`,
   * so the wire contract is unchanged; the success body is still
   * `{ hostId, sessionId, mode, pid }`.
   */
  router.post(
    '/:sessionId/start',
    asyncHandler(async (request: Request, response: Response) => {
      const sessionId = routeParameter(request.params.sessionId);
      const result = await startResidentHost(sessionId, {
        sessionHostManager,
        readSession,
        resolveHostDriver,
        startResidentSession,
      });

      if (!result.ok) {
        sendRefusal(response, result.status, result.code, result.message);
        return;
      }

      response.json(
        createApiSuccessResponse({
          hostId: result.hostId,
          sessionId: result.sessionId,
          mode: result.mode,
          pid: result.pid,
        }),
      );
    }),
  );

  /**
   * Closes the host serving one session, or refuses while it holds background work.
   *
   * The lease gate runs FIRST and is the *same* judgement the MCP `session_close`
   * handler makes — the contract shared by both transports: a live *resident* host
   * whose binding holds a `cron` or `background-task` lease refuses the close with
   * `SESSION_HAS_ACTIVE_LEASES` unless the request body carries a literal
   * `force: true`. The predicate (`blockingLeases`), the code
   * (`SESSION_HAS_ACTIVE_LEASES_CODE`) and the sentence (`leasesBlockingMessage`)
   * all come from the shared port module; nothing here restates any of them, which
   * is what keeps the two faces from drifting.
   *
   * It runs before `closeResidentHost` because the close clears the binding's
   * leases: a check placed after it could no longer read what the host was holding.
   * The ordering also matches the MCP handler exactly, so "refuse first, then
   * delegate" is one shape on both transports.
   *
   * `force` is read with `!== true`, spelled the same way the MCP reader spells it:
   * only a literal boolean `true` authorises the close, so an absent field, `false`,
   * or a string `"true"` all leave the leases blocking. A truthiness test here would
   * let `"true"` through — the one reading on which the two transports would differ.
   */
  router.post('/:sessionId/close', (request: Request, response: Response) => {
    const sessionId = routeParameter(request.params.sessionId);
    const force = (request.body as { force?: unknown } | undefined)?.force;

    const live = readLiveHost(sessionHostManager, sessionId);
    if (live?.mode === 'resident') {
      const blocking = blockingLeases(live.leases);
      if (blocking.length > 0 && force !== true) {
        sendRefusal(response, 409, SESSION_HAS_ACTIVE_LEASES_CODE, leasesBlockingMessage(blocking));
        return;
      }
    }

    const result = closeResidentHost(sessionId, {
      sessionHostManager,
      readSession,
      resolveHostDriver,
      startResidentSession,
    });

    if (!result.ok) {
      sendRefusal(response, result.status, result.code, result.message);
      return;
    }

    response.json(
      createApiSuccessResponse({
        hostId: result.hostId,
        sessionId: result.sessionId,
        mode: result.mode,
        closeReason: result.closeReason,
      }),
    );
  });

  return router;
}

/**
 * One refusal, in the shape the application's error middleware produces.
 *
 * Written here rather than thrown as an `AppError` because this router is
 * mounted on its own by criteria that add no error middleware — the listing
 * criterion mounts the production error handler after it, but the resident
 * criterion mounts only `express.json()` — so a thrown error would reach a
 * client as an unhandled stack. Answering in place makes the refusal readable
 * wherever the router is mounted, and the object shape is deliberate: the code
 * is the part a client branches on, and a string body would leave it to prose.
 */
function sendRefusal(
  response: Response,
  status: number,
  // The lease refusal's code lives in the shared port module (the `force` gate is
  // the caller's policy, deliberately not a session-hosts invariant), so the union
  // widens by exactly that one literal rather than adding it to the shared
  // `LifecycleModeErrorCode` vocabulary — the service's own refusals keep that
  // closed set.
  code: LifecycleModeErrorCode | typeof SESSION_HAS_ACTIVE_LEASES_CODE,
  message: string,
): void {
  response.status(status).json({ success: false, error: { code, message } });
}

/**
 * One path parameter as a string.
 *
 * Express types a route parameter as `string | string[]` (a repeated parameter
 * arrives as a list), and a session id is never a list here — the route names one
 * segment. Taking the first element is the same reading the plugins router makes
 * of its own parameters; an empty string then falls through to the same "no such
 * host" answer as an unknown id.
 */
function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

/** Projects one manager record into the wire shape above. */
function toHostView(host: ProcessHost): HostView {
  return {
    hostId: host.hostId,
    provider: host.provider,
    mode: host.mode,
    state: host.state,
    pid: host.pid,
    startedAt: host.startedAt,
    closeReason: host.closeReason,
    closeDetail: host.closeDetail ?? null,
    bindings: [...host.bindings.values()].map(toBindingView),
  };
}

/**
 * Projects one session and whether anything is serving it.
 *
 * The reason is filled only for the one combination that is a *finding* — a
 * session stored as resident with nothing running it. Everything else is null,
 * and each null says something different: a running session's question does not
 * arise, and a per-run session's process belongs to its turn, so its absence
 * between turns is the design rather than news. Filling the field for those
 * cases would make it non-empty on every row and therefore worth nothing to a
 * client trying to find the sessions a restart dropped.
 */
function toSessionHostStateView(
  session: SessionHostStateReading,
  running: Set<string>,
  occupancy: Map<string, SessionOccupiedBy> | null,
): SessionHostStateView {
  const isRunning = running.has(session.appSessionId);
  const providerSessionId = session.providerSessionId ?? null;

  return {
    appSessionId: session.appSessionId,
    provider: session.provider,
    lifecycleMode: session.mode,
    running: isRunning,
    reason: !isRunning && session.mode === 'resident' ? RESIDENT_NOT_RUNNING_REASON : null,
    occupiedBy:
      session.provider === 'claude' && providerSessionId
        ? occupancy?.get(providerSessionId) ?? null
        : null,
  };
}

/**
 * Projects one session on a host. Leases are copied by `snapshot()` already.
 *
 * The held-work leases are re-projected so `since` is guaranteed on the wire.
 * `addLease` stamps it, but the projection is where the client's contract is
 * fixed, and a reader that has to branch on whether the field arrived would be
 * reading a shape that varies — so an absent instant falls back to the binding's
 * own `lastActivityAt`, which is the instant the manager last touched it and is
 * never later than the hold. `cron` and the two lifetime kinds pass through
 * untouched: `cron` carries its own schedule and the others carry no clock.
 */
function toBindingView(binding: SessionBinding): BindingView {
  return {
    appSessionId: binding.appSessionId,
    providerSessionId: binding.providerSessionId,
    state: binding.state,
    leases: binding.leases.map((lease) => {
      if (lease.kind !== 'background-task' && lease.kind !== 'monitor') {
        return lease;
      }
      return { ...lease, since: typeof lease.since === 'number' ? lease.since : binding.lastActivityAt };
    }),
    lastActivityAt: binding.lastActivityAt,
    peerName: binding.peerName,
  };
}
