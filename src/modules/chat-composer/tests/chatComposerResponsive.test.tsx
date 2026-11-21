import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { ChatComposer, useChatComposerState } from '@/modules/chat-composer';
import { resetChatDrafts } from '@/shared/api/chatDrafts';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';
import type { UseDraftRewriteResult } from '@/modules/chat-composer/hooks/useDraftRewrite';
import type { DraftRewriteRequest, DraftRewriteResponse } from '@/shared/replySuggestionsType';

/**
 * The draft rewrite inside the real composer state and the real composer shell.
 *
 * WHAT THIS PINS. Apply writes the current draft through the composer's one writer and nothing
 * else: an immediate Enter then sends the NEW text on the ordinary send path, while a send
 * without applying sends the ORIGINAL draft. Apply itself never sends. Clear, a successful send
 * and a session/scope switch empty the candidate cache. The textarea's caret and its existing
 * input/key/footer props are untouched.
 *
 * The last block renders `ChatComposer` at the three viewport tiers and reads the structure the
 * CSS lays out (the ✦ surface is inside the composer body, the footer and its send control are
 * still there), because jsdom performs no layout.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const DRAFT = '明天十点见吧，把文档带上';
const POLISHED = '明天十点见，请把文档带上。';

/** The rewrite transport, replaced per case. */
const transport = vi.hoisted(() => ({
  calls: [] as unknown[],
  impl: async (_request: unknown): Promise<unknown> => ({ ok: true, result: { rewrittenText: 'polished' } }),
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
        createSession: () => okJson({ success: true, data: { sessionId: 'created-session', sessionName: 'created' } }),
        setSessionLifecycleMode: () => okJson({ success: true }),
      },
      replySuggestions: {
        // The parsed composer reading, not a Response: this mock replaces the api feature
        // surface itself, which the reply-suggestions controller consumes directly.
        status: async () => ({
          enabled: true,
          state: 'ready' as const,
          problems: [],
          lastFailure: null,
          expansion: 'off' as const,
          maxChips: 3,
          maxChipChars: 120,
        }),
        suggest: async () => ({ ok: true as const, result: { chips: [], draw: 1 } }),
        event: async () => true,
        draftRewrite: (request: DraftRewriteRequest): Promise<DraftRewriteResponse> => {
          transport.calls.push(request);
          return transport.impl(request) as Promise<DraftRewriteResponse>;
        },
      },
    },
  };
});

vi.mock('@/modules/chat-support/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));
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

const SESSION: ProjectSession = { id: 'session-a' };

type ComposerArgs = Parameters<typeof useChatComposerState>[0];

function renderComposerState(overrides: Partial<ComposerArgs> = {}) {
  let listener: ((event: { kind: string; sessionId: string }) => void) | null = null;
  const sendMessage = vi.fn();
  const view = renderHook(
    ({ session }: { session: ProjectSession }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: session,
      currentSessionId: session.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      sendMessage,
      subscribe: (handler: (event: { kind: string; sessionId: string }) => void) => {
        listener = handler;
        return () => {
          listener = null;
        };
      },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
      ...overrides,
    }),
    { initialProps: { session: SESSION } },
  );
  return {
    ...view,
    sendMessage,
    deliver: (sessionId = 'session-a') => listener?.({ kind: 'status', sessionId }),
  };
}

/** Waits for the shared feature reading to enable the chip. */
async function waitForChip(view: ReturnType<typeof renderComposerState>) {
  await waitFor(() => {
    assert.equal(view.result.current.draftRewrite.available, true);
  });
}

async function requestCandidate(view: ReturnType<typeof renderComposerState>) {
  await act(async () => {
    view.result.current.draftRewrite.openOrRequest();
  });
  await waitFor(() => {
    assert.equal(view.result.current.draftRewrite.candidate, POLISHED);
  });
}

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  transport.calls = [];
  transport.impl = async () => ({ ok: true, result: { rewrittenText: POLISHED } });
});

afterEach(() => {
  cleanup();
});

beforeEach(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { chat: enChat } },
      interpolation: { escapeValue: false },
    });
  }
});

