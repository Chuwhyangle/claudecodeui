/**
 * A conversation a Claude Code background job is running is read-only — and it comes back by itself.
 *
 * THE CLAIM, IN ONE SENTENCE. When `GET /api/session-hosts` says a session is held
 * (`occupiedBy: { jobId, pid }`), the composer refuses to send — its input is disabled, a notice names the
 * holder and the command that frees it, the status bar offers no [Start], and the send path itself refuses
 * even when it is called directly. When the holder goes away, the very next listing update puts all of
 * that back, in the same mounted tree, with no reload.
 *
 * WHY A REFUSAL AND NOT A HINT. The CLI exits 1 on a `--resume` of a session a bg job holds and says so
 * only on stderr, which this app drops — so before this, the user typed a message and got
 * `Resident process exited (error)` back. A disabled textarea alone would not be a state: a form can be
 * submitted from a script, a stale handler, or a queued voice transcript. The send entry is therefore
 * asserted directly, in the two arms that need each other — refused while held, and *sent* once released.
 * Without the second arm the first one would also pass against a composer that never sends anything.
 *
 * THE STORE IS THE REAL ONE. Unlike its siblings in this directory, this file does NOT mock
 * `@/shared/hooks/useSessionHosts`. The whole second half of the AC is about the listing being re-read —
 * "no reload, no remount, the next update restores" — and a mocked snapshot source would make that half
 * unmeasurable: the test would be swapping a fixture variable, not watching the real store pick up a new
 * answer. So the real module-level store is driven through a stubbed global `fetch` that answers
 * `/api/session-hosts` from a listing this file mutates, and the release is delivered the way the browser
 * delivers one now: an announced change (`invalidateSessionHosts`, the signal the websocket bridge passes
 * on) folded into the store's short coalescing beat. Every request the store makes is counted, so "the
 * store really re-read the listing" is read rather than assumed.
 *
 * WHAT IS COMPOSED HERE, AND WHAT IS NOT. `ChatInterface` is not rendered: it wants websocket, session
 * protection and task-settings providers, and none of them is part of this claim. The harness below wires
 * the same two components `ChatInterface` wires — the real `ChatComposer` and the real `ResidentStatusBar`,
 * both reading the real store — from the real `useChatComposerState`, and renders one real
 * `MessageComponent` row as the transcript that must survive the state. Every reading in the AC is taken
 * off a shipped component; only the wiring is this file's.
 *
 * WHAT THIS FILE DOES NOT CLAIM. That the server computes `occupiedBy` correctly — that is
 * `server/modules/session-hosts/tests/session-hosts-routes.test.ts` and
 * `server/modules/providers/tests/claude-session-occupancy.test.ts`. Here the listing is given to the
 * frontend, never derived by it.
 *
 * Run: npx vitest run src/modules/chat/tests/occupiedSessionReadOnly.test.tsx
 */

import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import type { TFunction } from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ResidentStatusBar from '@/modules/chat/transcript/ResidentStatusBar';
import deChat from '@/modules/i18n/locales/de/chat.json';
import enChat from '@/modules/i18n/locales/en/chat.json';
import esChat from '@/modules/i18n/locales/es/chat.json';
import frChat from '@/modules/i18n/locales/fr/chat.json';
import idChat from '@/modules/i18n/locales/id/chat.json';
import itChat from '@/modules/i18n/locales/it/chat.json';
import jaChat from '@/modules/i18n/locales/ja/chat.json';
import koChat from '@/modules/i18n/locales/ko/chat.json';
import ruChat from '@/modules/i18n/locales/ru/chat.json';
import trChat from '@/modules/i18n/locales/tr/chat.json';
import zhCNChat from '@/modules/i18n/locales/zh-CN/chat.json';
import zhTWChat from '@/modules/i18n/locales/zh-TW/chat.json';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { invalidateSessionHosts } from '@/shared/hooks/useSessionHosts';
import type { ChatMessage, LLMProvider, Project, ProjectSession, SessionHostsSnapshot } from '@/shared/types';

/* ─── The fixture the listing is built from ──────────────────────────────── */

const SESSION_ID = 'session-held-by-a-bg-job';
const JOB_ID = '04fda72d';
const HOLDER_PID = 5150;
/** The message the user is trying to send while the job holds the conversation. */
const DRAFT = 'please continue';

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: SESSION_ID };

