/**
 * Group C adapter — LiveKit Turn Detector v1-mini. This adapter does NOT run the model.
 *
 * NOT A STUB AND NOT AN OVERSIGHT (AC3, DoD). The SPEC's group C is "attempt the same measurement;
 * if the licence terms or the input spec cannot be established inside P0, record an explicit
 * `blocked-by-license` / `deferred-spec-unclear` WITH the licence/source evidence — do not silently
 * skip and do not fabricate a number." This file is that record: it carries what P0 actually read,
 * with sources, and returns a status instead of a probability. The reader's job is to see WHY the
 * measurement was not taken, so the numbers for groups A/B are not mistaken for a full four-way
 * comparison.
 *
 * ── WHAT P0 ESTABLISHED (2026-10-11, sources below) ────────────────────────────────────────────
 *
 *   0. NAMING — "LiveKit Turn Detector" is TWO products and only one is in scope. The audio-native
 *      v1 line lives in `livekit-agents/livekit/agents/inference/eot/` with a model id
 *      `turn-detector-v1` (LiveKit Cloud, server-side) and a local `turn-detector-v1-mini`; THIS
 *      adapter is about `turn-detector-v1-mini`. The older `livekit-plugins-turn-detector`
 *      (`MultilingualModel`/`EnglishModel`, HF `livekit/turn-detector`, `model_q8.onnx`) reads TEXT
 *      TOKENS (int64 `input_ids`, `MAX_HISTORY_TOKENS = 128`, `MAX_HISTORY_TURNS = 6`) — it has no
 *      sample rate, is deprecated, and is NOT group C.
 *
 *   1. LICENCE — the weights are under the "LiveKit Model License Agreement 2024" (title verbatim;
 *      "Last Updated: November 25, 2024"), a PROPRIETARY licence (SPDX
 *      `LicenseRef-scancode-livekit-model-2024`, category "Proprietary Free"), NOT OSI open source.
 *      Its grant is framework-locked: "you may use these LiveKit models freely but can only use them
 *      together with the LiveKit Agents framework", and the restrictions include "not to use any
 *      LiveKit Models on a standalone basis or with any frameworks other than LiveKit Agents". The
 *      plugin CODE is Apache-2.0 (repo `LICENSE` is verbatim Apache-2.0), but the MODEL FILES ship
 *      under this licence — LiveKit's own docs state the LiveKit Model License is "used for the text
 *      turn detector and the `v1-mini` model", and the native package `livekit-local-inference` is
 *      dual-licenced "Apache-2.0 AND LicenseRef-LiveKit-Model".
 *      → THIS HARNESS IS A STANDALONE Node/TS process, not the LiveKit Agents framework. Running
 *        v1-mini here is exactly the "standalone basis" the licence withholds. So group C is
 *        `blocked-by-license` for this repository and must not be run without a licence decision
 *        that this P0 task is not authorised to make (SPEC 边界/不做: 不绕过许可证).
 *
 *   2. INPUT SPEC — even setting the licence aside, the audio-native v1 input is not reproducible
 *      from public sources: the v1 module is transport/orchestration only, so feature extraction and
 *      the weights live behind `livekit.local_inference` (a NATIVE package built from the PRIVATE
 *      repo `livekit/agents-private`), and the only published constants are `DEFAULT_SAMPLE_RATE =
 *      16000`, `MIN_SILENCE_DURATION_MS = 200` and a 1.2 s client-side PCM buffer — no `n_fft` /
 *      hop / window length / log-mel recipe, and the internal feature type (raw PCM vs log-mel) is
 *      unpublished. The weights are also NOT on Hugging Face: there is no public
 *      `turn-detector-v1-mini` repo; the files are fetched by the SDK (`download-files` →
 *      `HF_HUB_CACHE`) and bundled with `livekit-local-inference`. (The public `livekit/turn-detector`
 *      HF repo — 165 MB `model_quantized.onnx` + tokenizer, tagged text-classification, base
 *      `Qwen/Qwen2.5-0.5B-Instruct` — is the DEPRECATED v0.x TEXT model above, not this one.)
 *      → so group C is ALSO `deferred-spec-unclear`: a local rerun could not be reproduced from
 *        public sources even if the licence allowed it, without reading the opaque native wrapper,
 *        which is what "deferred" records.
 *
 * Both findings point the same way, so the status is `blocked-by-license` (the harder blocker — a
 * licence cannot be resolved by reading more source) with `deferred-spec-unclear` recorded as the
 * second, independent reason and the spec evidence attached.
 *
 * FOR THE RECORD (not a measured number, recorded only so a later task starts informed): LiveKit
 * documents the audio detector's 14 languages as `ar, de, en, es, fr, hi, id, it, ja, ko, nl, pt, tr,
 * zh` (Chinese included), with per-language thresholds in the SDK's `inference/eot/languages.py`.
 *
 * Sources read 2026-10-11:
 *   · https://raw.githubusercontent.com/livekit/agents/main/MODEL_LICENSE  (title + "Last Updated")
 *   · https://raw.githubusercontent.com/livekit/agents/main/LICENSE  (Apache-2.0, the plugin code)
 *   · https://scancode-licensedb.aboutcode.org/livekit-model-2024.html  (SPDX record: Proprietary Free)
 *   · https://huggingface.co/livekit/turn-detector  + /raw/main/LICENSE  (LICENSE = LiveKit Model License; repo is the v0.x text model; HF API `gated:false`)
 *   · https://docs.livekit.io/agents/logic/turns/turn-detector/  (14 languages; model files under the LiveKit Model License, code Apache-2.0)
 *   · https://livekit.com/blog/solving-end-of-turn-detection  (v1 is audio-native; v1-mini is the CPU/pruned local variant)
 *   · https://raw.githubusercontent.com/livekit/agents/main/livekit-agents/livekit/agents/inference/eot/{base,transports,languages}.py  (16 kHz, 200 ms, 1.2 s buffer, `from livekit.local_inference import EOT`)
 *   · https://pypi.org/project/livekit-local-inference/  (dual licence "Apache-2.0 AND LicenseRef-LiveKit-Model")
 *   · livekit/agents `livekit-plugins/livekit-plugins-turn-detector` (text model: `model_q8.onnx`, int64 input_ids — not group C)
 */

