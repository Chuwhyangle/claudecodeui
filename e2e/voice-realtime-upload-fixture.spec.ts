/**
 * GOAL-031 / AC-315 — the browser voice criterion's upload half, on a real
 * browser against a real server, with NO microphone stand-in anywhere in the
 * run.
 *
 * WHAT THIS FILE IS FOR. AC-312's own e2e spec
 * (`voice-realtime-live-session-send.spec.ts`) proves the chain with a fake
 * `AudioContext`/`AudioWorkletNode`/`getUserMedia` graph standing in for a
 * microphone no CI machine has. This file proves the SAME chain — browser →
 * `/voice-realtime` proxy → (fake) Realtime upstream → a model's proposed
 * `session_send` → an editable on-screen intent → an explicit send → the real
 * `session_send` → the reply in the ordinary transcript — through the OTHER
 * audio source `useVoiceRealtimeSession` supports: an uploaded fixture file,
 * decoded by the browser's REAL `AudioContext.decodeAudioData` (no mock of
 * the Web Audio API at all) and replayed through `fileAudioSource` in
 * `src/modules/chat/voice-realtime/audioSource.ts` — the same module
 * `microphoneAudioSource` lives in, so this is a run of the shared pipeline,
 * not a parallel one. This is also this repo's fixed-corpus automated
 * end-to-end path for voice: a known WAV fixture, decoded and chunked exactly
 * once per run, with a deterministic outcome.
 *
 * WHAT IS REAL AND WHAT IS NOT. The Realtime upstream (DashScope) is a stand-in
 * for the same reason AC-312's spec uses one: the server dials
 * `VOICE_REALTIME_ENDPOINT`, which `playwright.config.ts` points at a port this
 * file's own WS server owns. Everything else — the browser's audio decode, the
 * `/voice-realtime` proxy, the bridge, the real `session_send` — is the
 * shipping code.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

const PANE = '.chat-messages-pane';
const USER_ROW = '[data-message-style="user"]';

// Deliberately the SAME account the sibling spec (`voice-realtime-live-session-send.spec.ts`)
// registers: AC-312's own criterion now chains both files into one Playwright invocation, and
// this server is a single-user system — a second, distinct hardcoded username would 403 on
// register and then 403 again on login, since the one user slot the first file claimed is not
// this file's username. Reusing it means whichever file runs first registers it and the second
// logs into the same account; either run order, and running this file alone, all work.
const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice realtime upload — DoD arm';
const SEED_USER_TEXT = 'seeded user turn for the voice realtime upload criterion';

/** What the fake upstream's function call proposes the model wants to send. */
const PROPOSED_TEXT = 'ORIGINAL proposal from the uploaded-fixture run';
/** What the person types into the editable intent — the text that must reach the session. */
const EDITED_TEXT = 'EDITED instruction the user approved (upload path)';

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

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

const waitForPhase = (page: Page, wanted: string) =>
  expect.poll(() => phase(page), { timeout: 25_000 }).toBe(wanted);

/**
 * Drives one whole gesture through the upload path: pick the fixture file,
 * wait for the model's proposed intent, edit it, send it. No `getUserMedia`
 * call and no fake audio graph are involved anywhere in this function — the
 * browser's real `AudioContext.decodeAudioData` runs on the fixture.
 */
async function uploadEditAndSend(page: Page, fixturePath: string, edited: string): Promise<void> {
  await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);

  // Unlike a held-open microphone, a short fixture can decode, chunk, reach the
  // fake upstream and come back as a proposed intent before a poll even runs
  // its first check — `listening` can already have given way to
  // `understanding` by then, so this waits on the intent directly rather than
  // pinning a phase that may never be observed.
  const intent = page.getByTestId('voice-realtime-intent');
  await expect(intent).toBeVisible({ timeout: 25_000 });
  expect(await intent.inputValue()).toBe(PROPOSED_TEXT);

  // AC2 (shared with the microphone path): the shown text is editable, and the
  // EDIT is what gets sent.
  await intent.fill(edited);
  await page.getByTestId('voice-realtime-send').click();
  await waitForPhase(page, 'sent');
}

const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

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

  test('uploading a fixed-corpus fixture shows an editable intent, and sending the edit lands in the transcript', async () => {
    await expect(page.getByTestId('voice-realtime-control')).toBeVisible({ timeout: 30_000 });

    await uploadEditAndSend(page, fixturePath, EDITED_TEXT);

    // AC1 + AC3 of AC-312, reused verbatim for the upload source: the send went
    // through the same proxy to the same real control service, so the turned
    // text is a transcript row on disk. Reload, so the reading is HISTORY.
    await page.getByTestId('voice-realtime-stop').click();
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(EDITED_TEXT);
    const shown = await paneText(page);
    expect(shown).not.toContain(PROPOSED_TEXT);
    expect(await page.locator(USER_ROW).filter({ hasText: EDITED_TEXT }).count()).toBeGreaterThanOrEqual(1);

    // AC-315's own reading: the fixture was actually decoded and chunked into
    // more than one wire frame — this is "chunked audio delivery", not one
    // giant frame — and the stand-in really was dialled.
    expect(upstream.connectionCount()).toBeGreaterThanOrEqual(1);
    expect(upstream.audioFrameCount()).toBeGreaterThan(1);
  });

  test('375px: the same upload gesture works with the core controls reachable', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('voice-realtime-control')).toBeVisible({ timeout: 30_000 });

    // AC4 of AC-312, reused verbatim for the upload source: the core controls
    // are on screen and operable at this width, not merely present in the DOM.
    const upload = page.getByTestId('voice-realtime-upload');
    await expect(upload).toBeVisible({ timeout: 20_000 });
    const box = await upload.boundingBox();
    if (!box) await explain(page, 'the voice upload control had no box at 375px');
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(376);

    const secondEdit = `${EDITED_TEXT} (mobile)`;
    await uploadEditAndSend(page, fixturePath, secondEdit);

    await page.getByTestId('voice-realtime-stop').click();
    await page.reload();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => paneText(page), { timeout: 25_000 }).toContain(secondEdit);

    expect(upstream.connectionCount()).toBeGreaterThanOrEqual(2);
  });
});
