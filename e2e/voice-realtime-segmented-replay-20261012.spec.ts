/**
 * A deterministic replay of a REAL Live Voice segmented-mode session — 2026-10-12 07:47:30–07:48:26Z,
 * journal `~/.cloudcli/voice-realtime-log/ef9daacd-9950-414a-acfc-aace142bf273.jsonl` — against the
 * CURRENT code, with the expected behaviour written as assertions.
 *
 * WHAT WAS SPOKEN. S1「这是一轮新的 Live Voice Mode 测试」 S2「现在是第二句话」 S3「第三句话」
 * S4「第四句话」 S5「上面我们看见丢了一句话」. The browser committed six segments (seq0..seq5); the
 * endpoint's answer to each commit is replayed frame-for-frame from the journal:
 *
 *   seq0  committed(A) · item(A) · transcript(A,S1) · response · session_send(S1) → delivered; "OK" follow-up
 *         (then the status injection's `session.update` — which carries the deployment's server_vad)
 *   seq1  ERROR "buffer too small" · response "OK" (MODEL_TEXT_REPLY) · speech_started · item(B)
 *   seq2  committed · speech_started · transcript(B,S2) — late: B was created before seq2's commit
 *   seq3  committed · item(C) · speech_started — then silence past the 8 s stall → turn_unanswered
 *         branch A: C is never transcribed; branch B: transcript(C,S3) arrives after S4's
 *   seq4  committed · item(D) · speech_started · transcript(D,S4)
 *   seq5  committed · item(E) · transcript(E,S5) · response · session_send(S5) → delivered
 *   Exit  → composer
 *
 * A third replay (variant V) isolates the proxy's segment attribution: an EMPTY transcript for an
 * earlier item (C) arrives while the NEXT segment is active and before that segment's relay.
 *
 * THE RULING THE ASSERTIONS ENCODE. The realtime model is allowed to not relay some inputs — no
 * auto-relay is expected, and a late transcript is not a defect by itself. Expected: captions keyed by
 * upstream itemId and kept at their spoken position; unrelayed transcripts stay `heard`, never shown as
 * delivering/sent; only S1 and S5 reach Claude; Exit back-fills the composer with exactly the unrelayed
 * transcripts in spoken order; a segment with no transcript is visibly marked; no red error UI for the
 * recoverable UPSTREAM_ERROR / MODEL_TEXT_REPLY; every `session.update` after segments started keeps
 * `turn_detection: null` (manual mode).
 *
 * WHY ONE REPLAY PER BRANCH, CACHED. Each replay crosses the 8 s stall and two 2.5 s coalescing
 * windows, so it runs ONCE in `beforeAll` and the legs read its recording. Playwright discards the
 * worker after a red test and re-runs `beforeAll` for the rest; the recording is cached in this run's
 * own throwaway data dir, so a restarted worker reads it instead of replaying again. Legs that are RED
 * on the current code are separate tests so each red is individually visible.
 *
 * WHAT IS REAL. The browser, the app server, `/voice-realtime`, the bridge, the transport, the
 * executor and the debug-agent provider standing in for Claude. Not real: the microphone (the shaped-
 * PCM fake from `voice-realtime-live-session-send.spec.ts`) and the endpoint (the shared scripted
 * upstream on `QUAY_E2E_VOICE_REALTIME_PORT`; `DASHSCOPE_API_KEY` is blanked by the config AND the
 * server runs from a root with no `.env` — see the config's `envFreeServerRoot` — so the blank
 * survives `server/load-env.ts`'s backfill and the run makes zero cloud calls). Account: the shared
 * `voice-realtime-e2e` fixture account — the server is single-seat, and a
 * private account would 403 every sibling voice spec in a shared selection.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  audioCommitted,
  captionCompleted,
  endpointError,
  functionCall,
  modelTextReply,
  responseCreated,
  responseDone,
  speechStarted,
  startScriptedUpstream,
  userItemCreated,
  type ScriptedEndpointEvent,
  type ScriptedUpstreamServer,
} from './voiceRealtimeScriptedUpstream';

const PANE = '.chat-messages-pane';
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
const BAR = '[data-testid="voice-realtime-bar"]';

const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';

// The words, exactly as the 2026-10-12 journal recorded them (the ASR's own spelling of S1 differs
// from the model's relay of it — "Mod" vs "mode" — which is kept: it is what the real session had).
const S1_HEARD = '这是一轮新的Live Voice Mod 测试。';
const S1_RELAYED = '这是一轮新的 live voice mode 测试。';
const S2 = '现在是第二句话。';
const S3 = '第三句话。';
const S4 = '第四句话。';
const S5 = '上面我们看见丢了一句话。';

/** One spoken sentence of the fake microphone, in seconds of voiced body. */
const SPEECH_SECONDS = 1.0;

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const scenario = (title: string) => ({
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title, userText: `seeded turn for ${title}` },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [`seeded turn for ${title}`] } },
});

