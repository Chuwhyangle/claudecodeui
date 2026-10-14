"""Turn one replay run's events.jsonl into a readable, ordered transcript for semantic review.

Usage: python3 -I digest.py <run-dir> [...]
Prints, per run: every final transcription, every function call (with its arguments, complete or
cut off), every model text reply (classified by the item it follows), and errors; then a summary
of mechanical counts. The semantic judgement is made by reading this output, not by this script.
"""

import json
import sys


def digest(run_dir):
    events = [json.loads(line) for line in open(f"{run_dir}/events.jsonl")]
    meta = next(e for e in events if e["kind"] == "meta")
    item_type = {}
    resp_args = {}
    resp_prev = {}
    lines = []
    counts = {"send": 0, "interrupt": 0, "status": 0, "text_after_user": 0, "text_after_output": 0,
              "truncated": 0, "errors": 0, "captions": 0}
    audio_start = next((e["t"] for e in events if e["kind"] == "audio_start"), 0)

    def ts(e):
        return f"{(e['t'] - audio_start) / 1000:7.1f}s"

    for e in events:
        k = e["kind"]
        if k == "caption":
            counts["captions"] += 1
            lines.append(f"{ts(e)}  ASR   {e['text']}")
        elif k == "status":
            lines.append(f"{ts(e)}  ----  status phase={e['phase']} queued={e['items']}")
        elif k == "exec":
            tool = e["tool"]
            counts[{"session_send": "send", "session_interrupt": "interrupt", "session_status": "status"}[tool]] += 1
            lines.append(f"{ts(e)}  CALL  {tool} {json.dumps(e['args'], ensure_ascii=False)}")
        elif k in ("bridge_error", "transport_error"):
            err = e["error"]
            if "TRUNCATED_BY_TURN" in err:
                counts["truncated"] += 1
                lines.append(f"{ts(e)}  CUT   call truncated by turn_detected")
            elif "MODEL_TEXT_REPLY" in err:
                pass  # reported from the wire below, with its predecessor
            else:
                counts["errors"] += 1
                lines.append(f"{ts(e)}  ERR   {err[:160]}")
        elif k == "wire" and e.get("dir") == "received":
            w = e["wire"]
            t = w.get("type")
            if t == "conversation.item.created":
                item = w.get("item", {})
                role = item.get("role") or ""
                item_type[item.get("id")] = item.get("type") + (f"/{role}" if role else "")
                if item.get("type") == "message" and role == "assistant":
                    resp_prev[item.get("id")] = item_type.get(w.get("previous_item_id"), "?")
            elif t == "response.text.done" or t == "response.audio_transcript.done":
                text = (w.get("text") or w.get("transcript") or "").strip()
                if text:
                    prev = resp_prev.get(w.get("item_id"), "?")
                    if prev.startswith("function_call_output"):
                        counts["text_after_output"] += 1
                        lines.append(f"{ts(e)}  ok    {text!r}")
                    else:
                        counts["text_after_user"] += 1
                        lines.append(f"{ts(e)}  TEXT  {text!r}   (follows {prev})")
            elif t == "response.function_call_arguments.done":
                resp_args[w.get("call_id")] = w.get("arguments")
            elif t == "response.done":
                r = w.get("response", {})
                if r.get("status") == "cancelled":
                    for out in r.get("output", []):
                        if out.get("type") == "function_call":
                            lines.append(f"{ts(e)}  cut-args {out.get('name')} {out.get('arguments')!r}")
    done = next((e for e in events if e["kind"] == "done"), {})
    fatal = [e for e in events if e["kind"] == "fatal"]
    print(f"===== {run_dir}  arm={meta['arm']} rep={meta['rep']} tools={meta['tools']} "
          f"cost=¥{done.get('costCny', 0):.3f} {'FATAL' if fatal else ''}")
    for line in lines:
        print(line)
    print("SUMMARY", json.dumps(counts))
    print()


for d in sys.argv[1:]:
    digest(d)
