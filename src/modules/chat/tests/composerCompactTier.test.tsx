import assert from 'node:assert/strict';

import { act, fireEvent, render, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import type { MutableRefObject } from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { COMPACT_TIER_WIDTH_PX, INLINE_TOOLS_MIN_BOX_PX } from '@/modules/chat/hooks/useComposerCompactTier';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { VoiceClipSlot } from '@/shared/types';

/**
 * The composer's footer was arranged by the window width alone, and a window 768px wide with the
 * sidebar open leaves the input box 445px — narrow enough that one recording's replay pair pushed
 * the two control groups onto separate rows (the browser probe read the groups' tops 36px apart,
 * and 72px apart with a pair). The window was never the wrong number to ask about the *device*;
 * it is the wrong number to ask about the *box*, which the sidebar, its drag, and the chat
 * column's own cap all resize while the window stands still.
 *
 * So the tier now reads two signals — the window's `md` rule, and the box's own measured width —
 * and these cases are about the second one. jsdom lays nothing out, so the box's width is not
 * something a render can produce: it is *given* here, by a getter over the form's `clientWidth`
 * (the number the hook reads) that the cases can move, and a `ResizeObserver` double that drives
 * the re-measure the way a real one drives it after a sidebar drag. Every case therefore reads one
 * thing: which signal the composer's footer is arranged by, and which controls that arrangement
 * puts in it.
 *
 * What jsdom still cannot answer — whether the box really fits its row — is the browser probe's
 * job, and the threshold it produced is the number the cells below straddle.
 */

/** The box the composer arranges in. */
const FORM_SELECTOR = 'form[data-slot="prompt-input"]';
const BODY_SELECTOR = '[data-slot="prompt-input-body"]';
const FOOTER_SELECTOR = '[data-slot="prompt-input-footer"]';
/** The left control group: where the replay pair lives on the wide tier. */
const TOOLS_SELECTOR = '[data-slot="prompt-input-tools"]';
/** The row of its own the replay pair gets on the compact tier. */
const CLIP_ROW_SELECTOR = '[data-slot="prompt-input-clip-row"]';

/** The window rule's two sides: one pixel under `md`, and a window with room to spare. */
const NARROW_EDGE_WIDTH = 767;
const DESKTOP_WIDTH = 1280;

/** The box the 1280px window leaves with the sidebar open and with it closed — the probe's own readings. */
const BOX_WITH_SIDEBAR_OPEN = 445;
const BOX_WITH_SIDEBAR_CLOSED = 866;

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default: keeps this whole-module replacement complete.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
}));

/**
 * The clip the composer is holding. The capture chain is not what these cases are about — the
 * footer's arrangement in the presence of a pair is — so the slot is a fixture the cases set,
 * exactly as the responsive cases next door do.
 */
const { clipFixture } = vi.hoisted(() => ({
  clipFixture: { slot: null as VoiceClipSlot | null, toggle: vi.fn() },
}));

vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    toggle: clipFixture.toggle,
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
    url: 'blob:tier-original',
    meta: { bytes: 6_400, mimeType: 'audio/webm', durationMs: 9_000 },
  },
  trimmed: {
    url: 'blob:tier-trimmed',
    meta: { bytes: 32_000, mimeType: 'audio/wav', durationMs: 4_000 },
  },
};

/**
 * The box's width, as the hook's own reading is taken: the form's `clientWidth`.
 *
 * jsdom answers 0 for every element, so the number is supplied here — over the prototype because
 * the hook measures on mount, before a case could reach the rendered node. `width` is read on
 * every access, which is what lets a case move it and re-measure.
 */
const box = { width: 0 };

const installBoxWidth = (width: number) => {
  box.width = width;
  Object.defineProperty(HTMLFormElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => box.width,
  });
};

/**
 * The observer double, shaped like the one the activity-indicator cases use: the callback is held
 * so a case can fire it, and the observed elements are kept so a case can read what was observed.
 */
