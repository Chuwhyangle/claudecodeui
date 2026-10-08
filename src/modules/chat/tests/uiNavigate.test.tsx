import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React, { useRef, useState } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, expect, describe, it, vi } from 'vitest';

import UiNavigatePrompt from '@/modules/chat/components/UiNavigatePrompt';
import { useUiNavigate } from '@/modules/chat/hooks/useUiNavigate';
import { ChangesView } from '@/modules/git-panel';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { TaskMasterPanel } from '@/modules/task-master';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { GitStatusResponse, ServerEvent, UiNavigateReveal } from '@/shared/types';

/**
 * The task list the panel renders comes from the task-master provider, which this
 * module does not own and which fetches over the app's API. Only that store is
 * replaced — the panel, its board and its detail modal are the real components —
 * so "the task's detail opened" is read off the panel's own markup rather than
 * off a call log. `vi.hoisted` keeps the holder reachable from the hoisted mock
 * factory without reading an uninitialized module-scope binding.
 */
const taskMasterState = vi.hoisted(() => ({ context: {} as Record<string, unknown> }));

vi.mock('@/modules/task-master/context/TaskMasterContext', () => ({
  useTaskMaster: () => taskMasterState.context,
  TaskMasterProvider: ({ children }: { children: unknown }) => children,
}));

/** A working-tree file the Changes view can list, and a task the board can show. */
const REVEAL_FILE = 'src/target.ts';
const REVEAL_TASK_ID = 'task-42';
const GIT_STATUS: GitStatusResponse = {
  branch: 'main',
  hasCommits: true,
  modified: [REVEAL_FILE],
  added: [],
  deleted: [],
  untracked: [],
  staged: [],
};

/**
 * An incoming `ui.navigate` — an external MCP caller asking this device's browser to
 * open a session and place the transcript inside it — is answered by the device's own
 * policy, and every branch of that conversation is asserted here against the real
 * `useUiNavigate` and the real `UiNavigatePrompt`.
 *
 * The doubles are the seams the hook was built with: a websocket subscription the
 * test dispatches frames into, a `sendMessage` that records the reply frames, a
 * `navigateToSession` that records the route changes, and the two chat-module
 * placement entries (`locateMessage`, `scrollToLatest`) as spies. Nothing between the
 * frame and the reply is stubbed, so the prompt the criterion reads is the component
 * the app renders, and the `reason`/`status` strings asserted below are the ones the
 * server correlates against the request.
 *
 * The policy is read from `localStorage` under its real key, so the two "always"
 * buttons are checked the way the settings section would read them: by the stored
 * value, not by a mock's call log.
 */

/** The localStorage key the per-device policy lives under (settings module's own key). */
const POLICY_STORAGE_KEY = 'mcpNavigationPolicy';

/** The two placement entries and the route change are recorded here; the frames are typed by their `type`. */
type SentFrame = Record<string, unknown>;

type HarnessDeps = Parameters<typeof useUiNavigate>[0];
type HarnessRig = {
  sent: SentFrame[];
  navigations: string[];
  locateMessage: ReturnType<typeof vi.fn>;
  scrollToLatest: ReturnType<typeof vi.fn>;
  listeners: Set<(event: ServerEvent) => void>;
  deps: Omit<HarnessDeps, 'activeSessionId'>;
  dispatch: (frame: SentFrame) => Promise<void>;
};

/**
 * Renders the hook and, whenever it has an open request, the real prompt bar — so
 * "prompt appeared" and "no prompt" are read off markup rather than off hook state,
 * and the four answers are exercised through the same buttons the user clicks.
 */
function Harness(props: HarnessDeps) {
  const ui = useUiNavigate(props);
  if (!ui.prompt) {
    return null;
  }
  return (
    <UiNavigatePrompt
      requester={ui.prompt.requester}
      sessionTitle={ui.prompt.sessionTitle}
      target={ui.prompt.target}
      onJump={ui.accept}
      onIgnore={ui.ignore}
      onAlwaysAccept={ui.alwaysAccept}
      onAlwaysReject={ui.alwaysReject}
    />
  );
}

