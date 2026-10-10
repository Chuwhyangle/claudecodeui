# Live Voice — test stages

Live Voice is a **stream**: audio goes up continuously, events come back on their own
schedule, and they may stop coming. A green end-to-end run says little; the cases that broke in
production (a schema the model could not satisfy, an unhandled event, a session that was busy,
an upstream that went quiet) each live in ONE stage. So test bottom-up: a stage is only worth
running once the one below it is green, and a red integration run is first reproduced at the
lowest stage that can show it.

| Stage | What it proves | Where | Run |
| --- | --- | --- | --- |
| **C** browser hook | frame queue across the handshake, PCM16 encoding (16 k / 48 k), mute, caption replacement, recoverable vs fatal errors, teardown | `src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` | `npx vitest run <file>` |
| **T** transport | DashScope frame mapping, argument-schema validation, `session.update` body (voice) | `server/modules/voice-realtime/tests/voice-realtime-dashscope-transport*.test.ts` | one file with `tsx --test` |
| **B** bridge | event routing, tolerated vocabulary, captions, stall detection | `…/voice-realtime-bridge*.test.ts`, `…/voice-realtime-streaming-stages.test.ts` (B1–B3) | same |
| **P** proxy over the REAL transport | ordering, redial mid-stream, busy-session wait and replace, teardown during a wait, truncated calls, error recoverability | `…/voice-realtime-ws-proxy.real-transport.test.ts`, `…/voice-realtime-streaming-stages.test.ts` (P1–P5) | same |
| **R** recorded session replay | a REAL capture (`tests/fixtures/`) produces zero error frames and exactly the heard/sent results | `…/voice-realtime-replay.test.ts` | same |
| **H** HTTP audio upload | an audio file through the same proxy; heard / answered / wire timeline | `…/voice-realtime-diagnose.test.ts`; route `POST /api/voice-realtime/diagnose` | below |
| **E** browser e2e (fake upstream) | the page, the bar, the transcript, a real send | `e2e/voice-realtime-live-session-send.spec.ts`, `e2e/voice-realtime-upload-fixture.spec.ts` | `npx playwright test <file> --workers=1` |
| **L** live contract (real upstream) | the real endpoint, the real key, the deployed build | `scripts/voice-realtime-diagnose.mjs --repeat N` | below |

Never run a multi-file `--test` fan-out or the full suite from a session (see AGENTS.md); run the
stage files one by one, or a glob under `scripts/with-memory-cap.sh`.

## Reading a failure

* Red in **C/T/B/P/R** — a code defect; the test name says which rule.
* Green through **R** and red in **H/L** — the upstream behaved in a way no recording has shown yet.
  Record it (see `tests/fixtures/README.md`), add it to **R**, then fix.
* **L** is a rate, not a verdict. The real upstream's connect time varies 0.2–9 s and it
  occasionally stalls after `speech_started`; a single run proves nothing either way.

## Stage H / L from the command line

```
node scripts/voice-realtime-diagnose.mjs --url http://127.0.0.1:3001 --token <JWT> \
  --session <sessionId> --wav clip.wav                # one run, dry (nothing is sent to the session)
node scripts/voice-realtime-diagnose.mjs … --repeat 8 --min-ok 6   # contract: pass rate over 8 runs
node scripts/voice-realtime-diagnose.mjs … --live     # deliver the model's session_send for real
```

The WAV must be mono 16 kHz 16-bit PCM
(`ffmpeg -i in.mp3 -ac 1 -ar 16000 -c:a pcm_s16le out.wav`). Dry run is the default.
The server also logs every upstream event and every frame sent to the browser, one line each,
prefixed `[voice-realtime <session8>]`.

## Spend guard

Every Live Voice connection is metered from the `usage` of each `response.done`, priced as in the October 2026 bill
(`estimateRealtimeCostCny`: text in ¥0.0015, audio in ¥0.006, text out ¥0.0045 per 1,000 tokens). A connection
is ended with a `SPEND_LIMIT` error when it spends more than `VOICE_REALTIME_MAX_CNY_PER_30S` (default ¥0.015)
inside 30 s. There is no default cap on a connection's total or length; `VOICE_REALTIME_MAX_CNY_PER_CONNECTION`
can impose one. The log line
`usage connection total input=… output=… cost~CNY…` shows the running figure; the diagnose route uses a ¥0.05 window.
Read bill lines against that log: the realtime model bills one line per connection, at its end.
