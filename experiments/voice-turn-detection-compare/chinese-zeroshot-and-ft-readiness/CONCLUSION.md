# P0.14 — Chinese zero-shot end-of-turn: conclusion

**Task:** `gap-voice-turn-detection-p0-14-chinese-zeroshot-and-ft-readiness`
**Scope:** zero training · zero paid API · zero production change. Nothing here was fine-tuned; no
paid endpointing/realtime/Omni call was made; no file under `server/modules/voice-realtime/` or
`src/modules/chat/voice-realtime/` is touched.

Every number below is produced by **this task's own local inference** on the checkpoints P0.13
already landed (revisions and sha256 copied verbatim — see §7 and `RESULT.json → provenance`). No
number is interpolated, copied from a model card, or re-used from another task's run.

---

## 1. The two questions AC7 asks, answered first

**Q1 — Is there a Chinese zero-shot operating point that meets the pre-registered budget?**
**Yes — a budget-satisfying point exists, and all four candidates reach one.**
On both corpora, at the full-corpus level, every candidate (both models *and* both model-free
baselines) meets the pre-registered budget of **false cutoff ≤ 10 % AND missed END ≤ 10 %** (§3).

**But that is not evidence the models work.** On the *natural* Chinese corpus the two model-free
baselines — the **shipping VAD rule** and a **fixed 0.2 s silence timer** — have **fewer missed
ends than either model** (0/38 vs 3/38 and 2/38), and on *every* view all four candidates have the
**identical** false-cutoff rate. The models never beat the baseline; on the error that matters for
turn-taking they are beaten by it. The pass is therefore a property of a **contact-poor corpus**,
not of the models (§5, §6).

**Q2 — Should a follow-up fine-tune / LoRA task be filed now?**
**Not as the next step, and this task files none.** The evidence says the binding constraint is
**evaluation**, not model quality: on this corpus no model can be separated from a silence timer, so
a fine-tune has no measurable target to move. The recommended next artifact is a **natural Chinese
turn-taking corpus with a discriminative protocol** (real inter-speaker gaps, speaker-disjoint
split); fine-tuning becomes worth filing only once that harness can tell a model from a timer. If a
fine-tune *is* filed, it is technically feasible — see §8 and `gpu-finetune-runbook.md`.

---

## 2. What was run

- **Harness reused, corpus new.** Scoring and sweep semantics come from
  `../eot-bench-adapters/protocol.mts` — the same module P0.7/P0.11/P0.13 use: a causal grid walk
  of `p_eot` sampled at 0.1 s and 0.02 s, and a policy sweep over `threshold × actionDelay ×
  timeout`. turn-1-mini runs through P0.13's own `run-turn1mini.py` **unmodified** (driven with
  absolute WAV paths; nothing in P0.13's directory is written).
- **Four candidates**, each swept on its own axis: Smart Turn v3.2 (ONNX int8, compiled mel),
  turn-1-mini (streaming ONNX, official 4 kHz low-pass), the **shipping VAD rule**
  (`StreamingVad` + `thresholdsFor` from `src/shared/voiceEndpoint.ts`, knob = endpoint ms), and a
  **fixed-wait timer** (no audio at all, knob = silence seconds).
- **Degenerate rows excluded (AC3):** the sweep drops every row with `threshold ≤ 0.02` — the
  threshold axis is filtered, not just `threshold = 0`, so a policy cannot win by firing always.
- **Cross-model comparison is frontier-to-frontier (AC3):** the two models' `threshold` axes are
  never compared numerically; each frontier lives in its own probability space.
- **Held-out discipline (AC4):** a per-model operating point is *selected* on one clip-disjoint half
  (split by clip `sha256`, so the two halves share no clip) and the *reported* rates are measured on
  the other half. **Selection set ≠ reporting set.**

---

## 3. Corpus — and the sample-size reality (AC2)

Both corpora are **real Chinese speech** and are **reported separately**, never merged into one
number. No TTS, no splicing, no synthetic dialogue.

| corpus | nature | clips | holds | eots | what its "END" really is |
|---|---|---:|---:|---:|---|
| `thchs30-zh-scripted` | **scripted single-utterance reads** | 40 | 34 | 40 | a **scripted sentence-final boundary** — a read-aloud period, **not** a conversational turn end |
| `ascend-zh-natural-dialogue` | **spontaneous conversation** (code-switched) | 38 | 14 | 38 | this speaker stopped (the released crop ends at the utterance) |

