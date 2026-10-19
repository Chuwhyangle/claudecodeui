/**
 * E0 — the browser end of the unattended wav replay (`voice-output-e2e-harness`).
 *
 * WHAT IS REAL, AND WHAT IS A STAND-IN.
 *
 *   Real: the browser, the app server, the shipped `/voice-realtime` proxy and relay, the real
 *   `session_send` reaching the debug agent's resident control plane, the journal the proxy writes,
 *   the client's own PCM encoder and socket, the browser's `/api/voice/tts` request path and the
 *   `voicePlayer` that receives and plays the returned audio.
 *
 *   Stand-in, and named here so a green run cannot be read as more than it is:
 *     · the microphone is `wavMic.ts` — a fake Web Audio graph that pushes the REAL corpus window
 *       into the app's own worklet port, 100 ms at a time (`--use-file-for-fake-audio-capture`
 *       would be a real device path, but it cannot be driven frame-by-frame from a spec and it
 *       bypasses the harness the rest of the voice criteria share);
 *     · the DashScope Realtime endpoint is the repository's scripted upstream, which answers the
 *       app's handshake and, through `armVad`, closes utterances acoustically from the audio the
 *       app really sends. The transcript it completes for each utterance is the FROZEN recogniser
 *       output for this exact recording (`log/<id>.jsonl`), not an invented sentence;
 *     · the TTS backend is a local route stand-in: the browser's real `/api/voice/tts` request is
 *       answered with a valid WAV, so the leg proves "text → HTTP → bytes → browser playback"
 *       end-to-end without a cloud bill. The sibling AC-405 task owns the real cosyvoice synth;
 *       when its downlink frame lands, this spec is where its audio assertion is added.
 *     · the model's follow-up remark and the run-end summary are the harness's own sentences: the
 *       scripted endpoint says the announce text after each delivered `session_send`, and the app
 *       server runs with `VOICE_REALTIME_CLOSING_TURN=announce` plus a summary stand-in, so the
 *       narrator's WHOLE production path (gate → queue → `narrator_speak`) is exercised without a
 *       side text model. The run-end transition is real: the armed scenario ends each turn two
 *       seconds after it opens, and the proxy's own host poll observes that end.
 *
 * WHY THIS FILE IS UNDER `e2e/`. `playwright.config.ts` has `testDir: './e2e'` and a closed list of
 * spec basenames that arm the scripted endpoint, the debug-agent fixture home and continuous mode.
 * Reusing that harness (as the task requires) means being one of those basenames; rebuilding a
 * parallel server/browser boot under `experiments/` would be the second test base the task
 * forbids. The experiment itself — sample selection, window derivation and detector calibration —
 * lives in `experiments/voice-e2e-harness/run.mjs`, which launches this file.
 *
 * RUN
 *   node experiments/voice-e2e-harness/run.mjs [--sample <prefix>]
 *   # or directly, with a plan the runner wrote:
 *   VOICE_E2E_PLAN=/path/plan.json node_modules/.bin/playwright test e2e/voice-output-e2e-harness.spec.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import { installWavMic, playWavMic, wavMicReading } from '../experiments/voice-e2e-harness/wavMic';
import { startScriptedUpstream, type ScriptedUpstreamServer } from './voiceRealtimeScriptedUpstream';
import {
  awaitClientMounted,
  warmClientStartup,
  type ClientWarmupReading,
  type RequestFailure,
} from './support/client-startup-warmup';

// ── the plan the runner derived from the frozen corpus ────────────────────────────────────────
type Plan = {
  version: 1;
  sampleId: string;
  wavPath: string;
  sampleRate: number;
  windowStartMs: number;
  windowEndMs: number;
  expectedTranscripts: string[];
  vad: {
    timeBase: 'audio-time' | 'wall-clock';
    threshold: number;
    silenceDurationMs: number;
    sampleRate: number;
    expectedUtterances: number;
  };
  mic: { frameMs: number };
};

const PLAN_PATH = process.env.VOICE_E2E_PLAN;
if (!PLAN_PATH) {
  throw new Error(
    'VOICE_E2E_PLAN is not set — run this file through `node experiments/voice-e2e-harness/run.mjs`, ' +
      'which derives the sample window and detector parameters from the frozen corpus.',
  );
}
const PLAN = JSON.parse(readFileSync(PLAN_PATH, 'utf8')) as Plan;
if (PLAN.version !== 1 || PLAN.expectedTranscripts.length !== PLAN.vad.expectedUtterances) {
  throw new Error(`the plan at ${PLAN_PATH} is not a version-1 plan with one transcript per utterance`);
}

/**
 * The two sentences the narrator is expected to say, published by `run.mjs` beside the plan.
 *
 * They are read from the environment rather than restated here: the announce text is what the
 * scripted endpoint puts on the wire, and the summary text is what the app server's stand-in
 * producer returns. A literal on this side would be a second copy that could agree with itself
 * while disagreeing with what the run actually said.
 */
