/**
 * gap-live-voice-pending-utterance-withdraw — the DoD walkthrough for AC-351 (GOAL-041 / SPEC §0.3 D-11):
 * three spoken sentences queued in the CLI, the MIDDLE one taken back from the Live Voice surface, and
 * only the other two delivered at the turn boundary.
 *
 * WHAT THIS FILE IS FOR. The unit criterion (`voicePendingWithdraw.test.tsx`) drives the hook and reads
 * the DOM, which proves the CONTROL. It cannot prove the CONTROL REACHES A REAL QUEUE: that the delivery
 * carries a real `queuedMessageUuid`, that a click leaves the browser as `chat.cancel-queued` naming that
 * one id, and that the sentence really never becomes a turn. Those are comparisons between two things
 * that could have disagreed — the uuid the host minted against the uuid the row carries, the one cancel
 * frame against three buttons, the two started rows against the third cancelled one — so they are read
 * here, in a real browser, against a real queue.
 *
 * WHERE THE BROWSER HALF ENDS, AND WHY. The row's own MARKING on the host's `cancelled` event is not
 * read here, and cannot be. A voice delivery reaches the session through `session_send`, and that
 * control call passes no connection (`mcp-session-send.ts`), so the run it opens belongs to no socket;
 * the host forwards a walk's frames through the writer of the LAST dispatch (`debug-agent.host-driver.ts`
 * keeps one `lastWriter`, set by every dispatch including a busy send's carrier), which is that
 * connectionless carrier's. A page only ever attaches to a run it subscribes to WHILE that run is the
 * session's current, running one (`chat-websocket.service.ts` → `attachConnection`), and the client
 * subscribes on session open and on socket reconnect — nothing subscribes between the last send and the
 * boundary. The page that holds the deliveries is, by construction, the page opened BEFORE the sends, so
 * no page can both hold them and be attached to the writer the boundary's frames ride on. The marking is
 * therefore asserted where a frame can be handed to the hook directly (the unit criterion), and the
 * boundary is read on the CLI side — off the transcript the process itself writes. The page's own view
 * after the boundary is captured below as the reading of exactly that gap, and pinned so that closing it
 * turns this file red rather than silently changing what it proves.
 *
 * REAL AND NOT REAL. Real: the browser, the app server, the `/voice-realtime` proxy, the MCP
 * `session_send`, the chat websocket, the control handler, the provider runtime and the host driver's
 * own command queue. Not real: the microphone (an init script installs an inert Web Audio graph — nothing
 * here pushes PCM into it) and the DashScope endpoint (the app dials the port `playwright.config.ts`
 * points it at, on which this file binds its own WebSocket server). No cloud call is made by
 * construction: the selection blanks `DASHSCOPE_API_KEY` and the server runs from a root with no `.env`,
 * so the dial carries no credential; the page's non-loopback traffic is recorded and asserted empty of
 * anything but the page's own chrome.
 *
 * WHY THE DEBUG AGENT IS THE "FAKE RESIDENT SESSION". The substitute process is a scenario walked by
 * `POST /api/debug-agent/clock`: `unattended-turn` opens the turn that makes the session busy (so a
 * voice `session_send` is a PUSH into the CLI's queue and answers `queued: true` with a uuid) — once in
 * front of EACH sentence, for the reason {@link TURN_TEXTS} gives — `await-release` is the barrier the
 * caller holds open while it takes its readings, `cancel-ack` is the process acting on the withdrawal,
 * and `dequeue` is the process taking a queued command — the exact moments a real `claude` would
 * produce them. The clock is NOT awaited where it is fired: it blocks for the whole walk, and the
 * readings below live inside that window.
 *
 * ⛔ fan-in's suite (`scripts/test.sh`) does not run Playwright. This file self-certifies the DoD, and
 * its readings (screenshot paths, the CLI-side received/delivered counts) are copied into the task's
 * `## Notes`.
 *
 * Run:
 *   QUAY_LIVE_VOICE_SHOT_DIR=<dir outside the checkout> \
 *     bash scripts/with-memory-cap.sh npx playwright test e2e/voice-pending-utterance-withdraw.spec.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  captionCompleted,
  functionCall,
  startScriptedUpstream,
  type ScriptedUpstreamServer,
} from './voiceRealtimeScriptedUpstream';

const PANE = '.chat-messages-pane';
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
/** The activity dock, whose state attribute says the process is mid-turn. */
const DOCK = '[data-activity-dock]';

