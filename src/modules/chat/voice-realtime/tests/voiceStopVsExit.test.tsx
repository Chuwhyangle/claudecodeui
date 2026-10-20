/**
 * AC (this task) — Live Voice's Leave and a running turn's Stop are two different controls, and
 * leaving does not stop the run.
 *
 * THE CLAIM. The bar's End used to be a solid red Square — the same glyph, and nearly the same
 * colour weight, the composer's submit button shows while a turn runs (its Stop). Read side by
 * side, "leave the microphone" and "cancel what Claude is doing" looked like one button, and
 * pressing End also dropped whatever had been heard and never delivered. The controls are now told
 * apart — a leaving glyph (`LogOut`) on the same pure icon square the mic controls are, fenced off
 * from them, and the running turn's Stop drawn on the transcript's own status row, where it stays
 * reachable in Live Voice too (the composer that carries the submit-button Stop is not mounted
 * there) — and leaving re-homes the undelivered words into the composer instead of discarding them.
 *
 * WHY THIS FILE, AND WHY THE FIRST ASSERTION IS THE ICON ONE. The criterion that names this file
 * runs it as the ONLY filter, so a green run is a reading of THIS file and nothing else. Its first
 * assertion is the falsifying shape the requirement leads with — the two buttons do not carry the
 * same icon — so the one reading the pre-fix UI fails is the first thing the run reports.
 *
 * This case renders the REAL `ChatInterface` (and through it the real `ChatMessagesPane`,
 * `ActivityIndicator`, `ChatComposer` and `VoiceRealtimeBar`), with the app's websocket, session,
 * provider and composer hooks handed their answers directly — the same shape
 * `chatInterfaceEscapeAbort.test.tsx` uses. The voice connection is driven through a fake
 * `WebSocket` and a fake audio source, so the bar's DOM is read against real markup and a real
 * (fake-socket) session.
 *
 * Run: npm run test:client -- src/modules/chat/voice-realtime/tests/voiceStopVsExit.test.tsx
 */
import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { VoiceRealtimeAudioFrame, VoiceRealtimeAudioSource } from '@/modules/chat/voice-realtime/audioSource';
import type { ChatMessage, Project, SessionActivity } from '@/shared/types';

const SESSION_ID = 'session-stop-exit';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const DESKTOP_WIDTH = 1280;

const PROJECT: Project = {
  projectId: 'project-stop-exit',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const ACTIVITY: SessionActivity = { statusText: 'Reviewing', canInterrupt: true, startedAt: START };

/**
 * The session already has a loaded turn on screen. A LIVE turn always does — the pane's list branch
 * is gated on the loaded `chatMessages` being non-empty (`isProcessing && chatMessages.length === 0`
 * draws the loading state), and a person can only be in Live Voice on a session they are already
 * talking to. The rows have to be rendered: the conversation's own contents are what several legs
 * below read — both the real messages they must carry and the voice-only rows they must not.
 */
const PRIOR_TURN: ChatMessage = { type: 'user', content: 'earlier question', timestamp: START };

/** What the recogniser heard — a final utterance with no delivery, so it is the leave backlog. */
const HEARD = '把 server 的日志贴出来';

const state = vi.hoisted(() => ({
  canAbortSession: true,
  aborts: 0,
  // The session's "a turn is in flight" reading. It has to be mutable: the shipped composer makes
  // the submit button the Live Voice entry ONLY while nothing is running (every busier tier —
  // loading / recording / transcribing / queueing — wins), so a case that is in Live Voice while a
  // turn runs enters first and resumes the turn afterwards.
  isProcessing: true,
  // The rows the session reports as visible. A cell the AC1/AC2 case moves so the relayed message
  // can land in the transcript the way it really does — a run later than the `sent` frame.
  visibleMessages: [] as ChatMessage[],
}));

// ── the fake wire and audio source the voice hook drives (the voiceCaptionShownState harness) ───

const auth = vi.hoisted(() => ({ token: 'jwt-token' as string | null }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: auth.token }) }));

