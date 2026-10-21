/**
 * gap-live-voice-intent-control-browser-e2e — the DoD walkthrough for AC-345 (GOAL-041, SPEC
 * `docs/proposals/voice-realtime-persistent-control-SPEC.md`): intent control read in a REAL browser
 * against a REAL app server, driven by the shared scripted Realtime upstream.
 *
 * WHAT THIS FILE IS FOR. The server criteria (`voice-realtime-interrupt.test.ts`,
 * `…-interrupt-fence.test.ts`, `…-interrupt-revision-order.test.ts`) drive the proxy in-process, and
 * the unit criteria drive the hook against a stubbed socket. Neither can read the two things this
 * task is about: that the numbers the PERSON is shown are the ones the session actually holds, and
 * that the words a person spoke reach the CLI in the order they were spoken when the person both
 * types and talks. Those are comparisons between two parties that could have disagreed, so they are
 * read here, in a browser, against a real CLI queue.
 *
 * WHAT IS REAL AND WHAT IS NOT. Real: the browser, the app server, the `/voice-realtime` proxy, the
 * bridge, the live executor, the real `session_send`/`session_interrupt` reaching the real MCP
 * control plane, the chat websocket, the provider runtime and the host driver's own command queue.
 * Not real: the microphone (no CI machine has one — an init script installs a Web Audio graph whose
 * worklet the spec pulses with ONE captured frame, because `listening` only becomes true after the
 * first captured frame, and the fake graph would otherwise never deliver one; every utterance below
 * still reaches the proxy as the endpoint's own final transcript, exactly as it does in
 * `voice-realtime-scripted-scenarios.spec.ts`) and the
 * DashScope endpoint itself (the app dials the port `playwright.config.ts` points it at, on which
 * this file binds its own `ws` server).
 *
 * WHY THE UTTERANCES ARE THE ENDPOINT'S TRANSCRIPTS AND NOT A PACED AUDIO FILE. The landed task
 * `gap-voice-realtime-paced-audio-source` delivered `pacedFileAudioSource` with NO browser seam: the
 * factory is selected only by `useVoiceRealtimeSession.startWithFile` when its caller passes
 * `options`, and the only UI caller — the hidden upload input in `VoiceRealtimeBar.tsx` — passes
 * none; a native file input cannot carry a JS `schedule` function, so no `setInputFiles` can reach
 * it. Wiring one would mean changing the production upload path's shape, and this task's scope is a
 * criterion over the intent-control contract, not a new audio seam. A final transcription IS the
 * same reading either way — the proxy counts `utteranceSeq`, fires the fence and passes the words to
 * the page on this event whether the audio came from a file or from the wire — so the utterances are
 * driven here the way the sibling spec drives them, and `## Notes` records the deviation.
 *
 * CLOUD API IS FORBIDDEN BY CONSTRUCTION (AC3). `playwright.config.ts` blanks `DASHSCOPE_API_KEY` on
 * this selection's server and runs it from a root with no `.env`, so the handshake carries no
 * credential; the case below reads the ABSENCE of `authorization` on the upgrade, the page's
 * non-loopback traffic (exactly its two pinned Google-Fonts stylesheets) and the upstream's own dial
 * count, so "zero cloud calls" is an observation rather than a claim.
 *
 * ⛔ fan-in's suite (`scripts/test.sh`) does not run Playwright. This file self-certifies the DoD, and
 * the readings in its `console.log` lines are copied into the task's `## Notes`.
 *
 * Run:
 *   QUAY_LIVE_VOICE_SHOT_DIR=<dir outside the checkout> \
 *     bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type ConsoleMessage, type Page } from '@playwright/test';

import {
  captionCompleted,
  functionCall,
  malformedFunctionCall,
  speechStopped,
  startScriptedUpstream,
  type ScriptedUpstreamServer,
} from './voiceRealtimeScriptedUpstream';

const PANE = '.chat-messages-pane';
/** The composer's textarea testid — present exactly while `ChatComposer` is mounted. */
const COMPOSER_TEXTAREA = '[data-slot="prompt-input-textarea"]';
const BAR = '[data-testid="voice-realtime-bar"]';
const STATUS = '[data-testid="voice-realtime-status"]';
/**
 * The seam the bar used to draw to say the session had stopped. `gap-voice-ui-strip-to-caption-and-
 * connection-state` (2026-10-14) removed that node, so it is read here as an ABSENCE — and by testid
 * PREFIX, so a notice coming back under a new name fails the reading too, which a query written
 * against the old name could not do.
 */
const STOP_NOTICE_PREFIX = '[data-testid^="voice-realtime-stop"]';
/**
 * The ONE read-only card the relay's hold draws for the message it is merging while the session is
 * busy (ruling 2026-10-14). It stands where the per-sentence rows the queue used to draw used to be:
 * there is ONE card while queued, and as more is said it is the same card whose text grows — never a
 * second one. So a reading that used to count rows now reads the merged text off the single card.
 */
const HELD_CARD = '[data-testid="voice-pending-message"]';

const USERNAME = 'voice-intent-control-e2e';
const PASSWORD = 'voice-intent-control-e2e-pass';
/** The fixture session's own seed row, so every walk opens on a transcript that is not empty. */
const SEED_USER_TEXT = 'seeded user turn for the intent-control criterion';

/**
 * How long the walk waits between two `unattended-turn` steps — the mechanism that makes a
 * `session_send` a QUEUED delivery, and not pacing.
 *
 * The host driver decides turn-versus-push by reading whether the session already holds a turn at the
 * instant the command arrives (`debug-agent.host-driver.ts`: `busy = turnByAppSession.has(...)`, read
 * BEFORE the runner is entered, and the busy option is stamped only when it is true). A session that
 * is already mid-turn has the command PUSHED — the host mints it an id and the CLI holds it behind
 * the run — while an IDLE session makes the very same command OPEN a turn and answer `queued: false`
 * with no id at all. A walk that opens ONE turn and then parks therefore measures its first send as a
 * push and every later one as a turn; that is what a sibling walk recorded, and what this file's own
 * first red was (both sends settled `queued: false`, so the order readings below had no command id to
 * join on).
 *
 * So the walk opens a turn every {@link TURN_CADENCE_MS} for its whole length instead of once, and
 * every send below lands on a session that is holding one. The cadence is deliberately shorter than
 * the relay's own 2.5 s coalescing window: a send may be answered while the next turn is opening, and
 * all the ordering needs is that a turn EXISTS at the instant the command arrives.
 *
 * IT IS ALSO THE WAIT EVERY SEND IS PACED ON. A delivery's own carrier supersedes the turn the walk is
 * drawing, so the send after it waits for the NEXT turn to be on disk before it goes (see
 * `waitForTurnAfter`) — which means the cadence is waited out once per send, in every case below, and
 * a whole-file run pays it a dozen times. One second is as short as the guarantee allows (the window it
 * must stay under is 2.5 s) and it halves that bill; {@link TURN_COUNT} is raised to match, so the walk
 * still covers a minute of turns and no case can outlive it.
 */
const TURN_CADENCE_MS = 1_000;

/**
 * How many turns a walk opens — comfortably more than any case below needs, for the reason above, and
 * long enough in TIME that no case can outlive its own walk: {@link TURN_COUNT} ×
 * {@link TURN_CADENCE_MS} is a minute of turns, while the longest case below reads for 16 s.
 */
const TURN_COUNT = 60;

/** How far past the last turn the walk parks, so it never ends inside a case. */
const TURN_TAIL_MS = 240_000;

/** The text every turn's row carries. Numbered, so a case can wait for the NEXT one. */
const turnText = (index: number): string => `intent-control held turn ${index + 1} end`;

/** The mark a turn's row carries, numbered. The trailing ` end` keeps `turn 1` off `turn 12`. */
const TURN_MARK = /intent-control held turn (\d+) end/;

/**
 * The highest turn number written to the transcript at or after `since`, or 0.
 *
 * Read from the transcript rather than from the page because this is the SESSION's own statement that
 * it is mid-turn — the reading the host's busy check is made of — and it is read as a TIME rather
 * than as a count of how many turns exist: every turn the walk opens is on the same absolute clock,
 * so "a turn written after the last stop" is what says the stop's vacancy has been filled again.
 * A row that is still being appended (no parsable line yet) is skipped rather than allowed to throw.
 */
function highestTurnSince(transcriptPath: string, since: number): number {
  let highest = 0;
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!TURN_MARK.test(line)) continue;
    let at = Number.NaN;
    try {
      at = Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? '');
    } catch {
      continue;
    }
    if (!Number.isFinite(at) || at < since) continue;
    highest = Math.max(highest, Number(TURN_MARK.exec(line)?.[1]));
  }
  return highest;
}

/** Every parsable row of the transcript, in FILE order; a row still being appended is skipped. */
function transcriptRows(transcriptPath: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A partially written trailing line is not a row yet; the caller re-reads.
    }
  }
  return out;
}

/**
 * The file-order index of the first `command_lifecycle` row in state `started`, or -1.
 *
 * FILE ORDER, DELIBERATELY, and not a timestamp. The two instants the busy-release criterion compares
 * — a queued command being STARTED, and the turn it was pushed behind writing its terminal row — are
 * written by the same walk on the same process, so the line each sits on is a total order with no
 * clock in it at all. A timestamp comparison would put the reading at the mercy of the clock's
 * resolution (both rows can share a millisecond), which is exactly the fragility this avoids.
 */
function indexOfFirstStartedCommand(transcriptPath: string): number {
  return transcriptRows(transcriptPath).findIndex(
    (row) => row.type === 'command_lifecycle' && row.state === 'started',
  );
}

/** The file-order index of the first terminal `result` row, or -1. */
function indexOfFirstTurnResult(transcriptPath: string): number {
  return transcriptRows(transcriptPath).findIndex((row) => row.type === 'result');
}

/** The endpoint's own failure shapes the bridge refuses — see `malformedFunctionCall`. */
const NOT_JSON_ARGUMENTS = '{"intent": ';
const NOT_AN_OBJECT_ARGUMENTS = '[]';

// ---------------------------------------------------------------------------------------------
// The walks. Each case arms its own, so no case can be explained by a sibling's state.
// ---------------------------------------------------------------------------------------------

/** The smallest valid scenario — its walk writes nothing; the session is a carrier for the rows. */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: 'Voice intent control arm', userText: SEED_USER_TEXT },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

/**
 * A walk that keeps the session mid-turn for its whole length: a fresh `unattended-turn` every
 * {@link TURN_CADENCE_MS} (see that constant for why this is the mechanism and not pacing), and then
 * a `wait` far enough out that the walk never finishes inside a case — its `turn-end` would be a
 * session that stopped being busy halfway through the readings.
 *
 * The seed states `lifecycleMode: 'resident'`. That is what makes this the kind of session a person
 * can type into while it works (the composer's `busySendGoesToProcess` path case 2 reads), and it is
 * the kind whose own queue the sends below join.
 */
