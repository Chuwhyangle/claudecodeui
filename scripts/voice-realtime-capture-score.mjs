#!/usr/bin/env node
/**
 * Score ONE Live Voice uplink capture — the WAV plus the endpoint judgement timeline beside it — and
 * print what it says. The point of the capture is offline analysis, and this is the offline analysis:
 * it reads the exact files `voice-realtime-audio-capture.ts` wrote and turns them into readings.
 *
 *   node scripts/voice-realtime-capture-score.mjs --capture ~/.cloudcli/voice-realtime-capture/<id>.wav [--json]
 *   node scripts/voice-realtime-capture-score.mjs --capture ~/.cloudcli/voice-realtime-capture
 *   node scripts/voice-realtime-capture-score.mjs --self-test
 *
 * `--capture` takes the `.wav` path or the directory holding it; a directory uses its newest capture.
 * `--self-test` builds a synthetic capture whose acoustics are known exactly, scores it, and checks the
 * readings — the fail-closed form of "this tool works", so the DoD run is never the first time it runs.
 *
 * TWO READINGS, and both are produced from the capture itself:
 *
 *  · ENDPOINT DECISIONS — how many utterances the endpoint's own detector opened, closed and committed
 *    (`input_audio_buffer.speech_started` / `.speech_stopped` / `.committed` in the timeline), with each
 *    event's millisecond offset from the capture's shared origin.
 *  · A DETECTOR'S PROPOSALS — a plain energy VAD run over the recorded audio, producing its own
 *    segments. This is the baseline the endpoint is compared against, and it needs NOTHING but the
 *    audio: it is the reason a WAV on its own is not enough and the timeline is.
 *
 * The MATCH line pairs the two: how many of the endpoint's utterances some proposal overlaps. That
 * number, and the two counts above it, are the readings — a file that parses but yields none of them
 * is not a corpus, and this tool says so by exiting non-zero.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One line of the capture's judgement timeline. Only the fields this tool reads are named. */
/** @typedef {{kind: string, offsetMs: number|null, atMs?: number, sampleRate?: number, channels?: number, itemId?: string, frames?: number, dataBytes?: number, durationMs?: number}} TimelineEntry */

/** A parsed WAV: the PCM payload plus the header fields a reading is computed against. */
/** @typedef {{sampleRate: number, channels: number, bits: number, dataBytes: number, pcm: Buffer}} Wav */

/** One speech proposal: a run of frames the detector considered speech, in audio milliseconds. */
/** @typedef {{startMs: number, endMs: number, peak: number}} Proposal */

const DEFAULT_OPTIONS = { frameMs: 20, threshold: 0.02, minSpeechMs: 100, minSilenceMs: 300 };

/**
 * Reads a RIFF/WAVE file and returns its PCM payload.
 *
 * The chunk walk is deliberate rather than a fixed 44-byte skip: the capture writes a canonical header,
 * but a capture that was edited, concatenated or re-encoded by an operator still has to score, and a
 * tool that silently mis-reads such a file's payload would report a made-up reading.
 *
 * @param {string} file
 * @returns {Wav}
 */
