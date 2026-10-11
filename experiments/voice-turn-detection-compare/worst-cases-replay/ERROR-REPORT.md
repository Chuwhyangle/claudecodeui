# P0.15 — worst-case replay: which real samples the two English turn detectors get wrong

Generated 2026-10-11T12:24:19.075Z by `extract-worst-cases.mts` from a real re-fetch and a real re-run of both models in an independent worktree.

## Why this report exists

P0.13 published aggregate rates and a Pareto frontier, and deliberately wrote no per-sample row: its `RESULT.json` holds `denominator`/`gate`/`frontier`/`dense` only, and its audio, span manifest and score caches were gitignored scratch that fan-in reclaimed with the worktree. So the follow-up question — *which recording, and what did the model say right before it was wrong* — had no readable answer. This report is that answer, computed from audio this task re-fetched itself and from model output this task produced itself.

## The fixed operating point (not re-selected)

`threshold=0.13`, `actionDelaySeconds=1`, `timeoutSeconds=3.5` — the exact tuple P0.13's CONCLUSION §2b reports for BOTH models, so the two models' per-span verdicts are strictly comparable and the AC5 comparison is a real check rather than a restatement. The baseline row is the same actionDelay/timeout with `threshold=0` — the degenerate "never look at the score, just wait" policy (equivalent to a plain VAD/timer).

## Ranking rules (AC2 asks for an explainable severity order)

- **False cutoff** — by severity descending: gapSeconds = (true pause length) − (time the cut landed), i.e. how much of the pause the speaker still had left; ties broken by longer true pause, then earlier cut, then span key
- **Missed end** — by severity descending: gapSeconds = (model fire time) − timeout, with "never crossed the threshold at all" = Infinity ranked first (the model gave no signal, so the endpoint came only from the timer); ties broken by span key

## Rates at the fixed point (this run, independently recomputed)

| view | model | false cutoff (hold→cut) | missed end (eot→timeout) | mean EoT latency (s) | baseline cutoff/missed |
|---|---|---|---|---|---|
| eot-bench-en | smart-turn-v3.2 | 33/705 = 4.68% | 27/400 = 6.75% | 0.2903 | 9.65% / 0.00% |
| eot-bench-en | turn-1-mini | 32/705 = 4.54% | 14/400 = 3.50% | 0.3660 | 9.65% / 0.00% |
| librispeech-en-real | smart-turn-v3.2 | 0/5 = 0.00% | 0/16 = 0.00% | 0.0187 | 0.00% / 0.00% |
| librispeech-en-real | turn-1-mini | 0/5 = 0.00% | 0/16 = 0.00% | 0.2875 | 0.00% / 0.00% |
| merged | smart-turn-v3.2 | 33/710 = 4.65% | 27/416 = 6.49% | 0.2798 | 9.58% / 0.00% |
| merged | turn-1-mini | 32/710 = 4.51% | 14/416 = 3.37% | 0.3630 | 9.58% / 0.00% |

`mean EoT latency` is eot-bench's "conversational dead air, not compute": over EoT spans, the model's own fire time when it detected, else the full timeout.

## AC5 — does this run reproduce P0.13's published k/n?

| model | view | P0.13 cutoff | this run | P0.13 missed | this run | P0.13 mean lat | this run | verdict |
|---|---|---|---|---|---|---|---|---|
| smart-turn-v3.2 | eot-bench-en | 33/705 | 33/705 | 27/400 | 27/400 | 0.29025 | 0.29025 | match |
| smart-turn-v3.2 | librispeech-en-real | — | 0/5 | — | 0/16 | — | 0.01875 | not published by P0.13 |
| smart-turn-v3.2 | merged | 33/710 | 33/710 | 27/416 | 27/416 | 0.279808 | 0.279808 | match |
| turn-1-mini | eot-bench-en | 32/705 | 32/705 | 14/400 | 14/400 | 0.366 | 0.366 | match |
| turn-1-mini | librispeech-en-real | — | 0/5 | — | 0/16 | — | 0.2875 | not published by P0.13 |
| turn-1-mini | merged | 32/710 | 32/710 | 14/416 | 14/416 | 0.362981 | 0.362981 | match |

**Verdict: IDENTICAL on all 4 published model/view pairs (2 view(s) not published by P0.13 — reported, not compared); grouping matches (96 speaker/session groups)** — Every published k, n and mean latency is reproduced exactly by an independent re-fetch and re-run — which is the evidence that this task's span set, cell geometry and score tables are the same objects P0.13 measured, not merely similar ones.

