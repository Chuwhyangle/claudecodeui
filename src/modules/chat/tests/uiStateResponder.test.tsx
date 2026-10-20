import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UNKNOWN_PANEL,
  useUiStateResponder,
  type UseUiStateResponderDeps,
} from '@/modules/chat/hooks/useUiStateResponder';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';
import { messageAnchorId } from '@/modules/chat/utils/transcript/messageKeys';
import { getDeviceId, getTabId } from '@/shared/utils/deviceIdentity';
import type { ChatMessage, ServerEvent } from '@/shared/types';

/**
 * The browser half of the `ui_visible_context` round trip.
 *
 * A `ui.state_request` arrives on the shared websocket and this device must answer
 * it at once with its own identifiers and readings — no message body, no panel
 * content. The ONE content-bearing field is `selectedText` (the transcript
 * selection, gap-ui-visible-context-extended-fields): the browser always SENDS it
 * because it cannot know the caller's token, and the server delivers it only
 * through the separately-scoped `ui_selected_text`. Every leg below drives the real
 * `useUiStateResponder` over a subscription the test dispatches frames into and a
 * `sendMessage` that records the reply, so the frame read here is the frame the app
 * would put on the wire.
 *
 * The `visibility`/`hasFocus`/`panel` readings come from the real `document`/DOM,
 * stubbed only where jsdom cannot model them (a background tab, keyboard focus),
 * and the policy and name are read from the same `localStorage` keys the settings
 * section writes.
 */

/** Every key a `ui.state_response` is allowed to carry — the whitelist, and nothing else. */
const RESPONSE_KEYS = [
  'type',
  'requestId',
  'deviceId',
  'tabId',
  'deviceName',
  'navigationPolicy',
  'visibility',
  'hasFocus',
  'lastFocusedAt',
  'panel',
  'selectedProject',
  'selectedSession',
  'visibleMessages',
  'pendingApprovals',
  'queuedMessages',
  'currentDiff',
  'currentTask',
  'selectedText',
].sort();

type SentFrame = Record<string, unknown>;

type Rig = {
  sent: SentFrame[];
  listeners: Set<(event: ServerEvent) => void>;
  deps: UseUiStateResponderDeps;
  dispatch: (frame: SentFrame) => Promise<void>;
  reply: () => SentFrame;
};

/** Mounts the hook with nothing to render; the frame it sends is the whole observable. */
function Harness(props: UseUiStateResponderDeps) {
  useUiStateResponder(props);
  return null;
}

/** One test's doubles: a subscription set, a recorder, and the chat-state values the hook is handed. */
function buildRig(overrides: Partial<Omit<UseUiStateResponderDeps, 'subscribe' | 'sendMessage'>> = {}): Rig {
  const sent: SentFrame[] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const deps: UseUiStateResponderDeps = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendMessage: (message) => {
      sent.push(message as SentFrame);
    },
    selectedProject: 'project-7',
    selectedSession: 'session-9',
    pendingApprovals: 0,
    queuedMessages: 0,
    ...overrides,
  };

  const dispatch = async (frame: SentFrame) => {
    await act(async () => {
      for (const listener of [...listeners]) {
        listener(frame as ServerEvent);
      }
    });
  };

  return {
    sent,
    listeners,
    deps,
    dispatch,
    reply: () => {
      const frame = sent[sent.length - 1];
      if (!frame) {
        throw new Error('no reply frame was sent');
      }
      return frame;
    },
  };
}

/** One `ui.state_request` with a fresh id; the server always sends one. */
const requestFrame = (requestId = 'req-abc'): SentFrame => ({ type: 'ui.state_request', requestId });

/** Saves and restores the two `document` readers jsdom models differently from a real browser. */
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function stubVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
}

/** A `ChatMessage` with the two required fields defaulted, so a case states only what it is about. */
const message = (fields: Partial<ChatMessage> & Pick<ChatMessage, 'type'>): ChatMessage => ({
  timestamp: '2024-01-01T00:00:00.000Z',
  content: '',
  ...fields,
});

