/**
 * The MCP gateway's `session_start` / `session_close` handlers (AC-251).
 *
 * These two stage-4 write tools start and stop a session's resident host. They
 * are ADAPTERS and nothing more: the whole of "should this session start" — no
 * such session, a host already serving it in another mode, a stored preference
 * that is not residential, a provider with no host driver, and "already running
 * is a success" — lives in the session-hosts module's `startResidentHost` /
 * `closeResidentHost` (AC-236), and this file delegates to those two functions
 * through {@link McpSessionHostDeps.hosts} rather than re-deriving any of it.
 * That delegation is the point: a second copy of the start/close decision inside
 * the gateway is exactly what this task exists to prevent, and the criterion's
 * spy counts (the service was reached on every call; the driver launched once)
 * are the mechanical evidence.
 *
 * What this file DOES own is the one decision the service deliberately does not
 * make: the `force` gate. `closeResidentHost` closes a live resident host
 * unconditionally — it reads the binding's leases back only to REPORT them — so
 * a caller that wants "refuse while a cron or background-task lease is held" has
 * to ask BEFORE it delegates. That ordering is load-bearing: once the host is
 * closed its leases are gone (the manager clears them on teardown), and a check
 * placed after the close could no longer read "the host is still running". The
 * gate therefore runs first, and its refusal is a structured error the caller
 * can branch on, naming the lease kinds and how many of each are held.
 *
 * Everything the services need is injected ({@link McpSessionHostDeps}): the
 * `hosts.start` / `hosts.close` pair (production: {@link createSessionHostControl}
 * over the session-hosts barrel), and a read-only `liveHost` port that answers
 * the `force` gate's one question — is a resident host serving this session, and
 * what is it holding. `liveHost` reads `snapshot()` for the same reason the
 * service's own `liveHostForSession` does: it is the manager's published read
 * port, and a `closed` host is skipped so the gate never blocks a close that has
 * already happened. It starts nothing and closes nothing.
 */

import { z } from 'zod';

import type { HostLease } from '@/shared/types.js';
// The lease judgement is owned by the shared layer, not by this module. It is
// re-exported below so the gateway barrel (and the criteria that read it) keep
// the names they always had; `modules/session-hosts/session-hosts.routes.ts`
// imports the same definitions directly from `@/shared/ports`, which is what
// removes the `session-hosts -> mcp-gateway` edge that used to close the init
// cycle. Nothing here reaches the session-hosts module for this judgement.
import {
  blockingLeases,
  leasesBlockingMessage,
  readLiveHost,
  SESSION_HAS_ACTIVE_LEASES_CODE,
} from '@/shared/ports/session-host-control.port.js';
import type { SessionHostControlPort } from '@/shared/ports/session-host-control.port.js';
// Re-exported from the shared port so the gateway barrel and every existing
// consumer keep the names they had. The definitions — and the comments that
// explain the lease judgement — live in the port file.
export {
  blockingLeases,
  leasesBlockingMessage,
  readLiveHost,
  SESSION_HAS_ACTIVE_LEASES_CODE,
} from '@/shared/ports/session-host-control.port.js';
import {
  closeResidentHost,
  sessionHostManager,
  startResidentHost,
} from '@/modules/session-hosts/index.js';
import type {
  ResidentHostServiceDeps,
  SessionHostManager,
} from '@/modules/session-hosts/index.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';

// --------------------------- injected services ---------------------------

/**
 * The services `session_start` / `session_close` answer from, all injected.
 *
 * The control surface itself is the shared {@link SessionHostControlPort}: the
 * contract belongs to the seam between the two modules, not to the gateway, so
 * the session-hosts routes can share the lease judgement without importing this
 * module. The alias keeps the gateway's own type name (and every criterion that
 * cites it) stable.
 */
export type McpSessionHostControl = SessionHostControlPort;

/** The services `session_start` / `session_close` answer from, all injected. */
export type McpSessionHostDeps = {
  hosts: McpSessionHostControl;
};

// --------------------------- input and payload ---------------------------

/** The `session_start` tool's typed input. */
export type McpSessionStartInput = {
  /** The session to start; the transport's target gate resolves a name to an id first. */
  session: string;
};

/** The `session_close` tool's typed input. */
export type McpSessionCloseInput = {
  /** The session to close; the transport's target gate resolves a name to an id first. */
  session: string;
  /**
   * Close even while the session holds `cron` / `background-task` leases. Absent
   * (or `false`) turns those leases into a refusal; `true` authorises the close.
   */
  force?: boolean;
};

/** The `session_start` tool's Zod input shape, used for registration and validation. */
export const SESSION_START_INPUT_SCHEMA = {
  session: z.string(),
} satisfies z.ZodRawShape;

/**
 * The `session_close` tool's Zod input shape.
 *
 * `force` is the one field this task ADDS to a stage-4 tool's arguments. It is an
 * input field and not a new tool: the name set and every tool's scope still come
 * from `MCP_STAGE4_WRITE_TOOLS`, and the self-referential guard (AC-252) reads
 * that same table.
 */
export const SESSION_CLOSE_INPUT_SCHEMA = {
  session: z.string(),
  force: z.boolean().optional(),
} satisfies z.ZodRawShape;

/**
 * The `session_start` result: the resident host now serving the session.
 *
 * `mode` is the literal `'resident'` and `pid` is nullable for the same reasons
 * the service's own {@link ResidentHostStartOutcome} states them — the adapter
 * forwards the outcome's fields verbatim rather than re-shaping them.
 */