/** Builds one test's doubles. Every spy is fresh per case, so no case reads another's log. */
function buildRig(overrides: Partial<Omit<HarnessDeps, 'activeSessionId'>> = {}): HarnessRig {
  const sent: SentFrame[] = [];
  const navigations: string[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const locateMessage = vi.fn(async () => true);
  const scrollToLatest = vi.fn();

  const deps: Omit<HarnessDeps, 'activeSessionId'> = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendMessage: (message) => {
      sent.push(message as SentFrame);
    },
    navigateToSession: (sessionId) => {
      navigations.push(sessionId);
    },
    locateMessage,
    scrollToLatest,
    resolveSessionTitle: () => 'Design review',
    ...overrides,
  };

  const dispatch = async (frame: SentFrame) => {
    await act(async () => {
      for (const listener of [...listeners]) {
        listener(frame as ServerEvent);
      }
    });
  };

  return { sent, navigations, locateMessage, scrollToLatest, listeners, deps, dispatch };
}

/** One `ui.navigate` frame with the fields every case sets. */
const navigateFrame = (overrides: Partial<Record<string, unknown>> = {}): SentFrame => ({
  type: 'ui.navigate',
  navigationId: 'nav-1',
  requester: 'Claude Desktop',
  sessionId: 'session-target',
  at: { latest: true },
  ...overrides,
});

/** The reply frames of one type, in the order they were sent. */
const framesOfType = (rig: HarnessRig, type: string): SentFrame[] =>
  rig.sent.filter((frame) => frame.type === type);

beforeEach(() => {
  localStorage.clear();
  scrollIntoViewSpy.mockClear();
  // The board renders whatever list the provider holds; a case that opens a task
  // needs one to open, and a fresh object per case keeps no case reading another's.
  taskMasterState.context = {
    currentProject: null,
    projectTaskMaster: null,
    mcpServerStatus: null,
    tasks: [{ id: REVEAL_TASK_ID, title: 'Fix the activity dock', status: 'pending' }],
    nextTask: null,
    isLoadingTasks: false,
    isLoadingMCP: false,
    error: null,
    setCurrentProject: () => {},
    refreshTasks: async () => {},
    refreshMCPStatus: async () => {},
    clearError: () => {},
  };
});

