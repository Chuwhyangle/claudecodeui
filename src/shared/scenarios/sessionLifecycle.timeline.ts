/**
 * The ONE committed session-lifecycle timeline.
 *
 * THE CLAIM. A transcript is reduced from three sources — the persisted
 * transcript, the live socket, and the voice caption stream — and the same
 * sequence of user actions must reduce to the same screen no matter which
 * execution surface drives it (a pure reducer under vitest, a browser under
 * Playwright). The failure mode that motivated this artifact is a timeline that
 * exists twice: each surface carries its own hand-written copy, they drift, and
 * a fix proved on one surface says nothing about the other. So the timeline is
 * DATA here, at a path each surface imports — never copied — and the surfaces
 * keep only the assertion code.
 *
 * WHY `src/shared/scenarios/`. It is neutral ground: reachable from a frontend
 * module as `@/shared/scenarios/sessionLifecycle.timeline` and from a root-level
 * e2e spec as `../src/shared/scenarios/sessionLifecycle.timeline`. It must stay
 * import-clean — no runtime imports at all, at most `import type`, which the
 * bundler and the e2e transform both erase — so importing it never drags a
 * frontend module into a Playwright process or a Playwright helper into the app.
 *
 * WHAT IS HERE. The timeline is organised into FAMILIES, one per invariant the
 * pure execution surface asserts (the browser surface drives the same families
 * through its own events). Each family is a fixed sequence of typed events over
 * literal timestamps — no wall-clock reads — plus the initial server/realtime
 * state the sequence runs against, and the human-readable `invariant` it pins.
 * A surface replays a family by folding its events through the store's exported
 * pure transitions; it must not re-implement the fold.
 *
 * FAMILY ①  busy-send          — a send while the process is busy keeps its text
 *                                through `command_lifecycle: started`.
 * FAMILY ②  queued-command     — `queued → running → completed` leaves no residue,
 *                                on the socket side or the voice pending side.
 * FAMILY ③  event-ordering     — repeated / reordered / late events reduce
 *                                idempotently: never a second lifecycle row.
 * FAMILY ④  refresh-merge      — a refresh merged with live rows is element-wise
 *                                equal to the same rows never refreshed.
 */
import type { CommandLifecycleState } from '@/shared/types';

/** Stable id for the artifact; a surface that copies the timeline loses this one value. */
export const SESSION_LIFECYCLE_TIMELINE_ID = 'session-lifecycle-shared-timeline';

/** The three sources a transcript is reduced from. */
export type SessionLifecycleFamilyId =
  | 'busy-send'
  | 'queued-command'
  | 'event-ordering'
  | 'refresh-merge';

/**
 * A row as the timeline carries it: the fields the transitions read, spelled out
 * rather than imported so this module has no runtime type dependency. A surface
 * widens one of these to its own `NormalizedMessage` before folding it in.
 */
export type TimelineRow = {
  readonly id: string;
  readonly sessionId: string;
  readonly timestamp: string;
  readonly provider: string;
  readonly kind: 'text' | 'command_lifecycle';
  readonly role?: 'user' | 'assistant';
  readonly content?: string;
  readonly commandUuid?: string;
  readonly commandState?: CommandLifecycleState;
};

/** One finalised utterance the voice side heard, keyed by its upstream item id. */
export type TimelineUtterance = {
  readonly itemId: string;
  readonly text: string;
  readonly at: number;
  readonly seq?: number | null;
};

/** One delivery of a voice utterance to the host, the key of the pending-row check. */
export type TimelineDelivery = {
  readonly message: string;
  readonly at: number;
  readonly heard: readonly string[];
  readonly itemIds: readonly string[];
  readonly queuedMessageUuid?: string | null;
};

/**
 * The events a family's sequence is built from. Each is named for the store
 * entry it exercises, so a surface can map it to a real call without guessing.
 */
