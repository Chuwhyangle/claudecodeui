# Relay-mode replay (2026-10-14)

Question: does turning the realtime model into a pure "pen" (mode a: tidy up and forward everything,
the only choice being send vs interrupt) stop the utterance losses seen in the 2026-10-14 second live
test, and is the closing "OK" response still needed (Q4)? No implementation was changed.

## Method

- `run.mts` replays a real capture (`~/.cloudcli/voice-realtime-capture/<id>.wav`, 16 kHz PCM16) in
  real time through the SHIPPED transport + bridge to the real `qwen3.8-omni-flash-realtime`. The
  executor only records calls and returns the shipped proxy's exact `session_send` result. The original
  journal's `status injected` timeline is replayed into the instructions (header + staleness rule +
  `[exec] …` line), so the model sees "Claude is running" when it originally did.
- Arms: **B** = shipped prompt, 3 tools, closing `response.create`; **A** = mode-a prompt (no
  "call no function" arm; interrupt always carries the user's words), `session_status` removed,
  closing response kept; **AN** = A without the closing response.
- Corpus: the three most recent live sessions `b5d01c21` (10-13 night), `d4c9bfc4` (10-14 morning),
  `e650117b` (10-14 second test). 2 reps × 3 captures × 3 arms = 18 runs, ≈ ¥2.75.
- `digest.py` prints each run as an ordered ASR / CALL / TEXT / CUT transcript; the semantic grading
  was done by reading those against the intended message units of each session (40 units: 17 + 12 + 11).

Usage:

    npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-relay-mode-replay/run.mts \
      --capture e650117b --arm A --rep 1 --out /tmp/relay-mode-replay
    python3 -I experiments/voice-realtime-relay-mode-replay/digest.py /tmp/relay-mode-replay/e650117b-A-r1

## Results (6 runs per arm)

| | B (shipped) | A (mode a) | AN (mode a, no closing OK) |
|---|---|---|---|
| Text replies to the user's speech | 31 | **0** | 6 |
| Message units lost or materially cut | ≈ 22 | **0** | 4 |
| Expected interrupts that were interrupts | 6/10 | **8/10** | 5/10 |
| Interrupts carrying the user's words | 5/6 | **6/6** | 5/5 |
| Truncated calls later completed | most | **all** | most |
| Mean cost per run | ¥0.181 | ¥0.171 | ¥0.104 |

Unchanged across arms: proper nouns and dates in the first sentence garbled (e.g. "Live Voice Mode",
"10月14日" → "2月14日"); systematic over-corrections ("气泡没上去" → "切换没上去", a statement turned
into a question); a call whose response is cancelled after its arguments completed is executed AND
re-sent (duplicate fragment); AN draws `conversation.item.deleted` after nearly every call.

Limits: the status timeline is the original one (an arm's own interrupt does not change it; no
RunDigest fields); two reps only; which units "should" interrupt is a judgement, anchored where
possible on what the person said next (e.g. b5d01c21 "先暂停一下" was later complained about as queued).

## The finalized prompt re-verified on the real upstream (2026-10-14, AC7 of the fix task)

The fix task shipped a finalized prompt text (with `session_status` withdrawn), so the three captures
were replayed once more with `--arm B` — which imports the shipped `VOICE_REALTIME_INSTRUCTIONS`, so
the bytes measured are the shipped bytes — and with the task's own rep name and paths:

    npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-relay-mode-replay/run.mts \
      --capture <id> --arm B --rep verify --out /tmp/relay-mode-replay-verify
    python3 -I experiments/voice-realtime-relay-mode-replay/digest.py /tmp/relay-mode-replay-verify/<id>-B-rverify

SUMMARY lines, verbatim:

    b5d01c21  {"send": 14, "interrupt": 1, "status": 0, "text_after_user": 0, "text_after_output": 10, "truncated": 5, "errors": 9, "captions": 28}
    d4c9bfc4  {"send": 16, "interrupt": 1, "status": 0, "text_after_user": 0, "text_after_output": 12, "truncated": 3, "errors": 2, "captions": 33}
    e650117b  {"send": 21, "interrupt": 1, "status": 0, "text_after_user": 0, "text_after_output": 17, "truncated": 7, "errors": 1, "captions": 52}

`text_after_user` sums to 0 across the three; `status` is 0 in all three. Every `session_interrupt`
call carried `message` (and `intent`); `revision-not-enqueued` appeared in none of the runs.

### Per-unit semantic reading vs each capture's original journal

(Journals `~/.cloudcli/voice-realtime-log/{b5d01c21-3f53-4228-a28e-d18b7cb967f7,
d4c9bfc4-20f8-4bf1-892a-1dc55d2e11a3, e650117b-f0d4-4efd-8253-2390d4f4195d}.jsonl`, read against the
replay's `exec` calls.)

- **b5d01c21 — 1 unit not delivered**: 「先暂停一下，先统计一下这次我到底输入了几段话，识别输出又输出了几段。」 The
  transport reported `CONNECTION_LOST` (willRetry) at 210.0 s and a fresh `session.created` at 210.5 s, and the
  digest carries no transcription at all between 190.6 s and 250.0 s — the audio was never transcribed, so the
  relay never saw it. A control rep of the same capture (`--rep verify-b2`) drew no `CONNECTION_LOST`, transcribed
  the unit at 204.1 s / 208.2 s and delivered it at 208.5 s, with
  `SUMMARY {"send": 17, "interrupt": 1, "status": 0, "text_after_user": 0, "text_after_output": 12, "truncated": 2, "errors": 8, "captions": 31}`
  — the miss is the transport, not the prompt. Everything else delivered (the replay splits some units more
  finely than the journal did).
- **d4c9bfc4 — 无.** All 11 journal units delivered; 「然后再次插话，赶快处理。」 went out as the interrupt, with
  the person's own words as `message`.
- **e650117b — 无**, and the replay delivered two units the original journal never forwarded at all
  (「先不着急立任务，先做完整的调查，分析问题，建议解决方案。」 and 「你看上面这段"分析问题，建议解决方案"又没被处理…」 — the
  production session's last `session_send` is at ≈260 s while the capture runs 349 s).

### The first draft of the finalized text failed this check; the wording was corrected

With the first draft of the finalized prompt the same `--rep verify` command measured `text_after_user`
= 0 / 0 / **4** (e650117b), reproduced exactly on a repeat rep — not a flake; all four followed
`input_audio` user items. An arm-A control on the same capture in the same session measured 0, so the
wording, not the harness, drove them. The clauses that close the gap are arm A's: the relay opens by
saying it tidies the person's words and passes them on rather than taking part ("You are not a
participant."), the pass-on sentence keeps the fragment-joining and the no-paraphrase limit, and the
rule ends by naming the model's only choice as HOW a thing is delivered, never whether. The shipped
text now carries those clauses; the reliability-pass paragraphs from
`gap-voice-busy-preemption-instruction-reliability` were left untouched, and every pinned literal
(AC1/AC2/AC3/D-6) still holds.
