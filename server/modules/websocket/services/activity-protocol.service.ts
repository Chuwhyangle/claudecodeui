import {
  readSessionDeliveries,
  readSessionSchedules,
  readSessionTasks,
  readSessionTurn,
  readSessionTurnRun,
  type TurnState,
} from '@/modules/providers/index.js';
import type { ActivityProtocolSnapshot, ActivitySnapshotTurn, DeliveryEntry } from '@/shared/types.js';

import { BOOT_ID } from './activity-heartbeat.service.js';
export type { ActivityProtocolSnapshot, ActivitySnapshotTurn };



/** The two frame kinds the protocol puts on the wire. */
export type ActivityProtocolFrameKind = 'activity.snapshot' | 'activity.upsert';

/**
 * One frame on the activity socket: a snapshot, or an upsert carrying a *whole*
 * new snapshot.
 *
 * The frame is the snapshot plus a `kind`, deliberately the same fields rather
 * than a delta. "Upsert" here means "this is the session's activity now" — a
 * receiver replaces its picture with the frame's body instead of applying a
 * change to it, which is what makes a missed frame harmless as long as the
 * revision is watched (see the client behaviour in the criterion).
 */
export type ActivityProtocolFrame = ActivityProtocolSnapshot & {
  kind: ActivityProtocolFrameKind;
};

/** One connection's delivery callback, handed every frame for its session. */
export type ActivityFrameListener = (frame: ActivityProtocolFrame) => void;

/**
 * The injections a store accepts. Every one of them exists so a criterion can
 * drive the store with readings it controls instead of reaching for production
 * state it would then have to wait on.
 */
export type ActivityStoreOptions = {
  /** The clock every `asOf` is read from. Defaults to `Date.now`; a criterion pins it. */
  now?: () => number;
  /**
   * The boot id every snapshot is stamped with. Defaults to the heartbeat's
   * process `BOOT_ID`, which is what keeps the two frames' `bootId` in agreement.
   */
  bootId?: string;
  /** The session's turn state. Defaults to the providers module's live reduction. */
  readTurn?: (sessionId: string) => TurnState;
  /**
   * The session's run identity for the turn in flight, or `null`s when there is
   * none. Defaults to the providers module's live reading of the resident
   * driver's own turn binding, which is the only place a turn's run is known —
   * an injected criterion states its own, and a session whose turns are one
   * process each leaves the default answering nothing.
   */
  readTurnRun?: (sessionId: string) => { runId: string | null; startedAt: number | null };
  /**
   * The session's task projection. Defaults to the providers module's live Task
   * table (the run loop's reducer, AC-191 → AC-194's wiring leg); a criterion
   * injects its own.
   */
  readTasks?: (sessionId: string) => readonly unknown[];
  /**
   * The session's schedule projection. Defaults to the providers module's live
   * Schedule table (AC-192 → AC-194's wiring leg); a criterion injects its own.
   */
  readSchedules?: (sessionId: string) => readonly unknown[];
  /**
   * The session's accepted deliveries (SPEC §7.1). Defaults to the providers
   * module's live reading of the resident driver's delivery ledger — the same
   * shape and the same place as `readTasks` / `readSchedules`, because it is the
   * same kind of thing: a projection the run loop holds and this protocol only
   * transports. A criterion injects its own.
   */
  readDeliveries?: (sessionId: string) => readonly DeliveryEntry[];
};

/**
 * The activity protocol's storage face.
 *
 * One instance holds only its own sessions, keyed by session id — there is no
 * module-level bucket a second store could share, which is what lets two
 * criteria (or two server configurations) run side by side without reading each
 * other's revisions. The five verbs are the whole contract:
 *
 *  - `snapshot` reads the four live sources plus the current revision and
 *    returns a fresh copy; an unknown or retired session answers `null`.
 *  - `recordChange` is the one way a revision ever moves: it advances the session
 *    by one and pushes a whole-snapshot upsert to that session's subscribers.
 *  - `subscribe` registers one connection, hands it today's snapshot first, and
 *    returns its own unsubscribe. Two subscriptions to one session are two
 *    independent cursors.
 *  - `retireSession` drops the session's revision, snapshot and subscriptions —
 *    the retention policy, called when the session ends.
 *  - `sessionIds` lists the sessions the store still holds, for a caller asserting
 *    that a retirement really reclaimed one.
 */
