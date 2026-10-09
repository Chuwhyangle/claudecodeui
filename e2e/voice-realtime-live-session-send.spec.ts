/**
 * GOAL-031 / AC-312 — the browser voice criterion, on a real browser against a
 * real server.
 *
 * WHAT THIS FILE IS FOR. The two dependencies of this task each proved one half
 * in isolation: AC-310 wired the Realtime tool table to the real MCP services,
 * AC-311 made that bridge survive a dropped connection. Neither had a browser.
 * This file drives the whole chain the task names — microphone permission →
 * audio frames → a model tool call → an editable on-screen intent → an explicit
 * send → `session_send` → the reply rendered in the ordinary transcript — and
 * reads each link as a DOM or protocol fact.
 *
 * WHAT IS REAL AND WHAT IS NOT. The composer half of the app has no voice
 * transport yet (that is a LATER task), so this file does not lean on it: the
 * thing under test is the control plane AC-312 ADDS — `VoiceRealtimeControl` and
 * the `/voice-realtime` proxy — driven directly through its own testids. Two
 * things are stand-ins, and each is named where it lives:
 *
 *   · the microphone, because no CI machine has one and a real one cannot be
 *     told to speak an exact frame. An init script replaces `AudioContext`,
 *     `AudioWorkletNode` and `getUserMedia` with an inert graph this file
 *     pushes PCM into (`__voiceFake.speak(0.6)`), exactly the interface the real
 *     worklet forwards, so everything downstream of the audio thread is the
 *     shipping code.
 *
 *   · the Realtime upstream (DashScope). The server dials
 *     `VOICE_REALTIME_ENDPOINT`, which `playwright.config.ts` points at a port
 *     this file's own WS server owns. The fake upstream speaks the DashScope
 *     dialect (it must receive the `session.update` before it may emit a
 *     function call, because the transport validates the call's arguments
 *     against the tools that update advertised), proposes a `session_send`, and
 *     is otherwise inert. This is the repo's e2e convention: a fake server on a
 *     real socket, so the proxy, the transport and the bridge are all real.
 *
 * WHAT MAKES THE REPLY LAND. The deployed session is armed through the debug
 * agent (the same seam `transcript-task-terminal-row.spec.ts` uses), so
 * `dispatchRun` routes the voice `session_send` to a provider whose typed turn
 * writes the message text as a real transcript row — on disk and in history.
 * Nothing about the reply is stubbed: the assertion reads the same transcript
 * pane a person reads.
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

const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice realtime — DoD arm';
const SEED_USER_TEXT = 'seeded user turn for the voice realtime criterion';

/** What the fake upstream's function call proposes the model wants to send. */
const PROPOSED_TEXT = 'ORIGINAL proposal the model asked to send';
/** What the person types into the editable intent — the text that must reach the session. */
const EDITED_TEXT = 'EDITED instruction the user approved';

/** One spoken burst, long enough to produce one PCM frame the proxy forwards upstream. */
const SPEECH_SECONDS = 0.6;

/**
 * A scenario that only exists to make the session armable.
 *
 * `armDebugAgentScenario` refuses a document whose `steps` is empty and whose
 * `expect` is absent, so this is the smallest valid one. Its walk writes nothing
 * (`wait` at t=0) and finishes at once: the run the voice send opens is a
 * carrier for the typed-turn row the PROVIDER writes, not for anything this
 * document does, and the clock is never advanced here. Because the walk ends
 * immediately the run settles before the next leg, so the second leg's
 * `session_send` is not refused as a second run on a busy session.
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
  /** The bound session id a proposed `session_send` must name. Set once, after arming. */
  setBoundSessionId(id: string): void;
  /** How many upstream connections the proxy has dialled. */
  connectionCount(): number;
  close(): Promise<void>;
};

/**
 * Starts the DashScope stand-in on `port` and returns the handle the spec drives.
 *
 * The dialect is the endpoint's `session_send` delivery and nothing else: the
 * FIRST audio frame is answered with a `session_send` function call. The
 * call's `arguments` name the armed session (the executor refuses any other id)
 * and carry `waitSeconds: 0.5`, so the send resolves only after the debug run
 * has written the transcript row the criterion reads.
 */
