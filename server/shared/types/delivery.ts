import type { ChatRunSource } from './primitives.js';

// ---------------------------
//--------------- BUSY INPUT: PRIORITY, LIFECYCLE, WITHDRAWAL ----------
/**
 * The tier a user message is written into the CLI's own command queue under.
 *
 * The CLI holds its own queue and the host writes into it rather than building
 * one of its own, so "what happens to a message sent while a turn is running"
 * is a fact about the tier, not about the server. `later` is the tier that
 * reproduces the interactive CLI's behavior — the message waits for the turn in
 * flight and is then run as a turn of its own, never merged into the current
 * one and never dropped (`docs/proposals/claude-resident-sessions.md` §8).
 *
 * A union rather than a bare string because it is the CLI's vocabulary, not
 * this codebase's: the SDK declares the same three values, and a host that
 * accepted anything else would be writing a frame the process cannot honor.
 */
export type HostInputPriority = 'now' | 'next' | 'later';

// ---------------------------
//--------------- DELIVERY STATE CHANNEL: SNAPSHOT ENTRIES ------------
/**
 * How long the text a delivery carries may be before the activity channel
 * truncates it.
 *
 * The snapshot is an *activity* record, not a transcript: it has to say what a
 * session is holding well enough for a client to draw a pending row, and the
 * transcript itself is the authoritative full text (fetched per message, over
 * its own route). So the text travels bounded — a long prompt is cut here rather
 * than allowed to make every heartbeat-sized frame carry a document.
 *
 * Exported as a value because it sits on both sides of the reduction: the driver
 * cuts to it, and the criterion that reads the channel back is handed the same
 * number instead of retyping it, so a change to the bound moves the measurement
 * with it.
 */
export const DELIVERY_TEXT_MAX_CHARS = 400;

/**
 * The runtime option key a dispatch states a delivery's origin under.
 *
 * The delivery's `source` is the caller's fact — a timer, the MCP gateway and a
 * person's socket all dispatch through the same entry — and the run's origin is
 * already carried on the run record. The *delivery* is built inside the resident
 * driver, on the far side of the module edge from the dispatch, so the origin has
 * to travel on the one thing that crosses it: the options bag the turn is
 * dispatched with. Named here, as a value, because both ends of that edge spell
 * it and a literal retyped on either side is exactly the kind of pair that drifts.
 */
export const DELIVERY_SOURCE_OPTION = 'deliverySource';

// ---------------------------
//--------------- API COMPAT: THE runId BACKFILL WINDOW ------------
/**
 * The instant the `runId` backfill window closes (SPEC §8.3).
 *
 * S3 gives every accepted send a `deliveryId` — the `commandUuid` the host minted
 * and the CLI echoes back — and widens `runId` to be nullable, because a resident
 * send has no turn yet when it answers. That would break every caller that
 * already holds a `runId` and feeds it to `run_get`, so for one minor version the
 * answer BACKFILLS the field: while the turn is unbound, `runId` is stated as the
 * `deliveryId` (`runId === deliveryId` is how a caller recognizes the backfill),
 * and `run_get` accepts either id (SPEC §8.2). Past this instant the backfill is
 * removed — an unbound send states `runId: null` — and a criterion that reads
 * THIS constant turns red on its own the day the date passes, which is what
 * forces the removal rather than leaving it to memory.
 *
 * Written as an absolute instant rather than a duration so the very same number
 * is what the criterion asserts against; the criterion reads it and checks it is
 * still in the future, and never retypes the date.
 */
export const RUN_ID_COMPAT_WINDOW_END_MS = Date.parse('2027-01-15T00:00:00Z');

/**
 * Whether the `runId` backfill still applies at `nowMs` (SPEC §8.3).
 *
 * A reader that only has a clock asks this rather than comparing the constant
 * itself, so "is the window open" is decided in one place — the criterion can
 * push an injected `now` past the deadline, and the implementation and the
 * criterion then agree by construction about which side of the boundary the send
 * is on.
 */
export function isRunIdCompatWindowOpen(nowMs: number): boolean {
  return nowMs < RUN_ID_COMPAT_WINDOW_END_MS;
}

/**
 * Where one accepted delivery is, as the activity channel states it.
 *
 * Deliberately narrower than the ledger's own state vocabulary
 * (`ClaudeResidentDeliveryState`, which also carries `pushed`): `pushed` is the
 * host's mark on a write the CLI has not spoken about yet, and from a client's
 * side an accepted-but-unreported command *is* a queued one — it is waiting for
 * the process to take it. Collapsing the two here is what keeps the channel's
 * vocabulary the CLI's own four words (SPEC §4.1) while the ledger keeps the
 * finer distinction it needs internally.
 */
export type DeliveryEntryState = 'queued' | 'started' | 'completed' | 'cancelled';

/**
 * Why a delivery ended in a way that was not a clean completion.
 *
 * The same set the driver's ledger states on a `cancelled`
 * (`ClaudeResidentDeliveryReason` minus its `cli` residual, which the snapshot
 * carries as `null`: a terminal the CLI stated with nobody here asking is the
 * ordinary ending, not a reason worth naming).
 */
