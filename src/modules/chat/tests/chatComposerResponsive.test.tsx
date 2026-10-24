import assert from 'node:assert/strict';

import { fireEvent, render, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import WebSocketContext from '@/shared/context/WebSocketContext';
import type {
  ChatMessage,
  ComposerChipStrip,
  PendingPermissionRequest,
  Project,
  ProjectSession,
  ProviderModelActions,
  SessionActivity,
  VoiceClipSlot,
} from '@/shared/types';

/**
 * On a phone the composer's footer wrapped onto a second row, because it carried
 * seven controls including the commands, schedule and token ones. The fix keeps the
 * primary row to the six controls that send a message and moves the other three
 * behind a single "more" entry on the narrow layout — while the wide layout keeps
 * showing them inline, unchanged.
 *
 * jsdom parses no Tailwind, so nothing here can read a `flex-nowrap` class or a
 * breakpoint. What it can hold is the *structure* the CSS then lays out: which
 * controls exist in which tier at all. The tier is switched by the signal the
 * component itself reads — `window.innerWidth` against the `md` boundary — so a
 * component that switched on some other signal would take the same branch here and
 * these cases would fail rather than pass against a second copy of the rule. That
 * the real box really measures `scrollWidth === clientWidth` on a phone is the e2e
 * probe's job, not a unit test's.
 *
 * The last two cases read the running turn instead of the footer, over a composer
 * and a message pane rendered together — the two surfaces the turn can be drawn on,
 * as ChatInterface renders them. What they can hold is which surface exists at
 * which tier and how many accessible stop entries the pair offers: below `md` the
 * status is a line in the transcript carrying no control, so the composer's own
 * submit button is the one entry; from `md` up the tab still carries its own, and
 * the reading is unchanged. That the line really sits under the last message and
 * really scrolls with it is likewise the browser probe's job.
 */

/**
 * The model label the narrow row has to fit beside the send button. A short name
 * would let a row that does not truncate anything pass; the shipping catalog's
 * entries are this long, so the cases below are read against the real shape.
 */
const LONG_MODEL_NAME = 'claude-sonnet-4-5-20250929';

const MOBILE_WIDTH = 390;
/** One pixel under the `md` boundary, where the narrow layout must still apply. */
const NARROW_EDGE_WIDTH = 767;
const DESKTOP_WIDTH = 1280;

// The real hook asks the backend whether a voice provider is configured; the mic
// button is one of the six the narrow row must keep, so it has to be offered here.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

// A plain install: no debug upload entry (an extra control) and no trim switch.
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default: keeps this whole-module replacement complete.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
}));

/**
 * The clip the composer is holding, as the replay-count case below wants it.
 *
 * The voice hook is doubled because the capture chain is not what that case is about — the number of
 * accessible replay controls the composer renders is — and driving a real recording would mean
 * stubbing `MediaRecorder`, the clip's `Audio` elements and the object-URL calls in a file whose
 * subject is the breakpoint. Every other case wants a composer with nothing recorded, which is what
 * the slot's `null` default gives them, so their rendering is unchanged.
 */
const { clipFixture } = vi.hoisted(() => ({
  clipFixture: { slot: null as VoiceClipSlot | null },
}));

vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    toggle: () => undefined,
    stop: () => undefined,
    transcribeFile: () => undefined,
    clipSlot: clipFixture.slot,
    clipPlayState: { original: 'idle', trimmed: 'idle' },
    toggleClipPlayback: () => undefined,
  }),
}));

/** The pair a trimmed capture leaves in the slot: the recording, and the upload made of it. */
const CLIP_PAIR: VoiceClipSlot = {
  original: {
    url: 'blob:responsive-original',
    meta: { bytes: 6_400, mimeType: 'audio/webm', durationMs: 9_000 },
  },
  trimmed: {
    url: 'blob:responsive-trimmed',
    meta: { bytes: 32_000, mimeType: 'audio/wav', durationMs: 4_000 },
  },
};

beforeEach(() => {
  clipFixture.slot = null;
});

/**
 * jsdom implements no media queries at all. The double answers "no" to every query,
 * which is a keyboard device: the composer then prints its hint row, as it does in a
 * desktop browser — the row that a touch device hides. That keeps the hint out of the
 * way of the narrow-layout cases below only by width, exactly as it is in a browser.
 */