/**
 * The steps that make the session read "BUSY" to the relay (AC7) — a steady cadence of
 * `thinking-tokens` rows for the whole window a busy case reads in.
 *
 * THE ONE SIGNAL THE COMPOSITION READS FOR A DEBUG SESSION. The relay's hold — the ONE merged pending
 * message the ruling put above the bar — is gated on the host's `busy` reading (`hostRunActivity` →
 * `composeHostRunActivityReading`, `server/index.ts`). For a Claude-speaking resident session that
 * reading comes from the driver's own `rounds`; a debug-agent session has no such driver, so the
 * composition falls back to the activity store's TURN PHASE, and the walk must produce the row that
 * phase is reduced from. An `unattended-turn` writes only a USER row, which the phase reducer does not
 * read — so the phase stayed `idle` and the relay never held anything (the reading this task exists to
 * close). A `thinking-tokens` step writes the one row a `system/thinking_tokens` frame becomes
 * (`claude-turn-phase.service.ts`'s `enterPhase(sessionId, 'thinking')`).
 *
 * WHY A CADENCE AND NOT ONE STEP. The phase is not held by one row: the walk's own unattended runs
 * settle and the reduction returns the turn to `idle`, and the hold poll (`busyPollMs`, 250 ms)
 * releases the moment it reads `idle`. So the signal is re-asserted faster than the poll can observe a
 * gap — {@link BUSY_SIGNAL_INTERVAL_MS} is well under that poll — which is what keeps the hold engaged
 * for the whole case rather than for the second after the first row. The rows cost nothing a reading
 * looks at: they carry no message text, only the phase signal.
 *
 * SCOPED BY THE WALK, deliberately: the phase is keyed per session and is fixed by the rows THIS
 * scenario writes, so no sibling spec's session (which writes no such row) can be made busy by it.
 * That is why the busy reading is driven from the fixture rather than by teaching the debug host
 * driver a `runInFlight` — the latter would flip `busy` for every debug walk in the suite, not only
 * the one that means to measure the hold.
 */
const BUSY_SIGNAL_INTERVAL_MS = 150;
const BUSY_SIGNAL_WINDOW_MS = 45_000;
const busySignalSteps = (): Array<{ at: number; op: 'thinking-tokens' }> =>
  Array.from({ length: Math.floor(BUSY_SIGNAL_WINDOW_MS / BUSY_SIGNAL_INTERVAL_MS) }, (_unused, index) => ({
    at: index * BUSY_SIGNAL_INTERVAL_MS,
    op: 'thinking-tokens' as const,
  }));

const heldScenario = (title: string, seedText: string, turnCount = TURN_COUNT, busy = false) => {
  const turns = Array.from({ length: turnCount }, (_unused, index) => ({
    at: index * TURN_CADENCE_MS,
    op: 'unattended-turn' as const,
    text: turnText(index),
    trigger: 'cron' as const,
  }));
  const signal = busy ? busySignalSteps() : [];
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title, userText: seedText, lifecycleMode: 'resident' },
    // SORTED BY `at`: the engine sleeps until each step's offset and walks the list IN ORDER, so a
    // merged list that is not time-ordered would fire the later half all at once instead of on the
    // clock (see `busySignalSteps`).
    steps: [
      ...[...signal, ...turns].sort((a, b) => a.at - b.at),
      { at: turnCount * TURN_CADENCE_MS + TURN_TAIL_MS, op: 'wait' as const },
    ],
    // `turnCount` turns, plus every busy-signal row a busy walk opens with (all are transcript rows).
    expect: { rows: { delta: turnCount + signal.length }, content: { mustContain: [seedText] } },
  };
};

/**
 * The walk for the busy-RELEASE criterion (gap-live-voice-busy-release-quiet-window-next-priority).
 *
 * ONE turn held open for the whole case, so the host's own busy check (`turnByAppSession.has(...)`,
 * read before the runner is entered) answers true at every instant a send arrives and the release is
 * PUSHED into the CLI's queue; a cadence of phase rows, so the RELAY's reading stays busy — the relay
 * answers `hostRunActivity` for a debug-agent session from the activity store's turn phase, because
 * the debug host driver has no `runInFlight` (a Claude driver's `rounds` is the reading it lacks); and
 * then the two steps the criterion's ORDER is read off: a `dequeue` that starts whatever the queue is
 * holding, and the turn's own terminal row.
 *
 * THE PHASE CADENCE IS NOT PACING. The phase is reduced from the rows this walk writes and carries no
 * clock of its own; the reason it is a cadence and not a single step is the relay's busy poll (250 ms),
 * which releases the hold the moment it reads `idle`. Re-asserting the phase every
 * {@link BUSY_SIGNAL_INTERVAL_MS} — well under that poll — keeps the relay's own reading of "busy"
 * engaged across the whole window, which is what makes the release point a reading rather than a race.
 *
 * A SINGLE TURN, NOT A CADENCE OF THEM. {@link heldScenario} opens a turn per second because its cases
 * need a turn to EXIST whenever a send lands. Here the turn must stay open across everything, so the
 * walk opens one and never ends it: a walk that ended its turn would let the relay's run-end release
 * take over, and the release the case is about would never happen.
 */
const RELEASE_DEQUEUE_AT_MS = 12_000;
const RELEASE_RESULT_AT_MS = 16_000;
const RELEASE_TAIL_MS = 240_000;

const busyReleaseScenario = (title: string, seedText: string) => {
  const signal = busySignalSteps();
  return {
    version: 1,
    dialect: 'claude',
    home: 'gate',
    transcript: { mode: 'per-row-jsonl' },
    seed: { title, userText: seedText, lifecycleMode: 'resident' },
    // SORTED BY `at` for the same reason {@link heldScenario} sorts: the engine walks the list IN
    // ORDER and sleeps to each step's offset, so a list that is not time-ordered fires the later half
    // all at once. The turn's row is FIRST among the `at: 0` steps on purpose — the lease has to be
    // named before a delivery can be pushed into the session.
    steps: [
      ...[
        { at: 0, op: 'unattended-turn' as const, text: turnText(0), trigger: 'cron' as const },
        ...signal,
        { at: RELEASE_DEQUEUE_AT_MS, op: 'dequeue' as const },
        { at: RELEASE_RESULT_AT_MS, op: 'turn-result' as const },
      ].sort((a, b) => a.at - b.at),
      { at: RELEASE_TAIL_MS, op: 'wait' as const },
    ],
    // One turn row, the busy-signal rows, the `started` life-cycle row and the turn's terminal row.
    expect: { rows: { delta: 1 + signal.length + 2 }, content: { mustContain: [seedText] } },
  };
};

// ---------------------------------------------------------------------------------------------
// The page helpers — the same shapes the sibling voice specs use.
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

/** A session a walk was armed on: the id the UI addresses it by, and the file the walk writes. */
type ArmedSession = { sessionId: string; transcriptPath: string };

async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown,
): Promise<ArmedSession> {
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

/**
 * Brings a session's substitute process up, through the endpoint the status bar's own control calls.
 *
 * Load-bearing, not setup: an `unattended-turn` step resolves the session's PROCESS before it opens
 * the turn on it, so a walk fired against a session no host is bound to opens nothing — and every
 * send below would then find an idle session and be answered `queued: false`.
 */
async function startResidentProcess(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`);
  if (!response.ok()) {
    throw new Error(
      `could not start the resident process for ${sessionId}: ${response.status()} ${await response.text()}`,
    );
  }
}

/**
 * Fires a walk. NEVER AWAITED BEFORE A READING: `/clock` answers when the walk ENDS, and a walk here
 * is parked for minutes past the readings it exists to make possible. Its outcome is reduced to a
 * settled value so a failure elsewhere is not shadowed by an unhandled rejection.
 */
function fireClock(api: APIRequestContext, sessionId: string) {
  return api
    .post('/api/debug-agent/clock', { data: { sessionId } })
    .then(async (response) => ({ ok: response.ok(), status: response.status() }))
    .catch((error: unknown) => ({ ok: false, status: -1, failed: String(error) }));
}

const phase = async (page: Page): Promise<string> =>
  ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim();

const waitForPhase = (page: Page, wanted: string) =>
  expect.poll(() => phase(page), { timeout: 25_000 }).toBe(wanted);

/**
 * Waits until the walk has opened a turn whose row was written at or after `since`.
 *
 * THE BARRIER BEFORE EVERY SEND THAT FOLLOWS A STOP. Both things that can stop a command from being
 * queued — the abort an interrupt performs, and the push a delivery performs — leave the session with
 * NO turn open, and a send that arrives in that window OPENS one instead of joining one. `since` is
 * therefore always a moment taken AFTER such an event was observed (the `sent` frame a push settles,
 * the `stopped` frame an abort puts on the wire), and the wait is for the clock's next turn rather
 * than for a count: the walk's turns are on one absolute timeline, so one written after the stop is
 * the session really being mid-turn again.
 */
async function waitForTurnAfter(transcriptPath: string, since: number, timeoutMs: number): Promise<void> {
  await expect
    .poll(() => highestTurnSince(transcriptPath, since), {
      timeout: timeoutMs,
      message: 'the walk never opened another turn for the session to be holding',
    })
    .toBeGreaterThan(0);
}

/**
 * Arms a held walk, brings its process up, opens it in the browser, and fires the walk.
 *
 * THE ORDER IS LOAD-BEARING, all three steps of it: the process is started before the clock because
 * an `unattended-turn` needs a host to open its turn on; the clock is fired only once the page is in
 * voice and LISTENING because the walk's offsets are measured from the fire and the case's own setup
 * must not be spent inside them; and the return waits for the first turn to be on disk, which is the
 * reading that says the session is already mid-turn — the state that makes the case's first send a
 * queued delivery instead of a turn of its own.
 */
async function openHeldRun(
  page: Page,
  api: APIRequestContext,
  workspacePath: string,
  title: string,
  seedText: string,
  turnCount = TURN_COUNT,
  busy = false,
): Promise<ArmedSession> {
  const armed = await armScenario(api, workspacePath, heldScenario(title, seedText, turnCount, busy));
  await startResidentProcess(api, armed.sessionId);
  await openSession(page, armed.sessionId);
  await enterLiveVoice(page);
  await pushFirstCaptureFrame(page);
  await waitForPhase(page, 'listening');
  void fireClock(api, armed.sessionId);
  await waitForTurnAfter(armed.transcriptPath, 0, 30_000);
  return armed;
}

/** Writes a screenshot when QUAY_LIVE_VOICE_SHOT_DIR is set; a no-op in ordinary runs. */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.QUAY_LIVE_VOICE_SHOT_DIR;
  if (!dir) return;
  // Long enough for the bar's own transitions to have painted, short enough that eight shots are not
  // seconds of a run whose budget is 100 s.
  await page.waitForTimeout(400);
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

/** Leaves Live Voice and waits for the composer to come back. */
async function leaveLiveVoice(page: Page): Promise<void> {
  await page.getByTestId('voice-realtime-end').click();
  await expect(page.locator(BAR)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 15_000 });
}

/**
 * Navigates to a session and waits for its pane and composer.
 *
 * THE NAVIGATION IS BOUNDED-RELOADED, the same fallback shape `beforeAll` uses for its project row.
 * Under the load this file runs in, the first navigation can land before the client bundle (or the
 * dev server's dependency optimizer) is ready and the session pane then never mounts: measured
 * 2026-10-21 under four concurrent sibling lanes, a case died on the 30 s wait with
 * `element(s) not found` for `.chat-messages-pane`. The reload re-runs the SAME navigation once;
 * the assertion below is unchanged, so a page that is genuinely broken still fails — this is a
 * bounded retry of the navigation, not a longer patience with a missing pane, and it changes no
 * Playwright-level retry budget.
 */
async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/session/${sessionId}`);
  if (
    !(await page
      .locator(PANE)
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true, () => false))
  ) {
    await page.reload();
  }
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible({ timeout: 30_000 });
}

