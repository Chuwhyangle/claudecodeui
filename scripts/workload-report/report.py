#!/usr/bin/env python3
"""Weekly UI observation-load report.

Reads the local view-event log written by ``POST /api/observation/view-events``
(``~/.cloudcli/ui-view-events.jsonl`` by default) and prints, in Markdown:

  * 观察型切换 — how many viewing episodes the reader switched away from, and how
    many distinct targets/sessions that covers. This is the half of the load the
    typed-input analysis could not see.
  * 停留 — dwell-time total, median, p90 and a histogram.
  * 按目标类型 — the share of episodes spent on a session (会话), the Quay board
    (Quay), the architecture drawing (架构), the cockpit (驾驶舱) and everything
    else (其他).
  * 驾驶舱：预览 vs 跳转 — inside the cockpit, was the reader previewing a tile or
    jumping into it?

Each JSONL line is one completed episode:
``{at, kind, target, fromTarget, dwellMs, deviceId}``.

Usage (run isolated so no local Python packages/env leak in):

    python3 -I scripts/workload-report/report.py --out /tmp/weekly.md
    python3 -I scripts/workload-report/report.py --fixture scripts/workload-report/testdata --out /tmp/weekly.md
    python3 -I scripts/workload-report/report.py --fixture scripts/workload-report/testdata --self-check

``--self-check`` re-derives the shipped fixture's counts and exits non-zero when
they drift from the hand-computed expectations below; a report that silently
counts the wrong thing is worse than no report.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_LOG_PATH = Path("~/.cloudcli/ui-view-events.jsonl")

MINUTE_MS = 60_000
SECOND_MS = 1_000

# Hand-computed from scripts/workload-report/testdata/sample.jsonl. Changing the
# fixture means re-deriving these by hand, not reading them back from the script.
FIXTURE_EXPECTED = {
    "events": 12,
    "switches": 12,
    "unique_targets": 9,
    "unique_sessions": 3,
    "total_dwell_ms": 265_700,
    "median_dwell_ms": 8_500,
    "p90_dwell_ms": 45_000,
    "bucket_lt_10s": 7,
    "bucket_10s_60s": 4,
    "bucket_1m_5m": 1,
    "bucket_gt_5m": 0,
    "by_type": {"会话": 4, "Quay": 3, "架构": 1, "驾驶舱": 3, "其他": 1},
    "cockpit_preview": 1,
    "cockpit_tile": 1,
    "cockpit_jump": 1,
}


def load_events(source: Path) -> list[dict]:
    """Reads every ``*.jsonl`` file in a directory (or one file), skipping bad lines."""
    files: list[Path]
    if source.is_dir():
        files = sorted(source.glob("*.jsonl"))
    else:
        files = [source]

    events: list[dict] = []
    bad_lines = 0
    for file in files:
        with file.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    bad_lines += 1
                    continue
                if isinstance(record, dict):
                    events.append(record)
                else:
                    bad_lines += 1
    if bad_lines:
        print(f"warning: skipped {bad_lines} malformed line(s)", file=sys.stderr)
    events.sort(key=lambda event: event.get("at", 0))
    return events


def target_type(event: dict) -> str:
    """The report's coarse target class for one episode."""
    kind = event.get("kind")
    target = str(event.get("target", ""))
    if kind == "session":
        return "会话"
    if kind == "cockpit-tile":
        return "驾驶舱"
    if kind == "cockpit-preview":
        return "驾驶舱"
    if kind == "tab":
        if target == "quay":
            return "Quay"
        if target == "architecture":
            return "架构"
        if target == "cockpit":
            return "驾驶舱"
    return "其他"


def percentile(values: list[int], fraction: float) -> int:
    """Nearest-rank percentile over a non-empty sorted list."""
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[index]


def summarize(events: list[dict]) -> dict:
    """One reading of the whole log; every number the report prints comes from here."""
    dwells = [int(event.get("dwellMs", 0)) for event in events]
    sessions = {
        str(event.get("target"))
        for event in events
        if event.get("kind") == "session"
    }
    types = Counter(target_type(event) for event in events)
    cockpit_kinds = Counter(
        str(event.get("kind"))
        for event in events
        if target_type(event) == "驾驶舱"
    )
    return {
        "events": len(events),
        "switches": len(events),
        "revisits": sum(
            1
            for event in events
            if event.get("fromTarget") is not None
            and event.get("fromTarget") == event.get("target")
        ),
        "unique_targets": len({str(event.get("target")) for event in events}),
        "unique_sessions": len(sessions),
        "total_dwell_ms": sum(dwells),
        "median_dwell_ms": int(statistics.median(dwells)) if dwells else 0,
        "p90_dwell_ms": percentile(dwells, 0.9) if dwells else 0,
        "bucket_lt_10s": sum(1 for dwell in dwells if dwell < 10 * SECOND_MS),
        "bucket_10s_60s": sum(
            1 for dwell in dwells if 10 * SECOND_MS <= dwell < MINUTE_MS
        ),
        "bucket_1m_5m": sum(
            1 for dwell in dwells if MINUTE_MS <= dwell < 5 * MINUTE_MS
        ),
        "bucket_gt_5m": sum(1 for dwell in dwells if dwell >= 5 * MINUTE_MS),
        "by_type": dict(types),
        "cockpit_preview": cockpit_kinds.get("cockpit-preview", 0),
        "cockpit_tile": cockpit_kinds.get("cockpit-tile", 0),
        "cockpit_jump": cockpit_kinds.get("tab", 0),
        "first_at": min((event.get("at", 0) for event in events), default=None),
        "last_at": max((event.get("at", 0) for event in events), default=None),
    }


