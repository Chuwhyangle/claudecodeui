# Real DashScope realtime traces (AC-308, real half)

These files are REAL call records, captured once against
`wss://dashscope.aliyuncs.com` with a live `DASHSCOPE_API_KEY`. They are the
evidence AC-308's real half asks for: a real session/connection id, raw network
latency data, and a model-initiated `function_call` event. Nothing in CI
re-executes them — the criterion replays the preserved JSON instead, and the
false-forms criterion proves the JSON is not reproducible by a fixture.

| File | Model | Purpose |
| --- | --- | --- |
| `qwen38-omni-realtime-trace.json` | `qwen3.8-omni-flash-realtime` | **AC9's formal trace** for the adopted target model: real ids, real varied latencies, real audio in, a model-initiated `ui_visible_context` call, and the `function_call_output` backfill resuming the same turn. Uses the required `voice: "Tina"`. |
| `function-call-trace.json` | `qwen3.5-omni-flash-realtime` | The AC3 trace (historical, still valid): real ids, real latencies, a model-initiated `ui_visible_context` call round-tripped back as `function_call_output`. |
| `named-model-connect.json` | `qwen3-omni-flash-realtime` | Documents the models-rejecting historical alias: it connects and transcribes real audio, but `session.updated` carries **no `tools`** and it makes no function call. |
| `audio/d05-o65.wav` | — | The real Chinese speech (16 kHz mono PCM16) fed to every session, byte-identical to `experiments/voice-provider-paired-quality/fixtures/d05-o65.wav`. |

## The adopted target model (2026-10-09 spec correction)

AC-308 originally named `qwen3-omni-flash-realtime`. Live, that alias **accepts
the connection and transcribes real audio, but does not support provider-side
function calling**: `session.updated` omits `tools` entirely, and a tool-shaped
request is answered in plain text. Its trace (`named-model-connect.json`) is kept
as the record of that reading — zero function-call events, a real transcript, and
a `session.updated` whose keys are

```
id, object, model, modalities, instructions, voice,
input_audio_format, output_audio_format, input_audio_transcription, turn_detection
```

— no `tools`.

The formally adopted target is now **`qwen3.8-omni-flash-realtime`** (the
shipping `DEFAULT_DASHSCOPE_REALTIME_MODEL`). It honours `session.tools` (all six
declared tools echoed), emits a real endpoint-assigned `function_call`, accepts the
`function_call_output` backfill, and continues the same turn — all visible in
`qwen38-omni-realtime-trace.json`.

### The `voice: "Tina"` constraint

`qwen3.8-omni-flash-realtime` requires an **explicit `voice: "Tina"`** in its
`session.update`; the trace records it two ways — the top-level `voice` field and
the `session.update` frame's `session.voice`. The transport carries it as a
first-class `voice` option (`DEFAULT_DASHSCOPE_REALTIME_VOICE`), and
`capture-live.ts` takes `--voice`.

## Known limitation (AC-308 AC11) — NOT a bug

`tool_choice: required` (and DashScope's equivalent setting) does **not** guarantee
the model calls a tool on every turn — the model may answer in text instead. This
is a property of the endpoint, not a defect to fix here. It must NOT be worked
around by feeding this harness only inputs that always trigger a call: the live
trace's `functionCalls[]` is whatever the model actually chose, and
`capture-live.ts` exits non-zero rather than retry-until-it-calls. The register
lives in the transport module's header (`voice-realtime-dashscope-transport.ts`,
"KNOWN LIMITATION") and is repeated here.

## Inbound call validation (AC-308 AC10)

The transport records the tools its `session.update` advertised and rejects an
inbound `function_call` that names an unadvertised tool (`UNDECLARED_TOOL`) or
violates a declared parameter shape (`TOOL_ARGUMENT_SCHEMA_VIOLATION`) — both
reported through `onError`, never routed to the executor. `qwen38-omni-realtime-trace.json`
is live evidence the check does not disturb a legitimate call (`ui_visible_context`,
arguments `{}`, which conforms).

