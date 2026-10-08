import { randomUUID } from 'node:crypto';

import type {
  AnyRecord,
  RealtimeClientConnection,
  UiNavigationAck,
  UiNavigationFinalStatus,
  UiNavigationPosition,
  UiNavigationRecord,
  UiNavigationStatus,
  UiStateRequestTarget,
} from '@/shared/types.js';
import { isSessionOpeningPosition } from '@/shared/types.js';
import { uiClientRegistry } from '@/modules/websocket/services/ui-client-registry.service.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Telling one browser to open a session, and remembering what came of it.
 *
 * This is a PUSH, the mirror of {@link uiStateRequestService}'s pull. One call
 * writes a `ui.navigate` to ONE device's tabs, waits for the browser's DELIVERY
 * ack (a `ui.navigate_ack` saying `shown` / `applied` / `declined`) and then
 * returns — it does NOT wait for the user. An `ask`-policy device answers
 * `shown` at once and its human decides later; that later verdict arrives as a
 * `ui.navigate_result` frame, which updates the record this service is holding
 * in memory rather than a caller's already-returned value.
 *
 * The two frames are therefore DIFFERENT EVENTS, not two halves of one answer:
 *
 *  - `ui.navigate_ack` is "your instruction reached a browser" — a fact about
 *    the transport, matched to the pending call by its `navigationId`;
 *  - `ui.navigate_result` is "here is what the user decided" — a fact about the
 *    world, matched to the RECORD (which may be long since returned).
 *
 * Keeping the two apart is what makes "the tool never waits for the user" and
 * "the final outcome is still observable" both true at once.
 *
 * The in-memory log is bounded on purpose: at most
 * {@link UI_NAVIGATION_MAX_RECORDS} records, and nothing older than
 * {@link UI_NAVIGATION_RETENTION_MS}. A navigation is about a LIVE socket — the
 * tab that received it, the prompt it is showing — so a durable table would be a
 * second source of truth that outlives every reason to consult it. The log is
 * pruned on every write AND every read, so a caller asking "what happened" never
 * sees a record the retention window already retired.
 */

/** How long a call waits for the browser's delivery ack before reporting `unresponsive`. */
export const UI_NAVIGATION_DELIVERY_TIMEOUT_MS = 1500;

/** Most recent navigation records kept in memory; older ones are dropped. */
export const UI_NAVIGATION_MAX_RECORDS = 50;

/** How long a navigation record is retained after its last status change. */
export const UI_NAVIGATION_RETENTION_MS = 10 * 60 * 1000;

/**
 * The injected seams: which connections a device's tabs are on, how a frame is
 * written, the clock, and the one side effect a FINAL `applied` navigation has.
 */
export type UiNavigationDeps = {
  /**
   * The live connections of one device's tabs.
   *
   * Production binds this to the UI client registry's `listUiClientTargets`; a
   * criterion binds it to its own registry so the fixtures it drove are the ones
   * written to. An unknown device is an empty list — the caller (the MCP tool)
   * has already refused a device the registry does not hold.
   */
  listTargets: (deviceId: string) => UiStateRequestTarget[];
  /**
   * How one frame is written to one connection. Defaults to a JSON write, which
   * is what a real socket needs; a criterion can substitute a recorder.
   */
  send?: (connection: RealtimeClientConnection, frame: unknown) => void;
  /**
   * The clock, injected so retention is testable without waiting ten minutes.
   */
  now?: () => number;
  /**
   * The "last opened" pointer's writer (gap-mcp-ui-last-opened-session's upsert),
   * called EXACTLY when a navigation's status becomes `applied` — never for a
   * declined, ignored or unanswered one. Bound in production to the providers
   * module's `uiLastOpenedSessionService.recordOpenedSession`; a criterion passes
   * a recorder.
   */
  recordApplied?: (sessionId: string, at: number) => void;
};

/** One navigation request: the device to write to, the session, and where to land. */
export type UiNavigationRequest = {
  /** The resolved device id (the MCP tool owns device resolution). */
  deviceId: string;
  /** The device's display name, as the registry reported it, for the record. */
  deviceName: string;
  sessionId: string;
  at: UiNavigationPosition;
  /**
   * The asking MCP client's human-readable name, or null when none could be
   * resolved. The MCP tool resolves it (a PAT's `name`, an OAuth client's
   * display name) before calling here; this service carries it onto the record
   * and onto the `ui.navigate` frame's `requester`, so the browser's confirmation
   * bar can say WHO is asking rather than a bare fallback.
   */
  requestedBy: string | null;
};

/** One pending delivery: the collector the matching ack is handed to. */
type PendingNavigation = {
  onAck: (connection: RealtimeClientConnection, status: UiNavigationAck) => void;
};