/** The withdrawal rows, as `VoicePendingUtterance.tsx` draws them. */
const ROW = '[data-testid="voice-pending-utterance"]';
const WITHDRAWABLE = '[data-voice-withdrawable="true"]';
const WITHDRAW_BUTTON = '[data-voice-withdraw="true"]';
const WITHDRAWN = '[data-voice-withdrawn="true"]';

const USERNAME = 'voice-pending-withdraw-e2e';
const PASSWORD = 'voice-pending-withdraw-e2e-pass';
const TITLE = 'Voice pending utterance withdraw — the middle sentence';
const SEED_USER_TEXT = 'seeded user turn for the per-utterance withdrawal criterion';
/**
 * The turn the substitute process opens in front of EACH spoken sentence, in order.
 *
 * THREE turns and not one, and both the reason and the count are the app's, not this file's. The run
 * registry holds ONE run per session (`chat-run-registry.service.ts`): a busy send joins the queue by
 * superseding that run with a carrier of its own (`chat-websocket.service.ts`), and a push does not
 * run, so that carrier resolves as soon as the push is accepted and the slot is free again. A second
 * sentence sent after that finds no run in flight, opens a turn of its own, and is answered
 * `queued: false` — which is what a walk with ONE unattended turn measures (and did, before this file
 * opened a turn in front of each sentence). So the process is put back mid-turn before every sentence,
 * which is exactly the state the first one found. The texts differ so this file can wait for the turn
 * it is about to speak behind rather than for one that was already open.
 */
const TURN_TEXTS = [
  'the turn the process was already writing',
  'the second turn opened while the queue filled',
  'the third turn opened while the queue filled',
];

/** The three spoken sentences, in the order the relay delivers them. */
const SENTENCES = [
  'first — keep this sentence and run it',
  'second — take this one back',
  'third — keep this sentence too',
];
/** The endpoint's item ids for the three utterances, and the ids of the three tool calls. */
const ITEM_IDS = ['withdraw-item-1', 'withdraw-item-2', 'withdraw-item-3'];
const CALL_IDS = ['withdraw-call-1', 'withdraw-call-2', 'withdraw-call-3'];
/** The index of the one sentence this walk takes back. */
const WITHDRAWN_INDEX = 1;

/**
 * The walk. Absolute offsets from the run's start, so where each reading can be taken does not depend on
 * how long this file took to get there.
 *
 * One `unattended-turn` in front of each sentence (see {@link TURN_TEXTS}), 25 s apart. The spacing is
 * not pacing — the chain is paced on the session's own `sent` answer, which is the reading that says a
 * sentence was taken — it is headroom: the turn in front of sentence N has to be opened after sentence
 * N-1 was queued, and a loaded host buys that ordering back in the transcript wait below.
 *
 * `await-release` is the barrier: the walk parks there until the test has taken its click and its
 * readings, and then the remaining steps fire in sequence. It is placed late — long after the three
 * sends and the click — and the barrier's own 20 s ceiling is measured from ARRIVAL, so a late barrier
 * is what buys the click its room; a release stated before arrival is recorded and the barrier passes
 * the moment it is reached. `cancel-ack` twice, because the first is the process acting on the
 * withdrawal and the second must be the no-op a scenario with nothing waiting has to tolerate.
 * `dequeue` three times, because only TWO commands are left in the queue: the third is the no-op that
 * proves the withdrawal really removed the middle one rather than merely relabelling it.
 */
const WITHDRAW_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'unattended-turn', text: TURN_TEXTS[0], trigger: 'cron' },
    { at: 25_000, op: 'unattended-turn', text: TURN_TEXTS[1], trigger: 'cron' },
    { at: 50_000, op: 'unattended-turn', text: TURN_TEXTS[2], trigger: 'cron' },
    { at: 75_000, op: 'await-release' },
    { at: 76_000, op: 'cancel-ack' },
    { at: 76_500, op: 'cancel-ack' },
    { at: 77_000, op: 'turn-end' },
    { at: 78_000, op: 'dequeue' },
    { at: 79_000, op: 'dequeue' },
    { at: 80_000, op: 'dequeue' },
    { at: 81_000, op: 'wait' },
  ],
  expect: { rows: { delta: 6 }, content: { mustContain: [SEED_USER_TEXT, ...TURN_TEXTS] } },
};

