import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CockpitHubState,
  CockpitPendingSend,
  QuayFocusableObject,
} from '@/shared/types';
import type { VadEvent } from '@/shared/voiceEndpoint';
import { i18n } from '@/modules/i18n';
import CockpitRemote from '@/modules/cockpit/CockpitRemote';
import type { VoiceCaptureEngine, VoiceCaptureSink } from '@/modules/chat';
import type * as ChatModule from '@/modules/chat';
import type * as SharedApi from '@/shared/api';

/**
 * The phone remote: every control turns into the hub's own semantic event, a phrase is turned
 * into an `utterance` rather than sent, and the one irreversible act — releasing the confirmed
 * message — happens exactly once, on the device that spoke.
 *
 * THE HUB IS A FAKE CONNECTION, COUNTED. The remote is tested against a recorded connection
 * (`dispatch` counts every event) whose `state` the test sets, because what the page must not
 * do is keep a second copy of the cockpit: every reading below is either an event it sent or a
 * broadcast it rendered.
 *
 * DICTATION RUNS THE REAL CHAIN. `@/modules/chat`'s `useVoiceInput` is wrapped in a spy but not
 * replaced, with a fake capture engine pushing PCM and a stubbed recogniser answering — so "the
 * remote uses the composer's hook" is an observed call and the transcript really travels the
 * segmenter and the upload path.
 */

const useVoiceInputSpy = vi.hoisted(() => vi.fn());
const transcribeVoice = vi.hoisted(() => vi.fn());

const hubMock = vi.hoisted(() => ({
  state: null as unknown,
  connected: true,
  dispatch: vi.fn(),
  reportVisible: vi.fn(),
  options: undefined as unknown,
}));

const apiMock = vi.hoisted(() => ({
  voice: {
    capture: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    writeLabels: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  },
}));

vi.mock('@/modules/cockpit/hooks/useCockpitHub', () => ({
  useCockpitHub: (options: unknown) => {
    hubMock.options = options;
    return {
      state: hubMock.state,
      connected: hubMock.connected,
      dispatch: hubMock.dispatch,
      reportVisible: hubMock.reportVisible,
    };
  },
}));

vi.mock('@/modules/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatModule>();
  // Wrap, do not replace: the real hook must still run, and every call through the barrel is
  // visible. This is the reading AC2 asks for — the remote really reaches this export.
  useVoiceInputSpy.mockImplementation(actual.useVoiceInput);
  return { ...actual, useVoiceInput: useVoiceInputSpy };
});

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    api: apiMock,
    transcribeVoice,
    captureRawVoice: vi.fn(),
    effectivePauseCuesDeclaration: () => null,
  };
});

// The voice switches, pinned: VAD on (the shipped default), no debug readings, no edge trimming.
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  voiceDebugFlushSilenceSec: () => undefined,
  voiceDebugMinSegmentSec: () => undefined,
  voiceDebugIdleSec: () => undefined,
  voiceDebugOriginalCapSec: () => undefined,
}));

const TRANSCRIPT = '把这个任务改短一点';
const FOCUS_URI = 'quay://alpha/board';
const SECOND_URI = 'quay://beta/board';

const FIRST: QuayFocusableObject = {
  uri: FOCUS_URI,
  label: '①',
  display: { status: 'running', color: 'green', ordinal: 1, pos: { row: 1, column: 1 } },
};
const SECOND: QuayFocusableObject = {
  uri: SECOND_URI,
  label: '②',
  display: { status: 'stale', color: 'amber', ordinal: 2, pos: { row: 2, column: 1 } },
};

const PENDING: CockpitPendingSend = {
  text: '看 alpha',
  visible: [FIRST, SECOND],
  viewUri: 'quay://alpha/board',
  focusUri: FOCUS_URI,
  target: {
    sessionId: 'session-1',
    projectId: 'p1',
    projectName: 'Alpha',
    sessionTitle: 'Alpha chat',
    source: 'pinned',
    fleetUnavailableReason: null,
  },
  reason: null,
};

function hubState(overrides: Partial<CockpitHubState> = {}): CockpitHubState {
  return {
    rev: 1,
    view: { type: 'fleet' },
    viewStack: [],
    focusUri: FOCUS_URI,
    tray: [],
    history: [FOCUS_URI],
    visible: { viewUri: null, focusables: [FIRST, SECOND], projects: [] },
    pendingSend: null,
    lastEventSource: null,
    ...overrides,
  };
}

/**
 * A capture engine this file drives by hand — the microphone and audio thread, reduced to the
 * sink contract the dictation hook consumes.
 */
