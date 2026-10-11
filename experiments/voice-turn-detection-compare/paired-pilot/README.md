# P0.8 — paired realtime-vs-non-realtime pilot

A **minimal** (7-sample) end-to-end pilot for the question P0–P0.7 did *not* answer: can the cheap
chain — `StreamingVad` + silence-wait + non-realtime `qwen3.8-omni-flash` (`tool_choice=auto`) —
replace the incumbent `qwen3.8-omni-flash-realtime` Live Voice Agent?

It **reuses** `experiments/voice-turn-detection-compare/` (the realtime adapter, the shipping
`StreamingVad`); it does **not** expand the turn-detector corpus and does **not** add a detector.
Every tool call is a **dry-run**: neither chain constructs a real executor, and nothing reaches a
Claude Code session.

- **Machine output:** `RESULT.json` (written by the runner; never hand-edited).
- **Human reading, per-example + attribution + verdict:** [`FINDINGS.md`](./FINDINGS.md).
- **Preregistration** (thresholds fixed before the run) and **sample design:** `samples.json`.

## Files

| file | role |
|---|---|
| `samples.json` | the 7 authored scripts + `preregistration` (Go/No-Go thresholds, budget cap, failure taxonomy, the chain-B silence-wait constant). The runner **refuses to start** without the preregistration block and echoes it into `RESULT.json`. |
| `gen-samples.mts` | synthesises each script to `audio/<id>.wav` (msedge-tts). `synth:"natural"` = one TTS pass; `synth:"inject"` = injected pause structure (only the two pause scenarios). Appends a trailing silence the endpoint can fire on; writes `audio/manifest.json` with `speechEndMs` + `sha256`. |
| `run-paired-pilot.mts` | runs both chains per sample, real upstream calls, dry-run sinks, budget guard, per-example rows + summary + Go/No-Go → `RESULT.json`. |
| `FINDINGS.md` | the human reading on top of `RESULT.json`. |
| `audio/` | **generated, git-ignored** (see `.gitignore`). |

## Reproduce

```bash
# 1. audio  (free; TTS, deterministic)
npx tsx --tsconfig server/tsconfig.json \
  experiments/voice-turn-detection-compare/paired-pilot/gen-samples.mts

# 2. the pilot  (real upstream calls — DASHSCOPE_API_KEY required)
npx tsx --tsconfig server/tsconfig.json \
  experiments/voice-turn-detection-compare/paired-pilot/run-paired-pilot.mts

# one sample only:
ONLY=s1-single-command npx tsx --tsconfig server/tsconfig.json \
  experiments/voice-turn-detection-compare/paired-pilot/run-paired-pilot.mts
```

`--tsconfig server/tsconfig.json` is required: the runner imports `src/shared/voiceEndpoint.ts`
through the server's path mapping. Direct runs need `node_modules/.bin` on `PATH`.

## Budget

New real upstream spend is hard-capped at **¥0.05**, set in `samples.json` *before* the run; the
runner aborts before any call that could cross it and records the shortfall. The completed 7-sample
run cost **¥0.0194** (≈¥0.0258 including two pre-run smokes) — within cap, no abort. Priced with the
`qwen3.8-omni-flash-realtime` table as a proxy; the invoice is the authority.

## Verdict

**NO-GO**, driven by the candidate's **latency** (p50 3.1 s / p95 15.5 s end-of-speech → call), not by
its understanding (6/7 correct, correctly silent on the control). The incumbent arm fails correctness
and fires a false action on the control. Full per-example reading and the four-class attribution are in
[`FINDINGS.md`](./FINDINGS.md). **N=7, synthetic, single voice — not generalizable.**