const USER_MESSAGE = {
  id: 'msg-1',
  type: 'user',
  content: 'what does the failing test say?',
  timestamp: new Date('2026-01-01T00:00:00.000Z'),
} as unknown as ChatMessage;

/**
 * The listing as the route publishes it: one resident session, nothing running, and a holder stated.
 *
 * `lifecycleMode: 'resident'` is what puts the status bar on screen at all — the bar's subject is a
 * process nobody has started, and the [Start] control the AC wants hidden is only ever drawn for one of
 * those.
 */
const occupiedListing = (): SessionHostsSnapshot => ({
  hosts: [],
  sessions: [
    {
      appSessionId: SESSION_ID,
      provider: 'claude',
      lifecycleMode: 'resident',
      running: false,
      reason: 'no-live-host',
      occupiedBy: { jobId: JOB_ID, pid: HOLDER_PID },
    },
  ],
}) as unknown as SessionHostsSnapshot;

/** The same listing after `claude stop <jobId>`: the holder is gone and the session is free again. */
const releasedListing = (): SessionHostsSnapshot => ({
  hosts: [],
  sessions: [
    {
      appSessionId: SESSION_ID,
      provider: 'claude',
      lifecycleMode: 'resident',
      running: false,
      reason: 'no-live-host',
      occupiedBy: null,
    },
  ],
}) as unknown as SessionHostsSnapshot;

/* ─── The i18n instance the composer reads ───────────────────────────────── */

/**
 * One real i18next instance over the shipped locales, with `fallbackLng` off.
 *
 * Off on purpose: with a fallback language left on, a locale that had lost the new keys would render
 * English and the notice assertions below would hold over a locale that has no copy at all. The
 * coverage reading (`AC7`) goes further and reads the shipped files as data, so the two halves fail
 * independently — a key that exists but is empty reds here, a key that is missing reds there.
 */
const LOCALES: Record<string, { chat: unknown }> = {
  de: { chat: deChat },
  en: { chat: enChat },
  es: { chat: esChat },
  fr: { chat: frChat },
  id: { chat: idChat },
  it: { chat: itChat },
  ja: { chat: jaChat },
  ko: { chat: koChat },
  ru: { chat: ruChat },
  tr: { chat: trChat },
  'zh-CN': { chat: zhCNChat },
  'zh-TW': { chat: zhTWChat },
};

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  // The shipped locale JSON is `unknown`-valued to the compiler; i18next wants its own `Resource`
  // shape. The values are the files themselves, read as data by AC7 below.
  resources: LOCALES as unknown as Record<string, Record<string, string>>,
  interpolation: { escapeValue: false },
});

/* ─── Module doubles: nothing here is the thing under test ───────────────── */

// The resident-capability matrix is a network read, and this criterion is about what happens *after* the
// capability is known. `claude` is the shipping resident-capable provider, so declaring it keeps the
// composer's switch drawn and its answer irrelevant to every reading below.
vi.mock('@/shared/hooks/useProviderCapabilities', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useResidentProviders: () => new Set<LLMProvider>(['claude']) };
});

vi.mock('@/shared/selectedProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readSelectedProvider: () => 'claude' as const };
});

// The voice chain is a recorder, a debug gate and a trim switch this criterion has no reading on; a plain
// install keeps the mic button the composer always draws from reaching for any of them. Same doubles as
// the composer's sibling criteria.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default: keeps this whole-module replacement complete.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
}));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    toggle: () => undefined,
    stop: () => undefined,
    transcribeFile: () => undefined,
    clipSlot: null,
    clipPlayState: { original: 'idle', trimmed: 'idle' },
    toggleClipPlayback: () => undefined,
  }),
}));

/* ─── The stubbed transport ──────────────────────────────────────────────── */

/**
 * What the next `/api/session-hosts` poll answers with, and what the client actually did.
 *
 * `listing` is assigned between phases; `listingRequests` counts only the listing reads, so the composer's
 * own incidental traffic (drafts, commands, capabilities) cannot make the re-read evidence noisy.
 */
const harness = {
  listing: null as SessionHostsSnapshot | null,
  listingRequests: 0,
  sent: [] as Array<Record<string, unknown>>,
  clipboard: [] as string[],
};

/** The shape `authenticatedFetch` reads off a response: `ok`/`status`/`json` and two header reads. */
const respond = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
});

