#!/usr/bin/env node
/**
 * E0 — unattended end-to-end replay of a REAL wav sample through the Live Voice chain.
 *
 * WHAT THIS RUNS. One frozen recording from
 * `~/.cloudcli/voice-realtime-closing-turn-corpus/capture/` is played through the browser's Live
 * Voice capture path (via the harness's WAV microphone, `wavMic.ts`), the real app server's
 * `/voice-realtime` proxy and relay, and the browser's real read-aloud path (`/api/voice/tts` +
 * `voicePlayer`). The spec it launches (`e2e/voice-output-e2e-harness.spec.ts`) turns the run into
 * pass/fail assertions; this script prepares the sample and reports the verdict.
 *
 * WHY THE SAMPLE IS PREPARED HERE AND NOT IN THE SPEC. Two readings have to agree before a replay
 * is meaningful, and both are derived from the frozen corpus:
 *
 *   1. WHICH UTTERANCES THE WINDOW CONTAINS. The corpus ships the original endpoint's commit
 *      timeline (`capture/<id>.timeline.jsonl`) and the recogniser's output (`log/<id>.jsonl`).
 *      Pairing them by order is what lets the harness say "the message the relay carried is the
 *      transcript this exact recording produced" instead of inventing a sentence.
 *   2. THE DETECTOR PARAMETERS THAT HEAR EXACTLY THOSE UTTERANCES. The scripted endpoint is a
 *      peak-based `server_vad` stand-in (`createScriptedVad`). Real microphone audio is much
 *      quieter than the synthetic fixtures (peaks ~0.1–0.5, not ~0.9), and its inter-word gaps do
 *      not line up with a fixed 400 ms window. So this script simulates the detector over the
 *      exact PCM bytes the browser will send — the same 20 ms windows, the same PCM16
 *      quantization, the same silence accounting — and picks a `(threshold, silence)` pair under
 *      which the detector closes exactly as many utterances as the frozen transcript list. If no
 *      pair does, the run refuses to start rather than producing a replay nobody could attribute.
 *
 * WHAT IT DOES NOT DO. It does not call any cloud service, does not touch the deployer's
 * `:3001`, and does not replace the product's capture/relay/TTS code: the Playwright spec it
 * launches owns those, through the same `playwright.config.ts` selection every sibling voice
 * criterion uses.
 *
 * USAGE
 *   node experiments/voice-e2e-harness/run.mjs                  # replay the default sample
 *   node experiments/voice-e2e-harness/run.mjs --sample 8fe60310
 *   node experiments/voice-e2e-harness/run.mjs --list           # list the corpus and derived windows
 *   node experiments/voice-e2e-harness/run.mjs --plan-only      # derive + calibrate, launch nothing
 *   node experiments/voice-e2e-harness/run.mjs --dump /tmp/run.json
 *
 * ENV
 *   VOICE_E2E_CORPUS_DIR  override the corpus root (default ~/.cloudcli/voice-realtime-closing-turn-corpus)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CORPUS_DIR =
  process.env.VOICE_E2E_CORPUS_DIR ?? path.join(os.homedir(), '.cloudcli', 'voice-realtime-closing-turn-corpus');
const CAPTURE_DIR = path.join(CORPUS_DIR, 'capture');
const LOG_DIR = path.join(CORPUS_DIR, 'log');

/** The spec this runner drives. Named noise (`--grep`) is passed through to Playwright. */
const SPEC = 'e2e/voice-output-e2e-harness.spec.ts';
/** The default sample: the shortest capture that still carries several real utterances. */
const DEFAULT_SAMPLE = '402fad85';

/**
 * The model's closing-turn follow-up the scripted endpoint says after a delivered `session_send`.
 *
 * Since `a2c2e8139` ("speak the announce at speech_stopped") the announce no longer waits for this
 * turn: the endpoint's `speech_stopped` enqueues `announce-early-<seq>` with the connection's fixed
 * phrase table (`voice-realtime-announce-phrases.ts`), and the real closing turn — this sentence —
 * is SUPPRESSED inside the 3 s window. It remains armed because it is the trigger the suppression
 * is measured on; the spec asserts this exact sentence never reaches the page or the TTS stand-in.
 */
const ANNOUNCE_TEXT = '好的，我来查一下。';

/**
 * The run-end summary the narrator says, as the stand-in producer.
 *
 * The real producer is a side text model; this run supplies the text through the deployment's own
 * stand-in seam (`VOICE_REALTIME_SUMMARY_STANDIN`), so the whole replay stays on loopback. Chosen to
 * satisfy the same gate a model's answer would face: ≤40 characters, no Markdown, and no tail shared
 * with the context pack it summarizes.
 */