class FakeResizeObserver {
  static latest: FakeResizeObserver | null = null;
  readonly observed: Element[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.latest = this;
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {
    return undefined;
  }

  disconnect() {
    this.observed.length = 0;
  }

  /** One delivery, as a real observer would make after the box changed size. */
  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const installObserver = () => {
  FakeResizeObserver.latest = null;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
};

/** The signal the composer reads for the window rule, so a renamed source of truth fails these cases. */
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

/**
 * The signal the composer reads for the *height* rule.
 *
 * jsdom's own window is 1024x768, which is the tall tier — so every case that does not call this
 * keeps the arrangement it had before the height tier existed, and the cases below that do call it
 * are the only ones that can reach the new one.
 */
const setViewportHeight = (height: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
};

/** A viewport tall enough that nothing about it is short, and one of each landscape phone's heights. */
const TALL_HEIGHT = 900;
const LANDSCAPE_HEIGHT = 330;

/**
 * The device the render is on.
 *
 * The short tier is read from the viewport's height *and* the device, so a double that answered
 * "no" to everything would leave the tier unreachable and every case below passing for a reason
 * none of them declares — including the cases that assert the tier is NOT taken, which are only
 * meaningful when the device is one the tier applies to. `renderComposer` sets it per case, and the
 * `matches` getter reads it live, as a real `MediaQueryList` does.
 */
const device = { touchOnly: false };
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

/** jsdom implements no media queries; the double answers the device query and "no" to the rest. */
const installMatchMedia = () => {
  window.matchMedia = ((query: string) => {
    const isTouchQuery = query === TOUCH_ONLY_QUERY;
    return {
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

let matchMediaInstalled = false;
const injectMatchMediaOnce = () => {
  if (matchMediaInstalled) return;
  installMatchMedia();
  matchMediaInstalled = true;
};

const baseProps = (options: { dropzoneRef?: MutableRefObject<HTMLFormElement | null> } = {}) => ({
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
  availableEffortOptions: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
  onSelectEffort: () => undefined,
  model: 'claude-sonnet-4-5-20250929',
  availableModelOptions: [{ value: 'claude-sonnet-4-5-20250929', label: 'claude-sonnet-4-5-20250929' }],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: vi.fn(),
  slashCommandsCount: 0,
  onToggleCommandMenu: vi.fn(),
  hasInput: false,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  // The shipping footer's row carries the Suggest control (icon on this tier) whenever the
  // feature is on; the arrangement cases must measure that row, not one missing a control.
  replySuggestionsEnabled: true,
  replySuggestionsLoading: false,
  onRequestReplySuggestions: vi.fn(),
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
  // The real `getRootProps` hands back a `ref` inside these props, and the composer spreads them
  // onto the form. By default the double is empty — the cases above are about the arrangement, not
  // about the refs — and case (g) is the one that makes them carry a ref.
  getRootProps: () => (options.dropzoneRef ? { ref: options.dropzoneRef } : {}),
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
 * What the footer's arrangement is, read from the structure the CSS then lays out.
 *
 * `compact` is the arrangement's own entry: the three controls that moved behind it are absent
 * from the footer exactly when it is. The wrap token is read beside it because the two are one
 * branch — a composer that drew the compact controls inside the wide row would read `compact` and
 * `flex-wrap` at once, which is not a state the component has.
 */
const readFooter = (footer: Element) => {
  const inFooter = (name: string) => within(footer as HTMLElement).queryByRole('button', { name }) !== null;
  return {
    compact: inFooter(enChat.input.moreTools),
    inlineControls: [enChat.input.showAllCommands, enChat.schedule.trigger, enChat.misc.showTokenUsage]
      .filter(inFooter),
    wrapTokens: Array.from(footer.classList).filter((name) => /^flex-(?:wrap|nowrap)$/.test(name)),
  };
};

const describeArrangement = (footer: Element) => {
  const names = Array.from(footer.querySelectorAll('button'))
    .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '<unnamed>')
    .join(' | ');
  return `${JSON.stringify(readFooter(footer))} controls: ${names}`;
};

/**
 * What the height tier's arrangement is, read from the structure the CSS then lays out.
 *
 * Three readings, one branch each: the form becomes the row, the body takes the slack the footer
 * gave up, and the footer's divider moves from the top edge to the leading edge. A composer that
 * drew the controls beside the input without moving the divider would read the first and not the
 * last, and that is not a state this component has — so a cell that asserts only one of them would
 * pass against a half-applied arrangement.
 *
 * The form's own reading is the grid, not a `flex-row`, and that is not a style preference: a
 * session that is not already resident draws the switch's row above the input, and in a flex row
 * that row is simply the first column — it took the input's width (0px measured) and the controls
 * sat where the input should have been. A wrapping row is worse, not better: it breaks its lines
 * from the items' *content* sizes before shrinking anything, so a wide enough control cluster moved
 * the input onto a line of its own and the arrangement became the stacked one while still reporting
 * `display: flex`. Both of those are one class token away from the arrangement this case reads, so
 * the tokens are what it asserts.
 */
const readInlineRow = (form: HTMLFormElement) => {
  const body = form.querySelector<HTMLElement>(BODY_SELECTOR);
  const footer = form.querySelector<HTMLElement>(FOOTER_SELECTOR);
  return {
    formIsRow: form.classList.contains('grid')
      && form.classList.contains('grid-cols-[minmax(0,1fr)_auto]')
      && form.classList.contains('items-end'),
    bodyTakesSlack: body !== null
      && body.classList.contains('min-w-0')
      && body.classList.contains('flex-col'),
    footerDividerMoved: footer !== null
      && footer.classList.contains('border-l')
      && footer.classList.contains('border-t-0'),
  };
};

const describeInlineRow = (form: HTMLFormElement) => JSON.stringify(readInlineRow(form));

type RenderOptions = {
  /** The window width the render sees. */
  viewport: number;
  /** The window height the render sees. Defaults to the tall tier, which is jsdom's own window. */
  viewportHeight?: number;
  /**
   * The device the render sees. Defaults to a mouse-and-keyboard one, which is what the width cases
   * were written against; the short-tier cases set it, because a short *window* on a desktop is
   * deliberately not the tier and a case that forgot this would pass for the wrong reason.
   */
  touchOnly?: boolean;
  /**
   * The box's measured width, or null for a box that cannot be measured — the jsdom default, and
   * what an element that has not been laid out reports.
   */
  boxWidth: number | null;
  /** Whether a `ResizeObserver` exists at all. */
  withObserver?: boolean;
  clip?: VoiceClipSlot | null;
  /**
   * The ref the dropzone's own root props carry, when their shape is being read rather than
   * stubbed away. Absent by default: an empty props object is what the other cases pass.
   */
  dropzoneRef?: MutableRefObject<HTMLFormElement | null>;
};

const renderComposer = ({
  viewport,
  viewportHeight = TALL_HEIGHT,
  touchOnly = false,
  boxWidth,
  withObserver = true,
  clip = null,
  dropzoneRef,
}: RenderOptions) => {
  injectMatchMediaOnce();
  setViewportWidth(viewport);
  setViewportHeight(viewportHeight);
  device.touchOnly = touchOnly;
  if (boxWidth === null) {
    // The box reports 0, which is what "not laid out yet" looks like.
    installBoxWidth(0);
  } else {
    installBoxWidth(boxWidth);
  }
  if (withObserver) installObserver();
  clipFixture.slot = clip;

  const view = render(
    React.createElement(ChatComposer, { ...baseProps({ dropzoneRef }) } as React.ComponentProps<typeof ChatComposer>),
  );
  const footer = view.container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  const form = view.container.querySelector<HTMLFormElement>(FORM_SELECTOR);
  assert.ok(footer, `the composer must render a footer (${FOOTER_SELECTOR})`);
  assert.ok(form, `the composer must render its input box (${FORM_SELECTOR})`);

  return { view, footer, form };
};

/** The clip row, if the composer drew one. */
const clipRowOf = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLElement>(CLIP_ROW_SELECTOR);

const clipButtonsIn = (root: Element) => root.querySelectorAll('[data-clip-url]').length;

/** Generated ids differ between mounts and say nothing about structure; the rest is compared as is. */
const normalizeIds = (markup: string) =>
  markup.replace(/\s(id|aria-controls|aria-labelledby|aria-describedby)="[^"]*"/g, ' $1="#"');

beforeEach(() => {
  clipFixture.slot = null;
  box.width = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLFormElement.prototype as { clientWidth?: number }).clientWidth;
  FakeResizeObserver.latest = null;
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

test('(a) a wide window with a box under the threshold takes the compact arrangement', () => {
  const { footer } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_OPEN,
    clip: CLIP_PAIR,
  });

  const reading = describeArrangement(footer);
  assert.equal(readFooter(footer).compact, true, `a ${BOX_WITH_SIDEBAR_OPEN}px box must be compact; ${reading}`);
  assert.deepEqual(
    readFooter(footer).inlineControls,
    [],
    `commands, schedule and token usage must not stay in the footer; ${reading}`,
  );
  assert.deepEqual(readFooter(footer).wrapTokens, ['flex-nowrap'], `the compact row may not wrap; ${reading}`);
});

test('(a) with a pair, the compact arrangement puts the replay row before the footer and nothing in the tools group', () => {
  const { view, footer } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_OPEN,
    clip: CLIP_PAIR,
  });

  const row = clipRowOf(view);
  assert.ok(row, 'the compact arrangement must draw the replay pair a row of its own');
  assert.equal(clipButtonsIn(row), 2, `both tracks belong to that row; it holds ${clipButtonsIn(row)}`);
  // The row sits between the box and the footer: the footer must come after it.
  assert.equal(
    (row.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    true,
    'the replay row must come before the footer, so the footer keeps its own row',
  );
  const tools = footer.querySelector(TOOLS_SELECTOR);
  assert.ok(tools, `the footer must render its tool group (${TOOLS_SELECTOR})`);
  assert.equal(
    clipButtonsIn(tools),
    0,
    `the compact footer's tool group must hold no replay control; it holds ${clipButtonsIn(tools)}`,
  );
});

test('(b) a wide window with a box over the threshold keeps the wide arrangement', () => {
  const { view, footer } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_CLOSED,
    clip: CLIP_PAIR,
  });

  const reading = describeArrangement(footer);
  assert.equal(readFooter(footer).compact, false, `a ${BOX_WITH_SIDEBAR_CLOSED}px box must stay wide; ${reading}`);
  assert.deepEqual(
    readFooter(footer).inlineControls,
    [enChat.input.showAllCommands, enChat.schedule.trigger, enChat.misc.showTokenUsage],
    `commands, schedule and token usage stay inline on the wide tier; ${reading}`,
  );
  assert.equal(readFooter(footer).wrapTokens.includes('flex-wrap'), true, `the wide row may wrap; ${reading}`);

  assert.equal(clipRowOf(view), null, 'the wide tier must not draw the compact replay row');
  const tools = footer.querySelector(TOOLS_SELECTOR);
  assert.ok(tools, `the footer must render its tool group (${TOOLS_SELECTOR})`);
  assert.equal(
    clipButtonsIn(tools),
    2,
    `the wide tier keeps both replay controls in the tool group; it holds ${clipButtonsIn(tools)}`,
  );
});

test('(c) a narrow window stays compact however wide the box measures', () => {
  const { footer } = renderComposer({
    viewport: NARROW_EDGE_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_CLOSED,
    clip: CLIP_PAIR,
  });

  const reading = describeArrangement(footer);
  assert.equal(
    readFooter(footer).compact,
    true,
    `the window's own rule decides below md, whatever the box measures; ${reading}`,
  );
  assert.deepEqual(
    readFooter(footer).inlineControls,
    [],
    `the three wide-only controls must not appear in a narrow window; ${reading}`,
  );
});

test('(d) the threshold is one cell wide: the constant minus one is compact, the constant is wide', () => {
  const narrow = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: COMPACT_TIER_WIDTH_PX - 1 });
  assert.equal(
    readFooter(narrow.footer).compact,
    true,
    `a box of ${COMPACT_TIER_WIDTH_PX - 1}px must be compact; ${describeArrangement(narrow.footer)}`,
  );
  narrow.view.unmount();

  const atThreshold = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: COMPACT_TIER_WIDTH_PX });
  assert.equal(
    readFooter(atThreshold.footer).compact,
    false,
    `a box of exactly ${COMPACT_TIER_WIDTH_PX}px must be wide; ${describeArrangement(atThreshold.footer)}`,
  );
});

