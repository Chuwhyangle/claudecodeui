#!/usr/bin/env python3
"""Deterministic view of the results. Semantic equivalence is a human read; this file only
prints the texts side by side and the lexical readings (CER to R, identifiers, context leaks)."""
import json, os, re, statistics, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
fixtures = {f['key']: f for f in json.load(open(os.path.join(ROOT, 'out/fixtures.json')))['items']}
results = [json.loads(l) for l in open(os.path.join(ROOT, 'out/results.jsonl')) if l.strip()]
by = {}
for r in results: by.setdefault((r['arm'], r['key']), []).append(r)
for v in by.values(): v.sort(key=lambda r: r['rep'])

def norm(s):
    return re.sub(r'[^一-鿿A-Za-z0-9]', '', s or '').lower()
def cer(a, b):
    x, y = norm(a), norm(b)
    if not x and not y: return 0.0
    dp = list(range(len(y) + 1))
    for i in range(1, len(x) + 1):
        prev = dp[0]; dp[0] = i
        for j in range(1, len(y) + 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (x[i - 1] != y[j - 1]))
            prev = cur
    return dp[len(y)] / max(len(x), len(y))
TERM = re.compile(r'[A-Za-z][A-Za-z0-9_.\-]*|\d+')
def terms(s): return {t.lower() for t in TERM.findall(s or '')}
def added_terms(cand, asr, relay):
    base = terms(asr) | terms(relay)
    return sorted(terms(cand) - base)
def context_latin_hits(cand, ctx, asr, relay):
    base = terms(asr) | terms(relay)
    ct = terms(ctx)
    return sorted(t for t in terms(cand) & ct - base if len(t) >= 3)

ARMS = ['N0', 'N1', 'N1-wrong', 'N2', 'T']
for key, f in fixtures.items():
    print('\n' + '=' * 100)
    print(f'## {key}  ({f["audioSeconds"]}s, ctx {f["contextChars"]}/{f["contextRows"]})')
    print('ASR   :', f['asr'])
    print('R     :', f['relay'])
    for arm in ARMS:
        rows = by.get((arm, key), [])
        if not rows: continue
        for r in rows:
            txt = r.get('text', '')
            extra = ''
            if r.get('applied'): extra += f" applied={r['applied']}"
            if r.get('rejected'): extra += f" rejected={r['rejected']}"
            print(f'{arm:8s} rep{r["rep"]} status={r["status"]} {r["ms"]}ms cerR={cer(txt, f["relay"]):.3f} addedTerms={added_terms(txt, f["asr"], f["relay"])} ctxHits={context_latin_hits(txt, f["context"], f["asr"], f["relay"])}{extra}')
            print('         ', txt)
print('\n' + '=' * 100)
print('## latency (successful calls)')
for arm in ARMS:
    vals = [r['ms'] for r in results if r['arm'] == arm and r['status'] == 200]
    if vals:
        vals.sort()
        p50 = vals[len(vals) // 2]; p90 = vals[min(len(vals) - 1, int(len(vals) * 0.9))]
        print(f'{arm:8s} n={len(vals)} p50={p50}ms p90={p90}ms max={max(vals)}ms')