const installMatchMedia = () => {
  window.matchMedia = ((query: string) => {
    const isTouchQuery = query === TOUCH_ONLY_QUERY;
    return {
      // Live, like a real MediaQueryList: the device is set per case, after this double is built.
      get matches() {
        return isTouchQuery ? device.touchOnly : false;
      },
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
};

/** The signal the composer itself reads (`useDeviceSettings`), so a renamed source of truth fails the cases below. */
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

/**
 * The device the render is on, which the short tier reads beside the height.
 *
 * The double below answers the device query from here and "no" to everything else. It has to answer
 * it at all: a double that said "no" to every query would leave the tier unreachable, and the cell
 * that asserts the short tier's single stop entry would then be reading the wide arrangement while
 * claiming to read the short one.
 */
const device = { touchOnly: false };
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

/**
 * The second signal the same hook reads. jsdom's own window is 768px tall, which is the tall tier,
 * so a case that does not set this keeps reading exactly the layout it read before the height tier
 * existed — and the one case below that does set it is the only one that can reach the new one.
 */
const setViewportHeight = (height: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
};

/** A phone held sideways: wide enough for `md`, and the height that makes the tier apply. */
const LANDSCAPE_WIDTH = 844;
const LANDSCAPE_HEIGHT = 330;

const FOOTER_SELECTOR = '[data-slot="prompt-input-footer"]';
/** The footer's left control group — the one whose own wrapping permission is read below. */
const TOOLS_SELECTOR = '[data-slot="prompt-input-tools"]';
/** Every open overlay the composer can put on screen; two at once is the nesting bug. */
const openOverlays = () => Array.from(document.querySelectorAll('[role="menu"],[role="dialog"]'));

/**
 * The wrapping tokens an element declares, read off its class list.
 *
 * jsdom parses no stylesheet, so this is not a layout reading — it is the *permission*
 * the component itself declares, which is what the box below turns on. The layout
 * consequence is the browser probe's: at the narrowest desktop width (768, sidebar open)
 * one recording's replay pair in this group read `scrollWidth 470 / clientWidth 445`
 * before the group was allowed to wrap, and `445 / 445` after.
 */
const wrapTokens = (element: Element) =>
  Array.from(element.classList).filter((name) => /^flex-(?:wrap|nowrap)$/.test(name));

/** The names the primary controls carry in the narrow layout, read from the shipping locale. */
const PRIMARY_NAMES = [
  enChat.input.attachFiles,
  enChat.input.suggestions.suggest,
  enChat.input.moreTools,
  enChat.composer.modelMenu,
  enChat.composer.permissionHeading.replace('{{provider}}', 'Claude'),
  enChat.voice.input,
  enChat.input.send,
];

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
  // A real provider offers both, and the model button only exists when one does —
  // which is the arrangement the narrow row has to survive, not the empty one.
  availableEffortOptions: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
  onSelectEffort: () => undefined,
  model: LONG_MODEL_NAME,
  availableModelOptions: [{ value: LONG_MODEL_NAME, label: LONG_MODEL_NAME }],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: vi.fn(),
  slashCommandsCount: 0,
  onToggleCommandMenu: vi.fn(),
  hasInput: false,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  // The reply-suggestions feature is on in the shipping composer whenever the status
  // reading enables it, and its button is one of the controls the footer's budget was
  // measured against — so the fixture renders it rather than a footer the page never has.
  chipStrip: baseChipStrip(),
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
  input: '',
  onVoiceTranscript: () => undefined,
  scope: 'session-a',
  projectId: null,
  isActive: true,
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Ask anything',
  isTextareaExpanded: false,
});

/**
 * The one chip prop the composer takes. The empty strip keeps the reading the
 * footer's budget cases need (no chips drawn) while the Suggest control stays on,
 * because its button is one of the controls being measured.
 */
const baseChipStrip = (overrides: Partial<ComposerChipStrip> = {}): ComposerChipStrip => ({
  visible: false,
  selectedIndex: null,
  listId: 'suggestion-list',
  chips: [],
  onAccept: () => undefined,
  suggestionsEnabled: true,
  suggestionsLoading: false,
  onRequestSuggestions: vi.fn(),
  expansionChips: [],
  onAcceptExpansionChip: () => undefined,
  ...overrides,
});

type ComposerOverrides = Partial<ReturnType<typeof baseProps>>;

const renderComposer = (width: number, overrides: ComposerOverrides = {}) => {
  injectMatchMediaOnce();
  setViewportWidth(width);
  const props = { ...baseProps(), ...overrides } as React.ComponentProps<typeof ChatComposer>;
  const view = render(React.createElement(ChatComposer, props));
  const footer = view.container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  assert.ok(footer, `the composer must render a footer (${FOOTER_SELECTOR})`);
  return { view, footer, props };
};

/**
 * A real media query for the hint row's device rule, and nothing else — it answers
 * "no" to every query, so the composer behaves as it does on a keyboard device.
 */
let matchMediaInstalled = false;
const injectMatchMediaOnce = () => {
  if (matchMediaInstalled) return;
  installMatchMedia();
  matchMediaInstalled = true;
};

/** Every interactive control inside the footer, named for a failure message that can be acted on. */
const describeFooterControls = (footer: Element) =>
  Array.from(footer.querySelectorAll('button'))
    .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '<unnamed>')
    .join(' | ');