const SUMMARY_TEXT = '本轮任务已结束，全部检查通过。';

/**
 * The voice id this run names for the scripted TTS stand-in.
 *
 * A stand-in accepts any non-empty value. What matters here is that the leaf refuses an EMPTY voice
 * before dialling, so the criterion has to name one to exercise the downlink at all.
 */
const TTS_VOICE = 'voice-e2e-standin';

/** Candidate detector parameters, swept by {@link calibrate}. */
const THRESHOLD_CANDIDATES = [0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3];
const SILENCE_CANDIDATES = [300, 400, 500, 600, 700, 800, 1000, 1200];
/** The detector's analysis window, mirroring `ANALYSIS_WINDOW_MS` in the scripted endpoint. */
const ANALYSIS_WINDOW_MS = 20;

const fail = (message) => {
  process.stderr.write(`voice-e2e: ${message}\n`);
  process.exit(2);
};

// ── wav ────────────────────────────────────────────────────────────────────────────────────────
/** Reads a mono, 16-bit PCM WAV. Anything else is refused: the browser path assumes this shape. */
function readWav(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${filePath}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    offset = body + size + (size % 2);
  }
  if (format === null || data === null) throw new Error(`${filePath}: missing fmt/data chunk`);
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error(
      `${filePath}: expected mono 16-bit PCM, got format=${format.audioFormat} channels=${format.channels} bits=${format.bitsPerSample}`,
    );
  }
  return { sampleRate: format.sampleRate, pcm: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) };
}

// ── the frozen corpus ─────────────────────────────────────────────────────────────────────────
const readJsonl = (filePath) =>
  readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

/** `<< transcription.completed "…"` → the words, or null. */
function transcriptOfLine(line) {
  const marker = '<< transcription.completed ';
  if (typeof line !== 'string' || !line.startsWith(marker)) return null;
  const raw = line.slice(marker.length).trim();
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
}

/**
 * One sample: its PCM, its endpoint timeline, and the recogniser's transcript for each commit.
 *
 * THE PAIRING IS BY ORDER, and that is a claim checked rather than assumed: the endpoint wrote one
 * `committed` event per utterance and the recogniser wrote one `transcription.completed` line per
 * utterance, in the same spoken order. A sample where the two counts disagree is refused — it is a
 * corpus the harness cannot attribute.
 */
function loadSample(sampleId) {
  const wavPath = path.join(CAPTURE_DIR, `${sampleId}.wav`);
  const timelinePath = path.join(CAPTURE_DIR, `${sampleId}.timeline.jsonl`);
  const logPath = path.join(LOG_DIR, `${sampleId}.jsonl`);
  if (!existsSync(wavPath)) fail(`no wav for sample ${sampleId} under ${CAPTURE_DIR}`);
  if (!existsSync(timelinePath)) fail(`no timeline for sample ${sampleId} under ${CAPTURE_DIR}`);
  if (!existsSync(logPath)) fail(`no frozen log for sample ${sampleId} under ${LOG_DIR}`);

  const { sampleRate, pcm } = readWav(wavPath);
  const timeline = readJsonl(timelinePath);
  const commits = timeline.filter((event) => event.kind === 'committed').map((event) => event.offsetMs);
  const speechStarted = timeline.filter((event) => event.kind === 'speech_started').map((event) => event.offsetMs);
  const speechStopped = timeline.filter((event) => event.kind === 'speech_stopped').map((event) => event.offsetMs);

  const transcripts = [];
  for (const entry of readJsonl(logPath)) {
    const text = transcriptOfLine(entry.line);
    if (text !== null) transcripts.push(text);
  }
  if (commits.length !== transcripts.length) {
    fail(
      `sample ${sampleId}: ${commits.length} committed event(s) but ${transcripts.length} frozen transcript(s) — ` +
        'the corpus pair cannot be attributed',
    );
  }

  const durationMs = (pcm.length / sampleRate) * 1000;
  const paddingMs = 1500;
  const windowStartMs = Math.max(0, Math.floor((speechStarted.length > 0 ? Math.min(...speechStarted) : 0) - paddingMs));
  const windowEndMs = Math.min(
    Math.floor(durationMs),
    Math.ceil((speechStopped.length > 0 ? Math.max(...speechStopped) : Math.floor(durationMs)) + paddingMs),
  );
  const turns = transcripts
    .map((text, index) => ({ text, offsetMs: commits[index] }))
    .filter((turn) => turn.offsetMs >= windowStartMs && turn.offsetMs <= windowEndMs)
    .map((turn) => ({ text: turn.text, offsetMs: turn.offsetMs }));

  return { sampleId, wavPath, sampleRate, pcm, durationMs, windowStartMs, windowEndMs, turns };
}

