/**
 * ── P0.6 UPDATE (2026-10-11, task gap-voice-turn-detection-p0-6-dataset-benchmark) ────────────
 * READ THIS FIRST. Everything below is the P0 / P0.5 record, retained verbatim as evidence of what
 * those phases read and concluded. P0.6 re-read the SAME licence text ("Last Updated: November 25,
 * 2024") and reached the opposite ROUTE — not a different text. Section 3.b(i) withholds use on a
 * "standalone basis"; P0/P0.5 (a standalone Node/TS harness) were therefore correct to stop. P0.6
 * instead drives v1-mini INSIDE the official `livekit-agents` framework
 * (`livekit-sandbox/run_livekit_eot.py`, `inference.TurnDetector(version="v1-mini")`), which is the
 * exact use the licence grants. Group C is consequently MEASURED in P0.6 — `status: "measured"`,
 * 65 points — see `RESULT.json.groupC` and `.groupC.licenceReverification` (field `changeFromP05`).
 * This adapter now supplies only the licence / input-spec / source EVIDENCE to `run.mts`; it no
 * longer decides the status. The "both findings point the same way" conclusion below is the P0/P0.5
 * one and is superseded by the P0.6 route change.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
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
 * ── P0.5 UPGRADE: FROM FOOTNOTE TO "DESIGNED, AUTHORIZATION-BLOCKED" CONTROL GROUP (AC12) ───────
 *
 * The follow-up instruction is to promote group C from a footnote to a FORMAL control group measured
 * on the same manifest, the same reading definitions and the same six-metric schema as groups A/B —
 * PROVISIONED but not executed, because the licence is a hard block. This section is that upgrade's
 * evidence and its readiness design. Nothing was downloaded; no inference code was added; the adapter
 * remains a pure documentation + blocked-status module.
 *
 *   1. SECTION 3(i) — THE INDEPENDENT HARNESS IS THE NAMED PROHIBITION. The licence's "Limitation on
 *      Use" clause (Section 3) reads, verbatim:
 *
 *        "(i) not to use any LiveKit Models on a standalone basis or with any frameworks other than
 *         LiveKit Agents"
 *
 *      Section 1 adds the same point in plain English: "You cannot use the LiveKit models on a
 *      standalone basis or with any other frameworks." This repository's harness is a standalone
 *      Node/TS process — not the LiveKit Agents framework — so running v1-mini here is precisely the
 *      "standalone basis" the licence withholds. Section 3(i) bars the benchmark on its face; it is
 *      not a grey area that more reading would resolve.
 *
 *   2. SECTION 3(ii) — A SECOND, INDEPENDENT RISK THAT SURVIVES EVEN A FRAMEWORK-COMPLIANT RUN. The
 *      same clause continues, verbatim:
 *
 *        "(ii) not to use any LiveKit Materials or any output from, or results of using, LiveKit
 *         Models (including any derivative works thereof) to improve or otherwise develop any other
 *         models that are not LiveKit Models"
 *
 *      This is the clause a reader is most likely to miss. Even a run wrapped INSIDE a real
 *      `livekit-agents` + `livekit-plugins-turn-detector` pipeline (which would satisfy 3(i)) would
 *      still produce comparison readings whose USE — deciding, for this product, between Smart Turn,
 *      MaAI and LiveKit — is what 3(ii) constrains. Whether that decision-making is "to improve or
 *      otherwise develop any other models" is a LEGAL INTERPRETATION, not an engineering question;
 *      this task does not resolve it and must not be read as having resolved it. The two clauses
 *      block two different things, and fixing one does not fix the other.
 *
 *   3. NO EXEMPTION, NO CONTACT — VERIFIED, NOT ASSUMED. The full text of the LiveKit Model License
 *      Agreement (Last Updated: November 25, 2024 — the same version P0 read; HTTP 200 on
 *      2026-10-11, no newer revision) was read end to end (§1 Introduction, §2 Definitions, §3
 *      License Rights [Right to Use + Limitation on Use], §4 IP, §5 Disclaimer, §6 Liability, §7
 *      Trademarks, §8 Term and Termination, §9 Governing Law and Venue). It contains:
 *        · NO benchmark, evaluation, research or academic exemption of any kind; and
 *        · NO contact address, form or procedure for requesting different or broader permission
 *          (the only route to a different licence is LiveKit's ordinary business/sales channel,
 *          which the licence file does not name).
 *      So there is nothing inside the licence to appeal to, and nothing to point at that would let
 *      this harness proceed. That is why the status is a hard block rather than "unclear".
 *
 *   4. UPGRADE PATH — FOR THE USER, NOT FOR THIS WORKER. The worker cannot contact LiveKit or make a
 *      legal commitment on the user's behalf. Three escalating options, in the order a maintainer
 *      should consider them (see `upgradePath` in the returned finding for the same list as data):
 *
 *        (a) WRITTEN AUTHORIZATION, BOTH POINTS. Through LiveKit's ordinary contact channel
 *            (https://livekit.io/contact — the licence file names no other address), request written
 *            confirmation of TWO things: (a1) using v1-mini outside the LiveKit Agents framework for
 *            benchmarking, AND (a2) using the comparison results to select between non-LiveKit
 *            detectors for this product. BOTH must be confirmed in writing; (a1) alone does not
 *            clear Section 3(ii).
 *        (b) FRAMEWORK-COMPLIANT RUN — LOW FRICTION, RESIDUAL RISK. Build the benchmark inside a
 *            real `livekit-agents` + `livekit-plugins-turn-detector` pipeline, which literally
 *            satisfies Section 3(i). Section 3(ii)'s selection risk remains, and accepting it is the
 *            user's judgment call — this task flags the distinction and does not choose for them.
 *        (c) ZERO-RISK FALLBACK — CITE, DO NOT RUN. Put LiveKit's own published `eot-bench` figures,
 *            and/or an independent third-party retest such as p99lab's (both named by the task as
 *            acceptable secondary sources — NEITHER was fetched or verified in this run), into the
 *            SPEC table as REFERENCED, NOT-RE-RUN-HERE rows (see `referencedThirdPartyNumbers`).
 *            They must be clearly labelled second-hand, with a different hardware/methodology, and
 *            are never presented as this repository's own measurement.
 *
 * UNTIL (a) IS CONFIRMED IN WRITING, THIS ADAPTER DOES NOT DOWNLOAD OR RUN v1-mini — no model-loading
 * or inference code path was added, and none exists in this file (grep it: there is no `onnxruntime`,
 * no `import`, no weight fetch). Group C therefore stays `measured: false` with `status:
 * 'blocked-by-license'`; the SPEC relabels it "designed, authorization-blocked" — a provisioning
 * state, not a measured one. The interface, the manifest wiring and the six-metric schema it WOULD
 * fill are identical to groups A/B, so if the licence is ever cleared the harness does not change.
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
  /** AC12: the SPEC's formal label for group C after the P0.5 upgrade — provisioned, not measured. */
  specGroupLabel: 'designed, authorization-blocked (已设计、授权阻塞)';
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
  /** AC12: Section 3's "Limitation on Use" sub-clauses, quoted as data so 3(i) and 3(ii) read verbatim. */
  limitationOnUseClauses: {
    clause: '3(i)' | '3(ii)' | '3(iii)';
    verbatim: string;
    blocksWhat: string;
  }[];
  /** AC12: the two escape hatches the upgrade path would otherwise lean on — verified ABSENT. */
  noExemption: {
    benchmarkResearchExemption: false;
    relicenceContactNamed: false;
    howVerified: string;
  };
  /** AC12: the three escalating options, in the order a maintainer should consider them. */
  upgradePath: {
    order: 1 | 2 | 3;
    option: 'written-authorization' | 'framework-compliant-run' | 'cite-not-run';
    what: string;
    clearsSection3i: boolean;
    clearsSection3ii: boolean | 'not-a-legal-determination';
    residualRisk: string;
  }[];
  /** AC12: second-hand figures a later task MAY cite; NONE was fetched or verified in this run. */
  referencedThirdPartyNumbers: { source: string; kind: string; fetchedHere: false; note: string }[];
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
    specGroupLabel: 'designed, authorization-blocked (已设计、授权阻塞)',
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
    limitationOnUseClauses: [
      {
        clause: '3(i)',
        verbatim:
          'not to use any LiveKit Models on a standalone basis or with any frameworks other than LiveKit Agents',
        blocksWhat:
          'running v1-mini in THIS harness: it is a standalone Node/TS process, not the LiveKit Agents framework, so it is the exact "standalone basis" the licence withholds. Sections 1 phrases the same limit in plain English: "You cannot use the LiveKit models on a standalone basis or with any other frameworks."',
      },
      {
        clause: '3(ii)',
        verbatim:
          'not to use any LiveKit Materials or any output from, or results of using, LiveKit Models (including any derivative works thereof) to improve or otherwise develop any other models that are not LiveKit Models',
        blocksWhat:
          'the USE of the comparison results to SELECT between non-LiveKit detectors for this product — a distinct risk that survives even a Section 3(i)-compliant run. Whether that selection counts as "improve or otherwise develop any other models" is a legal interpretation this task does not make.',
      },
      {
        clause: '3(iii)',
        verbatim:
          'distribute or otherwise make available the LiveKit Materials (including any derivative works thereof) except (x) pursuant to the terms of this Agreement, and (y) you reproduce the above copyright notice',
        blocksWhat:
          'redistributing any LiveKit material or derivative — not triggered here (nothing was downloaded), recorded so a later task does not treat distribution as free.',
      },
    ],
    noExemption: {
      benchmarkResearchExemption: false,
      relicenceContactNamed: false,
      howVerified:
        'the full LiveKit Model License Agreement (Last Updated: November 25, 2024; HTTP 200, 2026-10-11) was read end to end — §1 Introduction, §2 Definitions, §3 License Rights, §4 IP, §5 Disclaimer, §6 Liability, §7 Trademarks, §8 Term and Termination, §9 Governing Law and Venue (California; venue San Francisco). It contains no benchmark/evaluation/research/academic exemption and no contact address or relicensing procedure. So there is nothing inside the licence to appeal to — the status is a hard block, not "unclear".',
    },
    upgradePath: [
      {
        order: 1,
        option: 'written-authorization',
        what:
          'via LiveKit\'s ordinary contact channel (https://livekit.io/contact — the licence names no other address), obtain WRITTEN confirmation of TWO things: (a1) benchmarking v1-mini outside the LiveKit Agents framework, AND (a2) using the comparison results to select between non-LiveKit detectors. Both must be confirmed; (a1) alone does not clear Section 3(ii).',
        clearsSection3i: true,
        clearsSection3ii: true,
        residualRisk: 'none once written; this worker cannot request or accept it on the user\'s behalf.',
      },
      {
        order: 2,
        option: 'framework-compliant-run',
        what:
          'build the benchmark inside a real `livekit-agents` + `livekit-plugins-turn-detector` pipeline, which literally satisfies Section 3(i).',
        clearsSection3i: true,
        clearsSection3ii: 'not-a-legal-determination',
        residualRisk:
          'Section 3(ii)\'s selection risk remains — whether using the results to choose a detector for this product is permitted is the user\'s judgment call, not this task\'s.',
      },
      {
        order: 3,
        option: 'cite-not-run',
        what:
          'place LiveKit\'s own published `eot-bench` figures and/or an independent third-party retest (e.g. p99lab\'s) into the SPEC table as REFERENCED, NOT-RE-RUN-HERE rows.',
        clearsSection3i: true,
        clearsSection3ii: true,
        residualRisk:
          'none legally — but the numbers are second-hand, from different hardware and methodology, and must never be presented as this repository\'s measurement.',
      },
    ],
    referencedThirdPartyNumbers: [
      {
        source: 'LiveKit eot-bench (LiveKit\'s own published benchmark)',
        kind: 'first-party published benchmark',
        fetchedHere: false,
        note:
          'named by the task as an acceptable zero-risk citation. NOT fetched or verified in this run — a later task citing it must record the exact source URL and date, and label it second-hand.',
      },
      {
        source: 'p99lab third-party retest',
        kind: 'independent third-party retest',
        fetchedHere: false,
        note:
          'named by the task as an acceptable zero-risk citation. NOT fetched or verified in this run — a later task citing it must record the exact source URL and date, and label it second-hand.',
      },
    ],
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
