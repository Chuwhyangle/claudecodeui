#!/usr/bin/env python3
import json,os,collections
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
rows=[json.loads(l) for l in open(os.path.join(OUT,'judge-human.jsonl')) if l.strip()]
arms=['N0','N1','N1-guard','N1-guard-oracle','N1-guard-strict','N1-guard-oracle-strict']
print('human-preference judge')
print('| arm | rep0 | rep1 | rep0 2-rate |')
print('|---|---|---|---|')
for arm in arms:
    cells=[]; rates=[]
    for rep in (0,1):
        sc=[r['score'] for r in rows if r['arm']==arm and r['rep']==rep]
        c=collections.Counter(sc); cells.append(str(dict(c)) if sc else '—')
        rates.append(round(c.get(2,0)/len(sc),2) if sc else None)
    print(f'| `{arm}` | {cells[0]} | {cells[1]} | {rates[0]} |')
print('\n## the two human-gold items')
for k in ['6c76e1cf-0','b8360029-5']:
    print('\n###',k)
    for arm in arms:
        for rep in (0,1):
            r=next((x for x in rows if x['arm']==arm and x['key']==k and x['rep']==rep),None)
            if r: print(f'{arm:24s} r{rep} {r["score"]} | {r["reason"][:120]}')