type FakeSource = VoiceRealtimeAudioSource & { push(frame: VoiceRealtimeAudioFrame): void; stopped: number };
const sources: FakeSource[] = [];
vi.mock('@/modules/chat/voice-realtime/audioSource', () => {
  const make = (): FakeSource => {
    let onFrame: ((frame: VoiceRealtimeAudioFrame) => void) | null = null;
    const source: FakeSource = {
      stopped: 0,
      async start(handler) {
        onFrame = handler;
      },
      stop() {
        source.stopped += 1;
      },
      push(frame) {
        onFrame?.(frame);
      },
    };
    sources.push(source);
    return source;
  };
  // `ChatInterface` prewarms the microphone on the Live Voice tap (the connecting-window fix).
  // This harness drives capture through the hook's own `microphoneAudioSource()` above and reads
  // the bar, so the warm-up has nothing to acquire here — it must only not throw. Prewarm itself
  // is asserted in `liveVoiceMicPrewarmEntry.test.tsx` and `audioSource.warm.test.ts`.
  return {
    microphoneAudioSource: make,
    fileAudioSource: make,
    warmMicrophoneSource: async () => undefined,
    releaseWarmMicrophoneSource: () => undefined,
  };
});

/** The slice of WebSocket the hook uses, with a hand to deliver server frames. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>);
  }
}

const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

// ── the ChatInterface doubles (the chatInterfaceEscapeAbort harness) ───────────────────────────

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
  // ChatInterface hands this to the transcript's empty state; tasksEnabled is false above, so it
  // is never rendered. The real one reads TaskMasterContext, which these cases do not provide.
  NextTaskBanner: () => null,
}));

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

vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => undefined }));
vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: () => undefined }),
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useResidentProviders: () => new Set<string>() }));
vi.mock('@/shared/selectedProvider', () => ({ readSelectedProvider: () => 'claude' }));
vi.mock('@/shared/hooks/useSessionHosts', () => ({
  useSessionHosts: () => ({ snapshot: { hosts: [], sessions: [] } }),
  findSessionHostState: () => null,
  findSessionOccupancy: () => null,
}));
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    api: {
      forkSession: async () => ({ ok: true, json: async () => ({ data: { sessionId: SESSION_ID } }) }),
      commands: { list: async () => ({ ok: true, json: async () => ({ commands: [] }) }) },
    },
  };
});
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
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
    chatMessages: [PRIOR_TURN],
    addMessage: () => undefined,
    markUserTurnUndelivered: () => undefined,
    restoreUserTurn: () => undefined,
    sessionActivity: ACTIVITY,
    isProcessing: state.isProcessing,
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
    visibleMessages: state.visibleMessages,
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

// The composer hook is doubled with a REAL state cell, so the draft the leave re-homes into is the
// draft the (real) ChatComposer textarea reads back — the box a person would see, not a stub.
vi.mock('@/modules/chat/hooks/useChatComposerState', async () => {
  const ReactModule = await import('react');
  return {
    useChatComposerState: () => {
      const [input, setInput] = ReactModule.useState('');
      return {
        input,
        setInput,
        textareaRef: { current: null },
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
      };
    },
  };
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
  state.isProcessing = true;
  state.visibleMessages = [PRIOR_TURN];
  auth.token = 'jwt-token';
  FakeWebSocket.instances = [];
  sources.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const interfaceElement = () => (
  <ChatInterface isActive selectedProject={PROJECT} selectedSession={null} ws={null} sendMessage={() => undefined} />
);

const renderInterface = () => render(interfaceElement());

/**
 * Enters Live Voice on the already-scoped session and opens the fake connection.
 *
 * The shipped composer makes the submit button the Live Voice entry only while the draft is empty
 * AND nothing is running (a running turn's Stop outranks it). Every case that reads the LEAVE
 * against a running turn therefore enters while the session is momentarily idle and resumes the
 * turn immediately after — the same end state the old always-visible entry produced.
 */
const enterVoice = async (view: ReturnType<typeof renderInterface>) => {
  state.isProcessing = false;
  view.rerender(interfaceElement());
  fireEvent.click(view.getByTestId('live-voice-button'));
  await waitFor(() => assert.ok(view.getByTestId('voice-realtime-bar'), 'the bar must mount on entry'));
  await waitFor(() => assert.ok(socket(), 'the entry must open the voice connection'));
  act(() => socket().receive({ type: 'state', state: 'open' }));
  state.isProcessing = true;
  view.rerender(interfaceElement());
};

const composerTextarea = (view: ReturnType<typeof renderInterface>): HTMLTextAreaElement => {
  const area = view.container.querySelector('textarea[data-slot="prompt-input-textarea"]');
  assert.ok(area, 'the composer textarea must be on screen');
  return area as HTMLTextAreaElement;
};

