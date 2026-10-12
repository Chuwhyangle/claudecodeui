/**
 * The double-drop browser acceptance (GOAL-043 / AC-368).
 *
 * WHAT THIS FILE IS. The 2026-10-12 Live Voice journal (`~/.cloudcli/voice-realtime-log/
 * e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl`) records a segmented session whose socket died three
 * times: the commit of one segment was written and never answered, the reconnect replayed it and lost
 * the replay 1.15 s later, the second reconnect replayed it once more, and only then did the bridge
 * stop. Everything downstream of that — which segment the page is told is un-delivered, whether the
 * sentences spoken afterwards are still attributed to their own segment and kept in spoken order, and
 * whether a segment is ever delivered twice — is what this spec reads off a REAL browser.
 *
 * TWO VARIANTS, ONE SCRIPTED UPSTREAM.
 *
 *   · 双断线 (the double drop) — the branch whose shape is the journal's. `DOUBLE_DROP_PLAN` is
 *     AC-365's dial-by-dial fault plan, extended by ONE dial: see the constant for why the third
 *     dial's ordinary entry is not enough to reach the reading this criterion's headline names
 *     (`DEFAULT_MAX_SEGMENT_REPLAYS = 2` spends the budget on the THIRD replay, not the second).
 *   · V-fatal (the permanent disconnect) — the branch where the endpoint stops answering and the
 *     bridge settles `closed` under a LIVE page socket. The words spoken after it must be marked
 *     not sent, and the bar must say the connection is gone.
 *
 * F6 — THE PLAN IS READ, THE DROPS ARE DRIVEN. `e2e/voiceRealtimeScriptedUpstream.ts`'s `armFaults`
 * is read-only by construction: the e2e upstream never fires a planned drop (its own `drop()` /
 * `refuseDials()` are the only things that end a connection), because a browser spec's timeline is
 * the browser's. So this spec arms the SAME `ScriptedFaultPlan` an in-process criterion arms, reads
 * each dial's entry back through `dialFaults()`, and drives the death the entry describes — the
 * `dropBeforeCommit` ordinal decides WHEN to drop, and `dropAfterCommitMs.ms` is the literal wait.
 * The two sides are written against one dial-by-dial script rather than two that can drift apart.
 *
 * WHAT IS REAL. The browser, the app server, `/voice-realtime`, the bridge, the transport, the
 * debug-agent provider standing in for Claude, and a real TCP dial to the spec's own loopback
 * listener. Not real: the microphone (the shaped-PCM fake the sibling voice specs use) and the
 * endpoint (the scripted upstream on `QUAY_E2E_VOICE_REALTIME_PORT`; `DASHSCOPE_API_KEY` is blanked
 * by the config AND the server runs from a root with no `.env`, so the blank survives
 * `server/load-env.ts`'s backfill). Account: the shared `voice-realtime-e2e` fixture account — the
 * server is single-seat, and a private account would 403 every sibling voice spec.
 *
 * AC-367'S COPY IS THE READING. The page's three graded verdicts are three different facts
 * (`src/modules/chat/voice-realtime/MessageComponent.tsx`), and this file asserts the one AC-368 is
 * about — `lost(upstream-drop)`, "This part never reached the model — please say it again." — by its
 * `data-voice-segment-outcome-*` attributes AND its words, and asserts the segment is NOT shown as
 * the not-recognised row (the reading AC-367 (b) forbids).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  audioCommitted,
  captionCompleted,
  functionCall,
  responseCreated,
  startScriptedUpstream,
  userItemCreated,
  type ScriptedDialFaults,
  type ScriptedEndpointEvent,
  type ScriptedFaultPlan,
  type ScriptedUpstreamServer,
} from './voiceRealtimeScriptedUpstream';

const PANE = '.chat-messages-pane';
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
const BAR = '[data-testid="voice-realtime-bar"]';

const USERNAME = 'voice-realtime-e2e';
const PASSWORD = 'voice-realtime-e2e-pass';

/** One spoken sentence of the fake microphone, in seconds of voiced body. */
const SPEECH_SECONDS = 1.0;

// The six sentences the timeline speaks. The endpoint's transcript of each is what this spec scripts,
// so the strings are the spec's own — the audio is synthesized, never decoded.
const S0 = '这是第一句话。';
const S1 = '这是第二句话。';
const S2 = '这是第三句话。';
const S3 = '这是第四句话。';
const S4 = '这是第五句话。';
const S5 = '这是第六句话。';
/**
 * The one segment the model relays — VERBATIM, and both halves of that are load-bearing.
 *
 * ONLY SEQ5 IS RELAYED. The branch's double drop happens over seq2, and any relayed segment before
 * the drop makes the app round-trip a tool output, whose `response.done` clears the bridge's
 * `committedSegment` and collapses the double drop to a single one (measured 2026-10-13).
 *
 * VERBATIM SO THE ATTRIBUTION IS EXACT. The client attributes a delivered message to the captions it
 * carries (`useVoiceRealtimeSession`): a caption whose words appear in the relayed text is claimed by
 * TEXT, and when the relayed text contains NO pending caption the client falls back to "everything
 * spoken since the last delivery" (`carried = matched.length > 0 ? matched : thought`). A REPHRASE
 * therefore hands seq5's one delivery every pending caption — seq0, seq1, seq3, seq4 — and drops
 * them all off the screen, which is the rewrite-attribution question and not this criterion. Relaying
 * the transcript verbatim keeps the claim exact: the only caption seq5's delivery takes over is seq5's
 * own, so the sibling sentences stay as their own `heard` rows and the spoken order is readable.
 */
const S5_RELAYED = S5;

// AC-367's rendered copy, read off `src/modules/i18n/locales/en/chat.json` (the run sets
// `userLanguage: 'en'`). Asserted literally: the DoD asks that the page's words match AC-367.
const LOST_UPSTREAM_COPY = 'This part never reached the model — please say it again.';
const LOST_CONNECTION_COPY = 'The voice connection closed — this part was not sent.';
const DISCONNECTED_LABEL = 'Voice disconnected';