export type DeliveryEntryReason = 'withdrawn' | 'interrupt' | 'process-exit' | 'owed-terminal-missing';

/**
 * One accepted delivery, as the activity snapshot carries it (SPEC §7.1).
 *
 * This is the *status projection* of one accepted send: what a client needs to
 * draw a pending row and settle it, without replaying a stream and without being
 * attached to the run that happened to write the frames. It is deliberately not
 * the ledger record — the ledger is the driver's own account (frames written,
 * leases held, rungs owed) and lives across the module edge; this is the ten
 * facts of it that a browser is entitled to.
 *
 * The channel is a **snapshot**, not a delta: the entry travels inside the whole
 * `activity.snapshot` / `activity.upsert` body, so a client that reconnects
 * reads the current queue and every terminal still inside the retention window
 * without anyone replaying anything at it (`id-relations` B-7).
 *
 * Two field-presence rules are load-bearing, and both are stated as *values*
 * rather than as absent keys so an entry's shape never depends on its state:
 *
 * - `reason` is `null` unless the delivery was cancelled, because a `completed`
 *   delivery has no reason to state and a client that had to test `'reason' in
 *   entry` before drawing a row would be branching on a shape rather than on a
 *   fact.
 * - `text` is `null` once the delivery reaches a terminal, and bounded
 *   ({@link DELIVERY_TEXT_MAX_CHARS}) while it is live. The text is what makes a
 *   queued row readable; an ended delivery's words belong to the transcript, and
 *   carrying them would keep every finished message alive in a snapshot that is
 *   re-sent on every change.
 */
export type DeliveryEntry = {
  /** The delivery's identity: the `commandUuid` the host minted and the CLI echoes back. */
  deliveryId: string;
  state: DeliveryEntryState;
  /** Who asked for this delivery — the same origin vocabulary the run records use. */
  source: ChatRunSource;
  /** The CLI queue tier the write was made under, or `null` for a write that had no queue to be behind. */
  priority: HostInputPriority | null;
  /** When the send was accepted (the host's clock at the write). */
  enqueuedAt: number;
  /** When the CLI said it started running this command, or `null`. */
  startedAt: number | null;
  /** When the CLI stated its terminal, or `null` while it is live. */
  endedAt: number | null;
  /** The turn this command was bound to (SPEC §4.2), or `null` while it is bound to none. */
  turnId: string | null;
  /** The `cancelled` reason, or `null` for a live or cleanly completed delivery. */
  reason: DeliveryEntryReason | null;
  /** The command's own words while the delivery is live, bounded; `null` once it ends. */
  text: string | null;
};

/**
 * How `run_get` states a delivery it read by id (SPEC §8.2).
 *
 * Deliberately the same four words {@link DeliveryEntry} carries — this is a
 * reading of the same ledger, and a second vocabulary would be a second truth.
 */
export type ResidentDeliveryLookupState = DeliveryEntryState;

/**
 * Why a delivery `run_get` read by id ended without completing (SPEC §8.2).
 *
 * WIDER than {@link DeliveryEntryReason}: `run_get` reports the ledger's own
 * reason verbatim, including the `cli` residual (a terminal the CLI stated that
 * nobody here asked for). The activity snapshot drops that residual because a
 * browser drawing a row has nothing to do with the distinction; a caller that
 * asked "has the sentence I sent finished, and if not why not" does.
 */
export type ResidentDeliveryLookupReason = DeliveryEntryReason | 'cli';

/**
 * One delivery, as `run_get` resolves it by id (SPEC §8.2).
 *
 * The by-id face of the same ledger {@link DeliveryEntry} projects as a list:
 * what a caller who holds only a `deliveryId` needs in order to wait for the
 * command it names to end and to read that turn's closing message. It carries
 * the facts the *list* projection does not need — the owning session and the
 * run the delivery's turn is executing as — because the reason a caller reads
 * by id at all is that it holds no session to look the delivery up under.
 *
 * `runId` is the run of the TURN this command was bound to (run=turn, SPEC
 * §5.2), or `null` for a command with no turn yet.
 */
export type ResidentDeliveryLookup = {
  deliveryId: string;
  /** The session whose resident ledger holds this delivery. */
  sessionId: string;
  /** The turn this command was bound to, or `null`. */
  turnId: string | null;
  /** The run the bound turn is executing as, or `null` when the command has no turn. */
  runId: string | null;
  state: ResidentDeliveryLookupState;
  /** The `cancelled` reason (including the `cli` residual), else `null`. */
  reason: ResidentDeliveryLookupReason | null;
  /** Who asked for this delivery — the same origin vocabulary the run records use. */
  source: ChatRunSource;
  /** When the send was accepted. */
  enqueuedAt: number;
  /** When the CLI said it started running this command, or `null`. */
  startedAt: number | null;
  /** When the CLI stated its terminal, or `null` while it is live. */
  endedAt: number | null;
};