function createFakeCapture() {
  const sampleRate = 16_000;
  let sink: VoiceCaptureSink | null = null;
  let atSample = 0;
  let starts = 0;
  let stops = 0;
  const frame = (seconds: number, amplitude: number, events: readonly VadEvent[]): void => {
    if (sink === null) throw new Error('frame pushed before the capture was started');
    const samples = new Float32Array(Math.max(1, Math.round(seconds * sampleRate)));
    samples.fill(amplitude);
    sink.onFrame(samples, atSample, events);
    atSample += samples.length;
  };
  const engine: VoiceCaptureEngine = {
    async start(_stream, nextSink) {
      starts += 1;
      sink = nextSink;
      atSample = 0;
      return sampleRate;
    },
    stop() {
      stops += 1;
      sink = null;
    },
  };
  return {
    engine,
    speak(seconds: number, amplitude = 0.3) {
      if (sink === null) throw new Error('speech pushed before the capture was started');
      sink.onActivity();
      frame(seconds, amplitude, [{ type: 'speechStart', atSample }]);
    },
    active: () => sink !== null,
    starts: () => starts,
    stops: () => stops,
  };
}

function renderRemote(captureEngine?: VoiceCaptureEngine) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CockpitRemote {...(captureEngine === undefined ? {} : { captureEngine })} />
    </I18nextProvider>,
  );
}

/** The remote's own input box: the element typed into and dictated into. */
function textarea(): HTMLTextAreaElement {
  return screen
    .getByTestId('cockpit-remote-input')
    .querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
}

/** The semantic events the page sent, in order. */
function dispatched(): unknown[] {
  return hubMock.dispatch.mock.calls.map((call) => call[0]);
}

let secureContextDescriptor: PropertyDescriptor | undefined;

beforeEach(async () => {
  // `restoreMocks: true` strips implementations before every test, so the barrel's real hook is
  // re-installed here: the spy counts calls, it never replaces the hook.
  const actualChat = await vi.importActual<typeof ChatModule>('@/modules/chat');
  useVoiceInputSpy.mockReset();
  useVoiceInputSpy.mockImplementation(actualChat.useVoiceInput);
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: TRANSCRIPT }) });
  hubMock.dispatch.mockReset();
  hubMock.reportVisible.mockReset();
  hubMock.state = hubState();
  hubMock.connected = true;
  hubMock.options = undefined;
  secureContextDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:voice-clip'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  if (secureContextDescriptor === undefined) {
    delete (window as unknown as { isSecureContext?: boolean }).isSecureContext;
  } else {
    Object.defineProperty(window, 'isSecureContext', secureContextDescriptor);
  }
});

