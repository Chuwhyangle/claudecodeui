/**
 * Does one process keep N real-time silero uplink gates on a 20 ms clock? (¥0, no upstream.)
 *
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-realtime-closing-turn/drift-probe.mts [streams=8] [seconds=30]
 *
 * The staged plan runs 8 replays at once (stages 2 and 3 together). `run.mts` paces each frame to
 * t0 + i×20 ms and records the worst lateness as `driftMs`; the gate FAILS a run past 800 ms. This
 * measures that number under the same load before any money depends on it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_TURN_DETECTION } from '../../server/modules/voice-realtime/voice-realtime-turn-detection.js';
import { createUplinkVadClassifier } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';
import { createUplinkVadGate } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad-gate.js';

const HOME = os.homedir();
const CORPUS = path.join(HOME, '.cloudcli', 'voice-realtime-closing-turn-corpus', 'capture');
const WEIGHTS = process.env.VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH ?? path.join(HOME, 'work/voice-vad-engines/silero/silero_vad.onnx');
const STREAMS = Number(process.argv[2] ?? 8);
const SECONDS = Number(process.argv[3] ?? 30);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const wavs = readdirSync(CORPUS).filter((f) => f.endsWith('.wav'));
const pcmOf = (file: string): Buffer => {
  const buf = readFileSync(path.join(CORPUS, file));
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') return buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
};

const one = async (index: number): Promise<{ driftMs: number; late: number; frames: number }> => {
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: WEIGHTS });
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: DEFAULT_TURN_DETECTION.silence_duration_ms });
  const pcm = pcmOf(wavs[index % wavs.length]!);
  const total = Math.min(Math.floor(pcm.length / 640), Math.floor((SECONDS * 1000) / 20));
  await sleep(200); // every stream starts together, after all classifiers exist
  const t0 = Date.now();
  let driftMs = 0;
  let late = 0;
  for (let i = 0; i < total; i++) {
    await gate.observe(pcm.subarray(i * 640, (i + 1) * 640).toString('base64'));
    const wait = t0 + (i + 1) * 20 - Date.now();
    if (wait > 0) await sleep(wait);
    else {
      driftMs = Math.max(driftMs, -wait);
      if (-wait > 100) late += 1;
    }
  }
  await gate.close().catch(() => undefined);
  return { driftMs, late, frames: total };
};

const t = Date.now();
const results = await Promise.all(Array.from({ length: STREAMS }, (_, i) => one(i)));
console.log(`${STREAMS} concurrent gates × ${SECONDS} s on ${os.cpus().length} cpu(s), load ${os.loadavg()[0]!.toFixed(1)} · wall ${((Date.now() - t) / 1000).toFixed(1)} s`);
results.forEach((r, i) => console.log(`  stream ${i}: max drift ${r.driftMs} ms · frames > 100 ms late ${r.late}/${r.frames}`));
const worst = Math.max(...results.map((r) => r.driftMs));
console.log(`worst drift ${worst} ms (gate: warn > 400, fail > 800)`);
process.exit(worst > 800 ? 1 : 0);
