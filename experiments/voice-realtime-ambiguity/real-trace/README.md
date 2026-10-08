# Real DashScope realtime traces (AC-308, real half)

These two files are REAL call records, captured once by a human against
`wss://dashscope.aliyuncs.com` with a live `DASHSCOPE_API_KEY`. They are the
evidence AC-308's real half asks for: a real session/connection id, raw network
latency data, and a model-initiated `function_call` event. Nothing in CI
re-executes them — the criterion replays the preserved JSON instead, and the
false-forms criterion proves the JSON is not reproducible by a fixture.

| File | Model | Purpose |
| --- | --- | --- |
| `function-call-trace.json` | `qwen3.5-omni-flash-realtime` | The AC3 trace: real ids, real latencies, a model-initiated `ui_visible_context` call round-tripped back as `function_call_output`. |
| `named-model-connect.json` | `qwen3-omni-flash-realtime` | Documents the model the GOAL-030 task names: it connects and transcribes real audio, but `session.updated` carries **no `tools`** and it makes no function call. |
| `audio/d05-o65.wav` | — | The real Chinese speech (16 kHz mono PCM16) fed to both sessions, byte-identical to `experiments/voice-provider-paired-quality/fixtures/d05-o65.wav`. |

## The model deviation (recorded, not hidden)

The task and GOAL-030 name `qwen3-omni-flash-realtime`. Live, that model
**accepts the connection and transcribes real audio, but does not support
provider-side function calling**: the `session.updated` reply omits the `tools`
field entirely, and a tool-shaped request is answered in plain text instead of
as a `function_call`. Its trace (`named-model-connect.json`) shows exactly that —
zero function-call events, a real transcript, and a `session.updated` whose keys
are

```
id, object, model, modalities, instructions, voice,
input_audio_format, output_audio_format, input_audio_transcription, turn_detection
```

— no `tools`.

The tool-capable sibling `qwen3.5-omni-flash-realtime` DOES honour `session.tools`
and emitted a real, endpoint-assigned function call:

```
name       ui_visible_context
call_id    call_24b2a41b2cf149848cfec96d
arguments  {}
```

So the transport's `model` is a config option whose default is the task-named
model (`DEFAULT_DASHSCOPE_REALTIME_MODEL`), and a caller that needs function
calling passes `model: 'qwen3.5-omni-flash-realtime'` without a code change. Both
live connections are preserved above so the deviation is auditable rather than
asserted.

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
function-call-trace.json  [2.852, 126.148, 876.64, 87.786, 275.36, 86.804, 1311.523, 240.997, 86.806, 201.37]
named-model-connect.json   [2.626, 178.212, 1216.251, 535.926, 536.621, 1413.633]
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

npx tsx experiments/voice-realtime-ambiguity/real-trace/capture-live.ts \
    --model qwen3.5-omni-flash-realtime --out function-call-trace.json
npx tsx experiments/voice-realtime-ambiguity/real-trace/capture-live.ts \
    --model qwen3-omni-flash-realtime   --out named-model-connect.json
```

The second command exits non-zero and prints a warning — that is the expected
outcome for a model with no provider-side function calling, and its trace is
written regardless.

## Credential hygiene (AC5)

The key travels in the `Authorization` header only — never the URL, never a
frame. `capture-live.ts` never records headers and scrubs any accidental
occurrence of the key from the serialized trace before writing (both captures
report `scrubbed=0`), and refuses to write a trace that mentions `Authorization`
at all. Neither JSON file contains a credential literal; neither is a `.env*`
file.