describe('draft rewrite in the composer state', () => {
  it('apply writes the candidate through the one writer and does not send', async () => {
    const view = renderComposerState();
    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await requestCandidate(view);

    await act(async () => view.result.current.draftRewrite.apply());
    assert.equal(view.result.current.input, POLISHED);
    assert.equal(view.sendMessage.mock.calls.length, 0, 'apply never sends');
    assert.equal(view.result.current.draftRewrite.candidate, null);
    assert.equal(view.result.current.draftRewrite.expanded, false);
  });

  it('an immediate Enter after apply sends the new text on the ordinary send path', async () => {
    const view = renderComposerState();
    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await requestCandidate(view);
    await act(async () => view.result.current.draftRewrite.apply());

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
    assert.equal(view.sendMessage.mock.calls.length, 1);
    assert.equal((view.sendMessage.mock.calls[0][0] as { content: string }).content, POLISHED);
  });

  it('without apply, send delivers the original draft', async () => {
    const view = renderComposerState();
    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
    assert.equal(view.sendMessage.mock.calls.length, 1);
    assert.equal((view.sendMessage.mock.calls[0][0] as { content: string }).content, DRAFT);
    assert.equal(transport.calls.length, 0, 'a plain send does not ask for a rewrite');
  });

  it('apply keeps the same textarea node editable (it does not swap or disable the draft box)', async () => {
    const view = renderComposerState();
    // A real textarea for the writer's caret work.
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    (view.result.current.textareaRef as { current: HTMLTextAreaElement | null }).current = textarea;

    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await requestCandidate(view);
    await act(async () => view.result.current.draftRewrite.apply());

    assert.equal(view.result.current.textareaRef.current, textarea, 'the same node the composer binds');
    assert.equal(textarea.disabled, false);
    assert.equal(view.result.current.input, POLISHED);
    assert.equal(view.sendMessage.mock.calls.length, 0);
    textarea.remove();
  });

  it('clearing the composer empties the candidate cache', async () => {
    const view = renderComposerState();
    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await requestCandidate(view);

    await act(async () => view.result.current.handleClearInput());
    assert.equal(view.result.current.draftRewrite.candidate, null);

    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await act(async () => view.result.current.draftRewrite.openOrRequest());
    await waitFor(() => assert.equal(transport.calls.length, 2, 'the cleared cache asks again'));
  });

  it('a delivered send empties the candidate cache', async () => {
    const view = renderComposerState();
    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await requestCandidate(view);
    await act(async () => view.result.current.draftRewrite.apply());

    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
    await act(async () => view.deliver('session-a'));
    await waitFor(() => assert.equal(view.result.current.draftRewrite.candidate, null));

    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await act(async () => view.result.current.draftRewrite.openOrRequest());
    await waitFor(() => assert.equal(transport.calls.length, 2));
  });

  it('a session switch drops the candidate and the cache', async () => {
    const view = renderComposerState();
    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await requestCandidate(view);

    await act(async () => view.rerender({ session: { id: 'session-b' } }));
    assert.equal(view.result.current.draftRewrite.candidate, null);

    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await act(async () => view.result.current.draftRewrite.openOrRequest());
    await waitFor(() => assert.equal(transport.calls.length, 2));
  });

  it('a late answer after a session switch does not repopulate the candidate', async () => {
    let resolveTransport: ((response: DraftRewriteResponse) => void) | null = null;
    transport.impl = () => new Promise<DraftRewriteResponse>((resolve) => {
      resolveTransport = resolve;
    });
    const view = renderComposerState();
    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await act(async () => view.result.current.draftRewrite.openOrRequest());

    await act(async () => view.rerender({ session: { id: 'session-b' } }));
    await act(async () => {
      resolveTransport?.({ ok: true, result: { rewrittenText: POLISHED } });
    });
    assert.equal(view.result.current.draftRewrite.candidate, null);
    assert.equal(view.result.current.input, '', 'the new session draft is not overwritten');
  });

  it('a transport failure keeps the draft byte for byte', async () => {
    transport.impl = async () => ({ ok: false, failure: {
      at: '2026-01-01T00:00:00.000Z',
      code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
      category: 'http',
      httpStatus: 502,
      requestId: 'req-1',
      model: 'settings-model',
      message: 'safe message',
    } });
    const view = renderComposerState();
    await act(async () => view.result.current.setInput(DRAFT));
    await waitForChip(view);
    await act(async () => view.result.current.draftRewrite.openOrRequest());
    await waitFor(() => assert.equal(view.result.current.draftRewrite.failure?.category, 'http'));
    assert.equal(view.result.current.input, DRAFT);
  });
});

