/**
 * GOAL-033 / AC-316 — the browser's Live Voice criterion, on a real browser
 * against a real server.
 *
 * WHAT THIS FILE IS FOR. AC-312 proved the chain microphone → audio frames → a
 * model tool call → an editable on-screen intent → an explicit send →
 * `session_send` → a transcript row. AC-316 removes the draft-and-confirm step
 * and makes voice a MUTUALLY EXCLUSIVE mode with the text composer, rendered as a
 * fixed compact bar that captures continuously until Mute or End. This file drives
 * that new shape and reads each claim as a DOM or protocol fact:
 *
 *   · entering Live Voice swaps `ChatComposer` out and `VoiceRealtimeBar` in —
 *     never both at once, on 1280px and on 375px;
 *   · the old draft control plane (`voice-realtime-start` / visible
 *     `voice-realtime-upload` / `voice-realtime-intent` / `voice-realtime-send` /
 *     `voice-realtime-cancel`) is gone, not moved;
 *   · the bar's height does not change phase to phase (the "never grows, never
 *     goes full-screen" requirement);
 *   · capture is continuous: Mute withholds frames WITHOUT closing the connection,
 *     and Unmute resumes on the same connection;
 *   · a model-proposed `session_send` executes immediately (no browser round-trip)
 *     and its turn lands through the ordinary transcript rendering.
 *
 * WHAT IS REAL AND WHAT IS NOT. The microphone is a stand-in because no CI machine
 * has one: an init script replaces `AudioContext`, `AudioWorkletNode` and
 * `getUserMedia` with an inert graph this file pushes PCM into
 * (`__voiceFake.speak(0.6)`), exactly the interface the real worklet forwards. The
 * Realtime upstream (DashScope) is a stand-in too: the server dials
 * `VOICE_REALTIME_ENDPOINT`, which `playwright.config.ts` points at a port this
 * file's own WS server owns. Everything else — the browser hook, the
 * `/voice-realtime` proxy, the bridge, the real `session_send` and the transcript
 * write — is the shipping code.
 *
 * WHY BOTH LEGS SHARE ONE SESSION. The criterion's own words are "the currently
 * open session": the legs are two gestures in front of the same chat pane, and
 * the mobile leg proves the same binding at 375px rather than a different one.
 * Each leg opens its own `/voice-realtime` socket, so each reaches the fake
 * upstream on a fresh connection and gets its own proposal.
 */

import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

// The relay mode this run will actually get, from the PRODUCT's own resolver rather than a copy of
// its default — see `segmentedRelayExpected` below. The module is pure (it imports nothing), and
// `e2e/` belongs to no typecheck program, so this adds no server code to the run but the function.
import { resolveVoiceRealtimeMode } from '../server/modules/voice-realtime/voice-realtime-mode';

const PANE = '.chat-messages-pane';
const USER_ROW = '[data-message-style="user"]';
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';

const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice realtime — DoD arm';
const SEED_USER_TEXT = 'seeded user turn for the voice realtime criterion';

/** What the fake upstream's function call tells the model to send. There is no edit step any more. */
const PROPOSED_TEXT = 'voice instruction delivered with no draft confirmation';

/**
 * How long one sentence of the fake microphone's speech lasts. `speak()` wraps it in a
 * calibration lead-in and a trailing pause (see its own comment in the init script) and hands
 * it to the page as ONE message, so on the continuous path it is one `audio` frame and on the
 * segmented path exactly one committed sentence. A `speak()` call says TWO of these — see the
 * helper for the pause between them and why one sentence is not an utterance.
 */
const SPEECH_SECONDS = 0.6;
/**
 * How long the real `session_send` is asked to take once the model calls it. Wide
 * enough that the spec can observe capture staying operable THROUGH the executing
 * window rather than racing the send's completion.
 */
const SEND_WAIT_SECONDS = 2.5;

/** The testids AC-316 removed. Asserting each has zero matches proves "gone, not moved". */
const REMOVED_TESTIDS = [
  'voice-realtime-control',
  'voice-realtime-start',
  'voice-realtime-stop',
  'voice-realtime-upload',
  'voice-realtime-intent',
  'voice-realtime-send',
  'voice-realtime-cancel',
];

