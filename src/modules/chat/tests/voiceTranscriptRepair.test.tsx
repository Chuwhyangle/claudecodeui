import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { createFakeVoiceCapture } from '@/modules/chat/tests/voiceCaptureTestHarness';
import { VOICE_INPUT_VOICE_SO_FAR_HEADING } from '@/modules/chat/utils/voice/voiceContextPack';
import enChat from '@/modules/i18n/locales/en/chat.json';
// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';
import type { ChatMessage } from '@/shared/types';

/**
 * The transcript's last step, on the path the app really runs it on.
 *
 * `projectIdentifiers.test.ts` owns where the candidate names come from and
 * `identifierRepair.test.ts` owns what the repair does with them. What neither can
 * see is the join: the composer fetching a project's files, the hook repairing the
 * recogniser's text against them, and the repaired text being what the composer is
 * handed. That join is what this file drives, end to end, through the real
 * `ChatComposer` — the only stand-in is the speech endpoint, because there is no
 * offline recogniser in this checkout.
 *
 * The two readings are deliberately paired. "A repair happens" alone would pass on a
 * chain that repairs everything, and "plain prose is untouched" alone would pass on a
 * chain that does nothing at all — which is exactly the state this task is changing.
 * Only both together pin the behaviour: one rewrite, and no rewrite where none is due.
 */

const { transcribeVoice, getFileIndex } = vi.hoisted(() => ({
  transcribeVoice: vi.fn(),
  getFileIndex: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    api: { getFileIndex },
    transcribeVoice,
    // The raw-corpus upload the hook fires after a listen. Declared so this whole-module double stays
    // complete; it is never awaited, so its absence would be a crash only if the switch were on, and
    // these cases keep it off.
    captureRawVoice: vi.fn(),
    synthesizeVoice: vi.fn(),
    voiceConfigSignature: () => 'test-signature',
    // The hook reads the recogniser's answer through this named export. It does no I/O, so it is
    // driven for real rather than doubled — the double exists to cut the speech endpoint, and a
    // second copy of the parse here would be a second copy of the thing under test.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
    // The other thing the capture path asks the shared module for: the declaration that decides
    // whether the audio is changed before it is uploaded. Taken from the real accessor for the same
    // reason as the parse above — this file's subject is the repair join, not who answers 裁不裁,
    // and an answer copied here would be a second copy of that decision. Nothing has published a
    // voice profile, so it answers "nothing to read" and the recording travels as it was recorded,
    // which is the input every reading below is taken on rather than a state they depend on.
    effectivePauseCuesDeclaration: actual.effectivePauseCuesDeclaration,
  };
});

// The real hook asks the backend whether a voice provider is configured; the mic button
// is gated on that, and this file drives the mic button.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/* ─── Fakes ────────────────────────────────────────────────────────── */

/**
 * The project's flat file index, in the shape `GET …/files-index` answers with.
 *
 * The names are the fixture's own, and the reparability reading depends on them: the
 * stem of every entry is offered as a candidate beside its basename, so a sentence
 * that happens to contain one of these words would be rewritten. None of the plain
 * sentences below do — that is the property being read, not an accident.
 */
const FILES = [
  { type: 'file', name: 'voice.routes.ts', path: '/project/src/voice.routes.ts' },
  { type: 'file', name: 'useVoiceInput.tsx', path: '/project/src/useVoiceInput.tsx' },
  { type: 'file', name: 'identifierRepair.ts', path: '/project/src/identifierRepair.ts' },
];

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const fakeStream = { getTracks: () => [{ stop: () => undefined }] };

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => fakeStream },
  });
  let counter = 0;
  createObjectURL.mockReset();
  createObjectURL.mockImplementation(() => `blob:clip-${++counter}`);
  revokeObjectURL.mockReset();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;

  getFileIndex.mockReset();
  getFileIndex.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ files: FILES, truncated: false }),
  });
  transcribeVoice.mockReset();
});

// The object-URL stubs stay installed between tests on purpose: jsdom does not implement
// them at all, and testing-library's auto-cleanup unmounts the composer *after* this file's
// hooks run — restoring them here would make the unmount cleanup throw.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ─── The composer, driven through the real chain ──────────────────── */

