/**
 * Reply items at the surfaces a person actually uses: the labels drawn beside
 * the latest answer, the preview line above the input box, the transcript
 * highlight while the draft points at an item, and the unchanged message text.
 *
 * WHAT THIS PINS. Only the LAST assistant text reply carries labels — an older
 * answer keeps its plain prose — and each labelled item publishes the address
 * `cloudcli://session/<sessionId>/msg/<messageId>#item-<n>`. A draft that names
 * items draws the matching excerpts and highlights exactly those items; a draft
 * that names an item the reply does not have says so instead of guessing. The
 * message that leaves the composer is the draft itself: the preview is a
 * reading aid, never a transform.
 *
 * Run: npx vitest run src/modules/chat/tests/replyItemReferences.test.tsx
 */

import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, describe, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import enCommon from '@/modules/i18n/locales/en/common.json';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

const SESSION_ID = 'session-reply-items';
const PROJECT: Project = {
  projectId: 'project-reply-items',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};
const SESSION: ProjectSession = { id: SESSION_ID };

const OLD_REPLY = {
  type: 'assistant',
  id: 'msg-old',
  content: '1. 旧的第一点\n2. 旧的第二点',
  timestamp: '2026-10-24T10:00:00.000Z',
} as unknown as ChatMessage;

const USER_TURN = {
  type: 'user',
  id: 'msg-user',
  content: '再给一版',
  timestamp: '2026-10-24T10:00:01.000Z',
} as unknown as ChatMessage;

const LATEST_REPLY = {
  type: 'assistant',
  id: 'msg-latest',
  content: '1. 安装依赖\n2. 运行测试\n3. 修复失败项\n4. 提交变更',
  timestamp: '2026-10-24T10:00:02.000Z',
} as unknown as ChatMessage;

/** The transcript every case starts from; a case may swap in its own rows. */
const state = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  /** The draft the mocked composer hook was asked to send. */
  submitted: [] as string[],
}));

/* ─── Module doubles: only the server-facing edges are doubled ───────────── */

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
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

vi.mock('@/shared/hooks/useSessionHosts', () => ({
  useSessionHosts: () => ({ snapshot: { hosts: [], sessions: [] } }),
  findSessionHostState: () => null,
  findSessionOccupancy: () => null,
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    ...actual,
    api: {
      ...((actual.api ?? {}) as Record<string, unknown>),
      replySuggestions: {
        status: () => okJson({ enabled: false, expansion: 'off', maxChips: 3, maxChipChars: 120 }),
        suggest: () => okJson({ chips: [], draw: 0 }),
        event: () => Promise.resolve({ ok: true }),
      },
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
        skills: () => okJson({ success: true, data: { skills: [] } }),
      },
    },
  };
});

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
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
  useChatSessionState: () => {
    const messages = state.messages;
    return {
      chatMessages: messages,
      addMessage: () => undefined,
      markUserTurnUndelivered: () => undefined,
      restoreUserTurn: () => undefined,
      sessionActivity: null,
      isProcessing: false,
      canAbortSession: false,
      currentSessionId: SESSION_ID,
      setCurrentSessionId: () => undefined,
      isLoadingSessionMessages: false,
      isLoadingMoreMessages: false,
      hasMoreMessages: false,
      totalMessages: messages.length,
      isUserScrolledUp: false,
      setIsUserScrolledUp: () => undefined,
      tokenBudget: null,
      setTokenBudget: () => undefined,
      visibleMessageCount: messages.length,
      visibleMessages: messages,
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
      jumpToMessage: () => undefined,
    };
  },
}));

/**
 * The composer's own state, held in real React state so typing reaches every
 * reader in ChatInterface: the textarea, the preview derivation and the
 * transcript highlight. Only the send is recorded rather than transmitted —
 * there is no server in a component test.
 */
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
        renderInputWithMentions: (text: string) => text,
        selectFile: () => undefined,
        attachedFiles: [],
        setAttachedFiles: () => undefined,
        fileErrors: new Map<string, string>(),
        getRootProps: () => ({}),
        getInputProps: () => ({}),
        isDragActive: false,
        openAttachmentPicker: () => undefined,
        handleSubmit: () => {
          state.submitted.push(input);
        },
        queuedDraft: null,
        editQueuedDraft: () => undefined,
        deleteQueuedDraft: () => undefined,
        handleVoiceTranscript: () => undefined,
        handleInputChange: (event: { target: { value: string } }) => setInput(event.target.value),
        handleKeyDown: () => undefined,
        handlePaste: () => undefined,
        handleTextareaClick: () => undefined,
        handleTextareaInput: () => undefined,
        syncInputOverlayScroll: () => undefined,
        handleClearInput: () => setInput(''),
        handleAbortSession: () => undefined,
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
        chipStrip: {
          visible: false,
          selectedIndex: null,
          listId: 'reply-item-suggestions',
          chips: [],
          onAccept: () => undefined,
          suggestionsEnabled: false,
          suggestionsLoading: false,
          onRequestSuggestions: () => undefined,
          expansionChips: [],
          onAcceptExpansionChip: () => undefined,
        },
      };
    },
  };
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat', 'common'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat, common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const view = () => render(
  <ChatInterface
    isActive
    selectedProject={PROJECT}
    selectedSession={SESSION}
    ws={null}
    sendMessage={() => undefined}
  />,
);