test('(e) an unmeasured box leaves the window rule alone, and the structure byte-identical', () => {
  // The reference: jsdom's own defaults, no observer and a box that reports 0 — the render every
  // other case in this file would produce if the measurement never happened.
  const reference = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: null, withObserver: false });
  const referenceMarkup = normalizeIds(reference.footer.outerHTML);
  assert.equal(readFooter(reference.footer).compact, false, 'the reference render must be the wide one for this to read');
  reference.view.unmount();

  // A box that cannot be measured at all: no observer exists, so the hook never asks.
  const noObserver = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: BOX_WITH_SIDEBAR_OPEN, withObserver: false });
  assert.equal(
    readFooter(noObserver.footer).compact,
    false,
    'without a ResizeObserver the window rule is the whole answer, so a narrow box cannot matter',
  );
  assert.equal(
    normalizeIds(noObserver.footer.outerHTML),
    referenceMarkup,
    'an unmeasurable box must leave the footer structurally identical to the window-only render',
  );
  noObserver.view.unmount();

  // An observer that exists but reports a box with no width yet: 0 is "not laid out", not "narrow".
  const zeroWidth = renderComposer({ viewport: DESKTOP_WIDTH, boxWidth: null, withObserver: true });
  assert.equal(
    readFooter(zeroWidth.footer).compact,
    false,
    'a box that has not been laid out reads 0 and must not be taken for a narrow one',
  );
  assert.equal(
    normalizeIds(zeroWidth.footer.outerHTML),
    referenceMarkup,
    'a zero-width box must leave the footer structurally identical to the window-only render',
  );
  zeroWidth.view.unmount();

  // And the window rule still decides on its own when nothing is measured: 767 is compact.
  const narrow = renderComposer({ viewport: NARROW_EDGE_WIDTH, boxWidth: BOX_WITH_SIDEBAR_OPEN, withObserver: false });
  assert.equal(
    readFooter(narrow.footer).compact,
    true,
    'with nothing measured, a narrow window must still take the compact arrangement',
  );
});

