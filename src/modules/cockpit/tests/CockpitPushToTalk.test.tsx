import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuayFocusableObject } from '@/shared/types';
import type { VadEvent } from '@/shared/voiceEndpoint';
import { i18n } from '@/modules/i18n';
import CockpitInput from '@/modules/cockpit/CockpitInput';
import { routeCockpitText } from '@/modules/cockpit/cockpitRouting';
import type {
  CockpitFleetPort,
  CockpitRouteDecision,
} from '@/modules/cockpit/cockpitRouting';
import type { CockpitProject } from '@/modules/cockpit/cockpitView';
import { useCockpitPushToTalk } from '@/modules/cockpit/hooks/useCockpitPushToTalk';
import type { VoiceCaptureEngine, VoiceCaptureSink } from '@/modules/chat';
import type * as ChatModule from '@/modules/chat';
import type * as SharedApi from '@/shared/api';

/**
 * The cockpit's push-to-talk: chat's ONE dictation hook, held Space as a second trigger, and the
 * rule that dictated text lands in the input box rather than leaving as a message.
 *
 * THE HOOK UNDER TEST IS THE REAL ONE. `useCockpitPushToTalk` is driven through a real
 * `useVoiceInput` (the chat barrel's export is wrapped in a spy, not replaced), with a fake capture
 * engine pushing PCM and a stubbed recogniser answering — so "the cockpit uses the same hook" is
 * an observed call, and the transcript really travels the segmenter and the upload path.
 */

const useVoiceInputSpy = vi.hoisted(() => vi.fn());
const transcribeVoice = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => ({
  voice: {
    capture: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    writeLabels: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  },
}));

vi.mock('@/modules/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatModule>();
  // Wrap, do not replace: the real hook must still run, and every call through the barrel is
  // visible. This is the reading AC3 asks for — the cockpit's hook really reaches this export.
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

/**
 * A capture engine this file drives by hand — the microphone and audio thread, reduced to the
 * sink contract the dictation hook consumes. It lives here rather than being borrowed from
 * chat's test directory because a cross-module import may only enter through a barrel, and a
 * test helper is not part of chat's public API.
 */
function createFakeCapture() {
  const sampleRate = 16_000;
  let sink: VoiceCaptureSink | null = null;
  let atSample = 0;
  const frame = (seconds: number, amplitude: number, events: readonly VadEvent[]): void => {
    if (sink === null) throw new Error('frame pushed before the capture was started');
    const samples = new Float32Array(Math.max(1, Math.round(seconds * sampleRate)));
    samples.fill(amplitude);
    sink.onFrame(samples, atSample, events);
    atSample += samples.length;
  };
  const engine: VoiceCaptureEngine = {
    async start(_stream, nextSink) {
      sink = nextSink;
      atSample = 0;
      return sampleRate;
    },
    stop() {
      sink = null;
    },
  };
  return {
    engine,
    /** Speech-level audio with a `speechStart` event, so the segmenter closes a segment. */
    speak(seconds: number, amplitude = 0.3) {
      if (sink === null) throw new Error('speech pushed before the capture was started');
      sink.onActivity();
      frame(seconds, amplitude, [{ type: 'speechStart', atSample }]);
    },
    active: () => sink !== null,
  };
}

const TRANSCRIPT = '把这个任务改短一点';

const FOCUS_URI = 'quay://claudecodeui/task/x';

const FOCUSABLE: QuayFocusableObject = {
  uri: FOCUS_URI,
  label: '①',
  display: { status: 'in_progress', color: 'blue', ordinal: 1, pos: { row: 1, column: 1 } },
};

const PROJECTS: CockpitProject[] = [
  {
    projectId: 'p1',
    name: 'claudecodeui',
    projectPath: '/work/claudecodeui',
    driverState: 'running',
    tasks: { total: 1, todo: 0, ready: 1, needsHuman: 0, done: 0 },
    cached: false,
    error: null,
  },
];

/** A deterministic fleet answer: the routing outcome must not depend on when this file runs. */
const FLEET: CockpitFleetPort = {
  readInterfaceSession: async () => ({ ok: true, interfaceSessionId: 'session-target' }),
  writeInterfaceSession: async () => ({ ok: true }),
  clearInterfaceSession: async () => ({ ok: true }),
};

/** The cockpit's single submit path, reproduced: one parser for typed and dictated text. */
async function decide(text: string): Promise<CockpitRouteDecision> {
  return routeCockpitText({
    text,
    visible: [FOCUSABLE],
    projects: PROJECTS,
    focusUri: FOCUS_URI,
    fleet: FLEET,
    recentSessionId: () => null,
  });
}

/**
 * The cockpit's input half, assembled the way `CockpitPage` assembles it: one controlled box,
 * the push-to-talk hook, and the same `decide` path on submit.
 */
function Harness({ captureEngine }: { captureEngine?: VoiceCaptureEngine }) {
  const [value, setValue] = useState('');
  const [decisions, setDecisions] = useState<CockpitRouteDecision[]>([]);
  const pushToTalk = useCockpitPushToTalk({
    onTranscript: (text) => setValue((previous) => (previous.trim() === '' ? text : `${previous} ${text}`)),
    ...(captureEngine === undefined ? {} : { captureEngine }),
  });

  return (
    <div>
      <CockpitInput
        value={value}
        onValueChange={setValue}
        onSubmit={(text) => {
          setValue('');
          void decide(text).then((decision) => setDecisions((previous) => [...previous, decision]));
        }}
        voiceState={pushToTalk.state}
        onVoiceToggle={pushToTalk.toggle}
        voiceInFlight={pushToTalk.inFlight}
      />
      <div data-testid="decisions" data-json={JSON.stringify(decisions)} />
      <div data-testid="voice-state" data-state={pushToTalk.state} />
    </div>
  );
}

function renderHarness(captureEngine?: VoiceCaptureEngine) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Harness {...(captureEngine === undefined ? {} : { captureEngine })} />
    </I18nextProvider>,
  );
}