/**
 * A scenario that only exists to make the session armable.
 *
 * `armDebugAgentScenario` refuses a document whose `steps` is empty and whose
 * `expect` is absent, so this is the smallest valid one. Its walk writes nothing
 * (`wait` at t=0) and finishes at once: the run the voice send opens is a carrier
 * for the typed-turn row the PROVIDER writes, not for anything this document does,
 * and the clock is never advanced here.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

/**
 * Whether the server this run is driving will declare segmented relay to the browser.
 *
 * ASKED OF THE PRODUCT, NOT RE-DERIVED HERE. The mode is resolved by the SAME pure function the
 * proxy and `server/index.ts` call (`resolveVoiceRealtimeMode`), so this expectation cannot drift
 * from the behaviour it is compared against: whatever default that function ships — segmented
 * (the P4 rollout decision) or continuous (the 2026-10-13 experience-first ruling, GOAL-044) —
 * this run reads it rather than a copy of it. A hand-written `!== 'continuous'` is exactly the
 * copy that went stale when the default flipped: it answered "segmented" for an unset variable
 * while the server had started answering "continuous", so the branch below asserted `commit`-based
 * framing against a proxy that had stopped committing.
 *
 * WHY THE SPEC PROCESS'S OWN ENVIRONMENT IS THE SERVER'S. `VOICE_REALTIME_MODE` is a DEPLOYMENT
 * setting, read once at server start-up. `playwright.config.ts` assembles that server's environment
 * by spreading this runner's and overriding the key only for the continuous-only selections
 * (`voiceContinuousOnlySelection` — the experience baseline and the silence-tail criterion, each
 * measured as its run's ONLY spec). This criterion selects two specs, so no override applies and
 * the key the resolver sees here is the key the server was started with.
 *
 * The same answer decides which framing the upstream should have seen, so the AC-319 assertion
 * below is a real reading of the run's own configuration rather than a re-statement of it.
 */
function segmentedRelayExpected(): boolean {
  return resolveVoiceRealtimeMode(process.env).mode === 'segmented';
}

// ---------------------------------------------------------------------------------------------
// The fake Realtime upstream.
// ---------------------------------------------------------------------------------------------

type FakeUpstream = {
  /** Arms the stand-in: it answers audio with a call only once the bound session is known. */
  setBoundSessionId(id: string): void;
  /** Sends every connected proxy a function call whose arguments violate the tool's schema. */
  emitMalformedCall(): void;
  /** How many upstream connections the proxy has dialled. */
  connectionCount(): number;
  /** How many of them are open right now. */
  liveConnectionCount(): number;
  /** How many `input_audio_buffer.append` frames the upstream has received. */
  audioFrameCount(): number;
  /**
   * How many `input_audio_buffer.commit` frames the upstream has received (AC-319).
   *
   * This is the reading that tells the two framings apart. The segmented path uploads only
   * committed sentences, so the proxy writes each segment's audio as `append…` and then a
   * `commit`; the continuous fallback never commits — it just streams `append` frames — so
   * this count is 0 there. A run that reads 0 under the default configuration is a run that
   * never exercised the segmented path at all.
   */
  commitCount(): number;
  /** How many `session_send` proposals the upstream has emitted. */
  callCount(): number;
  close(): Promise<void>;
};

/**
 * Starts the DashScope stand-in on `port` and returns the handle the spec drives.
 *
 * The dialect is the endpoint's `session_send` delivery and nothing else: the
 * FIRST audio frame is answered with a `session_send` function call. The call's
 * `arguments` name the armed session (the executor refuses any other id) and carry
 * `waitSeconds`, so the send resolves only after the debug run has written the
 * transcript row the criterion reads — which is what gives the spec a visible
 * in-flight window.
 */