/** jsdom lays every element out at zero; a row's geometry has to be handed to it. */
const setRect = (element: Element, top: number, height: number): void => {
  (element as HTMLElement).getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
};

/**
 * One row exactly as `ChatMessagesPane` renders it: the real `LazyMessageRow`, addressed by the
 * pane's own rule and mounting its content because a standalone render has no lazy observer
 * (`lazyRows={null}`).
 *
 * Rendering through the real wrapper rather than a hand-built `div` is the point of these cases —
 * the `data-message-anchor-id` under test is the attribute *that component* publishes, from the
 * anchor *that rule* computes, which is the pair the responder reads in a live browser.
 */
function TranscriptRow({ row }: { row: { message: ChatMessage } }) {
  return (
    <LazyMessageRow
      lazyRows={null}
      timestamp={row.message.timestamp}
      anchorId={messageAnchorId(row.message)}
      initiallyNearViewport
    >
      <div className="chat-message">{row.message.content}</div>
    </LazyMessageRow>
  );
}

/** A message plus the geometry the case wants the DOM to report for its row. */
type LaidOutRow = { message: ChatMessage; top: number; height: number };

/**
 * Renders a transcript into a real scroll container — `overflow-y: auto`, as the pane is — and
 * hands every element the geometry jsdom cannot compute. Returns the pane and the addressed rows
 * in document order, which is transcript order and therefore the order the responder walks.
 */
function renderTranscript(rows: LaidOutRow[], pane: { top: number; height: number }) {
  const { container } = render(
    <div className="chat-messages-pane" style={{ overflowY: 'auto' }}>
      {rows.map((row, index) => (
        <TranscriptRow key={messageAnchorId(row.message) ?? index} row={row} />
      ))}
    </div>,
  );
  const paneElement = container.querySelector<HTMLElement>('.chat-messages-pane');
  if (!paneElement) {
    throw new Error('the transcript pane did not render');
  }
  setRect(paneElement, pane.top, pane.height);
  const rowElements = Array.from(paneElement.querySelectorAll<HTMLElement>('[data-message-anchor-id]'));
  rowElements.forEach((element, index) => {
    const row = rows[index];
    if (row) {
      setRect(element, row.top, row.height);
    }
  });
  return { paneElement, rowElements };
}

/** The ids on screen, computed from the DOM the way the criterion words it: rows inside the pane band. */
const onScreenIds = (pane: HTMLElement, rows: HTMLElement[]): (string | null)[] => {
  const paneRect = pane.getBoundingClientRect();
  return rows
    .filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > paneRect.top && rect.top < paneRect.bottom;
    })
    .map((row) => row.getAttribute('data-message-anchor-id'));
};

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalVisibility) {
    Object.defineProperty(document, 'visibilityState', originalVisibility);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
});

