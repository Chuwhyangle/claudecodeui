# P0.9 — Staged low-cost Turn Detection feasibility: conclusion

**Task:** `gap-voice-turn-detection-p0-9-staged-cheap-feasibility` · **Date:** 2026-10-11
**Machine readings:** `RESULT.json` (written by `offline-vad-sweep.mts` + `stage2-local-detectors.mts`, never hand-edited).
**Zero new paid calls.** Nothing here made a DashScope WebSocket call or a non-realtime Omni HTTP request.
Stage 1 replays local audio; Stage 2 reads P0.7's *committed* readings. The only execution in Stage 2 is a local
filesystem probe for turn-1-mini.

---

## 口径纠正 (AC1) — exclude/annotate the P0.7-polluted sessions before quoting any baseline

The comparison target is "Qwen Realtime's current observable quality". P0.7's raw streaming block has **11/24
sessions marked `timeout`**. Their class is read off P0.7's *own* recorded evidence (`attribution`), not asserted:

- **2 measurement false-negatives — KEPT clean:** `librispeech-000#0@400`, `librispeech-000#0@800` — the endpoint
  *did* fire (exactly one `speechStopsRelMs`) but the harness could not attribute it (`attributedStoppedRelMs === null`).
- **9 real upstream pollution — DROPPED:** 0 stops (never fired) or ≥2 stops (fragmented):
  `librispeech-002#0@800`, `librispeech-003#0@400/@800`, `librispeech-005#0@400/@800`, `librispeech-005#1@800`,
  `zh-d01-o85#0@800`, `zh-d01-o85#1@400/@800`.
- **1 non-timeout anomaly — ANNOTATED, not silently kept:** `zh-d01-o85#0@400` is `ok` but its onset→stop wait is
  **14012 ms** (>10× every other ok session). Reported both with and without it.

**Denominators, before → after (stated up front, as required):**

| scope | before | after (clean) | dropped | kept-FN |
|---|---|---|---|---|
| overall sessions | 24 | **15** | 9 | 2 |
| level400 | 12 | **9** | 3 | |
| level800 | 12 | **6** | 6 | |

Incumbent clean baseline (n=15 sessions; 11 eots): **end-wait p50 = 604 ms, p90 = 936 ms** (n=9), missed-end 0/11,
false-cutoff 1/4 holds. The polluted small-denominator readings (e.g. @800 n=6) are **not** used as "Realtime's real
quality baseline", and no inverse claim ("pure VAD infeasible from 0/6") is drawn — both sides state their denominator.

---

## Stage 1 (AC2/AC3) — offline replay of the shipping `StreamingVad` on real audio

Corpus: **44 samples / 73 candidate points** (29 within-turn `hold` pauses + 44 `eot`), 46 real spans, the same
P0.6/P0.7 audio. The detector is the **shipping** `src/shared/voiceEndpoint.ts` (`StreamingVad` + `thresholdsFor`),
replayed at each threshold with the same eot-bench sweep P0.7 used — its `VAD@400` point reproduces P0.7's group A
**bit-for-bit** (cutoff 0.068966/29, missed 0.022727/44, lat 0.495455, f1 0.966292). Per-point readings are in
`RESULT.json.stage1.spanReadings`.

| endpoint | false-cutoff (holds) | missed-end (eots) | end-wait p50 / p90 | gate @0.10 |
|---|---|---|---|---|
| 300 ms | 15/29 = 0.517 | 0/44 = 0 | 300 / 460 | fail |
| 400 ms | 10/29 = 0.345 | 1/44 = 0.023 | 400 / 540 | fail |
| 500 ms | 7/29 = 0.241 | 1/44 = 0.023 | 500 / 640 | fail |
| **800 ms** | **2/29 = 0.069** | **3/44 = 0.068** | **800 / 820** | **PASS** |
| 1200 ms | 1/29 = 0.034 | 4/44 = 0.091 | 1200 / 1200 | fail (slower than p90 936) |
| 1500 ms | 0/29 = 0 | 8/44 = 0.182 | 1500 / 1500 | fail (missed-end over budget) |

**Stage-1 conclusion (AC3): a sufficient pure-VAD threshold EXISTS — 800 ms.** It is the only threshold clearing all
three pre-registered bars (cutoff ≤ 0.10, missed-end ≤ 0.10, end-wait p90 820 ms ≤ incumbent clean p90 936 ms).
**It is MARGINAL:** at eot-bench's tighter budgets (0.02, 0.05) **no** threshold passes
(`stage1Gate.budgetSensitivity`). Documented fragility: if the baseline were the as-deployed level-400 p90 of 604 ms
instead of the pooled 936 ms, 800 ms' 820 ms would fail.

---