/** The reading group C contributes to RESULT.json — a status with its evidence, never a number. */
export type LiveKitFinding = {
  group: 'C';
  detector: 'LiveKit Turn Detector v1-mini (audio-native, local CPU)';
  status: 'blocked-by-license' | 'deferred-spec-unclear' | 'measured';
  primaryBlocker: 'licence' | 'none';
  secondaryBlocker: 'input-spec-unpublished';
  measured: false;
  falseCutoffRate: null;
  missedEndpointRate: null;
  latencyP50Ms: null;
  latencyP90Ms: null;
  cpuMsPerDecision: null;
  extraModelCostCny: null;
  licence: {
    name: string;
    lastUpdated: string;
    spdx: string;
    category: string;
    osiApproved: false;
    codeLicence: 'Apache-2.0';
    weightsLicenceMatches: string;
    docsStatement: string;
    distributionLicence: string;
    frameworkLockClause: string;
    standaloneClause: string;
    consequence: string;
  };
  inputSpec: {
    reproducibleFromPublicSources: false;
    defaultSampleRateHz: 16000;
    minSilenceDurationMs: 200;
    clientBufferSeconds: number;
    publishedFeatureRecipe: false;
    internalFeatureTypeUnpublished: true;
    weightsOnHuggingFace: false;
    nativePackage: string;
    privateBuildRepo: string;
    publicTextModelRepo: string;
    note: string;
  };
  modelIds: { cloud: string; local: string; note: string };
  languageCoverage: { count: number; languages: string[]; source: string; caveat: string };
  sources: string[];
  ifUnblocked: string;
};

/** The clauses quoted above, kept as data so the reader sees the exact wording rather than a paraphrase. */
const LICENCE_CLAUSES = {
  frameworkLockClause: 'you may use these LiveKit models freely but can only use them together with the LiveKit Agents framework',
  standaloneClause: 'not to use any LiveKit Models on a standalone basis or with any frameworks other than LiveKit Agents',
} as const;