describe('a ui.state_request is answered with this tab’s visible context', () => {
  it('echoes the requestId verbatim and carries only the whitelist fields', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    // A workspace tab is open, so `panel` is a real reading rather than null.
    const panel = document.createElement('button');
    panel.setAttribute('data-workspace-tab', 'chat');
    panel.setAttribute('aria-current', 'true');
    document.body.appendChild(panel);

    const rig = buildRig({ pendingApprovals: 2, queuedMessages: 3 });
    render(<Harness {...rig.deps} />);

    await rig.dispatch(requestFrame('req-abc'));

    expect(rig.sent).toHaveLength(1);
    const frame = rig.reply();

    expect(frame.type).toBe('ui.state_response');
    expect(frame.requestId).toBe('req-abc');
    // The exact key set: a message body, a selection or a panel's content has no
    // field here, so an implementation that added one would fail this line.
    expect(Object.keys(frame).sort()).toEqual(RESPONSE_KEYS);

    expect(frame.deviceId).toBe(getDeviceId());
    expect(frame.tabId).toBe(getTabId());
    expect(typeof frame.deviceName).toBe('string');
    expect((frame.deviceName as string).length).toBeGreaterThan(0);
    expect(frame.visibility).toBe('visible');
    expect(frame.hasFocus).toBe(true);
    expect(frame.panel).toBe('chat');
    expect(frame.selectedProject).toBe('project-7');
    expect(frame.selectedSession).toBe('session-9');
    expect(frame.pendingApprovals).toBe(2);
    expect(frame.queuedMessages).toBe(3);
    expect(typeof frame.lastFocusedAt).toBe('number');
    expect(frame.visibleMessages).toEqual({ first: null, last: null });
  });

  it('reports visibility: hidden and hasFocus: false for a background tab', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    stubVisibility('hidden');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    await rig.dispatch(requestFrame('req-hidden'));

    const frame = rig.reply();
    expect(frame.requestId).toBe('req-hidden');
    expect(frame.visibility).toBe('hidden');
    expect(frame.hasFocus).toBe(false);
    // Nothing was focused in this tab, so there is no moment to report.
    expect(frame.lastFocusedAt).toBeNull();
  });

  it('reflects this device’s navigation policy and name from localStorage', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    localStorage.setItem('mcpNavigationPolicy', 'reject');
    localStorage.setItem('mcpNavigationDeviceName', '  Studio Mac  ');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    await rig.dispatch(requestFrame('req-policy'));

    const frame = rig.reply();
    expect(frame.navigationPolicy).toBe('reject');
    expect(frame.deviceName).toBe('Studio Mac');
  });

  it('drops a request without an id rather than answering one it cannot match', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    await rig.dispatch({ type: 'ui.state_request' });
    await rig.dispatch({ type: 'ui.state_request', requestId: '' });
    // A frame of a different kind is not this hook's to answer.
    await rig.dispatch({ type: 'ui.navigate', navigationId: 'nav-1', requestId: 'req-lost' });

    expect(rig.sent).toHaveLength(0);
  });

  it('answers every request it receives, each with its own requestId', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    await rig.dispatch(requestFrame('req-one'));
    await rig.dispatch(requestFrame('req-two'));

    expect(rig.sent.map((frame) => frame.requestId)).toEqual(['req-one', 'req-two']);
  });
});

describe('the anchor rule the transcript and the responder share', () => {
  it('prefers the provider anchor, then the read row id, then this client’s own row id', () => {
    expect(messageAnchorId({ transcriptAnchorId: 'anchor-user', transcriptRowId: 'row-1', id: 'live:1' })).toBe(
      'anchor-user',
    );
    // A row from a read has no provider anchor and no `id` — its address is its own row id.
    expect(messageAnchorId({ transcriptRowId: 'row-1', id: 'live:1' })).toBe('row-1');
    expect(messageAnchorId({ id: 'live:1' })).toBe('live:1');
    expect(messageAnchorId({})).toBeNull();
  });

  it('addresses an assistant row that carries only its read id — the arrangement the defect left blank', () => {
    const assistant = message({ type: 'assistant', transcriptRowId: 'e2e-answer_0', content: 'the answer' });
    // No provider anchor: Claude stamps one on user turns alone, which is why the raw field named nothing here.
    expect(assistant.transcriptAnchorId).toBeUndefined();
    expect(messageAnchorId(assistant)).toBe('e2e-answer_0');
  });
});