// ── AC1: the two controls do not share a glyph (FIRST ASSERTION IN THE FILE) ────────────────────

test('the leave control and the composer stop do not share an icon, and leave is a pure icon square', async () => {
  const view = renderInterface();

  // Both glyphs are read BEFORE the first claim, so the file's leading assertion is the requirement's
  // own and not a premise. The composer's Stop is on screen while a turn runs; entering Live Voice
  // swaps the composer out for the bar, so the composer's glyph has to be read while it is still
  // mounted. Read null-tolerantly: a missing control then fails at the claim that names it, below,
  // rather than in a helper before the claim.
  const stopIcon = view.container.querySelector('button[aria-label="Stop"] svg')?.getAttribute('class') ?? '';
  await enterVoice(view);
  const exit = view.getByTestId('voice-realtime-end');
  const exitIcon = exit.querySelector('svg')?.getAttribute('class') ?? '';

  // THE reading the requirement leads with: two different controls, two different glyphs. It is the
  // first assertion this file's criterion run reports.
  assert.notEqual(
    exitIcon,
    stopIcon,
    `the leave control must not draw the stop's own glyph: leave="${exitIcon}" stop="${stopIcon}"`,
  );
  assert.ok(exitIcon.includes('log-out'), `the leave control draws a leaving glyph: "${exitIcon}"`);
  assert.ok(stopIcon.includes('square'), `the composer's stop draws the stop glyph: "${stopIcon}"`);

  // And the leave control is the SAME pure icon square as the controls beside it — no visible text,
  // Mute's own class (so the same `h-10 w-10` target and `text-foreground`), and tooltip/accessible
  // name carrying the meaning the removed label used to.
  assert.equal(exit.textContent?.trim(), '', 'the leave control carries no visible text');
  assert.ok(exit.getAttribute('aria-label'), 'the leave control has an accessible name');
  assert.ok(exit.getAttribute('title'), 'the leave control has a tooltip');
  assert.equal(
    exit.className,
    view.getByTestId('voice-realtime-mute').className,
    "the leave control shares the mic controls' icon-square class",
  );
  assert.equal(
    view.container.querySelector('[data-testid="voice-realtime-exit-label"]'),
    null,
    'the old visible text label is gone',
  );

  view.unmount();
});

// ── AC2: the running row's own Stop ─────────────────────────────────────────────────────────────

test('the running status row carries a stop that aborts exactly once', () => {
  const view = renderInterface();

  const stop = view.container.querySelector('[data-testid="running-turn-stop"]');
  assert.ok(stop, `the running turn must expose its own stop on the status row; DOM: ${view.container.innerHTML.slice(0, 400)}`);

  fireEvent.click(stop);
  assert.equal(state.aborts, 1, `the row stop must reach the abort handler exactly once; it ran ${state.aborts} time(s)`);

  view.unmount();
});

// ── AC3: the same Stop is present and live in voice mode ────────────────────────────────────────

test('in Live Voice the running row keeps its stop, and it still aborts', async () => {
  const view = renderInterface();
  await enterVoice(view);

  // The composer (and its submit-button Stop) is gone; the row's Stop must not have gone with it.
  assert.equal(
    view.container.querySelector('textarea[data-slot="prompt-input-textarea"]'),
    null,
    'premise: the text composer is replaced while voice mode is active',
  );
  const stop = view.getByTestId('running-turn-stop');
  fireEvent.click(stop);
  assert.equal(state.aborts, 1, `the row stop must abort inside voice mode too; it ran ${state.aborts} time(s)`);

  view.unmount();
});

// ── AC4: leaving is not stopping (negative control) ─────────────────────────────────────────────

test('leaving Live Voice does not abort the running turn', async () => {
  const view = renderInterface();
  await enterVoice(view);

  fireEvent.click(view.getByTestId('voice-realtime-end'));

  // The one thing the leave must NOT do: reach the abort path.
  assert.equal(state.aborts, 0, `leaving must not abort the turn; the abort handler ran ${state.aborts} time(s)`);
  // And the run is still the transcript's live reading — the turn did not end with the mode.
  await waitFor(() => assert.equal(view.container.querySelector('[data-testid="voice-realtime-bar"]'), null));
  assert.ok(
    view.container.querySelector('.chat-messages-pane [data-activity-dock][data-activity-state="in-turn"]'),
    'the turn must still be running after the mode is left',
  );

  view.unmount();
});

