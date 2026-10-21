import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { createFakeVoiceCapture } from '@/modules/chat/tests/voiceCaptureTestHarness';
import enChat from '@/modules/i18n/locales/en/chat.json';
// Type-only, so both are erased before vi.mock's hoisted factories run.
import type * as SharedApi from '@/shared/api';
import type * as SharedVoiceConfig from '@/shared/voiceConfig';

/**
 * The send hook: the moment a listen's words and the user's own edit are both known.
 *
 * `voiceEditLabels.test.ts` owns what a label MEANS — the ops, the shape rule, the boundary between
 * a correction and a rewrite. What it cannot see is whether the app ever derives one: a pure module
 * that nothing calls is a module that labels nothing, and the reading that matters here is the join
 * — the send handler asking for labels for the text it is about to send, and putting them back
 * beside the audio they came from. This file drives the real `ChatComposer` through a real mic press
 * and a real submit; the only stand-ins are the speech endpoint (there is no offline recogniser in
 * this checkout) and the label write itself (the store is the server's business, read by
 * `server/modules/voice/tests/voice-data.test.ts`).
 *
 * THE READINGS ARE A SET, and each one is stated against the failure that would make it vacuous.
 * "A PATCH happens" alone would pass on a write that ran even when the message never went out; "the
 * message still goes out" alone would pass on a hook that does nothing at all. The switch-off case
 * is taken with a record id ALREADY IN HAND, so it reads the gate rather than the absence of a
 * record — turned off for the whole press instead, there would be nothing to PATCH whether or not
 * the gate existed, and the case would pass for the wrong reason.
 *
 * The failure arm is TWO CASES rather than one, because the two shapes fail at different moments
 * and only the second is falsifiable on its own. A rejection settles in a microtask, long after the
 * message has gone, so a hook with no catch at all still passes it; a transport that throws on the
 * way to building the request throws INSIDE the submit handler, ahead of `onSubmit`, and takes the
 * message with it unless the hook catches synchronously. Every case here was checked against a
 * mutation of the shipped hook that reddens it and nothing else.
 */

const { transcribeVoice, getFileIndex, writeLabels, captureState, saveConfig, recording } = vi.hoisted(() => ({
  transcribeVoice: vi.fn(),
  getFileIndex: vi.fn(),
  writeLabels: vi.fn(),
  captureState: vi.fn(),
  saveConfig: vi.fn(),
  /**
   * The user's own recording switch, read through the real accessor rather than replaced.
   *
   * It is a HANDLE rather than a per-test value because the third case has to flip it between the
   * dictation and the send — the same thing the hook's own comment describes happening when the
   * switch is turned off in another tab.
   */
  recording: { enabled: true },
}));

vi.mock('@/shared/voiceConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedVoiceConfig>();
  return {
    ...actual,
    // Everything else stays real: this file's subject is the send, not the settings document, and a
    // second copy of the accessor here would be a second copy of the thing the hook reads.
    readVoiceConfig: () => ({ ...actual.readVoiceConfig(), voiceDataRecording: recording.enabled }),
  };
});

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    // `voice.writeLabels` is the one entry under test; the rest of the voice surface is declared so
    // the whole-module double stays complete rather than because a case reaches it.
    api: {
      getFileIndex,
      voice: { writeLabels, capture: captureState, saveConfig },
    },
    transcribeVoice,
    // The raw-corpus upload the hook fires after a listen, and the synthesizer the replay control
    // uses. Declared for the same reason as the two above; neither is reached with raw capture off
    // and a listen that is never replayed.
    captureRawVoice: vi.fn(),
    synthesizeVoice: vi.fn(),
    voiceConfigSignature: () => 'test-signature',
    // The one thing taken from the real module: it does no I/O, and its job — reading the
    // recogniser's answer — is not what this file is about, so a double here would be a second copy
    // of the wire parse rather than a stand-in for the network.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
    effectivePauseCuesDeclaration: actual.effectivePauseCuesDeclaration,
  };
});

// The real hook asks the backend whether a voice provider is configured; the mic button is gated on
// that answer, and this file drives the mic button.
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
 * A recogniser answer, in the two shapes the hook reads it.
 *
 * The body is served twice on purpose: `readRecordId` clones the answer and reads the record's id
 * off it, and the transcript parse then consumes the response itself. A fake that could only be
 * read once would exercise a path the real one does not have.
 */
