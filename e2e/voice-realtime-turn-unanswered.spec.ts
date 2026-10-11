/**
 * `gap-live-voice-upstream-stall-no-answer` — the browser criterion for the DISPOSITION of a spoken
 * turn the endpoint never answers.
 *
 * WHAT THIS FILE IS FOR. The live incident (session `d88c6722`) read as `我说完之后就没反应了`: the
 * endpoint accepted the upload, announced `input_audio_buffer.speech_started`, and then went silent
 * for ~31 s. The bridge's own stall deadline (8 s) fired and the page was handed a generic recoverable
 * error — a sentence, and no state. The turn the person had just spoken was neither answered nor
 * ended: the bar sat on "Listening…" as if nothing had been said.
 *
 * The fix gives that turn an EXPLICIT destination. When the deadline expires the awaited turn is
 * closed on the bridge, the proxy reports it as its own outbound frame (`turn_unanswered`, NOT an
 * `error`), and the page holds it as a session state: the bar's STATUS reads that the turn is
 * unanswered until the next delivery spends it. This file reads that whole chain on a real browser —
 * the shipped bar, the real `/voice-realtime` proxy, the real bridge, and a fake Realtime upstream
 * that is orchestrated to stall.
 *
 * WHY IT IS ITS OWN FILE, AND NOT A CASE IN `voice-realtime-upload-fixture.spec.ts`. A stall arm has
 * to cross the bridge's 8 s deadline, so it costs ~14 s of wallclock that no other voice case pays.
 * That file's criterion (AC-315/AC-317) chains it with a second command under one 60 s gate; growing
 * it by this arm reds those already-achieved criteria on the clock, which is a fact about the gate and
 * not about the behaviour this task changed. The arm therefore lives beside the harness it shares a
 * dialect with rather than inside it — see {@link SPEC_BUDGET_MS} in `playwright.config.ts`, which
 * declares this file's measured run so the watchdog does not kill it mid-case.
 *
 * WHERE FALSIFICATION IS RECORDED (AC3). Two arms:
 *   · the control (`stallSilenceMs = 0`, the shipped dialect) answers at once, so no turn stalls and
 *     the notice must never appear — the same reading the stall arm makes, without the stall.
 *   · removing the disposition (the proxy routes `UPSTREAM_STALLED` back to the generic error channel,
 *     or the bar drops the notice) makes the stall arm RED: the notice never appears before the late
 *     answer lands. The falsification's diff and failing line are recorded in the task's Evidence.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

/** This run's throwaway data directory, published by playwright.config.ts. */
const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;

const PANE = '.chat-messages-pane';
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';

/** The phases the bar's own `voice-realtime-phase` seam may report. */
const PHASE_STATES: readonly string[] = ['idle', 'connecting', 'listening', 'muted', 'failed'];

// Deliberately the SAME account the two sibling voice specs register: this server is single-user, so a
// second distinct hardcoded username would 403 on register and again on login. Reusing it means any
// run order, and running this file alone, all work.
const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';
const TITLE = 'Voice realtime unanswered turn — AC2 arm';
const SEED_USER_TEXT = 'seeded user turn for the voice realtime unanswered-turn criterion';

/** What the endpoint reports it HEARD — a different string from what is delivered, so each names one row. */
const HEARD_TEXT = 'what the endpoint transcribed from the uploaded audio';
/** What the model relays when the endpoint answered only after it went quiet (AC2's stalled arm). */
const STALL_DELIVERED = 'the answer that arrived only after the endpoint went quiet';
/** What the model relays when the endpoint answers at once (AC3(i)'s control). */
const CONTROL_DELIVERED = 'the answer delivered the moment the endpoint heard the utterance';

/**
 * The bridge's own stall deadline, restated here because the arm has to be read against it.
 *
 * A literal (not imported from the server module) on purpose: this file must FAIL if the shipped
 * deadline moves past the arm it drives, rather than following it silently. The arm's silence is a
 * fixed margin above this value.
 */
const BRIDGE_STALL_DEADLINE_MS = 8_000;
/**
 * How long the fake endpoint stays SILENT after announcing that it is hearing speech, before it
 * answers — the orchestrable upstream this file's whole reading is about.
 *
 * The margin above {@link BRIDGE_STALL_DEADLINE_MS} is the window in which the unanswered notice has
 * to be readable BEFORE the late answer lands and spends it.
 */