// ---------------------------------------------------------------------------------------------
// The page helpers — the shapes the sibling voice specs use.
// ---------------------------------------------------------------------------------------------

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

async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown,
): Promise<{ sessionId: string; transcriptPath: string }> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const data = body?.data;
  if (typeof data?.sessionId !== 'string' || typeof data?.transcriptPath !== 'string') {
    throw new Error(`arming returned no sessionId/transcriptPath: ${JSON.stringify(body)}`);
  }
  return { sessionId: data.sessionId, transcriptPath: data.transcriptPath };
}

/** Brings a session's resident process up, through the endpoint the status bar's own control calls. */
async function startResidentProcess(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`);
  if (!response.ok()) {
    throw new Error(
      `could not start the resident process for ${sessionId}: ${response.status()} ${await response.text()}`,
    );
  }
}

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

const waitForPhase = (page: Page, wanted: string) =>
  expect.poll(() => phase(page), { timeout: 25_000 }).toBe(wanted);

/** Writes a screenshot when QUAY_LIVE_VOICE_SHOT_DIR is set; a no-op in ordinary runs. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.QUAY_LIVE_VOICE_SHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Enters Live Voice and waits for the bar to have replaced the composer. */
async function enterLiveVoice(page: Page): Promise<void> {
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
  const entry = page.getByTestId('live-voice-button');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByTestId('voice-realtime-bar')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeHidden();
}

/** Navigates to a session and waits for its pane and composer. */
async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/session/${sessionId}`);
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
}

/**
 * Has the endpoint close an utterance with `text`, and waits until the bar is showing those words.
 *
 * The wait is the ordering barrier between "the model heard this sentence" and "the model acted on it":
 * it is the caption, not a sleep, so the sentence the call below is for is on screen before it is sent.
 */
async function hearUtterance(
  page: Page,
  upstream: ScriptedUpstreamServer,
  itemId: string,
  text: string,
): Promise<void> {
  upstream.emit(captionCompleted(itemId, text));
  await expect(page.getByTestId('voice-realtime-caption')).toContainText(text, { timeout: 15_000 });
}

const isLoopbackUrl = (url: string): boolean =>
  /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

// ---------------------------------------------------------------------------------------------
// The fake audio graph. No CI machine has a microphone, so the browser's capture is an inert graph;
// nothing in this file pushes PCM into it (the walk is driven entirely by the scripted upstream).
// ---------------------------------------------------------------------------------------------

function installFakeAudioGraph(): void {
  type Port = { onmessage: ((m: unknown) => void) | null; postMessage: () => void };
  class FakeWorkletNode {
    port: Port;
    constructor() {
      this.port = { onmessage: null, postMessage: () => undefined };
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
      /* no state changes are driven by this file */
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

/**
 * Records every JSON frame the app put on a socket AND every one it was handed back, by subclassing
 * `WebSocket` — the app's own handlers keep working, and the recorded frames are copies of what the app
 * already carried.
 *
 * THE OUTBOUND HALF is the only witness for "the click left the browser as one `chat.cancel-queued`
 * naming one uuid": the REST queue reading says the host was handed *something*, and the frame says what
 * the browser actually put on the wire.
 *
 * THE INBOUND HALF is the only witness for "the session queued this sentence". The model is NOT the one
 * told: the relay answers its `session_send` call itself, the moment it is made, with
 * `{accepted, instruction}` — the coalescing window's own receipt — and the CLI's answer, the one
 * carrying `queued` and the `queuedMessageUuid`, travels to the BROWSER as the `sent` frame once that
 * window closes. Reading the tool output for a queue id reads the relay's receipt and finds nothing.
 */
const recordSocketFrames = () => {
  const page = window as unknown as { __socketSent: unknown[]; __socketInbound: unknown[] };
  page.__socketSent = [];
  page.__socketInbound = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          page.__socketInbound.push(JSON.parse(String(event.data)));
        } catch {
          // Only the JSON frames this protocol uses are of interest.
        }
      });
    }

    send(data: Parameters<WebSocket['send']>[0]) {
      try {
        page.__socketSent.push(JSON.parse(String(data)));
      } catch {
        // Only the JSON frames this protocol uses are of interest.
      }
      super.send(data);
    }
  } as unknown as typeof WebSocket;
};

const sentFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() => (window as unknown as { __socketSent: Array<Record<string, unknown>> }).__socketSent ?? []);

const inboundFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() => (window as unknown as { __socketInbound: Array<Record<string, unknown>> }).__socketInbound ?? []);

/** The queue id on a `sent` frame whose result says the session is HOLDING the sentence, else `null`. */
function queuedDeliveryUuid(frame: Record<string, unknown>): string | null {
  if (frame.type !== 'sent') return null;
  const result = frame.result as Record<string, unknown> | null | undefined;
  // `queued: false` means the send STARTED a run instead of joining the queue: there is no command
  // behind it for a withdrawal to address, so it is not a delivery this file can withdraw.
  if (result?.queued !== true) return null;
  const uuid = result.queuedMessageUuid;
  return typeof uuid === 'string' && uuid !== '' ? uuid : null;
}

/**
 * Waits until the browser has been handed `expected` deliveries the session QUEUED, and returns their
 * queue ids, oldest first.
 *
 * The wait is also the pacing barrier: a delivery is answered only after the relay's coalescing window
 * has closed, so by the time the count moves, the sentence before it is already one command of its own
 * rather than another piece of the same one.
 */
async function queuedDeliveryUuids(page: Page, expected: number, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sent = (await inboundFrames(page)).filter((frame) => frame.type === 'sent');
    const uuids = sent.map(queuedDeliveryUuid).filter((uuid): uuid is string => uuid !== null);
    if (uuids.length >= expected) return uuids;
    if (Date.now() >= deadline) {
      throw new Error(
        `${uuids.length} of ${expected} spoken sentences came back QUEUED; the session answered: `
        + JSON.stringify(sent.map((frame) => frame.result)),
      );
    }
    await page.waitForTimeout(250);
  }
}

/** Waits until one frame the app sent matches `predicate`. */
async function waitForSentFrame(
  page: Page,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<void> {
  await expect.poll(async () => (await sentFrames(page)).some(predicate), { timeout: timeoutMs }).toBe(true);
}

/** Fires a walk and reduces its outcome to a settled value, so a failure elsewhere is not shadowed. */
function fireClock(api: APIRequestContext, sessionId: string) {
  return api
    .post('/api/debug-agent/clock', { data: { sessionId } })
    .then(async (response) => ({
      ok: response.ok(),
      status: response.status(),
      body: (await response.json().catch(() => null)) as { success?: boolean } | null,
    }))
    .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));
}

type QueueReading = {
  queued: string[];
  withdrawRequested: string[];
  withdrawn: string[];
  controlResponses: string[];
};

/** What the substitute process is holding, as the debug provider reports it. */
async function readQueue(api: APIRequestContext, sessionId: string): Promise<QueueReading> {
  const response = await api.get(`/api/debug-agent/queue?sessionId=${encodeURIComponent(sessionId)}`);
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/debug-agent/queue answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  const data = body?.data ?? {};
  return {
    queued: data.queued ?? [],
    withdrawRequested: data.withdrawRequested ?? [],
    withdrawn: data.withdrawn ?? [],
    controlResponses: data.controlResponses ?? [],
  };
}

type LifecycleRow = { command_uuid: string; state: string };

/** The `command_lifecycle` rows on disk — the queue's account, written on the scenario's clock. */
function readLifecycleRows(transcriptPath: string): LifecycleRow[] {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const rows: LifecycleRow[] = [];
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== 'command_lifecycle') continue;
    if (typeof parsed.command_uuid !== 'string' || typeof parsed.state !== 'string') continue;
    rows.push({ command_uuid: parsed.command_uuid, state: parsed.state });
  }
  return rows;
}

/**
 * Waits until the transcript carries one command's `command_lifecycle` row in one state.
 *
 * The process's own account of what it did with a queued command, read where the CLI writes it — and,
 * for this walk, the only place it is readable at all: the frames the host forwards carry the queue's
 * `command_lifecycle` events to a run no browser socket is attached to (see the file header), so the
 * boundary is a reading taken from the artifact rather than from the page.
 */
async function waitForLifecycleRow(
  transcriptPath: string,
  commandUuid: string,
  state: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      () =>
        readLifecycleRows(transcriptPath).some(
          (row) => row.command_uuid === commandUuid && row.state === state,
        ),
      { timeout: timeoutMs, message: `the process never reported ${state} for ${commandUuid}` },
    )
    .toBe(true);
}

