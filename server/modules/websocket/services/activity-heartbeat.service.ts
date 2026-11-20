import type { WebSocket } from 'ws';

import {
  readSessionTurn,
  type TurnPhase,
} from '@/modules/providers/index.js';
import { BOOT_ID } from '@/modules/websocket/services/activity-protocol.contract.js';
import { readActivityRevision } from '@/modules/websocket/services/activity-protocol.service.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * The two shipped timings for the business heartbeat, in milliseconds.
 *
 * These are the one place the shipped numbers live. A client is told both at
 * subscribe time (the `chat_subscribed` hello) and the server then beats at the
 * interval it announced, so a criterion that wants the shipped defaults reads
 * these constants instead of re-typing 5000 / 15000.
 *
 * The beat is what a browser can see: the process already has a protocol-level
 * `ping` (see `attachWebSocketHeartbeat`), but that is invisible to page
 * JavaScript, so it cannot tell a client whether the server is still there. The
 * unreachable threshold is deliberately a small multiple of the interval, so a
 * client that stops hearing frames can degrade after a few missed beats rather
 * than after one slow tick.
 */
export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 5_000;
export const ACTIVITY_UNREACHABLE_AFTER_MS = 15_000;

/**
 * The process identity both this heartbeat and the activity protocol stamp.
 *
 * It now lives in `activity-protocol.contract.ts` — the leaf the two modules
 * share — so this module never has to read it back out of the protocol module
 * (that import was half of the `cycle-websocket-services-two-pairs` SCC).
 * Re-exported here because the run registry and the websocket barrel import it
 * from this path.
 */
export { BOOT_ID };

/**
 * Reads the two shipped timings, applying the environment overrides a
 * process-level criterion uses to shorten the beat.
 *
 * The overrides exist so a criterion can watch several beats inside a test
 * budget; production leaves both unset and gets the shipped numbers. They are
 * read per call rather than captured at load so a caller that supplies its own
 * environment gets an answer about that environment. A non-positive or
 * unparsable value is ignored rather than accepted, because a zero interval
 * would spin the timer.
 */