test('(f) a box that changes width flips the arrangement without remounting, and flips back', () => {
  const { footer, form, view } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_CLOSED,
    clip: CLIP_PAIR,
  });

  const observer = FakeResizeObserver.latest;
  assert.ok(observer, 'the composer must install an observer to watch its box');
  assert.equal(
    observer.observed.includes(form),
    true,
    'the observer must be watching the composer\'s own box, or a flip could not reach it',
  );

  assert.equal(readFooter(footer).compact, false, `the ${BOX_WITH_SIDEBAR_CLOSED}px box must start wide`);
  // A mark on the node itself: a remount would replace the element and lose it, so the flip below
  // is read as a re-render of this same box rather than as a new one that happens to be narrow.
  form.dataset.tierProbe = 'first-box';
  const stamp = form;

  // A sidebar drag: the box narrows while the window stands still.
  act(() => {
    box.width = BOX_WITH_SIDEBAR_OPEN;
    observer.emit();
  });
  assert.equal(
    readFooter(footer).compact,
    true,
    `a box dragged to ${BOX_WITH_SIDEBAR_OPEN}px must flip to compact; ${describeArrangement(footer)}`,
  );
  assert.equal(
    view.container.querySelector<HTMLFormElement>(FORM_SELECTOR),
    stamp,
    'the flip must re-render the same box, not remount the composer',
  );
  assert.equal(
    view.container.querySelector<HTMLFormElement>(FORM_SELECTOR)?.dataset.tierProbe,
    'first-box',
    'the mark on the box must survive the flip',
  );

  // And back the other way, with the pair's row leaving as it goes.
  act(() => {
    box.width = BOX_WITH_SIDEBAR_CLOSED;
    observer.emit();
  });
  assert.equal(
    readFooter(footer).compact,
    false,
    `a box dragged back to ${BOX_WITH_SIDEBAR_CLOSED}px must flip back to wide; ${describeArrangement(footer)}`,
  );
  assert.equal(clipRowOf(view), null, 'flipping back to wide must take the compact replay row away');
  assert.equal(
    view.container.querySelector<HTMLFormElement>(FORM_SELECTOR)?.dataset.tierProbe,
    'first-box',
    'the same box must still be the one on screen after flipping back',
  );
});

