#!/usr/bin/env python3
"""Build the fixture for the realtime-vs-one-shot experiment.

Inputs are the LIVE Voice artifacts the product already wrote:
  ~/.cloudcli/voice-realtime-capture/<connection>.wav + .timeline.jsonl
  ~/.cloudcli/voice-realtime-log/<connection>.jsonl
  out/history/hist-<sessionId>.json  (the app's own history, dumped by dump-history.mts)

The context pack is rebuilt with the SAME rule the browser uses (newest-first, 600-char row cap,
2000-char budget) and the result is CHECKED against the proxy's own `context received chars/rows`
line. A mismatch aborts, so a fixture can never silently use a different context.
"""
import json, os, re, sys, wave, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser('~')
LOG = os.path.join(HOME, '.cloudcli/voice-realtime-log')
CAP = os.path.join(HOME, '.cloudcli/voice-realtime-capture')
HIST = os.path.join(ROOT, 'out/history')
OUT = os.path.join(ROOT, 'out')

CONN = {
    '6c76e1cf': 'c5a57036-de6c-482e-9078-d5572e528ef5',
    '711e54cc': 'ab71f2d3-6130-4929-aed4-897f462b65f3',
    'acf7fc73': 'ab71f2d3-6130-4929-aed4-897f462b65f3',
    'e8df1709': 'd7d93fad-0546-45bd-a80a-2b4596e5f834',
    'bf517472': 'd7d93fad-0546-45bd-a80a-2b4596e5f834',
    '262537d7': 'd7d93fad-0546-45bd-a80a-2b4596e5f834',
}
# The connection ids above are the first 8 chars used in the files; resolve the full names from disk.
def resolve_connection(prefix):
    for name in os.listdir(LOG):
        if name.startswith(prefix) and name.endswith('.jsonl'):
            return name[:-6]
    raise SystemExit(f'no journal for {prefix}')

ITEMS = [
    {'key': 'referent-architecture-tab', 'conn': '6c76e1cf', 'index': 0,
     'note': 'R rewrites "RTX TM 这个图" to "architecture tab" (context-dependent).'},
    {'key': 'referent-live-voice-test', 'conn': '711e54cc', 'index': 0,
     'note': 'R rewrites "外界测试" to "live voice 测试".'},
    {'key': 'term-live-voice-case', 'conn': 'bf517472', 'index': 1,
     'note': 'R normalizes "Live模式下" to "Live Voice 模式下".'},
    {'key': 'long-punctuation', 'conn': 'e8df1709', 'index': 0,
     'note': 'Long utterance; R only adds punctuation and a repeated-word comma.'},
    {'key': 'short-subject-add', 'conn': 'e8df1709', 'index': 1,
     'note': 'R adds the subject "你" ("不应该缓存" -> "你不应该缓存").'},
    {'key': 'list-punctuation', 'conn': 'e8df1709', 'index': 2,
     'note': 'R turns "commit，build" into "commit、build".'},
    {'key': 'case-normalization', 'conn': 'acf7fc73', 'index': 0,
     'note': 'R lowercases "Live Voice" and removes a comma.'},
    {'key': 'long-driving-live-voice', 'conn': '262537d7', 'index': 2,
     'note': 'Long utterance; R fixes repetition and capitalizes "Live Voice".'},
]