export function resolveActivityHeartbeatConfig(
  env: NodeJS.ProcessEnv = process.env,
): { intervalMs: number; unreachableAfterMs: number } {
  return {
    intervalMs: readPositiveInt(env.ACTIVITY_HEARTBEAT_INTERVAL_MS, ACTIVITY_HEARTBEAT_INTERVAL_MS),
    unreachableAfterMs: readPositiveInt(env.ACTIVITY_UNREACHABLE_AFTER_MS, ACTIVITY_UNREACHABLE_AFTER_MS),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The revision a session's activity is currently at, read from the activity
 * protocol's single revision source.
 *
 * The heartbeat does not own the counter — it reads the store's, seeding a
 * session on first sight exactly as the store's `revision` does — so a beat and a
 * snapshot always carry the same number for a session, and the protocol's
 * `recordChange` is the one thing that can move it.
 */
function revisionForSession(sessionId: string): number {
  return readActivityRevision(sessionId);
}

/**
 * The activity fields a client is handed when it subscribes: who this server
 * is, the session's current activity revision, and the two timings the server
 * will use.
 *
 * Exported for this module's chat gateway, which spreads these onto the
 * `chat_subscribed` hello. The heartbeat frames it starts here are built from
 * exactly this state, so the hello and every frame that follows agree about the
 * boot id, the revision, and the beat.
 */
export function activityAnnouncement(sessionId: string): {
  bootId: string;
  rev: number;
  heartbeatIntervalMs: number;
  unreachableAfterMs: number;
  /** The phase the session's turn is in, as the frame forwarder last reduced it. */
  phase: TurnPhase;
  /** The pending tool's name while `phase` is `tool`, else null. */
  toolName: string | null;
} {
  const { intervalMs, unreachableAfterMs } = resolveActivityHeartbeatConfig();
  // The phase is read from the providers module's own reduction of the raw frame
  // stream — the same reading the client's dock renders. It is not derived here:
  // this module transports the answer, it does not compute one.
  //
  // `sessionId` here is the **app session id** a client subscribes with, and the
  // providers module must have fed the tracker under that same id. A tracker fed
  // the provider-native id instead would miss on every read and answer `idle`
  // for a running turn (gap-activity-turn-phase-id-space-mismatch); the fix for
  // that lives at the write seam (`forwardNormalizedFrames`'s `turnSessionId`),
  // not here — this module has only the app id and no provider id to translate to.
  const turn = readSessionTurn(sessionId);
  return {
    bootId: BOOT_ID,
    rev: revisionForSession(sessionId),
    heartbeatIntervalMs: intervalMs,
    unreachableAfterMs,
    phase: turn.phase,
    toolName: turn.toolName,
  };
}

/**
 * The `activity.heartbeat` frame for one session, built from the current state.
 *
 * `isProcessing` is the run registry's own answer to "is a run in flight for
 * this session", read at beat time. It is the authority the client needs to
 * tell a *finished* turn from a turn the phase tracker merely has no phase for:
 * `phase` comes from the frame forwarder's reduction (which reads `idle` for
 * any session it never saw a frame for), so a running turn whose provider sends
 * no phase-carrying frames would otherwise look ended. The hello carries the
 * same bit, read from the same registry, so the two frames can never disagree.
 */
function buildActivityHeartbeat(sessionId: string, isProcessing: boolean): {
  kind: 'activity.heartbeat';
  sessionId: string;
  bootId: string;
  rev: number;
  phase: TurnPhase;
  toolName: string | null;
  isProcessing: boolean;
  timestamp: string;
} {
  const { bootId, rev, phase, toolName } = activityAnnouncement(sessionId);
  return {
    kind: 'activity.heartbeat',
    sessionId,
    bootId,
    rev,
    phase,
    toolName,
    // Authoritative run-in-flight bit from the run registry, NOT a re-derivation
    // of `phase`. See the module's chat gateway, which injects the reader.
    isProcessing,
    timestamp: new Date().toISOString(),
  };
}

/** One running beat: the stop function, keyed by the session it belongs to. */
const heartbeatsBySocket = new WeakMap<WebSocket, Map<string, () => void>>();

/**
 * Starts the business heartbeat for one subscribed session on one socket, and
 * returns the function that stops it.
 *
 * Exported for this module's chat gateway: `chat.subscribe` is the one message
 * that says "a browser is now on this session", and it is the only place the
 * beat is armed. A socket that subscribes to the same session twice gets the
 * beat it is already running rather than a second one, so a page that reloads
 * and re-sends `chat.subscribe` does not double its own frame rate. The beat
 * also stops on the socket's own `close`/`error`, so a dead client leaves no
 * timer behind.
 *
 * `readTurnInFlight` is the run registry's own `isProcessing` for this session,
 * read on every beat so a run that ends between two beats is reported ended by
 * the next one. It is injected rather than imported: the registry must stay the
 * single owner of "is a run in flight", and this module must not take a
 * dependency on it just to transport the answer. The caller (the chat gateway)
 * already holds the registry and computes the same bit for the hello.
 */
export function attachActivityHeartbeat(
  ws: WebSocket,
  sessionId: string,
  readTurnInFlight: () => boolean,
): () => void {
  const bySession = heartbeatsBySocket.get(ws) ?? new Map<string, () => void>();
  heartbeatsBySocket.set(ws, bySession);

  const alreadyRunning = bySession.get(sessionId);
  if (alreadyRunning) {
    return alreadyRunning;
  }

  const sendFrame = () => {
    if (ws.readyState !== WS_OPEN_STATE) {
      stopBeat();
      return;
    }
    try {
      ws.send(JSON.stringify(buildActivityHeartbeat(sessionId, readTurnInFlight())));
    } catch {
      // A socket that throws on send is one the close/error path would have
      // handled anyway; stop here so the timer cannot outlive it.
      stopBeat();
    }
  };

  const timer = setInterval(sendFrame, resolveActivityHeartbeatConfig().intervalMs);
  // The beat is a liveness signal, not a reason for the process to stay alive.
  // A real server is already held open by its listening socket; unref'ing this
  // timer means a shutting-down server is never kept up by a beat nobody can
  // receive, and — the case that matters for the criteria — a test that drives
  // the gateway with an in-process socket surface and never emits `close` can
  // still exit once its own work is done instead of hanging on a live interval.
  timer.unref();

  function stopBeat(): void {
    clearInterval(timer);
    bySession.delete(sessionId);
    if (bySession.size === 0) {
      heartbeatsBySocket.delete(ws);
    }
    ws.off('close', stopBeat);
    ws.off('error', stopBeat);
  }

  ws.on('close', stopBeat);
  ws.on('error', stopBeat);
  bySession.set(sessionId, stopBeat);

  return stopBeat;
}
