# Live Voice — prompt probe

`prompt-probe.mts` sends fixed utterances (as text turns, no audio) to the real
`qwen3.8-omni-flash-realtime` under two instruction variants and counts how often the model calls
`session_send`. Recorded 2026-10-09, 2 runs per utterance, 6 utterances:

| Variant | `session_send` called | Behaviour |
| --- | --- | --- |
| A — "…when the user asks for something to be done… do not call it to answer questions you can answer yourself" (the original) | 7 / 12 | answered questions and remarks itself in text (never shown to the user) and rewrote the instruction |
| B — relay everything, verbatim, never reply in text (shipped) | 12 / 12 | message equals what was said |

Run: `set -a; . ./.env.test; set +a; npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-prompt/prompt-probe.mts`