def format_minutes(milliseconds: int) -> str:
    return f"{milliseconds / MINUTE_MS:.1f} 分钟"


def format_share(count: int, total: int) -> str:
    return f"{100.0 * count / total:.1f}%" if total else "0.0%"


def iso(epoch_ms: int | None) -> str:
    if epoch_ms is None:
        return "—"
    return datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S UTC"
    )


def render(summary: dict, source_label: str) -> str:
    total = summary["events"]
    lines: list[str] = []
    lines.append("# UI 观察负载周报")
    lines.append("")
    lines.append(f"- 数据源：`{source_label}`")
    lines.append(f"- 查看事件：{total} 条")
    lines.append(
        f"- 时间范围：{iso(summary['first_at'])} → {iso(summary['last_at'])}"
    )
    lines.append("")
    lines.append(
        "> 读数只覆盖本机记录的查看动作；只观察、不打字的切换经此首次可见。"
    )
    lines.append("")

    lines.append("## 观察型切换")
    lines.append("")
    lines.append(f"- 观察型切换次数：**{summary['switches']}**（每离开一个查看目标计一次）")
    lines.append(f"- 去重目标数：{summary['unique_targets']}")
    lines.append(f"- 去重会话数：{summary['unique_sessions']}")
    lines.append(f"- 隐藏页返回同一目标的接续：{summary['revisits']}")
    lines.append("")

    lines.append("## 停留")
    lines.append("")
    lines.append(f"- 总停留：{format_minutes(summary['total_dwell_ms'])}")
    lines.append(f"- 中位停留：{summary['median_dwell_ms'] / 1000:.1f} 秒")
    lines.append(f"- p90 停留：{summary['p90_dwell_ms'] / 1000:.1f} 秒")
    lines.append("")
    lines.append("| 停留区间 | 次数 | 占比 |")
    lines.append("| --- | ---: | ---: |")
    buckets = [
        ("< 10 秒", summary["bucket_lt_10s"]),
        ("10 秒 – 1 分钟", summary["bucket_10s_60s"]),
        ("1 – 5 分钟", summary["bucket_1m_5m"]),
        ("≥ 5 分钟", summary["bucket_gt_5m"]),
    ]
    for label, count in buckets:
        lines.append(f"| {label} | {count} | {format_share(count, total)} |")
    lines.append("")

    lines.append("## 按目标类型")
    lines.append("")
    lines.append("| 目标类型 | 次数 | 占比 |")
    lines.append("| --- | ---: | ---: |")
    for name in ("会话", "Quay", "架构", "驾驶舱", "其他"):
        count = summary["by_type"].get(name, 0)
        lines.append(f"| {name} | {count} | {format_share(count, total)} |")
    lines.append("")

    lines.append("## 驾驶舱：预览 vs 跳转")
    lines.append("")
    cockpit_total = (
        summary["cockpit_preview"]
        + summary["cockpit_tile"]
        + summary["cockpit_jump"]
    )
    lines.append(f"- 预览（cockpit-preview）：{summary['cockpit_preview']}")
    lines.append(f"- 在驾驶舱内打开 tile（cockpit-tile）：{summary['cockpit_tile']}")
    lines.append(f"- 跳转进驾驶舱（tab: cockpit）：{summary['cockpit_jump']}")
    lines.append(
        f"- 预览占驾驶舱查看的比例："
        f"{format_share(summary['cockpit_preview'], cockpit_total)}"
    )
    lines.append("")
    return "\n".join(lines)


def self_check(summary: dict) -> list[str]:
    """Compares the shipped fixture's reading with the hand-computed expectations."""
    problems: list[str] = []
    for key, expected in FIXTURE_EXPECTED.items():
        actual = summary.get(key)
        if key == "by_type":
            for name, count in expected.items():
                got = actual.get(name, 0) if isinstance(actual, dict) else None
                if got != count:
                    problems.append(f"by_type[{name}]: expected {count}, got {got}")
            continue
        if actual != expected:
            problems.append(f"{key}: expected {expected}, got {actual}")
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture",
        type=Path,
        help="Directory of *.jsonl fixtures (or one file) to read instead of the live log.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="Write the Markdown report here instead of stdout.",
    )
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Assert the shipped fixture against hand-computed counts; exit 1 on drift.",
    )
    args = parser.parse_args(argv)

    source = args.fixture if args.fixture is not None else DEFAULT_LOG_PATH.expanduser()
    if not source.exists():
        print(
            f"error: no view-event log at {source} (open the UI, or pass --fixture)",
            file=sys.stderr,
        )
        return 2

    events = load_events(source)
    summary = summarize(events)
    report = render(summary, str(source))

    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(report)

    if args.self_check:
        problems = self_check(summary)
        if problems:
            for problem in problems:
                print(f"self-check FAIL: {problem}", file=sys.stderr)
            return 1
        print("self-check: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