// ---------------------------------------------------------------------------------------------
// The recording each leg reads.
// ---------------------------------------------------------------------------------------------

type Row = { style: string | null; testid: string | null; text: string };
type Snapshot = {
  rows: Row[];
  closeTrace: { count: string | null; text: string } | null;
  errorVisible: boolean;
  bodyText: string;
};
type BrowserFrame = Record<string, unknown> & { type?: string };
type BranchRecording = {
  sessionId: string;
  commits: number;
  dialed: number;
  /** The `Host` of every upgrade the stand-in received, in dial order — where the dial actually went. */
  dialHosts: string[];
  authorizationHeaderSeen: boolean;
  browserFrames: BrowserFrame[];
  upstreamClientFrames: Array<Record<string, unknown>>;
  consoleWarnings: string[];
  errorEverVisible: boolean;
  snapshots: Record<string, Snapshot>;
  draft: string;
  journal: string[];
};
type Recording = { A: BranchRecording; B: BranchRecording; V: BranchRecording };

// ---------------------------------------------------------------------------------------------
// Page helpers (the sibling voice specs' shapes).
// ---------------------------------------------------------------------------------------------

const projectRow = (page: Page, workspaceName: string) =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();
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

async function armScenario(api: APIRequestContext, projectPath: string, doc: unknown): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario: doc } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  return sessionId;
}

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane');
    const rows = [...(pane?.querySelectorAll('[data-message-style]') ?? [])].map((el) => ({
      style: el.getAttribute('data-message-style'),
      testid: el.getAttribute('data-testid'),
      text: ((el.querySelector('div[dir="auto"]')?.textContent ?? el.textContent) || '').trim(),
    }));
    const trace = document.querySelector('[data-testid="voice-closed-unshown-utterance"]');
    return {
      rows,
      closeTrace: trace ? { count: trace.getAttribute('data-voice-closed-unshown'), text: (trace.textContent ?? '').trim() } : null,
      errorVisible: document.querySelector('[data-testid="voice-realtime-error"]') !== null,
      bodyText: document.body.innerText.slice(0, 6_000),
    };
  });
}

/** The shaped-PCM fake microphone, copied from `voice-realtime-live-session-send.spec.ts` (same graph members). */
function installFakeMicrophone(): void {
  const buildSpeechBurst = (seconds: number): Float32Array => {
    const rate = 16_000;
    const lead = Math.round(0.6 * rate);
    const body = Math.round(Math.max(0.2, seconds) * rate);
    const tail = Math.round(2.2 * rate);
    const samples = new Float32Array(lead + body + tail);
    for (let i = 0; i < lead; i += 1) samples[i] = 0.02 * Math.sin((2 * Math.PI * 220 * i) / rate);
    for (let i = 0; i < body; i += 1) {
      const envelope = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / rate);
      samples[lead + i] = 0.5 * envelope * Math.sin((2 * Math.PI * 180 * i) / rate);
    }
    return samples;
  };
  type Port = { port: { onmessage: ((m: unknown) => void) | null } };
  const state: { node: Port | null; atSample: number; speak: (seconds: number) => void } = {
    node: null,
    atSample: 0,
    speak(seconds: number) {
      const node = state.node;
      if (!node) throw new Error('the fake capture was not connected yet');
      const samples = buildSpeechBurst(seconds);
      node.port.onmessage?.({ data: { type: 'pcm', samples, atSample: state.atSample } });
      state.atSample += samples.length;
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
      /* inert */
    }
  }
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

  // "No red error UI" is a reading over the WHOLE replay, not a sample: latch any appearance.
  (window as unknown as { __voiceErrorSeen: boolean }).__voiceErrorSeen = false;
  new MutationObserver(() => {
    if (document.querySelector('[data-testid="voice-realtime-error"]')) {
      (window as unknown as { __voiceErrorSeen: boolean }).__voiceErrorSeen = true;
    }
  }).observe(document, { childList: true, subtree: true });
}

// ---------------------------------------------------------------------------------------------
// The replay driver.
// ---------------------------------------------------------------------------------------------

type Ctx = {
  page: Page;
  upstream: ScriptedUpstreamServer;
  frames: BrowserFrame[];
  warnings: string[];
};

