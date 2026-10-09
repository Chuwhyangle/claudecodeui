import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterAll, afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { createFakeVoiceCapture } from '@/modules/chat/tests/voiceCaptureTestHarness';
import enChat from '@/modules/i18n/locales/en/chat.json';
// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';

/**
 * The executable half of the browser criterion's three falsifications.
 *
 * `e2e/voice-error-messages.spec.ts` reads the shipping notice in a real browser: the sentence a
 * refusal gets, that it is still there four seconds later, that it goes away when it is closed, that
 * the draft survives, and that the page carries no concatenated transport sentence. Those readings
 * are only worth what they are worth if the implementations they are meant to reject would have
 * turned them red — and four browser runs (a baseline plus three mutants) do not fit in that
 * criterion's budget: one run costs ~24s against a 55s watchdog, so the mutants are taken here,
 * against the same shipped component, in jsdom, and the browser-level rig is deliberately NOT built.
 *
 * THE LEVER IS A PATCHED COPY OF THE SHIPPED FILE, imported from a temporary path in the source tree
 * and deleted when this file finishes. Three other levers were considered and rejected:
 *
 *   · A module double (`vi.mock('.../ChatComposer', factory)`) would have to *re-implement* the
 *     component to carry the mutation — the double is what would be read, not the shipped file.
 *   · Patching the module in place would leave the tree mutated if this file ever crashed mid-run,
 *     which is the one outcome that must not be possible.
 *   · An in-memory clone cannot be imported as a module without a data: URL, and a `.tsx` source is
 *     not transformed through one — the mutant would not be the shipped source under a JSX parser.
 *
 * What is left is the one the task's proposal names: a copy in the same tree, patched by an exact
 * string replacement, imported, read, and removed. Each mutation is therefore the SHIPPED source
 * plus one anchored edit and nothing else, and the copy is written and removed inside the case that
 * reads it, so `git status --porcelain` is the same before and after this file runs.
 *
 * Every case follows the same three steps, in this order: the unmutated copy is green first (so the
 * reading is known to be about the mutation rather than about the harness), the mutant turns exactly
 * one predicted reading red and prints which one, and a reading OUTSIDE that family stays green (so
 * "turned red" is not satisfied by a component that stopped rendering anything at all).
 */

const { transcribeVoice } = vi.hoisted(() => ({ transcribeVoice: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    transcribeVoice,
    // The raw-corpus upload the hook fires after a listen; doubled so this file's wholistic mock of
    // the module stays complete. It is never awaited, so a failed/absent one cannot affect a reading.
    captureRawVoice: vi.fn(),
    synthesizeVoice: vi.fn(),
    voiceConfigSignature: () => 'test-signature',
    // The recogniser's answer is read through the shipping parse; only the endpoint is cut, because
    // a second copy of the parse here would be a second copy of the thing the criteria read.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
    effectivePauseCuesDeclaration: () => actual.effectivePauseCuesDeclaration(),
  };
});

// The mic only renders when the backend says a voice provider is configured.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

// A plain install: no upload entry, the shipped segment minimum, and no idle override.
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default, so these cases still run the segmenting path.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
  voiceDebugMinSegmentSec: () => undefined,
  voiceDebugIdleSec: () => undefined,
  voiceDebugOriginalCapSec: () => undefined,
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

/** The copy every sentence reading is taken against: the shipped English file, at the leg's own code. */
const EXPECTED_CODE = 'MODEL_NOT_FOUND';
const EXPECTED_SENTENCE = (enChat as { voice: { errors: Record<string, string> } }).voice.errors[EXPECTED_CODE];

/* ─── The capture, faked ───────────────────────────────────────────── */

const fakeStream = { getTracks: () => [{ stop: () => undefined }] };
let objectUrlCount = 0;

