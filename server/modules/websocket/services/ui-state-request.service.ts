import { randomUUID } from 'node:crypto';

import type {
  AnyRecord,
  RealtimeClientConnection,
  UiStateRequestOptions,
  UiStateRequestTarget,
  UiVisibleContextDevice,
  UiVisibleContextReport,
  UiVisibleContextTab,
} from '@/shared/types.js';
import { uiClientRegistry } from '@/modules/websocket/services/ui-client-registry.service.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
export type { UiStateRequestOptions };


/**
 * Asking the browsers what they are showing, and collecting the answers.
 *
 * This is a PULL, not a presence store. Nothing is reported on a schedule and
 * nothing is cached: one call broadcasts a `ui.state_request` carrying a fresh
 * `requestId`, every addressed tab answers with a `ui.state_response` echoing
 * that id, and the call returns when either every asked tab has answered or the
 * window closes — whichever comes first. A tab that never answers is a fact the
 * caller reads (`unresponsive: true`) rather than a reason to fail: one closed
 * laptop lid must not make the whole question unanswerable.
 *
 * The `requestId` is what keeps two overlapping calls apart. Answers are matched
 * against the one pending request that minted the id and are dropped otherwise —
 * including an answer that arrives after its own request already returned, which
 * is why a late frame can never be read into the NEXT call's result. The id is
 * generated here and never reused.
 *
 * The same round trip is the primitive the other UI-facing MCP tools share
 * (`ui_clients_list`, `ui_open_session`), so a second tool asking a browser
 * something does not need a second protocol.
 */

/** How long a call waits for answers before it reports the rest as unresponsive. */
export const UI_STATE_REQUEST_DEFAULT_TIMEOUT_MS = 1500;

/**
 * One pending call: the collector the matching answers are handed to.
 *
 * `onAnswer` is called with the connection that answered, so two tabs of one
 * browser are two answers rather than one — and a second answer from the same
 * connection is ignored, because a tab is asked exactly once per request.
 */
type PendingUiStateRequest = {
  onAnswer: (connection: RealtimeClientConnection, report: UiVisibleContextReport) => void;
};

/** The injected seams: where the addressed connections come from, and the clock-free rest. */
export type UiStateRequestDeps = {
  /**
   * The live connections to ask, all devices unless one `deviceId` is named.
   *
   * Production binds this to the UI client registry's `listUiClientTargets`; a
   * criterion binds it to its own registry so the fixtures it drove are the ones
   * asked.
   */
  listTargets: (deviceId?: string) => UiStateRequestTarget[];
  /**
   * How one frame is written to one connection. Defaults to a JSON write, which
   * is what a real socket needs; a criterion can substitute a recorder.
   */
  send?: (connection: RealtimeClientConnection, frame: unknown) => void;
};



/** The round trip, as its two callers see it: ask, and hand in an answer. */
export type UiStateRequestService = {
  /**
   * Broadcasts one `ui.state_request` and resolves with what the browsers
   * answered, grouped by device and ordered by the newest tab focus first.
   *
   * Resolves as soon as every asked tab has answered, so a healthy round trip
   * costs one round trip rather than the full window. No devices at all (or none
   * of the named one) resolves immediately with `[]` — there is nobody to wait
   * for. A connection that closes between the registry read and the write is
   * simply unanswered, not an error.
   */
  requestUiState(options?: UiStateRequestOptions): Promise<UiVisibleContextDevice[]>;
  /**
   * Routes one inbound `ui.state_response` to the call that asked for it.
   *
   * Returns true when the frame was a well-formed answer to a request that is
   * still open; false when it was malformed, mis-addressed, or late — in every
   * false case the frame is dropped without effect, which is what makes a
   * duplicated or stale answer harmless.
   */
  handleResponse(connection: RealtimeClientConnection, frame: unknown): boolean;
};

/** A non-empty string, or null. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A finite number, or null. */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A non-negative integer count; anything else reads as 0 (there is no such thing as a negative queue). */
function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The visible message id range, with each end null when the tab reports none. */
function readVisibleMessages(value: unknown): { first: string | null; last: string | null } {
  if (value === null || typeof value !== 'object') {
    return { first: null, last: null };
  }
  const record = value as AnyRecord;
  return { first: readText(record.first), last: readText(record.last) };
}

/** A list of non-empty strings; anything else reads as empty. */
function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    const text = readText(entry);
    if (text !== null) {
      out.push(text);
    }
  }
  return out;
}

/** The expanded-diff reading, or null when the Git panel is not the active panel. */
function readCurrentDiff(value: unknown): UiVisibleContextReport['currentDiff'] {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as AnyRecord;
  const view = readText(record.view);
  if (view === null) {
    return null;
  }
  return { view, files: readStringList(record.files), commits: readStringList(record.commits) };
}