const answer = (text: string, recordId?: string) => {
  const body = recordId === undefined ? { text } : { text, recordId };
  return {
    ok: true,
    status: 200,
    json: async () => body,
    clone: () => ({ json: async () => body }),
  };
};

/** The id the store gave this listen's record — what a label would be written back against. */
const RECORD_ID = 'rec-2026-10-06-a';

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

  // No project names: the repair this composer also runs must not touch the fixture's words, or a
  // case would be reading the repair rather than the label.
  getFileIndex.mockReset();
  getFileIndex.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ files: [], truncated: false }),
  });
  transcribeVoice.mockReset();
  // A write that succeeds unless the case says otherwise. The hook never inspects the answer — the
  // label is a side channel — so the shape only has to be a resolved promise.
  writeLabels.mockReset();
  writeLabels.mockResolvedValue({ ok: true, status: 200, json: async () => ({ recordId: RECORD_ID }) });
  captureState.mockReset();
  captureState.mockResolvedValue({ ok: true, status: 200, json: async () => ({ raw: false }) });
  saveConfig.mockReset();
  saveConfig.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  recording.enabled = true;
});

// The object-URL stubs stay installed between tests on purpose: jsdom does not implement them at
// all, and testing-library's auto-cleanup unmounts the composer *after* this file's hooks run —
// restoring them here would make the unmount cleanup throw.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ─── The composer, driven through the real chain ──────────────────── */

/**
 * The composer with a parent that owns the box, as the real one has.
 *
 * The input is held here rather than handed in as a constant because the case under test is an EDIT:
 * the dictation arrives, the user changes it, and the send compares the two. A fixed prop could not
 * express that, and the two arms of the comparison would collapse into one value.
 */
type HarnessProps = {
  projectId: string;
  engine: ReturnType<typeof createFakeVoiceCapture>['engine'];
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onTranscript: (text: string, send?: boolean) => void;
};

function Harness({ projectId, engine, onSubmit, onTranscript }: HarnessProps) {
  const [input, setInput] = React.useState('');
  return React.createElement(ChatComposer, {
    voiceCaptureEngine: engine,
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
    onSubmit,
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
    input,
    onInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setInput(event.target.value),
    // The real parent inserts the dictation into the box and leaves it there for the user to edit;
    // replacing the box with it is the same state at the moment this file reads, and the edit is
    // then delivered as a real change event rather than assumed.
    onVoiceTranscript: (text: string, send?: boolean) => {
      setInput(text);
      onTranscript(text, send);
    },
    scope: 'session-labels',
    projectId,
    isActive: true,
    onTextareaClick: () => undefined,
    onTextareaKeyDown: () => undefined,
    onTextareaPaste: () => undefined,
    onTextareaScrollSync: () => undefined,
    onTextareaInput: () => undefined,
    placeholder: 'Ask anything',
    isTextareaExpanded: false,
  } as unknown as React.ComponentProps<typeof ChatComposer>);
}

/**
 * One full mic press on the real composer, ending with whatever the recogniser answered.
 *
 * Returns the mounted view and a `send` that submits the form exactly as the send button does, so a
 * case can put anything it needs between the dictation and the send — a human edit, or a switch
 * turned off elsewhere.
 */
const dictate = async (projectId: string, transcript: string, recordId?: string) => {
  transcribeVoice.mockResolvedValue(answer(transcript, recordId));
  const capture = createFakeVoiceCapture();
  const onSubmit = vi.fn();
  const onTranscript = vi.fn();

  const view = render(
    React.createElement(Harness, { projectId, engine: capture.engine, onSubmit, onTranscript }),
  );

  // Drain the candidate fetch before recording, so the press is judged against a composer that has
  // the project's names in hand rather than one whose list is still in flight.
  await act(async () => {});

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

  return {
    view,
    onSubmit,
    onTranscript,
    /** The user's edit of the box the dictation landed in. */
    typed: (text: string) => {
      fireEvent.change(view.getByPlaceholderText('Ask anything'), { target: { value: text } });
    },
    /** The one entry into the composer's send: the form's own submit, as the button produces it. */
    send: () => {
      const form = view.container.querySelector('form');
      assert.ok(form, 'the composer has to render its form, or nothing can be submitted');
      fireEvent.submit(form);
    },
  };
};