**Grouping (AC1):** this run re-derived **96** speaker/session groups from its own fetch of the pinned parquet; P0.13 published **96** (`groupDistribution.groups`). Equal — the same turns fold into the same groups.

AC5 asks for the **eot-bench-en** and **merged** views specifically, and those four model/view pairs are the compared rows above. The `librispeech-en-real` row is included for completeness but is NOT a comparison: P0.13 published only each view's Pareto frontier, and on that degenerate 5-hold/16-EoT view the operating point is dominated, so no target exists to compare against. Recording it as "not published" is deliberate — treating an unavailable target as a match would be the failure mode this check exists to prevent.

## Determinism — a second, independent process derived the same document (AC4)

Verdict: **byte-identical** (second-run exit code 0). Fields allowed to differ: `generatedAt`, `runtimeSeconds`, `courtesyCheck`, `determinism`, `smartTurnRun.shardMs`.

Two independent processes took the same scoring path on the same inputs and derived a byte-identical result document apart from the wall-clock fields listed in ignoredFields. What that covers depends on which path was taken and is stated in `scope` below; turn-1-mini's model output is established separately by turn1MiniRun.selfCheck.

**Scope of that claim:** the Smart Turn score cache was cold, so the child was given `--no-cache` and re-scored every cell from scratch: both processes did the same work on the same inputs, and a difference between them can only be a difference in the result — this covers the Smart Turn inference, the span rebuild, the policy reading, the ranking, the cross-tables and the rendering. turn-1-mini's scores are reused (--no-python) because its score file carries the python run's wall-clock timing; that model's output is covered separately by turn1MiniRun.selfCheck.

Two things are being established separately and each matters: this check re-runs the whole pipeline in a fresh process on the same inputs and compares the two documents; the audit recorded in `smartTurnRun.audit` independently shows that the Smart Turn table holds fresh model output rather than a stale file (64 cells re-scored with a fresh ONNX call, max absolute deviation 0). turn-1-mini's model output has its own check, `turn1MiniRun.selfCheck`, which re-runs prefixes through a fresh python session. No one of them implies another.

## AC3 — are the models actually better than not looking at the score?

`At the fixed point on the merged corpus (710 holds, 416 EoT): the timer baseline cuts 68/710 holds (9.58%) but misses nothing (it fires immediately). Smart Turn cuts 33 (4.65%) and misses 27 (6.49%); turn-1-mini cuts 32 (4.51%) and misses 14 (3.37%). So a pure timer is NOT dominated on the miss side — it never misses — and the models' value is entirely on the cutoff side: they cut roughly 0.51× (Smart Turn) and 0.53× (turn-1-mini) fewer real pauses, and in exchange they give up some endpoint certainty (27 and 14 EoT spans that only the timeout caught). A deployment that would rather wait than interrupt should read that trade as: the model buys back pauses at the price of occasionally falling back to the timer, which is exactly the same fallback the baseline uses unconditionally.`

| error type | both models | Smart Turn only | turn-1-mini only | either model | baseline | baseline only | neither |
|---|---|---|---|---|---|---|---|
| false cutoff | 25 | 8 | 7 | 40 | 68 | 28 | 1058 |
| missed end | 2 | 25 | 12 | 39 | 0 | 0 | 1087 |

## Top 10 false cutoffs — smart-turn-v3.2 (merged view)

| # | sampleId | speaker | GT | model said | p_eot at trigger | max p_eot | decision at | GT at | gap (s) | wav sha256 (first 12) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `en__460_78__user_turn_000` | 460_78 | hold | cutoff-model | 0.1312 | 0.9557 | 66300 ms | 68800 ms | 2.5 | 62d395a34c70 |
| 2 | `en__948_9__user_turn_000` | 948_9 | hold | cutoff-model | 0.8548 | 0.9403 | 1600 ms | 3600 ms | 2 | c1c532f8453b |
| 3 | `en__1115_49__user_turn_003` | 1115_49 | hold | cutoff-model | 0.1553 | 0.7581 | 15900 ms | 17800 ms | 1.9 | 68196b3f7883 |
| 4 | `en__829_87__user_turn_004` | 829_87 | hold | cutoff-model | 0.9750 | 0.9870 | 7600 ms | 9000 ms | 1.4 | 57b4c78c5577 |
| 5 | `en__448_63__user_turn_003` | 448_63 | hold | cutoff-model | 0.9523 | 0.9830 | 6900 ms | 8200 ms | 1.3 | 64e72abd5df0 |
| 6 | `en__671_55__user_turn_000` | 671_55 | hold | cutoff-model | 0.6788 | 0.9719 | 33800 ms | 35100 ms | 1.3 | a8671701b219 |
| 7 | `en__209_55__user_turn_000` | 209_55 | hold | cutoff-model | 0.3747 | 0.8688 | 18200 ms | 19300 ms | 1.1 | 395ec38cb297 |
| 8 | `en__607_38__user_turn_001` | 607_38 | hold | cutoff-timeout | 0.0232 | 0.0232 | 8400 ms | 9300 ms | 0.9 | 3b60be7fab4b |
| 9 | `en__1115_49__user_turn_000` | 1115_49 | hold | cutoff-model | 0.9673 | 0.9865 | 11000 ms | 11900 ms | 0.9 | 9d8f65aded20 |
| 10 | `en__287_49__user_turn_002` | 287_49 | hold | cutoff-model | 0.1829 | 0.2960 | 8100 ms | 9000 ms | 0.9 | 2c0ffe30e94c |

