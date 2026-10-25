#!/usr/bin/env python3
"""How many context rows/chars does a referent or term need? A post-hoc analysis of the
voice-omni-vs-realtime fixtures.

Reads (all local, no network):
  out/fixtures-24.json   the 24 real utterances, their exact C2 packs, asr/relay references
  out/results-30c.jsonl  N0 (no context) / N1 (full context) outputs, 2 reps

For each of the five referent/term cases, finds the LAST occurrence of the anchor in the
context, measured in rows-from-end and chars-from-end. Then builds a coverage curve and
maps it to the observed N0/N1 term hits. This is a necessary-condition analysis: an anchor
that is not in the retained window cannot be resolved from it; the converse is not proven.

Usage: python3 experiments/voice-omni-vs-realtime/analyze-context-k.py
"""

import json
import re
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = json.loads((HERE / "out/fixtures-24.json").read_text())["items"]
RESULTS = [json.loads(line) for line in (HERE / "out/results-30c.jsonl").read_text().splitlines() if line.strip()]

# The five referent/term cases and the anchor each output is expected to recover.
TARGETS = {
    "6c76e1cf-0": ["architecture tab", "tab"],
    "711e54cc-0": ["live voice"],
    "acf7fc73-0": ["live voice"],
    "bf517472-0": ["pack"],
    "bf517472-1": ["live voice"],
}


def rows_of(context: str) -> list[str]:
    return re.split(r"\n(?=(?:用户|助手)（)", context)


def last_pos(context: str, term: str):
    """(rows-from-end, chars-from-end) of the last occurrence, or None. 1 = the newest row."""
    index = context.lower().rfind(term.lower())
    if index < 0:
        return None
    rows = rows_of(context)
    offset = 0
    row_index = None
    for i, row in enumerate(rows):
        if offset <= index < offset + len(row) + 1:
            row_index = i
            break
        offset += len(row) + 1
    return (len(rows) - row_index, len(context) - index)


def hit(key: str, text: str) -> bool:
    lowered = text.lower()
    if key == "6c76e1cf-0":
        return "architecture" in lowered and "tab" in lowered
    return TARGETS[key][0] in lowered


def anchor_terms(key: str) -> list[str]:
    # acf7 has no exact "live voice"; its two tokens are the only context anchor.
    return ["live", "voice"] if key == "acf7fc73-0" else TARGETS[key]


def covered(key: str, context: str, mode: str, k: int) -> bool:
    positions = [p for p in (last_pos(context, t) for t in anchor_terms(key)) if p is not None]
    return any((p[0] if mode == "rows" else p[1]) <= k for p in positions)


def main() -> None:
    print("## 1. Anchor position in the exact C2 pack\n")
    print("| key | anchor | rows from newest | chars from newest |")
    print("|---|---|---:|---:|")
    for key, terms in TARGETS.items():
        item = next(x for x in FIXTURES if x["key"] == key)
        for term in terms:
            position = last_pos(item["context"], term)
            if position is None:
                print(f"| {key} | `{term}` | not found | not found |")
            else:
                print(f"| {key} | `{term}` | {position[0]} | {position[1]} |")

    print("\n## 2. Observed N0/N1 term hits (rep 0 / rep 1)\n")
    print("| key | N0 | N1 |")
    print("|---|---|---|")
    observed = {}
    for key in TARGETS:
        cells = []
        for arm in ("N0", "N1"):
            reps = [
                hit(key, r["text"])
                for r in RESULTS
                if r["key"] == key and r["arm"] == arm and r.get("status") == 200
            ]
            observed[(key, arm)] = sum(reps) / len(reps) if reps else 0.0
            cells.append("/".join("✓" if x else "✗" for x in reps))
        print(f"| {key} | {cells[0]} | {cells[1]} |")
    print(
        f"\nN0 total {sum(observed[(k, 'N0')] for k in TARGETS):.1f}/5, "
        f"N1 total {sum(observed[(k, 'N1')] for k in TARGETS):.1f}/5 (mean over reps)."
    )

    print("\n## 3. Coverage-based expected term hits\n")
    print("Necessary-condition estimate: retained anchor ⇒ use the observed N1 outcome, lost ⇒ N0.")
    print("\n| K | rows: expected/5 | chars: expected/5 |")
    print("|---:|---:|---:|")
    for k_rows, k_chars in [(0, 0), (1, 200), (2, 300), (3, 500), (3, 600), (4, 700), (4, 800), (6, 1000), (10, 1200), (12, 2000)]:
        values = []
        for mode, k in (("rows", k_rows), ("chars", k_chars)):
            if k == 0:
                values.append(sum(observed[(key, "N0")] for key in TARGETS))
                continue
            total = 0.0
            for key in TARGETS:
                item = next(x for x in FIXTURES if x["key"] == key)
                total += observed[(key, "N1")] if covered(key, item["context"], mode, k) else observed[(key, "N0")]
            values.append(total)
        print(f"| {k_rows} / {k_chars} | {values[0]:.1f} | {values[1]:.1f} |")

    print("\n## 4. Broader Latin/number anchors (sensitivity)\n")
    needs = []
    for item in FIXTURES:
        anchors = [
            token
            for token in set(re.findall(r"[A-Za-z][A-Za-z0-9_.-]{2,}|\d+", item["relay"]))
            if re.search(re.escape(token), item["context"], re.I)
        ]
        positions = [p for p in (last_pos(item["context"], token) for token in anchors) if p is not None]
        if not positions:
            continue
        needs.append(
            (
                item["key"],
                sorted(anchors),
                max(p[0] for p in positions),
                max(p[1] for p in positions),
            )
        )
    for key, anchors, rows, chars in needs:
        print(f"- `{key}`: anchors={anchors}, rows-from-end={rows}, chars-from-end={chars}")
    if needs:
        chars = sorted(x[3] for x in needs)
        rows = sorted(x[2] for x in needs)
        print(
            f"\nRetain ALL anchors: rows p50/p90/max = {statistics.median(rows):.0f}/"
            f"{rows[int(len(rows) * 0.9)]:.0f}/{max(rows)}; chars = {statistics.median(chars):.0f}/"
            f"{chars[int(len(chars) * 0.9)]:.0f}/{max(chars)}."
        )
        for mode, index in (("rows", 2), ("chars", 3)):
            print(f"\n{mode} coverage of all context anchors:")
            thresholds = [1, 2, 3, 4, 5, 6, 8, 10, 12] if mode == "rows" else [200, 300, 400, 500, 600, 700, 800, 1000, 1200, 1500, 2000]
            for k in thresholds:
                kept = sum(1 for row in needs if row[index] <= k)
                print(f"- K={k}: {kept}/{len(needs)} items retain every anchor")


if __name__ == "__main__":
    main()