/** The service as its callers see it. */
export type UiNavigationService = {
  /**
   * Writes one `ui.navigate` to a device's tabs and resolves with the DELIVERY
   * reading once a tab acks or the window closes.
   *
   * The returned record's `status` is `applied` (an `accept` device, or any
   * device that navigated at once), `pending_user` (an `ask` device's bar is
   * up), `declined` (a `reject` device) or `unresponsive` (nothing acked inside
   * {@link UI_NAVIGATION_DELIVERY_TIMEOUT_MS}). A device with no open tab
   * resolves as `unresponsive` at once rather than waiting the window out — there
   * is nobody to write to.
   */
  navigate(request: UiNavigationRequest): Promise<UiNavigationRecord>;
  /**
   * Routes one inbound `ui.navigate_ack` to the call that wrote its instruction.
   *
   * Returns true when the frame was a well-formed ack for a navigation still
   * awaiting delivery; false when it was malformed, unknown, or late — every
   * false case drops the frame without effect.
   */
  handleAck(connection: RealtimeClientConnection, frame: unknown): boolean;
  /**
   * Applies one inbound `ui.navigate_result` to the record it names.
   *
   * Returns true when the frame was a well-formed result for a record this
   * service still holds; false for a malformed frame or an unknown / already
   * pruned `navigationId`, which is dropped. Applying an `applied` result is
   * what writes the "last opened" pointer — the user said yes.
   */
  handleResult(connection: RealtimeClientConnection, frame: unknown): boolean;
  /**
   * The retained navigation records, newest request first, optionally narrowed
   * to one `navigationId`.
   *
   * Prunes before reading, so a record the retention window has retired is
   * absent even if no write has happened since — "too old to consult" is a
   * property of the read, not of the next call.
   */
  listNavigations(navigationId?: string): UiNavigationRecord[];
};

/** A non-empty string, or null. */
function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One of `allowed`, or null. */
function readOneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const ACK_STATUSES: readonly UiNavigationAck[] = ['shown', 'applied', 'declined'];
const FINAL_STATUSES: readonly UiNavigationFinalStatus[] = [
  'applied',
  'declined',
  'ignored',
  'superseded',
  'expired',
];

/** The delivery ack's status as the caller-facing reading. `shown` is a prompt, not a decision. */
function ackToStatus(ack: UiNavigationAck): UiNavigationStatus {
  return ack === 'shown' ? 'pending_user' : ack;
}

/**
 * Builds a navigation service over the injected seams.
 *
 * Production uses the process-wide {@link uiNavigationService}; the factory
 * exists so a criterion can drive navigations against a registry and a clock of
 * its own, with no process-wide record left behind when the case ends.
 */