/** The cockpit input's textarea, the element the person types (and dictates) into. */
function textarea(): HTMLTextAreaElement {
  return screen
    .getByTestId('cockpit-input')
    .querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement;
}

const decisions = (): CockpitRouteDecision[] =>
  JSON.parse(screen.getByTestId('decisions').getAttribute('data-json') ?? '[]') as CockpitRouteDecision[];

beforeEach(async () => {
  // `restoreMocks: true` (vitest.config.ts) strips implementations before every test, so the
  // barrel's real hook is re-installed here: the spy counts calls, it never replaces the hook.
  const actualChat = await vi.importActual<typeof ChatModule>('@/modules/chat');
  useVoiceInputSpy.mockReset();
  useVoiceInputSpy.mockImplementation(actualChat.useVoiceInput);
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: TRANSCRIPT }) });
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

describe('AC3: the cockpit uses chat\'s own dictation hook', () => {
  it('reaches useVoiceInput through the @/modules/chat barrel', () => {
    renderHarness();
    expect(useVoiceInputSpy).toHaveBeenCalled();
  });

  it('puts dictated text into the input box instead of sending it', async () => {
    const capture = createFakeCapture();
    renderHarness(capture.engine);

    await act(async () => {
      screen.getByRole('button', { name: 'Voice input' }).click();
    });
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeTruthy();

    await act(async () => {
      capture.speak(1);
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Stop recording' }).click();
    });

    await waitFor(() => expect(textarea().value).toContain(TRANSCRIPT));
    // Dictation edited the box; nothing was routed, previewed or sent.
    expect(decisions()).toEqual([]);
  });

  it('starts on Space held outside the input and stops on release', async () => {
    const capture = createFakeCapture();
    renderHarness(capture.engine);

    const down = new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(capture.active()).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
    });
    expect(capture.active()).toBe(false);
  });

  it('lets a focused input keep Space as a space, not as push-to-talk', async () => {
    const capture = createFakeCapture();
    renderHarness(capture.engine);
    textarea().focus();

    // `fireEvent` returns false when the page called preventDefault: a true here is the reading
    // that the key was left to the field.
    const delivered = fireEvent.keyDown(textarea(), { code: 'Space', key: ' ' });

    expect(delivered).toBe(true);
    expect(capture.active()).toBe(false);
  });

  it('routes typed and dictated submissions of the same words identically', async () => {
    const capture = createFakeCapture();
    renderHarness(capture.engine);

    // Dictated: speak, stop, then submit the box.
    await act(async () => {
      screen.getByRole('button', { name: 'Voice input' }).click();
    });
    await act(async () => {
      capture.speak(1);
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Stop recording' }).click();
    });
    await waitFor(() => expect(textarea().value).toContain(TRANSCRIPT));
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: 'Enter' });
    });
    await waitFor(() => expect(decisions()).toHaveLength(1));

    // Typed: the same words, through the same submit handler.
    await act(async () => {
      fireEvent.change(textarea(), { target: { value: TRANSCRIPT } });
      fireEvent.keyDown(textarea(), { key: 'Enter' });
    });
    await waitFor(() => expect(decisions()).toHaveLength(2));

    expect(decisions()[0]).toEqual(decisions()[1]);
  });
});