/**
 * AC-365's dial-by-dial plan — the journal's own double drop — EXTENDED BY ONE DIAL.
 *
 * AC-365's `doubleDropScenario` runs three dials: dial #1 drops its third commit before answering it,
 * dial #2 processes the replay and drops 1.15 s later, dial #3 is ordinary and ANSWERS the replay
 * (its D2 asserts the replayed segment recovers). That reading is correct for the in-process
 * criterion, but it cannot produce the verdict AC-368's headline names: a segment is only reported
 * `lost(upstream-drop)` once its replay budget is spent, and `DEFAULT_MAX_SEGMENT_REPLAYS = 2` spends
 * it on the THIRD replay (`voice-realtime-bridge.service.ts`'s `replayCommittedSegment`). With three
 * dials the bridge has replayed twice and still owes the segment a third chance.
 *
 * So dial #2's entry is repeated as dial #3 (the journal's shape — a replay that died, then the
 * bridge giving up) and the ordinary dial moves to #4, which is where the budget is read and
 * `lost(upstream-drop)` is emitted. The first three entries are AC-365's, unchanged and in order.
 */
const DOUBLE_DROP_PLAN: ScriptedFaultPlan = {
  dials: [
    // dial #1 — the third commit (the user's third segment) arrives and the endpoint never answers
    // it: the socket is gone.
    { dropBeforeCommit: 3 },
    // dial #2 — the replay is PROCESSED and answered with nothing, and the endpoint drops the socket
    // 1.15 s later (the journal's second CONNECTION_LOST, 1.15 s after the first).
    { loseEventsOfCommit: 1, dropAfterCommitMs: { ordinal: 1, ms: 1150 } },
    // dial #3 — the same death one dial later: this is the replay that SPENDS the budget.
    { loseEventsOfCommit: 1, dropAfterCommitMs: { ordinal: 1, ms: 1150 } },
    // dial #4 — ordinary. The bridge has no replayed audio left to write, so this dial opens clean.
    {},
  ],
};

/**
 * The V-fatal plan: the endpoint stops answering and every dial after the first is refused.
 *
 * Driven with `refuseDials`, not by the plan — see F6 in this file's header. The COUNT of refusals is
 * read back off the armed plan rather than hardcoded, so the plan and the driving stay one script.
 */
const V_FATAL_PLAN: ScriptedFaultPlan = {
  dials: [
    {},
    { disposition: { action: 'refuse' } },
    { disposition: { action: 'refuse' } },
    { disposition: { action: 'refuse' } },
  ],
};

/**
 * The page's OWN chrome — the only non-loopback hosts the app fires at, declared as an allowlist (the
 * sibling voice specs' shape). The browser context BLOCKS every non-loopback request and records it;
 * the positive leg asserts nothing outside this set was ever attempted.
 */
const CHROME_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'api.github.com']);

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
// The recording the legs read.
// ---------------------------------------------------------------------------------------------

type BrowserFrame = Record<string, unknown> & {
  type?: string;
  seq?: number;
  itemId?: string;
  state?: string;
  reason?: string;
  message?: string;
  protocol?: string;
  final?: boolean;
};

/** One transcript row, whatever kind it is — the segment-outcome rows carry no `data-message-style`. */
type Row = {
  style: string | null;
  testid: string | null;
  text: string;
  outcomeState: string | null;
  outcomeReason: string | null;
  outcomeSeq: string | null;
  unrecognizedSeq: string | null;
};

type Snapshot = {
  rows: Row[];
  status: string | null;
  phase: string | null;
  retry: boolean;
  error: string | null;
  bodyText: string;
};

type BranchRecording = {
  sessionId: string;
  /** Segments committed upstream during this branch. */
  commits: number;
  /** Dials the app made during this branch. */
  dials: number;
  /** The plan entry each dial was read against, index = dial - 1. */
  dialFaults: ScriptedDialFaults[];
  dialHosts: string[];
  authorizationHeaderSeen: boolean;
  browserFrames: BrowserFrame[];
  sentMessages: string[];
  upstreamClientFrames: Array<Record<string, unknown>>;
  consoleWarnings: string[];
  snapshots: Record<string, Snapshot>;
};