/** The focused-task reading, or null when no task is focused. */
function readCurrentTask(value: unknown): UiVisibleContextReport['currentTask'] {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as AnyRecord;
  const id = readText(record.id);
  // Only TaskMaster has a selection surface; any other `source` is not a reading
  // this vocabulary carries, so it is dropped rather than passed through.
  if (id === null || record.source !== 'taskmaster') {
    return null;
  }
  return { source: 'taskmaster', id, title: readText(record.title) };
}

/** The most characters of a selection the projection will carry, whatever a browser sent. */
const SELECTED_TEXT_MAX_LENGTH = 500;

/**
 * The transcript-selection reading, or null.
 *
 * The projection re-imposes the cap the browser already applied, so a client
 * that sends an over-long `text` cannot widen what crosses this boundary, and it
 * accepts only the one region this vocabulary defines. This is the ONE
 * content-bearing field the projection reads; `ui_visible_context` keeps it out
 * of its result and only the separately-scoped `ui_selected_text` delivers it.
 */
function readSelectedText(value: unknown): UiVisibleContextReport['selectedText'] {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const record = value as AnyRecord;
  const text = typeof record.text === 'string' ? record.text : null;
  if (text === null || record.region !== 'transcript') {
    return null;
  }
  const overLong = text.length > SELECTED_TEXT_MAX_LENGTH || record.truncated === true;
  return {
    text: text.length > SELECTED_TEXT_MAX_LENGTH ? text.slice(0, SELECTED_TEXT_MAX_LENGTH) : text,
    truncated: overLong,
    region: 'transcript',
  };
}

/**
 * Projects a frame down to {@link UiVisibleContextReport} — the whitelist.
 *
 * A field is copied only when it is one of the report's own: whatever else the
 * frame carries (a message body, a whole panel's content, a key a later client
 * invents) is read by nobody and reaches no caller. The one content-bearing
 * field, `selectedText`, is read HERE but delivered only through the
 * separately-scoped `ui_selected_text` tool; `ui_visible_context` strips it, so a
 * cloudcli:read caller cannot reach the text. The two fields that decide whether
 * this is an answer at all are `visibility` and `hasFocus`: a frame missing
 * either is not a reading and is dropped, so the tab counts as unresponsive
 * rather than being reported as showing nothing.
 */
function readReport(frame: AnyRecord): UiVisibleContextReport | null {
  const visibility =
    frame.visibility === 'visible' ? 'visible' : frame.visibility === 'hidden' ? 'hidden' : null;
  if (visibility === null || typeof frame.hasFocus !== 'boolean') {
    return null;
  }

  return {
    navigationPolicy: readText(frame.navigationPolicy) ?? 'ask',
    visibility,
    hasFocus: frame.hasFocus,
    lastFocusedAt: readNumber(frame.lastFocusedAt),
    panel: readText(frame.panel),
    selectedProject: readText(frame.selectedProject),
    selectedSession: readText(frame.selectedSession),
    visibleMessages: readVisibleMessages(frame.visibleMessages),
    pendingApprovals: readCount(frame.pendingApprovals),
    queuedMessages: readCount(frame.queuedMessages),
    currentDiff: readCurrentDiff(frame.currentDiff),
    currentTask: readCurrentTask(frame.currentTask),
    selectedText: readSelectedText(frame.selectedText),
  };
}

/** One tab entry for a tab that did not answer: known identity, no report. */
function unresponsiveTab(target: UiStateRequestTarget): UiVisibleContextTab {
  return {
    tabId: target.tabId,
    deviceName: target.deviceName,
    unresponsive: true,
    navigationPolicy: null,
    visibility: null,
    hasFocus: null,
    lastFocusedAt: null,
    panel: null,
    selectedProject: null,
    selectedSession: null,
    visibleMessages: null,
    pendingApprovals: null,
    queuedMessages: null,
    currentDiff: null,
    currentTask: null,
    selectedText: null,
  };
}

/** The sort key of one tab: its focus moment, with "never answered / never focused" sorting last. */
function tabFocusKey(tab: UiVisibleContextTab): number {
  return tab.lastFocusedAt ?? Number.NEGATIVE_INFINITY;
}

/**
 * Groups the answers by device — the shape the MCP tool returns — ordering
 * devices and their tabs by the newest tab focus first.
 *
 * Every addressed target appears, answered or not, so the caller can tell "this
 * device has three tabs and one of them is asleep" from "this device has two
 * tabs". A device's own `lastFocusedAt` is the newest of its tabs', and its name
 * is taken from its most recently connected tab, matching what `listUiClients`
 * publishes for the same device.
 */
