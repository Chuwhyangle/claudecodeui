import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import WebSocketContext from '@/shared/context/WebSocketContext';
import type {
  ActivityPhase,
  IsSessionProcessing,
  MarkSessionIdle,
  MarkSessionProcessing,
  ServerEvent,
  SessionActivity,
  SessionActivityMap,
  SyncProcessingSessions,
} from '@/shared/types';
import { api } from '@/shared/api';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
  };
};

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
};

/**
 * What the activity snapshot last said one session's turn is doing.
 *
 * The server's snapshot frames (`activity.snapshot` / `activity.upsert`) and its
 * heartbeat both carry the phase reduction and the pending tool's name; the
 * snapshot also names the instant it was taken (`asOf`). This is the client's
 * per-session account of that reading — a passthrough, never a phase computed
 * here — merged onto the activity map so the sidebar can render it.
 */
type SessionTurnReading = {
  /** The phase the server last reported. */
  phase: ActivityPhase;
  /** The pending tool's name while `phase` is `tool`, else null. */
  toolName: string | null;
  /**
   * Client-clock instant the frame carrying this reading arrived. It is what
   * keeps an earlier turn's reading from being drawn on a later turn: a
   * reading older than the turn it would be drawn on is not this turn's.
   */
  observedAt: number;
};

/**
 * Slack applied when comparing a reading's arrival against a turn's start.
 *
 * The two clocks are normally the same process's, but a browser clock need not
 * agree with the server's to the second. A reading that arrived within this
 * window of the turn's start is still this turn's; an older one belongs to a
 * turn that has ended.
 */
const STALE_READING_TOLERANCE_MS = 60_000;

/** Every phase the server may report, so an unrecognised value is ignored rather than drawn. */
const ACTIVITY_PHASES: ReadonlySet<string> = new Set<ActivityPhase>([
  'idle',
  'thinking',
  'writing',
  'tool',
  'awaitingPermission',
  'compacting',
]);

/** The phase one frame carries, or null when it reports none this build knows. */
const readPhase = (value: unknown): ActivityPhase | null =>
  typeof value === 'string' && ACTIVITY_PHASES.has(value) ? (value as ActivityPhase) : null;

/** The tool name one frame carries, or null. Only meaningful alongside a `tool` phase. */
const readToolName = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const EMPTY_TURN_READINGS: ReadonlyMap<string, SessionTurnReading> = new Map();

/**
 * The per-session activity entries, published as a subscription as well as
 * through {@link useProcessingSessions}.
 *
 * The map is the right reading for a surface that draws every running session
 * (the Running view), but the wrong one for a row: a provider `status` frame
 * allocates a new map several times a second during a run, and a sidebar row
 * that read the map itself would re-render on all of it — the same regression
 * `useBusySessionIdSet` exists to prevent. This store hands one entry back by
 * id and keeps its identity while that entry is unchanged, so a row re-renders
 * only when its own session's activity moved.
 */
type SessionActivityEntryStore = {
  subscribe: (listener: () => void) => () => void;
  get: (sessionId: string) => SessionActivity | undefined;
};

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const SessionActivityEntryContext = createContext<SessionActivityEntryStore | null>(null);

/**
 * The set of session ids currently producing a response, with a stable identity
 * while membership is unchanged.
 *
 * Every provider `status` frame rewrites an entry's `statusText`, which
 * allocates a new activity map several times a second during a run. Consumers
 * that only need membership — the sidebar renders a dot per row and a running
 * count — would re-render on all of it.
 */