beforeEach(() => {
  harness.listing = null;
  harness.listingRequests = 0;
  harness.sent = [];
  harness.clipboard = [];
  resetChatDrafts();
  localStorage.clear();
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { harness.clipboard.push(text); } },
  });
  // One dispatcher for every module the client talks to: the listing is what this file scripts, and
  // everything else gets a benign empty answer so the composer's own background reads cannot throw and
  // become the thing being observed.
  vi.stubGlobal('fetch', async (url: unknown) => {
    const target = String(url);
    // The path, not the whole URL: the store asks for `?scope=active`, and this file is about what
    // the listing answers, not about how the question is spelled.
    if (target.split('?')[0].endsWith('/api/session-hosts')) {
      harness.listingRequests += 1;
      return respond({ success: true, data: harness.listing });
    }
    // The file tree answers with a bare array; the mention repair flattens it, so a `{ data: … }`
    // envelope there is a shape error the composer would log on every render.
    if (target.includes('/api/file-tree/')) {
      return respond([]);
    }
    return respond({ success: true, data: { drafts: [] } });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ─── The harness ────────────────────────────────────────────────────────── */

/**
 * The three shipped pieces, wired the way `ChatInterface` wires them, over the real store.
 *
 * `onComposerState` hands the hook's result out so the test can call `handleSubmit` directly — the send
 * entry the AC insists must refuse on its own, rather than only being blocked by a disabled control.
 */
function HeldSessionView({
  onComposerState,
}: {
  onComposerState: (state: ReturnType<typeof useChatComposerState>) => void;
}) {
  const composerState = useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION_ID,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default',
    currentProviderModel: 'claude-sonnet-4-5-20250929',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message) => { harness.sent.push(message as Record<string, unknown>); },
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  });
  onComposerState(composerState);

  return (
    <div>
      {/* The conversation itself. A read-only state that hid the transcript would be a different feature,
          so the row is rendered and read. */}
      <MessageComponent
        message={USER_MESSAGE}
        prevMessage={null}
        createDiff={() => []}
        provider="claude"
      />
      <ResidentStatusBar sessionId={SESSION_ID} t={i18next.getFixedT(null, 'chat') as TFunction} />
      <ChatComposer
        pendingPermissionRequests={[]}
        handlePermissionDecision={composerState.handlePermissionDecision}
        handleGrantToolPermission={composerState.handleGrantToolPermission}
        activity={null}
        isLoading={false}
        onAbortSession={composerState.handleAbortSession}
        permissionMode="default"
        availablePermissionModes={['default']}
        onSelectPermissionMode={() => undefined}
        providerLabel="Claude"
        effort="medium"
        availableEffortOptions={[{ value: 'low' }, { value: 'medium' }, { value: 'high' }]}
        onSelectEffort={() => undefined}
        model="claude-sonnet-4-5-20250929"
        availableModelOptions={[{ value: 'claude-sonnet-4-5-20250929', label: 'claude-sonnet-4-5-20250929' }]}
        onSelectModel={() => undefined}
        modelsLoading={false}
        tokenBudget={null}
        onShowTokenUsage={composerState.showCostModal}
        slashCommandsCount={composerState.slashCommandsCount}
        onToggleCommandMenu={composerState.handleToggleCommandMenu}
        hasInput={Boolean(composerState.input.trim())}
        onClearInput={composerState.handleClearInput}
        onSubmit={composerState.handleSubmit}
        isDragActive={composerState.isDragActive}
        queuedDraft={composerState.queuedDraft}
        isEditingSentMessage={Boolean(composerState.editingAnchorId)}
        onCancelEditMessage={composerState.cancelEditMessage}
        scheduledMessages={[]}
        onScheduleMessage={() => undefined}
        onCancelScheduledMessage={() => undefined}
        onEditQueuedDraft={composerState.editQueuedDraft}
        onDeleteQueuedDraft={composerState.deleteQueuedDraft}
        attachedFiles={composerState.attachedFiles}
        onRemoveAttachment={() => undefined}
        fileErrors={composerState.fileErrors}
        showFileDropdown={composerState.showFileDropdown}
        filteredFiles={composerState.filteredFiles}
        selectedFileIndex={composerState.selectedFileIndex}
        onSelectFile={composerState.selectFile}
        filteredCommands={composerState.filteredCommands}
        selectedCommandIndex={composerState.selectedCommandIndex}
        onCommandSelect={composerState.handleCommandSelect}
        onCloseCommandMenu={composerState.resetCommandMenuState}
        isCommandMenuOpen={composerState.showCommandMenu}
        frequentCommands={composerState.frequentCommands}
        getRootProps={composerState.getRootProps as (...args: unknown[]) => Record<string, unknown>}
        getInputProps={composerState.getInputProps as (...args: unknown[]) => Record<string, unknown>}
        openAttachmentPicker={composerState.openAttachmentPicker}
        inputHighlightRef={composerState.inputHighlightRef}
        renderInputWithMentions={composerState.renderInputWithMentions}
        textareaRef={composerState.textareaRef}
        input={composerState.input}
        onVoiceTranscript={composerState.handleVoiceTranscript}
        scope={composerState.draftScope}
        sessionId={SESSION_ID}
        projectId={PROJECT.projectId}
        isActive
        onInputChange={composerState.handleInputChange}
        onTextareaClick={composerState.handleTextareaClick}
        onTextareaKeyDown={composerState.handleKeyDown}
        onTextareaPaste={composerState.handlePaste}
        onTextareaScrollSync={composerState.syncInputOverlayScroll}
        onTextareaInput={composerState.handleTextareaInput}
        onInputFocusChange={composerState.handleInputFocusChange}
        placeholder="Ask anything"
        isTextareaExpanded={composerState.isTextareaExpanded}
      />
    </div>
  );
}