describe('the visible-message range over a real transcript', () => {
  it('reports the first and last on-screen row’s anchor ids, not a pair of nulls', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');

    // A prompt scrolled just past the pane's top, then two assistant rows filling the band — the
    // arrangement the defect met with an empty range: the band holds a message, so the addresses
    // must be the band's own rows.
    const rows: LaidOutRow[] = [
      // Bottom 40 sits inside the window but above the pane (top 60), so only the clip excludes it.
      { message: message({ type: 'user', transcriptAnchorId: 'anchor-prompt', content: 'the prompt' }), top: -300, height: 340 },
      { message: message({ type: 'assistant', transcriptRowId: 'e2e-answer_0', content: 'the answer' }), top: 100, height: 500 },
      { message: message({ type: 'assistant', transcriptRowId: 'e2e-answer_1', content: 'the tail' }), top: 640, height: 100 },
    ];
    const { paneElement, rowElements } = renderTranscript(rows, { top: 60, height: 700 });

    const rig = buildRig();
    render(<Harness {...rig.deps} />);
    await rig.dispatch(requestFrame('req-range'));

    const range = rig.reply().visibleMessages as { first: string | null; last: string | null };
    const expected = onScreenIds(paneElement, rowElements);
    expect(expected.length, 'the band must hold rows, or there is nothing to compare the range to').toBe(2);

    expect(range.first, 'the reported first id must be non-null').not.toBeNull();
    expect(range.last, 'the reported last id must be non-null').not.toBeNull();
    // The ends are the ends of what is really on screen, in transcript order.
    expect(range).toEqual({ first: expected[0], last: expected[expected.length - 1] });
    expect(range).toEqual({ first: 'e2e-answer_0', last: 'e2e-answer_1' });

    // The assistant row the defect left unaddressable is the one carrying the reported address.
    const assistantRow = rowElements.find((row) => row.textContent === 'the answer');
    expect(assistantRow?.getAttribute('data-message-anchor-id')).toBe('e2e-answer_0');
  });

  it('still reports an empty range, honestly, when no row is on screen', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');

    const rows: LaidOutRow[] = [
      { message: message({ type: 'user', transcriptAnchorId: 'anchor-prompt', content: 'above' }), top: -600, height: 200 },
      { message: message({ type: 'assistant', transcriptRowId: 'e2e-answer_0', content: 'below' }), top: 2_000, height: 300 },
    ];
    const { paneElement, rowElements } = renderTranscript(rows, { top: 60, height: 700 });
    expect(onScreenIds(paneElement, rowElements)).toEqual([]);

    const rig = buildRig();
    render(<Harness {...rig.deps} />);
    await rig.dispatch(requestFrame('req-empty'));

    expect(rig.reply().visibleMessages).toEqual({ first: null, last: null });
  });
});

describe('an absent workspace and an unreadable one are two different readings', () => {
  it('reports null with no workspace mounted and the unknown sentinel when the read fails', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    const rig = buildRig();
    render(<Harness {...rig.deps} />);

    // No `data-workspace-tab` anywhere: this tab is not showing a workspace, so the question does not apply.
    await rig.dispatch(requestFrame('req-no-workspace'));
    expect(rig.reply().panel).toBeNull();

    // A workspace shell is mounted, but no view marks itself active — the read failed. Reporting
    // null here would read to a caller exactly like "this tab shows no workspace".
    const tab = document.createElement('button');
    tab.setAttribute('data-workspace-tab', 'chat');
    document.body.appendChild(tab);

    await rig.dispatch(requestFrame('req-unreadable'));
    expect(rig.reply().panel).toBe(UNKNOWN_PANEL);
  });
});

/**
 * The three readings gap-ui-visible-context-extended-fields adds to the frame.
 *
 * Each is read from the SAME DOM contract the components now publish — the Git
 * sub-view tabs, the expanded diff items, the open task-detail modal and the
 * transcript rows — so these cases fail if a component stops publishing the
 * attribute the reading depends on, not merely if the reading is wrong.
 */
