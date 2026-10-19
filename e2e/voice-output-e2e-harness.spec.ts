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
 *     · the READ-ALOUD backend is a local route stand-in: the browser's real `/api/voice/tts`
 *       request is answered with a valid WAV, so the leg proves "text → HTTP → bytes → browser
 *       playback" end-to-end without a cloud bill.
 *     · the NARRATOR's TTS backend is a scripted CosyVoice HTTP server on loopback
 *       (`startScriptedTts`): the app server's real TTS leaf dials it, the real SSE bytes are
 *       framed and sent as `tts_audio`/`tts_done`, and the real page decodes and plays them before
 *       answering `narrator_done`. The cloud synth (AC-405) is the same leaf against DashScope;
 *       this leg proves the downlink wiring, not the provider's audio quality.
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
import { createServer } from 'node:http';
import path from 'node:path';

import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  DEFAULT_VOICE_REALTIME_TTS_FRAME_BYTES,
  DEFAULT_VOICE_REALTIME_TTS_MODEL,
  VOICE_REALTIME_TTS_PATH,
  VOICE_REALTIME_TTS_VOICE_ENV,
} from '../server/modules/voice-realtime/voice-realtime-tts';
import { ANNOUNCE_PHRASES } from '../server/modules/voice-realtime/voice-realtime-announce-phrases';
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
 * The ANNOUNCE sentence is the connection's FIRST fixed phrase: since
 * `gap-narrator-announce-phrase-cache` the proxy ignores the model's follow-up wording and speaks
 * `pickAnnouncePhrase(0)` instead, so that is what the page must receive. The endpoint's own
 * follow-up text (`VOICE_E2E_ANNOUNCE_TEXT`) is only the TRIGGER here and is asserted NOT to cross
 * the wire below. The summary text is what the app server's stand-in producer returns.
 */
const MODEL_FOLLOW_UP = process.env.VOICE_E2E_ANNOUNCE_TEXT;
const SUMMARY_TEXT = process.env.VOICE_E2E_SUMMARY_TEXT;
if (!MODEL_FOLLOW_UP || !SUMMARY_TEXT) {
  throw new Error(
    'VOICE_E2E_ANNOUNCE_TEXT / VOICE_E2E_SUMMARY_TEXT are not set — run this file through ' +
      '`node experiments/voice-e2e-harness/run.mjs`, which publishes both beside the plan.',
  );
}
const ANNOUNCE_TEXT = ANNOUNCE_PHRASES[0]!;

/**
 * The scripted TTS stand-in's port and the voice the app server was started with.
 *
 * BOTH SIDES NAME THE SAME PORT: `run.mjs` allocates it before Playwright spawns the app server,
 * publishes the address as `VOICE_REALTIME_TTS_ENDPOINT` to the server and the bare number to this
 * spec. The spec binds it and answers the leaf's HTTP request; nothing here reaches a cloud service.
 */
