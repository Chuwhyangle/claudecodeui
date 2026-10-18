"""Can the server tell an OMISSION from a rewrite using only (recogniser text, model message)?
   Labels come from the KNOWN text (is the clip's content in the message?), never from the recogniser."""
import json, glob, re, math
CLIPS = {
 'd01': ('把 server 里的 voice.service.ts 的超时改成三十秒', 'voice.service.ts'),
 'd03': ('看一下 useVoiceInput 这个 hook 是怎么处理 recording 的', 'usevoiceinput'),
 'd04': ('不要动 voice.service.ts，只改 voice.module.ts', 'voice.module.ts'),
 'd08': ('把默认模型换成 whisper large，啊不，是 whisper turbo', 'whisper'),
}
norm = lambda s: re.sub(r'[\s，。！？、,.!?"“”\'’：:；;（）()\-_·]', '', s).lower()
def ngr(s, n): return [s[i:i+n] for i in range(max(0, len(s) - n + 1))]
def present(cid, text):
    ref, anchor = CLIPS[cid]
    if norm(anchor) in norm(text): return True
    a = set(ngr(norm(ref), 4)); b = set(ngr(norm(text), 4))
    return bool(a) and len(a & b) / len(a) >= 0.5
def recall(n, a, m):
    A = ngr(norm(a), n); M = set(ngr(norm(m), n))
    return sum(1 for g in A if g in M) / len(A) if A else 1.0
def lcs_ratio(a, m):
    a, m = norm(a), norm(m)
    if not a: return 1.0
    prev = [0] * (len(m) + 1)
    for ch in a:
        cur = [0]
        for j, c2 in enumerate(m, 1): cur.append(prev[j-1] + 1 if ch == c2 else max(prev[j], cur[-1]))
        prev = cur
    return prev[-1] / len(a)
SCORES = {'bigram recall': lambda a, m: recall(2, a, m), 'trigram recall': lambda a, m: recall(3, a, m), 'LCS ratio': lcs_ratio}

pairs = []   # (asr, message, truth_present, session label)
for p in sorted(glob.glob('experiments/voice-relay-qb/traces/*.json')):
    for r in json.load(open(p))['results']:
        if 'error' in r: continue
        log = r['log']
        commits = {e['seq']: e['t'] for e in log if e['kind'] == 'commit'}
        asr = {e['seq']: e['text'] for e in log if e['kind'] == 'asr'}
        created = sorted(e['t'] for e in log if e['kind'] == 'response.created')
        dones = sorted(e['t'] for e in log if e['kind'] == 'response.done')
        calls = [(e['t'], e['message']) for e in log if e['kind'] == 'call']
        for c in r['perClip']:
            for seq in c['itemSeqs']:
                if seq not in commits or not asr.get(seq): continue
                cr = next((t for t in created if t >= commits[seq]), None)
                if cr is None: continue
                dn = next((t for t in dones if t >= cr), 10**12)
                call = next((m for t, m in calls if cr <= t <= dn), None)
                if call is None: continue
                pairs.append((asr[seq], call, present(c['clip'], call), f"{r['pattern']}/{r['arm']}"))
for p in sorted(glob.glob('experiments/voice-relay-claims/traces/*.json')):
    for r in json.load(open(p))['results']:
        if 'error' in r or not r.get('message'): continue
        for x in r['rows']:
            if x.get('text'): pairs.append((x['text'], r['message'], bool(x['present']), 'claims'))
n_abs = sum(1 for _, _, t, _ in pairs if not t); n_pre = len(pairs) - n_abs
print(f"labelled (recogniser text, message) pairs: {len(pairs)}   content PRESENT in the message: {n_pre}   content ABSENT (omitted): {n_abs}\n")

print("score distribution (median / p10 / p90) — a good detector separates the two rows:")
for name, f in SCORES.items():
    pre = sorted(f(a, m) for a, m, t, _ in pairs if t); ab = sorted(f(a, m) for a, m, t, _ in pairs if not t)
    q = lambda v, x: v[min(len(v) - 1, int(len(v) * x))] if v else float('nan')
    print(f"   {name:15} present: {q(pre,.5):.2f} / {q(pre,.1):.2f} / {q(pre,.9):.2f}      absent: {q(ab,.5):.2f} / {q(ab,.1):.2f} / {q(ab,.9):.2f}")

print("\nflag 'OMITTED' when score < t.   precision = of the items flagged, how many were truly omitted (the rest would be a garbled duplicate)")
for name, f in SCORES.items():
    print(f"   {name}")
    for t in (0.15, 0.25, 0.35, 0.5):
        flag = [(tr) for a, m, tr, _ in pairs if f(a, m) < t]
        tp = sum(1 for tr in flag if not tr)
        print(f"      t={t:.2f}: flagged {len(flag):3}  truly omitted {tp:3}  precision={tp/max(1,len(flag)):4.0%}   catches {tp}/{n_abs} = {tp/max(1,n_abs):4.0%} of the real omissions")
print("\nthe pairs the best detector gets WRONG (bigram recall, t=0.25):")
f = SCORES['bigram recall']
for a, m, tr, lab in pairs:
    s = f(a, m)
    if (s < 0.25 and tr) or (s >= 0.25 and not tr):
        print(f"   {'FALSE ALARM (content is there)' if tr else 'MISSED OMISSION             '} s={s:.2f}  ASR={a[:34]!r}  MSG={m[:40]!r}")
