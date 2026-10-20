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
 * A FOURTH replay (variant R) scripts NOTHING: the shared endpoint's optional protocol state machine
 * answers the six commits, so every endpoint frame is a function of the detector the app's own
 * `session.update` frames leave in place. It is the leg that would red if the segmented path ever let
 * the deployment's `server_vad` back on — the mechanism behind the 2026-10-12 journal above.
 *
 * THE RULING THE ASSERTIONS ENCODE. The realtime model is allowed to not relay some inputs — no
 * auto-relay is expected, and a late transcript is not a defect by itself. Expected: captions keyed by
 * upstream itemId and kept at their spoken position; unrelayed transcripts stay `heard`, never shown as
 * delivering/sent; only S1 and S5 reach Claude; Exit back-fills the composer with exactly the unrelayed
 * transcripts in spoken order; no red error UI for the
 * recoverable UPSTREAM_ERROR / MODEL_TEXT_REPLY; every `session.update` after segments started keeps
 * `turn_detection: null` (manual mode).
 *
 * WHAT THE STRIP CHANGED HERE (gap-voice-ui-strip-to-caption-and-connection-state, 2026-10-14). The
 * conversation no longer draws any of the pane's own voice rows, so the two legs that read a segment
 * with no transcript as a LINE ON THE PAGE were flipped to read its absence — which is the stronger
 * statement, since they now fail if such a line comes back under any name. The count of unrelayed
 * segments is still taken (it is what Exit back-fills the composer with); it is simply not drawn.
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
  type ScriptedProtocolOptions,
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

/**
 * Variant R's endpoint: the protocol state machine, ARMED, with the answers to the six commits left
 * entirely to it — the spec scripts not one frame of this branch.
 *
 * `initialTurnDetection: 'server_vad'` is the deployment's OWN default, the detector a session has
 * before the app says otherwise. That is what makes this a reading of the PRODUCT rather than of the
 * spec's script: the 2026-10-12 journal's empty-buffer refusal, its `speech_started` and the item it
 * created itself all reappear here IF the app ever lets the deployment's detector back on — which is
 * exactly what the status injection did before `gap-live-voice-manual-mode-session-update-keeps-vad-off`
 * landed. Post-fix the segmented path's `turn_detection: null` holds, the machine stays manual, and
 * every commit is accepted.
 *
 * The item/words mapping mirrors the journal's: six commits, five spoken sentences, two of which the
 * model relays (`session_send`), the rest transcribed but never relayed.
 */
const R_PROTOCOL: ScriptedProtocolOptions = {
  initialTurnDetection: 'server_vad',
  commits: [
    {
      itemId: 'R_A',
      transcript: { kind: 'on-time', text: S1_HEARD },
      answer: { kind: 'function_call', name: 'session_send', args: { message: S1_RELAYED } },
    },
    { itemId: 'R_B', transcript: { kind: 'on-time', text: S2 } },
    { itemId: 'R_C', transcript: { kind: 'never' } },
    { itemId: 'R_D', transcript: { kind: 'on-time', text: S4 } },
    {
      itemId: 'R_E',
      transcript: { kind: 'on-time', text: S5 },
      answer: { kind: 'function_call', name: 'session_send', args: { message: S5 } },
    },
    { itemId: 'R_F', transcript: { kind: 'never' } },
  ],
  // The journal's follow-up: the model's own "OK" on the tool result. The MACHINE says it here — the
  // driver's follow-up listener stands down for this branch — so the endpoint's answers stay ONE
  // stream rather than two writers racing on the same `response.create`.
  toolResumeAnswer: { kind: 'text', text: 'OK' },
};

/**
 * The page's OWN chrome — the only non-loopback hosts the app fires at, declared as an allowlist (the same
 * shape the sibling `voice-realtime-scripted-scenarios.spec.ts` uses). `index.html` preconnects and loads
 * Google Fonts, and the sidebar's star badge / version check fetch `api.github.com`. None of them is the voice
 * path. The browser context below BLOCKS every non-loopback request (so nothing actually leaves the page) and
 * records it; the positive leg then asserts that nothing outside this set was ever attempted.
 */
const CHROME_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'api.github.com']);

/** Whether a request URL targets the loopback interface (the sibling spec's own shape). */
const isLoopbackUrl = (url: string): boolean => /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

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
  /** The bottom voice bar's transcript line, trimmed — the on-screen trace of a not-yet-delivered utterance. */
  barCaption: string;
  /**
   * How many of the pane's own VOICE-ONLY nodes are on screen — the rows and the closing-count line
   * this task removed (operator's ruling, 2026-10-14). Read by testid PREFIX rather than by name, so a
   * node of that kind coming back under any name fails the `toBe(0)` readings below instead of
   * slipping past a query written against the old names.
   */
  voiceOnlyNodes: number;
  /**
   * The `voice-closed-unshown-utterance` row the close trace used to draw — read straight off the
   * DOM, so the leg below is a real absence and not a missing query. REMOVED by human ruling
   * (`gap-voice-close-trace-row-removed-from-transcript`, 2026-10-14): it is `null` on every snapshot
   * now, which is exactly what `(c) branch A` asserts after Exit. Kept beside `voiceOnlyNodes` — the
   * prefix reading covers the family, this one names the row the ruling was about.
   */
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
type Recording = {
  A: BranchRecording;
  B: BranchRecording;
  V: BranchRecording;
  /** Variant R: the branch whose endpoint frames come from the protocol state machine, not a script. */
  R: BranchRecording;
  /** Every non-loopback request the page attempted during the replay, in order — all of them blocked. */
  browserEgress: string[];
};

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

