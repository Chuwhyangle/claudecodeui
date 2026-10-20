import { useEffect, useRef, useState } from 'react';

import {
  readMcpNavigationPolicy,
  writeMcpNavigationPolicy,
} from '@/shared';
import type { ServerEvent, UiNavigateReveal, UiNavigateTarget } from '@/shared/types';

/**
 * How long an unanswered confirmation prompt waits before it lapses.
 *
 * The request is answered as `ignored` when it does: the user was shown the
 * request and did nothing, which is a decision — leaving the prompt up forever
 * would let a stale ask navigate the browser long after the caller gave up.
 */
const PROMPT_TIMEOUT_MS = 30_000;

/**
 * How long a navigation waits for its target session to become the one the
 * transcript shows before it stops trying to place the viewport there.
 *
 * Opening a session is a route change, so the placement can only run once the
 * chat surface has adopted it; a session that never opens (a bad id, a failed
 * read) leaves the request answered as applied but unplaced rather than pending
 * forever.
 */
const LOCATE_READY_TIMEOUT_MS = 5_000;

/** The `reason` on an acknowledgement whose message id could not be located; the session still opened. */
const MESSAGE_NOT_FOUND_REASON = 'MESSAGE_NOT_FOUND';

/** The `reason` on an acknowledgement whose diff or task target the panel could not show. */
const TARGET_NOT_FOUND_REASON = 'TARGET_NOT_FOUND';

/** The `reason` on an acknowledgement or result this device's own policy declined — not a failure. */
const POLICY_REASON = 'policy';

/** Names the caller on a prompt when the frame carried no usable `requester`, so the bar never renders an empty source. */
const UNKNOWN_REQUESTER = 'MCP';

/**
 * The request an open confirmation prompt is asking about.
 *
 * `target` is the frame's `at` narrowed to the two supported placements, or
 * null when the request asked for neither (which means "latest"). The title is
 * resolved when the prompt opens so the bar does not re-read the session list
 * on every render.
 */
export type UiNavigatePrompt = {
  navigationId: string;
  requester: string;
  sessionId: string;
  sessionTitle: string | null;
  target: UiNavigateTarget | null;
};

/** Everything the hook needs from its host: the socket, the route, and the chat module's own locating entries. */
type UseUiNavigateDeps = {
  /** The websocket subscription the whole app shares; the hook adds one listener to it. */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  /** Sends one reply frame back to the server. */
  sendMessage: (message: unknown) => void;
  /** Opens a session, growing a history entry the way a click in the sidebar would. */
  navigateToSession: (sessionId: string) => void;
  /** The session the transcript currently shows, or null when none is open. */
  activeSessionId: string | null;
  /** Centres one message in the active session; answers false when the id could not be located. */
  locateMessage: (messageId: string) => Promise<boolean>;
  /** Places the active session's transcript on its newest messages. */
  scrollToLatest: () => void;
  /**
   * Reveals a diff or a task in the panel that owns it, switching the workspace
   * to that panel first. Answers false when the named target could not be shown.
   *
   * The git and task-master panels live in sibling modules, so the host that can
   * switch tabs owns this; when it is absent, a diff/task request is acknowledged
   * as applied but nothing moves.
   */
  revealTarget?: (reveal: UiNavigateReveal) => boolean | Promise<boolean>;
  /** Resolves a session id to a human title for the prompt; null when it cannot be resolved. */
  resolveSessionTitle?: (sessionId: string) => string | null;
};

/** The open prompt (or null) plus the four answers the prompt bar can give. */
type UseUiNavigateResult = {
  prompt: UiNavigatePrompt | null;
  accept: () => void;
  ignore: () => void;
  alwaysAccept: () => void;
  alwaysReject: () => void;
};

/** What attempting to place a request produced: placed, the target was not there, or nothing could act on it. */
type LocateOutcome = 'placed' | 'not_found' | 'target_missing' | 'unavailable';

/** A frame that asks this device to open a session; the parsed, validated shape of `ui.navigate`. */
type UiNavigateRequest = {
  navigationId: string;
  requester: string;
  sessionId: string;
  at: UiNavigateTarget | null;
};

