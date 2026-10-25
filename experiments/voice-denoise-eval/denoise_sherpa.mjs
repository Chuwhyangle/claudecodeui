#!/usr/bin/env node
/**
 * Runs the two sherpa-onnx speech-enhancement arms over the prepared mixtures.
 *
 * GTCRN is the 16k ultra-light streaming model (0.5 MB); DPDFNet is the
 * heavier 16k quality arm (8.4 MB). Both are used in their offline form here so
 * the ASR/SI-SDR comparison measures the model rather than chunk buffering.
 * The production streaming wrapper is `OnlineSpeechDenoiser`.
 *
 * Run from the repository root so `sherpa-onnx-node` resolves:
 *   node experiments/voice-denoise-eval/denoise_sherpa.mjs
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const OUT = '/tmp/voice-denoise-eval';
const DATASET = path.join(OUT, 'dataset');
const ENHANCED = path.join(OUT, 'enhanced');
const manifest = JSON.parse(readFileSync(path.join(DATASET, 'manifest.json'), 'utf8'));
const models = {
  gtcrn: '/tmp/voice-denoise-eval/models/gtcrn_simple.onnx',
  dpdfnet: '/tmp/voice-denoise-eval/models/dpdfnet_baseline.onnx',
};

mkdirSync(ENHANCED, { recursive: true });

const denoisers = {};
for (const [name, model] of Object.entries(models)) {
  denoisers[name] = new sherpa.OfflineSpeechDenoiser({
    model: { [name]: { model } },
    numThreads: 1,
    debug: false,
    provider: 'cpu',
  });
  console.log(`${name}: sampleRate=${denoisers[name].sampleRate}`);
}

for (const item of manifest) {
  const wave = sherpa.readWave(item.noisy);
  for (const [name, denoiser] of Object.entries(denoisers)) {
    const output = denoiser.run({ samples: wave.samples, sampleRate: wave.sampleRate });
    const file = path.join(ENHANCED, `${item.id}_${name}.wav`);
    sherpa.writeWave(file, { samples: output.samples, sampleRate: output.sampleRate });
    console.log(`${item.id} ${name}: ${wave.samples.length} -> ${output.samples.length} samples`);
  }
}
