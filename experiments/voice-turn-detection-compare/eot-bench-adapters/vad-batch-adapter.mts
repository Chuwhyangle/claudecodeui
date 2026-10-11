/**
 * Group A as an eot-bench BATCH adapter: the SHIPPING `StreamingVad`, asked the causal question at
 * every grid cell of every candidate point.
 *
 * IT IS THE SHIPPING RULE, NOT A REIMPLEMENTATION. `StreamingVad` and `thresholdsFor` are imported
 * from `src/shared/voiceEndpoint.ts` — the module the voice relay actually runs — and the commit rule
 * is the module's own: an utterance ends once `endpointFrames` CONSECUTIVE frames fall below the
 * VAD's current noise-floor threshold. The floor is read after EVERY pushed frame, exactly as
 * `pushFrameEnergy` leaves it, so the reading is of the detector's causal state and not of a floor
 * computed with hindsight.
 *
 * WHY THE SCORE IS A STEP FUNCTION, AND WHY THAT IS THE POINT. A silence-threshold VAD has no
 * probability: at a given silence duration it has either accumulated its endpoint or it has not.
 * `p_eot(d)` is therefore 0 until the commit frame fits inside the prefix and 1 afterwards, and the
 * policy sweep's threshold axis is degenerate for this group. That degeneracy is the honest shape of
 * the incumbent, and it is what makes its Pareto point a single point rather than a curve: the only
 * knob is `silence_duration_ms`, which moves the step, not the shape.
 *
 * WHAT "THE PREFIX ENDS AT d" MEANS FOR A `hold` SPAN. The prefix is the span's own audio, which for
 * a within-turn pause stops being silence at the pause's end (the speaker resumed). A commit that
 * would land after the resume is therefore NOT inside any prefix the grid walks — the grid's horizon
 * is capped at the pause — which reproduces group A's `commitFrame < resumeFrame` condition without
 * a special case.
 */

import { StreamingVad, thresholdsFor, FRAME_MS } from '../../../src/shared/voiceEndpoint.ts';

import type { BatchAdapter, BatchItem } from './protocol.mts';

/** The incumbent's endpoint: the same 400 ms the shipping default resolves to. */
export const VAD_ENDPOINT_MS = 400;

function frameEnergies(samples: Float32Array, rate: number, frame: number): number[] {
  const n = Math.floor(samples.length / frame);
  const out: number[] = [];
  for (let f = 0; f < n; f++) {
    let acc = 0;
    const from = f * frame;
    for (let i = 0; i < frame; i++) acc += samples[from + i] * samples[from + i];
    out.push(Math.sqrt(acc / frame));
  }
  return out;
}

/**
 * The VAD's commit frame for one causal prefix, scanning from the candidate point's OWN onset.
 *
 * Scanning from the onset and not from frame 0 is not an optimisation — a prefix for a `hold` span
 * contains every EARLIER pause of the same clip, and the first quiet run in it belongs to whichever
 * pause came first. Group A scans from `floor(onsetSample / frame)` for exactly this reason; the
 * onset is recovered here from the item's own `timestampMs - silenceDurMs` so the adapter stays a
 * pure `BatchItem → p_eot` function.
 *
 * Returns the frame index at which the detector declares the utterance over, or `Infinity` if the
 * prefix ends before it can. The scan looks for the first frame whose FORWARD quiet run reaches the
 * endpoint, rather than assuming the manifest's onset is also the detector's: the manifest's onset is
 * the first frame under the perceptual floor, which can still sit on a decay ramp the VAD itself has
 * not called quiet yet.
 */
export function vadCommitFrame(prefix: Float32Array, rate: number, onsetFrame: number): { commitFrame: number; endpointFrames: number; frame: number; quietStartFrame: number } {
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * rate));
  const energies = frameEnergies(prefix, rate, frame);
  const vad = new StreamingVad({ sampleRate: rate });
  const quiet: boolean[] = [];
  for (let i = 0; i < energies.length; i++) {
    vad.pushFrameEnergy(energies[i]);
    quiet.push(energies[i] < thresholdsFor(vad.noiseFloor).enter);
  }
  const forward = new Int32Array(quiet.length + 1);
  for (let i = quiet.length - 1; i >= 0; i--) forward[i] = quiet[i] ? forward[i + 1] + 1 : 0;
  const endpointFrames = Math.max(1, Math.round(((VAD_ENDPOINT_MS / 1000) * rate) / frame));
  const from = Math.min(quiet.length, Math.max(0, onsetFrame));
  for (let j = from; j < quiet.length; j++) {
    if (forward[j] >= endpointFrames) {
      return { commitFrame: j + endpointFrames, endpointFrames, frame, quietStartFrame: j };
    }
  }
  return { commitFrame: Number.POSITIVE_INFINITY, endpointFrames, frame, quietStartFrame: -1 };
}

/** Build the group-A batch adapter. `predictBatch` scores each item's own causal prefix. */
export function createVadBatchAdapter(): BatchAdapter {
  return {
    adapterId: 'vnpt-vad-400ms-batch',
    scorePoint: VAD_ENDPOINT_MS / 1000,
    predictBatch(items: BatchItem[]): Promise<number[]> {
      const scores = items.map((item) => {
        const frame = Math.max(1, Math.round((FRAME_MS / 1000) * item.sampleRate));
        // The candidate point's own onset, recovered from the item's grid coordinates.
        const onsetFrame = Math.floor(((item.timestampMs - item.silenceDurMs) / 1000) * item.sampleRate / frame);
        const { commitFrame } = vadCommitFrame(item.audio, item.sampleRate, onsetFrame);
        // The prefix carries `floor(prefixFrames)` whole frames; the commit has landed once the frame
        // one PAST the endpoint has been pushed — i.e. `commitFrame <= framesAvailable`.
        const framesAvailable = Math.floor(item.audio.length / frame);
        return commitFrame !== Number.POSITIVE_INFINITY && commitFrame <= framesAvailable ? 1 : 0;
      });
      return Promise.resolve(scores);
    },
  };
}