// ── AC5: undelivered words survive the leave, as a draft ────────────────────────────────────────

test('words heard but never delivered are re-homed into the composer, and never re-delivered', async () => {
  const view = renderInterface();
  await enterVoice(view);

  // The endpoint closes an utterance the proxy never took over: exactly the words a leave loses.
  act(() => socket().receive({ type: 'caption', itemId: 'a', text: HEARD, final: true }));

  const wire = socket();
  fireEvent.click(view.getByTestId('voice-realtime-end'));

  // The backlog is in the box, as a draft.
  await waitFor(() => assert.ok(view.container.querySelector('textarea[data-slot="prompt-input-textarea"]')));
  assert.equal(composerTextarea(view).value, HEARD, 'the undelivered words must appear in the composer input');

  // And they were NOT pushed back onto the wire: the client never re-sends the spoken words, so
  // there is no second delivery of the same message to count.
  const redelivered = wire.sent.filter((frame) => frame.includes(HEARD)).length;
  assert.equal(redelivered, 0, `the backlog must not be re-delivered automatically; it went out ${redelivered} time(s)`);
  assert.ok(wire.closed, 'the live connection must be closed by the leave');

  view.unmount();
});

test('a leave with nothing unheard leaves the composer untouched', async () => {
  const view = renderInterface();
  await enterVoice(view);

  fireEvent.click(view.getByTestId('voice-realtime-end'));

  await waitFor(() => assert.ok(view.container.querySelector('textarea[data-slot="prompt-input-textarea"]')));
  assert.equal(composerTextarea(view).value, '', 'an orderly leave must not write a phantom draft');

  view.unmount();
});

// ── the conversation stays the conversation, whatever the connection does ───────────────────────
//
// The close-trace line is part of that (gap-voice-close-trace-row-removed-from-transcript). A close
// on words the screen never showed used to append a system row — "Live Voice closed before N of your
// words reached the screen." — which, being a fact about the CONNECTION, outlived the mode. The line
// is gone by human ruling (2026-10-14). The leg below pins both halves on the SAME scenario, off the
// real `ChatInterface`: the session reports the dead connection on the BAR, and neither the row's
// testid nor its copy is anywhere in the conversation.

/** The copy the removed close-trace row used to draw. Its absence is read below, after Exit. */
const CLOSE_TRACE_COPY = 'Live Voice closed before';

test('a close on unshown words adds nothing to the conversation — the bar is where the session reports itself', async () => {
  const view = renderInterface();
  await enterVoice(view);

  // The server closes the socket on words the screen never showed. The client still counts the loss
  // (read off the hook in `voiceCaptionShownState.test.tsx`, with its own console record); what this
  // case pins is WHERE it is told — on the bar, not as a line in the conversation.
  act(() => socket().receive({ type: 'caption', itemId: 'a', text: HEARD, final: true }));
  act(() => socket().close());
  await waitFor(() =>
    assert.equal(
      view.getByTestId('voice-realtime-status').textContent,
      'Voice disconnected',
      'the bar must report the dead connection',
    ),
  );

  assert.equal(
    view.container.querySelectorAll('[data-testid="voice-closed-unshown-utterance"]').length,
    0,
    'a close must not add a voice-only line to the conversation',
  );

  // Leaving the mode changes nothing about that: there was never a line to take away, and the rows
  // the person can still read are the same ones.
  fireEvent.click(view.getByTestId('voice-realtime-end'));
  await waitFor(() => assert.equal(view.container.querySelector('[data-testid="voice-realtime-bar"]'), null));
  assert.equal(
    view.container.querySelectorAll('[data-testid="voice-closed-unshown-utterance"]').length,
    0,
    'the conversation is unchanged by the mode being left',
  );

  // The row's own COPY, not only its testid: the words are what the person would actually read, and
  // after the mode is left the page carries none of them. Non-vacuity comes from the draft read
  // beside it — the undelivered words still reach the composer, so this is a page that really ran
  // the close and not a page that rendered nothing at all.
  await waitFor(() => assert.ok(view.container.querySelector('textarea[data-slot="prompt-input-textarea"]')));
  assert.equal(composerTextarea(view).value, HEARD, 'the undelivered words must still reach the composer');
  const pageText = view.container.textContent ?? '';
  assert.equal(
    pageText.includes(CLOSE_TRACE_COPY),
    false,
    `the removed close trace must not be on the page; page said ${JSON.stringify(pageText)}`,
  );

  view.unmount();
});