export type TimelineEvent =
  | { readonly kind: 'load-history'; readonly rows: readonly TimelineRow[] }
  | { readonly kind: 'refresh-history'; readonly rows: readonly TimelineRow[] }
  | { readonly kind: 'send-busy'; readonly row: TimelineRow }
  | {
      readonly kind: 'command-lifecycle';
      readonly commandUuid: string;
      readonly state: CommandLifecycleState;
    }
  | { readonly kind: 'append-realtime'; readonly row: TimelineRow }
  | { readonly kind: 'voice-utterance'; readonly utterance: TimelineUtterance }
  | { readonly kind: 'voice-delivery'; readonly delivery: TimelineDelivery }
  | { readonly kind: 'voice-visible-turn'; readonly row: TimelineRow };

/** A replayable family: the state to start from, the events, and what they prove. */
export type SessionLifecycleFamily = {
  readonly id: SessionLifecycleFamilyId;
  readonly invariant: string;
  /** Persisted transcript the sequence begins from. */
  readonly server: readonly TimelineRow[];
  /** Live rows already on screen when the sequence begins (usually empty). */
  readonly realtime: readonly TimelineRow[];
  /** Voice captions heard before the sequence begins. */
  readonly utterances: readonly TimelineUtterance[];
  /** Voice deliveries made before the sequence begins. */
  readonly deliveries: readonly TimelineDelivery[];
  /** User turns already visible before the sequence begins. */
  readonly visible: readonly TimelineRow[];
  readonly events: readonly TimelineEvent[];
};

export type SessionLifecycleTimeline = {
  readonly id: typeof SESSION_LIFECYCLE_TIMELINE_ID;
  readonly families: readonly SessionLifecycleFamily[];
};

// ── Fixed time base ─────────────────────────────────────────────────────────
// Literal, monotone, and never read from the clock: a family replayed twice
// must reduce to identical output, and a wall-clock read would make the merged
// order (which sorts on timestamp) differ run to run.
const T0 = '2026-03-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:02.000Z';
const T3 = '2026-03-01T00:00:03.000Z';
const T4 = '2026-03-01T00:00:04.000Z';

const SESSION = 'scenario-session';

const row = (over: Partial<TimelineRow> & Pick<TimelineRow, 'id' | 'kind'>): TimelineRow => ({
  sessionId: SESSION,
  timestamp: T0,
  provider: 'claude',
  ...over,
});

const pendingRow = (over: Partial<TimelineRow> & Pick<TimelineRow, 'id'>): TimelineRow =>
  row({
    kind: 'command_lifecycle',
    role: 'user',
    content: '',
    commandState: 'queued',
    ...over,
  });

/** The session's already-running turn, so a send lands on a loaded store. */
const RUNNING_TURN = row({
  id: 'turn-running',
  kind: 'text',
  role: 'assistant',
  content: 'working on the previous request…',
  timestamp: T0,
});

/** The load every family begins from: the transcript already holds a turn. */
const SERVER_BASE: readonly TimelineRow[] = [RUNNING_TURN];

const SEND_TEXT = 'ship it while the answer is still streaming';
/** The user turn the busy send becomes once the host runs it. */
const SEND_BECOMES_TURN = row({
  id: 'u-turn-busy',
  kind: 'text',
  role: 'user',
  content: SEND_TEXT,
  timestamp: T3,
});

/**
 * FAMILY ①  A send to a busy process keeps its text through `started`.
 *
 * The row may only leave the screen once the turn it became is visible. `started`
 * is the host dequeuing the command, NOT the arrival of the turn's rows — so the
 * text has to survive it. The old behaviour blanked the content on `started` and
 * the bubble vanished until a refresh.
 */
const busySend: SessionLifecycleFamily = {
  id: 'busy-send',
  invariant:
    'a send to a busy process still carries the user text after command_lifecycle:started, until its replacement turn is visible',
  server: SERVER_BASE,
  realtime: [],
  utterances: [],
  deliveries: [],
  visible: [],
  events: [
    { kind: 'send-busy', row: pendingRow({ id: 'cmd-row-busy', content: SEND_TEXT }) },
    { kind: 'command-lifecycle', commandUuid: 'cmd-busy', state: 'started' },
  ],
};

/**
 * FAMILY ②  `queued → running → completed` leaves no residue.
 *
 * On the socket side the pending row must be gone once the host reports the
 * command completed. On the voice side a caption that was delivered as a user
 * turn must not leave a second, pending row behind — the same "retired by its
 * replacement" rule, read through `heardUtteranceRows`.
 */
