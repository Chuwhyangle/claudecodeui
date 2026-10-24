/**
 * The observation layer's model and wall.
 *
 * `ObservedObject` is the ONE shape every producer writes and the cockpit reads; the store owns
 * its invariants (URI grammar, monotonic revisions, the "unevaluated must say why" rule) and the
 * wall's composition (pinned residency, automatic surfacing of attention/red objects,
 * status-then-recency ordering, the block cap). Producers never compose a wall and the cockpit
 * never writes — the two directions meet here, which is what keeps the observation surface
 * smaller than the objects it observes.
 *
 * DELTA = REVISIONS AFTER THE CURSOR. A `SeenCursor` is per user and lives in the database, so
 * "seen" is the same fact on every device instead of a browser-local claim. Every write appends
 * one `ObservedRevision` carrying its delta items; the wall flattens the ones after the user's
 * cursor. Advancing the cursor therefore clears them everywhere at once.
 *
 * A STATE CHANGE IS PUSHED, NOT POLLED. Every revision (and every cursor advance or pin) is
 * published through the injected `publish` seam. `server/index.ts` wires that seam to the
 * cockpit hub, which fans it out over the same `/ws` sockets the cockpit already uses; the
 * observation module itself knows nothing about websockets.
 *
 * Consumers: `server/modules/observation/observation.routes.ts` (the HTTP face),
 * `server/modules/observation/observation.module.ts` (composition), and the producer tasks that
 * write revisions through {@link ObservationStore.writeRevision}.
 */
import { AppError } from '@/shared/utils.js';
import { observationDb } from '@/modules/database/index.js';
import type {
  ObservationProducerHeartbeatRow,
  ObservationSeenCursorRow,
  ObservedObjectRow,
  ObservedRevisionRow,
} from '@/modules/database/index.js';

import {
  OBSERVATION_LAYER_BLIND_SPOTS,
  mergeBlindSpots,
  splitBlindSpotsFromDigest,
  withBlindSpotsInDigest,
} from './blind-spots.js';
import {
  parseObservationUri,
  type ObservationKind,
} from './observation-uri.js';
import { evaluateProducer, type ProducerReading } from './producer-liveness.js';

/** The shipped block cap on the wall (the `observation.wallLimit` server setting overrides it). */
export const DEFAULT_OBSERVATION_WALL_LIMIT = 12;

/** The four-state reading every observed object and every producer carries. */
export type ObservationStatusState = 'ok' | 'attention' | 'red' | 'unevaluated';

/**
 * An object's status. `reason` is REQUIRED for `unevaluated` — "we could not read this" must
 * say why, or it is indistinguishable from a green reading nobody checked.
 */
export type ObservedStatus = {
  state: ObservationStatusState;
  reason?: string;
};

/** Where a reading came from, and whether a deterministic pass or an LLM produced it. */
export type ObservedProvenance = {
  producer: string;
  tier: 'deterministic' | 'llm';
  evaluatedAt: number;
};

/** One observed object at its current revision. */
export type ObservedObject = {
  uri: string;
  kind: ObservationKind;
  title: string;
  status: ObservedStatus;
  /** Kind-specific structured reading; the store treats it as an opaque JSON document. */
  digest: Record<string, unknown>;
  /**
   * What this projection cannot see. Always non-empty: the kind's defaults followed by any
   * producer-supplied declarations, de-duplicated. The preview is the only place it renders.
   */
  blindSpots: string[];
  revision: number;
  updatedAt: number;
  provenance: ObservedProvenance;
};

/** One appended revision and the delta items it contributed. */
export type ObservedRevision = {
  uri: string;
  revision: number;
  at: number;
  deltaItems: string[];
};

/** One user's cross-device cursor on one object. */
export type SeenCursor = {
  userId: string;
  uri: string;
  revision: number;
  at: number;
};

/** One user's pinned object. */
export type WatchEntry = {
  userId: string;
  uri: string;
  pinnedAt: number;
};

/** One object as the wall shows it: the object, whether it is pinned, and its unseen deltas. */
export type ObservationWallEntry = {
  object: ObservedObject;
  pinned: boolean;
  seenRevision: number;
  deltaItems: string[];
};

