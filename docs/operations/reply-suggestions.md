# Reply suggestions (model-generated composer chips)

The reply-suggestions backend drafts up to three complete replies to the last
assistant message and hands them to the composer as chips. Clicking a chip fills
the input; it never sends. The feature is **off by default**, because a draw sends
the tail of the conversation to an external LLM gateway.

Generation goes straight to the gateway over HTTP (Anthropic Messages or OpenAI
Chat Completions). It does **not** go through Claude Code, Codex or an Agent SDK:
those would write a transcript and appear in the sidebar.

## Files

| Path | Role |
|---|---|
| `config/reply-suggestions.settings.example.json` | Tracked template. Contains defaults and no secret. |
| `config/reply-suggestions.settings.json` | Development copy. Git-ignored; mode `600`. |
| `~/.config/claudecodeui/reply-suggestions.settings.json` | Default local copy an installed deployment reads when `REPLY_SUGGESTIONS_SETTINGS_PATH` is unset. |
| `~/.cloudcli/reply-suggestions-usage.jsonl` | Local-only usage ledger (`usageLog`). |

The **only** environment entry is `REPLY_SUGGESTIONS_SETTINGS_PATH`, which names
the settings file. Every knob lives in the file itself. If the named path does
not exist the server reports a problem and the feature stays off; if the default
path does not exist that is the ordinary off state and is not a problem.

## Module layout

The backend lives in `server/modules/reply-suggestions/`, split by
responsibility. The file format above stays flat; the settings are grouped only
in memory, and the key travels as an opaque credential (`JSON.stringify`,
`util.inspect` and `toString` all answer `[redacted]`).

| File | Role |
|---|---|
| `index.ts` | Barrel; the only entry point for other modules. |
| `reply-suggestions.module.ts` | Composition root: builds the settings reader and the usage-ledger writer, hands both to the service, mounts the routes. |
| `reply-suggestions.routes.ts` | HTTP face; parses transport input and calls one service method. |
| `reply-suggestions.service.ts` | Orchestration: per-session draw/cache decisions and ledger rows. |
| `reply-suggestions-draw.ts` | One draw: request assembly, first call, the single supplement. |
| `reply-suggestions-guard.ts` | Circuit breaker and the one-minute/one-day call caps. |
| `reply-suggestions-draw-store.ts` | Per-session draw state, 200-key batch cache, in-flight coalescing. |
| `reply-suggestions-prompts.ts` | Built-in and user prompt construction. |
| `reply-suggestions-chips.ts` | Answer parsing, clipping, de-duplication and near-duplicate filtering. |
| `reply-suggestions-settings.ts` | Settings file reader, grouped reading and the opaque `ApiCredential`. |
| `reply-suggestions-client.ts` | Direct-HTTP client for the two wire dialects. |
| `reply-suggestions-usage-log.ts` | Typed JSONL ledger rows and the bounded, rotating writer. |

The file is re-read whenever its modification time changes, so switching the
protocol/model/gateway needs no restart. An unreadable or malformed file never
prevents the server from starting.

## Keys

`version` — a non-empty string logged beside every extraction, so an edit is
visible.

`enabled` — master switch (`false` by default). When true, `baseUrl`, `model`
and a resolved key are all required; a missing one reads as disabled and is
named in the reported problems.

`protocol` — `anthropic` or `openai`.

`baseUrl` — gateway root. A value already ending in `/v1` is not given a second
`/v1`; trailing slashes are tolerated.

`model` — model name sent upstream.

`authScheme` — `""` (protocol default), `x-api-key` or `bearer`. Empty means
`x-api-key` for anthropic and `bearer` for openai.

`apiKeyFile` — path to the key file; a leading `~` is expanded. The file is
either one bare key line or a shell-style table (`NAME=value`, optional
`export`, one pair of single or double quotes allowed). The key is read into
memory only when the file is (re)parsed. It is never written to a log, an error
message, `/status` or a `problems` entry. A mode wider than `600` (for example
`644`) is reported as a problem but is not fatal.

`apiKeyVar` — with a key file holding several assignments, the variable to take.
Empty means: the file's only assignment if there is exactly one, otherwise the
first non-empty line.