export function evaluateLiveKit(): LiveKitFinding {
  return {
    group: 'C',
    detector: 'LiveKit Turn Detector v1-mini (audio-native, local CPU)',
    status: 'blocked-by-license',
    primaryBlocker: 'licence',
    secondaryBlocker: 'input-spec-unpublished',
    measured: false,
    falseCutoffRate: null,
    missedEndpointRate: null,
    latencyP50Ms: null,
    latencyP90Ms: null,
    cpuMsPerDecision: null,
    extraModelCostCny: null,
    licence: {
      name: 'LiveKit Model License Agreement 2024',
      lastUpdated: 'November 25, 2024',
      spdx: 'LicenseRef-scancode-livekit-model-2024',
      category: 'Proprietary Free (not OSI open source)',
      osiApproved: false,
      codeLicence: 'Apache-2.0',
      weightsLicenceMatches: 'LiveKit Model License (model files, distinct from the Apache-2.0 plugin code)',
      docsStatement: 'LiveKit docs: the LiveKit Model License is "used for the text turn detector and the `v1-mini` model"',
      distributionLicence: 'the native package livekit-local-inference is dual-licenced "Apache-2.0 AND LicenseRef-LiveKit-Model"',
      frameworkLockClause: LICENCE_CLAUSES.frameworkLockClause,
      standaloneClause: LICENCE_CLAUSES.standaloneClause,
      consequence:
        'this harness is a standalone Node/TS process, not the LiveKit Agents framework, so running v1-mini here is the "standalone basis" the licence withholds; P0 does not have authority to accept or reinterpret these terms (SPEC 边界: 不绕过许可证)',
    },
    inputSpec: {
      reproducibleFromPublicSources: false,
      defaultSampleRateHz: 16000,
      minSilenceDurationMs: 200,
      clientBufferSeconds: 1.2,
      publishedFeatureRecipe: false,
      internalFeatureTypeUnpublished: true,
      weightsOnHuggingFace: false,
      nativePackage: 'livekit-local-inference (the EOT wrapper the SDK calls as `from livekit.local_inference import EOT`)',
      privateBuildRepo: 'livekit/agents-private (the native package is built from a private repo, so its featurisation cannot be read publicly)',
      publicTextModelRepo: 'livekit/turn-detector — the DEPRECATED v0.x TEXT model (model_q8.onnx + tokenizer, int64 input_ids), NOT the audio v1-mini',
      note:
        'the audio-native v1 weights ship inside the Agents SDKs / the native package, and feature extraction is behind `livekit.local_inference`; only DEFAULT_SAMPLE_RATE=16000, MIN_SILENCE_DURATION_MS=200 and a 1.2 s client PCM buffer are published, and the internal feature type (raw PCM vs log-mel) is not — a local rerun could not be reproduced from public sources without reading the opaque native wrapper',
    },
    modelIds: {
      cloud: 'turn-detector-v1',
      local: 'turn-detector-v1-mini',
      note: 'the full id runs via LiveKit Inference (Cloud, server-side); the local fallback that ships in the SDK is the mini',
    },
    languageCoverage: {
      count: 14,
      languages: ['ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pt', 'tr', 'zh'],
      source: 'LiveKit docs (turn detector page) cross-checked against the SDK `inference/eot/languages.py` threshold table',
      caveat: 'NOT MEASURED HERE — recorded as documented coverage only; the SPEC G6 asks whether v1-mini equals v1 on zh/en code-mixing, and that remains unanswered because the model was not run',
    },
    sources: [
      'https://raw.githubusercontent.com/livekit/agents/main/MODEL_LICENSE',
      'https://raw.githubusercontent.com/livekit/agents/main/LICENSE',
      'https://huggingface.co/livekit/turn-detector',
      'https://scancode-licensedb.aboutcode.org/livekit-model-2024.html',
      'https://livekit.com/blog/solving-end-of-turn-detection',
      'https://docs.livekit.io/agents/logic/turns/turn-detector/',
      'https://pypi.org/project/livekit-local-inference/',
      'https://github.com/livekit/agents/tree/main/livekit-agents/livekit/agents/inference/eot',
    ],
    ifUnblocked:
      'a later task with an explicit licence decision could re-run this adapter against the same manifest; the reading definitions (false-cutoff / missed-endpoint / latency p50·p90 / CPU) are already fixed by run.mts, so the harness itself would not change',
  };
}