test('(g) the box is measured even when the dropzone’s root props carry a ref of their own', () => {
  // react-dropzone's root props put a `ref` in the object the composer spreads onto the form, and a
  // `ref=` written beside a spread is replaced by the one inside it — so the tier hook's box goes
  // unmeasured and the whole arrangement silently falls back to the window rule, which is what the
  // browser read until both refs were attached from one callback. The cases above pass an empty
  // props object and so cannot see it; this one renders with the shape the real props have.
  const dropzoneRef: MutableRefObject<HTMLFormElement | null> = { current: null };
  const { footer, form } = renderComposer({
    viewport: DESKTOP_WIDTH,
    boxWidth: BOX_WITH_SIDEBAR_OPEN,
    clip: CLIP_PAIR,
    dropzoneRef,
  });

  assert.equal(
    readFooter(footer).compact,
    true,
    `the box must be measured with the dropzone's ref in the props; ${describeArrangement(footer)}`,
  );
  assert.equal(
    dropzoneRef.current,
    form,
    'the dropzone\'s own root ref must still reach the form it was handed',
  );
});

test('(h) a short viewport with a box wide enough draws the controls beside the input', () => {
  // The tier this file did not have until now: height. A landscape phone is 844px wide, so the
  // width rules hand it a desktop box — and ~330px tall, so the row the footer occupies is 17% of
  // the screen. Beside the input it costs nothing, because the input is already that tall.
  const { footer, form } = renderComposer({
    viewport: DESKTOP_WIDTH,
    viewportHeight: LANDSCAPE_HEIGHT,
    touchOnly: true,
    boxWidth: INLINE_TOOLS_MIN_BOX_PX,
    clip: CLIP_PAIR,
  });

  assert.deepEqual(
    readInlineRow(form),
    { formIsRow: true, bodyTakesSlack: true, footerDividerMoved: true },
    `a ${LANDSCAPE_HEIGHT}px-tall viewport with a ${INLINE_TOOLS_MIN_BOX_PX}px box must draw the
     controls beside the input; ${describeInlineRow(form)}`,
  );
  assert.equal(
    readFooter(footer).compact,
    true,
    `the row beside the input is still the compact six-control row; ${describeArrangement(footer)}`,
  );
  // The clip row leaves the flow between the box and the footer, because on this tier a sibling of
  // the body would become a third column of the form's row.
  assert.equal(
    form.querySelector<HTMLElement>(BODY_SELECTOR)?.querySelector(CLIP_ROW_SELECTOR) !== null,
    true,
    'the replay row must move inside the body on the inline tier, not sit between two columns',
  );
  assert.equal(
    form.querySelectorAll(CLIP_ROW_SELECTOR).length,
    1,
    'the replay row must still be drawn exactly once — moving it must not add a second copy',
  );
  assert.equal(
    clipButtonsIn(form),
    2,
    'both tracks of the recording must still be reachable from their new column',
  );
});