/** The same names, in DOM order — the compact row is an ordered set, not just a bag of controls. */
const footerControlNames = (footer: Element) =>
  Array.from(footer.querySelectorAll('button'))
    .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '<unnamed>');

const openMoreMenu = (view: ReturnType<typeof render>) => {
  fireEvent.click(view.getByRole('button', { name: enChat.input.moreTools }));
  return view.getByRole('menu');
};

/* ── one running turn, one dock, and the stop entries it offers ───────────── */

/** A fixed clock, so the turn's elapsed reading is a number the cases can name. */
const START = Date.parse('2026-01-01T00:00:00.000Z');
/**
 * The dock's one marker, wherever it is mounted.
 *
 * The composer's tab and the transcript's compact line used to be addressed by
 * two selectors, and the pair of cases below read which of them existed at which
 * width. They are one component behind one attribute now; what still differs by
 * width is the *mount site*, which the position assertions below read instead.
 */
const ACTIVITY_DOCK = '[data-activity-dock]';
/** The transcript's scroll container, so "the dock's other mount site" can be addressed. */
const PANE_SELECTOR = '.chat-messages-pane';

/**
 * The turn both cases are about: running, and interruptible — so the tab surface
 * has something of its own to offer and the pair genuinely could expose two stop
 * entries, which is what makes the counts below readings rather than zeroes.
 */
const RUNNING_ACTIVITY: SessionActivity = {
  statusText: 'Reviewing',
  canInterrupt: true,
  startedAt: START,
};

/** A request already on screen: the status belongs to it, and the turn stops being shown. */
const PENDING_PERMISSION: PendingPermissionRequest = { requestId: 'req-1', toolName: 'Bash' };

const TURN_MESSAGES: ChatMessage[] = [
  { type: 'user', content: 'question', timestamp: '2026-01-01T00:00:00.000Z' },
  { type: 'assistant', content: 'answer', timestamp: '2026-01-01T00:00:01.000Z' },
];

const TURN_PROJECT: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

/**
 * The pane's own props, only as far as a transcript holding one turn needs them. The
 * pane is rendered by ChatInterface next to the composer, and its inline status line
 * is the second surface of this turn: `hasActivityIndicator` is that component's own
 * reading of "a turn is running and no permission request has taken the status over",
 * and `activity` is the same turn.
 */
const paneProps = (overrides: Partial<React.ComponentProps<typeof ChatMessagesPane>> = {}) => ({
  scrollContainerRef: { current: null },
  scrollContentRef: () => undefined,
  onWheel: () => undefined,
  onTouchMove: () => undefined,
  isLoadingSessionMessages: false,
  isProcessing: true,
  hasActivityIndicator: false,
  activity: null,
  chatMessages: TURN_MESSAGES,
  selectedSession: { id: 'session-a' } as ProjectSession,
  currentSessionId: 'session-a',
  provider: 'claude' as const,
  setProvider: () => undefined,
  textareaRef: { current: null },
  providerModels: { claude: LONG_MODEL_NAME },
  setProviderModel: () => undefined,
  providerModelCatalog: {},
  providerModelActions: {} as ProviderModelActions,
  providerModelsLoading: false,
  tasksEnabled: false,
  isTaskMasterInstalled: null,
  setInput: () => undefined,
  isLoadingMoreMessages: false,
  hasMoreMessages: false,
  totalMessages: TURN_MESSAGES.length,
  sessionMessagesCount: TURN_MESSAGES.length,
  visibleMessageCount: TURN_MESSAGES.length,
  visibleMessages: TURN_MESSAGES,
  loadEarlierMessages: () => undefined,
  loadAllMessages: () => undefined,
  allMessagesLoaded: true,
  isLoadingAllMessages: false,
  loadAllJustFinished: false,
  showLoadAllOverlay: false,
  createDiff: () => undefined,
  selectedProject: TURN_PROJECT,
  showThinking: true,
  ...overrides,
});

/**
 * The composer and the message pane in one tree, as ChatInterface renders them, with
 * a turn running. Both surfaces are on screen for every reading taken over it, so a
 * count of one means "one entry, across two surfaces" and not "nothing rendered" —
 * the pane alone could not show the tab, and the composer alone cannot show the line.
 * Returned as an element rather than a render result, so a case can build the pair in
 * either state: a turn running, or a permission request holding the status.
 */