const ANNOUNCE_TEXT = process.env.VOICE_E2E_ANNOUNCE_TEXT;
const SUMMARY_TEXT = process.env.VOICE_E2E_SUMMARY_TEXT;
if (!ANNOUNCE_TEXT || !SUMMARY_TEXT) {
  throw new Error(
    'VOICE_E2E_ANNOUNCE_TEXT / VOICE_E2E_SUMMARY_TEXT are not set — run this file through ' +
      '`node experiments/voice-e2e-harness/run.mjs`, which publishes both beside the plan.',
  );
}

/** Reads the window out of the sample's WAV as the PCM16 the fake microphone will replay. */
function readWindowPcm(plan: Plan): { pcm16Base64: string; frames: number } {
  const buffer = readFileSync(plan.wavPath);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${plan.wavPath}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'data') data = buffer.subarray(body, Math.min(body + size, buffer.length));
    offset = body + size + (size % 2);
  }
  if (data === null) throw new Error(`${plan.wavPath}: missing data chunk`);
  const from = Math.floor((plan.windowStartMs * plan.sampleRate) / 1000) * 2;
  const to = Math.min(data.length, Math.floor((plan.windowEndMs * plan.sampleRate) / 1000) * 2);
  const window = data.subarray(from, to);
  const frameMs = plan.mic.frameMs;
  const frameBytes = Math.max(2, Math.round((plan.sampleRate * frameMs) / 1000) * 2);
  return { pcm16Base64: window.toString('base64'), frames: Math.ceil(window.length / frameBytes) };
}

const WINDOW_PCM = readWindowPcm(PLAN);

// ── the page's vocabulary ────────────────────────────────────────────────────────────────────
const PANE = '.chat-messages-pane';
const BAR = '[data-testid="voice-realtime-bar"]';
const STATUS = '[data-testid="voice-realtime-status"]';
const CAPTION = '[data-testid="voice-realtime-caption"]';
const USERNAME = 'voice-e2e-harness';
const PASSWORD = 'voice-e2e-harness-pass';
const SEED_USER_TEXT = 'seeded turn for the voice end-to-end harness';
/** The assistant row whose read-aloud control is the voice-output leg's trigger. */
const OUTPUT_TEXT = '语音输出端到端基线：这段文字应当经 TTS 合成后到达浏览器。';
/** How long the walk is parked past the test's lifetime; the scenario's own steps never reach it. */
const WALK_PARKED_AT_MS = 120_000;
/**
 * When each armed walk's turn ends, in ms from that turn's own start.
 *
 * The narrator's run-end trigger is a `running → idle` transition observed by the proxy's host poll
 * (every 250 ms). Every delivered message opens a walk of its own in this fixture, so a `turn-end`
 * two seconds in is what makes each of those runs genuinely end while the connection is live — a
 * parked turn would leave `busy: true` forever and the summary would never be asked for.
 */
