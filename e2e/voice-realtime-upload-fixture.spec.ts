/**
 * GOAL-033 / AC-316 — the browser voice criterion's upload half, on a real
 * browser against a real server, with NO microphone stand-in anywhere in the
 * run.
 *
 * WHAT THIS FILE IS FOR. The sibling spec
 * (`voice-realtime-live-session-send.spec.ts`) proves the chain with a fake
 * `AudioContext`/`AudioWorkletNode`/microphone-capture graph standing in for a
 * microphone no CI machine has. This file proves the SAME chain — browser →
 * `/voice-realtime` proxy → (fake) Realtime upstream → a model's proposed
 * `session_send` → the real `session_send` → the turn in the ordinary
 * transcript — through the OTHER audio source `useVoiceRealtimeSession`
 * supports: an uploaded fixture file, decoded by the browser's REAL
 * `AudioContext.decodeAudioData` (no mock of the Web Audio API at all) and
 * replayed through `fileAudioSource` in
 * `src/modules/chat/voice-realtime/audioSource.ts` — the same module
 * `microphoneAudioSource` lives in, so this is a run of the shared pipeline,
 * not a parallel one. This is also this repo's fixed-corpus automated
 * end-to-end path for voice: a known WAV fixture, decoded and chunked exactly
 * once per run, with a deterministic outcome.
 *
 * WHAT AC-316 CHANGED HERE. There is no draft-and-confirm step any more: the
 * bar captures continuously, and the model's `session_send` executes the moment
 * it is called, so the fixture's turn appears in the transcript with no edit
 * step and no visible upload button — the file input is a hidden test seam,
 * driven directly. The bar's automatic microphone start is suppressed with the
 * `__voiceRealtimeSkipAutoStart` window flag, because this file injects a file
 * instead of feeding a fake microphone, and no CI machine has a real one.
 *
 * WHAT AC-315 READS HERE (the criterion repointed onto the bar). AC-315's own
 * guarantee is unchanged by AC-316 and is read in this file, on this UI, as
 * four mechanical facts — none of which is "a turn appeared":
 *
 *   · the uploaded corpus was really decoded and CHUNKED: the upstream's
 *     `input_audio_buffer.append` count grows by more than one across the
 *     injection, and it reaches a fresh upstream connection. One frame, or an
 *     empty source, fails here (see the handshake-gap queue in
 *     `useVoiceRealtimeSession`); the falsification is recorded in the task's
 *     DoD.
 *   · the run went through NO microphone: every `navigator.mediaDevices.
 *     getUserMedia` call is counted by an init-script stub that REJECTS, and
 *     each case asserts the count is zero when it ends — the mic path is not
 *     merely unused, it is unavailable.
 *   · the browser's own Web Audio API is what decoded the fixture: the
 *     init script replaces no `AudioContext`, so the check below reads the
 *     NATIVE constructor and `decodeAudioData` back out of the page.
 *   · the instruction LANDED IN HISTORY: the executing `session_send` writes a
 *     real user row, and that row survives `page.reload()`.
 *
 * The draft-confirmation reading ("the model's proposed text must not appear in
 * the transcript") was a property of AC-312's superseded UI: with the draft card
 * gone the proposal IS what gets sent, so that assertion is retired with the
 * shape it described — it is not re-created here.
 *
 * WHAT IS REAL AND WHAT IS NOT. The Realtime upstream (DashScope) is a stand-in
 * for the same reason the sibling spec uses one: the server dials
 * `VOICE_REALTIME_ENDPOINT`, which `playwright.config.ts` points at a port this
 * file's own WS server owns. Everything else — the browser's audio decode, the
 * `/voice-realtime` proxy, the bridge, the real `session_send` — is the
 * shipping code. This file defines NO audio cut of its own: unlike the sibling
 * spec there is no fake `AudioContext`/`AudioWorkletNode`/capture graph here,
 * which is also why a `getUserMedia` call can only come from the shipping
 * `microphoneAudioSource`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

const PANE = '.chat-messages-pane';
const USER_ROW = '[data-message-style="user"]';
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';

/**
 * The phases the bar's own `voice-realtime-phase` seam may report.
 *
 * This file drives the SHIPPED bar and nothing else, so the phase it reads has
 * to be one of the bar's own states — the seam is asserted, not assumed, and a
 * bar that reported anything else fails here rather than being papered over.
 * The removed draft control plane's testids are deliberately NOT named anywhere
 * in this file (its "gone, not moved" reading belongs to the sibling spec): the
 * repointed criterion must not depend on literals of a deleted UI.
 */
const PHASE_STATES: readonly string[] = ['idle', 'connecting', 'listening', 'muted', 'failed'];

// Deliberately the SAME account the sibling spec (`voice-realtime-live-session-send.spec.ts`)
// registers: the criterion chains both files into one Playwright invocation, and
// this server is a single-user system — a second, distinct hardcoded username would 403 on
// register and then 403 again on login, since the one user slot the first file claimed is not
// this file's username. Reusing it means whichever file runs first registers it and the second
// logs into the same account; either run order, and running this file alone, all work.
const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice realtime upload — DoD arm';
const SEED_USER_TEXT = 'seeded user turn for the voice realtime upload criterion';

