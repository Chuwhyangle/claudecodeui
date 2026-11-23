import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import { TokenUsageSummary, useChatComposerState } from '@/modules/chat-composer';
import { useChatSessionState } from '@/modules/chat-session';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { resetChatDrafts } from '@/shared/api/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';
import type { SessionStore } from '@/modules/chat-session';

/**
 * The token budget reaches the client on two channels, and they are not
 * interchangeable.
 *
 * A live `token_budget` frame describes the newest turn: it has no cumulative
 * spend, and the composer counter wants exactly that reading. `/cost` wants the
 * opposite — the provider's whole-session reading, fetched from
 * `/token-usage` — because a newest-turn occupancy shown as "Total tokens used"
 * is the bug this split exists to prevent (437K where the session had spent
 * 118.5M). So `useChatSessionState` keeps them in two states, `liveFrame` and
 * `authoritativeReading`; ChatComposer's counter is handed the frame, while the
 * composer hook (and therefore `/cost`) never accepts one at all.
 *
 * These cases pin that split at the two places it is decided — the state hook
 * and the composer hook's command payload — plus the one-line wiring in
 * ChatInterface that chooses which state goes where.
 */

const SESSION_ID = 'session-authoritative';

const PROJECT: Project = {
  projectId: 'project-authoritative',
  displayName: 'Project Authoritative',
  fullPath: '/tmp/project-authoritative',
};

const SESSION: ProjectSession = { id: SESSION_ID, name: 'Session one', provider: 'claude' } as ProjectSession;

/** The provider reader's answer: both scopes in one first-class reading. */
const AUTHORITATIVE = {
  used: 437_000,
  total: 917_000,
  sessionSpend: {
    inputTokens: 100_000_000,
    outputTokens: 18_500_000,
    totalTokens: 118_500_000,
  },
  contextOccupancy: { used: 437_000, total: 917_000 },
};

/** The realtime frame: the newest turn, and nothing about the session's spend. */
const LIVE_FRAME = { used: 512_000, total: 917_000 };

const apiMocks = vi.hoisted(() => ({
  sessionTokenUsage: vi.fn(),
  commandList: vi.fn(),
  commandExecute: vi.fn(),
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      replySuggestions: {
        status: () => okJson({ enabled: false, expansion: 'off', maxChips: 3, maxChipChars: 120 }),
        suggest: () => okJson({ chips: [], draw: 0 }),
        event: () => okJson({ ok: true }),
      },
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: apiMocks.commandList, execute: apiMocks.commandExecute },
      files: { search: () => okJson({ success: true, files: [] }) },
      providers: {
        // The authoritative source `/cost` has to read.
        sessionTokenUsage: apiMocks.sessionTokenUsage,
        createSession: () => okJson({ success: true, data: { sessionId: 'created-session', sessionName: 'created' } }),
        setSessionLifecycleMode: () => okJson({ success: true }),
        skills: () => okJson({ success: true, data: { skills: [] } }),
      },
    },
  };
});

vi.mock('@/modules/chat-support/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));

vi.mock('@/shared/voice/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  voiceDebugFlushSilenceSec: () => undefined,
}));

vi.mock('@/modules/chat-voice/hooks/useVoiceInput', () => ({
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

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** A store stub with just the async surface `useChatSessionState` reaches for. */
function sessionStoreStub() {
  const slot = { fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 };
  return {
    refreshLatestFromServer: vi.fn(async () => ({ slot, applied: true, changed: false, deferred: false })),
    fetchFromServer: vi.fn(async () => slot),
    fetchMore: vi.fn(async () => ({ slot, prependedCount: 0 })),
    appendRealtime: vi.fn(),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn(() => []),
    getSessionSlot: vi.fn(() => slot),
  } as unknown as SessionStore;
}

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  apiMocks.sessionTokenUsage
    .mockReset()
    .mockImplementation(async () => ({ ok: true, json: async () => ({ data: AUTHORITATIVE }) }));
  apiMocks.commandList
    .mockReset()
    .mockImplementation(async () => ({ ok: true, json: async () => ({ success: true, commands: [] }) }));
  apiMocks.commandExecute.mockReset().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ type: 'builtin', action: 'cost', data: { cost: {} } }),
  }));
});