type Recording = {
  doubleDrop: BranchRecording;
  permanent: BranchRecording;
  /** Every non-loopback request the page attempted during the run, in order — all of them blocked. */
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
 * The transcript as the page shows it.
 *
 * The three row kinds this criterion reads are three DIFFERENT elements: a spoken row carries
 * `data-message-style`, while the graded-outcome and not-recognised rows are `system` rows with no
 * style at all (a segment that produced no transcript has no words of the person's to show). So the
 * selector names all of them and the segments that carry none of the style attributes are read by
 * their own `data-voice-*` attributes instead of being silently absent from `rows`.
 */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane');
    const selector = [
      '[data-message-style]',
      '[data-testid="voice-row-segment-outcome"]',
      '[data-testid="voice-row-unrecognized"]',
      '[data-testid="voice-closed-unshown-utterance"]',
    ].join(', ');
    const rows = [...(pane?.querySelectorAll(selector) ?? [])].map((el) => ({
      style: el.getAttribute('data-message-style'),
      testid: el.getAttribute('data-testid'),
      text: (el.textContent ?? '').trim(),
      outcomeState: el.getAttribute('data-voice-segment-outcome-state'),
      outcomeReason: el.getAttribute('data-voice-segment-outcome-reason'),
      outcomeSeq: el.getAttribute('data-voice-segment-outcome-seq'),
      unrecognizedSeq: el.getAttribute('data-voice-unrecognized-seq'),
    }));
    const statusEl = document.querySelector('[data-testid="voice-realtime-status"]');
    const phaseEl = document.querySelector('[data-testid="voice-realtime-phase"]');
    const errorEl = document.querySelector('[data-testid="voice-realtime-error"]');
    return {
      rows,
      status: statusEl ? (statusEl.textContent ?? '').trim() : null,
      phase: phaseEl ? (phaseEl.textContent ?? '').trim() : null,
      retry: document.querySelector('[data-testid="voice-realtime-retry"]') !== null,
      error: errorEl ? (errorEl.textContent ?? '').trim() : null,
      bodyText: document.body.innerText.slice(0, 8_000),
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
      /* no statechange listener is read */
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
}

// ---------------------------------------------------------------------------------------------
// The replay driver.
// ---------------------------------------------------------------------------------------------

type Ctx = {
  page: Page;
  upstream: ScriptedUpstreamServer;
  frames: BrowserFrame[];
  warnings: string[];
  /**
   * The dial number (1-based, ACROSS the whole run) each `input_audio_buffer.commit` arrived on.
   *
   * WHY AN OBSERVER RATHER THAN `commitCount()`. The reconnect is a loopback dial: the bridge opens
   * the next socket and writes the replay within MILLISECONDS of the death, so "count at the moment
   * I began waiting for the dial" and "count once the dial is up" are the same number — a wait for
   * "more commits than before" then never fires, even though the replay really went out. The
   * observer is stamped by the upstream at arrival, so it cannot lose that race.
   */
  commitDials: number[];
};

/** The upper edge of EVERY event sync here. A sync that reaches it means the event never came. */
const SYNC_TIMEOUT_MS = 20_000;

function describeRecording(ctx: Ctx, from: number): string {
  const frames = ctx.frames.slice(from) as Array<Record<string, unknown>>;
  const tally = (type: string): number => frames.filter((frame) => frame.type === type).length;
  const label = (frame: Record<string, unknown>): string =>
    [
      String(frame.type),
      frame.seq === undefined ? '' : `:${String(frame.seq)}`,
      frame.state === undefined ? '' : `:${String(frame.state)}`,
      frame.reason === undefined ? '' : `:${String(frame.reason)}`,
      frame.protocol === undefined ? '' : `:${String(frame.protocol)}`,
    ].join('');
  return [
    `browser frames since the branch began: ready=${tally('ready')} state=${tally('state')} ` +
      `segment_ack=${tally('segment_ack')} caption=${tally('caption')} sent=${tally('sent')} error=${tally('error')}`,
    `the whole run: ${JSON.stringify(frames.map(label))}`,
    `upstream dials=${ctx.upstream.dialed()} live=${ctx.upstream.liveConnectionCount()} commits=${ctx.upstream.commitCount()} ` +
      `client frames=${JSON.stringify(ctx.upstream.clientFrames().map(label))}`,
    `console warnings: ${JSON.stringify(ctx.warnings.slice(-3))}`,
  ].join('\n');
}

/** Polls `read` until it is true, bounded; a timeout throws with the recording digest attached. */
async function syncTo(
  ctx: Ctx,
  from: number,
  what: string,
  read: () => boolean | Promise<boolean>,
  timeout = SYNC_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await read()) return;
    if (Date.now() >= deadline) {
      throw new Error(`event sync "${what}" did not happen within ${timeout} ms\n${describeRecording(ctx, from)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Waits for ≥1 browser frame of `type` after `from` that `match` accepts (default: any of them). */
function waitFrame(
  ctx: Ctx,
  from: number,
  type: string,
  match: (frame: BrowserFrame) => boolean = () => true,
): Promise<void> {
  return syncTo(ctx, from, `browser frame ${type}`, () =>
    ctx.frames.slice(from).some((frame) => frame.type === type && match(frame)),
  );
}

/** Waits for a FINAL caption keyed by `itemId` — one transcript of the scripted endpoint reaching the page. */
const waitCaption = (ctx: Ctx, from: number, itemId: string): Promise<void> =>
  waitFrame(ctx, from, 'caption', (frame) => frame.itemId === itemId && frame.final === true);

/** Speaks one sentence and waits until its commit reached the upstream (the segmented, live path). */
async function utter(ctx: Ctx): Promise<void> {
  const before = ctx.upstream.commitCount();
  await ctx.page.evaluate((seconds: number) => {
    (window as unknown as { __voiceFake: { speak(seconds: number): void } }).__voiceFake.speak(seconds);
  }, SPEECH_SECONDS);
  await syncTo(ctx, 0, 'the segment commit reached the upstream', () => ctx.upstream.commitCount() === before + 1);
}

/**
 * Speaks one sentence and waits for its own verdict, for a branch whose connection is already gone.
 *
 * `utter` above waits on the upstream commit counter, and a segment closed on a dead bridge writes no
 * commit — the proxy answers from the bridge's own state. So the settle this branch waits on is the
 * `segment_ack` the page receives for that `seq`, which is exactly the reading it is about.
 */
async function utterOnDeadBridge(ctx: Ctx, from: number, seq: number): Promise<void> {
  const before = verdictsFor(ctx, from, seq).length;
  await ctx.page.evaluate((seconds: number) => {
    (window as unknown as { __voiceFake: { speak(seconds: number): void } }).__voiceFake.speak(seconds);
  }, SPEECH_SECONDS);
  await syncTo(ctx, from, `the verdict for seq ${seq}`, () => verdictsFor(ctx, from, seq).length > before);
}

/** Real (non-caption, non-outcome) user rows carrying `text`. */
const realRowWith = (snap: Snapshot, text: string): Row[] =>
  snap.rows.filter((row) => row.style === 'user' && row.testid === null && normalize(row.text).includes(normalize(text)));

async function waitRealRow(ctx: Ctx, text: string): Promise<void> {
  await expect.poll(async () => realRowWith(await snapshot(ctx.page), text).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
}

/** Enters Live Voice on `sessionId` and waits until the segmented relay is really declared. */
async function enterVoice(ctx: Ctx, sessionId: string, from: number): Promise<void> {
  const { page } = ctx;
  await page.goto(`/session/${sessionId}`);
  // ONE RELOAD ON A MISSED BOOT, the same fallback `beforeAll` uses for the workspace list. A cold
  // SPA boot under load can exceed a single 30 s window (the boot flake the sibling voice specs carry
  // too), and a red criterion from a boot isn't a reading about this product. Live Voice has not been
  // started yet at this point, so a reload costs nothing but the boot.
  if (!(await page.locator(PANE).waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false))) {
    await page.reload();
  }
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('live-voice-button').click();
  await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => phase(page), { timeout: 25_000 }).toBe('listening');
  // Segmented mode is the premise of the whole replay: the server must have declared it.
  await syncTo(ctx, from, 'the server declared segmented relay (ready{segmented-v1})', () =>
    ctx.frames.slice(from).some((frame) => frame.type === 'ready' && frame.protocol === 'segmented-v1'),
  );
}

/** The branch's settled state: the upstream bookkeeping every leg reads. */
function settle(
  ctx: Ctx,
  sessionId: string,
  from: number,
  clientFramesFrom: number,
  warningsFrom: number,
  commitsFrom: number,
  dialsBefore: number,
  dialFaults: ScriptedDialFaults[],
  snapshots: Record<string, Snapshot>,
): BranchRecording {
  const headers = ctx.upstream.upgradeHeaders().slice(dialsBefore);
  return {
    sessionId,
    commits: ctx.upstream.commitCount() - commitsFrom,
    dials: ctx.upstream.dialed() - dialsBefore,
    dialFaults,
    dialHosts: headers.map((header) => String(header.host ?? '')),
    authorizationHeaderSeen: headers.some((header) => Object.keys(header).some((key) => key.toLowerCase() === 'authorization')),
    browserFrames: ctx.frames.slice(from),
    sentMessages: ctx.frames
      .slice(from)
      .filter((frame) => frame.type === 'sent')
      .map((frame) => String(frame.message ?? '')),
    upstreamClientFrames: ctx.upstream.clientFrames().slice(clientFramesFrom),
    consoleWarnings: ctx.warnings.slice(warningsFrom),
    snapshots,
  };
}

/** Leaves Live Voice the way a person does, so the next branch starts from a clean page. */
async function exitVoice(ctx: Ctx): Promise<void> {
  await ctx.page.getByTestId('voice-realtime-end').click();
  await expect(ctx.page.locator(BAR)).toHaveCount(0, { timeout: 15_000 });
  await expect(ctx.page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
  await ctx.page.locator(COMPOSER_TEXTAREA).fill('');
}

// ---------------------------------------------------------------------------------------------
// Variant 双断线.
// ---------------------------------------------------------------------------------------------

async function replayDoubleDrop(ctx: Ctx, sessionId: string): Promise<BranchRecording> {
  const { page, upstream } = ctx;
  const dialsBefore = upstream.dialed();
  // Which endpoint this branch dials: the plain script, never the protocol machine — the plan's
  // drops are what this branch is about, and a machine answering the commits would answer the very
  // commit dial #1 must leave unanswered.
  upstream.armProtocol(null);
  upstream.armFaults(DOUBLE_DROP_PLAN);
  const framesFrom = ctx.frames.length;
  const clientFramesFrom = upstream.clientFrames().length;
  const warningsFrom = ctx.warnings.length;
  const commitsFrom = upstream.commitCount();
  const dialFaults: ScriptedDialFaults[] = [];
  const snapshots: Record<string, Snapshot> = {};

  await enterVoice(ctx, sessionId, framesFrom);

  // ---- seq0 — heard, never relayed: a caption row of its own, no delivery.
  await utter(ctx);
  await upstream.script([
    { wire: audioCommitted('DD_0'), afterMs: 120 },
    { wire: userItemCreated('DD_0', null), afterMs: 1 },
    { wire: captionCompleted('DD_0', S0), afterMs: 140 },
  ]);
  await waitCaption(ctx, framesFrom, 'DD_0');

  // ---- seq1 — heard, NEVER relayed. This is deliberate, and it is the one thing in the branch that
  // must not happen before the drop.
  //
  // A relayed segment makes the app run `session_send` and return the result as a tool output, and the
  // endpoint acknowledges a tool output with `response.done` — the ONE upstream event that makes the
  // bridge let go of the segment it is holding (`committedSegment`, `dispatch`). The app RE-SENDS a
  // tool output it never saw acknowledged, so a relay before the drop puts a `response.done` onto the
  // RECONNECT as well — one landing after dial #2's replay would clear the anchor and leave dial #3
  // with nothing to write, which is exactly the "single drop" this criterion is not about. Measured
  // 2026-10-13: with a relayed seq1 the branch collapsed at dial #2.
  await utter(ctx);
  await upstream.script([
    { wire: audioCommitted('DD_1', 'DD_0'), afterMs: 120 },
    { wire: userItemCreated('DD_1', 'DD_0'), afterMs: 1 },
    { wire: captionCompleted('DD_1', S1), afterMs: 140 },
  ]);
  await waitCaption(ctx, framesFrom, 'DD_1');

  // ---- seq2 — the commit dial #1 never answers (the plan's `dropBeforeCommit`).
  await utter(ctx);
  // The plan entry for the dial that just happened. Read BEFORE the drop, so a plan that never
  // reached the upstream reads as its own failure rather than as a missing drop.
  const dial1 = upstream.dialFaults();
  dialFaults.push(dial1);
  expect(dial1, "dial #1's entry in the armed plan").toEqual({ dropBeforeCommit: 3 });
  expect(upstream.dialed() - dialsBefore, "the plan's first entry belongs to this branch's first dial").toBe(1);
  upstream.drop();
  // The commit died with the socket: UNCERTAIN, and the page is told so before the reconnect.
  await syncTo(ctx, framesFrom, 'seq2 reported written (uncertain) after the first drop', () =>
    verdictsFor(ctx, framesFrom, 2).includes('written'),
  );


  // ---- dials #2 and #3 — the replay is written, the endpoint says nothing, the socket dies 1.15 s later.
  for (const dial of [2, 3] as const) {
    await syncTo(ctx, framesFrom, `dial #${dial}`, () => upstream.dialed() - dialsBefore >= dial);
    const entry = upstream.dialFaults();
    dialFaults.push(entry);
    const budget = entry.dropAfterCommitMs;
    expect(budget, `dial #${dial}'s entry says when this dial dies`).toEqual({ ordinal: 1, ms: 1150 });
    // The replay is the ONLY commit this dial writes, and the observer stamps it with the dial it
    // arrived on — see `Ctx.commitDials` for why the counter cannot answer this question.
    const thisDial = dialsBefore + dial;
    await syncTo(ctx, framesFrom, `dial #${dial}'s replayed commit reached the endpoint (commits on dials ${JSON.stringify(ctx.commitDials)})`, () =>
      ctx.commitDials.includes(thisDial),
    );
    // fixed-wait: THE PLAN'S OWN MILLISECOND COUNT — the journal's second CONNECTION_LOST, 1.15 s
    // after the first. Not a settle: the drop is a duration the fault plan names, so the wait is read
    // off the plan rather than guessed.
    await page.waitForTimeout(budget.ms);
    upstream.drop();
    await syncTo(ctx, framesFrom, `the verdict for seq2 after dial #${dial}`, () =>
      verdictsFor(ctx, framesFrom, 2).length >= dial,
    );
  }

  // ---- dial #4 — ordinary, and the dial where the replay budget is spent.
  await syncTo(ctx, framesFrom, 'dial #4', () => upstream.dialed() - dialsBefore >= 4);
  dialFaults.push(upstream.dialFaults());
  expect(upstream.dialFaults(), 'dial #4 of the plan is an ordinary dial').toEqual({});
  await syncTo(ctx, framesFrom, 'seq2 reported lost(upstream-drop) — the replay budget is spent', () =>
    verdictsFor(ctx, framesFrom, 2).includes('lost:upstream-drop'),
  );
  snapshots.afterGiveUp = await snapshot(page);

  // ---- seq3, seq4, seq5 — spoken after the bridge gave up on seq2, each answered normally.
  const after: Array<{ item: string; text: string; relay: string | null }> = [
    { item: 'DD_3', text: S3, relay: null },
    { item: 'DD_4', text: S4, relay: null },
    { item: 'DD_5', text: S5, relay: S5_RELAYED },
  ];
  for (const entry of after) {
    const from = ctx.frames.length;
    await utter(ctx);
    const events: ScriptedEndpointEvent[] = [
      { wire: audioCommitted(entry.item), afterMs: 120 },
      { wire: userItemCreated(entry.item, null), afterMs: 1 },
      { wire: captionCompleted(entry.item, entry.text), afterMs: 140 },
    ];
    if (entry.relay !== null) {
      events.push({ wire: responseCreated('resp_dd_5'), afterMs: 90 });
      events.push({ wire: functionCall('session_send', { message: entry.relay }, 'call_dd_5'), afterMs: 120 });
    }
    await upstream.script(events);
    await waitCaption(ctx, from, entry.item);
    if (entry.relay !== null) {
      await waitFrame(ctx, from, 'sent');
      // `sent` is a frame on the WIRE and this recording reads the wire out-of-process, so it says
      // nothing about the DOM: the row the app opened for the relay keeps `voice-row-delivering` until
      // the delivered message is `shown`. Exit inside that window and the closing snapshot catches the
      // just-delivered row still carrying the merged caption words of the utterances it was built from
      // — a `testid !== null` row, not a real one (the sibling spec measured this, 2/2 runs).
      await waitRealRow(ctx, entry.relay);
    }
  }
  snapshots.beforeExit = await snapshot(page);
  await exitVoice(ctx);
  snapshots.afterExit = await snapshot(page);

  return settle(ctx, sessionId, framesFrom, clientFramesFrom, warningsFrom, commitsFrom, dialsBefore, dialFaults, snapshots);
}

// ---------------------------------------------------------------------------------------------
// Variant V-fatal: the connection is terminated for good.
// ---------------------------------------------------------------------------------------------

async function replayPermanentDisconnect(ctx: Ctx, sessionId: string): Promise<BranchRecording> {
  const { page, upstream } = ctx;
  const dialsBefore = upstream.dialed();
  upstream.armProtocol(null);
  upstream.armFaults(V_FATAL_PLAN);
  const framesFrom = ctx.frames.length;
  const clientFramesFrom = upstream.clientFrames().length;
  const warningsFrom = ctx.warnings.length;
  const commitsFrom = upstream.commitCount();
  const dialFaults: ScriptedDialFaults[] = [];
  const snapshots: Record<string, Snapshot> = {};

  await enterVoice(ctx, sessionId, framesFrom);

  // ---- seq0 — the last segment the endpoint answers.
  await utter(ctx);
  await upstream.script([
    { wire: audioCommitted('PF_0'), afterMs: 120 },
    { wire: userItemCreated('PF_0', null), afterMs: 1 },
    { wire: captionCompleted('PF_0', S0), afterMs: 140 },
  ]);
  await waitCaption(ctx, framesFrom, 'PF_0');

  // ---- the endpoint stops answering: every dial after this one is refused, and this socket dies.
  const armed = upstream.faults();
  expect(armed, 'the upstream holds the plan this branch armed').toEqual(V_FATAL_PLAN);
  const refusals = (armed?.dials ?? []).filter((dial) => dial.disposition?.action === 'refuse').length;
  expect(refusals, 'the plan refuses the dials after the first').toBeGreaterThanOrEqual(2);
  // Read this branch's OWN first dial off the armed plan. `dialFaults()` would index the plan by the
  // GLOBAL dial counter, which by this point in the run already stands past the plan's four entries.
  dialFaults.push(armed?.dials[0] ?? {});
  upstream.refuseDials(refusals);
  upstream.drop();

  await syncTo(ctx, framesFrom, 'the bridge settled closed (state frame)', () =>
    ctx.frames.slice(framesFrom).some((frame) => frame.type === 'state' && frame.state === 'closed'),
  );
  expect(upstream.dialed() - dialsBefore, 'the refused dials really happened').toBeGreaterThanOrEqual(2);
  // The bar's own reading, taken BEFORE the post-close segments arm their stall windows: the page
  // socket is still open, so the `state: closed` frame is the only sign the page has, and it must be
  // enough for the bar to say so and offer a way back.
  await syncTo(ctx, framesFrom, 'the bar reads the disconnected state', async () => {
    const snap = await snapshot(page);
    return snap.status === DISCONNECTED_LABEL && snap.retry;
  });
  snapshots.disconnected = await snapshot(page);
  // Once the disconnect is on screen the endpoint can be cleared, so the branch leaves no armed
  // refusal behind for anything that follows it.
  upstream.refuseDials(0);

  // ---- the words spoken AFTER the connection terminated: marked not sent, not retried, not lost upstream.
  for (const seq of [1, 2, 3] as const) {
    await utterOnDeadBridge(ctx, framesFrom, seq);
  }
  snapshots.afterClosedSpeech = await snapshot(page);
  await exitVoice(ctx);
  snapshots.afterExit = await snapshot(page);

  return settle(ctx, sessionId, framesFrom, clientFramesFrom, warningsFrom, commitsFrom, dialsBefore, dialFaults, snapshots);
}

// ---------------------------------------------------------------------------------------------
// Readings shared by the legs.
// ---------------------------------------------------------------------------------------------

const framesOfType = (rec: BranchRecording, type: string): BrowserFrame[] =>
  rec.browserFrames.filter((frame) => frame.type === type);

/** The verdicts one `seq` was given in this branch, as `<state>` or `<state>:<reason>` labels. */
const verdictsSince = (frames: BrowserFrame[], seq: number): string[] =>
  frames
    .filter((frame) => frame.type === 'segment_ack' && frame.seq === seq)
    .map((frame) => (frame.reason === undefined ? String(frame.state) : `${frame.state}:${frame.reason}`));

const verdictsFor = (ctx: Ctx, from: number, seq: number): string[] => verdictsSince(ctx.frames.slice(from), seq);
const verdictsIn = (rec: BranchRecording, seq: number): string[] => verdictsSince(rec.browserFrames, seq);

/** The final captions the page received, as `<itemId>=<seq>` — the attribution reading. */
const captionSeqs = (rec: BranchRecording): string[] =>
  rec.browserFrames
    .filter((frame) => frame.type === 'caption' && frame.final === true)
    .map((frame) => `${String(frame.itemId)}=${String(frame.seq)}`);

/** The index of the row this criterion reads, or -1. A row is named by its text or its own marker. */
const indexOfRow = (snap: Snapshot, match: (row: Row) => boolean): number => snap.rows.findIndex(match);

/** The graded-outcome rows of one branch, in transcript order. */
const outcomeRows = (snap: Snapshot): Row[] => snap.rows.filter((row) => row.testid === 'voice-row-segment-outcome');

/** The index of the first row whose words contain `text` (real or caption), or -1. */
const rowIndexOf = (snap: Snapshot, text: string): number =>
  snap.rows.findIndex((row) => row.style === 'user' && normalize(row.text).includes(normalize(text)));

// ---------------------------------------------------------------------------------------------

test.describe('voice realtime double drop (GOAL-043 / AC-368)', () => {
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
    // This run's own throwaway data dir (the fixture home lives directly under it), so the cache can
    // never be read by a different run. The cache is what keeps a red leg's worker restart from
    // re-driving two real-browser branches and blowing the criterion's 100 s reading.
    const dataDir = path.dirname(fixtureHome);
    const cacheFile = path.join(dataDir, 'double-drop.recording.json');
    if (existsSync(cacheFile)) {
      recording = JSON.parse(readFileSync(cacheFile, 'utf8')) as Recording;
      return;
    }

    const upstream = await startScriptedUpstream(upstreamPort);
    // Stamp every commit with the dial it arrived on, at ARRIVAL. See `Ctx.commitDials`.
    const commitDials: number[] = [];
    upstream.onClientFrame((frame) => {
      if (frame.type === 'input_audio_buffer.commit') commitDials.push(upstream.dialed());
    });
    const workspacePath = path.join(fixtureHome, 'voice-realtime-workspace');
    const workspaceName = path.basename(workspacePath);
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    const api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    const sessionDrop = await armScenario(api, workspacePath, scenario('Voice double drop'));
    const sessionFatal = await armScenario(api, workspacePath, scenario('Voice permanent disconnect'));

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
    // THE BROWSER HALF OF "ZERO CLOUD CALLS". Every request the page makes is inspected; a non-loopback
    // one is BLOCKED (so nothing leaves the browser) and recorded. Registered on the CONTEXT (before the
    // page exists), so it also covers any request the page makes before this file's own handlers attach.
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
          frames.push(JSON.parse(text) as BrowserFrame);
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
    await revealSession(page, workspaceName, sessionDrop);

    const ctx: Ctx = { page, upstream, frames, warnings, commitDials };
    try {
      const doubleDrop = await replayDoubleDrop(ctx, sessionDrop);
      const permanent = await replayPermanentDisconnect(ctx, sessionFatal);
      recording = { doubleDrop, permanent, browserEgress };
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(recording, null, 2));
      if (process.env.QUAY_DOUBLE_DROP_DUMP) {
        writeFileSync(process.env.QUAY_DOUBLE_DROP_DUMP, JSON.stringify(recording, null, 2));
      }
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await api.dispose();
      await upstream.close();
    }
  });

  // ------------------------------- the run itself (green) -------------------------------

  test('the run was segmented, on the local scripted upstream, with no cloud credential', () => {
    // WHERE THE DIAL WENT is the `.env`-independent half of "no cloud call". The blank credential rides
    // on the config's `envFreeServerRoot`; the dial target is a property of this run — the endpoint is
    // the loopback stand-in the spec itself bound.
    const standInHost = `127.0.0.1:${process.env.QUAY_E2E_VOICE_REALTIME_PORT}`;
    const branches = [recording.doubleDrop, recording.permanent];
    for (const rec of branches) {
      expect(rec.browserFrames.some((f) => f.type === 'ready' && f.protocol === 'segmented-v1'), 'ready{segmented-v1}').toBe(true);
      expect(rec.dialHosts.length, `the app never dialled the stand-in for session ${rec.sessionId}`).toBeGreaterThanOrEqual(1);
      expect(rec.dialHosts.filter((host) => host !== standInHost), `dials that left ${standInHost}`).toEqual([]);
      expect(rec.authorizationHeaderSeen, 'the upstream dial carried a credential').toBe(false);
    }
    // The double-drop branch is the whole point, and the count is exact: six segments the person spoke
    // (seq0–seq5) plus the two replays the bridge wrote of seq2 on dials #2 and #3. Nothing else in the
    // branch commits, so a missing replay or a stray extra one is a reading, not a rounding.
    expect(recording.doubleDrop.commits, `the double-drop branch's commits: ${JSON.stringify(recording.doubleDrop.dialFaults)}`).toBe(8);
    // ...and the terminal branch drove at least the refused redial its plan describes.
    expect(recording.permanent.dials, 'the permanent-disconnect branch redialled into the refusals').toBeGreaterThanOrEqual(3);
  });

  test("nothing left the loopback: zero server dials and no non-local browser request beyond the page's own chrome", () => {
    // ---- the server: the egress guard's log ----
    const egressLog = process.env.QUAY_E2E_VOICE_REALTIME_EGRESS_LOG;
    expect(egressLog, 'playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_EGRESS_LOG for this selection').toBeTruthy();
    // The guard CREATES the file (empty) as it installs, so the file EXISTING is the proof it was live in
    // the server. Without that, an empty `readFileSync` below would be a vacuous pass rather than a
    // zero-egress reading.
    expect(existsSync(egressLog!), `the server egress guard never loaded (no ${egressLog})`).toBe(true);
    const serverEgress = readFileSync(egressLog!, 'utf8').split('\n').filter(Boolean);
    expect(serverEgress, `the server dialled out of the loopback:\n${serverEgress.join('\n')}`).toEqual([]);

    // ---- the browser: every non-local request, all of them blocked by the context route ----
    // Non-vacuity first: an empty list is only a reading if the route really saw traffic.
    expect(
      recording.browserEgress.length,
      'the browser outbound route recorded nothing at all — it cannot certify an absent non-local request',
    ).toBeGreaterThan(0);
    const strayHosts = [...new Set(recording.browserEgress.map((url) => new URL(url).host))].filter((host) => !CHROME_HOSTS.has(host));
    expect(strayHosts, `a non-local browser request outside the page's own chrome: ${strayHosts.join(', ')}`).toEqual([]);
    console.log(
      `[egress] browser non-local requests: ${recording.browserEgress.length} ` +
        `(${[...new Set(recording.browserEgress.map((url) => new URL(url).host))].sort().join(', ')})`,
    );

    // ---- the server's own environment, source and behaviour ----
    const configSource = readFileSync(path.resolve(process.cwd(), 'playwright.config.ts'), 'utf8');
    const voiceEnvSpread = configSource.slice(configSource.indexOf('...(voiceRealtimeSelection'));
    expect(voiceEnvSpread, 'the cloud credential must be blanked on this selection').toContain("DASHSCOPE_API_KEY: ''");
    expect(configSource, 'the debug agent must stand in for Claude on this selection').toContain("DEBUG_AGENT: '1'");
    const debugAgentList = configSource.slice(configSource.indexOf('const DEBUG_AGENT_SPEC_FILES'));
    expect(
      debugAgentList.slice(0, debugAgentList.indexOf('];')),
      'this criterion must be one of the debug-agent selections',
    ).toContain('voice-realtime-double-drop.spec.ts');
    // BEHAVIOURAL: the turns really came from the debug agent's scenario engine.
    expect(
      realRowWith(recording.doubleDrop.snapshots.beforeExit!, 'seeded turn for Voice double drop').length,
      "the replayed transcript is not the debug agent scenario engine's",
    ).toBeGreaterThanOrEqual(1);
  });

  // ------------------------------- variant 双断线 -------------------------------

  test('the double drop: seq2 is reported lost(upstream-drop) and shown as never delivered, not as unrecognized', () => {
    const rec = recording.doubleDrop;
    // The ladder, read off the wire: the commit that died with the first socket is UNCERTAIN, the two
    // replays that died with their sockets are UNCERTAIN again, and only the FOURTH dial — the one with
    // nothing left to replay — reports the segment lost. Four verdicts, one per dial, latest wins.
    expect(
      verdictsIn(rec, 2),
      'the verdicts seq2 was given, one per dial that carried it',
    ).toEqual(['written', 'written', 'written', 'lost:upstream-drop']);

    const snap = rec.snapshots.afterGiveUp!;
    const rows = outcomeRows(snap);
    expect(rows, `graded-outcome rows on screen: ${JSON.stringify(snap.rows)}`).toHaveLength(1);
    const row = rows[0]!;
    expect(row.outcomeState, 'the row is the terminal lost verdict').toBe('lost');
    expect(row.outcomeReason, 'the reason names the replay budget, not the connection').toBe('upstream-drop');
    expect(row.outcomeSeq, "the row says WHICH of the person's sentences this was").toBe('2');
    // AC-367's copy, verbatim — the DoD asks that the page's words match that criterion.
    expect(row.text, 'the row copy').toBe(LOST_UPSTREAM_COPY);
    // AC-367 (b): a segment that was never transcribed is NOT the not-recognised row. That row is the
    // endpoint's honest "I was asked and reported no words" — an answer about a different event.
    expect(
      snap.rows.filter((candidate) => candidate.testid === 'voice-row-unrecognized'),
      'a lost segment was shown as not recognized',
    ).toEqual([]);
  });

  test('the segments spoken after the drop are each attributed to their own seq, in spoken order', () => {
    const rec = recording.doubleDrop;
    // WIRE: one final caption per segment that produced words, each on the seq that segment was spoken
    // as — and NOTHING for seq2, whose commit never reached an endpoint that answered it.
    expect(captionSeqs(rec)).toEqual(['DD_0=0', 'DD_1=1', 'DD_3=3', 'DD_4=4', 'DD_5=5']);

    // PAGE: the same five sentences stand as their own rows, in the order they were spoken, with the
    // lost segment's row between seq1's and seq3's — the position seq2's words would have occupied.
    const order = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;
    const text = { S0, S1, S2, S3, S4, S5 };
    const positions = order.map((key) =>
      key === 'S2'
        ? indexOfRow(rec.snapshots.beforeExit!, (row) => row.testid === 'voice-row-segment-outcome')
        : key === 'S5'
          ? indexOfRow(rec.snapshots.beforeExit!, (row) => row.testid === null && normalize(row.text).includes(normalize(S5_RELAYED)))
          : rowIndexOf(rec.snapshots.beforeExit!, text[key]),
    );
    const rows = JSON.stringify(rec.snapshots.beforeExit!.rows);
    expect(positions.every((index) => index >= 0), `not every sentence has a row of its own: ${rows}`).toBe(true);
    expect(positions, `row indices of S0,S1,seq2,S3,S4,S5 in ${rows}`).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size, `the six readings must be six different rows: ${rows}`).toBe(6);
    // The sentences that produced words on screen are the person's own heard rows — only the relayed
    // seq5 was replaced by a delivered message, and the lost seq2 has no words of its own to show.
    for (const spoken of [S0, S1, S3, S4]) {
      const index = rowIndexOf(rec.snapshots.beforeExit!, spoken);
      expect(rec.snapshots.beforeExit!.rows[index]!.testid, `"${spoken}" row state: ${rows}`).toBe('voice-row-heard');
    }
  });

  test('the round delivers at most once: the replayed segment reaches Claude zero times, the relayed one once', () => {
    const rec = recording.doubleDrop;
    // AT-ONCE, READ AS AN EXACT LIST. Six segments were spoken and TWO writes of seq2 went upstream
    // (the original, then the replay) across three socket deaths — and the endpoint answered neither,
    // so nothing about seq2 may appear on the delivery channel. Exactly one segment was relayed. An
    // exact list is what makes "at most once" a reading rather than an absence: a duplicate delivery,
    // a delivery of the lost segment, or a delivery of a segment nobody relayed each change it.
    expect(rec.sentMessages, 'every delivery the app announced, in order').toEqual([S5_RELAYED]);
    // The three sentences spoken after the drop were heard and never relayed, so they stay captions:
    // a real row for any of them would mean words reached the model that no endpoint ever answered
    // for. seq5's relayed text IS the real row, which is what a delivery looks like on this page.
    const snap = rec.snapshots.beforeExit!;
    expect(realRowWith(snap, S5_RELAYED).length, 'the relayed segment is on screen as a delivered row').toBeGreaterThanOrEqual(1);
    for (const unrelayed of [S0, S1, S2, S3, S4]) {
      for (const real of realRowWith(snap, unrelayed)) {
        expect(
          normalize(real.text).includes(normalize(S5_RELAYED)),
          `"${unrelayed}" reached Claude as part of a delivered row: ${real.text}`,
        ).toBe(false);
      }
    }
  });

  // ------------------------------- variant V-fatal -------------------------------

  test('the permanent disconnect: the bar says the connection is gone and offers the way back', () => {
    const snap = recording.permanent.snapshots.disconnected!;
    expect(snap.status, `the status slot read ${JSON.stringify(snap.status)}`).toBe(DISCONNECTED_LABEL);
    expect(snap.phase, 'the bar is not in a failure phase — this is a disconnect, not an error').not.toBe('failed');
    expect(snap.retry, 'a disconnected bar must offer the way back').toBe(true);
  });

  test('the permanent disconnect: the words spoken after it are marked not sent — not retried, not lost upstream', () => {
    const rec = recording.permanent;
    // One verdict per segment spoken onto the dead bridge, and all three carry the SAME reason: nothing
    // was ever written for them (the connection was not open), which is a different fact from seq2's
    // spent replay budget in the branch above.
    for (const seq of [1, 2, 3] as const) {
      expect(verdictsIn(rec, seq), `the verdict for seq ${seq}`).toEqual(['lost:connection-closed']);
    }
    // Nothing was written upstream after the drop, so nothing can have been delivered.
    expect(rec.sentMessages, 'a dead connection delivered something').toEqual([]);

    const snap = rec.snapshots.afterClosedSpeech!;
    const rows = outcomeRows(snap);
    // THE THREE SPOKEN ONTO THE DEAD BRIDGE, selected by seq. There is a FOURTH outcome row and it is
    // not a contradiction: seq0 was spoken and committed BEFORE the close, and the refused redials
    // spend its replay budget, so seq0 is `lost:upstream-drop` — the pre-close loss, the same fate
    // variant A's seq2 meets. The AC's reading is the speech after the disconnect, which is what the
    // seq filter isolates; seq0 is asserted on its own line below so the count is explained, not hidden.
    const postClose = rows.filter((row) => ['1', '2', '3'].includes(String(row.outcomeSeq)));
    expect(
      rows.map((row) => `${row.outcomeSeq}:${row.outcomeReason}`).sort(),
      `graded-outcome rows on screen: ${JSON.stringify(snap.rows)}`,
    ).toEqual(['0:upstream-drop', '1:connection-closed', '2:connection-closed', '3:connection-closed']);
    expect(postClose, 'one row per segment spoken after the close').toHaveLength(3);
    for (const row of postClose) {
      expect(row.outcomeState, 'the row is a terminal lost verdict').toBe('lost');
      expect(row.outcomeReason, 'the reason is the closed connection, not the replay budget').toBe('connection-closed');
      expect(row.text, 'the row copy').toBe(LOST_CONNECTION_COPY);
    }
    expect(
      snap.rows.filter((candidate) => candidate.testid === 'voice-row-unrecognized'),
      'a lost segment was shown as not recognized',
    ).toEqual([]);
  });
});