afterEach(() => {
  // The drafts store keeps a debounced server write alive across cases; clear it so
  // the "accept keeps the draft" case cannot leave a timer writing during the next.
  resetChatDrafts();
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

describe('the device policy decides what a navigation request does', () => {
  it('declines a request outright under the reject policy, with no prompt', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'reject');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame());

    expect(screen.queryByTestId('ui-navigate-prompt')).toBeNull();
    expect(rig.sent).toEqual([
      {
        type: 'ui.navigate_ack',
        navigationId: 'nav-1',
        status: 'declined',
        reason: 'policy',
      },
    ]);
    expect(rig.navigations).toEqual([]);
  });

  it('navigates at once under the accept policy and acknowledges it as applied', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame());

    expect(screen.queryByTestId('ui-navigate-prompt')).toBeNull();
    expect(rig.navigations).toEqual(['session-target']);
    expect(rig.scrollToLatest).toHaveBeenCalledTimes(1);
    expect(rig.sent).toEqual([
      { type: 'ui.navigate_ack', navigationId: 'nav-1', status: 'applied', reason: undefined },
    ]);
  });

  it('keeps accepting — and keeps the draft — when the composer holds unsent text', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    const rig = buildRig();
    writeDraftText('session-target', 'half-written thought');
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame());

    // No downgrade to a prompt, and the text the user had typed is still there: the
    // draft is keyed by session, so navigating to it cannot consume it.
    expect(screen.queryByTestId('ui-navigate-prompt')).toBeNull();
    expect(rig.navigations).toEqual(['session-target']);
    expect(framesOfType(rig, 'ui.navigate_ack')).toEqual([
      { type: 'ui.navigate_ack', navigationId: 'nav-1', status: 'applied', reason: undefined },
    ]);
    expect(readDraftText('session-target')).toBe('half-written thought');
  });

  it('shows a prompt under the ask policy and jumps on demand', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame());

    expect(rig.sent).toEqual([
      { type: 'ui.navigate_ack', navigationId: 'nav-1', status: 'shown' },
    ]);
    expect(screen.getByTestId('ui-navigate-prompt')).toBeDefined();
    expect(screen.getByText('From Claude Desktop · Session: Design review · Latest messages')).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByTestId('ui-navigate-jump'));
    });

    expect(rig.navigations).toEqual(['session-target']);
    expect(screen.queryByTestId('ui-navigate-prompt')).toBeNull();
    expect(framesOfType(rig, 'ui.navigate_result')).toEqual([
      { type: 'ui.navigate_result', navigationId: 'nav-1', status: 'applied', reason: undefined },
    ]);
  });

  it('reports an ignored request and never navigates when the prompt is dismissed', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame());

    await act(async () => {
      fireEvent.click(screen.getByTestId('ui-navigate-ignore'));
    });

    expect(rig.navigations).toEqual([]);
    expect(screen.queryByTestId('ui-navigate-prompt')).toBeNull();
    expect(framesOfType(rig, 'ui.navigate_result')).toEqual([
      { type: 'ui.navigate_result', navigationId: 'nav-1', status: 'ignored' },
    ]);
  });
});

describe('the prompt lapses, yields to newer requests, and can rewrite the policy', () => {
  it('expires an unanswered prompt after thirty seconds', async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
      const rig = buildRig();
      render(<Harness activeSessionId="session-target" {...rig.deps} />);

      await rig.dispatch(navigateFrame());
      expect(screen.getByTestId('ui-navigate-prompt')).toBeDefined();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000);
      });
      expect(screen.getByTestId('ui-navigate-prompt')).toBeDefined();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(screen.queryByTestId('ui-navigate-prompt')).toBeNull();
      expect(framesOfType(rig, 'ui.navigate_result')).toEqual([
        { type: 'ui.navigate_result', navigationId: 'nav-1', status: 'expired' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supersedes the open prompt when a newer request arrives, leaving exactly one', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame({ navigationId: 'nav-1', requester: 'First client' }));
    await rig.dispatch(navigateFrame({ navigationId: 'nav-2', requester: 'Second client' }));

    expect(screen.getAllByTestId('ui-navigate-prompt')).toHaveLength(1);
    expect(screen.getByText(/Second client/)).toBeDefined();
    expect(screen.queryByText(/First client/)).toBeNull();
    expect(framesOfType(rig, 'ui.navigate_result')).toEqual([
      { type: 'ui.navigate_result', navigationId: 'nav-1', status: 'superseded' },
    ]);
    // Both requests were acknowledged as shown; only the newer one is still open.
    expect(framesOfType(rig, 'ui.navigate_ack')).toEqual([
      { type: 'ui.navigate_ack', navigationId: 'nav-1', status: 'shown' },
      { type: 'ui.navigate_ack', navigationId: 'nav-2', status: 'shown' },
    ]);
  });

  it('makes accept this device\'s policy on "always accept" and jumps immediately', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame());

    await act(async () => {
      fireEvent.click(screen.getByTestId('ui-navigate-always-accept'));
    });

    expect(localStorage.getItem(POLICY_STORAGE_KEY)).toBe('accept');
    expect(rig.navigations).toEqual(['session-target']);
    expect(screen.queryByTestId('ui-navigate-prompt')).toBeNull();
    expect(framesOfType(rig, 'ui.navigate_result')).toEqual([
      { type: 'ui.navigate_result', navigationId: 'nav-1', status: 'applied', reason: undefined },
    ]);
  });

  it('makes reject this device\'s policy on "always reject" and refuses this request too', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame());

    await act(async () => {
      fireEvent.click(screen.getByTestId('ui-navigate-always-reject'));
    });

    expect(localStorage.getItem(POLICY_STORAGE_KEY)).toBe('reject');
    expect(rig.navigations).toEqual([]);
    expect(screen.queryByTestId('ui-navigate-prompt')).toBeNull();
    expect(framesOfType(rig, 'ui.navigate_result')).toEqual([
      { type: 'ui.navigate_result', navigationId: 'nav-1', status: 'declined', reason: 'policy' },
    ]);
  });
});