Most severe: `en__460_78__user_turn_000` (eot-bench-en, experiments/voice-turn-detection-compare/worst-cases-replay/data/eot-bench-audio/en__460_78__user_turn_000.wav). CONTINUE (the speaker only paused); the model's reading was `cutoff-model` at 66300 ms against a GT time of 68800 ms (gap 2.5 s). Its probability trajectory around the decision cell: 0s→0.131, 0.1s→0.080, 0.2s→0.264, 0.3s→0.393.

To materialize the bytes of any row above in one command: `node experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs --corpus-b` (writes the pinned audio into `data/` and re-verifies every sha256 against the pins recorded in `RESULT.json`).

## Top 10 missed endpoints — smart-turn-v3.2 (merged view)

| # | sampleId | speaker | GT | model said | p_eot at trigger | max p_eot | decision at | GT at | gap (s) | wav sha256 (first 12) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `en__1115_49__user_turn_000` | 1115_49 | eot | miss | 0.0327 | 0.0327 | 23800 ms | 20300 ms | Infinity | 9d8f65aded20 |
| 2 | `en__200_147__user_turn_001` | 200_147 | eot | miss | 0.0411 | 0.0411 | 28700 ms | 25200 ms | Infinity | 4eaf927351a0 |
| 3 | `en__219_75__user_turn_001` | 219_75 | eot | miss | 0.0270 | 0.0270 | 31700 ms | 28200 ms | Infinity | dd8de39f0cf7 |
| 4 | `en__224_147__user_turn_006` | 224_147 | eot | miss | 0.0992 | 0.0992 | 17900 ms | 14400 ms | Infinity | a99af5241fd7 |
| 5 | `en__224_52__user_turn_000` | 224_52 | eot | miss | 0.1065 | 0.1065 | 18300 ms | 14800 ms | Infinity | 9896f8583a10 |
| 6 | `en__234_89__user_turn_000` | 234_89 | eot | miss | 0.0303 | 0.0303 | 43400 ms | 39900 ms | Infinity | 8dd8aa5f4765 |
| 7 | `en__286_19__user_turn_002` | 286_19 | eot | miss | 0.1142 | 0.1142 | 27200 ms | 23700 ms | Infinity | b92297bcd89c |
| 8 | `en__287_49__user_turn_002` | 287_49 | eot | miss | 0.0260 | 0.0260 | 41100 ms | 37600 ms | Infinity | 2c0ffe30e94c |
| 9 | `en__371_24__user_turn_000` | 371_24 | eot | miss | 0.0830 | 0.0830 | 25100 ms | 21600 ms | Infinity | 4c4b5ee8af15 |
| 10 | `en__374_147__user_turn_003` | 374_147 | eot | miss | 0.0214 | 0.0214 | 20000 ms | 16500 ms | Infinity | f8d7f6869648 |

Most severe: `en__1115_49__user_turn_000` (eot-bench-en, experiments/voice-turn-detection-compare/worst-cases-replay/data/eot-bench-audio/en__1115_49__user_turn_000.wav). END (the speaker really finished); the model's reading was `miss` at 23800 ms against a GT time of 20300 ms (gap Infinity s). Its probability trajectory around the decision cell: 0s→0.017, 0.1s→0.033, 0.2s→0.016, 0.3s→0.012, 0.4s→0.012.

To materialize the bytes of any row above in one command: `node experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs --corpus-b` (writes the pinned audio into `data/` and re-verifies every sha256 against the pins recorded in `RESULT.json`).