export type ActivityStore = {
  snapshot(sessionId: string): ActivityProtocolSnapshot | null;
  recordChange(sessionId: string): void;
  subscribe(sessionId: string, onFrame: ActivityFrameListener): () => void;
  retireSession(sessionId: string): void;
  sessionIds(): string[];
};

/**
 * Internal face adding the revision read the heartbeat needs.
 *
 * It is deliberately not part of the public `ActivityStore` type: a read that
 * changes nothing has no place in the protocol's verb surface, and only the
 * heartbeat — through {@link readActivityRevision} — is allowed to ask.
 */
type ActivityStoreWithRevisions = ActivityStore & {
  revision(sessionId: string): number;
};

/** One session's live state inside a store: its revision and its current listeners. */
type SessionActivityState = {
  rev: number;
  subscribers: Set<ActivityFrameListener>;
};

function createStore(options: ActivityStoreOptions): ActivityStoreWithRevisions {
  const now = options.now ?? (() => Date.now());
  const bootIdOption = options.bootId;
  const readTurn = options.readTurn;
  const readTurnRun = options.readTurnRun;
  const readTasks = options.readTasks;
  const readSchedules = options.readSchedules;
  const readDeliveries = options.readDeliveries;

  const sessions = new Map<string, SessionActivityState>();

  // Sessions are born when a connection subscribes; a bare `snapshot` for an id the
  // store has never been told about answers `null` (the REST 404), and a
  // `recordChange` for one is a no-op rather than a resurrection. That is the
  // invariant AC8 rests on: once `retireSession` has dropped a session, a later
  // change cannot bring it back, so a retired session neither reappears in
  // `sessionIds` nor delivers a frame.
  function ensureSession(sessionId: string): SessionActivityState {
    const known = sessions.get(sessionId);
    if (known) {
      return known;
    }
    const created: SessionActivityState = { rev: 0, subscribers: new Set() };
    sessions.set(sessionId, created);
    return created;
  }

  // The boot id is resolved per read rather than captured at construction so this
  // module can sit inside an import cycle with the heartbeat (each reads the
  // other's single value) without touching a binding before the other module has
  // initialised it.
  function bootId(): string {
    return bootIdOption ?? BOOT_ID;
  }

  // The three sources are read through the injected readers on every snapshot, so a
  // change to a task or schedule is visible the next time either path asks — which
  // is exactly why a frame body and a REST body read at one revision agree. The
  // default turn reader is called inside this function body, never at module
  // evaluation, for the same cycle reason as `bootId()`.
  function readTurnState(sessionId: string): TurnState {
    return readTurn ? readTurn(sessionId) : readSessionTurn(sessionId);
  }

  // The run half of the turn, resolved the same way and for the same reason. It is
  // merged rather than required, so a reader that injected a phase reduction of its
  // own still gets the run identity the live driver knows — and a session with no
  // bound turn gets nothing, which is the honest answer rather than a placeholder id.
  function readTurnRunState(sessionId: string): { runId?: string | null; startedAt?: number | null } {
    const reading = readTurnRun ? readTurnRun(sessionId) : readSessionTurnRun(sessionId);
    if (!reading.runId) {
      return {};
    }
    return { runId: reading.runId, startedAt: reading.startedAt };
  }

  // The delivery projection, read live like the other three: the reader answers the
  // queue and the retained terminals as they stand now, which is what makes a
  // snapshot taken after a change — and a frame built at that same change — agree
  // without either of them being cached.
  function readDeliveryEntries(sessionId: string): DeliveryEntry[] {
    return [...(readDeliveries ? readDeliveries(sessionId) : readSessionDeliveries(sessionId))];
  }

  function buildSnapshot(sessionId: string, rev: number): ActivityProtocolSnapshot {
    return {
      sessionId,
      bootId: bootId(),
      rev,
      asOf: now(),
      turn: { ...readTurnState(sessionId), ...readTurnRunState(sessionId) },
      tasks: [...(readTasks ? readTasks(sessionId) : readSessionTasks(sessionId))],
      schedules: [...(readSchedules ? readSchedules(sessionId) : readSessionSchedules(sessionId))],
      deliveries: readDeliveryEntries(sessionId),
    };
  }

  function buildFrame(
    kind: ActivityProtocolFrameKind,
    sessionId: string,
    rev: number,
  ): ActivityProtocolFrame {
    return { kind, ...buildSnapshot(sessionId, rev) };
  }

  return {
    snapshot(sessionId) {
      const state = sessions.get(sessionId);
      if (!state) {
        return null;
      }
      // A fresh object every read: a caller cannot hold onto a mutable internal
      // record, because there is none — the sources are re-read and re-copied.
      return buildSnapshot(sessionId, state.rev);
    },

    recordChange(sessionId) {
      const state = sessions.get(sessionId);
      if (!state) {
        return;
      }
      state.rev += 1;
      // The body is the whole snapshot as of this revision, never a delta. It is
      // built once and handed to every listener unchanged, so two connections on
      // one session observe identical frames.
      const frame = buildFrame('activity.upsert', sessionId, state.rev);
      // Delivered over a copy so a listener that unsubscribes during delivery
      // cannot skip its neighbour.
      for (const listener of [...state.subscribers]) {
        listener(frame);
      }
    },

    subscribe(sessionId, onFrame) {
      const state = ensureSession(sessionId);
      state.subscribers.add(onFrame);
      // A joiner is handed the current snapshot FIRST, before any later change can
      // arrive, so it has an anchor to judge continuity against. This is the
      // "late joiner gets a snapshot" half of the protocol; the revision on it is
      // the session's current one, which is what lets the client ignore an older
      // frame that races in behind it.
      onFrame(buildFrame('activity.snapshot', sessionId, state.rev));
      return () => {
        const current = sessions.get(sessionId);
        current?.subscribers.delete(onFrame);
      };
    },

    retireSession(sessionId) {
      // Dropping the one map entry drops the revision and every subscription at
      // once, so nothing session-shaped survives the call. There is no cached
      // snapshot to drop as well: reads are live.
      sessions.delete(sessionId);
    },

    sessionIds() {
      return [...sessions.keys()];
    },

    revision(sessionId) {
      return ensureSession(sessionId).rev;
    },
  };
}

