import type { ChatRunSource, CommandLifecycleState } from './primitives.js';

// ---------------------------------------------------------------------------
// The resident ledger's own types (SPEC `resident-delivery-turn-ledger` §5).
//
// These cross one module edge and one only: `modules/resident-ledger` owns
// their transitions and the driver holds one ledger per host as the read-only
// view declared at the end of this group. They are stated here rather than in
// the driver because they sit on both sides of that edge, which is the same
// "two or more consumers" rule the rest of this file follows.
//
// The view is READ-ONLY by construction: every field is `readonly`, every
// collection is a `Readonly*` one. A module outside the ledger cannot write a
// ledger field at all — not by convention, but because the type refuses — which
// is what makes "the ledger has one writer" (I6) a fact about the compiler
// rather than a rule a reviewer has to hold.
// ---------------------------------------------------------------------------

/**
 * Whether a delivery has reached the one terminal the CLI states for it (C-1).
 *
 * The single definition of "this command is over", so the settled test, the
 * owed test and the anomaly reconciliation cannot drift apart: a delivery is
 * done exactly when it is `completed` or `cancelled`, and nothing else counts.
 */
export function isTerminalDeliveryState(state: ClaudeResidentDeliveryState): boolean {
  return state === 'completed' || state === 'cancelled';
}

/**
 * Where one accepted send has got to, as the CLI states it.
 *
 * The state a delivery is in is written by exactly one thing: the CLI's own
 * `command_lifecycle` (`queued` → `started` → `completed`|`cancelled`). A send
 * the host has written but the CLI has not yet reported is `pushed`, which is
 * this driver's own mark and the reason the ledger has a state the CLI's
 * vocabulary does not carry.
 */
export type ClaudeResidentDeliveryState = 'pushed' | 'queued' | 'started' | 'completed' | 'cancelled';

/**
 * Why a delivery or a turn ended in a way that was not a clean completion.
 *
 * `cli` is the residual: the CLI stated a terminal this driver never asked for,
 * which is the ordinary result of a turn that simply finished. The rest are the
 * ends somebody here caused or reconciled: a withdrawal this host requested, an
 * interrupt it requested, the process going away, and the reconciliation of a
 * command whose terminal never arrived (I4).
 */
export type ClaudeResidentDeliveryReason =
  | 'withdrawn'
  | 'interrupt'
  | 'process-exit'
  | 'owed-terminal-missing'
  | 'cli';

/**
 * One delivery: one accepted send, and the run its dispatcher is awaiting.
 *
 * The identity is the CLI's, not this driver's: `commandUuid` is the value the
 * CLI reports back in `command_lifecycle`, and every frame of the send is
 * recorded under it so a lifecycle event finds the delivery it belongs to
 * whatever frame the CLI chose to name. Nothing here is inferred from a
 * position in a list.
 *
 * NOTHING DRIVER-SHAPED IS HERE (AC-395 (d)): the round a delivery's dispatcher
 * is awaiting, the lease it holds and the run writer its terminal frame goes to
 * are the driver's own bookkeeping, kept driver-side and indexed by
 * `commandUuid`. The ledger records what the CLI said and nothing about how
 * this process is wired.
 */
