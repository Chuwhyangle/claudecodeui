/**
 * Candidate adapter — MaAI (MaAI-Kyoto/MaAI) VAP single-channel turn-taking. Like the LiveKit
 * adapter, this one does NOT run the model; it records what was verified from primary sources and
 * returns a status instead of a number.
 *
 * NOT A STUB. The task asks MaAI to be the FIRST new candidate ("首选新增候选") and then asks, in the
 * same breath, to verify the weights, the licence and the single-channel behaviour BEFORE deciding
 * whether it can run in an isolated harness. The verification came back negative on two independent
 * grounds, and this file is that record — so a reader sees WHY there is no MaAI row of numbers, and
 * does not mistake the absence for an oversight.
 *
 * ── WHAT WAS READ (2026-10-11, primary sources; URLs at the bottom) ────────────────────────────
 *
 *   1. CODE LICENCE — MIT. `MaAI-Kyoto/MaAI`'s `LICENSE` is verbatim MIT, "Copyright (c) 2025 MaAI
 *      Development Team". The repository README states the same and then hands the MODELS to a
 *      different licence:
 *
 *        "The source code in this repository is licensed under the MIT License. For the trained
 *         models, please follow the license described in the README of each model or on Hugging
 *         Face repository."
 *
 *   2. WEIGHTS LICENCE — NOT MIT, and NOT uniform. The MaAI Hugging Face org (`maai-kyoto`) carries
 *      per-repo licences that split sharply by language and variant:
 *        · `maai-kyoto/vap_ch`, `vap_en`, `vap_jp`, `vap_ca`, `vap_fr` …  → `cc-by-nc-nd-4.0`
 *        · `maai-kyoto/vap_*_kyoto` (Japanese-only fine-tunes), `vap_bc_*`, `vap_nod_jp`,
 *          `vap_prompt_jp`                                             → `license:mit`
 *      The CHINESE single-channel weights we would need live in `maai-kyoto/vap_ch`, whose card
 *      `cardData.license` is **`cc-by-nc-nd-4.0`** — and whose file list really does carry the
 *      single-channel (`vap_mono_*`) state dicts:
 *        `vap_mono_state_dict_ch_{5,10,20,50}hz_20000msec.pt`,
 *        `vap_mono_mimi_state_dict_ch_12.5hz_20000msec.pt`,
 *        `vap_mono_mc_mimi_state_dict_ch_12.5hz_20000msec.pt`.
 *      CC-BY-NC-ND-4.0 is NonCommercial **and** NoDerivatives: it cannot be shipped inside a product
 *      and it cannot be fine-tuned or redistributed as a derivative. Whether even an INTERNAL,
 *      non-commercial evaluation is covered is a legal reading this task is not authorised to make
 *      (the same discipline the SPEC applied to the LiveKit licence).
 *
 *   3. THE MODE IS DEPRECATED. The task's premise was a 2026-08-30 `vap_mono` single-channel mode.
 *      The README now says the opposite — the named modes were folded into one automatic selector:
 *
 *        "`mode="vap"` now selects the noise-robust (`mc=True`, default) and single-channel (when
 *         `audio_ch2` is omitted) VAP models automatically; `vap_mc`, `vap_mono` and `vap_mc_mono`
 *         are deprecated"
 *
 *      So `vap_mono` is not a live API surface; single-channel behaviour is now reached by omitting
 *      `audio_ch2`. (The example scripts under `example/vap_mono/` and the `vap_mono_*` weight files
 *      remain — the deprecation is of the MODE NAME, not of the capability.)
 *
 *   4. RUNTIME — absent, and this is a second, independent blocker. The weights are PyTorch
 *      `state_dict` `.pt` files, and this environment has no `torch` (checked: only numpy 2.5.3 is
 *      installed). There is no ONNX export of the VAP mono weights in the repo. So even if the
 *      licence were permissive, an offline rerun here would need a new heavy dependency installed
 *      into the harness — out of scope for a task whose 边界 forbid touching production deps.
 *
 * Both grounds point the same way, so the status is `blocked-by-license` (the harder blocker, and
 * the one a later task cannot fix by installing anything) with the missing runtime recorded as the
 * second, independent reason.
 *
 * FOR THE RECORD (documented capability, NOT measured — recorded so a later task starts informed):
 * the README advertises CPU-only operation ("operates efficiently, even exclusively on CPU hardware")
 * and English/Chinese/Japanese support; the task's own reading also found no CPU benchmark number
 * published by MaAI, so there is no latency figure to cite even as a secondary source.
 *
 * Sources read 2026-10-11:
 *   · https://raw.githubusercontent.com/MaAI-Kyoto/MaAI/main/LICENSE                (verbatim MIT)
 *   · https://raw.githubusercontent.com/MaAI-Kyoto/MaAI/main/README.md               (code-vs-model licence split; vap_mono deprecation; CPU claim)
 *   · https://huggingface.co/api/models/maai-kyoto/vap_ch                            (cardData.license = cc-by-nc-nd-4.0; vap_mono_* files)
 *   · https://huggingface.co/api/models?author=maai-kyoto                            (per-repo licence split across the org)
 *   · https://maai-kyoto.github.io/MaAI/                                             (single-channel VAP description — cited by the task)
 */

