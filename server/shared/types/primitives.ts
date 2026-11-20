/**
 * The shared type tree's PRIMITIVE vocabulary: the three unions the event,
 * session and launch contracts all name.
 *
 * This file is a LEAF by construction — it imports nothing, from this directory
 * or anywhere else. That is the whole reason it exists. Until
 * `gap-routine-architecture-analysis-cycle-shared-types-type-only-3` the unions
 * lived in `claude-events.ts` / `cli-session.ts`, which made
 * `claude-events → cli-session → provider-launch → claude-events` an
 * intra-package file cycle closed entirely by `import type` edges (plus
 * `provider-launch → cli-session` for `HostMode`). `import type` is still a
 * compile dependency, so every consumer of any one of the three contracts
 * compiled all three, and the directory-level ratchet could not see it because
 * all three files live in one directory.
 *
 * The fix is the usual one-way leaf: the event, session and launch modules each
 * point HERE, and this module points at nothing, so the package's file graph is
 * acyclic. `server/shared/tests/server-import-cycle-budget.test.ts` case (k)
 * pins that reading (synthetic type-only cycle + the real package).
 */

/**
 * Who asked for one provider run.
 *
 * `user` is a turn a human sent from a client; `scheduled` is one a timer
 * fired (the scheduled-messages dispatcher); `unattended` is one the
 * session-host layer opened by itself, with no request and no socket behind
 * it. The fact is recorded on the run rather than inferred later from the
 * absence of a connection, because "no connection" is equally true of a
 * scheduled run — and a run opened by a host driver must be distinguishable
 * from both.
 *
 * `mcp` is one the MCP gateway opened on a tool call. It too has no socket
 * behind it, so it shares the no-connection shape with `scheduled` and
 * `unattended`: which of the three a run is has to come from this recorded
 * value, never from whether a connection happens to be attached.
 *
 * `voice` is one the Live Voice relay opened when a spoken sentence settled. It
 * reaches the control service through the MCP gateway's own `session_send`
 * builder, but it is deliberately NOT `mcp`: a spoken delivery is not a command
 * a person can withdraw, and the activity channel's clients read this value to
 * decide whether a delivery row is theirs to draw (see `src/shared/types.ts`'s
 * `ActivityDeliverySource`). Keeping it a distinct member is what lets a voice
 * delivery reach the transcript without becoming a pending command row.
 *
 * Read by `chatRunRegistry` (which stamps it at `startRun` and exposes it on
 * the run record) and by the debug agent's host-driver criterion.
 */
export type ChatRunSource = 'user' | 'scheduled' | 'unattended' | 'mcp' | 'voice';

/**
 * Where one queued user message is in the CLI's own lifecycle.
 *
 * `queued` and `started` are the two facts that separate "still withdrawable"
 * from "already running"; `cancelled` is the only evidence a withdrawal worked
 * (the CLI answers a `cancel_async_message` control frame with no
 * `control_response` at any timing, so the queue's own account of the message is
 * the verdict — `docs/proposals/claude-resident-sessions-experiments.md` §9.2);
 * `completed` is the turn having run to its end.
 */
export type CommandLifecycleState = 'queued' | 'started' | 'cancelled' | 'completed';

/**
 * How long one host process is meant to live.
 *
 * `per-run` is the default for every provider: the process exists for exactly
 * one turn, so the application has no handle on it between turns. `resident`
 * is the Claude-only mode in which one process serves many turns, which is what
 * `HostLease` records are for.
 */
export type HostMode = 'per-run' | 'resident';
