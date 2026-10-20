import { useEffect, useRef } from 'react';

import { readDeviceName, readMcpNavigationPolicy } from '@/shared';
import { getDeviceId, getTabId } from '@/shared/utils/deviceIdentity';
import type { ServerEvent, UiStateResponseFrame, UiVisibleContextReport } from '@/shared/types';

/**
 * Answers the server's `ui.state_request` with what this tab is showing.
 *
 * An external MCP caller asks the server "what do the connected browsers have
 * open?"; the server broadcasts one `ui.state_request` carrying a `requestId` and
 * waits for the answers. This hook is the browser half of that round trip: on the
 * frame it reads this tab's own identifiers and ranges — which device and tab it
 * is, which panel/project/session it shows, which message ids are on screen, how
 * many approvals and queued messages are waiting — and sends one
 * `ui.state_response` back with the request's id echoed verbatim.
 *
 * ## Identifiers and ranges only
 *
 * The report deliberately carries no message body, no user selection and no panel
 * content. The server projects an answer down to exactly those fields before an
 * MCP caller ever sees it, and a caller that wants the text behind a message id
 * asks `session_read` for it. Reading the DOM here rather than threading a dozen
 * live values through the provider is also what keeps this hook mountable where
 * the state actually lives — see the mount point in `ChatInterface`.
 *
 * ## The page is read, never driven
 *
 * A request asks a question; it does not navigate, focus or un-hide anything. The
 * four DOM/`document` readings below are point-in-time facts about the page as it
 * already is. A tab that is not running this hook simply never answers, and the
 * server reports it `unresponsive` — that is the designed outcome, not a failure.
 */

/**
 * Everything the hook needs from its host: the socket fan-out, the reply sender,
 * and the few pieces of chat state that live in the component rather than in the
 * DOM (the open project/session and the two counts).
 */
export type UseUiStateResponderDeps = {
  /** The websocket subscription the whole app shares; the hook adds one listener to it. */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  /** Sends one reply frame back to the server. */
  sendMessage: (message: unknown) => void;
  /** The id of the project this tab has open, or null. */
  selectedProject: string | null;
  /** The id of the session this tab has open, or null. */
  selectedSession: string | null;
  /** How many tool approvals are waiting for the user in this tab. */
  pendingApprovals: number;
  /** How many of this tab's messages are still waiting in the send queue. */
  queuedMessages: number;
};

/** Whether the browser context exposes the two readers the report is built from. */
const hasDocument = (): boolean => typeof document !== 'undefined';

/**
 * The window's viewport height/width, falling back to the document element for a
 * context (a test double, a non-visual embed) where `innerHeight` is absent.
 */
const viewportHeight = (): number =>
  typeof window === 'undefined' ? 0 : window.innerHeight || document.documentElement.clientHeight;

/** Whether a row's box has any area on the visible part of the page. */
const rectIntersectsViewport = (rect: DOMRect): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  const width = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom > 0 && rect.top < viewportHeight() && rect.right > 0 && rect.left < width;
};

/** Whether two boxes overlap at all. */
const rectsOverlap = (left: DOMRect, right: DOMRect): boolean =>
  left.bottom > right.top && left.top < right.bottom && left.right > right.left && left.left < right.right;

/**
 * The scrollable box a transcript row is clipped by — the nearest ancestor that
 * actually scrolls — or null when the row is not inside one.
 *
 * `getBoundingClientRect` reports a row's box WITHOUT its ancestors' clipping, so
 * a row scrolled just past the top of its pane still "intersects" the window.
 * Intersecting a row's box with this one is what keeps such a row out of the
 * reported range.
 */
const scrollClipOf = (element: HTMLElement): HTMLElement | null => {
  let parent = element.parentElement;
  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
};

/** Whether one transcript row is on screen right now. */
const rowIsVisible = (row: HTMLElement): boolean => {
  const rect = row.getBoundingClientRect();
  if (!rectIntersectsViewport(rect)) {
    return false;
  }
  const clip = scrollClipOf(row);
  return clip === null || rectsOverlap(rect, clip.getBoundingClientRect());
};

/**
 * The first and last message ids currently visible in the transcript, in document
 * order, or a pair of nulls when no row is on screen. Reads the same
 * `data-message-anchor-id` the transcript's jump/locate machinery addresses rows
 * by, so the range names ids a `session_read` can be resolved against.
 *
 * The two nulls mean "nothing visible", so they are only honest when *every*
 * visible row is addressable. That is the transcript's side of the contract:
 * each row publishes `messageAnchorId(message)` — the provider anchor when it
 * has one, else the message id — and not the raw `transcriptAnchorId`, which
 * only a user row carries. A pane whose band holds a long assistant answer is
 * full of a message and must report it, not an empty range.
 */
