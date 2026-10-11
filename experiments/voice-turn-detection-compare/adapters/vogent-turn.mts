/**
 * Candidate adapter — Vogent Turn (`vogent/Vogent-Turn-80M`). Records the licence evidence and the
 * gated-weights blocker; does NOT run the model.
 *
 * WHAT IT WOULD BE. An independent audio-in / END-CONTINUE-out turn detector: a Whisper-Tiny
 * (≤8 s @ 16 kHz) encoder feeding a SmolLM2-135M-derived head, exported as `WhisperSmolLMClassifier`
 * (~80M params). It is NOT a transcription source and NOT a replacement input for Qwen — see
 * "THE TEXT-BRANCH RULE" below.
 *
 * ── WHAT WAS READ (2026-10-11, primary sources; URLs at the bottom) ────────────────────────────
 *
 *   1. CODE LICENCE — Apache-2.0. `vogent/vogent-turn`'s `LICENSE` is verbatim Apache License 2.0.
 *
 *   2. WEIGHTS LICENCE — NOT plain Apache-2.0, and the licence FILE itself is gated. The repository
 *      README says, in its own words:
 *
 *        "Inference code is open-source under Apache 2.0. Model weights are under a modified
 *         Apache 2.0 license with stricter attribution requirements for certain types of usage."
 *
 *      The HF model `vogent/Vogent-Turn-80M` is gated (`gated: "auto"`), so its `LICENSE` file is
 *      NOT publicly readable — a direct fetch returns HTTP 401 "You must have access to it and be
 *      authenticated". This artifact therefore records the licence as the README's words plus the
 *      ONE clause that IS public: the gate's own acceptance prompt (`cardData.extra_gated_prompt`),
 *      quoted verbatim below. It does NOT claim to have read the full modified-Apache text, because
 *      it could not (that is the honest form of the AC2/AC3 discipline: cite the primary source you
 *      actually reached, and say when a source is unreachable).
 *
 *      THE HORIZONTAL-PLATFORM CLAUSE (verbatim, from the public model card's gating prompt):
 *
 *        "If you are using this model as part of a horizontal voice agent platform, you agree *not*
 *         to set Vogent-Turn-80M as a default option, and to require users to select an option
 *         labeled 'Vogent Turn Detector' if they would like to use the model."
 *
 *      This is the clause the task asked to be recorded verbatim. It is a DISTRIBUTION/USAGE term,
 *      not a benchmark term: it binds anyone shipping Vogent-Turn-80M inside a voice-agent product.
 *
 *   3. DOWNLOAD BLOCKER — the weights are gated (`gated: "auto"`; files `model.safetensors`,
 *      `onnx-fp16/…`, `onnx-fp32/…`, and a `LICENSE` all 401 to an unauthenticated fetch). Downloading
 *      them means accepting the gate's terms with a Hugging Face account, which is a licence decision
 *      (accepting the modified-Apache terms) this task does not make on the user's behalf. So the
 *      weights were NOT downloaded and the model was NOT run.
 *
 *   4. RUNTIME — absent, a second independent reason. The published checkpoint is safetensors / ONNX,
 *      but the published reference inference code is Python and the environment here has neither
 *      torch nor transformers (only numpy 2.5.3). Feeding the ONNX with onnxruntime-web would still
 *      leave the Whisper-Tiny mel front-end to reproduce — a materially bigger job than group B's,
 *      because this model couples an encoder and a decoder-side head.
 *
 * ── THE TEXT-BRANCH RULE (SPEC 边界: 不得拿它内部的 ASR/文本分支输出替代主 Qwen 音频推理) ────────
 * Vogent-Turn-80M is measured ONLY as an independent detector — audio in, END/CONTINUE out. Its
 * internal text/tokeniser branch must never be piped into Qwen as a transcript substitute. This run
 * produced no Vogent output at all (the weights are gated), so nothing derived from Vogent reached
 * Qwen — a structural fact, not merely an avoided one. The harness contains no code path that could
 * route Vogent output anywhere: the adapter returns a finding object, not audio or text.
 *
 * Sources read 2026-10-11:
 *   · https://raw.githubusercontent.com/vogent/vogent-turn/main/LICENSE          (verbatim Apache-2.0)
 *   · https://raw.githubusercontent.com/vogent/vogent-turn/main/README.md         ("modified Apache 2.0"; Mono input)
 *   · https://huggingface.co/api/models/vogent/Vogent-Turn-80M                   (gated:"auto"; cardData.extra_gated_prompt; WhisperSmolLMClassifier; 79,224,576 params)
 *   · https://huggingface.co/vogent/Vogent-Turn-80M/raw/main/LICENSE             (HTTP 401 — gated, NOT readable)
 */