export type ResidentLedgerDelivery = {
  /** The uuid this delivery is addressed by — the last frame's, which is the prompt. */
  readonly commandUuid: string;
  /** Every frame uuid this one send wrote (an attachment expansion writes several). */
  readonly uuids: readonly string[];
  readonly state: ClaudeResidentDeliveryState;
  readonly reason: ClaudeResidentDeliveryReason | null;
  /**
   * Who asked for this send — the same origin vocabulary the run records use.
   *
   * Read at the send from the dispatch's own statement (the runtime option the
   * websocket dispatch writes under the run=turn flag) rather than inferred here:
   * a timeline, the MCP gateway and a person's socket all reach this driver
   * through the same entry, so only the caller can say which of them it was, and
   * `user` is the honest default for a caller that stated nothing (SPEC §4.1, §6.1).
   */
  readonly source: ChatRunSource;
  /**
   * The command's own words, kept for the activity channel's live rows only.
   *
   * Bounded at read time rather than here (`DELIVERY_TEXT_MAX_CHARS`) because the
   * transcript is the authoritative full text and this copy exists for a queued
   * row's sake; it is dropped from the projection as soon as the delivery ends.
   */
  readonly text: string;
  /** The turn the CLI bound this command to (C-2), or null while it is bound to none. */
  readonly turnId: string | null;
  /**
   * The run the delivery's turn is executing as (SPEC §5.2), or null.
   *
   * Written when the turn binds, so a caller holding only a `deliveryId` can
   * learn the run without a session to look it up under. It stays readable after
   * the turn has closed, which the driver's own open-turn binding cannot be —
   * that field is the OPEN turn's binding and is cleared at `RESULT`, while a
   * delivery's terminal may arrive later (C-3).
   */
  readonly runId: string | null;
  /**
   * Whether the dispatcher that sent this delivery is still awaiting its run.
   *
   * Cleared when the run is settled — at its turn's close, which is the moment
   * the run's terminal frame is written. It is deliberately NOT the same thing
   * as `state`: C-3 makes the CLI's terminal and the turn's `RESULT` two
   * independent events, so a delivery can be terminal while its run is still
   * open (folded command) or open while its terminal has not been read (a
   * first command whose `completed` follows its `RESULT`).
   */
  readonly runOpen: boolean;
  /**
   * True when the run closed while the CLI had not yet stated a terminal (I4).
   *
   * This is the cross-check the order-independence of §5.3 rests on: an owed
   * delivery is expected to receive its terminal before the next turn begins,
   * and one that does not is settled `cancelled(owed-terminal-missing)` and
   * recorded as an anomaly rather than left quietly non-terminal.
   */
  readonly owed: boolean;
  /** True when this host asked the CLI to withdraw the command. */
  readonly withdrawalRequested: boolean;
  readonly enqueuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly priority: string | null;
};

/**
 * The turn the CLI is working on, as the ledger sees it.
 *
 * Minted at `system/init` and closed at `RESULT` — the two moments the CLI
 * itself states a turn boundary with (C-6: there is no `session_state_changed`).
 */
export type ResidentLedgerTurn = {
  readonly id: string;
  /**
   * Whether anybody at this end sent the command that opened it.
   *
   * Read at the `init` from the commands already waiting to be bound: a turn
   * whose opener this host pushed is `delivered`, and one nothing here pushed is
   * `unattended` — the CLI's own cron or background follow-up, which no caller
   * holds a handle for (I5).
   */
  readonly kind: 'delivered' | 'unattended';
  readonly open: boolean;
  /** The delivery the turn's frames belong to: the earliest command it bound. */
  readonly ownerDeliveryId: string | null;
  /** Whether this host has asked the CLI to interrupt, so its `RESULT` reads `aborted`. */
  readonly interruptRequested: boolean;
};

/** One turn that has closed, with the terminal it read (SPEC §5.1). */
export type ResidentLedgerClosedTurn = {
  readonly id: string;
  readonly kind: 'delivered' | 'unattended';
  readonly outcome: 'completed' | 'aborted';
  readonly ownerDeliveryId: string | null;
};

/**
 * The ledger's own account of a state it could not make consistent.
 *
 * Recorded rather than thrown: a stream that breaks one of the CLI's rules is a
 * fact about the CLI, and ending the read loop over it would take the whole
 * process down on a frame the CLI is entitled to send.
 */
export type ResidentLedgerAnomaly = {
  readonly code: string;
  readonly detail: string;
};

/**
 * One host's delivery/turn ledger, as its owner hands it out: a READ-ONLY VIEW.
 *
 * This is the whole of the host's own account of what it sent and what the CLI
 * said came of it. Every state in it is written by an event the CLI or this
 * driver caused — never by a position in a list, a count of results, or an
 * inference from how many turns have ended. Its other readers (the manager's
 * leases, the registry's runs, this driver's own readings) are projections of
 * it, recomputed rather than balanced by hand.
 *
 * The view is what the driver holds and passes back to the ledger's own
 * transitions; the transition functions in `modules/resident-ledger` are the
 * only writers, and they are the only place the mutable shape exists.
 */
export type ResidentLedger = {
  /** Every delivery this host has sent, in send order. */
  readonly deliveries: readonly ResidentLedgerDelivery[];
  /** The same deliveries, addressed by any frame uuid they wrote. */
  readonly byUuid: ReadonlyMap<string, ResidentLedgerDelivery>;
  /**
   * Commands the CLI started under a uuid nothing here pushed.
   *
   * The CLI's own cron firings carry a `started` this host never wrote (E9
   * §9.4). They are kept so the ledger can say which commands were not its own
   * — the cross-check an unattended turn's `init` is read against (I5) — and
   * they are deliberately **not** deliveries: no caller holds a handle, so
   * there is nothing to report to and nothing to expose. Nothing here projects
   * them either: S1 leaves the host's busy surface exactly as it was (N-1), and
   * a foreign command's own terminal is the CLI's business rather than this
   * ledger's.
   */
  readonly foreign: ReadonlySet<string>;
  /** The turn the CLI is working on, or the one most recently closed. */
  readonly turn: ResidentLedgerTurn | null;
  /** Every turn that has closed, in order, with the terminal it read. */
  readonly closedTurns: readonly ResidentLedgerClosedTurn[];
  /** Commands the CLI started while no turn was open, waiting for the next one. */
  readonly pendingStart: readonly ResidentLedgerDelivery[];
  /** The ledger's own account of the states it could not make consistent. */
  readonly anomalies: readonly ResidentLedgerAnomaly[];
};