test('(i) one pixel under the threshold, and the stacked arrangement is kept', () => {
  // The fallback the tier is built around: below it the sidebar is open (or the viewport is
  // narrow), the box is too small for both, and a squeezed input is worse for the user who opened
  // the panel on purpose than a squeezed transcript.
  const { form } = renderComposer({
    viewport: DESKTOP_WIDTH,
    viewportHeight: LANDSCAPE_HEIGHT,
    touchOnly: true,
    boxWidth: INLINE_TOOLS_MIN_BOX_PX - 1,
  });

  assert.deepEqual(
    readInlineRow(form),
    { formIsRow: false, bodyTakesSlack: false, footerDividerMoved: false },
    `a box of ${INLINE_TOOLS_MIN_BOX_PX - 1}px must keep the stacked arrangement; ${describeInlineRow(form)}`,
  );
});

test('(j) a tall touch viewport keeps the stacked arrangement however wide the box is', () => {
  // One half of the tier's guard, and the device is set on purpose: with a mouse the case would
  // pass for the device half alone and say nothing about the height. A touch device with the height
  // to spare keeps the arrangement the whole suite read before this tier existed.
  const { form } = renderComposer({
    viewport: DESKTOP_WIDTH,
    viewportHeight: TALL_HEIGHT,
    touchOnly: true,
    boxWidth: BOX_WITH_SIDEBAR_CLOSED,
  });

  assert.deepEqual(
    readInlineRow(form),
    { formIsRow: false, bodyTakesSlack: false, footerDividerMoved: false },
    `a ${TALL_HEIGHT}px-tall touch viewport must keep the stacked arrangement; ${describeInlineRow(form)}`,
  );
});