## Top 10 false cutoffs — turn-1-mini (merged view)

| # | sampleId | speaker | GT | model said | p_eot at trigger | max p_eot | decision at | GT at | gap (s) | wav sha256 (first 12) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `en__460_78__user_turn_000` | 460_78 | hold | cutoff-model | 0.1385 | 0.2118 | 66600 ms | 68800 ms | 2.2 | 62d395a34c70 |
| 2 | `en__1115_49__user_turn_003` | 1115_49 | hold | cutoff-model | 0.1369 | 0.1453 | 15900 ms | 17800 ms | 1.9 | 68196b3f7883 |
| 3 | `en__460_78__user_turn_000` | 460_78 | hold | cutoff-model | 0.1362 | 0.4785 | 53100 ms | 54700 ms | 1.6 | 62d395a34c70 |
| 4 | `en__460_78__user_turn_000` | 460_78 | hold | cutoff-model | 0.1856 | 0.4881 | 6800 ms | 8200 ms | 1.4 | 62d395a34c70 |
| 5 | `en__829_87__user_turn_004` | 829_87 | hold | cutoff-model | 0.1501 | 0.7680 | 7600 ms | 9000 ms | 1.4 | 57b4c78c5577 |
| 6 | `en__671_55__user_turn_000` | 671_55 | hold | cutoff-model | 0.1462 | 0.6748 | 33800 ms | 35100 ms | 1.3 | a8671701b219 |
| 7 | `en__1115_49__user_turn_003` | 1115_49 | hold | cutoff-model | 0.1461 | 0.5075 | 11000 ms | 12200 ms | 1.2 | 68196b3f7883 |
| 8 | `en__209_55__user_turn_000` | 209_55 | hold | cutoff-model | 0.1543 | 0.7161 | 18200 ms | 19300 ms | 1.1 | 395ec38cb297 |
| 9 | `en__607_38__user_turn_001` | 607_38 | hold | cutoff-timeout | 0.0875 | 0.0875 | 8400 ms | 9300 ms | 0.9 | 3b60be7fab4b |
| 10 | `en__1115_49__user_turn_000` | 1115_49 | hold | cutoff-model | 0.1598 | 0.6939 | 11000 ms | 11900 ms | 0.9 | 9d8f65aded20 |

Most severe: `en__460_78__user_turn_000` (eot-bench-en, experiments/voice-turn-detection-compare/worst-cases-replay/data/eot-bench-audio/en__460_78__user_turn_000.wav). CONTINUE (the speaker only paused); the model's reading was `cutoff-model` at 66600 ms against a GT time of 68800 ms (gap 2.2 s). Its probability trajectory around the decision cell: 1s→0.047, 1.1s→0.070, 1.2s→0.100, 1.3s→0.138, 1.4s→0.160, 1.5s→0.212, 1.6s→0.183.

To materialize the bytes of any row above in one command: `node experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs --corpus-b` (writes the pinned audio into `data/` and re-verifies every sha256 against the pins recorded in `RESULT.json`).

## Top 10 missed endpoints — turn-1-mini (merged view)

| # | sampleId | speaker | GT | model said | p_eot at trigger | max p_eot | decision at | GT at | gap (s) | wav sha256 (first 12) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `en__1137_55__user_turn_002` | 1137_55 | eot | miss | 0.1049 | 0.1049 | 4700 ms | 1200 ms | Infinity | 76d59b1736ad |
| 2 | `en__1137_55__user_turn_008` | 1137_55 | eot | miss | 0.0799 | 0.0799 | 5700 ms | 2200 ms | Infinity | d453c31a152d |
| 3 | `en__280_147__user_turn_004` | 280_147 | eot | miss | 0.0695 | 0.0695 | 23200 ms | 19700 ms | Infinity | a636bb50de1d |
| 4 | `en__371_24__user_turn_004` | 371_24 | eot | miss | 0.0845 | 0.0845 | 20200 ms | 16700 ms | Infinity | 32236d744e13 |
| 5 | `en__376_36__user_turn_002` | 376_36 | eot | miss | 0.0950 | 0.0950 | 61500 ms | 58000 ms | Infinity | c97e2ceb0107 |
| 6 | `en__418_55__user_turn_006` | 418_55 | eot | miss | 0.1082 | 0.1082 | 8300 ms | 4800 ms | Infinity | 1d5dbce45c19 |
| 7 | `en__447_20__user_turn_009` | 447_20 | eot | miss | 0.1214 | 0.1214 | 6400 ms | 2900 ms | Infinity | f4682e826f1a |
| 8 | `en__448_63__user_turn_001` | 448_63 | eot | miss | 0.0913 | 0.0913 | 24900 ms | 21400 ms | Infinity | 6e87596d6145 |
| 9 | `en__571_24__user_turn_009` | 571_24 | eot | miss | 0.1007 | 0.1007 | 15600 ms | 12100 ms | Infinity | 25cc466e795e |
| 10 | `en__580_144__user_turn_006` | 580_144 | eot | miss | 0.0669 | 0.0669 | 5100 ms | 1600 ms | Infinity | 66c374611cc6 |