/** The capture engine every render in this file is handed; recreated per case so no frame leaks. */
let capture = createFakeVoiceCapture();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  capture = createFakeVoiceCapture();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => fakeStream },
  });
  objectUrlCount = 0;
  URL.createObjectURL = (() => `blob:mutation-${++objectUrlCount}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as unknown as typeof URL.revokeObjectURL;
  transcribeVoice.mockReset();
  // A recogniser refusal, in the shape the browser criterion's stand-in answers with: a non-2xx
  // status and an envelope carrying the semantic code and the recogniser's own string.
  transcribeVoice.mockResolvedValue({
    ok: false,
    status: 404,
    clone: () => ({
      json: async () => ({
        error: 'The requested transcription model is not available.',
        code: EXPECTED_CODE,
        upstreamCode: 'ModelNotFound',
      }),
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ─── The composer, driven ─────────────────────────────────────────── */

type ComposerComponent = React.ComponentType<React.ComponentProps<typeof ChatComposer>>;

/**
 * Every prop `ChatComposer` requires except the three this harness supplies per render.
 *
 * The draft is the whole reason `input`/`onInputChange` are among them: the composer takes `input` as a
 * controlled value and reports every edit through `onInputChange`, exactly as the shipping parent wires it, so
 * "the draft survived the failure" is read off the textarea the user typed into rather than off a stub.
 * `voiceClipPlayback.test.tsx` carries the same list for the same reason; it is repeated rather than imported
 * because a fixture that moved under this file would move the reading with it.
 */
const composerProps: Omit<
  React.ComponentProps<typeof ChatComposer>,
  'input' | 'onInputChange' | 'onVoiceTranscript'
> = {
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
  availableEffortOptions: [],
  onSelectEffort: () => undefined,
  model: 'test-model',
  availableModelOptions: [],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: () => undefined,
  slashCommandsCount: 0,
  onToggleCommandMenu: () => undefined,
  hasInput: false,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDraft: null,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: () => undefined,
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
  scope: 'session-a',
  projectId: null,
  isActive: true,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Ask anything',
  isTextareaExpanded: false,
};

const ComposerHarness = ({ Composer, onVoiceTranscript }: {
  Composer: ComposerComponent;
  onVoiceTranscript: (text: string, send?: boolean) => void;
}) => {
  const [input, setInput] = React.useState('');
  return React.createElement(Composer, {
    ...composerProps,
    voiceCaptureEngine: capture.engine,
    input,
    onInputChange: (event: { target: { value: string } }) => setInput(event.target.value),
    onVoiceTranscript,
  });
};

const TEXTAREA = '[data-slot="prompt-input-textarea"]';
const NOTICE = '[data-testid="voice-error-notice"]';
const MESSAGE = '[data-testid="voice-error-message"]';
const CLOSE = '[data-testid="voice-error-close"]';
/** The statuses develop's chain concatenated into the bubble: `transcribe 502 (UNAUTHORIZED)`. */
const CONCAT_SENTENCE = /transcribe\s*\(?\d+/i;

/** Everything one run of the readings below produced, read off the DOM the composer built. */
type Readings = {
  noticeShown: boolean;
  sentence: string | null;
  sentenceIsTheCodesCopy: boolean;
  concatHits: number;
  draftBefore: string | null;
  draftAfter: string | null;
  draftKept: boolean;
  closed: boolean;
  visibleAfter4s: boolean;
  textUnchanged: boolean;
};

/** The notice's own sentence, alone: the layer's text minus the icon-only controls' text nodes. */
const readSentence = (root: HTMLElement): string | null => {
  const message = root.querySelector(MESSAGE);
  return message === null ? null : message.textContent;
};

/**
 * Presses the mic once through the composer's own buttons. The fake recorder answers the stop with a
 * chunk, which is what makes the upload exist; the stand-in answers it with the refusal above.
 */
const recordOnce = async (view: ReturnType<typeof render>) => {
  await act(async () => {
    view.getByRole('button', { name: 'Voice input' }).click();
  });
  // Three seconds of speech: below the segment minimum, so the stop flushes one trailing segment.
  await act(async () => {
    capture.speak(3);
  });
  await act(async () => {
    view.getByRole('button', { name: 'Stop recording' }).click();
  });
  // The refusal is retried before it is reported (250 ms + 500 ms of pipeline backoff), and this
  // file runs on fake timers, so the clock has to be advanced past that backoff for the notice to
  // appear at all.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
};

/**
 * The five readings, from one render of one composer component.
 *
 * The order is load-bearing. The close reading is taken from the FIRST failure, because it needs a
 * notice that is on screen; the persistence reading is taken from a SECOND failure, because the first
 * notice was just dismissed and a reading taken after that would be a reading of nothing. And every
 * failure is preceded by a draft typed into the textarea, so "the draft is still there" is read after
 * a failure that really happened rather than in a composer nothing ever happened to.
 */
const takeReadings = async (Composer: ComposerComponent): Promise<Readings> => {
  const view = render(React.createElement(ComposerHarness, { Composer, onVoiceTranscript: () => undefined }));
  const textarea = () => view.container.querySelector<HTMLTextAreaElement>(TEXTAREA);
  const notice = () => view.container.querySelector<HTMLElement>(NOTICE);

  // (1) The first failure: the draft, the sentence, the page's own text, the close control.
  await act(async () => {
    fireEvent.change(textarea()!, { target: { value: 'keep this draft' } });
  });
  const draftBefore = textarea()!.value;
  await recordOnce(view);
  const firstNotice = notice();
  const noticeShown = firstNotice !== null;
  const sentence = readSentence(view.container);
  const concatHits = Array.from(view.container.textContent?.matchAll(new RegExp(CONCAT_SENTENCE, 'gi')) ?? []).length;
  const draftAfter = textarea()!.value;
  const draftKept = draftAfter === draftBefore;
  const firstText = firstNotice?.textContent ?? '';
  await act(async () => {
    view.container.querySelector<HTMLElement>(CLOSE)?.click();
  });
  const closed = notice() === null;

  // (2) The second failure, and the wait past four seconds: the reading the timer would clear.
  await recordOnce(view);
  const visibleAtFailure = notice() !== null;
  await act(async () => {
    vi.advanceTimersByTime(4_500);
  });
  const visibleAfter4s = notice() !== null;
  const textUnchanged = (notice()?.textContent ?? '') === firstText;

  view.unmount();
  return {
    // A run whose second failure never produced a notice has no persistence reading at all, so it is
    // reported as not-visible rather than as "unchanged" — the empty set must not read as a pass.
    noticeShown: noticeShown && visibleAtFailure,
    sentence,
    sentenceIsTheCodesCopy: sentence === EXPECTED_SENTENCE,
    concatHits,
    draftBefore,
    draftAfter,
    draftKept,
    closed,
    visibleAfter4s,
    textUnchanged,
  };
};

/* ─── The lever: one patched copy of the shipped composer ──────────── */

const COMPOSER_SOURCE = path.join(process.cwd(), 'src/modules/chat/composer/ChatComposer.tsx');
const MUTANT_DIR = path.dirname(COMPOSER_SOURCE);
/** Every copy this file wrote, so the run can prove it left none behind. */
const written: string[] = [];

/** Replaces `anchor` exactly once, or throws: a patch that matched twice is a patch of the wrong file. */
const replaceOnce = (source: string, anchor: string, replacement: string): string => {
  const parts = source.split(anchor);
  if (parts.length !== 2) {
    throw new Error(
      `the mutation's anchor matched ${parts.length - 1} times in ${path.basename(COMPOSER_SOURCE)}, `
      + `expected exactly 1: ${JSON.stringify(anchor.slice(0, 80))}`,
    );
  }
  return parts.join(replacement);
};