const STALL_MARGIN_MS = 2_500;

/** When true the endpoint announces speech and stalls; `false` is the shipped dialect (answer at once). */
let stallSilenceMs = 0;

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
// The fixed-corpus fixture file (the relay's own dialect, copied from the sibling spec's comment).
// ---------------------------------------------------------------------------------------------

/**
 * Writes a 16 kHz mono 16-bit PCM WAV — a deterministic, fixed-corpus stand-in for "someone uploaded
 * a short recording" — and returns its path.
 *
 * Two utterances with a measurable pause between them, so the relay's `relay` profile commits TWO
 * segments (see `writeFixtureWav` in the sibling spec for the full arithmetic). This file needs the
 * frames to REACH the upstream so the endpoint's `append` handler — which is where it announces
 * speech and then stalls — is entered at all.
 */
function writeFixtureWav(): string {
  const sampleRate = 16_000;
  const pieces: readonly { seconds: number; amplitude: number }[] = [
    { seconds: 0.6, amplitude: 0.02 },
    { seconds: 0.5, amplitude: 0.5 },
    { seconds: 2.1, amplitude: 0 },
    { seconds: 0.5, amplitude: 0.5 },
    { seconds: 2.1, amplitude: 0 },
  ];
  const sampleCount = pieces.reduce((total, piece) => total + Math.round(piece.seconds * sampleRate), 0);
  const data = Buffer.alloc(sampleCount * 2);
  let written = 0;
  for (const piece of pieces) {
    const samples = Math.round(piece.seconds * sampleRate);
    for (let index = 0; index < samples; index += 1) {
      const value = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * piece.amplitude * 0x7fff;
      data.writeInt16LE(Math.round(value), (written + index) * 2);
    }
    written += samples;
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  const fixturePath = path.join(os.tmpdir(), `voice-realtime-unanswered-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(fixturePath, Buffer.concat([header, data]));
  return fixturePath;
}

// ---------------------------------------------------------------------------------------------
// The fake Realtime upstream — the sibling spec's dialect, plus the stall this file drives.
// ---------------------------------------------------------------------------------------------

type FakeUpstream = {
  setBoundSessionId(id: string): void;
  audioFrameCount(): number;
  close(): Promise<void>;
};

function startFakeUpstream(port: number): Promise<FakeUpstream> {
  const server = new WebSocketServer({ port, host: '127.0.0.1' });
  let boundSessionId = '';
  let calls = 0;
  let audioFrames = 0;

  server.on('connection', (socket) => {
    let callSent = false;

    socket.on('message', (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }

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
        const call = calls;
        calls += 1;

        // THE STALL: the endpoint announces that it is HEARING speech (which is what arms the
        // bridge's stall clock — `awaitingTranscription`) and then says nothing for `stallSilenceMs`.
        // With the control's 0, the announcement is skipped and the answer below is immediate.
        if (stallSilenceMs > 0) {
          socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: `item_fake_${call}_0` }));
        }

        const answer = (): void => {
          const itemId = `item_fake_${call}_0`;
          socket.send(
            JSON.stringify({
              type: 'conversation.item.input_audio_transcription.delta',
              item_id: itemId,
              stash: HEARD_TEXT,
              text: '',
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'conversation.item.input_audio_transcription.completed',
              item_id: itemId,
              transcript: HEARD_TEXT,
            }),
          );
          const relayed = stallSilenceMs > 0 ? STALL_DELIVERED : CONTROL_DELIVERED;
          socket.send(
            JSON.stringify({
              type: 'response.function_call_arguments.done',
              call_id: `call_fake_${call}`,
              name: 'session_send',
              arguments: JSON.stringify({ session: boundSessionId, message: relayed, waitSeconds: 0.5 }),
            }),
          );
        };

        if (stallSilenceMs > 0) {
          setTimeout(answer, stallSilenceMs);
        } else {
          answer();
        }
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
        audioFrameCount: () => audioFrames,
        close: () =>
          new Promise<void>((done) => {
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

const paneText = (page: Page): Promise<string> => page.locator(PANE).innerText();

/** How many times the page called `navigator.mediaDevices.getUserMedia`; `-1` when the seam is absent. */
function mediaCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const seam = (window as unknown as Record<string, unknown>).__voiceRealtimeGetUserMediaCalls;
    return typeof seam === 'function' ? (seam as () => number)() : -1;
  });
}

/** Reads back that the page is the one this file means to drive (native Web Audio, mic stub installed). */
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
  await page.getByTestId('live-voice-button').click();
  await expect(page.getByTestId('voice-realtime-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
  const phase = ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();
  expect(PHASE_STATES).toContain(phase);
}

// ---------------------------------------------------------------------------------------------
// The criterion.
// ---------------------------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test.describe('voice realtime unanswered turn', () => {
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

    fixturePath = writeFixtureWav();
    upstream = await startFakeUpstream(upstreamPort);

    const workspace = path.join(fixtureHome, 'voice-realtime-unanswered-workspace');
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
        (window as unknown as Record<string, unknown>).__voiceRealtimeSkipAutoStart = true;

        // The no-microphone guarantee, made countable: the stub REJECTS, so a run that entered the
        // microphone path fails on its own terms as well as moving the count.
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

  /**
   * The one reading both arms make about a spoken turn's destination, so the control and the arm
   * cannot drift apart: the utterance reaches the ordinary transcript as `deliveredText`, and the
   * unanswered notice — the seam the disposition lands on — is exactly where each arm says it is.
   * `deliveredText` is unique to each arm, so the poll cannot pass on a row left by the other.
   */
  async function assertTurnDestination(
    target: Page,
    deliveredText: string,
    expectation: 'unanswered-then-answered' | 'answered-at-once',
  ): Promise<void> {
    const notice = target.getByTestId('voice-realtime-unanswered');
    if (expectation === 'unanswered-then-answered') {
      // WHILE THE ENDPOINT IS SILENT: the turn has a destination on screen — and it is a STATUS, not
      // a failure. The session is still listening, so the person can simply say it again.
      await expect(notice).toBeVisible({ timeout: 20_000 });
      expect(
        ((await target.getByTestId('voice-realtime-phase').textContent()) ?? '').trim(),
        'an unanswered turn is not a failed session: the connection is still listening',
      ).toBe('listening');
    } else {
      // The control's own first reading: with an immediate answer there is no unanswered turn, so the
      // notice seam is empty as the frames are still arriving.
      expect(await notice.count(), 'an answered turn must never raise the unanswered notice').toBe(0);
    }
    // THE ANSWER, whenever it lands, still reaches the transcript: a stall is a slow endpoint, not a
    // lost turn.
    await expect.poll(() => paneText(target), { timeout: 25_000 }).toContain(deliveredText);
    // THE OUTCOME IS SPENT: a delivered turn closes it, so the notice is gone.
    await expect(notice, 'a delivered turn must clear the unanswered outcome').toHaveCount(0);
  }

  test('AC2: a turn the endpoint never answers ends on screen as an unanswered turn, then clears when the answer lands', async () => {
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page);

    stallSilenceMs = BRIDGE_STALL_DEADLINE_MS + STALL_MARGIN_MS;
    try {
      const framesBefore = await upstream.audioFrameCount();
      await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);
      await expect.poll(() => upstream.audioFrameCount() - framesBefore, { timeout: 25_000 }).toBeGreaterThan(0);
      await assertTurnDestination(page, STALL_DELIVERED, 'unanswered-then-answered');
      expect(await mediaCallCount(page), 'the arm never enters the microphone path').toBe(0);
    } finally {
      stallSilenceMs = 0;
      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
    }
  });

  test('AC3(i): with the endpoint answering at once the same reading holds with no unanswered turn', async () => {
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await enterLiveVoice(page);

    // `stallSilenceMs = 0` is the shipped dialect: the endpoint hears the audio and answers at once,
    // so no turn ever stalls. The criterion's own assertion must still hold here — the row lands and
    // the notice never appears — which is what makes the arm's positive reading evidence rather than
    // a shape every run produces.
    stallSilenceMs = 0;
    try {
      const framesBefore = await upstream.audioFrameCount();
      await page.setInputFiles('[data-testid="voice-realtime-upload-input"]', fixturePath);
      await expect.poll(() => upstream.audioFrameCount() - framesBefore, { timeout: 25_000 }).toBeGreaterThan(0);
      await assertTurnDestination(page, CONTROL_DELIVERED, 'answered-at-once');
    } finally {
      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
    }
  });
});