**The natural corpus must not be over-read (explicit insufficiency declaration).**

- It is **38 admitted clips from 4 conversations**, and only **2 distinct speakers** (speaker 3: 29
  clips, speaker 17: 9). Per-session admitted counts are 12 / 12 / 12 / 2.
- It is **code-switched**: the rows kept are `zh` (14) or `mixed` (24), so most clips contain
  English as well as Mandarin — that is a property of the audio, not of the label
  (`corpus-license-review.json` §evalCorpora).
- Consequence: **any single error on a 9-hold report half is 11.1 %**, above a 10 % budget, and the
  clips within a conversation are **not independent samples** — so the Wilson interval, which
  assumes independence, **understates** the true uncertainty. Wilson is still reported (it is the
  protocol), but it is a *lower bound* on the width. No pass/fail claim here should be treated as
  settled.
- The gate is deliberately strict and its yield is **evidenced, not asserted**. Of **1200 scanned
  ASCEND rows** the fetch admitted **38**; drop reasons (`data/corpus.json → naturalGate.dropped`,
  reproducible by re-running `fetch-chinese-corpus.mjs`): **453** had < 200 ms of *real* trailing
  silence (a turn end there would be synthetic), **237** were English-only, **229** were < 1 s,
  **237** were skipped because their session had already filled its per-session cap, **6** had no
  internal pause to test as a hold. Admission also requires **≥ 1 real internal pause ≥ 120 ms**, so
  a tight crop cannot masquerade as a turn end.

**Stated plainly: the natural Chinese sample is too small and too correlated to support a
pass/fail verdict.** The corpus is adequate to *find* that the baselines are competitive; it is not
adequate to *rank* the models. This is written here rather than omitted, per the task's rule.

---

## 4. Results — full corpus, per corpus, budget = false cutoff ≤ 10 % **and** missed END ≤ 10 %

Each cell is `k/n = rate`, Wilson 95 % CI, and the model's own EOT wait (p50 / p90 / max). "wait"
is *how long after the true end the policy fired*; it is reported **separately** from inference
cost (§9).

### 4a. `thchs30-zh-scripted` (scripted reads) — 34 holds, 40 eots

| candidate | false cutoff | missed END | wait p50/p90/max (s) | in budget |
|---|---|---|---|---|
| Smart Turn v3.2 | 3/34 = 8.8 % [3.1, 23.0] | 0/40 = 0 % [0, 8.8] | 0.00 / 0.00 / 0.00 | yes |
| turn-1-mini | 3/34 = 8.8 % [3.1, 23.0] | 0/40 = 0 % [0, 8.8] | 0.00 / 0.00 / 0.50 | yes |
| **VAD (shipping rule)** | 3/34 = 8.8 % [3.1, 23.0] | 0/40 = 0 % [0, 8.8] | **0.20 / 0.20 / 0.22** | yes |
| **fixed-wait timer** | 3/34 = 8.8 % [3.1, 23.0] | 0/40 = 0 % [0, 8.8] | **0.20 / 0.20 / 0.20** | yes |

On scripted reads **all four rows are numerically identical** on both error rates. The models have
no advantage whatsoever on a read-aloud corpus — as expected, since a read corpus has no turn ends.

### 4b. `ascend-zh-natural-dialogue` (spontaneous, code-switched) — 14 holds, 38 eots

| candidate | false cutoff | missed END | wait p50/p90/max (s) | in budget |
|---|---|---|---|---|
| Smart Turn v3.2 | 1/14 = 7.1 % [1.3, 31.5] | **3/38 = 7.9 %** [2.7, 20.8] | 0.00 / 0.20 / 1.00 | yes |
| turn-1-mini | 1/14 = 7.1 % [1.3, 31.5] | **2/38 = 5.3 %** [1.5, 17.3] | 0.00 / 0.90 / 1.00 | yes |
| **VAD (shipping rule)** | 1/14 = 7.1 % [1.3, 31.5] | **0/38 = 0 %** [0, 9.2] | **0.20 / 0.20 / 0.20** | yes |
| **fixed-wait timer** | 1/14 = 7.1 % [1.3, 31.5] | **0/38 = 0 %** [0, 9.2] | **0.20 / 0.20 / 0.20** | yes |

