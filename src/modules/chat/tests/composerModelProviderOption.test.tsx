/**
 * One composer model choice is a (model, upstream provider) pair.
 *
 * THE CLAIM, IN ONE SENTENCE. The composer's model menu offers a built-in model
 * once bare (inherit the provider's default) and once per upstream provider the
 * catalog names — `gpt-5.6-terra` and `gpt-5.6-terra (fjdac)` — keeps a custom
 * model as a single row, and sends the clicked row's full identity to the
 * session's model write; the collapsed trigger shows that identity.
 *
 * WHY THE PAIR, NOT THE MODEL. The two rows carry the same model id, so a menu
 * that only remembers `value` cannot say which one was picked and a write that
 * only sends `model` cannot record which upstream endpoint the session must
 * run under. The provider id is therefore carried separately through the whole
 * chain: catalog row → menu entry → composer callback → `selectProviderModel`.
 *
 * WHAT IS COMPOSED HERE, AND WHAT IS NOT. The real `ChatInterface`, the real
 * `ChatComposer` and the real `ComposerModelMenu` are rendered — the menu's own
 * grouping and the composer's own callback plumbing are the code under test, so
 * a stand-in for either would assert nothing about the shipped path. The
 * session/provider/composer hooks are given their answers directly, the way
 * every `ChatInterface` case in this directory does; only the provider-state
 * hook is doubled where it records what `selectProviderModel` was handed.
 *
 * THE FALSE FORMS ARE READ, NOT ASSUMED. Grouping is read off the shipped
 * markup's `role="group"` labels, and the "no provider === 'codex' branch" arm
 * reads the menu's own source: the menu must be driven by catalog data, so the
 * same catalog expands the same way for a provider named `claude`.
 *
 * Run: npx vitest run src/modules/chat/tests/composerModelProviderOption.test.tsx
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatInterface from '@/modules/chat/ChatInterface';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { LLMProvider, Project, ProjectSession, ProviderModelOption } from '@/shared/types';

const SESSION_ID = 'session-model-provider';

const PROJECT: Project = {
  projectId: 'project-model-provider',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const SESSION: ProjectSession = { id: SESSION_ID };

/**
 * The catalog the server answers with once it expands built-ins: the bare row
 * and every registered provider's variant share `value` and differ only by
 * `modelProviderId`. `my-model` is a custom entry, already bound to `fjdac`, so
 * it must stay one row. `gpt-5.6-sol` has no variant: nothing may invent one.
 */
const CATALOG: ProviderModelOption[] = [
  { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
  { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra · fjdac', modelProviderId: 'fjdac' },
  { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
  { value: 'my-model', label: 'my-model · fjdac', modelProviderId: 'fjdac', isCustom: true, recordId: 7 },
];

/**
 * Mutable answers the doubles read: one case can choose the provider, the
 * catalog, and the selection the composer starts from, and read what the model
 * write was handed.
 */
const state = vi.hoisted(() => ({
  provider: 'codex' as LLMProvider,
  options: [] as ProviderModelOption[],
  selection: { model: 'gpt-5.6-terra', modelProviderId: null as string | null },
  calls: [] as Array<{
    provider: LLMProvider;
    model: string;
    sessionId: string | null;
    modelProviderId: string | null;
  }>,
}));

/* ─── Module doubles: nothing here is the thing under test ───────────────── */

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ token: null }) }));

vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: null }),
  NextTaskBanner: () => null,
}));

// Only `useWebSocket` is doubled: the module's default export is the real context,
// whose `null` value the pane's own `useContext` reading already tolerates.
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

vi.mock('@/modules/chat-session/hooks/useSessionStore', () => ({
  useSessionStore: () => ({}),
}));

vi.mock('@/modules/chat-session/hooks/useChatRealtimeHandlers', () => ({
  useChatRealtimeHandlers: () => undefined,
}));

vi.mock('@/modules/chat-composer/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: () => undefined }),
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useResidentProviders: () => new Set<string>(),
  useProviderLifecycleDefaults: () => ({}),
}));