/**
 * The dialect's own name for the row that carries one command lifecycle fact.
 *
 * The name is the claude transcript dialect's, not this codebase's: the row is
 * what the CLI writes into a transcript and what the host reads back off the
 * stream, and both envelopes the CLI uses (`type: 'command_lifecycle'` and
 * `type: 'system'` with this subtype) are spelled with it
 * (`docs/proposals/claude-resident-sessions-experiments.md` §9.2).
 *
 * Exported as a value, and not as prose the producers each retype, because the
 * string sits on both sides of the row → frame edge: the normalizer recognises
 * the row by it, and the client-visible kind that row normalizes to carries the
 * same name in `MessageKind`. A producer that must write the row *without*
 * naming a frame — the debug agent is one, and its static guard forbids wire
 * names in its own sources
 * (`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`) —
 * references the dialect's name here instead of embedding the literal.
 */
export const COMMAND_LIFECYCLE_ROW_TYPE = 'command_lifecycle';

/**
 * The claude dialect's own names for the two content blocks a tool call is made
 * of: the `tool_use` block an assistant row carries, and the `tool_result` block
 * the paired user row answers it with.
 *
 * Exported for the same reason {@link COMMAND_LIFECYCLE_ROW_TYPE} is: the
 * strings sit on the row → frame edge, and a producer that is forbidden from
 * naming a frame in its own sources — the debug agent is one, and its static
 * guard rejects the literals `tool_use` / `tool_result` outright
 * (`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`) —
 * references the dialect's name here rather than embedding the literal. The
 * normalizer recognises the blocks by these same strings.
 */
export const CLAUDE_TOOL_USE_BLOCK_TYPE = 'tool_use';
export const CLAUDE_TOOL_RESULT_BLOCK_TYPE = 'tool_result';

/**
 * The claude dialect's four `system` subtypes a background task's lifecycle is
 * carried by: the task table's reducer (AC-191,
 * `claude-activity-task-reducer.service.ts`) reads each one off the raw frame.
 *
 * Exported for the same reason {@link COMMAND_LIFECYCLE_ROW_TYPE} is: the strings
 * sit on the row → frame edge, and a producer forbidden from naming a frame in
 * its own sources — the debug agent, whose static guard lists `task_notification`
 * as a forbidden wire literal
 * (`server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts`) —
 * references the dialect's name here instead of embedding the literal. The
 * reducer recognises the frames by these same strings.
 */
export const CLAUDE_TASK_STARTED_SUBTYPE = 'task_started';
export const CLAUDE_TASK_PROGRESS_SUBTYPE = 'task_progress';
export const CLAUDE_TASK_UPDATED_SUBTYPE = 'task_updated';
export const CLAUDE_TASK_NOTIFICATION_SUBTYPE = 'task_notification';

/**
 * The option the chat transport stamps on every turn it dispatches, marking the
 * dispatch as one whose `command` is a message somebody composed.
 *
 * A provider runtime receives turns from more than one place. The chat transport
 * is the one that carries a person's message: `chat-websocket.service.ts` builds
 * the options bag for every `chat.send` / `chat.edit-send`, and for the detached
 * turns a scheduled message fires. Everything else that reaches a runtime — the
 * debug agent's own control plane driving an armed scenario, a launch-option
 * probe — carries a *label* in `command` rather than a message, and must not be
 * recorded as though somebody had sent it.
 *
 * Stated by the transport rather than inferred by the reader, because the two
 * dispatch shapes are otherwise identical: the runtime sees the same entry, the
 * same option keys, and (in the debug agent's case) the same session, and only
 * the sender knows which of the two it is. A provider that writes a turn's own
 * row — the debug agent is the one that does, since its "process" runs a
 * scenario rather than a CLI that would record the prompt itself — reads this
 * flag to decide whether the command is worth recording.
 *
 * Absent means "not a chat turn", so a dispatch from an internal driver writes
 * no user row by default. The direction matters: manufacturing a user row out of
 * a driver's label invents a message nobody sent, while failing to write one for
 * a chat turn is the gap this flag exists to close.
 */
