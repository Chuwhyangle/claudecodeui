/**
 * The Live Voice bar must not say `Listening…` before the microphone is capturing.
 *
 * WHAT THIS FILE IS FOR. `state: open` reports the UPSTREAM Realtime session; capture is
 * asynchronous (`getUserMedia` → `AudioContext` → the worklet). On 2026-10-18 a real session
 * (`0256124a`) showed the bar on `Listening…` 289 ms before the first captured frame — speech in
 * that window could not reach the WAV or the wire, yet the page claimed to be listening. This spec
 * reads the fix on a real browser against the real app server and the real `/voice-realtime` proxy:
 * while `getUserMedia` is still pending and the upstream has already reported open, the status cell
 * carries `data-capture="starting"` and the not-ready sentence; the first captured frame flips the
 * same cell to `Listening…` / `data-capture="live"`.
 *
 * WHAT IS REAL AND WHAT IS NOT. The account, the session, the proxy and the relay are the run's
 * real server. The Realtime upstream is the shared scripted stand-in on
 * `QUAY_E2E_VOICE_REALTIME_PORT` (it answers `session.update`, which is what drives the proxy to
 * `state: open`), and the microphone is an init-script capture graph whose `getUserMedia` is held
 * 1.5 s and whose first frame is pushed BY THIS SPEC — so "no frame yet" is a fact the test owns,
 * not a race. `playwright.config.ts` arms both selections this file needs (see the
 * `voiceRealtimeSelection` and `DEBUG_AGENT_SPEC_FILES` entries naming it).
 *
 * THE PHASE SEAM IS THE WAVEFORM'S INPUT. `voice-realtime-phase` carries the raw phase; the bar
 * draws the meter from `phase === 'listening'`, so `arming` in that seam is the mechanical reading
 * of "the waveform is held inactive" without asserting on animation frames.
 */

import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import { startScriptedUpstream, type ScriptedUpstreamServer } from './voiceRealtimeScriptedUpstream';

/** This run's throwaway data directory, published by playwright.config.ts. */
const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;

const PANE = '.chat-messages-pane';
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
const BAR = '[data-testid="voice-realtime-bar"]';
const STATUS = '[data-testid="voice-realtime-status"]';

// The SAME account the sibling Live Voice specs use: this server is single-user, so a second
// hardcoded username would 403 on register and again on login. Reusing it makes any run order work.
const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice realtime capture-ready probe';
const SEED_USER_TEXT = 'seeded user turn for the capture-ready criterion';

/**
 * The microphone window this criterion reads, declared here because the ARM is what makes it
 * deterministic: `getUserMedia` must not have returned before the upstream opens.
 */
const GET_USER_MEDIA_DELAY_MS = 1_500;

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

/** The seeded project's row, named by its basename the way the sidebar draws it. */
const projectRow = (page: Page, workspaceName: string) =>
  page
    .getByRole('heading', { name: workspaceName })
    .or(page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }))
    .first();

const sessionRow = (page: Page, sessionId: string) => page.locator(`a[href="/session/${sessionId}"]`).first();

async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  throw new Error(`the sidebar never showed a row for session ${sessionId}`);
}

async function armScenario(api: APIRequestContext, projectPath: string): Promise<string> {
  const scenario = {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title: TITLE, userText: SEED_USER_TEXT },
    steps: [{ at: 0, op: 'wait' }],
    expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
  };
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return sessionId;
}

/** The page-side capture stand-in this spec drives. */
type CaptureHarness = {
  getUserMediaCalls(): number;
  nodeReady(): boolean;
  frames(): number;
  /** Pushes the FIRST captured frame; `false` while the capture graph does not exist yet. */
  pushFirstFrame(): boolean;
};

test.describe.configure({ mode: 'serial' });
// One case, bounded under the config's 55s single-file watchdog (same shape as
// `voice-realtime-new-session-entry.spec.ts`).
test.describe.configure({ timeout: 45_000 });