const readVisibleMessages = (): UiVisibleContextReport['visibleMessages'] => {
  if (!hasDocument()) {
    return { first: null, last: null };
  }
  let first: string | null = null;
  let last: string | null = null;
  for (const row of document.querySelectorAll<HTMLElement>('[data-message-anchor-id]')) {
    const id = row.getAttribute('data-message-anchor-id');
    if (!id || !rowIsVisible(row)) {
      continue;
    }
    if (first === null) {
      first = id;
    }
    last = id;
  }
  return { first, last };
};

/**
 * The `panel` value for "a workspace is mounted, but no view says it is the
 * active one" — a read that failed, not a tab that is not showing a workspace.
 *
 * `null` has to keep meaning exactly one thing, "there is no workspace panel to
 * report", or a caller cannot tell an unreadable panel from an absent one. This
 * sentinel keeps the two apart; it is not a tab id, and no workspace view can
 * be called it.
 */
export const UNKNOWN_PANEL = 'unknown';

/**
 * The workspace panel this tab is showing — the active view's own id off the
 * `data-workspace-tab`/`aria-current` pair both workspace surfaces render.
 *
 * Three outcomes, and they are three on purpose:
 *
 * - `null` — no `data-workspace-tab` anywhere, so this tab is not showing a
 *   workspace at all and the question does not apply. This is also what a
 *   non-browser context reports.
 * - the id — the view that marks itself `aria-current`. Both surfaces carry
 *   that pair: the desktop pill and the mobile selector's rows already did, and
 *   the mobile *trigger* now does too, so the collapsed layout — where the rows
 *   live inside a closed dialog and nothing else on screen names the view — is
 *   readable without opening the picker.
 * - {@link UNKNOWN_PANEL} — a workspace is mounted but none of its views is
 *   marked active. Reporting `null` here would be a lie of omission: it would
 *   read to a caller exactly like "this tab shows no workspace".
 */
const readActivePanel = (): string | null => {
  if (!hasDocument()) {
    return null;
  }
  const tabs = document.querySelectorAll<HTMLElement>('[data-workspace-tab]');
  if (tabs.length === 0) {
    return null;
  }
  for (const tab of tabs) {
    if (tab.getAttribute('aria-current') === 'true') {
      return tab.getAttribute('data-workspace-tab');
    }
  }
  return UNKNOWN_PANEL;
};

/** The DOM attribute a Git sub-view tab carries its id on (`GitViewTabs`). */
const GIT_VIEW_ATTR = 'data-git-view';

/**
 * The Git diffs this tab currently has expanded, or null when the Git panel is
 * not the active panel.
 *
 * Expanded is a Set in the panel, so the reading is a collection: every element
 * carrying the `data-git-expanded-file` / `data-git-expanded-commit` contract,
 * in document order. The active sub-view comes from the `data-git-view`/
 * `aria-selected` pair the tabs render; a Git panel that is up but whose tabs
 * report nothing active falls back to {@link UNKNOWN_PANEL}, never to `null`,
 * so "which view" stays distinguishable from "not the Git panel".
 *
 * Paths and hashes only — the diff body is not read here and is not reported.
 */
const readCurrentDiff = (): UiVisibleContextReport['currentDiff'] => {
  if (!hasDocument() || readActivePanel() !== 'git') {
    return null;
  }
  const activeView = document.querySelector<HTMLElement>(`[${GIT_VIEW_ATTR}][aria-selected="true"]`);
  const view = activeView?.getAttribute(GIT_VIEW_ATTR) ?? UNKNOWN_PANEL;

  const files: string[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('[data-git-expanded-file]')) {
    const path = element.getAttribute('data-git-expanded-file');
    if (path !== null && path.length > 0) {
      files.push(path);
    }
  }
  const commits: string[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('[data-git-expanded-commit]')) {
    const hash = element.getAttribute('data-git-expanded-commit');
    if (hash !== null && hash.length > 0) {
      commits.push(hash);
    }
  }
  return { view, files, commits };
};

/** The attribute the open task-detail modal roots itself on, carrying the task id. */
const TASK_SELECTED_ATTR = 'data-task-selected';

/**
 * The TaskMaster task this tab has focused, or null when the detail modal is
 * closed.
 *
 * The TaskMaster panel keeps `selectedTask` as private component state; the
 * modal is the one place it becomes addressable, so the reading goes through the
 * `data-task-selected` contract rather than reaching into the panel. `source` is
 * fixed to `'taskmaster'`: quay tasks are a separate id namespace with no
 * selection surface, so an unlabelled id would be ambiguous.
 */