export type SessionStartPayload = {
  hostId: string;
  sessionId: string;
  mode: 'resident';
  pid: number | null;
};

/**
 * The `session_close` result: the host that was closed, why, and the leases its
 * binding held when it was.
 *
 * `closeReason` is the service's own `'user'` and `leases` is the reading the
 * service hands back — the same value the HTTP route keeps off its wire but that
 * a caller deciding whether a close was safe needs.
 */
export type SessionClosePayload = {
  hostId: string;
  sessionId: string;
  mode: 'resident';
  closeReason: 'user';
  leases: HostLease[];
};

/** Reads and validates `session_start`'s arguments. */
export function readSessionStartInput(args: Record<string, unknown>): McpSessionStartInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  return { session };
}

/** Reads and validates `session_close`'s arguments. */
export function readSessionCloseInput(args: Record<string, unknown>): McpSessionCloseInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  // Only a literal `true` authorises the force-close; anything else (including a
  // missing field) leaves the leases blocking, so the safe reading is the default.
  return { session, force: args.force === true };
}

// --------------------------- buildSessionStart ---------------------------

/**
 * Starts the resident host for `input.session`, returning the live host.
 *
 * The decision is the service's: `deps.hosts.start` is `startResidentHost`, and
 * its success arm is forwarded verbatim (so a session that already has a live
 * resident host answers with the SAME host and pid — "start" is a request for a
 * state, and the state is already the one asked for). A refusal is thrown as a
 * JSON-bodied error carrying the service's own `code` and `message` UNCHANGED,
 * which both registration seams render as an `isError` result: the gateway adds
 * no vocabulary of its own, so `LIFECYCLE_MODE_NOT_RESIDENT` /
 * `LIFECYCLE_MODE_HOST_UNAVAILABLE` / `SESSION_NOT_FOUND` reach the caller with
 * the sentence the HTTP route would have answered.
 *
 * Consumers: `registerMcpWriteTools` (the registered handler) and this module's
 * criterion, which drives it through the real mount.
 */
export async function buildSessionStart(
  input: McpSessionStartInput,
  _ctx: { principal: McpPrincipal },
  deps: McpSessionHostDeps,
): Promise<SessionStartPayload> {
  const outcome = await deps.hosts.start(input.session);
  if (!outcome.ok) {
    throw new McpToolError(outcome.code, outcome.message);
  }
  return {
    hostId: outcome.hostId,
    sessionId: outcome.sessionId,
    mode: outcome.mode,
    pid: outcome.pid,
  };
}

// --------------------------- buildSessionClose ---------------------------

/**
 * Closes the resident host serving `input.session`, or refuses while it holds
 * background work.
 *
 * The `force` gate runs FIRST and, when it fires, `deps.hosts.close` is never
 * called — the host is still running, which is the whole point of the refusal.
 * The gate is skipped for a live host in a non-resident mode (`live.mode !==
 * 'resident'`), so a per-run host is left to the service's own
 * `LIFECYCLE_MODE_NOT_RESIDENT` rather than being masked by a lease decision
 * about a mode that cannot hold these leases. When the gate passes, the close is
 * the service's — success forwards its `closeReason` and `leases` verbatim, and a
 * refusal forwards its `code`/`message` unchanged.
 *
 * Consumers: `registerMcpWriteTools` (the registered handler) and this module's
 * criterion, which drives it through the real mount and reads the host's pid
 * before and after a refused close.
 */
export function buildSessionClose(
  input: McpSessionCloseInput,
  _ctx: { principal: McpPrincipal },
  deps: McpSessionHostDeps,
): SessionClosePayload {
  const live = deps.hosts.liveHost(input.session);
  if (live?.mode === 'resident') {
    const blocking = blockingLeases(live.leases);
    if (blocking.length > 0 && input.force !== true) {
      throw new McpToolError(SESSION_HAS_ACTIVE_LEASES_CODE, leasesBlockingMessage(blocking), false, {
        leases: blocking,
      });
    }
  }

  const outcome = deps.hosts.close(input.session);
  if (!outcome.ok) {
    throw new McpToolError(outcome.code, outcome.message);
  }
  return {
    hostId: outcome.hostId,
    sessionId: outcome.sessionId,
    mode: outcome.mode,
    closeReason: outcome.closeReason,
    leases: outcome.leases,
  };
}

// --------------------------- default wiring over the session-hosts barrel ---------------------------

/**
 * The production `hosts` control: the session-hosts module's own start/close
 * services over the injected service deps, plus {@link readLiveHost} over the
 * same manager.
 *
 * This is the one place the MCP gateway reaches the session-hosts module, and it
 * reaches it through the barrel's exported functions rather than a private copy.
 * The service deps are the composition root's (AC-253): the process-wide
 * `sessionHostManager`, the session-row reader, the host-driver resolver, and the
 * resident-launch seam. When none are given the defaults are the read-only half —
 * the process manager — which is enough for `liveHost` and the idempotent start
 * path but STARTing or CLOSing a fresh session needs the other three, so a real
 * wiring supplies them.
 *
 * Consumers: `server/index.ts` (via AC-253) and this module's criterion.
 */
export function createSessionHostControl(
  serviceDeps: ResidentHostServiceDeps = { sessionHostManager },
): McpSessionHostDeps {
  return {
    hosts: {
      start: (sessionId) => startResidentHost(sessionId, serviceDeps),
      close: (sessionId) => closeResidentHost(sessionId, serviceDeps),
      liveHost: (sessionId) => readLiveHost(serviceDeps.sessionHostManager, sessionId),
    },
  };
}