test('(j) a short window on a mouse-and-keyboard device is not the tier either', () => {
  // The other half, and the one that shipped broken: DevTools docked to the bottom leaves a desktop
  // window 450px tall, and the phone's inline row taken there put the composer's keyboard hint — a
  // row a touch device never draws, because it is hidden at every width — into the footer's line,
  // where it took 467px of an 866px composer and left the input 138px wide.
  const { form } = renderComposer({
    viewport: 1440,
    viewportHeight: 450,
    touchOnly: false,
    boxWidth: 866,
  });

  assert.deepEqual(
    readInlineRow(form),
    { formIsRow: false, bodyTakesSlack: false, footerDividerMoved: false },
    `a short window on a mouse device must keep the desktop arrangement; ${describeInlineRow(form)}`,
  );
});

test('(k) an unmeasured box leaves a short viewport stacked, and the clip row where it was', () => {
  // Same direction as case (e): the first render cannot know the box will fit, so it draws the
  // arrangement that is safe when it does not. The observer's first measurement arrives before
  // anything is painted, so this is a shape the user never sees — but it is the shape a render
  // without a `ResizeObserver` keeps, and it must not be the inline one.
  const { form } = renderComposer({
    viewport: DESKTOP_WIDTH,
    viewportHeight: LANDSCAPE_HEIGHT,
    touchOnly: true,
    boxWidth: null,
    withObserver: false,
    clip: CLIP_PAIR,
  });

  assert.deepEqual(
    readInlineRow(form),
    { formIsRow: false, bodyTakesSlack: false, footerDividerMoved: false },
    `an unmeasured box must keep the stacked arrangement; ${describeInlineRow(form)}`,
  );
  assert.equal(
    form.querySelector<HTMLElement>(BODY_SELECTOR)?.querySelector(CLIP_ROW_SELECTOR),
    null,
    'the replay row must stay between the box and the footer while the arrangement is stacked',
  );
});

test('(l) the dictation mic and Live Voice are two separate controls inside the footer, mic first', () => {
  const onLiveVoice = vi.fn();
  clipFixture.toggle.mockClear();
  injectMatchMediaOnce();
  setViewportWidth(DESKTOP_WIDTH);
  setViewportHeight(TALL_HEIGHT);
  installBoxWidth(BOX_WITH_SIDEBAR_CLOSED);
  const view = render(
    React.createElement(ChatComposer, {
      ...baseProps(),
      onLiveVoice,
    } as React.ComponentProps<typeof ChatComposer>),
  );
  const footer = view.container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  assert.ok(footer);
  const mic = within(footer).getByTestId('voice-input-button');
  const live = within(footer).getByTestId('live-voice-button');
  assert.notStrictEqual(mic, live);
  assert.ok(mic.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING, 'Live Voice follows the mic');
  assert.equal(live.getAttribute('aria-label'), 'Start Live Voice');

  fireEvent.click(live);
  assert.equal(onLiveVoice.mock.calls.length, 1, 'Live Voice entry calls its own handler');
  assert.equal(clipFixture.toggle.mock.calls.length, 0, 'and never the dictation toggle');

  fireEvent.click(mic);
  assert.equal(onLiveVoice.mock.calls.length, 1, 'the dictation mic does not enter Live Voice');
  assert.equal(clipFixture.toggle.mock.calls.length, 1, 'it runs the dictation toggle');
});