/** The exact PCM16 the app will put on the wire: the wav's samples re-quantized by the client encoder. */
function wirePcm(pcm, sampleRate, startMs, endMs) {
  const from = Math.floor((startMs * sampleRate) / 1000);
  const to = Math.min(pcm.length, Math.floor((endMs * sampleRate) / 1000));
  const out = new Int16Array(to - from);
  for (let index = from; index < to; index += 1) {
    // `encodePcm16Base64`: clamp to [-1, 1], then trunc(v * 0x7fff) / trunc(v * 0x8000) — the
    // truncation Direction of `DataView.setInt16`. Applied to the float the worklet delivers.
    const sample = pcm[index] / 32768;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    out[index - from] = Math.trunc(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return out;
}

/**
 * Mirrors `createScriptedVad`'s acoustic detector over the exact wire bytes.
 *
 * PEAK, not RMS, over {@link ANALYSIS_WINDOW_MS} windows; an utterance closes once the silence
 * after speech reaches `silenceMs` of RECEIVED samples (`timeBase: 'audio-time'`). Returns the
 * closed utterance spans in window-relative seconds.
 */
function detect(pcm, sampleRate, threshold, silenceMs) {
  const window = Math.max(1, Math.round((sampleRate * ANALYSIS_WINDOW_MS) / 1000));
  const closes = [];
  let inSpeech = false;
  let silentSamples = 0;
  let startedAt = 0;
  for (let offset = 0; offset + window <= pcm.length; offset += window) {
    let peak = 0;
    for (let index = offset; index < offset + window; index += 1) {
      const amplitude = Math.abs(pcm[index]) / 32768;
      if (amplitude > peak) peak = amplitude;
    }
    if (peak >= threshold) {
      if (!inSpeech) {
        inSpeech = true;
        startedAt = offset / sampleRate;
      }
      silentSamples = 0;
    } else if (inSpeech) {
      silentSamples += window;
      if ((silentSamples / sampleRate) * 1000 >= silenceMs) {
        closes.push({ startedAt: Number(startedAt.toFixed(2)), endedAt: Number(((offset + window) / sampleRate).toFixed(2)) });
        inSpeech = false;
        silentSamples = 0;
      }
    }
  }
  return closes;
}

/**
 * Picks the `(threshold, silence)` pair under which the detector hears exactly the frozen turns.
 *
 * STABILITY IS THE TIE-BREAK. Several pairs can produce the right COUNT by accident (one absorbed
 * gap here, one spurious burst there). A pair whose neighbours in the candidate grid also produce
 * the right count is one the segmentation is not balancing on a single window, so it is preferred
 * over an equally-correct pair with no support. The remaining tie-break prefers the neighbours of
 * the shipped detector's own defaults (threshold 0.5 is too high for real microphone audio;
 * silence 800 is the shipped value) rather than an arbitrary corner of the grid.
 */
function calibrate(pcm, sampleRate, expectedCount) {
  const matches = [];
  for (let t = 0; t < THRESHOLD_CANDIDATES.length; t += 1) {
    for (let s = 0; s < SILENCE_CANDIDATES.length; s += 1) {
      const threshold = THRESHOLD_CANDIDATES[t];
      const silenceMs = SILENCE_CANDIDATES[s];
      const closes = detect(pcm, sampleRate, threshold, silenceMs);
      if (closes.length === expectedCount) matches.push({ t, s, threshold, silenceMs, closes });
    }
  }
  if (matches.length === 0) {
    const readings = [];
    for (const threshold of THRESHOLD_CANDIDATES) {
      for (const silenceMs of SILENCE_CANDIDATES) {
        readings.push(`${threshold}/${silenceMs}:${detect(pcm, sampleRate, threshold, silenceMs).length}`);
      }
    }
    return { ok: false, readings };
  }
  const score = (candidate) =>
    matches.filter((peer) => Math.abs(peer.t - candidate.t) <= 1 && Math.abs(peer.s - candidate.s) <= 1).length;
  matches.sort((left, right) => {
    const bySupport = score(right) - score(left);
    if (bySupport !== 0) return bySupport;
    const byThreshold = Math.abs(left.threshold - 0.1) - Math.abs(right.threshold - 0.1);
    if (byThreshold !== 0) return byThreshold;
    return Math.abs(left.silenceMs - 600) - Math.abs(right.silenceMs - 600);
  });
  const best = matches[0];
  return { ok: true, threshold: best.threshold, silenceMs: best.silenceMs, closes: best.closes, candidates: matches.length };
}

// ── argv ──────────────────────────────────────────────────────────────────────────────────────
function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

if (!existsSync(CAPTURE_DIR)) {
  fail(`corpus not found at ${CORPUS_DIR} (override with VOICE_E2E_CORPUS_DIR)`);
}

const sampleIds = readdirSync(CAPTURE_DIR)
  .filter((name) => name.endsWith('.wav'))
  .map((name) => name.slice(0, -4))
  .sort();

if (process.argv.includes('--list')) {
  for (const sampleId of sampleIds) {
    try {
      const sample = loadSample(sampleId);
      process.stdout.write(
        `${sampleId}  window=${sample.windowStartMs}-${sample.windowEndMs}ms (${(sample.windowEndMs - sample.windowStartMs) / 1000}s)  ` +
          `turns=${sample.turns.length}  duration=${(sample.durationMs / 1000).toFixed(1)}s\n`,
      );
    } catch (error) {
      process.stdout.write(`${sampleId}  (unreadable: ${error instanceof Error ? error.message : error})\n`);
    }
  }
  process.exit(0);
}

const requested = readArg('sample', DEFAULT_SAMPLE);
const sampleId = sampleIds.find((id) => id.startsWith(requested));
if (sampleId === undefined) {
  fail(`no sample matching "${requested}" (run with --list to see the corpus)`);
}

const sample = loadSample(sampleId);
if (sample.turns.length === 0) fail(`sample ${sampleId}: the derived window carries no frozen transcript`);

const pcm = wirePcm(sample.pcm, sample.sampleRate, sample.windowStartMs, sample.windowEndMs);
const calibration = calibrate(pcm, sample.sampleRate, sample.turns.length);
if (!calibration.ok) {
  fail(
    `sample ${sampleId}: no (threshold, silence) pair hears exactly ${sample.turns.length} utterance(s) — ` +
      `detector readings were ${calibration.readings.join(' ')}`,
  );
}

const plan = {
  version: 1,
  sampleId,
  wavPath: sample.wavPath,
  sampleRate: sample.sampleRate,
  windowStartMs: sample.windowStartMs,
  windowEndMs: sample.windowEndMs,
  expectedTranscripts: sample.turns.map((turn) => turn.text),
  vad: {
    timeBase: 'audio-time',
    threshold: calibration.threshold,
    silenceDurationMs: calibration.silenceMs,
    sampleRate: sample.sampleRate,
    expectedUtterances: sample.turns.length,
  },
  mic: { frameMs: 100 },
};

const planDir = mkdtempSync(path.join(os.tmpdir(), 'voice-e2e-plan-'));
const planPath = path.join(planDir, 'plan.json');
writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

process.stdout.write(
  `[voice-e2e] sample=${sampleId} window=${sample.windowStartMs}-${sample.windowEndMs}ms ` +
    `(${((sample.windowEndMs - sample.windowStartMs) / 1000).toFixed(1)}s) turns=${sample.turns.length}\n` +
    `[voice-e2e] vad threshold=${calibration.threshold} silence=${calibration.silenceMs}ms ` +
    `(stable pairs=${calibration.candidates})\n` +
    `[voice-e2e] transcripts=${JSON.stringify(sample.turns.map((turn) => turn.text))}\n` +
    `[voice-e2e] plan=${planPath}\n`,
);

const dumpPath = readArg('dump', process.env.VOICE_E2E_DUMP ?? path.join(planDir, 'run.json'));
if (process.argv.includes('--plan-only')) {
  process.stdout.write(`[voice-e2e] plan-only: ${JSON.stringify(plan)}\n`);
  process.exit(0);
}
/**
 * A free loopback port for the scripted TTS stand-in.
 *
 * The spec binds the port and answers the leaf's HTTP request; the SERVER has to be told the same
 * address at start-up, so the number is allocated here — before Playwright spawns the app server —
 * and published both as the endpoint and as the spec-side port. Node's own bind/close in a child
 * process is used because this script is synchronous by design (it blocks in `spawnSync` below).
 */
function freePort() {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{process.stdout.write(String(server.address().port));server.close();});",
    ],
    { encoding: 'utf8' },
  );
  const port = Number((result.stdout ?? '').trim());
  if (!Number.isInteger(port) || port <= 0) {
    fail(`could not allocate a TTS stand-in port: ${(result.stderr ?? '').trim()}`);
  }
  return port;
}