test('the token budget splits into a live frame and an authoritative reading', async () => {
  const view = renderHook(() => useChatSessionState({
    isActive: false,
    selectedProject: PROJECT,
    selectedSession: SESSION,
    ws: null,
    sendMessage: () => undefined,
    resetStreamingState: () => undefined,
    statusCheckSentAtRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    sessionStore: sessionStoreStub(),
  }));

  // The provider's `/token-usage` answer lands on the authoritative channel
  // only: a reading of the whole session is never mistaken for a live frame.
  await waitFor(() => assert.deepEqual(view.result.current.authoritativeReading, AUTHORITATIVE));
  assert.equal(view.result.current.liveFrame, null, 'the history reading is not a live frame');

  // Two independent states: writing one leaves the other exactly as it was.
  // (The realtime handler's own adoption of frames is pinned next door, in
  // tokenBudgetSessionScope.test.tsx.)
  act(() => {
    view.result.current.setLiveFrame(LIVE_FRAME);
  });
  assert.deepEqual(view.result.current.liveFrame, LIVE_FRAME);
  assert.deepEqual(view.result.current.authoritativeReading, AUTHORITATIVE);

  act(() => {
    view.result.current.setAuthoritativeReading(null);
  });
  assert.equal(view.result.current.authoritativeReading, null);
  assert.deepEqual(view.result.current.liveFrame, LIVE_FRAME, 'clearing the reading keeps the frame');
});

test('/cost sends the authoritative reading, and the composer hook does not accept a live frame', async () => {
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION_ID,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'claude-sonnet-4-5',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    // The hook is handed the authoritative reading and nothing else: the live
    // frame is not part of its arguments, so it cannot leak into `/cost`.
    authoritativeReading: AUTHORITATIVE,
    sendMessage: () => undefined,
    isConnected: true,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));

  await act(async () => {
    view.result.current.showCostModal();
  });

  await waitFor(() => assert.equal(apiMocks.commandExecute.mock.calls.length, 1));
  const request = apiMocks.commandExecute.mock.calls[0][0] as {
    commandName: string;
    context: { tokenUsage?: unknown };
  };
  assert.equal(request.commandName, '/cost');
  assert.deepEqual(request.context.tokenUsage, AUTHORITATIVE);

  // The frame's newest-turn count (512K) is not the session's spend; the
  // payload names the reading's 118.5M instead.
  assert.notDeepEqual(request.context.tokenUsage, LIVE_FRAME);

  await waitFor(() => assert.equal(view.result.current.commandModalPayload?.kind, 'cost'));
});

test('the composer counter still renders the live frame', () => {
  const view = render(<TokenUsageSummary usage={LIVE_FRAME} />);
  const chip = view.getByRole('button');

  // The counter reads `used` off the frame it is given (512K), not the
  // authoritative reading's context occupancy (437K) or its 118.5M spend.
  assert.match(chip.textContent ?? '', /512K/);
  assert.doesNotMatch(chip.textContent ?? '', /437K/);
  assert.doesNotMatch(chip.textContent ?? '', /118\.5M|119M/);
});

test('ChatInterface prefers the live counter frame, falls back to the reading, and isolates /cost', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src', 'modules', 'chat', 'ChatInterface.tsx'),
    'utf8',
  );

  // c0fb922 deliberately added the authoritative fallback before a live frame
  // arrives. Once a frame exists it still takes priority for the counter, but
  // the merged reading carries the authoritative turn so the chip can show
  // "this turn" without the frame shadowing it.
  assert.match(source, /tokenBudget=\{tokenBudgetReading\}/);
  assert.match(source, /authoritativeReading\?\.turn/);

  // ...and the composer state is handed only the authoritative reading: the
  // live frame is not one of its arguments.
  const callStart = source.indexOf('useChatComposerState({');
  assert.notEqual(callStart, -1, 'ChatInterface still builds the composer state');
  const args = source.slice(callStart, source.indexOf('\n  });', callStart));
  assert.match(args, /authoritativeReading,/);
  assert.doesNotMatch(args, /tokenBudget:/);
});