const RUN_TURN_END_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 40_000;
const TTS_OBSERVE_MS = 30_000;
/** How long the run-end summary is waited for: a delivered turn ends 2 s in, then a 400 ms settle. */
const SUMMARY_OBSERVE_MS = 45_000;
/** How long the announce remark is waited for; it follows the first delivery by one round trip. */
const ANNOUNCE_OBSERVE_MS = 20_000;

/** A small, valid, decodable WAV the TTS route hands back — 2.5 s of a 440 Hz tone. */
function standinTtsWav(): Buffer {
  const rate = 16_000;
  const seconds = 2.5;
  const count = Math.round(rate * seconds);
  const dataBytes = count * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < count; index += 1) {
    const envelope = 0.35 * (0.7 + 0.3 * Math.sin((2 * Math.PI * 2 * index) / rate));
    buffer.writeInt16LE(Math.round(envelope * Math.sin((2 * Math.PI * 440 * index) / rate) * 32767), 44 + index * 2);
  }
  return buffer;
}
const STANDIN_TTS_WAV = standinTtsWav();

// ── journal readers (same construction as the sibling voice criteria) ────────────────────────
type JournalEntry = Record<string, unknown>;

/**
 * Every journal line belonging to `sessionId`'s connection.
 *
 * The FILE is selected by its header (`kind: 'connection'` + the session id), never the lines by
 * their text: later entries carry only the connection id, so a text filter would keep the header
 * and silently drop every `session_send` the criteria are built on.
 */
function readJournal(dir: string, sessionId: string): string[] {
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
    const rows = readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    if (rows.length === 0) continue;
    let header: { kind?: unknown; sessionId?: unknown };
    try {
      header = JSON.parse(rows[0]!) as { kind?: unknown; sessionId?: unknown };
    } catch {
      continue;
    }
    if (header.kind === 'connection' && header.sessionId === sessionId) lines.push(...rows);
  }
  return lines;
}

const journalEntries = (dir: string, sessionId: string): JournalEntry[] =>
  readJournal(dir, sessionId).map((line) => JSON.parse(line) as JournalEntry);

/** The messages the relay actually handed the session, in journal order. */
const relayedMessages = (entries: JournalEntry[]): Array<{ message: string; outcome: string }> =>
  entries
    .filter((entry) => entry.kind === 'session_send')
    .map((entry) => ({ message: String(entry.message ?? ''), outcome: String(entry.outcome ?? '') }));

/** Compare on letters/digits only: whitespace and punctuation are not what "the right message" means. */
const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** One `narrator_speak` the page received, with the id the queue paces on. */
type NarratorSpeak = { atMs: number; utteranceId: string; text: string };

/**
 * Every narrator narration the page received, in arrival order.
 *
 * Read from the same `__voiceFrames` tap the other legs use, so the assertion is about the frames
 * that actually crossed the browser's own socket — not about a queue reading the server would have
 * to be trusted for.
 */
const readNarratorSpeaks = (page: Page): Promise<NarratorSpeak[]> =>
  page.evaluate(() => {
    const frames =
      (window as unknown as { __voiceFrames?: Array<{ atMs: number; frame: Record<string, unknown> }> })
        .__voiceFrames ?? [];
    return frames
      .filter((entry) => entry.frame.type === 'narrator_speak' && typeof entry.frame.text === 'string')
      .map((entry) => ({
        atMs: entry.atMs,
        utteranceId: typeof entry.frame.utteranceId === 'string' ? entry.frame.utteranceId : '',
        text: String(entry.frame.text),
      }));
  });

// ── fixture helpers (copied from the sibling specs: there is no shared module for these) ─────
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

