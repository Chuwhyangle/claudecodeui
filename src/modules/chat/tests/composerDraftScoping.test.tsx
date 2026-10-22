import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Drafts used to be keyed by project, so every session in a project shared one
 * draft and switching sessions carried the previous one's half-typed message
 * across. They are keyed by session now (and by project only for a chat that
 * has not been sent yet), which is what lets a draft be picked up on another
 * device against the session it belongs to.
 *
 * These tests drive the real hook, so the effect ordering that decides which
 * scope a keystroke lands in is exercised rather than described.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

// The composer only ever reaches the network through these; stubbing them keeps
// the test about draft scoping rather than about fetch behaviour in jsdom.
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
        createSession: () => okJson({
          success: true,
          data: { sessionId: 'created-session', sessionName: 'created' },
        }),
        // Resolves on a later task, so the composer re-renders onto the new session's scope
        // while the send is suspended here — the window the resident switch opens.
        setSessionLifecycleMode: () => new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, json: async () => ({ success: true }) }), 5);
        }),
      },
    },
  };
});

const renderComposer = (selectedSession: ProjectSession | null) => renderHook(
  ({ session }: { session: ProjectSession | null }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session?.id ?? null,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
  { initialProps: { session: selectedSession } },
);

beforeEach(() => {
  localStorage.clear();
  // The drafts store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's drafts into the next.
  resetChatDrafts();
});

test('a draft is stored under the open session, not the project', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });

  assert.equal(readDraftText('session-a'), 'for session A');
  assert.equal(readDraftText(`project:${PROJECT.projectId}`), '');
});

test('a chat with no session yet is stored under its project', async () => {
  const view = renderComposer(null);

  await act(async () => {
    view.result.current.setInput('not sent yet');
  });

  assert.equal(readDraftText(`project:${PROJECT.projectId}`), 'not sent yet');
});

test('switching sessions swaps the draft instead of carrying it across', async () => {
  writeDraftText('session-b', 'for session B');
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });

  await act(async () => {
    view.rerender({ session: { id: 'session-b' } });
  });

  assert.equal(view.result.current.input, 'for session B');
  assert.equal(
    readDraftText('session-a'),
    'for session A',
    "the previous session's draft must survive the switch",
  );
  assert.equal(
    readDraftText('session-b'),
    'for session B',
    "the new session's draft must not be overwritten by the previous one's text",
  );
});

test('switching back restores the draft that was left behind', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('for session A');
  });
  await act(async () => {
    view.rerender({ session: { id: 'session-b' } });
  });
  await act(async () => {
    view.rerender({ session: { id: 'session-a' } });
  });

  assert.equal(view.result.current.input, 'for session A');
});

test('a draft written on another device is picked up while the session is open', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    // Stands in for a hydrate delivering what was typed elsewhere.
    writeDraftText('session-a', 'typed on the phone');
  });

  assert.equal(view.result.current.input, 'typed on the phone');
});

test('an append from another surface is restored without dropping the half-typed text', async () => {
  // The architecture selection tray appends its composed context to this same
  // scope. The composer must restore the APPENDED draft (not only a wholesale
  // external rewrite), or the reader watching the chat loses the tray's text.
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('half-typed');
  });
  await act(async () => {
    writeDraftText('session-a', `${readDraftText('session-a')}\n\nabout these elements`);
  });

  assert.equal(view.result.current.input, 'half-typed\n\nabout these elements');
});

test('clearing the composer clears that session\'s stored draft', async () => {
  const view = renderComposer({ id: 'session-a' });

  await act(async () => {
    view.result.current.setInput('typed');
  });
  assert.equal(readDraftText('session-a'), 'typed');

  await act(async () => {
    view.result.current.setInput('');
  });

  assert.equal(readDraftText('session-a'), '');
});

/**
 * The send of a brand-new chat navigates to its session while it is still
 * running, and the resident switch adds an await (the lifecycle-mode write)
 * after that navigation. The scope the sent text is retired from has to be the
 * one it was typed in, whichever awaits the send path has in between.
 */
test('a first send with the resident switch on retires the project draft it was typed in', async () => {
  const projectScope = `project:${PROJECT.projectId}`;
  let listener: ((event: { kind: string; sessionId: string }) => void) | null = null;

  const view = renderHook(() => {
    const [session, setSession] = useState<ProjectSession | null>(null);
    return useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: session,
      currentSessionId: session?.id ?? null,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      // The switch is set for this brand-new session; the send path reads it directly rather than a
      // module-level one-shot, so the test drives it the way `ChatInterface` does.
      residentEnabled: true,
      clearResidentIntent: () => undefined,
      sendMessage: () => {
        // The server's first frame for the session is the delivery's answer.
        setTimeout(() => listener?.({ kind: 'status', sessionId: 'created-session' }), 0);
      },
      subscribe: (handler: (event: { kind: string; sessionId: string }) => void) => {
        listener = handler;
        return () => {
          listener = null;
        };
      },
      onSessionEstablished: (sessionId: string) => setSession({ id: sessionId }),
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    } as never);
  });

  await act(async () => {
    view.result.current.setInput('typed in a new chat');
  });
  assert.equal(readDraftText(projectScope), 'typed in a new chat');

  // Not wrapped in act on purpose: act holds every state update until its scope exits, so the
  // navigation to the new session would never re-render the composer while the send is suspended
  // on the lifecycle-mode write — which is exactly what a browser does and what this pins.
  await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  await waitFor(() => {
    assert.equal(readDraftText(projectScope), '');
  });

  assert.equal(
    readDraftText(projectScope),
    '',
    'the sent message must not stay behind as the project\'s draft for the next New Session',
  );
  assert.equal(readDraftText('created-session'), '', "the new session's box starts empty");
});
