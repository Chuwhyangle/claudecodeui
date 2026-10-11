# P0.12 — Qwen Realtime timeout / 14 s anomaly: diagnosis conclusion

Task: `gap-voice-turn-detection-p0-12-realtime-timeout-diagnosis`.

**Scope of the claim.** Everything below is about the **upstream `server_vad` automatic endpoint** (the
P0.x *realtime arm*), replayed with `create_response:false`. It is **not** the production segmented
relay (`turn_detection:null` + browser VAD), and none of it generalises to production Live Voice
quality. A timeout here means "the endpoint did not deliver an accepted `speech_stopped` inside the
harness deadline" — nothing more.

## 1. What was missing in P0.7, and what fixes it

P0.7's `predictions[].events` record only `direction:"received"` frames. Verified directly in
`experiments/voice-turn-detection-compare/RESULT.json`: there are **zero sent frames** and **no WS
open/error/close** for any of the 24 sessions, and every session's `usage` is `null`. So from P0.7
alone, "the endpoint stayed silent" cannot be told apart from "our sender stalled", "the socket died",
or "an event arrived and the attribution rule threw it away". P0.7's own `actualSpend` says as much:
`costBasis` = *"a session with `create_response:false` reports no usage and is recorded at 0"* — the
P0.7 spend of ¥0 is *no-usage-recorded*, not *free*.

This task's instrument (`diagnose.mts`) records, per session: the full WS lifecycle (open + handshake
ms, every error, close with code/reason and whether the close was ours), **every sent frame** (the
`session.update` and each `input_audio_buffer.append` with its wall time and byte count, plus first/last
frame type and the measured inter-frame cadence), **every received frame**, the computed deadline, and
the attribution decision for each candidate stop with its accept/reject reason. The raw log is written
both inside `RESULT.json` (`diagnosis.sessions[]`) and, per session, as `sessions.jsonl`.

## 2. Loopback gate (AC1) — the instrument was checked against known truth before it was paid

`loopback.test.mts` drives the **same runner and attribution rule** a paid session uses against a local
fake DashScope endpoint (`loopback-ws.mts`, ephemeral `127.0.0.1`, zero cost), one scenario per class:

| scenario | expected class | asserted |
| --- | --- | --- |
| clean endpoint | `ok` | accepted stop at/before deadline, all frames sent |
| fire after the deadline | `late-beyond-deadline` | the stop IS this candidate's, just late |
| endpoint never narrates | `upstream-no-event` | `stopCount == 0`, socket healthy |
| socket dies mid-stream | `network-ws-failure` | close code 1011 recorded, `deliberate:false`, `framesSent < 20` |
| fire rejected by the window | `attribution-window-rejected` | `stopCount ≥ 1`, `acceptedStopWallMs == null` |

Result: `node_modules/.bin/tsx experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/loopback.test.mts`
→ **exit 0, 6/6 tests pass**. Recorded `loopback.passedAt = 2026-10-11T08:54:43.361Z`, before the paid
run at `2026-10-11T08:55:37.547Z` (`loopbackPrecedesPaid: true` in the artifact). The six tests
(5 scenarios + an "evidence" test asserting the four timeout classes are discriminated by *different
recorded fields*, not one field re-read). No socket left `127.0.0.1` during the loopback.

## 3. Paid paired replay (AC3, AC4)

Four previously-failing configs, chosen from the Proposal's priority list, **audio sha256 and session
params read from the P0.7 artifact and verified equal before any socket opened**
(`allAudioMatches: true`, `allParamsMatch: true`), 2 runs each = **8 sessions**:

| config | ground-truth label | P0.7 status | P0.7 endpoint wait |
| --- | --- | --- | --- |
| `zh-d01-o85#0@400` | hold | ok (**14012 ms** — the 14 s anomaly) | 14012 |
| `librispeech-002#0@800` | eot | timeout (cited as a zero-event stall) | — |
| `librispeech-005#0@400` | hold | timeout | — |
| `librispeech-000#0@400` | eot | timeout (P0.9's "measurement false negative") | — |

Budget: cap **¥0.05** written into the artifact **before** execution (`budget.writtenBeforeExecution:
true`); worst-case per-session estimate ¥0.001103–¥0.001494; abort-on-over-budget implemented and not
triggered (`abortedOverBudget: false`, `status: "completed"`, 8/8 sessions). Run command carried an
explicit timeout; the paid loop persists `RESULT.json` **after every session** so a kill cannot lose
spend or log.

**Spend is reported honestly, not as 0** (AC4): `spend.cny = null`, `spend.basis = "unknown"`,
`upperBoundEstimateCny = 0.010412` (a deliberately pessimistic bound, labelled an estimate). All 8
sessions returned no usage because `create_response:false` produces no `response.done`.

One caveat recorded in the artifact itself (`diagnosis.priorFailedAttempt`): an earlier invocation of
this same run crashed on a scope bug **after** the first session had already been billed and returned.
That one session is counted here as real, unaccounted spend — `accountedInSpendBelow: false`.

## 4. Side-by-side (AC5)

P0.7 values are quoted from its `byLevel` aggregate (12 sessions per level, 6 `hold` + 6 `eot` spans);
the retest values are 4 configs × 2 runs. **The denominators are not the same** — this is a paired
re-check of the same configs, not a rate comparison.

| metric | P0.7 @400 (denom) | P0.7 @800 (denom) | retest (denom) |
| --- | --- | --- | --- |
| sessions / ok / timeout | 12 / 8 / 4 | 12 / 5 / 7 | 8 / 5 / 3 |
| endpoint wait p50 / p90 (ms) | 575 / 604 | 884 / 936 | **1001 / 1991**, max 2367 (n=5 accepted) |
| timeout rate (Wilson 95%) | 4/12 = 0.33 | 7/12 = 0.58 | 3/8 = **0.375 [0.14, 0.69]** |
| false cutoff (`hold`) | 1/6 = 0.167 (at threshold 0.5) | 0/6 = 0 | **3/4 = 0.75 [0.30, 0.95]** |
| missed END (`eot`) | 1/6 = 0.167 | 2/6 = 0.333 | **2/4 = 0.50 [0.15, 0.85]** |

The two columns measure **different levels** and must not be read as the same number: P0.7's
"cutoff"/"missed-END" are about *the detector policy firing over paced points*
(`detector.p_eot` vs `label`), whereas the retest's are about *the endpoint's own VAD event* (did an
accepted `speech_stopped` arrive, and was the span `hold` or `eot`). Both are reported with their
denominators and Wilson intervals for exactly that reason. P0.7's full per-level sweep, including the
whole Pareto frontier with cutoff/missed-END rates and CIs, is carried verbatim in
`pairedReplay.rows[].p07LevelAggregate`.

**Timeout classification (this is the class breakdown AC5 asked for; network failures are excluded
from missed END by construction):**

| class | count | evidence |
| --- | --- | --- |
| network / WS failure | **0** | all 8 sessions opened, handshook, and never errored; closes were ours (`deliberate:true`) |
| upstream no event | **0** | every timed-out session recorded `stopCount ≥ 1` |
| late beyond deadline | **0** | no accepted stop landed after the deadline |
| attribution window rejected | **3** | stop received, not attributed to this candidate |
| **total timeouts** | **3 / 8** | |

No retest session hit the network/WS class, so `labelRates.missedEnd.excludedNetworkFailures = 0`.

## 5. Per-session attribution (AC6)

The 11 P0.7 timeouts + the 14 s anomaly, each with a re-test verdict or an explicit statement of the
missing evidence (`diagnosis.gapAttribution.entries`). **4 retested, 8 evidence-missing.**

**Retested — the mechanism, with timestamps.**

* `librispeech-000#0@400` (eot) — P0.7 timeout, P0.9 called it a *measurement false negative*.
  Retest: **`attribution-window-rejected`** twice. The endpoint **did** fire, both times, one
  `speech_stopped` each, and the rule rejected it as **`before-earliest-possible`, 130 ms and 131 ms
  short** of `onset + silence_duration_ms × 0.9`. The P0.9 label is confirmed by mechanism, not by
  re-assertion: the model's end-detection was ~130 ms early relative to the harness's own tolerance,
  and the harness discarded it as a timeout.
* `zh-d01-o85#0@400` (hold) — P0.7 ok with a **14012 ms** wait (the anomaly). Retest run 1: **ok, 447 ms**
  (5 stops; the 1338 ms fire rejected as `before-earliest-possible`, the 4447 ms fire accepted). The
  14 s wait **did not reproduce** — on this config it looks like a run-to-run stall, not a systematic
  upstream property. Retest run 2: `attribution-window-rejected` (one fire at 1327 ms, rejected 3033 ms
  early as an earlier-silence detection). So the same config can be ok-in-447 ms or rejected, i.e. the
  14 s figure is not a stable endpoint latency.
* `librispeech-005#0@400` (hold) — P0.7 timeout, inferred "upstream-no-event". Retest: **ok both runs**
  (waits 2367 / 1991 ms; two fires each, first rejected before-earliest, second accepted). The P0.7
  stall **did not reproduce**; the endpoint delivered events both times. Note these "ok"s are, by label,
  **false cutoffs** — the endpoint ended a turn the audio had not finished.
* `librispeech-002#0@800` (eot) — P0.7 timeout, cited as a *zero-event stall*. Retest: **ok both runs**
  (waits 935 / 1001 ms, one accepted fire each). The zero-event stall **did not reproduce**; on this
  config the endpoint fired on both attempts.

**Evidence-missing — 8 configs**: `librispeech-000#0@800`, `librispeech-003#0@400`,
`librispeech-003#0@800`, `librispeech-005#0@800`, `librispeech-005#1@800`, `zh-d01-o85#0@800`,
`zh-d01-o85#1@400`, `zh-d01-o85#1@800`. These were not in the 4-config re-test. For each, the missing
log classes are stated explicitly and **no attribution is inferred from them**: P0.7 recorded no sent
frames (so the sending cadence and byte counts cannot be checked) and no WS open/error/close (so a
socket failure cannot be told from a silent endpoint). The received frames themselves are complete — so
a stop is either absent from P0.7's log or absent from the endpoint; there is no third explanation this
data can distinguish.

**Rejection sub-reason, stated precisely.** All three retest rejections were `before-earliest-possible`.
The `interrupted-by-resume` path of the attribution rule was exercised by the loopback's
`attribution-rejected` scenario (asserted `reason =~ /interrupted-by-resume/`) but **not** by the paid
retest; the two sub-reasons are distinct branches and the real data happened to land on the other one.

## 6. Answers the task asked for

- **Is the timeout a model problem, a transport problem, or a measurement problem?** Across the 8
  re-tested sessions: **never transport** (0 WS failures), **never the model staying silent** (0
  upstream-no-event), and **3 of 8 are measurement** — the endpoint fired and the harness's attribution
  window rejected the fire (all as `before-earliest-possible`). The other 5 delivered an accepted stop
  in time.
- **Is the 14 s anomaly real?** It did not reproduce (447 ms on the retest), and the same config also
  produced a *rejected* fire on the other run. Treated as variance on this config, not a stable latency.
- **Is the retest reproducible?** Partly: `librispeech-000#0@400` rejected on both runs and
  `librispeech-002#0@800` succeeded on both — those two agree run-to-run. `zh-d01-o85#0@400` split
  (ok / rejected) — that one does not.

## 7. Honest limits

- n is small (4 configs × 2 runs = 8 sessions). Every rate above is given with its denominator and a
  Wilson 95 % interval because of that.
- 8 of the 12 gap entries are evidence-missing by design (budget/priority), not by success.
- One earlier invocation billed one session whose spend is not in `spend.upperBoundEstimateCny`; it is
  disclosed in `diagnosis.priorFailedAttempt`.
- The true charge is **unknown** (no usage returned), not ¥0; only the ¥0.010412 upper-bound estimate
  is offered, and it is labelled an estimate.
- This is the upstream `server_vad` realtime arm. Nothing here may be extrapolated to the production
  segmented relay.

## Artifacts

- `RESULT.json` — the artifact: budget, guard, audio/param checks, loopback record, the 8 sessions with
  their full logs, `pairedReplay` (side-by-side + class breakdown), `gapAttribution`, spend.
- `sessions.jsonl` — one line per session, the raw per-session log (WS lifecycle, sent, received,
  deadline, attribution).
- `diagnose.mts` — the instrument + orchestrator (`--paid`, `--report`, `--verify`, `--loopback-passed`).
- `loopback-ws.mts` / `loopback.test.mts` — the zero-cost gate.