**Group stratification (AC4).** `RESULT.json → …views[…].groupDistribution` reports the same errors
per group, where a group is a **session** for the natural corpus (ASCEND exposes a session id) and
a **clip** for the scripted corpus (THCHS-30 exposes no speaker id in the mirror used — the weaker
guarantee, stated rather than hidden). On the natural corpus Smart Turn's single false cutoff sits
entirely in one session (`worstGroupCutoffShare = 1.0`, but the numerator is one event, so read that
as "one error", not as concentration) and its missed ends appear in **3 of the 4** sessions, with
the worst single session holding only a third of them (`topDecileMissedShare = 0.3333`) — i.e. the
failures are spread across conversations, not one bad recording.

**Language stratification (AC4).** `RESULT.json → …views[…].languageDistribution` breaks the same
errors down by the corpus's own language tag (`zh` vs `mixed`; `mixed` means the clip code-switches
but still contains Mandarin). It is reported for the natural corpus and the merged view, and is
**null for the scripted corpus** — THCHS-30 carries no language tag, so a null there means "not
applicable", not "measured and empty". Honest read of it: the ASCEND strata are far too small
(14 holds / 38 eots split two ways) for the split to carry weight, which is the same sample-size
ceiling as §3 — it is reported for completeness, not as a finding.

This is the load-bearing table. On real spontaneous Chinese:

- **false cutoff is identical (1/14) for all four** — the models add no discrimination on that side;
- on **missed END the two model-free baselines are strictly better than both models** (0/38 vs
  3/38 and 2/38);
- and they achieve it at a **deterministic 0.20 s wait**, while the models' selected points fire at
  a p50 of **0.00 s** with p90 up to 0.90 s and a 1.00 s tail — i.e. the models are *both* less
  accurate *and* less predictable.

### 4c. Merged (both corpora) — 48 holds, 78 eots

Smart Turn fc 3/48 = 6.2 % / me 3/78 = 3.8 %; turn-1-mini fc 3/48 / me 2/78 = 2.6 %; VAD and
fixed-wait fc 3/48 / **me 0/78 = 0 %**. The merged view repeats §4b: same false cutoffs, baselines
strictly better on missed END.

### 4d. The frontiers sit in a corner

Every frontier point in every view is at **`threshold = 0.03`** — the lowest value the AC3
degeneracy filter allows — with the single exception of one Smart Turn point at `threshold = 0.99`
on the scripted corpus. The models' best operating points therefore sit on the **floor of the
allowed threshold axis**: to meet the budget they must fire almost unconditionally, which is the
same behaviour as a timer. The count of budget-satisfying grid cells on the natural corpus
reinforces it — **Smart Turn 96**, turn-1-mini 280, VAD 471, fixed-wait 570: Smart Turn's feasible
region on natural Chinese is the *thinnest* of the four.

---

## 5. Held-out verdicts (AC4) — selection ≠ reporting

The operating point was selected on one clip-disjoint half and the rates below are measured on the
**other** half.

| corpus (report half) | candidate | false cutoff on report half | missed END on report half |
|---|---|---|---|
| thchs30 (23 holds, 21 eots) | Smart Turn | 2/23 = 8.7 % [2.4, 26.8] | 0/21 = 0 % |
| thchs30 | turn-1-mini | 2/23 = 8.7 % [2.4, 26.8] | 0/21 = 0 % |
| thchs30 | VAD / fixed-wait | 2/23 = 8.7 % [2.4, 26.8] | 0/21 = 0 % |
| ascend (9 holds, 21 eots) | Smart Turn | 1/9 = **11.1 %** [2.0, 43.5] | 2/21 = 9.5 % [2.6, 28.9] |
| ascend | turn-1-mini | 1/9 = **11.1 %** [2.0, 43.5] | 1/21 = 4.8 % [0.9, 22.7] |
| ascend | VAD / fixed-wait | 1/9 = **11.1 %** [2.0, 43.5] | 0/21 = 0 % |

Two things to read carefully:

1. On the natural report half, **all four** candidates land at `1/9 = 11.1 %` false cutoff —
   *above* the 10 % budget. With 9 holds, one error is 11.1 %; this is **not** evidence that any of
   them "fails", and it is exactly the sample-size ceiling described in §3. It is reported, not
   hidden, and it is why §1 refuses a pass/fail claim.
2. The ordering that *is* stable across every view and both splits is the one in §4b: **the
   baselines never have a worse missed-END rate than the models, and on the natural corpus they are
   strictly better.**

