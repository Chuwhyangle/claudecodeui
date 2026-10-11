# Chinese turn-detection fine-tune / LoRA — GPU runbook (PLAN ONLY)

**Status: nothing in this document was executed.** No training run, no GPU, no optimizer, no
fine-tuned weight was produced or downloaded. This is the written feasibility answer AC5 asks for,
built on two things that *were* executed — the AC5 dry-run (`dryrun-pytorch.py`) and the corpus
licence review (`corpus-license-review.json`) — plus the upstream training code as read first-hand.

Everything below is a plan to be run **only if a follow-up task is filed and approved**. This task
does not file it (AC7).

---

## 1. What the dry-run already established (evidence, not assumption)

| claim | evidence |
|---|---|
| Smart Turn v3.2 training is reproducible from a public base | `pipecat-ai/smart-turn/train.py:684` calls `SmartTurnV3Model.from_pretrained(CONFIG["base_model_name"], num_labels=1, ignore_mismatched_sizes=True)` with `base_model_name = "openai/whisper-tiny"`. Mirroring that class + call on this machine **loaded and ran**: 8,000,386 params, encoder `d_model=384`, `max_source_positions=400`, forward on `[2, 80, 800]` → logits `[2, 1]`, BCEWithLogits loss `0.692672` (finite). |
| The HF Smart Turn repo ships **ONNX only** | the `pipecat-ai/smart-turn-v3` repo has no trainable `.pt`; the trainable path is the **GitHub** repo's `train.py`, which starts from the public base. |
| turn-1-mini's released checkpoint is a **real PyTorch checkpoint** | `turn-1-mini.safetensors` (sha256 `d03ccff8…`, 84 tensors) loads into the released `p99turn.mini.Turn1Mini` `nn.Module` (5,262,337 params) and forwards (`[1, 32000]` → `[1, 100]`, finite). |
| turn-1-mini ships **no training code** | scanning every released module for `def train` / `backward(` / `.step()` / `optim.` / `Trainer(` / `AdamW` / `load_dataset` finds **zero** hits. A fine-tune must supply its own loop. |
| turn-1-mini is **English-only by construction** | `config.json` declares `"language": "en"`; the model card states it was "trained on read, conversational and telephone speech in English". |
| Chinese is genuinely out-of-distribution for turn-1-mini | the above, plus the P0.14 benchmark's own numbers (see `CONCLUSION.md`). |

The raw evidence behind every row above — the loaded param counts, the forward/loss shapes, the
`p99turn` module scan and the exact download list (base weights only) — is committed at
`dryrun-evidence.json` in this directory. It is produced by `dryrun-pytorch.py` and can be re-run
(`.venv/bin/python -I dryrun-pytorch.py --out dryrun-evidence.json`). A first draft of that scan
used a bare `loss` substring and falsely flagged `p99turn/mini.py` as carrying a training path; the
committed run scans for training-specific needles only and reports **zero** hits.

Consequence for the plan: the two models need **different recipes**. Smart Turn can be fine-tuned
with the upstream `transformers.Trainer` almost verbatim; turn-1-mini needs a hand-written loop and
a decision about *where* the adaptation lives (see §4).

---

## 2. Pre-flight checklist (do not start a run until every box is ticked)

```
[ ] A GPU is allocated and its memory is known (target >= 16 GB VRAM for whisper-tiny-class full
    fine-tune; >= 8 GB is enough for LoRA at the sequence lengths below).
[ ] A CUDA torch build is installed in an ISOLATED env (NOT the P0.14 CPU venv; that one is pinned
    to the CPU wheel index — see requirements.txt).
[ ] The base weights are resolved at a pinned revision (openai/whisper-tiny; or turn-1-mini
    safetensors @ 076c86d1744a231d3a4cce31f3bbbd1211b4c281) and their sha256 recorded BEFORE training.
[ ] The training corpus licence has been re-read first-hand (corpus-license-review.json
    §trainingCandidates) and its redistribution terms match the intended use. Academic-only corpora
    (MagicHub) must NOT feed a shipped model.
[ ] A held-out SPLIT IS FIXED BEFORE TRAINING — speaker-disjoint (see §5). No clip in train may share
    a speaker (or a session) with validation.
[ ] The P0.14 Chinese eval set (thchs30 + ascend, or a larger version) is FROZEN and untouched by
    training. It is the reporting set; it must not become the tuning set.
[ ] An English retention regression set is frozen (see §6) BEFORE any Chinese data is seen.
[ ] A baseline run of the UNTRAINED model is recorded on both the Chinese eval and the English
    regression set, so every delta is measured against a number, not an impression.
[ ] ONNX export + quantisation path is verified to round-trip BEFORE training (a model that cannot be
    exported is not shippable regardless of its accuracy).
```