Most severe: `en__1137_55__user_turn_002` (eot-bench-en, experiments/voice-turn-detection-compare/worst-cases-replay/data/eot-bench-audio/en__1137_55__user_turn_002.wav). END (the speaker really finished); the model's reading was `miss` at 4700 ms against a GT time of 1200 ms (gap Infinity s). Its probability trajectory around the decision cell: 1s→0.090, 1.1s→0.074, 1.2s→0.082, 1.3s→0.105, 1.4s→0.098, 1.5s→0.077.

To materialize the bytes of any row above in one command: `node experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs --corpus-b` (writes the pinned audio into `data/` and re-verifies every sha256 against the pins recorded in `RESULT.json`).

## The baseline (threshold=0) is not a strawman

The degenerate policy fires on the first cell of every span — it never consults the model, so it detects every EoT instantly (latency 0, missed 0) and cuts every hold whose pause outlasts `actionDelay`. That is exactly the trade a real VAD/timer makes, and it is the row the models must beat to be worth their cost. The numbers above are the comparison.

## Reproduction

See `README.md`. Short version: `node fetch-and-verify.mjs --all` re-fetches and re-verifies every byte, then `node_modules/.bin/tsx --tsconfig server/tsconfig.json extract-worst-cases.mts --shards 8` re-scores both models and rewrites every file in this directory.

## Reproduction evidence — MEASURED hashes, not assumed agreement (AC1/AC4)

Every row below is a hash this task computed from bytes it fetched, compared against the pin P0.13 locked. `RESULT.json.reproduction` carries the complete machine-readable record (including all 400 corpus-B WAV hashes) — this is the readable digest.

### LibriSpeech corpus A — 16/16 clips, refetched sha256 vs the committed P0.6 manifest value

| sampleId | LibriSpeech row | refetched sha256 | manifest sha256 | bytes | match |
|---|---|---|---|---|---|
| `librispeech-000` | 0 (3.505s) | `746c756a0b428726…` | `746c756a0b428726…` | 112238 | yes |
| `librispeech-001` | 1 (14.225s) | `6d9736c06b09ac23…` | `6d9736c06b09ac23…` | 455278 | yes |
| `librispeech-002` | 2 (5.025s) | `274f9b86e9604ce0…` | `274f9b86e9604ce0…` | 160878 | yes |
| `librispeech-003` | 3 (23.315s) | `ef85df13ab69f32b…` | `ef85df13ab69f32b…` | 746158 | yes |
| `librispeech-004` | 4 (11.065s) | `115228e5a474ac58…` | `115228e5a474ac58…` | 354158 | yes |
| `librispeech-005` | 5 (13.16s) | `0ff13eca813cf682…` | `0ff13eca813cf682…` | 421198 | yes |
| `librispeech-006` | 6 (5.85s) | `83dc37ad130a56f5…` | `83dc37ad130a56f5…` | 187278 | yes |
| `librispeech-007` | 7 (3.315s) | `6cc4df352a4bf4ec…` | `6cc4df352a4bf4ec…` | 106158 | yes |
| `librispeech-008` | 8 (4.785s) | `a29c2cb988253630…` | `a29c2cb988253630…` | 153198 | yes |
| `librispeech-009` | 9 (7.28s) | `cff8e6d895c4dbb6…` | `cff8e6d895c4dbb6…` | 233038 | yes |
| `librispeech-010` | 10 (3.035s) | `c7727e916a3fa86a…` | `c7727e916a3fa86a…` | 97198 | yes |
| `librispeech-011` | 11 (3.195s) | `1c86cdec794cb288…` | `1c86cdec794cb288…` | 102318 | yes |
| `librispeech-013` | 13 (2.94s) | `6b56ade8142254ab…` | `6b56ade8142254ab…` | 94158 | yes |
| `librispeech-014` | 14 (16.84s) | `1b87211aa391e6e8…` | `1b87211aa391e6e8…` | 538958 | yes |
| `librispeech-015` | 15 (6.38s) | `5b24666f42ffc0d6…` | `5b24666f42ffc0d6…` | 204238 | yes |
| `librispeech-016` | 16 (10.015s) | `759382236c1fff28…` | `759382236c1fff28…` | 320558 | yes |

