import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

import type { VoiceLiveReading } from '../src/modules/chat/utils/voice/voiceLiveReading';

/*
 * The continuous voice path's own reading, read off a real page.
 *
 * WHAT IS REAL AND WHAT IS NOT. The composer, the hook, the segmenter, the shared VAD, the request
 * builder and the reading module are the shipping code. Three things are stand-ins, each named where
 * it lives:
 *
 *   · the microphone, because no CI machine has one and none could be told to say an exact timeline.
 *     An init script replaces `AudioContext`/`AudioWorkletNode` and `getUserMedia` with a graph the
 *     spec drives (`__voiceFake.speak(3)` feeds three seconds of speech and a `speechStart`), so
 *     everything downstream of the audio thread runs unchanged. The same fake context forwards
 *     `decodeAudioData` to a real context, so a chosen file still decodes for real.
 *
 *   · the recogniser. The settings name `dashscope-omni`, whose declaration is `proxy-only`, so the
 *     client posts to this app's `/api/voice/transcribe`; Playwright intercepts that route, so no
 *     request leaves the machine and no credential is spent.
 *
 *   · the corpus. `corpus/long/L3-sparse` and `L4-nonstop` are real human speech outside the repo.
 *     A missing sample is NAMED and fails — a run that quietly measured nothing is the one failure a
 *     measurement may not have.
 *
 * WHAT IS MEASURED. Every number comes from `window.__voiceLive`, the object the hook publishes at
 * the end of an input under the debug switch — never from a re-computation in this file. The A/B is
 * the same bytes over the same entry with the VAD on and with `voiceVad=off`, so the difference the
 * reading reports is a real difference between two runs, not an assertion about one.
 *
 * EVERY LEG NAMES BOTH SWITCHES. `voiceVad` — like `voiceDebug` and the numeric switches — is
 * REMEMBERED in `localStorage`, so a leg that named only `voiceDebug=1` would inherit whatever arm
 * the previous leg left behind and read the wrong thing. Naming `voiceVad=1` explicitly is what
 * makes "the VAD-on leg" mean the VAD really ran.
 */

const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-live-vad-workspace');
const SESSION_ID = 'e2e-voice-live-vad';
const SESSION_NAME = 'voice-live-vad';
/** The fixed corpus, the same directory the streaming-VAD criterion reads. */
const LONG_DIR = process.env.VAD_LONG ?? '/data/home/yale/work/tc-verify/corpus/long';

/** The sparse sample: mostly silence, so the cut has a lot to save. */
const SPARSE = 'L3-sparse';
/** The continuous sample: no pause long enough to cut on, so the ceiling is what cuts it. */
const NONSTOP = 'L4-nonstop';

/** The segmenter's ceiling. `longestSegmentSec` may not exceed it on a cut the ceiling made. */
const MAX_SEGMENT_SEC = 60;
/** One 20 ms frame — the segmenter's own grid — is the tolerance two runs' `recordedSec` match within. */
const FRAME_SEC = 0.02;
/** The upload entry's accessible name, and the one control the debug switch is allowed to add. */
const UPLOAD_LABEL = 'Upload audio file';

/** How long a corpus upload is given to decode, segment and settle. */
const READING_TIMEOUT_MS = 60_000;

test.describe.configure({ mode: 'serial' });

/** The controls a composer paints, as the parity criterion reads them. */
type ComposerControls = { buttons: string[]; testIds: string[] };

/**
 * AC-2b's "VAD on" verdict, factored out so a MUTATED reading can be tried against it.
 *
 * The criterion is a conjunction: the cut really saved audio (`sentSec < recordedSec`), it saved at
 * least half of it (`savedRatio >= 0.5`), and the input cost more than one request. Each leg of the
 * conjunction is a place a wrong reading would slip through, so it is a function of a reading rather
 * than an inlined set of expects.
 */
const vadOnVerdict = (reading: VoiceLiveReading): boolean =>
  reading.sentSec < reading.recordedSec && reading.savedRatio >= 0.5 && reading.requests >= 2;

/**
 * AC-2b's "VAD off" verdict: the whole recording went out, as one request in one piece.
 *
 * `sentSec == recordedSec` is asserted to within one frame rather than exactly: the WAV the path
 * builds is 16-bit at 16 kHz and the recording is measured in samples, so the two agree to the
 * sample, and one frame is a generous stand-in for "the same audio".
 */
