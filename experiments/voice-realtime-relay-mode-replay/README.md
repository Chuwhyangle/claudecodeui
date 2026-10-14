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