const PLAIN_EN = 'please make the wording clearer before we ship it';
const PLAIN_ZH = '把这段说明改得更清楚一点再发布';
const MISHEARD = 'please open voice.rouse.ts and fix the proxy';
const REPAIRED = 'please open voice.routes.ts and fix the proxy';

/**
 * One full mic press on the real composer, ending with whatever the recogniser answered.
 *
 * The candidate list arrives from `getFileIndex` through the composer's own effect, so the
 * press can only be judged after that promise has been drained — hence the settle before
 * the recording starts: a repair reading taken before the composer has the names would
 * report "nothing repaired" for a reason that has nothing to do with the repair.
 */
/**
 * Every prop the composer needs that a case does NOT vary, so each harness below states only its
 * own half. The two harnesses (one-shot press, and the stateful box below) must render the same
 * composer; a second copy of this list would be a second composer.
 */
const BASE_COMPOSER_PROPS: Record<string, unknown> = {
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
  scope: 'session-a',
  isActive: true,
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Ask anything',
  isTextareaExpanded: false,
};

const composerProps = (overrides: Record<string, unknown>) =>
  ({ ...BASE_COMPOSER_PROPS, ...overrides } as unknown as React.ComponentProps<typeof ChatComposer>);

const speakInto = async (
  projectId: string,
  transcript: string,
  onVoiceTranscript: (text: string, send?: boolean) => void,
  contextMessages?: readonly ChatMessage[],
  speechSec = 3,
  silenceSec = 0,
) => {
  const fetchesBefore = getFileIndex.mock.calls.length;
  const capture = createFakeVoiceCapture();
  const view = render(
    React.createElement(ChatComposer, composerProps({
      voiceCaptureEngine: capture.engine,
      textareaRef: { current: null },
      input: '',
      onVoiceTranscript,
      contextMessages,
      projectId,
    })),
  );

  // Drain the candidate fetch before recording, so the press is judged against a
  // composer that has the project's names in hand.
  await act(async () => {});
  assert.deepEqual(
    getFileIndex.mock.calls.slice(fetchesBefore),
    [[projectId]],
    'the composer asks the project for its file index, once',
  );

  await act(async () => {
    view.getByRole('button', { name: 'Voice input' }).click();
  });
  assert.ok(
    view.getByRole('button', { name: 'Stop recording' }),
    'the recorder has to really be running, or the stop below uploads nothing',
  );

  // Speech plus an optional silent tail: the stop flushes it as the single trailing segment — the
  // shape a press-and-release dictation has always had. The tail is what the edge trim is for.
  await act(async () => {
    capture.speak(speechSec);
    if (silenceSec > 0) capture.push(silenceSec, 0);
  });

  await act(async () => {
    view.getByRole('button', { name: 'Stop recording' }).click();
  });
  // The flush enqueues the trailing segment and its upload settles a microtask or two later.
  await act(async () => {});

  return view;
};

test('a mis-heard name is repaired against the project the composer is open in', async () => {
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: MISHEARD }) });
  const onVoiceTranscript = vi.fn();

  const view = await speakInto('project-repair', MISHEARD, onVoiceTranscript);

  assert.deepEqual(
    onVoiceTranscript.mock.calls,
    [[REPAIRED, false]],
    'the composer must be handed the project\'s real file name, not the recogniser\'s spelling',
  );
  view.unmount();
});

test('a listen carries the visible conversation as the relay context', async () => {
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: PLAIN_ZH }) });
  const contextMessages: ChatMessage[] = [
    { type: 'user', content: 'architecture tab 的继承关系看不出来', timestamp: Date.now() },
  ];

  const view = await speakInto('project-context', PLAIN_ZH, vi.fn(), contextMessages);

  const call = transcribeVoice.mock.calls[0];
  assert.ok(call, 'nothing reached the recogniser');
  assert.match(
    String(call[4]),
    /architecture tab 的继承关系看不出来/,
    'the relay context must be the visible conversation the composer was handed',
  );
  view.unmount();
});