`disableThinking` — send `thinking: {"type":"disabled"}` on both protocols
(`true` by default). The gateway accepts this; it roughly halves latency and
output tokens without lowering suggestion quality.

`temperature` — first-draw sampling temperature (0–2, default `0.3`).

`redrawTemperature` — redraw sampling temperature (0–2, default `1.0`); a higher
value produces fewer near-duplicates.

`maxOutputTokens` — `max_tokens` sent upstream (1–8192, default `400`).

`timeoutMs` — per-request timeout in milliseconds (1–120000, default `5000`).

`maxChips` — maximum chips in one draw (1–10, default `3`).

`maxChipChars` — each chip is clipped to this many characters (1–2000, default
`120`).

`maxTailChars` — trailing characters of the last assistant message sent upstream
(1–100000, default `1500`).

`maxFocusChars` — characters of client-selected text used as focus (0–100000,
default `600`). A longer selection is clipped, not rejected.

`maxCallsPerMinute`, `maxCallsPerDay` — sliding-window upstream call caps
(defaults `30` / `3000`). Over a cap answers `429`.

`expansion` — `off` or `vary`. With `vary`, picking a model chip asks for
**variants** of that reply instead of sending it, and quoting a passage asks for
**responses** to it; both arrive as dashed chips under the textarea and replace
the body when clicked (a `> quoted` block is kept). `vary` also uses
`redrawTemperature`, because genuine rewording is the point. Default `off`: an
`expand` request is then refused `400` before any upstream call, and the
composer behaves exactly as it did before the experiment.

`usageLog` — write the local-only JSONL ledger (`true` by default). The ledger
holds the server's `shown` rows and the client's `picked` / `cleared` /
`redrawn` / `sent` events. Every `shown` row carries `served`: `"upstream"` when
the batch came from a real model call, `"cache"` when the service answered from
the batch cache. Both are displays; only `"upstream"` rows are paid calls. Rows
written before `served` existed have no such field and must be read as
`"upstream"`. The text a person finally sends is not stored; it can be recovered
from the session transcript. Rotation: a file that would exceed 5 MB is renamed
to `<file>.1`, discarding the older `.1`.

`systemPrompt` — empty uses the built-in prompt; a non-empty string replaces it
whole.

Unknown keys (including every `_`-prefixed key in the template) are ignored.
A known key with an invalid value falls back to its default and is named in the
reported problems.

## HTTP API

All routes are mounted under `/api/reply-suggestions` behind the normal bearer
authentication.

`GET /status` → `{ enabled, expansion, maxChips, maxChipChars }`. No key and no
path is exposed. `enabled` is the effective switch (a misconfigured file reads
`false`).

`POST /` with `{ sessionId, redraw?, focus?, seed?, expand? }` → `{ chips: string[], draw: number }`.

- The assistant text is read on the server from the injected transcript reader;
  the client never supplies it.
- The server takes the last `maxTailChars` characters and remembers the chips it
  already showed for that session and that assistant message id.
- `redraw: true` uses `redrawTemperature` and writes up to the last 12 shown
  chips into the prompt as "do not repeat".
- Results are exactly de-duplicated after normalisation, and chips whose
  character-set overlap with an already-shown chip is `>= 0.7` are filtered. If
  fewer than two chips survive, the server supplements exactly once.
- Only chips new in this draw are returned; `draw` increments per extraction.
- Identical concurrent requests (same session, message, redraw flag and focus)
  share one upstream call.
- No assistant message → `{ chips: [], draw: 0 }` with no upstream call.

### One message, one upstream draw (the batch cache)

The batch last returned for a conversation is cached in the server's memory, so
a second look at the same assistant message is free. The key is **session id +
last assistant message id + settings `version`**: editing the settings file
(switching model or prompt bumps `version`) retires the old entries naturally.

- A non-redraw, non-expand request whose key is cached returns that same
  `{ chips, draw }` unchanged: **no upstream call, no `draw` increment, and no
  consumption of `maxCallsPerMinute` / `maxCallsPerDay` or the circuit-breaker
  counters**.
