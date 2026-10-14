import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * The composer's first send states the selection ON THE GATEWAY CALL, not only on the frame.
 *
 * THE CLAIM. `POST /api/providers/sessions` mints the row; a `chat.send` carries the model
 * as a per-message option and the row is written from it as a side effect. A session whose
 * first turn is not a composer send therefore had no recorded model — the Live Voice relay
 * delivers its first utterance through `session_send`, which has no such option — and the
 * Claude runtime launched it with `--model default` (measured 2026-10-15: the page showed
 * `v4.1flash`, the child ran the host account's default with no ANTHROPIC_* env at all).
 *
 * WHAT THIS PINS. The composer already holds the selection it is about to send; the gateway
 * call it makes in the same breath has to carry it, so the row is correct before any run
 * exists — whatever entry ends up opening the first turn.
 *
 * THE FIRST ASSERTION IS THE FALSIFYING ONE: before the fix the create payload was
 * `{provider, projectPath, initialMessage}`, so `payload.model` was `undefined`.
 */

const PROJECT: Project = {
  projectId: 'project-selection',
  displayName: 'Project Selection',
  fullPath: '/tmp/project-selection',
};

const CREATED_SESSION_ID = 'server-minted-selection-session';
const MODEL = 'v4.1flash';
const EFFORT = 'high';

const state = vi.hoisted(() => ({
  createSessionPayloads: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      providers: {
        createSession: (payload: Record<string, unknown>) => {
          state.createSessionPayloads.push(payload);
          return okJson({
            success: true,
            data: { sessionId: CREATED_SESSION_ID, sessionName: 'selection chat' },
          });
        },
        setSessionLifecycleMode: () => okJson({ success: true }),
      },
    },
  };
});

const renderComposer = () => renderHook(() => useChatComposerState({
  selectedProject: PROJECT,
  selectedSession: null,
  currentSessionId: null,
  provider: 'claude',
  permissionMode: 'acceptEdits',
  cyclePermissionMode: () => undefined,
  resolvePermissionModeForProvider: () => 'acceptEdits' as PermissionMode,
  currentProviderModel: MODEL,
  currentProviderEffort: EFFORT,
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: () => undefined,
  isConnected: true,
  scrollToBottom: () => undefined,
  addMessage: () => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
}));

beforeEach(() => {
  resetChatDrafts();
  state.createSessionPayloads = [];
});

test('the first send of a brand-new conversation states its selection on the gateway call', async () => {
  const view = renderComposer();

  await act(async () => {
    view.result.current.setInput('first message');
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  await waitFor(() => {
    assert.equal(
      state.createSessionPayloads.length,
      1,
      `the first send must allocate exactly one session through the gateway; it made ${state.createSessionPayloads.length} call(s)`,
    );
  });

  // The falsifying assertion, first: the pre-fix payload carried provider, projectPath and
  // initialMessage only, so `model` was undefined and the minted row had no selection.
  assert.equal(
    state.createSessionPayloads[0].model,
    MODEL,
    `the gateway call that mints the row must carry the model the composer is about to send; payload=${JSON.stringify(state.createSessionPayloads[0])}`,
  );
  assert.equal(state.createSessionPayloads[0].effort, EFFORT);
  assert.equal(state.createSessionPayloads[0].permissionMode, 'acceptEdits');
});
