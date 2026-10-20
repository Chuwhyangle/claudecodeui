/**
 * The client's control half of the activity dock: the two requests a person can
 * place against the work a session is holding — stop a background task, and move
 * a running foreground tool to the background.
 *
 * The controls hold no state. A click sends exactly one frame over the app's own
 * socket and changes nothing locally:
 *
 *  - `chat.stop-task` `{ sessionId, taskId, requestId }`
 *  - `chat.background-task` `{ sessionId, toolUseId, requestId }`
 *
 * A row's state, and whether a backgrounded task has appeared at all, come back
 * only through the server's own `activity.snapshot` / `activity.upsert` frames
 * (reduced into `useSessionActivity`). That is what makes "the click is not
 * optimistic" a reading a criterion can take: this module imports no store
 * writer, so there is no local path by which a click could move a row.
 *
 * Whether a control can be used has **two** readings, and both are needed:
 *
 *  - *liveness* (`useActivityFreshness`): when the dock has gone `unreachable`,
 *    no request can be placed at all, and both controls are disabled with the
 *    composer stop's own `claudeStatus.unreachable.stopReason`;
 *  - *capability*: the provider's own statement about the verb, read from
 *    `GET /api/providers/capabilities` for the session's provider. A resident
 *    session whose provider declares no such verb gets a control that is
 *    disabled **and says why**, rather than one that looks live, takes the
 *    click, and quietly does nothing — the shape this gate exists to remove.
 *
 * The capability applies to a *resident* session only, and that is the matrix's
 * own rule rather than a client-side one: `residentFeatures` describes what a
 * held process can do. A per-run turn is placed through the runtime's own
 * verb, which is a different route the matrix says nothing about, so a per-run
 * session keeps its control enabled however the resident declaration reads.
 * {@link readSessionHostState} is where the session's provider and lifecycle
 * mode come from — the two facts the server's own gate reads — so the control
 * that will not be clicked and the request that would be refused cannot
 * disagree.
 *
 * The pending foreground tool is read off the loaded transcript, never derived
 * here: the server's Turn Tracker is authoritative for "which tool_use is
 * unpaired", and the transcript is where its id is on screen. {@link
 * findPendingForegroundTool} is the one place that reading is taken, so the
 * panel and any other reader agree.
 */

import { useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import WebSocketContext from '@/shared/context/WebSocketContext';
import { findSessionHostState, useSessionHosts } from '@/shared/hooks/useSessionHosts';
import type { SessionHostsSnapshot, SessionHostStateView } from '@/shared/types';
import type { ChatMessage } from '@/shared/types';
import type { ActivityLiveness } from '@/modules/chat/utils/session/activityFreshness';

/** One running foreground tool the dock can offer to move to the background. */
export type ForegroundTool = {
  /** The `tool_use.id` the server's Turn Tracker is holding as pending. */
  toolUseId: string;
  /** The tool's name, drawn beside the control. */
  toolName: string;
};

/** What the dock's controls need: the two senders plus the two disabled readings. */
export type ActivityControls = {
  /** The liveness the buttons go by; an unreachable dock disables both. */
  liveness: ActivityLiveness;
  /** True when no stop can be placed — unreachable, or the provider declares no verb. */
  stopDisabled: boolean;
  /** Why the stop is disabled, for its `[data-control-disabled-reason]` text. */
  stopDisabledReason: string;
  /** True when no background request can be placed — same two readings. */
  backgroundDisabled: boolean;
  /** Why the background control is disabled, for its own reason text. */
  backgroundDisabledReason: string;
  /** Places a stop request for one task. Changes nothing locally. */
  stopTask: (taskId: string) => void;
  /** Places a background request for one foreground tool. Changes nothing locally. */
  backgroundTool: (toolUseId: string) => void;
};

/**
 * One provider's resident control declarations, as the matrix states them.
 *
 * Both fields read `false` when absent: the matrix's own "a capability nobody
 * measured is not a capability this matrix may promise" rule, which the client
 * must not soften into "unknown means yes".
 */
type ResidentControlCapability = {
  stopTask: boolean;
  backgroundTasks: boolean;
};

/**
 * The capability rows one page needs, keyed by provider id.
 *
 * Cached at module scope for the life of the document because the matrix is a
 * static statement about the build: two docks, or a remount, must not each
 * re-fetch it. `null` means "not answered yet" and is deliberately distinct
 * from an empty map — an empty map is the server saying it declares no provider
 * at all, which is a real answer the gate may act on, while `null` is no answer
 * yet, which it may not.
 */
let cachedResidentControls: Map<string, ResidentControlCapability> | null = null;
let inFlightResidentControls: Promise<Map<string, ResidentControlCapability> | null> | null = null;

/**
 * Reads the resident control declarations off the capability matrix.
 *
 * A failed read answers `null` and is *not* cached: a transient failure must not
 * disable the dock's controls for the rest of the page's life, so the next mount
 * tries again, and until then the caller reads `null` (no answer) and applies no
 * capability gate. The server remains the authority either way — it refuses a
 * placed request it cannot carry — so the worst a failed read costs is a control
 * that is offered and then refused out loud, never one that is offered and
 * silently inert.
 *
 * The shared `useProviderCapabilities` hook is not reused here: it declares only
 * the fields its own consumers read (`lifecycleModes`, `supportsSessionForking`)
 * and this module needs `residentFeatures`, which that hook's row type does not
 * carry. Widening it would be a change to a module this one does not own for a
 * consumer it does not have.
 */
async function loadResidentControls(): Promise<Map<string, ResidentControlCapability> | null> {
  if (cachedResidentControls) {
    return cachedResidentControls;
  }
  if (inFlightResidentControls) {
    return inFlightResidentControls;
  }

  inFlightResidentControls = (async () => {
    try {
      const response = await api.providers.capabilities();
      const body = (await response.json()) as {
        success?: boolean;
        data?: { providers?: Array<{ provider?: string; residentFeatures?: Record<string, unknown> }> };
      };
      const rows = body.success && Array.isArray(body.data?.providers) ? body.data.providers : [];
      const byProvider = new Map<string, ResidentControlCapability>();
      for (const row of rows) {
        if (typeof row?.provider !== 'string') {
          continue;
        }
        byProvider.set(row.provider, {
          stopTask: row.residentFeatures?.stopTask === true,
          backgroundTasks: row.residentFeatures?.backgroundTasks === true,
        });
      }
      cachedResidentControls = byProvider;
      return byProvider;
    } catch (error) {
      console.error('Error loading provider capabilities:', error);
      return null;
    } finally {
      inFlightResidentControls = null;
    }
  })();

  return inFlightResidentControls;
}

/**
 * The session's own provider and lifecycle mode, or null when the listing does
 * not carry it (yet).
 *
 * Null is "no answer", not "no capability": the caller treats it as "apply no
 * capability gate", which is the direction that cannot invent a refusal. It is
 * also the reading a session with no row at all produces — a brand-new session
 * before its first poll — and the one a hand-built snapshot in a unit test
 * produces, so neither has to know this gate exists.
 */
function readSessionHostState(
  snapshot: SessionHostsSnapshot | null,
  sessionId: string | null | undefined,
): SessionHostStateView | null {
  if (!sessionId) {
    return null;
  }
  return findSessionHostState(snapshot, sessionId);
}

/**
 * A request id for one control frame.
 *
 * The server echoes it on the `control_result` receipt; nothing on this side
 * correlates it today, but the protocol requires a non-empty string, so this
 * mints one. `crypto.randomUUID` is absent in some non-secure/test contexts, so
 * the fallback keeps the frame well-formed there rather than throwing inside a
 * click handler.
 */
function newRequestId(): string {
  const cryptoRef = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The pending foreground tool in a loaded transcript, or null.
 *
 * A tool is pending exactly when its `tool_use` row has no paired result —
 * `useChatMessages` has already resolved the pairing onto each row's
 * `toolResult`, so this reads that rather than re-scanning for results. When
 * more than one is unpaired the last one is the pending one, matching the
 * server's tracker (each `tool_use` overwrites the id it holds).
 */
export function findPendingForegroundTool(
  messages: ChatMessage[] | null | undefined,
): ForegroundTool | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  let pending: ForegroundTool | null = null;
  for (const message of messages) {
    if (message?.isToolUse === true && !message.toolResult) {
      const toolUseId = typeof message.toolId === 'string' ? message.toolId : '';
      if (toolUseId) {
        pending = { toolUseId, toolName: message.toolName ?? '' };
      }
    }
  }
  return pending;
}

/**
 * The dock's control handlers for one session, given the liveness reading its
 * caller already holds.
 *
 * `liveness` is a parameter rather than a fresh `useActivityFreshness` call so
 * the dock runs one freshness machine, not two: the machine that drives the
 * dock's own state is the same one that disables its controls.
 */
export function useActivityControls(
  sessionId: string | null | undefined,
  liveness: ActivityLiveness,
): ActivityControls {
  const { t } = useTranslation('chat');
  const connection = useContext(WebSocketContext);
  const sendMessage = connection?.sendMessage;
  const isConnected = connection?.isConnected ?? false;
  const { snapshot: hostsSnapshot } = useSessionHosts();
  const [residentControls, setResidentControls] = useState<Map<string, ResidentControlCapability> | null>(
    cachedResidentControls,
  );

  // Read once per mount and share the module cache across mounts; the matrix
  // does not move while the server is up, so there is nothing to poll for.
  useEffect(() => {
    let cancelled = false;
    void loadResidentControls().then((controls) => {
      if (!cancelled) {
        setResidentControls(controls);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const hostState = readSessionHostState(hostsSnapshot, sessionId);
  // The capability half: only a resident session's provider states these verbs,
  // and only once the matrix has actually answered (`residentControls !== null`).
  const residentSession = hostState?.lifecycleMode === 'resident';
  const declared =
    residentSession && residentControls !== null && hostState
      ? residentControls.get(hostState.provider) ?? null
      : null;
  const stopUnsupported = residentSession && residentControls !== null && declared?.stopTask !== true;
  const backgroundUnsupported =
    residentSession && residentControls !== null && declared?.backgroundTasks !== true;

  const unreachable = liveness === 'unreachable' || !isConnected || !sendMessage;
  const unreachableReason = t('claudeStatus.unreachable.stopReason', {
    defaultValue: 'Stop is unavailable while the server is unreachable',
  });
  const stopUnsupportedReason = t('claudeStatus.controls.stopTaskUnsupported', {
    defaultValue: 'This provider cannot stop a background task, so there is nothing to place',
  });
  const backgroundUnsupportedReason = t('claudeStatus.controls.backgroundToolUnsupported', {
    defaultValue: 'This provider cannot move a running tool to the background',
  });

  const stopTask = useCallback(
    (taskId: string) => {
      if (!sendMessage || !sessionId || !taskId) {
        return;
      }
      sendMessage({ type: 'chat.stop-task', sessionId, taskId, requestId: newRequestId() });
    },
    [sendMessage, sessionId],
  );

  const backgroundTool = useCallback(
    (toolUseId: string) => {
      if (!sendMessage || !sessionId || !toolUseId) {
        return;
      }
      sendMessage({ type: 'chat.background-task', sessionId, toolUseId, requestId: newRequestId() });
    },
    [sendMessage, sessionId],
  );

  return {
    liveness,
    stopDisabled: unreachable || stopUnsupported,
    stopDisabledReason: unreachable ? unreachableReason : stopUnsupportedReason,
    backgroundDisabled: unreachable || backgroundUnsupported,
    backgroundDisabledReason: unreachable ? unreachableReason : backgroundUnsupportedReason,
    stopTask,
    backgroundTool,
  };
}