---

## 6. The honest headline

> On real spontaneous Chinese speech, neither zero-shot model — Smart Turn v3.2, the model built
> for this, nor turn-1-mini — separated from the **shipping VAD rule** or a **plain 0.2 s silence
> timer**. All four meet the budget; the two timers meet it *better* on missed END and more
> predictably. The models' "winning" operating points sit at the floor of the allowed threshold
> axis, i.e. they win by behaving like a timer.

This is a **negative result about discriminative value on this corpus**, not a proof that the models
are bad in Chinese. The corpus cannot adjudicate that: it has 4 conversations, 2 speakers, and a
9-hold report half. What it *does* establish is that **the pre-registered budget alone is too weak
to certify a Chinese endpointing model** — a model-free baseline clears it.

---

## 7. Reuse and non-interference (AC1, AC6) — mechanical evidence

All four checks are recomputed by the harness and stored in `RESULT.json`; the shell commands are
recorded there too, so each is re-runnable.

| claim | evidence |
|---|---|
| **P0.13 artifacts untouched (AC1/AC6)** | `git diff --name-only $(git merge-base HEAD develop) -- experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini` → **empty** (`p013UntouchedEvidence.empty = true`) |
| **checkpoint identity is verbatim (AC1)** | Smart Turn `f766f81d…`, `smart-turn-v3.2-cpu.onnx` sha256 `2bb02631…`, 8 679 182 B; turn-1-mini `076c86d1…`, ONNX `e747b182…`, safetensors `d03ccff8…`, `p99turn` 1.2.3 — **byte-for-byte equal to P0.13's own `RESULT.json → provenance`**, no version re-selected. `RESULT.json → models['smart-turn-v3.2'].matchesPinnedSource = true` |
| **no production Live Voice change (AC6)** | `git diff --name-only $(git merge-base HEAD develop) -- server/modules/voice-realtime/ src/modules/chat/voice-realtime/` → **empty**; the develop-tip form is also empty (`productionDiffEvidence.empty = true`) |
| **nothing builds/typechecks/tests this (AC6)** | the P0.14 path is referenced by **none** of `package.json`, `tsconfig.json`, `server/tsconfig.json`, `scripts/tsconfig.json`, `vite.config.js`, `scripts/test.sh` (`isolationEvidence.clean = true`, hits = []) |
| **no paid / realtime / Omni call (AC6)** | marker scan over the two harness files finds **no** paid-API markers; the only network egress is `huggingface.co`, `datasets-server.huggingface.co`, `www.openslr.org`, `raw.githubusercontent.com`. `thisTaskNewSpendCny = 0` |
| **no fine-tuned weight downloaded or trained** | `dryrun-evidence.json → downloads` contains exactly a config, a **base** whisper-tiny encoder snapshot, and turn-1-mini's released checkpoint — no fine-tuned endpointing weight; no optimizer, no backward pass, no checkpoint written (`noFineTunedWeightsDownloaded = true`) |

---

## 8. Chinese adaptation feasibility (AC5) — plan only, zero training executed

The feasibility answer is **technically yes, and it was established by running code, not by reading
docs**. Full detail in `gpu-finetune-runbook.md`; raw evidence in `dryrun-evidence.json`
(produced by `dryrun-pytorch.py`, re-runnable).

- **turn-1-mini** — the released checkpoint is a real PyTorch `safetensors` that loads into the
  released `p99turn.mini.Turn1Mini` `nn.Module` (**5 262 337 params**, forward `[1, 32000]` →
  `[1, 100]`, finite), and its sha256 matches P0.13's pin. The released package contains **no
  training code** (training-specific needle scan over every released module: **zero hits**, so a
  fine-tune must supply its own loop). Its config declares `"language": "en"`.
- **Smart Turn v3.2** — the HF repo ships **ONNX only**; the trainable path is the GitHub
  `train.py`, whose documented entry point is
  `SmartTurnV3Model.from_pretrained("openai/whisper-tiny", num_labels=1, ignore_mismatched_sizes=True)`.
  Mirroring that class and that call **loaded and ran here**: 8 000 386 params, `d_model = 384`,
  `max_source_positions = 400`, forward `[2, 80, 800]` → logits `[2, 1]`, BCEWithLogits loss finite.
  The base weights are the **public whisper-tiny encoder**, not a fine-tuned endpointing weight.