const queuedCommand: SessionLifecycleFamily = {
  id: 'queued-command',
  invariant:
    'once the host completes a queued command and its turn is visible, no command_lifecycle row and no voice pending row remains',
  server: SERVER_BASE,
  realtime: [],
  utterances: [
    { itemId: 'utt-1', text: 'add a health check', at: 1_000, seq: 1 },
  ],
  deliveries: [
    {
      message: 'add a health check',
      at: 1_100,
      heard: ['add a health check'],
      itemIds: ['utt-1'],
      queuedMessageUuid: 'cmd-queued',
    },
  ],
  visible: [],
  events: [
    { kind: 'send-busy', row: pendingRow({ id: 'cmd-row-queued', content: 'add a health check' }) },
    { kind: 'command-lifecycle', commandUuid: 'cmd-queued', state: 'started' },
    {
      kind: 'voice-visible-turn',
      row: row({
        id: 'u-turn-voice',
        kind: 'text',
        role: 'user',
        content: 'add a health check',
        timestamp: T2,
      }),
    },
    { kind: 'command-lifecycle', commandUuid: 'cmd-queued', state: 'completed' },
  ],
};

/**
 * FAMILY ③  Repeated, reordered, and late events reduce idempotently.
 *
 * A `queued` that arrives after the command completed is stale and must add
 * nothing; the same event applied twice must not produce a second row. The
 * store's own row is the only pending row throughout.
 */
const eventOrdering: SessionLifecycleFamily = {
  id: 'event-ordering',
  invariant:
    'repeated, reordered, or late lifecycle events never produce a second command_lifecycle row or change a cleared terminal state',
  server: SERVER_BASE,
  realtime: [],
  utterances: [],
  deliveries: [],
  visible: [],
  events: [
    { kind: 'send-busy', row: pendingRow({ id: 'cmd-row-order', content: 'retry the build' }) },
    { kind: 'command-lifecycle', commandUuid: 'cmd-order', state: 'started' },
    { kind: 'command-lifecycle', commandUuid: 'cmd-order', state: 'started' },
    { kind: 'command-lifecycle', commandUuid: 'cmd-order', state: 'completed' },
    // A late, out-of-order `queued` for an already-completed command.
    { kind: 'command-lifecycle', commandUuid: 'cmd-order', state: 'queued' },
  ],
};

/**
 * FAMILY ④  A refresh merged with live rows equals the same rows never refreshed.
 *
 * The persisted turn arrives on a refresh while a live pending row is already on
 * screen. Merging the refreshed transcript with the live rows must be
 * element-wise equal to merging the rows as if no refresh had happened — a
 * refresh reorders or duplicates the transcript, it does not rewrite it.
 */
const refreshMerge: SessionLifecycleFamily = {
  id: 'refresh-merge',
  invariant:
    'refreshing the persisted transcript while live rows exist yields the same merged transcript as never refreshing',
  server: SERVER_BASE,
  realtime: [],
  utterances: [],
  deliveries: [],
  visible: [],
  events: [
    // A send lands while the process is busy, so a live pending row is on screen…
    { kind: 'send-busy', row: pendingRow({ id: 'cmd-row-merge', content: 'keep going', timestamp: T4 }) },
    // …a first refresh brings back only the running turn…
    { kind: 'refresh-history', rows: [RUNNING_TURN] },
    // …the turn the live row will become…
    { kind: 'refresh-history', rows: [RUNNING_TURN, SEND_BECOMES_TURN] },
    // …and the SAME rows once more, as a refresh racing the first one returns.
    { kind: 'refresh-history', rows: [RUNNING_TURN, SEND_BECOMES_TURN] },
  ],
};

export const SESSION_LIFECYCLE_TIMELINE: SessionLifecycleTimeline = {
  id: SESSION_LIFECYCLE_TIMELINE_ID,
  families: [busySend, queuedCommand, eventOrdering, refreshMerge],
};

/** Family ids in declaration order — what a surface iterates to cover every invariant. */
export const SESSION_LIFECYCLE_FAMILY_IDS: readonly SessionLifecycleFamilyId[] =
  SESSION_LIFECYCLE_TIMELINE.families.map((family) => family.id);