function startFakeUpstream(port: number): Promise<FakeUpstream> {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  let boundSessionId = '';
  let connections = 0;
  let calls = 0;
  let audioFrames = 0;
  let commits = 0;

  server.on('connection', (socket) => {
    connections += 1;
    let callSent = false;

    socket.on('message', (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

      // The channel is deliberately narrow: the bridge acts on `function_call`
      // (normalised from `response.function_call_arguments.done`) and tolerates the
      // endpoint's own lifecycle traffic. It reports a type this endpoint never
      // sends as `UNKNOWN_EVENT` — so the stand-in still speaks only what the loop
      // needs, but it does answer `session.update`, because the real endpoint does
      // and the session must survive that reply.
      // The endpoint acknowledges our `session.update`. The bridge must TOLERATE this:
      // it is the endpoint answering us, not a failure. The stand-in used to omit it —
      // which is precisely why a real session died here with no criterion noticing.
      if (frame.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created' }));
        socket.send(JSON.stringify({ type: 'session.updated' }));
        return;
      }

      // AC-319: the segmented path closes each sentence it uploads, so the proxy writes the
      // committed audio then this frame; the continuous fallback never sends one. Counted,
      // not acted on — the reading is what tells the two framings apart.
      if (frame.type === 'input_audio_buffer.commit') {
        commits += 1;
        return;
      }

      if (frame.type === 'input_audio_buffer.append') {
        audioFrames += 1;
        if (callSent || boundSessionId.length === 0) {
          return;
        }
        callSent = true;
        calls += 1;
        socket.send(
          JSON.stringify({
            type: 'response.function_call_arguments.done',
            call_id: `call_fake_${calls}`,
            name: 'session_send',
            // NO `session`: the instructions tell the model "the session is fixed by the
            // connection; never name one", and the real model obeys. A stand-in that
            // named the session here is what hid a schema that REQUIRED it — every
            // real call was rejected while this spec stayed green.
            arguments: JSON.stringify({ message: PROPOSED_TEXT, waitSeconds: SEND_WAIT_SECONDS }),
          }),
        );
      }
    });
  });

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('the fake Realtime upstream never began listening')), 10_000);
    server.once('listening', () => {
      clearTimeout(deadline);
      resolve({
        setBoundSessionId: (id: string) => {
          boundSessionId = id;
        },
        emitMalformedCall: () => {
          for (const client of server.clients) {
            client.send(
              JSON.stringify({
                type: 'response.function_call_arguments.done',
                call_id: `call_malformed_${Date.now()}`,
                name: 'session_send',
                // Arguments that are NOT valid JSON — the `message` string is left unterminated, the
                // shape of the real incident this case reproduces. The transport defers a non-JSON
                // payload to the bridge, which reports it as `MALFORMED_FUNCTION_CALL` (recoverable),
                // so the code the console warning carries is that one rather than the transport's own
                // `TOOL_ARGUMENT_SCHEMA_VIOLATION` (which the fake's earlier `{ message: 42 }` — valid
                // JSON, wrong type — produced). Schema-violation coverage lives in the server's own
                // tests; this case is about the malformed call reaching the browser's console.
                arguments: '{"message": "unterminated',
              }),
            );
          }
        },
        connectionCount: () => connections,
        liveConnectionCount: () => server.clients.size,
        audioFrameCount: () => audioFrames,
        commitCount: () => commits,
        callCount: () => calls,
        close: () =>
          new Promise<void>((done) => {
            // `WebSocketServer.close()` only stops accepting new clients and then
            // waits for every existing one to disconnect — a proxy socket still
            // parked on the upstream would hang teardown. Terminate them, so
            // close always settles.
            for (const client of server.clients) {
              client.terminate();
            }
            server.close(() => done());
          }),
      });
    });
    server.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

const projectRow = (page: Page, workspaceName: string) =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): ReturnType<Page['locator']> =>
  page.locator(`a[href="/session/${sessionId}"]`).first();

async function explain(page: Page, what: string): Promise<never> {
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`${what}; the page held:\n${body.slice(0, 2_000)}`);
}

/** Expands the fixture project until the session's row is on screen. Bounded, and never silent. */
async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  await explain(page, `the sidebar never showed a row for session ${sessionId}`);
}

/** Creates (or signs in) the fixture account and returns its bearer token. */
async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', { headers: { Authorization: `Bearer ${registered.token}` } });
    return registered.token;
  }
  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(`could not create or sign in as ${USERNAME}: ${register.status()} ${JSON.stringify(registered)}`);
  }
  return loggedIn.token;
}

/** Arms one scenario and returns the session id the rest of this file addresses it by. */
async function armScenario(api: APIRequestContext, projectPath: string, scenario: unknown): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return sessionId;
}