/**
 * Waits until the walk has written `text` into the session's transcript.
 *
 * The signal for "the process has opened the turn this sentence is about to be pushed into", and read
 * off disk rather than off the page because that is where the walk's own step puts it: the engine
 * appends the row synchronously before it forwards anything, so a row on disk is a turn that is
 * already open (the open call runs first, in the same step). Waiting on the transcript rather than on
 * a fixed offset is what makes the ordering "the previous sentence was queued, THEN this turn opened"
 * a reading instead of a hope.
 */
async function waitForTranscriptText(transcriptPath: string, text: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return fs.readFileSync(transcriptPath, 'utf8').includes(text);
        } catch {
          return false;
        }
      },
      { timeout: timeoutMs, message: `the walk never wrote ${JSON.stringify(text)} to the transcript` },
    )
    .toBe(true);
}

// The walk is ~81 s of scenario clock (three turns 25 s apart, then the barrier and the queue steps), and
// the case may not be faster than the offsets it waits on. The default 60 s per-test budget would kill a
// healthy run mid-case — a watchdog red that says nothing about what it was measuring.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('voice pending utterance withdraw', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: ScriptedUpstreamServer;
  let workspacePath = '';
  let workspaceName = '';
  let sessionId = '';
  let transcriptPath = '';

  /** Every non-loopback URL the PAGE reached, so "no cloud call" is a reading rather than a claim. */
  const nonLoopbackRequests: string[] = [];
  const nonLoopbackWebSockets: string[] = [];

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

    // The workspace has to sit inside the fixture home: the control plane writes only under
    // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it.
    workspacePath = path.join(fixtureHome, 'voice-pending-withdraw-workspace');
    workspaceName = path.basename(workspacePath);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    const armed = await armScenario(api, workspacePath, WITHDRAW_SCENARIO);
    sessionId = armed.sessionId;
    transcriptPath = armed.transcriptPath;
    // A scenario's `unattended-turn` needs a host to open its turn on, so the process is up before the
    // walk is fired — the same start verb the bar's own [Start] button gives.
    await startResidentProcess(api, sessionId);

    const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
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
    await context.addInitScript(installFakeAudioGraph);
    await context.addInitScript(recordSocketFrames);

    page = await context.newPage();
    page.on('request', (r) => {
      const url = r.url();
      if (!isLoopbackUrl(url)) nonLoopbackRequests.push(url);
    });
    page.on('websocket', (ws) => {
      const url = ws.url();
      if (!isLoopbackUrl(url)) nonLoopbackWebSockets.push(url);
    });
    await page.route('**/api/voice/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
    );

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
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
    await upstream?.close();
  });

  test('three spoken sentences queue, the middle one is withdrawn, and only the other two reach the turn boundary', async () => {
    await openSession(page, sessionId);
    await enterLiveVoice(page);
    await waitForPhase(page, 'listening');

    // Fired, never awaited, and fired only once the page is in voice and listening. The walk blocks for
    // its whole length, and every reading below is taken while the process is still holding the turn it
    // opened — but the walk's offsets are also what spaces the three turns, so the page's own setup
    // must not be spent inside them.
    const clock = fireClock(api, sessionId);
    await waitForTranscriptText(transcriptPath, TURN_TEXTS[0]!, 30_000);
    await expect(page.locator(DOCK)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 30_000 });

    // ---- three spoken sentences, three pushes, three queue ids ------------------------------------
    const uuids: string[] = [];
    for (let index = 0; index < SENTENCES.length; index += 1) {
      if (index > 0) {
        // The turn this sentence is pushed into (see TURN_TEXTS). Without it the slot the previous
        // sentence's carrier vacated would make this send OPEN a turn of its own, and the session would
        // answer `queued: false` with no id — a sentence this file then could not withdraw.
        await waitForTranscriptText(transcriptPath, TURN_TEXTS[index]!, 60_000);
      }
      await hearUtterance(page, upstream, ITEM_IDS[index]!, SENTENCES[index]!);
      upstream.emit(functionCall('session_send', { message: SENTENCES[index] }, CALL_IDS[index]!));
      // The chain is paced on the SESSION's own answer, not on a sleep: the sentence is on the wire the
      // moment the model calls, and the queue id below is what says the session took it and is holding
      // it. Reading it off the browser's `sent` frame is also what makes each sentence its own command —
      // that frame arrives only once the relay's coalescing window has closed, so the next sentence
      // opens a window of its own instead of being folded into this one.
      const queued = await queuedDeliveryUuids(page, index + 1, 20_000);
      const uuid = queued[queued.length - 1]!;
      uuids.push(uuid);
      console.log(`cli.received[${index}]=${JSON.stringify(SENTENCES[index])} queued=true uuid=${uuid}`);
    }
    console.log(`cli.received.count=${uuids.length}`);
    expect(new Set(uuids).size, 'each pushed sentence is its own command').toBe(3);
    const pushedOutputs = upstream
      .functionCallOutputs()
      .filter((entry) => CALL_IDS.includes(String((entry.item as Record<string, unknown> | undefined)?.call_id)));
    expect(pushedOutputs.length, 'every spoken sentence reached the session as one sent call').toBe(3);

    // The CLI side's own reading of what it received: three texts held, and none of them withdrawn yet.
    const heldQueue = await readQueue(api, sessionId);
    console.log(`cli.queue.held=${JSON.stringify(heldQueue.queued)}`);
    expect(heldQueue.queued.length, 'the session is holding all three spoken sentences').toBe(3);
    expect(heldQueue.withdrawn, 'nothing is withdrawn before the click').toEqual([]);

    // ---- the surface offers exactly three rows, one per sentence, addressed by the host's own ids ----
    await expect.poll(async () => page.locator(WITHDRAWABLE).count(), { timeout: 20_000 }).toBe(3);
    const domUuids = await page
      .locator(WITHDRAWABLE)
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-voice-pending-uuid')));
    console.log(`ui.withdrawable.uuids=${JSON.stringify(domUuids)}`);
    expect(domUuids, 'the rows are addressed by exactly the ids the host minted, oldest first').toEqual(uuids);
    for (let index = 0; index < SENTENCES.length; index += 1) {
      await expect(page.locator(WITHDRAWABLE).nth(index), `row ${index} offers its own sentence back`)
        .toContainText(SENTENCES[index]!);
    }
    await shot(page, 'voice-pending-withdraw-queued');

    // ---- withdraw the MIDDLE one -------------------------------------------------------------------
    const middleUuid = uuids[WITHDRAWN_INDEX]!;
    const middleRow = page.locator(`${WITHDRAWABLE}[data-voice-pending-uuid="${middleUuid}"]`);
    await middleRow.locator(WITHDRAW_BUTTON).click();

    // The click reached the process that holds the command — read through the provider the registry
    // resolved, not through anything this file kept.
    await expect
      .poll(async () => {
        const reading = await readQueue(api, sessionId);
        return reading.withdrawRequested.length + reading.withdrawn.length;
      }, { timeout: 15_000, message: 'the click must reach the process that holds the command' })
      .toBeGreaterThanOrEqual(1);

    // Exactly ONE cancel frame, naming the middle uuid, and NO abort: the withdrawal is one command and
    // it never stops the run in flight (D-11).
    const isCancelFor = (uuid: string) => (frame: Record<string, unknown>) =>
      frame.type === 'chat.cancel-queued' && frame.sessionId === sessionId && frame.messageUuid === uuid;
    await waitForSentFrame(page, isCancelFor(middleUuid), 15_000);
    const cancels = (await sentFrames(page)).filter((frame) => frame.type === 'chat.cancel-queued');
    const aborts = (await sentFrames(page)).filter((frame) => frame.type === 'chat.abort');
    console.log(`wire.cancelFrames=${cancels.length} wire.abortFrames=${aborts.length}`);
    console.log(`wire.cancel.uuid=${String(cancels[0]?.messageUuid)}`);
    expect(cancels.length, `one click is one withdrawal: ${JSON.stringify(cancels)}`).toBe(1);
    expect(cancels[0]?.messageUuid).toBe(middleUuid);
    expect(aborts.length, 'a withdrawal must never abort the running turn').toBe(0);

    // A request is not a withdrawal: the host has not acted yet, so the row must not claim one.
    await expect(page.locator(WITHDRAWN), 'no row may claim a withdrawal before the host states one')
      .toHaveCount(0);
    await shot(page, 'voice-pending-withdraw-clicked');

    // ---- the host acts on the withdrawal, and the boundary is read where it is readable -------------
    const release = await api.post('/api/debug-agent/release', { data: { sessionId } });
    expect(release.ok(), `the walk must be releasable: ${release.status()} ${await release.text()}`).toBe(true);

    // THE TURN BOUNDARY, on the CLI side: the process's own account of what it queued, started and
    // dropped. The middle command is `cancelled` and the two survivors are `started` — in order — and
    // those two rows are the whole delivery reading this walk is about (see the artifact block below).
    await waitForLifecycleRow(transcriptPath, middleUuid, 'cancelled', 40_000);
    for (const index of [0, 2]) {
      await waitForLifecycleRow(transcriptPath, uuids[index]!, 'started', 40_000);
    }

    // The page's own view across the boundary: still the three rows it was handed, none of them marked,
    // because nothing the boundary produced arrived on its socket (the file header says why). Pinned as
    // a reading of that gap — the day a page can hear this run, this line is what says so.
    await shot(page, 'voice-pending-withdraw-after-boundary');
    await expect(page.locator(ROW), 'the page still draws the rows it was handed, as the header explains')
      .toHaveCount(3);
    await expect(page.locator(WITHDRAWN), 'no inbound frame reached this page to mark a row').toHaveCount(0);

    // ---- the artifact: what the CLI's queue actually did ------------------------------------------
    const outcome = await clock;
    console.log(`walk.ok=${outcome.ok} status=${outcome.status}`);
    expect(outcome.ok, `the walk must complete: ${JSON.stringify(outcome.body)}`).toBe(true);

    const lifecycle = readLifecycleRows(transcriptPath);
    const cancelled = lifecycle.filter((row) => row.state === 'cancelled');
    const started = lifecycle.filter((row) => row.state === 'started');
    console.log(`transcript.lifecycle=${JSON.stringify(lifecycle)}`);
    expect(cancelled.map((row) => row.command_uuid), 'exactly the middle sentence was cancelled')
      .toEqual([middleUuid]);
    expect(started.map((row) => row.command_uuid), 'only the two survivors were started, in order')
      .toEqual([uuids[0], uuids[2]]);

    const queue = await readQueue(api, sessionId);
    console.log(`queue.queued=${JSON.stringify(queue.queued)} queue.withdrawn=${JSON.stringify(queue.withdrawn)}`
      + ` queue.withdrawRequested=${JSON.stringify(queue.withdrawRequested)}`);
    console.log(`queue.controlResponses=${queue.controlResponses.length}`);
    // Listed once per event about the one command, not once per command: the request is recorded when
    // it is made (`cancelQueuedInput`) and the act is recorded when the process acknowledges it
    // (`acknowledgeCancel`). Deduplicated here so the assertion is about WHICH command was withdrawn.
    expect([...new Set(queue.withdrawn)], 'the process acted on exactly the middle withdrawal')
      .toEqual([middleUuid]);
    expect(queue.queued, 'nothing is left in the process queue').toEqual([]);
    expect(queue.controlResponses, 'the withdrawal is never answered by a control response').toHaveLength(0);

    // The scenario's own declared expectation, read off disk by the control plane.
    const selfCheck = await api.get(`/api/debug-agent/self-check?sessionId=${encodeURIComponent(sessionId)}`);
    const selfData = (await selfCheck.json().catch(() => null))?.data;
    console.log(`selfcheck.rowsDelta=${String(selfData?.rowsDelta)}`);
    console.log(`selfcheck.failures=${JSON.stringify(selfData?.failures)}`);
    expect(selfData?.failures, 'the scenario the walk declares must be satisfied by what it wrote').toEqual([]);

    // ---- no cloud call ---------------------------------------------------------------------------
    const CHROME_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'api.github.com']);
    const strayHosts = [...new Set(nonLoopbackRequests.map((url) => new URL(url).host))].filter(
      (host) => !CHROME_HOSTS.has(host),
    );
    console.log(`cloud.strayHosts=${JSON.stringify(strayHosts)} cloud.webSockets=${JSON.stringify(nonLoopbackWebSockets)}`);
    expect(strayHosts, `a non-loopback host outside the page's own chrome: ${strayHosts.join(', ')}`).toEqual([]);
    expect(nonLoopbackWebSockets, `the page opened a non-loopback socket: ${nonLoopbackWebSockets.join(', ')}`)
      .toEqual([]);

    console.log(`summary.queued=${SENTENCES.length} summary.delivered=${started.length}`
      + ` summary.withdrawn=${cancelled.length}`);
  });
});