const turnElement = (
  width: number,
  {
    pendingPermissionRequests = [] as PendingPermissionRequest[],
    height = 900,
    touchOnly = false,
  } = {},
) => {
  injectMatchMediaOnce();
  setViewportWidth(width);
  setViewportHeight(height);
  device.touchOnly = touchOnly;
  const activity = RUNNING_ACTIVITY;
  const hasActivityIndicator = pendingPermissionRequests.length === 0;
  const composerProps = { ...baseProps(), activity, isLoading: true, pendingPermissionRequests };
  return (
    <UiPreferencesProvider>
      <ChatComposer {...(composerProps as React.ComponentProps<typeof ChatComposer>)} />
      <ChatMessagesPane
        {...(paneProps({ activity, hasActivityIndicator }) as React.ComponentProps<typeof ChatMessagesPane>)}
      />
    </UiPreferencesProvider>
  );
};

const renderTurn = (
  width: number,
  options: { pendingPermissionRequests?: PendingPermissionRequest[]; height?: number; touchOnly?: boolean } = {},
) => {
  const view = render(turnElement(width, options));
  const footer = view.container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  assert.ok(footer, `the composer must render a footer (${FOOTER_SELECTOR})`);
  return { view, footer };
};

/** Every accessible control whose name says stop — the reading the criterion counts. */
const stopButtons = (root: HTMLElement) => within(root).queryAllByRole('button', { name: /stop/i });

/** The reads above, named rather than counted, so a stray control is identifiable in the failure. */
const nameStops = (buttons: HTMLElement[]) =>
  buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '<unnamed>').join(' | ')
  || '<none>';

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

test('(a) the narrow footer is six controls when empty and seven with a draft, the clear ✕ being the seventh', () => {
  // The empty row: exactly the controls that send a message. The Suggest control is an
  // icon on this tier, so the accessible name (its aria-label) is the only text it has.
  const empty = renderComposer(MOBILE_WIDTH);
  const emptyControls = Array.from(empty.footer.querySelectorAll('button'));
  assert.equal(
    emptyControls.length,
    PRIMARY_NAMES.length,
    `the empty narrow footer must hold ${PRIMARY_NAMES.length} controls; it holds ${emptyControls.length}: ${describeFooterControls(empty.footer)}`,
  );

  assert.deepEqual(
    footerControlNames(empty.footer),
    PRIMARY_NAMES,
    `the narrow footer controls, in order, read: ${describeFooterControls(empty.footer)}`,
  );
  const suggest = within(empty.footer).getByRole('button', { name: enChat.input.suggestions.suggest });
  assert.equal(
    (suggest.textContent ?? '').trim(),
    '',
    `the compact Suggest control is icon-only; it renders text: ${JSON.stringify(suggest.textContent)}`,
  );
  assert.equal(suggest.getAttribute('aria-label'), enChat.input.suggestions.suggest);
  assert.equal(
    empty.footer.querySelector('[data-slot="composer-clear-input"]'),
    null,
    'an empty box has nothing to clear',
  );

  for (const moved of [enChat.input.showAllCommands, enChat.schedule.trigger, enChat.misc.showTokenUsage]) {
    assert.equal(
      within(empty.footer).queryByRole('button', { name: moved }),
      null,
      `"${moved}" must not stay in the narrow footer; controls read: ${describeFooterControls(empty.footer)}`,
    );
  }
  empty.view.unmount();

  // A draft adds exactly one control, and it is the clear ✕, placed after "more".
  const drafted = renderComposer(MOBILE_WIDTH, { hasInput: true, input: 'draft' });
  const draftedControls = Array.from(drafted.footer.querySelectorAll('button'));
  assert.equal(
    draftedControls.length,
    PRIMARY_NAMES.length + 1,
    `a draft must add exactly the clear ✕; controls read: ${describeFooterControls(drafted.footer)}`,
  );
  assert.deepEqual(
    footerControlNames(drafted.footer),
    [...PRIMARY_NAMES.slice(0, 3), enChat.input.clearInput, ...PRIMARY_NAMES.slice(3)],
    `the drafted narrow footer puts the ✕ between "more" and the model menu; it reads: ${describeFooterControls(drafted.footer)}`,
  );
  const clear = drafted.footer.querySelector('[data-slot="composer-clear-input"]');
  assert.ok(clear, 'the drafted narrow footer must offer the clear ✕');
  assert.equal(clear.getAttribute('aria-label'), enChat.input.clearInput);
  const more = within(drafted.footer).getByRole('button', { name: enChat.input.moreTools });
  assert.equal(
    more.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
    'the clear ✕ must follow the "more" entry in DOM order',
  );
  drafted.view.unmount();

  // The 360px floor: no room for the extra control, so the row stays six.
  const narrowest = renderComposer(340, { hasInput: true, input: 'draft' });
  assert.equal(
    Array.from(narrowest.footer.querySelectorAll('button')).length,
    PRIMARY_NAMES.length,
    `below 360px a draft must not add a control; controls read: ${describeFooterControls(narrowest.footer)}`,
  );
  assert.equal(narrowest.footer.querySelector('[data-slot="composer-clear-input"]'), null);
});