/** Sends one message through the composer's own submit path — the typed half of the interleave. */
async function typeAndSend(page: Page, text: string): Promise<void> {
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  await textarea.fill(text);
  await textarea.press('Enter');
}

/**
 * Has the endpoint close an utterance with `text`, and waits until the bar is showing those words.
 *
 * THE WAIT IS THE ORDERING BARRIER, and it is a reading rather than a sleep: the proxy answers a
 * final transcription in ONE synchronous step — it sends the `caption` frame to the page, counts the
 * utterance (`utteranceSeq`, the fence's `triggerSeq`) and raises the unforwarded count the duplicate
 * guard reads — so a page already rendering those words is proof all three have happened, and the
 * call below is fenced and deduped against the utterance it was meant to be about.
 *
 * The `itemId` has to be a NEW one per utterance: the page keys captions by it, so re-using an id
 * REPLACES the earlier words instead of arriving as a second utterance.
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

/** The parsed `output` of the tool result the app returned for `callId`, or `null`. */
function toolOutputFor(upstream: ScriptedUpstreamServer, callId: string): Record<string, unknown> | null {
  for (const entry of upstream.functionCallOutputs()) {
    const item = entry.item as Record<string, unknown> | undefined;
    if (item?.call_id !== callId) continue;
    const raw = item.output;
    if (typeof raw !== 'string') continue;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

const isLoopbackUrl = (url: string): boolean =>
  /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

// ---------------------------------------------------------------------------------------------
// The fake audio graph. No CI machine has a microphone, so the browser's capture is an inert graph.
// The ONE thing this file pushes into it is a first captured frame (`pushFirstCaptureFrame`):
// `listening` is only true once capture delivers a frame, and the scripted upstream drives every
// utterance from then on.
// ---------------------------------------------------------------------------------------------

/** The page-side capture probe `pushFirstCaptureFrame` drives (installed by {@link installFakeAudioGraph}). */
type CaptureProbe = {
  /** The most recently constructed worklet — the one the next `start()` adopts and wires. */
  node: { port: { onmessage: ((message: unknown) => void) | null } } | null;
  /** Worklets constructed so far: one per Live Voice capture session on this page. */
  constructed: number;
  /** `constructed` as of the last frame this file pushed. */
  pushed: number;
};

function installFakeAudioGraph(): void {
  type Port = { onmessage: ((m: unknown) => void) | null; postMessage: () => void };
  // The worklet is what capture delivers frames through, so the most recently constructed one is
  // the node a first frame has to reach. `constructed`/`pushed` let the helper make "exactly one
  // first frame per capture session" a page-side fact instead of a caller's promise.
  const capture = { node: null as { port: Port } | null, constructed: 0, pushed: 0 };
  class FakeWorkletNode {
    port: Port;
    constructor() {
      this.port = { onmessage: null, postMessage: () => undefined };
      capture.node = this;
      capture.constructed += 1;
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
  (window as unknown as { __voiceCaptureProbe: typeof capture }).__voiceCaptureProbe = capture;
}

/**
 * Pushes the one captured frame that makes `listening` reachable.
 *
 * WHY IT IS NEEDED. Upstream `state: open` only takes the bar to `arming`; `listening` is set when
 * capture delivers its FIRST frame (`useVoiceRealtimeSession.ts` → `beginCapture`). The fake graph
 * is inert, so without this frame every `waitForPhase(page, 'listening')` below would poll `arming`
 * until it timed out — the contract `c99a0eaba` introduced ("an arming phase until the first
 * captured frame") is real, and this spec has to satisfy it.
 *
 * WHEN IT LANDS. Only after `start()` has WIRED the most recently constructed worklet — `port.onmessage`
 * is assigned after the asynchronous acquisition, and a frame pushed before that is dropped — and only
 * once per worklet, so a later capture session's first frame cannot be satisfied by an earlier one.
 */
async function pushFirstCaptureFrame(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const capture = (window as unknown as { __voiceCaptureProbe?: CaptureProbe }).__voiceCaptureProbe;
          const node = capture?.node;
          if (!capture || !node || node.port.onmessage === null) return false;
          if (capture.pushed >= capture.constructed) return false;
          const samples = new Float32Array(3_200); // 200 ms at 16 kHz
          for (let index = 0; index < samples.length; index += 1) {
            samples[index] = 0.2 * Math.sin((2 * Math.PI * 180 * index) / 16_000);
          }
          node.port.onmessage({ data: { type: 'pcm', samples } });
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

/**
 * Records every JSON frame the app was HANDED on a socket, by subclassing `WebSocket` — the app's own
 * handlers keep working, and the recorded frames are copies of what the app already carried.
 *
 * WHY INBOUND, AND WHY HERE. The model is NOT the party told what the CLI did: the relay answers its
 * `session_send` call the moment it is made, with the coalescing window's own receipt, and the CLI's
 * answer — the one carrying `queued` and the `queuedMessageUuid` — travels to the BROWSER as the
 * `sent` frame once that window closes. So the browser is the only place that holds "this text, and
 * the id the host minted for it" together, in one list, in order. What the page SENDS is not recorded:
 * every reading below is about what the session answered, and `upstream.clientFrames()` already covers
 * the outbound half where it matters.
 */
const recordSocketFrames = () => {
  const page = window as unknown as { __socketInbound: unknown[] };
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
  } as unknown as typeof WebSocket;
};

const inboundFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() => (window as unknown as { __socketInbound: Array<Record<string, unknown>> }).__socketInbound ?? []);

/** One delivery the CLI QUEUED: the text the browser was told reached it, and the host's own id. */
type Delivery = { text: string; uuid: string };

/**
 * Every delivery the session QUEUED, oldest first.
 *
 * `queued: false` is dropped on purpose: a send that STARTED a run did not join the queue, so there
 * is no command behind it for the host to hold and no id for it to mint — it is not a delivery a
 * queue-order reading can place.
 */
async function deliveries(page: Page): Promise<Delivery[]> {
  const frames = (await inboundFrames(page)).filter((frame) => frame.type === 'sent');
  const out: Delivery[] = [];
  for (const frame of frames) {
    const result = frame.result as Record<string, unknown> | null | undefined;
    if (result?.queued !== true) continue;
    const uuid = result.queuedMessageUuid;
    if (typeof uuid !== 'string' || uuid === '') continue;
    out.push({ text: typeof frame.message === 'string' ? frame.message : '', uuid });
  }
  return out;
}

/**
 * The page's own frame counters as they stand right now.
 *
 * EVERY READING BELOW IS RELATIVE TO ONE OF THESE, and that is not tidiness. The page is shared by all
 * eight cases on purpose (one browser, one account, one fixture home), and the recorder is installed by
 * an init script — so `__socketInbound` never resets and the counters only ever climb. An absolute
 * `expect(count).toBe(3)` in the fifth case would be reading the first four cases' frames as well.
 */
type FrameBaseline = { sent: number; stopped: number; queued: number };

async function frameBaseline(page: Page): Promise<FrameBaseline> {
  const frames = await inboundFrames(page);
  return {
    sent: frames.filter((frame) => frame.type === 'sent').length,
    stopped: frames.filter((frame) => frame.type === 'stopped').length,
    queued: (await deliveries(page)).length,
  };
}

/**
 * Waits until `expected` more QUEUED deliveries have reached the browser.
 *
 * ⛔ THIS IS THE BARRIER BETWEEN TWO `session_send` CALLS, and getting it wrong is how this file first
 * went red. A `sent` frame is emitted when a delivery SETTLES — which is when the relay's coalescing
 * window closes (2.5 s, hardcoded, no env seam) — so a second call made before the first settled lands
 * INSIDE that window, where the relay folds the two into ONE message: one delivery, and no queue id for
 * the second sentence at all. Waiting for the delivery instead is what makes each call its own command,
 * which is what every order reading here needs.
 *
 * AND IT IS ALSO THE CLOCK THE FILE IS PACED ON: a queued delivery is the reading that says the CLI is
 * holding this sentence, which is the moment the next one may be spoken.
 */
async function waitForQueued(page: Page, base: FrameBaseline, expected: number, timeoutMs: number): Promise<void> {
  await expect
    .poll(async () => (await deliveries(page)).length - base.queued, {
      timeout: timeoutMs,
      message: `fewer than ${expected} queued deliveries settled`,
    })
    .toBeGreaterThanOrEqual(expected);
}

/** How many `stopped` frames the server has put on a socket this page holds SINCE `base`. */
async function stoppedSince(page: Page, base: FrameBaseline): Promise<number> {
  return (await inboundFrames(page)).filter((frame) => frame.type === 'stopped').length - base.stopped;
}

/**
 * The count the bar is showing right now, or `-1` when the attribute is not on screen at all — a
 * value no real reading can take, so a missing bar cannot pass as a zero-depth one.
 */
async function depthShown(page: Page): Promise<number> {
  return Number((await page.locator(STATUS).getAttribute('data-queued-depth')) ?? '-1');
}

/**
 * The text of the ONE card the relay's hold is drawing, as the page renders it (0 entries when
 * nothing is held — the card comes down with the clear frame).
 *
 * The string is the WHOLE card — the merged words followed by the card's own labels ("Queued", "Will
 * send when this finishes") — so a caller asserts `toContain` on the words rather than equality. The
 * card is ONE per hold, never one per sentence: what this reading is for is that the words of every
 * sentence spoken while busy are in it, in the order they were spoken.
 */
const heldCardTexts = (page: Page): Promise<string[]> =>
  page.locator(HELD_CARD).evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim()));

/**
 * Waits until the ONE held card's text carries `needle` — the HOLD's own barrier.
 *
 * The sibling of {@link waitForQueued}, for the post-ruling model. A held relay is answered with a
 * `pending` frame, which the page draws as the one card; a delivery is announced by a `sent` frame
 * instead. So a case that measures the hold paces itself on the CARD, and a case that measures a
 * delivery paces itself on the queue — waiting for the wrong one is how a case would read a state the
 * model it names does not produce.
 */
async function waitForHeldCard(page: Page, needle: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(async () => (await heldCardTexts(page)).some((text) => text.includes(needle)), {
      timeout: timeoutMs,
      message: `the held card never carried ${JSON.stringify(needle)}`,
    })
    .toBe(true);
}

type QueueReading = { queued: string[] };

/** The commands the substitute process is holding, oldest first — the CLI's own account. */
async function readQueue(api: APIRequestContext, sessionId: string): Promise<QueueReading> {
  const response = await api.get(`/api/debug-agent/queue?sessionId=${encodeURIComponent(sessionId)}`);
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/debug-agent/queue answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  return { queued: (body?.data?.queued ?? []) as string[] };
}

/**
 * The CLI's queue order, spelled in the words the browser was told it was holding.
 *
 * The two parties are read SEPARATELY and then joined on the ONE thing they cannot disagree about:
 * the host mints the id, the browser is handed that same id on the `sent` frame. A command the
 * browser was never handed an id for keeps its id in the reading rather than being dropped, so the
 * order is never silently shortened by a delivery this file failed to observe.
 */
async function hostQueueOrder(page: Page, api: APIRequestContext, sessionId: string): Promise<string[]> {
  const byUuid = new Map((await deliveries(page)).map((delivery) => [delivery.uuid, delivery.text]));
  return (await readQueue(api, sessionId)).queued.map((uuid) => byUuid.get(uuid) ?? `<unobserved:${uuid}>`);
}

// The cases below pace themselves on the app's own acknowledgements rather than on fixed sleeps, but
// each one still has to enter and leave Live Voice and wait on a real MCP round trip; the sibling
// scripted-upstream file budgets the same shape at 240 s, and the default 60 s per-test watchdog
// would kill a healthy case mid-reading — a red that says nothing about what it was measuring.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('voice realtime intent control', () => {
  let page: Page;
  let api: APIRequestContext;
  let upstream: ScriptedUpstreamServer;
  let workspacePath = '';
  let workspaceName = '';

  /** Every non-loopback URL the PAGE reached, so "no cloud call" is a reading rather than a claim. */
  const nonLoopbackRequests: string[] = [];
  const nonLoopbackWebSockets: string[] = [];
  /** Uncaught page errors — evidence for a failing case, never part of the egress reading. */
  const pageErrors: string[] = [];

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
    workspacePath = path.join(fixtureHome, 'voice-intent-control-workspace');
    workspaceName = path.basename(workspacePath);

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();

    api = await request.newContext({ baseURL: clientUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });

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
    // The outbound reading (AC3): every URL the page reaches that is not loopback, and every socket
    // it opens, recorded from the first byte the page loads.
    page.on('request', (r) => {
      const url = r.url();
      if (!isLoopbackUrl(url)) nonLoopbackRequests.push(url);
    });
    page.on('websocket', (ws) => {
      const url = ws.url();
      if (!isLoopbackUrl(url)) nonLoopbackWebSockets.push(url);
    });
    // A page error is not a cloud call, so it is kept apart from the egress reading and reported
    // only if the case that produced it fails.
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/api/voice/health', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
    );

    const seeded = await armScenario(api, workspacePath, SCENARIO);
    await page.goto('/');
    if (
      !(await projectRow(page, workspaceName)
        .waitFor({ state: 'visible', timeout: 25_000 })
        .then(() => true, () => false))
    ) {
      await page.reload();
    }
    await revealSession(page, workspaceName, seeded.sessionId);
    await sessionRow(page, seeded.sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
  });

  /**
   * The upstream is ONE server for the whole file, so anything a case arms on it is every later
   * case's state too. What is armed here is the dial refusal: case 4 refuses the dials that follow its
   * drop, precisely so the relay cannot quietly re-open the line — and a case after it has a dial of
   * its own to make. Reset before each case rather than after the one that arms it, so the reader of
   * case 4 does not have to know which case comes next.
   */
  test.beforeEach(() => {
    upstream?.refuseDials(0);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
    await upstream?.close();
  });

  /**
   * Case 1 — the sentences spoken during a run, and the correction that has to overtake them.
   *
   * THREE READINGS THE UNIT CRITERIA CANNOT TAKE. (a) The ONE card the relay's hold draws carries the
   * sentences spoken while the session is busy, in the order they were spoken — read from the page and
   * compared against the words the browser was told the relay was holding. (b) The depth the bar shows
   * is a count drawn from the party that owns it — the proxy while it is holding a sentence, the
   * session for the queue itself — and never a number the page computed; WHY THE TWO CANNOT BE
   * COMPARED HERE is spelled out at the reading. (c) The interrupt's correction folds the held words
   * and the interruption's note into the SAME message the CLI is handed (enqueue-then-abort), so that
   * one command — and nothing else — is what the next turn's input holds.
   *
   * ⛔ THE DELIVERY READINGS WERE RE-ANCHORED TO THE POST-RULING MODEL (2026-10-14 human ruling; AC6).
   * The pre-ruling file asserted that each spoken sentence became a command of its OWN in the CLI's
   * queue (`hostQueued === 2`, a `waitForQueued` per sentence, `order.length === 4`). Under the ruling
   * that is the opposite of what a BUSY session does: the relay keeps every sentence out of the CLI's
   * queue (零逐句投递), draws ONE merged pending card, and the interrupt folds the held words + the
   * correction + the note into ONE enqueue-then-abort. So the readings below are the post-ruling ones:
   * zero per-sentence deliveries while busy, one merged card, one folded command.
   *
   * THE WALK IS BUSY FOR ITS WHOLE LENGTH (see {@link BUSY_SIGNAL_STEP}): the turn-phase signal it
   * opens with makes the host report a run in flight, so the hold engages on the first word and the
   * sentences never reach the CLI until the interrupt folds them in. Cases 2–7 keep the queue-model
   * walk (see {@link heldScenario}) because their readings are about the queue itself.
   *
   * AC3 IS READ HERE TOO: the upstream's dial really happened, it carried NO credential, and nothing
   * the page touched left the loopback.
   */
  test('sentences spoken during a run stay visible one by one, the bar depth is read from the party that owns it, and the correction lands ahead of what followed it', async () => {
    const OPENING = 'open the held turn for the intent-control case';
    const SECOND = 'and also add the retry to the sync job';
    const CORRECTION = 'no — leave the sync job alone and fix the parser instead';
    const AFTER = 'and keep the parser change small';

    const armed = await openHeldRun(
      page,
      api,
      workspacePath,
      'Voice intent arm — backlog',
      'the held run the correction corrects',
      // BUSY (AC7): the walk opens with a turn-phase signal, so the host reports a run in flight and the
      // relay's hold engages — the sentences spoken below stay OUT of the CLI's queue until the
      // interrupt folds them in.
      TURN_COUNT,
      true,
    );
    const heldId = armed.sessionId;
    // The instant of the last event that could have left the session with no turn open (see
    // `waitForTurnAfter`): 0 until the first one, because the walk is already holding a turn.
    let vacancy = 0;

    // The dial really happened, and it really came HERE: the session cannot reach `listening` against
    // a server that never answered a handshake.
    await expect.poll(() => upstream.dialed(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(
      upstream.upgradeHeaders().some((headers) => 'authorization' in headers),
      'the blanked key must ride as NO credential, not as an empty one',
    ).toBe(false);

    const frames = await frameBaseline(page);

    // ---- sentence 1 is spoken into the run the walk is holding, and HELD ---------------------------
    await hearUtterance(page, upstream, 'intent-heard-1', OPENING);
    upstream.emit(functionCall('session_send', { message: OPENING }, 'intent-call-1'));
    // THE HOLD'S OWN BARRIER. A held relay is answered with a `pending` frame (never a `sent` one): the
    // buffer's account of what it is holding, which the page draws as the ONE card. Waiting for the
    // card to carry the words is proof the hold engaged — and it replaces the per-sentence
    // `waitForQueued` the pre-ruling file waited on, which measured a delivery the busy model forbids.
    await waitForHeldCard(page, OPENING, 20_000);
    vacancy = Date.now();

    // ---- sentence 2 is spoken into the same run and HELD -------------------------------------------
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    await hearUtterance(page, upstream, 'intent-heard-2', SECOND);
    upstream.emit(functionCall('session_send', { message: SECOND }, 'intent-call-2'));
    // (b) THE BAR'S QUEUE DEPTH COUNTS WHAT WAS HANDED OVER — AND NOTHING HAS BEEN. ⛔ RE-ANCHORED
    // (AC6). Pre-ruling this second call opened a 1 s coalescing window, so the bar's
    // `data-queued-depth` rose for as long as the proxy was holding a sentence ON ITS WAY OUT. Under
    // the ruling the hold is a DIFFERENT wait: while the session is busy nothing is on its way out, so
    // the bar's queue count stays 0 and the hold's own measure is the CARD (asserted below), never the
    // bar's depth. Each count is read from the party that owns it: the bar counts what reached the
    // session, the card is the relay's account of what it is holding.
    await expect
      .poll(() => depthShown(page), {
        timeout: 20_000,
        message: 'the bar must count nothing handed over while the relay holds',
      })
      .toBe(0);
    // The second sentence joined the SAME card, after the first — one card, both sentences, in order.
    await waitForHeldCard(page, SECOND, 20_000);
    vacancy = Date.now();

    // The run the sentences are queueing behind is the walk's own held turn, and it is on screen: a
    // session the person can see working is the one whose queue the bar is showing a depth for.
    await expect(page.getByTestId('running-turn-stop')).toBeVisible({ timeout: 30_000 });

    // (b, cont.) THE SESSION'S OWN COUNT IS READ WHERE IT LIVES. The equality this case wants —
    // "the depth the bar shows is what the session really holds" — is a comparison of TWO PARTIES'
    // accounts, and only one of the two is readable in this environment. `data-queued-depth` is
    // `queuedDepth()`: the proxy's own holds PLUS the session's queue when the proxy can read it,
    // and that last term is a pull seam (`hostQueueReading` → `pendingQueuedInputs`, wired at
    // `server/index.ts:734`) that answers `null` for this session. `null` is the documented UNKNOWN,
    // not a defect this file can read away: `provider-runtime.service.ts:812` lists "a driver
    // without the verb" among the answers that mean unknown depth, and the debug agent's host-driver
    // entry carries no `pendingQueuedInputs` (the Claude provider's does). So this case reads each
    // party's own account instead of pretending to compare them: the bar's number is the proxy's
    // (asserted above), and the session's queue is read from the session. The equality needs a
    // provider whose driver implements the depth verb — which is exactly what the queue-depth
    // criteria stand a scripted host up for
    // (`server/modules/voice-realtime/tests/voice-realtime-queue-depth-truth.test.ts`).
    const hostQueued = (await readQueue(api, heldId)).queued.length;
    console.log(`reading.barDepth=${await depthShown(page)} reading.hostQueued=${hostQueued}`);
    // ⛔ RE-ANCHORED (AC6). The pre-ruling file asserted `hostQueued === 2` — the two sentences as TWO
    // commands in the CLI's queue. Under the ruling a BUSY session takes NO per-sentence delivery, so
    // the CLI's queue is EMPTY here, and that emptiness IS the reading (零逐句投递). What the session is
    // holding is the relay's ONE merged message, which has not been delivered and so is not in the queue.
    expect(hostQueued, 'a busy session takes no per-sentence delivery, so the CLI queue is empty').toBe(0);
    // The same fact from the browser's side: no `sent` frame was put on the socket either.
    expect(
      (await deliveries(page)).length - frames.queued,
      'the relay delivered nothing while the session is busy',
    ).toBe(0);

    // (a) ONE CARD for the message the session is waiting on, the sentences in speech order — while
    // the session is busy every sentence is merged into ONE held message, so the page draws one card
    // whose text carries both, not a row per sentence.
    await expect(page.locator(HELD_CARD)).toHaveCount(1);
    const heldCard = await heldCardTexts(page);
    expect(heldCard[0], `the one held message carries both sentences in speech order: ${JSON.stringify(heldCard)}`)
      .toContain(OPENING);
    expect(heldCard[0], `the one held message carries both sentences in speech order: ${JSON.stringify(heldCard)}`)
      .toContain(SECOND);
    expect(
      heldCard[0]!.indexOf(OPENING),
      `the ONE merged card keeps the sentences in speaking order: ${JSON.stringify(heldCard)}`,
    ).toBeLessThan(heldCard[0]!.indexOf(SECOND));
    await shot(page, 'intent-control-queued');

    // ---- the correction: one spoken judgement carrying the corrected instruction -------------------
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    await hearUtterance(page, upstream, 'intent-heard-3', CORRECTION);
    upstream.emit(
      functionCall(
        'session_interrupt',
        { intent: 'the user changed direction mid-turn', heard: CORRECTION, message: CORRECTION },
        'intent-interrupt',
      ),
    );
    await expect.poll(() => toolOutputFor(upstream, 'intent-interrupt') !== null, { timeout: 20_000 }).toBe(true);
    const receipt = toolOutputFor(upstream, 'intent-interrupt');
    console.log(`reading.interruptReceipt=${JSON.stringify(receipt)}`);
    expect(receipt?.reason, 'a stop whose correction was enqueued is not a covered or refused one').toBeUndefined();
    await expect.poll(() => stoppedSince(page, frames), { timeout: 20_000 }).toBe(1);
    // ⛔ RE-ANCHORED (AC6): the interrupt FOLDS the hold. A stop that arrives with words held is ONE
    // utterance — "stop, do this instead" — so the held words, the new words and the interruption's
    // note go to the session as EXACTLY ONE message, enqueued BEFORE the abort (enqueue-then-abort).
    // The browser is therefore handed exactly ONE `sent` frame for the whole thing.
    await expect
      .poll(async () => (await deliveries(page)).length - frames.queued, {
        timeout: 20_000,
        message: 'the interrupt must fold the hold into exactly one delivery',
      })
      .toBe(1);
    const folded = (await deliveries(page)).at(-1)!;
    console.log(`reading.foldedText=${JSON.stringify(folded.text.slice(0, 160))}`);
    let foldCursor = -1;
    for (const piece of [OPENING, SECOND, CORRECTION]) {
      const at = folded.text.indexOf(piece);
      expect(at, `the ONE folded message carries ${JSON.stringify(piece)}: ${JSON.stringify(folded.text)}`)
        .toBeGreaterThan(-1);
      expect(at, `the folded pieces keep speaking order: ${JSON.stringify(folded.text)}`).toBeGreaterThan(foldCursor);
      foldCursor = at;
    }
    // The abort vacated the turn the correction was enqueued into; the next send needs the clock to
    // have put the session back mid-turn before it can join anything.
    vacancy = Date.now();

    // ---- and the sentence spoken AFTER the correction ----------------------------------------------
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    await hearUtterance(page, upstream, 'intent-heard-4', AFTER);
    upstream.emit(functionCall('session_send', { message: AFTER }, 'intent-call-4'));
    // The session is STILL busy, so this sentence joins a NEW hold rather than the CLI's queue: the
    // card carries it, and no further delivery appears (the one folded message remains the only one).
    await waitForHeldCard(page, AFTER, 20_000);
    expect(
      (await deliveries(page)).length - frames.queued,
      'the sentence after the correction is held too: still exactly one delivery',
    ).toBe(1);

    // (c) THE NEXT TURN'S INPUT, read as the CLI's own queue, oldest first, joined to the words the
    // browser was handed by the ONE thing neither party can invent: the command id the host minted.
    // ⛔ RE-ANCHORED (AC6): the queue no longer holds FOUR commands. The busy hold kept every spoken
    // sentence out of it, and the interrupt folded the held words + the correction + the note into ONE
    // command — so the queue holds exactly ONE, and the sentence spoken after the correction, still
    // held by the relay, is NOT among them.
    const order = await hostQueueOrder(page, api, heldId);
    console.log(`reading.cliOrder=${JSON.stringify(order.map((text) => text.slice(0, 48)))}`);
    expect(order.length, `the interrupt folds the hold into ONE queued command: ${JSON.stringify(order)}`).toBe(1);
    expect(order[0], `the one queued command carries the held words: ${JSON.stringify(order)}`).toContain(OPENING);
    expect(order[0], `the one queued command carries the correction: ${JSON.stringify(order)}`).toContain(CORRECTION);
    expect(
      order.some((text) => text.includes(AFTER)),
      `the sentence after the correction is held, not queued: ${JSON.stringify(order)}`,
    ).toBe(false);

    // The card is ONE, and it holds the sentence spoken AFTER the correction. The interrupt spent the
    // previous hold — its note, the held sentences and the correction went to the session as ONE
    // message — so what the relay is holding now is only what followed it.
    await expect.poll(() => page.locator(HELD_CARD).count(), { timeout: 20_000 }).toBe(1);
    const heldAfter = await heldCardTexts(page);
    expect(heldAfter[0], `the card holds the sentence spoken after the correction: ${JSON.stringify(heldAfter)}`)
      .toContain(AFTER);
    await shot(page, 'intent-control-correction-queued');

    // ---- AC3: nothing the page touched left the loopback -------------------------------------------
    const CHROME_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'api.github.com']);
    const strayHosts = [...new Set(nonLoopbackRequests.map((url) => new URL(url).host))].filter(
      (host) => !CHROME_HOSTS.has(host),
    );
    console.log(`cloud.dialed=${upstream.dialed()} cloud.strayHosts=${JSON.stringify(strayHosts)}`
      + ` cloud.webSockets=${JSON.stringify(nonLoopbackWebSockets)}`);
    expect(strayHosts, `a non-loopback host outside the page's own chrome: ${strayHosts.join(', ')}`).toEqual([]);
    expect(nonLoopbackWebSockets, `the page opened a non-loopback socket: ${nonLoopbackWebSockets.join(', ')}`)
      .toEqual([]);

    await leaveLiveVoice(page);
  });

  /**
   * Case 2 — a typed message and a spoken sentence, interleaved, reach the CLI in the order they
   * happened.
   *
   * THIS IS THE ONE CASE NO UNIT CRITERION CAN TAKE. The typed half travels the chat websocket to the
   * control plane; the spoken half travels the voice socket, the proxy, the executor and the same
   * control plane. They are two different roads into one queue, so "the CLI received them in the
   * order they happened" is a claim about the two roads agreeing — and the only place it can be read
   * is the queue itself.
   *
   * THE READING NAMES ALL FOUR COMMANDS, and it gets their ids from the two parties each id belongs
   * to. The two SPOKEN sentences are named by the voice socket: the `sent` frame the browser was
   * handed carries both the words and the id the host minted for them. The two TYPED ones have no
   * delivery on that socket — they reached the queue down another road — so what names them is the
   * moment they joined: the queue is read either side of each typed send, and the entry that appeared
   * across it is the command that send queued. The final reading is therefore the CLI's own queue,
   * oldest first, with every one of its four entries identified — and "both ways round" is the
   * position of each typed id against the spoken one: typed-before-spoken, and spoken-before-typed,
   * preserved together in one list.
   */
  test('a typed message and a spoken sentence reach the CLI queue in the order they happened, both ways round', async () => {
    const OPENING = 'open the held turn for the interleave case';
    const TYPED_1 = 'typed while the run was still going';
    const SPOKEN = 'and then I said this out loud';
    const TYPED_3 = 'and finally I typed this one';

    const armed = await openHeldRun(
      page,
      api,
      workspacePath,
      'Voice intent arm — order',
      'the held run the typed and spoken words queue behind',
    );
    const heldId = armed.sessionId;
    let vacancy = 0;

    const frames = await frameBaseline(page);

    await hearUtterance(page, upstream, 'order-heard-open', OPENING);
    upstream.emit(functionCall('session_send', { message: OPENING }, 'order-call-open'));
    await waitForQueued(page, frames, 1, 20_000);
    vacancy = Date.now();
    await expect(page.getByTestId('running-turn-stop')).toBeVisible({ timeout: 30_000 });

    // The composer only exists outside Live Voice, so the interleave is a real mode change each way —
    // which is also what a person does. The turn barrier is taken before the TYPED send for the same
    // reason it is taken before a spoken one: a typed message into a session that is not mid-turn is a
    // turn, not a queue entry, and this case is about the queue.
    await leaveLiveVoice(page);
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    await typeAndSend(page, TYPED_1);
    await expect
      .poll(async () => (await readQueue(api, heldId)).queued.length, {
        timeout: 20_000,
        message: 'the typed message must reach the CLI queue while the run is in flight',
      })
      .toBe(2);
    // The entry that appeared across that send IS this typed command's id: the queue was one command
    // long before it and two after, so nothing else can have joined. This is how a typed command is
    // named here — it leaves no delivery on the voice socket for the browser to have been handed.
    const typedFirst = (await readQueue(api, heldId)).queued[1] as string;
    console.log(`reading.typedFirstUuid=${typedFirst}`);
    // The typed message pushed too, so it vacated the turn in its own right: the barrier before the
    // spoken one has to be taken from AFTER this push rather than from the opening sentence's.
    vacancy = Date.now();

    await enterLiveVoice(page);
    await pushFirstCaptureFrame(page);
    await waitForPhase(page, 'listening');
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    await hearUtterance(page, upstream, 'order-heard-spoken', SPOKEN);
    upstream.emit(functionCall('session_send', { message: SPOKEN }, 'order-call-spoken'));
    await waitForQueued(page, frames, 2, 20_000);
    vacancy = Date.now();

    await leaveLiveVoice(page);
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    await typeAndSend(page, TYPED_3);
    await expect
      .poll(async () => (await readQueue(api, heldId)).queued.length, { timeout: 20_000 })
      .toBe(4);
    // Same reading as the first typed one, from the other side: it arrived into a queue three long.
    const typedLast = (await readQueue(api, heldId)).queued[3] as string;
    console.log(`reading.typedLastUuid=${typedLast}`);

    // THE INTERLEAVE, BOTH WAYS ROUND — the CLI's own queue, oldest first, every entry named. The two
    // spoken sentences are named by the ids the browser was handed with their words; the two typed
    // ones by the send each appeared across.
    const voice = await deliveries(page);
    const uuidOf = (text: string): string => {
      const found = voice.find((delivery) => delivery.text.includes(text));
      if (!found) throw new Error(`no delivery carried "${text}": ${JSON.stringify(voice.map((d) => d.text))}`);
      return found.uuid;
    };
    const openingUuid = uuidOf(OPENING);
    const spokenUuid = uuidOf(SPOKEN);
    const queued = (await readQueue(api, heldId)).queued;
    console.log(`reading.interleaveQueue=${JSON.stringify(queued)} reading.openingUuid=${openingUuid}`
      + ` reading.spokenUuid=${spokenUuid}`);
    expect(queued, `the CLI holds the four commands in the order they happened: ${JSON.stringify(queued)}`)
      .toEqual([openingUuid, typedFirst, spokenUuid, typedLast]);
    expect(
      queued.indexOf(typedFirst),
      `a message typed before the sentence was spoken must sit ahead of it: ${JSON.stringify(queued)}`,
    ).toBeLessThan(queued.indexOf(spokenUuid));
    expect(
      queued.indexOf(typedLast),
      `a message typed after the sentence was spoken must sit behind it: ${JSON.stringify(queued)}`,
    ).toBeGreaterThan(queued.indexOf(spokenUuid));
    await shot(page, 'intent-control-interleave');
  });

  /**
   * Case 3 — the same correction, interrupted for twice, aborts once and says so once.
   *
   * The second call names the SAME utterance as the first with nothing said in between, so the fence
   * answers it `{stopped:false, reason:'covered'}`: the debounce D-7 exists to forbid, and — the
   * reading that matters to a person — NO second `stopped` frame. And because the covered path
   * returns before the correction is enqueued (G1 runs only on a stop that will happen), the
   * correction reaches the CLI exactly ONCE.
   *
   * The frame count is read rather than the DOM because the bar draws no per-stop node at all any more
   * (the strip, 2026-10-14): a second stop would be invisible on screen either way, so "no second
   * stop" is a frame count.
   */
  test('a second interrupt for the same correction aborts once, says so once, and enqueues the correction once', async () => {
    const WORDS = 'open the held turn for the covered case';
    const CORRECTION = 'no — take the other direction instead';

    const armed = await openHeldRun(
      page,
      api,
      workspacePath,
      'Voice intent arm — covered',
      'the held run the repeated stop leaves alone',
    );
    const heldId = armed.sessionId;
    let vacancy = 0;

    // Taken BEFORE the first call: a baseline read after it would already contain the frame the wait
    // below is waiting for, and the wait would then hang until its timeout.
    const frames = await frameBaseline(page);
    await hearUtterance(page, upstream, 'covered-heard-1', WORDS);
    upstream.emit(functionCall('session_send', { message: WORDS }, 'covered-call-open'));
    await waitForQueued(page, frames, 1, 20_000);
    vacancy = Date.now();
    await expect(page.getByTestId('running-turn-stop')).toBeVisible({ timeout: 30_000 });

    const interrupt = (callId: string) =>
      functionCall(
        'session_interrupt',
        { intent: 'the user changed direction', heard: WORDS, message: CORRECTION },
        callId,
      );

    // The stop that DOES run: this connection has not interrupted for this utterance yet. The turn
    // barrier first, because the sentence above was a push and the push vacated the turn the
    // correction has to be enqueued into (G1 runs before the abort, and an enqueue needs a queue).
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    upstream.emit(interrupt('covered-stop-1'));
    await expect.poll(() => toolOutputFor(upstream, 'covered-stop-1') !== null, { timeout: 20_000 }).toBe(true);
    const first = toolOutputFor(upstream, 'covered-stop-1');
    console.log(`reading.coveredFirst=${JSON.stringify(first)}`);
    expect(first?.triggerSeq, `the stop names the utterance it was made on: ${JSON.stringify(first)}`).toBe(1);
    expect(first?.reason, 'a stop that ran is not covered').toBeUndefined();
    await expect.poll(() => stoppedSince(page, frames), { timeout: 20_000 }).toBe(1);
    await shot(page, 'intent-control-stopped');

    // And now the SAME call with nothing said in between.
    upstream.emit(interrupt('covered-stop-2'));
    await expect.poll(() => toolOutputFor(upstream, 'covered-stop-2') !== null, { timeout: 20_000 }).toBe(true);
    const second = toolOutputFor(upstream, 'covered-stop-2');
    console.log(`reading.coveredSecond=${JSON.stringify(second)}`);
    expect(second?.stopped, `the covered receipt: ${JSON.stringify(second)}`).toBe(false);
    expect(second?.reason, `the covered receipt: ${JSON.stringify(second)}`).toBe('covered');
    expect(second?.triggerSeq, 'it still names the utterance it was for').toBe(1);

    // One settle boundary is enough: the covered path returns BEFORE any `send`, so every later frame
    // on this socket would have to come after the result the upstream already holds.
    await page.waitForTimeout(2_000);
    console.log(`reading.stoppedFrames=${await stoppedSince(page, frames)} of 1 expected`);
    expect(
      await stoppedSince(page, frames),
      'the covered call put a second stop on the wire — a debounce read as a stop that happened',
    ).toBe(1);

    // The correction was enqueued once, by the stop that ran, and by nothing else: the sentence the
    // stop was made on is where it was, and the queue grew by exactly one command.
    const queue = await readQueue(api, heldId);
    const order = await hostQueueOrder(page, api, heldId);
    console.log(`reading.coveredQueue=${JSON.stringify(order.map((text) => text.slice(0, 40)))}`);
    expect(queue.queued.length, `exactly one correction reached the CLI: ${JSON.stringify(order)}`).toBe(2);
    expect(order[0]).toContain(WORDS);
    expect(order[1]).toContain(CORRECTION);

    await leaveLiveVoice(page);
  });

  /**
   * Case 4 — the upstream drops, nothing the CLI already held is lost, and what never made it
   * re-homes into the composer.
   *
   * THE DISCONNECT IS A REAL ONE: the socket is terminated without being asked, as a network loss is,
   * and the dials that follow are refused so the relay cannot quietly re-open and paper over it. The
   * enqueue the interrupt performed is a control-plane call that does not ride the upstream, so the
   * backlog it had already put in the CLI's queue has to survive the socket dying — that is the
   * reading. And the phrase the model heard but never relayed is NOT part of that backlog: it is the
   * person's own words, still unclaimed when the mode ends, so leaving Live Voice has to give it back
   * in the composer instead of swallowing it.
   *
   * BOTH READINGS ARE THE ONES THIS CASE WAS FIRST WRITTEN WITH — UN-RE-ANCHORED 2026-10-16. `8c3c60c99`
   * and `af3f21b9b` (AC-345) had turned them round: the phrase was read as riding the correction (a
   * queue entry carrying it) and therefore as NOT re-homed. That re-anchor rested on the span guard —
   * a delivery's heard sentences measured against its own words by adjacent-character-pair overlap
   * and, where "uncovered", spliced in verbatim in front (the pair-overlap span guard).
   * The guard and its module are deleted by the ruling of 2026-10-16 (task
   * `gap-live-voice-one-text-per-segment-prefer-response`): 每个语音片段只应有一次文本进入 CLI；优先用
   * response；仅在确认一段音频没有 response 时才 fallback 到 transcript. The live round of that day
   * (journal `3d2d3b2c`, 13:20) is why: the endpoint misheard "LiveWire" as "来望也", the model
   * repaired it off the audio IN THE SAME RESPONSE, and the measure scored the pair 0.462 — a rewrite
   * read as a drop, the mishearing delivered in front of the words that corrected it. An interrupt
   * whose call carries a correction IS a response for its span, so it delivers the correction alone;
   * what the span left unclaimed — here the phrase — is answered for exactly where AC-345's own
   * counter-argument said it would be: not "上了屏、投递无门", but handed back to the input box.
   *
   * THE DISCRIMINATION IS KEPT, AND IT IS THE REVERSE OF THE RE-ANCHORED ONE: restore the guard and
   * the queue carries the phrase, so the assertion below goes red.
   */
  test('an upstream disconnect during the interrupt loses no backlog, and the phrase that never made it re-homes into the composer', async () => {
    const OPENING = 'open the held turn for the disconnect case';
    const PHRASE = 'and this phrase is never relayed to the session';
    const CORRECTION = 'no — hold the queue together and fix the reconnect path';

    const armed = await openHeldRun(
      page,
      api,
      workspacePath,
      'Voice intent arm — disconnect',
      'the held run the dropped socket leaves behind',
    );
    const heldId = armed.sessionId;

    const frames = await frameBaseline(page);
    await hearUtterance(page, upstream, 'drop-heard-open', OPENING);
    upstream.emit(functionCall('session_send', { message: OPENING }, 'drop-call-open'));
    await waitForQueued(page, frames, 1, 20_000);
    await expect(page.getByTestId('running-turn-stop')).toBeVisible({ timeout: 30_000 });

    // The interrupt, and then the line goes down WHILE it is still settling: the correction's enqueue
    // is in flight against the control plane, not against the upstream this socket speaks to.
    //
    // The turn barrier matters more here than anywhere else: `session_interrupt` enqueues its
    // correction DIRECTLY — no coalescing window stands between the call and the delivery — so a
    // correction spoken into the slot the opening push just freed would find an idle session, be
    // answered `queued: false`, and be refused rather than delivered (which is case 5's fault, not
    // this one's).
    //
    // ⛔ THE BARRIER STANDS BEFORE THE SPOKEN SENTENCE, NOT BETWEEN IT AND THE INTERRUPT. Rule v2's
    // omission fill pays an unforwarded sentence forward `silence_ms` (3 s) after the
    // `transcription.completed` that heard it unless an interrupt closes the candidate first. The
    // barrier below depends only on the opening push having freed a slot — not on the phrase — but
    // standing between the phrase and the interrupt it put its own wait inside that 3 s window:
    // measured 2026-10-21 under load, that wait was ~8.4 s, the phrase was delivered by
    // `omission_fill {"reason":"fill"}` before the interrupt arrived, and there was nothing left to
    // re-home in the composer. Taken first, the phrase and the correction follow back-to-back inside
    // the window, so the interrupt closes the candidate and the phrase is still unclaimed when the
    // mode ends.
    const vacancy = Date.now();
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    // The phrase the model recognises and never forwards — the leave's backlog. The interrupt below
    // carries a correction, so that segment's response is the correction and nothing else is spliced
    // into it (2026-10-16; see the case comment), which leaves the phrase unclaimed for the composer.
    await hearUtterance(page, upstream, 'drop-heard-phrase', PHRASE);
    await hearUtterance(page, upstream, 'drop-heard-correction', CORRECTION);
    upstream.emit(
      functionCall(
        'session_interrupt',
        { intent: 'the user changed direction as the line dropped', heard: CORRECTION, message: CORRECTION },
        'drop-interrupt',
      ),
    );
    await page.waitForTimeout(250);
    upstream.refuseDials(20);
    upstream.drop();
    await expect.poll(() => upstream.liveConnectionCount(), { timeout: 15_000 }).toBe(0);

    // What the CLI was already holding survives the socket dying.
    await expect
      .poll(async () => (await readQueue(api, heldId)).queued.length, {
        timeout: 20_000,
        message: 'the disconnect must not take the backlog the CLI was already holding',
      })
      .toBeGreaterThanOrEqual(1);
    const order = await hostQueueOrder(page, api, heldId);
    console.log(`reading.afterDropQueue=${JSON.stringify(order.map((text) => text.slice(0, 40)))}`);
    expect(
      order.some((text) => text.includes(CORRECTION)),
      `the correction the interrupt enqueued must survive the drop: ${JSON.stringify(order)}`,
    ).toBe(true);
    // The phrase was never relayed, so nothing in the CLI's queue can be carrying it.
    const carrying = order.find((text) => text.includes(CORRECTION)) ?? '';
    console.log(`reading.correctionDelivery=${JSON.stringify(carrying)}`);
    expect(order.some((text) => text.includes(PHRASE)), 'a never-relayed phrase cannot be in the queue').toBe(false);
    await shot(page, 'intent-control-after-drop');

    // And the person's unclaimed words come back where they can still be sent from. The correction —
    // the one thing a delivery DID carry — is not offered back.
    await leaveLiveVoice(page);
    const draft = await page.locator(COMPOSER_TEXTAREA).inputValue();
    console.log(`reading.rehomedDraft=${JSON.stringify(draft)}`);
    expect(draft, `the composer draft was "${draft}"`).toContain(PHRASE);
    expect(draft, `a delivered correction must not be re-homed; draft "${draft}"`).not.toContain(CORRECTION);
    await shot(page, 'intent-control-draft-rehomed');
  });

  /**
   * Case 5 — an interrupt whose correction cannot be CONFIRMED as enqueued is answered honestly, and
   * the page is not told a stop happened.
   *
   * THE FAULT IS A MISSING CONFIRMATION, and it is the one the code actually reaches. G1 enqueues the
   * correction before it aborts, and it aborts ONLY on that enqueue being confirmed
   * (`queuedMessageUuid !== null || queued === true`). A confirmation the session does not give is
   * therefore the relay's own reading of "the correction never reached it" — and a correction that
   * never reached the session must not stop the run it was meant to correct. The receipt says so
   * (`stopped:false`, `reason:'revision-not-enqueued'`), the stop path is never entered, and — the
   * reading a person gets — NOTHING on the wire or on screen claims a stop.
   *
   * WHY THE CONFIRMATION IS THE READING AND THE QUEUE IS NOT. The gateway answers a delivery out of the
   * debug agent's chat-run registry while the sentence itself is queued by the agent's own host driver,
   * and the two disagree in exactly this walk: a `busy` dispatch never clears the driver's
   * `turnByAppSession`, while the push's carrier run DOES complete in the chat registry — so the next
   * dispatch finds a free slot, answers `{queued:false, queuedMessageUuid:null}`, and the driver pushes
   * the command anyway. The relay reads only the confirmation, so it withholds the stop. Asking the
   * CLI's queue whether the correction is there would therefore read this drift rather than the relay,
   * which is why what this case pins about the queue is that the refusal took NOTHING AWAY from it: a
   * receipt is honest about what its author can see, and what the relay can see is the confirmation.
   *
   * THE WALK OPENS ONE TURN AND THEN STOPS, which is what makes the fault deterministic rather than
   * raced: the opening sentence is a push (a turn is in flight in front of it, and a push's carrier
   * frees the slot as it is accepted), and no further turn is ever opened, so the correction's own
   * enquiry finds the idle session this case is about however long the run took to get there.
   *
   * AND THAT IS WHY NOTHING HERE WAITS FOR A RUN ON SCREEN. The slot the push freed is the same thing
   * that ends the run the page was drawing — the push's carrier supersedes it and resolves — so an
   * idle session and a visible `running-turn-stop` are mutually exclusive states in this walk, and the
   * fault under test IS the idle one. Waiting for the run here would be waiting for a state the fault
   * forbids; the readings below are the ones the fault's own shape leaves readable, and the sentence
   * that opened the case is the evidence that a run really was in flight in front of it.
   */
  test('an interrupt whose correction cannot be confirmed as enqueued says stopped:false, puts no stop on screen, and aborts nothing', async () => {
    const WORDS = 'open the held turn for the refused-correction case';
    const CORRECTION = 'no — take the other direction, this one cannot be queued';

    const armed = await openHeldRun(
      page,
      api,
      workspacePath,
      'Voice intent arm — refused correction',
      'the held run a refused correction must not stop',
      1,
    );
    const heldId = armed.sessionId;

    const frames = await frameBaseline(page);
    await hearUtterance(page, upstream, 'refused-heard-open', WORDS);
    upstream.emit(functionCall('session_send', { message: WORDS }, 'refused-call-open'));
    // The sentence reached the CLI's queue, which is the proof that a run was in flight in front of it:
    // a delivery is only ever pushed into a queue when the session is already mid-turn.
    await waitForQueued(page, frames, 1, 20_000);
    // What the CLI is holding the instant before the interrupt — the reading "aborts nothing" is
    // measured against, taken here so a later queue read cannot be credited to the interruption.
    const heldBefore = (await readQueue(api, heldId)).queued;
    console.log(`reading.queueBeforeRefusal=${JSON.stringify(heldBefore)}`);

    // The interrupt arrives with the session idle: the sentence above was a push, and the walk has no
    // turn left to open. Its delivery is therefore answered without a confirmation — and it must not
    // stop anything.
    upstream.emit(
      functionCall(
        'session_interrupt',
        { intent: 'the user changed direction with nothing in flight', heard: WORDS, message: CORRECTION },
        'refused-interrupt',
      ),
    );
    await expect.poll(() => toolOutputFor(upstream, 'refused-interrupt') !== null, { timeout: 20_000 }).toBe(true);
    const receipt = toolOutputFor(upstream, 'refused-interrupt');
    console.log(`reading.refusedReceipt=${JSON.stringify(receipt)}`);
    expect(receipt?.stopped, `a correction that never reached the session must not abort: ${JSON.stringify(receipt)}`)
      .toBe(false);
    expect(receipt?.reason, `the honest reason for a withheld stop: ${JSON.stringify(receipt)}`)
      .toBe('revision-not-enqueued');
    expect(typeof receipt?.detail, `the receipt carries WHY: ${JSON.stringify(receipt)}`).toBe('string');

    // No stop on the wire, and none on screen: the page must not read a refusal as a stop.
    await page.waitForTimeout(2_000);
    console.log(`reading.refusedStoppedFrames=${await stoppedSince(page, frames)} of 0 expected`);
    expect(await stoppedSince(page, frames), 'a withheld stop must put no `stopped` frame on the wire').toBe(0);
    await expect(
      page.locator(STOP_NOTICE_PREFIX),
      'the bar draws no stop notice for a stop that did not happen',
    ).toHaveCount(0);
    await expect(
      page.locator(STATUS),
      'the bar must not say「已停止」for a stop that did not happen',
    ).not.toContainText('已停止');
    await shot(page, 'intent-control-refused-correction');

    // The refusal is not cosmetic: it aborts nothing. Every command the CLI was holding before the
    // interrupt is still there after it — nothing was withdrawn, dequeued or cancelled by a correction
    // the relay refused — and the sentence the walk's turn is holding is still the first of them.
    const orderAfter = await hostQueueOrder(page, api, heldId);
    const heldAfter = (await readQueue(api, heldId)).queued;
    console.log(
      `reading.refusedQueueWords=${JSON.stringify(orderAfter.map((text) => text.slice(0, 40)))}`
        + ` reading.queueAfterRefusal=${JSON.stringify(heldAfter)}`,
    );
    expect(
      heldBefore.filter((uuid) => !heldAfter.includes(uuid)),
      `the refusal took a command out of the CLI's queue: ${JSON.stringify(heldAfter)}`,
    ).toEqual([]);
    expect(orderAfter.length, `the CLI's queue was emptied by the refusal: ${JSON.stringify(orderAfter)}`)
      .toBeGreaterThanOrEqual(1);
    expect(orderAfter[0], `the sentence the walk's turn was holding is gone: ${JSON.stringify(orderAfter)}`)
      .toContain(WORDS);

    await leaveLiveVoice(page);
  });

  /**
   * Case 6 — a malformed function call during a correction is RECOVERABLE.
   *
   * The endpoint cuts a generation off mid-arguments (`{"intent": ` — not JSON at all, and `[]` —
   * JSON that is not an object), which the bridge refuses as `MALFORMED_FUNCTION_CALL`. It is one
   * more thing that CAN go wrong between a person saying "no, do this instead" and the run turning,
   * and the whole point of it being recoverable is that it costs nothing: no abort, no red line on
   * screen, and the person's next correction still delivers.
   *
   * THE RECOVERABLE FRAME IS READ ON THE CONSOLE, not in the DOM, because that is where the client
   * puts it — the hook returns on `recoverable: true` without setting `error`. That is exactly the
   * shape being pinned: the same failure arriving as a fatal one would paint the bar red and end the
   * session.
   */
  test('a malformed function call during a correction is recoverable and the next correction still delivers', async () => {
    const WORDS = 'open the held turn for the malformed-call case';
    const CORRECTION = 'no — take the other direction, this one is fine';

    const armed = await openHeldRun(
      page,
      api,
      workspacePath,
      'Voice intent arm — malformed call',
      'the held run a malformed call must leave running',
    );
    const heldId = armed.sessionId;

    const frames = await frameBaseline(page);
    await hearUtterance(page, upstream, 'malformed-heard-open', WORDS);
    upstream.emit(functionCall('session_send', { message: WORDS }, 'malformed-call-open'));
    await waitForQueued(page, frames, 1, 20_000);
    await expect(page.getByTestId('running-turn-stop')).toBeVisible({ timeout: 30_000 });

    const warnings: string[] = [];
    const onConsole = (message: ConsoleMessage) => {
      if (/recoverable error/i.test(message.text())) warnings.push(message.text());
    };
    page.on('console', onConsole);

    // Both refused shapes, one after the other: not-JSON and JSON-that-is-not-an-object are two
    // different throws in the bridge, and a case that only exercised one would leave the other free.
    for (const [index, rawArguments] of [NOT_JSON_ARGUMENTS, NOT_AN_OBJECT_ARGUMENTS].entries()) {
      upstream.emit(malformedFunctionCall('session_interrupt', rawArguments, `malformed-call-${index}`));
    }
    await expect
      .poll(() => warnings.length, { timeout: 25_000, message: 'the client must report the malformed call as recoverable' })
      .toBeGreaterThanOrEqual(1);
    console.log(`reading.recoverableWarnings=${JSON.stringify(warnings)}`);
    expect(warnings.join(' | ')).toContain('MALFORMED_FUNCTION_CALL');

    // Nothing fatal on screen, nothing stopped, and the run is still there.
    await expect(page.getByTestId('voice-realtime-error'), 'a recoverable failure must not paint an error')
      .toHaveCount(0);
    expect(await stoppedSince(page, frames), 'a malformed call must not abort anything').toBe(0);
    await expect(page.getByTestId('running-turn-stop')).toBeVisible();
    page.off('console', onConsole);

    // And the next correction — a well-formed one — still reaches the session. The turn barrier is
    // read again here because the sentence above was itself a push, and a push frees the slot it was
    // taken from: without a turn opened after it, this delivery would open one of its own.
    const vacancy = Date.now();
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    await hearUtterance(page, upstream, 'malformed-heard-correction', CORRECTION);
    upstream.emit(functionCall('session_send', { message: CORRECTION }, 'malformed-call-correction'));
    await waitForQueued(page, frames, 2, 20_000);
    const order = await hostQueueOrder(page, api, heldId);
    console.log(`reading.afterMalformedQueue=${JSON.stringify(order.map((text) => text.slice(0, 40)))}`);
    expect(order.some((text) => text.includes(CORRECTION)), 'the next correction must still reach the session').toBe(true);
    await shot(page, 'intent-control-after-malformed');

    await leaveLiveVoice(page);
  });

  /**
   * Case 7 — the same utterance, relayed twice, reaches the session once (SPEC §11.2).
   *
   * The endpoint's transcription can arrive twice for one thing the person said — a reconnect, a
   * replay, a model that answers the same words again — and the person only said it once. The proxy's
   * duplicate guard is what makes the second relay a no-op: the relay's OWN answer says the message
   * has already reached the session, and the CLI's queue grows by nothing.
   *
   * THE READING IS THE QUEUE'S OWN GROWTH, not the page's, because that is the party the requirement
   * is about: "not delivered twice" means the CLI holds ONE command for the one sentence that was
   * said. The queue is already holding the sentence before it, so the count is read as a DELTA across
   * the replay rather than as an absolute — a number that only this case's own sentence can move.
   */
  test('the same utterance relayed twice reaches the session once', async () => {
    const OPENING = 'open the held turn for the idempotency case';
    const REPEATED = 'and add the retry to the sync job';

    const armed = await openHeldRun(
      page,
      api,
      workspacePath,
      'Voice intent arm — idempotency',
      'the held run the repeated relay must not double',
    );
    const heldId = armed.sessionId;

    const frames = await frameBaseline(page);
    await hearUtterance(page, upstream, 'replay-heard-open', OPENING);
    upstream.emit(functionCall('session_send', { message: OPENING }, 'replay-call-open'));
    await waitForQueued(page, frames, 1, 20_000);
    await expect(page.getByTestId('running-turn-stop')).toBeVisible({ timeout: 30_000 });

    // The sentence that will be relayed twice, delivered once. The turn barrier is read again because
    // the opening push freed the slot it was taken from.
    const vacancy = Date.now();
    await waitForTurnAfter(armed.transcriptPath, vacancy, 20_000);
    await hearUtterance(page, upstream, 'replay-heard-1', REPEATED);
    upstream.emit(functionCall('session_send', { message: REPEATED }, 'replay-call-1'));
    await waitForQueued(page, frames, 2, 20_000);
    const queuedOnce = (await readQueue(api, heldId)).queued.length;
    console.log(`reading.replayQueuedOnce=${queuedOnce}`);

    // The same sentence relayed a second time, with nothing said in between.
    upstream.emit(functionCall('session_send', { message: REPEATED }, 'replay-call-2'));
    await expect.poll(() => toolOutputFor(upstream, 'replay-call-2') !== null, { timeout: 20_000 }).toBe(true);
    const second = toolOutputFor(upstream, 'replay-call-2');
    console.log(`reading.replayReceipt=${JSON.stringify(second)}`);
    expect(String(second?.instruction), `the relay must say it already landed: ${JSON.stringify(second)}`)
      .toContain('already reached the session');

    // Longer than the coalescing window, because the reading is that NO delivery followed the replay:
    // a second command would land a whole window after the tool call it answered.
    await page.waitForTimeout(4_000);
    const order = await hostQueueOrder(page, api, heldId);
    console.log(`reading.replayQueue=${JSON.stringify(order.map((text) => text.slice(0, 40)))}`);
    expect((await readQueue(api, heldId)).queued.length, 'a replayed sentence must not lengthen the queue').toBe(
      queuedOnce,
    );
    expect(order.length, 'one sentence said once is one command, however many times it is relayed').toBe(
      queuedOnce,
    );
    expect(
      order.filter((text) => text.includes(REPEATED)).length,
      `exactly one command carries the repeated sentence: ${JSON.stringify(order)}`,
    ).toBe(1);
    // And the page was handed ONE card for the sentence, not two: the sentence said once is ONE held
    // message however many times it is relayed.
    expect((await heldCardTexts(page)).filter((text) => text.includes(REPEATED)).length).toBe(1);
    await shot(page, 'intent-control-replay-once');

    await leaveLiveVoice(page);
  });

  /**
   * Case 8 — the busy hold's SECOND way out (gap-live-voice-busy-release-quiet-window-next-priority).
   *
   * Case 1 above reads the post-ruling model with the upstream still speaking: a sentence said while
   * busy is HELD, and the hold is spent when the run ends (or an interrupt folds it). This task's
   * change adds a second way out — the upstream having stopped speaking for the quiet window — and
   * this case is its end-to-end reading: the hold leaves while the run is STILL IN FLIGHT, so the
   * sentence reaches the host's queue in time for the walk's own `dequeue` to start it, which the
   * transcript then records BEFORE the turn's terminal row.
   *
   * WHAT IS READ AND WHY IT IS THE ORDER. The criterion is not "a delivery appeared" (a run-end
   * release produces one too, only later) but WHERE it appeared relative to the turn's end: the
   * `command_lifecycle started` row the walk's `dequeue` writes, against the `result` row the turn
   * writes. Both are read off FILE ORDER (see {@link indexOfFirstStartedCommand}), so the assertion
   * carries no clock.
   *
   * ⛔ THE ARM THAT MAKES IT A CRITERION RATHER THAN A COINCIDENCE is the false form the task's AC5
   * names: with the release point reverted to "wait for the run to end", the hold is STILL held when
   * the walk reaches `dequeue` (`RELEASE_DEQUEUE_AT_MS`), the queue is empty, nothing starts, and the
   * sentence only leaves after `turn-result` — so there is no `started` row before the `result`, and
   * the assertion below reds rather than passing on a release it did not measure.
   */
  test('a sentence spoken while busy is released on the upstream quiet window and started before the turn has ended', async () => {
    const SPOKEN = 'while the turn is still running, add the retry to the sync job';

    const armed = await armScenario(
      api,
      workspacePath,
      busyReleaseScenario('Voice busy release arm', 'the held run the release criterion runs against'),
    );
    await startResidentProcess(api, armed.sessionId);
    await openSession(page, armed.sessionId);
    await enterLiveVoice(page);
    await pushFirstCaptureFrame(page);
    await waitForPhase(page, 'listening');
    void fireClock(api, armed.sessionId);
    await waitForTurnAfter(armed.transcriptPath, 0, 30_000);

    const frames = await frameBaseline(page);

    // ---- the sentence is spoken into the run the walk is holding, and is HELD -----------------------
    await hearUtterance(page, upstream, 'release-heard-1', SPOKEN);
    upstream.emit(functionCall('session_send', { message: SPOKEN }, 'release-call-1'));
    await waitForHeldCard(page, SPOKEN, 20_000);

    // ---- the endpoint stops speaking: the quiet window's OTHER reading ------------------------------
    // `input_audio_buffer.speech_stopped` is what the bridge routes to `onUpstreamTurn(false)`, and that
    // is the ONLY place the relay records "the person stopped talking" (`lastUpstreamSilenceAt`). A walk
    // that never sends one leaves the window with no silence to count from, so the hold could only ever
    // leave at the 20 s cap — which is the control this case would silently degrade into, measuring a
    // release it did not cause. So the frame is sent explicitly, and the release below is what proves
    // the window engaged.
    upstream.emit(speechStopped('release-heard-1', 0));

    // ---- the release: the hold leaves WITHOUT the run ending ----------------------------------------
    // A QUEUED delivery is the host's own statement that the sentence reached its queue while the turn
    // was still in flight. Its absence is this case's red: the hold would still be held when the walk
    // dequeues below, and nothing would start.
    await waitForQueued(page, frames, 1, 20_000);
    // The deliveries SINCE the baseline, not the page's whole history: the page is shared by every
    // case in this file, so `at(-1)` of the full list would be this case's own only by accident.
    const released = (await deliveries(page)).slice(frames.queued).at(-1)!;
    console.log(`reading.releasedText=${JSON.stringify(released.text.slice(0, 120))}`);
    expect(
      released.text,
      `the released command carries the spoken sentence: ${JSON.stringify(released.text)}`,
    ).toContain(SPOKEN);

    // ---- the walk's `dequeue` starts it, and the turn's terminal row lands after it -----------------
    await expect
      .poll(() => indexOfFirstStartedCommand(armed.transcriptPath), {
        timeout: 25_000,
        message: 'the walk never dequeued the released command (no `command_lifecycle started` row)',
      })
      .toBeGreaterThan(-1);
    await expect
      .poll(() => indexOfFirstTurnResult(armed.transcriptPath), {
        timeout: 25_000,
        message: "the walk never wrote the turn's terminal `result` row",
      })
      .toBeGreaterThan(-1);
    const startedAt = indexOfFirstStartedCommand(armed.transcriptPath);
    const resultAt = indexOfFirstTurnResult(armed.transcriptPath);
    console.log(`reading.startedAtRow=${startedAt} resultAtRow=${resultAt}`);
    expect(
      startedAt,
      `the command the busy hold released must be STARTED before the turn's result (started at row ` +
        `${startedAt}, result at row ${resultAt}) — a hold that waited for the run to end would start ` +
        'it only after the result, or never',
    ).toBeLessThan(resultAt);

    await shot(page, 'intent-control-busy-release');
    await leaveLiveVoice(page);
  });
});
