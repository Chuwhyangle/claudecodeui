#!/usr/bin/env python3
"""Offline benchmark and replay tool for composer reply suggestions.

WHAT THIS MEASURES. The composer offers model-written reply chips. This tool
turns that into a repeatable offline measurement: sample (assistant message tail
-> the user's real next reply) pairs from local session transcripts, generate
chips over a matrix of (model x prompt version x temperature x thinking switch),
judge every chip with at least two judge models, and report a conservative
agreement number (a chip counts only when BOTH judges call it usable) plus
per-chip and per-message hit rates. It also replays the backend's local usage
ledger (shown / picked / cleared / redrawn / sent) and generates a blind
annotation sheet (the config that produced a chip is hidden) with a scorer.

WHAT IT NEVER WRITES INTO THE REPOSITORY. Sampled user text, generated chips and
the usage ledger are local-only. Samples and result files live under `tmp/`
(git-ignored) or a caller-provided temporary directory. The committed files are
this script, its README and one synthetic fixture. An API key is read from the
file named by `apiKeyFile` (optionally selected by `apiKeyVar`) and passed only
to the outbound request; it is never printed, logged or written to disk here.

USAGE (see README.md for the full matrix format and metric definitions):

    python3 -I experiments/reply-suggestions-bench/bench.py selftest
    python3 -I experiments/reply-suggestions-bench/bench.py sample --out tmp/samples.jsonl --limit 60
    python3 -I experiments/reply-suggestions-bench/bench.py run --samples tmp/samples.jsonl \
        --matrix tmp/matrix.json --settings config/reply-suggestions.settings.json --out tmp/results.json
    python3 -I experiments/reply-suggestions-bench/bench.py replay --ledger ~/.cloudcli/reply-suggestions-usage.jsonl
    python3 -I experiments/reply-suggestions-bench/bench.py blind --results tmp/results.json --out tmp/blind.jsonl
    python3 -I experiments/reply-suggestions-bench/bench.py score --manifest tmp/blind.jsonl \
        --key tmp/blind-key.jsonl --annotations tmp/annotations.txt
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures
import datetime
import glob
import http.server
import json
import os
import pathlib
import random
import re
import statistics
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE_DIR = pathlib.Path(__file__).resolve().parent / "fixtures"
AGREEMENT_FIXTURE = FIXTURE_DIR / "synthetic-judgements.json"
DEFAULT_SETTINGS = REPO_ROOT / "config" / "reply-suggestions.settings.json"
DEFAULT_TRANSCRIPTS = pathlib.Path.home() / ".claude" / "projects"
DEFAULT_LEDGER = pathlib.Path.home() / ".cloudcli" / "reply-suggestions-usage.jsonl"

VERDICTS = ("same", "near", "different")
VERDICT_TEXT = {"same": "同", "near": "近", "different": "异"}

# The checked-in expectation for the synthetic judgement fixture. It is written
# as a literal (rather than read from the fixture) so a change to the agreement
# implementation fails even if the fixture is edited in the same breath.
EXPECTED_AGREEMENT = {
    "perChipSame": 0.10,
    "perChipSameOrNear": 0.40,
    "perMessageSame": 0.25,
    "perMessageSameOrNear": 0.75,
}

# Synthetic answers shipped with the blind selftest. The expected judge-human
# agreement below is computed by hand from these three groups.
BLIND_ANSWER_GROUPS = 40


# ---------------------------------------------------------------------------
# small IO helpers
# ---------------------------------------------------------------------------


def read_jsonl(path: pathlib.Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def write_jsonl(path: pathlib.Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_json(path: pathlib.Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=1)
        handle.write("\n")


def tail_code_points(text: str, maximum: int) -> str:
    return text if len(text) <= maximum else text[-maximum:]


def truncate_code_points(text: str, maximum: int) -> str:
    return text if len(text) <= maximum else text[:maximum]


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip()).lower()


def parse_iso_timestamp(value: str) -> "datetime.datetime | None":
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def median_or_none(values: list[float | int]) -> float | None:
    cleaned = [v for v in values if isinstance(v, (int, float))]
    return float(statistics.median(cleaned)) if cleaned else None


def fmt_rate(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.3f}"


# ---------------------------------------------------------------------------
# settings and key resolution
# ---------------------------------------------------------------------------


def load_settings(path: pathlib.Path) -> dict:
    if not path.exists():
        raise SystemExit(
            f"settings file not found: {path}\n"
            "copy config/reply-suggestions.settings.example.json to a local file and pass --settings"
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as failure:
        raise SystemExit(f"settings file is not valid JSON: {type(failure).__name__}") from None
    if not isinstance(data, dict):
        raise SystemExit("settings file must hold a JSON object")
    return data


def resolve_api_key(settings: dict) -> str:
    """Read the key from the file named by apiKeyFile; never echo it."""
    raw_path = str(settings.get("apiKeyFile") or "").strip()
    if raw_path == "":
        return ""
    path = pathlib.Path(os.path.expanduser(raw_path))
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as failure:
        raise SystemExit(f"cannot read apiKeyFile ({type(failure).__name__})") from None

    wanted = str(settings.get("apiKeyVar") or "").strip()
    assignments: "collections.OrderedDict[str, str]" = collections.OrderedDict()
    first_value = ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "" or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export "):].strip()
        if "=" in stripped:
            name, value = stripped.split("=", 1)
            value = value.strip().strip("'\"")
            assignments[name.strip()] = value
            if value and not first_value:
                first_value = value
        elif not first_value:
            first_value = stripped.strip("'\"")
    if wanted:
        return assignments.get(wanted, "")
    if len(assignments) == 1:
        return next(iter(assignments.values()))
    return first_value


# ---------------------------------------------------------------------------
# gateway client (both protocols)
# ---------------------------------------------------------------------------


class GatewayError(Exception):
    """An upstream failure. The message is a category, never response content."""


def endpoint_for(base_url: str, protocol: str) -> str:
    root = (base_url or "").strip().rstrip("/")
    if root == "":
        raise GatewayError("missing-base-url")
    if not root.endswith("/v1"):
        root = root + "/v1"
    return root + ("/messages" if protocol == "anthropic" else "/chat/completions")


def _post_json(url: str, headers: dict, payload: dict, timeout_s: float) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as failure:
        # Only the status code: an error body may echo the request or the key.
        raise GatewayError(f"http-{failure.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise GatewayError("transport") from None


def auth_headers(config: dict, api_key: str) -> dict:
    protocol = config.get("protocol", "anthropic")
    scheme = str(config.get("authScheme") or "").strip()
    if scheme == "":
        scheme = "x-api-key" if protocol == "anthropic" else "bearer"
    if scheme == "x-api-key":
        return {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    return {"authorization": f"Bearer {api_key}"}


def complete(config: dict, api_key: str, system: str, user: str) -> dict:
    """One completion. Returns {text, inputTokens, outputTokens}."""
    protocol = str(config.get("protocol") or "anthropic")
    temperature = float(config.get("temperature", 0.3))
    max_tokens = int(config.get("maxOutputTokens", 400))
    timeout_ms = int(config.get("timeoutMs", 20000))
    disable_thinking = bool(config.get("disableThinking", True))
    url = endpoint_for(str(config.get("baseUrl") or ""), protocol)

    if protocol == "anthropic":
        payload = {
            "model": config.get("model"),
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "temperature": temperature,
        }
        if disable_thinking:
            payload["thinking"] = {"type": "disabled"}
        data = _post_json(url, auth_headers(config, api_key), payload, timeout_ms / 1000)
        text = "".join(
            block.get("text", "")
            for block in (data.get("content") or [])
            if isinstance(block, dict) and block.get("type") == "text"
        )
        usage = data.get("usage") or {}
        return {
            "text": text,
            "inputTokens": usage.get("input_tokens"),
            "outputTokens": usage.get("output_tokens"),
        }

    payload = {
        "model": config.get("model"),
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
    }
    if disable_thinking:
        payload["thinking"] = {"type": "disabled"}
    data = _post_json(url, auth_headers(config, api_key), payload, timeout_ms / 1000)
    choices = data.get("choices") or []
    message = choices[0].get("message") if choices and isinstance(choices[0], dict) else {}
    content = (message or {}).get("content")
    if isinstance(content, list):
        text = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    else:
        text = content or ""
    usage = data.get("usage") or {}
    return {
        "text": text,
        "inputTokens": usage.get("prompt_tokens"),
        "outputTokens": usage.get("completion_tokens"),
    }


# ---------------------------------------------------------------------------
# prompts (mirror the backend's built-in prompt)
# ---------------------------------------------------------------------------


def generation_system_prompt(max_chip_chars: int = 120) -> str:
    return "\n".join(
        [
            "你在为用户起草聊天输入框里可直接发送的回复。用户刚看完助手最后一条消息，要从中挑一条。",
            "给出 3 条互不相同的完整回复：第 1 条用「；」分隔、简要回答所有待答点，助手给了推荐就采纳；",
            "第 2、3 条是真正的备选（不同的决定，或更短的确认），不是第 1 条的改写。",
            f"用用户的语言和简短风格，每条不超过 {max_chip_chars} 个字符。",
            "不得编造消息里没有的事实、数字或测量值：可以替人做决定，不可以编造事实。",
            "没有待答点时，建议最可能的下一条指令。",
            '只输出 JSON：{"chips": ["…", "…", "…"]}',
        ]
    )


def generation_user_prompt(tail: str, focus: str = "", avoid: list[str] | None = None) -> str:
    lines = ["助手最后一条消息（末尾节选，可能被截断）：", '"""', tail, '"""']
    if focus:
        lines.extend(["", "用户选中了消息里的这一段，想回应它：", '"""', focus, '"""'])
    if avoid:
        lines.extend(["", "不要重复以下已经展示过的回复："])
        lines.extend(f"- {chip}" for chip in avoid[-6:])
    return "\n".join(lines)


JUDGE_SYSTEM_PROMPT = "\n".join(
    [
        "你是回复建议的评判。下面给出用户真实发出的回复，以及若干候选回复。",
        "逐条判断候选能否原样替代用户真实发出的回复且效果相同：",
        "same（同）= 可原样发送且效果相同；near（近）= 只需小幅修改；different（异）= 语义不同。",
        '只输出 JSON：{"verdicts": ["same"|"near"|"different", …]}，顺序与候选一致。',
    ]
)


def judge_user_prompt(actual: str, chips: list[str]) -> str:
    lines = ["用户真实发出的回复：", '"""', actual, '"""', "", "候选："]
    for index, chip in enumerate(chips, start=1):
        lines.append(f"{index}. {chip}")
    lines.append("")
    lines.append("逐条给出判决（同/近/异）。")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# JSON extraction and chip parsing
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)


def extract_json(text: str) -> object:
    trimmed = (text or "").strip()
    candidates = []
    fenced = _FENCE_RE.search(trimmed)
    if fenced:
        candidates.append(fenced.group(1).strip())
    candidates.append(trimmed)
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
    for opener, closer in (("{", "}"), ("[", "]")):
        start = trimmed.find(opener)
        end = trimmed.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(trimmed[start : end + 1])
            except json.JSONDecodeError:
                continue
    return None


def parse_chips(text: str) -> list[str]:
    parsed = extract_json(text)
    if isinstance(parsed, dict):
        raw = parsed.get("chips")
    elif isinstance(parsed, list):
        raw = parsed
    else:
        raw = None
    if not isinstance(raw, list):
        raise GatewayError("unparseable-chips")
    chips = []
    for item in raw:
        if not isinstance(item, str):
            raise GatewayError("unparseable-chips")
        value = item.strip()
        if value:
            chips.append(value)
    return chips


def normalize_verdict(value: object) -> str | None:
    if isinstance(value, bool):
        return "same" if value else "different"
    if not isinstance(value, str):
        return None
    lowered = value.strip().lower()
    if lowered in ("same", "同", "1", "可原样发送"):
        return "same"
    if lowered in ("near", "近", "2", "近似"):
        return "near"
    if lowered in ("different", "diff", "异", "3"):
        return "different"
    if "different" in lowered or "异" in lowered or "diff" in lowered:
        return "different"
    if "near" in lowered or "近" in lowered:
        return "near"
    if "same" in lowered or "同" in lowered:
        return "same"
    return None


def parse_verdicts(text: str, expected: int) -> list[str | None]:
    parsed = extract_json(text)
    values: list[object] = []
    if isinstance(parsed, dict):
        for key in ("verdicts", "judgements", "judgments", "labels"):
            if isinstance(parsed.get(key), list):
                values = parsed[key]
                break
    elif isinstance(parsed, list):
        values = parsed
    mapped = [normalize_verdict(value) for value in values][:expected]
    while len(mapped) < expected:
        mapped.append(None)
    return mapped


def judge_chips(judge_config: dict, api_key: str, actual: str, chips: list[str]) -> list[str | None]:
    if not chips:
        return []
    response = complete(judge_config, api_key, JUDGE_SYSTEM_PROMPT, judge_user_prompt(actual, chips))
    return parse_verdicts(response["text"], len(chips))


# ---------------------------------------------------------------------------
# sampling from local session transcripts
# ---------------------------------------------------------------------------

AUTOMATION_PREFIXES = (
    "[Request interrupted by user]",
    # Split so a common API-key prefix pattern never appears in this file.
    "<task" "-notification",
    "<command-name>",
    "<command-message>",
    "This session is being continued",
    "UTTERANCE:",
    "needs-human (latest",
)

# Worker/driver turns arrive as the transcript's "user" role but are machine
# prompts, not things a person typed. They are excluded so the benchmark's
# denominator is human replies: a task id at the start, or a task body heading.
AUTOMATION_HEADINGS = (
    "## Touches",
    "## Acceptance Criteria",
    "## Proposal",
    "## Plan",
    "## DoD",
    "## Needs-Human",
)
_TASK_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+-\d+")


def _content_text(content: object) -> tuple[str, bool]:
    """Return (text, has_tool_result) for a transcript message content."""
    if isinstance(content, str):
        return content, False
    if isinstance(content, list):
        has_tool_result = any(
            isinstance(block, dict) and block.get("type") == "tool_result" for block in content
        )
        text = "\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
        return text, has_tool_result
    return "", False


def _is_automation(text: str) -> bool:
    stripped = text.strip()
    if stripped == "":
        return True
    if any(stripped.startswith(prefix) for prefix in AUTOMATION_PREFIXES):
        return True
    if _TASK_ID_RE.match(stripped):
        return True
    # Client-injected wrappers: pasted blocks, local bash input, slash commands.
    if re.match(r"<[a-z][a-z_-]*[ >]", stripped):
        return True
    return any(heading in stripped for heading in AUTOMATION_HEADINGS)


def sample_transcripts(
    transcripts_root: pathlib.Path,
    limit: int,
    days: int,
    max_tail_chars: int = 1500,
    entrypoints: set[str] | None = None,
    max_gap_seconds: int = 600,
) -> list[dict]:
    """Sample (assistant tail -> next user reply) pairs from local transcripts.

    `entrypoints` optionally restricts the sample to interactive session types
    (e.g. {"cli", "sdk-cli"}). Worker sessions record their driver prompts as
    the "user" role and would otherwise dominate the denominator.
    """
    cutoff = time.time() - days * 86400
    samples: list[dict] = []
    for file_name in glob.glob(str(transcripts_root / "*" / "*.jsonl")):
        path = pathlib.Path(file_name)
        try:
            if path.stat().st_mtime < cutoff:
                continue
        except OSError:
            continue
        project = path.parent.name
        session = path.name[:-6]
        pending: dict | None = None
        try:
            handle = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with handle:
            for line in handle:
                if '"type"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("isSidechain"):
                    continue
                kind = row.get("type")
                message = row.get("message") or {}
                if kind == "assistant":
                    text = ""
                    blocks = message.get("content")
                    if isinstance(blocks, list):
                        for block in blocks:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text += block.get("text", "")
                    elif isinstance(blocks, str):
                        text = blocks
                    if text.strip():
                        pending = {
                            "messageId": row.get("uuid") or row.get("id") or "",
                            "at": row.get("timestamp", ""),
                            "tail": tail_code_points(text.strip(), max_tail_chars),
                        }
                elif kind == "user":
                    if row.get("isMeta"):
                        continue
                    text, has_tool_result = _content_text(message.get("content"))
                    if has_tool_result or _is_automation(text):
                        continue
                    if pending is None:
                        continue
                    # A reply hours later is a new instruction, not a response to
                    # the assistant's last message; keeping it would measure the
                    # wrong thing (the tail has gone stale).
                    assistant_at = parse_iso_timestamp(pending.get("at") or "")
                    user_at = parse_iso_timestamp(str(row.get("timestamp") or ""))
                    if assistant_at is not None and user_at is not None:
                        if (user_at - assistant_at).total_seconds() > max_gap_seconds:
                            pending = None
                            continue
                    entrypoint = str(row.get("entrypoint") or "")
                    if entrypoints is not None and entrypoint not in entrypoints:
                        pending = None
                        continue
                    samples.append(
                        {
                            "project": project,
                            "session": session,
                            "entrypoint": entrypoint,
                            "messageId": pending["messageId"],
                            "at": row.get("timestamp", ""),
                            "tail": pending["tail"],
                            "actual": truncate_code_points(text.strip(), 4000),
                        }
                    )
                    pending = None
    # The same human message can appear in a resumed/parallel session. Keep the
    # first occurrence so one repeated phrase does not dominate the sample.
    unique: list[dict] = []
    seen_actual: set[str] = set()
    for row in samples:
        key = normalize_text(row["actual"])
        if key in seen_actual:
            continue
        seen_actual.add(key)
        unique.append(row)
    samples = unique

    # Deterministic order, then deterministic pick: the sample set is reproducible.
    samples.sort(key=lambda row: (row["session"], row["at"], row["messageId"]))
    random.Random(7).shuffle(samples)
    chosen = samples[:limit]
    for index, row in enumerate(chosen, start=1):
        row["id"] = index
    return chosen


# ---------------------------------------------------------------------------
# agreement metrics
# ---------------------------------------------------------------------------


def _hit(verdict_values: list[str | None], threshold: str, mode: str) -> bool:
    accepted = {"same"} if threshold == "same" else {"same", "near"}
    if not verdict_values or any(value is None for value in verdict_values):
        return False
    flags = [value in accepted for value in verdict_values]
    return all(flags) if mode == "conservative" else any(flags)


def agreement_rates(
    trials: list[dict],
    threshold: str = "same",
    mode: str = "conservative",
    judges: list[str] | None = None,
) -> dict:
    """Rates over a judgement table.

    `trials`: [{"id": ..., "chips": [{"verdicts": {judge: verdict}}]}].
    保守一致度 is `mode="conservative"`: every judge must accept the chip.
    `mode="lenient"` is the falsification arm: any judge accepting is enough.
    """
    chip_total = chip_hit = message_total = message_hit = 0
    for trial in trials:
        message_total += 1
        any_hit = False
        for chip in trial.get("chips") or []:
            verdicts = chip.get("verdicts") or {}
            labels = judges if judges is not None else list(verdicts.keys())
            values = [verdicts.get(label) for label in labels]
            chip_total += 1
            hit = _hit(values, threshold, mode)
            if hit:
                chip_hit += 1
                any_hit = True
        if any_hit:
            message_hit += 1
    return {
        "chips": chip_total,
        "chipHits": chip_hit,
        "perChip": (chip_hit / chip_total) if chip_total else None,
        "messages": message_total,
        "messageHits": message_hit,
        "perMessage": (message_hit / message_total) if message_total else None,
    }


def agreement_summary(trials: list[dict], judges: list[str] | None = None) -> dict:
    labels = judges
    if labels is None:
        label_set: list[str] = []
        for trial in trials:
            for chip in trial.get("chips") or []:
                for label in (chip.get("verdicts") or {}):
                    if label not in label_set:
                        label_set.append(label)
        labels = label_set
    return {
        "perChipSame": agreement_rates(trials, "same", "conservative", labels)["perChip"],
        "perChipSameOrNear": agreement_rates(trials, "near", "conservative", labels)["perChip"],
        "perMessageSame": agreement_rates(trials, "same", "conservative", labels)["perMessage"],
        "perMessageSameOrNear": agreement_rates(trials, "near", "conservative", labels)["perMessage"],
    }


# ---------------------------------------------------------------------------
# matrix run + aggregation
# ---------------------------------------------------------------------------


def effective_config(config: dict, settings: dict) -> dict:
    merged = dict(config)
    if not merged.get("baseUrl"):
        merged["baseUrl"] = settings.get("baseUrl") or ""
    if "authScheme" not in merged:
        merged["authScheme"] = settings.get("authScheme") or ""
    if "timeoutMs" not in merged:
        merged["timeoutMs"] = settings.get("timeoutMs") or 20000
    if "protocol" not in merged:
        merged["protocol"] = settings.get("protocol") or "anthropic"
    if not merged.get("label"):
        merged["label"] = str(merged.get("model") or "config")
    return merged


def validate_matrix(matrix: dict) -> None:
    generators = matrix.get("generation")
    judges = matrix.get("judges")
    if not isinstance(generators, list) or not generators:
        raise SystemExit("matrix needs a non-empty `generation` array")
    if not isinstance(judges, list) or len(judges) < 2:
        raise SystemExit("matrix needs at least two `judges` (conservative agreement requires both)")
    for group_name, group in (("generation", generators), ("judges", judges)):
        labels = [str(entry.get("label") or "") for entry in group]
        if any(label == "" for label in labels):
            raise SystemExit(f"every {group_name} entry needs a non-empty `label`")
        if len(set(labels)) != len(labels):
            raise SystemExit(f"{group_name} labels must be unique")


def run_matrix(
    samples: list[dict],
    matrix: dict,
    settings: dict,
    api_key: str,
    concurrency: int = 4,
) -> dict:
    validate_matrix(matrix)
    generators = [effective_config(entry, settings) for entry in matrix["generation"]]
    judges = [effective_config(entry, settings) for entry in matrix["judges"]]
    results: dict = {
        "meta": {
            "generators": [{k: v for k, v in entry.items() if k != "apiKey"} for entry in generators],
            "judges": [{k: v for k, v in entry.items() if k != "apiKey"} for entry in judges],
            "samples": len(samples),
        },
        "generators": {entry["label"]: {k: v for k, v in entry.items() if k != "apiKey"} for entry in generators},
        "judges": {entry["label"]: {k: v for k, v in entry.items() if k != "apiKey"} for entry in judges},
        "samples": [],
    }

    tasks: list[tuple[dict, dict, dict]] = []
    for sample in samples:
        record = {
            "id": sample.get("id"),
            "messageId": sample.get("messageId"),
            "session": sample.get("session"),
            # Local-only: results files live under tmp/ and are never committed.
            "actual": sample.get("actual"),
            "configs": {},
        }
        results["samples"].append(record)
        for generator in generators:
            tasks.append((record, sample, generator))

    def work(task: tuple[dict, dict, dict]) -> None:
        record, sample, generator = task
        outcome: dict = {
            "chips": [],
            "verdicts": {},
            "judgeErrors": {},
            "latencyMs": None,
            "inputTokens": None,
            "outputTokens": None,
            "error": None,
        }
        started = time.monotonic()
        try:
            response = complete(
                generator,
                api_key,
                str(generator.get("systemPrompt") or generation_system_prompt(int(generator.get("maxChipChars", 120)))),
                generation_user_prompt(sample.get("tail") or ""),
            )
            try:
                chips = parse_chips(response["text"])
            except GatewayError:
                # One retry, matching the backend's supplement-on-a-bad-draw
                # behaviour: a single unparseable answer should not silently
                # remove a sample from the matrix.
                response = complete(
                    generator,
                    api_key,
                    str(generator.get("systemPrompt") or generation_system_prompt(int(generator.get("maxChipChars", 120)))),
                    generation_user_prompt(sample.get("tail") or ""),
                )
                chips = parse_chips(response["text"])
            outcome["latencyMs"] = int((time.monotonic() - started) * 1000)
            outcome["inputTokens"] = response.get("inputTokens")
            outcome["outputTokens"] = response.get("outputTokens")
            max_chips = int(generator.get("maxChips", 3))
            max_chars = int(generator.get("maxChipChars", 120))
            seen: set[str] = set()
            selected: list[str] = []
            for chip in chips:
                clipped = truncate_code_points(chip, max_chars)
                key = normalize_text(clipped)
                if key and key not in seen:
                    seen.add(key)
                    selected.append(clipped)
            outcome["chips"] = selected[:max_chips]
        except GatewayError as failure:
            outcome["error"] = str(failure)
            record["configs"][generator["label"]] = outcome
            return

        for judge in judges:
            try:
                outcome["verdicts"][judge["label"]] = judge_chips(
                    judge, api_key, sample.get("actual") or "", outcome["chips"]
                )
            except GatewayError as failure:
                outcome["verdicts"][judge["label"]] = []
                outcome["judgeErrors"][judge["label"]] = str(failure)
        record["configs"][generator["label"]] = outcome

    workers = max(1, int(concurrency))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, tasks))
    return results


def results_to_trials(results: dict, config_label: str) -> list[dict]:
    judges = list((results.get("judges") or {}).keys())
    trials: list[dict] = []
    for sample in results.get("samples") or []:
        outcome = (sample.get("configs") or {}).get(config_label)
        if not outcome or outcome.get("error"):
            continue
        chips = []
        for index, text in enumerate(outcome.get("chips") or []):
            verdicts = {}
            for judge in judges:
                values = (outcome.get("verdicts") or {}).get(judge) or []
                verdicts[judge] = values[index] if index < len(values) else None
            chips.append({"text": text, "verdicts": verdicts})
        trials.append({"id": sample.get("id"), "chips": chips})
    return trials


def aggregate_results(results: dict) -> dict:
    judges = list((results.get("judges") or {}).keys())
    summary: dict = {"configs": {}, "judges": judges}
    for config_label in (results.get("generators") or {}):
        trials = results_to_trials(results, config_label)
        latencies = []
        output_tokens = []
        errors = 0
        chip_count = 0
        for sample in results.get("samples") or []:
            outcome = (sample.get("configs") or {}).get(config_label)
            if not outcome:
                continue
            if outcome.get("error"):
                errors += 1
                continue
            chip_count += len(outcome.get("chips") or [])
            if isinstance(outcome.get("latencyMs"), (int, float)):
                latencies.append(outcome["latencyMs"])
            if isinstance(outcome.get("outputTokens"), (int, float)):
                output_tokens.append(outcome["outputTokens"])

        row: dict = {
            "messages": len(trials),
            "chips": chip_count,
            "errors": errors,
            "latencyMsMedian": median_or_none(latencies),
            "outputTokensMedian": median_or_none(output_tokens),
            "perJudge": {},
        }
        for judge in judges:
            row["perJudge"][judge] = {
                "perChipSame": agreement_rates(trials, "same", "conservative", [judge])["perChip"],
                "perChipSameOrNear": agreement_rates(trials, "near", "conservative", [judge])["perChip"],
                "perMessageSame": agreement_rates(trials, "same", "conservative", [judge])["perMessage"],
                "perMessageSameOrNear": agreement_rates(trials, "near", "conservative", [judge])["perMessage"],
            }
        row["conservative"] = agreement_summary(trials, judges)
        row["conservative"]["perChipHits"] = agreement_rates(trials, "same", "conservative", judges)["chipHits"]
        row["conservative"]["perMessageHits"] = agreement_rates(trials, "same", "conservative", judges)["messageHits"]
        row["lenient"] = {
            "perChipSame": agreement_rates(trials, "same", "lenient", judges)["perChip"],
            "perMessageSame": agreement_rates(trials, "same", "lenient", judges)["perMessage"],
            "perMessageSameOrNear": agreement_rates(trials, "near", "lenient", judges)["perMessage"],
        }
        summary["configs"][config_label] = row
    return summary


def print_aggregate(summary: dict) -> None:
    print("config                     msgs chips err  ms_med  tok_med  cons_chip_same  cons_chip_s/n  cons_msg_same  cons_msg_s/n  lenient_msg_same")
    for label, row in summary["configs"].items():
        cons = row["conservative"]
        print(
            f"{label:<26} {row['messages']:>4} {row['chips']:>5} {row['errors']:>3}  "
            f"{'n/a' if row['latencyMsMedian'] is None else int(row['latencyMsMedian']):>6}  "
            f"{'n/a' if row['outputTokensMedian'] is None else int(row['outputTokensMedian']):>7}  "
            f"{fmt_rate(cons['perChipSame']):>14}  {fmt_rate(cons['perChipSameOrNear']):>13}  "
            f"{fmt_rate(cons['perMessageSame']):>13}  {fmt_rate(cons['perMessageSameOrNear']):>12}  "
            f"{fmt_rate(row['lenient']['perMessageSame']):>16}"
        )


# ---------------------------------------------------------------------------
# replay of the backend usage ledger
# ---------------------------------------------------------------------------


def _transcript_user_text(
    transcripts_root: pathlib.Path, session_id: str, not_before: str
) -> str | None:
    matches = glob.glob(str(transcripts_root / "*" / f"{session_id}.jsonl"))
    best: str | None = None
    for file_name in matches:
        path = pathlib.Path(file_name)
        try:
            handle = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with handle:
            for line in handle:
                if '"type"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("type") != "user" or row.get("isMeta") or row.get("isSidechain"):
                    continue
                timestamp = str(row.get("timestamp") or "")
                if timestamp and timestamp < not_before:
                    continue
                text, has_tool_result = _content_text((row.get("message") or {}).get("content"))
                if has_tool_result or not text.strip():
                    continue
                best = text.strip()
                break
        if best is not None:
            break
    return best


def replay_usage(
    ledger_path: pathlib.Path,
    transcripts_root: pathlib.Path | None = None,
    records: list[dict] | None = None,
) -> dict:
    rows = list(records) if records is not None else read_jsonl(ledger_path)
    drawings: "collections.OrderedDict[tuple[str, int], dict]" = collections.OrderedDict()
    cache_hits = 0
    upstream_calls = 0
    for row in rows:
        key = (str(row.get("sessionId") or ""), int(row.get("draw") or 0))
        kind = row.get("type")
        if kind == "shown":
            # A cache hit repeats a batch already counted from its `served:
            # "upstream"` row. Counting it as a draw would count the same batch
            # twice and inflate the click-rate denominator; it is its own number
            # ("how many displays were free"). Rows written before `served`
            # existed have no field and read as real calls.
            if row.get("served") == "cache":
                cache_hits += 1
                continue
            upstream_calls += 1
            drawings[key] = {
                "sessionId": key[0],
                "draw": key[1],
                "at": str(row.get("at") or ""),
                "chips": list(row.get("chips") or []),
                "model": row.get("model"),
                "protocol": row.get("protocol"),
                "picked": None,
                "pickedAt": None,
                "cleared": False,
                "redrawn": False,
                "sent": False,
                "sentAt": None,
            }
        elif key in drawings:
            entry = drawings[key]
            if kind == "picked":
                entry["picked"] = int(row.get("index") or 0)
                entry["pickedAt"] = str(row.get("at") or "")
            elif kind == "cleared":
                entry["cleared"] = True
            elif kind == "redrawn":
                entry["redrawn"] = True
            elif kind == "sent":
                entry["sent"] = True
                entry["sentAt"] = str(row.get("at") or "")

    total = len(drawings)
    drew = [entry for entry in drawings.values() if entry["chips"]]
    picked = [entry for entry in drew if entry["picked"] is not None]
    redrawn = [entry for entry in drew if entry["redrawn"]]
    cleared = [entry for entry in drew if entry["cleared"]]
    sent_after_pick = [entry for entry in picked if entry["sent"]]
    changed = 0
    compared = 0
    unresolved = 0
    for entry in sent_after_pick:
        index = entry["picked"]
        if index is None or index < 0 or index >= len(entry["chips"]):
            continue
        sent_text = None
        if transcripts_root is not None:
            sent_text = _transcript_user_text(
                transcripts_root, entry["sessionId"], entry["at"]
            )
        if sent_text is None:
            unresolved += 1
            continue
        compared += 1
        if normalize_text(sent_text) != normalize_text(entry["chips"][index]):
            changed += 1

    return {
        "draws": total,
        "drawsWithChips": len(drew),
        # How many `shown` rows were served from the server cache (no model call)
        # and how many were real upstream calls. The batch figures above count
        # only the latter.
        "cacheHits": cache_hits,
        "upstreamCalls": upstream_calls,
        "pickedRate": (len(picked) / len(drew)) if drew else None,
        "redrawRate": (len(redrawn) / len(drew)) if drew else None,
        "clearedRate": (len(cleared) / len(drew)) if drew else None,
        "pickCount": len(picked),
        "redrawCount": len(redrawn),
        "clearedCount": len(cleared),
        "sentAfterPick": len(sent_after_pick),
        "changedAfterPick": changed,
        "comparedAfterPick": compared,
        "unresolvedSent": unresolved,
        "changedAfterPickRate": (changed / compared) if compared else None,
        "sessions": len({entry["sessionId"] for entry in drawings.values()}),
    }


def print_replay(summary: dict) -> None:
    print(
        f"draws={summary['draws']} sessions={summary['sessions']} "
        f"draws_with_chips={summary['drawsWithChips']}"
    )
    print(
        f"picked_rate={fmt_rate(summary['pickedRate'])} ({summary['pickCount']}) "
        f"redraw_rate={fmt_rate(summary['redrawRate'])} ({summary['redrawCount']}) "
        f"cleared_rate={fmt_rate(summary['clearedRate'])} ({summary['clearedCount']})"
    )
    print(
        f"changed_after_pick={fmt_rate(summary['changedAfterPickRate'])} "
        f"({summary['changedAfterPick']}/{summary['comparedAfterPick']} comparable, "
        f"sent_after_pick={summary['sentAfterPick']}, unresolved={summary['unresolvedSent']})"
    )
    print(
        f"缓存命中次数(cache_hits)={summary['cacheHits']} "
        f"真实调用次数(upstream_calls)={summary['upstreamCalls']}"
    )


# ---------------------------------------------------------------------------
# blind annotation sheet + scorer
# ---------------------------------------------------------------------------


def generate_blind_sheet(
    results: dict, limit: int = 40, seed: int = 7
) -> tuple[list[dict], list[dict]]:
    """Return (manifest, key). The manifest hides every config and verdict."""
    candidates: list[dict] = []
    judges = list((results.get("judges") or {}).keys())
    for sample in results.get("samples") or []:
        actual = sample.get("actual")
        if actual is None:
            actual = (sample.get("_actual") or "")
        for config_label, outcome in (sample.get("configs") or {}).items():
            if not outcome or outcome.get("error"):
                continue
            chips = outcome.get("chips") or []
            verdicts_by_judge = outcome.get("verdicts") or {}
            for index, chip in enumerate(chips):
                verdicts = {}
                for judge in judges:
                    values = verdicts_by_judge.get(judge) or []
                    verdicts[judge] = values[index] if index < len(values) else None
                known = [value for value in verdicts.values() if value is not None]
                if len(set(known)) <= 1:
                    continue
                candidates.append(
                    {
                        "actual": actual,
                        "chip": chip,
                        "config": config_label,
                        "messageId": sample.get("messageId"),
                        "verdicts": verdicts,
                    }
                )

    rng = random.Random(seed)
    rng.shuffle(candidates)
    chosen = candidates[:limit]
    manifest: list[dict] = []
    key: list[dict] = []
    for index, entry in enumerate(chosen, start=1):
        manifest.append({"id": index, "actual": entry["actual"], "chip": entry["chip"]})
        key.append(
            {
                "id": index,
                "config": entry["config"],
                "messageId": entry["messageId"],
                "verdicts": entry["verdicts"],
            }
        )
    return manifest, key


def read_annotations(path: pathlib.Path) -> dict[int, str]:
    """Read human labels. Accepts JSONL `{id, verdict}` or text `1同 2近 3异`."""
    text = path.read_text(encoding="utf-8", errors="replace")
    annotations: dict[int, str] = {}
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        for row in read_jsonl(path):
            identifier = row.get("id")
            verdict = normalize_verdict(row.get("verdict") or row.get("label"))
            if isinstance(identifier, int) and verdict:
                annotations[identifier] = verdict
        return annotations
    tokens = re.findall(r"(\d+)\s*([同近异]|same|near|different)", text, re.IGNORECASE)
    if tokens:
        for identifier, verdict in tokens:
            mapped = normalize_verdict(verdict)
            if mapped:
                annotations[int(identifier)] = mapped
        return annotations
    # Fallback: a bare sequence of 1/2/3 in manifest order.
    numbers = re.findall(r"[123]", text)
    for index, number in enumerate(numbers, start=1):
        annotations[index] = {"1": "same", "2": "near", "3": "different"}[number]
    return annotations


def score_annotations(manifest: list[dict], key: list[dict], annotations: dict[int, str]) -> dict:
    key_by_id = {int(entry["id"]): entry for entry in key}
    per_judge: dict[str, dict[str, int]] = {}
    for row in manifest:
        identifier = int(row["id"])
        human = annotations.get(identifier)
        if human is None:
            continue
        entry = key_by_id.get(identifier)
        if entry is None:
            continue
        for judge, verdict in (entry.get("verdicts") or {}).items():
            if verdict is None:
                continue
            counts = per_judge.setdefault(judge, {"n": 0, "exact": 0, "sameOrNear": 0})
            counts["n"] += 1
            if verdict == human:
                counts["exact"] += 1
            if (verdict in ("same", "near")) == (human in ("same", "near")):
                counts["sameOrNear"] += 1
    result = {"annotated": len(annotations), "judges": {}}
    for judge, counts in per_judge.items():
        result["judges"][judge] = {
            "n": counts["n"],
            "exact": counts["exact"],
            "exactRate": (counts["exact"] / counts["n"]) if counts["n"] else None,
            "sameOrNear": counts["sameOrNear"],
            "sameOrNearRate": (counts["sameOrNear"] / counts["n"]) if counts["n"] else None,
        }
    return result


def print_scores(scored: dict) -> None:
    print(f"annotated={scored['annotated']}")
    for judge, row in scored["judges"].items():
        print(
            f"{judge:<20} n={row['n']:>3} exact={fmt_rate(row['exactRate'])} "
            f"same_or_near={fmt_rate(row['sameOrNearRate'])}"
        )


# ---------------------------------------------------------------------------
# selftest: a loopback fake gateway
# ---------------------------------------------------------------------------

_FAKE_LOCK = threading.Lock()
_FAKE_STATE: dict = {"requests": []}


def _fake_chips(model: str) -> list[str]:
    return [
        f"{model} 候选一：按计划继续；先看读数",
        f"{model} 候选二：先别改，我再看一眼",
        f"{model} 候选三：测吧，重点看延迟",
    ]


def _fake_verdicts(model: str, count: int) -> list[str]:
    if "pro" in model:
        return [("same", "near", "different")[index % 3] for index in range(count)]
    return ["same" if index == 0 else "different" for index in range(count)]


class _FakeGatewayHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # keep the selftest output clean
        pass

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = {}
        with _FAKE_LOCK:
            _FAKE_STATE["requests"].append(
                {
                    "path": self.path,
                    "headers": {key.lower(): value for key, value in self.headers.items()},
                    "body": body,
                }
            )
        protocol = "anthropic" if self.path.rstrip("/").endswith("/messages") else "openai"
        messages = body.get("messages") or []
        if protocol == "anthropic":
            system = body.get("system") or ""
        else:
            system = ""
            for message in messages:
                if message.get("role") == "system":
                    system = message.get("content") or ""
        user = ""
        for message in messages:
            if message.get("role") == "user":
                user = message.get("content") or ""
        if isinstance(user, list):
            user = "".join(part.get("text", "") for part in user if isinstance(part, dict))
        model = str(body.get("model") or "")

        if "评判" in system:
            count = len(re.findall(r"(?m)^\d+\.\s", user))
            text = json.dumps({"verdicts": _fake_verdicts(model, count)}, ensure_ascii=False)
        else:
            text = json.dumps({"chips": _fake_chips(model)}, ensure_ascii=False)

        if protocol == "anthropic":
            payload = {
                "content": [{"type": "text", "text": text}],
                "usage": {"input_tokens": 12, "output_tokens": 7},
            }
        else:
            payload = {
                "choices": [{"message": {"role": "assistant", "content": text}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 7},
            }
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def _start_fake_gateway() -> tuple[http.server.ThreadingHTTPServer, str]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeGatewayHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    return server, base


# ---------------------------------------------------------------------------
# selftest steps
# ---------------------------------------------------------------------------


def selftest_agreement() -> dict:
    fixture = json.loads(AGREEMENT_FIXTURE.read_text(encoding="utf-8"))
    trials = fixture["trials"]
    summary = agreement_summary(trials)
    chip_count = sum(len(trial.get("chips") or []) for trial in trials)
    print(f"agreement fixture: chips={chip_count} messages={len(trials)}")
    print(
        "per-chip   conservative same={} same-or-near={}".format(
            fmt_rate(summary["perChipSame"]), fmt_rate(summary["perChipSameOrNear"])
        )
    )
    print(
        "per-message conservative same={} same-or-near={}".format(
            fmt_rate(summary["perMessageSame"]), fmt_rate(summary["perMessageSameOrNear"])
        )
    )
    # The fixture's expected block and the script's built-in literals must agree.
    for key, expected in EXPECTED_AGREEMENT.items():
        fixture_value = fixture["expected"][key]
        assert abs(fixture_value - expected) < 1e-9, (key, fixture_value, expected)
        actual = summary[key]
        assert actual is not None and abs(actual - expected) < 1e-9, (key, actual, expected)
    return summary


def selftest_replay() -> dict:
    records = [
        {"at": "2026-01-01T00:00:01Z", "type": "shown", "sessionId": "sess-a", "draw": 1,
         "chips": ["好，按计划继续", "先别改，我看下", "改吧"]},
        # A cache hit repeats the same batch (`draw` is unchanged): it must not be
        # counted as another batch, and its chips must not overwrite the real row.
        {"at": "2026-01-01T00:00:01Z", "type": "shown", "sessionId": "sess-a", "draw": 1,
         "served": "cache", "chips": ["缓存副本一", "缓存副本二"]},
        {"at": "2026-01-01T00:00:02Z", "type": "picked", "sessionId": "sess-a", "draw": 1, "index": 0},
        {"at": "2026-01-01T00:00:03Z", "type": "sent", "sessionId": "sess-a", "draw": 1},
        {"at": "2026-01-01T00:00:04Z", "type": "shown", "sessionId": "sess-a", "draw": 2,
         "chips": ["测吧", "先别测"]},
        {"at": "2026-01-01T00:00:05Z", "type": "redrawn", "sessionId": "sess-a", "draw": 2},
        {"at": "2026-01-01T00:00:06Z", "type": "shown", "sessionId": "sess-b", "draw": 1,
         "chips": ["测吧", "先别测"]},
        {"at": "2026-01-01T00:00:07Z", "type": "picked", "sessionId": "sess-b", "draw": 1, "index": 1},
        {"at": "2026-01-01T00:00:08Z", "type": "sent", "sessionId": "sess-b", "draw": 1},
        # An explicit upstream row; the earlier rows have no field and are old
        # records, which must read as real calls too.
        {"at": "2026-01-01T00:00:09Z", "type": "shown", "sessionId": "sess-b", "draw": 2,
         "served": "upstream", "chips": ["按计划继续", "改吧", "先看看"]},
        {"at": "2026-01-01T00:00:10Z", "type": "cleared", "sessionId": "sess-b", "draw": 2},
    ]
    with tempfile.TemporaryDirectory(prefix="reply-bench-") as temp_dir:
        root = pathlib.Path(temp_dir)
        transcript = [
            {"type": "user", "timestamp": "2026-01-01T00:00:03Z",
             "message": {"content": "好，按计划继续"}},
            {"type": "user", "timestamp": "2026-01-01T00:00:08Z",
             "message": {"content": "先别测，等我看完再说"}},
        ]
        write_jsonl(root / "proj" / "sess-a.jsonl", transcript[:1])
        write_jsonl(root / "proj" / "sess-b.jsonl", transcript[1:])
        summary = replay_usage(pathlib.Path("unused"), transcripts_root=root, records=records)
    assert summary["draws"] == 4, summary
    assert summary["upstreamCalls"] == 4, summary
    assert summary["cacheHits"] == 1, summary
    assert abs(summary["pickedRate"] - 0.5) < 1e-9, summary
    assert abs(summary["redrawRate"] - 0.25) < 1e-9, summary
    assert abs(summary["changedAfterPickRate"] - 0.5) < 1e-9, summary
    print(
        "[selftest] replay: picked=0.500 redrawn=0.250 changed_after_pick=0.500 "
        "upstream_calls=4 cache_hits=1"
    )
    return summary


def _synthetic_blind_results() -> dict:
    """40 chips whose two judges always disagree, so the sheet has 40 rows."""
    samples = []
    # 40 chips spread over 20 messages x 2 configs, 2 chips each.
    for message_index in range(20):
        sample = {
            "id": message_index + 1,
            "messageId": f"msg-{message_index + 1}",
            "actual": f"合成答案 {message_index + 1}",
            "configs": {},
        }
        for config_label in ("cfg-a", "cfg-b"):
            base = message_index * 2
            chips = [f"合成候选 {base + 1}", f"合成候选 {base + 2}"]
            # The two judges disagree on EVERY chip (same vs different), which
            # guarantees the disagreement-driven sheet can fill all 40 rows.
            sample["configs"][config_label] = {
                "chips": chips,
                "verdicts": {
                    "judge-one": ["same", "same"],
                    "judge-two": ["different", "different"],
                },
                "error": None,
            }
        samples.append(sample)
    return {
        "generators": {"cfg-a": {"label": "cfg-a"}, "cfg-b": {"label": "cfg-b"}},
        "judges": {"judge-one": {"label": "judge-one"}, "judge-two": {"label": "judge-two"}},
        "samples": samples,
    }


def selftest_blind() -> dict:
    results = _synthetic_blind_results()
    manifest, key = generate_blind_sheet(results, limit=40)
    assert len(manifest) == 40, len(manifest)
    serialized = json.dumps(manifest, ensure_ascii=False)
    for forbidden in ("cfg-a", "cfg-b", "judge-one", "judge-two"):
        assert forbidden not in serialized, forbidden
    # Synthetic human answers, in manifest order (id 1..40): the first 20 are
    # "same", the next 10 "near", the rest "different".
    annotations: dict[int, str] = {}
    for identifier in range(1, 41):
        if identifier <= 20:
            annotations[identifier] = "same"
        elif identifier <= 30:
            annotations[identifier] = "near"
        else:
            annotations[identifier] = "different"
    scored = score_annotations(manifest, key, annotations)
    # Hand-computed from the construction, independent of the shuffle:
    #   human labels: ids 1-20 = same, ids 21-30 = near, ids 31-40 = different.
    #   judge-one   : same on every chip  -> exact = 20/40, same-or-near = 30/40.
    #   judge-two   : different on every chip -> exact = 10/40, same-or-near = 10/40.
    one = scored["judges"]["judge-one"]
    two = scored["judges"]["judge-two"]
    assert one["n"] == 40 and two["n"] == 40
    assert one["exact"] == 20, one
    assert one["sameOrNear"] == 30, one
    assert two["exact"] == 10, two
    assert two["sameOrNear"] == 10, two
    assert abs(one["exactRate"] - 0.5) < 1e-9
    assert abs(one["sameOrNearRate"] - 0.75) < 1e-9
    assert abs(two["exactRate"] - 0.25) < 1e-9
    assert abs(two["sameOrNearRate"] - 0.25) < 1e-9
    print("[selftest] blind: 40 rows, config hidden, scores match hand-computed values")
    print_scores(scored)
    return {"manifest": manifest, "key": key, "scores": scored}


def selftest_blind_with_files() -> dict:
    """Exercise the on-disk manifest/key/annotations round trip."""
    results = _synthetic_blind_results()
    with tempfile.TemporaryDirectory(prefix="reply-bench-") as temp_dir:
        root = pathlib.Path(temp_dir)
        manifest, key = generate_blind_sheet(results, limit=40)
        write_jsonl(root / "blind.jsonl", manifest)
        write_jsonl(root / "blind-key.jsonl", key)
        annotations_text = " ".join(
            f"{identifier}{'同' if identifier <= 20 else ('近' if identifier <= 30 else '异')}"
            for identifier in range(1, 41)
        )
        (root / "annotations.txt").write_text(annotations_text + "\n", encoding="utf-8")
        loaded_manifest = read_jsonl(root / "blind.jsonl")
        loaded_annotations = read_annotations(root / "annotations.txt")
        assert len(loaded_manifest) == 40
        assert len(loaded_annotations) == 40
        manifest_text = (root / "blind.jsonl").read_text(encoding="utf-8")
        for forbidden in ("cfg-a", "cfg-b"):
            assert forbidden not in manifest_text
    print("[selftest] blind files: manifest/key/annotations round trip ok")
    return {}


def selftest_network() -> dict:
    server, base = _start_fake_gateway()
    try:
        with _FAKE_LOCK:
            _FAKE_STATE["requests"].clear()
        anthropic_generator = {
            "label": "anth-gen", "protocol": "anthropic", "model": "v4.1flash",
            "baseUrl": base, "temperature": 0.3, "maxOutputTokens": 400,
            "timeoutMs": 5000, "disableThinking": True, "authScheme": "x-api-key",
        }
        openai_generator = {
            "label": "oa-gen", "protocol": "openai", "model": "v4.1flash",
            "baseUrl": base, "temperature": 0.3, "maxOutputTokens": 400,
            "timeoutMs": 5000, "disableThinking": True,
        }
        anthropic_judge = {
            "label": "v4pro-judge", "protocol": "anthropic", "model": "v4pro",
            "baseUrl": base, "temperature": 0.0, "maxOutputTokens": 200,
            "timeoutMs": 5000, "disableThinking": True, "authScheme": "x-api-key",
        }
        openai_judge = {
            "label": "terra-judge", "protocol": "openai", "model": "gpt-5.6-terra",
            "baseUrl": base, "temperature": 0.0, "maxOutputTokens": 200,
            "timeoutMs": 5000, "disableThinking": False,
        }

        first = complete(
            anthropic_generator, "test-key", generation_system_prompt(120),
            generation_user_prompt("助手最后一条消息的末尾。"),
        )
        assert len(parse_chips(first["text"])) == 3
        second = complete(
            openai_generator, "test-key", generation_system_prompt(120),
            generation_user_prompt("助手最后一条消息的末尾。"),
        )
        assert len(parse_chips(second["text"])) == 3
        # Thinking-off arm: the key must be absent from the JSON body.
        complete(
            {**anthropic_generator, "disableThinking": False}, "test-key",
            generation_system_prompt(120), generation_user_prompt("再生成一次。"),
        )
        with _FAKE_LOCK:
            requests = list(_FAKE_STATE["requests"])
        paths = {request["path"] for request in requests}
        assert any(path.rstrip("/").endswith("/v1/messages") for path in paths), paths
        assert any(path.rstrip("/").endswith("/v1/chat/completions") for path in paths), paths
        assert all(request["body"].get("temperature") == 0.3 for request in requests)
        assert all(request["body"].get("max_tokens") == 400 for request in requests)
        assert any(request["body"].get("thinking") == {"type": "disabled"} for request in requests)
        assert any("thinking" not in request["body"] for request in requests)
        print("[selftest] generation: anthropic + openai ok; temperature and thinking knobs observed")

        chips = parse_chips(first["text"])
        verdicts_one = judge_chips(anthropic_judge, "test-key", "用户的真实回复", chips)
        verdicts_two = judge_chips(openai_judge, "test-key", "用户的真实回复", chips)
        assert len(verdicts_one) == 3 and len(verdicts_two) == 3
        assert verdicts_one != verdicts_two
        print("[selftest] judges: two judges returned three verdicts each")

        samples = [
            {"id": 1, "messageId": "m1", "tail": "助手第一轮的末尾。", "actual": "好，按计划继续"},
            {"id": 2, "messageId": "m2", "tail": "助手第二轮的末尾。", "actual": "先别改，我看下"},
        ]
        matrix = {
            "generation": [anthropic_generator, openai_generator],
            "judges": [anthropic_judge, openai_judge],
        }
        results = run_matrix(samples, matrix, {"baseUrl": base}, "test-key", concurrency=2)
        summary = aggregate_results(results)
        assert set(summary["configs"]) == {"anth-gen", "oa-gen"}
        for row in summary["configs"].values():
            assert row["messages"] == 2 and row["errors"] == 0, row
            assert row["chips"] == 6, row
            assert 0.0 <= row["conservative"]["perChipSame"] <= 1.0
            assert row["conservative"]["perChipSame"] <= row["lenient"]["perChipSame"]
        print("[selftest] matrix: 2 configs x 2 samples aggregated; conservative <= lenient")
        return {"results": results, "summary": summary}
    finally:
        server.shutdown()
        server.server_close()


# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------


def cmd_selftest(args: argparse.Namespace) -> int:
    if args.only == "agreement":
        selftest_agreement()
        print("agreement ok")
        return 0
    if args.only == "blind":
        selftest_blind()
        selftest_blind_with_files()
        print("blind ok")
        return 0
    if args.only == "replay":
        selftest_replay()
        print("replay ok")
        return 0
    selftest_network()
    selftest_agreement()
    print("[selftest] agreement: fixture numbers match built-in expectation")
    selftest_replay()
    selftest_blind()
    selftest_blind_with_files()
    print("selftest ok")
    return 0


def cmd_sample(args: argparse.Namespace) -> int:
    entrypoints = None
    if args.entrypoints:
        entrypoints = {item.strip() for item in args.entrypoints.split(",") if item.strip()}
    samples = sample_transcripts(
        pathlib.Path(os.path.expanduser(args.transcripts)),
        limit=args.limit,
        days=args.days,
        entrypoints=entrypoints,
        max_gap_seconds=args.max_gap_seconds,
    )
    write_jsonl(pathlib.Path(args.out), samples)
    print(f"sampled={len(samples)} out={args.out} (local-only; do not commit)")
    return 0


def _load_matrix(args: argparse.Namespace, settings: dict) -> dict:
    if not args.matrix:
        raise SystemExit(
            "no --matrix given: create one with at least two judges (see README.md)"
        )
    return json.loads(pathlib.Path(args.matrix).read_text(encoding="utf-8"))


def cmd_run(args: argparse.Namespace) -> int:
    settings = load_settings(pathlib.Path(args.settings))
    api_key = resolve_api_key(settings)
    if not api_key:
        raise SystemExit("no API key resolved from the settings file")
    samples = read_jsonl(pathlib.Path(args.samples))
    if not samples:
        raise SystemExit(f"no samples in {args.samples}")
    missing_actual = [row for row in samples if not row.get("actual")]
    if missing_actual:
        raise SystemExit(f"{len(missing_actual)} samples have no `actual` text")
    matrix = _load_matrix(args, settings)
    results = run_matrix(samples, matrix, settings, api_key, concurrency=args.concurrency)
    summary = aggregate_results(results)
    if args.out:
        write_json(pathlib.Path(args.out), results)
        write_json(pathlib.Path(str(args.out) + ".summary.json"), summary)
        print(f"results={args.out} (local-only; do not commit)")
    print_aggregate(summary)
    return 0


def cmd_aggregate(args: argparse.Namespace) -> int:
    results = json.loads(pathlib.Path(args.results).read_text(encoding="utf-8"))
    summary = aggregate_results(results)
    print_aggregate(summary)
    return 0


def cmd_replay(args: argparse.Namespace) -> int:
    summary = replay_usage(
        pathlib.Path(os.path.expanduser(args.ledger)),
        transcripts_root=pathlib.Path(os.path.expanduser(args.transcripts)),
    )
    print_replay(summary)
    if args.out:
        write_json(pathlib.Path(args.out), summary)
    return 0


def cmd_blind(args: argparse.Namespace) -> int:
    results = json.loads(pathlib.Path(args.results).read_text(encoding="utf-8"))
    manifest, key = generate_blind_sheet(results, limit=args.limit)
    write_jsonl(pathlib.Path(args.out), manifest)
    key_path = args.key or str(args.out) + "-key.jsonl"
    write_jsonl(pathlib.Path(key_path), key)
    print(f"blind rows={len(manifest)} manifest={args.out} key={key_path} (local-only; do not commit)")
    if manifest:
        print("head:")
        for row in manifest[:5]:
            print(
                f"  {row['id']:>2}. chip={row['chip'][:40]!r} actual={row['actual'][:40]!r}"
            )
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    manifest = read_jsonl(pathlib.Path(args.manifest))
    key = read_jsonl(pathlib.Path(args.key))
    annotations = read_annotations(pathlib.Path(args.annotations))
    scored = score_annotations(manifest, key, annotations)
    print_scores(scored)
    if args.out:
        write_json(pathlib.Path(args.out), scored)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Offline benchmark for composer reply suggestions (standard library only)."
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    selftest = subcommands.add_parser("selftest", help="run the loopback self-test")
    selftest.add_argument(
        "--only",
        choices=("agreement", "blind", "replay"),
        help="run only one segment (agreement, blind or replay)",
    )
    selftest.set_defaults(handler=cmd_selftest)

    sample = subcommands.add_parser("sample", help="sample transcript pairs into a local JSONL")
    sample.add_argument("--transcripts", default=str(DEFAULT_TRANSCRIPTS))
    sample.add_argument("--out", required=True)
    sample.add_argument("--limit", type=int, default=60)
    sample.add_argument("--days", type=int, default=30)
    sample.add_argument(
        "--entrypoints",
        default="",
        help="comma separated transcript entrypoints to keep (e.g. cli,sdk-cli); empty keeps all",
    )
    sample.add_argument(
        "--max-gap-seconds",
        type=int,
        default=600,
        help="drop a pair when the user reply is later than this after the assistant message",
    )
    sample.set_defaults(handler=cmd_sample)

    run = subcommands.add_parser("run", help="generate + judge over the matrix, then aggregate")
    run.add_argument("--samples", required=True)
    run.add_argument("--matrix", required=True)
    run.add_argument("--settings", default=str(DEFAULT_SETTINGS))
    run.add_argument("--out")
    run.add_argument("--concurrency", type=int, default=4)
    run.set_defaults(handler=cmd_run)

    aggregate = subcommands.add_parser("aggregate", help="print the aggregate table for a results file")
    aggregate.add_argument("--results", required=True)
    aggregate.set_defaults(handler=cmd_aggregate)

    replay = subcommands.add_parser("replay", help="replay the backend usage ledger")
    replay.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    replay.add_argument("--transcripts", default=str(DEFAULT_TRANSCRIPTS))
    replay.add_argument("--out")
    replay.set_defaults(handler=cmd_replay)

    blind = subcommands.add_parser("blind", help="build a blind annotation sheet from judge disagreements")
    blind.add_argument("--results", required=True)
    blind.add_argument("--out", required=True)
    blind.add_argument("--key")
    blind.add_argument("--limit", type=int, default=40)
    blind.set_defaults(handler=cmd_blind)

    score = subcommands.add_parser("score", help="score human annotations against the judges")
    score.add_argument("--manifest", required=True)
    score.add_argument("--key", required=True)
    score.add_argument("--annotations", required=True)
    score.add_argument("--out")
    score.set_defaults(handler=cmd_score)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":
    sys.exit(main())
