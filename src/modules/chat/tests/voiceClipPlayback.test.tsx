import assert from 'node:assert/strict';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import VoiceClipButton from '@/modules/chat/composer/VoiceClipButton';
import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { createFakeVoiceCapture } from '@/modules/chat/tests/voiceCaptureTestHarness';
import { voicePlayer } from '@/modules/chat/utils/voicePlayer';
import enChat from '@/modules/i18n/locales/en/chat.json';
// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';
import type { VoiceClipPlayState, VoiceClipSlot } from '@/shared/types';

/**
 * The composer keeps the last listen as a single slot so it can be replayed as a pair.
 *
 * Since continuous capture there are two tracks and they mean different things than they used to:
 * `trimmed` is the filtered audio the segments were cut from (always present once anything was
 * said), and `original` is the raw PCM the microphone produced (present unless the stream passed
 * the cap). What this file owns is the *policy* around them — when a clip is captured, when it is
 * dropped, what the controls over it say, and which of the two is sounding — while the capture
 * itself and the clip's `Audio` elements are faked, because jsdom has neither a microphone nor an
 * audio thread.
 *
 * The lifecycle half is the part a unit test can actually own. The composer is never unmounted on a
 * session switch, so nothing here is exercised by a remount: the hook has to drop the clip from the
 * scope signal alone, and only stop — not drop — it when it goes off screen.
 */

const { transcribeVoice } = vi.hoisted(() => ({ transcribeVoice: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    transcribeVoice,
    // The raw-corpus upload the hook fires after a listen. Doubled so a case can assert it is never
    // called when the deployment's switch is off; harmless when it is, because it is never awaited.
    captureRawVoice: vi.fn(),
    synthesizeVoice: vi.fn(),
    voiceConfigSignature: () => 'test-signature',
    // The recogniser's answer is read through the shipping parse; only the endpoint is cut.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
    // The capture path reads the effective recogniser's `pauseCues` at the trim's one read point
    // when a listen starts. This file stubs the trim off, so the value does not change what is cut
    // here; the accessor is taken from the real module so the double stays complete — nothing has
    // published a voice profile, so it answers "nothing to read".
    effectivePauseCuesDeclaration: actual.effectivePauseCuesDeclaration,
  };
});

// The mic button is gated on the backend saying a voice provider is configured.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

// A plain install: no upload entry, the shipped segment minimum, no idle override.
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

/* ─── Fakes ────────────────────────────────────────────────────────── */

/** What the clip element's next `play()` resolves to. */
let nextPlayResult: Promise<void> = Promise.resolve();

class FakeAudio {
  static instances: FakeAudio[] = [];

  src = '';
  playCalls = 0;
  pauseCalls = 0;
  /** What `play()` returns; a test swaps `nextPlayResult` to drive the rejection path. */
  playResult: Promise<void> = nextPlayResult;
  private listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  play(): Promise<void> {
    this.playCalls += 1;
    return this.playResult;
  }

  pause() {
    this.pauseCalls += 1;
  }

  dispatch(type: string) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

const fakeStream = { getTracks: () => [{ stop: () => undefined }] };

/** The capture engine every render is handed; recreated per case so no frame leaks. */
let capture = createFakeVoiceCapture();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  capture = createFakeVoiceCapture();
  vi.stubGlobal('Audio', FakeAudio);
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
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) });
  FakeAudio.instances = [];
  nextPlayResult = Promise.resolve();
});

// The object-URL stubs stay installed between tests on purpose: jsdom does not implement them at
// all, and testing-library's auto-cleanup unmounts the hook *after* this file's hooks run.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
});

/* ─── Hook harness ─────────────────────────────────────────────────── */

type HookProps = { scope: string | null; isActive: boolean };

const renderVoice = () => {
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const view = renderHook(
    ({ scope, isActive }: HookProps) =>
      useVoiceInput(onTranscript, onError, { scope, isActive, captureEngine: capture.engine }),
    { initialProps: { scope: 'session-a', isActive: true } as HookProps },
  );
  return { view, onTranscript, onError };
};