const vadOffVerdict = (reading: VoiceLiveReading): boolean =>
  Math.abs(reading.sentSec - reading.recordedSec) <= FRAME_SEC
  && reading.requests === 1
  && reading.segments === 1;

test.describe('the live VAD reading end to end', () => {
  let context: BrowserContext;
  let page: Page;
  /** Every upload the recogniser stand-in saw, so a leg can wait on the request rather than a timer. */
  const uploads: string[] = [];
  /** Every `[voice:live]` line the page printed, so "exactly one" is a count and not an impression. */
  const liveLines: string[] = [];

  const composer = () => page.locator('[data-slot="prompt-input-textarea"]');
  const micButton = () => page.getByRole('button', { name: 'Voice input' });
  const stopButton = () => page.getByRole('button', { name: 'Stop recording' });
  const uploadEntry = () => page.getByRole('button', { name: UPLOAD_LABEL });
  /** The hidden input the upload entry owns, told apart from the attachment picker by what it accepts. */
  const uploadInput = () => page.locator('input[type="file"][accept="audio/*"]');
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${path.basename(WORKSPACE)}`) }).first();
  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

  /** Expands the project's session list, retrying past a sidebar that is still re-rendering. */
  const expandProject = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) return;
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        return;
      } catch {
        /* collapsed again; click once more */
      }
    }
    await expect(sessionLink()).toBeVisible({ timeout: 15_000 });
  };

  /**
   * Loads `url` (which names the switches), opens the seeded session, and empties the box.
   *
   * A full navigation is what makes each leg independent: the page's globals — `__voiceLive`
   * included — start fresh, and the switches the URL names are resolved by the module's own reader.
   */
  const openComposer = async (url: string) => {
    await page.goto(url);
    await expandProject();
    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    await expect(composer()).toBeVisible({ timeout: 15_000 });
    await composer().fill('');
    await expect(composer()).toHaveValue('');
  };

  /** The reading the page published, or null while it has not produced one. */
  const readLive = (): Promise<VoiceLiveReading | null> =>
    page.evaluate(() => (window as unknown as { __voiceLive?: VoiceLiveReading }).__voiceLive ?? null);

  /** Waits for the page's reading and returns it. The hook publishes it once, at the end of an input. */
  const waitReading = async (): Promise<VoiceLiveReading> => {
    await expect.poll(async () => (await readLive()) !== null, { timeout: READING_TIMEOUT_MS }).toBe(true);
    const reading = await readLive();
    if (!reading) throw new Error('the page published no reading after the wait reported one');
    return reading;
  };

  /** Asserts no reading exists yet, so a later wait cannot be satisfied by a previous leg's. */
  const expectNoReadingYet = async () => {
    expect(await readLive(), 'a reading survived a reload — the leg would read the wrong input').toBeNull();
  };

  /** The corpus sample's path, or a failure NAMING it when it is absent. */
  const requireSample = (id: string): string => {
    const file = path.join(LONG_DIR, `${id}.wav`);
    expect(
      fs.existsSync(file),
      `the corpus sample is missing at ${file} — the criterion cannot run without it`,
    ).toBe(true);
    return file;
  };

  /** One recorded input through the fake microphone, driving the fake audio graph by hand. */
  const micInput = async (seconds: number) => {
    const before = uploads.length;
    await micButton().click();
    await expect(stopButton()).toBeVisible({ timeout: 10_000 });
    await page.evaluate((n) => {
      (window as unknown as { __voiceFake: { speak: (s: number) => void } }).__voiceFake.speak(n);
    }, seconds);
    await stopButton().click();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBeGreaterThan(before);
  };

  /** One chosen corpus file through the upload entry, with the reading it settles into. */
  const uploadSample = async (file: string): Promise<VoiceLiveReading> => {
    await expectNoReadingYet();
    await expect(uploadEntry()).toBeVisible({ timeout: 10_000 });
    await uploadInput().setInputFiles(file);
    return waitReading();
  };

  /** The controls inside the composer, as names and testids rather than positions. */
  const composerControls = (): Promise<ComposerControls> =>
    page.evaluate(() => {
      const root = document.querySelector('[data-slot="prompt-input"]');
      if (!root) return { buttons: [], testIds: [] };
      const buttons = Array.from(root.querySelectorAll('button')).map((button) =>
        (button.getAttribute('aria-label') || button.textContent || '').trim(),
      );
      const testIds = Array.from(root.querySelectorAll('[data-testid]')).map((element) =>
        element.getAttribute('data-testid') ?? '',
      );
      return { buttons, testIds };
    });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(60_000);

    context = await browser.newContext({ baseURL: CLIENT_URL });
    await context.addInitScript(
      ({ voiceConfig, preferences }) => {
        window.localStorage.setItem('voiceConfig', JSON.stringify(voiceConfig));
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem(
          'user-preferences',
          JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }),
        );
        window.localStorage.setItem('userLanguage', 'en');

        // The real decoder, captured before the fake replaces the global: a chosen file still has to
        // decode for real. Asking it for 16 kHz matches the corpus' own rate, so the segmenter gets
        // the samples it would have got from the file unchanged.
        const RealAudioContext = (window as unknown as { AudioContext: new (options?: unknown) => AudioContext }).AudioContext;
        let decodeContext: AudioContext | null = null;
        const decodingContext = (): AudioContext => {
          decodeContext ??= new RealAudioContext({ sampleRate: 16_000 });
          return decodeContext;
        };

        // The fake audio graph. `speak`/`pause` are the driver the spec uses; `node` is where the
        // hook attaches its `onmessage`, captured at construction.
        type Port = { port: { onmessage: ((m: unknown) => void) | null } };
        const state: {
          node: Port | null;
          atSample: number;
          speak: (seconds: number) => void;
          pause: (seconds: number) => void;
        } = {
          node: null,
          atSample: 0,
          // A speech run: the `speechStart` is posted BEFORE the PCM, so the hook buffers it and hands
          // it to this same push — exactly the order the real worklet uses.
          speak(seconds: number) {
            const node = state.node;
            if (!node) throw new Error('the fake capture was not connected yet');
            node.port.onmessage?.({ data: { type: 'event', event: { type: 'speechStart', atSample: state.atSample } } });
            push(seconds, 0.3);
          },
          // A pause: the `speechEnd` is posted first, then the silence itself.
          pause(seconds: number, amplitude = 0) {
            const node = state.node;
            if (!node) throw new Error('the fake capture was not connected yet');
            node.port.onmessage?.({ data: { type: 'event', event: { type: 'speechEnd', atSample: state.atSample } } });
            push(seconds, amplitude);
          },
        };
        function push(seconds: number, amplitude: number): void {
          const node = state.node;
          if (!node) throw new Error('the fake capture was not connected yet');
          const count = Math.max(1, Math.round(seconds * 16_000));
          const samples = new Float32Array(count);
          samples.fill(amplitude);
          node.port.onmessage?.({ data: { type: 'pcm', samples, atSample: state.atSample } });
          state.atSample += count;
        }
        (window as unknown as { __voiceFake: typeof state }).__voiceFake = state;

        class FakeWorkletNode {
          port: { onmessage: ((m: unknown) => void) | null; postMessage: () => void };
          constructor() {
            this.port = { onmessage: null, postMessage: () => undefined };
            state.node = this as unknown as typeof state.node;
          }

          connect() {
            /* the graph is inert; the spec drives the port directly */
          }
        }

        class FakeAudioContext {
          sampleRate = 16_000;
          destination = {};
          audioWorklet = { addModule: async () => undefined };
          createGain() {
            return { gain: { value: 0 }, connect: () => undefined };
          }

          createMediaStreamSource() {
            return { connect: () => undefined };
          }

          // The one real thing this fake does: a chosen audio file is decoded by the browser's own
          // decoder, so the file entry travels the same decode the shipped path does.
          decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer> {
            return decodingContext().decodeAudioData(bytes);
          }

          close() {
            return Promise.resolve();
          }
        }

        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
        (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
        });
      },
      {
        // dashscope-omni is proxy-only, so the client posts to this app's /api/voice/transcribe; its
        // credential fields are what make the server call it configured.
        voiceConfig: {
          baseUrl: '',
          apiKey: '',
          sttModel: '',
          ttsModel: '',
          ttsVoice: '',
          ttsFormat: '',
          providerId: 'dashscope-omni',
          dashscopeEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          dashscopeApiKey: 'sk-e2e-live-vad-fake',
          dashscopeModel: 'qwen3-asr-flash',
        },
        preferences: { voiceEnabled: true },
      },
    );

    page = await context.newPage();
    page.on('console', (message) => {
      if (message.text().includes('[voice:live]')) liveLines.push(message.text());
    });

    // The one recogniser stand-in. It answers every upload, and returns a `usage` block so the
    // reading's own usage field has something real to accumulate.
    await page.route('**/api/voice/transcribe', async (route) => {
      uploads.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          text: 'a transcribed segment',
          usage: { prompt_tokens: 400, completion_tokens: 5, total_tokens: 405 },
        }),
      });
    });

    // First run on a fresh database: create the single account and finish onboarding, with the same
    // cold-Vite retry the other voice specs carry.
    await page.goto('/');
    let onboarded = await page.locator('#username').isVisible().catch(() => false);
    for (let attempt = 0; !onboarded && attempt < 3; attempt += 1) {
      await page.reload();
      onboarded = await page.locator('#username').isVisible().catch(() => false);
    }
    if (!onboarded) {
      const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
      throw new Error(`the account form never rendered; the page shows: ${JSON.stringify(shown.slice(0, 300))}`);
    }
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    // Create the single account on a fresh database, or sign in on one an earlier spec in the same
    // run already created: the voice specs are run in one invocation, and they share the run's
    // `auth.db`. The confirm field is what tells the forms apart — the setup form is the only one
    // with it, and it is always rendered, so its absence means the account already exists.
    if (await page.locator('#confirmPassword').isVisible().catch(() => false)) {
      await page.locator('#confirmPassword').fill('e2epassword');
      await page.getByRole('button', { name: 'Create Account' }).click();
      await page.getByPlaceholder('John Doe').fill('E2E User');
      await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Complete Setup' }).click();
    } else {
      await page.getByRole('button', { name: 'Sign In' }).click();
    }
    await expect(projectRow()).toBeVisible({ timeout: 12_000 });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('the reading exists only while the debug switch is on', async () => {
    test.setTimeout(45_000);

    // Switch NOT SET: the URL names neither switch, so `voiceDebug` is off by its own default — this
    // file's first leg, and nothing has remembered it on. A complete input still travels the whole
    // chain (the request is made), but it publishes no reading and prints no line.
    const beforeOff = liveLines.length;
    await openComposer('/');
    await micInput(3);
    expect(liveLines.length, 'the chain printed a reading line while the switch was off').toBe(beforeOff);
    expect(await readLive(), 'a reading was published while the switch was off').toBeNull();

    // Switch on: the same input, and exactly one line — one input, one reading.
    const beforeOn = liveLines.length;
    await openComposer('/?voiceDebug=1&voiceVad=1');
    await micInput(3);
    const reading = await waitReading();
    expect(liveLines.length - beforeOn, 'a single input printed something other than one reading').toBe(1);
    expect(reading.recordedSec).toBeGreaterThan(2);
  });

  test('the VAD A/B over one sample reads the difference the switch makes', async () => {
    test.setTimeout(120_000);
    const sparse = requireSample(SPARSE);

    // Leg ON: the shipping path. The sample is cut at its pauses, so less audio goes out than came in.
    await openComposer('/?voiceDebug=1&voiceVad=1');
    const on = await uploadSample(sparse);
    expect(vadOnVerdict(on), `the VAD-on reading does not show a saving: ${JSON.stringify(on)}`).toBe(true);

    // Leg OFF: the same bytes, whole, as one request — the "before" the reading's baseline describes.
    await openComposer('/?voiceDebug=1&voiceVad=off');
    const off = await uploadSample(sparse);
    expect(vadOffVerdict(off), `the VAD-off reading is not one whole request: ${JSON.stringify(off)}`).toBe(true);

    // The counterfactual is the same recording: the two runs must have read the same input.
    expect(
      Math.abs(on.recordedSec - off.recordedSec),
      `the two legs recorded different lengths: ${on.recordedSec} vs ${off.recordedSec}`,
    ).toBeLessThanOrEqual(FRAME_SEC);

    // AC-2c: the audio-token saving the reading reports IS the ratio of the requests it compares.
    const reduction = (off.estAudioTokens - on.estAudioTokens) / off.estAudioTokens;
    expect(
      Math.abs(reduction - on.savedRatio),
      `token reduction ${reduction} does not match savedRatio ${on.savedRatio}`,
    ).toBeLessThanOrEqual(0.01);

    // The A/B table the DoD asks for, printed so a green run leaves the numbers behind it.
    for (const [arm, reading] of [['vad-on', on], ['vad-off', off]] as const) {
      console.log(
        `[voice-live-ab] ${SPARSE} arm=${arm} recordedSec=${reading.recordedSec.toFixed(3)}`
          + ` sentSec=${reading.sentSec.toFixed(3)} savedRatio=${reading.savedRatio.toFixed(3)}`
          + ` segments=${reading.segments} requests=${reading.requests} forcedCuts=${reading.forcedCuts}`
          + ` longestSegmentSec=${reading.longestSegmentSec.toFixed(2)} longestWaitSec=${reading.longestWaitSec.toFixed(2)}`
          + ` firstTextLatencyMs=${String(reading.firstTextLatencyMs)} estAudioTokens=${reading.estAudioTokens.toFixed(1)}`,
      );
    }

    // AC-2g, the false forms — each must read RED, or the criterion is not discriminating.
    // (1) the saved ratio measured the wrong way round (fraction sent, not saved).
    const invertedRatio: VoiceLiveReading = { ...on, savedRatio: on.sentSec / on.recordedSec };
    expect(
      vadOnVerdict(invertedRatio),
      'the inverted saved ratio passed the VAD-on verdict — the criterion is not sensitive to it',
    ).toBe(false);
    // (2) `voiceVad=off` that still cut the input.
    const stillSegmented: VoiceLiveReading = { ...off, requests: off.requests + 1, segments: off.segments + 1 };
    expect(
      vadOffVerdict(stillSegmented),
      'a segmenting VAD-off reading passed the VAD-off verdict — the criterion is not sensitive to it',
    ).toBe(false);
    console.log(
      `[voice-live-ab] falseForms invertedRatioGreen=${vadOnVerdict(invertedRatio)}`
        + ` offStillSegmentedGreen=${vadOffVerdict(stillSegmented)}`,
    );
  });

  test('the ceiling forces a cut on continuous speech', async () => {
    test.setTimeout(90_000);
    const nonstop = requireSample(NONSTOP);

    await openComposer('/?voiceDebug=1&voiceVad=1');
    const reading = await uploadSample(nonstop);
    console.log(
      `[voice-live-ab] ${NONSTOP} arm=vad-on recordedSec=${reading.recordedSec.toFixed(3)}`
        + ` sentSec=${reading.sentSec.toFixed(3)} segments=${reading.segments} requests=${reading.requests}`
        + ` forcedCuts=${reading.forcedCuts} longestSegmentSec=${reading.longestSegmentSec.toFixed(2)}`
        + ` firstTextLatencyMs=${String(reading.firstTextLatencyMs)}`,
    );
    expect(
      reading.forcedCuts,
      `continuous speech produced no forced cut: ${JSON.stringify(reading)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      reading.longestSegmentSec,
      `a segment exceeded the ceiling: ${reading.longestSegmentSec}s > ${MAX_SEGMENT_SEC}s`,
    ).toBeLessThanOrEqual(MAX_SEGMENT_SEC);
  });

  test('a short input is one request with no forced cut', async () => {
    test.setTimeout(45_000);

    // Three seconds of continuous speech, well under the segmenter's 30 s floor: no pause can end it
    // and no ceiling can reach it, so the stop flushes it as the single trailing segment.
    await openComposer('/?voiceDebug=1&voiceVad=1');
    await micInput(3);
    const reading = await waitReading();
    expect(reading.requests, `a short input cost more than one request: ${JSON.stringify(reading)}`).toBe(1);
    expect(reading.forcedCuts, `a short input was force-cut: ${JSON.stringify(reading)}`).toBe(0);
    expect(reading.segments).toBe(1);
  });

  test('the composer controls change only by the upload entry', async () => {
    test.setTimeout(45_000);

    await openComposer('/?voiceDebug=off&voiceVad=1');
    const off = await composerControls();

    await openComposer('/?voiceDebug=1&voiceVad=1');
    const on = await composerControls();

    // The premise: the composer really painted, so an equal pair is a reading and not two blanks.
    expect(off.buttons.length, 'the composer painted no controls, so the comparison would be vacuous').toBeGreaterThan(0);

    // The testids are identical — the switch adds no identified element.
    expect([...on.testIds].sort()).toEqual([...off.testIds].sort());
    // The buttons differ by exactly the upload entry, in the multiset sense (its position is layout).
    expect([...on.buttons].sort()).toEqual([...off.buttons, UPLOAD_LABEL].sort());
  });
});