- `redraw: true` still calls upstream (that is what the person asked for) and
  replaces the cached batch with the new one.
- An expansion request (`expand: true`, with `seed` or `focus`) neither reads nor
  writes this cache: it is anchored on the draft, not on the message.
- An upstream failure, an unparseable answer and an empty batch are never
  cached, so the next request tries again.
- The cache holds the **200 most recently used keys** and has **no time
  expiry**; past the bound the least-recently-used key is evicted and draws
  again. A restart empties it, so the first visit afterwards draws once. This is
  bounded by count, not by time, precisely so an old-but-still-open conversation
  does not re-bill the model.
- Identical concurrent requests are still coalesced into one upstream call.

A message therefore costs **1 first draw + as many redraws as the person presses
Suggest**, instead of one call per visit. The browser also keeps its own
20-key in-memory table of batch → chips for the same key, so switching away and
back (or remounting the composer) restores the batch without even the HTTP
round-trip; a page reload loses that table and falls through to the server
cache, which still makes no model call.

### Expansion (`expand: true`)

`expand: true` marks the experimental post-pick draw. It is only accepted when
`expansion` is `vary`; otherwise the server answers `400`
(`REPLY_SUGGESTIONS_EXPANSION_DISABLED`) and makes no upstream call. Without
`expand`, a `seed` is a `400` too — `seed` only has meaning as an expansion
anchor. An expansion needs at least one of `seed` / `focus`.

- `seed` — the reply the person already picked. It is clipped to `maxChipChars`
  and the prompt asks for 2–3 **variants** that keep its decision and intent and
  differ only in wording or detail. The seed counts as already shown for this
  draw: an answer identical to it, or with character-set overlap `>= 0.7`, is
  filtered before it reaches the person.
- `focus` with an empty `seed` — the passage the person quoted. The prompt asks
  for 2–3 **responses** to that passage.
- Expansion draws share the de-duplication, call caps, circuit breaker and
  supplement-once behaviour of an ordinary draw. Their usage row carries
  `expansion: "seed" | "focus"`; neither the seed nor the focus text is copied
  into the ledger.
- The client caps a chain at five expansion requests; the cap is a frontend
  constant, not a server setting, so a direct API caller may ask for more.

`POST /events` with `{ sessionId, draw, event, index?, source? }` → `204`.
`event` is `picked`, `cleared`, `redrawn` or `sent`; `index` is the chip's index
when applicable, and `source` is `seed` or `focus` when the picked chip came from
an expansion draw. Appends one line to the usage ledger.

Errors: malformed request `400`; unknown session `404` (the injected reader's
`AppError` passes through); feature off `503`; over a call cap `429`; upstream
failure `502`.

## Parsing, logging, protection

The model answer may be `{"chips":[...]}`, a bare array, or either wrapped in a
``` fence. Every element must be a string; empty strings are dropped, chips are
clipped to `maxChipChars`, exact duplicates are removed and the list is capped
at `maxChips`. An answer with no usable chip is an upstream failure (`502`).

One log line per upstream call records only protocol, model, settings version,
duration, outcome and the token counts the gateway reported. It never contains
conversation text, chip text or the key.

The usage ledger's `shown` rows additionally record `served` (`"upstream"` or
`"cache"`; see the `usageLog` key above). A cache hit writes a `shown` row with
the cached `chips` and `draw` and no upstream log line, so the ledger separates
"how many times a batch was displayed" from "how many times the model was
actually called".

Protection: sliding one-minute and one-day call caps; **five consecutive
upstream failures open a 30-second circuit breaker** (constants in
`reply-suggestions-guard.ts`); every attempt is bounded by `timeoutMs`. A cache
hit never enters the guard, so it spends no call budget and moves no breaker
state.

## Limitations

- Near-duplicate detection is character-set overlap; a semantic rewrite can
  still slip through.
- The gateway's price is not modelled locally; cost is reported as token counts
  only.
- The experimental `expansion: "vary"` behaviour is off by default and exists
  only to try the interaction; the offline data does not show it beats drawing
  again. Its chain cap (5) lives in the frontend, so it is not enforced for a
  direct API caller.
