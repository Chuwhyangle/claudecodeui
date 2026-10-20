import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

// Type-only module aliases, so the mock's `importOriginal` can name the module's type without an
// `import()` annotation (which this repo's lint forbids) and without a runtime import (the factory
// is hoisted above every statement in this file). Erased before that hoisting runs.
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type { Project, SessionActivity, SessionHostsSnapshot } from '@/shared/types';
import ChatInterface from '@/modules/chat/ChatInterface';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ResidentSessionBadge from '@/modules/chat/transcript/ResidentSessionBadge';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import enChat from '@/modules/i18n/locales/en/chat.json';

/**
 * Escape is the composer's key only when the composer is where the user is, and only when no
 * floating layer is up.
 *
 * The listener it holds is ChatInterface's own document-level capture listener, armed while
 * `canAbortSession` is true. It used to fire on any Escape anywhere on the page. Two things were
 * wrong with that. Focus was never consulted, so Escape pressed on a button, the transcript, or
 * nothing at all stopped the turn. And it ran *before* every floating layer's own Escape handling —
 * those registers are on the same `document` node and, in the badge panel's and the Dialog's case,
 * leave `defaultPrevented` false — so opening the resident pill's panel and pressing Escape closed
 * the panel *and* killed the running turn: the round kept going server-side while the queued line
 * landed on a turn the page had just abandoned.
 *
 * This file holds the guard, with the real ChatInterface (its real capture listener, the real
 * ChatComposer whose textarea carries the focus the guard reads) and real floating layers:
 *
 *   (a) focus in the composer, no layer, turn running  -> exactly one abort
 *   (b) a floating layer open, focus still in the composer -> it closes, zero aborts
 *   (c) focus somewhere else, turn running            -> zero aborts
 *   (d) nothing to abort                              -> zero aborts
 *
 * The layers in (b) are the real components. At least one of them must be a layer that does *not*
 * `preventDefault` its own Escape — the badge panel and the Dialog are exactly that, and they are
 * what makes (b) load-bearing. The composer's model menu is the control: `useComposerMenuAnchor`
 * listens on *window* capture, one hop above ChatInterface's `document` capture, so it was immune
 * before this guard existed; it would stay green for a page that never grew one.
 *
 * ChatInterface wires a websocket, session, provider and composer state that would each reach the
 * network here; the hook-level doubles below hand it their answers directly. What stays real is
 * everything this file is about: the listener, the composer, and the layers.
 */

const SESSION_ID = 'session-escape-guard';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const DESKTOP_WIDTH = 1280;

const PROJECT: Project = {
  projectId: 'project-escape-guard',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const ACTIVITY: SessionActivity = { statusText: 'Reviewing', canInterrupt: true, startedAt: START };

/** Mutable state the doubles read, so one case can flip `canAbortSession` between arms. */
const state = vi.hoisted(() => ({ canAbortSession: true, aborts: 0 }));

/**
 * The composer's own textarea ref, hoisted so this file can both hand ChatInterface the *same*
 * object every render (a fresh `{ current: null }` per render would make the real ChatComposer's
 * ref detach and reattach) and focus the node the guard reads.
 */
const composer = vi.hoisted(() => ({ textarea: { current: null as HTMLTextAreaElement | null } }));

/** The resident snapshot the real `useSessionHosts` helpers read; resident, so the pill draws. */
const harness = vi.hoisted(() => ({ snapshot: null as unknown as SessionHostsSnapshot }));

const makeSnapshot = (): SessionHostsSnapshot =>
  ({
    hosts: [
      {
        hostId: 'host-escape-guard',
        provider: 'claude',
        mode: 'resident',
        state: 'idle',
        pid: 4242,
        startedAt: Date.now() - 60_000,
        closeReason: null,
        closeDetail: '',
        bindings: [
          {
            appSessionId: SESSION_ID,
            providerSessionId: 'provider-session-escape-guard',
            state: 'idle',
            leases: [],
            lastActivityAt: Date.now(),
            peerName: 'resident@host',
          },
        ],
      },
    ],
    sessions: [
      {
        appSessionId: SESSION_ID,
        provider: 'claude',
        lifecycleMode: 'resident',
        running: false,
        reason: null,
      },
    ],
  }) as unknown as SessionHostsSnapshot;

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
  // ChatInterface hands this to the transcript's empty state; tasksEnabled is false above, so it
  // is never rendered. The real one reads TaskMasterContext, which these cases do not provide.
  NextTaskBanner: () => null,
}));