const readCurrentTask = (): UiVisibleContextReport['currentTask'] => {
  if (!hasDocument()) {
    return null;
  }
  const element = document.querySelector<HTMLElement>(`[${TASK_SELECTED_ATTR}]`);
  const id = element?.getAttribute(TASK_SELECTED_ATTR) ?? null;
  if (id === null || id.length === 0) {
    return null;
  }
  const title = element?.getAttribute(`${TASK_SELECTED_ATTR}-title`) ?? null;
  return { source: 'taskmaster', id, title };
};

/** The most characters of a selection that cross the boundary; the rest is clipped. */
export const SELECTED_TEXT_MAX_LENGTH = 500;

/** Whether a selection endpoint sits inside a transcript row (`data-message-anchor-id`). */
const nodeIsInTranscript = (node: Node | null): boolean => {
  if (node === null) {
    return false;
  }
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest('[data-message-anchor-id]') !== null;
};

/**
 * The text selected inside the transcript, reduced, or null.
 *
 * Only a settled, non-collapsed selection both of whose endpoints land inside a
 * transcript row counts — a selection in the sidebar, the Git panel or the
 * terminal reads as "nothing selected". The text is clipped to
 * {@link SELECTED_TEXT_MAX_LENGTH} and flagged `truncated`, so the reading is
 * bounded no matter how much was highlighted. `region` is always `'transcript'`
 * and doubles as evidence the region check ran.
 */
const readSelectedText = (): UiVisibleContextReport['selectedText'] => {
  if (!hasDocument() || typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return null;
  }
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  if (!nodeIsInTranscript(selection.anchorNode) || !nodeIsInTranscript(selection.focusNode)) {
    return null;
  }
  const text = selection.toString();
  if (text.length === 0) {
    return null;
  }
  const truncated = text.length > SELECTED_TEXT_MAX_LENGTH;
  return {
    text: truncated ? text.slice(0, SELECTED_TEXT_MAX_LENGTH) : text,
    truncated,
    region: 'transcript',
  };
};

/**
 * Answers the server's `ui.state_request` frames with this tab's visible context.
 *
 * Mounted where the chat state lives (see `ChatInterface`); the subscription is
 * installed once and the handler is published through a ref, so a re-render from
 * a streaming turn never tears the listener down.
 */
export function useUiStateResponder(deps: UseUiStateResponderDeps): void {
  // The newest deps are published after every commit — the handler reads them, and
  // they change on most renders (a keystroke updates the queued count), so a
  // dependency array would resubscribe constantly. Same pattern as `useUiNavigate`.
  const depsRef = useRef(deps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    depsRef.current = deps;
  });

  // When this tab was last focused, or null when it has not been since the hook
  // mounted. Seeded from the current focus so a page that is already focused
  // reports a time rather than null. Only ever moves forward, so the server can
  // order devices most-recently-focused first.
  const lastFocusedAtRef = useRef<number | null>(hasDocument() && document.hasFocus() ? Date.now() : null);
  useEffect(() => {
    const markFocused = () => {
      lastFocusedAtRef.current = Date.now();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        markFocused();
      }
    };
    window.addEventListener('focus', markFocused);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', markFocused);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const buildReport = (requestId: string): UiStateResponseFrame => {
    const { selectedProject, selectedSession, pendingApprovals, queuedMessages } = depsRef.current;
    return {
      type: 'ui.state_response',
      requestId,
      deviceId: getDeviceId(),
      tabId: getTabId(),
      deviceName: readDeviceName(),
      navigationPolicy: readMcpNavigationPolicy(),
      visibility: hasDocument() && document.visibilityState === 'visible' ? 'visible' : 'hidden',
      hasFocus: hasDocument() && document.hasFocus(),
      lastFocusedAt: lastFocusedAtRef.current,
      panel: readActivePanel(),
      selectedProject,
      selectedSession,
      visibleMessages: readVisibleMessages(),
      pendingApprovals,
      queuedMessages,
      currentDiff: readCurrentDiff(),
      currentTask: readCurrentTask(),
      selectedText: readSelectedText(),
    };
  };

  const handleFrame = (event: ServerEvent) => {
    if (event.type !== 'ui.state_request') {
      return;
    }
    const { requestId } = event;
    // A request without an id cannot be matched to an answer, so it is dropped
    // rather than answered — the server would discard the reply anyway.
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return;
    }
    depsRef.current.sendMessage(buildReport(requestId));
  };

  // The handler is re-created every render (it reads live refs and the DOM), so it
  // is published through a ref and the subscription below stays installed once.
  const handlerRef = useRef(handleFrame);
  useEffect(() => {
    handlerRef.current = handleFrame;
  });

  const { subscribe } = deps;
  useEffect(() => subscribe((event) => handlerRef.current(event)), [subscribe]);
}