// ── AC1/AC2 (gap-live-voice-caption-attribution-swallows-undelivered) ───────────────────────────
//
// A delivery must claim only the utterances its OWN relayed message carries, never "every finished
// utterance still unclaimed". The swallowing shape: the endpoint recognises several utterances the
// model chooses not to forward, so no delivery carries them; a LATER delivery — relaying different
// words — used to claim them all, and the leave both lost them from the composer and took their
// bubbles off screen. Here a delivery relays three utterances verbatim and must take only those.

/** Utterances the recogniser heard that the model never relays — the leave's backlog. */
const SWALLOWED = ['现在可以看出来啊', '当前时间来了', '懂', '而后退'];
/** Utterances a later delivery really relays, verbatim — the only ones it may claim. */
const CARRIED = ['好像现在语音输入又断了', '哦只是慢', '还是出来了'];
const CARRIED_MESSAGE = CARRIED.map((piece) => `${piece}。`).join('');

/** The real transcript row the relayed delivery becomes, stamped now (the matcher bounds it in time). */
const relayedDeliveryRow = (): ChatMessage => ({
  id: 'real-delivery',
  type: 'user',
  content: CARRIED_MESSAGE,
  timestamp: Date.now(),
});

test('a delivery claims only the utterances its own message carries, so the rest survive the leave', async () => {
  const view = renderInterface();
  await enterVoice(view);

  // Four finished utterances the model never forwards: no delivery will ever contain their words.
  SWALLOWED.forEach((text, i) =>
    act(() => socket().receive({ type: 'caption', itemId: `sw${i}`, text, final: true })),
  );
  // Then a later delivery that relays three OTHER utterances verbatim.
  CARRIED.forEach((text, i) =>
    act(() => socket().receive({ type: 'caption', itemId: `c${i}`, text, final: true })),
  );
  // The relayed message lands as a real transcript row — the delivery is now SHOWN (a run later than
  // the `sent` frame, exactly as in the incident), so the fold would empty the swallowed words had
  // the delivery claimed them.
  act(() => {
    state.visibleMessages = [PRIOR_TURN, relayedDeliveryRow()];
  });
  act(() => socket().receive({ type: 'sent', sessionId: SESSION_ID, result: {}, message: CARRIED_MESSAGE }));

  // (b) THE DELIVERY'S OWN READING IS NOW READ OFF THE LEAVE. Every on-screen surface that used to
  // name the delivery's utterances is gone with the other voice-only rows — the badge on the
  // delivered message, and the row-per-utterance the pane kept before that. What is left is the
  // CONSEQUENCE, asserted below: the leave re-homes exactly the four the delivery never carried, and
  // none of the three it did. A swallow — one delivery claiming every finished utterance still
  // unclaimed — would empty the draft, so that leg is what falsifies it now.
  assert.equal(
    view.container.querySelectorAll('[data-testid="voice-transcript-badge"]').length,
    0,
    'a delivered message is an ordinary message: no voice-only mark on it',
  );
  assert.equal(
    view.container.querySelectorAll('[data-testid^="voice-row-"]').length,
    0,
    'the pane must add no row of its own for a spoken utterance',
  );

  // AC2: leaving re-homes exactly those four, and not the delivered three.
  const wire = socket();
  fireEvent.click(view.getByTestId('voice-realtime-end'));

  await waitFor(() => assert.ok(view.container.querySelector('textarea[data-slot="prompt-input-textarea"]')));
  const draft = composerTextarea(view).value;
  for (const text of SWALLOWED) {
    assert.ok(draft.includes(text), `the swallowed utterance "${text}" must reach the composer; draft "${draft}"`);
  }
  for (const text of CARRIED) {
    assert.ok(
      !draft.includes(text),
      `the delivered utterance "${text}" must NOT be re-homed; draft "${draft}"`,
    );
  }

  // And nothing was pushed back onto the wire: the client never re-sends spoken words, so there is no
  // second delivery of the same message to count.
  const redelivered = wire.sent.filter((frame) => SWALLOWED.some((text) => frame.includes(text))).length;
  assert.equal(redelivered, 0, `the backlog must not be re-delivered automatically; it went out ${redelivered} time(s)`);

  view.unmount();
});