test('(a2) the Suggest control is icon-only and busy-flagged on the narrow tier, labelled on the wide one', () => {
  // Compact tier, a draw in flight: the icon spins, the button is disabled, and the
  // accessible name + aria-busy are what an assistive reading gets in place of text.
  const compact = renderComposer(MOBILE_WIDTH, {
    chipStrip: baseChipStrip({ suggestionsLoading: true }),
  });
  const busy = within(compact.footer).getByRole('button', { name: enChat.input.suggestions.suggest });
  assert.equal(busy.getAttribute('disabled'), '', 'a second click must not become a second draw');
  assert.equal(busy.getAttribute('aria-busy'), 'true');
  assert.equal((busy.textContent ?? '').trim(), '', 'the compact control renders no visible text');
  assert.ok(busy.querySelector('svg.animate-spin'), 'the in-flight state must be visible as an icon state');
  compact.view.unmount();

  // Wide tier: the labelled button is unchanged, because that row has the width for it.
  const wide = renderComposer(1280);
  const labelled = within(wide.footer).getByRole('button', { name: enChat.input.suggestions.suggest });
  assert.equal(
    (labelled.textContent ?? '').trim(),
    enChat.input.suggestions.suggest,
    `the wide tier keeps the visible label; it reads: ${JSON.stringify(labelled.textContent)}`,
  );
  wide.view.unmount();
});

test('(a) the tier boundary is md: 767px is still the narrow layout, and 768px is not', () => {
  const narrow = renderComposer(NARROW_EDGE_WIDTH);
  assert.equal(
    within(narrow.footer).queryByRole('button', { name: enChat.input.moreTools }) !== null,
    true,
    `767px must take the narrow layout; controls read: ${describeFooterControls(narrow.footer)}`,
  );
  narrow.view.unmount();

  const wide = renderComposer(NARROW_EDGE_WIDTH + 1);
  assert.equal(
    within(wide.footer).queryByRole('button', { name: enChat.input.moreTools }),
    null,
    `768px must take the wide layout; controls read: ${describeFooterControls(wide.footer)}`,
  );
});

test('(a) the narrow row may never wrap; from md up the left tool group may, instead of widening the box', () => {
  // The two halves of one rule, read on the group that holds the replay pair. Below `md`
  // the row is the six controls that send a message and may not wrap, so neither the box
  // nor the group carries a wrap token: the row's height is a constant the narrow layout
  // depends on. From `md` up the box keeps its own wrapping row, but that only decides
  // where the two groups go — it cannot break a group, and this group's children cannot
  // shrink (the pair declares `shrink-0`; an icon button cannot go below its own icon).
  // Without a wrap token here the group's content is what a narrow desktop width pushes
  // past the box's edge, which is the 470/445 overflow the browser probe records.
  const narrow = renderComposer(NARROW_EDGE_WIDTH);
  const narrowTools = narrow.footer.querySelector(TOOLS_SELECTOR);
  assert.ok(narrowTools, `the narrow footer must render its tool group (${TOOLS_SELECTOR})`);
  const narrowReading = `@${NARROW_EDGE_WIDTH}: box="${narrow.footer.className}" tools="${narrowTools.className}"`;
  assert.deepEqual(
    wrapTokens(narrow.footer),
    ['flex-nowrap'],
    `the narrow box must be the row that never wraps; ${narrowReading}`,
  );
  assert.equal(
    wrapTokens(narrowTools).includes('flex-wrap'),
    false,
    `the narrow tool group must not be allowed to wrap; ${narrowReading}`,
  );
  narrow.view.unmount();

  const wide = renderComposer(NARROW_EDGE_WIDTH + 1);
  const wideTools = wide.footer.querySelector(TOOLS_SELECTOR);
  assert.ok(wideTools, `the wide footer must render its tool group (${TOOLS_SELECTOR})`);
  const wideReading = `@${NARROW_EDGE_WIDTH + 1}: box="${wide.footer.className}" tools="${wideTools.className}"`;
  assert.equal(
    wrapTokens(wideTools).includes('flex-wrap'),
    true,
    `from md up the tool group must be able to take a second line of its own; ${wideReading}`,
  );
});

