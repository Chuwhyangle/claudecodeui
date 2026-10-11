# P0.8 paired pilot — findings (N=7, NOT generalizable)

Machine output is `RESULT.json` (written by `run-paired-pilot.mts`, never hand-edited). This file is
the **human reading** on top of it, per the preregistration (`samples.json → preregistration`): the
mechanical proxy is a filter, the judgement is on the raw tool-call argument shown below.

**Question.** Can the cheap chain — `StreamingVad` + silence-wait + non-realtime `qwen3.8-omni-flash`
(`tool_choice=auto`) — replace the incumbent `qwen3.8-omni-flash-realtime` Live Voice Agent, end to end?

## The two chains, precisely

| | Chain A (incumbent arm) | Chain B (candidate) |
|---|---|---|
| Endpoint | upstream `server_vad` (400 ms) via the shipping DashScope transport, `create_response=true` | shipping `StreamingVad` (400 ms) **+ declared silence-wait 700 ms** → effective end-of-turn silence 1100 ms |
| Model | `qwen3.8-omni-flash-realtime` | `qwen3.8-omni-flash` (non-realtime), one request per committed utterance |
| Delivery | dry-run sink (`{queued:true}`), never delivered | none — no executor exists on chain B |

**Boundary, stated up front.** Chain A is the harness's *realtime arm* (the same one P0–P0.7 used): it
endpoints with the **upstream** `server_vad`. The shipping product instead runs a *segmented* relay
(`voice-realtime-segmented-relay-SPEC.md`): the **browser**'s `StreamingVad` cuts segments and the
bridge closes each upstream with `turn_detection: null`. Both policies endpoint at **400 ms**, so the
*endpoint behaviour* — and therefore the fragmentation finding below — transfers; but chain A is not
byte-for-byte the production relay, and the pilot neither modifies nor invokes it. One of chain A's
per-example artifacts (s1, below) is specific to the `create_response` race that the shipping
transport explicitly guards against, and is labelled as such rather than charged to production.

## Per-example reading (each line is the raw `message` argument, not a summary)

| # | scenario | Chain A (realtime) raw call(s) | Chain B (candidate) raw call | A verdict | B verdict |
|---|---|---|---|---|---|
| s1 | complete-single-command | `session_send{"message": "把 server 里的 voice service` ( **truncated JSON, never closed** ) | `把 server 目录下 voiceService.ts 里的超时时间改成 30 秒。` | fail — unusable payload | **correct** |
| s2 | thinking-pause | ×3: `就是在。` / `那个设置页面。` / `加一个开关。` | `在设置页面加一个开关。` | fail — acted on fragments | **correct** |
| s3 | supplementary-qualifier | ×2: `把默认超时改成30。` / `秒。` | `把 staging 环境配置里的默认超时时间改成 30 秒。` | fail — split mid-token | **correct** |
| s4 | self-correction | `改一下 voiceService.ts，嗯不对，应该是 voiceRoutes.ts。` | `改一下 voice-routes.ts（不是 voice-service.ts）。` | flagged — names the rejected target | flagged — names the rejected target |
| s5 | mixed zh-en terms | `看一下 useVoiceInput 这个 hook 是怎么处理 recording 的` | `看一下 useVoiceInput 这个 hook，说明它是如何处理 recording 状态的…` | **correct** | **correct** |
| s6 | consecutive-commands | `内存不要超过1024兆。` ( **first command dropped** ) | `把限流阈值改成 20 次/分钟，同时把内存上限设置为不超过 1024MB。` | fail — missing action #1 | **correct** |
| s7 | non-address control (**no action expected**) | `这个超时我记得之前好像是三十秒吧？` | *(no call)* — model replied why: "开发者在回忆/自言自语…不调用工具" | **spurious** | **correctly silent** |

Rates (auxiliary only — N=7, do **not** quote as an estimate of field performance):

| | correct | spurious | missed | end→call p50 | end→call p95 |
|---|---|---|---|---|---|
| Chain A | 1/7 | 2/7 | 0/6 | 2446 ms | 5878 ms |
| Chain B | 6/7 | 0/7 | 0/6 | **3103 ms** | **15496 ms** |

## Go / No-Go

**NO-GO** (thresholds fixed before the run; `RESULT.json.gateChecks`). Four gates fail:

1. `keyCasesPassBothChains` — chain A fails s1 (complete-single-command) and s6 (consecutive-commands); s4 fails on both.
2. `chainASpuriousUnderCap` — 2/7 = 0.286 > 0.15.
3. `chainBLatencyP50` — 3103 ms > 3000 ms.
4. `chainBLatencyP95` — 15496 ms > 6000 ms.

The honest answer to the pilot's question is therefore: **the cheap chain is not, as configured, a
drop-in replacement — but it is not rejected for understanding. It is rejected for latency.** Its
per-example understanding is *better* than the incumbent's on this set (6/7 vs 1/7), it is correctly
silent on the control where the incumbent acted, and it does not fire partial actions. Its cost is
time: p50 3.1 s, p95 15.5 s end-of-speech → tool call.

## Failure attribution (the four preregistered classes)

| case | class | concrete basis |
|---|---|---|
| s1 / chain A | **streaming** | the tool-call argument stream was cut mid-JSON (`{"message": "把 server 里的 voice service` — never closed); `response.created: 2` but `function_call_arguments.done: 1`. **Caveat:** this is the `create_response` race the shipping transport guards against, so it is a harness artifact, not a production bug. |
| s2 / chain A | **endpoint** | 4 upstream `speech_stopped`, 3 committed actions — the 400 ms VAD split one hesitation-laden utterance; the incumbent commits an action per fragment. |
| s3 / chain A | **endpoint** | 4 stops, 2 actions, the second split *inside a token* (`改成30。` / `秒。`). |
| s6 / chain A | **endpoint** | 2 stops; only the trailing clause was acted on — the first of two commands was dropped by fragmentation. |
| s7 / chain A | **semantic** | endpoint decided on the trailing silence, but the incumbent did not recognise self-directed musing and fired an action. |
| s4 / both | **actionGate** | both messages narrate the correction and therefore *name the rejected identifier*; the mechanical `forbiddenTokens` rule flags them. **Manual reading: both chains understood the correction** (the final target `voiceRoutes.ts` / `voice-routes.ts` is correct) — the flag is the proxy penalising a faithful pass-through, and there is no correction-grace window in either chain. **This single case is a proxy artifact; the NO-GO does not depend on it** (gate 1 is already failed by chain A on s1/s6, and gates 2–4 are independent). |

Chain B has **no correctness failures** to attribute; its sole gate failure is latency, which is not a
correctness class.

## Why chain B is slow — with evidence

`RESULT.json.rows[].chainB.usage` records `completion_tokens_details.reasoning_tokens` **52–172 per
call** (e.g. s7: 84 reasoning of 108 completion tokens). The latency is dominated by the model's
**default reasoning**, not by the endpoint wait (~670–695 ms, and the audio itself is only ~5–7 s). The
pilot measured the chain **as specified** (the P0.6/P0.7 audio+tools format, no reasoning override); a
reasoning-disabled / reasoning-reduced config was **not** tested and is the first concrete follow-up.

## Cost ledger (hard cap ¥0.05, written before the run)

| run | new upstream spend |
|---|---|
| smoke 1 (s1, pre-final) | ≈ ¥0.0041 |
| smoke 2 (s1, pre-final) | ¥0.00231 |
| **final 7-sample run** (`RESULT.json.budget.spentCny`) | **¥0.019416** |
| **total** | **≈ ¥0.0258** — **within cap**, no abort |

Priced with the `qwen3.8-omni-flash-realtime` table as a proxy (the non-realtime price is not published
in this repo; the invoice is the authority). TTS synthesis is free and does not count.

## Boundaries / limitations (do not over-read)

- **N=7, synthetic, single voice** (msedge-tts `zh-CN-XiaoxiaoNeural`), all `synthetic:true`. No human speaker. Not generalizable.
- **Two samples carry injected pause structure** (s2 thinking-pause, s3 supplementary-qualifier) — the pause is the scenario. The other five are single-pass TTS whose internal pauses are the synthesiser's own prosody.
- Chain A uses the harness's **upstream-VAD** realtime arm, not the shipping **segmented** relay (see boundary above).
- Chain B's `endToCall` for the control sample is excluded (no call ⇒ no latency point).
- One run per sample; no repetition, so no variance estimate.

## Concrete next steps

1. Re-measure chain B with reasoning disabled/reduced — this is the single largest lever on the NO-GO.
2. Run the incumbent arm through the shipping **segmented** relay (browser-VAD + explicit commit) rather than the harness's upstream-VAD arm.
3. Add a **correction-grace window** (Action Gate) so a self-correction resolves to the final target without the rejected one — the one class both chains fail.
