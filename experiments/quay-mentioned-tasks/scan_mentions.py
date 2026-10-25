#!/usr/bin/env python3
"""Scan recent Claude session transcripts for mentions of quay task/goal ids.

Question this answers: how often does a *complete* task id (tasks/*.md slug) or
goal id (GOAL-NNN) appear in the user/assistant MESSAGE BODIES of recent
sessions — excluding tool calls (assistant `tool_use`/`thinking` blocks and user
`tool_result` blocks) — and how deep in the transcript those mentions sit, so we
can decide "full transcript" vs "last N messages".

Usage:
  python3 scan_mentions.py --project-root <repo> \
      --transcript-dir ~/.claude/projects/-data-home-yale-work-claudecodeui \
      --recent 250 --out report.json
"""
import argparse
import collections
import json
import os
import re
import statistics
import sys
import time

ID_TOKEN_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]*')


def load_vocab(project_root: str) -> tuple[set[str], set[str]]:
    """(task_ids, goal_ids), both lowercased. Task ids are tasks/*.md slugs;
    goal ids are the GOAL-NNN prefix of goals/*.md filenames."""
    tasks: set[str] = set()
    tasks_dir = os.path.join(project_root, 'tasks')
    if os.path.isdir(tasks_dir):
        for fn in os.listdir(tasks_dir):
            if fn.endswith('.md'):
                tasks.add(fn[:-3].lower())

    goals: set[str] = set()
    goals_dir = os.path.join(project_root, 'goals')
    if os.path.isdir(goals_dir):
        for fn in os.listdir(goals_dir):
            if fn.endswith('.md'):
                m = re.match(r'(goal-\d{3})', fn[:-3].lower())
                if m:
                    goals.add(m.group(1))
    return tasks, goals


def extract_text(entry: dict) -> tuple[str, int]:
    """Text body of a user/assistant entry, and how many tool-ish blocks were
    excluded. Returns the concatenated `text` blocks only; `tool_use`,
    `tool_result` and `thinking` blocks are dropped (they are not message body)."""
    msg = entry.get('message') or {}
    content = msg.get('content')
    if isinstance(content, str):
        return content, 0
    if isinstance(content, list):
        parts: list[str] = []
        excluded = 0
        for block in content:
            if not isinstance(block, dict):
                continue
            t = block.get('type')
            if t == 'text' and isinstance(block.get('text'), str):
                parts.append(block['text'])
            elif t in ('tool_use', 'tool_result', 'thinking'):
                excluded += 1
        return '\n'.join(parts), excluded
    return '', 0


def mentions_in(text: str, vocab: frozenset[str]) -> collections.Counter:
    """Count complete-id occurrences by tokenising on non-id characters and
    looking each token up in the closed vocab (case-insensitive exact match)."""
    hits: collections.Counter = collections.Counter()
    for tok in ID_TOKEN_RE.findall(text):
        low = tok.lower()
        if low in vocab:
            hits[low] += 1
    return hits


def recent_transcripts(transcript_dir: str, limit: int) -> list[tuple[str, float]]:
    """Top-level *.jsonl sorted by mtime desc, newest first; (path, mtime)."""
    entries = []
    for fn in os.listdir(transcript_dir):
        if not fn.endswith('.jsonl'):
            continue
        p = os.path.join(transcript_dir, fn)
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            continue
        entries.append((p, mtime))
    entries.sort(key=lambda e: e[1], reverse=True)
    return entries[:limit]


def scan_session(path: str, vocab: frozenset[str]) -> dict:
    """Stream one session's transcript and return its mention summary."""
    units = 0                       # user/assistant text units seen
    mentions: list[dict] = []       # one dict per mention
    excluded_blocks = 0
    entries_seen = 0
    tool_use_mentions = 0           # mentions that would appear if tool blocks counted
    tool_text_total_chars = 0
    body_text_total_chars = 0

    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            entries_seen += 1
            etype = entry.get('type')
            if etype not in ('user', 'assistant'):
                continue

            text, excluded = extract_text(entry)
            excluded_blocks += excluded
            units += 1
            body_text_total_chars += len(text)

            hits = mentions_in(text, vocab)
            for tid, count in hits.items():
                mentions.append({
                    'id': tid,
                    'kind': 'goal' if tid.startswith('goal-') else 'task',
                    'unit': units,
                    'count': count,
                })

            # Noise quantification: what the same scan would add if tool-ish
            # blocks were treated as body. Read them separately here.
            msg = entry.get('message') or {}
            content = msg.get('content')
            if isinstance(content, list):
                tool_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get('type') in ('tool_use', 'tool_result', 'thinking'):
                        # tool_use input is a dict; only string-ify text-like fields
                        raw = block.get('text')
                        if isinstance(raw, str):
                            tool_parts.append(raw)
                        elif block.get('type') == 'tool_use' and isinstance(block.get('input'), dict):
                            tool_parts.append(json.dumps(block['input'], ensure_ascii=False))
                tool_text = '\n'.join(tool_parts)
                tool_text_total_chars += len(tool_text)
                tool_use_mentions += sum(mentions_in(tool_text, vocab).values())

    distinct = sorted({m['id'] for m in mentions})
    return {
        'session': os.path.basename(path)[:-6],
        'mtime': os.path.getmtime(path),
        'entries': entries_seen,
        'units': units,
        'excludedBlocks': excluded_blocks,
        'bodyChars': body_text_total_chars,
        'toolChars': tool_text_total_chars,
        'mentions': mentions,
        'mentionCount': sum(m['count'] for m in mentions),
        'distinctCount': len(distinct),
        'toolBlockMentionCount': tool_use_mentions,
    }