function groupByDevice(
  targets: readonly UiStateRequestTarget[],
  answers: Map<RealtimeClientConnection, UiVisibleContextReport>,
): UiVisibleContextDevice[] {
  const byDevice = new Map<string, UiVisibleContextDevice>();
  const newestTabByDevice = new Map<string, number>();

  for (const target of targets) {
    const report = answers.get(target.connection);
    const tab: UiVisibleContextTab =
      report === undefined
        ? unresponsiveTab(target)
        : {
            tabId: target.tabId,
            deviceName: target.deviceName,
            unresponsive: false,
            ...report,
          };

    let device = byDevice.get(target.deviceId);
    if (device === undefined) {
      device = { deviceId: target.deviceId, deviceName: target.deviceName, lastFocusedAt: null, tabs: [] };
      byDevice.set(target.deviceId, device);
    }
    device.tabs.push(tab);
    if (tab.lastFocusedAt !== null && (device.lastFocusedAt === null || tab.lastFocusedAt > device.lastFocusedAt)) {
      device.lastFocusedAt = tab.lastFocusedAt;
    }

    const newest = newestTabByDevice.get(target.deviceId);
    if (newest === undefined || target.connectedAt >= newest) {
      newestTabByDevice.set(target.deviceId, target.connectedAt);
      device.deviceName = target.deviceName;
    }
  }

  for (const device of byDevice.values()) {
    device.tabs.sort((left, right) => tabFocusKey(right) - tabFocusKey(left));
  }

  return [...byDevice.values()].sort(
    (left, right) =>
      (right.lastFocusedAt ?? Number.NEGATIVE_INFINITY) - (left.lastFocusedAt ?? Number.NEGATIVE_INFINITY),
  );
}

/**
 * Builds a round trip over the injected seams.
 *
 * Production uses the process-wide {@link uiStateRequestService}; the factory
 * exists so a criterion can drive a round trip against a registry and a clock of
 * its own, with no process-wide request left pending when the case ends.
 */
export function createUiStateRequestService(deps: UiStateRequestDeps): UiStateRequestService {
  /** The calls waiting for answers, keyed by the `requestId` they minted. */
  const pending = new Map<string, PendingUiStateRequest>();
  const send =
    deps.send ??
    ((connection: RealtimeClientConnection, frame: unknown) => {
      connection.send(JSON.stringify(frame));
    });

  return {
    async requestUiState(options = {}) {
      const timeoutMs = options.timeoutMs ?? UI_STATE_REQUEST_DEFAULT_TIMEOUT_MS;
      const targets = deps.listTargets(options.deviceId);
      // Nobody to ask: an empty reading, returned at once. Waiting the window
      // out for a question no connection could receive would only delay the one
      // honest answer.
      if (targets.length === 0) {
        return [];
      }

      const requestId = randomUUID();
      const answers = new Map<RealtimeClientConnection, UiVisibleContextReport>();
      const asked = targets.filter((target) => target.connection.readyState === WS_OPEN_STATE);

      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer !== null) {
            clearTimeout(timer);
          }
          // Forgotten before the result is built, so an answer that arrives
          // after this point finds no pending request and is dropped instead of
          // being appended to a result the caller already holds.
          pending.delete(requestId);
          resolve();
        };

        pending.set(requestId, {
          onAnswer(connection, report) {
            if (settled || answers.has(connection)) {
              return;
            }
            answers.set(connection, report);
            if (answers.size >= asked.length) {
              finish();
            }
          },
        });

        for (const target of asked) {
          try {
            send(target.connection, { type: 'ui.state_request', requestId });
          } catch {
            // A socket that failed between the registry read and this write is
            // simply one of the tabs that did not answer.
          }
        }

        if (asked.length === 0) {
          finish();
          return;
        }
        timer = setTimeout(finish, timeoutMs);
      });

      return groupByDevice(targets, answers);
    },

    handleResponse(connection, frame) {
      if (frame === null || typeof frame !== 'object') {
        return false;
      }
      const record = frame as AnyRecord;
      if (record.type !== 'ui.state_response') {
        return false;
      }
      const requestId = readText(record.requestId);
      if (requestId === null) {
        return false;
      }
      const request = pending.get(requestId);
      if (request === undefined) {
        return false;
      }
      const report = readReport(record);
      if (report === null) {
        return false;
      }
      request.onAnswer(connection, report);
      return true;
    },
  };
}

/**
 * The process-wide round trip: the one the chat gateway routes `ui.state_response`
 * frames into, over the registry `ui.hello` announces into.
 *
 * One instance per server run, because the pending-request table is the shared
 * state two calls correlate through — a second instance would be a second place
 * an answer could be looked for and not found.
 */
export const uiStateRequestService: UiStateRequestService = createUiStateRequestService({
  listTargets: (deviceId) => uiClientRegistry.listUiClientTargets(deviceId),
});
