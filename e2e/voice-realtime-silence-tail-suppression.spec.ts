/**
 * Silence Tail Suppression, read off a real browser, the real proxy and a stand-in endpoint.
 *
 * WHY THIS SPEC EXISTS. The in-process criterion
 * (`server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts`) proves the
 * upload state machine's arithmetic against a corpus it feeds by hand — it can step a clock, name the
 * exact frame a transition lands on, and falsify the module by mutating it. What it cannot show is
 * that the machine is wired into the wire: that a person going quiet in front of a microphone makes
 * the appends STOP, that the socket stays up while they do, and that the audio withheld during the
 * pause is what the endpoint hears when the person speaks again. Those are readings of the product, so
 * they have to be taken on the product.
 *
 * WHAT THE READING IS. One timeline, played through the app's own capture path in real time: a short
 * spoken run, three seconds of digital silence, then a second spoken run. The stand-in endpoint stamps
 * every `input_audio_buffer.append` the moment it arrives, so the WIRE's own timeline is the
 * observable — not the gate's internal state, not a log line about it. Three facts are read off it:
 *
 *  · the uploads STOP — there is a gap between two consecutive appends far longer than the capture
 *    cadence, and it cannot be shorter than the tail `T` (a relay that dropped one frame would show a
 *    gap of one cadence, which this reading would not mistake for suppression);
 *  · the uploads RESUME with the pre-roll — the appends after the gap arrive as a burst, because the
 *    suppressed frames are flushed out of the ring in one synchronous loop rather than at the
 *    cadence; a relay that merely dropped the quiet frames could never produce it;
 *  · the ENDPOINT never had its session torn down — there is no commit, no `response.create`, and the
 *    same connection carries the appends after the episode (a socket that had closed could not).
 *
 * The journal's structured `silence_tail` entries are read beside the wire, so the state machine's own
 * account of the episode and the endpoint's experience of it can be compared to each other.
 *
 * WHY IT IS THE SOLE SELECTION IT RUNS UNDER. Suppression only exists on the CONTINUOUS wire (the
 * segmented relay cuts the audio into committed segments, and there is nothing to suppress between
 * them), and `VOICE_REALTIME_MODE` is a property of the SERVER process, which serves the whole run —
 * so `playwright.config.ts` arms `continuous` only when this file is the entire selection and
 * publishes `QUAY_E2E_VOICE_REALTIME_MODE` for the check at the top of `beforeAll` below. The feature
 * is OFF BY DEFAULT (decision doc §10.5 H-S2), so the config also arms
 * `VOICE_REALTIME_SILENCE_TAIL` for this selection and for no other: `voice-realtime-continuous-*
 * experience.spec.ts` measures the same server without the gate, and arming it there would change the
 * baseline that criterion exists to take.
 *
 * NOTHING LEAVES THE MACHINE. The browser aborts every non-loopback request, the app server runs under
 * the AC-360 egress guard preloaded by `playwright.config.ts`, and the stand-in endpoint records the
 * dial and the handshake headers. The last case reads all three.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  fakeMicFrames,
  fakeMicPushed,
  installFakeMic,
  playFakeMic,
  type FakeMicSegment,
} from './voiceRealtimeFakeMic';
import { startScriptedUpstream, type ScriptedUpstreamServer } from './voiceRealtimeScriptedUpstream';

// ── the page's own vocabulary, copied from the sibling voice specs ────────────────────────────────
const PANE = '.chat-messages-pane';
const BAR = '[data-testid="voice-realtime-bar"]';
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';

const USERNAME = 'voice-silence-tail-e2e';
const PASSWORD = 'voice-silence-tail-e2e-pass';
const TITLE = 'silence tail suppression e2e';
const SEED_USER_TEXT = 'seeded turn for the silence-tail reading';

/** How long the spoken runs at either end of the timeline last. Long enough for the 3-frame onset. */
const SPEECH_MS = 600;
/**
 * The quiet stretch in the middle. THREE SECONDS, and the size is load-bearing in both directions: it
 * is several times the shipped tail `T` (1 s) — so a relay that uploaded the whole pause would show a
 * gap of one cadence and this reading would not call it suppression — and it is well inside the
 * endpoint's own idle patience, so a socket that stayed open for the whole episode is the product's
 * doing rather than the endpoint's tolerance.
 */
const SILENCE_MS = 3_000;