---

## 3. Corpus construction (turn-taking labels, not ASR labels)

The single most important design point: **a read/ASR corpus does not contain turn ends.** The P0.14
finding is that THCHS-30's "END" is a scripted sentence boundary and its "hold"s are intra-sentence
pauses; training on that teaches a sentence-final detector, not a turn-taking detector.

Target composition for a fine-tune:

1. **Conversational core (majority).** Real multi-turn speech with turn boundaries —
   `AISHELL/AISHELL-4` (Apache-2.0, meetings, TextGrid turn annotations) is the best-licenced
   candidate; `playwithmino/alimeeting-eval-8k` (CC BY-SA 4.0, 8 kHz) is the row-API alternative.
   Build labels from the annotation:
   - a **turn end** = the speaker stopped and did not resume → the trailing silence is `END`;
   - a **within-turn pause** = the same speaker resumed → the internal silence is a `hold`/CONTINUE;
   - **overlapped** regions must be excluded or explicitly labelled — a "pause" under another
     speaker is not an endpoint.
2. **Read/scripted satellite (minority).** AISHELL-1/3 or THCHS-30 for acoustic coverage only. Keep
   these in a SEPARATE bucket so the mix can be ablated.
3. **Code-switch coverage.** ASCEND (zh/en) if the deployment target mixes English — otherwise it
   dilutes the Chinese-only signal.
4. **Never** synthetic dialogue (MYJOKERML): TTS silences are not human turn-taking.
5. **Digital tail policy.** Give every END a fixed closing silence (P0.6/P0.13 use 1500 ms) so the
   grid has room; give every hold only its real pause. Record, per clip, how much of the scored
   silence is real vs padding.
6. **Normalisation.** 16 kHz mono. turn-1-mini additionally REQUIRES the 4 kHz low-pass
   (`p99turn.audio.bandlimit_4k`) — apply it for that target only, and re-apply it at inference.
7. **No leakage.** Deduplicate by audio hash; a session that appears in train must not appear in val.

---

## 4. Two recipes

### 4a. Smart Turn v3.2 — upstream recipe (transformers `Trainer`)

Reproduce `pipecat-ai/smart-turn/train.py`:
- model: `SmartTurnV3Model(WhisperPreTrainedModel)` = `WhisperEncoder` + attention pooling +
  3-layer classifier head, initialised from `openai/whisper-tiny` with
  `num_labels=1, ignore_mismatched_sizes=True`;
- features: `WhisperFeatureExtractor(chunk_length=8)` → `[B, 80, 800]`;
- loss: `BCEWithLogitsLoss` with a `pos_weight` computed from the batch's class ratio (clamped
  0.1–10) — already in the class's `forward`;
- fine-tune options, cheapest first:
  1. **head-only** (freeze the encoder) — fastest, least likely to overfit a small corpus;
  2. **LoRA** on the encoder's attention projections — a middle ground; requires injecting adapters
     into `WhisperEncoder` before `Trainer`;
  3. **full fine-tune** — most data-hungry; only with a corpus in the tens of hours.
- the released ONNX is what ships; training produces a `.pt`/safetensors that must then be exported
  (§7).

### 4b. turn-1-mini — no released training code, so the loop is ours

Because the released package has no training path and the config declares English, the adaptation
must be authored:
- **the tensor interface is already loadable** — `Turn1Mini` is a plain `nn.Module` over
  `turn-1-mini.safetensors`, so `state_dict()` in/out works;
- **LoRA is the natural fit**: the trunk is 6 causal-conv+attention blocks (`Trunk`, `d=256`,
  left_ctx=60) followed by a small head; wrap the attention projections; keep the released weights
  frozen;
- **the streaming contract must be preserved**: the model is causal, frame-wise, 20 ms hop, 160 ms
  step, band-limited to 4 kHz. Any training must keep the causal receptive field and the low-pass;
  a non-causal objective will not export to the streaming graph;