/**
 * The requester the bar names.
 *
 * A `ui.navigate` frame carries the resolved name of the client that asked
 * (`probe-ui-open` for a personal access token, the OAuth client's display name
 * otherwise), and the bar must show THAT so the user can tell who is asking.
 * The name is user-settable text, so it is rendered as text and never as markup
 * — a name that looks like a tag stays a string. Only a frame with no usable
 * name falls back to the fixed `MCP` label.
 */
describe('the bar names the asking client from the frame', () => {
  it("renders the frame's requester name inside the prompt text", async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame({ requester: 'probe-ui-open' }));

    const bar = screen.getByTestId('ui-navigate-prompt');
    expect(bar.textContent).toContain('probe-ui-open');
    expect(screen.getByText('From probe-ui-open · Session: Design review · Latest messages')).toBeDefined();
    // A real name is shown, so the fixed fallback must not also appear.
    expect(bar.textContent).not.toContain('MCP');
  });

  it('renders a marker-bearing name as text, never as markup', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame({ requester: '<b>x</b>' }));

    const bar = screen.getByTestId('ui-navigate-prompt');
    // The marker reaches the user as characters, verbatim …
    expect(bar.textContent).toContain('<b>x</b>');
    // … and produced no element of its own.
    expect(bar.querySelector('b')).toBeNull();
  });

  it('falls back to the fixed name only when the frame carries no usable requester', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'ask');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame({ requester: '   ' }));

    const bar = screen.getByTestId('ui-navigate-prompt');
    expect(bar.textContent).toContain('MCP');
  });
});

describe('the two placements a request can name', () => {
  it('locates a named message and acknowledges the navigation as applied', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame({ at: { messageId: 'message-42' } }));

    expect(rig.locateMessage).toHaveBeenCalledWith('message-42');
    expect(rig.scrollToLatest).not.toHaveBeenCalled();
    expect(rig.sent).toEqual([
      { type: 'ui.navigate_ack', navigationId: 'nav-1', status: 'applied', reason: undefined },
    ]);
  });

  it('still opens the session when the message cannot be located, and says so', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    const rig = buildRig({ locateMessage: vi.fn(async () => false) });
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame({ at: { messageId: 'message-does-not-exist' } }));

    // Partial success: the session opened (a failed location is not a failed
    // navigation), and the reason tells the caller what to expect on screen.
    expect(rig.navigations).toEqual(['session-target']);
    expect(rig.sent).toEqual([
      {
        type: 'ui.navigate_ack',
        navigationId: 'nav-1',
        status: 'applied',
        reason: 'MESSAGE_NOT_FOUND',
      },
    ]);
  });

  it('scrolls to the bottom for a latest placement', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    const rig = buildRig();
    render(<Harness activeSessionId="session-target" {...rig.deps} />);

    await rig.dispatch(navigateFrame({ at: { latest: true } }));

    expect(rig.scrollToLatest).toHaveBeenCalledTimes(1);
    expect(rig.locateMessage).not.toHaveBeenCalled();
  });

  it('waits for the target session to open before placing the transcript in it', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    const rig = buildRig();
    const view = render(<Harness activeSessionId="session-open" {...rig.deps} />);

    await rig.dispatch(navigateFrame({ sessionId: 'session-target', at: { messageId: 'message-42' } }));

    // The route change is the only thing that has happened: the transcript still
    // shows the old session, so there is nothing to place against yet.
    expect(rig.navigations).toEqual(['session-target']);
    expect(rig.locateMessage).not.toHaveBeenCalled();
    expect(rig.sent).toEqual([]);

    await act(async () => {
      view.rerender(<Harness activeSessionId="session-target" {...rig.deps} />);
    });

    await waitFor(() => expect(rig.locateMessage).toHaveBeenCalledWith('message-42'));
    await waitFor(() => expect(rig.sent).toEqual([
      { type: 'ui.navigate_ack', navigationId: 'nav-1', status: 'applied', reason: undefined },
    ]));
  });
});

