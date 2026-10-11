#!/usr/bin/env python3
"""P0.13 corpus B — fetch the English eot-bench validation split at a pinned revision and extract a
bounded, replayable per-turn WAV set plus a span manifest.

Everything about the labelling mirrors livekit/eot-bench's own harness (`eot_bench/io.py` +
`eot_bench/metrics.py`) so the two models can be scored on the *same* span denominator:

  · a silence span is scored iff `end - start >= min_silence_span` (default 0.1 s);
  · the *last* silence span of a turn is the true END point (`label == "eot"`), every earlier one is a
    pause (`label == "hold"`);
  · a causal read at offset `d` into a span sees the audio `array[0 : floor((start + d) * sr)]`;
  · the hold denominator is filtered to `0.2 s <= dur <= 5.0 s` (eot spans are never filtered).

Outputs (all under the gitignored `data/`):
  data/eot-bench-audio/<id>.wav           16 kHz mono s16le, one file per turn (the raw clip);
  data/eot-bench-en-manifest.json         provenance + the canonical span table.

The parquet is re-fetchable: revision + sha256 are pinned below and re-verified on every run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
import wave
from typing import Any

DATASET = "livekit/eot-bench-data"
# Pinned 2026-07-22 (HF API `lastModified`); license cc-by-4.0 per the dataset card.
REVISION = "ca9d98a9686b920a2d8c9eb984224ba9be74e4dd"
LICENSE = "CC-BY-4.0"
SPLIT_FILE = "data/en/validation-00000-of-00001.parquet"
PARQUET_SHA256 = "e475d435c8e693912243e8a810bf7e34a59e01e208551ce5b362c9c778b0fdc4"
PARQUET_BYTES = 162406142

# eot-bench defaults (eot_bench/io.py, eot_bench/metrics.py).
INFERENCE_INTERVAL = 0.1
MIN_SILENCE_SPAN = 0.1
HOLD_MIN_DUR = 0.2
HOLD_MAX_DUR = 5.0
EPS = 1e-9


def resolve_url(revision: str) -> str:
    return f"https://huggingface.co/datasets/{DATASET}/resolve/{revision}/{SPLIT_FILE}"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def download(url: str, dest: str) -> None:
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "quay-p0-13/1.0"})
    with urllib.request.urlopen(req) as resp, open(tmp, "wb") as out:  # noqa: S310 (pinned host)
        total = resp.headers.get("Content-Length")
        seen = 0
        while True:
            block = resp.read(1 << 20)
            if not block:
                break
            out.write(block)
            seen += len(block)
            if total:
                sys.stderr.write(f"\r  {seen/1e6:7.1f} / {int(total)/1e6:.1f} MB")
    sys.stderr.write("\n")
    os.replace(tmp, dest)


def ensure_parquet(data_dir: str) -> tuple[str, dict[str, Any]]:
    path = os.path.join(data_dir, "eot-bench-en-validation.parquet")
    fetched = False
    if not os.path.exists(path):
        print(f"download {resolve_url(REVISION)} -> {path}")
        download(resolve_url(REVISION), path)
        fetched = True
    digest = sha256_file(path)
    size = os.path.getsize(path)
    if digest != PARQUET_SHA256:
        raise SystemExit(f"parquet sha256 mismatch: {digest} != pinned {PARQUET_SHA256}")
    if size != PARQUET_BYTES:
        raise SystemExit(f"parquet size mismatch: {size} != pinned {PARQUET_BYTES}")
    print(f"parquet ok  sha256={digest[:16]}…  bytes={size}  fetched={fetched}")
    return path, {"sha256": digest, "bytes": size, "fetched": fetched}


def group_of(turn_id: str) -> str:
    """`en__<speaker>_<session>__user_turn_NNN` -> the speaker/session group key."""
    parts = turn_id.split("__")
    return parts[1] if len(parts) >= 2 else turn_id


def time_grid(start: float, end: float, step: float) -> list[float]:
    """eot-bench `_time_grid`: arange with an inclusive end."""
    n = int(math.floor((end - start) / step + EPS)) + 1
    return [round(start + i * step, 6) for i in range(n)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
    ap.add_argument("--limit", type=int, default=0, help="keep only the first N turns (0 = all 400)")
    ap.add_argument("--no-audio", action="store_true", help="skip WAV extraction (manifest only)")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.abspath(args.out)
    audio_dir = os.path.join(data_dir, "eot-bench-audio")
    os.makedirs(audio_dir, exist_ok=True)

    import pyarrow.parquet as pq

    parquet, parquet_meta = ensure_parquet(data_dir)
    table = pq.read_table(parquet, columns=["id", "audio", "language", "duration", "silence_spans"])
    rows = table.to_pylist()
    if args.limit:
        rows = rows[: args.limit]
    print(f"rows={len(rows)}")

    langs = {r["language"] for r in rows}
    if langs != {"en"}:
        raise SystemExit(f"expected an all-English split, got languages={sorted(langs)}")

    spans: list[dict[str, Any]] = []
    per_turn_cells = 0
    seen_ids: set[str] = set()
    wav_written = 0
    for row in rows:
        turn_id = row["id"]
        if turn_id in seen_ids:
            raise SystemExit(f"duplicate turn id {turn_id}")
        seen_ids.add(turn_id)
        group = group_of(turn_id)

        wav_rel = f"data/eot-bench-audio/{turn_id}.wav"
        if not args.no_audio:
            raw = bytes(row["audio"]["bytes"])
            dest = os.path.join(here, wav_rel)
            with open(dest, "wb") as fh:
                fh.write(raw)
            wav_written += 1
            with wave.open(dest, "rb") as w:
                sr, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
                frames = w.getnframes()
            if (sr, ch, width) != (16000, 1, 2):
                raise SystemExit(f"{turn_id}: unexpected wav header sr={sr} ch={ch} width={width}")
            clip_ms = round(frames * 1000.0 / sr)
        else:
            sr, clip_ms = 16000, round(float(row["duration"]) * 1000.0)

        silence = row["silence_spans"]
        n_spans = len(silence)
        for span_index, span in enumerate(silence):
            start = float(span["start"])
            end = float(span["end"])
            dur = end - start
            if dur < MIN_SILENCE_SPAN - EPS:
                continue
            label = "eot" if span_index == n_spans - 1 else "hold"
            # Denominator view: eot spans are always kept; holds only inside [0.2, 5.0].
            in_hold_range = (dur >= HOLD_MIN_DUR - EPS) and (dur <= HOLD_MAX_DUR + EPS)
            keep = label == "eot" or in_hold_range
            start_ms = round(start * 1000.0)
            end_ms = round(end * 1000.0)
            cells = len(time_grid(start, end, INFERENCE_INTERVAL))
            if keep:
                per_turn_cells += cells
            spans.append(
                {
                    "key": f"eot-bench-en|{turn_id}#{span_index}",
                    "corpus": "eot-bench-en",
                    "id": turn_id,
                    "spanIndex": span_index,
                    "group": group,
                    "label": label,
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "silenceMs": round(dur * 1000.0, 3),
                    "holdInDenominator": in_hold_range,
                    "inDenominator": keep,
                    "wav": wav_rel,
                    "sampleRate": sr,
                    "clipMs": clip_ms,
                    "cellsAtDefaultGrid": cells,
                }
            )

    eot = sum(1 for s in spans if s["label"] == "eot")
    hold = sum(1 for s in spans if s["label"] == "hold")
    hold_kept = sum(1 for s in spans if s["label"] == "hold" and s["inDenominator"])
    hold_dropped = hold - hold_kept
    groups = sorted({s["group"] for s in spans})

    manifest = {
        "generatedBy": "fetch-eot-bench-english.py",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provenance": {
            "dataset": DATASET,
            "splitFile": SPLIT_FILE,
            "revision": REVISION,
            "license": LICENSE,
            "parquetSha256": parquet_meta["sha256"],
            "parquetBytes": parquet_meta["bytes"],
            "turns": len(rows),
            "wavFilesWritten": wav_written,
        },
        "config": {
            "inferenceIntervalSec": INFERENCE_INTERVAL,
            "minSilenceSpanSec": MIN_SILENCE_SPAN,
            "holdSpanDurationRangeSec": [HOLD_MIN_DUR, HOLD_MAX_DUR],
            "labelRule": "last silence span -> eot, others -> hold",
            "causalReadRule": "cell offset d sees audio[0 : floor((start+d)*sr)]",
        },
        "counts": {
            "spans": len(spans),
            "eotSpans": eot,
            "holdSpans": hold,
            "holdSpansInDenominator": hold_kept,
            "holdSpansDroppedByDuration": hold_dropped,
            "denominatorSpans": eot + hold_kept,
            "groups": len(groups),
            "defaultGridCells": per_turn_cells,
        },
        "groups": groups,
        "spans": spans,
    }

    out_path = os.path.join(data_dir, "eot-bench-en-manifest.json")
    with open(out_path, "w") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=False)
    print(json.dumps(manifest["counts"], indent=1))
    print(f"manifest -> {out_path}  ({os.path.getsize(out_path)} B)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