test('(l) without a Live Voice handler the composer draws no Live Voice control', () => {
  injectMatchMediaOnce();
  setViewportWidth(DESKTOP_WIDTH);
  setViewportHeight(TALL_HEIGHT);
  installBoxWidth(BOX_WITH_SIDEBAR_CLOSED);
  const view = render(
    React.createElement(ChatComposer, { ...baseProps() } as React.ComponentProps<typeof ChatComposer>),
  );
  assert.equal(view.container.querySelector('[data-testid="live-voice-button"]'), null);
});

/**
 * The Live Voice entry while there is no session to bind to.
 *
 * A native `disabled` control carries `pointer-events: none`, so on a touch device the tap never
 * reaches it and nothing at all happens — the reader sees a correctly placed button that does
 * nothing, however many times they tap. These two cases pin the contract that replaced it: the
 * control stays hittable, and a tap that cannot start Live Voice answers with a visible reason
 * while the other controls are untouched.
 */
test('(l) an unavailable Live Voice entry still receives the tap and answers it visibly', () => {
  const onLiveVoice = vi.fn();
  injectMatchMediaOnce();
  setViewportWidth(DESKTOP_WIDTH);
  setViewportHeight(TALL_HEIGHT);
  installBoxWidth(BOX_WITH_SIDEBAR_CLOSED);
  const reason = 'Live Voice needs a conversation. Send a message first, then start Live Voice.';
  const view = render(
    React.createElement(ChatComposer, {
      ...baseProps(),
      onLiveVoice,
      liveVoiceDisabled: true,
      liveVoiceDisabledReason: reason,
    } as React.ComponentProps<typeof ChatComposer>),
  );

  const live = view.getByTestId('live-voice-button');

  // The regression itself, read off the DOM rather than off behaviour: `disabled` would make this
  // element unhittable on touch. The state is still reported to assistive tech, but the event must
  // not be swallowed — so the attribute that swallows it is the one under assertion here.
  assert.equal(live.hasAttribute('disabled'), false, 'an unavailable entry must not be natively disabled');
  assert.equal(live.getAttribute('aria-disabled'), 'true', 'the unavailable state is still announced');

  assert.equal(view.queryByTestId('live-voice-notice'), null, 'nothing is shown before the tap');

  fireEvent.click(live);

  const notice = view.getByTestId('live-voice-notice');
  assert.equal(notice.textContent, reason, 'the tap is answered with the reason it cannot start');
  assert.equal(notice.getAttribute('role'), 'status', 'and announced, not only drawn');
  assert.equal(onLiveVoice.mock.calls.length, 0, 'an unavailable entry does not start a voice session');

  // The neighbours keep their own behaviour: a dead-looking control must not cost the reader
  // the rest of the row.
  const mic = view.getByTestId('voice-input-button');
  clipFixture.toggle.mockClear();
  fireEvent.click(mic);
  assert.equal(clipFixture.toggle.mock.calls.length, 1, 'the dictation mic still toggles');
  assert.equal(onLiveVoice.mock.calls.length, 0);
});

test('(l) an available Live Voice entry starts the session and shows no notice', () => {
  const onLiveVoice = vi.fn();
  injectMatchMediaOnce();
  setViewportWidth(DESKTOP_WIDTH);
  setViewportHeight(TALL_HEIGHT);
  installBoxWidth(BOX_WITH_SIDEBAR_CLOSED);
  const view = render(
    React.createElement(ChatComposer, {
      ...baseProps(),
      onLiveVoice,
    } as React.ComponentProps<typeof ChatComposer>),
  );

  const live = view.getByTestId('live-voice-button');
  assert.equal(live.getAttribute('aria-disabled'), null, 'an available entry is not marked unavailable');

  fireEvent.click(live);

  assert.equal(onLiveVoice.mock.calls.length, 1, 'the ordinary entry is unchanged');
  assert.equal(view.queryByTestId('live-voice-notice'), null, 'and produces no notice');
});