// ---------------------------------------------------------------------------------------------
// The control.
// ---------------------------------------------------------------------------------------------

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

const waitForPhase = (page: Page, wanted: string) =>
  expect.poll(() => phase(page), { timeout: 25_000 }).toBe(wanted);

/** The page-side capture probe `pushFirstCaptureFrame` drives (installed in the init script). */
type CaptureProbe = {
  /** The most recently constructed worklet — the one the next `start()` adopts and wires. */
  node: { port: { onmessage: ((message: unknown) => void) | null } } | null;
  /** The segmenter's ledger: the first sample index of the next chunk. */
  atSample: number;
  /** Worklets constructed so far: one per Live Voice capture session on this page. */
  constructed: number;
  /** `constructed` as of the last frame this file pushed. */
  pushed: number;
};

/**
 * Pushes the one captured frame that makes `listening` reachable.
 *
 * WHY IT IS NEEDED. Upstream `state: open` only takes the bar to `arming`; `listening` is set when
 * capture delivers its FIRST frame (`c99a0eaba`). The fake graph is inert — frames only leave it via
 * `__voiceFake.speak()` — so every initial `waitForPhase(page, 'listening')` below would poll
 * `arming` until it timed out. This is the same contract `e2e/voice-realtime-intent-control.spec.ts`
 * satisfies with its own helper; the frame here also advances the shared `atSample` ledger, because
 * the segmented relay throws on a chunk whose offset does not match what it has written.
 *
 * WHEN IT LANDS. Only after `start()` has WIRED the most recently constructed worklet —
 * `port.onmessage` is assigned after the asynchronous acquisition, and a frame pushed before that
 * is dropped — and only once per worklet, so a later capture session's first frame cannot be
 * satisfied by an earlier one.
 */
async function pushFirstCaptureFrame(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const capture = (window as unknown as { __voiceCaptureProbe?: CaptureProbe }).__voiceCaptureProbe;
          const node = capture?.node;
          if (!capture || !node || node.port.onmessage === null) return false;
          if (capture.pushed >= capture.constructed) return false;
          const samples = new Float32Array(3_200); // 200 ms at 16 kHz
          for (let index = 0; index < samples.length; index += 1) {
            samples[index] = 0.2 * Math.sin((2 * Math.PI * 180 * index) / 16_000);
          }
          node.port.onmessage({ data: { type: 'pcm', samples, atSample: capture.atSample } });
          capture.atSample += samples.length;
          capture.pushed = capture.constructed;
          return true;
        }),
      {
        timeout: 20_000,
        message: 'the capture graph never wired a worklet to receive the first captured frame',
      },
    )
    .toBe(true);
}

/** The transcript's own text, read straight off the pane. */
const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

/**
 * The gap between the two sentences of one utterance, and the beat after the last one.
 *
 * Wide in both roles because both are socket round trips rather than clock ticks: the relay has
 * to have heard the first sentence before the second arrives, and to have committed the second
 * before the caller acts on `speak`'s return.
 */
const SPEECH_BEAT_MS = 400;

/**
 * One utterance — the fake microphone's only action, and an utterance is not one sentence.
 *
 * Under the default segmented relay the browser uploads speech a sentence at a time, and the proxy
 * HOLDS the model's relayed `session_send` for a sentence until the NEXT sentence's audio (or that
 * segment's transcript) confirms it. The fake upstream never sends a transcript, so a one-sentence
 * burst leaves its relay held; an immediate End then tears the socket down, and the proxy's settled
 * policy for a connection the browser has left is to record that held relay as not-delivered rather
 * than hand it to the session — the turn never becomes a row. A person does not speak one unbroken
 * sentence either, and the relay is built for that: a second sentence after a real pause is the
 * boundary that RELEASES the first one's relay, so the turn is on its way before the caller can End.
 * The PC leg already got this shape from its repeated `speak` calls; one call now speaks the same
 * way, which is what lets the 375px leg's own connection land its own row.
 */