/**
 * A place in the transcript, a file diff and a task are each a different surface,
 * and the whole point of asking for one is that the view actually moves. So the
 * hook is rendered beside the REAL panels — the changes view and the task-master
 * panel, imported through their module barrels — and the assertions are made on
 * the markup those panels already publish for the app's own `ui_visible_context`.
 *
 * The panels are not stubbed: only the task list they render is fed from a fixed
 * store, because in the app it arrives from a provider this module does not own.
 */
const scrollIntoViewSpy = vi.fn();

// jsdom does not implement scrolling, so the probe above stands in for it: a row
// that is scrolled into the viewport calls this, and nothing else does.
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  value: scrollIntoViewSpy,
  writable: true,
  configurable: true,
});

/** The expanded-file contract `ui_visible_context`'s `readCurrentDiff` reads: present only while expanded. */
const expandedFileRow = (): Element | null => document.querySelector('[data-git-expanded-file]');

/** The task-focus contract `readCurrentTask` reads: present only while a task's detail is open. */
const selectedTaskNode = (): Element | null => document.querySelector('[data-task-selected]');

/** The changes view, with the reveal threaded the way GitPanel threads it into it. */
function changesViewWithReveal(reveal: UiNavigateReveal | null, requestId: number | null) {
  return (
    <ChangesView
      isMobile={false}
      projectPath="/tmp/project"
      gitStatus={GIT_STATUS}
      gitDiff={{}}
      isLoading={false}
      wrapText
      isCreatingInitialCommit={false}
      onWrapTextChange={() => {}}
      onCreateInitialCommit={async () => true}
      onOpenFile={async () => {}}
      onDiscardFile={async () => {}}
      onDeleteFile={async () => {}}
      onStageFiles={async () => true}
      onUnstageFiles={async () => true}
      onCommitChanges={async () => true}
      onRequestConfirmation={() => {}}
      onExpandedFilesChange={() => {}}
      revealFilePath={reveal?.kind === 'diff' ? reveal.filePath : null}
      revealRequestId={requestId}
    />
  );
}

/** The task panel, with the reveal threaded the way the workspace threads it into it. */
function taskPanelWithReveal(reveal: UiNavigateReveal | null, requestId: number | null) {
  return (
    <TaskMasterPanel
      isVisible
      revealTaskId={reveal?.kind === 'task' ? reveal.taskId : null}
      revealRequestId={requestId}
    />
  );
}

/**
 * Renders the real hook and hands whatever reveal it asks for to a panel.
 *
 * This is the host's job in the app, in miniature: hold the newest request in
 * state and pass it down, counting requests so that asking for the same target
 * again is still a new request the panel acts on.
 */
function RevealHarness({
  deps,
  render,
}: {
  deps: Omit<HarnessDeps, 'activeSessionId' | 'revealTarget'>;
  render: (reveal: UiNavigateReveal | null, requestId: number | null) => React.ReactNode;
}) {
  const [request, setRequest] = useState<{ requestId: number; reveal: UiNavigateReveal } | null>(null);
  const requestCount = useRef(0);
  useUiNavigate({
    ...deps,
    activeSessionId: 'session-target',
    revealTarget: (reveal) => {
      requestCount.current += 1;
      setRequest({ requestId: requestCount.current, reveal });
      return true;
    },
  });
  return <>{render(request?.reveal ?? null, request?.requestId ?? null)}</>;
}