/**
 * The region every mutation patches: the composer's failure handler and the state it sets.
 *
 * All three mutations belong to this one place, because it is the single point where a failure
 * becomes something the page shows — the timer that used to clear it, the sentence it used to be
 * turned into, and the draft the old chain cleared when it reported one.
 */
const FAILURE_HANDLER_ANCHOR = `  const [voiceFailure, setVoiceFailure] = useState<VoiceFailureReport | null>(null);
  const handleVoiceError = useCallback((failure: VoiceFailureReport) => {
    setVoiceFailure(failure);
  }, []);`;

/** Writes `<patched source>` beside the shipped file, imports it, and records it for removal. */
const loadMutant = async (name: string, patch: (source: string) => string): Promise<ComposerComponent> => {
  const source = fs.readFileSync(COMPOSER_SOURCE, 'utf8');
  const patched = patch(source);
  if (patched === source) throw new Error(`the ${name} mutation left the source unchanged`);
  const file = path.join(MUTANT_DIR, `__mutation-${name}-ChatComposer.tsx`);
  fs.writeFileSync(file, patched, 'utf8');
  written.push(file);
  const imported = (await import(/* the path is written at run time, so it is resolved at run time */ file)) as {
    default: ComposerComponent;
  };
  return imported.default;
};

/** The three mutations, each expressed as the shipped source plus one anchored edit. */
const MUTATIONS: Array<{
  name: string;
  lever: string;
  /** The reading the case predicts will turn red, named as the criterion names it. */
  which: string;
  /**
   * The family reading IN ITS GREEN STATE — the state the shipped composer must be in, and the state
   * the mutation must destroy. One polarity for all three cases, so "base-green" and "mutant-red" are
   * the two readings of one predicate rather than two predicates that could drift apart.
   */
  family: (readings: Readings) => boolean;
  outside: { name: string; green: (readings: Readings) => boolean };
  patch: (source: string) => string;
}> = [
  {
    name: 'four-second-timer',
    lever: 'the pre-change timer restored in the failure handler, unmutated copy imported first',
    which: 'AC4 visible-after-4s',
    family: (readings) => readings.visibleAfter4s && readings.textUnchanged,
    outside: { name: 'AC4 closed-on-close-control', green: (readings) => readings.closed },
    patch: (source) => replaceOnce(source, FAILURE_HANDLER_ANCHOR, `  const [voiceFailure, setVoiceFailure] = useState<VoiceFailureReport | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((failure: VoiceFailureReport) => {
    setVoiceFailure(failure);
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceFailure(null), 4000);
  }, []);`),
  },
  {
    name: 'concat-message',
    lever: 'the failure handler hands the notice the chain\'s own concatenated sentence',
    which: 'AC2 sentence-equals-code-copy + AC6 concat-hits',
    family: (readings) => readings.sentenceIsTheCodesCopy && readings.concatHits === 0,
    outside: { name: 'AC4 visible-after-4s', green: (readings) => readings.visibleAfter4s },
    patch: (source) => replaceOnce(source, FAILURE_HANDLER_ANCHOR, `  const [voiceFailure, setVoiceFailure] = useState<VoiceFailureReport | null>(null);
  const handleVoiceError = useCallback((failure: VoiceFailureReport) => {
    setVoiceFailure(typeof failure === 'string' ? failure : \`transcribe \${failure.status}\`);
  }, []);`),
  },
  {
    name: 'clear-draft-on-failure',
    lever: 'the failure handler clears the composer\'s own input through the channel it is given for it',
    which: 'AC5 draft-kept',
    family: (readings) => readings.draftKept,
    outside: { name: 'AC4 visible-after-4s', green: (readings) => readings.visibleAfter4s },
    patch: (source) => replaceOnce(source, FAILURE_HANDLER_ANCHOR, `  const [voiceFailure, setVoiceFailure] = useState<VoiceFailureReport | null>(null);
  const handleVoiceError = useCallback((failure: VoiceFailureReport) => {
    setVoiceFailure(failure);
    onInputChange({ target: { value: '' } } as unknown as ChangeEvent<HTMLTextAreaElement>);
  }, [onInputChange]);`),
  },
];