/** Drives one full mic press: start, speak for `heldMs`, stop, and drain the upload tail. */
const record = async (
  view: { result: { current: ReturnType<typeof useVoiceInput> } },
  heldMs: number,
  { speak = true }: { speak?: boolean } = {},
) => {
  await act(async () => {
    view.result.current.toggle();
  });
  if (speak) {
    await act(async () => {
      capture.speak(heldMs / 1000);
    });
  }
  await act(async () => {
    view.result.current.stop();
  });
  await act(async () => {});
};

const lastAudio = () => FakeAudio.instances[FakeAudio.instances.length - 1];

/* ─── Capture ──────────────────────────────────────────────────────── */

test('a finished listen lands in the clip slot as a pair of tracks', async () => {
  const { view, onTranscript } = renderVoice();
  const before = view.result.current.clipSlot;
  assert.equal(before, null, 'nothing to replay before a listen');

  await record(view, 2000);

  const slot = view.result.current.clipSlot;
  assert.ok(slot, 'a listen that said something has to leave a slot');
  assert.ok(slot.original, 'the raw stream has to be replayable');
  assert.ok(slot.trimmed, 'the filtered audio the segments were cut from has to be replayable');
  assert.notEqual(slot.trimmed.url, slot.original.url, 'the two controls must not point at the same audio');
  assert.equal(slot.original.meta.mimeType, 'audio/wav');
  assert.equal(slot.trimmed.meta.mimeType, 'audio/wav');
  assert.equal(onTranscript.mock.calls.length, 1, 'the transcript still reaches the composer');
});

test('a silent press leaves no filtered track: there was nothing to cut', async () => {
  const { view, onTranscript, onError } = renderVoice();

  await record(view, 2000, { speak: false });

  const slot = view.result.current.clipSlot;
  assert.equal(slot?.trimmed ?? null, null, 'nothing was said, so there is no filtered audio');
  assert.equal(onTranscript.mock.calls.length, 0, 'silence spends no request');
  assert.deepEqual(onError.mock.calls, [], 'silence is not a failure');
});

test('a failed transcription still leaves the clip replayable', async () => {
  const { view, onError } = renderVoice();
  transcribeVoice.mockResolvedValue({ ok: false, status: 500 });

  await record(view, 2000);
  // Cover the pipeline's retry backoff (250 ms + 500 ms) before the failure is reported.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  assert.ok(
    view.result.current.clipSlot,
    'a transcription that failed is exactly when the user needs to hear what they said',
  );
  assert.equal(onError.mock.calls.length, 1, 'the failure is still reported');
});

test('a second listen evicts the first and revokes its object URLs', async () => {
  const { view } = renderVoice();

  await record(view, 1000);
  const first = view.result.current.clipSlot;
  assert.ok(first?.original && first.trimmed, 'the first listen has a pair');
  await record(view, 1000);

  assert.notEqual(view.result.current.clipSlot?.original?.url, first.original.url);
  const revoked = revokeObjectURL.mock.calls.map((call) => call[0]);
  assert.ok(
    revoked.includes(first.original.url) && revoked.includes(first.trimmed.url),
    'the evicted clip leaks its blobs unless both URLs are revoked',
  );
});

test('unmounting revokes the clip object URLs', async () => {
  const { view } = renderVoice();

  await record(view, 1000);
  const slot = view.result.current.clipSlot;
  view.unmount();

  const revoked = revokeObjectURL.mock.calls.map((call) => call[0]);
  assert.ok(
    slot?.original && slot.trimmed && revoked.includes(slot.original.url) && revoked.includes(slot.trimmed.url),
  );
});

test('starting a new listen stops a clip that is still playing', async () => {
  const { view } = renderVoice();
  await record(view, 1000);

  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });
  const audio = lastAudio();
  assert.equal(view.result.current.clipPlayState.original, 'playing');

  await act(async () => {
    view.result.current.toggle();
  });

  assert.ok(audio.pauseCalls > 0, 'the previous clip must not keep sounding under the new listen');
  assert.equal(view.result.current.clipPlayState.original, 'idle');
});