test.describe('the bar says Listening only after the first captured frame', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: ScriptedUpstreamServer;

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }

    upstream = await startScriptedUpstream(upstreamPort);

    const workspace = path.join(fixtureHome, 'voice-capture-ready-workspace');
    const workspaceName = path.basename(workspace);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    const sessionId = await armScenario(api, workspace);

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(
      ({ authToken, gUMDelayMs }: { authToken: string; gUMDelayMs: number }) => {
        window.localStorage.setItem('auth-token', authToken);
        window.localStorage.setItem('userLanguage', 'en');

        // THE CAPTURE STAND-IN. `getUserMedia` is HELD for `gUMDelayMs`, so the upstream is open
        // while the microphone is still starting — the window this criterion is about. The first
        // frame is pushed by the spec, not on a timer, so "no frame yet" is the test's own fact.
        const state: {
          node: { port: { onmessage: ((message: unknown) => void) | null } } | null;
          calls: number;
          frames: number;
        } = { node: null, calls: 0, frames: 0 };

        class FakeWorkletNode {
          port: { onmessage: ((message: unknown) => void) | null; postMessage: () => void };

          constructor() {
            this.port = { onmessage: null, postMessage: () => undefined };
            state.node = this;
          }

          connect() {
            /* the graph is inert; the spec drives the port directly */
          }
        }

        class FakeAudioContext {
          sampleRate = 16_000;
          destination = {};
          state = 'running';
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

          addEventListener() {
            /* no statechange is driven: the capture stays running */
          }

          resume() {
            return Promise.resolve();
          }
        }

        (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
        (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeWorkletNode;
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: async () => {
              state.calls += 1;
              await new Promise((resolve) => setTimeout(resolve, gUMDelayMs));
              return { getTracks: () => [{ stop: () => undefined }] };
            },
          },
        });

        const harness = {
          getUserMediaCalls: () => state.calls,
          nodeReady: () => state.node !== null,
          frames: () => state.frames,
          pushFirstFrame: (): boolean => {
            const node = state.node;
            if (node === null) return false;
            const samples = new Float32Array(3_200); // 200 ms at 16 kHz
            for (let index = 0; index < samples.length; index += 1) {
              samples[index] = 0.2 * Math.sin((2 * Math.PI * 180 * index) / 16_000);
            }
            node.port.onmessage?.({ data: { type: 'pcm', samples } });
            state.frames += 1;
            return true;
          },
        };
        (window as unknown as { __voiceCaptureProbe: typeof harness }).__voiceCaptureProbe = harness;
      },
      { authToken: token, gUMDelayMs: GET_USER_MEDIA_DELAY_MS },
    );

    page = await context.newPage();
    // The microphone button is rendered only when the voice backend reports configured; the
    // upstream is this run's scripted stand-in, so the health route is answered for the page.
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
    await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
    await upstream?.close();
  });

  test('before the first captured frame the bar says Starting microphone… / starting; the frame flips it to Listening… / live', async () => {
    await page.getByTestId('live-voice-button').click();
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });

    // ── the window: upstream open, no captured frame yet ─────────────────────────────────────
    // `arming` is the proxied phase; the meter is drawn from `phase === 'listening'`, so this is
    // also the reading that the waveform is held inactive.
    await expect
      .poll(() => page.getByTestId('voice-realtime-phase').textContent(), { timeout: 25_000 })
      .toBe('arming');
    const harnessAtWindow = await page.evaluate(() => {
      const probe = (window as unknown as { __voiceCaptureProbe: CaptureHarness }).__voiceCaptureProbe;
      return { frames: probe.frames(), calls: probe.getUserMediaCalls() };
    });
    // Non-vacuity: the capture really has not produced a frame yet, and it really was started.
    expect(harnessAtWindow.frames, 'the first frame must not have been pushed before this reading').toBe(0);
    expect(harnessAtWindow.calls, 'getUserMedia was never called — this is not the microphone path').toBeGreaterThanOrEqual(1);

    const status = page.locator(STATUS);
    expect(await status.getAttribute('data-capture'), 'the capture reading before the first frame').toBe('starting');
    const statusText = (await status.textContent()) ?? '';
    expect(statusText.trim(), 'the bar claimed to be listening before the microphone captured anything').not.toBe('Listening…');
    expect(statusText.trim()).toBe('Starting microphone…');
    console.log(`[capture-ready] before-frame phase=arming status="${statusText.trim()}" data-capture=starting frames=${harnessAtWindow.frames}`);

    // ── the first captured frame ─────────────────────────────────────────────────────────────
    // It can only be pushed once the capture graph exists (getUserMedia has returned); wait for it.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __voiceCaptureProbe: CaptureHarness }).__voiceCaptureProbe.nodeReady()), { timeout: 15_000 }).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { __voiceCaptureProbe: CaptureHarness }).__voiceCaptureProbe.pushFirstFrame()),
      'the capture graph never accepted the first frame',
    ).toBe(true);

    await expect.poll(() => status.textContent(), { timeout: 15_000 }).toBe('Listening…');
    expect(await status.getAttribute('data-capture'), 'the capture reading after the first frame').toBe('live');
    await expect.poll(() => page.getByTestId('voice-realtime-phase').textContent()).toBe('listening');
    console.log('[capture-ready] after-frame phase=listening status="Listening…" data-capture=live');

    // Leave the mode, so the case leaves no live socket behind.
    await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
  });
});