function readWav(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a RIFF/WAVE file`);
  }
  /** @type {{sampleRate: number, channels: number, bits: number}|null} */
  let format = null;
  /** @type {Buffer|null} */
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && start + 16 <= buffer.length) {
      format = {
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(start, Math.min(start + size, buffer.length));
    }
    offset = start + size + (size % 2);
  }
  if (format === null || data === null) throw new Error(`${file}: missing a fmt or data chunk`);
  return { ...format, dataBytes: data.length, pcm: data };
}

/**
 * Reads the judgement timeline beside a capture, one JSON object per line.
 *
 * A line that cannot be parsed is an ERROR rather than a skipped row: the timeline is the alignment
 * contract, and half of it silently dropped would produce a reading about a capture nobody has.
 *
 * @param {string} file
 * @returns {TimelineEntry[]}
 */
function readTimeline(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    try {
      return /** @type {TimelineEntry} */ (JSON.parse(line));
    } catch (error) {
      throw new Error(`${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * The RMS of one frame of mono PCM16, in 0..1.
 *
 * @param {Buffer} pcm
 * @param {number} index
 * @param {number} samplesPerFrame
 * @returns {number}
 */
function frameRms(pcm, index, samplesPerFrame) {
  let sum = 0;
  const base = index * samplesPerFrame;
  for (let sample = 0; sample < samplesPerFrame; sample += 1) {
    const at = (base + sample) * 2;
    if (at + 1 >= pcm.length) return 0;
    const value = pcm.readInt16LE(at) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samplesPerFrame);
}

/**
 * A plain energy detector: a proposal is a run of above-threshold frames at least `minSpeechMs` long,
 * closed by at least `minSilenceMs` of quiet (or by the end of the audio).
 *
 * Deliberately simple. Its job is to be a SECOND opinion that needs only the audio, so the reading
 * "the endpoint decided N utterances and a plain energy detector proposed M segments" can be produced
 * from a capture with no other tooling. It is a baseline, not a model.
 *
 * @param {Buffer} pcm
 * @param {number} sampleRate
 * @param {{frameMs: number, threshold: number, minSpeechMs: number, minSilenceMs: number}} options
 * @returns {Proposal[]}
 */
function detectProposals(pcm, sampleRate, options) {
  const samplesPerFrame = Math.round((sampleRate * options.frameMs) / 1000);
  const frameCount = Math.floor(pcm.length / 2 / samplesPerFrame);
  const minSpeechFrames = Math.max(1, Math.ceil(options.minSpeechMs / options.frameMs));
  const minSilenceFrames = Math.max(1, Math.ceil(options.minSilenceMs / options.frameMs));
  /** @type {Proposal[]} */
  const proposals = [];
  let start = -1;
  let quiet = 0;
  let peak = 0;

  const close = (/** @type {number} */ endFrame) => {
    if (start >= 0 && endFrame - start >= minSpeechFrames) {
      proposals.push({ startMs: start * options.frameMs, endMs: endFrame * options.frameMs, peak });
    }
    start = -1;
    quiet = 0;
    peak = 0;
  };

  for (let index = 0; index < frameCount; index += 1) {
    const rms = frameRms(pcm, index, samplesPerFrame);
    if (rms >= options.threshold) {
      if (start < 0) start = index;
      if (rms > peak) peak = rms;
      quiet = 0;
    } else if (start >= 0) {
      quiet += 1;
      if (quiet >= minSilenceFrames) close(index - quiet + 1);
    }
  }
  close(frameCount);
  return proposals;
}

/**
 * Pairs the endpoint's `speech_started` / `speech_stopped` offsets into utterances, in order.
 *
 * A `speech_started` with no later `speech_stopped` is kept as an open utterance ending at the capture's
 * end — a connection that was cut off mid-sentence still decided something, and dropping it would
 * undercount by exactly the case an operator is most likely to be looking at.
 *
 * @param {TimelineEntry[]} timeline
 * @param {number} durationMs
 * @returns {{startMs: number, endMs: number}[]}
 */
function endpointUtterances(timeline, durationMs) {
  /** @type {{startMs: number, endMs: number}[]} */
  const utterances = [];
  let open = -1;
  for (const entry of timeline) {
    const offset = typeof entry.offsetMs === 'number' ? entry.offsetMs : null;
    if (offset === null) continue;
    if (entry.kind === 'speech_started') {
      if (open < 0) open = offset;
    } else if (entry.kind === 'speech_stopped' && open >= 0) {
      utterances.push({ startMs: open, endMs: offset });
      open = -1;
    }
  }
  if (open >= 0) utterances.push({ startMs: open, endMs: durationMs });
  return utterances;
}

/**
 * Scores one capture: the audio and the timeline, read from disk.
 *
 * @param {string} capturePath A `.wav` file, or a directory holding one.
 * @param {{frameMs: number, threshold: number, minSpeechMs: number, minSilenceMs: number}} options
 * @returns {Record<string, unknown>}
 */
function scoreCapture(capturePath, options) {
  const wavPath = resolveCapture(capturePath);
  const wav = readWav(wavPath);
  const timelinePath = wavPath.replace(/\.wav$/, '.timeline.jsonl');
  const timeline = readTimeline(timelinePath);
  const origin = timeline.find((entry) => entry.kind === 'origin');

  const frames = Math.floor(wav.dataBytes / 2 / wav.channels);
  const durationMs = Math.round((frames / wav.sampleRate) * 1000);
  const proposals = detectProposals(wav.pcm, wav.sampleRate, options);
  const utterances = endpointUtterances(timeline, durationMs);

  // A proposal MATCHES an utterance when their spans overlap at all — generous on purpose: the reading
  // is "was this utterance noticed by the baseline", not "were the two boundaries within N ms", which
  // is a threshold this tool has no basis to pick.
  const matched = utterances.filter((utterance) =>
    proposals.some((proposal) => proposal.startMs < utterance.endMs && utterance.startMs < proposal.endMs),
  ).length;

  const count = (/** @type {string} */ kind) => timeline.filter((entry) => entry.kind === kind).length;
  const offsetOf = (/** @type {string} */ kind) => {
    const entry = timeline.find((item) => item.kind === kind);
    return entry === undefined ? null : entry.offsetMs;
  };

  return {
    capture: wavPath,
    timeline: timelinePath,
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    durationMs,
    origin: origin === undefined ? null : { atMs: origin.atMs, sampleRate: origin.sampleRate ?? null, channels: origin.channels ?? null },
    endpoint: {
      started: count('speech_started'),
      stopped: count('speech_stopped'),
      committed: count('committed'),
      segments: count('segment'),
      utterances,
      offsets: { speechStartedMs: offsetOf('speech_started'), speechStoppedMs: offsetOf('speech_stopped'), committedMs: offsetOf('committed') },
    },
    detector: { proposals, count: proposals.length },
    match: { matched, total: utterances.length },
  };
}

/**
 * Resolves `--capture` to one `.wav`: the path itself, or the newest capture in the directory.
 *
 * @param {string} capturePath
 * @returns {string}
 */
function resolveCapture(capturePath) {
  if (statSync(capturePath).isDirectory()) {
    const wavs = readdirSync(capturePath)
      .filter((name) => name.endsWith('.wav'))
      .map((name) => join(capturePath, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs || left.localeCompare(right));
    if (wavs.length === 0) throw new Error(`${capturePath}: no .wav capture in the directory`);
    return /** @type {string} */ (wavs[0]);
  }
  return capturePath;
}

/**
 * Whether the report carries at least one READING — the thing AC7 asks for.
 *
 * A capture that parsed but decided nothing and proposed nothing is not a reading: an empty file would
 * otherwise "score" green, which is the failure mode this check exists to prevent.
 *
 * @param {Record<string, unknown>} report
 * @returns {boolean}
 */
function hasReading(report) {
  const endpoint = /** @type {{committed: number, started: number, stopped: number}} */ (report.endpoint);
  const detector = /** @type {{count: number}} */ (report.detector);
  return endpoint.committed > 0 || endpoint.started > 0 || endpoint.stopped > 0 || detector.count > 0;
}

/**
 * @param {Record<string, unknown>} report
 * @returns {string[]}
 */
function render(report) {
  const endpoint = /** @type {{started: number, stopped: number, committed: number, segments: number, utterances: {startMs: number, endMs: number}[], offsets: Record<string, number|null>}} */ (
    report.endpoint
  );
  const detector = /** @type {{count: number}} */ (report.detector);
  const match = /** @type {{matched: number, total: number}} */ (report.match);
  const lines = [
    `capture=${report.capture} rate=${report.sampleRate} channels=${report.channels} durationMs=${report.durationMs}`,
    `endpoint started=${endpoint.started} stopped=${endpoint.stopped} committed=${endpoint.committed} segments=${endpoint.segments}`,
    `detector proposals=${detector.count}`,
    `match ${match.matched}/${match.total}`,
    `offset speech_started=${endpoint.offsets.speechStartedMs ?? '-'}ms speech_stopped=${endpoint.offsets.speechStoppedMs ?? '-'}ms committed=${endpoint.offsets.committedMs ?? '-'}ms`,
    `reading endpoint-committed=${endpoint.committed} detector-proposals=${detector.count} matched=${match.matched}/${match.total}`,
  ];
  for (const utterance of endpoint.utterances) {
    lines.push(`utterance ${utterance.startMs}ms..${utterance.endMs}ms`);
  }
  return lines;
}

/**
 * Builds a synthetic capture with known acoustics, scores it, and checks the readings.
 *
 * The curve: 100 ms silence, 300 ms of tone, 200 ms silence, at 16 kHz in 20 ms frames — so the audio
 * is unambiguous about where speech is. The timeline claims the endpoint opened speech at 108 ms and
 * released it at 412 ms (a few ms off, as a real detector's are). The checks below are what make
 * `--self-test` worth running: they fail if the audio cannot be read, if the timeline cannot be
 * aligned, or if the detector stops finding the tone.
 *
 * @returns {void}
 */
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'voice-capture-score-selftest-'));
  const wavPath = join(root, 'selftest.wav');
  try {
    const sampleRate = 16000;
    const frameSamples = 320;
    const frameCount = 30;
    const lead = 5;
    const speech = 15;
    const pcm = Buffer.alloc(frameCount * frameSamples * 2);
    for (let index = 0; index < frameCount; index += 1) {
      const speaking = index >= lead && index < lead + speech;
      for (let sample = 0; sample < frameSamples; sample += 1) {
        const value = speaking ? Math.round(16000 * Math.sin((2 * Math.PI * 440 * sample) / sampleRate)) : 0;
        pcm.writeInt16LE(value, (index * frameSamples + sample) * 2);
      }
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
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
    header.writeUInt32LE(pcm.length, 40);
    writeFileSync(wavPath, Buffer.concat([header, pcm]));

    const t0 = 1_700_000_000_000;
    const timeline = [
      { at: new Date(t0).toISOString(), kind: 'origin', atMs: t0, offsetMs: 0, sampleRate, channels: 1 },
      { at: new Date(t0 + 108).toISOString(), kind: 'speech_started', atMs: t0 + 108, offsetMs: 108 },
      { at: new Date(t0 + 412).toISOString(), kind: 'speech_stopped', atMs: t0 + 412, offsetMs: 412 },
      { at: new Date(t0 + 420).toISOString(), kind: 'committed', atMs: t0 + 420, offsetMs: 420, itemId: 'item_selftest' },
      { at: new Date(t0 + 600).toISOString(), kind: 'final', frames: frameCount, dataBytes: pcm.length, durationMs: 600, offsetMs: 600 },
    ];
    writeFileSync(wavPath.replace(/\.wav$/, '.timeline.jsonl'), `${timeline.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const report = scoreCapture(wavPath, DEFAULT_OPTIONS);
    const endpoint = /** @type {{committed: number, offsets: Record<string, number|null>}} */ (report.endpoint);
    const detector = /** @type {{count: number}} */ (report.detector);
    const match = /** @type {{matched: number, total: number}} */ (report.match);

    const failures = [];
    if (!hasReading(report)) failures.push('the synthetic capture produced no reading');
    if (report.sampleRate !== sampleRate) failures.push(`sampleRate read as ${report.sampleRate}, expected ${sampleRate}`);
    if (report.durationMs !== 600) failures.push(`durationMs read as ${report.durationMs}, expected 600`);
    if (endpoint.committed !== 1) failures.push(`endpoint committed read as ${endpoint.committed}, expected 1`);
    if (endpoint.offsets.speechStartedMs !== 108) failures.push(`speech_started offset read as ${endpoint.offsets.speechStartedMs}, expected 108`);
    if (detector.count !== 1) failures.push(`detector proposed ${detector.count} segments, expected 1`);
    if (match.matched !== 1 || match.total !== 1) failures.push(`match read as ${match.matched}/${match.total}, expected 1/1`);

    if (failures.length > 0) {
      for (const failure of failures) console.error(`self-test FAIL: ${failure}`);
      process.exitCode = 1;
      return;
    }
    for (const line of render(report)) console.log(`self-test ${line}`);
    console.log('self-test ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The parsed command line. */
const argv = process.argv.slice(2);
/** @type {string|null} */
let capture = null;
let json = false;
let selfTestRequested = false;
/** @type {{frameMs: number, threshold: number, minSpeechMs: number, minSilenceMs: number}} */
const options = { ...DEFAULT_OPTIONS };

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--capture') capture = argv[++index] ?? null;
  else if (arg === '--frame-ms') options.frameMs = Number(argv[++index]);
  else if (arg === '--threshold') options.threshold = Number(argv[++index]);
  else if (arg === '--min-speech-ms') options.minSpeechMs = Number(argv[++index]);
  else if (arg === '--min-silence-ms') options.minSilenceMs = Number(argv[++index]);
  else if (arg === '--json') json = true;
  else if (arg === '--self-test') selfTestRequested = true;
  else {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

if (selfTestRequested) {
  selfTest();
} else if (capture === null) {
  console.error('usage: node scripts/voice-realtime-capture-score.mjs --capture <wav|dir> [--json]');
  console.error('       node scripts/voice-realtime-capture-score.mjs --self-test');
  process.exit(2);
} else {
  try {
    const report = scoreCapture(capture, options);
    if (json) console.log(JSON.stringify(report, null, 2));
    else for (const line of render(report)) console.log(line);
    // The tool's contract: exit 0 only when it actually READ something. A capture that parses but
    // yields no reading exits 1, so a green run in a script means data, not an empty directory.
    if (!hasReading(report)) {
      console.error('no reading: the capture carried neither an endpoint decision nor a detectable segment');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