/* ─── Lifecycle ────────────────────────────────────────────────────── */

test('a scope change drops the clip', async () => {
  const { view } = renderVoice();
  await record(view, 1000);
  const slot = view.result.current.clipSlot;
  assert.ok(slot);

  await act(async () => {
    view.rerender({ scope: 'session-b', isActive: true });
  });

  assert.equal(view.result.current.clipSlot, null, 'the clip describes a chat that is no longer open');
  const revoked = revokeObjectURL.mock.calls.map((call) => call[0]);
  assert.ok(slot.original && slot.trimmed && revoked.includes(slot.original.url) && revoked.includes(slot.trimmed.url));
});

test('going inactive stops the sound but keeps the clip', async () => {
  const { view } = renderVoice();
  await record(view, 1000);
  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });
  const audio = lastAudio();

  await act(async () => {
    view.rerender({ scope: 'session-a', isActive: false });
  });

  assert.equal(view.result.current.clipPlayState.original, 'idle', 'the pill is off screen; nothing can stop it');
  assert.ok(audio.pauseCalls > 0);
  assert.ok(view.result.current.clipSlot, 'the clip is not dropped — the user is coming back to it');

  await act(async () => {
    view.rerender({ scope: 'session-a', isActive: true });
  });
  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });

  assert.equal(
    view.result.current.clipPlayState.original,
    'playing',
    'a clip kept across the hidden state must still be replayable',
  );
});

/* ─── One track at a time ──────────────────────────────────────────── */

test('the two tracks never sound at once', async () => {
  const { view } = renderVoice();
  await record(view, 1000);
  assert.ok(view.result.current.clipSlot?.trimmed, 'this test is about the pair');

  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });
  // Each track gets its element on first use, so the one just started is the newest.
  const originalAudio = lastAudio();
  assert.ok(originalAudio, 'starting a track puts an element behind it');
  assert.equal(view.result.current.clipPlayState.original, 'playing');

  await act(async () => {
    view.result.current.toggleClipPlayback('trimmed');
  });

  const trimmedAudio = lastAudio();
  assert.notEqual(trimmedAudio, originalAudio, 'the filtered track sounds through an element of its own');
  assert.equal(view.result.current.clipPlayState.trimmed, 'playing', 'the second track starts');
  assert.equal(
    view.result.current.clipPlayState.original,
    'idle',
    'and the first one stops — two speakers is what the pair exists to avoid',
  );
  assert.ok(originalAudio.pauseCalls > 0, 'stopping the first track is not just a state change');
  assert.equal(trimmedAudio.pauseCalls, 0, 'the track that is sounding was not paused by its own start');
});

/* ─── Read-aloud is mutually exclusive ─────────────────────────────── */

test('playing a clip stops read-aloud first', async () => {
  const { view } = renderVoice();
  await record(view, 1000);
  const stopReadAloud = vi.spyOn(voicePlayer, 'stop');

  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });

  assert.equal(stopReadAloud.mock.calls.length, 1, 'two audio sources at once is noise');
});

test('read-aloud taking over pauses the clip', async () => {
  const { view } = renderVoice();
  await record(view, 1000);
  await act(async () => {
    view.result.current.toggleClipPlayback('original');
  });
  const audio = lastAudio();
  const pausesBefore = audio.pauseCalls;
  vi.spyOn(voicePlayer, 'isBusy').mockReturnValue(true);

  await act(async () => {
    voicePlayer.stop();
  });

  assert.ok(audio.pauseCalls > pausesBefore, 'the clip has to yield the speakers');
  assert.equal(view.result.current.clipPlayState.original, 'idle');
});

/* ─── Failure path ─────────────────────────────────────────────────── */

