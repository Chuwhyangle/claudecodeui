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
| **B** bridge | event routing, tolerated vocabulary, captions, stall detection (a stall closes the awaited turn) | `…/voice-realtime-bridge*.test.ts`, `…/voice-realtime-streaming-stages.test.ts` (B1–B4) | same |
| **P** proxy over the REAL transport | ordering, redial mid-stream, busy-session wait and replace, teardown during a wait, truncated calls, error recoverability | `…/voice-realtime-ws-proxy.real-transport.test.ts`, `…/voice-realtime-streaming-stages.test.ts` (P1–P5) | same |
| **R** recorded session replay | a REAL capture (`tests/fixtures/`) produces zero error frames and exactly the heard/sent results | `…/voice-realtime-replay.test.ts` | same |
| **H** HTTP audio upload | an audio file through the same proxy; heard / answered / wire timeline | `…/voice-realtime-diagnose.test.ts`; route `POST /api/voice-realtime/diagnose` | below |
| **S** segmented relay | the segment frame protocol (`segment_start`/`audio{seq}`/`segment_end`) end to end: only speech goes upstream, each `segment_end` commits once *after* its last append, a drop between commit and response replays once, End/Mute flushes the open segment — parameterised over the manual-commit and the server-VAD fallback, with falsifications | `…/voice-realtime-segmented-protocol.test.ts` | one file with `tsx --test` |
| **E** browser e2e (fake upstream) | the page, the bar, the transcript, a real send; an endpoint that goes silent past the stall deadline leaves the spoke turn with an explicit, non-error on-screen outcome | `e2e/voice-realtime-live-session-send.spec.ts`, `e2e/voice-realtime-upload-fixture.spec.ts`, `e2e/voice-realtime-turn-unanswered.spec.ts` | `npx playwright test <file> --workers=1` |
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

# Segmented relay (stage S): the script cuts the WAV HERE with the browser's own relay segmenter
# and sends the pieces as segments, so the HTTP path exercises the segment protocol with no
# browser. Start the server with VOICE_REALTIME_SEGMENT_COMMIT=manual — the route carries only a
# turn list, and it is that switch (the same one a browser's seams throw) that makes the service
# map the turns to segments instead of a plain multi-turn script. The report's per-segment
# seq/duration/ack are printed one line each, and `--json` carries `segments[]` +
# `audioSecondsUpstream` for a recorded fixture.
VOICE_REALTIME_SEGMENT_COMMIT=manual npm run dev        # or export it for `tsx server/index.ts`
node scripts/voice-realtime-diagnose.mjs --url http://127.0.0.1:3001 --token <JWT> \
  --session <sessionId> --wav clip.wav --segments     # one protocol run; add --live to deliver
```

The WAV must be mono 16 kHz 16-bit PCM
(`ffmpeg -i in.mp3 -ac 1 -ar 16000 -c:a pcm_s16le out.wav`). Dry run is the default.
The server also logs every upstream event and every frame sent to the browser, one line each,
prefixed `[voice-realtime <session8>]`.

## Spend guard

Every Live Voice connection is metered from the `usage` of each `response.done`, priced as in the October 2026 bill
(`estimateRealtimeCostCny`: text in ¥0.0015, audio in ¥0.006, text out ¥0.0045 per 1,000 tokens). The log line
`usage connection total input=… output=… cost~CNY…` shows the running figure. Read bill lines against that log:
the realtime model bills one line per connection, at its end.

**The per-30-s window cap is OFF unless it is configured — production sets no default.** `VOICE_REALTIME_MAX_CNY_PER_30S`
names the most a connection may spend inside 30 s. Unset (the shipped state) the assembled `spendGuard` carries **no**
`maxCnyPerWindow` at all, so the window branch can never fire and no connection is ever ended for its rate. Set to a
positive number, crossing it ends the connection with a `SPEND_LIMIT` error: `Voice spending guard: this connection used
about ¥… in 30 s (limit ¥…), so it was ended. Start Live Voice again to continue.` A value that is not a positive number
(`abc`, `0`, `-1`, a blank string) is **refused**: the cap stays off *and* the server logs a `spend window limit: …` line,
because `Number('abc')` is `NaN` and `spent > NaN` is always false — an unvalidated typo would disarm the guard
invisibly. The HTTP diagnosis route passes its own ¥0.05 window for its scripted clip; an override always outranks the
deployment's variable.

Production deliberately names no cap because the window threshold was tight for *normal* tool use, not just for
runaways: a response that re-reads a ~1k-token context and emits ~18 tokens costs about ¥0.0016, so ¥0.015 was roughly
nine responses per 30 s — and every tool round trip is one full context re-read. Runaway cost is covered by
`TOOL_LOOP_GUARD` instead: the bridge refuses a 7th tool call inside one utterance, and resets the count when the user
speaks, which bounds the 2026-10-10 shape (89 calls in a minute) with or without a spend cap.

There is no default cap on a connection's total or length either; `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` is the
explicit opt-in that imposes one.

> **Not implemented, by design.** `docs/proposals/voice-realtime-segmented-relay-SPEC.md` (C5) also asks the window
> limit to widen with the context package: `windowLimit = 0.015 + 0.003 × (package tokens / 1000)`. That scaling is
> **not implemented** — the package size is read per connection inside the proxy while the seams are assembled once at
> boot, so it needs a `createTransport` signature change and is its own task. The SPEC text stays as the design record.