// Only `useWebSocket` is doubled: the module's default export is the real context, whose `null`
// value the dock's own `useContext` reading already tolerates.
vi.mock('@/shared/context/WebSocketContext', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useWebSocket: () => ({ subscribe: () => () => undefined, isConnected: true }),
  };
});

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({ markSessionProcessing: () => undefined, markSessionIdle: () => undefined }),
}));

vi.mock('@/modules/chat/hooks/useSessionStore', () => ({
  useSessionStore: () => ({}),
}));

vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({
  useChatRealtimeHandlers: () => undefined,
}));

vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: () => undefined }),
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useResidentProviders: () => new Set<string>(),
}));

vi.mock('@/shared/selectedProvider', () => ({
  readSelectedProvider: () => 'claude',
}));

// The store is a module-scope poller with no test seam, so only the snapshot is supplied through
// the hook; the module's own readings (`findSessionHostState`, `findSessionOccupancy`, …) are kept,
// because the pill and the composer's occupied state read them for real. The snapshot is resident
// so the badge this file presses Escape over is a real one the real helpers recognise.
vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  return {
    ...actual,
    useSessionHosts: () => ({
      refresh: async () => {},
      start: async () => {},
      close: async () => {},
      forceClose: async () => {},
      snapshot: harness.snapshot,
      error: null,
      loading: false,
    }),
  };
});

vi.mock('@/shared/api', () => ({
  api: {
    forkSession: async () => ({ ok: true, json: async () => ({ data: { sessionId: SESSION_ID } }) }),
    commands: { list: async () => ({ ok: true, json: async () => ({ commands: [] }) }) },
    sessionHosts: { close: async () => ({ ok: true, json: async () => ({}) }) },
  },
}));

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default: keeps this whole-module replacement complete.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
}));

vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: 'claude',
    setProvider: () => undefined,
    providerModels: { claude: 'claude-sonnet-4-5' },
    setStoredProviderModel: () => undefined,
    currentProviderEffort: 'medium',
    currentProviderEffortOptions: [{ value: 'medium' }],
    currentProviderModel: 'claude-sonnet-4-5',
    currentProviderModelOptions: [{ value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }],
    permissionMode: 'default',
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => undefined,
    availablePermissionModes: ['default'],
    selectPermissionMode: () => undefined,
    cyclePermissionMode: () => undefined,
    providerModelCatalog: {},
    providerModelsLoading: false,
    providerModelActions: {},
    selectProviderModel: async () => undefined,
    selectProviderEffort: async () => undefined,
    resolvePermissionModeForProvider: () => 'default',
    supportsMessageEditing: true,
    supportsSessionForking: true,
  }),
}));

vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
    addMessage: () => undefined,
    markUserTurnUndelivered: () => undefined,
    restoreUserTurn: () => undefined,
    sessionActivity: ACTIVITY,
    isProcessing: true,
    canAbortSession: state.canAbortSession,
    currentSessionId: SESSION_ID,
    setCurrentSessionId: () => undefined,
    isLoadingSessionMessages: false,
    isLoadingMoreMessages: false,
    hasMoreMessages: false,
    totalMessages: 0,
    isUserScrolledUp: false,
    setIsUserScrolledUp: () => undefined,
    tokenBudget: null,
    setTokenBudget: () => undefined,
    visibleMessageCount: 0,
    visibleMessages: [],
    loadEarlierMessages: () => undefined,
    loadAllMessages: () => undefined,
    loadFullTranscript: async () => [],
    allMessagesLoaded: true,
    isLoadingAllMessages: false,
    loadAllJustFinished: false,
    showLoadAllOverlay: false,
    createDiff: () => [],
    scrollContainerRef: { current: null },
    scrollContentRef: null,
    scrollToBottom: () => undefined,
    scrollToBottomAndReset: () => undefined,
    handleScroll: () => undefined,
    requestLatestMessages: async () => undefined,
  }),
}));

vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({
    input: '',
    setInput: () => undefined,
    // The first argument of the real hook, and the node the guard reads focus against.
    textareaRef: composer.textarea,
    inputHighlightRef: { current: null },
    isTextareaExpanded: false,
    slashCommandsCount: 0,
    filteredCommands: [],
    frequentCommands: [],
    commandQuery: '',
    showCommandMenu: false,
    selectedCommandIndex: 0,
    resetCommandMenuState: () => undefined,
    handleCommandSelect: () => undefined,
    handleToggleCommandMenu: () => undefined,
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    renderInputWithMentions: () => null,
    selectFile: () => undefined,
    attachedFiles: [],
    setAttachedFiles: () => undefined,
    fileErrors: new Map<string, string>(),
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    openAttachmentPicker: () => undefined,
    handleSubmit: () => undefined,
    queuedDraft: null,
    editQueuedDraft: () => undefined,
    deleteQueuedDraft: () => undefined,
    handleVoiceTranscript: () => undefined,
    handleInputChange: () => undefined,
    handleKeyDown: () => undefined,
    handlePaste: () => undefined,
    handleTextareaClick: () => undefined,
    handleTextareaInput: () => undefined,
    syncInputOverlayScroll: () => undefined,
    handleClearInput: () => undefined,
    handleAbortSession: () => {
      state.aborts += 1;
    },
    handlePermissionDecision: () => undefined,
    handleGrantToolPermission: () => ({ success: true }),
    handleInputFocusChange: () => undefined,
    commandModalPayload: null,
    closeCommandModal: () => undefined,
    showCostModal: () => undefined,
    editingAnchorId: null,
    beginEditMessage: () => undefined,
    cancelEditMessage: () => undefined,
    draftScope: SESSION_ID,
    sendFailed: false,
  }),
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const installMatchMedia = () => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  installMatchMedia();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: DESKTOP_WIDTH });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
  state.canAbortSession = true;
  state.aborts = 0;
  harness.snapshot = makeSnapshot();
});

afterEach(() => {
  cleanup();
});

const LAYER_SELECTOR = '[role="dialog"],[role="menu"],[role="listbox"]';

/** Renders the real ChatInterface and returns the textarea the guard reads focus on. */
function renderInterface() {
  const view = render(
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={null}
      ws={null}
      sendMessage={() => undefined}
    />,
  );
  const textarea = view.container.querySelector('textarea');
  assert.ok(textarea, `premise: the real composer must draw a textarea; DOM: ${view.container.innerHTML.slice(0, 400)}`);
  composer.textarea.current = textarea as HTMLTextAreaElement;
  return view;
}

/** Escape lands on the focused element in a browser; here the composer's textarea carries it. */
const pressEscape = () => {
  const target = document.activeElement ?? document;
  fireEvent.keyDown(target, { key: 'Escape' });
};

test('(a) focus in the composer, no floating layer, turn running: Escape aborts exactly once', () => {
  const view = renderInterface();
  composer.textarea.current?.focus();

  assert.equal(document.activeElement, composer.textarea.current, 'premise: the composer textarea holds focus');
  assert.equal(document.activeElement, view.container.querySelector('textarea'), 'premise: and it is the real one');
  assert.equal(document.querySelector(LAYER_SELECTOR), null, 'premise: no floating layer is open');
  assert.equal(state.canAbortSession, true, 'premise: the turn can be aborted');

  pressEscape();
  console.log(`[reading] (a) aborts=${state.aborts}`);
  assert.equal(state.aborts, 1, `a focused composer with no layer must abort once; it aborted ${state.aborts} time(s)`);
});

test('(b) the resident pill panel open: Escape closes it and does not abort', () => {
  const view = renderInterface();
  composer.textarea.current?.focus();
  assert.equal(document.activeElement, composer.textarea.current, 'premise: the composer textarea holds focus');

  const badge = render(<ResidentSessionBadge sessionId={SESSION_ID} />);
  const pill = badge.container.querySelector<HTMLElement>('[data-resident-badge]');
  assert.ok(pill, 'premise: the resident pill must draw for a resident session');
  act(() => {
    fireEvent.click(pill);
  });
  const panel = document.querySelector('[data-resident-badge-panel]');
  assert.ok(panel, 'premise: the pill must open its panel');
  assert.equal(panel.getAttribute('role'), 'dialog', 'premise: the panel is the layer the guard must see');
  assert.equal(document.activeElement, composer.textarea.current, 'premise: the composer still holds focus');

  pressEscape();
  console.log(
    `[reading] (b/pill) aborts=${state.aborts} panelOpen=${document.querySelector('[data-resident-badge-panel]') !== null}`,
  );
  assert.equal(state.aborts, 0, `Escape inside the pill panel must not abort the turn; it aborted ${state.aborts} time(s)`);
  assert.equal(document.querySelector('[data-resident-badge-panel]'), null, 'and the panel must be closed by that same Escape');
  view.unmount();
});