async function startResidentProcess(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`, { data: {} });
  if (!response.ok()) throw new Error(`start failed (${response.status()}): ${await response.text()}`);
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────
type PlaybackRecord = { atMs: number; src: string; duration: number | null; settled: string | null };

type HarnessRun = {
  sessionId: string;
  mic: { frames: number; samples: number; expectedFrames: number };
  detector: { speechStarted: number; speechStopped: number; expected: number; forwarded: string[] };
  upstream: { dialed: number; appendFrames: number; authorizationSeen: boolean; frameTypes: string[] };
  relay: { messages: string[]; outcomes: string[]; joined: string };
  voiceOutput: {
    requests: number;
    input: string;
    audioBytes: number;
    played: boolean;
    durationSec: number | null;
    playback: PlaybackRecord[];
  };
  egress: { logExists: boolean; blocked: boolean; dials: number; authorizationSeen: boolean };
  narrator: { speaks: NarratorSpeak[] };
  page: { phase: string; caption: string; status: string; pageErrors: string[]; consoleErrors: string[] };
};

test.describe('the frozen wav sample through the real Live Voice chain', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let run: HarnessRun;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');

    const mode = (process.env.QUAY_E2E_VOICE_REALTIME_MODE ?? '').trim();
    if (mode !== 'continuous') {
      throw new Error(
        'this spec replays a wav through the continuous wire, so it must be the ONLY selection: run ' +
          `\`node experiments/voice-e2e-harness/run.mjs\`. QUAY_E2E_VOICE_REALTIME_MODE was "${mode || '(unset)'}".`,
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

    const upstream = await startScriptedUpstream(upstreamPort);
    // The model's follow-up remark on a delivered `session_send`. Armed HERE, beside the detector,
    // because the two are the two halves of the same reply: the detector closes the utterance and
    // calls `session_send`, and the transport's synthesized resume opens the response this text
    // answers. The app server runs with `VOICE_REALTIME_CLOSING_TURN=announce`, so the proxy's gate
    // turns this sentence into a narration rather than swallowing it as display-only.
    upstream.armFollowUpText(ANNOUNCE_TEXT);
    upstream.armVad({
      timeBase: PLAN.vad.timeBase,
      threshold: PLAN.vad.threshold,
      silenceDurationMs: PLAN.vad.silenceDurationMs,
      sampleRate: PLAN.vad.sampleRate,
      // One turn per frozen transcript, in spoken order. Every turn is FORWARDED: the assertion
      // this spec exists for is that the relay carries the recording's own words.
      turns: PLAN.expectedTranscripts.map((text) => ({ text, policy: 'forward' as const })),
    });

    const workspacePath = path.join(fixtureHome, 'voice-e2e-workspace');
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
        seed: { title: 'voice e2e harness baseline', userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
        steps: [
          // An ordinary assistant turn: the row the voice-output leg reads aloud. It is a `row`
          // step rather than an `unattended-turn` because this run does not need a busy plane —
          // and a held turn lease would push the relay's deliveries into the busy-input hold
          // instead of the session's queue, which is a different reading than the one here.
          { at: 0, op: 'row', role: 'assistant', text: OUTPUT_TEXT },
          // The run END the narrator's summary waits for. Everything the session is given re-runs
          // this walk, so each delivered message opens a turn and this step ends it two seconds
          // later: the proxy's host poll reads `running → idle` and asks the summary producer once.
          { at: RUN_TURN_END_MS, op: 'turn-end' },
          { at: WALK_PARKED_AT_MS, op: 'wait' },
        ],
        expect: { rows: { delta: 1 }, content: { mustContain: [SEED_USER_TEXT] } },
      });
      await startResidentProcess(api, sessionId);

      let warmup: ClientWarmupReading | null = null;
      try {
        warmup = await warmClientStartup(clientUrl, dataDir);
      } catch (error) {
        throw new Error(
          `this run could not pre-commit its dependency optimizer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const context = await browser.newContext({ baseURL: clientUrl, viewport: { width: 1280, height: 800 } });
      await context.route('**', (route) => {
        const url = route.request().url();
        if (/^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) return route.continue();
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
      // The real recording, through the same fake capture graph the continuous-wire criteria use.
      await installWavMic(context, {
        pcm16Base64: WINDOW_PCM.pcm16Base64,
        sampleRate: PLAN.sampleRate,
        frameMs: PLAN.mic.frameMs,
      });
      // The voice socket's inbound frames: the relay's own words to the page, stamped.
      await context.addInitScript(() => {
        const frames: Array<{ atMs: number; frame: Record<string, unknown> }> = [];
        (window as unknown as { __voiceFrames: typeof frames }).__voiceFrames = frames;
        const Original = window.WebSocket;
        class Tapped extends Original {
          constructor(...args: ConstructorParameters<typeof WebSocket>) {
            super(...args);
            const url = typeof args[0] === 'string' ? args[0] : '';
            if (!url.includes('/voice-realtime')) return;
            this.addEventListener('message', (event: MessageEvent) => {
              if (typeof event.data !== 'string') return;
              let frame: Record<string, unknown>;
              try {
                frame = JSON.parse(event.data) as Record<string, unknown>;
              } catch {
                return; // not a JSON frame
              }
              frames.push({ atMs: Date.now(), frame });
              // The narrator queue is PACED: it says one narration and waits for the page's
              // `narrator_done` before the next. This tap stands in for the page's playback
              // completion here — without the ack a run-end summary would sit behind the last
              // announce remark forever and the frame the criterion reads would never be sent.
              if (frame.type === 'narrator_speak' && typeof frame.utteranceId === 'string') {
                try {
                  this.send(JSON.stringify({ type: 'narrator_done', utteranceId: frame.utteranceId }));
                } catch {
                  /* the socket is going away; the frames already recorded are the reading */
                }
              }
            });
          }
        }
        (window as unknown as { WebSocket: unknown }).WebSocket = Tapped;
      });
      // The browser's own audio element, tapped: `voicePlayer` creates `new Audio()` outside the
      // DOM, so a DOM query cannot see playback. The wrapper records the play call, the blob the
      // player was handed, and whether the element actually decoded the bytes (`loadedmetadata`).
      await context.addInitScript(() => {
        const playback: Array<Record<string, unknown>> = [];
        (window as unknown as { __voicePlayback: typeof playback }).__voicePlayback = playback;
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function patchedPlay(...args: Parameters<typeof originalPlay>) {
          const record: Record<string, unknown> = {
            atMs: Date.now(),
            src: typeof this.src === 'string' ? this.src : '',
            duration: null,
            settled: null,
          };
          playback.push(record);
          this.addEventListener(
            'loadedmetadata',
            () => {
              record.duration = Number.isFinite(this.duration) ? this.duration : null;
            },
            { once: true },
          );
          let settled: Promise<void>;
          try {
            settled = originalPlay.apply(this, args);
          } catch (error) {
            record.settled = `threw:${error instanceof Error ? error.name : String(error)}`;
            throw error;
          }
          if (settled && typeof settled.then === 'function') {
            settled.then(
              () => {
                record.settled = 'resolved';
              },
              (error: unknown) => {
                record.settled = `rejected:${error instanceof Error ? error.name : String(error)}`;
              },
            );
          } else {
            record.settled = 'void';
          }
          return settled;
        } as typeof HTMLMediaElement.prototype.play;
      });

      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      const requestFailures: RequestFailure[] = [];
      page.on('requestfailed', (request) => {
        requestFailures.push({ url: request.url(), failureText: request.failure()?.errorText ?? '(no failureText)' });
      });

      // The deployment's only local health answer: the scripted endpoint is what makes the session
      // real, and every sibling voice criterion answers the probe the same way.
      await page.route('**/api/voice/health', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: true }) }),
      );

      // THE VOICE-OUTPUT SERVICE, as a local stand-in. The browser's real request rides
      // `/api/voice/tts` (the server's own TTS backend is not configured in this run); answering
      // it here proves the downlink half — a real audio body decodable by the browser's media
      // element — without a cloud bill. The request body is kept so the assertion can say the text
      // that was synthesized is the row's own copy.
      const ttsRequests: Array<{ atMs: number; body: Record<string, unknown> }> = [];
      await page.route('**/api/voice/tts', async (route) => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        } catch {
          /* a non-JSON body is still a request this leg can report */
        }
        ttsRequests.push({ atMs: Date.now(), body });
        await route.fulfill({ status: 200, contentType: 'audio/wav', body: STANDIN_TTS_WAV });
      });

      await page.goto(`/session/${sessionId}`);
      await awaitClientMounted(page, PANE, 12_000, {
        pageErrors,
        consoleErrors,
        requestFailures,
        warmup,
      });

      // Start the scenario's walk and read the assistant row it writes. The row is the TTS leg's
      // subject; waiting for it here (rather than clicking a locator blind) makes a scenario that
      // never ran fail by its own name.
      //
      // NOT AWAITED, on purpose: `/clock` does not return until the walk has run to its end, and
      // this walk is parked far past the test. Awaiting it would hold the whole spec for the park
      // duration and report nothing about the replay — the sibling continuous criterion starts the
      // walk with `void` for the same reason.
      void api.post('/api/debug-agent/clock', { data: { sessionId } }).catch(() => undefined);
      await expect(page.locator(PANE)).toContainText(OUTPUT_TEXT, { timeout: 30_000 });

      // ── enter Live Voice and play the recording ─────────────────────────────────────────────
      await page.getByTestId('live-voice-button').click();
      await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => upstream.liveConnectionCount(), { timeout: 25_000 }).toBe(1);
      const playBeganAtMs = Date.now();
      await playWavMic(page);
      const playEndedAtMs = Date.now();
      await expect
        .poll(
          () => page.getByTestId('voice-realtime-phase').textContent().then((text) => (text ?? '').trim()),
          { timeout: 25_000 },
        )
        .toBe('listening');

      await upstream.waitForUtterances(PLAN.vad.expectedUtterances, 45_000);

      // A delivery is a round trip (proxy → coalescing window → session host → journal). Wait for
      // the journal's joined messages to cover the frozen transcripts rather than for a sleep.
      const expectedJoined = normalize(PLAN.expectedTranscripts.join(''));
      const relayDeadline = Date.now() + DELIVERY_TIMEOUT_MS;
      let entries: JournalEntry[] = [];
      let messages: Array<{ message: string; outcome: string }> = [];
      while (Date.now() < relayDeadline) {
        entries = journalEntries(journalDir, sessionId);
        messages = relayedMessages(entries);
        if (normalize(messages.map((entry) => entry.message).join('')) === expectedJoined) break;
        await page.waitForTimeout(250);
      }

      // ── the voice-output leg: text → TTS → audio bytes → the browser's own player ───────────
      const speakRow = page.locator('[data-message-style="assistant"]').filter({ hasText: OUTPUT_TEXT }).first();
      const speakButton = speakRow.locator('button[aria-label="Read aloud"]');
      await expect(speakButton).toBeVisible({ timeout: 15_000 });
      await speakButton.click();

      const ttsDeadline = Date.now() + TTS_OBSERVE_MS;
      let playback: PlaybackRecord[] = [];
      while (Date.now() < ttsDeadline) {
        playback = await page.evaluate(
          () => ((window as unknown as { __voicePlayback?: PlaybackRecord[] }).__voicePlayback ?? []).slice(),
        );
        const played = playback.some((record) => record.src.startsWith('blob:') && record.settled === 'resolved');
        if (ttsRequests.length > 0 && played) break;
        await page.waitForTimeout(250);
      }

      // ── the narrator's two automatic outputs ─────────────────────────────────────────────────
      // 1. The announce remark follows a delivered message: the closing turn's follow-up text on
      //    the resumed response, which the proxy's announce gate routes into the narrator queue.
      //    Waited for as a FRAME, not for a clock — the queue paces on the page's ack above.
      let narratorSpeaks = await readNarratorSpeaks(page);
      const announceDeadline = Date.now() + ANNOUNCE_OBSERVE_MS;
      while (Date.now() < announceDeadline && !narratorSpeaks.some((speak) => speak.text === ANNOUNCE_TEXT)) {
        await page.waitForTimeout(250);
        narratorSpeaks = await readNarratorSpeaks(page);
      }
      // 2. The run-end summary. Every delivered message opens a walk of its own and the armed deck
      //    ends each turn two seconds in, so the transition is a real `running → idle` the proxy's
      //    host poll observes; the 400 ms settle and the stand-in producer's answer follow it.
      const summaryDeadline = Date.now() + SUMMARY_OBSERVE_MS;
      while (Date.now() < summaryDeadline && !narratorSpeaks.some((speak) => speak.text === SUMMARY_TEXT)) {
        await page.waitForTimeout(250);
        narratorSpeaks = await readNarratorSpeaks(page);
      }

      const vad = upstream.vad();
      const headers = upstream.upgradeHeaders();
      const egressText = existsSync(egressLog) ? readFileSync(egressLog, 'utf8') : '';
      const playedRecords = playback.filter((record) => record.src.startsWith('blob:'));
      const playedDuration = playedRecords.reduce<number | null>(
        (longest, record) =>
          record.duration !== null && (longest === null || record.duration > longest) ? record.duration : longest,
        null,
      );

      run = {
        sessionId,
        mic: {
          frames: (await wavMicReading(page)).frames,
          samples: (await wavMicReading(page)).samples,
          expectedFrames: WINDOW_PCM.frames,
        },
        detector: {
          speechStarted: vad?.speechStarted ?? -1,
          speechStopped: vad?.speechStopped ?? -1,
          expected: PLAN.vad.expectedUtterances,
          forwarded: vad === null ? [] : [...vad.forwarded],
        },
        upstream: {
          dialed: upstream.dialed(),
          appendFrames: upstream.clientFrames().filter((frame) => frame.type === 'input_audio_buffer.append').length,
          authorizationSeen: headers.some((header) => header.authorization !== undefined),
          frameTypes: upstream.clientFrames().map((frame) => String(frame.type)),
        },
        relay: {
          messages: messages.map((entry) => entry.message),
          outcomes: messages.map((entry) => entry.outcome),
          joined: messages.map((entry) => entry.message).join(''),
        },
        voiceOutput: {
          requests: ttsRequests.length,
          // The client posts `{ text }` (the server maps it to the upstream's `input`); reading the
          // wrong key here would report an empty synthesis and fail a leg that actually worked.
          input: typeof ttsRequests[0]?.body.text === 'string' ? (ttsRequests[0]!.body.text as string) : '',
          audioBytes: STANDIN_TTS_WAV.length,
          played: playedRecords.some((record) => record.settled === 'resolved'),
          durationSec: playedDuration,
          playback: playedRecords,
        },
        egress: {
          logExists: existsSync(egressLog),
          blocked: egressText.includes('EGRESS BLOCKED'),
          dials: upstream.dialed(),
          authorizationSeen: headers.some((header) => header.authorization !== undefined),
        },
        narrator: { speaks: narratorSpeaks },
        page: {
          phase: ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim(),
          caption: ((await page.locator(CAPTION).textContent().catch(() => '')) ?? '').trim(),
          status: ((await page.locator(STATUS).textContent().catch(() => '')) ?? '').trim(),
          pageErrors,
          consoleErrors,
        },
      };

      if (process.env.VOICE_E2E_DUMP) {
        writeFileSync(
          process.env.VOICE_E2E_DUMP,
          `${JSON.stringify({ plan: PLAN, playBeganAtMs, playEndedAtMs, ...run }, null, 2)}\n`,
          'utf8',
        );
      }

      await page.getByTestId('voice-realtime-end').click().catch(() => undefined);
      await api.post('/api/debug-agent/release', { data: { sessionId } }).catch(() => undefined);
      await context.close().catch(() => undefined);
    } finally {
      await api.dispose();
      await upstream.close();
    }
  });

  test('the recorded sample reached the endpoint and was heard as the frozen utterances', () => {
    // The non-vacuity reading first: a player that pushed nothing proves nothing.
    expect(run.mic.frames, 'the WAV microphone must have pushed frames').toBeGreaterThan(0);
    expect(run.mic.frames, 'the whole derived window must have been played').toBeGreaterThanOrEqual(
      Math.floor(run.mic.expectedFrames * 0.95),
    );
    expect(run.upstream.dialed, 'the app must dial the scripted endpoint exactly once').toBe(1);
    expect(run.upstream.appendFrames, 'the app must have sent audio to the endpoint').toBeGreaterThan(0);
    expect(run.detector.speechStarted, 'the detector must have heard every utterance open').toBe(
      PLAN.vad.expectedUtterances,
    );
    expect(run.detector.speechStopped, 'the detector must have closed every utterance').toBe(PLAN.vad.expectedUtterances);
  });

  test('the relay carried the recording\'s frozen transcripts as messages', () => {
    expect(
      normalize(run.relay.joined),
      `relayed messages were ${JSON.stringify(run.relay.messages)}`,
    ).toBe(normalize(PLAN.expectedTranscripts.join('')));
    for (const outcome of run.relay.outcomes) {
      expect(outcome.toLowerCase()).not.toContain('error');
      expect(outcome.toLowerCase()).not.toContain('refused');
    }
  });

  test('the synthesized voice output reached the browser and was played', () => {
    expect(run.voiceOutput.requests, 'the read-aloud control must have requested TTS').toBeGreaterThan(0);
    expect(run.voiceOutput.input, 'the synthesized text must be the assistant row\'s own copy').toContain(OUTPUT_TEXT);
    expect(run.voiceOutput.audioBytes, 'the TTS response must carry audio bytes').toBeGreaterThan(0);
    expect(run.voiceOutput.played, `playback records were ${JSON.stringify(run.voiceOutput.playback)}`).toBe(true);
    expect(run.voiceOutput.durationSec, 'the browser must have decoded the delivered audio').toBeGreaterThan(0.5);
  });

  test('the announce closing turn reached the browser as narrator speech', () => {
    const speaks = run.narrator.speaks;
    const announce = speaks.find((speak) => speak.text === ANNOUNCE_TEXT);
    expect(
      announce,
      `the narrator frames were ${JSON.stringify(speaks.map((speak) => speak.text))}`,
    ).toBeDefined();
    // The frame's own readings, not the constants': the AC is about what crossed the socket.
    const text = announce!.text.trim();
    expect([...text].length, `the announcement was ${JSON.stringify(text)}`).toBeLessThanOrEqual(15);
    expect(normalize(text), 'the announcement must not be the old one-word "OK"').not.toBe('ok');
    expect(text, 'the announcement must be the announce producer\'s, not a summary').not.toBe(SUMMARY_TEXT.trim());
    expect(announce!.utteranceId).toMatch(/^announce-\d+$/);
  });

  test('the run-end summary reached the browser as narrator speech', () => {
    const speaks = run.narrator.speaks;
    const summary = speaks.find((speak) => speak.text === SUMMARY_TEXT);
    expect(
      summary,
      `the narrator frames were ${JSON.stringify(speaks.map((speak) => speak.text))}`,
    ).toBeDefined();
    // The same three readings the proxy's own gate applies before it injects a summary.
    const text = summary!.text.trim();
    expect([...text].length, `the summary was ${JSON.stringify(text)}`).toBeLessThanOrEqual(40);
    expect([...text].filter((character) => '#*`|-'.includes(character)), 'the summary must carry no Markdown').toEqual([]);
    expect(text, 'the summary must be one line of speech').not.toContain('\n');
    expect(summary!.utteranceId).toMatch(/^run-end-summary-\d+$/);
  });

  test('the run stayed on loopback and carried no cloud credential', () => {
    expect(run.egress.logExists, 'the egress guard must have been loaded').toBe(true);
    expect(run.egress.blocked, 'no non-loopback dial may have been attempted').toBe(false);
    expect(run.egress.dials, 'the only dial is this spec\'s own scripted endpoint').toBe(1);
    expect(run.egress.authorizationSeen, 'the upgrade must carry no cloud credential').toBe(false);
    expect(run.page.pageErrors, `the page threw: ${JSON.stringify(run.page.pageErrors)}`).toHaveLength(0);
  });
});