/**
 * Creates an activity store. State is held per instance and bucketed by session
 * id, so two stores never read each other's revisions and two sessions never read
 * each other's subscribers. See {@link ActivityStore} for the contract and
 * {@link ActivityStoreOptions} for the injected readings a criterion drives.
 *
 * The criterion `server/modules/websocket/tests/activity-protocol.test.ts` is the
 * consumer that matters: it builds a store per case with a pinned clock, a fixed
 * boot id, and fake turn/task/schedule readers, then asserts the snapshot, the
 * upserts and the retention behaviour against them.
 */
export function createActivityStore(options: ActivityStoreOptions = {}): ActivityStore {
  return createStore(options);
}

/**
 * The process-wide store the running server uses — the same instance the activity
 * REST router mounts and the one {@link readActivityRevision} reads.
 *
 * It is a single instance because "the revision the heartbeat announces" and "the
 * revision a snapshot carries" have to be one number; a second store would be a
 * second counter, which is precisely the defect this module exists to avoid. It
 * is created eagerly here, but every default that crosses an import edge (the boot
 * id and the turn reader) is resolved lazily at read time, so the cycle between
 * this module and the heartbeat is safe to evaluate in either order.
 */
const defaultStore = createStore({});

/** The process-wide activity store, for the server's composition root to mount. */
export const activityStore: ActivityStore = defaultStore;

/**
 * The session's current revision, read from the process-wide store and seeding a
 * session on first sight.
 *
 * This is the ONE revision source. The heartbeat's `activityAnnouncement` reads it
 * so the `rev` it stamps on every beat is the same number a snapshot carries, and
 * `recordChange` is the only thing that ever advances it — there is no second
 * counter anywhere in the process. Consumed by `activity-heartbeat.service.ts`;
 * exported rather than folded into the public `ActivityStore` type because it is a
 * read for the transport, not a protocol verb.
 */
export function readActivityRevision(sessionId: string): number {
  return defaultStore.revision(sessionId);
}