test('(b) a Dialog open: Escape closes it and does not abort', () => {
  const view = renderInterface();
  composer.textarea.current?.focus();

  render(
    <Dialog defaultOpen>
      <DialogContent>
        <DialogTitle>Probe</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
  assert.ok(document.querySelector('[role="dialog"]'), 'premise: the real Dialog must be open');
  assert.equal(document.activeElement, composer.textarea.current, 'premise: the composer keeps focus');
  assert.equal(state.aborts, 0, 'premise: no abort yet');

  pressEscape();
  console.log(`[reading] (b/dialog) aborts=${state.aborts} dialogOpen=${document.querySelector('[role="dialog"]') !== null}`);
  assert.equal(state.aborts, 0, `Escape inside a Dialog must not abort the turn; it aborted ${state.aborts} time(s)`);
  assert.equal(document.querySelector('[role="dialog"]'), null, 'and the Dialog must be closed by that same Escape');
  view.unmount();
});

test('(b) the composer model menu open: Escape closes it and does not abort', () => {
  const view = renderInterface();
  composer.textarea.current?.focus();

  // Scoped to this render's own container: the real composer inside ChatInterface draws its own
  // `aria-haspopup` triggers, and a page-wide query would press one of those instead.
  const menuView = render(
    <ComposerModelMenu
      effort="medium"
      effortOptions={[]}
      onSelectEffort={() => undefined}
      model="claude-sonnet-4-5"
      modelOptions={[{ value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }]}
      onSelectModel={() => undefined}
      modelsLoading={false}
    />,
  );
  const trigger = menuView.container.querySelector<HTMLElement>('[aria-haspopup="menu"]');
  assert.ok(trigger, 'premise: the model menu must draw its trigger');
  act(() => {
    fireEvent.click(trigger);
  });
  assert.ok(document.querySelector('[role="menu"]'), 'premise: the menu must be open');
  assert.equal(state.aborts, 0, 'premise: no abort yet');

  pressEscape();
  console.log(`[reading] (b/menu) aborts=${state.aborts} menuOpen=${document.querySelector('[role="menu"]') !== null}`);
  assert.equal(state.aborts, 0, `Escape inside the composer menu must not abort the turn; it aborted ${state.aborts} time(s)`);
  assert.equal(document.querySelector('[role="menu"]'), null, 'and the menu must be closed by that same Escape');
  view.unmount();
});

test('(c) focus outside the composer, turn running: Escape does not abort', () => {
  renderInterface();
  const probe = render(<button type="button">elsewhere</button>);
  const button = probe.container.querySelector('button');
  assert.ok(button, 'premise: a button outside the composer must be focusable');
  button.focus();
  assert.notEqual(document.activeElement, composer.textarea.current, 'premise: focus has left the composer');
  assert.equal(state.canAbortSession, true, 'premise: the turn can still be aborted');
  assert.equal(document.querySelector(LAYER_SELECTOR), null, 'premise: no floating layer is open');

  pressEscape();
  console.log(`[reading] (c) aborts=${state.aborts} focused=${document.activeElement?.tagName ?? 'none'}`);
  assert.equal(state.aborts, 0, `Escape off the composer must not abort the turn; it aborted ${state.aborts} time(s)`);
});

test('(d) nothing to abort: Escape does not abort even with the composer focused', () => {
  state.canAbortSession = false;
  renderInterface();
  composer.textarea.current?.focus();
  assert.equal(document.activeElement, composer.textarea.current, 'premise: the composer textarea holds focus');
  assert.equal(document.querySelector(LAYER_SELECTOR), null, 'premise: no floating layer is open');

  pressEscape();
  console.log(`[reading] (d) aborts=${state.aborts}`);
  assert.equal(state.aborts, 0, `Escape with nothing to abort must not reach the handler; it aborted ${state.aborts} time(s)`);
});