/**
 * The timeline. Speech, a long quiet stretch, speech.
 *
 * `voiceRealtimeFakeMic.ts` renders it to shaped PCM and pushes one 100 ms frame per tick, so the app
 * receives the audio while it is streaming — which is the only way a silence can be observed as a
 * duration rather than as a missing burst. The middle segment is DIGITAL ZERO: the question this file
 * asks is what the relay does with a person who has stopped talking, and a shaped background floor
 * would be asking it about the detector's noise-floor estimate instead.
 */
const TIMELINE: readonly FakeMicSegment[] = [
  { kind: 'speech', seconds: SPEECH_MS / 1000, label: '第一句：把 server 的日志贴出来' },
  { kind: 'silence', seconds: SILENCE_MS / 1000, label: '长静音 3.0 s —— 远长于 tail T = 1 s' },
  { kind: 'speech', seconds: SPEECH_MS / 1000, label: '第二句：不对，改成跑 lint' },
];

/**
 * The smallest gap between two consecutive uploads that may be called suppression.
 *
 * The capture cadence is 100 ms, so a healthy relay's largest gap is the cadence itself; a relay that
 * dropped a frame is one cadence, a relay that dropped a second is two. `T` is 1 s and `T` is the
 * SHORTEST possible suppressed window — the tail is uploaded in full before the gate closes — so
 * anything at or above the tail can only be the gate. The reading still asserts the gap it actually
 * saw rather than this floor, so the number quoted below is measured, not assumed.
 */
const MIN_SUPPRESSION_GAP_MS = 1_000;

/**
 * The window a burst is counted in: the pre-roll flush happens inside ONE call to the gate's
 * `observe`, which the proxy drains in one synchronous `for` loop, so the flushed frames reach the
 * endpoint within a few milliseconds of each other. The following streamed frame is 100 ms behind
 * them, so a window of 50 ms counts the flush and nothing else.
 */
const FLUSH_WINDOW_MS = 50;
/** The smallest flush that is evidence of a ring rather than of a lucky pair of frames. */
const MIN_FLUSH_FRAMES = 5;

/** How long the reading waits for the resumed transition to reach the journal. */
const JOURNAL_TIMEOUT_MS = 20_000;

// ── fixture helpers, copied from the sibling voice specs (there is no shared module for these) ─────
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
  const sessionId = body?.data?.sessionId;
  if (!response.ok() || typeof sessionId !== 'string') {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  return sessionId;
}

const projectRow = (page: Page, workspaceName: string) =>
  page
    .getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
    .first();

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

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

/** Enters Live Voice and waits for the bar to have replaced the composer. */
async function enterLiveVoice(page: Page): Promise<void> {
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
  const entry = page.getByTestId('live-voice-button');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
}

// ── the journal: one file per browser connection, selected by its own header ──────────────────────
type JournalEntry = Record<string, unknown>;

/**
 * Every journal line belonging to `sessionId`'s connection, verbatim.
 *
 * THE FILE IS SELECTED BY ITS HEADER, NOT THE LINES BY THEIR TEXT. `voice-realtime-log.ts` writes one
 * file per BROWSER CONNECTION and puts the session on exactly one entry — the `connection` header,
 * written first. Every later entry is keyed by `connectionId` alone, so a reader that asked "which
 * lines mention this session?" would keep the header and drop every `silence_tail` entry with it, and
 * would then report, in perfect silence, that the gate never ran.
 */
function readJournal(dir: string, sessionId: string): JournalEntry[] {
  if (!existsSync(dir)) return [];
  const entries: JournalEntry[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    const rows = readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    if (rows.length === 0) continue;
    let header: { kind?: unknown; sessionId?: unknown };
    try {
      header = JSON.parse(rows[0]!) as { kind?: unknown; sessionId?: unknown };
    } catch {
      // A file whose first line is not JSON is not a connection journal this build wrote.
      continue;
    }
    if (header.kind === 'connection' && header.sessionId === sessionId) {
      for (const row of rows) entries.push(JSON.parse(row) as JournalEntry);
    }
  }
  return entries;
}

/**
 * The `turn_detection.type` the app advertised in its `session.update`, or null before it sent one.
 *
 * This is the wire's own declaration of which relay is running: `server_vad` means the endpoint
 * segments the audio itself, which is the continuous path and the only one Silence Tail Suppression
 * exists on. Read off the frame the app really sent, so it cannot be satisfied by an assumption about
 * the deployment's mode.
 */