/** What the fake upstream's function call sends. There is no edit step any more. */
const PROPOSED_TEXT = 'voice instruction delivered from the uploaded fixture';

/** A scenario that only exists to make the session armable — see the sibling spec for why. */
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
// The fixed-corpus fixture file.
// ---------------------------------------------------------------------------------------------

/**
 * Writes a tiny 16 kHz mono 16-bit PCM WAV file — a deterministic, fixed-corpus
 * stand-in for "someone uploaded a short recording" — and returns its path.
 *
 * A real, decodable WAV rather than silence-with-the-right-headers: the samples
 * are a quiet sine tone, so `AudioContext.decodeAudioData` has real audio data
 * to hand back, not an all-zero buffer a decoder could special-case.
 */
function writeFixtureWav(seconds: number): string {
  const sampleRate = 16_000;
  const sampleCount = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 0.2 * 0x7fff;
    data.writeInt16LE(Math.round(value), index * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  const fixturePath = path.join(os.tmpdir(), `voice-realtime-upload-fixture-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(fixturePath, Buffer.concat([header, data]));
  return fixturePath;
}

// ---------------------------------------------------------------------------------------------
// The fake Realtime upstream — identical dialect to the sibling spec (see its own comment for why
// it speaks only `input_audio_buffer.append` → one `response.function_call_arguments.done`).
// ---------------------------------------------------------------------------------------------

type FakeUpstream = {
  setBoundSessionId(id: string): void;
  connectionCount(): number;
  audioFrameCount(): number;
  close(): Promise<void>;
};

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
        audioFrameCount: () => audioFrames,
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

const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

/**
 * How many times the page called `navigator.mediaDevices.getUserMedia`.
 *
 * `-1` when the counting seam is absent: a later edit that dropped the init
 * script's stub must fail the `toBe(0)` below rather than read as "no
 * microphone calls were made".
 */
function mediaCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const seam = (window as unknown as Record<string, unknown>).__voiceRealtimeGetUserMediaCalls;
    return typeof seam === 'function' ? (seam as () => number)() : -1;
  });
}

/**
 * Reads back that the page is the one this file means to drive.
 *
 * Two halves, both mechanical. The browser's own Web Audio API must be
 * unpatched — this file defines no fake `AudioContext`/`AudioWorkletNode`
 * graph, so `decodeAudioData` really is the browser decoding the fixture. And
 * the `getUserMedia` counting stub must be installed, so the per-case "no
 * microphone" reading below is evidence rather than an absence of it.
 */
async function assertNoAudioSourceStandIn(page: Page): Promise<void> {
  const reading = await page.evaluate(() => {
    const isNative = (value: unknown): boolean =>
      typeof value === 'function' && /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(value));
    const ctor = (window as unknown as Record<string, unknown>).AudioContext as
      | { prototype?: { decodeAudioData?: unknown } }
      | undefined;
    return {
      audioContext: isNative(ctor),
      decodeAudioData: isNative(ctor?.prototype?.decodeAudioData),
      getUserMediaStubbed: !isNative(navigator.mediaDevices.getUserMedia),
    };
  });
  expect(reading.audioContext, 'AudioContext must be the browser native one: this file defines no fake audio graph').toBe(true);
  expect(reading.decodeAudioData, 'decodeAudioData must be the browser implementation: the fixture is really decoded').toBe(true);
  expect(reading.getUserMediaStubbed, 'the getUserMedia counting stub must be installed').toBe(true);
}

/** Enters Live Voice and waits for the bar to have replaced the composer. */
async function enterLiveVoice(page: Page): Promise<void> {
  await assertNoAudioSourceStandIn(page);
  await page.getByTestId('live-voice-enter').click();
  await expect(page.getByTestId('voice-realtime-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
  // The bar's own phase seam, read off the shipped control rather than off copy.
  const phase = ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();
  expect(PHASE_STATES).toContain(phase);
}

/**
 * Drives one whole gesture through the upload path: inject the fixture into the
 * hidden input and let the pipeline run to the transcript. No microphone-capture
 * call and no fake audio graph are involved anywhere in this function — the
 * browser's real `AudioContext.decodeAudioData` runs on the fixture, and the
 * model's `session_send` executes without any browser round-trip.
 */
async function injectFixture(page: Page, fixturePath: string): Promise<void> {
  await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);
  // The fixture decodes and chunks faster than the proxy reports the upstream
  // `open`, so every frame goes through the hook's handshake-gap queue before
  // the first one reaches the fake upstream. Wait on the resulting transcript
  // turn rather than a phase — `listening` can pass before a poll's first check.
  await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);
}

test.describe.configure({ mode: 'serial' });

test.describe('voice realtime upload fixture', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: FakeUpstream;
  let sessionId = '';
  let workspaceName = '';
  let fixturePath = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }

    fixturePath = writeFixtureWav(0.6);
    upstream = await startFakeUpstream(upstreamPort);

    const workspace = path.join(fixtureHome, 'voice-realtime-upload-workspace');
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
        // This file injects a fixture instead of feeding a fake microphone, so
        // the bar's automatic `start()` (which would call the real
        // `getUserMedia`) is suppressed — no CI machine has a microphone.
        (window as unknown as Record<string, unknown>).__voiceRealtimeSkipAutoStart = true;

        // AC-315's no-microphone guarantee, made countable. The stub REJECTS
        // rather than resolves, so a run that entered the microphone path would
        // fail on its own terms as well as move the count: "no microphone" is a
        // positive reading, not an absence of evidence. Every case reads the
        // count back through `__voiceRealtimeGetUserMediaCalls` when it ends.
        let mediaCalls = 0;
        const rejectMicrophone = () => {
          mediaCalls += 1;
          return Promise.reject(new Error('this criterion runs with no microphone'));
        };
        const nav = navigator as unknown as { mediaDevices?: Record<string, unknown> };
        const mediaDevices = nav.mediaDevices ?? {};
        mediaDevices.getUserMedia = rejectMicrophone;
        if (!nav.mediaDevices) {
          Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
        }
        (window as unknown as Record<string, unknown>).__voiceRealtimeGetUserMediaCalls = () => mediaCalls;
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
    if (fixturePath) {
      fs.rmSync(fixturePath, { force: true });
    }
  });

  test('injecting a fixed-corpus fixture sends its instruction through the ordinary transcript, with no draft step', async () => {
    const composer = page.locator(COMPOSER_TEXTAREA);
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page);
    const bar = page.getByTestId('voice-realtime-bar');

    // There is no visible upload trigger — the input is a hidden test seam only.
    const uploadInput = page.locator('[data-testid="voice-realtime-upload-input"]');
    await expect(uploadInput).toHaveCount(1);
    // The injection seam is hidden, not a visible control: `sr-only` renders it
    // at most a pixel across, so nothing on screen offers to open it.
    const seamBox = await uploadInput.boundingBox();
    expect(seamBox ? Math.max(seamBox.width, seamBox.height) : 0).toBeLessThanOrEqual(2);

    // AC-315's upload reading, measured ACROSS the gesture rather than assumed:
    // the fixture was really decoded and chunked into more than one wire frame —
    // "chunked audio delivery", not one giant frame — and those frames reached a
    // fresh upstream connection. A >1 frame delta is also the handshake-gap
    // queue's falsification: without it the whole fixture is produced into the
    // still-connecting socket and the delta stays at 0.
    const framesBefore = upstream.audioFrameCount();
    const connectionsBefore = upstream.connectionCount();

    await injectFixture(page, fixturePath);

    // The instruction reached the session through the ordinary transcript
    // rendering — the send executed the moment the model called it.
    expect(await paneText(page)).toContain(PROPOSED_TEXT);

    expect(upstream.connectionCount() - connectionsBefore).toBeGreaterThanOrEqual(1);
    expect(upstream.audioFrameCount() - framesBefore).toBeGreaterThan(1);

    // AC-315's no-microphone reading for this case's capture window: the gesture
    // above reached the upstream without the microphone path ever being entered.
    expect(await mediaCallCount(page)).toBe(0);

    // AC3: End closes and returns the composer to the pane.
    await page.getByTestId('voice-realtime-end').click();
    await expect(bar).toHaveCount(0);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // History, not this page's live state.
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(PROPOSED_TEXT);
    expect(await page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count()).toBeGreaterThanOrEqual(1);

    // Closing the case: the reload re-ran the init script, so this reads the
    // post-reload window — still zero microphone calls anywhere in the case.
    expect(await mediaCallCount(page)).toBe(0);
  });

  test('375px: the same injection gesture works with the bar inside the viewport', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    const composer = page.locator(COMPOSER_TEXTAREA);
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await enterLiveVoice(page);

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

    // AC-315's own reading for the SECOND injection: measure what the second
    // upload actually delivers, not merely that a turn appeared. The transcript
    // already holds the first turn, so the delivery proof is the frame delta and
    // a fresh connection.
    const framesBefore = upstream.audioFrameCount();
    const connectionsBefore = upstream.connectionCount();
    await injectFixture(page, fixturePath);
    expect(upstream.audioFrameCount() - framesBefore).toBeGreaterThan(1);
    expect(upstream.connectionCount() - connectionsBefore).toBeGreaterThanOrEqual(1);

    // The second gesture is the one that could plausibly have fallen back to the
    // microphone; it did not.
    expect(await mediaCallCount(page)).toBe(0);

    await page.getByTestId('voice-realtime-end').click();
    await expect(bar).toHaveCount(0);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.locator(USER_ROW).filter({ hasText: PROPOSED_TEXT }).count(), { timeout: 25_000 })
      .toBeGreaterThanOrEqual(2);

    expect(await mediaCallCount(page)).toBe(0);
  });
});