function startFakeUpstream(port: number): Promise<FakeUpstream> {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  let boundSessionId = '';
  let connections = 0;
  let calls = 0;

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

      // The channel is deliberately narrow: the bridge consumes exactly ONE
      // inbound type (`function_call`, normalised from
      // `response.function_call_arguments.done`) and reports every other type as
      // `UNKNOWN_EVENT`. A stand-in that spoke the endpoint's whole session
      // lifecycle — `session.created`, `response.created`, `response.done` —
      // would therefore keep the browser in an error state that has nothing to
      // do with the criterion, so this one says only what the loop needs.
      if (frame.type === 'input_audio_buffer.append') {
        // The model cannot have decided anything before it has heard anything, and
        // one proposal per connection keeps the two legs independent.
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
            arguments: JSON.stringify({ session: boundSessionId, message: PROPOSED_TEXT, waitSeconds: 0.5 }),
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
        connectionCount: () => connections,
        close: () =>
          new Promise<void>((done) => {
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

/** Drives one whole gesture: open the mic, speak, edit the intent, send it. */
async function speakEditAndSend(page: Page, edited: string): Promise<void> {
  await page.getByTestId('voice-realtime-start').click();
  await waitForPhase(page, 'listening');

  // The one thing the fake microphone does: one spoken burst. It reaches the
  // proxy as a base64 PCM frame and the upstream as `input_audio_buffer.append`,
  // which is what makes the stand-in propose a `session_send`.
  await page.evaluate((seconds: number) => {
    (window as unknown as { __voiceFake: { speak(seconds: number): void } }).__voiceFake.speak(seconds);
  }, SPEECH_SECONDS);

  const intent = page.getByTestId('voice-realtime-intent');
  await expect(intent).toBeVisible({ timeout: 25_000 });
  expect(await intent.inputValue()).toBe(PROPOSED_TEXT);

  // AC2: the shown text is editable, and the EDIT is what gets sent.
  await intent.fill(edited);
  await page.getByTestId('voice-realtime-send').click();
  await waitForPhase(page, 'sent');
}

/** The transcript's own text, read straight off the pane. */
const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

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

  test('PC: speaking shows an editable intent, and sending the edit lands in the transcript', async () => {
    await expect(page.getByTestId('voice-realtime-control')).toBeVisible({ timeout: 30_000 });

    await speakEditAndSend(page, EDITED_TEXT);

    // AC1 + AC3: the send went through the proxy to the real control service, so
    // the turned text is a transcript row on disk. Reload, so the reading is the
    // HISTORY a person sees rather than anything this page held live.
    await page.getByTestId('voice-realtime-stop').click();
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(EDITED_TEXT);
    const shown = await paneText(page);
    // AC2: the sent text is the EDIT, never the model's proposal.
    expect(shown).not.toContain(PROPOSED_TEXT);
    expect(await page.locator(USER_ROW).filter({ hasText: EDITED_TEXT }).count()).toBeGreaterThanOrEqual(1);

    // The stand-in really was dialled: the chain was browser → proxy → upstream.
    expect(upstream.connectionCount()).toBeGreaterThanOrEqual(1);
  });

  test('375px: the same gesture works with the core controls reachable', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('voice-realtime-control')).toBeVisible({ timeout: 30_000 });

    // AC4: the core controls are on screen and operable at this width, not merely
    // present in the DOM.
    const start = page.getByTestId('voice-realtime-start');
    await expect(start).toBeVisible({ timeout: 20_000 });
    const box = await start.boundingBox();
    if (!box) await explain(page, 'the voice start control had no box at 375px');
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(376);

    const secondEdit = `${EDITED_TEXT} (mobile)`;
    await speakEditAndSend(page, secondEdit);

    await page.getByTestId('voice-realtime-stop').click();
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(secondEdit);

    expect(upstream.connectionCount()).toBeGreaterThanOrEqual(2);
  });
});
