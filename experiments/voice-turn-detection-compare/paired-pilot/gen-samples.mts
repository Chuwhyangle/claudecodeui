/**
 * Generate the P0.8 pilot's audio from the authored scripts in `samples.json`.
 *
 * WHY TTS AND NOT THE REAL-RECORDED CORPUS. The P0.6/P0.7 corpus added 32 real human
 * recordings, but every one of them is READ SPEECH (LibriSpeech/THCHS-30) — prose read aloud,
 * with no programming intent and no self-correction. It therefore cannot answer this pilot's
 * question ("does the chain act on a developer's spoken instruction?"). The scripts here are
 * authored as developer dictation, so the ground-truth intent is exact by construction; the
 * audio is TTS (`synthetic:true`, recorded as such in samples.json and RESULT.json). No human
 * speaker is claimed.
 *
 * TWO SYNTHESIS MODES, AND WHY. `synth` per sample is either `natural` or `inject`:
 *
 *   - `natural` — synthesise the whole text in ONE TTS pass (`speak`). The model's own prosody
 *     produces whatever pauses the phrasing implies (a comma is short; a clause boundary is
 *     slightly longer), but no pause is manufactured. This is the honest audio for a fluent
 *     instruction, and it is what a real user's utterance sounds like.
 *   - `inject`  — `buildClip` injects pause structure at a target speech-occupancy (`o55` the
 *     "长停顿/高度斟酌" tier, `o65` "边想边说"). This is applied ONLY to the two samples whose
 *     SCENARIO is the pause itself (s2 thinking-pause, s3 supplementary-qualifier), so that the
 *     endpoint-vs-hesitation challenge is present exactly where the design says it should be and
 *     absent from the fluent samples.
 *
 * A first smoke run synthesised EVERY sample with `inject`; the injected pauses (0.72-3.41 s)
 * all exceeded the 400 ms endpoint window, so both chains fired at every internal pause and acted
 * on fragments — a sample-design artifact, not a property of either chain. Measuring natural
 * whole-text synthesis showed the fluent samples collapse to a single endpoint, so the injected
 * pauses were confined to s2/s3 and the fluent samples switched to `natural`.
 *
 * A trailing silence is APPENDED here (not by the synthesiser): the endpoint detector needs a
 * silence to fire on, and appending it in the generator rather than mid-run keeps the audio
 * deterministic and the recorded `speechEndMs`/`appendedTailMs` reproducible.
 *
 * Run:  npx tsx --tsconfig server/tsconfig.json \
 *         experiments/voice-turn-detection-compare/paired-pilot/gen-samples.mts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TC = '/data/home/yale/work/tc-verify';

const { buildClip } = await import(`${TC}/tools/dictation-corpus.mjs`);
const { speak } = await import(`${TC}/tools/tts.mjs`);
const { writeWav, concat, silence, durationSec, trimEdgeSilence, RATE } = await import(
  `${TC}/tools/wav.mjs`
);

type Sample = {
  id: string;
  scenario: string;
  scriptId: string;
  text: string;
  occupancy: string;
  seed: number;
  synth: 'natural' | 'inject';
};

const spec = JSON.parse(readFileSync(join(HERE, 'samples.json'), 'utf8')) as {
  samples: Sample[];
  audioProvenance: { voice: string };
};
const VOICE = spec.audioProvenance.voice;
const APPEND_TAIL_MS = 1200; // enough silence for a 400 ms endpoint rule to fire, plus margin.

const AUDIO_DIR = join(HERE, 'audio');
mkdirSync(AUDIO_DIR, { recursive: true });

const manifest: Array<Record<string, unknown>> = [];
for (const s of spec.samples) {
  let speech: Float32Array;
  let pauses: unknown;
  let chunks: unknown;
  let speechSeconds: number;
  if (s.synth === 'inject') {
    const clip = await buildClip({ id: s.scriptId, kind: 'pilot', text: s.text }, s.occupancy, {
      voice: VOICE,
      seed: s.seed,
    });
    // Ground truth: the last speech interval's end, in the ORIGINAL clip timeline.
    speech = clip.samples;
    pauses = clip.pauses;
    chunks = clip.chunks;
    speechSeconds = clip.speechSeconds;
  } else {
    const raw = await speak(s.text, { voice: VOICE });
    // Trim the synthesiser's edge padding so the clip starts on speech and the appended tail is
    // the ONLY trailing silence the detector sees.
    speech = trimEdgeSilence(raw as Float32Array, RATE, 0.008);
    pauses = [];
    chunks = [];
    speechSeconds = +durationSec(speech).toFixed(3);
  }

  const tail = silence(APPEND_TAIL_MS / 1000, RATE);
  const audio = concat(speech, tail);
  const wavPath = join(AUDIO_DIR, `${s.id}.wav`);
  writeWav(wavPath, audio);

  // The appended tail carries no speech, so the speech-end offset is the end of the trimmed /
  // generated speech itself.
  const speechEndMs = Math.round(durationSec(speech) * 1000);
  const sha256 = createHash('sha256').update(readFileSync(wavPath)).digest('hex');
  const entry = {
    id: s.id,
    scenario: s.scenario,
    scriptId: s.scriptId,
    text: s.text,
    occupancy: s.occupancy,
    synth: s.synth,
    seed: s.seed,
    voice: VOICE,
    synthetic: true,
    sampleRate: RATE,
    totalMs: Math.round(durationSec(audio) * 1000),
    speechEndMs,
    appendedTailMs: APPEND_TAIL_MS,
    speechSeconds,
    pauses,
    chunks,
    wav: `audio/${s.id}.wav`,
    sha256,
  };
  manifest.push(entry);
  console.log(
    `${s.id.padEnd(28)} ${s.synth.padEnd(7)} ${String(entry.totalMs).padStart(5)}ms  speechEnd=${String(speechEndMs).padStart(5)}ms`,
  );
}

writeFileSync(join(HERE, 'audio', 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`GEN-DONE ${manifest.length} samples -> audio/manifest.json`);