/**
 * The observation layer's own reading, shown when any producer is not `ok`.
 *
 * It is NOT part of `entries`, so the block cap can never fold it away: a wall that is quiet
 * because its producers are dead must say so even when the object list is full.
 */
export type ObservationWallSelf = {
  title: '观察层自身';
  state: 'attention';
  reason: string;
  /** The layer's own declaration: a heartbeat is not a correctness reading. */
  blindSpots: string[];
};

/** `GET /api/observation/wall`'s response body. */
export type ObservationWall = {
  entries: ObservationWallEntry[];
  /** Objects that surfaced but did not fit under the cap. */
  collapsedCount: number;
  /** Every registered producer's liveness reading, non-`ok` first. */
  producers: ProducerReading[];
  /** The layer's own entry, or null when every producer is `ok`. */
  self: ObservationWallSelf | null;
};

/** The frame pushed over the cockpit hub when anything changes. */
export type ObservationUpdateFrame = {
  kind: 'observation.update';
  uri: string;
  revision: number;
  seenRevision: number | null;
  deltaItems: string[];
};

/** A write from a producer. `at`/`evaluatedAt` default to the store's clock. */
export type WriteObservationInput = {
  uri: string;
  kind: ObservationKind;
  title: string;
  status: ObservedStatus;
  digest?: Record<string, unknown>;
  /** Extra declarations appended to the kind's defaults; merged and de-duplicated. */
  blindSpots?: string[];
  deltaItems?: string[];
  provenance: {
    producer: string;
    tier: 'deterministic' | 'llm';
    evaluatedAt?: number;
  };
};

/** Options for {@link createObservationStore}. */
export type ObservationStoreDeps = {
  /** The clock every timestamp and the liveness reading use. Defaults to `Date.now`. */
  now?: () => number;
  /** The wall's block cap. Defaults to {@link DEFAULT_OBSERVATION_WALL_LIMIT}. */
  wallLimit?: number;
  /** Pushes one frame to one user; the composition root binds it to the cockpit hub. */
  publish?: (userId: string, frame: ObservationUpdateFrame) => void;
};

/** The observation module's write/read surface, as the routes and producers see it. */
export type ObservationStore = {
  writeRevision(input: WriteObservationInput): ObservedObject;
  getObject(uri: string): ObservedObject | null;
  listRevisions(uri: string, afterRevision: number): ObservedRevision[];
  markSeen(userId: string, uri: string, revision: number): { cursor: SeenCursor; advanced: boolean };
  getSeenCursor(userId: string, uri: string): SeenCursor | null;
  pin(userId: string, uri: string): WatchEntry;
  unpin(userId: string, uri: string): boolean;
  getWall(userId: string): ObservationWall;
  registerProducer(producer: string, expectedIntervalMs: number): void;
  recordProducerAttempt(producer: string, error?: string | null): void;
};

