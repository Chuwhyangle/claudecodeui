import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetChatDrafts } from '@/shared/chatDrafts';
import { resetUserPreferences } from '@/shared/userSettings';
import type { Project, ProjectSession } from '@/shared/types';

/**
 * The permission mode used to live in two localStorage keys, one per session
 * (`permissionMode-<sessionId>`) and one per provider for the "default mode of a
 * new chat" preference (`permissionMode-last-<provider>`). Both are gone: the
 * mode is a session attribute the server records when a message actually
 * carries it, and switching the mode in the composer is not a write of any
 * kind. These tests drive the real hooks, so what they pin is the behaviour the
 * composer has, not a description of it.
 *
 * The two halves of the rule are covered here: what an open session shows, and
 * what a brand-new chat does with a pick that has nothing to attach to yet.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

/**
 * The capability matrix, stubbed rather than fetched.
 *
 * `defaultPermissionMode` is deliberately *not* the first entry: with the real
 * claude matrix both are `default`, so a test written against it could not tell
 * "fell back to the provider default" apart from "kept the initial state".
 */
const CAPABILITIES = {
  providers: [
    {
      provider: 'claude',
      permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
      defaultPermissionMode: 'acceptEdits',
      supportsMessageEditing: true,
      supportsSessionForking: true,
      supportsEffort: false,
    },
  ],
};

const state = vi.hoisted(() => ({
  /** Every request the client makes, so "nothing was written" is checkable. */
  calls: [] as string[],
  activeModel: { success: true, data: null } as unknown,
  createdSessionId: 'server-minted-session',
  sent: [] as Array<Record<string, unknown>>,
}));

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
      drafts: () => okJson({ success: true, drafts: [] }),
      saveDraft: () => okJson({ success: true }),
      deleteDraft: () => okJson({ success: true }),
    },
    commands: {
      list: () => okJson({ success: true, builtIn: [], custom: [], commands: [] }),
      execute: () => okJson({ success: true }),
    },
    files: { search: () => okJson({ success: true, files: [] }) },
    getFileIndex: () => okJson({ files: [], truncated: false }),
    assets: { uploadFiles: () => okJson({ success: true, attachments: [] }) },
    providers: {
      skills: () => okJson({ success: true, data: { skills: [] } }),
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: CAPABILITIES }),
      sessionActiveModel: (provider: string, sessionId: string) => {
        state.calls.push(`read:${provider}:${sessionId}`);
        return okJson(state.activeModel);
      },
      setSessionActiveModel: () => {
        state.calls.push('write:model');
        return okJson({ success: true, data: null });
      },
      setSessionActiveEffort: () => {
        state.calls.push('write:effort');
        return okJson({ success: true, data: null });
      },
      createSession: () => {
        state.calls.push('create:session');
        return okJson({
          success: true,
          data: { sessionId: state.createdSessionId, sessionName: 'brand new chat' },
        });
      },
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async (session: ProjectSession | null) => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: session, selectedProject: PROJECT }),
  );
};

/**
 * The two hooks wired the way `ChatInterface` wires them, which is the only
 * place the whole rule is visible: the provider hook decides which mode the
 * composer holds, and the composer is what puts it on the wire.
 */
const renderWiredChat = async (session: ProjectSession | null) => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  const { useChatComposerState } = await import(
    '@/modules/chat/hooks/useChatComposerState'
  );

  return renderHook(({ selectedSession }: { selectedSession: ProjectSession | null }) => {
    const providerState = useChatProviderState({
      selectedSession,
      selectedProject: PROJECT,
    });
    const composerState = useChatComposerState({
      selectedProject: PROJECT,
      selectedSession,
      currentSessionId: selectedSession?.id ?? null,
      provider: providerState.provider,
      permissionMode: providerState.permissionMode,
      cyclePermissionMode: providerState.cyclePermissionMode,
      resolvePermissionModeForProvider: providerState.resolvePermissionModeForProvider,
      currentProviderModel: providerState.currentProviderModel,
      currentProviderEffort: providerState.currentProviderEffort,
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message: unknown) => {
        state.sent.push(message as Record<string, unknown>);
      },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: providerState.setPendingPermissionRequests,
    });
    return { providerState, composerState };
  }, { initialProps: { selectedSession: session } });
};