const speak = async (page: Page, seconds: number): Promise<void> => {
  const say = (value: number): Promise<void> =>
    page.evaluate((v: number) => {
      (window as unknown as { __voiceFake: { speak(seconds: number): void } }).__voiceFake.speak(v);
    }, value);
  await say(seconds);
  // A real pause, not a same-tick second push: the hold on the first sentence is established by
  // the round trip that carries its audio upstream and the model's call back.
  await page.waitForTimeout(SPEECH_BEAT_MS);
  await say(seconds);
  // And a real beat for that second sentence to reach the relay and release the first, because the
  // caller may End the moment this returns and End does not wait for a frame still in flight.
  await page.waitForTimeout(SPEECH_BEAT_MS);
};

/** Writes a screenshot when QUAY_LIVE_VOICE_SHOT_DIR is set; a no-op in ordinary runs. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.QUAY_LIVE_VOICE_SHOT_DIR;
  // Colours transition on state change; let them settle so the picture shows the resting state.
  if (dir) await page.waitForTimeout(700);
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Enters Live Voice and waits for the bar to have replaced the composer. */
async function enterLiveVoice(page: Page): Promise<void> {
  // The entry lives INSIDE the composer, as its own control beside the dictation mic — never in a
  // strip above the box. The old external button's id must be gone.
  await expect(page.getByTestId('live-voice-enter')).toHaveCount(0);
  const entry = page.getByTestId('live-voice-button');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="prompt-input"]').getByTestId('live-voice-button')).toHaveCount(1);
  // Order: attach, the dictation mic, then Live Voice, on one row — two separate buttons.
  const mic = page.getByTestId('voice-input-button');
  await expect(mic).toBeVisible({ timeout: 15_000 });
  const micBox = await mic.boundingBox();
  const entryBox = await entry.boundingBox();
  expect(micBox && entryBox && entryBox.x > micBox.x && Math.abs(entryBox.y - micBox.y) < 8).toBeTruthy();
  await expect(entry).toHaveAttribute('aria-label', /Live Voice/);
  await shot(page, `default-composer-${page.viewportSize()?.width}`);
  await entry.click();
  await expect(page.getByTestId('voice-realtime-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
}

test.describe.configure({ mode: 'serial' });

test.describe('voice realtime live session send', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: FakeUpstream;
  let sessionId = '';
  let workspaceName = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }

    upstream = await startFakeUpstream(upstreamPort);

    const workspace = path.join(fixtureHome, 'voice-realtime-workspace');
    workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    sessionId = await armScenario(api, workspace, SCENARIO);
    upstream.setBoundSessionId(sessionId);

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(
      ({ authToken }: { authToken: string }) => {
        window.localStorage.setItem('auth-token', authToken);
        window.localStorage.setItem('userLanguage', 'en');
        // Dictation enabled, so the default composer carries both voice entries.
        const preferences = { voiceEnabled: true };
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }));

        // The fake audio graph. `speak` is the driver the spec uses; `node` is
        // where the hook attaches its `onmessage`, captured at construction.
        //
        // WHAT `speak` EMITS, AND WHY IT IS NOT A FLAT TONE (AC-319). The shipping relay's
        // voice-activity detector measures its noise floor as the sliding 15th percentile of
        // the frames it has just seen, so a constant-amplitude burst BECOMES that floor and
        // never clears the speech factor above it — a flat `samples.fill(0.3)` is silence to
        // the detector, so the segmented client released no segment and this spec's upstream
        // frame counts sat at zero under the default configuration. One burst is therefore
        // built like a spoken sentence: a quiet lead-in for the detector's half-second
        // bootstrap to calibrate against, a syllable-shaped run (a 3 Hz envelope over a
        // 180 Hz carrier) that reads as speech, and a trailing pause longer than the relay's
        // own 2.0 s commit gap. The pause is what makes the sentence COMMIT and reach the
        // upstream while the spec is still listening, rather than waiting inside the
        // segmenter for Mute or End to flush it. A committed sentence is not a delivered turn
        // yet, though: the proxy holds its relay until a LATER sentence commits, which is why
        // the spec's `speak` says two of these — see that helper's comment.
        const buildSpeechBurst = (seconds: number): Float32Array => {
          const rate = 16_000;
          const lead = Math.round(0.6 * rate);
          const body = Math.round(Math.max(0.2, seconds) * rate);
          const tail = Math.round(2.2 * rate);
          const samples = new Float32Array(lead + body + tail);
          for (let i = 0; i < lead; i += 1) {
            samples[i] = 0.02 * Math.sin((2 * Math.PI * 220 * i) / rate);
          }
          for (let i = 0; i < body; i += 1) {
            const envelope = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / rate);
            samples[lead + i] = 0.5 * envelope * Math.sin((2 * Math.PI * 180 * i) / rate);
          }
          return samples;
        };
        type Port = { port: { onmessage: ((m: unknown) => void) | null } };
        // `constructed`/`pushed` make "exactly one first frame per capture session" a page-side
        // fact rather than a caller's promise; they are shared with `__voiceCaptureProbe` below.
        const state: {
          node: Port | null;
          atSample: number;
          constructed: number;
          pushed: number;
          speak: (seconds: number) => void;
        } = {
          node: null,
          atSample: 0,
          constructed: 0,
          pushed: 0,
          speak(seconds: number) {
            const node = state.node;
            if (!node) throw new Error('the fake capture was not connected yet');
            const samples = buildSpeechBurst(seconds);
            node.port.onmessage?.({ data: { type: 'pcm', samples, atSample: state.atSample } });
            state.atSample += samples.length;
          },
        };
        (window as unknown as { __voiceFake: typeof state }).__voiceFake = state;
        // The probe `pushFirstCaptureFrame` drives. Same object, so the first-frame push keeps the
        // segmenter's `atSample` ledger contiguous with `speak`'s bursts.
        (window as unknown as { __voiceCaptureProbe: typeof state }).__voiceCaptureProbe = state;

        class FakeWorkletNode {
          port: { onmessage: ((m: unknown) => void) | null; postMessage: () => void };
          constructor() {
            this.port = { onmessage: null, postMessage: () => undefined };
            state.node = this as unknown as typeof state.node;
            state.constructed += 1;
          }

          connect() {
            /* the graph is inert; the spec drives the port directly */
          }
        }

        // The capture `AudioContext`, carrying the `state` / `statechange` / `resume()` the microphone
        // source reacts to (`audioSource.ts` subscribes with `addEventListener('statechange', …)`). The
        // shape must match `voice-realtime-scripted-scenarios.spec.ts`'s fake: without `addEventListener`
        // the source's `start()` threw INSIDE its async body (`activeContext.addEventListener is not a
        // function`), which the hook caught and rendered as a bar error — so the recoverable-error case
        // below read that transient failure instead of the model's own console report. No statechange is
        // driven here, so `state` stays `running` and `resume()` is a resolved promise.
        class FakeAudioContext {
          sampleRate = 16_000;
          destination = {};
          state = 'running';
          audioWorklet = { addModule: async () => undefined };
          private readonly stateChangeListeners: Array<() => void> = [];
          createGain() {
            return { gain: { value: 0 }, connect: () => undefined };
          }

          createMediaStreamSource() {
            return { connect: () => undefined };
          }

          close() {
            return Promise.resolve();
          }

          addEventListener(type: string, listener: () => void) {
            if (type === 'statechange') this.stateChangeListeners.push(listener);
          }

          resume() {
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
      { authToken: token },
    );
    page = await context.newPage();
    // Dictation reads as available, so the default composer carries BOTH voice entries (mic and
    // Live Voice) and the spec can assert their order and independence.
    await page.route('**/api/voice/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
    );

    await page.goto('/');
    if (!(await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
      await page.reload();
    }
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
    await upstream?.close();
  });

  test('PC: entering Live Voice swaps out the composer, captures continuously through Mute and execution, and a send lands with no draft step', async () => {
    const composer = page.locator(COMPOSER_TEXTAREA);
    const bar = page.getByTestId('voice-realtime-bar');

    // The pane starts in the ordinary text composer.
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page);

    // AC1: mutually exclusive — the bar is up and the composer is gone (not merely
    // covered), so the two inputs can never be visible at once.
    for (const id of REMOVED_TESTIDS) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    // The hidden fixture-injection input survives with no visible trigger.
    const uploadInput = page.locator('[data-testid="voice-realtime-upload-input"]');
    await expect(uploadInput).toHaveCount(1);
    // The injection seam is hidden, not a visible control: `sr-only` renders it
    // at most a pixel across, so nothing on screen offers to open it.
    const seamBox = await uploadInput.boundingBox();
    expect(seamBox ? Math.max(seamBox.width, seamBox.height) : 0).toBeLessThanOrEqual(2);

    // AC3: entering Live Voice starts capture automatically. `listening` needs a captured frame
    // (`arming` is the window before it), and the fake graph only emits when the spec drives it.
    await pushFirstCaptureFrame(page);
    await waitForPhase(page, 'listening');

    // AC2: one fixed, compact bar — the same height in every reachable phase.
    const barHeight = async (): Promise<number> => (await bar.boundingBox())?.height ?? 0;
    const barTop = async (): Promise<number> => (await bar.boundingBox())?.y ?? 0;
    const listeningHeight = await barHeight();
    const listeningTop = await barTop();
    const framesBeforeFirstBurst = upstream.audioFrameCount();
    await speak(page, SPEECH_SECONDS);
    // The upload is a WebSocket round trip, so the count is read after it has provably landed
    // rather than immediately: `framesBeforeMute` below is the mute leg's baseline, and a
    // baseline sampled before the first burst arrived would make the muted-burst equality
    // assertion ambiguous about which burst it is measuring.
    await expect.poll(() => upstream.audioFrameCount(), { timeout: 20_000 }).toBeGreaterThan(framesBeforeFirstBurst);
    await shot(page, 'live-listening-1280');
    expect(listeningHeight).toBeGreaterThan(0);

    // AC3: Mute withholds frames without closing or re-opening the connection.
    const connectionBeforeMute = upstream.connectionCount();
    const framesBeforeMute = upstream.audioFrameCount();
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'muted');
    const mutedHeight = await barHeight();
    await shot(page, 'live-muted-1280');

    // A burst while muted must reach no one: the upstream frame count stays put.
    await speak(page, SPEECH_SECONDS);
    await page.waitForTimeout(400);
    expect(upstream.audioFrameCount()).toBe(framesBeforeMute);

    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'listening');
    expect(upstream.connectionCount()).toBe(connectionBeforeMute);
    expect(Math.abs(mutedHeight - listeningHeight)).toBeLessThanOrEqual(2);
    expect(Math.abs((await barTop()) - listeningTop)).toBeLessThanOrEqual(2);
    // Elapsed clock, wave and caption cell sit inside the one bar.
    await expect(page.getByTestId('voice-realtime-elapsed')).toHaveText(/^\d\d:\d\d$/);
    await expect(page.getByTestId('voice-realtime-wave')).toBeVisible();

    // Unmuted audio flows again — the same connection carries it.
    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.audioFrameCount(), { timeout: 20_000 }).toBeGreaterThan(framesBeforeMute);

    // AC-319: prove the run actually took the mode's path, in both configurations. Under the
    // default segmented relay the proxy writes each committed sentence's audio and then a
    // `commit`; the continuous fallback never commits and keeps streaming `append`s. Reading
    // the mode's own count is what keeps this spec honest — a run that uploaded nothing at all
    // would otherwise satisfy "no frames while muted" vacuously. The default path must show at
    // least one commit AND real audio; the fallback must show audio but zero commits.
    if (segmentedRelayExpected()) {
      await expect.poll(() => upstream.commitCount(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
      expect(upstream.audioFrameCount()).toBeGreaterThan(0);
    } else {
      expect(upstream.commitCount()).toBe(0);
      expect(upstream.audioFrameCount()).toBeGreaterThan(0);
    }

    // The model proposes a `session_send` the moment it hears audio, and AC-316
    // executes it immediately. Capture must stay operable THROUGH that window.
    await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
    await shot(page, 'live-executing-1280');
    expect(Math.abs((await barHeight()) - listeningHeight)).toBeLessThanOrEqual(2);
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'muted');
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'listening');
    expect(upstream.connectionCount()).toBe(connectionBeforeMute);

    // AC5: no draft, no Send/Cancel — the turn lands through the ordinary
    // transcript rendering, because the send executed the moment it was called.
    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);

    // AC3: End really closes, and the composer comes back.
    await page.getByTestId('voice-realtime-end').click();
    await expect(bar).toHaveCount(0);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // History, not this page's live state: reload and read the pane again.
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);
    expect(await page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count()).toBeGreaterThanOrEqual(1);
    expect(upstream.connectionCount()).toBeGreaterThanOrEqual(1);
  });

  test('375px: the same mode and gesture work with the bar inside the viewport', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    const composer = page.locator(COMPOSER_TEXTAREA);
    await expect(composer).toBeVisible({ timeout: 30_000 });

    // Read the running totals BEFORE entering, so this leg proves its own
    // connection and its own frames rather than leg 1's.
    const framesBefore = upstream.audioFrameCount();
    const connectionsBefore = upstream.connectionCount();

    await enterLiveVoice(page);
    await pushFirstCaptureFrame(page);
    await waitForPhase(page, 'listening');

    // AC1/AC2 at 375px: the bar is on screen, within the viewport, and the
    // composer is not — one input at a time, at this width too.
    const bar = page.getByTestId('voice-realtime-bar');
    const box = await bar.boundingBox();
    if (!box) await explain(page, 'the voice bar had no box at 375px');
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(376);
    await expect(composer).toBeHidden();
    // Mute and End stay on screen and clickable at this width.
    for (const id of ['voice-realtime-mute', 'voice-realtime-end']) {
      const control = await page.getByTestId(id).boundingBox();
      expect(control && control.x >= 0 && control.x + control.width <= 376 && control.height >= 36).toBeTruthy();
    }
    await shot(page, 'live-listening-375');
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'muted');
    expect(Math.abs(((await bar.boundingBox())?.height ?? 0) - box!.height)).toBeLessThanOrEqual(2);
    await shot(page, 'live-muted-375');
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'listening');

    // A burst on this leg's own connection reaches the upstream.
    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.audioFrameCount(), { timeout: 20_000 }).toBeGreaterThan(framesBefore);
    expect(upstream.connectionCount()).toBeGreaterThan(connectionsBefore);

    await page.getByTestId('voice-realtime-end').click();
    await expect(bar).toHaveCount(0);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Both legs' turns are on disk: the second connection wrote its own row.
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count(), { timeout: 25_000 })
      .toBeGreaterThanOrEqual(2);
  });

  test('a recoverable malformed model call is reported to the console, not the bar, and the microphone and the connection stay alive', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page);
    await pushFirstCaptureFrame(page);
    await waitForPhase(page, 'listening');

    // The ruling this case pins: a recoverable error is reported to the BROWSER CONSOLE — carrying
    // the error's own code — and never rendered on the bar. Collect the page's console lines BEFORE
    // the frame so the report cannot land before the listener exists.
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });

    upstream.emitMalformedCall();

    // The report reached the console, so the frame has certainly been handled by the time the bar is
    // read below — which is what makes the zero-count assertion a reading rather than a race…
    await expect
      .poll(() => warnings.filter((line) => line.includes('MALFORMED_FUNCTION_CALL')).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);
    // … and there is nothing on the bar: a rejected call used to leave the bar speaking for itself,
    // and now a RECOVERED one does not take the person's screen at all. The picture is the evidence
    // the DoD asks for, written only when a shot directory is configured.
    expect(await page.getByTestId('voice-realtime-error').count()).toBe(0);
    await shot(page, 'live-recoverable-error-1280');
    // It spoiled one model turn, not the session.
    await expect.poll(() => phase(page), { timeout: 5_000 }).toBe('listening');
    await expect(page.getByTestId('voice-realtime-mute')).toBeEnabled();

    const framesBefore = upstream.audioFrameCount();
    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.audioFrameCount(), { timeout: 20_000 }).toBeGreaterThan(framesBefore);

    await page.getByTestId('voice-realtime-end').click();
    await expect(page.getByTestId('voice-realtime-bar')).toHaveCount(0);
  });

  test('moving the pane to another session ends the Live Voice connection instead of leaving it open', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page);
    await pushFirstCaptureFrame(page);
    await waitForPhase(page, 'listening');
    await expect.poll(() => upstream.liveConnectionCount(), { timeout: 15_000 }).toBe(1);

    // Another session in the same pane: voice mode falls back to the text composer in the
    // same render — and the microphone and the upstream session must go with it.
    await page.getByRole('button', { name: /new session/i }).first().click();
    await expect(page.getByTestId('voice-realtime-bar')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => upstream.liveConnectionCount(), { timeout: 15_000 }).toBe(0);
  });
});