vi.mock('@/shared/settings/selectedProvider', () => ({
  readSelectedProvider: () => state.provider,
}));

vi.mock('@/shared/hooks/useSessionHosts', () => ({
  useSessionHosts: () => ({ snapshot: { hosts: [], sessions: [] } }),
  findSessionHostState: () => null,
  findSessionOccupancy: () => null,
}));

vi.mock('@/modules/chat-support/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/shared/voice/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  // The listen's own mode resolver, resolved from the preference store this mock does not own.
  resolveVoiceVadMode: () => 'vad',
  voiceDebugFlushSilenceSec: () => undefined,
}));

// The one seam this criterion is about at the composer's edge: the shipped
// `ChatInterface` handler calls this, so the double records the exact arguments
// the real hook would have received. Its answers are otherwise the ones the
// other `ChatInterface` cases hand their hooks.
vi.mock('@/modules/chat-session/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: state.provider,
    setProvider: () => undefined,
    providerModels: { [state.provider]: state.selection.model },
    setStoredProviderModel: () => undefined,
    currentProviderEffort: 'medium',
    currentProviderEffortOptions: [],
    currentProviderModel: state.selection.model,
    currentProviderModelProviderId: state.selection.modelProviderId,
    currentProviderModelOptions: state.options,
    permissionMode: 'default',
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => undefined,
    availablePermissionModes: ['default'],
    selectPermissionMode: () => undefined,
    cyclePermissionMode: () => undefined,
    providerModelCatalog: {},
    providerModelsLoading: false,
    providerModelActions: {},
    selectProviderModel: async (
      provider: LLMProvider,
      model: string,
      sessionId?: string | null,
      modelProviderId?: string | null,
    ) => {
      state.calls.push({
        provider,
        model,
        sessionId: sessionId ?? null,
        modelProviderId: modelProviderId ?? null,
      });
      return { scope: 'session' as const, model, modelProviderId: modelProviderId ?? null };
    },
    selectProviderEffort: async () => undefined,
    resolvePermissionModeForProvider: () => 'default',
    supportsMessageEditing: true,
    supportsSessionForking: true,
  }),
}));