def pct(numer, denom):
    return 0.0 if denom == 0 else 100.0 * numer / denom


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--project-root', required=True)
    ap.add_argument('--transcript-dir', required=True)
    ap.add_argument('--recent', type=int, default=250)
    ap.add_argument('--out', default='report.json')
    args = ap.parse_args()

    tasks, goals = load_vocab(args.project_root)
    vocab = frozenset(tasks | goals)
    print(f'vocab: {len(tasks)} task ids, {len(goals)} goal ids, {len(vocab)} total', file=sys.stderr)

    sessions = recent_transcripts(args.transcript_dir, args.recent)
    print(f'scanning {len(sessions)} recent sessions', file=sys.stderr)

    t0 = time.time()
    results = []
    for path, _mtime in sessions:
        results.append(scan_session(path, vocab))
    elapsed = time.time() - t0
    print(f'scanned in {elapsed:.1f}s', file=sys.stderr)

    with_mentions = [r for r in results if r['mentionCount'] > 0]
    # Window analysis: how many of the last K body units capture all mentions.
    windows = [20, 50, 100, 200, 500]
    window_capture = {}
    for r in with_mentions:
        total = r['units']
        for k in windows:
            if r['mentionCount'] == 0:
                continue
            captured = all(m['unit'] > total - k for m in r['mentions'])
            window_capture.setdefault(k, {'all': 0, 'any_missed': 0})
            window_capture[k]['all'] += 1 if captured else 0
            window_capture[k]['any_missed'] += 0 if captured else 1

    all_mentions = [m for r in with_mentions for m in r['mentions']]
    # What fraction of ALL mention occurrences fall inside the last K body units
    # of their own session (the full-transcript vs last-N question).
    mention_tail_pct = {}
    for k in windows:
        captured = 0
        for r in with_mentions:
            captured += sum(1 for m in r['mentions'] if m['unit'] > r['units'] - k)
        mention_tail_pct[k] = round(pct(captured, len(all_mentions)), 1) if all_mentions else 0.0

    id_freq = collections.Counter(m['id'] for m in all_mentions)
    top = id_freq.most_common(30)

    report = {
        'scanned': len(results),
        'sessionsWithMentions': len(with_mentions),
        'sessionsWithMentionsPct': round(pct(len(with_mentions), len(results)), 1),
        'totalMentions': sum(r['mentionCount'] for r in results),
        'totalToolBlockMentions': sum(r['toolBlockMentionCount'] for r in results),
        'bodyChars': sum(r['bodyChars'] for r in results),
        'toolChars': sum(r['toolChars'] for r in results),
        'sessionsByDistinctCount': {
            'min': min((r['distinctCount'] for r in with_mentions), default=0),
            'max': max((r['distinctCount'] for r in with_mentions), default=0),
            'median': statistics.median([r['distinctCount'] for r in with_mentions]) if with_mentions else 0,
        },
        'mentionDepth': {
            'sessions': [
                {
                    'session': r['session'],
                    'units': r['units'],
                    'distinct': r['distinctCount'],
                    'mentions': r['mentionCount'],
                    'lastUnit': max((m['unit'] for m in r['mentions']), default=0),
                }
                for r in sorted(with_mentions, key=lambda r: -r['mtime'])[:40]
            ],
            'windowFullCapture': {
                str(k): {
                    'capturesAll': window_capture.get(k, {}).get('all', 0),
                    'missesAny': window_capture.get(k, {}).get('any_missed', 0),
                }
                for k in windows
            },
            'mentionTailCapturePct': {str(k): mention_tail_pct[k] for k in windows},
        },
        'topMentions': [{'id': i, 'count': c} for i, c in top],
        'mentionKindSplit': {
            'task': sum(1 for m in all_mentions if m['kind'] == 'task'),
            'goal': sum(1 for m in all_mentions if m['kind'] == 'goal'),
        },
    }

    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f'wrote {args.out}', file=sys.stderr)

    # Human summary
    print()
    print('=== 会话里提到 task/goal 完整 id 的统计 ===')
    print(f"扫描会话: {report['scanned']}  有提及: {report['sessionsWithMentions']} ({report['sessionsWithMentionsPct']}%)")
    print(f"总提及次数: {report['totalMentions']}  若把 tool 块也算: {report['totalToolBlockMentions']}")
    print(f"正文字符: {report['bodyChars']}  tool 块字符: {report['toolChars']}")
    print(f"每会话 distinct id 数 min/median/max: {report['sessionsByDistinctCount']}")
    print(f"提及种类: task={report['mentionKindSplit']['task']} goal={report['mentionKindSplit']['goal']}")
    print()
    print('=== 最近 N 条 body 单元能否覆盖全部提及 ===')
    for k in windows:
        w = report['mentionDepth']['windowFullCapture'][str(k)]
        print(f'  最近 {k} 条: 全覆盖 {w["capturesAll"]} 个会话, 会漏 {w["missesAny"]} 个会话')
    print('=== 提及出现位置:落在会话最近 N 条 body 单元内的占比 ===')
    for k in windows:
        print(f'  最近 {k} 条: {report["mentionDepth"]["mentionTailCapturePct"][str(k)]}%')
    print()
    print('=== 提及最多的 id (top 20) ===')
    for i, c in top[:20]:
        print(f'  {i}  {c}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