describe('a turn, a diff and a task each move the view they name', () => {
  it('scrolls the named turn\'s row into the viewport', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    // The placement entry is the chat module's own `jumpToMessage` in miniature:
    // it finds the row by the anchor the transcript publishes and scrolls it in.
    const rig = buildRig({
      locateMessage: vi.fn(async (anchorId: string) => {
        const row = document.querySelector(`[data-message-anchor-id="${anchorId}"]`);
        if (!row) {
          return false;
        }
        row.scrollIntoView();
        return true;
      }),
    });
    render(
      <>
        <Harness activeSessionId="session-target" {...rig.deps} />
        <div data-message-anchor-id="turn-7">the turn</div>
      </>,
    );

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();

    await rig.dispatch(navigateFrame({ at: { turnId: 'turn-7' } }));

    await waitFor(() => expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1));
    // The row that entered the viewport is the one the frame named — not just any row.
    const row = document.querySelector('[data-message-anchor-id="turn-7"]');
    expect(scrollIntoViewSpy.mock.contexts[0]).toBe(row);
    expect(rig.sent).toEqual([
      { type: 'ui.navigate_ack', navigationId: 'nav-1', status: 'applied', reason: undefined },
    ]);
  });

  it('expands the named file in the changes view when a diff is asked for', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    const rig = buildRig();
    render(<RevealHarness deps={rig.deps} render={changesViewWithReveal} />);

    // The file is listed from the start; it is the expansion that the reveal changes.
    expect(document.body.textContent).toContain(REVEAL_FILE);
    expect(expandedFileRow()).toBeNull();

    await rig.dispatch(navigateFrame({ at: { diffFile: REVEAL_FILE } }));

    await waitFor(() => expect(expandedFileRow()).not.toBeNull());
    expect(expandedFileRow()?.getAttribute('data-git-expanded-file')).toBe(REVEAL_FILE);
    // A panel reveal is not a conversation change: the transcript is left alone.
    expect(rig.navigations).toEqual([]);
    expect(rig.sent).toEqual([
      { type: 'ui.navigate_ack', navigationId: 'nav-1', status: 'applied', reason: undefined },
    ]);
  });

  it('opens the named task\'s detail in the task panel', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'accept');
    const rig = buildRig();
    render(<RevealHarness deps={rig.deps} render={taskPanelWithReveal} />);

    expect(selectedTaskNode()).toBeNull();

    await rig.dispatch(navigateFrame({ at: { taskId: REVEAL_TASK_ID } }));

    await waitFor(() => expect(selectedTaskNode()).not.toBeNull());
    expect(selectedTaskNode()?.getAttribute('data-task-selected')).toBe(REVEAL_TASK_ID);
    expect(rig.navigations).toEqual([]);
  });

  // Negative control: the policy is what authorises the move, so under `reject`
  // none of the three surfaces may change — not the viewport, not the changes
  // view, not the task panel — even though the frames were received.
  it('leaves every surface untouched when the policy is reject', async () => {
    localStorage.setItem(POLICY_STORAGE_KEY, 'reject');
    const rig = buildRig();
    render(
      <RevealHarness
        deps={rig.deps}
        render={(reveal, requestId) => (
          <>
            <div data-message-anchor-id="turn-7">the turn</div>
            {changesViewWithReveal(reveal, requestId)}
            {taskPanelWithReveal(reveal, requestId)}
          </>
        )}
      />,
    );

    await rig.dispatch(navigateFrame({ at: { turnId: 'turn-7' } }));
    await rig.dispatch(navigateFrame({ navigationId: 'nav-2', at: { diffFile: REVEAL_FILE } }));
    await rig.dispatch(navigateFrame({ navigationId: 'nav-3', at: { taskId: REVEAL_TASK_ID } }));

    expect(rig.locateMessage).not.toHaveBeenCalled();
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(expandedFileRow()).toBeNull();
    expect(selectedTaskNode()).toBeNull();
    expect(rig.navigations).toEqual([]);
  });
});