/* ── the composer shell at the three viewport tiers ───────────────────────── */

const FOOTER_SELECTOR = '[data-slot="prompt-input-footer"]';

function surface(overrides: Partial<UseDraftRewriteResult> = {}): UseDraftRewriteResult {
  return {
    available: true,
    expanded: false,
    loading: false,
    candidate: null,
    failure: null,
    openOrRequest: vi.fn(),
    collapse: vi.fn(),
    retry: vi.fn(),
    apply: vi.fn(),
    invalidate: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

const baseProps = () => ({
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: null,
  isLoading: false,
  onAbortSession: () => undefined,
  permissionMode: 'default',
  availablePermissionModes: ['default'],
  onSelectPermissionMode: () => undefined,
  providerLabel: 'Claude',
  effort: 'medium',
  availableEffortOptions: [{ value: 'medium' }],
  onSelectEffort: () => undefined,
  model: 'claude-sonnet-4-5-20250929',
  availableModelOptions: [{ value: 'claude-sonnet-4-5-20250929', label: 'claude-sonnet-4-5-20250929' }],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: vi.fn(),
  slashCommandsCount: 0,
  onToggleCommandMenu: vi.fn(),
  hasInput: true,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDraft: null,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: vi.fn(),
  onCancelScheduledMessage: () => undefined,
  onEditQueuedDraft: () => undefined,
  onDeleteQueuedDraft: () => undefined,
  attachedFiles: [],
  onRemoveAttachment: () => undefined,
  fileErrors: new Map<string, string>(),
  showFileDropdown: false,
  filteredFiles: [],
  selectedFileIndex: 0,
  onSelectFile: () => undefined,
  filteredCommands: [],
  selectedCommandIndex: 0,
  onCommandSelect: () => undefined,
  onCloseCommandMenu: () => undefined,
  isCommandMenuOpen: false,
  frequentCommands: [],
  getRootProps: () => ({}),
  getInputProps: () => ({}),
  openAttachmentPicker: () => undefined,
  inputHighlightRef: { current: null },
  renderInputWithMentions: () => null,
  textareaRef: { current: null },
  input: DRAFT,
  onVoiceTranscript: () => undefined,
  scope: 'session-a',
  projectId: null,
  isActive: true,
  onInputChange: vi.fn(),
  onTextareaClick: vi.fn(),
  onTextareaKeyDown: vi.fn(),
  onTextareaPaste: vi.fn(),
  onTextareaScrollSync: vi.fn(),
  onTextareaInput: vi.fn(),
  placeholder: 'Ask anything',
  isTextareaExpanded: false,
  draftRewrite: surface(),
});

describe('the ✦ surface in the composer shell', () => {
  for (const width of [320, 375, 1280]) {
    it(`sits inside the composer body with the footer and send control intact at ${width}px`, () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
      const props = baseProps() as unknown as React.ComponentProps<typeof ChatComposer>;
      const view = render(React.createElement(ChatComposer, props));

      const body = view.container.querySelector('[data-slot="prompt-input-body"]');
      const footer = view.container.querySelector(FOOTER_SELECTOR);
      const chip = view.container.querySelector('[data-slot="draft-rewrite-chip"]');
      assert.ok(body, `width ${width}: body`);
      assert.ok(footer, `width ${width}: footer still drawn`);
      assert.ok(chip, `width ${width}: chip drawn`);
      assert.ok(body.contains(chip), `width ${width}: chip is inside the same composer body`);
      assert.ok(footer.querySelectorAll('button').length > 0, `width ${width}: footer controls remain`);
      view.unmount();
    });
  }

  it('the textarea keeps its own input/key props when the surface is drawn', () => {
    const props = baseProps();
    const view = render(React.createElement(
      ChatComposer,
      props as unknown as React.ComponentProps<typeof ChatComposer>,
    ));
    const textarea = view.container.querySelector<HTMLTextAreaElement>('[data-slot="prompt-input-textarea"]');
    assert.ok(textarea);
    fireEvent.change(textarea, { target: { value: `${DRAFT}！` } });
    assert.equal((props.onInputChange as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    assert.equal((props.onTextareaKeyDown as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    assert.ok(!(textarea as HTMLTextAreaElement).disabled, 'the textarea is still the editable draft');
    view.unmount();
  });
});
