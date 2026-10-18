"""Stats + worst-sample timelines for experiments/voice-relay-qb traces.
   python3 -I analyze.py <trace.json> [<trace2.json> ...] [--worst N]"""
import json, sys

def pct(a, p):
    a = sorted(a); return a[min(len(a) - 1, int(len(a) * p))] if a else float('nan')

def load(paths):
    out = []
    for p in paths:
        d = json.load(open(p))
        out += [r for r in d['results'] if 'error' not in r]
        for r in d['results']:
            if 'error' in r: print('ERROR in', p, r['error'][:200])
    return out

def lag_of(r):
    L = [e['t'] - e['at'] for e in r['log'] if e['kind'] == 'endpoint-speech-stopped' and e.get('at') is not None]
    return (max(L) if L else 0)

def stratum(r):
    return 'healthy' if lag_of(r) <= 1500 else 'lagged'

def score(r):
    lost = sum(1 for c in r['perClip'] if c['deliveries'] == 0)
    dup = sum(1 for c in r['perClip'] if c['deliveries'] >= 2)
    late = sum(1 for c in r['perClip'] if c['latencyMs'] is not None and c['latencyMs'] > 6000)
    return 3 * lost + dup + late

def stats(rs, label):
    clips = [c for r in rs for c in r['perClip']]
    n = len(clips)
    lost = sum(1 for c in clips if c['deliveries'] == 0)
    right = sum(1 for c in clips if c['deliveries'] == 1)
    dup = sum(1 for c in clips if c['deliveries'] >= 2)
    lat = [c['latencyMs'] for c in clips if c['latencyMs'] is not None]
    fill_only = sum(1 for c in clips if c['deliveries'] >= 1 and all(k == 'fill' for k in c['kinds']))
    fill_only_garbled = sum(1 for c in clips if c['deliveries'] >= 1 and all(k == 'fill' for k in c['kinds']) and not c['asrOk'])
    anyfill = sum(1 for c in clips if 'fill' in c['kinds'])
    d = {k: sum(r['diag'][k] for r in rs) for k in rs[0]['diag']}
    spend = sum(r['spendCny'] for r in rs)
    print(f"\n[{label}] sessions={len(rs)} clips={n}   RIGHT(1x)={right} ({right/n:.0%})  LOST(0x)={lost} ({lost/n:.0%})  DUP(2x+)={dup} ({dup/n:.0%})")
    print(f"    first-delivery latency after the clip ends: p50={pct(lat,.5)/1000:.1f}s p90={pct(lat,.9)/1000:.1f}s max={max(lat)/1000:.1f}s   (delivered clips {len(lat)}/{n})")
    print(f"    clips reaching the session ONLY as recogniser text: {fill_only} ({fill_only/n:.0%}), of which the text does not contain the content (garbled): {fill_only_garbled}")
    print(f"    clips with a recogniser-text delivery at all: {anyfill} ({anyfill/n:.0%})")
    print(f"    responses/session={sum(r['responses'] for r in rs)/len(rs):.1f}  diag={ {k:v for k,v in d.items() if v} }   spend/session=¥{spend/len(rs):.4f}")

def show(r):
    print(f"\n{'=' * 100}\nWORST: pattern {r['pattern']} arm {r['arm']} rep {r['rep']} ({stratum(r)}, worst endpoint lag {lag_of(r)/1000:.1f}s)   score={score(r)}   responses={r['responses']}   diag={ {k:v for k,v in r['diag'].items() if v} }")
    print("per clip (known text → what reached the session):")
    for c in r['perClip']:
        lat = 'never' if c['latencyMs'] is None else f"+{c['latencyMs']/1000:.1f}s"
        print(f"   {c['clip']}  deliveries={c['deliveries']} {c['kinds']}  first={lat}  endpoint items={c['itemSeqs']}  recogniser text for it: {c['asr'][:70]!r} {'(ok)' if c['asrOk'] else '(GARBLED)'}")
    print("timeline (ms from the first audio frame):")
    skip = {'endpoint-speech-started', 'endpoint-speech-stopped'}
    for e in r['log']:
        k = e['kind']; t = e['t']
        d = {x: v for x, v in e.items() if x not in ('t', 'kind')}
        if k == 'asr': print(f"  {t:6} ASR        seq={d.get('seq')} {d.get('text')!r}")
        elif k == 'commit': print(f"  {t:6} commit     seq={d.get('seq')} endpoint span={d.get('span')}")
        elif k == 'call': print(f"  {t:6} MODEL CALL message={str(d.get('message'))[:110]!r} claims={d.get('items')} claimed={d.get('claimed')} consumedSpan={d.get('consumedSpan')}")
        elif k == 'fill': print(f"  {t:6} FILL       ({d.get('reason')}) seqs={d.get('seqs')} text={str(d.get('text'))[:100]!r}")
        elif k == 'roster-sent': print(f"  {t:6} roster     {str(d.get('text')).replace(chr(10), ' | ')[:150]}")
        elif k == 'response.done': print(f"  {t:6} response.done  status={d.get('status')} output={d.get('outputs')} {('details=' + str(d.get('statusDetails'))) if d.get('statusDetails') else ''}")
        elif k in ('response.created', 'ask', 'ask-aborted', 'ask-cancelled', 'ask-dropped', 'roster-stale-at-response', 'claim-voided', 'settle-rearm', 'local-vad-speech', 'local-vad-quiet', 'asr-consumed-by-earlier-response', 'roster-ack-timeout', 'inflight-timeout'):
            print(f"  {t:6} {k:<12} {d if d else ''}")
        elif k in skip: print(f"  {t:6} (endpoint {k.split('-')[-1]} at audio {d.get('at')})")

paths = [a for a in sys.argv[1:] if a.endswith('.json')]
worst_n = int(sys.argv[sys.argv.index('--worst') + 1]) if '--worst' in sys.argv else 3
rs = load(paths)
print(f"{len(rs)} sessions from {len(paths)} trace(s)")
print("\nsession health = worst endpoint speech_stopped lag behind the audio (healthy ≤ 1.5 s; the real captures' median is 1.5 s):")
for arm in ('B', 'BN', 'Q', 'Q12', 'Q12N'):
    L = sorted(lag_of(r) for r in rs if r['arm'] == arm)
    print(f"   {arm}: " + ' '.join(f"{x/1000:.1f}s" for x in L) + f"   → healthy {sum(1 for x in L if x <= 1500)}/{len(L)}")
for strat in ('healthy', 'lagged'):
    for arm in ('B', 'BN', 'Q', 'Q12', 'Q12N'):
        sub = [r for r in rs if r['arm'] == arm and stratum(r) == strat]
        if sub: stats(sub, f"{arm} / {strat}")
if worst_n:
    for arm in ('B', 'BN', 'Q', 'Q12', 'Q12N'):
        only = sys.argv[sys.argv.index('--stratum') + 1] if '--stratum' in sys.argv else None
        sub = sorted([r for r in rs if r['arm'] == arm and (only is None or stratum(r) == only)], key=score, reverse=True)[:worst_n]
        for r in sub:
            if score(r) > 0: show(r)