export type MaaiFinding = {
  candidate: 'MaAI (MaAI-Kyoto) VAP single-channel';
  status: 'blocked-by-license';
  primaryBlocker: 'licence';
  secondaryBlocker: 'runtime-unavailable';
  /** Never a number here: the model was not run. */
  measured: false;
  falseCutoffRate: null;
  missedEndpointRate: null;
  latencyP50Ms: null;
  latencyP90Ms: null;
  cpuMsPerDecision: null;
  extraModelCostCny: null;
  codeLicence: {
    spdx: 'MIT';
    holder: string;
    source: string;
    verbatimHead: string;
  };
  weightsLicence: {
    /** The Chinese single-channel weights — the ones this task would need. */
    repo: string;
    spdx: string;
    category: string;
    permissiveForProduct: false;
    whyBlocked: string;
    fileEvidence: string[];
    orgLicenceSplit: string;
    source: string;
  };
  modeDeprecation: {
    /** The task premise ("vap_mono mode added 2026-08-30") is now superseded by the README. */
    statement: string;
    consequence: string;
  };
  runtime: {
    available: false;
    reason: string;
    weightsFormat: string;
    onnxExportAvailable: boolean;
  };
  documentedCapability: { cpuOnly: true; languages: string[]; publishedCpuBenchmark: false; note: string };
  sources: string[];
  ifUnblocked: string;
};

export function evaluateMaai(): MaaiFinding {
  return {
    candidate: 'MaAI (MaAI-Kyoto) VAP single-channel',
    status: 'blocked-by-license',
    primaryBlocker: 'licence',
    secondaryBlocker: 'runtime-unavailable',
    measured: false,
    falseCutoffRate: null,
    missedEndpointRate: null,
    latencyP50Ms: null,
    latencyP90Ms: null,
    cpuMsPerDecision: null,
    extraModelCostCny: null,
    codeLicence: {
      spdx: 'MIT',
      holder: 'Copyright (c) 2025 MaAI Development Team',
      source: 'https://raw.githubusercontent.com/MaAI-Kyoto/MaAI/main/LICENSE (verbatim MIT text, HTTP 200)',
      verbatimHead: 'MIT License\n\nCopyright (c) 2025 MaAI Development Team',
    },
    weightsLicence: {
      repo: 'maai-kyoto/vap_ch',
      spdx: 'CC-BY-NC-ND-4.0',
      category: 'Creative Commons NonCommercial-NoDerivatives (not OSI open source; no commercial use, no derivatives)',
      permissiveForProduct: false,
      whyBlocked:
        'the CHINESE single-channel weights live in maai-kyoto/vap_ch, whose HF cardData.license is "cc-by-nc-nd-4.0" — NonCommercial and NoDerivatives. The repo code is MIT, but the README explicitly delegates the models to their own licence. Shipping these weights in a product is barred, and even an internal evaluation needs a legal reading this task is not authorised to make (the same discipline the SPEC applied to the LiveKit licence).',
      fileEvidence: [
        'vap_mono_state_dict_ch_5hz_20000msec.pt',
        'vap_mono_state_dict_ch_10hz_20000msec.pt',
        'vap_mono_state_dict_ch_20hz_20000msec.pt',
        'vap_mono_state_dict_ch_50hz_20000msec.pt',
        'vap_mono_mimi_state_dict_ch_12.5hz_20000msec.pt',
        'vap_mono_mc_mimi_state_dict_ch_12.5hz_20000msec.pt',
      ],
      orgLicenceSplit:
        'the maai-kyoto org is NOT uniformly licensed: the base language models (vap_ch/vap_en/vap_jp/vap_ca/vap_fr) are cc-by-nc-nd-4.0, while the Japanese `*_kyoto` fine-tunes, the `vap_bc_*` backchannel models, `vap_nod_jp` and `vap_prompt_jp` are MIT. So "MaAI is MIT" (true of the CODE) is the wrong licence to quote for the Chinese model weights.',
      source: 'https://huggingface.co/api/models/maai-kyoto/vap_ch (cardData.license) + https://huggingface.co/api/models?author=maai-kyoto',
    },
    modeDeprecation: {
      statement:
        'README: `mode="vap"` now selects the noise-robust (`mc=True`, default) and single-channel (when `audio_ch2` is omitted) VAP models automatically; `vap_mc`, `vap_mono` and `vap_mc_mono` are deprecated',
      consequence:
        'the task premise (a 2026-08-30 `vap_mono` mode) is superseded: single-channel behaviour is now reached by omitting `audio_ch2` under `mode="vap"`, not by naming a `vap_mono` mode. The `vap_mono_*` weight files still exist, so the capability is real — only the mode NAME is deprecated.',
    },
    runtime: {
      available: false,
      reason:
        'the VAP weights are PyTorch state_dict `.pt` files and this environment has no torch (checked: numpy 2.5.3 only). Installing torch/transformers into the harness is out of scope for this task (边界: 不接入运行时/生产依赖).',
      weightsFormat: 'PyTorch state_dict (.pt)',
      onnxExportAvailable: false,
    },
    documentedCapability: {
      cpuOnly: true,
      languages: ['en', 'zh', 'ja'],
      publishedCpuBenchmark: false,
      note:
        'NOT MEASURED. README: "MaAI operates efficiently, even exclusively on CPU hardware"; language support for English/Chinese/Japanese is advertised. No CPU latency benchmark is published by MaAI, so there is no secondary figure to cite either.',
    },
    sources: [
      'https://raw.githubusercontent.com/MaAI-Kyoto/MaAI/main/LICENSE',
      'https://raw.githubusercontent.com/MaAI-Kyoto/MaAI/main/README.md',
      'https://huggingface.co/api/models/maai-kyoto/vap_ch',
      'https://huggingface.co/api/models?author=maai-kyoto',
      'https://maai-kyoto.github.io/MaAI/',
    ],
    ifUnblocked:
      'a later task with (a) an explicit licence decision on CC-BY-NC-ND-4.0 for this use and (b) torch available in an isolated environment could re-run this adapter against the same manifest; the reading definitions (false-cutoff / missed-endpoint / latency p50·p90 / CPU) are already fixed by run.mts, so the harness itself would not change',
  };
}