vi.mock('@/modules/chat-session/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
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

vi.mock('@/modules/chat-composer/hooks/useChatComposerState', () => ({
  useChatComposerState: () => ({
    input: '',
    setInput: () => undefined,
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
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
  state.provider = 'codex';
  state.options = CATALOG;
  state.selection = { model: 'gpt-5.6-terra', modelProviderId: null };
  state.calls = [];
});

afterEach(cleanup);

const renderInterface = () =>
  render(
    <ChatInterface
      isActive
      selectedProject={PROJECT}
      selectedSession={SESSION}
      ws={null}
      sendMessage={() => undefined}
    />,
  );

/* ─── Readings off the mounted tree ──────────────────────────────────────── */

const MODEL_MENU_LABEL = 'Select model and reasoning effort';

/** The composer's model trigger — the one control the whole reading hangs off. */
const modelTrigger = (): HTMLElement => {
  const trigger = document.querySelector<HTMLElement>(`button[aria-label="${MODEL_MENU_LABEL}"]`);
  assert.ok(trigger, 'premise: the composer must draw its model menu trigger');
  return trigger;
};

/** Opens the popover and then its (initially collapsed) model section. */
const openModelList = () => {
  fireEvent.click(modelTrigger());
  const menu = screen.getByRole('menu', { name: MODEL_MENU_LABEL });
  // The model list starts one click away; that row is labelled with the active
  // selection and toggles the section rather than selecting anything.
  const sectionToggle = within(menu).getByRole('menuitem');
  fireEvent.click(sectionToggle);
  return menu;
};

/** The rows of one model's group, in render order, by their visible labels. */
const groupRowLabels = (menu: HTMLElement, modelLabel: string): string[] => {
  const group = within(menu).getByRole('group', { name: modelLabel });
  return within(group)
    .getAllByRole('menuitemradio')
    .map((row) => (row.textContent ?? '').trim());
};

/* ─── The readings ───────────────────────────────────────────────────────── */

test('(a) built-ins expand into bare + one row per provider, a custom model stays one row', () => {
  const view = renderInterface();
  const menu = openModelList();

  // Premise: the trigger really draws the model menu, so the readings below are
  // taken off the shipped surface rather than an empty popover.
  assert.ok(menu, 'premise: the model menu must be open');
  assert.equal(state.calls.length, 0, 'premise: opening the menu selects nothing');

  // The grouped-by-model reading: each model is its own group, and the two
  // provider rows share it with the bare row.
  assert.deepEqual(
    groupRowLabels(menu, 'gpt-5.6-terra'),
    ['gpt-5.6-terra', 'gpt-5.6-terra (fjdac)'],
    'a built-in model must offer its bare row and each registered provider variant, grouped together',
  );

  // A built-in the catalog did not expand gains no variant of its own.
  assert.deepEqual(
    groupRowLabels(menu, 'gpt-5.6-sol'),
    ['gpt-5.6-sol'],
    'a model with no provider row must not be fanned out speculatively',
  );

  // A custom model is already bound to one provider: one row, no `(provider)`
  // suffix, no expansion.
  assert.deepEqual(
    groupRowLabels(menu, 'my-model'),
    ['my-model'],
    'a custom model must stay a single row even though it carries a provider id',
  );

  // Exactly the rows the catalog carried: 4 entries (2 + 1 + 1), never a
  // fabricated row for a provider the catalog did not name.
  assert.equal(
    within(menu).getAllByRole('menuitemradio').length,
    4,
    'the menu must render exactly the catalog rows, grouped by model',
  );

  view.unmount();
});

test('(b) selecting a variant sends model + provider id; the collapsed trigger shows the composed label', () => {
  const view = renderInterface();
  const menu = openModelList();

  const variant = within(within(menu).getByRole('group', { name: 'gpt-5.6-terra' }))
    .getByRole('menuitemradio', { name: 'gpt-5.6-terra (fjdac)' });
  fireEvent.click(variant);

  assert.deepEqual(
    state.calls,
    [{ provider: 'codex', model: 'gpt-5.6-terra', sessionId: SESSION_ID, modelProviderId: 'fjdac' }],
    'clicking a variant must hand the whole identity to selectProviderModel',
  );

  view.unmount();

  // The collapsed button, read from a composer whose session selection IS the
  // variant — the state the click above produces once the write is recorded.
  state.calls = [];
  state.selection = { model: 'gpt-5.6-terra', modelProviderId: 'fjdac' };
  const settled = renderInterface();
  assert.equal(
    (modelTrigger().textContent ?? '').trim(),
    'gpt-5.6-terra (fjdac)',
    'the collapsed trigger must show the composed model (provider) label',
  );
  settled.unmount();
});

test('(c) selecting the bare row sends no provider id', () => {
  const view = renderInterface();
  const menu = openModelList();

  const bare = within(within(menu).getByRole('group', { name: 'gpt-5.6-terra' }))
    .getByRole('menuitemradio', { name: 'gpt-5.6-terra' });
  fireEvent.click(bare);

  assert.deepEqual(
    state.calls,
    [{ provider: 'codex', model: 'gpt-5.6-terra', sessionId: SESSION_ID, modelProviderId: null }],
    'the bare row must carry no provider id — absent means "inherit the provider default"',
  );

  view.unmount();
});

test('(c2) a provider the catalog no longer carries has no variant row', () => {
  // The session still records the binding `gone` — that was the conversation's
  // real endpoint — but the current catalog offers no such row, and the menu is
  // built from the catalog, not from a provider list.
  state.selection = { model: 'gpt-5.6-terra', modelProviderId: 'gone' };
  const view = renderInterface();
  const menu = openModelList();

  assert.equal(
    within(menu).queryByRole('group', { name: 'gone' }),
    null,
    'a deleted provider must not become a group of its own',
  );
  assert.equal(
    within(menu).queryAllByRole('menuitemradio', { name: 'gpt-5.6-terra (gone)' }).length,
    0,
    'a variant row may only exist for a (model, provider) row the catalog carries',
  );
  // The trigger, by contrast, reports the session's real binding: the composer
  // must not silently pretend the conversation runs under the bare default.
  assert.equal(
    (modelTrigger().textContent ?? '').trim(),
    'gpt-5.6-terra (gone)',
    'the collapsed trigger must keep reporting the session\'s recorded binding',
  );

  view.unmount();
});

test('(c3) a blank provider id is the bare identity, not an empty variant', () => {
  state.options = [
    { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra', modelProviderId: '   ' },
  ];
  const view = renderInterface();
  const menu = openModelList();

  assert.deepEqual(
    groupRowLabels(menu, 'gpt-5.6-terra'),
    ['gpt-5.6-terra'],
    'a whitespace-only provider id must read as the bare row, never as "()"',
  );

  view.unmount();
});

test('(d) the menu is one model list grouped by model — not a provider picker beside a model picker', () => {
  const view = renderInterface();
  const menu = openModelList();

  // No second dropdown of any kind: the model menu is a menu, and nothing on
  // the page is a <select>/combobox.
  assert.equal(document.querySelectorAll('select').length, 0, 'the composer must not grow a provider <select>');
  assert.equal(screen.queryAllByRole('combobox').length, 0, 'neither a model nor a provider combobox may appear');

  // Grouping is by MODEL: the group labels are model names, and no provider id
  // is a group of its own.
  const groupLabels = within(menu)
    .getAllByRole('group')
    .map((group) => group.getAttribute('aria-label'));
  assert.deepEqual(
    groupLabels,
    ['gpt-5.6-terra', 'gpt-5.6-sol', 'my-model'],
    'each model must be its own group, in catalog order',
  );
  assert.equal(
    within(menu).queryByRole('group', { name: 'fjdac' }),
    null,
    'the menu must not be grouped by provider',
  );

  view.unmount();
});

test('(d2) expansion follows the catalog, not the provider name: the same rows appear for claude', () => {
  // Data-driven, by construction: a hardcoded `provider === 'codex'` path would
  // leave this provider's catalog unexpanded (or its callback single-argument).
  state.provider = 'claude';
  state.calls = [];
  state.options = [
    { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5 · fjdac', modelProviderId: 'fjdac' },
  ];
  const view = renderInterface();
  const menu = openModelList();

  assert.deepEqual(
    groupRowLabels(menu, 'claude-sonnet-4-5'),
    ['claude-sonnet-4-5', 'claude-sonnet-4-5 (fjdac)'],
    'the same catalog shape must expand the same way under another provider name',
  );

  fireEvent.click(
    within(within(menu).getByRole('group', { name: 'claude-sonnet-4-5' }))
      .getByRole('menuitemradio', { name: 'claude-sonnet-4-5 (fjdac)' }),
  );
  assert.deepEqual(
    state.calls,
    [{ provider: 'claude', model: 'claude-sonnet-4-5', sessionId: SESSION_ID, modelProviderId: 'fjdac' }],
    'the provider id must reach the write under any provider, not only codex',
  );

  view.unmount();
});

test('(d3) the menu source carries no provider === \'codex\' branch', () => {
  // The behavioural arm above proves today's behavior; this arm makes the
  // architecture red line itself falsifiable. Provider differences belong in
  // the catalog data (server) and in PROVIDER_DESCRIPTORS (client), never in a
  // branch inside the composer menu.
  const source = readFileSync(
    path.join(process.cwd(), 'src/modules/chat-composer/composer/menus/ComposerModelMenu.tsx'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /(?:provider|state\.provider)\s*===\s*['"]codex['"]/,
    'the composer model menu must not branch on the provider name',
  );
  assert.doesNotMatch(
    source,
    /['"]codex['"]\s*===\s*provider/,
    'the composer model menu must not branch on the provider name (reversed comparison)',
  );
});
