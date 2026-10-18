/**
 * prefix_padding_ms probe: does the DashScope realtime endpoint accept a client-set
 * `turn_detection.prefix_padding_ms`, and does raising it recover the leading syllables that the
 * shipped 300 ms default clips?
 *
 * Two audio modes:
 *   fixture  the known-text TTS clip (10 s): slice 3 s from the first energy onset, 600 ms lead
 *   raw      any 16 kHz mono PCM16 WAV between --fromMs and --fromMs+--durationMs (e.g. a live capture)
 *
 * Arms (same audio, same model/voice, create_response:false so the model never answers):
 *   K      shipped turn_detection { type, threshold:0.5, silence_duration_ms:800 }
 *   P1000  K + prefix_padding_ms:1000
 *   P1500  K + prefix_padding_ms:1500
 *   T03    K with threshold:0.3 (control: earlier detection without touching padding)
 *
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-prefix-padding-probe/probe.mts \
 *     --audio <capture.wav> --fromMs 0 --durationMs 6200 --leadMs 0 --arms K,P1000,P1500 --reps 1
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRun, openSession, readApiKey, sleep, type ProbeEvent } from '../voice-realtime-segmented/p0/probe-lib.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DEFAULT_FIXTURE = path.join(REPO, 'experiments/voice-provider-paired-quality/fixtures/d01-o65.wav');
const FIXTURE_REFERENCE = '把 server 里的 voice.service.ts 的超时改成三十秒';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const argNum = (name: string, fallback: number): number => Number(arg(name, String(fallback)));
const AUDIO = path.resolve(arg('audio', DEFAULT_FIXTURE));
const FROM_MS = argNum('fromMs', -1);
const DURATION_MS = argNum('durationMs', 0);
const LEAD_MS = argNum('leadMs', 600);
const TAIL_MS = argNum('tailMs', 1500);
const REFERENCE = arg('reference', FROM_MS >= 0 ? '' : FIXTURE_REFERENCE);
const ARMS = arg('arms', 'K,P1000,P1500').split(',').map((s) => s.trim()).filter(Boolean);
const REPS = argNum('reps', 1);

type Arm = { id: string; turnDetection: Record<string, unknown> };
const BASE = { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800, create_response: false };
const ARM_DEFS: Record<string, Arm> = {
  K: { id: 'K', turnDetection: { ...BASE } },
  P1000: { id: 'P1000', turnDetection: { ...BASE, prefix_padding_ms: 1000 } },
  P1500: { id: 'P1500', turnDetection: { ...BASE, prefix_padding_ms: 1500 } },
  T03: { id: 'T03', turnDetection: { ...BASE, threshold: 0.3 } },
};

// ── the feed ────────────────────────────────────────────────────────────────────────────────────

function readWavPcm16(file: string): { sampleRate: number; channels: number; pcm: Buffer } {
  const buf = readFileSync(file);
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      const bits = buf.readUInt16LE(off + 22);
      if (bits !== 16) throw new Error(`audio is ${bits}-bit, not PCM16`);
    }
    if (id === 'data') return { sampleRate, channels, pcm: buf.subarray(off + 8, off + 8 + size) };
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function monoPcm16(pcm: Buffer, channels: number): Buffer {
  if (channels === 1) return pcm;
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

const FRAME_SAMPLES = 320; // 20 ms @ 16 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;
const msBytes = (ms: number): number => Math.round((ms / 1000) * 16_000) * 2;

function buildFeed(): { feed: Buffer; speechStartMs: number } {
  const { sampleRate, channels, pcm } = readWavPcm16(AUDIO);
  if (sampleRate !== 16_000) throw new Error(`audio is ${sampleRate} Hz; the endpoint wants 16 kHz`);
  const mono = monoPcm16(pcm, channels);
  let startByte = 0;
  if (FROM_MS >= 0) {
    startByte = msBytes(FROM_MS);
  } else {
    const nFrames = Math.floor(mono.length / FRAME_BYTES);
    let onsetFrame = 0;
    for (let f = 0; f < nFrames; f += 1) {
      let sum = 0;
      for (let s = 0; s < FRAME_SAMPLES; s += 1) {
        const v = mono.readInt16LE((f * FRAME_SAMPLES + s) * 2);
        sum += v * v;
      }
      if (Math.sqrt(sum / FRAME_SAMPLES) > 300) {
        onsetFrame = f;
        break;
      }
    }
    startByte = Math.max(0, onsetFrame - 5) * FRAME_BYTES;
  }
  const length = DURATION_MS > 0 ? msBytes(DURATION_MS) : 3.0 * 16_000 * 2;
  const speech = mono.subarray(startByte, Math.min(mono.length, startByte + length));
  return {
    feed: Buffer.concat([Buffer.alloc(msBytes(LEAD_MS)), speech, Buffer.alloc(msBytes(TAIL_MS))]),
    speechStartMs: LEAD_MS,
  };
}

// ── readings ────────────────────────────────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s，。！？、,.!?"“”'’：:；;（）()\-]/g, '');
}
const REF_NORM = REFERENCE === '' ? '' : normalize(REFERENCE);

function coverage(text: string): { first3: boolean; first5: boolean; first8: boolean } | null {
  if (REF_NORM === '') return null;
  const t = normalize(text);
  return {
    first3: t.includes(REF_NORM.slice(0, 3)),
    first5: t.includes(REF_NORM.slice(0, 5)),
    first8: t.includes(REF_NORM.slice(0, 8)),
  };
}

type Reading = {
  arm: string;
  rep: number;
  echo: Record<string, unknown> | null;
  errors: string[];
  startedMs: number | null;
  stoppedMs: number | null;
  transcripts: string[];
  coverage: ReturnType<typeof coverage>;
  spendCny: number;
};

function pickEcho(events: ProbeEvent[]): Record<string, unknown> | null {
  const updated = events.filter((e) => e.direction === 'received' && e.wire.type === 'session.updated');
  const session = updated[updated.length - 1]?.wire.session as Record<string, unknown> | undefined;
  const td = session?.turn_detection;
  return td && typeof td === 'object' ? (td as Record<string, unknown>) : null;
}

async function runOne(arm: Arm, rep: number, run: ReturnType<typeof createRun>, feed: Buffer): Promise<Reading> {
  const session = await openSession({
    run,
    label: `${arm.id}#${rep}`,
    instructions: 'You are a voice relay. Relay what the user says. Never reply in text.',
    sessionDefaults: {
      modalities: ['text'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm24',
      turn_detection: arm.turnDetection,
    },
  });
  await session.waitFor(
    () => session.events.some((e) => e.direction === 'received' && e.wire.type === 'session.updated'),
    8_000,
  );

  const feedStart = Date.now();
  const frames = Math.floor(feed.length / FRAME_BYTES);
  for (let i = 0; i < frames; i += 1) {
    session.sendAudioBase64(feed.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES).toString('base64'));
    await sleep(20);
  }
  // Let the endpoint close every turn and finish every transcription.
  await sleep(TAIL_MS + 2_500);

  const received = session.events.filter((e) => e.direction === 'received');
  const at = (type: string): number | null => {
    const hit = received.find((e) => e.wire.type === type);
    return hit === undefined ? null : hit.atMs - feedStart;
  };
  const transcripts = received
    .filter((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed')
    .map((e) => String((e.wire as Record<string, unknown>).transcript ?? ''));
  const text = transcripts.join('');
  const reading: Reading = {
    arm: arm.id,
    rep,
    echo: pickEcho(session.events),
    errors: session.errors.map((e) => String((e.wire as Record<string, unknown>).error ?? e.wire.type)),
    startedMs: at('input_audio_buffer.speech_started'),
    stoppedMs: at('input_audio_buffer.speech_stopped'),
    transcripts,
    coverage: text === '' ? null : coverage(text),
    spendCny: session.spendCny,
  };
  await session.close();
  return reading;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

const apiKey = readApiKey();
const run = createRun({ budgetCny: 0.2, apiKey });
const { feed } = buildFeed();
console.log(
  `audio=${path.relative(REPO, AUDIO)} from=${FROM_MS}ms dur=${DURATION_MS}ms lead=${LEAD_MS}ms ` +
    `feed=${(feed.length / 2 / 16_000).toFixed(2)}s arms=${ARMS.join(',')} reps=${REPS} ref=${JSON.stringify(REFERENCE)}`,
);

const readings: Reading[] = [];
for (let rep = 1; rep <= REPS; rep += 1) {
  for (const id of ARMS) {
    const arm = ARM_DEFS[id];
    if (!arm) {
      console.log(`unknown arm ${id}`);
      continue;
    }
    try {
      const reading = await runOne(arm, rep, run, feed);
      readings.push(reading);
      console.log(
        `${reading.arm}#${reading.rep} echo=${JSON.stringify(reading.echo)} ` +
          `started=${reading.startedMs}ms stopped=${reading.stoppedMs}ms cov=${JSON.stringify(reading.coverage)} ` +
          `text=${JSON.stringify(reading.transcripts)} errors=${JSON.stringify(reading.errors)} cny=${reading.spendCny}`,
      );
    } catch (error) {
      console.log(`${arm.id}#${rep} FAILED ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }
}

mkdirSync(path.join(HERE, 'traces'), { recursive: true });
const out = path.join(HERE, 'traces', `prefix-padding-${Date.now()}.json`);
writeFileSync(
  out,
  JSON.stringify({ audio: AUDIO, fromMs: FROM_MS, durationMs: DURATION_MS, reference: REFERENCE, arms: readings, spendCny: run.spendCny }, null, 2),
);
console.log(`\nspend=${run.spendCny.toFixed(6)} CNY guard=${run.guardTriggered} trace=${path.relative(REPO, out)}`);
