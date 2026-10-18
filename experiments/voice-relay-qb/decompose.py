"""Where did each clip's model-written text go?  (reads traces that logged response outputs)
   python3 -I decompose.py <trace.json> [...]"""
import json, re, sys
from collections import Counter, defaultdict

CLIPS = {
 'd01': ('把 server 里的 voice.service.ts 的超时改成三十秒', 'voice.service.ts'),
 'd03': ('看一下 useVoiceInput 这个 hook 是怎么处理 recording 的', 'usevoiceinput'),
 'd04': ('不要动 voice.service.ts，只改 voice.module.ts', 'voice.module.ts'),
 'd08': ('把默认模型换成 whisper large，啊不，是 whisper turbo', 'whisper'),
}
norm = lambda s: re.sub(r'[\s，。！？、,.!?"“”\'’：:；;（）()\-]', '', s).lower()
def grams(s):
    c = s.replace(' ', ''); return {c[i:i+4] for i in range(max(0, len(c) - 3))}
def present(cid, text):
    ref, anchor = CLIPS[cid]
    if norm(anchor) in norm(text): return True
    a, b = grams(norm(ref)), grams(norm(text))
    return bool(a) and len(a & b) / len(a) >= 0.5

def msg_of(o):
    try: return str(json.loads(o['args']).get('message', ''))
    except Exception:
        m = re.search(r'"message":\s*"([^"]*)', o.get('args', '')); return m.group(1) if m else ''
def has_claim(o):
    try: a = json.loads(o['args']); return 'items' in a and 'roster' in a
    except Exception: return '"items"' in o.get('args', '')

rows = []
for p in sys.argv[1:]:
    rows += [r for r in json.load(open(p))['results'] if 'error' not in r and any('outputs' in e for e in r['log'] if e['kind'] == 'response.done')]
def lag(r):
    L = [e['t'] - e['at'] for e in r['log'] if e['kind'] == 'endpoint-speech-stopped' and e.get('at') is not None]
    return max(L) if L else 0
rows = [r for r in rows if lag(r) <= 1500]          # healthy sessions only
print(f"{len(rows)} healthy sessions with logged response outputs\n")

cats = ['A model-delivered (call executed)',
        'B wrote it, call REJECTED (required claim fields missing)',
        'C wrote it as session_interrupt (probe stub delivers nothing; production delivers the message)',
        'D wrote it, but that response was CANCELLED by new speech',
        'E never wrote it: item was offered to a completed response and the message omitted it',
        'F never wrote it: no response ever covered it (ask swallowed / never asked / deadline first)']
by_arm = defaultdict(Counter); n_arm = Counter(); written_any = Counter()
for r in rows:
    arm = r['arm']
    exe = [e['message'] for e in r['log'] if e['kind'] == 'call']
    comp, canc = [], []
    for e in r['log']:
        if e['kind'] != 'response.done': continue
        for o in e.get('outputs') or []:
            if 'fn' not in o: continue
            (comp if e.get('status') == 'completed' else canc).append((o['fn'], msg_of(o), has_claim(o)))
    asks = [(e['t'], set(e['offered'])) for e in r['log'] if e['kind'] == 'ask']
    done_completed_after = lambda t: any(x['kind'] == 'response.done' and x['t'] > t and x.get('status') == 'completed' for x in r['log'])
    for c in r['perClip']:
        n_arm[arm] += 1
        cid = c['clip']
        seqs = set(c['itemSeqs'])
        if any(present(cid, m) for m in exe): cat = cats[0]
        else:
            wc = [x for x in comp if present(cid, x[1])]
            if wc and arm != 'B' and any(x[0] == 'session_send' and not x[2] for x in wc): cat = cats[1]
            elif wc and any(x[0] == 'session_interrupt' for x in wc): cat = cats[2]
            elif wc: cat = cats[1]
            elif any(present(cid, x[1]) for x in canc): cat = cats[3]
            elif any(seqs & off and done_completed_after(t) for t, off in asks): cat = cats[4]
            else: cat = cats[5]
        by_arm[arm][cat] += 1
        if cat in cats[:4]: written_any[arm] += 1

for arm in ('B', 'Q', 'Q12', 'Q12N'):
    if n_arm[arm] == 0: continue
    n = n_arm[arm]
    print(f"[{arm}]  clips={n}   the model WROTE the clip's content in some response: {written_any[arm]} ({written_any[arm]/n:.0%})   delivered through an executed model call: {by_arm[arm][cats[0]]} ({by_arm[arm][cats[0]]/n:.0%})")
    for c in cats:
        if by_arm[arm][c]: print(f"      {by_arm[arm][c]:3} ({by_arm[arm][c]/n:4.0%})  {c}")
    print()