/**
 * The prompt bar renders fourteen keys out of the `chat` bundle, and react-i18next
 * renders a missing key verbatim — so a locale that drops one ships the literal
 * text `uiNavigate.alwaysAccept` to its user. This walks the whole
 * `locales/*\/chat.json` glob rather than a sampled language list, so a locale added
 * (or dropped) without the keys cannot pass by going stale.
 *
 * The list is the live contract read out of `UiNavigatePrompt.tsx`, kept as an
 * independent literal rather than derived from `en`, so all twelve dropping a key
 * still reds. Resolved from the vitest process cwd (the repo root), the way the other
 * filesystem-reading tests here do it: under jsdom `import.meta.url` is not a file:
 * URL.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** The bundle every other locale's `uiNavigate` subtree is compared against. */
const REFERENCE_LOCALE = 'en';

/** Every `uiNavigate` key the prompt bar renders, dotted from the bundle root. */
const REQUIRED_UI_NAVIGATE_KEYS = [
  'uiNavigate.title',
  'uiNavigate.requester',
  'uiNavigate.targetSession',
  'uiNavigate.unknownSession',
  'uiNavigate.atLatest',
  'uiNavigate.atMessage',
  'uiNavigate.atTurn',
  'uiNavigate.atDiff',
  'uiNavigate.atTask',
  'uiNavigate.jump',
  'uiNavigate.ignore',
  'uiNavigate.settingsHint',
  'uiNavigate.alwaysAccept',
  'uiNavigate.alwaysReject',
] as const;

/** The two keys that interpolate; a translation without the placeholder renders an empty name. */
const REQUIRED_PLACEHOLDERS: Record<string, string> = {
  'uiNavigate.requester': '{{name}}',
  'uiNavigate.targetSession': '{{title}}',
};

type ChatBundle = Record<string, unknown>;

/** Reads a dotted path out of a nested bundle, returning undefined on any missing hop. */
function readPath(bundle: ChatBundle, dottedPath: string): unknown {
  let node: unknown = bundle;
  for (const part of dottedPath.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Every leaf key of a value, dotted and prefixed. A non-object (string, number, ...) is a leaf. */
function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return prefix.length > 0 ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix.length > 0 ? `${prefix}.${key}` : key),
  );
}

/** The reasons one locale's prompt-bar keys fail the contract; empty means it passes. */
function uiNavigateProblems(bundle: ChatBundle): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED_UI_NAVIGATE_KEYS) {
    const value = readPath(bundle, key);
    if (value === undefined) {
      problems.push(`${key} is missing`);
      continue;
    }
    if (typeof value !== 'string') {
      problems.push(`${key} is not a string`);
      continue;
    }
    if (value.trim().length === 0) {
      problems.push(`${key} is an empty string`);
      continue;
    }
    const leafName = key.slice(key.lastIndexOf('.') + 1);
    if (value === leafName || value === key) {
      problems.push(`${key} is the raw key name, not a label`);
      continue;
    }
    const placeholder = REQUIRED_PLACEHOLDERS[key];
    if (placeholder && !value.includes(placeholder)) {
      problems.push(`${key} dropped the ${placeholder} placeholder`);
    }
  }
  return problems;
}