/** A 400 for a caller mistake; the process error middleware translates it unchanged. */
function invalid(message: string, code = 'INVALID_OBSERVATION'): AppError {
  return new AppError(message, { code, statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseDeltaItems(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** The wall is only ever asked for a user key; the routes supply `String(req.user.id)`. */
function userKey(userId: unknown): string {
  const key = typeof userId === 'string' ? userId.trim() : '';
  if (key === '') throw invalid('a user id is required', 'INVALID_USER');
  return key;
}

/** Validates one status, enforcing the "unevaluated must carry a reason" invariant. */
function normalizeStatus(input: unknown): ObservedStatus {
  if (!isRecord(input)) throw invalid('`status` must be an object');
  const state = input.state;
  if (state !== 'ok' && state !== 'attention' && state !== 'red' && state !== 'unevaluated') {
    throw invalid('`status.state` must be one of ok, attention, red, unevaluated');
  }
  const rawReason = input.reason;
  if (rawReason !== undefined && typeof rawReason !== 'string') {
    throw invalid('`status.reason` must be a string when present');
  }
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (state === 'unevaluated' && reason === '') {
    throw invalid('an unevaluated status must carry a non-empty `status.reason`');
  }
  return reason === '' ? { state } : { state, reason };
}

function toObservedObject(row: ObservedObjectRow): ObservedObject {
  const status: ObservedStatus =
    row.statusReason === null
      ? { state: row.statusState as ObservationStatusState }
      : { state: row.statusState as ObservationStatusState, reason: row.statusReason };
  const kind = row.kind as ObservationKind;
  const tier = row.provenanceTier === 'llm' ? 'llm' : 'deterministic';
  const { digest, blindSpots } = splitBlindSpotsFromDigest(
    parseJsonRecord(row.digestJson),
    kind,
    tier,
  );
  return {
    uri: row.uri,
    kind,
    title: row.title,
    status,
    digest,
    blindSpots,
    revision: row.revision,
    updatedAt: row.updatedAt,
    provenance: {
      producer: row.provenanceProducer,
      tier,
      evaluatedAt: row.provenanceEvaluatedAt,
    },
  };
}

function toSeenCursor(row: ObservationSeenCursorRow): SeenCursor {
  return { userId: row.userId, uri: row.uri, revision: row.revision, at: row.at };
}

function toObservedRevision(row: ObservedRevisionRow): ObservedRevision {
  return {
    uri: row.uri,
    revision: row.revision,
    at: row.at,
    deltaItems: parseDeltaItems(row.deltaItemsJson),
  };
}

/** Order the wall: red before attention before ok, then most recently revised first. */
const STATE_RANK: Record<ObservationStatusState, number> = {
  red: 0,
  attention: 1,
  ok: 2,
  unevaluated: 3,
};

function compareWallEntries(left: ObservationWallEntry, right: ObservationWallEntry): number {
  const byState = STATE_RANK[left.object.status.state] - STATE_RANK[right.object.status.state];
  if (byState !== 0) return byState;
  const byRevision = right.object.revision - left.object.revision;
  if (byRevision !== 0) return byRevision;
  const byUpdatedAt = right.object.updatedAt - left.object.updatedAt;
  if (byUpdatedAt !== 0) return byUpdatedAt;
  return left.object.uri.localeCompare(right.object.uri);
}

/**
 * Builds the store over the shared database connection.
 *
 * The default wall limit is the shipped 12; `server/index.ts` passes the operator's
 * `observation.wallLimit` from the server settings file when it composes the module.
 */
export function createObservationStore(deps: ObservationStoreDeps = {}): ObservationStore {
  const now = deps.now ?? (() => Date.now());
  const wallLimit = deps.wallLimit ?? DEFAULT_OBSERVATION_WALL_LIMIT;
  if (!Number.isInteger(wallLimit) || wallLimit <= 0) {
    throw invalid('`wallLimit` must be a positive integer', 'INVALID_WALL_LIMIT');
  }
  const publish = deps.publish ?? (() => {});

  const publishRevision = (uri: string, revision: number, status: ObservedStatus, deltaItems: string[]): void => {
    const recipients = new Set([...observationDb.listWatchUserIds(uri), ...observationDb.listSeenUserIds(uri)]);
    for (const userId of recipients) {
      publish(userId, { kind: 'observation.update', uri, revision, seenRevision: null, deltaItems });
    }
  };

  const requireUri = (value: unknown) => {
    const parsed = parseObservationUri(value);
    if (parsed === null) {
      throw invalid('`uri` must be one of cloudcli://session/<id>, cloudcli://architecture/<id>, quay://<id>/board', 'INVALID_URI');
    }
    return parsed;
  };

  const readObject = (uri: string): ObservedObject | null => {
    const row = observationDb.readObject(uri);
    return row === null ? null : toObservedObject(row);
  };

  return {
    writeRevision(input) {
      const parsed = requireUri(input?.uri);
      const kind = input.kind;
      if (kind !== 'session' && kind !== 'project' && kind !== 'architecture') {
        throw invalid('`kind` must be one of session, project, architecture');
      }
      if (kind !== parsed.kind) {
        throw invalid(`uri ${parsed.uri} addresses a ${parsed.kind}, not a ${kind}`);
      }
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (title === '') throw invalid('`title` must be a non-empty string');
      const status = normalizeStatus(input.status);
      const producer = typeof input.provenance?.producer === 'string' ? input.provenance.producer.trim() : '';
      if (producer === '') throw invalid('`provenance.producer` must be a non-empty string');
      const tier = input.provenance?.tier;
      if (tier !== 'deterministic' && tier !== 'llm') {
        throw invalid('`provenance.tier` must be deterministic or llm');
      }
      const at = now();
      const evaluatedAt = input.provenance.evaluatedAt ?? at;
      if (!Number.isFinite(evaluatedAt)) throw invalid('`provenance.evaluatedAt` must be a finite timestamp');
      const digest = input.digest ?? {};
      if (!isRecord(digest)) throw invalid('`digest` must be an object');
      const appendedBlindSpots = input.blindSpots ?? [];
      if (!Array.isArray(appendedBlindSpots) || appendedBlindSpots.some((spot) => typeof spot !== 'string')) {
        throw invalid('`blindSpots` must be an array of strings');
      }
      const blindSpots = mergeBlindSpots(kind, tier, appendedBlindSpots);
      const deltaItems = input.deltaItems ?? [];
      if (!Array.isArray(deltaItems) || deltaItems.some((item) => typeof item !== 'string')) {
        throw invalid('`deltaItems` must be an array of strings');
      }
      const items = deltaItems.map((item) => item.trim()).filter((item) => item !== '');

      const appended = observationDb.appendRevision({
        uri: parsed.uri,
        kind,
        title,
        statusState: status.state,
        statusReason: status.reason ?? null,
        digestJson: JSON.stringify(withBlindSpotsInDigest(digest, blindSpots)),
        at,
        deltaItemsJson: JSON.stringify(items),
        provenanceProducer: producer,
        provenanceTier: tier,
        provenanceEvaluatedAt: evaluatedAt,
      });

      const object: ObservedObject = {
        uri: parsed.uri,
        kind,
        title,
        status,
        digest,
        blindSpots,
        revision: appended.revision,
        updatedAt: at,
        provenance: { producer, tier, evaluatedAt },
      };
      publishRevision(parsed.uri, object.revision, status, items);
      return object;
    },

    getObject(uri) {
      const parsed = parseObservationUri(uri);
      return parsed === null ? null : readObject(parsed.uri);
    },

    listRevisions(uri, afterRevision) {
      const parsed = requireUri(uri);
      if (!Number.isInteger(afterRevision) || afterRevision < 0) {
        throw invalid('`revision` must be a non-negative integer');
      }
      return observationDb.listRevisionsAfter(parsed.uri, afterRevision).map(toObservedRevision);
    },

    markSeen(userId, uri, revision) {
      const key = userKey(userId);
      const parsed = requireUri(uri);
      if (!Number.isInteger(revision) || revision < 1) {
        throw invalid('`revision` must be a positive integer');
      }
      const current = observationDb.readSeenCursor(key, parsed.uri);
      // A cursor never moves backwards: a late frame from an older device must not resurrect
      // deltas the user has already cleared on another one.
      if (current !== null && revision <= current.revision) {
        return { cursor: toSeenCursor(current), advanced: false };
      }
      const at = now();
      observationDb.writeSeenCursor(key, parsed.uri, revision, at);
      const cursor: SeenCursor = { userId: key, uri: parsed.uri, revision, at };
      const object = readObject(parsed.uri);
      publish(key, {
        kind: 'observation.update',
        uri: parsed.uri,
        revision: object?.revision ?? revision,
        seenRevision: revision,
        deltaItems: [],
      });
      return { cursor, advanced: true };
    },

    getSeenCursor(userId, uri) {
      const key = userKey(userId);
      const parsed = parseObservationUri(uri);
      if (parsed === null) return null;
      const row = observationDb.readSeenCursor(key, parsed.uri);
      return row === null ? null : toSeenCursor(row);
    },

    pin(userId, uri) {
      const key = userKey(userId);
      const parsed = requireUri(uri);
      const at = now();
      const row = observationDb.writeWatchEntry(key, parsed.uri, at);
      const entry: WatchEntry = { userId: row.userId, uri: row.uri, pinnedAt: row.pinnedAt };
      publish(key, {
        kind: 'observation.update',
        uri: parsed.uri,
        revision: observationDb.readObject(parsed.uri)?.revision ?? 0,
        seenRevision: null,
        deltaItems: [],
      });
      return entry;
    },

    unpin(userId, uri) {
      const key = userKey(userId);
      const parsed = requireUri(uri);
      const removed = observationDb.deleteWatchEntry(key, parsed.uri);
      publish(key, {
        kind: 'observation.update',
        uri: parsed.uri,
        revision: observationDb.readObject(parsed.uri)?.revision ?? 0,
        seenRevision: null,
        deltaItems: [],
      });
      return removed;
    },

    getWall(userId) {
      const key = userKey(userId);
      const pins = observationDb.listWatchEntries(key);
      const pinnedUris = new Set(pins.map((pin) => pin.uri));
      const cursors = new Map<string, number>();
      for (const cursor of observationDb.listSeenCursors(key)) {
        cursors.set(cursor.uri, cursor.revision);
      }

      const candidates: ObservationWallEntry[] = [];
      for (const row of observationDb.listObjects()) {
        const object = toObservedObject(row);
        const pinned = pinnedUris.has(object.uri);
        // An unpinned object is on the wall only while it needs attention; recovering to `ok`
        // (or to any other non-attention reading) is what makes it leave again.
        if (!pinned && object.status.state !== 'attention' && object.status.state !== 'red') {
          continue;
        }
        const seenRevision = cursors.get(object.uri) ?? 0;
        const deltaItems = observationDb
          .listRevisionsAfter(object.uri, seenRevision)
          .flatMap((revision) => parseDeltaItems(revision.deltaItemsJson));
        candidates.push({ object, pinned, seenRevision, deltaItems });
      }

      const pinned = candidates.filter((entry) => entry.pinned).sort(compareWallEntries);
      const unpinned = candidates.filter((entry) => !entry.pinned).sort(compareWallEntries);
      // Pinned entries are resident: they take their slots first and are never folded, so the
      // cap can only ever hide automatically surfaced objects.
      const room = Math.max(0, wallLimit - pinned.length);
      const shown = unpinned.slice(0, room);
      const collapsedCount = unpinned.length - shown.length;
      const entries = [...pinned, ...shown].sort(compareWallEntries);

      const producers = observationDb
        .listProducers()
        .map((heartbeat: ObservationProducerHeartbeatRow) => evaluateProducer(heartbeat, now()))
        .sort((left: ProducerReading, right: ProducerReading) => {
          const byState = left.state === 'ok' ? 1 : 0;
          const rightByState = right.state === 'ok' ? 1 : 0;
          return byState - rightByState || left.producer.localeCompare(right.producer);
        });
      const notOk = producers.filter((reading) => reading.state !== 'ok');
      const self: ObservationWallSelf | null =
        notOk.length === 0
          ? null
          : {
              title: '观察层自身',
              state: 'attention',
              reason: notOk
                .map((reading) => `${reading.producer}: ${reading.state}${reading.reason === null ? '' : ` (${reading.reason})`}`)
                .join('; '),
              blindSpots: [...OBSERVATION_LAYER_BLIND_SPOTS],
            };

      return { entries, collapsedCount, producers, self };
    },

    registerProducer(producer, expectedIntervalMs) {
      const name = typeof producer === 'string' ? producer.trim() : '';
      if (name === '') throw invalid('`producer` must be a non-empty string');
      if (!Number.isInteger(expectedIntervalMs) || expectedIntervalMs <= 0) {
        throw invalid('`expectedIntervalMs` must be a positive integer');
      }
      observationDb.registerProducer(name, expectedIntervalMs);
    },

    recordProducerAttempt(producer, error = null) {
      const name = typeof producer === 'string' ? producer.trim() : '';
      if (name === '') throw invalid('`producer` must be a non-empty string');
      const heartbeat = observationDb.readProducer(name);
      if (heartbeat === null) {
        throw invalid(`producer ${name} is not registered`, 'PRODUCER_NOT_REGISTERED');
      }
      if (error !== null && typeof error !== 'string') throw invalid('`error` must be a string or null');
      observationDb.recordProducerAttempt(name, now(), error === null ? null : error.trim() || 'producer failed');
    },
  };
}
