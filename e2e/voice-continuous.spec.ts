import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

/*
 * Continuous capture, end to end, against the real client and the real backend.
 *
 * WHAT IS REAL AND WHAT IS NOT. The composer, the hook, the segmenter, the shared VAD and the request
 * builder are the shipping code. Two things are stand-ins, and each is named where it lives:
 *
 *   · the microphone, because no CI machine has one and a real one could not be told to say an exact
 *     timeline of speech and pauses. An init script replaces `AudioContext`/`AudioWorkletNode` and
 *     `getUserMedia` with a graph the spec drives: `__voiceFake.speak(1)` feeds one second of speech
 *     with a `speechStart`, `__voiceFake.pause(2.5)` feeds silence. That is the same interface the real
 *     worklet forwards (PCM frames plus VAD events), so everything downstream of the audio thread runs
 *     unchanged.
 *
 *   · the recogniser. The settings name `dashscope-omni`, whose declaration is `proxy-only`, so the
 *     client posts to this app's `/api/voice/transcribe`; Playwright intercepts that route, so the
 *     request never leaves the machine and no credential is spent. The route answers each upload with a
 *     sentence this file chooses, and can delay or fail an individual one — which is what lets the
 *     ordering, incremental and failure readings be taken at all.
 *
 * The fixture session is seeded by `playwright.config.ts` (the server scans its projects once at boot,
 * so a transcript written during the run would never be adopted).
 */

const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-continuous-workspace');
const SESSION_ID = 'e2e-voice-continuous';
const SESSION_NAME = 'voice-continuous';

/** What the recogniser stand-in answers each upload with, by the order the uploads arrive in. */
const ANSWERS = ['alpha bravo', 'charlie delta', 'echo foxtrot'];

/** Short enough that a two-word answer cannot be a coincidence with another leg's. */
const FULL_TWO = `${ANSWERS[0]} ${ANSWERS[1]}`;

/** A pause longer than the segmenter's cut threshold (2.0 s), so a cut lands inside it. */
const CUT_PAUSE_SEC = 2.6;

/** A spoken second and a pause: one segment per repetition, once the minimum is turned down. */
const SPEECH_SEC = 1;

/** The segment minimum every leg but the short-input one names, so a pause really ends a segment. */
const SMALL_MIN_SEC = 0.3;

/** The shipped silence-flush window, in seconds. A leg that means the default names this. */
const FLUSH_WINDOW_SEC = 5;

/**
 * A debug-shortened flush window: a leg can reach a flush without five real seconds of silence.
 *
 * Every leg that measures a flush NAMES this switch, because the flags are remembered in
 * `localStorage` — a leg that left it to the default would inherit whatever the previous leg set.
 */
const FLUSH_SEC = 0.5;

/**
 * The shipped idle auto-stop, in seconds, named by every flush leg so it is never inherited.
 *
 * The flags are remembered in `localStorage`, so the silent-listen leg's `voiceIdleSec=2` would
 * otherwise still be in force here — and a window measured in seconds of held request would close
 * the microphone out from under the leg. Every leg below that keeps the listen open names this.
 */
const IDLE_WINDOW_SEC = 120;

/**
 * One intercepted upload.
 *
 * `body` is the raw multipart payload, decoded as UTF-8: the relay context travels as a text field
 * in exactly that body, so a criterion can read what the browser actually sent rather than what the
 * hook meant to send.
 */
type Recorded = { url: string; answer: string; index: number; body: string };

test.describe.configure({ mode: 'serial' });