function turnDetectionOf(upstream: ScriptedUpstreamServer): string | null {
  const update = upstream.clientFrames().find((frame) => frame.type === 'session.update') as
    | { session?: { turn_detection?: { type?: unknown } } }
    | undefined;
  const type = update?.session?.turn_detection?.type;
  return typeof type === 'string' ? type : null;
}

/** The gate's own account of the episode: the `silence_tail` entries, in file order. */
const silenceTailEntries = (entries: JournalEntry[]): JournalEntry[] =>
  entries.filter((entry) => entry.kind === 'silence_tail');

/** The gap between two consecutive arrival stamps, for the pairs `gaps()` returns. */
function gaps(stamps: readonly number[]): Array<{ index: number; ms: number }> {
  const out: Array<{ index: number; ms: number }> = [];
  for (let index = 1; index < stamps.length; index += 1) {
    out.push({ index, ms: stamps[index]! - stamps[index - 1]! });
  }
  return out;
}

/** What one run of this spec left behind, every field a reading rather than a claim. */
type SilenceTailRun = {
  sessionId: string;
  /** The segments the page actually pushed, in order. */
  pushed: Array<{ kind: string; seconds: number; label: string }>;
  /** How many capture frames the page pushed — the non-vacuity floor for every reading below. */
  micFrames: number;
  /** WHEN each `input_audio_buffer.append` reached the endpoint, in the spec's own clock. */
  appendStamps: number[];
  /** Every frame type the endpoint received, in order. */
  upstreamFrameTypes: string[];
  /** The `turn_detection.type` the app advertised — `server_vad` is the continuous wire. */
  turnDetection: string | null;
  commits: number;
  declaredSegmented: boolean;
  /** The journal's entries for this session, parsed. */
  journalEntries: JournalEntry[];
  /** The gate's own `silence_tail` entries, in file order. */
  silenceTail: JournalEntry[];
  /** The journal's `connection` header — the mode the composition root resolved. */
  mode: string | null;
  phase: string;
  egress: {
    logExists: boolean;
    blocked: boolean;
    dials: number;
    liveConnections: number;
    authorizationSeen: boolean;
    refused: string[];
  };
  pageErrors: string[];
};