const TTS_PORT = Number(process.env.VOICE_E2E_TTS_PORT);
const TTS_VOICE = process.env[VOICE_REALTIME_TTS_VOICE_ENV];
if (!Number.isInteger(TTS_PORT) || TTS_PORT <= 0 || !TTS_VOICE) {
  throw new Error(
    'VOICE_E2E_TTS_PORT / VOICE_REALTIME_TTS_VOICE are not set — run this file through ' +
      '`node experiments/voice-e2e-harness/run.mjs`, which allocates the stand-in port.',
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

/**
 * The WAV the SCRIPTED TTS SERVER streams to the app server for every narrator sentence.
 *
 * 1.0 s at 24 kHz — the leaf's default sample rate — so a full utterance spans more than one
 * `tts_audio` frame at the leaf's 16 KiB slice size. That is what makes `seq` order and the
 * reassembled byte total real readings rather than a single-frame tautology.
 */
function narratorTtsWav(): Buffer {
  const rate = 24_000;
  const seconds = 1;
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
    const envelope = 0.3 * (0.7 + 0.3 * Math.sin((2 * Math.PI * 2 * index) / rate));
    buffer.writeInt16LE(Math.round(envelope * Math.sin((2 * Math.PI * 440 * index) / rate) * 32767), 44 + index * 2);
  }
  return buffer;
}
const NARRATOR_TTS_WAV = narratorTtsWav();
/**
 * How many `tts_audio` frames the narrator cache emits for one stand-in utterance.
 *
 * Since `gap-narrator-announce-phrase-cache` both a warmed phrase and an on-the-spot synthesis are
 * framed by `emitVoiceRealtimeSynthesisFrames()` over the COMPLETE WAV, so the count is the plain
 * whole-blob slice count (the streaming leaf's separate header frame applies only to
 * `streamVoiceRealtimeSpeech`, which the narrator no longer calls).
 */
const NARRATOR_TTS_FRAMES = Math.ceil(NARRATOR_TTS_WAV.length / DEFAULT_VOICE_REALTIME_TTS_FRAME_BYTES);

/** One request the scripted TTS server answered, with the body it read. */
type ScriptedTtsRequest = { atMs: number; path: string; text: string; voice: string; model: string };
type ScriptedTtsServer = { requests: ScriptedTtsRequest[]; close(): Promise<void> };

/**
 * The scripted CosyVoice HTTP server the app server's TTS leaf dials.
 *
 * It speaks the documented wire: `POST /api/v1/services/audio/tts/SpeechSynthesizer` with
 * `X-DashScope-SSE` answered by `sentence-synthesis` events whose `output.audio.data` is a base64
 * slice. The WAV is sent in THREE SSE events, so the leaf's own 16 KiB framing is measurable apart
 * from the upstream chunking. Every request is recorded, so the assertion can say the announce and
 * summary TEXTS really reached synthesis rather than reading the server's own queue.
 */
async function startScriptedTts(port: number): Promise<ScriptedTtsServer> {
  const requests: ScriptedTtsRequest[] = [];
  const server = createServer((incoming, outgoing) => {
    if (incoming.method !== 'POST' || (incoming.url ?? '') !== VOICE_REALTIME_TTS_PATH) {
      outgoing.statusCode = 404;
      outgoing.end('not found');
      return;
    }
    let raw = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk: string) => {
      raw += chunk;
    });
    incoming.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* an unreadable body is still a request this stand-in reports */
      }
      const input = (typeof body.input === 'object' && body.input !== null ? body.input : {}) as Record<
        string,
        unknown
      >;
      requests.push({
        atMs: Date.now(),
        path: incoming.url ?? '',
        text: typeof input.text === 'string' ? input.text : '',
        voice: typeof input.voice === 'string' ? input.voice : '',
        model: typeof body.model === 'string' ? body.model : '',
      });

      outgoing.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const slices = 3;
      const per = Math.ceil(NARRATOR_TTS_WAV.length / slices);
      for (let offset = 0; offset < NARRATOR_TTS_WAV.length; offset += per) {
        const data = NARRATOR_TTS_WAV.subarray(offset, Math.min(offset + per, NARRATOR_TTS_WAV.length)).toString(
          'base64',
        );
        outgoing.write(
          `data: ${JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data } }, usage: { characters: 8 } })}\n\n`,
        );
      }
      outgoing.write(`data: ${JSON.stringify({ output: { type: 'sentence-end', finish_reason: 'stop' } })}\n\n`);
      outgoing.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

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

/** One frame the page received or sent, stamped by the browser's clock. */
type VoiceFrameEntry = { atMs: number; frame: Record<string, unknown> };

/** Everything the page received on the `/voice-realtime` socket. */
const readVoiceFrames = (page: Page): Promise<VoiceFrameEntry[]> =>
  page.evaluate(
    () =>
      ((window as unknown as { __voiceFrames?: Array<{ atMs: number; frame: Record<string, unknown> }> })
        .__voiceFrames ?? []).slice(),
  );

/** Everything the page SENT on the `/voice-realtime` socket (the pacing acks live here). */
const readSentFrames = (page: Page): Promise<VoiceFrameEntry[]> =>
  page.evaluate(
    () =>
      ((window as unknown as { __voiceSentFrames?: Array<{ atMs: number; frame: Record<string, unknown> }> })
        .__voiceSentFrames ?? []).slice(),
  );

/**
 * One narrator utterance's synthesized audio, reassembled from the frames that crossed the socket.
 *
 * `seqs` is the ORDER THE PAGE RECEIVED, not a sorted view — the AC is that the slices arrive in
 * `seq` order, and sorting here would hide exactly the defect it names. `doneBytes` is the leaf's
 * own reading and is compared with the stand-in WAV's length below.
 */
type NarratorTtsReading = {
  utteranceId: string;
  text: string;
  speakAtMs: number;
  /** When the first `tts_audio` frame (the WAV header) reached the page. */
  firstAudioAtMs: number | null;
  seqs: number[];
  doneAtMs: number | null;
  doneFrames: number | null;
  doneBytes: number | null;
  errorCode: string | null;
  ackedAtMs: number | null;
  /** The first AudioContext source the page started after this utterance's header arrived. */
  firstStartAtMs: number | null;
  /** The page's own final caption before this narration — the end of the speech it answers. */
  speechEndAtMs: number | null;
};

function readNarratorTts(
  frames: VoiceFrameEntry[],
  sent: VoiceFrameEntry[],
  sourceStarts: number[],
): NarratorTtsReading[] {
  const readings = new Map<string, NarratorTtsReading>();
  const ensure = (utteranceId: string): NarratorTtsReading => {
    let reading = readings.get(utteranceId);
    if (reading === undefined) {
      reading = {
        utteranceId,
        text: '',
        speakAtMs: Number.POSITIVE_INFINITY,
        firstAudioAtMs: null,
        seqs: [],
        doneAtMs: null,
        doneFrames: null,
        doneBytes: null,
        errorCode: null,
        ackedAtMs: null,
        firstStartAtMs: null,
        speechEndAtMs: null,
      };
      readings.set(utteranceId, reading);
    }
    return reading;
  };
  for (const entry of frames) {
    const frame = entry.frame;
    if (typeof frame.utteranceId !== 'string') continue;
    const reading = ensure(frame.utteranceId);
    if (frame.type === 'narrator_speak') {
      reading.text = typeof frame.text === 'string' ? frame.text : '';
      reading.speakAtMs = entry.atMs;
    } else if (frame.type === 'tts_audio') {
      if (reading.firstAudioAtMs === null) reading.firstAudioAtMs = entry.atMs;
      reading.seqs.push(typeof frame.seq === 'number' ? frame.seq : -1);
    } else if (frame.type === 'tts_done') {
      reading.doneAtMs = entry.atMs;
      reading.doneFrames = typeof frame.frames === 'number' ? frame.frames : -1;
      reading.doneBytes = typeof frame.bytes === 'number' ? frame.bytes : -1;
    } else if (frame.type === 'tts_error') {
      reading.errorCode = typeof frame.code === 'string' ? frame.code : 'UNNAMED';
    }
  }
  for (const entry of sent) {
    const frame = entry.frame;
    if (frame.type !== 'narrator_done' || typeof frame.utteranceId !== 'string') continue;
    const reading = readings.get(frame.utteranceId);
    if (reading !== undefined) reading.ackedAtMs = entry.atMs;
  }
  // The final captions the page heard, in arrival order: the end of the speech a narration answers.
  const captionFinals = frames
    .filter((entry) => entry.frame.type === 'caption' && entry.frame.final === true)
    .map((entry) => entry.atMs);
  for (const reading of readings.values()) {
    if (reading.firstAudioAtMs !== null) {
      // A source started by this utterance's audio, before its ack. AudioBufferSourceNode is only
      // used by the narrator's streaming path, so the window is enough to attribute it.
      const upper = reading.ackedAtMs ?? Number.POSITIVE_INFINITY;
      reading.firstStartAtMs =
        sourceStarts.find((at) => at >= reading.firstAudioAtMs! && at <= upper) ?? null;
    }
    const before = captionFinals.filter((at) => at <= reading.speakAtMs);
    reading.speechEndAtMs = before.length === 0 ? null : before[before.length - 1]!;
  }
  return [...readings.values()];
}

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
  narrator: {
    speaks: NarratorSpeak[];
    /** One entry per utterance the server synthesized, read off the frames the page received. */
    tts: NarratorTtsReading[];
    /** The requests the scripted CosyVoice server answered, in order. */
    requests: ScriptedTtsRequest[];
    /** Narrator clips the browser actually scheduled on an AudioContext (the streaming path). */
    played: number;
    /** Narrator clips the browser decoded through a media element (the Blob fallback path). */
    elementPlayed: number;
    /** Every AudioBufferSourceNode start the page made, on the browser clock. */
    starts: number[];
  };
  page: { phase: string; caption: string; status: string; pageErrors: string[]; consoleErrors: string[]; consoleLogs: string[] };
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
    // The CosyVoice HTTP stand-in the app server's TTS leaf dials. Started here, before any page
    // connects, so the first announce remark's synthesis never races a missing listener.
    const scriptedTts = await startScriptedTts(TTS_PORT);
    // The model's follow-up remark on a delivered `session_send`. Armed HERE, beside the detector,
    // because the two are the two halves of the same reply: the detector closes the utterance and
    // calls `session_send`, and the transport's synthesized resume opens the response this text
    // answers. The app server runs with `VOICE_REALTIME_CLOSING_TURN=announce`, so the proxy's gate
    // turns this sentence into a narration rather than swallowing it as display-only.
    upstream.armFollowUpText(MODEL_FOLLOW_UP);
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
      // The voice socket's frames in BOTH directions, stamped.
      //
      // NOTHING IS AUTO-ACKED HERE ANY MORE. The previous version of this tap answered every
      // `narrator_speak` with `narrator_done` itself, which meant the server's queue advanced on a
      // frame the browser never earned. The AC is that PLAYBACK completion paces the queue: the
      // real page now plays the TTS audio and sends the ack from its own `ended` handler, and the
      // outbound tap below records that ack so the assertion can read when it happened.
      await context.addInitScript(() => {
        const frames: Array<{ atMs: number; frame: Record<string, unknown> }> = [];
        const sent: Array<{ atMs: number; frame: Record<string, unknown> }> = [];
        (window as unknown as { __voiceFrames: typeof frames }).__voiceFrames = frames;
        (window as unknown as { __voiceSentFrames: typeof sent }).__voiceSentFrames = sent;
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
            });
          }
          send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
            if (typeof data === 'string' && this.url.includes('/voice-realtime')) {
              try {
                sent.push({ atMs: Date.now(), frame: JSON.parse(data) as Record<string, unknown> });
              } catch {
                /* a non-JSON string is not a frame this criterion reads */
              }
            }
            super.send(data);
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

      // The narrator's streaming playback goes through an AudioContext, not a media element. Tap
      // `AudioBufferSourceNode.start()` so the criterion can say WHEN the first audio was actually
      // scheduled — the reading the streaming task exists for ("the first source starts before
      // tts_done").
      await context.addInitScript(() => {
        const starts: number[] = [];
        (window as unknown as { __narratorStarts: typeof starts }).__narratorStarts = starts;
        const originalStart = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function patchedStart(
          ...args: Parameters<typeof originalStart>
        ): void {
          starts.push(Date.now());
          originalStart.apply(this, args);
        };
      });

      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const consoleLogs: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
        // The client's own `[voice-realtime]` narration diagnostics: the dump carries them so a red
        // run can say WHY the page took the element fallback instead of the streaming path.
        if (message.text().includes('[voice-realtime]')) consoleLogs.push(message.text());
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

      // ── the narrator's two automatic outputs, through TTS ────────────────────────────────────
      // 1. The announce remark follows a delivered message: the closing turn's follow-up text on
      //    the resumed response, which the proxy's announce gate routes into the narrator queue.
      // 2. The run-end summary. Every delivered message opens a walk of its own and the armed deck
      //    ends each turn two seconds in, so the transition is a real `running → idle` the proxy's
      //    host poll observes; the 400 ms settle and the stand-in producer's answer follow it.
      //
      // BOTH ARE WAITED FOR AS COMPLETE TTS UTTERANCES — the text frame, every audio slice, the
      // `tts_done` reading AND the page's own `narrator_done` — because the queue is PACED: the
      // second sentence is only sent after the first has PLAYED. A wait on the text frame alone
      // would be satisfied before the leg this criterion exists for had run.
      let narratorFrames: VoiceFrameEntry[] = [];
      let narratorSentFrames: VoiceFrameEntry[] = [];
      let narratorSpeaks = await readNarratorSpeaks(page);
      let narratorTts: NarratorTtsReading[] = [];
      let narratorStarts: number[] = [];
      const narratorDeadline = Date.now() + SUMMARY_OBSERVE_MS;
      while (Date.now() < narratorDeadline) {
        narratorFrames = await readVoiceFrames(page);
        narratorSentFrames = await readSentFrames(page);
        narratorSpeaks = await readNarratorSpeaks(page);
        narratorStarts = await page.evaluate(
          () => ((window as unknown as { __narratorStarts?: number[] }).__narratorStarts ?? []).slice(),
        );
        narratorTts = readNarratorTts(narratorFrames, narratorSentFrames, narratorStarts);
        const announce = narratorTts.find((reading) => reading.text === ANNOUNCE_TEXT);
        const summary = narratorTts.find((reading) => reading.text === SUMMARY_TEXT);
        if (
          announce !== undefined &&
          announce.doneAtMs !== null &&
          announce.ackedAtMs !== null &&
          summary !== undefined &&
          summary.doneAtMs !== null &&
          summary.ackedAtMs !== null
        ) {
          break;
        }
        await page.waitForTimeout(250);
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
      // RE-READ the playback tap: the narrator clips play AFTER the read-aloud leg above. The
      // read-aloud stand-in is 2.5 s and a narrator clip is 1.0 s, so the duration band below is
      // what separates "the browser decoded our TTS bytes" from "the earlier read-aloud happened".
      const allPlayback: PlaybackRecord[] = await page.evaluate(
        () => ((window as unknown as { __voicePlayback?: PlaybackRecord[] }).__voicePlayback ?? []).slice(),
      );
      const narratorPlayed = allPlayback.filter(
        (record) =>
          record.src.startsWith('blob:') && record.duration !== null && record.duration > 0.5 && record.duration < 1.5,
      ).length;
      // The streaming path never creates a media element for a narration; the scheduled
      // AudioBufferSourceNodes are its playback record.
      const narratorStreamedStarts = narratorStarts.length;

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
        narrator: {
          speaks: narratorSpeaks,
          tts: narratorTts,
          requests: scriptedTts.requests.slice(),
          played: narratorStreamedStarts,
          elementPlayed: narratorPlayed,
          starts: narratorStarts.slice(),
        },
        page: {
          phase: ((await page.getByTestId('voice-realtime-phase').textContent()) ?? '').trim(),
          caption: ((await page.locator(CAPTION).textContent().catch(() => '')) ?? '').trim(),
          status: ((await page.locator(STATUS).textContent().catch(() => '')) ?? '').trim(),
          pageErrors,
          consoleErrors,
          consoleLogs,
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
      await scriptedTts.close();
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

  test('the narrator speech was synthesized and streamed as ordered tts_audio frames', () => {
    const announce = run.narrator.tts.find((reading) => reading.text === ANNOUNCE_TEXT);
    const summary = run.narrator.tts.find((reading) => reading.text === SUMMARY_TEXT);
    const readings = run.narrator.tts.map((reading) => ({ id: reading.utteranceId, text: reading.text }));
    expect(announce, `narrator tts readings were ${JSON.stringify(readings)}`).toBeDefined();
    expect(summary, `narrator tts readings were ${JSON.stringify(readings)}`).toBeDefined();

    for (const [label, reading] of [
      ['announce', announce!],
      ['summary', summary!],
    ] as const) {
      // A NAMED refusal is red here: the whole point of the downlink is that a sentence the queue
      // accepted is actually spoken, and `tts_error` is the leaf's honest alternative to audio.
      expect(reading.errorCode, `${label}: tts_error ${reading.errorCode ?? ''}`).toBeNull();
      // THE AC's "按 seq 从 0 连续": the received order must BE the sequence, not merely a set.
      expect(reading.seqs, `${label}: tts_audio seq order`).toEqual([...Array(NARRATOR_TTS_FRAMES).keys()]);
      expect(reading.doneFrames, `${label}: tts_done frames`).toBe(NARRATOR_TTS_FRAMES);
      // "bytes 等于合成字节数": the leaf's own total is the stand-in WAV's exact length.
      expect(reading.doneBytes, `${label}: tts_done bytes`).toBe(NARRATOR_TTS_WAV.length);
    }

    // The TEXTS reached synthesis, read off the stand-in's recorded requests. A run whose narrator
    // frames carried words but whose TTS request body carried something else would pass the frame
    // assertions alone, which is exactly the wire this AC is about.
    const synthesized = run.narrator.requests.map((request) => request.text);
    expect(synthesized, `synthesis requests were ${JSON.stringify(synthesized)}`).toContain(ANNOUNCE_TEXT);
    expect(synthesized, `synthesis requests were ${JSON.stringify(synthesized)}`).toContain(SUMMARY_TEXT);
    // THE PHRASE CACHE'S READING: the announce sentence was synthesized during WARM-UP (the fixed
    // table is pre-synthesized when the connection opens), and the model's follow-up wording — the
    // trigger — never became a synthesis request at all.
    for (const phrase of ANNOUNCE_PHRASES) {
      expect(synthesized, `synthesis requests were ${JSON.stringify(synthesized)}`).toContain(phrase);
    }
    expect(synthesized, `the model follow-up reached synthesis: ${JSON.stringify(synthesized)}`).not.toContain(
      MODEL_FOLLOW_UP,
    );
    for (const request of run.narrator.requests) {
      expect(request.path, 'the leaf must dial the documented CosyVoice path').toBe(VOICE_REALTIME_TTS_PATH);
      expect(request.model, 'the leaf must request the pinned CosyVoice model').toBe(DEFAULT_VOICE_REALTIME_TTS_MODEL);
      expect(request.voice, 'the leaf must send the voice the deployment named').toBe(TTS_VOICE);
    }
  });

  test('the browser played each narration and its narrator_done advanced the queue', () => {
    const announce = run.narrator.tts.find((reading) => reading.text === ANNOUNCE_TEXT);
    const summary = run.narrator.tts.find((reading) => reading.text === SUMMARY_TEXT);
    expect(announce, 'the announce utterance must exist').toBeDefined();
    expect(summary, 'the run-end summary utterance must exist').toBeDefined();

    // PLAYBACK, not mere receipt: the page scheduled the narrator's PCM on an AudioContext (the
    // streaming path). The read-aloud element is tapped separately below and is not counted here.
    expect(
      run.narrator.played,
      `narrator playback records were ${JSON.stringify({ starts: run.narrator.starts, tts: run.narrator.tts })}`,
    ).toBeGreaterThan(0);

    // The ack is the page's own, sent from its playback completion handler — and sent AFTER the
    // audio stream closed. An ack raced on `narrator_speak` (the old harness tap) fails this.
    expect(announce!.ackedAtMs, 'the announce narration must be acked by the page').not.toBeNull();
    expect(summary!.ackedAtMs, 'the summary narration must be acked by the page').not.toBeNull();
    expect(announce!.ackedAtMs!, 'the announce ack must follow its tts_done').toBeGreaterThan(announce!.doneAtMs!);
    expect(summary!.ackedAtMs!, 'the summary ack must follow its tts_done').toBeGreaterThan(summary!.doneAtMs!);

    // THE QUEUE ADVANCED: another narration started only after the announce's playback ack. This is
    // the reading that says the ack is load-bearing — with no ack (or with it ignored), the summary
    // would sit behind the announce forever and the second frame would never be emitted.
    const later = run.narrator.tts.filter((reading) => reading.speakAtMs > announce!.ackedAtMs!);
    expect(
      later.map((reading) => reading.text),
      `utterances after the announce ack: ${JSON.stringify(later.map((reading) => reading.text))}`,
    ).not.toHaveLength(0);
  });

  test('the first narrator audio started BEFORE tts_done, and within the speech-end budget', () => {
    const announce = run.narrator.tts.find((reading) => reading.text === ANNOUNCE_TEXT);
    expect(announce, 'the announce utterance must exist').toBeDefined();

    // THE STREAMING CRITERION: the first scheduled source precedes the utterance's completion.
    expect(announce!.firstAudioAtMs, 'the announce must have delivered at least one tts_audio frame').not.toBeNull();
    expect(announce!.firstStartAtMs, 'the page must have scheduled the announce audio').not.toBeNull();
    expect(announce!.doneAtMs, 'the announce must have completed').not.toBeNull();
    expect(
      announce!.firstStartAtMs!,
      `firstStart=${announce!.firstStartAtMs} firstAudio=${announce!.firstAudioAtMs} done=${announce!.doneAtMs}`,
    ).toBeLessThan(announce!.doneAtMs!);

    // THE DoD'S BUDGET: from the end of the speech the narration answers to the first source.
    // `speechEndAtMs` is the page's own final caption for that utterance.
    expect(announce!.speechEndAtMs, 'the announce must follow a final caption on this page').not.toBeNull();
    expect(
      announce!.firstStartAtMs! - announce!.speechEndAtMs!,
      `speechEnd=${announce!.speechEndAtMs} firstAudio=${announce!.firstAudioAtMs} ` +
        `firstStart=${announce!.firstStartAtMs} done=${announce!.doneAtMs}`,
    ).toBeLessThan(1200);

    // The timing table the DoD asks the Notes to carry.
    console.log(
      `narrator first-frame timing: speechEnd=${new Date(announce!.speechEndAtMs!).toISOString()} ` +
        `firstAudio=${new Date(announce!.firstAudioAtMs!).toISOString()} ` +
        `firstStart=${new Date(announce!.firstStartAtMs!).toISOString()} ` +
        `ttsDone=${new Date(announce!.doneAtMs!).toISOString()} ` +
        `speechEndToStartMs=${announce!.firstStartAtMs! - announce!.speechEndAtMs!} ` +
        `firstAudioToStartMs=${announce!.firstStartAtMs! - announce!.firstAudioAtMs!}`,
    );
  });

  test('the run stayed on loopback and carried no cloud credential', () => {
    expect(run.egress.logExists, 'the egress guard must have been loaded').toBe(true);
    expect(run.egress.blocked, 'no non-loopback dial may have been attempted').toBe(false);
    expect(run.egress.dials, 'the only dial is this spec\'s own scripted endpoint').toBe(1);
    expect(run.egress.authorizationSeen, 'the upgrade must carry no cloud credential').toBe(false);
    expect(run.page.pageErrors, `the page threw: ${JSON.stringify(run.page.pageErrors)}`).toHaveLength(0);
  });
});