def ts(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

def rel_time(timestamp, now_ms):
    at = datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00')).timestamp() * 1000
    minutes = int(max(0, now_ms - at) // 60000)
    if minutes < 1: return '刚刚'
    if minutes < 60: return f'{minutes} 分钟前'
    hours = minutes // 60
    if hours < 24: return f'{hours} 小时前'
    return f'{hours // 24} 天前'

def elide(text, cap):
    if len(text) <= cap: return text
    if cap <= 1: return text[:max(cap, 0)]
    head = int(cap * 0.7); tail = cap - head - 1
    return text[:head] + '…' + text[-tail:]

def build_pack(messages, cut):
    now = datetime.datetime.fromisoformat(cut.replace('Z', '+00:00')).timestamp() * 1000
    rows = [m for m in messages
            if (m.get('timestamp') or '') <= cut
            and m.get('role') in ('user', 'assistant')
            and (m.get('content') or '').strip()
            and m.get('kind') not in ('tool_use', 'tool_result', 'thinking', 'task_notification', 'error', 'compaction')
            and not m.get('compact')]
    taken = []; chars = 0
    for m in reversed(rows):
        label = '用户' if m['role'] == 'user' else '助手'
        line = elide(f'{label}（{rel_time(m["timestamp"], now)}）：{(m["content"] or "").strip()}', 600)
        added = len(line) + (1 if taken else 0)
        if chars + added > 2000: break
        taken.append(line); chars += added
    taken.reverse()
    return '\n'.join(taken), chars, len(taken)

def parse_journal(conn):
    path = os.path.join(LOG, conn + '.jsonl')
    connection = None; expected = None
    trans = []; sends = []
    for line in open(path, errors='replace'):
        try: o = json.loads(line)
        except Exception: continue
        if o.get('kind') == 'connection': connection = o
        elif o.get('kind') == 'log':
            m = re.search(r'context received chars=(\d+) rows=(\d+)', o.get('line', ''))
            if m and expected is None: expected = (int(m.group(1)), int(m.group(2)))
            m = re.search(r'transcription\.completed "(.*)"$', o.get('line', ''))
            if m: trans.append((o['at'], m.group(1)))
        elif o.get('kind') == 'session_send' and o.get('message'):
            sends.append((o['at'], o['message']))
    pairs = []; used = set()
    for t, text in trans:
        cand = [(j, s, m) for j, (s, m) in enumerate(sends)
                if j not in used and ts(s) >= ts(t) and ts(s) - ts(t) <= 10]
        if cand:
            j, s, m = cand[0]; used.add(j); pairs.append({'at': t, 'asr': text, 'sentAt': s, 'relay': m})
    return connection, expected, pairs

def speech_intervals(conn):
    path = os.path.join(CAP, conn + '.timeline.jsonl')
    starts = []; out = []
    for line in open(path):
        o = json.loads(line)
        if o.get('kind') == 'speech_started': starts.append(o['offsetMs'])
        elif o.get('kind') in ('speech_stopped', 'committed') and starts:
            out.append((starts.pop(), o['offsetMs']))
    return out

def cut_wav(conn, start_ms, end_ms, prev_end_ms, next_start_ms, dest):
    src = os.path.join(CAP, conn + '.wav')
    with wave.open(src, 'rb') as w:
        rate = w.getframerate(); n = w.getnframes()
        # Never let the pad cross into the neighbouring speech run: two utterances 100-200 ms
        # apart are common, and a fixed 500 ms tail then feeds the NEXT sentence to this segment.
        pre = min(300, max(0, start_ms - prev_end_ms - 300)) if prev_end_ms is not None else 300
        tail = min(500, max(0, next_start_ms - end_ms - 300)) if next_start_ms is not None else 500
        a = max(0, int(start_ms - pre) * rate // 1000)
        b = min(n, int(end_ms + tail) * rate // 1000)
        w.setpos(a)
        frames = w.readframes(b - a)
        with wave.open(dest, 'wb') as o:
            o.setnchannels(1); o.setsampwidth(2); o.setframerate(rate); o.writeframes(frames)
    return (b - a) / rate

def main():
    fixtures = []
    for item in ITEMS:
        conn = resolve_connection(item['conn'])
        session = CONN[item['conn']]
        connection, expected, pairs = parse_journal(conn)
        hist_path = os.path.join(HIST, f'hist-{session}.json')
        if not os.path.exists(hist_path):
            raise SystemExit(f'missing {hist_path}; run dump-history.mts first')
        messages = json.load(open(hist_path))
        context, chars, rows = build_pack(messages, connection['at'])
        if (chars, rows) != expected:
            raise SystemExit(f'{item["conn"]}: context mismatch: rebuilt {(chars, rows)} vs journal {expected}')
        if item['index'] >= len(pairs):
            raise SystemExit(f'{item["conn"]}: no pair at index {item["index"]}')
        pair = pairs[item['index']]
        intervals = speech_intervals(conn)
        if item['index'] >= len(intervals):
            raise SystemExit(f'{item["conn"]}: no speech interval at index {item["index"]}')
        start_ms, end_ms = intervals[item['index']]
        prev_end = intervals[item['index'] - 1][1] if item['index'] > 0 else None
        next_start = intervals[item['index'] + 1][0] if item['index'] + 1 < len(intervals) else None
        audio = os.path.join(OUT, 'audio', f'{item["key"]}.wav')
        seconds = cut_wav(conn, start_ms, end_ms, prev_end, next_start, audio)
        fixtures.append({**item, 'connectionId': conn, 'sessionId': session,
                         'connectionAt': connection['at'],
                         'context': context, 'contextChars': chars, 'contextRows': rows,
                         'asr': pair['asr'], 'relay': pair['relay'],
                         'speechStartMs': start_ms, 'speechEndMs': end_ms,
                         'audioSeconds': round(seconds, 3), 'audio': audio})
        print(f'{item["key"]}: {seconds:.2f}s ctx={chars}/{rows} ASR={pair["asr"][:60]!r}')
    dest = os.path.join(OUT, 'fixtures.json')
    json.dump({'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'items': fixtures}, open(dest, 'w'), ensure_ascii=False, indent=1)
    print('wrote', dest, len(fixtures), 'items')

if __name__ == '__main__':
    main()