afterAll(() => {
  const removed = written.filter((file) => fs.existsSync(file));
  for (const file of written) {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  const leftover = fs
    .readdirSync(MUTANT_DIR)
    .filter((entry) => entry.startsWith('__mutation-'));
  console.log(
    `[voice-error-mutation] copies-written=${written.length} removed-now=${removed.length} leftover-in-tree=${JSON.stringify(leftover)}`,
  );
  console.log(
    '[voice-error-mutation] registration: the THREE mutations above are taken in jsdom against the shipped '
      + 'composer, patched as a copy in the source tree and removed at the end of this file; no browser-level '
      + 'mutation rig is built, because one browser run of the criterion costs ~24s against playwright.config.ts\'s '
      + '55s watchdog and its 54s criterion budget, and a baseline plus three mutants do not fit in it. The '
      + 'browser criterion reads the shipping build only; what its readings reject is proven here, on the same '
      + 'shipped component, not in the browser.',
  );
  assert.deepEqual(leftover, [], 'a mutated copy was left behind in the source tree');
});

for (const mutation of MUTATIONS) {
  test(`mutation ${mutation.name}: the unmutated copy is green, the mutant reds ${mutation.which}, and ${mutation.outside.name} stays green`, async () => {
    const baseline = await takeReadings(ChatComposer);
    assert.ok(
      mutation.family(baseline),
      `${mutation.name}: the unmutated composer already fails ${mutation.which}, so this case would measure the harness: ${JSON.stringify(baseline)}`,
    );

    const Mutant = await loadMutant(mutation.name, mutation.patch);
    const mutant = await takeReadings(Mutant);

    const mutantRed = !mutation.family(mutant);
    const outsideGreen = mutation.outside.green(mutant);
    console.log(
      `mutation=${mutation.name} lever=${mutation.lever} base-green=${mutation.family(baseline)}`
        + ` mutant-red=${mutantRed} which=${mutation.which} outside-family-green=${outsideGreen}`
        + ` (${mutation.outside.name}) noticed=${mutant.noticeShown}`,
    );

    assert.ok(mutantRed, `${mutation.name}: ${mutation.which} did not turn red on the mutant: ${JSON.stringify(mutant)}`);
    assert.ok(
      outsideGreen,
      `${mutation.name}: ${mutation.outside.name} also went red, so the mutant was rejected by something other than the reading it names: ${JSON.stringify(mutant)}`,
    );
    // The positive control for both readings above: the mutant still renders a notice at all.
    assert.ok(mutant.noticeShown, `${mutation.name}: no notice was on screen, so the readings were taken over nothing`);
  });
}
