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

## Runtime knobs: `contextPack` and `spendGuard`

Both Live Voice and one-shot dictation read the deployment's settings file
(`VOICE_REALTIME_SETTINGS_PATH`). Two blocks govern the C2 pack's size and the per-window spend cap:

```json
{
  "contextPack": { "maxRows": 4, "budgetChars": 1200, "rowCapChars": 600 },
  "spendGuard": { "maxCnyPerWindow": 0.05, "windowMs": 30000 }
}
```

| block | field | accepted range | shipped default |
| --- | --- | --- | --- |
| `contextPack` | `maxRows` | 1–12 | 4 |
| `contextPack` | `budgetChars` | 200–4000 | 1200 |
| `contextPack` | `rowCapChars` | 100–2000 | 600 |
| `spendGuard` | `maxCnyPerWindow` | 0.001–10 CNY | 0.05 |
| `spendGuard` | `windowMs` | 5000–60000 ms | 30000 |

**Precedence.** `contextPack`: `environment > settings file > default`, where the escape hatches are
`VOICE_REALTIME_CONTEXT_MAX_ROWS`, `VOICE_REALTIME_CONTEXT_BUDGET_CHARS` and
`VOICE_REALTIME_CONTEXT_ROW_CAP_CHARS`. `spendGuard`: the HTTP diagnosis route's per-run override >
`VOICE_REALTIME_MAX_CNY_PER_30S` > the file > the default; `windowMs` has no environment spelling and
comes from the file (then the default).

**Refusal.** A known field with the wrong type or an out-of-range value refuses the WHOLE block; the
defaults apply and the reason reaches the connection log (`settings: using the built-in prompt — …`)
and `GET /api/voice/runtime-config`'s `warnings`. Unknown keys/sub-keys are ignored. The spend guard
has **no off switch**: `null`/`0` are refused, not obeyed — name a larger positive number to widen it.

**Hot update.** The file is read once per Live Voice connection and per request for
`/api/voice/runtime-config` and `/api/voice/transcribe`. An edit therefore reaches the NEXT connection
and the next request; a session already speaking keeps the reading it connected with (no mid-session
swap). The browser fetches the endpoint during the voice-availability check and caches the effective
values; if the fetch fails it builds with the shipped defaults. The browser — not the file — owns the
hard ceiling (12 rows / 4,000 chars / 2,000 per row); a larger reading is clamped, never obeyed.

**Server-side truncation.** The proxy trims every `context` frame and the one-shot path trims
`hints.context` to the reading that connection/request resolved: the newest rows first, each row
elided head-70% + `…` + tail-30%, oldest rows dropped. The log line names both readings:
`context truncated from=<n> rows/<chars> chars to=<n> rows/<chars> chars`.

## Spend guard

Every Live Voice connection is metered from the `usage` of each `response.done`, priced as in the October 2026 bill
(`estimateRealtimeCostCny`: text in ¥0.0015, audio in ¥0.006, text out ¥0.0045 per 1,000 tokens). The log line
`usage connection total input=… output=… cost~CNY…` shows the running figure. Read bill lines against that log:
the realtime model bills one line per connection, at its end.

**The per-window cap ships at ¥0.05 / 30 s and is ALWAYS armed.** That is a RATE guard, not a cost line: the
observed 30 s windows (147 real connections, 2026-10-11…22) have p50 ¥0.0117, p90 ¥0.0376 and p99 ¥0.0654, so
¥0.05 leaves ~96% of normal connections untouched while the recorded runaway loop (≈¥0.49/min) crosses it several
times over. The normal entry is `spendGuard.maxCnyPerWindow` in the settings file; `VOICE_REALTIME_MAX_CNY_PER_30S`
is the environment escape hatch and the HTTP diagnosis route passes its own per-run override. An explicit value
that is out of range (`abc`, `0`, `-1`, a blank string) is **refused**: the default stays armed and the server logs
a `spend window limit: …` line, because `Number('abc')` is `NaN` and `spent > NaN` is always false — an unvalidated
typo must not disarm the guard. Crossing the cap ends the connection with a `SPEND_LIMIT` error:
`Voice spending guard: this connection used about ¥… in 30 s (limit ¥…), so it was ended. Start Live Voice again to continue.`

There is no default cap on a connection's total or length; `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` is the explicit
opt-in that imposes one. Runaway cost is additionally bounded by `TOOL_LOOP_GUARD`: the bridge refuses a 7th tool
call inside one utterance.

### Real readings from the 2026-10-23 DoD run

Probe: the real server (`npx tsx --tsconfig=server/tsconfig.json server/index.ts`) on port **3917**, isolated
`HOME` and `DATABASE_PATH`, `VOICE_REALTIME_ENDPOINT=ws://127.0.0.1:3918` pointing at an in-process stand-in
upstream that emits `response.done` with `usage(5600,100,30)` (≈¥0.0090) per browser audio frame. The temp settings
file started as `{"contextPack":{"maxRows":2,"budgetChars":400,"rowCapChars":190},"spendGuard":{"maxCnyPerWindow":0.001,"windowMs":30000}}`.

* `GET /api/voice/runtime-config` → `contextPack={"maxRows":2,"budgetChars":400,"rowCapChars":190}`, `source=file`.
* Connection A, a pack built from those values: `context injected chars=381 rows=2 template=file`.
* Connection A, a stale 6-row / 1,271-char frame: `context truncated from=6 rows/1271 chars to=2 rows/381 chars`.
* Edit the same file to `{"contextPack":{"maxRows":4,"budgetChars":1200,"rowCapChars":600},"spendGuard":{"maxCnyPerWindow":0.05,"windowMs":30000}}`:
  * Connection B (new): `context truncated from=6 rows/1271 chars to=4 rows/847 chars` → `context injected chars=847 rows=4`.
  * Connection A (still live): its next frame still reads `context truncated from=6 rows/1271 chars to=2 rows/381 chars` — no mid-session swap.
  * `SPEND_LIMIT` on B: `… used about ¥0.054 in 30 s (limit ¥0.050) …` (6 charged responses; the 7th crossed it).
* Connection A's `SPEND_LIMIT`: `… used about ¥0.009 in 30 s (limit ¥0.001) …` — the file's 0.001, not the default.
* Delete the `spendGuard` block and open connection C: `SPEND_LIMIT: … (limit ¥0.050)` at `cny=0.05391`, i.e. the
  shipped default, with `windowMs=30000`.
* The stand-in upstream's last `session.update` for connection B carried the 4 newest rows and none of the two
  dropped ones.
* The one-shot path's fetch recorder (unit, `voice-realtime-context-and-settings.test.ts`): a 6-row/≈2,000-char
  `hints.context` with `2/400/190` reaches the wire with `SHOT-5` present, `SHOT-0` absent, and the service log
  carries `context truncated from=`.

> **Not implemented, by design.** `docs/proposals/voice-realtime-segmented-relay-SPEC.md` (C5) also asks the window
> limit to widen with the context package: `windowLimit = 0.05 + 0.003 × (package tokens / 1000)`. That scaling is
> **not implemented** — the package size is read per connection inside the proxy while the seams are assembled once
> per connection at the composition root, so it needs a `createTransport` signature change and is its own task. The
> SPEC text stays as the design record.
