# Recorded upstream sessions

`real-run-qwen38-four-utterances.json` — every `received` frame (audio deltas are not present in a
text-modality session) from ONE real session with `qwen3.8-omni-flash-realtime`, recorded on
2026-10-09 by feeding `experiments/voice-trim/fixtures/zh-d01-o85.wav` (a 12 s Chinese dictation
with pauses) through the shipping transport at real-time pace: `[{ atMs, wire }]`.

It holds five final transcriptions and four `session_send` function calls (some of them fragments —
the model reacts to every VAD segment), plus the full lifecycle chatter the endpoint emits
(`session.created/updated`, `conversation.item.created`, `input_audio_buffer.*`, `response.*`).

Replayed by `voice-realtime-replay.test.ts`. Re-record with the probe described in that file's
header; do not hand-edit — the value of the fixture is that nobody wrote it.