function useBusySessionIds(processingSessions: SessionActivityMap): ReadonlySet<string> {
  // Deriving the set from a membership key, rather than from the map, keeps its
  // identity stable across the `statusText` rewrites without reading a ref
  // during render. Session ids never contain a NUL, so it is a safe separator.
  const membershipKey = [...processingSessions.keys()].sort().join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Mounted by the project-workspace route; tracks which sessions are producing a response so chat, sidebar and project-workspace agree on session activity. */
export function SessionProtectionProvider({ children }: { children: ReactNode }) {
  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
    isSessionProcessing,
  } = useSessionProtection();

  // The page's one socket, read directly so a unit render with no provider
  // simply has no frames to fold rather than throwing.
  const connection = useContext(WebSocketContext);
  const subscribeFrames = connection?.subscribe;
  const sendMessage = connection?.sendMessage;
  const isConnected = connection?.isConnected ?? false;

  /**
   * The turn reading the activity frames last delivered, keyed by session.
   *
   * The sidebar draws a running session's phase without opening it, and the
   * phase is a server reduction the client may not compute itself. This state
   * is where those frames land: the activity snapshot names the turn's phase
   * and pending tool, the heartbeat repeats them, and the `chat_subscribed`
   * hello carries the same announcement for the session a reader is viewing.
   * Nothing here derives a phase — an unrecognised value leaves the last
   * reading alone.
   */
  const [turnReadings, setTurnReadings] = useState<ReadonlyMap<string, SessionTurnReading>>(
    EMPTY_TURN_READINGS,
  );

  const applyTurnReading = useCallback(
    (sessionId: string, phase: ActivityPhase, toolName: string | null) => {
      setTurnReadings((prev) => {
        // Arrival time is part of the reading, so an unchanged phase still
        // refreshes it: a new turn that opens on the same word must not be
        // mistaken for the old turn's reading.
        const updated = new Map(prev);
        updated.set(sessionId, { phase, toolName, observedAt: Date.now() });
        return updated;
      });
    },
    [],
  );

  // Fold every activity frame the page hears. `useProcessingSessions` then
  // carries the reading, so a row's phase comes from the same snapshot the
  // dock reads rather than from a second subscription with its own opinion.
  useEffect(() => {
    if (!subscribeFrames) {
      return undefined;
    }

    return subscribeFrames((event: ServerEvent) => {
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
      if (!sessionId) {
        return;
      }

      if (event.kind === 'activity.snapshot' || event.kind === 'activity.upsert') {
        // The snapshot's `turn` is the server's reduction; `phase` is the half
        // this store keeps, and `toolName` is only meaningful while it is `tool`.
        const turn = event.turn;
        const reading = typeof turn === 'object' && turn !== null
          ? (turn as Record<string, unknown>)
          : null;
        const phase = readPhase(reading?.phase);
        if (phase !== null) {
          applyTurnReading(sessionId, phase, readToolName(reading?.toolName));
        }
        return;
      }

      if (event.kind === 'activity.heartbeat' || event.kind === 'chat_subscribed') {
        const phase = readPhase(event.phase);
        if (phase !== null) {
          applyTurnReading(sessionId, phase, readToolName(event.toolName));
        }
      }
    });
  }, [subscribeFrames, applyTurnReading]);

  // A session that stops processing drops its reading, so the next turn starts
  // from "no phase named yet" rather than redrawing the previous turn's tool.
  const previouslyRunningRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(processingSessions.keys());
    const ended = [...previouslyRunningRef.current].filter((sessionId) => !current.has(sessionId));
    previouslyRunningRef.current = current;
    if (ended.length === 0) {
      return;
    }
    setTurnReadings((prev) => {
      if (!ended.some((sessionId) => prev.has(sessionId))) {
        return prev;
      }
      const updated = new Map(prev);
      for (const sessionId of ended) {
        updated.delete(sessionId);
      }
      return updated;
    });
  }, [processingSessions]);

  // Ask the server to feed this page each running session's activity snapshot.
  // The snapshot is the only frame that names the turn's phase for a session
  // nobody has opened, so the sidebar's reading has to be requested: the feed's
  // own verb, never `chat.subscribe` (whose reply is the run's replay stream).
  // Re-sent after a reconnect because subscriptions live with the socket.
  const requestedFeedsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isConnected) {
      requestedFeedsRef.current.clear();
      return;
    }
    if (!sendMessage) {
      return;
    }
    for (const sessionId of processingSessions.keys()) {
      if (requestedFeedsRef.current.has(sessionId)) {
        continue;
      }
      requestedFeedsRef.current.add(sessionId);
      sendMessage({ type: 'activity.subscribe', sessionId });
    }
  }, [processingSessions, isConnected, sendMessage]);

  /**
   * The activity map with the snapshot's turn reading merged onto each entry.
   *
   * Identity is preserved when nothing moved — including when there is no turn
   * reading at all — so consumers of the map keep the same bail-out they had
   * before this reading existed.
   */
  const sessionsWithTurn = useMemo(() => {
    if (turnReadings.size === 0) {
      return processingSessions;
    }
    let changed = false;
    const merged = new Map(processingSessions);
    for (const [sessionId, activity] of merged) {
      const reading = turnReadings.get(sessionId);
      if (!reading) {
        continue;
      }
      // A reading older than the turn it would be attached to describes a turn
      // that has already ended — drawing it would be the sidebar claiming the
      // previous tool while the new turn is doing something else.
      if (reading.observedAt + STALE_READING_TOLERANCE_MS < activity.startedAt) {
        continue;
      }
      const toolName = reading.toolName ?? null;
      if (activity.phase === reading.phase && (activity.toolName ?? null) === toolName) {
        continue;
      }
      merged.set(sessionId, { ...activity, phase: reading.phase, toolName });
      changed = true;
    }
    return changed ? merged : processingSessions;
  }, [processingSessions, turnReadings]);

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );
    } catch (error) {
      console.error('[SessionProtection] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      syncProcessingSessions,
      isSessionProcessing,
    }),
    [
      isSessionProcessing,
      markSessionIdle,
      markSessionProcessing,
      syncProcessingSessions,
    ],
  );

  const busySessionIds = useBusySessionIds(processingSessions);

  // The read half of the entry store: callers subscribe to the map's changes
  // but read one entry, so an update to another session cannot re-render them.
  const sessionsWithTurnRef = useRef<SessionActivityMap>(sessionsWithTurn);
  const entryListenersRef = useRef<Set<() => void>>(new Set());
  const emitEntryChange = useCallback(() => {
    for (const listener of [...entryListenersRef.current]) {
      listener();
    }
  }, []);
  useEffect(() => {
    // The store's frame: the ref is what `get` reads, and the emission is what
    // tells already-subscribed rows to take a reading. Both happen after commit
    // so a row never sees a map from a render React did not finish.
    sessionsWithTurnRef.current = sessionsWithTurn;
    emitEntryChange();
  }, [sessionsWithTurn, emitEntryChange]);
  const entryStore = useMemo<SessionActivityEntryStore>(
    () => ({
      subscribe: (listener) => {
        entryListenersRef.current.add(listener);
        return () => {
          entryListenersRef.current.delete(listener);
        };
      },
      get: (sessionId) => sessionsWithTurnRef.current.get(sessionId),
    }),
    [],
  );

  return (
    <SessionProtectionActionsContext.Provider value={actions}>
      <BusySessionIdsContext.Provider value={busySessionIds}>
        <SessionActivityEntryContext.Provider value={entryStore}>
          <SessionProtectionStateContext.Provider value={sessionsWithTurn}>
            {children}
          </SessionProtectionStateContext.Provider>
        </SessionActivityEntryContext.Provider>
      </BusySessionIdsContext.Provider>
    </SessionProtectionActionsContext.Provider>
  );
}