test('a long silent tail is trimmed before the segment is uploaded', async () => {
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: PLAIN_EN }) });

  await speakInto('project-tail-trim', PLAIN_EN, vi.fn(), undefined, 1, 3);

  const blob = transcribeVoice.mock.calls[0]?.[0] as Blob | undefined;
  assert.ok(blob, 'nothing reached the recogniser');
  // 4 s of 16 kHz mono 16-bit WAV is ~128 KB; the speech is the first second, so the edge trim
  // must leave a small fraction of that. The bound is deliberately loose — this is a wiring test,
  // not a DSP reading (the exact policy is pinned in voiceTrim.test.ts).
  assert.ok(
    blob.size < 80_000,
    `the silent tail reached the recogniser: ${blob.size} bytes for a 1 s speech + 3 s silence segment`,
  );
});

test('a sentence carrying no identifier arrives character for character', async () => {
  for (const [index, sentence] of [PLAIN_EN, PLAIN_ZH].entries()) {
    transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: sentence }) });
    const onVoiceTranscript = vi.fn();

    const view = await speakInto(`project-plain-${index}`, sentence, onVoiceTranscript);

    const [call] = onVoiceTranscript.mock.calls;
    assert.deepEqual(
      call?.[0],
      sentence,
      `the repair rewrote a sentence that carried no identifier: recogniser=${JSON.stringify(sentence)} composer=${JSON.stringify(call?.[0])}`,
    );
    assert.equal(call?.[1], false, 'a mic press that was not a "send" must not become one');
    view.unmount();
  }
});

/* ─── The same composer with a box that really holds a draft ───────── */

/**
 * The composer with `input` as REAL state.
 *
 * THE ONE-SHOT HARNESS ABOVE PASSES A CONSTANT `input`, which is enough for the repair readings and
 * not enough for the context pack: the pack is built from the box a listen started in and from what
 * the listen has already committed, so both halves have to actually change on screen. Here `input`
 * is state, `onVoiceTranscript` writes the committed dictation into it the way the state layer does
 * (at the caret the listen opened at), and `onDraftSetterReady` hands out the setter a case types
 * through while the microphone is still open.
 */
type DraftSetter = ((next: string) => void) | null;

function StatefulChatComposer({
  capture,
  onDraftSetterReady,
  draft,
  textareaRef,
  projectId,
  contextMessages,
}: {
  capture: ReturnType<typeof createFakeVoiceCapture>;
  onDraftSetterReady: (setter: DraftSetter) => void;
  draft: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  projectId: string;
  contextMessages?: readonly ChatMessage[];
}) {
  const [input, setInput] = React.useState(draft);
  // The setter is handed OUT rather than written into a prop object: a component may not mutate
  // what it was given (oxlint's `react(immutability)`), and the test's only need is the callback.
  React.useEffect(() => {
    onDraftSetterReady(setInput);
    return () => {
      onDraftSetterReady(null);
    };
  }, [onDraftSetterReady]);

  // The committed dictation lands at the caret the listen opened at, which is the whole draft here.
  const onVoiceTranscript = React.useCallback(
    (text: string) => {
      setInput(draft + text);
    },
    [draft],
  );

  return React.createElement(ChatComposer, composerProps({
    voiceCaptureEngine: capture.engine,
    textareaRef,
    input,
    onVoiceTranscript,
    contextMessages,
    projectId,
  }));
}

/** The draft this case starts the listen in; the caret sits at the seam between the two halves. */
const DRAFT_BEFORE = 'P0-DRAFT-BEFORE 把这段说明改短一点：';
const DRAFT_AFTER = 'P0-DRAFT-AFTER 后面这句先留着';
const FIRST_ANSWER = 'alpha bravo';