- **Licence review is first-hand** (`corpus-license-review.json`, every line fetched with its URL):
  best training candidate is **AISHELL-4** (Apache-2.0, natural Mandarin meetings with TextGrid
  turn annotations); AliMeeting-eval-8k inherits CC BY-SA 4.0 (8 kHz caveat); MagicHub is
  academically-restricted (reject for a shipped model); a TTS dialogue corpus is **rejected**
  outright because synthesized silences are not human turn-taking.
- The runbook covers the pre-flight checklist, corpus construction (turn-taking labels, not ASR
  labels), speaker-disjoint splits, an **English retention regression** with pre-registered
  go/no-go gates, and ONNX export + int8 quantisation.

**No step of that plan was executed.** No GPU, no optimizer, no dataset, no fine-tuned weight.

---

## 9. Inference cost (reported separately from wait, AC4)

- **Smart Turn v3.2** (compiled mel + ONNX int8 on CPU), 1823 grid cells at 0.1 s: mel feature
  p50 **24.73 ms** / p90 24.88 ms; ONNX inference p50 **44.25 ms** / p90 45.40 ms — so ~**69 ms of
  CPU per decision** (`smartTurnInferenceCpuMs` in `RESULT.json`).
- **turn-1-mini** (official streaming ONNX, 4 kHz low-pass), 12 480 steps over 1996.8 s of streamed
  audio: step p50 **1.44 ms** / p90 1.64 ms / max 2.65 ms per 160 ms step → ~**111× real time** on
  one CPU thread (`turn1MiniTiming` in `RESULT.json`).

So the two families have very different cost profiles: per decision on this CPU, turn-1-mini is
nearly **50× cheaper** than Smart Turn. That is a real budget item to weigh against Smart Turn's
(here, absent) accuracy advantage — and it matters more, not less, once a per-utterance streaming
deployment is considered.

---

## 10. Limitations

1. **Natural-corpus size and correlation** (§3) — the dominant limitation. 4 conversations, 2
   speakers, 9-hold report half; Wilson CIs are optimistic because clips are not independent.
2. **Code-switching** — the natural clips are `zh`/`mixed`, so this is not a pure-Mandarin result.
3. **Scripted corpus is not a turn-taking corpus** — THCHS-30's "END" is a sentence boundary; §4a's
   perfect tie across all four candidates is a property of that fact, not a model measurement.
4. **Single machine, CPU** — inference timings are this host's, one thread.
5. **Threshold degeneracy** — the AC3 filter drops `threshold ≤ 0.02`; the models' optima sit *at*
   0.03, i.e. immediately above the filter. A wider filter would only make the models look worse.

---

## 11. Recommendation (AC7)

- **Do not file a fine-tune / LoRA task yet.** The corpus cannot separate a model from a silence
  timer, so a fine-tune would have no measurable target.
- **Recommended next artifact instead:** a Chinese turn-taking evaluation upgrade — real
  inter-speaker gaps (a corpus like AISHELL-4, speaker-disjoint split) plus a **hard-negative**
  protocol that a timer provably fails (e.g. scoring holds against a timer whose wait is tuned to
  the budget). Only then does a model have room to demonstrate value.
- **This task creates no follow-up task**, per its own constraint; the recommendation is written
  here only.
- If a fine-tune is subsequently approved, `gpu-finetune-runbook.md` is the plan, and its
  pre-registered gates (Chinese gain must clear both Wilson intervals; English retention must not
  regress; streaming/ONNX export must round-trip) are the acceptance criteria.

---

## 12. Reproduce

```bash
# 1) corpus (writes data/corpus.json + data/real/*.wav; not committed)
node experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/fetch-chinese-corpus.mjs \
     --ascend 48 --thchs30 40

# 2) isolated python env for turn-1-mini (requirements.txt pins the runtime + the CPU torch build)
python3 -m venv --without-pip .venv && python3 -m pip --python .venv/bin/python install -r requirements.txt

# 3) benchmark -> RESULT.json (~12 min)
node_modules/.bin/tsx --tsconfig server/tsconfig.json \
  experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/run-benchmark.mts

# 4) AC5 dry-run evidence -> dryrun-evidence.json (loads + one forward/loss each; no training)
.venv/bin/python -I experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/dryrun-pytorch.py \
  --out experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/dryrun-evidence.json
```
