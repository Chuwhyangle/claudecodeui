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

/** One spoken burst. The fake worklet turns one burst into exactly one `audio` frame. */
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
  /** How many `input_audio_buffer.append` frames the upstream has received. */
  audioFrameCount(): number;
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
                // `message` must be a string.
                arguments: JSON.stringify({ message: 42 }),
              }),
            );
          }
        },
        connectionCount: () => connections,
        audioFrameCount: () => audioFrames,
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

/** The transcript's own text, read straight off the pane. */
const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

/** One spoken burst — the fake microphone's only action. */
const speak = (page: Page, seconds: number): Promise<void> =>
  page.evaluate((value: number) => {
    (window as unknown as { __voiceFake: { speak(seconds: number): void } }).__voiceFake.speak(value);
  }, seconds);

/** Enters Live Voice and waits for the bar to have replaced the composer. */
async function enterLiveVoice(page: Page): Promise<void> {
  await page.getByTestId('live-voice-enter').click();
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

        // The fake audio graph. `speak` is the driver the spec uses; `node` is
        // where the hook attaches its `onmessage`, captured at construction.
        type Port = { port: { onmessage: ((m: unknown) => void) | null } };
        const state: { node: Port | null; atSample: number; speak: (seconds: number) => void } = {
          node: null,
          atSample: 0,
          speak(seconds: number) {
            const node = state.node;
            if (!node) throw new Error('the fake capture was not connected yet');
            const count = Math.max(1, Math.round(seconds * 16_000));
            const samples = new Float32Array(count);
            samples.fill(0.3);
            node.port.onmessage?.({ data: { type: 'pcm', samples, atSample: state.atSample } });
            state.atSample += count;
          },
        };
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
      { authToken: token },
    );
    page = await context.newPage();

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

    // AC3: entering Live Voice starts capture automatically.
    await waitForPhase(page, 'listening');

    // AC2: one fixed, compact bar — the same height in every reachable phase.
    const barHeight = async (): Promise<number> => (await bar.boundingBox())?.height ?? 0;
    const listeningHeight = await barHeight();
    expect(listeningHeight).toBeGreaterThan(0);

    // AC3: Mute withholds frames without closing or re-opening the connection.
    const connectionBeforeMute = upstream.connectionCount();
    const framesBeforeMute = upstream.audioFrameCount();
    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'muted');
    const mutedHeight = await barHeight();

    // A burst while muted must reach no one: the upstream frame count stays put.
    await speak(page, SPEECH_SECONDS);
    await page.waitForTimeout(400);
    expect(upstream.audioFrameCount()).toBe(framesBeforeMute);

    await page.getByTestId('voice-realtime-mute').click();
    await waitForPhase(page, 'listening');
    expect(upstream.connectionCount()).toBe(connectionBeforeMute);
    expect(Math.abs(mutedHeight - listeningHeight)).toBeLessThanOrEqual(4);

    // Unmuted audio flows again — the same connection carries it.
    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.audioFrameCount(), { timeout: 20_000 }).toBeGreaterThan(framesBeforeMute);

    // The model proposes a `session_send` the moment it hears audio, and AC-316
    // executes it immediately. Capture must stay operable THROUGH that window.
    await expect.poll(() => upstream.callCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
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

  test('a malformed model call is reported on the bar, and the microphone and the connection stay alive', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    upstream.emitMalformedCall();

    // The failure is SHOWN — a rejected call used to vanish and the bar read
    // "Listening…" while nothing happened — …
    await expect(page.getByTestId('voice-realtime-error')).toContainText(/schema/i, { timeout: 15_000 });
    // … but it spoiled one model turn, not the session.
    await expect.poll(() => phase(page), { timeout: 5_000 }).toBe('listening');
    await expect(page.getByTestId('voice-realtime-mute')).toBeEnabled();

    const framesBefore = upstream.audioFrameCount();
    await speak(page, SPEECH_SECONDS);
    await expect.poll(() => upstream.audioFrameCount(), { timeout: 20_000 }).toBeGreaterThan(framesBefore);

    await page.getByTestId('voice-realtime-end').click();
    await expect(page.getByTestId('voice-realtime-bar')).toHaveCount(0);
  });
});