/* ─── The three readings ───────────────────────────────────────────── */

test('a send writes the listened words against the edit, onto the record the listen was kept in', async () => {
  const press = await dictate('project-labels-write', 'key', RECORD_ID);
  assert.deepEqual(
    press.onTranscript.mock.calls,
    [['key', false]],
    'the dictation has to reach the box before the edit below means anything',
  );

  press.typed('quay');
  assert.equal(writeLabels.mock.calls.length, 0, 'editing is not sending — nothing is filed yet');
  press.send();

  assert.deepEqual(
    writeLabels.mock.calls,
    [[
      RECORD_ID,
      {
        finalText: 'quay',
        labels: [{ segmentIndex: 0, heard: 'key', final: 'quay', op: 'replace' }],
      },
    ]],
    'the send must file "heard key → sent quay" against the record the audio is in',
  );
  assert.equal(press.onSubmit.mock.calls.length, 1, 'the message itself still goes out, once');
  press.view.unmount();
});

test('a label write the server refuses does not cost the send', async () => {
  // A refused write — the store evicted the record, or the deployment wired no such route. It
  // resolves rather than throwing, so what it reads is that the send never waited on the answer.
  writeLabels.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'No such recording.' }) });
  const press = await dictate('project-labels-refused', 'key', RECORD_ID);

  press.typed('quay');
  press.send();

  assert.equal(writeLabels.mock.calls.length, 1, 'the write was attempted');
  assert.equal(press.onSubmit.mock.calls.length, 1, 'the message went out anyway');
  await act(async () => {});
  press.view.unmount();
});

test('a label write that rejects does not cost the send', async () => {
  // THE ARM THAT KEEPS THE OTHER TWO HONEST. Nothing here is awaited and the send is not
  // conditional on the answer, so this reading alone would pass on a hook whose catch had been
  // deleted — the send would simply carry on. What makes it worth stating is the pair: it is the
  // transport failing AFTER it returned, and the next case is the transport failing BEFORE it did.
  writeLabels.mockRejectedValue(new Error('the store is gone'));
  const press = await dictate('project-labels-rejected', 'key', RECORD_ID);

  press.typed('quay');
  press.send();

  assert.equal(writeLabels.mock.calls.length, 1, 'the write was attempted');
  assert.equal(press.onSubmit.mock.calls.length, 1, 'the message was sent anyway');
  // The rejection settles in a microtask; let it land inside the test rather than at teardown, where
  // an unhandled one would be reported against whichever test happened to be running.
  await act(async () => {});
  press.view.unmount();
});

test('a label write that throws before returning does not cost the send', async () => {
  // The synchronous failure: a transport that throws on the way to building the request, which is
  // the shape the hook's own `try` is for. THIS IS THE FALSIFIABLE ARM — the throw happens inside
  // the submit handler, before `onSubmit` is reached, so a hook that let it propagate would send
  // nothing at all. It is also the case the other two could not catch: a rejection only ever
  // surfaces in a microtask, by which time the message is already gone.
  writeLabels.mockImplementation(() => {
    throw new Error('the transport is not even constructible');
  });
  const press = await dictate('project-labels-thrown', 'key', RECORD_ID);

  press.typed('quay');
  press.send();

  assert.equal(writeLabels.mock.calls.length, 1, 'the write was attempted');
  assert.equal(
    press.onSubmit.mock.calls.length,
    1,
    'a throw from the label side channel must not take the user\'s message with it',
  );
  press.view.unmount();
});

test('the switch being off stops the write, even with the record id already in hand', async () => {
  // The id is COLLECTED with the switch on and the switch is flipped afterwards, so this case reads
  // the gate rather than the absence of a record. Turned off for the whole press instead, there
  // would be no id to write against and the case would pass on a hook with no gate at all.
  const press = await dictate('project-labels-off', 'key', RECORD_ID);

  recording.enabled = false;
  press.typed('quay');
  press.send();

  assert.deepEqual(writeLabels.mock.calls, [], 'a user who is not keeping records gets no write');
  assert.equal(press.onSubmit.mock.calls.length, 1, 'and their message is sent as usual');
  press.view.unmount();
});
