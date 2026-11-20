import { randomUUID } from 'node:crypto';

import type { ActivityProtocolSnapshot } from '@/shared/types.js';

/**
 * The leaf contract between the activity heartbeat and the activity protocol.
 *
 * Both sides used to read one value from the other (`BOOT_ID` one way,
 * `readActivityRevision` the other), which made the two files a package-local
 * import cycle (`cycle-websocket-services-two-pairs`). The values and frame
 * vocabulary they must agree on live here instead, so the dependency is
 * one-way: heartbeat → protocol → this leaf. Nothing here imports either
 * module — the file is a leaf, and an import back into it cannot close a
 * cycle.
 */

/**
 * The identity of the running process, generated once when this module is
 * loaded.
 *
 * A client uses it as "which server am I talking to": the value is stable for
 * the whole life of the process, and a different value means the server was
 * restarted, so every local "in progress" assumption has to be discarded. It is
 * deliberately a module constant and not a per-frame or per-connection value —
 * an id that changed between two frames would report a restart that never
 * happened.
 *
 * It lives in the contract because BOTH frames carry it: the heartbeat's
 * `activity.heartbeat` and the protocol's snapshots/upserts stamp the same id,
 * and each reads this one constant rather than minting its own, so the two can
 * never disagree about which process produced them.
 */
export const BOOT_ID = randomUUID();

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