export function createUiNavigationService(deps: UiNavigationDeps): UiNavigationService {
  /** The calls still awaiting a delivery ack, keyed by the id they minted. */
  const pending = new Map<string, PendingNavigation>();
  /** The retained records, oldest first; the tail is the newest. */
  const records: UiNavigationRecord[] = [];
  const now = deps.now ?? (() => Date.now());
  const send =
    deps.send ??
    ((connection: RealtimeClientConnection, frame: unknown) => {
      connection.send(JSON.stringify(frame));
    });

  /** Retires records past either bound. Called on every write and every read. */
  function prune(): void {
    const cutoff = now() - UI_NAVIGATION_RETENTION_MS;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].updatedAt < cutoff) {
        records.splice(index, 1);
      }
    }
    if (records.length > UI_NAVIGATION_MAX_RECORDS) {
      records.splice(0, records.length - UI_NAVIGATION_MAX_RECORDS);
    }
  }

  /** The record for one id, or undefined once pruned / never minted. */
  function find(navigationId: string): UiNavigationRecord | undefined {
    return records.find((record) => record.navigationId === navigationId);
  }

  /**
   * Moves a record to a new status, writing the last-opened pointer on the
   * single transition into `applied`. `updatedAt` always moves, so a record that
   * keeps changing is retained.
   *
   * The pointer is written ONLY for a session-opening position: revealing a diff
   * or a task leaves the active session where it was, so recording it as
   * "last opened" would make `ui_last_opened_session` lie. `ui_open_session`,
   * `ui_focus_turn` and a plain `{ latest }` / `{ messageId }` all qualify;
   * `ui_show_diff` and `ui_open_task` do not.
   */
  function applyStatus(record: UiNavigationRecord, status: UiNavigationStatus, tabId?: string): void {
    const wasApplied = record.status === 'applied';
    record.status = status;
    record.updatedAt = now();
    if (tabId !== undefined) {
      record.tabId = tabId;
    }
    if (status === 'applied' && !wasApplied && isSessionOpeningPosition(record.at)) {
      deps.recordApplied?.(record.sessionId, record.updatedAt);
    }
  }

  /** A copy, so a caller cannot mutate the record the log still owns. */
  function snapshot(record: UiNavigationRecord): UiNavigationRecord {
    return { ...record, at: { ...record.at } };
  }

  return {
    async navigate(request) {
      prune();

      const targets = deps.listTargets(request.deviceId);
      const asked = targets.filter((target) => target.connection.readyState === WS_OPEN_STATE);

      const record: UiNavigationRecord = {
        navigationId: randomUUID(),
        deviceId: request.deviceId,
        deviceName: request.deviceName,
        tabId: null,
        sessionId: request.sessionId,
        at: { ...request.at },
        requestedBy: request.requestedBy,
        requestedAt: now(),
        updatedAt: now(),
        status: 'unresponsive',
      };
      records.push(record);

      // Nobody to write to: the honest reading is "unresponsive", returned at
      // once rather than after a window no connection could ever close.
      if (asked.length === 0) {
        return snapshot(record);
      }

      const frame = {
        type: 'ui.navigate',
        navigationId: record.navigationId,
        sessionId: request.sessionId,
        at: record.at,
        // The bar names the asker; the record's `requestedBy` is the same string,
        // so what the user read and what `ui_visible_context` reports agree. An
        // unresolved name is the empty string — the browser's own fallback — never
        // the literal "null".
        requester: record.requestedBy ?? '',
      };

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
          // Forgotten before the record is returned, so a LATER ack finds no
          // pending call and is dropped instead of being applied twice.
          pending.delete(record.navigationId);
          resolve();
        };

        pending.set(record.navigationId, {
          onAck(connection, ack) {
            if (settled) {
              return;
            }
            // The acking connection names the tab that received the instruction,
            // so the record says WHICH tab is showing the bar.
            const answeringTab = targets.find((target) => target.connection === connection);
            applyStatus(record, ackToStatus(ack), answeringTab?.tabId);
            finish();
          },
        });

        for (const target of asked) {
          try {
            send(target.connection, frame);
          } catch {
            // A socket that failed between the registry read and this write is
            // simply one of the tabs that never acked.
          }
        }

        timer = setTimeout(finish, UI_NAVIGATION_DELIVERY_TIMEOUT_MS);
      });

      return snapshot(record);
    },

    handleAck(connection, frame) {
      if (frame === null || typeof frame !== 'object') {
        return false;
      }
      const record = frame as AnyRecord;
      if (record.type !== 'ui.navigate_ack') {
        return false;
      }
      const navigationId = readText(record.navigationId);
      const status = readOneOf(record.status, ACK_STATUSES);
      if (navigationId === null || status === null) {
        return false;
      }
      const waiting = pending.get(navigationId);
      if (waiting === undefined) {
        return false;
      }
      waiting.onAck(connection, status);
      return true;
    },

    handleResult(connection, frame) {
      if (frame === null || typeof frame !== 'object') {
        return false;
      }
      const parsed = frame as AnyRecord;
      if (parsed.type !== 'ui.navigate_result') {
        return false;
      }
      const navigationId = readText(parsed.navigationId);
      const status = readOneOf(parsed.status, FINAL_STATUSES);
      if (navigationId === null || status === null) {
        return false;
      }
      // A result names a RECORD, not a pending call: the user may decide long
      // after the tool returned. An id this service no longer holds (unknown, or
      // pruned) is dropped.
      const record = find(navigationId);
      if (record === undefined) {
        return false;
      }
      const tabId = readText(parsed.tabId);
      applyStatus(record, status, tabId ?? undefined);
      prune();
      return true;
    },

    listNavigations(navigationId) {
      prune();
      const ordered = records.slice().reverse().map(snapshot);
      return navigationId === undefined
        ? ordered
        : ordered.filter((record) => record.navigationId === navigationId);
    },
  };
}

/**
 * The process-wide navigation service: the one the chat gateway routes
 * `ui.navigate_ack` / `ui.navigate_result` frames into, over the registry
 * `ui.hello` announces into.
 *
 * One instance per server run, because the record log is the shared state two
 * calls correlate through — a second instance would be a second place a result
 * could be looked for and not found.
 */
export const uiNavigationService: UiNavigationService = createUiNavigationService({
  listTargets: (deviceId) => uiClientRegistry.listUiClientTargets(deviceId),
});

/** Every retained navigation record, from the process-wide service. */
export const listUiNavigations = (navigationId?: string): UiNavigationRecord[] =>
  uiNavigationService.listNavigations(navigationId);