/** One caller waiting for a session to become the active one. The timer is the give-up deadline. */
type ActiveSessionWaiter = {
  sessionId: string;
  resolve: (ready: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Narrows a websocket frame to the placements this feature supports; anything
 * else means "latest".
 *
 * A turn is addressed exactly like a message — the transcript's own anchor id is
 * the only id a turn has on this side — so `turnId` and `messageId` differ only
 * in the word the caller used. The two panel placements name a file or a task
 * instead of a place in the transcript and are handled by {@link revealFor}.
 */
const parseTarget = (value: unknown): UiNavigateTarget | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.latest === true) {
    return { latest: true };
  }
  if (typeof record.messageId === 'string' && record.messageId) {
    return { messageId: record.messageId };
  }
  if (typeof record.turnId === 'string' && record.turnId) {
    return { turnId: record.turnId };
  }
  if (typeof record.diffFile === 'string' && record.diffFile) {
    return { diffFile: record.diffFile };
  }
  if (typeof record.taskId === 'string' && record.taskId) {
    return { taskId: record.taskId };
  }
  return null;
};

/** The panel reveal a target asks for, or null when it names a place in the transcript instead. */
const revealFor = (target: UiNavigateTarget | null): UiNavigateReveal | null => {
  if (!target) {
    return null;
  }
  if ('diffFile' in target) {
    return { kind: 'diff', filePath: target.diffFile };
  }
  if ('taskId' in target) {
    return { kind: 'task', taskId: target.taskId };
  }
  return null;
};

/**
 * Validates an incoming `ui.navigate` frame.
 *
 * A frame without a navigation id or a session cannot be answered or acted on,
 * so it is dropped rather than half-handled: a reply would name a request the
 * caller could not match, and a navigation would open an unknown session.
 */
const parseRequest = (event: ServerEvent): UiNavigateRequest | null => {
  const { navigationId, sessionId } = event;
  if (typeof navigationId !== 'string' || !navigationId) {
    return null;
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return null;
  }
  const requester = typeof event.requester === 'string' && event.requester.trim()
    ? event.requester.trim()
    : UNKNOWN_REQUESTER;
  return { navigationId, requester, sessionId, at: parseTarget(event.at) };
};

/**
 * Handles `ui.navigate`: an external MCP caller asking this device's browser to
 * open a session and place the transcript inside it.
 *
 * The device's own policy decides what happens, and the hook owns that whole
 * conversation — reading the policy, prompting when it is `ask`, writing the
 * policy back when the user says "always", and replying with the frames the
 * server correlates against the request. It is mounted by the chat module
 * because the placement entries (`jumpToMessage`, `scrollToBottomAndReset`)
 * live there and the websocket provider sits above the router, so it can carry
 * no route of its own.
 */