const legacyPermissionModeKeys = () => Object.keys(localStorage)
  .filter((key) => key.startsWith('permissionMode-'));

beforeEach(() => {
  localStorage.clear();
  // Two module-level singletons outlive localStorage.clear(), so one test's
  // writes would otherwise leak into the next.
  resetUserPreferences();
  resetChatDrafts();
  state.calls = [];
  state.sent = [];
  state.activeModel = { success: true, data: null };
});

afterEach(() => {
  vi.resetModules();
});

test('已有会话显示服务端记录的权限模式，而不是本机遗留的值', async () => {
  // A leftover local value for this very session: it must not be preferred
  // over what the server says, and it must not survive the mount either.
  localStorage.setItem('permissionMode-session-1', 'bypassPermissions');
  localStorage.setItem('permissionMode-last-claude', 'plan');
  state.activeModel = {
    success: true,
    data: { model: 'claude-opus-5', effort: null, permissionMode: 'plan', source: 'session' },
  };

  const { result } = await renderProviderState(SESSION);

  await waitFor(() => {
    assert.equal(result.current.permissionMode, 'plan');
  });
  assert.deepEqual(
    legacyPermissionModeKeys(),
    [],
    'the legacy keys are removed rather than migrated, so nothing local can answer for a session',
  );
});

test('服务端未记录（null）时回落 provider 默认模式', async () => {
  state.activeModel = {
    success: true,
    data: { model: 'claude-opus-5', effort: null, permissionMode: null, source: 'session' },
  };

  const { result } = await renderProviderState(SESSION);

  // `null` is not a mode: it means "this session never sent one", which is
  // answered with the provider's own default.
  await waitFor(() => {
    assert.equal(result.current.permissionMode, 'acceptEdits');
  });
});

test('切换模式：不触发任何写请求，也不触碰 localStorage', async () => {
  state.activeModel = {
    success: true,
    data: { model: 'claude-opus-5', effort: null, permissionMode: 'plan', source: 'session' },
  };

  const { result } = await renderProviderState(SESSION);
  await waitFor(() => {
    assert.equal(result.current.permissionMode, 'plan');
  });

  const callsBeforeSwitch = state.calls.length;
  await act(async () => {
    result.current.selectPermissionMode('bypassPermissions');
  });

  // The pick is visible immediately, and it went nowhere: the mode becomes a
  // session attribute when a message carries it, not when the menu is used.
  assert.equal(result.current.permissionMode, 'bypassPermissions');
  assert.deepEqual(state.calls.slice(callsBeforeSwitch), []);
  assert.deepEqual(legacyPermissionModeKeys(), []);
  assert.equal(localStorage.getItem('permissionMode-session-1'), null);
  assert.equal(localStorage.getItem('permissionMode-last-claude'), null);
});

test('全新聊天：模式只留在内存，并随首条消息发出', async () => {
  const { result } = await renderWiredChat(null);

  // The composer opens on the provider default — there is no stored "last mode"
  // to inherit, which is the preference this task deliberately drops.
  await waitFor(() => {
    assert.equal(result.current.providerState.permissionMode, 'acceptEdits');
  });

  await act(async () => {
    result.current.providerState.selectPermissionMode('bypassPermissions');
  });
  assert.equal(result.current.providerState.permissionMode, 'bypassPermissions');

  await act(async () => {
    result.current.composerState.setInput('brand new chat');
  });
  await act(async () => {
    await result.current.composerState.handleSubmit(
      { preventDefault: () => undefined } as never,
    );
  });

  assert.equal(state.sent.length, 1, 'the first message went out');
  const frame = state.sent[0];
  assert.equal(frame.type, 'chat.send');
  assert.equal(frame.sessionId, state.createdSessionId);
  assert.deepEqual(
    (frame.options as Record<string, unknown>)?.permissionMode,
    'bypassPermissions',
    'the composer\'s pick rides the first message to the server, which is what records it',
  );
  assert.deepEqual(
    legacyPermissionModeKeys(),
    [],
    'nothing about a new chat\'s pick is written to storage',
  );
});