/** Speaks one sentence and waits until its commit reached the upstream. */
async function utter(ctx: Ctx): Promise<void> {
  const before = ctx.upstream.commitCount();
  await ctx.page.evaluate((s: number) => {
    (window as unknown as { __voiceFake: { speak(seconds: number): void } }).__voiceFake.speak(s);
  }, SPEECH_SECONDS);
  await expect.poll(() => ctx.upstream.commitCount(), { timeout: 15_000 }).toBe(before + 1);
}

const framesOf = (ctx: Ctx, type: string, from = 0): BrowserFrame[] =>
  ctx.frames.slice(from).filter((frame) => frame.type === type);

async function waitFrame(ctx: Ctx, type: string, from: number, timeout = 15_000): Promise<void> {
  await expect.poll(() => framesOf(ctx, type, from).length, { timeout }).toBeGreaterThanOrEqual(1);
}

/** Real (non-caption) user rows carrying `text`. */
const realRowWith = (snap: Snapshot, text: string): Row[] =>
  snap.rows.filter((row) => row.style === 'user' && row.testid === null && normalize(row.text).includes(normalize(text)));

async function waitRealRow(ctx: Ctx, text: string): Promise<void> {
  await expect.poll(async () => realRowWith(await snapshot(ctx.page), text).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
}

/**
 * Replays one branch of the recorded session on a fresh session and returns its recording.
 * `branch`: 'A' (C never transcribed), 'B' (C's transcript arrives after S4's), 'V' (attribution variant).
 */
async function replay(
  ctx: Ctx,
  branch: 'A' | 'B' | 'V',
  sessionId: string,
  journalDir: string | null,
): Promise<BranchRecording> {
  const { page, upstream } = ctx;
  const framesFrom = ctx.frames.length;
  const clientFramesFrom = upstream.clientFrames().length;
  const warningsFrom = ctx.warnings.length;
  const commitsFrom = upstream.commitCount();
  const snapshots: Record<string, Snapshot> = {};

  // The model's remark on a tool result ("OK" in the journal): answered after the synthesized
  // tool-resume `response.create`, as a follow-up response — exactly the journal's order.
  let resumePending = false;
  let followUps = 0;
  const unsubscribe = upstream.onClientFrame((frame) => {
    const item = frame.item as Record<string, unknown> | undefined;
    if (frame.type === 'conversation.item.create' && item?.type === 'function_call_output') {
      resumePending = true;
      return;
    }
    if (frame.type === 'response.create' && resumePending) {
      resumePending = false;
      followUps += 1;
      const id = `resp_${branch}_follow_${followUps}`;
      void upstream.script([
        { wire: responseCreated(id), afterMs: 120 },
        { wire: modelTextReply('OK', id), afterMs: 20 },
        { wire: responseDone(id), afterMs: 5 },
      ]);
    }
  });

  await page.goto(`/session/${sessionId}`);
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('live-voice-button').click();
  await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => phase(page), { timeout: 25_000 }).toBe('listening');
  // Segmented mode is the premise of the whole replay: the server must have declared it.
  await expect
    .poll(() => framesOf(ctx, 'ready', framesFrom).some((frame) => frame.protocol === 'segmented-v1'), { timeout: 15_000 })
    .toBe(true);

  const p = branch;
  if (branch === 'V') {
    // seq0: the endpoint takes the audio as item C and never transcribes it (yet).
    await utter(ctx);
    await upstream.script([
      { wire: audioCommitted(`${p}_C`), afterMs: 120 },
      { wire: userItemCreated(`${p}_C`, null), afterMs: 1 },
      { wire: speechStarted(), afterMs: 90 },
    ]);
    await page.waitForTimeout(800);
    // seq1: item E, its words, then C's EMPTY transcript arriving late — while seq1 is the active
    // segment and before seq1's relay — then the relay of S5.
    await utter(ctx);
    const sentFrom = ctx.frames.length;
    await upstream.script([
      { wire: audioCommitted(`${p}_E`, `${p}_C`), afterMs: 116 },
      { wire: userItemCreated(`${p}_E`, `${p}_C`), afterMs: 1 },
      { wire: captionCompleted(`${p}_E`, S5), afterMs: 186 },
      { wire: captionCompleted(`${p}_C`, ''), afterMs: 40 },
      { wire: responseCreated(`resp_${p}_5`), afterMs: 80 },
      { wire: functionCall('session_send', { message: S5 }, `call_${p}_5`), afterMs: 160 },
    ]);
    // Give the relay its full 2.5 s coalescing window and more, so an absent `sent` is a reading.
    await page.waitForTimeout(5_000);
    if (framesOf(ctx, 'sent', sentFrom).length > 0) {
      await waitRealRow(ctx, S5).catch(() => undefined);
    }
    snapshots.beforeExit = await snapshot(page);
  } else {
    // ---- seq0: S1, relayed and delivered after the coalescing window ----
    await utter(ctx);
    const s1From = ctx.frames.length;
    await upstream.script([
      { wire: audioCommitted(`${p}_A`), afterMs: 340 },
      { wire: userItemCreated(`${p}_A`, null), afterMs: 1 },
      { wire: responseCreated(`resp_${p}_0`), afterMs: 280 },
      { wire: captionCompleted(`${p}_A`, S1_HEARD), afterMs: 128 },
      { wire: functionCall('session_send', { message: S1_RELAYED }, `call_${p}_0`), afterMs: 11 },
    ]);
    await waitFrame(ctx, 'sent', s1From);
    await waitRealRow(ctx, S1_RELAYED);
    // The journal's status injections (07:47:39 / 07:47:41) follow the delivery on a 2 s cadence.
    await page.waitForTimeout(2_500);
    snapshots.afterS1 = await snapshot(page);

    // ---- seq1: the commit is refused, the model answers "OK", the endpoint's VAD takes the audio as B ----
    await utter(ctx);
    await upstream.script([
      {
        wire: endpointError('invalid_request_error', 'Error committing input audio buffer: buffer too small, or have no audio.'),
        afterMs: 150,
      },
      { wire: responseCreated(`resp_${p}_1`), afterMs: 240 },
      { wire: modelTextReply('OK', `resp_${p}_1`), afterMs: 21 },
      { wire: responseDone(`resp_${p}_1`), afterMs: 1 },
      { wire: speechStarted(), afterMs: 75 },
      { wire: userItemCreated(`${p}_B`, `${p}_A_reply`), afterMs: 135 },
    ]);
    await page.waitForTimeout(600);

    // ---- seq2: committed, then B's transcript (S2) arrives late; no response ----
    await utter(ctx);
    await upstream.script([
      { wire: audioCommitted(`${p}_seq2`, `${p}_B`), afterMs: 123 },
      { wire: speechStarted(), afterMs: 86 },
      { wire: captionCompleted(`${p}_B`, S2), afterMs: 86 },
    ]);
    await page.waitForTimeout(600);
    snapshots.afterS2 = await snapshot(page);

    // ---- seq3: committed + item C, speech_started, then silence past the bridge's 8 s stall ----
    await utter(ctx);
    const stallFrom = ctx.frames.length;
    await upstream.script([
      { wire: audioCommitted(`${p}_C`, `${p}_B`), afterMs: 124 },
      { wire: userItemCreated(`${p}_C`, `${p}_B`), afterMs: 1 },
      { wire: speechStarted(), afterMs: 90 },
    ]);
    await waitFrame(ctx, 'turn_unanswered', stallFrom, 20_000);
    await page.waitForTimeout(500);
    snapshots.afterStall = await snapshot(page);

    // ---- seq4: committed + item D, its transcript (S4); no response ----
    await utter(ctx);
    const seq4: ScriptedEndpointEvent[] = [
      { wire: audioCommitted(`${p}_D`, `${p}_C`), afterMs: 142 },
      { wire: userItemCreated(`${p}_D`, `${p}_C`), afterMs: 1 },
      { wire: speechStarted(), afterMs: 136 },
      { wire: captionCompleted(`${p}_D`, S4), afterMs: 29 },
    ];
    if (branch === 'B') {
      // Branch B: C's transcript (S3) finally arrives — after seq4's commit and after D's transcript.
      seq4.push({ wire: captionCompleted(`${p}_C`, S3), afterMs: 180 });
    }
    await upstream.script(seq4);
    await page.waitForTimeout(800);
    snapshots.afterS4 = await snapshot(page);

    // ---- seq5: item E, its transcript (S5), the relay of S5 only ----
    await utter(ctx);
    const s5From = ctx.frames.length;
    await upstream.script([
      { wire: audioCommitted(`${p}_E`, `${p}_D`), afterMs: 116 },
      { wire: userItemCreated(`${p}_E`, `${p}_D`), afterMs: 1 },
      { wire: captionCompleted(`${p}_E`, S5), afterMs: 186 },
      { wire: responseCreated(`resp_${p}_5`), afterMs: 119 },
      { wire: functionCall('session_send', { message: S5 }, `call_${p}_5`), afterMs: 162 },
    ]);
    // Inside the proxy's coalescing window: the `queued` frame is the server's own "in flight".
    await waitFrame(ctx, 'queued', s5From);
    await page.waitForTimeout(300);
    snapshots.queuedS5 = await snapshot(page);
    await waitFrame(ctx, 'sent', s5From);
    await page.waitForTimeout(150);
    snapshots.sentS5 = await snapshot(page);
    await waitRealRow(ctx, S5);
    await page.waitForTimeout(2_500);
    snapshots.beforeExit = await snapshot(page);
  }

  // ---- the user clicks Exit ----
  await page.getByTestId('voice-realtime-end').click();
  await expect(page.locator(BAR)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
  const draft = await page.locator(COMPOSER_TEXTAREA).inputValue();
  await page.waitForTimeout(800);
  snapshots.afterExit = await snapshot(page);
  const errorEverVisible = await page.evaluate(() => (window as unknown as { __voiceErrorSeen: boolean }).__voiceErrorSeen);
  // Clear the draft so the next branch starts from an empty composer.
  await page.locator(COMPOSER_TEXTAREA).fill('');
  unsubscribe();

  const journal: string[] = [];
  if (journalDir !== null && existsSync(journalDir)) {
    for (const file of readdirSync(journalDir).filter((name) => name.endsWith('.jsonl'))) {
      const lines = readFileSync(path.join(journalDir, file), 'utf8').split('\n').filter(Boolean);
      if (lines.some((line) => line.includes(sessionId))) journal.push(...lines);
    }
  }

  const headers = upstream.upgradeHeaders();
  return {
    sessionId,
    commits: upstream.commitCount() - commitsFrom,
    dialed: upstream.dialed(),
    dialHosts: headers.map((h) => String(h.host ?? '')),
    authorizationHeaderSeen: headers.some((h) => Object.keys(h).some((key) => key.toLowerCase() === 'authorization')),
    browserFrames: ctx.frames.slice(framesFrom),
    upstreamClientFrames: upstream.clientFrames().slice(clientFramesFrom),
    consoleWarnings: ctx.warnings.slice(warningsFrom),
    errorEverVisible,
    snapshots,
    draft,
    journal,
  };
}

// ---------------------------------------------------------------------------------------------
// Readings shared by the legs.
// ---------------------------------------------------------------------------------------------

const sentMessages = (rec: BranchRecording): string[] =>
  rec.browserFrames.filter((frame) => frame.type === 'sent').map((frame) => String(frame.message ?? ''));

/** Index of the first row carrying `text` (real or caption), or -1. */
const rowIndexOf = (snap: Snapshot, text: string): number =>
  snap.rows.findIndex((row) => row.style === 'user' && normalize(row.text).includes(normalize(text)));

/** The `session.update` frames sent upstream after the connection began segmenting. */
function sessionUpdatesAfterSegmentsStarted(rec: BranchRecording): Array<Record<string, unknown>> {
  const frames = rec.upstreamClientFrames;
  const firstSegmentFrame = frames.findIndex(
    (frame) => frame.type === 'input_audio_buffer.append' || frame.type === 'input_audio_buffer.commit',
  );
  // The VAD-off switch goes out on the first `segment_start`, i.e. just BEFORE the first audio frame.
  const vadOff = frames.findIndex(
    (frame) =>
      frame.type === 'session.update' &&
      (frame.session as Record<string, unknown> | undefined)?.turn_detection === null,
  );
  const start = vadOff === -1 ? firstSegmentFrame : Math.min(vadOff, firstSegmentFrame === -1 ? vadOff : firstSegmentFrame);
  return frames.slice(Math.max(0, start)).filter((frame) => frame.type === 'session.update');
}

// ---------------------------------------------------------------------------------------------

test.describe('voice realtime segmented replay of the 2026-10-12 session', () => {
  let recording: Recording;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }
    // This run's own throwaway data dir (the fixture home lives directly under it), so the cache
    // can never be read by a different run.
    const dataDir = path.dirname(fixtureHome);
    const cacheFile = path.join(dataDir, 'segmented-replay-20261012.recording.json');
    if (existsSync(cacheFile)) {
      recording = JSON.parse(readFileSync(cacheFile, 'utf8')) as Recording;
      return;
    }
    const journalDir = path.join(dataDir, 'voice-realtime-log');

    const upstream = await startScriptedUpstream(upstreamPort);
    const workspacePath = path.join(fixtureHome, 'voice-realtime-workspace');
    const workspaceName = path.basename(workspacePath);
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    const api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    const sessionA = await armScenario(api, workspacePath, scenario('Voice replay 20261012 branch A'));
    const sessionB = await armScenario(api, workspacePath, scenario('Voice replay 20261012 branch B'));
    const sessionV = await armScenario(api, workspacePath, scenario('Voice replay 20261012 variant V'));

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    await context.addInitScript(
      ({ authToken }: { authToken: string }) => {
        window.localStorage.setItem('auth-token', authToken);
        window.localStorage.setItem('userLanguage', 'en');
        const preferences = { voiceEnabled: true };
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }));
      },
      { authToken: token },
    );
    await context.addInitScript(installFakeMicrophone);
    const page = await context.newPage();
    const frames: BrowserFrame[] = [];
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text());
    });
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/voice-realtime')) return;
      ws.on('framereceived', (frame) => {
        try {
          const payload = frame.payload;
          const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
          const parsed = JSON.parse(text) as BrowserFrame;
          frames.push({ ...parsed, __at: Date.now() });
        } catch {
          /* binary or non-JSON: not a protocol frame this recording reads */
        }
      });
    });
    await page.route('**/api/voice/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
    );
    await page.goto('/');
    if (!(await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 25_000 }).then(() => true, () => false))) {
      await page.reload();
    }
    await revealSession(page, workspaceName, sessionA);

    const ctx: Ctx = { page, upstream, frames, warnings };
    try {
      const A = await replay(ctx, 'A', sessionA, journalDir);
      const B = await replay(ctx, 'B', sessionB, journalDir);
      const V = await replay(ctx, 'V', sessionV, journalDir);
      recording = { A, B, V };
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(recording, null, 2));
      if (process.env.QUAY_REPLAY_DUMP) writeFileSync(process.env.QUAY_REPLAY_DUMP, JSON.stringify(recording, null, 2));
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await api.dispose();
      await upstream.close();
    }
  });

  // ------------------------------- characterization (green) -------------------------------

  test('the replay ran segmented, on the local scripted upstream, with no cloud credential', () => {
    // WHERE THE DIAL WENT is the `.env`-independent half of "no cloud call". The blank credential
    // rides on the config's `envFreeServerRoot` (a server root with no `.env`, so `load-env.ts`
    // cannot backfill the key); the dial target is a property of this run — the endpoint is the
    // loopback stand-in the spec itself bound. A dial that left it would not reach the stand-in at
    // all: its `Host` would differ, and no frame would ever come back.
    const standInHost = `127.0.0.1:${process.env.QUAY_E2E_VOICE_REALTIME_PORT}`;
    for (const key of ['A', 'B'] as const) {
      const rec = recording[key];
      expect(rec.commits, `branch ${key}: six segments must have been committed`).toBe(6);
      expect(rec.browserFrames.some((f) => f.type === 'ready' && f.protocol === 'segmented-v1'), `branch ${key}: ready{segmented-v1}`).toBe(true);
      expect(rec.dialHosts.length, `branch ${key}: the app never dialled the stand-in`).toBeGreaterThanOrEqual(1);
      expect(rec.dialHosts.filter((host) => host !== standInHost), `branch ${key}: dials that left ${standInHost}`).toEqual([]);
      expect(rec.authorizationHeaderSeen, `branch ${key}: the upstream dial carried a credential`).toBe(false);
      expect(framesOfType(rec, 'turn_unanswered').length, `branch ${key}: the seq3 stall must surface`).toBeGreaterThanOrEqual(1);
    }
    expect(recording.V.commits).toBe(2);
  });

  test('only S1 and S5 reach Claude, in both branches', () => {
    for (const key of ['A', 'B'] as const) {
      const rec = recording[key];
      expect(sentMessages(rec), `branch ${key}: sent frames`).toEqual([S1_RELAYED, S5]);
      const finalSnap = rec.snapshots.beforeExit!;
      expect(realRowWith(finalSnap, S1_RELAYED).length, `branch ${key}: S1 row`).toBeGreaterThanOrEqual(1);
      expect(realRowWith(finalSnap, S5).length, `branch ${key}: S5 row`).toBeGreaterThanOrEqual(1);
      for (const unrelayed of [S2, S3, S4]) {
        expect(realRowWith(finalSnap, unrelayed), `branch ${key}: "${unrelayed}" must not have reached Claude`).toEqual([]);
      }
    }
  });

  test('no red error UI for the recoverable UPSTREAM_ERROR and MODEL_TEXT_REPLY; both reach the console', () => {
    for (const key of ['A', 'B'] as const) {
      const rec = recording[key];
      expect(rec.errorEverVisible, `branch ${key}: voice-realtime-error appeared during the replay`).toBe(false);
      const codes = rec.browserFrames.filter((f) => f.type === 'error').map((f) => `${f.code}:${f.recoverable}`);
      expect(codes, `branch ${key}: error frames`).toEqual(
        expect.arrayContaining(['UPSTREAM_ERROR:true', 'MODEL_TEXT_REPLY:true']),
      );
      expect(rec.consoleWarnings.some((line) => line.includes('UPSTREAM_ERROR'))).toBe(true);
      expect(rec.consoleWarnings.some((line) => line.includes('MODEL_TEXT_REPLY'))).toBe(true);
    }
  });

  test('captions reach the browser keyed by the upstream itemId', () => {
    const captions = (rec: BranchRecording) =>
      rec.browserFrames.filter((f) => f.type === 'caption' && f.final === true).map((f) => `${f.itemId}=${f.text}`);
    expect(captions(recording.A)).toEqual([`A_A=${S1_HEARD}`, `A_B=${S2}`, `A_D=${S4}`, `A_E=${S5}`]);
    expect(captions(recording.B)).toEqual([`B_A=${S1_HEARD}`, `B_B=${S2}`, `B_D=${S4}`, `B_C=${S3}`, `B_E=${S5}`]);
  });

  test('branch A: Exit back-fills the composer with exactly the unrelayed transcripts, in spoken order', () => {
    const draft = recording.A.draft;
    expect(normalize(draft), `draft was ${JSON.stringify(draft)}`).toBe(normalize(S2 + S4));
  });

  // ------------------------------- expected behaviour (red legs) -------------------------------

  // RED on the current code. Fix task: gap-live-voice-manual-mode-session-update-keeps-vad-off.
  // Verbatim first failing line (current develop):
  //   Error: a session.update after segments started re-enabled the endpoint's detector: [{"tools":0,"turn_detection":null},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}}]
  test.fail('(a) every session.update after segments started keeps turn_detection null (manual mode)', () => {
    const updates = sessionUpdatesAfterSegmentsStarted(recording.A);
    const summary = updates.map((frame) => {
      const session = (frame.session ?? {}) as Record<string, unknown>;
      return { tools: Array.isArray(session.tools) ? session.tools.length : 0, turn_detection: session.turn_detection };
    });
    // Non-vacuity: the status injection (tools re-advertised) really went out after segments started.
    expect(summary.filter((entry) => entry.tools > 0).length, `session.update frames: ${JSON.stringify(summary)}`).toBeGreaterThanOrEqual(1);
    expect(
      summary.filter((entry) => entry.turn_detection !== null),
      `a session.update after segments started re-enabled the endpoint's detector: ${JSON.stringify(summary)}`,
    ).toEqual([]);
  });

  // RED on the current code. Fix task: gap-live-voice-segment-honest-heard-unrecognized-state.
  // Verbatim first failing line (current develop):
  //   Error: branch A @queuedS5: rows [{"style":"user","testid":null,"text":"seeded turn for Voice replay 20261012 branch A"},{"style":"user","testid":null,"text":"这是一轮新的 live voice mode 测试。"},{"style":"user","testid":"voice-row-delivering","text":"现在是第二句话。第四句话。上面我们看见丢了一句话。"}]
  test.fail('unrelayed transcripts are never shown as delivering while S5 is in flight', () => {
    for (const key of ['A', 'B'] as const) {
      for (const moment of ['queuedS5', 'sentS5'] as const) {
        const snap = recording[key].snapshots[moment]!;
        const wrong = snap.rows.filter(
          (row) => row.testid === 'voice-row-delivering' && [S2, S3, S4].some((text) => normalize(row.text).includes(normalize(text))),
        );
        expect(wrong, `branch ${key} @${moment}: rows ${JSON.stringify(snap.rows)}`).toEqual([]);
      }
    }
  });

  // RED on the current code. Fix task: gap-live-voice-segment-honest-heard-unrecognized-state.
  // Verbatim first failing line (current develop):
  //   Error: row indices of S1,S2,S4,S5 in [{"style":"user","testid":null,"text":"seeded turn for Voice replay 20261012 branch A"},{"style":"user","testid":null,"text":"这是一轮新的 live voice mode 测试。"},{"style":"user","testid":null,"text":"上面我们看见丢了一句话。"},{"style":"user","testid":"voice-row-heard","text":"现在是第二句话。第四句话。"}]
  test.fail('unrelayed transcripts stay visibly heard after S5 is delivered, each at its spoken position', () => {
    const snap = recording.A.snapshots.beforeExit!;
    const rows = JSON.stringify(snap.rows);
    for (const text of [S2, S4]) {
      const index = rowIndexOf(snap, text);
      expect(index, `"${text}" is not on screen: ${rows}`).toBeGreaterThanOrEqual(0);
      expect(snap.rows[index]!.testid, `"${text}" row state: ${rows}`).toBe('voice-row-heard');
    }
    // Spoken order: S1 < S2 < S4 < S5.
    const order = [S1_RELAYED, S2, S4, S5].map((text) => rowIndexOf(snap, text));
    expect(order, `row indices of S1,S2,S4,S5 in ${rows}`).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size, `S2 and S4 must each have their own row: ${rows}`).toBe(4);
  });

  // RED on the current code. Fix task: gap-live-voice-segment-honest-heard-unrecognized-state.
  // Verbatim first failing line (current develop):
  //   Error: no "not recognized" indication for segment C on the page
  test.fail('(c) branch A: the segment C that never got a transcript is visibly marked before Exit', () => {
    const snap = recording.A.snapshots.beforeExit!;
    const marker = /not recogni[sz]ed|unrecogni[sz]ed|no words|未识别|没有识别|没听清/i;
    expect(snap.bodyText, 'no "not recognized" indication for segment C on the page').toMatch(marker);
  });

  // RED on the current code. Fix task: gap-live-voice-segment-honest-heard-unrecognized-state.
  // Verbatim first failing line (current develop):
  //   Error: after Exit the transcript ends with rows [{"style":"user","testid":null,"text":"seeded turn for Voice replay 20261012 branch A"},{"style":"user","testid":null,"text":"这是一轮新的 live voice mode 测试。"},{"style":"user","testid":null,"text":"上面我们看见丢了一句话。"}]
  test.fail('(c) branch A: leaving with an unrecognized segment leaves an exit trace', () => {
    const snap = recording.A.snapshots.afterExit!;
    expect(snap.closeTrace, `after Exit the transcript ends with rows ${JSON.stringify(snap.rows.slice(-4))}`).not.toBeNull();
  });

  // RED on the current code. Fix task: gap-live-voice-segment-honest-heard-unrecognized-state.
  // Verbatim first failing line (current develop):
  //   Error: draft was "现在是第二句话。第四句话。第三句话。"
  test.fail('(d) branch B: Exit back-fills S2, S3, S4 in SPOKEN order, not arrival order', () => {
    const draft = recording.B.draft;
    expect(normalize(draft), `draft was ${JSON.stringify(draft)}`).toBe(normalize(S2 + S3 + S4));
  });

  // RED on the current code. Fix task: gap-live-voice-segment-honest-heard-unrecognized-state.
  // Verbatim first failing line (current develop):
  //   Error: S3 after S4 inside "现在是第二句话。第四句话。第三句话。"
  test.fail('(d) branch B: the late S3 transcript sits at its spoken position (before S4) on screen', () => {
    const snap = recording.B.snapshots.afterS4!;
    const rows = JSON.stringify(snap.rows);
    const s3 = rowIndexOf(snap, S3);
    const s4 = rowIndexOf(snap, S4);
    expect(s3, `S3 not on screen: ${rows}`).toBeGreaterThanOrEqual(0);
    // On one folded row the reading is the text order within the row.
    if (s3 === s4) {
      const text = normalize(snap.rows[s3]!.text);
      expect(text.indexOf(normalize(S3)), `S3 after S4 inside ${JSON.stringify(snap.rows[s3]!.text)}`).toBeLessThan(
        text.indexOf(normalize(S4)),
      );
    } else {
      expect(s3, `S3 row after S4 row: ${rows}`).toBeLessThan(s4);
    }
  });

  // RED on the current code. Fix task: gap-live-voice-caption-segment-attribution-by-item-id.
  // Verbatim first failing line (current develop; the `at=` wall-clock stamps vary per run):
  //   Error: journal:  | hello: declaring segmented-v1 | segment seq=0 dur=1300ms reason=gap frames=1 at=<ts> | to-browser segment_ack | segment seq=1 dur=1900ms reason=gap frames=1 at=<ts> | to-browser segment_ack | segment 1 dropped: the endpoint reported no words for it | to-browser segment_ack | << function_call session_send {"message":"上面我们看见丢了一句话。"} | session_send not-delivered (empty-transcript)
  test.fail('(b) variant V: a late EMPTY transcript for item C does not refuse the active segment\'s S5 relay', () => {
    const rec = recording.V;
    expect(sentMessages(rec), `journal: ${rec.journal.filter((l) => /segment|not-delivered|session_send/.test(l)).map((l) => JSON.parse(l).line).join(' | ')}`).toEqual([S5]);
  });

  // RED on the current code. Fix task: gap-live-voice-caption-segment-attribution-by-item-id.
  // Verbatim first failing lines (current develop):
  //   Error: segment_ack frames
  //   Expected value: not "1:dropped:empty-transcript"
  //   Received array:     ["0:committed", "1:committed", "1:dropped:empty-transcript"]
  test.fail('(b) variant V: the segment that carried words is not acked dropped/empty-transcript', () => {
    const acks = recording.V.browserFrames.filter((f) => f.type === 'segment_ack').map((f) => `${f.seq}:${f.state}${f.reason ? `:${f.reason}` : ''}`);
    expect(acks, 'segment_ack frames').not.toContain('1:dropped:empty-transcript');
  });
});

function framesOfType(rec: BranchRecording, type: string): BrowserFrame[] {
  return rec.browserFrames.filter((frame) => frame.type === type);
}