/**
 * Membership-only view of the running sessions. Prefer this over
 * useProcessingSessions wherever the activity details are not rendered.
 */
export function useBusySessionIdSet(): ReadonlySet<string> {
  const busySessionIds = useContext(BusySessionIdsContext);
  if (!busySessionIds) {
    throw new Error('useBusySessionIdSet must be used within SessionProtectionProvider');
  }
  return busySessionIds;
}

export function useProcessingSessions(): SessionActivityMap {
  const processingSessions = useContext(SessionProtectionStateContext);
  if (!processingSessions) {
    throw new Error('useProcessingSessions must be used within SessionProtectionProvider');
  }
  return processingSessions;
}

/** The one subscriber a row without a provider gets; there is never anything to emit. */
const noopSubscribe = () => () => undefined;

/**
 * One session's activity entry, with the snapshot's phase merged on.
 *
 * This is the reading a sidebar row needs for its own session and no other. A
 * row cannot use {@link useProcessingSessions} for it: that map is allocated
 * anew on every provider `status` frame (several times a second during a run),
 * and a row subscribing to it would re-render on every one — the regression
 * `useBusySessionIdSet` exists to prevent. Here the subscription is to the
 * map's changes but the snapshot is a single entry, so an update to a sibling
 * session leaves this row untouched.
 *
 * A row rendered outside the provider (a unit render of the row alone) reads
 * `undefined` and draws as an idle row rather than throwing.
 */
export function useSessionActivityEntry(sessionId?: string | null): SessionActivity | undefined {
  const store = useContext(SessionActivityEntryContext);
  const subscribe = store?.subscribe ?? noopSubscribe;
  const getSnapshot = useCallback(
    () => (sessionId ? store?.get(sessionId) : undefined),
    [store, sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSessionProtectionActions(): SessionProtectionActions {
  const actions = useContext(SessionProtectionActionsContext);
  if (!actions) {
    throw new Error('useSessionProtectionActions must be used within SessionProtectionProvider');
  }
  return actions;
}