test('(b) the wide footer still shows commands, schedule and token usage inline, with no "more" entry', () => {
  const { view, footer } = renderComposer(DESKTOP_WIDTH);

  for (const inline of [enChat.input.showAllCommands, enChat.schedule.trigger, enChat.misc.showTokenUsage]) {
    assert.ok(
      within(footer).queryByRole('button', { name: inline }),
      `"${inline}" must stay directly in the wide footer; controls read: ${describeFooterControls(footer)}`,
    );
  }

  assert.equal(
    view.queryByRole('button', { name: enChat.input.moreTools }),
    null,
    'the wide layout must not introduce the narrow layout\'s "more" entry',
  );
});

test('(c) the "more" menu offers all three, and the commands item calls the composer\'s own toggle once', () => {
  const onToggleCommandMenu = vi.fn();
  const { view } = renderComposer(MOBILE_WIDTH, { onToggleCommandMenu });
  const menu = openMoreMenu(view);

  const commands = within(menu).getByRole('menuitem', { name: new RegExp(enChat.input.showAllCommands) });
  within(menu).getByRole('menuitem', { name: enChat.schedule.trigger });
  within(menu).getByRole('menuitem', { name: new RegExp(enChat.misc.showTokenUsage) });

  fireEvent.click(commands);

  assert.equal(
    onToggleCommandMenu.mock.calls.length,
    1,
    `choosing commands must call the composer's toggle exactly once, called ${onToggleCommandMenu.mock.calls.length}`,
  );
  assert.equal(openOverlays().length, 0, 'the menu must close once its item is chosen');
});

test('(c) the token item opens the composer\'s own detail panel once', () => {
  const onShowTokenUsage = vi.fn();
  const { view } = renderComposer(MOBILE_WIDTH, { onShowTokenUsage });
  const menu = openMoreMenu(view);

  fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(enChat.misc.showTokenUsage) }));

  assert.equal(
    onShowTokenUsage.mock.calls.length,
    1,
    `choosing token usage must open the panel exactly once, opened ${onShowTokenUsage.mock.calls.length}`,
  );
  assert.equal(openOverlays().length, 0, 'the menu must close once its item is chosen');
});

test('(c) the schedule item reaches the original commit path and submits one instant', () => {
  const onScheduleMessage = vi.fn();
  const { view } = renderComposer(MOBILE_WIDTH, { input: 'later', hasInput: true, onScheduleMessage });
  const menu = openMoreMenu(view);

  fireEvent.click(within(menu).getByRole('menuitem', { name: enChat.schedule.trigger }));

  // The picker's own rows, rendered in the menu's surface: the same ones the wide
  // footer's popover shows, so the commit below is the shipping one.
  const picker = view.getByRole('menuitemradio', { name: new RegExp(enChat.schedule.in['15']) });
  assert.equal(openOverlays().length, 1, 'the picker must not open a second overlay');

  fireEvent.click(picker);

  assert.equal(
    onScheduleMessage.mock.calls.length,
    1,
    `scheduling must commit exactly once, committed ${onScheduleMessage.mock.calls.length}`,
  );
  assert.ok(
    onScheduleMessage.mock.calls[0]?.[0] instanceof Date,
    `the commit must carry the chosen instant, carried ${String(onScheduleMessage.mock.calls[0]?.[0])}`,
  );
});

test('(d) the commands item still carries the slash-command count badge', () => {
  const { view } = renderComposer(MOBILE_WIDTH, { slashCommandsCount: 7 });
  const menu = openMoreMenu(view);
  const commands = within(menu).getByRole('menuitem', { name: new RegExp(enChat.input.showAllCommands) });

  assert.ok(
    within(commands).queryByText('7'),
    `the commands item must show its count; it reads "${commands.textContent ?? ''}"`,
  );
});

test('(e) the schedule item is disabled while the box is empty and available once it holds text', () => {
  const empty = renderComposer(MOBILE_WIDTH);
  const emptyRow = within(openMoreMenu(empty.view)).getByRole('menuitem', { name: enChat.schedule.trigger });
  assert.ok(
    emptyRow.hasAttribute('disabled') || emptyRow.getAttribute('aria-disabled') === 'true',
    `an empty box must leave scheduling unavailable; the row reads ${emptyRow.outerHTML}`,
  );
  empty.view.unmount();

  const filled = renderComposer(MOBILE_WIDTH, { input: 'later', hasInput: true });
  const filledRow = within(openMoreMenu(filled.view)).getByRole('menuitem', { name: enChat.schedule.trigger });
  assert.equal(
    filledRow.hasAttribute('disabled') || filledRow.getAttribute('aria-disabled') === 'true',
    false,
    `text in the box must make scheduling available; the row reads ${filledRow.outerHTML}`,
  );
});