## A real endpoint nuance worth recording

The 3.8 capture also drew one endpoint `error` frame — `"Conversation already has
an active response"` — when the harness issued its own `response.create` while the
server's VAD-driven response was still open. It is not a transport defect and the
model continued the same turn anyway (the `function_call_output` backfill landed,
and a later `response.created` followed it); it is preserved verbatim in the trace
so the record stays honest.

Every trace keeps its connection alive long enough to observe the model's call,
and none is cherry-picked to guarantee one: `capture-live.ts` records whatever the
model chose and exits non-zero rather than retry (see the AC11 register above).

## What each trace contains

`exchange[]` is the whole wire record in order. Each entry is
`{ direction, atMs, sinceOpenMs, wire }`, `direction` from the transport's point
of view. The frames are the SHIPPING transport's own output (driven by
`capture-live.ts` through the real bridge), except a single `conversation.item.create`
text turn + `response.create` that the bridge's message set cannot express and
the capture appends raw — both recorded the same way.

`latenciesMs[]` are real round trips in milliseconds, each pairing a sent request
with the response type it actually expects (`session.update` → `session.updated`,
`conversation.item.create` → `conversation.item.created`, `response.create` →
`response.created`, `input_audio_buffer.append` → `input_audio_buffer.committed`).
They are measured on a monotonic microsecond clock, so none is a mis-paired zero:

```
qwen38-omni-realtime-trace.json  [2.189, 149.739, 779.11, 8.06, 1247.671, 589.89, 87.827, 273.858]
function-call-trace.json         [2.852, 126.148, 876.64, 87.786, 275.36, 86.804, 1311.523, 240.997, 86.806, 201.37]
named-model-connect.json         [2.626, 178.212, 1216.251, 535.926, 536.621, 1413.633]
```

`functionCalls[]` lists the calls the MODEL decided to make (`source: "model"`).
A call id is endpoint-assigned and never appears in any client frame, so a call
cannot be a scripted stand-in.

The one large client frame — the ~316 kB `input_audio_buffer.append` — keeps its
type and gains `audioBytes` (the decoded PCM length) but its base64 payload is
replaced by an elision marker: the exact bytes are `audio/d05-o65.wav`, so
nothing is lost and the trace stays ~55 kB instead of ~470 kB. Every other frame
is byte-exact as it crossed the socket.

## Regenerating

```bash
set -a; source /data/home/yale/work/claudecodeui/.env.test; set +a
export PATH="$PWD/node_modules/.bin:$PATH"

# The adopted target model — REQUIRES an explicit --voice Tina.
npx tsx experiments/voice-realtime-ambiguity/real-trace/capture-live.ts \
    --model qwen3.8-omni-flash-realtime --voice Tina --out qwen38-omni-realtime-trace.json
# The historical tool-capable sibling (default model).
npx tsx experiments/voice-realtime-ambiguity/real-trace/capture-live.ts \
    --model qwen3.5-omni-flash-realtime --out function-call-trace.json
# The tools-rejecting alias — exits non-zero by design.
npx tsx experiments/voice-realtime-ambiguity/real-trace/capture-live.ts \
    --model qwen3-omni-flash-realtime   --out named-model-connect.json
```

The third command exits non-zero and prints a warning — that is the expected
outcome for a model with no provider-side function calling, and its trace is
written regardless. Any command also exits non-zero when the model simply chose
not to call a tool within the window (the AC11 non-guarantee); the trace is still
written, unretried.

## Credential hygiene (AC5)

The key travels in the `Authorization` header only — never the URL, never a
frame. `capture-live.ts` never records headers and scrubs any accidental
occurrence of the key from the serialized trace before writing (every capture
reports `scrubbed=0`), and refuses to write a trace that mentions `Authorization`
at all. None of the JSON files contains a credential literal; none is a `.env*`
file.