describe('the extended readings: the Git diff, the focused task and the transcript selection', () => {
  /** The active workspace panel, as the layout renders it. */
  const mountActivePanel = (panel: string): void => {
    const button = document.createElement('button');
    button.setAttribute('data-workspace-tab', panel);
    button.setAttribute('aria-current', 'true');
    document.body.appendChild(button);
  };

  /** One Git sub-view tab, as `GitViewTabs` renders it. */
  const mountGitView = (view: string, active: boolean): void => {
    const button = document.createElement('button');
    button.setAttribute('data-git-view', view);
    button.setAttribute('aria-selected', String(active));
    document.body.appendChild(button);
  };

  /** One expanded diff item, as `FileChangeItem`/`CommitHistoryItem` render it. */
  const mountExpanded = (attribute: 'data-git-expanded-file' | 'data-git-expanded-commit', value: string): void => {
    const element = document.createElement('div');
    element.setAttribute(attribute, value);
    document.body.appendChild(element);
  };

  /** The task-detail modal, as `TaskDetailModal` renders it while open. */
  const mountTaskModal = (id: string, title: string): HTMLElement => {
    const modal = document.createElement('div');
    modal.setAttribute('data-task-selected', id);
    modal.setAttribute('data-task-selected-title', title);
    document.body.appendChild(modal);
    return modal;
  };

  /** A transcript row carrying the anchor contract the selection read is gated on. */
  const mountTranscriptRow = (anchorId: string, text: string): HTMLElement => {
    const row = document.createElement('div');
    row.setAttribute('data-message-anchor-id', anchorId);
    row.textContent = text;
    document.body.appendChild(row);
    return row;
  };

  /** Selects an element's contents, the way a drag across it would. */
  const selectContents = (element: Element): void => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const answer = async (requestId: string): Promise<SentFrame> => {
    const rig = buildRig();
    render(<Harness {...rig.deps} />);
    await rig.dispatch(requestFrame(requestId));
    return rig.reply();
  };

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it('reports the two expanded files of the active Git view, and nothing else', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    mountActivePanel('git');
    mountGitView('changes', true);
    mountGitView('history', false);
    mountExpanded('data-git-expanded-file', 'src/a.ts');
    mountExpanded('data-git-expanded-file', 'src/b.ts');
    mountExpanded('data-git-expanded-commit', 'deadbeef');

    const frame = await answer('req-git');
    expect(frame.currentDiff).toEqual({
      view: 'changes',
      files: ['src/a.ts', 'src/b.ts'],
      commits: ['deadbeef'],
    });
  });

  it('reports currentDiff: null when the Git panel is not the active panel', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    mountActivePanel('chat');
    // A stale contract elsewhere in the DOM must not leak into a non-Git reading.
    mountExpanded('data-git-expanded-file', 'src/a.ts');

    const frame = await answer('req-not-git');
    expect(frame.currentDiff).toBeNull();
  });

  it('reports an empty-lists reading — not null — for the Git panel with nothing expanded', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    mountActivePanel('git');
    mountGitView('history', true);

    const frame = await answer('req-git-empty');
    // The Git panel IS the active panel, so this is a real reading with an empty
    // set — the same distinction `panel` draws between null and the unknown sentinel.
    expect(frame.currentDiff).toEqual({ view: 'history', files: [], commits: [] });
    expect(frame.currentDiff).not.toBeNull();
  });

  it('reports the focused TaskMaster task while the modal is open and null once it closes', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    const modal = mountTaskModal('42', 'Ship the reading');

    const openFrame = await answer('req-task-open');
    expect(openFrame.currentTask).toEqual({ source: 'taskmaster', id: '42', title: 'Ship the reading' });

    modal.remove();

    const closedFrame = await answer('req-task-closed');
    expect(closedFrame.currentTask).toBeNull();
  });

  it('reports the transcript selection reduced, and null when the selection is outside the transcript', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    const row = mountTranscriptRow('m-1', 'the selected passage');

    selectContents(row);
    const insideFrame = await answer('req-sel-inside');
    expect(insideFrame.selectedText).toEqual({
      text: 'the selected passage',
      truncated: false,
      region: 'transcript',
    });

    // The same text, but selected in something that is not a transcript row.
    const elsewhere = document.createElement('div');
    elsewhere.textContent = 'selected in the sidebar';
    document.body.appendChild(elsewhere);
    selectContents(elsewhere);

    const outsideFrame = await answer('req-sel-outside');
    expect(outsideFrame.selectedText).toBeNull();
  });

  it('clips a selection longer than 500 characters and flags it truncated', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stubVisibility('visible');
    const row = mountTranscriptRow('m-long', 'x'.repeat(600));

    selectContents(row);

    const frame = await answer('req-sel-long');
    const reading = frame.selectedText as { text: string; truncated: boolean; region: string };
    expect(reading.truncated).toBe(true);
    expect(reading.text).toHaveLength(500);
    expect(reading.region).toBe('transcript');
  });
});