export type VogentFinding = {
  candidate: 'Vogent Turn (vogent/Vogent-Turn-80M)';
  status: 'deferred-gated-weights';
  primaryBlocker: 'gated-weights';
  secondaryBlocker: 'runtime-unavailable';
  /** Never a number here: the model was not run. */
  measured: false;
  falseCutoffRate: null;
  missedEndpointRate: null;
  latencyP50Ms: null;
  latencyP90Ms: null;
  cpuMsPerDecision: null;
  extraModelCostCny: null;
  codeLicence: { spdx: 'Apache-2.0'; source: string };
  weightsLicence: {
    /** The README's own words; the full file could not be read (gated). */
    statement: string;
    source: string;
    fullTextReadable: false;
    fullTextFetchResult: string;
    horizontalPlatformClause: string;
    /** True: the clause is the one the task asked to be recorded verbatim, and it IS public. */
    clauseIsVerbatim: true;
    clauseMeans: string;
  };
  downloadState: {
    downloaded: false;
    why: string;
    gated: 'auto';
    filesNotFetched: string[];
  };
  runtime: { available: false; reason: string; checkpointFormat: string };
  modelCard: {
    architecture: string;
    parameters: number;
    parametersApprox: string;
    inputChannels: string;
    inputSpec: string;
  };
  textBranchRule: { rule: string; satisfiedHow: string };
  sources: string[];
  ifUnblocked: string;
};

/** Kept as data so the reader sees the exact accepted wording, not a paraphrase. */
export const VOGENT_HORIZONTAL_PLATFORM_CLAUSE =
  'If you are using this model as part of a horizontal voice agent platform, you agree *not* to set ' +
  "Vogent-Turn-80M as a default option, and to require users to select an option labeled 'Vogent " +
  "Turn Detector' if they would like to use the model.";

export function evaluateVogent(): VogentFinding {
  return {
    candidate: 'Vogent Turn (vogent/Vogent-Turn-80M)',
    status: 'deferred-gated-weights',
    primaryBlocker: 'gated-weights',
    secondaryBlocker: 'runtime-unavailable',
    measured: false,
    falseCutoffRate: null,
    missedEndpointRate: null,
    latencyP50Ms: null,
    latencyP90Ms: null,
    cpuMsPerDecision: null,
    extraModelCostCny: null,
    codeLicence: {
      spdx: 'Apache-2.0',
      source: 'https://raw.githubusercontent.com/vogent/vogent-turn/main/LICENSE (verbatim Apache License 2.0, HTTP 200)',
    },
    weightsLicence: {
      statement:
        'Inference code is open-source under Apache 2.0. Model weights are under a modified Apache 2.0 license with stricter attribution requirements for certain types of usage.',
      source: 'https://raw.githubusercontent.com/vogent/vogent-turn/main/README.md §License (verbatim)',
      fullTextReadable: false,
      fullTextFetchResult:
        'https://huggingface.co/vogent/Vogent-Turn-80M/raw/main/LICENSE → HTTP 401 "Access to model vogent/Vogent-Turn-80M is restricted. You must have access to it and be authenticated" (the model is gated:"auto"), so the full modified-Apache text was NOT read',
      horizontalPlatformClause: VOGENT_HORIZONTAL_PLATFORM_CLAUSE,
      clauseIsVerbatim: true,
      clauseMeans:
        'a distribution/usage term, not a benchmark term: it binds anyone who ships Vogent-Turn-80M inside a horizontal voice-agent product. It does not by itself block an offline, non-distributed evaluation — the blocker here is the GATE (the weights cannot be fetched without authenticating and accepting this licence), not the clause.',
    },
    downloadState: {
      downloaded: false,
      why:
        'accepting a gated model\'s licence is a decision for the user, not for this task; P0.5 does not authenticate to Hugging Face or accept the modified-Apache terms on the user\'s behalf, so the weights were not fetched and the model was not run',
      gated: 'auto',
      filesNotFetched: ['model.safetensors', 'onnx-fp16/whisper-smol-lm-smaller-fp16.onnx', 'onnx-fp32/whisper-smol-lm-smaller.onnx', 'README.md', 'LICENSE'],
    },
    runtime: {
      available: false,
      reason:
        'the reference inference code is Python (torch + transformers) and this environment has neither (only numpy 2.5.3). Re-driving the ONNX export would still require reproducing the Whisper-Tiny mel front-end AND the decoder-side head — a bigger reproduction than group B\'s single-encoder path.',
      checkpointFormat: 'safetensors + ONNX (fp16/fp32)',
    },
    modelCard: {
      architecture: 'WhisperSmolLMClassifier (Whisper-Tiny encoder + SmolLM2-135M-derived head)',
      parameters: 79224576,
      parametersApprox: '~80M',
      inputChannels: 'Mono',
      inputSpec: 'np.ndarray (n_samples,) mono float32; README: Channels = Mono',
    },
    textBranchRule: {
      rule: 'Vogent-Turn-80M is measured ONLY as an independent detector (audio in, END/CONTINUE out); its internal text branch must never be piped to Qwen as a transcript substitute (SPEC 边界).',
      satisfiedHow:
        'the weights are gated, so no Vogent output exists in this run at all — nothing derived from Vogent could reach Qwen. Structurally, this adapter returns a finding object (no audio, no text), and the harness has no code path that routes Vogent output anywhere else.',
    },
    sources: [
      'https://raw.githubusercontent.com/vogent/vogent-turn/main/LICENSE',
      'https://raw.githubusercontent.com/vogent/vogent-turn/main/README.md',
      'https://huggingface.co/api/models/vogent/Vogent-Turn-80M',
      'https://huggingface.co/vogent/Vogent-Turn-80M/raw/main/LICENSE (HTTP 401)',
    ],
    ifUnblocked:
      'a later task, with the user\'s explicit acceptance of the gated modified-Apache terms and a torch/transformers runtime, could fetch the weights and re-run this adapter against the same manifest; the reading definitions are already fixed by run.mts, so the harness would not change',
  };
}
