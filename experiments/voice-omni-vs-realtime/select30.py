#!/usr/bin/env python3
"""Select 30 clean LIVE Voice utterances and cut each at the ENDPOINT buffer boundary:
  start = speech_started - 300 ms, end = input_audio_buffer.committed (not speech_stopped).
The context pack is rebuilt for the connection and checked against the proxy's chars/rows.
"""
import json, os, re, wave, datetime, collections

ROOT = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser('~')
LOG = os.path.join(HOME, '.cloudcli/voice-realtime-log')
CAP = os.path.join(HOME, '.cloudcli/voice-realtime-capture')
HIST = os.path.join(ROOT, 'out/history')
OUT = os.path.join(ROOT, 'out')
AUDIO = os.path.join(OUT, 'audio30')
os.makedirs(AUDIO, exist_ok=True)

# Pairing-noise exclusions + the one connection whose context pack cannot be recovered exactly
# (683b: a compaction summary makes the frontend's visible-row set differ from the transcript dump).
EXCLUDE = {('4faf66a8', 0), ('711e54cc', 2), ('b8360029', 0)}

def ts(s): return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

def rel_time(timestamp, now_ms):
    at = datetime.datetime.fromisoformat(timestamp.replace('Z', '+00:00')).timestamp() * 1000
    m = int(max(0, now_ms - at) // 60000)
    if m < 1: return '刚刚'
    if m < 60: return f'{m} 分钟前'
    h = m // 60
    if h < 24: return f'{h} 小时前'
    return f'{h // 24} 天前'

def elide(t, cap):
    if len(t) <= cap: return t
    if cap <= 1: return t[:max(cap, 0)]
    head = int(cap * 0.7); tail = cap - head - 1
    return t[:head] + '…' + t[-tail:]

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
        add = len(line) + (1 if taken else 0)
        if chars + add > 2000: break
        taken.append(line); chars += add
    taken.reverse()
    return '\n'.join(taken), chars, len(taken)

def read_journal(cid):
    conn = None; ctx = None; trans = []; sends = []
    for line in open(os.path.join(LOG, cid + '.jsonl'), errors='replace'):
        try: o = json.loads(line)
        except Exception: continue
        if o.get('kind') == 'connection': conn = o
        elif o.get('kind') == 'log':
            m = re.search(r'context received chars=(\d+) rows=(\d+)', o.get('line', ''))
            if m and ctx is None: ctx = (int(m.group(1)), int(m.group(2)))
            m = re.search(r'transcription\.completed "(.*)"$', o.get('line', ''))
            if m: trans.append((o['at'], m.group(1)))
        elif o.get('kind') == 'session_send' and o.get('message'):
            sends.append((o['at'], o['message']))
    pairs = []; used = set()
    for t, text in trans:
        cand = [(j, s, m) for j, (s, m) in enumerate(sends)
                if j not in used and ts(s) >= ts(t) and ts(s) - ts(t) <= 10]
        if cand:
            j, s, m = cand[0]; used.add(j)
            pairs.append({'at': t, 'asr': text, 'sentAt': s, 'relay': m})
    return conn, ctx, pairs

def read_intervals(cid):
    path = os.path.join(CAP, cid + '.timeline.jsonl')
    if not os.path.exists(path): return []
    ev = []
    for line in open(path):
        o = json.loads(line)
        if o.get('kind') in ('speech_started', 'speech_stopped', 'committed'): ev.append(o)
    intervals = []; starts = []
    for o in ev:
        if o.get('kind') == 'speech_started': starts.append(o)
        elif o.get('kind') == 'committed' and starts:
            s = starts.pop(0); intervals.append({'start': s['offsetMs'], 'end': o['offsetMs'], 'itemId': o.get('itemId')})
    return intervals

def cut(cid, start_ms, end_ms, dest):
    src = os.path.join(CAP, cid + '.wav')
    with wave.open(src, 'rb') as w:
        rate = w.getframerate(); n = w.getnframes()
        a = max(0, int((start_ms - 300) * rate // 1000))
        b = min(n, int(end_ms * rate // 1000))
        w.setpos(a); frames = w.readframes(b - a)
        with wave.open(dest, 'wb') as o:
            o.setnchannels(1); o.setsampwidth(2); o.setframerate(rate); o.writeframes(frames)
    return (b - a) / rate

items = []
for jp in sorted(os.listdir(LOG)):
    if not jp.endswith('.jsonl'): continue
    cid = jp[:-6]
    conn, ctx, pairs = read_journal(cid)
    if not conn or not ctx: continue
    intervals = read_intervals(cid)
    if len(pairs) != len(intervals): continue
    hist_path = os.path.join(HIST, f'hist-{conn["sessionId"]}.json')
    if not os.path.exists(hist_path): continue
    messages = json.load(open(hist_path))
    pack, chars, rows = build_pack(messages, conn['at'])
    if (chars, rows) != ctx: continue  # context not recoverable exactly -> not selected
    for i, (p, iv) in enumerate(zip(pairs, intervals)):
        if (cid[:8], i) in EXCLUDE: continue
        prev_commit = intervals[i - 1]['end'] if i > 0 else 0
        next_start = intervals[i + 1]['start'] if i + 1 < len(intervals) else 10**9
        gap_prev = iv['start'] - prev_commit
        gap_next = next_start - iv['end']
        dur = (iv['end'] - iv['start']) / 1000
        if i > 0 and gap_prev < 500: continue
        if gap_next < 500: continue
        if not (1.0 <= dur <= 30): continue
        if len(p['asr'].strip()) < 2 or len(p['relay'].strip()) < 2: continue
        key = f'{cid[:8]}-{i}'
        dest = os.path.join(AUDIO, key + '.wav')
        seconds = cut(cid, iv['start'], iv['end'], dest)
        items.append({**p, 'key': key, 'connectionId': cid, 'sessionId': conn['sessionId'],
                      'connectionAt': conn['at'], 'context': pack, 'contextChars': chars, 'contextRows': rows,
                      'startMs': iv['start'], 'endMs': iv['end'], 'audioSeconds': round(seconds, 3), 'audio': dest})
print('selected', len(items))
by = collections.Counter(i['sessionId'][:8] for i in items)
print('by session', dict(by))
for i in items:
    print(f'{i["key"]:18s} {i["audioSeconds"]:5.2f}s ASR={i["asr"][:60]!r} -> {i["relay"][:60]!r}')
json.dump({'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'items': items},
          open(os.path.join(OUT, 'fixtures-30.json'), 'w'), ensure_ascii=False, indent=1)
print('wrote', os.path.join(OUT, 'fixtures-30.json'))