test.describe('the continuous voice path end to end', () => {
  let context: BrowserContext;
  let page: Page;
  /** Every upload the route saw, in arrival order. */
  const uploads: Recorded[] = [];
  /** Per-upload delay, in ms, keyed by arrival index. */
  let delayMs: Record<number, number> = {};
  /**
   * When set, every upload whose body is larger than this is refused.
   *
   * The body, not the arrival index, because a refused segment is retried: the retry is a new request
   * with a new index, so an index-keyed refusal would let a later attempt succeed. The largest segment
   * is the one the failure leg makes fail, and every one of its attempts carries the same bytes.
   */
  const failAboveBytes: { value: number | null } = { value: null };

  /**
   * Writes the DoD's evidence — a screenshot and a context excerpt — when a directory is named.
   *
   * OFF BY DEFAULT. A criterion must not write into the tree it is judging, so the capture only
   * happens for the run whose evidence is being collected (`P0_ARTIFACT_DIR`). The excerpt is the
   * multipart `context` field alone, which is the pack the model would read: no headers, no key,
   * no audio.
   */
  const captureEvidence = async (name: string, contextBody: string) => {
    const dir = process.env.P0_ARTIFACT_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
    const at = contextBody.indexOf('name="context"');
    writeFileSync(
      path.join(dir, `${name}.context.txt`),
      at >= 0 ? contextBody.slice(at) : '<no context field in the upload>',
    );
  };

  /** The composer's textarea, the one place committed text lands. */
  const composer = () => page.locator('[data-slot="prompt-input-textarea"]');
  const micButton = () => page.getByRole('button', { name: 'Voice input' });
  const stopButton = () => page.getByRole('button', { name: 'Stop recording' });
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

  /** Loads `url` (which names the debug switches), opens the fixture session, and empties the box. */
  const openComposer = async (url: string) => {
    await page.goto(url);
    await expandProject();
    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    await expect(composer()).toBeVisible({ timeout: 15_000 });
    await composer().fill('');
    await expect(composer()).toHaveValue('');
  };

  /** Starts a listen and waits for the fake graph to be connected. */
  const startListening = async (url: string) => {
    await openComposer(url);
    await micButton().click();
    await expect(stopButton()).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as { __voiceFake?: { node?: unknown } }).__voiceFake?.node)))
      .toBe(true);
  };

  /** Feeds `seconds` of speech followed by a pause long enough to close the segment. */
  const speakThenCut = async (seconds = SPEECH_SEC) => {
    await page.evaluate(([s, pause]) => {
      const fake = (window as unknown as { __voiceFake: { speak: (n: number) => void; pause: (n: number) => void } }).__voiceFake;
      fake.speak(s);
      fake.pause(pause);
    }, [seconds, CUT_PAUSE_SEC]);
  };

  /** Feeds `seconds` of speech followed by silence longer than the (debug) flush window. */
  const speakThenFlush = async (seconds = SPEECH_SEC) => {
    await page.evaluate(([s, pause]) => {
      const fake = (window as unknown as { __voiceFake: { speak: (n: number) => void; pause: (n: number) => void } }).__voiceFake;
      fake.speak(s);
      fake.pause(pause);
    }, [seconds, FLUSH_SEC + 0.3]);
  };

  /** The controls inside the composer, as names and testids rather than positions. */
  const composerControls = (): Promise<{ buttons: string[]; testIds: string[] }> =>
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

        // The fake audio graph. `speak`/`pause` are the driver the spec uses; `node` is where the
        // hook attaches its `onmessage`, and it is captured at construction.
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
          // it to this same push — exactly the order the real worklet uses, and what makes the frames
          // that follow read as speech.
          speak(seconds: number) {
            const node = state.node;
            if (!node) throw new Error('the fake capture was not connected yet');
            node.port.onmessage?.({ data: { type: 'event', event: { type: 'speechStart', atSample: state.atSample } } });
            push(seconds, 0.3);
          },
          // A pause: the `speechEnd` is posted first (it ends the run at the silence's first frame),
          // then the silence itself. A leading `pause` with no speech before it posts a harmless
          // `speechEnd` the detector was already in.
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
          dashscopeApiKey: 'sk-e2e-continuous-fake',
          dashscopeModel: 'qwen3-asr-flash',
        },
        preferences: { voiceEnabled: true },
      },
    );
    page = await context.newPage();

    // The one recogniser stand-in. The request never leaves the machine and no credential is spent.
    await page.route('**/api/voice/transcribe', async (route) => {
      const index = uploads.length;
      const answer = ANSWERS[Math.min(index, ANSWERS.length - 1)];
      const postData = route.request().postDataBuffer();
      uploads.push({
        url: route.request().url(),
        answer,
        index,
        body: postData ? postData.toString('utf8') : '',
      });
      const delay = delayMs[index] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const bodyBytes = postData?.length ?? 0;
      if (failAboveBytes.value !== null && bodyBytes > failAboveBytes.value) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'the stand-in refused this segment' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: answer }),
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

  test.beforeEach(() => {
    uploads.length = 0;
    delayMs = {};
    failAboveBytes.value = null;
  });

  test('a short dictation is exactly one request and fills the box with its answer', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=30`);

    // Three seconds of speech, one continuous run: below the 30 s minimum, so the stop flushes it as
    // the single trailing segment.
    await page.evaluate(() => {
      (window as unknown as { __voiceFake: { speak: (n: number) => void } }).__voiceFake.speak(3);
    });
    await stopButton().click();

    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
    await expect(composer()).toHaveValue(ANSWERS[0], { timeout: 10_000 });
    expect(uploads.length, 'a short dictation made more than one request').toBe(1);
  });

  test('a long dictation commits in spoken order even when a later segment answers first', async () => {
    test.setTimeout(45_000);
    // The first segment's answer is held back well past the second's, so "the second is not committed
    // early" is a reading this run can actually take.
    delayMs = { 0: 5_000 };
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await speakThenCut();
    await speakThenCut();
    await stopButton().click();

    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(2);

    // The second segment has answered (no delay on it), but the first has not settled, so neither may
    // be in the box yet.
    await page.waitForTimeout(1_500);
    expect(await composer().inputValue(), 'a later segment was committed before the earlier one').not.toContain(ANSWERS[1]);

    await expect(composer()).toHaveValue(FULL_TWO, { timeout: 15_000 });
  });

  test('text is committed while the microphone is still recording', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await speakThenCut();

    // Still recording: the stop control is on screen, and the first segment's answer is already in the box.
    await expect(composer()).toHaveValue(ANSWERS[0], { timeout: 15_000 });
    await expect(stopButton()).toBeVisible();

    await stopButton().click();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
  });

  test('a lost segment leaves no marker in the box, reports once, and does not stop the rest', async () => {
    test.setTimeout(45_000);
    // The middle segment is the longest, so its upload is the one the refusal is keyed on; the first
    // and last are shorter and go through. Every retry of the middle one carries the same bytes.
    failAboveBytes.value = 50_000;
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await speakThenCut(1);
    await speakThenCut(2);
    await speakThenCut(1);
    await stopButton().click();

    // Both good segments are committed, in order, and the failed one contributes nothing.
    await expect(composer()).toHaveValue(`${ANSWERS[0]} ${ANSWERS[2]}`, { timeout: 20_000 });
    await expect(page.getByTestId('voice-error-notice')).toHaveCount(1);
    const value = await composer().inputValue();
    expect(value, `the box carries a placeholder: ${JSON.stringify(value)}`).not.toMatch(/\[|\]|failed|segment \d/i);
  });

  test('an input with no speech spends no request and reports nothing', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await page.evaluate(() => {
      (window as unknown as { __voiceFake: { pause: (n: number) => void } }).__voiceFake.pause(3);
    });
    await stopButton().click();

    // Back to idle with nothing spent.
    await expect(micButton()).toBeVisible({ timeout: 10_000 });
    await expect(composer()).toHaveValue('');
    expect(uploads.length, 'silence spent a request').toBe(0);
    await expect(page.getByTestId('voice-error-notice')).toHaveCount(0);
  });

  test('a silent listen auto-stops on its own after the idle window, with no request', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceIdleSec=2&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    // No speech at all: the idle guard closes the microphone on its own and the stop control goes away.
    await expect(micButton()).toBeVisible({ timeout: 12_000 });
    expect(uploads.length, 'the idle auto-stop spent a request').toBe(0);
  });

  test('pressing send while recording sends the whole concatenation once', async () => {
    test.setTimeout(45_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);

    await speakThenCut();
    await speakThenCut();

    // The composer's submit control is the send entry while recording. `exact` because a sidebar
    // project row's accessible name can contain the word too.
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // The whole dictation reaches the conversation as one message.
    await expect(page.locator('body')).toContainText(FULL_TWO, { timeout: 20_000 });
  });

  test('after a stop the replay slot offers the filtered audio, and drops the raw track past the cap', async () => {
    test.setTimeout(45_000);

    // Default cap: both tracks are offered.
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);
    await speakThenCut();
    await stopButton().click();
    await expect(page.getByRole('button', { name: 'Replay trimmed' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Replay original' })).toBeVisible();

    // A cap below the stream's length: the raw track is dropped whole, the filtered one stays.
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}&voiceOriginalCapSec=1`);
    await page.evaluate(() => {
      (window as unknown as { __voiceFake: { speak: (n: number) => void } }).__voiceFake.speak(3);
    });
    await stopButton().click();
    await expect(page.getByRole('button', { name: 'Replay trimmed' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Replay original' })).toHaveCount(0);
  });

  test('a silence flush fills the box without a stop, about five seconds after the speech ends', async () => {
    test.setTimeout(60_000);
    // The shipped window, named explicitly: the switch is remembered, so the default is asserted
    // by naming it rather than by leaving it to whatever the previous leg set.
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=30&voiceFlushSilenceSec=${FLUSH_WINDOW_SEC}&voiceIdleSec=${IDLE_WINDOW_SEC}`);

    const speechEndedAt = Date.now();
    await page.evaluate(() => {
      const fake = (window as unknown as { __voiceFake: { speak: (n: number) => void; pause: (n: number) => void } }).__voiceFake;
      fake.speak(2);
      fake.pause(0.25);
    });

    // Push the silence in real time, a quarter second at a time, until the flush fires. The flush is
    // driven by the audio's own frame count, not a timer; pacing it in real time is what makes the
    // wait the user feels the number this leg records.
    let fired = false;
    for (let step = 0; step < 48 && !fired; step += 1) {
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        (window as unknown as { __voiceFake: { pause: (n: number) => void } }).__voiceFake.pause(0.25);
      });
      fired = uploads.length > 0;
    }
    const intervalSec = (Date.now() - speechEndedAt) / 1000;
    console.log(
      `[voice-flush] speech-end -> request interval ≈ ${intervalSec.toFixed(2)}s (window ${FLUSH_WINDOW_SEC}s)`,
    );

    expect(fired, 'the silence never reached the flush window').toBe(true);
    expect(intervalSec, 'the flush fired before the window had elapsed').toBeGreaterThan(3.5);
    expect(intervalSec, 'the flush took far longer than the window').toBeLessThan(15);

    // No stop was pressed: the microphone is still open and the text is already in the box.
    await expect(composer()).toHaveValue(ANSWERS[0], { timeout: 10_000 });
    await expect(stopButton()).toBeVisible();

    // The stop finds nothing buffered, so it spends no second request.
    await stopButton().click();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
  });

  test('a pause shorter than the flush window does not spend a request', async () => {
    test.setTimeout(40_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=30&voiceFlushSilenceSec=1&voiceIdleSec=${IDLE_WINDOW_SEC}`);

    // One utterance with a 0.6 s break inside it: under the 1 s window, so nothing goes out.
    await page.evaluate(() => {
      const fake = (window as unknown as { __voiceFake: { speak: (n: number) => void; pause: (n: number) => void } }).__voiceFake;
      fake.speak(1);
      fake.pause(0.6);
      fake.speak(1);
    });
    await page.waitForTimeout(500);
    expect(uploads.length, 'a pause under the flush window spent a request').toBe(0);

    // The stop is what releases the one buffered segment.
    await stopButton().click();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
    await expect(composer()).toHaveValue(ANSWERS[0], { timeout: 10_000 });
  });

  test('the in-flight dot tracks requests on a still-recording listen', async () => {
    test.setTimeout(60_000);
    // Both requests are held, so "the dot is up" and "the dot is down" are readings this run takes.
    delayMs = { 0: 4_000, 1: 4_000 };
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=30&voiceFlushSilenceSec=${FLUSH_SEC}&voiceIdleSec=${IDLE_WINDOW_SEC}`);

    // Nothing in flight yet: no dot anywhere in the composer.
    await expect(page.getByTestId('voice-inflight-dot')).toHaveCount(0);

    // A request is out and held: the dot is inside the still-recording (stop) button.
    await speakThenFlush();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
    await expect(page.getByTestId('voice-inflight-dot')).toHaveCount(1);
    await expect(stopButton().getByTestId('voice-inflight-dot')).toBeVisible();

    // The held answer lands, and the dot goes with the pending request.
    await expect(page.getByTestId('voice-inflight-dot')).toHaveCount(0, { timeout: 15_000 });
    await expect(composer()).toHaveValue(ANSWERS[0], { timeout: 15_000 });

    // A second request, stopped while still in flight: the transcribing tail — answers landing after
    // the stop — is not a live request the user is waiting on, so it shows no dot either.
    await speakThenFlush();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(2);
    await expect(page.getByTestId('voice-inflight-dot')).toHaveCount(1);
    await stopButton().click();
    await expect(page.getByTestId('voice-inflight-dot')).toHaveCount(0);
    await expect(composer()).toHaveValue(FULL_TWO, { timeout: 20_000 });
  });

  test('the in-flight dot adds no control to the composer', async () => {
    test.setTimeout(45_000);
    await startListening(`/?voiceDebug=1&voiceMinSegmentSec=30&voiceVad=1&voiceFlushSilenceSec=${FLUSH_SEC}&voiceIdleSec=${IDLE_WINDOW_SEC}`);

    // The same live listen, before and during a held request. Comparing a recording composer with
    // itself keeps the mic button's own name (Stop recording) out of the difference.
    const before = await composerControls();
    delayMs = { 0: 4_000 };
    await speakThenFlush();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
    await expect(page.getByTestId('voice-inflight-dot')).toHaveCount(1);
    const during = await composerControls();

    // The premise: the composer really painted, so an equal pair is a reading and not two blanks.
    expect(before.buttons.length, 'the composer painted no controls, so the comparison would be vacuous').toBeGreaterThan(0);
    // The dot is not a control: no button appears with it, and the only testid it adds is its own.
    expect([...during.buttons].sort()).toEqual([...before.buttons].sort());
    const added = during.testIds.filter((id) => !before.testIds.includes(id));
    expect([...added].sort()).toEqual(['voice-inflight-dot']);
    expect(before.testIds.every((id) => during.testIds.includes(id))).toBe(true);
  });

  /*
   * Voice input P0: the DRAFT the box started in, and the PROVISIONAL range the dictation owns.
   *
   * THE RECOGNISER IS THE RELAY ROW. `dashscope-omni-relay` is the same service as the fixture's
   * `dashscope-omni`, with `honors.context: true` — so the context the client sends is put on the
   * wire instead of being dropped by the provider's own declaration. The settings are written through
   * the app's own config endpoint and the next load hydrates them: seeding `localStorage` would lose
   * to the server copy this run already imported in `beforeAll` (the legacy key is a migration source
   * only). Because the row is proxy-only, the upload still lands on `/api/voice/transcribe`, which is
   * where the route stand-in below reads it.
   */

  /** The draft typed before the mic is pressed. Distinctive, so its presence in a body is a reading. */
  const P0_DRAFT = '请把架构页的说明改短一点：';

  /** The relay row's settings — the fixture's service and credential fields, under the relay id. */
  const P0_RELAY_CONFIG = {
    baseUrl: '',
    apiKey: '',
    sttModel: '',
    ttsModel: '',
    ttsVoice: '',
    ttsFormat: '',
    providerId: 'dashscope-omni-relay',
    dashscopeEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    dashscopeApiKey: 'sk-e2e-p0-relay-fake',
    dashscopeModel: 'qwen3-asr-flash',
  };

  test('P0 voice input: the box keeps its draft, the dictation wears a provisional range, and the upload carries the draft', async () => {
    test.setTimeout(45_000);

    // Select the relay recogniser through the app's endpoint; 200 is the precondition, because every
    // reading below is about a context that only this row acknowledges.
    const saved = await page.evaluate(async (settings) => {
      const token = window.localStorage.getItem('auth-token');
      const response = await fetch('/api/voice/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(settings),
      });
      return response.status;
    }, P0_RELAY_CONFIG);
    expect(saved, 'the relay recogniser could not be selected').toBe(200);

    // Open the composer first, THEN type the draft: the listen snapshots the box when the mic is
    // pressed, so a draft typed after that would be a different (and wrong) reading.
    await openComposer(`/?voiceDebug=1&voiceMinSegmentSec=${SMALL_MIN_SEC}`);
    await composer().fill(P0_DRAFT);
    await composer().press('End');
    await expect(composer()).toHaveValue(P0_DRAFT);

    await micButton().click();
    await expect(stopButton()).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => page.evaluate(() => Boolean((window as unknown as { __voiceFake?: { node?: unknown } }).__voiceFake?.node)))
      .toBe(true);

    // One spoken second, then a pause past the cut threshold: exactly one segment, so the single
    // answer below is the whole dictation.
    await speakThenCut();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);

    // ① The box holds the draft with the dictation after it: the listen committed at the caret the
    // press opened, which was the end of the draft.
    await expect(composer()).toHaveValue(`${P0_DRAFT}${ANSWERS[0]}`, { timeout: 15_000 });

    // ② The provisional range covers the dictation and only the dictation — not the draft prefix.
    const provisional = page.locator('[data-voice-provisional="true"]');
    await expect(provisional).toHaveCount(1);
    await expect(provisional).toHaveText(ANSWERS[0]);

    // ③ The upload carried the draft as the relay context. Read from the intercepted body, i.e. what
    // the browser really sent, and in the multipart field the server parses.
    const body = uploads[0].body;
    expect(body, 'the upload carried no context field at all').toContain('name="context"');
    expect(body, 'the context did not contain the draft the box started in').toContain(P0_DRAFT);

    // The DoD's evidence: this moment — highlight up, draft still ordinary text — plus the pack.
    await captureEvidence('voice-input-p0-provisional', body);

    // ④ Stop: the listen ends, and the highlight goes with it — the words are ordinary text again.
    await stopButton().click();
    await expect(micButton()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-voice-provisional="true"]')).toHaveCount(0);
    await expect(composer()).toHaveValue(`${P0_DRAFT}${ANSWERS[0]}`);
  });
  });