export function useUiNavigate(deps: UseUiNavigateDeps): UseUiNavigateResult {
  /**
   * The latest deps, read by the frame handler.
   *
   * The handler is installed once on the shared subscription and therefore
   * cannot close over the render it was created in — re-subscribing on every
   * render would also leave a gap in which a frame could be dispatched to
   * nobody. Reading through this ref instead keeps the subscription stable
   * while every callback the handler calls is current.
   */
  const depsRef = useRef(deps);
  // Deliberately no dependency array: `deps` is a fresh object every render, and
  // the point is to publish the newest callbacks after *every* commit. Listing
  // it would publish them on identity changes only, which is the same thing
  // spelled less honestly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    depsRef.current = deps;
  });

  /** The request the prompt is asking about, or null. This is what the bar renders from. */
  const [prompt, setPrompt] = useState<UiNavigatePrompt | null>(null);
  /**
   * The same request, readable synchronously from the frame handler and the
   * timeout callback — both run outside React's render, and the answers must act
   * on the request that is actually open rather than on a state snapshot.
   */
  const promptRef = useRef<UiNavigatePrompt | null>(null);
  /** The open prompt's lapse deadline, cleared whenever the prompt is answered or replaced. */
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Callers parked on "this session is not open yet", each with its own give-up deadline. */
  const waitersRef = useRef<ActiveSessionWaiter[]>([]);
  /** The active session, read by the frame handler without re-installing the subscription. */
  const activeSessionIdRef = useRef(deps.activeSessionId);

  /** Drops the open prompt and its deadline without replying — the reply is the caller's job. */
  const closePrompt = () => {
    if (promptTimerRef.current !== null) {
      clearTimeout(promptTimerRef.current);
      promptTimerRef.current = null;
    }
    promptRef.current = null;
    setPrompt(null);
  };

  /** Resolves once `sessionId` is the session the transcript shows, or false when the deadline passes. */
  const waitForActiveSession = (sessionId: string): Promise<boolean> => {
    if (activeSessionIdRef.current === sessionId) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: ActiveSessionWaiter = {
        sessionId,
        resolve,
        timer: setTimeout(() => {
          waitersRef.current = waitersRef.current.filter((entry) => entry !== waiter);
          resolve(false);
        }, LOCATE_READY_TIMEOUT_MS),
      };
      waitersRef.current.push(waiter);
    });
  };

  /** Releases the waiters for a session that has just become active. */
  useEffect(() => {
    activeSessionIdRef.current = deps.activeSessionId;
    if (deps.activeSessionId === null) {
      return;
    }
    const ready = waitersRef.current.filter((waiter) => waiter.sessionId === deps.activeSessionId);
    if (ready.length === 0) {
      return;
    }
    waitersRef.current = waitersRef.current.filter((waiter) => waiter.sessionId !== deps.activeSessionId);
    for (const waiter of ready) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
  }, [deps.activeSessionId]);

  // An unmounted hook owes no reply: the socket it would answer on belongs to
  // the provider, which outlives it only when the app is being torn down.
  useEffect(() => () => {
    if (promptTimerRef.current !== null) {
      clearTimeout(promptTimerRef.current);
      promptTimerRef.current = null;
    }
    for (const waiter of waitersRef.current) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    waitersRef.current = [];
  }, []);

  /** Places the transcript for a request, once the target session is the open one. */
  const locate = async (sessionId: string, target: UiNavigateTarget | null): Promise<LocateOutcome> => {
    const ready = await waitForActiveSession(sessionId);
    if (!ready) {
      return 'unavailable';
    }
    // Read the deps after the wait: the host re-renders during a navigation, and
    // the entries it hands over are the ones that act on the session now open.
    const { locateMessage, scrollToLatest } = depsRef.current;
    const anchorId = target
      ? ('messageId' in target ? target.messageId : 'turnId' in target ? target.turnId : null)
      : null;
    if (anchorId) {
      return (await locateMessage(anchorId)) ? 'placed' : 'not_found';
    }
    scrollToLatest();
    return 'placed';
  };

  /** The reason a settled navigation carries, or undefined when its status says everything. */
  const reasonFor = (outcome: LocateOutcome): string | undefined => {
    if (outcome === 'not_found') {
      return MESSAGE_NOT_FOUND_REASON;
    }
    return outcome === 'target_missing' ? TARGET_NOT_FOUND_REASON : undefined;
  };

  /**
   * Carries out one request: a diff or a task goes to the panel that owns it, a
   * transcript placement opens the session and locates inside it.
   *
   * A panel reveal is not a session navigation — the workspace switches to the
   * git or tasks tab, not to another conversation — so it never calls
   * `navigateToSession`.
   */
  const place = async (request: UiNavigateRequest): Promise<LocateOutcome> => {
    const { navigateToSession, revealTarget } = depsRef.current;
    const reveal = revealFor(request.at);
    if (reveal) {
      if (!revealTarget) {
        return 'unavailable';
      }
      return (await revealTarget(reveal)) ? 'placed' : 'target_missing';
    }
    navigateToSession(request.sessionId);
    return locate(request.sessionId, request.at);
  };

  /** Places a request, then answers with either the delivery ack or the settled result. */
  const navigateAndLocate = async (request: UiNavigateRequest, reply: 'ack' | 'result') => {
    const { sendMessage } = depsRef.current;
    const outcome = await place(request);
    if (reply === 'ack') {
      sendMessage({
        type: 'ui.navigate_ack',
        navigationId: request.navigationId,
        status: 'applied',
        reason: reasonFor(outcome),
      });
      return;
    }
    sendMessage({
      type: 'ui.navigate_result',
      navigationId: request.navigationId,
      status: 'applied',
      reason: reasonFor(outcome),
    });
  };

  const handleFrame = (event: ServerEvent) => {
    if (event.type !== 'ui.navigate') {
      return;
    }
    const request = parseRequest(event);
    if (!request) {
      return;
    }

    // A newer request replaces the open prompt: the old one lapses at once, so
    // the user never has to answer a question about a navigation the caller has
    // already moved on from. There is only ever one prompt on screen.
    const open = promptRef.current;
    if (open) {
      closePrompt();
      depsRef.current.sendMessage({
        type: 'ui.navigate_result',
        navigationId: open.navigationId,
        status: 'superseded',
      });
    }

    const policy = readMcpNavigationPolicy();
    if (policy === 'reject') {
      depsRef.current.sendMessage({
        type: 'ui.navigate_ack',
        navigationId: request.navigationId,
        status: 'declined',
        reason: POLICY_REASON,
      });
      return;
    }
    if (policy === 'accept') {
      void navigateAndLocate(request, 'ack');
      return;
    }

    const next: UiNavigatePrompt = {
      navigationId: request.navigationId,
      requester: request.requester,
      sessionId: request.sessionId,
      sessionTitle: depsRef.current.resolveSessionTitle?.(request.sessionId) ?? null,
      target: request.at,
    };
    promptRef.current = next;
    setPrompt(next);
    promptTimerRef.current = setTimeout(() => {
      const lapsed = promptRef.current;
      closePrompt();
      if (!lapsed) {
        return;
      }
      depsRef.current.sendMessage({
        type: 'ui.navigate_result',
        navigationId: lapsed.navigationId,
        status: 'expired',
      });
    }, PROMPT_TIMEOUT_MS);
    depsRef.current.sendMessage({
      type: 'ui.navigate_ack',
      navigationId: request.navigationId,
      status: 'shown',
    });
  };

  // The handler is re-created every render (it reads live refs), so it is
  // published through a ref and the subscription below stays installed once.
  const handlerRef = useRef(handleFrame);
  // No dependency array, for the same reason as `depsRef` above: the newest
  // handler must be published after every commit, not only when its identity
  // changes — and it changes every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    handlerRef.current = handleFrame;
  });

  const { subscribe } = deps;
  useEffect(() => subscribe((event) => handlerRef.current(event)), [subscribe]);

  /** The prompt bar's "jump": open the session and place the transcript. */
  const accept = () => {
    const open = promptRef.current;
    if (!open) {
      return;
    }
    closePrompt();
    void navigateAndLocate(
      { navigationId: open.navigationId, requester: open.requester, sessionId: open.sessionId, at: open.target },
      'result',
    );
  };

  /** The prompt bar's "ignore": the navigation never happens and the caller is told so. */
  const ignore = () => {
    const open = promptRef.current;
    if (!open) {
      return;
    }
    closePrompt();
    depsRef.current.sendMessage({
      type: 'ui.navigate_result',
      navigationId: open.navigationId,
      status: 'ignored',
    });
  };

  /**
   * The prompt bar's "always accept": this device stops asking, and the request
   * that prompted the choice is answered by the decision that was just made, so
   * the user does not have to click twice for one navigation.
   */
  const alwaysAccept = () => {
    const open = promptRef.current;
    if (!open) {
      return;
    }
    writeMcpNavigationPolicy('accept');
    closePrompt();
    void navigateAndLocate(
      { navigationId: open.navigationId, requester: open.requester, sessionId: open.sessionId, at: open.target },
      'result',
    );
  };

  /** The prompt bar's "always reject": the same, in the refusing direction. */
  const alwaysReject = () => {
    const open = promptRef.current;
    if (!open) {
      return;
    }
    writeMcpNavigationPolicy('reject');
    closePrompt();
    depsRef.current.sendMessage({
      type: 'ui.navigate_result',
      navigationId: open.navigationId,
      status: 'declined',
      reason: POLICY_REASON,
    });
  };

  return { prompt, accept, ignore, alwaysAccept, alwaysReject };
}