test('a listen carries the box it started in and what it has already said, not the edits since', async () => {
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: FIRST_ANSWER }) });
  const capture = createFakeVoiceCapture();
  // The registration callback the component hands its setter to. The element below is created
  // once, so this identity is stable across the component's own re-renders, which is what the
  // registration effect depends on.
  let setDraft: DraftSetter = null;
  const onDraftSetterReady = (setter: DraftSetter) => {
    setDraft = setter;
  };
  const textareaRef: React.RefObject<HTMLTextAreaElement | null> = { current: null };
  const conversation: ChatMessage[] = [
    { type: 'user', content: 'CONVERSATION-ROW 架构页的继承关系', timestamp: Date.now() },
  ];

  const view = render(React.createElement(StatefulChatComposer, {
    capture,
    onDraftSetterReady,
    draft: DRAFT_BEFORE + DRAFT_AFTER,
    textareaRef,
    projectId: 'project-draft',
    contextMessages: conversation,
  }));
  // Let the composer's own candidate fetch settle, as the one-shot harness above does.
  await act(async () => {});

  // THE CARET IS THE READING, so it is placed explicitly: the draft's two halves only exist
  // relative to it, and a default selection of 0 would make the "before" half empty.
  const textarea = view.getByPlaceholderText('Ask anything') as HTMLTextAreaElement;
  textarea.focus();
  textarea.setSelectionRange(DRAFT_BEFORE.length, DRAFT_BEFORE.length);

  await act(async () => {
    view.getByRole('button', { name: 'Voice input' }).click();
  });
  assert.ok(
    view.getByRole('button', { name: 'Stop recording' }),
    'the recorder has to really be running, or no segment is ever uploaded',
  );

  // Segment 1: three seconds of speech, then the shipped ten-second silence flush closes it.
  // (`DEFAULT_FLUSH_SILENCE_SEC` is 10; a shorter pause is not a cut.)
  await act(async () => {
    capture.speak(3);
    capture.endSpeech();
    capture.push(10.5);
  });
  // Two flushes: the upload's promise resolve, then the commit that follows it.
  await act(async () => {});
  await act(async () => {});
  assert.equal(
    (view.getByPlaceholderText('Ask anything') as HTMLTextAreaElement).value,
    `${DRAFT_BEFORE}${DRAFT_AFTER}${FIRST_ANSWER}`,
    'the committed answer never reached the box, so the later upload has nothing to be told to avoid',
  );

  // The user keeps typing while the microphone is still open. This text belongs to the box NOW,
  // not to the box the listen started in — and the snapshot is what the recogniser must see.
  await act(async () => {
    setDraft?.(`${DRAFT_BEFORE}${DRAFT_AFTER}${FIRST_ANSWER}UNCOMMITTED-EDIT`);
  });

  // Segment 2: another utterance, closed by the stop.
  await act(async () => {
    capture.speak(3);
  });
  await act(async () => {
    view.getByRole('button', { name: 'Stop recording' }).click();
  });
  await act(async () => {});

  assert.ok(
    transcribeVoice.mock.calls.length >= 2,
    `the second segment was never uploaded (${transcribeVoice.mock.calls.length} requests)`,
  );
  const [first, second] = transcribeVoice.mock.calls
    .slice(0, 2)
    .map((call) => String(call[4]));

  // The FIRST upload has nothing committed yet, so it carries no "voice so far" section at all.
  assert.ok(first !== '', 'the first upload carried no context');
  assert.ok(first.includes(DRAFT_BEFORE), 'the draft before the caret is missing from the first context');
  assert.ok(first.includes(DRAFT_AFTER), 'the draft after the caret is missing from the first context');
  assert.equal(
    first.includes(VOICE_INPUT_VOICE_SO_FAR_HEADING),
    false,
    'the first context announced already-spoken text that did not exist yet',
  );
  assert.ok(
    first.includes('CONVERSATION-ROW 架构页的继承关系'),
    'the composer\'s visible conversation never reached the recogniser',
  );

  // The SECOND upload carries the snapshot draft AND what the listen had committed — never the edit
  // the user made after it began.
  assert.ok(second !== '', 'the second upload carried no context');
  assert.ok(second.includes(DRAFT_BEFORE), 'the snapshot draft before the caret is missing from the second context');
  assert.ok(second.includes(DRAFT_AFTER), 'the snapshot draft after the caret is missing from the second context');
  assert.ok(
    second.includes(`${VOICE_INPUT_VOICE_SO_FAR_HEADING}\n${FIRST_ANSWER}`),
    'what the listen had already committed is missing from the second context',
  );
  assert.equal(
    second.includes('UNCOMMITTED-EDIT'),
    false,
    'an edit made after the listen began leaked into its context',
  );

  view.unmount();
});