/**
 * The page-side capture probe `pushFirstCaptureFrame` drives (installed by {@link installFakeMicrophone}).
 *
 * WHY THE FIRST FRAME IS NEEDED. Upstream `state: open` only takes the bar to `arming`; the bar says
 * `listening` when capture delivers its FIRST frame (`c99a0eaba`). The fake graph is inert — frames
 * only leave it via `__voiceFake.speak()` — so a replay that waits for `listening` BEFORE its first
 * utterance would poll `arming` until the wait timed out. This helper pushes that one frame; it is
 * silent (all zeros) so it advances the segmenter's `atSample` ledger without contributing speech.
 *
 * WHEN IT LANDS. Only after `start()` has WIRED the most recently constructed worklet
 * (`port.onmessage` is assigned after the asynchronous acquisition, and a frame pushed before that is
 * dropped), and only once per worklet — `constructed`/`pushed` make "one first frame per capture
 * session" a page-side fact, so a later branch's capture cannot be satisfied by an earlier one's.
 */
type CaptureProbe = {
  node: { port: { onmessage: ((m: unknown) => void) | null } } | null;
  atSample: number;
  constructed: number;
  pushed: number;
};

async function pushFirstCaptureFrame(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const capture = (window as unknown as { __voiceCaptureProbe?: CaptureProbe }).__voiceCaptureProbe;
          const node = capture?.node;
          if (!capture || !node || node.port.onmessage === null) return false;
          if (capture.pushed >= capture.constructed) return false;
          const samples = new Float32Array(3_200); // 200 ms of silence at 16 kHz
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

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane');
    const rows = [...(pane?.querySelectorAll('[data-message-style]') ?? [])].map((el) => ({
      style: el.getAttribute('data-message-style'),
      testid: el.getAttribute('data-testid'),
      text: ((el.querySelector('div[dir="auto"]')?.textContent ?? el.textContent) || '').trim(),
    }));
    // The bottom voice bar's transcript line — the one place a spoken utterance is shown before it
    // becomes the real message (this task removed the caption ROWS from the chat area, so the bar is
    // all that is left). Read here so a leg can wait on it without its own DOM query.
    const barCaption = document.querySelector('[data-testid="voice-realtime-caption"]');
    const voiceOnlyNodes = document.querySelectorAll(
      '[data-testid^="voice-row-"], [data-testid^="voice-closed-"]',
    ).length;
    // The close trace's own row, queried by name as well as by the prefix above: the named query is
    // what makes `(c) branch A`'s `toBeNull()` a real absence rather than a selector that never
    // matched. It is `null` on every snapshot now that the line is gone.
    const trace = document.querySelector('[data-testid="voice-closed-unshown-utterance"]');
    return {
      rows,
      barCaption: ((barCaption?.textContent) ?? '').trim(),
      voiceOnlyNodes,
      closeTrace: trace
        ? { count: trace.getAttribute('data-voice-closed-unshown'), text: (trace.textContent ?? '').trim() }
        : null,
      errorVisible: document.querySelector('[data-testid="voice-realtime-error"]') !== null,
      bodyText: document.body.innerText.slice(0, 6_000),
    };
  });
}

/**
 * The DoD's screenshot, taken at the two moments the closing reading is about (before Exit, and the
 * composer after it). Gated on `QUAY_LIVE_VOICE_SHOT_DIR` — the same switch the sibling voice specs
 * use — so an ordinary run of this file takes no pictures and pays no 700 ms settle; the DoD's own run
 * sets it and copies the PNGs into the task's Notes.
 */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.QUAY_LIVE_VOICE_SHOT_DIR;
  // A screenshot is a one-shot capture, not an event to sync on: this lets the opt-in picture settle
  // after the last DOM update. It runs only when QUAY_LIVE_VOICE_SHOT_DIR is set.
  if (dir) await page.waitForTimeout(700); // fixed-wait: screenshot settle, opt-in only (QUAY_LIVE_VOICE_SHOT_DIR)
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
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
  // `constructed`/`pushed` make "exactly one first frame per capture session" a page-side fact
  // rather than a caller's promise; they are shared with `__voiceCaptureProbe` below.
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

// ---------------------------------------------------------------------------------------------
// Event syncs — what the fixed waits used to stand in for.
//
// The recording must be the same under load as it is on an idle host: a fixed 600 ms that happens
// to cover the endpoint's script on THIS machine silently reads a half-delivered turn on a busy
// one, and the recording's meaning changes with it. Every wait below therefore names the EVENT it
// is waiting for (a browser frame, the app's own upstream traffic, a DOM state) and is bounded by
// {@link SYNC_TIMEOUT_MS}. A sync that times out prints {@link describeRecording} and throws — so a
// timeout is a diagnosed "the replay never got there", not an extra quietly-swallowed delay.
//
// The only constants that stay are the protocol's OWN durations (the 2.5 s coalescing window),
// each carrying its `fixed-wait:` reason on the SAME line as the fixed wait it excuses.
// ---------------------------------------------------------------------------------------------

/**
 * The upper edge of EVERY event sync here. It is far above any settle the fixed waits it replaces
 * ever bought (150 ms–5 s): a sync that reaches it means the event never came — a wrong assumption
 * in this SPEC, not a slow machine.
 */
const SYNC_TIMEOUT_MS = 20_000;

/** What the replay has observed so far, one line per channel — the payload a timed-out sync prints. */
function describeRecording(ctx: Ctx): string {
  const tally = (frames: Array<Record<string, unknown>>): string =>
    ['ready', 'state', 'segment_ack', 'caption', 'queued', 'sent', 'turn_unanswered', 'error']
      .map((type) => `${type}=${frames.filter((frame) => frame.type === type).length}`)
      .join(' ');
  return [
    `browser frames: ${tally(ctx.frames as Array<Record<string, unknown>>)}`,
    `last browser frames: ${JSON.stringify(
      ctx.frames.slice(-5).map((frame) => ({ type: frame.type, seq: frame.seq, itemId: frame.itemId, code: frame.code })),
    )}`,
    `upstream commits=${ctx.upstream.commitCount()} client frames=${JSON.stringify(
      ctx.upstream.clientFrames().slice(-8).map((frame) => frame.type),
    )}`,
    `console warnings: ${JSON.stringify(ctx.warnings.slice(-3))}`,
  ].join('\n');
}