test('(f) reaching the picker never leaves two overlays open, and closing returns focus to the trigger', () => {
  const { view } = renderComposer(MOBILE_WIDTH, { input: 'later', hasInput: true });
  const trigger = view.getByRole('button', { name: enChat.input.moreTools });

  fireEvent.click(trigger);
  assert.equal(
    openOverlays().length,
    1,
    `the menu must be the only overlay open; open overlays read ${openOverlays().length}`,
  );

  fireEvent.click(view.getByRole('menuitem', { name: enChat.schedule.trigger }));
  assert.equal(
    openOverlays().length,
    1,
    `the picker lives in the menu's own surface, so it must not add a second overlay; open overlays read ${openOverlays().length}`,
  );
  assert.ok(
    view.queryByRole('menuitemradio', { name: new RegExp(enChat.schedule.in['15']) }),
    'the picker must actually be showing, or the reading above is about nothing',
  );

  fireEvent.keyDown(document, { key: 'Escape' });

  assert.equal(
    openOverlays().length,
    0,
    `closing must leave nothing open; open overlays read ${openOverlays().length}`,
  );
  assert.equal(
    document.activeElement,
    trigger,
    'closing from the picker must return focus to the "more" trigger',
  );
});

test('(g) a clip leaves exactly one accessible replay control per track, in each tier', () => {
  // The pair is drawn at narrow widths in a row of its own and from `md` up in the left tool group —
  // one renderer switched by `isMobile`, not two DOM copies with one hidden by a class. That is the
  // mechanism under test: with a single copy there is no second one for the accessibility tree to
  // have to hide, and the count below is the reading that says so. (A two-copy implementation would
  // have to make this file parse a `display:none` rule to keep the count at one; nothing here has to
  // read CSS, which is the observable difference between the two mechanisms.)
  clipFixture.slot = CLIP_PAIR;
  const readings: string[] = [];

  for (const tier of [
    { label: 'narrow (390px)', width: MOBILE_WIDTH },
    { label: 'wide (1280px)', width: DESKTOP_WIDTH },
  ]) {
    const { view } = renderComposer(tier.width);
    // `queryAllByRole` is `getAllByRole`'s accessible-elements query in its non-throwing form: a
    // count of zero is a reading here rather than a caught error, which is what lets the failure
    // message print the number — and a composer that never rendered would otherwise report the same
    // thing as one that rendered two copies.
    const original = view.queryAllByRole('button', { name: 'Replay original' });
    const trimmed = view.queryAllByRole('button', { name: 'Replay trimmed' });
    readings.push(
      `${tier.label}: Replay original=${original.length}, Replay trimmed=${trimmed.length}`,
    );

    assert.equal(
      original.length,
      1,
      `each tier must expose exactly one accessible "Replay original"; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      trimmed.length,
      1,
      `each tier must expose exactly one accessible "Replay trimmed"; readings: ${readings.join(' | ')}`,
    );

    view.unmount();
  }
});

test('(h) a running turn offers exactly one stop entry on every tier, and it is the composer submit', () => {
  const readings: string[] = [];

  for (const tier of [
    // The status is the transcript's own in-flow line at every viewport now, and it
    // carries no control: the composer's submit is the one stop entry, on the phone,
    // on the short landscape viewport, and on the desktop alike. The old arrangement
    // gave the wide tall viewport a second Stop on a tab the composer hung over the
    // transcript; this matrix is what keeps that second entry from coming back.
    { label: 'narrow (390px)', width: MOBILE_WIDTH, height: 900, touchOnly: false },
    { label: 'short and wide (844x330, touch)', width: LANDSCAPE_WIDTH, height: LANDSCAPE_HEIGHT, touchOnly: true },
    { label: 'wide and tall (1280px)', width: DESKTOP_WIDTH, height: 900, touchOnly: false },
  ]) {
    const { view } = renderTurn(tier.width, { height: tier.height, touchOnly: tier.touchOnly });
    const form = view.container.querySelector('form[data-slot="prompt-input"]');
    assert.ok(
      form,
      'the composer must render its PromptInput form, or "which control is the submit" has no answer to read',
    );

    const stops = stopButtons(view.container);
    // The submit button is the one stop entry that lives inside the composer's own form;
    // anything else offering a stop would be a second surface's control.
    const inForm = stops.filter((button) => form.contains(button));
    const outsideForm = stops.filter((button) => !form.contains(button));
    readings.push(
      `${tier.label}: ${stops.length} stop(s) [${nameStops(stops)}], ${outsideForm.length} outside the composer's own submit`,
    );

    assert.equal(
      stops.length,
      1,
      `every tier must offer exactly one stop entry; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      inForm.length,
      1,
      `the composer's own submit must be that entry on every tier; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      inForm[0]?.getAttribute('aria-label'),
      enChat.input.stop,
      `the surviving entry must be the composer's submit control, not a same-named second one; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      outsideForm.length,
      0,
      `no surface behind the submit may offer a stop any more; readings: ${readings.join(' | ')}`,
    );

    // The turn is still *shown* on every tier: the status is the pane's line and the
    // composer draws no dock. Without this the count above would read the same for a
    // page that showed the turn nowhere.
    assert.equal(
      view.container.querySelector(`${PANE_SELECTOR} ${ACTIVITY_DOCK}`) !== null,
      true,
      `the pane must draw the status line at ${tier.label}; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      view.container.querySelector(`.chat-composer-shell ${ACTIVITY_DOCK}`),
      null,
      `the composer must draw no status surface at ${tier.label}; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      view.container.querySelectorAll(ACTIVITY_DOCK).length,
      1,
      `exactly one dock on the page at ${tier.label}; readings: ${readings.join(' | ')}`,
    );

    view.unmount();
  }
});

test('(i) the surviving stop entry names the Esc key and keeps its accessible name', () => {
  // The Esc hint used to live on the tab's own Stop. It survives the tab's removal
  // on the one control that still stops the turn, and the accessible name a reader
  // finds the button by is unchanged.
  const { view } = renderTurn(DESKTOP_WIDTH, { height: 900 });
  const submit = within(view.container).getByRole('button', { name: enChat.input.stop });

  assert.equal(
    submit.getAttribute('aria-label'),
    enChat.input.stop,
    `the stop entry's accessible name must be unchanged; it reads ${JSON.stringify(submit.getAttribute('aria-label'))}`,
  );
  const title = submit.getAttribute('title') ?? '';
  assert.ok(
    /esc/i.test(title),
    `the stop entry's tooltip must name the Escape key; it reads ${JSON.stringify(title)}`,
  );
  view.unmount();
});

test('(j) unreachable: the one stop entry is disabled and says why', () => {
  // With the server gone the composer's stop entry is greyed, and the reason is
  // visible on the control itself — the read the dock used to carry, moved onto the
  // control that now owns the stop. The pane still shows the connection's sentence.
  const unreachable = {
    ws: null,
    sendMessage: () => undefined,
    subscribe: () => () => undefined,
    isConnected: false,
  };
  const view = render(
    <WebSocketContext.Provider value={unreachable as never}>
      {turnElement(DESKTOP_WIDTH, { height: 900 })}
    </WebSocketContext.Provider>,
  );

  const submit = within(view.container).getByRole('button', { name: enChat.input.stop });
  const title = submit.getAttribute('title') ?? '';
  const readings = `disabled=${submit.hasAttribute('disabled')} title=${JSON.stringify(title)}`;
  assert.ok(
    submit.hasAttribute('disabled'),
    `the stop must be disabled while the server is unreachable; readings: ${readings}`,
  );
  assert.ok(
    title.includes(enChat.claudeStatus.unreachable.stopReason),
    `the disabled stop must carry a visible reason; readings: ${readings}`,
  );
  assert.equal(
    view.container.querySelectorAll(ACTIVITY_DOCK).length,
    1,
    `the pane's status line is still the one surface, reading the connection; readings: ${readings}`,
  );
  assert.ok(
    (view.container.textContent ?? '').includes(enChat.claudeStatus.unreachable.title),
    `the status line must say the connection is lost; readings: ${readings}`,
  );
  view.unmount();
});

test('(k) a pending permission request takes the status over: neither tier draws an activity surface', () => {
  // Read on a pair rendered with the request already on screen, so the status belongs to
  // the request from the first commit and the case holds that the two never coexist — no
  // clock, and no exit animation to wait out. That those surfaces do exist while the turn
  // is running is case (h)'s reading, taken on these same two widths: between them, a
  // surface that vanished cannot be told apart from one that was never drawn.
  const readings: string[] = [];

  for (const tier of [
    { label: 'narrow (390px)', width: MOBILE_WIDTH },
    { label: 'wide (1280px)', width: DESKTOP_WIDTH },
  ]) {
    const view = render(turnElement(tier.width, { pendingPermissionRequests: [PENDING_PERMISSION] }));

    // Premise: the request's own surface is what took the status over. Without this the
    // two absences below would also be read for a pair that never rendered at all.
    assert.ok(
      view.container.textContent?.includes('Permission required'),
      `premise: the pending request must be on screen at ${tier.label}, or the absences below are about nothing`,
    );

    const dock = view.container.querySelector(ACTIVITY_DOCK);
    readings.push(`${tier.label}: dock=${dock ? 'present' : 'absent'}`);

    assert.equal(
      dock,
      null,
      `the request's own surface must replace the dock, on either mount site; readings: ${readings.join(' | ')}`,
    );

    view.unmount();
  }
});