- **loss**: per-frame BCE against the frame-level END label, matching the `[1, 100]` output;
- **the ONNX export must stay chunk-size-invariant** — the released graph's `carriedStateEqualsFresh-
  Prefix` / `chunkSizeInvariant` self-checks (P0.13's `run-turn1mini.py`) are the acceptance test for
  a re-exported model.

---

## 5. Speaker-disjoint split (mandatory)

- Group clips by **speaker id** where the corpus provides one (AliMeeting, AISHELL-4, ASCEND all do);
  where it does not (THCHS-30 exposes none in the mirror used), group by **session/recording** and
  state the weaker guarantee explicitly.
- Split **by group**, never by clip: e.g. 80 % speakers train / 10 % dev / 10 % test.
- Selection of hyper-parameters (thresholds, LoRA rank, epochs) happens on **dev only**.
- The **test** split is touched once, at the end. The P0.14 held-out protocol (select on one half,
  report on a disjoint half) is the same discipline; reuse it.
- Record the split manifest (group ids per fold) in the run's artifact directory — a split that
  cannot be reproduced makes the result unauditable.

---

## 6. English retention regression (the "did we break English?" design)

Fine-tuning on Chinese risks catastrophic forgetting on the language the model was built for.

- **Freeze an English set before training**: P0.13's own English corpus/labels are the obvious choice
  (reuse the pinned artifacts; do not re-derive). Add everyday English conversational clips.
- **Measure both models on it before and after**: report false-cutoff and missed-END with Wilson 95 %
  CIs, exactly as P0.14 reports Chinese.
- **Go/no-go gates** (pre-registered, so the decision is not made after seeing the numbers):
  - Chinese: a real gain — the post-training operating point at the same false-cutoff budget must
    beat the pre-training one **outside the two Wilson intervals**, not by a raw point delta;
  - English: no regression beyond the CI — if the English missed-END or false-cutoff CI moves in the
    bad direction, the recipe is rejected regardless of the Chinese gain;
  - a **language-balanced** objective (mix English + Chinese batches, or add a KL/retention term to
    the frozen model's English outputs) if the first attempt fails the English gate.
- **Also measure code-switched audio** (ASCEND) if the deployment mixes languages, since that is the
  hardest retention case.

---

## 7. ONNX export + quantisation (the shipping path)

For **Smart Turn**, export the trained `SmartTurnV3Model` to the shape the runtime consumes:
- the released graph's input is `[1, 80, 800]` (8 s window). Export with `torch.export`/`torch.onnx`
  using that fixed (or dynamic-batch) shape; reproduce `export_to_onnx_fp32` from `train.py`;
- **fp32 → int8**: `onnxruntime.quantization.quantize_static` with a calibration set drawn from the
  **training** distribution (never the test set), `QuantType.QInt8`; `quant_pre_process` first;
- **verify**: re-run P0.13's self-checks against the re-exported graph — P0.13's `run-turn1mini.py`
  gives the template (`carriedStateEqualsFreshPrefix`, `chunkSizeInvariant`,
  `onnxMatchesTorchReferenceStream`, `lowpassAppliedNotBypassed`); for Smart Turn, assert
  fp32-vs-int8 agreement on a held-out batch within a stated tolerance before shipping;
- record the exported file's **sha256** and the base revision, and pin them the way P0.13/P0.14 pin
  theirs.

For **turn-1-mini**, the export must preserve the streaming graph (160 ms step, carried state). The
released self-checks are the acceptance test; a re-export that fails `chunkSizeInvariant` is not
shippable even if offline accuracy improved.

---

## 8. Cost, budget and stopping rules

- A whisper-tiny-class full fine-tune on ~10 h of audio is **single-GPU hours**, not days; LoRA is a
  fraction of that. The binding cost is **data construction and labelling**, not GPU time.
- **Stop rules**: if the Chinese gain does not clear the English gate after one balanced attempt, stop
  and report; do not chase accuracy by widening the threshold grid (that is the overfitting AC4
  forbids).
- **Do not** train on the P0.14 eval sets. A model that scores well because it saw the test audio is
  worthless.

---

## 9. What this runbook does NOT establish

- It does not claim a fine-tune **would** work — only that it is **technically reproducible** from
  public code, public base weights and licence-cleared data, and it names the failure modes
  (English forgetting, TTS-artifact labels, read-corpus turn ends, streaming-graph breakage) that a
  follow-up must gate on.
- It does not pick the corpus for you; it ranks the candidates by licence and naturalness with the
  evidence in `corpus-license-review.json`.
- It performs no step of the plan.