/** A synthetic bundle whose required keys are all valid, for the positive controls. */
function completeBundle(): ChatBundle {
  const uiNavigate: Record<string, string> = {};
  for (const key of REQUIRED_UI_NAVIGATE_KEYS) {
    const leaf = key.slice(key.lastIndexOf('.') + 1);
    const placeholder = REQUIRED_PLACEHOLDERS[key];
    uiNavigate[leaf] = placeholder ? `translated ${placeholder}` : `translated text for ${key}`;
  }
  return { uiNavigate };
}

describe('every locale carries the prompt bar\'s keys', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const bundleFiles = globSync('*/chat.json', { cwd: LOCALES_DIR }).sort();

  it('covers every language directory on disk (the full-locale glob, not a sampled subset)', () => {
    console.log(`[AC4] readdir directories (${localeDirs.length}): ${JSON.stringify(localeDirs)}`);
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/chat.json`));
    expect(localeDirs.length).toBeGreaterThanOrEqual(12);
  });

  it('gives every locale every uiNavigate key, non-empty, not the key name, placeholders kept', () => {
    const offenders: string[] = [];
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as ChatBundle;
      for (const problem of uiNavigateProblems(bundle)) {
        offenders.push(`${file}: ${problem}`);
      }
    }
    console.log(`[AC4] offenders (${offenders.length}): ${JSON.stringify(offenders)}`);
    expect(offenders).toEqual([]);
  });

  it('gives every locale exactly the same uiNavigate key set as en', () => {
    const reference = JSON.parse(
      readFileSync(join(LOCALES_DIR, REFERENCE_LOCALE, 'chat.json'), 'utf8'),
    ) as ChatBundle;
    const referenceKeys = new Set(flattenKeys(readPath(reference, 'uiNavigate'), 'uiNavigate'));

    const diffs: Record<string, { missing: string[]; extra: string[] }> = {};
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as ChatBundle;
      const keys = new Set(flattenKeys(readPath(bundle, 'uiNavigate'), 'uiNavigate'));
      diffs[file] = {
        missing: [...referenceKeys].filter((key) => !keys.has(key)).sort(),
        extra: [...keys].filter((key) => !referenceKeys.has(key)).sort(),
      };
    }
    console.log(`[AC4] per-locale key-set diffs vs ${REFERENCE_LOCALE}: ${JSON.stringify(diffs)}`);
    for (const file of bundleFiles) {
      expect(diffs[file], `${file} key set vs ${REFERENCE_LOCALE}`).toEqual({ missing: [], extra: [] });
    }
  });

  // Positive control: the checker must reject a bundle that lacks a key, carries a
  // blank or key-copied label, or drops an interpolation placeholder. Without this
  // the cases above would be a green that cannot go red.
  it('rejects a bundle with a missing, blank, key-copied or placeholder-less label (positive control)', () => {
    expect(uiNavigateProblems({})).toEqual(
      REQUIRED_UI_NAVIGATE_KEYS.map((key) => `${key} is missing`),
    );

    const complete: ChatBundle = completeBundle();
    expect(uiNavigateProblems(complete)).toEqual([]);

    const missingOne = completeBundle();
    delete (missingOne.uiNavigate as Record<string, string>).alwaysReject;
    expect(uiNavigateProblems(missingOne)).toEqual(['uiNavigate.alwaysReject is missing']);

    const blanked = completeBundle();
    (blanked.uiNavigate as Record<string, string>).jump = '   ';
    expect(uiNavigateProblems(blanked)).toEqual(['uiNavigate.jump is an empty string']);

    const copiedLeaf = completeBundle();
    (copiedLeaf.uiNavigate as Record<string, string>).ignore = 'ignore';
    expect(uiNavigateProblems(copiedLeaf)).toEqual([
      'uiNavigate.ignore is the raw key name, not a label',
    ]);

    const droppedPlaceholder = completeBundle();
    (droppedPlaceholder.uiNavigate as Record<string, string>).requester = 'From somebody';
    expect(uiNavigateProblems(droppedPlaceholder)).toEqual([
      'uiNavigate.requester dropped the {{name}} placeholder',
    ]);
  });
});