test('a rejected play() returns the pill to idle and reports the error once', async () => {
  const { view, onError } = renderVoice();
  await record(view, 1000);
  // Deferred, so the loading state is observable before the rejection lands.
  let rejectPlay: (reason: unknown) => void = () => undefined;
  nextPlayResult = new Promise<void>((_resolve, reject) => {
    rejectPlay = reject;
  });

  act(() => {
    view.result.current.toggleClipPlayback('original');
  });
  assert.equal(view.result.current.clipPlayState.original, 'loading', 'the control shows it is working');

  await act(async () => {
    rejectPlay(new DOMException('Playback blocked', 'NotAllowedError'));
  });

  assert.equal(
    view.result.current.clipPlayState.original,
    'idle',
    'a rejected play() must not strand the pill in loading',
  );
  assert.equal(onError.mock.calls.length, 1, 'the user is told once, through the existing bubble');
  assert.match(String(onError.mock.calls[0]?.[0]), /Playback blocked/);
});

/* ─── Render face ──────────────────────────────────────────────────── */

/**
 * The tier the composer reads, as it reads it: `window.innerWidth` against `md` (768), taken by
 * `useDeviceSettings` in a state initialiser.
 */
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const MOBILE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
const NARROW_DESKTOP_WIDTH = 768;

const CLIP_ROW_SELECTOR = '[data-slot="prompt-input-clip-row"]';
const FOOTER_SELECTOR = '[data-slot="prompt-input-footer"]';
const TOOLS_SELECTOR = '[data-slot="prompt-input-tools"]';
const TEXTAREA_SELECTOR = '[data-slot="prompt-input-textarea"]';

const describePlacement = (root: HTMLElement, control: HTMLElement | null) => {
  if (!control) return 'no replay control rendered';
  const slots: string[] = [];
  for (let node = control.parentElement; node && node !== root; node = node.parentElement) {
    const slot = node.getAttribute('data-slot');
    if (slot) slots.push(slot);
  }
  return slots.length > 0 ? slots.join(' < ') : 'in no labelled slot';
};