All 16 match: **true**. 21 candidate points came back with them (16 END + 5 CONTINUE), which is the span set P0.13 scored.

### eot-bench corpus B — the pinned parquet and its 400 extracted turns

| artifact | pin | measured | match |
|---|---|---|---|
| parquet sha256 | `e475d435c8e69391…` | `e475d435c8e69391…` | yes |
| parquet bytes | 162406142 | 162406142 | yes |
| WAV files extracted | — | 400 (161326412 bytes, all hashed) | — |

Group/session counts from the fetched manifest, all re-checked in this run: `{"spans":1250,"eotSpans":400,"holdSpans":850,"holdSpansInDenominator":705,"holdSpansDroppedByDuration":145,"denominatorSpans":1105,"groups":96,"defaultGridCells":10901}` — the `groups` count is AC1's speaker/session grouping and is compared against P0.13's published value in the AC5 section above (not merely asserted here), and the denominator split (705 holds in, 145 dropped by duration, 400 EoT) is the one P0.13 published.

### Models — local CPU ONNX, hashes re-verified at run time

| model | repo @ revision | file | pin sha256 | measured sha256 | bytes | match |
|---|---|---|---|---|---|---|
| Smart Turn v3.2 | `pipecat-ai/smart-turn-v3`@`f766f81d` | smart-turn-v3.2-cpu.onnx | `2bb026316b14a660…` | `2bb026316b14a660…` | 8679182 | yes |
| turn-1-mini | `p99lab/turn-1-mini`@`076c86d1` | onnx/turn-1-mini.step.onnx | `e747b182d685c7db…` | `e747b182d685c7db…` | 21825125 | yes |

Python env pinned and checked: `{"p99turn":"1.2.3","onnxruntime":"1.31.0","numpy":"2.5.4","pyarrow":"26.0.0","huggingface_hub":"2.2.0"}` on Python 3.12.3 — all version checks true.

**Training weights: none fetched.** The turn-1-mini repo also holds a `.safetensors` (the torch/training-side artifact, sha256 `d03ccff872eb0ae2…`) — it is recorded here for reference and was deliberately NOT downloaded: `hf_hub_download` was called for `onnx/turn-1-mini.step.onnx` only. Both files actually fetched are inference graphs loaded by onnxruntime on CPU.

### Licences — fetched first-hand, quoted from the source, not paraphrased

| what | status | bytes | sha256 |
|---|---|---|---|
| livekit/eot-bench-data dataset card (carries the CC-BY-4.0 declaration + citation) | 200 | 3251 | `dd8151d673820f58…` |
| CC-BY-4.0 legal code (the corpus licence both corpora are distributed under) | 200 | 18657 | `9ba9550ad48438d0…` |
| LibriSpeech corpus page (OpenSLR SLR12; licence + attribution statement) | 200 | 8245 | `9b012c60f8fe6a54…` |
| p99lab/turn-1-mini LICENSE at the pinned revision | 200 | 11357 | `c71d239df91726fc…` |

Attribution as recorded in the deliverable: **livekit/eot-bench-data (CC-BY-4.0), revision ca9d98a9686b920a2d8c9eb984224ba9be74e4dd — attribution as stated in the dataset card grab above** · **LibriSpeech (c) 2014 by Vassil Panayotov, CC BY 4.0 — audio decoded from the corpus-native FLAC; source openslr/librispeech_asr clean/test**.

### Reused P0.13 scripts — byte-identical copies, so the landed P0.13 paths are never written to

| file | this task (copy) | P0.13 original | byte-identical |
|---|---|---|---|
| fetch-eot-bench-english.py | `844993c47ceee44a…` | `844993c47ceee44a…` | yes |
| run-turn1mini.py | `ed6a2a10ed6647db…` | `ed6a2a10ed6647db…` | yes |
| requirements.txt | `c2ff13d6bfb9d456…` | `c2ff13d6bfb9d456…` | yes |

Egress for the whole task: **huggingface.co`, `datasets-server.huggingface.co`, `creativecommons.org`, `openslr.org** — public corpus/model/card pulls only — no paid endpoint, no API key read.

