/**
 * The neutral contract between the MCP gateway and the session-hosts module.
 *
 * WHY THIS FILE EXISTS. The gateway's `session_start` / `session_close` handlers
 * and the session-hosts REST close route apply ONE lease judgement: which leases
 * block a close, the sentence a refusal carries, the structured code it carries,
 * and how the live host is read. Before this port the judgement lived in
 * `modules/mcp-gateway/mcp-session-host-control.ts`, so the session-hosts routes
 * imported the gateway to reach it — `session-hosts -> mcp-gateway` — and that
 * edge, together with the gateway's own use of the session-hosts barrel, formed
 * a two-module initialization cycle. A static import cycle constrains the order
 * the two modules may evaluate in; a new import on either side can turn it into
 * `ReferenceError: Cannot access ... before initialization` at process start.
 *
 * The lease judgement itself never needed the gateway: it reads `HostLease` and
 * `HostMode` (both shared vocabulary) and one manager read. It therefore belongs
 * here, in the shared layer both modules may import without re-entering each
 * other. The MCP gateway re-exports these names from
 * `mcp-session-host-control.ts`, so its own barrel and its criteria keep the
 * public surface they had; the session-hosts route imports this file directly.
 *
 * Consumers: `modules/mcp-gateway/mcp-session-host-control.ts` (the `force` gate
 * and its re-exports) and `modules/session-hosts/session-hosts.routes.ts` (the
 * REST close route). Importing this file creates no module edge in either
 * direction.
 */
import type { HostLease, HostMode } from '@/shared/types.js';

// --------------------------- the control contract ---------------------------

/**
 * The outcome of a resident start as the gateway consumes it: the live host, or
 * the service's refusal forwarded unchanged.
 *
 * Declared structurally rather than by importing the session-hosts module's own
 * `ResidentHostStartOutcome`: this file is the shared layer, and a shared ->
 * module import would be the very edge the port exists to remove. The shape is
 * byte-for-byte the service's union; a divergence is a type error at the
 * injection site in `server/index.ts`, which is where the two are joined.
 */
export type SessionHostStartReading =
  | { ok: true; hostId: string; sessionId: string; mode: 'resident'; pid: number | null }
  | { ok: false; status: number; code: string; message: string };

/**
 * The outcome of a resident close as the gateway consumes it: the closed host
 * with the leases it held, or the service's refusal.
 *
 * Same structural rule as {@link SessionHostStartReading}. `leases` is present on
 * the success arm because the gateway's payload reports what the close ended.
 */
export type SessionHostCloseReading =
  | {
      ok: true;
      hostId: string;
      sessionId: string;
      mode: 'resident';
      closeReason: 'user';
      leases: HostLease[];
    }
  | { ok: false; status: number; code: string; message: string };

/**
 * The one host-control surface the MCP gateway answers `session_start` /
 * `session_close` from.
 *
 * `start` / `close` are the session-hosts service verbs; `liveHost` is the
 * read-only view the `force` gate reads before it delegates. Every method is
 * injected at the gateway's construction (`server/index.ts` passes
 * `createSessionHostControl(...)`), so this module never imports the service and
 * the service never imports the gateway.
 */
export type SessionHostControlPort = {
  start(sessionId: string): Promise<SessionHostStartReading>;
  close(sessionId: string): SessionHostCloseReading;
  liveHost(sessionId: string): { mode: HostMode; leases: HostLease[] } | null;
};

// --------------------------- the shared lease judgement ---------------------------

/**
 * The structured refusal code `session_close` raises when a lease blocks it.
 *
 * Exported from the shared layer so both transports spell the code once. It is
 * deliberately not a member of `LifecycleModeErrorCode`: the `force` gate is the
 * caller's policy, not a session-hosts invariant, and widening that closed set
 * would claim otherwise.
 */
export const SESSION_HAS_ACTIVE_LEASES_CODE = 'SESSION_HAS_ACTIVE_LEASES';

/**
 * The leases a resident close must honour: the two kinds that mean background
 * work, in a fixed order.
 *
 * This is the single definition of the "is this session blocked" judgement. The
 * MCP `session_close` handler and the session-hosts REST route both call it, so
 * the two transports cannot drift into disagreeing about which leases block a
 * close. The judgement is one line because the *set* of blocking kinds is the
 * contract; the `force` / `!== true` reading that pairs with it lives at each
 * call site (both spell it the same way).
 */
export function blockingLeases(leases: HostLease[]): HostLease[] {
  return leases.filter((lease) => lease.kind === 'cron' || lease.kind === 'background-task');
}

/**
 * The sentence a lease-blocked close carries, naming every blocking kind and how
 * many of it are held.
 *
 * The message names WHAT blocks the close and HOW MANY of each, because "held by
 * a lease" alone leaves the caller unable to tell a single cron from a queue of
 * background tasks — and the whole value of the refusal is that the caller can
 * decide whether `force: true` is warranted. Order follows the fixed
 * `cron`-then-`background-task` order of {@link blockingLeases} so the sentence
 * is stable for a given lease set.
 */
export function leasesBlockingMessage(blocking: HostLease[]): string {
  const counts = new Map<string, number>();
  for (const lease of blocking) {
    counts.set(lease.kind, (counts.get(lease.kind) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([kind, count]) => `${kind}×${count}`);
  return `This resident session holds ${parts.join(', ')}; closing it would end that background work — pass force: true to close anyway.`;
}

/**
 * The subset of the session-hosts manager {@link readLiveHost} needs.
 *
 * Structural for the same reason the outcomes above are: naming the manager type
 * would import the session-hosts module into the shared layer. `ProcessHost`
 * satisfies it directly — `bindings` is a `Map<string, SessionBinding>` and a
 * `SessionBinding` carries `leases` — so production passes the manager with no
 * adapter.
 */
export type SessionHostLiveReader = {
  liveHostForSession(sessionId: string): {
    mode: HostMode;
    bindings: ReadonlyMap<string, { leases: HostLease[] }>;
  } | null;
};

/**
 * The read-only port the `force` gate reads, over a manager's published view.
 *
 * Delegates to the manager's own `liveHostForSession` — the same call the
 * service makes — then projects down to `{mode, leases}`, so "the gate sees the
 * same host the service would close" is now literally one call, not two
 * implementations kept in step. Reads only: it starts no host and closes none.
 */
export function readLiveHost(
  manager: SessionHostLiveReader,
  sessionId: string,
): { mode: HostMode; leases: HostLease[] } | null {
  const host = manager.liveHostForSession(sessionId);
  if (!host) {
    return null;
  }
  return { mode: host.mode, leases: host.bindings.get(sessionId)?.leases ?? [] };
}