export const CHAT_TURN_OPTION = 'chatTurn';

/**
 * One `command_lifecycle` event the CLI emitted for a queued user message.
 *
 * `commandUuid` is the uuid the *host* assigned when it wrote the frame — the
 * CLI echoes it back verbatim rather than minting one of its own (§9.2), which
 * is what makes a pushed message and a queue entry the same object from this
 * side. `at` is when the host read it off the stream, in host clock terms.
 */
export type CommandLifecycleEvent = {
  commandUuid: string;
  state: CommandLifecycleState;
  at: number;
};

/**
 * How one attempt to withdraw a queued user message ended.
 *
 * `withdrawn` means the CLI reported `cancelled` for that uuid, so the message
 * will run in no turn at all. `already-started` means it did not — the message
 * had been dequeued before the withdrawal reached the process, so it is running
 * or has run, and the process was not disturbed. `unknown` is the honest answer
 * for a uuid this host has no live process to withdraw from, or none it ever
 * pushed; it is deliberately not folded into `already-started`, because "we
 * cannot say" and "we know it is too late" are different facts.
 */
export type HostQueuedInputCancelResult = 'withdrawn' | 'already-started' | 'unknown';

/**
 * How much of a person's text a live resident process's OWN queue is still holding.
 *
 * A reading a caller reconciles a locally-guessed depth against, never a state the
 * caller keeps: the CLI holds its own queue and is the only thing that knows when a
 * turn boundary drains it, so a relay that counts its own deliveries can only ever
 * grow (measured 2026-10-12: the relay reported `queued=8→9→10` while the CLI's own
 * `command_lifecycle` showed seven entries dequeued together at one boundary, real
 * depth ≤2 afterwards).
 *
 * `items` counts messages the CLI accepted but has not dequeued into a turn — no
 * `started`/`completed`/`cancelled` `command_lifecycle` for them. `bytes` is the
 * UTF-8 length of their message text, the same unit the voice relay's admission
 * bound is written in, so the two numbers describe one set of messages.
 *
 * A reader answers `null` (not `{ items: 0 }`) when it cannot take the reading at
 * all — a per-run session, or a host that is gone — and a caller must read that as
 * UNKNOWN, never as empty.
 */
export type HostPendingQueuedInputs = { items: number; bytes: number };

// ---------------------------
//----------------- CLAUDE SESSION REGISTRY TYPES ------------
/**
 * A Claude Code background job that is holding a conversation, as the CLI's own
 * registry describes it.
 *
 * `jobId` is the handle `claude stop` / `claude attach` take (the CLI's short id
 * for the job); `pid` is the live process. Both are carried so the refusal can
 * name the exact command the user has to run.
 *
 * Consumed by the shared `findBackgroundSessionOwner` reader, by the Claude
 * resident host driver (which refuses to resume the conversation this names —
 * resident launch) and by the Claude per-run runtime (same refusal on the
 * per-run path). Both launch paths share this one definition so there is never a
 * second answer to "is this conversation occupied".
 */
export type ClaudeBackgroundSessionOwner = {
  pid: number;
  jobId: string;
  name: string | null;
};

/**
 * The two facts the outside world is owed about an occupied conversation.
 *
 * Not the whole {@link ClaudeBackgroundSessionOwner}: the job's display name is
 * the refusal's business, and the host listing's row is a client contract that
 * says exactly what a client can act on — the handle to stop the job with, and
 * the process to look at.
 *
 * Consumed by the shared `readClaudeSessionOccupancy` reader, by the Claude host
 * listing that reports it to clients, and re-exported through the providers
 * barrel for `server/index.ts`.
 */
export type ClaudeSessionOccupancy = {
  jobId: string;
  pid: number;
};

/**
 * Lists the files of one session-registry directory.
 *
 * A parameter of the registry readers rather than a direct call, for one reason:
 * the host listing is polled once a second, and "one directory scan per request,
 * however many conversations the listing holds" is a property that a
 * per-conversation implementation would silently lose. A criterion can only
 * count the scans if it can see them.
 *
 * Consumed by `scanSessionRegistry` and `readClaudeSessionOccupancy` in
 * `server/shared/utils.ts`; production callers pass the real listing, and a
 * criterion passes a counting one.
 */
export type ClaudeSessionRegistryLister = (sessionsDirectory: string) => string[];