const labels = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-reply-item-label]'));

const typeDraft = (container: HTMLElement, value: string) => {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value } });
  return textarea;
};

const preview = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-slot="reply-reference-preview"]');

beforeEach(() => {
  state.messages = [OLD_REPLY, USER_TURN, LATEST_REPLY];
  state.submitted = [];
});

describe('reply item labels in the transcript', () => {
  test('only the latest assistant reply carries labels and addresses', () => {
    const { container } = view();
    const itemLabels = labels(container);

    assert.deepEqual(
      itemLabels.map((element) => element.getAttribute('data-reply-item-label')),
      ['①', '②', '③', '④'],
      'the four items of the latest reply, and nothing from the older reply',
    );
    for (const element of itemLabels) {
      assert.equal(
        element.getAttribute('data-reply-item-uri')?.startsWith(
          `cloudcli://session/${SESSION_ID}/msg/msg-latest#item-`,
        ),
        true,
        element.getAttribute('data-reply-item-uri') ?? '(missing uri)',
      );
    }
    // The older reply's excerpts are not labelled: the URI above already proves
    // the addresses, and this proves the row itself stayed plain.
    assert.equal(container.querySelector('[data-reply-item-uri*="旧的第一点"]'), null);
  });

  test('a draft that names items highlights exactly those items here', () => {
    const { container } = view();
    typeDraft(container, '执行 1–2');

    const highlighted = Array.from(
      container.querySelectorAll<HTMLElement>('[data-reply-item-highlighted="true"]'),
    );
    assert.deepEqual(
      highlighted.map((element) => element.getAttribute('data-reply-item-label')),
      ['①', '②'],
    );
  });
});

describe('reply reference preview', () => {
  test('an item reference lists the matching excerpts', () => {
    const { container } = view();
    typeDraft(container, '执行 1–2');

    const previewRow = preview(container);
    assert.ok(previewRow, 'the preview line is drawn above the input');
    assert.equal(previewRow!.getAttribute('data-reply-reference-kind'), 'items');
    assert.match(previewRow!.textContent ?? '', /安装依赖/);
    assert.match(previewRow!.textContent ?? '', /运行测试/);
    assert.equal(previewRow!.querySelector('[data-reply-reference-item="1"]') !== null, true);
    assert.equal(previewRow!.querySelector('[data-reply-reference-item="2"]') !== null, true);
    assert.equal(previewRow!.querySelector('[data-reply-reference-item="3"]'), null);
  });

  test('a single point reads as one item, not a degenerate range', () => {
    const { container } = view();
    typeDraft(container, '第 2 点展开说说');

    const text = preview(container)?.textContent ?? '';
    assert.match(text, /Items 2/);
    assert.equal(text.includes('2–2'), false);
  });

  test('an out-of-range point reports the reply item count instead of guessing', () => {
    const { container } = view();
    typeDraft(container, '执行第 6 点');

    const previewRow = preview(container);
    assert.ok(previewRow);
    assert.equal(previewRow!.getAttribute('data-reply-reference-kind'), 'mismatch');
    assert.match(previewRow!.textContent ?? '', /4/);
    assert.equal(container.querySelector('[data-reply-item-highlighted="true"]'), null);
  });

  test('「按你的方案」 names the whole reply', () => {
    const { container } = view();
    typeDraft(container, '按你的方案做');

    assert.equal(preview(container)?.getAttribute('data-reply-reference-kind'), 'reply');
  });

  test('the sent message is the draft itself, unchanged by the preview', () => {
    const { container } = view();
    const textarea = typeDraft(container, '执行 1–2');

    const form = container.querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);

    assert.deepEqual(state.submitted, ['执行 1–2']);
    assert.equal(textarea.value, '执行 1–2');
  });
});