test.describe('live voice silence tail suppression (GOAL-044 / AC-364)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let run: SilenceTailRun;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');

    // The mode this server was started in. Suppression exists only on the continuous wire, so a run
    // that lost the arming would measure the segmented relay and report the absence of a suppression
    // episode that could never have happened — the one failure this spec must not make quietly.
    const mode = (process.env.QUAY_E2E_VOICE_REALTIME_MODE ?? '').trim();
    if (mode !== 'continuous') {
      throw new Error(
        'this spec measures the continuous wire, so it must be the ONLY selection: run ' +
          '`npx playwright test e2e/voice-realtime-silence-tail-suppression.spec.ts`. ' +
          `QUAY_E2E_VOICE_REALTIME_MODE was "${mode || '(unset)'}".`,
      );
    }

    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME');
    const upstreamPort = Number(process.env.QUAY_E2E_VOICE_REALTIME_PORT);
    if (!Number.isInteger(upstreamPort) || upstreamPort <= 0) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_VOICE_REALTIME_PORT for this selection');
    }

    const dataDir = path.dirname(fixtureHome);
    const journalDir = path.join(dataDir, 'voice-realtime-log');
    const egressLog = path.join(dataDir, 'egress.jsonl');

    // No detector is armed: this reading is about what the RELAY puts on the wire, so the endpoint's
    // opinion of the audio would only be a second, unrelated variable. `session.update` is still
    // answered (the scripted endpoint does that unconditionally), which is what the transport needs to
    // consider the session usable.
    const upstream = await startScriptedUpstream(upstreamPort);

    // The wire's own timeline. `onClientFrame` fires in the endpoint's process, synchronously with the
    // frame's arrival, so these stamps are the arrival order and spacing of the uploads themselves —
    // the one reading below that no part of the app can author.
    const appendStamps: number[] = [];
    upstream.onClientFrame((frame) => {
      if (frame.type === 'input_audio_buffer.append') appendStamps.push(Date.now());
    });

    const workspacePath = path.join(fixtureHome, 'voice-silence-tail-workspace');
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    const api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    try {
      const sessionId = await armScenario(api, workspacePath, {
        version: 1,
        dialect: 'claude',
        home: 'gate',
        transcript: { mode: 'per-row-jsonl' },
        seed: { title: TITLE, userText: SEED_USER_TEXT },
        // Nothing here sends into the session, so the walk is parked and its self-check is never
        // reached — the same shape `voice-realtime-scripted-scenarios.spec.ts` uses for the same
        // reason: a run that was never started cannot contradict this file's readings.
        steps: [{ at: 0, op: 'wait' }],
        expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
      });

      const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
      // THE BROWSER HALF OF "ZERO CLOUD CALLS": every non-loopback request is aborted before it
      // leaves, and the ones that were refused are collected so the reading can say the guard fired.
      const browserEgress: string[] = [];
      await context.route('**', (route) => {
        const url = route.request().url();
        if (/^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) return route.continue();
        browserEgress.push(url);
        return route.abort();
      });
      await context.addInitScript(
        ({ authToken }: { authToken: string }) => {
          window.localStorage.setItem('auth-token', authToken);
          window.localStorage.setItem('userLanguage', 'en');
          const preferences = { voiceEnabled: true };
          window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
          window.localStorage.setItem(
            'user-preferences',
            JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }),
          );
        },
        { authToken: token },
      );
      await installFakeMic(context, TIMELINE);

      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      // The wire's own declaration. The proxy tells the page which relay it negotiated in the frames
      // it sends back, and a segmented declaration would mean this reading was taken on a wire where
      // suppression does not exist — so the reading below is guarded by what the APP was told, not by
      // what this file asked for.
      const browserFrames: Array<Record<string, unknown>> = [];
      page.on('websocket', (socket) => {
        if (!socket.url().includes('/voice-realtime')) return;
        socket.on('framereceived', (frame) => {
          try {
            const payload = frame.payload;
            const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
            browserFrames.push(JSON.parse(text) as Record<string, unknown>);
          } catch {
            /* binary or non-JSON: not a protocol frame this reading is about */
          }
        });
      });
      // The health route is the one endpoint the page polls before it knows whether the deployment is
      // configured; the scripted upstream is what makes this run's session real, so the probe is
      // answered here rather than left to a network this run refuses to touch.
      await page.route('**/api/voice/health', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
      );

      const workspaceName = path.basename(workspacePath);
      await page.goto('/');
      if (
        !(await projectRow(page, workspaceName)
          .waitFor({ state: 'visible', timeout: 25_000 })
          .then(() => true, () => false))
      ) {
        await page.reload();
      }
      await revealSession(page, workspaceName, sessionId);
      await sessionRow(page, sessionId).click();
      await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });

      // ── enter Live Voice, and wait for the endpoint session to be really open ──────────────────
      await enterLiveVoice(page);
      await expect.poll(() => phase(page), { timeout: 25_000 }).toBe('listening');
      // The server has to have opened the upstream session before any audio is meaningful: the
      // capture's frames are held until `state: open`, and a gate armed on a socket nobody dialled
      // sees nothing at all. The wait is on the endpoint's own live-socket count, not on the bar.
      await expect.poll(() => upstream.liveConnectionCount(), { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
      // …and the app has CONFIGURED that session. No detector is armed on this stand-in (`armVad` is
      // never called — the endpoint's opinion of the audio is not a variable this file reads), so the
      // proof the session is real is the `session.update` the app sent, which is also where the mode
      // is visible: `server_vad` IS the continuous wire, and a session advertised with the endpoint
      // segmenting itself is exactly the one this file must not be measuring.
      await expect
        .poll(() => turnDetectionOf(upstream), { timeout: 25_000 })
        .toBe('server_vad');

      // ── play the timeline ──────────────────────────────────────────────────────────────────────
      await playFakeMic(page);

      // A DELIVERY IS A ROUND TRIP, so the reading waits for the SERVER's account of the resume to be
      // on disk rather than for a fixed sleep. A run where the gate never resumed is a reading too,
      // so this is bounded: the deadline is what stops the wait, not the entry.
      const deadline = Date.now() + JOURNAL_TIMEOUT_MS;
      while (
        !silenceTailEntries(readJournal(journalDir, sessionId)).some((entry) => entry.event === 'resumed') &&
        Date.now() < deadline
      ) {
        await page.waitForTimeout(200);
      }

      const journalEntries = readJournal(journalDir, sessionId);
      const egressText = existsSync(egressLog) ? readFileSync(egressLog, 'utf8') : '';
      const headers = upstream.upgradeHeaders();

      run = {
        sessionId,
        pushed: await fakeMicPushed(page),
        micFrames: await fakeMicFrames(page),
        appendStamps: [...appendStamps],
        upstreamFrameTypes: upstream.clientFrames().map((frame) => String(frame.type)),
        turnDetection: turnDetectionOf(upstream),
        commits: upstream.commitCount(),
        declaredSegmented: browserFrames.some((frame) => frame.protocol === 'segmented-v1'),
        journalEntries,
        silenceTail: silenceTailEntries(journalEntries),
        mode: (journalEntries.find((entry) => entry.kind === 'connection')?.mode as string | undefined) ?? null,
        phase: await phase(page),
        egress: {
          logExists: existsSync(egressLog),
          blocked: egressText.includes('EGRESS BLOCKED'),
          dials: upstream.dialed(),
          liveConnections: upstream.liveConnectionCount(),
          authorizationSeen: headers.some((header) => header.authorization !== undefined),
          refused: [...browserEgress],
        },
        pageErrors,
      };

      // ── leave Live Voice, so nothing outlives the reading ──────────────────────────────────────
      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
      await context.close().catch(() => undefined);
    } finally {
      await api.dispose();
      await upstream.close();
    }
  });

  // ── non-vacuity: the timeline played, and it reached the endpoint ────────────────────────────────
  test('the timeline was played through the capture path and reached the endpoint as appends', () => {
    expect(run.pushed.filter((segment) => segment.kind === 'speech')).toHaveLength(2);
    expect(run.pushed.filter((segment) => segment.kind === 'silence')).toHaveLength(1);
    // The page really pushed the timeline at the capture cadence: a play that pushed nothing would
    // make every reading below a reading of a silent microphone.
    expect(run.micFrames, 'the fake capture must have pushed frames').toBeGreaterThan(35);
    // …and the frames really reached the endpoint. A relay that never uploaded would satisfy every
    // "no gap" leg below vacuously.
    expect(run.appendStamps.length, 'the endpoint must have received uploads').toBeGreaterThan(10);
    // The wire under test: continuous, so nothing was committed and no segment was declared.
    expect(run.mode, 'the journal must say this connection ran the continuous relay').toBe('continuous');
    expect(run.turnDetection, 'the app must advertise the endpoint-side detector — that is the continuous wire').toBe(
      'server_vad',
    );
    expect(run.declaredSegmented, 'the proxy must NOT have declared the segmented relay').toBe(false);
    expect(run.commits, 'continuous mode commits nothing').toBe(0);
    expect(run.upstreamFrameTypes).toContain('input_audio_buffer.append');
    expect(run.upstreamFrameTypes).not.toContain('input_audio_buffer.commit');
    expect(run.upstreamFrameTypes).not.toContain('segment_start');
    expect(run.upstreamFrameTypes).not.toContain('response.create');
    expect(run.phase, 'the bar must be listening at the end of the play').toBe('listening');
  });

  // ── the suppression episode: the uploads stopped for the whole quiet stretch ─────────────────────
  test('the uploads stopped across the quiet stretch, and the gate recorded the episode', () => {
    // The gate's own account, first — the reading below is about the wire, and this is the state
    // machine's description of the same episode.
    expect(
      run.silenceTail.map((entry) => entry.event),
      `the journal must record the episode: ${JSON.stringify(run.silenceTail)}`,
    ).toContain('suppressed');
    expect(run.silenceTail.map((entry) => entry.event)).toContain('resumed');
    const suppressed = run.silenceTail.find((entry) => entry.event === 'suppressed');
    const resumed = run.silenceTail.find((entry) => entry.event === 'resumed');
    expect(suppressed?.tailMs, 'the tail the deployment resolved must be reported').toBe(1_000);
    expect(resumed?.suppressedMs, 'the resume must report how much audio was withheld').toBeGreaterThan(0);
    expect(resumed?.preRollFrames, 'the resume must report the pre-roll it flushed').toBeGreaterThan(0);

    // The wire. The largest gap between two consecutive uploads is the episode, measured rather than
    // assumed — and bounded on both sides, because a gap long enough to be suppression is exactly
    // what a stalled relay would also produce.
    const ordered = [...run.appendStamps].sort((left, right) => left - right);
    const largest = gaps(ordered).reduce((best, gap) => (gap.ms > best.ms ? gap : best), { index: 0, ms: 0 });
    expect(
      largest.ms,
      `the uploads must stop for longer than the tail: gaps ${JSON.stringify(gaps(ordered).map((gap) => gap.ms))}`,
    ).toBeGreaterThanOrEqual(MIN_SUPPRESSION_GAP_MS);
    // The quiet stretch bounds it from above: the relay can only withhold what the microphone gave
    // it, so a gap longer than the silence itself would mean the connection had stopped, not the gate.
    expect(largest.ms, 'the withhold cannot outlast the silence the microphone delivered').toBeLessThanOrEqual(
      SILENCE_MS,
    );

    // Uploads on BOTH sides of the episode — the non-vacuity that keeps the gap from being read off a
    // wire that simply never worked.
    const before = ordered.slice(0, largest.index);
    const after = ordered.slice(largest.index);
    expect(before.length, 'the spoken run before the pause must be on the wire').toBeGreaterThan(3);
    expect(after.length, 'the spoken run after the pause must be on the wire').toBeGreaterThan(3);
    // And audio really was withheld: fewer uploads left the app than the microphone handed it.
    expect(run.appendStamps.length, `uploaded ${run.appendStamps.length} of ${run.micFrames} frames`).toBeLessThan(
      run.micFrames,
    );
  });

  // ── the resume: the pre-roll is flushed in one burst (decision doc §10.4 S-2) ────────────────────
  test('the resume flushed the pre-roll in one burst, so the first syllable after the pause is not lost', () => {
    const ordered = [...run.appendStamps].sort((left, right) => left - right);
    const largest = gaps(ordered).reduce((best, gap) => (gap.ms > best.ms ? gap : best), { index: 0, ms: 0 });
    expect(largest.ms, 'this case reads the episode the case above measured').toBeGreaterThanOrEqual(
      MIN_SUPPRESSION_GAP_MS,
    );

    // Everything that arrived within `FLUSH_WINDOW_MS` of the first upload after the gap. The flush
    // is drained from the ring in ONE synchronous loop inside the gate's `observe`, so these frames
    // reach the endpoint together; the next streamed frame is a whole cadence behind them. A relay
    // that dropped the quiet frames and simply carried on could not produce this burst at all — it is
    // the ring, and nothing else, that puts held audio back on the wire in one go.
    const firstAfterGap = ordered[largest.index]!;
    const burst = ordered.slice(largest.index).filter((stamp) => stamp - firstAfterGap <= FLUSH_WINDOW_MS);
    expect(
      burst.length,
      `the pre-roll must arrive as a burst: stamps ${JSON.stringify(ordered.slice(largest.index, largest.index + 12))}`,
    ).toBeGreaterThanOrEqual(MIN_FLUSH_FRAMES);
    // The journal agrees, from the other side of the wire: the gate flushed what it says it flushed.
    const resumed = run.silenceTail.find((entry) => entry.event === 'resumed');
    expect(resumed?.preRollFrames).toBeGreaterThanOrEqual(MIN_FLUSH_FRAMES);
  });

  // ── AC5: nothing left the machine ─────────────────────────────────────────────────────────────
  test('zero cloud calls: the guard ran, refused nothing, and the upstream was the stand-in', () => {
    expect(run.egress.logExists, 'the guard creates its log empty as proof the preload ran').toBe(true);
    expect(run.egress.blocked, 'nothing may have been refused a non-loopback dial').toBe(false);
    expect(run.egress.dials, 'the app must have dialled THIS server').toBeGreaterThanOrEqual(1);
    // The connection the episode happened on is still live once it is over: a socket that had closed
    // could not have carried the uploads after the pause, so this is the "no close" half of §10.5.
    expect(run.egress.liveConnections, 'the upstream session must still be up after the episode').toBeGreaterThanOrEqual(
      1,
    );
    expect(run.egress.authorizationSeen, 'with the credential blanked, no dial may carry an authorization header').toBe(
      false,
    );
    // The BROWSER half of the guard, read as a relation rather than as a count. Every URL this spec's
    // own route refused is a request that did not leave the machine, so the reading that matters is
    // what is IN that list and not how long it is: a refused LOOPBACK request would mean the guard was
    // pointed the wrong way, and the "refused nothing" above would then be a statement about a guard
    // that could not have fired either way.
    expect(
      run.egress.refused.filter((url) => /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)),
      `the route must never have refused this run's own server: ${JSON.stringify(run.egress.refused)}`,
    ).toEqual([]);
    expect(run.pageErrors, `uncaught page errors: ${JSON.stringify(run.pageErrors)}`).toEqual([]);
  });
});
