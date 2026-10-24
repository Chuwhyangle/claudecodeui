#!/usr/bin/env python3
"""Prediction reconciliation for the observation wall (24h before/after ratios).

The observation wall's charter registers predictions of the form *"after the
wall ships, this behavioural ratio goes up/down"*. A prediction is only worth
something if it is scored against real readings, so this script:

  1. reads the T0 view-event JSONL (``{at, kind, target, fromTarget, dwellMs,
     deviceId}``, written by ``POST /api/observation/view-events``) and the
     human inputs in Claude Code session transcripts (``~/.claude/projects``),
     applying the T0 classifier and the T0 automatic-session exclusion;
  2. computes three *ratios* (numerator / denominator, not raw counts) over a
     before-window and an after-window around a pivot (default: ±24 hours);
  3. scores a registered prediction list (``[{id, metric, direction,
     threshold}]``) as ``confirmed`` / ``refuted`` / ``insufficient-data``.

Scoring rule (deliberately mechanical, stated so it can be argued with):

  * ``insufficient-data`` — either window's *denominator* is below the metric's
    minimum sample size. No verdict is possible, not even a negative one.
  * ``confirmed`` — the after-minus-before change reaches ``threshold`` (an
    absolute proportion-point change) in the registered ``direction``.
  * ``refuted`` — everything else. A change below the threshold, or in the
    opposite direction, does not support the registered prediction.

Metrics (definitions are part of the contract; see README):

  * ``cockpit_preview_share`` = cockpit previews / (cockpit previews + jumps
    into a session, Quay tab or architecture tab). Predicted to rise: the wall
    turns a jump into a preview.
  * ``observation_switch_share`` = navigation events into an observation target
    (session, Quay tab, architecture tab) / all view events. Predicted to fall:
    the wall consolidates observation.
  * ``progress_check_share`` = human inputs classified ``a_progress``
    ("查进展 / 是否可用 / 重启是否成功") / all human inputs. Predicted to fall.

Usage (run isolated so no local Python packages/env leak in):

    python3 -I scripts/workload-report/predict.py \
      --fixture scripts/workload-report/testdata \
      --pivot 2026-10-20T00:00:00+08:00 \
      --predictions scripts/workload-report/testdata/predictions.json \
      --json /tmp/pred-test.json

    # the shipped fixture asserts its own hand-computed ratios
    python3 -I scripts/workload-report/predict.py \
      --fixture scripts/workload-report/testdata \
      --pivot 2026-10-20T00:00:00+08:00 \
      --predictions scripts/workload-report/testdata/predictions.json \
      --self-check

    # real reconciliation: ±24h around the wall's launch
    python3 -I scripts/workload-report/predict.py \
      --pivot 2026-10-22T10:00:00+08:00 \
      --predictions /path/to/charter-predictions.json \
      --out /tmp/prediction-report.md --json /tmp/prediction-report.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_VIEW_LOG = Path("~/.cloudcli/ui-view-events.jsonl")
DEFAULT_TRANSCRIPT_ROOT = Path("~/.claude/projects")
DEFAULT_WINDOW = timedelta(hours=24)

VIEW_KINDS = {"session", "tab", "cockpit-tile", "cockpit-preview"}
# A jump into one of these tabs, or into a session, is "going to look at
# something" — the action a cockpit preview is supposed to replace.
OBSERVATION_TAB_TARGETS = {"quay", "architecture"}

# Minimum denominators. Below these a before/after ratio is a coin flip dressed
# as a reading, so the prediction is reported insufficient-data instead.
MIN_VIEW_EVENTS = 20
MIN_HUMAN_INPUTS = 10

VIEW_METRICS = {"cockpit_preview_share", "observation_switch_share"}
INPUT_METRICS = {"progress_check_share"}

# ── T0 classification rules ─────────────────────────────────────────────────
# Ported verbatim from the T0 workload analysis (observation-p0-view-
# instrumentation-and-weekly-report). Order matters: a_progress must win over
# e_ops so "重启是否成功" counts as a progress check, not an ops request.
CATEGORY_RULES = [
    (
        "g_relay",
        re.compile(
            r"^\[(来自人类|人类)|^(用户(批准|同意|授权|明确|建议|已)|只读审计用户|"
            r"仅分析（不改代码）：用户)|转达|(给|向|发消息给|发给).{0,20}(会话|session)|"
            r"(阅读|读取|查看|搜索|访问).{0,25}(会话|session).{0,6}(的)?(记录|历史|transcript)|"
            r"会话历史|另一个会话|对方会话|^(todo|ready|needs-human|in-progress|done)\s*\n\d|"
            r"^-\n\d{6,}|^---|会话 `",
            re.I,
        ),
    ),
    (
        "a_progress",
        re.compile(
            r"^(请)?(再次)?检查(一下)?(进展|是否|重启|任务|最近|改进)|进展|"
            r"是否(已)?(完成|成功|可用|生效)|怎么样了|为什么没有任务|在飞|状态如何|"
            r"跑完了吗|完成了吗|当前.{0,10}(状态|版本)|现在.{0,6}(状态|情况)|还在跑|运行状态",
            re.I,
        ),
    ),
    (
        "b_approve",
        re.compile(
            r"^(好|好的|可以|行|对|是的|嗯|ok|yes)?[。，,.！!]?\s*(同意|按你的(建议|意见)|"
            r"批准|授权|继续|提交|commit|执行|确认|就这样|就按|选|采用|现在就做|go|做吧|推进)",
            re.I,
        ),
    ),
    (
        "e_ops",
        re.compile(
            r"重启|restart|build|\bkill|杀掉|进程|卸载|安装|升级|部署|serve\b|drivers?|"
            r"OOM|内存|红了|变红|\bred\b|失败|fail|报错|错误|异常|卡住|卡在|fan-?in|"
            r"baseline|suite|日志|log\b|修复|bug|为什么(会|没|不)|崩|挂了|超时|timeout|权限",
            re.I,
        ),
    ),
    (
        "d_correct",
        re.compile(
            r"不对|不是我|不是这|错了|不要|别再|不应(该)?|而不是|应该是|改成|改为|"
            r"重新(做|来|写)|你(说|理解)的?.{0,6}(不|错)|并不是|实际上|其实|我的意思|"
            r"我说的是|误解|漏了|没(有)?按",
            re.I,
        ),
    ),
    (
        "f_verify",
        re.compile(
            r"截图|浏览器|mcp 浏览器|playwright|验证|验收|e2e|scenario|复现|"
            r"跑(一下|下)?.{0,6}测试|run.{0,10}test|看一下(页面|UI|界面)|在(真实|实际)",
            re.I,
        ),
    ),
    (
        "c_intent",
        re.compile(
            r"讨论|设计|实现|增加|新增|添加|改进|优化|立项|task|任务|proposal|提案|方案|"
            r"需求|希望|功能|研究|搜索|调研|分析|重构|架构|实验|计划|plan|是否可以|"
            r"能不能|如何|怎么",
            re.I,
        ),
    ),
]

VOICE_TEST_MARKER = re.compile(
    r"(live ?voice|livewire|fly voice|语音测试|"
    r"第[一二三四五六七八九十\d]+次测试|第[一二三四五六七八九十\d]+句|这句话|听见我|"
    r"识别|声纹|测试。)",
    re.I,
)
VOICE_TEST_EXEMPT = re.compile(r"检查|分析|讨论|task|任务|修|为什么|找出")

# T0's automatic-session exclusion: sessions whose first prompt is a harness
# template, or whose project directory is a throwaway/probe tree, are not human
# behaviour and must not enter the P2 denominator.
AUTO_SESSION = re.compile(
    r"^(You are |WORKSPACE:|Reply with exactly|Mechanics test|This is a mechanics test|"
    r"你是一次性文本生成器|# GOAL-|Say the |NEW MESSAGE:|Use the Bash tool|"
    r"Write a very long|Say the word|\[quay-fleet:)"
)
AUTO_PROJECT = re.compile(r"worktrees|scratch|^-tmp|probe|sandbox")
SYSTEM_TEXT_PREFIXES = (
    "<",
    "This session is being continued",
    "[Request interrupted",
    "[The previous turn was interrupted",
    "[the user interrupted",
    "[quay-fleet:",
)

LIMITATIONS = [
    "分类器是 T0 的正则分类规则，人工一致率约 60%；前后两个窗口使用同一分类器，"
    "误差方向一致，因此比例的前后对比仍可比，但绝对值不能当作精确读数。",
    "输入比例只覆盖本机 Claude Code 会话记录（~/.claude/projects）；换机器或清理记录后不连续。",
    "查看事件在离开目标时结算，最后一个未离开的目标不会出现在日志里；前后窗口的截断方向相同。",
    "样本量下限：查看类指标每个窗口 ≥ 20 条事件，输入类指标每个窗口 ≥ 10 条人类输入；低于下限不判定。",
]


# ── time helpers ────────────────────────────────────────────────────────────


def parse_iso(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def event_moment(event: dict) -> datetime | None:
    at = event.get("at")
    if not isinstance(at, (int, float)):
        return None
    return datetime.fromtimestamp(at / 1000, tz=timezone.utc)


def row_moment(row: dict) -> datetime | None:
    timestamp = row.get("timestamp")
    if not isinstance(timestamp, str) or not timestamp:
        return None
    try:
        return parse_iso(timestamp)
    except ValueError:
        return None


def in_window(moment: datetime | None, window: tuple[datetime, datetime]) -> bool:
    return moment is not None and window[0] <= moment < window[1]


def row_key(row: dict) -> tuple[float, str]:
    moment = row_moment(row)
    return (moment.timestamp() if moment else 0.0, row.get("timestamp", ""))


# ── reading evidence ────────────────────────────────────────────────────────


def read_jsonl(path: Path) -> list[dict]:
    records: list[dict] = []
    bad = 0
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            if isinstance(record, dict):
                records.append(record)
            else:
                bad += 1
    if bad:
        print(f"warning: skipped {bad} malformed line(s) in {path}", file=sys.stderr)
    return records


def split_records(records: list[dict], project: str = "") -> tuple[list[dict], list[dict]]:
    """Splits a mixed JSONL stream into view events and transcript user records.

    The shipped fixture directory holds ``sample.jsonl`` (view events from the
    weekly-report fixture) next to the prediction fixture, so the shape of each
    line, not the file name, decides which stream it belongs to.
    """
    events: list[dict] = []
    rows: list[dict] = []
    for record in records:
        if record.get("kind") in VIEW_KINDS and isinstance(record.get("at"), (int, float)):
            events.append(record)
            continue
        if record.get("type") == "user" or (
            "sessionId" in record and ("message" in record or "text" in record)
        ):
            row = to_user_row(record, project)
            if row is not None:
                rows.append(row)
    return events, rows


def text_of(content) -> tuple[str, bool]:
    """Returns (text, had_tool_result), the T0 extraction rule."""
    if isinstance(content, str):
        return content, False
    if isinstance(content, list):
        parts: list[str] = []
        tool_result = False
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "tool_result":
                    tool_result = True
                elif block.get("type") == "text":
                    parts.append(block.get("text", ""))
        return "\n".join(parts), tool_result
    return "", False


def to_user_row(record: dict, project: str) -> dict | None:
    message = record.get("message") or {}
    content = message.get("content", record.get("text"))
    text, had_tool_result = text_of(content)
    if had_tool_result or not text.strip():
        return None
    return {
        "sessionId": str(record.get("sessionId") or record.get("sid") or ""),
        "timestamp": record.get("timestamp") or record.get("ts") or "",
        "text": text,
        "isMeta": bool(record.get("isMeta", False)),
        "promptSource": record.get("promptSource") or record.get("ps"),
        "project": record.get("project") or project,
        "uuid": record.get("uuid"),
    }


def load_fixture(path: Path) -> tuple[list[dict], list[dict]]:
    # Recursive on purpose: the prediction fixtures live in testdata/predict/ so
    # the weekly report's own non-recursive ``*.jsonl`` glob never sees them.
    files = sorted(path.rglob("*.jsonl")) if path.is_dir() else [path]
    events: list[dict] = []
    rows: list[dict] = []
    for file in files:
        file_events, file_rows = split_records(read_jsonl(file))
        events.extend(file_events)
        rows.extend(file_rows)
    return events, rows


def load_live_transcripts(root: Path) -> list[dict]:
    rows: list[dict] = []
    for file in sorted(root.glob("*/*.jsonl")):
        # ``type: "user"`` lines are the only ones that can be human input; the
        # cheap substring check keeps a 24h read from parsing assistant turns.
        project = file.parent.name
        with file.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if '"type":"user"' not in line and '"type": "user"' not in line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") != "user":
                    continue
                row = to_user_row(record, project)
                if row is not None:
                    rows.append(row)
    return rows


# ── T0 session rules ────────────────────────────────────────────────────────


def is_system_text(text: str) -> bool:
    return text.lstrip().startswith(SYSTEM_TEXT_PREFIXES)


def group_sessions(rows: list[dict]) -> dict[str, list[dict]]:
    sessions: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        sessions[row["sessionId"]].append(row)
    for session_rows in sessions.values():
        session_rows.sort(key=row_key)
    return sessions


def auto_session_ids(sessions: dict[str, list[dict]]) -> set[str]:
    auto: set[str] = set()
    for session_id, session_rows in sessions.items():
        firsts = [
            row
            for row in session_rows
            if not row["isMeta"]
            and not is_system_text(row["text"])
            and row["promptSource"] != "system"
        ]
        template = bool(firsts and AUTO_SESSION.match(firsts[0]["text"].lstrip()))
        project = session_rows[0]["project"] or ""
        if template or AUTO_PROJECT.search(project):
            auto.add(session_id)
    return auto


def voice_session_ids(sessions: dict[str, list[dict]]) -> set[str]:
    voice: set[str] = set()
    for session_id, session_rows in sessions.items():
        if len(session_rows) < 5:
            continue
        marked = sum(1 for row in session_rows if VOICE_TEST_MARKER.search(row["text"]))
        if marked >= 0.3 * len(session_rows):
            voice.add(session_id)
    return voice


def select_human_inputs(
    rows: list[dict],
    window: tuple[datetime, datetime],
    auto_ids: set[str],
) -> tuple[list[dict], int]:
    """In-window human inputs, plus the number of auto-session rows excluded."""
    selected: list[dict] = []
    auto_excluded = 0
    seen: set[tuple] = set()
    for row in sorted(rows, key=row_key):
        if not in_window(row_moment(row), window):
            continue
        if row["sessionId"] in auto_ids:
            auto_excluded += 1
            continue
        if row["isMeta"] or row["promptSource"] == "system" or is_system_text(row["text"]):
            continue
        key = row["uuid"] or (row["sessionId"], row["timestamp"], row["text"])
        if key in seen:
            continue
        seen.add(key)
        selected.append(row)
    return selected, auto_excluded


def classify_inputs(rows: list[dict], voice_ids: set[str]) -> Counter:
    counts: Counter = Counter()
    for row in rows:
        text = row["text"].strip()
        if row["sessionId"] in voice_ids and not VOICE_TEST_EXEMPT.search(text):
            counts["h_voice_test"] += 1
            continue
        category = "z_other"
        for name, pattern in CATEGORY_RULES:
            if pattern.search(text[:400]):
                category = name
                break
        counts[category] += 1
    return counts


# ── metrics ─────────────────────────────────────────────────────────────────


def is_observation_navigation(event: dict) -> bool:
    kind = event.get("kind")
    target = str(event.get("target", ""))
    if kind == "session":
        return True
    return kind == "tab" and target in OBSERVATION_TAB_TARGETS


def view_counts(events: list[dict]) -> dict:
    previews = 0
    observation_switches = 0
    for event in events:
        if event.get("kind") == "cockpit-preview":
            previews += 1
        if is_observation_navigation(event):
            observation_switches += 1
    return {
        "events": len(events),
        "cockpit_previews": previews,
        "observation_jumps": observation_switches,
        "observation_switches": observation_switches,
    }


def ratio(numerator: int, denominator: int) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 6)


def metric_reading(
    numerator: int,
    denominator: int,
    sample_size: int,
    sample_basis: str,
) -> dict:
    return {
        "numerator": numerator,
        "denominator": denominator,
        "ratio": ratio(numerator, denominator),
        # The sample-size gate is judged on the window's evidence volume, not on
        # the metric's denominator: a preview-share denominator of 10 can sit
        # inside a 21-event window, and 21 events is the real sample there.
        "sample_size": sample_size,
        "sample_basis": sample_basis,
    }


def build_metrics(
    before_events: list[dict],
    after_events: list[dict],
    before_inputs: list[dict],
    after_inputs: list[dict],
    voice_ids: set[str],
) -> dict:
    before_view = view_counts(before_events)
    after_view = view_counts(after_events)
    before_categories = classify_inputs(before_inputs, voice_ids)
    after_categories = classify_inputs(after_inputs, voice_ids)

    return {
        "cockpit_preview_share": {
            "definition": "驾驶舱预览 /（驾驶舱预览 + 为观察而跳进会话或 tab 的导航）",
            "before": metric_reading(
                before_view["cockpit_previews"],
                before_view["cockpit_previews"] + before_view["observation_jumps"],
                before_view["events"],
                "窗口内查看事件",
            ),
            "after": metric_reading(
                after_view["cockpit_previews"],
                after_view["cockpit_previews"] + after_view["observation_jumps"],
                after_view["events"],
                "窗口内查看事件",
            ),
        },
        "observation_switch_share": {
            "definition": "观察型切换（进入会话 / Quay / 架构 tab） / 全部导航事件",
            "before": metric_reading(
                before_view["observation_switches"],
                before_view["events"],
                before_view["events"],
                "窗口内查看事件",
            ),
            "after": metric_reading(
                after_view["observation_switches"],
                after_view["events"],
                after_view["events"],
                "窗口内查看事件",
            ),
        },
        "progress_check_share": {
            "definition": '「查进展 / 是否可用 / 重启是否成功」类输入（a_progress） / 人类输入',
            "before": metric_reading(
                before_categories.get("a_progress", 0),
                len(before_inputs),
                len(before_inputs),
                "人类输入",
            ),
            "after": metric_reading(
                after_categories.get("a_progress", 0),
                len(after_inputs),
                len(after_inputs),
                "人类输入",
            ),
        },
    }


def add_deltas(metrics: dict) -> None:
    for reading in metrics.values():
        before = reading["before"]["ratio"]
        after = reading["after"]["ratio"]
        reading["delta"] = (
            None if before is None or after is None else round(after - before, 6)
        )


def min_samples_for(metric_name: str) -> int:
    return MIN_HUMAN_INPUTS if metric_name in INPUT_METRICS else MIN_VIEW_EVENTS


def score_predictions(predictions: list[dict], metrics: dict) -> list[dict]:
    scored: list[dict] = []
    for prediction in predictions:
        metric_name = prediction["metric"]
        direction = prediction["direction"]
        threshold = float(prediction["threshold"])
        reading = metrics[metric_name]
        before = reading["before"]
        after = reading["after"]
        minimum = min_samples_for(metric_name)

        reasons: list[str] = []
        if before["sample_size"] < minimum:
            reasons.append(
                f"before 样本量 {before['sample_size']}（{before['sample_basis']}）"
                f" < {minimum}"
            )
        if after["sample_size"] < minimum:
            reasons.append(
                f"after 样本量 {after['sample_size']}（{after['sample_basis']}）"
                f" < {minimum}"
            )

        if reasons:
            verdict = "insufficient-data"
            reason = "；".join(reasons)
        elif before["ratio"] is None or after["ratio"] is None:
            verdict = "insufficient-data"
            reason = "窗口内比例无定义（分母为 0）"
        else:
            delta = after["ratio"] - before["ratio"]
            if direction == "up":
                supported = delta >= threshold
            else:
                supported = delta <= -threshold
            verdict = "confirmed" if supported else "refuted"
            arrow = "上升" if direction == "up" else "下降"
            reason = (
                f"Δ={delta:+.6f}，登记方向{arrow}、阈值 {threshold:g}；"
                f"{'达到方向与幅度' if supported else '未达到登记的阈值或方向'}"
            )

        scored.append(
            {
                "id": prediction["id"],
                "metric": metric_name,
                "direction": direction,
                "threshold": threshold,
                "verdict": verdict,
                "reason": reason,
                "before": before,
                "after": after,
                "delta": reading["delta"],
            }
        )
    return scored


# ── output ──────────────────────────────────────────────────────────────────


def window_json(window: tuple[datetime, datetime]) -> dict:
    return {"start": window[0].isoformat(), "end": window[1].isoformat()}


def format_ratio(reading: dict) -> str:
    if reading["ratio"] is None:
        return "—"
    return f"{100.0 * reading['ratio']:.2f}%"


def format_delta(delta: float | None) -> str:
    if delta is None:
        return "—"
    return f"{100.0 * delta:+.2f}pp"


def render_markdown(report: dict) -> str:
    windows = report["windows"]
    lines: list[str] = []
    lines.append("# 预测对账：观察墙前后行为比例")
    lines.append("")
    lines.append(f"- 支点（pivot）：{report['pivot']}")
    lines.append(
        f"- 前窗口：{windows['before']['start']} → {windows['before']['end']}"
    )
    lines.append(
        f"- 后窗口：{windows['after']['start']} → {windows['after']['end']}"
    )
    lines.append(f"- 查看事件源：`{report['sources']['view_events']}`")
    lines.append(f"- 会话记录源：`{report['sources']['transcripts']}`")
    lines.append(
        f"- 自动会话剔除：前窗口 {report['sessions']['before']['auto_excluded']} 条、"
        f"后窗口 {report['sessions']['after']['auto_excluded']} 条"
    )
    lines.append("")

    lines.append("## 比例（分子 / 分母）")
    lines.append("")
    lines.append("| 指标 | 定义 | 前窗口 | 前样本 | 前比例 | 后窗口 | 后样本 | 后比例 | Δ |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for name, reading in report["metrics"].items():
        before = reading["before"]
        after = reading["after"]
        lines.append(
            f"| `{name}` | {reading['definition']} | "
            f"{before['numerator']} / {before['denominator']} | "
            f"{before['sample_size']} | "
            f"{format_ratio(before)} | "
            f"{after['numerator']} / {after['denominator']} | "
            f"{after['sample_size']} | "
            f"{format_ratio(after)} | "
            f"{format_delta(reading['delta'])} |"
        )
    lines.append("")
    lines.append(
        "> 比例 = 分子 / 分母；Δ 是后窗口比例减前窗口比例（百分点）。"
        "样本量是窗口内的证据量（查看类 = 全部查看事件，输入类 = 人类输入），"
        "低于下限时不判定，但分子/分母照列。"
    )
    lines.append("")

    lines.append("## 预测判定")
    lines.append("")
    lines.append("| id | 指标 | 方向 | 阈值 | 前比例 | 后比例 | Δ | 判定 |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: | --- |")
    for item in report["predictions"]:
        verdict = item["verdict"]
        lines.append(
            f"| {item['id']} | `{item['metric']}` | {item['direction']} | "
            f"{item['threshold']:g} | "
            f"{format_ratio(item['before'])} | {format_ratio(item['after'])} | "
            f"{format_delta(item['delta'])} | **{verdict}** |"
        )
    lines.append("")
    for item in report["predictions"]:
        lines.append(f"- **{item['id']}** — `{item['verdict']}`：{item['reason']}")
    lines.append("")

    lines.append("## 局限")
    lines.append("")
    for limitation in report["limitations"]:
        lines.append(f"- {limitation}")
    lines.append("")
    return "\n".join(lines)


def build_report(
    *,
    pivot: datetime,
    before_window: tuple[datetime, datetime],
    after_window: tuple[datetime, datetime],
    predictions: list[dict],
    before_events: list[dict],
    after_events: list[dict],
    before_inputs: list[dict],
    after_inputs: list[dict],
    before_auto_excluded: int,
    after_auto_excluded: int,
    voice_ids: set[str],
    sources: dict,
) -> dict:
    metrics = build_metrics(before_events, after_events, before_inputs, after_inputs, voice_ids)
    add_deltas(metrics)
    scored = score_predictions(predictions, metrics)
    return {
        "pivot": pivot.isoformat(),
        "windows": {
            "before": window_json(before_window),
            "after": window_json(after_window),
        },
        "sources": sources,
        "sessions": {
            "before": {"auto_excluded": before_auto_excluded},
            "after": {"auto_excluded": after_auto_excluded},
        },
        "metrics": metrics,
        "predictions": scored,
        "limitations": LIMITATIONS,
    }


# ── self-check ──────────────────────────────────────────────────────────────
# Hand-computed from scripts/workload-report/testdata. Changing the fixture
# means re-deriving these by hand, not reading them back from the script.
#
# Fixture arithmetic (pivot 2026-10-20T00:00:00+08:00):
#   before view events: 2 previews + 8 observation jumps + 11 other = 21
#   after  view events: 10 previews + 16 observation jumps + 4 other = 30
#   before human inputs: s1 7 + s2 5 = 12 (an auto template session's 4 rows —
#       its "You are …" first prompt plus 3 progress-looking prompts — are
#       excluded); a_progress = 3 ("检查一下进展" / "现在状态如何" /
#       "重启是否成功") + 3 ("进展怎么样" / "为什么没有任务" / "跑完了吗") = 6
#   after human inputs: s3 4; a_progress = 1 ("进展如何")
FIXTURE_EXPECTED = {
    "before_events": 21,
    "after_events": 30,
    "before_previews": 2,
    "after_previews": 10,
    "before_observation_switches": 8,
    "after_observation_switches": 16,
    "before_human_inputs": 12,
    "after_human_inputs": 4,
    "before_progress_checks": 6,
    "after_progress_checks": 1,
    "auto_excluded_in_window": 4,
    "ratios": {
        "cockpit_preview_share": {"before": 0.2, "after": 0.384615},
        "observation_switch_share": {"before": 0.380952, "after": 0.533333},
        "progress_check_share": {"before": 0.5, "after": 0.25},
    },
    "verdicts": {
        "P1-cockpit-preview-share": "confirmed",
        "P1-observation-switch-share": "refuted",
        "P2-progress-check-share": "insufficient-data",
    },
}


def self_check(report: dict) -> list[str]:
    problems: list[str] = []
    metrics = report["metrics"]
    readings = {
        "before_events": metrics["observation_switch_share"]["before"]["denominator"],
        "after_events": metrics["observation_switch_share"]["after"]["denominator"],
        "before_observation_switches": metrics["observation_switch_share"]["before"]["numerator"],
        "after_observation_switches": metrics["observation_switch_share"]["after"]["numerator"],
        "before_previews": metrics["cockpit_preview_share"]["before"]["numerator"],
        "after_previews": metrics["cockpit_preview_share"]["after"]["numerator"],
        "before_human_inputs": metrics["progress_check_share"]["before"]["denominator"],
        "after_human_inputs": metrics["progress_check_share"]["after"]["denominator"],
        "before_progress_checks": metrics["progress_check_share"]["before"]["numerator"],
        "after_progress_checks": metrics["progress_check_share"]["after"]["numerator"],
        "auto_excluded_in_window": (
            report["sessions"]["before"]["auto_excluded"]
            + report["sessions"]["after"]["auto_excluded"]
        ),
    }
    for key, expected in readings.items():
        if FIXTURE_EXPECTED[key] != expected:
            problems.append(
                f"{key}: expected {FIXTURE_EXPECTED[key]}, got {expected}"
            )

    for name, expected in FIXTURE_EXPECTED["ratios"].items():
        for side in ("before", "after"):
            actual = metrics[name][side]["ratio"]
            wanted = expected[side]
            if actual is None or abs(actual - wanted) > 1e-6:
                problems.append(
                    f"{name}.{side}.ratio: expected {wanted}, got {actual}"
                )

    verdicts = {item["id"]: item["verdict"] for item in report["predictions"]}
    for prediction_id, expected in FIXTURE_EXPECTED["verdicts"].items():
        if verdicts.get(prediction_id) != expected:
            problems.append(
                f"verdict[{prediction_id}]: expected {expected}, "
                f"got {verdicts.get(prediction_id)}"
            )
    return problems


# ── CLI ─────────────────────────────────────────────────────────────────────


def load_predictions(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not data:
        raise ValueError("predictions must be a non-empty JSON array")
    for entry in data:
        if not isinstance(entry, dict):
            raise ValueError("each prediction must be an object")
        for field in ("id", "metric", "direction", "threshold"):
            if field not in entry:
                raise ValueError(f"prediction missing '{field}': {entry!r}")
        if entry["metric"] not in VIEW_METRICS | INPUT_METRICS:
            raise ValueError(f"unknown metric {entry['metric']!r} in {entry['id']!r}")
        if entry["direction"] not in ("up", "down"):
            raise ValueError(f"direction must be 'up' or 'down' in {entry['id']!r}")
        if not isinstance(entry["threshold"], (int, float)):
            raise ValueError(f"threshold must be a number in {entry['id']!r}")
    return data


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture",
        type=Path,
        help="Directory of *.jsonl fixtures (or one file) instead of live evidence.",
    )
    parser.add_argument(
        "--pivot",
        type=parse_iso,
        help="Window pivot (ISO 8601). Default: now. Windows default to ±24h.",
    )
    parser.add_argument(
        "--window-before",
        nargs=2,
        type=parse_iso,
        metavar=("START", "END"),
        help="Explicit before window; overrides pivot-24h..pivot.",
    )
    parser.add_argument(
        "--window-after",
        nargs=2,
        type=parse_iso,
        metavar=("START", "END"),
        help="Explicit after window; overrides pivot..pivot+24h.",
    )
    parser.add_argument(
        "--predictions",
        type=Path,
        required=True,
        help="Prediction registry: [{id, metric, direction, threshold}].",
    )
    parser.add_argument(
        "--log",
        type=Path,
        default=DEFAULT_VIEW_LOG,
        help=f"Live view-event JSONL (default: {DEFAULT_VIEW_LOG}).",
    )
    parser.add_argument(
        "--transcripts",
        type=Path,
        default=DEFAULT_TRANSCRIPT_ROOT,
        help=f"Live transcript root (default: {DEFAULT_TRANSCRIPT_ROOT}).",
    )
    parser.add_argument("--out", type=Path, help="Write Markdown here instead of stdout.")
    parser.add_argument("--json", type=Path, help="Write the machine-readable report here.")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Assert the shipped fixture against hand-computed readings; exit 1 on drift.",
    )
    args = parser.parse_args(argv)

    pivot = args.pivot or datetime.now(tz=timezone.utc)
    before_window = (
        tuple(args.window_before)
        if args.window_before
        else (pivot - DEFAULT_WINDOW, pivot)
    )
    after_window = (
        tuple(args.window_after)
        if args.window_after
        else (pivot, pivot + DEFAULT_WINDOW)
    )
    if before_window[0] >= before_window[1] or after_window[0] >= after_window[1]:
        print("error: each window needs start < end", file=sys.stderr)
        return 2
    if args.self_check and args.fixture is None:
        print("error: --self-check asserts the shipped fixture; pass --fixture", file=sys.stderr)
        return 2

    if not args.predictions.exists():
        print(f"error: no prediction registry at {args.predictions}", file=sys.stderr)
        return 2
    try:
        predictions = load_predictions(args.predictions)
    except (ValueError, json.JSONDecodeError) as error:
        print(f"error: bad prediction registry: {error}", file=sys.stderr)
        return 2

    if args.fixture is not None:
        if not args.fixture.exists():
            print(f"error: no fixture at {args.fixture}", file=sys.stderr)
            return 2
        all_events, all_rows = load_fixture(args.fixture)
        sources = {
            "view_events": f"fixture:{args.fixture}",
            "transcripts": f"fixture:{args.fixture}",
        }
    else:
        log = args.log.expanduser()
        transcripts = args.transcripts.expanduser()
        if not log.exists():
            print(
                f"error: no view-event log at {log} (pass --fixture to use a fixture)",
                file=sys.stderr,
            )
            return 2
        if not transcripts.exists():
            print(f"error: no transcript root at {transcripts}", file=sys.stderr)
            return 2
        all_events = read_jsonl(log)
        all_rows = load_live_transcripts(transcripts)
        sources = {
            "view_events": str(log),
            "transcripts": str(transcripts),
        }

    sessions = group_sessions(all_rows)
    auto_ids = auto_session_ids(sessions)
    voice_ids = voice_session_ids(sessions)

    before_events = [
        event for event in all_events if in_window(event_moment(event), before_window)
    ]
    after_events = [
        event for event in all_events if in_window(event_moment(event), after_window)
    ]
    before_inputs, before_auto_excluded = select_human_inputs(
        all_rows, before_window, auto_ids
    )
    after_inputs, after_auto_excluded = select_human_inputs(
        all_rows, after_window, auto_ids
    )

    report = build_report(
        pivot=pivot,
        before_window=before_window,
        after_window=after_window,
        predictions=predictions,
        before_events=before_events,
        after_events=after_events,
        before_inputs=before_inputs,
        after_inputs=after_inputs,
        before_auto_excluded=before_auto_excluded,
        after_auto_excluded=after_auto_excluded,
        voice_ids=voice_ids,
        sources=sources,
    )

    markdown = render_markdown(report)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(markdown, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(markdown)

    if args.json is not None:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"wrote {args.json}")

    if args.self_check:
        problems = self_check(report)
        if problems:
            for problem in problems:
                print(f"self-check FAIL: {problem}", file=sys.stderr)
            return 1
        print("self-check: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