/** Renders the composer with a capture engine this file can speak into. */
const renderComposer = (onVoiceTranscript: (text: string, send?: boolean) => void) =>
  render(
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

/** Records one press through the composer's own buttons — the path a user takes, not the hook's API. */
const recordThroughComposer = async (view: ReturnType<typeof render>) => {
  await act(async () => {
    view.getByRole('button', { name: 'Voice input' }).click();
  });
  await act(async () => {
    capture.speak(1);
  });
  await act(async () => {
    view.getByRole('button', { name: 'Stop recording' }).click();
  });
  await act(async () => {});
};

test('(a) mobile: the pair lands in its own row between the box and the footer, one control per track', async () => {
  setViewportWidth(MOBILE_WIDTH);
  const view = renderComposer(() => undefined);
  const { container, getByRole } = view;

  await recordThroughComposer(view);

  const row = container.querySelector<HTMLElement>(CLIP_ROW_SELECTOR);
  assert.ok(
    row,
    `a listen at ${MOBILE_WIDTH}px must give the replay pair a row of its own; the controls read: ${describePlacement(container, container.querySelector('button[aria-label="Replay original"]'))}`,
  );
  const textarea = container.querySelector<HTMLElement>(TEXTAREA_SELECTOR);
  const footer = container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  assert.ok(textarea && footer, 'the composer must render its box and its footer');
  assert.ok(
    textarea.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the clip row has to come after the textarea',
  );
  assert.ok(
    row.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the clip row has to come before the footer',
  );
  assert.equal(footer.contains(row), false, 'the clip row is not a row inside the footer');

  const replayOriginal = getByRole('button', { name: 'Replay original' });
  const replayTrimmed = getByRole('button', { name: 'Replay trimmed' });
  assert.ok(
    row.contains(replayOriginal) && row.contains(replayTrimmed),
    `both controls belong to the clip row; they read: ${describePlacement(container, replayOriginal)}`,
  );
  assert.notEqual(
    replayOriginal.getAttribute('data-clip-url'),
    replayTrimmed.getAttribute('data-clip-url'),
    'the two controls have to be over two different audio sources',
  );

  await act(async () => {
    replayOriginal.click();
  });
  assert.ok(
    getByRole('button', { name: 'Stop original playback' }),
    'while the clip sounds the control has to announce that pressing it stops',
  );
});

test('(b) desktop: the pair stays in the left tool group inside the footer, left of the mic', async () => {
  setViewportWidth(DESKTOP_WIDTH);
  const view = renderComposer(() => undefined);
  const { container, getByRole } = view;

  await recordThroughComposer(view);

  assert.equal(
    container.querySelector(CLIP_ROW_SELECTOR),
    null,
    'the clip row is the narrow layout\'s; the wide layout keeps the controls where they were',
  );

  const tools = container.querySelector<HTMLElement>(TOOLS_SELECTOR);
  const footer = container.querySelector<HTMLElement>(FOOTER_SELECTOR);
  assert.ok(tools && footer, 'the composer must render its tool group and its footer');

  const replayOriginal = getByRole('button', { name: 'Replay original' });
  const replayTrimmed = getByRole('button', { name: 'Replay trimmed' });
  assert.ok(footer.contains(replayOriginal) && footer.contains(replayTrimmed));
  assert.ok(tools.contains(replayOriginal) && tools.contains(replayTrimmed));

  // The dictation mic moved beside the submit button's Live Voice double (2026-10-19), so the
  // pair — which stays in the left tool group — is now to its LEFT in document order. The claim
  // is still the useful one: the pair and the mic that produced it are in the same footer, with
  // the mic after the pair rather than replacing it.
  const mic = getByRole('button', { name: 'Voice input' });
  assert.ok(
    replayOriginal.compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the microphone sits right of the pair it recorded',
  );

  for (const [track, control] of [['original', replayOriginal], ['trimmed', replayTrimmed]] as const) {
    const text = control.textContent?.trim() ?? '';
    assert.match(text, /^\d+:\d{2}(?::\d{2})?$/, `the ${track} control must read its duration; it read "${text}"`);
  }
});

test('(b) the pair\'s home at the narrowest desktop width: still the tool group, and that group may wrap it', async () => {
  setViewportWidth(NARROW_DESKTOP_WIDTH);
  const view = renderComposer(() => undefined);
  const { container, getByRole } = view;

  await recordThroughComposer(view);

  assert.equal(container.querySelector(CLIP_ROW_SELECTOR), null, 'this width is not the mobile layout');

  const tools = container.querySelector<HTMLElement>(TOOLS_SELECTOR);
  assert.ok(tools, 'the composer must render its tool group');
  const replayOriginal = getByRole('button', { name: 'Replay original' });
  const replayTrimmed = getByRole('button', { name: 'Replay trimmed' });
  assert.ok(tools.contains(replayOriginal) && tools.contains(replayTrimmed));
  assert.equal(
    Array.from(tools.classList).includes('flex-wrap'),
    true,
    `the group holding the pair has to be allowed to take a second line; class="${tools.className}"`,
  );
});

test('(c) mobile: with nothing recorded the clip row does not exist at all, not empty', () => {
  setViewportWidth(MOBILE_WIDTH);
  const view = renderComposer(() => undefined);
  const { container, queryByRole } = view;

  assert.equal(queryByRole('button', { name: 'Replay original' }), null, 'nothing recorded means no control');
  assert.equal(container.querySelector(CLIP_ROW_SELECTOR), null, 'the row is conditional on the clip');
  assert.ok(container.querySelector(TEXTAREA_SELECTOR), 'the composer must have rendered its box');
  assert.ok(container.querySelector(FOOTER_SELECTOR), 'the composer must have rendered its footer');
});

test('(d) one track at a time: starting the filtered replay stops the original, and the names follow', async () => {
  setViewportWidth(MOBILE_WIDTH);
  const view = renderComposer(() => undefined);
  const { queryByRole, getByRole } = view;

  await recordThroughComposer(view);

  await act(async () => {
    getByRole('button', { name: 'Replay original' }).click();
  });
  assert.equal(queryByRole('button', { name: 'Replay original' }), null, 'the states are told apart by name');
  assert.ok(getByRole('button', { name: 'Replay trimmed' }), 'the other track never sounded, so it still offers to');

  await act(async () => {
    getByRole('button', { name: 'Replay trimmed' }).click();
  });

  assert.ok(getByRole('button', { name: 'Stop trimmed playback' }), 'the second track takes the speakers');
  assert.ok(getByRole('button', { name: 'Replay original' }), 'and the first one is back to offering to play');
});

/* ─── What the pill reads: the duration ────────────────────────────── */

const SILENT: VoiceClipPlayState = { original: 'idle', trimmed: 'idle' };

const renderClipButton = (clips: VoiceClipSlot) =>
  render(React.createElement(VoiceClipButton, { clips, state: SILENT, onToggle: () => undefined }));

/** A clip of the given length; the bytes are deliberately large so a byte count would be unmistakable. */
const clipOf = (url: string, durationMs: number): VoiceClipSlot['original'] => ({
  url,
  meta: { bytes: 2_097_152, mimeType: 'audio/webm', durationMs },
});

test('the replay pill reads the duration alone: the byte count that made a good trim look heavy is gone', () => {
  const { container } = renderClipButton({ original: clipOf('blob:two-megabyte-take', 47_000), trimmed: null });

  const text = container.textContent ?? '';
  for (const unit of ['MB', 'KB', ' B']) {
    assert.equal(text.includes(unit), false, `the pill must not carry a byte count; it read "${text}"`);
  }
  assert.equal(text.trim(), '0:47', `the pill's whole text is the duration; it read "${text}"`);
});

test('the pill formats M:SS below an hour and H:MM:SS from an hour', () => {
  const cases: Array<{ ms: number; label: string }> = [
    { ms: 3_000, label: '0:03' },
    { ms: 59_000, label: '0:59' },
    { ms: 61_000, label: '1:01' },
    { ms: 3_599_000, label: '59:59' },
    { ms: 3_600_000, label: '1:00:00' },
    { ms: 3_723_000, label: '1:02:03' },
    { ms: 0, label: '0:00' },
  ];
  for (const { ms, label } of cases) {
    const { container, unmount } = renderClipButton({ original: clipOf(`blob:duration-${ms}`, ms), trimmed: null });
    const text = container.textContent?.trim() ?? '';
    assert.equal(text, label, `a ${ms}ms clip has to read "${label}"; it read "${text}"`);
    unmount();
  }
});

test('with no raw stream kept the filtered track still offers its control, and nothing is disabled', () => {
  // The shape a stream past `ORIGINAL_CAP_SEC` leaves: the raw track is gone, the filtered one is not.
  const { container, queryByRole } = renderClipButton({
    original: null,
    trimmed: { url: 'blob:trimmed-only', meta: { bytes: 32_000, mimeType: 'audio/wav', durationMs: 19_000 } },
  });

  const buttons = Array.from(container.querySelectorAll('button'));
  assert.equal(buttons.length, 1, 'a slot with no raw stream offers one control, not two');
  assert.equal(buttons[0]?.getAttribute('data-clip-url'), 'blob:trimmed-only', 'the surviving control is the filtered one');
  assert.equal(buttons[0]?.disabled, false, 'the filtered control is live');
  assert.equal(
    queryByRole('button', { name: 'Replay original' }),
    null,
    'the absent raw stream is not offered as a disabled control either',
  );
  assert.equal(container.textContent?.trim(), '0:19');
});

test('when both tracks are present the pair reads original then filtered', () => {
  const { container } = renderClipButton({
    original: clipOf('blob:pair-original', 47_000),
    trimmed: { url: 'blob:pair-trimmed', meta: { bytes: 32_000, mimeType: 'audio/wav', durationMs: 19_000 } },
  });

  const buttons = Array.from(container.querySelectorAll('button'));
  assert.deepEqual(
    buttons.map((button) => button.getAttribute('data-clip-url')),
    ['blob:pair-original', 'blob:pair-trimmed'],
    'the pair is ordered original, filtered',
  );
  assert.deepEqual(
    buttons.map((button) => button.textContent?.trim()),
    ['0:47', '0:19'],
    'and each control shows its own track',
  );
});