const ttsPort = freePort();
const playwright = path.join(REPO_ROOT, 'node_modules', '.bin', 'playwright');
if (!existsSync(playwright)) fail(`playwright bin not found at ${playwright} (run npm install)`);

const passthrough = [];
const doubleDash = process.argv.indexOf('--');
if (doubleDash >= 0) passthrough.push(...process.argv.slice(doubleDash + 1));

const result = spawnSync(playwright, ['test', SPEC, ...passthrough], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    VOICE_E2E_PLAN: planPath,
    VOICE_E2E_DUMP: dumpPath,
    // THE DEPLOYMENT SWITCHES. Playwright passes its own environment to every webServer it spawns,
    // so setting them here is how they reach the app server: `announce` arms the narrator's announce
    // path — since `a2c2e8139` the remark is spoken at `speech_stopped` as `announce-early-<seq>`
    // from the fixed phrase table, while the endpoint's follow-up text (below) is the suppressed
    // closing-turn trigger — and the stand-in text is what the run-end narrator says. Both are read
    // by `server/index.ts` when it assembles a connection's seams.
    VOICE_REALTIME_CLOSING_TURN: 'announce',
    VOICE_REALTIME_SUMMARY_STANDIN: SUMMARY_TEXT,
    // THE SCRIPTED TTS STAND-IN (AC-408). The server assembles the narrator's TTS leaf from these:
    // the endpoint override points its CosyVoice HTTP client at loopback (and, by its presence, says
    // "no real credential"), and the voice id is what stops the leaf refusing before it dials. The
    // spec binds `VOICE_E2E_TTS_PORT` and answers with a valid WAV; both sides therefore name the
    // SAME port rather than each choosing one.
    VOICE_REALTIME_TTS_ENDPOINT: `http://127.0.0.1:${ttsPort}`,
    VOICE_REALTIME_TTS_VOICE: TTS_VOICE,
    VOICE_E2E_TTS_PORT: String(ttsPort),
    // The same two sentences to the spec, so what it asserts and what the endpoint says are one
    // source rather than two literals that could quietly drift apart.
    VOICE_E2E_ANNOUNCE_TEXT: ANNOUNCE_TEXT,
    VOICE_E2E_SUMMARY_TEXT: SUMMARY_TEXT,
  },
});