describe('AC1: every control is the hub event it names', () => {
  it('announces the input role only, so it never overwrites the display\'s visible set', () => {
    renderRemote();
    expect(hubMock.options).toEqual({ roles: ['input'] });
  });

  it('sends move / zoom / back / pin for the direction pad and the action keys', () => {
    renderRemote();
    fireEvent.click(screen.getByTestId('cockpit-remote-move-up'));
    fireEvent.click(screen.getByTestId('cockpit-remote-move-down'));
    fireEvent.click(screen.getByTestId('cockpit-remote-move-left'));
    fireEvent.click(screen.getByTestId('cockpit-remote-move-right'));
    fireEvent.click(screen.getByTestId('cockpit-remote-zoom-in'));
    fireEvent.click(screen.getByTestId('cockpit-remote-zoom-out'));
    fireEvent.click(screen.getByTestId('cockpit-remote-back'));
    fireEvent.click(screen.getByTestId('cockpit-remote-pin'));

    expect(dispatched()).toEqual([
      { type: 'move', direction: 'up' },
      { type: 'move', direction: 'down' },
      { type: 'move', direction: 'left' },
      { type: 'move', direction: 'right' },
      { type: 'zoom', direction: 'in' },
      { type: 'zoom', direction: 'out' },
      { type: 'back' },
      { type: 'pin' },
    ]);
  });

  it('unpins instead of pinning when the focused object is already in the tray', () => {
    hubMock.state = hubState({ tray: [FOCUS_URI] });
    renderRemote();
    fireEvent.click(screen.getByTestId('cockpit-remote-pin'));
    expect(dispatched()).toEqual([{ type: 'unpin', uri: FOCUS_URI }]);
  });

  it('turns a submitted phrase into an utterance and never sends it itself', () => {
    renderRemote();
    fireEvent.change(textarea(), { target: { value: '看 alpha' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    expect(dispatched()).toEqual([{ type: 'utterance', text: '看 alpha' }]);
    expect(textarea().value).toBe('');
  });

  it('shows the pending card and confirms it exactly once', () => {
    hubMock.state = hubState({ pendingSend: PENDING });
    renderRemote();

    expect(screen.getByTestId('cockpit-remote-preview-line').textContent).toContain('看 alpha');
    expect(screen.getByTestId('cockpit-remote-preview-line').textContent).toContain('Alpha');

    const confirm = screen.getByTestId('cockpit-remote-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(dispatched()).toEqual([{ type: 'confirm' }]);
    // A second press while the same card is open is refused on this side too.
    expect((screen.getByTestId('cockpit-remote-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends cancel for the card\'s other button', () => {
    hubMock.state = hubState({ pendingSend: PENDING });
    renderRemote();
    fireEvent.click(screen.getByTestId('cockpit-remote-cancel'));
    expect(dispatched()).toEqual([{ type: 'cancel' }]);
  });

  it('disables confirm when nothing is pending', () => {
    renderRemote();
    expect((screen.getByTestId('cockpit-remote-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('cockpit-remote-pending')).toBeNull();
  });

  it('disables the microphone in an insecure context, says why, and still submits typing', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    renderRemote();

    const hold = screen.getByTestId('cockpit-remote-hold') as HTMLButtonElement;
    expect(hold.disabled).toBe(true);
    expect(screen.getByTestId('cockpit-remote-insecure').textContent).toContain('HTTPS');

    fireEvent.change(textarea(), { target: { value: '看 beta' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(dispatched()).toEqual([{ type: 'utterance', text: '看 beta' }]);
  });
});

describe('AC3: the focus card names what the ordinal points at', () => {
  it('shows the project name beside the ordinal and status', () => {
    hubMock.state = hubState({
      visible: {
        viewUri: null,
        focusables: [FIRST, SECOND],
        projects: [
          { projectId: 'p1', fleetProjectId: 'alpha', name: 'Alpha', projectPath: '/work/alpha' },
        ],
      },
    });
    renderRemote();

    const card = screen.getByTestId('cockpit-remote-focus');
    expect(card.textContent).toContain('①');
    expect(card.textContent).toContain('running');
    // 「① running」 alone does not say WHICH project the phone is commanding.
    expect(screen.getByTestId('cockpit-remote-focus-name').textContent).toBe('Alpha');
  });

  it('names a focused task by its task id', () => {
    const task: QuayFocusableObject = {
      uri: 'quay://alpha/task/task-a',
      label: '①',
      display: { status: 'implementing', color: 'green', ordinal: 1, pos: { row: 1, column: 1 } },
    };
    hubMock.state = hubState({
      focusUri: task.uri,
      visible: {
        viewUri: 'quay://alpha/board',
        focusables: [task],
        projects: [
          { projectId: 'p1', fleetProjectId: 'alpha', name: 'Alpha', projectPath: '/work/alpha' },
        ],
      },
    });
    renderRemote();

    expect(screen.getByTestId('cockpit-remote-focus-name').textContent).toBe('task-a');
  });

  it('falls back to the address’s project segment when the roster does not name it', () => {
    hubMock.state = hubState({
      visible: { viewUri: null, focusables: [FIRST, SECOND], projects: [] },
    });
    renderRemote();

    expect(screen.getByTestId('cockpit-remote-focus-name').textContent).toBe('alpha');
  });
});

describe('AC2: dictation is the composer\'s hook and lands in the box', () => {
  it('reaches useVoiceInput through the @/modules/chat barrel, with the visible labels as hotwords', () => {
    renderRemote();
    expect(useVoiceInputSpy).toHaveBeenCalled();

    const options = useVoiceInputSpy.mock.calls.at(-1)?.[2] as { candidates?: string[] } | undefined;
    expect(options?.candidates).toEqual(['①', '②']);
  });

  it('holds to talk, then puts the transcript in the input box instead of sending it', async () => {
    const capture = createFakeCapture();
    renderRemote(capture.engine);

    const hold = screen.getByTestId('cockpit-remote-hold') as HTMLButtonElement;
    await act(async () => {
      fireEvent.pointerDown(hold, { pointerId: 1 });
    });
    expect(capture.active()).toBe(true);

    await act(async () => {
      capture.speak(1);
    });
    await act(async () => {
      fireEvent.pointerUp(hold, { pointerId: 1 });
    });

    await waitFor(() => expect(textarea().value).toContain(TRANSCRIPT));
    // Dictation edited the box; nothing was submitted to the hub.
    expect(dispatched()).toEqual([]);
  });

  it('closes the listen when the button is released before the microphone finishes opening', async () => {
    // A quick tap: the release lands while `getUserMedia` is still pending, so the stop at that
    // moment has no session to close. The recorder must still be torn down once it opens —
    // otherwise the microphone stays live with nobody holding anything.
    const capture = createFakeCapture();
    renderRemote(capture.engine);

    const hold = screen.getByTestId('cockpit-remote-hold') as HTMLButtonElement;
    await act(async () => {
      fireEvent.pointerDown(hold, { pointerId: 1 });
      fireEvent.pointerUp(hold, { pointerId: 1 });
    });

    await waitFor(() => expect(capture.starts()).toBe(1));
    await waitFor(() => expect(capture.stops()).toBeGreaterThanOrEqual(1));
    expect(capture.active()).toBe(false);
  });

  it('appends a dictation to what was already typed', async () => {    const capture = createFakeCapture();
    renderRemote(capture.engine);
    fireEvent.change(textarea(), { target: { value: '前缀' } });

    const hold = screen.getByTestId('cockpit-remote-hold') as HTMLButtonElement;
    await act(async () => {
      fireEvent.pointerDown(hold, { pointerId: 1 });
    });
    await act(async () => {
      capture.speak(1);
    });
    await act(async () => {
      fireEvent.pointerUp(hold, { pointerId: 1 });
    });

    await waitFor(() => expect(textarea().value).toBe(`前缀 ${TRANSCRIPT}`));
    expect(dispatched()).toEqual([]);
  });
});
