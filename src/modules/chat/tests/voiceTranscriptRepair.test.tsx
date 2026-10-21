import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { createFakeVoiceCapture } from '@/modules/chat/tests/voiceCaptureTestHarness';
import enChat from '@/modules/i18n/locales/en/chat.json';
// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';

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
const speakInto = async (
  projectId: string,
  transcript: string,
  onVoiceTranscript: (text: string, send?: boolean) => void,
) => {
  const fetchesBefore = getFileIndex.mock.calls.length;
  const capture = createFakeVoiceCapture();
  const view = render(
    React.createElement(ChatComposer, {
      voiceCaptureEngine: capture.engine,
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
      input: '',
      onVoiceTranscript,
      scope: 'session-a',
      projectId,
      isActive: true,
      onInputChange: () => undefined,
      onTextareaClick: () => undefined,
      onTextareaKeyDown: () => undefined,
      onTextareaPaste: () => undefined,
      onTextareaScrollSync: () => undefined,
      onTextareaInput: () => undefined,
      placeholder: 'Ask anything',
      isTextareaExpanded: false,
    } as unknown as React.ComponentProps<typeof ChatComposer>),
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

  // Three seconds of speech: below the segmenter's minimum, so the stop flushes it as the single
  // trailing segment — the shape a press-and-release dictation has always had.
  await act(async () => {
    capture.speak(3);
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