/** Polls `read` until it is true, bounded; a timeout throws with the recording digest attached. */
async function syncTo(ctx: Ctx, what: string, read: () => boolean | Promise<boolean>, timeout = SYNC_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await read()) return;
    if (Date.now() >= deadline) {
      throw new Error(`event sync "${what}" did not happen within ${timeout} ms\n${describeRecording(ctx)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Waits for ≥1 browser frame of `type` after `from` that `match` accepts (default: any of them). */
function waitFrame(
  ctx: Ctx,
  type: string,
  from: number,
  timeout = SYNC_TIMEOUT_MS,
  match: (frame: BrowserFrame) => boolean = () => true,
): Promise<void> {
  return syncTo(
    ctx,
    `browser frame ${type}`,
    () => ctx.frames.slice(from).some((frame) => frame.type === type && match(frame)),
    timeout,
  );
}

/** Waits for a FINAL caption keyed by `itemId` — one transcript of the scripted endpoint reaching the page. */
const waitCaption = (ctx: Ctx, itemId: string, from: number): Promise<void> =>
  waitFrame(ctx, 'caption', from, SYNC_TIMEOUT_MS, (frame) => frame.itemId === itemId && frame.final === true);

/** Waits until a fresh DOM snapshot satisfies `predicate` — the page settled into the state read next. */
const syncDom = (ctx: Ctx, what: string, predicate: (snap: Snapshot) => boolean, timeout = SYNC_TIMEOUT_MS): Promise<void> =>
  syncTo(ctx, what, async () => predicate(await snapshot(ctx.page)), timeout);

/** Waits until the app's own FULL `session.update` (tools re-advertised) reaches the upstream. */
const waitStatusInjection = (ctx: Ctx, from: number, what: string): Promise<void> =>
  syncTo(ctx, what, () =>
    ctx.upstream.clientFrames().slice(from).some((frame) => {
      const session = frame.session as Record<string, unknown> | undefined;
      return frame.type === 'session.update' && Array.isArray(session?.tools) && (session.tools as unknown[]).length > 0;
    }),
  );

/** Real (non-caption) user rows carrying `text`. */
const realRowWith = (snap: Snapshot, text: string): Row[] =>
  snap.rows.filter((row) => row.style === 'user' && row.testid === null && normalize(row.text).includes(normalize(text)));

async function waitRealRow(ctx: Ctx, text: string): Promise<void> {
  await expect.poll(async () => realRowWith(await snapshot(ctx.page), text).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
}

/**
 * Replays one branch of the recorded session on a fresh session and returns its recording.
 * `branch`: 'A' (C never transcribed), 'B' (C's transcript arrives after S4's), 'V' (attribution
 * variant), 'R' (the endpoint's own protocol state machine answers the commits — nothing scripted).
 */
async function replay(
  ctx: Ctx,
  branch: 'A' | 'B' | 'V' | 'R',
  sessionId: string,
  journalDir: string | null,
): Promise<BranchRecording> {
  const { page, upstream } = ctx;
  // Which endpoint this branch dials: R gets the armed state machine, every other branch the plain
  // script. Set BEFORE the dial below — the connection is made when the Live Voice button is clicked,
  // and a machine armed afterwards would sit out its own branch.
  upstream.armProtocol(branch === 'R' ? R_PROTOCOL : null);
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
    // Variant R's endpoint is the state machine: it answers the resume `response.create` itself (with
    // the journal's "OK"), so a second writer here would put two responses on one request.
    if (branch === 'R') return;
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
  // `listening` needs capture's FIRST frame (`arming` is the window before it), and the fake graph
  // only emits when the spec drives it — push that frame, then wait for the phase it promotes.
  await pushFirstCaptureFrame(page);
  await expect.poll(() => phase(page), { timeout: 25_000 }).toBe('listening');
  // Segmented mode is the premise of the whole replay: the server must have declared it.
  await expect
    .poll(() => framesOf(ctx, 'ready', framesFrom).some((frame) => frame.protocol === 'segmented-v1'), { timeout: 15_000 })
    .toBe(true);

  const p = branch;
  if (branch === 'R') {
    // NOTHING is scripted here. The armed machine answers every frame the app sends, and its answers
    // are a function of the detector the app's OWN `session.update` frames leave in place — so this
    // branch reads the product, not this spec. Six segments, exactly as the journal spoke them.
    for (let seq = 0; seq < 6; seq += 1) {
      const from = ctx.frames.length;
      await utter(ctx);
      // The app's own verdict on the segment it just closed, so the next sentence is spoken onto a
      // settled segment and the six commits arrive in the journal's order rather than by luck.
      await waitFrame(ctx, 'segment_ack', from);
      // A relay the machine produced does NOT reach Claude here and now: the proxy opens its 2.5 s
      // coalescing window first (`queued`), and a segmented session that moved on before it closed
      // would fold two relays into one message — or, as this branch did before the wait below, press
      // Exit inside the window and never deliver at all. Wait for the delivery itself.
      if (ctx.frames.slice(from).some((frame) => frame.type === 'queued')) {
        await waitFrame(ctx, 'sent', from);
        // `sent` is a frame on the WIRE, and this recording reads the wire out-of-process
        // (`page.on('websocket')` → `framereceived`), so it says nothing about the DOM. Since this
        // task (`gap-live-voice-remove-transcript-caption-rows`) the app opens NO row of its own for a
        // spoken utterance — there is no provisional caption row to hold the words while the delivery
        // is pending — so what there is to wait for is the REAL row the relayed message becomes. The
        // A/B branches wait for it by text after this frame; do the same here, taking the text from
        // the app's OWN frame. Without it the closing snapshot below can catch a moment one HTTP round
        // trip from the state it is about.
        const sent = ctx.frames.slice(from).find((frame) => frame.type === 'sent');
        if (sent?.message) await waitRealRow(ctx, String(sent.message));
      }
    }
    snapshots.beforeExit = await snapshot(page);
  } else if (branch === 'V') {
    // seq0: the endpoint takes the audio as item C and never transcribes it (yet).
    const v0From = ctx.frames.length;
    await utter(ctx);
    await upstream.script([
      { wire: audioCommitted(`${p}_C`), afterMs: 120 },
      { wire: userItemCreated(`${p}_C`, null), afterMs: 1 },
      { wire: speechStarted(), afterMs: 90 },
    ]);
    // seq1 is built on seq0's segment being settled: wait for the proxy's own verdict on it — the
    // manual-mode `segment_ack` the browser receives — not for a wall-clock gap.
    await waitFrame(ctx, 'segment_ack', v0From);
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
    await page.waitForTimeout(5_000); // fixed-wait: the absent-`sent` reading must truly cross the proxy's 2.5 s coalescing window (VOICE_REALTIME_COALESCE_MS)
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
    // The journal's status injections (07:47:39 / 07:47:41) follow the delivery on the S-A 2 s rate
    // window: wait for the app's own re-advertised `session.update` to reach the upstream — the
    // cadence is a duration, but the injection itself is an event this run can wait for.
    const injectionsFrom = ctx.upstream.clientFrames().length;
    await waitStatusInjection(ctx, injectionsFrom, 'after-S1 status injection (session.update upstream)');
    snapshots.afterS1 = await snapshot(page);

    // ---- seq1: the commit is refused, the model answers "OK", the endpoint's VAD takes the audio as B ----
    await utter(ctx);
    const seq1From = ctx.frames.length;
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
    // The endpoint refusing the commit (UPSTREAM_ERROR) and the model answering itself
    // (MODEL_TEXT_REPLY) are this script's observable effect; the reply is the LAST reactive frame it
    // sends, so waiting for that error frame is waiting for the whole script to have landed.
    await waitFrame(ctx, 'error', seq1From, SYNC_TIMEOUT_MS, (frame) => frame.code === 'MODEL_TEXT_REPLY');

    // ---- seq2: committed, then B's transcript (S2) arrives late; no response ----
    await utter(ctx);
    const seq2From = ctx.frames.length;
    await upstream.script([
      { wire: audioCommitted(`${p}_seq2`, `${p}_B`), afterMs: 123 },
      { wire: speechStarted(), afterMs: 86 },
      { wire: captionCompleted(`${p}_B`, S2), afterMs: 86 },
    ]);
    // B's own transcript is the script's last frame: wait for it to be on screen as a caption.
    await waitCaption(ctx, `${p}_B`, seq2From);
    snapshots.afterS2 = await snapshot(page);

    // ---- seq3: committed + item C, speech_started, then silence past the bridge's 8 s stall ----
    await utter(ctx);
    const stallFrom = ctx.frames.length;
    await upstream.script([
      { wire: audioCommitted(`${p}_C`, `${p}_B`), afterMs: 124 },
      { wire: userItemCreated(`${p}_C`, `${p}_B`), afterMs: 1 },
      { wire: speechStarted(), afterMs: 90 },
    ]);
    await waitFrame(ctx, 'turn_unanswered', stallFrom, SYNC_TIMEOUT_MS);
    // THE STALL HAS NO DESTINATION ON SCREEN ANY MORE (operator's ruling, 2026-10-14). The bar used to
    // grow a marker of its own when a turn went unanswered; the bar now says only where the CONNECTION
    // is, so nothing appears on the page at this moment and there is nothing left to wait on here.
    // The frame wait above IS the reading: `turn_unanswered` reached the page from the bridge. What
    // the page must NOT do — invent a line about the stall — is read by the `voiceOnlyNodes` legs.
    snapshots.afterStall = await snapshot(page);

    // ---- seq4: committed + item D, its transcript (S4); no response ----
    await utter(ctx);
    const seq4From = ctx.frames.length;
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
    // D's transcript is the script's narrative frame; branch B appends C's, later still. Wait for
    // both captions at the browser, so this snapshot reads the state the script actually produced.
    await waitCaption(ctx, `${p}_D`, seq4From);
    if (branch === 'B') await waitCaption(ctx, `${p}_C`, seq4From);
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
    // Inside the proxy's coalescing window: the `queued` frame is the server's own "in flight". Since
    // this task (`gap-live-voice-remove-transcript-caption-rows`) the app opens NO row of its own for
    // the utterance the proxy is holding — the words ride the bottom bar's caption line — so the
    // in-flight state this moment reads is "the bar carries S5 and the chat area holds no row of S5
    // yet", waited on rather than a blank 300 ms.
    await waitFrame(ctx, 'queued', s5From);
    await syncDom(ctx, 'S5 is in flight — carried by the bottom bar, no row of its own yet', (snap) =>
      normalize(snap.barCaption).includes(normalize(S5)) &&
      !snap.rows.some((row) => row.style === 'user' && normalize(row.text).includes(normalize(S5))),
    );
    snapshots.queuedS5 = await snapshot(page);
    // The `sent` frame closes the window: S5 reaches the transcript as its own real row, which is
    // exactly the state this moment reads.
    await waitFrame(ctx, 'sent', s5From);
    await waitRealRow(ctx, S5);
    snapshots.sentS5 = await snapshot(page);
    // The last thing still moving is the app's post-delivery status injection upstream.
    const exitInjectionsFrom = ctx.upstream.clientFrames().length;
    await waitStatusInjection(ctx, exitInjectionsFrom, 'post-S5 status injection (session.update upstream)');
    snapshots.beforeExit = await snapshot(page);
  }
  // The DoD's second reading: the screen as the person leaves it — S1/S5 as the real messages Claude
  // answered, the unrelayed sentences (S2, S4, and in branch B the late S3) existing in the recording's
  // own algebra and in the composer the Exit is about to back-fill, and NOTHING drawn for them: after
  // `gap-voice-ui-strip-to-caption-and-connection-state` the pane opens no line of its own, so branch
  // A's segment C — which never got a transcript — has no line to be marked on.
  await shot(page, `branch-${branch}-before-exit`);

  // ---- the user clicks Exit ----
  await page.getByTestId('voice-realtime-end').click();
  await expect(page.locator(BAR)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
  // Exit back-fills the still-unrelayed captions into the composer, where the person can send them.
  // The wait that used to stand here — "the `voice-row-heard`/`voice-row-delivering` rows have left
  // the transcript" — is gone with this task: a spoken utterance is never a row of the client's own
  // any more, so that predicate was satisfied before the click and checked nothing. The back-fill is
  // applied by `handleVoiceExit` in the SAME render that removes the bar, which the two `expect`s
  // above already bracket, so the closing snapshot reads a settled screen. What the box ended up
  // holding is asserted verbatim from the recording by the branch A and branch B legs below (the
  // branch that left nothing unheard back-fills an EMPTY draft), not re-derived from a branch guess
  // here.
  const draft = await page.locator(COMPOSER_TEXTAREA).inputValue();
  snapshots.afterExit = await snapshot(page);
  // The DoD's composer reading, taken while the back-filled draft is still in the box (it is cleared
  // below so the next branch starts empty).
  await shot(page, `branch-${branch}-after-exit-composer`);
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
    const sessionR = await armScenario(api, workspacePath, scenario('Voice replay 20261012 variant R'));

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    // THE BROWSER HALF OF "ZERO CLOUD CALLS". Every request the page makes is inspected; a non-loopback one is
    // BLOCKED (so nothing leaves the browser) and recorded. The page's own static chrome is the only
    // non-loopback traffic there may be, and the positive leg asserts nothing outside that declared set
    // appeared. Registered on the CONTEXT (before the page exists), so it also covers any request the page
    // makes before this file's own handlers are attached.
    const browserEgress: string[] = [];
    await context.route('**', (route) => {
      const url = route.request().url();
      if (isLoopbackUrl(url)) return route.continue();
      browserEgress.push(url);
      return route.abort();
    });
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
      const R = await replay(ctx, 'R', sessionR, journalDir);
      recording = { A, B, V, R, browserEgress };
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
    expect(recording.R.commits, 'variant R: the machine answered the same six segments').toBe(6);
    expect(recording.R.dialHosts.filter((host) => host !== standInHost), 'variant R: dials that left the stand-in').toEqual([]);
    expect(recording.R.authorizationHeaderSeen, 'variant R: the upstream dial carried a credential').toBe(false);
  });

  test('nothing left the loopback: zero server dials and no non-local browser request beyond the page\'s own chrome', () => {
    // ---- the server: the egress guard's log ----
    const egressLog = process.env.QUAY_E2E_VOICE_REALTIME_EGRESS_LOG;
    expect(
      egressLog,
      'playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_EGRESS_LOG for this selection',
    ).toBeTruthy();
    // The guard CREATES the file (empty) as it installs, so the file EXISTING is the proof it was live in the
    // server. Without that, an empty `readFileSync` below would be a vacuous pass rather than a zero-egress
    // reading. A guard that never loaded leaves no file, and this line reds.
    expect(existsSync(egressLog!), `the server egress guard never loaded (no ${egressLog})`).toBe(true);
    const serverEgress = readFileSync(egressLog!, 'utf8').split('\n').filter(Boolean);
    expect(serverEgress, `the server dialled out of the loopback:\n${serverEgress.join('\n')}`).toEqual([]);

    // ---- the browser: every non-local request, all of them blocked by the context route ----
    // Non-vacuity first: an empty list is only a reading if the route really saw traffic. The page's own
    // chrome always fires (fonts + `api.github.com`), so a live observer is never empty here.
    expect(
      recording.browserEgress.length,
      'the browser outbound route recorded nothing at all — it cannot certify an absent non-local request',
    ).toBeGreaterThan(0);
    const strayHosts = [...new Set(recording.browserEgress.map((url) => new URL(url).host))].filter(
      (host) => !CHROME_HOSTS.has(host),
    );
    expect(strayHosts, `a non-local browser request outside the page's own chrome: ${strayHosts.join(', ')}`).toEqual([]);
    // The DoD asks for the COUNT, not just the vacuity: print the tally so one full replay's browser outbound
    // reading is a number in the run output instead of an inference from a passing `> 0`.
    console.log(
      `[egress] browser non-local requests: ${recording.browserEgress.length} ` +
        `(${[...new Set(recording.browserEgress.map((url) => new URL(url).host))].sort().join(', ')})`,
    );

    // ---- the server's own environment, in the two halves the sibling voice spec reads it in ----
    // RUNTIME: the dial that DID happen (the loopback stand-in) carried no credential.
    for (const key of ['A', 'B'] as const) {
      expect(recording[key].authorizationHeaderSeen, `branch ${key}: the upstream dial carried a credential`).toBe(false);
    }
    const configSource = readFileSync(path.resolve(process.cwd(), 'playwright.config.ts'), 'utf8');
    // SOURCE: this selection blanks the credential and opens the debug-agent gate — the two declared
    // properties the runtime readings above depend on.
    const voiceEnvSpread = configSource.slice(configSource.indexOf('...(voiceRealtimeSelection'));
    expect(voiceEnvSpread, 'the cloud credential must be blanked on this selection').toContain("DASHSCOPE_API_KEY: ''");
    expect(configSource, 'the debug agent must stand in for Claude on this selection').toContain("DEBUG_AGENT: '1'");
    const debugAgentList = configSource.slice(configSource.indexOf('const DEBUG_AGENT_SPEC_FILES'));
    expect(
      debugAgentList.slice(0, debugAgentList.indexOf('];')),
      'this replay must be one of the debug-agent selections',
    ).toContain('voice-realtime-segmented-replay-20261012.spec.ts');
    // BEHAVIOURAL: the turns really came from the debug agent's scenario engine — the fixture seed text is on
    // screen (a real `claude` run would answer with its own words, not the armed scenario's).
    const seeded = realRowWith(recording.A.snapshots.beforeExit!, 'seeded turn for Voice replay 20261012 branch A');
    expect(seeded.length, 'the replayed transcript is not the debug agent scenario engine\'s').toBeGreaterThanOrEqual(1);
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

  // SUPERSEDED 2026-10-13 by AC-375 (GOAL-044, decision doc §11–§12). A `sent` frame now reports the
  // committed-item watermark (`coveredThroughItemId`), and the page claims every pending caption up to
  // it. The model HAD S2 and S4 in front of it when it relayed S5, so they are disposed of — relayed,
  // reworded or deliberately dropped — and leaving must NOT hand already-handled speech back as a
  // draft. The reading this leg replaces was `draft was "现在是第二句话。第四句话。"`; what it pins now is
  // the empty draft, read TOGETHER with the proof that both sentences really were there to be claimed
  // (their final captions are in the recording) and with the watermark that did the claiming — so an
  // implementation that simply dropped the sentences cannot pass this leg.
  test('branch A: Exit does not hand back speech the model already had in front of it', () => {
    const draft = recording.A.draft;
    expect(normalize(draft), `draft was ${JSON.stringify(draft)}`).toBe('');
    const finals = recording.A.browserFrames
      .filter((frame) => frame.type === 'caption' && frame.final === true)
      .map((frame) => normalize(String(frame.text)));
    expect(finals, `final captions were ${JSON.stringify(finals)}`).toEqual(
      expect.arrayContaining([normalize(S2), normalize(S4)]),
    );
    const s5Delivery = recording.A.browserFrames.find(
      (frame) => frame.type === 'sent' && normalize(String(frame.message)) === normalize(S5),
    );
    expect(s5Delivery?.coveredThroughItemId, 'S5 delivery watermark').toBe('A_E');
  });

  // ------------------------------- variant R: the machine answers (POSITIVE) -------------------------------
  //
  // R is the ONE branch whose endpoint frames are not scripted: `createScriptedProtocolState` answers
  // everything, and its answers are a function of the detector the app's OWN `session.update` frames
  // leave in place. That is what makes these legs a reading of the product: had the segmented path
  // let the status injection re-open the deployment's `server_vad` — the pre-fix behaviour — the
  // machine would refuse a commit with the journal's empty-buffer error and take the audio as its own
  // item, and every leg below would red. GREEN as of
  // `gap-live-voice-manual-mode-session-update-keeps-vad-off` (2026-10-12).

  test('variant R: all six commits are accepted — the endpoint neither refuses one nor takes the audio as its own', () => {
    const rec = recording.R;
    expect(rec.browserFrames.some((f) => f.type === 'ready' && f.protocol === 'segmented-v1')).toBe(true);
    const codes = rec.browserFrames.filter((f) => f.type === 'error').map((f) => String(f.code));
    // The journal's seq1 was the endpoint refusing a commit its own detector was holding.
    expect(codes, 'the endpoint refused a commit its own detector was holding').not.toContain('UPSTREAM_ERROR');
    // ...and the response that refusal swallowed never surfaced as a stall either.
    expect(framesOfType(rec, 'turn_unanswered'), 'a requested response was swallowed').toEqual([]);
    expect(rec.errorEverVisible, 'a red error UI appeared on variant R').toBe(false);

    // NON-VACUITY, read off the endpoint's own side. The server's journal records every frame the
    // machine emitted, so the all-clear above is a reading of a LIVE endpoint rather than of one that
    // happened to say nothing: the machine's two `session_send` calls are there, and not one `error`.
    //
    // The journal's "OK" remark on the tool result is there too and is deliberately NOT asserted as a
    // MODEL_TEXT_REPLY: the bridge registers the response a tool resume names, so an endpoint that
    // closes a resume with a remark is behaving, not misbehaving. MODEL_TEXT_REPLY is the frame the
    // A/B branches script — an unsolicited reply where a relay was due.
    // Not every journal record carries a `line` (some are structural), so coerce: a missing one is
    // simply not an endpoint frame this reading is about.
    const endpointFrames = rec.journal
      .map((entry) => String((JSON.parse(entry) as { line?: unknown }).line ?? ''))
      .filter((line) => line.startsWith('<< '));
    expect(
      endpointFrames.filter((line) => line.includes('function_call session_send')),
      `endpoint frames: ${JSON.stringify(endpointFrames)}`,
    ).toHaveLength(2);
    expect(endpointFrames.filter((line) => line.includes('error')), 'the endpoint reported an error').toEqual([]);
  });

  test('variant R: the machine`s transcripts reach the page keyed by the item the app committed', () => {
    const captions = recording.R.browserFrames
      .filter((f) => f.type === 'caption' && f.final === true)
      .map((f) => `${String(f.itemId)}=${String(f.text)}`);
    // `R_C` and `R_F` are the two the machine never transcribes — the `never` half of the matrix.
    expect(captions).toEqual([`R_A=${S1_HEARD}`, `R_B=${S2}`, `R_D=${S4}`, `R_E=${S5}`]);
    expect(framesOfType(recording.R, 'segment_ack'), 'one verdict per segment the app closed').toHaveLength(6);
  });

  test('variant R: only S1 and S5 reach Claude — the same two the journal delivered', () => {
    expect(sentMessages(recording.R)).toEqual([S1_RELAYED, S5]);
    expect(realRowWith(recording.R.snapshots.beforeExit!, S1_RELAYED).length).toBeGreaterThanOrEqual(1);
    expect(realRowWith(recording.R.snapshots.beforeExit!, S5).length).toBeGreaterThanOrEqual(1);
    for (const unrelayed of [S2, S4]) {
      expect(realRowWith(recording.R.snapshots.beforeExit!, unrelayed), `"${unrelayed}" must not have reached Claude`).toEqual([]);
    }
  });

  test('variant R: the server`s own journal records six kept segments and no empty-transcript drop', () => {
    const lines = recording.R.journal.map((line) => (JSON.parse(line) as { line: string }).line);
    const segments = lines.filter((line) => /segment seq=\d+/.test(line));
    expect(segments, `variant R journal: ${JSON.stringify(lines)}`).toHaveLength(6);
    expect(
      segments.filter((line) => /empty-transcript|not-delivered/.test(line)),
      `a segment was dropped on variant R: ${JSON.stringify(segments)}`,
    ).toEqual([]);
  });

  // ------------------------------- expected behaviour (defect legs, all green) -------------------------
  //
  // Every leg below was RED when it was written, and each is a plain `test(...)` now: the fix tasks
  // have landed, the known-defect wrappers are gone, and what is left is the assertion the leg always
  // expressed (AC-356 refuses a spec that still carries a wrapper — see `e2e/voiceRealtimeKnownDefect.ts`
  // for what the wrapper did and why it is preferable to Playwright's own expected-fail annotation while
  // a defect is still live). Each leg keeps the reading the defect produced, quoted above it, so a
  // regression is recognisable as the same failure rather than as a new one.

  // GREEN as of the fix for gap-live-voice-manual-mode-session-update-keeps-vad-off (2026-10-12):
  // the transport now re-states the segmented path's own detector switch into every FULL
  // `session.update`, so the state injection below can no longer re-open the endpoint's own VAD
  // behind `session.turn_detection: null`'s back. The reading this leg was written against — four
  // injected bodies each carrying the deployment's live detector — was:
  //   a session.update after segments started re-enabled the endpoint's detector: [{"tools":0,"turn_detection":null},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}},{"tools":3,"turn_detection":{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}}]
  test('(a) every session.update after segments started keeps turn_detection null (manual mode)', () => {
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

  // REWRITTEN with gap-live-voice-remove-transcript-caption-rows (2026-10-13). This leg used to read
  // the `voice-row-delivering` marker off a provisional caption row, asserting only the segment the
  // proxy was holding carried it. That row kind is gone — a spoken utterance is never a row of the
  // client's own any more — so the marker no longer exists and the old assertion would be vacuous.
  // The honest reading of the same moment is that the unrelayed sentences (S2/S3/S4) are carried by NO
  // row of the client's own: not while the proxy holds S5 (`queuedS5`), not once S5 has landed
  // (`sentS5`). The reading this leg was written against was:
  //   branch A @queuedS5: rows [{"style":"user","testid":null,"text":"seeded turn for Voice replay 20261012 branch A"},…{"style":"user","testid":"voice-row-delivering","text":"现在是第二句话。第四句话。上面我们看见丢了一句话。"}]
  test('an unrelayed transcript is never a row of the client’s own, in flight or delivered', () => {
    for (const key of ['A', 'B'] as const) {
      for (const moment of ['queuedS5', 'sentS5'] as const) {
        const snap = recording[key].snapshots[moment]!;
        const wrong = snap.rows.filter(
          (row) => row.style === 'user' && [S2, S3, S4].some((text) => normalize(row.text).includes(normalize(text))),
        );
        expect(wrong, `branch ${key} @${moment}: rows ${JSON.stringify(snap.rows)}`).toEqual([]);
      }
    }
  });

  // REWRITTEN with gap-live-voice-remove-transcript-caption-rows (2026-10-13). This leg used to assert
  // the unrelayed sentences were `voice-row-heard` rows placed at their spoken positions. That row
  // kind is gone, so the same moment now reads the other way round: after S5 is delivered, the ONLY
  // rows of the person's own in the chat area are the real messages (S1, S5), and the unrelayed
  // sentences are carried by no row at all. The reading this leg was written against was:
  //   row indices of S1,S2,S4,S5 in [{"style":"user","testid":null,…},{"style":"user","testid":"voice-row-heard","text":"现在是第二句话。第四句话。"}]
  test('after S5 is delivered only the real messages are rows, in spoken order', () => {
    const snap = recording.A.snapshots.beforeExit!;
    const rows = JSON.stringify(snap.rows);
    for (const text of [S2, S4]) {
      expect(rowIndexOf(snap, text), `"${text}" became a row of the client's own: ${rows}`).toBe(-1);
    }
    // Spoken order among the rows that ARE real: S1 < S5, each its own row.
    const order = [S1_RELAYED, S5].map((text) => rowIndexOf(snap, text));
    expect(order.every((index) => index >= 0), `a delivered row is missing from S1/S5: ${rows}`).toBe(true);
    expect(order, `row indices of S1,S5 in ${rows}`).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size, `S1 and S5 must each have their own row: ${rows}`).toBe(2);
  });

  // FLIPPED with gap-voice-ui-strip-to-caption-and-connection-state (2026-10-14). This leg used to
  // assert that a segment with no transcript left a line of its own on the page. That line — and
  // every other row of the pane's own voice kind — is gone: the conversation carries the real
  // messages and nothing else, and the bar says only where the connection is. The reading is the
  // same fact read at the end that survived: the page shows NO such indication. `bodyText` is the
  // whole rendered page, so a marker reappearing anywhere on it (a row, a badge, a sentence) fails
  // here whatever it is called.
  test('(c) branch A: the segment C that never got a transcript leaves no line on the page before Exit', () => {
    const snap = recording.A.snapshots.beforeExit!;
    const marker = /not recogni[sz]ed|unrecogni[sz]ed|no words|未识别|没有识别|没听清/i;
    expect(snap.bodyText, 'a "not recognized" line is on the page for segment C').not.toMatch(marker);
    expect(snap.voiceOnlyNodes, `voice-only nodes on screen: ${JSON.stringify(snap.rows)}`).toBe(0);
  });

  // REWRITTEN with gap-voice-ui-strip-to-caption-and-connection-state (2026-10-14), and again with
  // gap-voice-close-trace-row-removed-from-transcript. This leg used to assert that leaving by the
  // Exit button left a CLOSING-COUNT row as the transcript's last line. The count is still taken on
  // both paths (the server's close and the person's Exit), and the composer draft below is still the
  // trace that survives — but it is no longer drawn, so the leg's positive half is now its absence.
  // It reads that absence twice, on purpose: the named query for the closing-count row itself
  // (`closeTrace`, `null` now that the line is gone) and the prefix count over the whole voice-only
  // family (`voiceOnlyNodes`, 0), so a row of that kind returning under ANY name still fails here.
  test('(c) branch A: leaving with an unrecognized segment leaves no exit trace', () => {
    const snap = recording.A.snapshots.afterExit!;
    const reason = `after Exit the transcript ends with rows ${JSON.stringify(snap.rows.slice(-4))}`;
    expect(snap.closeTrace, reason).toBeNull();
    expect(snap.voiceOnlyNodes, reason).toBe(0);
  });

  // SUPERSEDED 2026-10-13 by AC-375 (GOAL-044, decision doc §11–§12), the same watermark rule as the
  // branch-A leg above: S2, S4 and the late S3 were all committed before the S5 relay's boundary, so
  // they are the model's to answer and must not come back as a draft. The reading this leg replaces
  // was `draft was "现在是第二句话。第三句话。第四句话。"` (in spoken order; the earlier
  // arrival-ordered draft was `"现在是第二句话。第四句话。第三句话。"`).
  test('(d) branch B: Exit does not hand back the late-arriving sentences either', () => {
    const draft = recording.B.draft;
    expect(normalize(draft), `draft was ${JSON.stringify(draft)}`).toBe('');
    const finals = recording.B.browserFrames
      .filter((frame) => frame.type === 'caption' && frame.final === true)
      .map((frame) => normalize(String(frame.text)));
    expect(finals, `final captions were ${JSON.stringify(finals)}`).toEqual(
      expect.arrayContaining([normalize(S2), normalize(S3), normalize(S4)]),
    );
  });

  // REWRITTEN with gap-live-voice-remove-transcript-caption-rows (2026-10-13). This leg used to assert
  // S3's late transcript sat at its spoken position ABOVE S4's row. Both were caption rows of the
  // client's own, and that row kind is gone. The honest reading is now a negative one: neither the
  // late-arriving S3 nor the earlier S4 is a row of the client's own — S3 arriving late changes
  // nothing about that. (That S3 did arrive and is accounted for is the composer back-fill leg
  // below, not this one.) The reading this leg was written against was:
  //   S3 after S4 inside "现在是第二句话。第四句话。第三句话。"
  test('(d) branch B: the late S3 transcript is never a row of the client’s own', () => {
    const snap = recording.B.snapshots.afterS4!;
    const rows = JSON.stringify(snap.rows);
    expect(rowIndexOf(snap, S3), `S3 became a row of the client's own: ${rows}`).toBe(-1);
    expect(rowIndexOf(snap, S4), `S4 became a row of the client's own: ${rows}`).toBe(-1);
  });

  // GREEN as of the fix for gap-live-voice-caption-segment-attribution-by-item-id (2026-10-12): the
  // transcript is attributed to the segment whose COMMIT produced its item id, not to whichever
  // segment was active when the words arrived, so C's late EMPTY transcript marks C (seq0) and leaves
  // seq1's relay alone. The reading this leg was written against — with the active segment deciding —
  // was: `segment 1 dropped: the endpoint reported no words for it | … session_send not-delivered
  // (empty-transcript)` in the journal and `["0:committed","1:committed","1:dropped:empty-transcript"]`
  // in the acks, i.e. S5 refused.
  test('(b) variant V: a late EMPTY transcript for item C does not refuse the active segment\'s S5 relay', () => {
    const rec = recording.V;
    expect(sentMessages(rec), `journal: ${rec.journal.filter((l) => /segment|not-delivered|session_send/.test(l)).map((l) => JSON.parse(l).line).join(' | ')}`).toEqual([S5]);
  });

  test('(b) variant V: the segment that carried words is not acked dropped/empty-transcript', () => {
    const acks = recording.V.browserFrames.filter((f) => f.type === 'segment_ack').map((f) => `${f.seq}:${f.state}${f.reason ? `:${f.reason}` : ''}`);
    expect(acks, 'segment_ack frames').not.toContain('1:dropped:empty-transcript');
    // The other half of the same fact: the refusal went to the segment the endpoint really did report
    // no words for, so the page can mark THAT one (the downstream criterion's input) rather than seq1.
    expect(acks, 'segment_ack frames').toContain('0:dropped:empty-transcript');
  });
});

function framesOfType(rec: BranchRecording, type: string): BrowserFrame[] {
  return rec.browserFrames.filter((frame) => frame.type === type);
}