/* ─── Readings off the mounted tree ──────────────────────────────────────── */

/** The composer's one textarea — the control the read-only state disables. */
const textarea = (container: HTMLElement) => container.querySelector('textarea') as HTMLTextAreaElement;

const occupiedNotice = (container: HTMLElement) =>
  container.querySelector('[data-slot="occupied-session-notice"]');

const startControl = (container: HTMLElement) => container.querySelector('[data-resident-start]');

/** Lets the store's first read and its effects land, without touching the clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * How far past an announcement the store's coalescing window is allowed to run.
 *
 * Longer than the store's own coalescing beat (250ms), and far shorter than the
 * shortest fallback interval (2s with the websocket down) — so a re-read below can
 * only have come from the announcement, never from a timer.
 */
const COALESCE_BEAT_MS = 300;

/** Delivers a listing change the way the websocket bridge does, and drains the re-read. */
async function announceListingChange(): Promise<void> {
  await act(async () => {
    invalidateSessionHosts();
    await vi.advanceTimersByTimeAsync(COALESCE_BEAT_MS);
  });
}

/* ─── AC5: the read-only state, and its release ──────────────────────────── */

test('AC5: a held session is read-only, and the next listing update after the release restores it in place', async () => {
  harness.listing = occupiedListing();

  // The hook returns a fresh object every render — a `handleSubmit` captured once would be the
  // closure of the render that first held it. The harness therefore writes each render's result into
  // this holder, and `composer()` reads the newest one, the same way a keydown handler in the shipped
  // app always reaches the latest `handleSubmit`.
  const latest: { current: ReturnType<typeof useChatComposerState> | null } = { current: null };
  const { container } = render(
    React.createElement(HeldSessionView, {
      onComposerState: (state: ReturnType<typeof useChatComposerState>) => { latest.current = state; },
    }),
  );
  await flush();

  const composer = (): ReturnType<typeof useChatComposerState> => {
    assert.ok(latest.current, 'the harness must have handed out the composer state, or nothing is readable');
    return latest.current;
  };

  /* ── Phase 1: held ── */

  assert.ok(
    harness.listingRequests >= 1,
    'the real store must have read the listing, or the reading below is of a fixture, not a store read',
  );

  assert.equal(
    textarea(container).disabled,
    true,
    'the input a held conversation cannot accept is disabled — the state is visible before anything is typed',
  );

  const notice = occupiedNotice(container);
  assert.ok(notice, 'and the reason is on screen, not only implied by a disabled box');
  assert.equal(
    notice.getAttribute('data-occupied-job-id'),
    JOB_ID,
    'the notice names the job that holds the session, structurally as well as in its sentence',
  );
  assert.equal(
    notice.getAttribute('data-occupied-pid'),
    String(HOLDER_PID),
    'and its pid, so a reader can match it against the process it is talking about',
  );
  const noticeText = notice.querySelector('[data-occupied-notice-text]')?.textContent ?? '';
  assert.ok(noticeText.includes(JOB_ID), `the sentence must name the job id; got: ${noticeText}`);
  assert.ok(
    noticeText.includes(`claude stop ${JOB_ID}`),
    `and the one command that releases it; got: ${noticeText}`,
  );

  assert.ok(
    startControl(container) === null,
    'the status bar offers nothing to start: a launch for a held session can only be refused',
  );

  assert.ok(
    container.querySelector('.chat-message'),
    'the transcript is still drawn — read-only is about sending, not about hiding the conversation',
  );

  await act(async () => {
    fireEvent.click(notice.querySelector('[data-occupied-copy-command]') as HTMLElement);
  });
  assert.deepEqual(
    harness.clipboard,
    [`claude stop ${JOB_ID}`],
    'the copy control writes the release command verbatim, with nothing around it',
  );

  // The send entry itself. Reached the way the keydown reaches it — the composer's own `handleSubmit`,
  // with a real draft in the box, so an empty-input early return cannot be mistaken for the refusal.
  await act(async () => {
    composer().setInput(DRAFT);
  });
  assert.equal(
    textarea(container).value,
    DRAFT,
    'the draft is really in the box, so the refusal below cannot be an empty-input early return',
  );
  await act(async () => {
    await composer().handleSubmit({ preventDefault: () => undefined } as never);
  });
  assert.deepEqual(
    // Copied first: `deepEqual` against `[]` narrows its left operand to `never[]`, and the
    // assertions after the release read the real array's elements.
    harness.sent.slice(),
    [],
    'a held session emits no frame at all — a disabled textarea is a hint, not an enforcement',
  );

  /* ── Phase 2: released, and picked up by the next announced update ── */

  const nodeBeforeRelease = textarea(container);
  harness.listing = releasedListing();
  const requestsBeforeRelease = harness.listingRequests;
  await announceListingChange();

  assert.ok(
    harness.listingRequests > requestsBeforeRelease,
    'the announced change really re-read the listing — without this the restore below could be a local default',
  );
  // `assert.ok(x === y)` rather than `assert.equal(x, y)` for every assertion whose operands are DOM
  // nodes: a failing `assert.equal` hands the node to the reporter as `actual`, and serializing a
  // React-rendered element walks its fiber tree — the mutation run does not fail, it grows to tens of
  // gigabytes and hangs. The boolean form asserts the identical thing and fails with the sentence
  // below, which is what AC6 needs to read.
  assert.ok(
    textarea(container) === nodeBeforeRelease,
    'the restore happens in the same mounted tree: the very node that was disabled is the one that came back',
  );
  assert.equal(
    textarea(container).disabled,
    false,
    'the input is usable again as soon as the holder is gone, with no reload',
  );
  assert.ok(
    occupiedNotice(container) === null,
    'and the notice goes with the state it describes',
  );
  assert.ok(
    startControl(container),
    'the status bar offers [Start] again — the control the refusal had hidden',
  );

  // The positive control: the same direct submit that was refused a moment ago now goes out. Without
  // this arm, phase 1 would also pass against a composer that could never send anything.
  assert.equal(textarea(container).value, DRAFT, 'the draft survived the release untouched');
  await act(async () => {
    await composer().handleSubmit({ preventDefault: () => undefined } as never);
  });
  assert.equal(harness.sent.length, 1, 'the released session accepts the very message that was refused');
  const frame = harness.sent[0];
  assert.equal(frame.type, 'chat.send', 'and it is an ordinary send frame');
  assert.equal(frame.sessionId, SESSION_ID, 'addressed to the session that was held');
  assert.equal(frame.content, DRAFT, 'carrying the draft that was waiting');
});

/* ─── AC7: the new copy exists, in every shipped language ────────────────── */

test('AC7: the three new strings are present and non-empty in all twelve shipped locales', () => {
  const names = Object.keys(LOCALES);
  const missing: string[] = [];
  let checked = 0;

  for (const name of names) {
    const resident = (LOCALES[name].chat as { resident?: Record<string, unknown> }).resident as
      | Record<string, unknown>
      | undefined;
    const occupied = resident?.occupied as Record<string, unknown> | undefined;
    for (const key of ['notice', 'copyCommand', 'copied']) {
      checked += 1;
      const value = occupied?.[key];
      if (typeof value !== 'string' || value.trim() === '') {
        missing.push(`${name}:${key}`);
      }
    }
  }

  console.log(`occupied-read-only i18n locales=${names.length} checked=${checked} missing=${missing.length}`);
  assert.equal(checked, names.length * 3, 'the reading must cover every locale and every new key');
  assert.deepEqual(missing, [], 'every shipped language must be able to say what is happening');
});