// ── the verdict, in one line, from the run's own artifact when it exists ─────────────────────
if (existsSync(dumpPath)) {
  try {
    const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
    const messages = Array.isArray(dump.relay?.messages) ? dump.relay.messages : [];
    const narrator = Array.isArray(dump.narrator?.speaks) ? dump.narrator.speaks : [];
    process.stdout.write(
      `[voice-e2e] played frames=${dump.mic?.frames ?? 'n/a'} samples=${dump.mic?.samples ?? 'n/a'} ` +
        `utterances=${dump.detector?.speechStopped ?? 'n/a'}/${plan.vad.expectedUtterances}\n` +
        `[voice-e2e] relayed messages=${JSON.stringify(messages)}\n` +
        `[voice-e2e] narrator speaks=${JSON.stringify(narrator.map((speak) => speak.text))}\n` +
        `[voice-e2e] voice-output tts-requests=${dump.voiceOutput?.requests ?? 'n/a'} ` +
        `audio-bytes=${dump.voiceOutput?.audioBytes ?? 'n/a'} played=${dump.voiceOutput?.played ?? 'n/a'} ` +
        `duration=${dump.voiceOutput?.durationSec ?? 'n/a'}s\n` +
        `[voice-e2e] zero-egress blocked=${dump.egress?.blocked ?? 'n/a'} dials=${dump.egress?.dials ?? 'n/a'} ` +
        `authorization=${dump.egress?.authorizationSeen ?? 'n/a'}\n`,
    );
  } catch (error) {
    process.stdout.write(`[voice-e2e] run artifact unreadable: ${error instanceof Error ? error.message : error}\n`);
  }
}

process.stdout.write(`[voice-e2e] RESULT: ${result.status === 0 ? 'PASS' : 'FAIL'} (exit ${result.status ?? 'signal'})\n`);
process.exit(result.status ?? 1);