## Stage 2 (AC4) — the local-detector set, and the quality-loss-vs-latency tradeoff

Triggered because Stage 1 is only marginal (see above); zero-cost — Smart Turn / LiveKit rows are **read** from
P0.7's committed `RESULT.json` (groups B/C), not re-run. Baseline for every Δ is Stage-1's sufficient **VAD@800**
(cutoff 0.068966/29, missed 0.068182/44, end-wait mean 0.877 s).

| detector (best operating point) | cutoff | missed-end | end-wait | model latency | Δcutoff | Δmissed | Δend-wait |
|---|---|---|---|---|---|---|---|
| **VAD@800** (Stage-1 sufficient) | 0.069 | 0.068 | 0.877 s | in-process ≈ 0 | — | — | — |
| Smart Turn v3.2 ONNX (CPU) | 0.103 | 0.023 | 0.186 s | 120.5 (feat) + 41.5 (inf) ≈ 162 ms | **+3.4 pp** | **−4.5 pp** | **−691 ms** |
| LiveKit v1-mini | 0.103 | 0.273 | 0.593 s | 12.3 ms | +3.4 pp | +20.5 pp | −284 ms |
| LiveKit v1-mini (in-budget pick) | 0.069 | 0.795 | 1.261 s | 12.3 ms | 0 pp | +72.7 pp | +384 ms (dominated) |

- **Smart Turn** is the only competitive local model: **−691 ms** end-wait and **−4.5 pp** missed-end for **+3.4 pp**
  cutoff — but its best-F1 point sits **0.34 pp above** the 0.10 cutoff budget, and the only *in-budget* point is the
  degenerate threshold-0.99 row (never fires; missed-end 0.977, F1 0.044). So it does **not** clear the pre-registered bar.
- **LiveKit v1-mini** is unusable as a standalone endpoint here: its framework keeps a **1.2 s ring buffer**, so
  deeper cells score the same audio and its missed-end stays 0.27–0.84. Dominated.
- **turn-1-mini (p99lab, Apache-2.0): 未安装** — mechanically probed: no `node_modules` entry matching `/turn/i`
  (only `smart-buffer`), no importable `turn_detector` / `turn1mini` / `p99lab_turn` Python module, no local checkout
  (the only "turn-1-mini" text hits are comments in the task file and `adapters/livekit-v1-mini.mts`). **No number is
  reported for this row** — it is neither measured nor silently dropped. Probe evidence: `RESULT.json.stage2.detectors[2].evidence`.

---

## Pre-registered gates and Go / No-Go (AC5)

Written **before** reading the sweep (`RESULT.json.stage1Gate.gate`): cutoff ≤ 0.10 **and** missed-end ≤ 0.10 **and**
end-wait p90 ≤ the incumbent's clean p90 (936 ms). Stage-2 adds: a local **model** must clear the same 0.10/0.10
budgets and be no slower than Stage-1's point.

> **GO — for pure VAD, at 800 ms — to unblock the *next, separately-scoped* step.**
> Stage 1 found a sufficient, zero-cost local threshold (800 ms). The pre-registered gate passes, so a **future**
> task may spend on a non-realtime Omni + `tool_call` pilot. This GO is *marginal* (0.10 budget only) and licenses
> **only** that next step — it is not a claim that pure VAD matches the incumbent in the field.

> **NO-GO — scoped, and only scoped, to:** (a) pure VAD at the **0.02 / 0.05** budgets (no threshold passes), and
> (b) the **local detector SET of Smart Turn v3.2 + LiveKit v1-mini + turn-1-mini-未安装** as a budget-clearing
> endpoint (none clears the 0.10 bar).
>
> **This NO-GO does NOT extend** to "stronger endpoint models also fail". It says nothing about a **real/complete
> LiveKit run**, about **non-realtime Omni itself**, or about Smart Turn under a different buffer/feature config —
> those are untested here and must not be claimed infeasible from this result.

---

## Boundaries (do not over-read)

- Candidate points are P0.6/P0.7's existing real audio (LibriSpeech CC-BY-4.0, THCHS-30); **no new samples, no new
  recordings, no new synthesized corpus**. No parallel data pipeline and no generic adapter layer were built — the
  sweep reuses `eot-bench-adapters/{corpus,protocol,run-replay}.mts`.
- Chain A (incumbent) is the harness's **upstream-VAD realtime arm**, not the shipping **segmented** relay; the
  endpoint policy is 400 ms in both, so endpoint behaviour transfers, but the readings are not the production relay.
- Stage-2 model rows are P0.7's committed readings, not fresh runs; the LiveKit row carries P0.7's own ring-buffer caveat.
- **Zero production Live Voice chain changes:** `git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` is empty.
