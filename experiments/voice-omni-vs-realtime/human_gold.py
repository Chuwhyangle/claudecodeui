#!/usr/bin/env python3
"""Record the two human-preferred examples and compare every arm against them."""
import json,os,re,collections
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
GOLD={
 '6c76e1cf-0':'现在可以看到 architecture tab 架构图了，但是有问题：是这里头所有节点都一样箭头，看不出继承关系。',
 'b8360029-5':'丢词丢得太厉害。',
}
fixtures={i['key']:i for i in json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']}
def load(n):return [json.loads(l) for l in open(os.path.join(OUT,n)) if l.strip()]
verb={r['key']:r.get('text','') for r in load('verbatim30.jsonl')}
res={}
for f in ['results-30c.jsonl','results-guard.jsonl','results-guard-strict.jsonl']:
    for r in load(f): res[(r['arm'],r['key'],r['rep'])]=r
def norm(s):return re.sub(r'[^一-鿿A-Za-z0-9]','',s or '').lower()
for k,gold in GOLD.items():
    print('\n##',k); print('ASR :',fixtures[k]['asr']); print('R   :',fixtures[k]['relay']); print('GOLD:',gold)
    rows=[]
    for arm in ['N0','N1','N1-guard','N1-guard-oracle','N1-guard-strict','N1-guard-oracle-strict']:
        for rep in (0,1):
            r=res.get((arm,k,rep));
            if not r:continue
            t=r.get('text',''); eq=norm(t)==norm(gold)
            rows.append((eq,arm,rep,t))
    for eq,arm,rep,t in sorted(rows,key=lambda x:(not x[0],x[1],x[2])):
        print(('MATCH ' if eq else 'diff  ')+f'{arm} r{rep}: {t}')
    print('Verb:',verb.get(k,''))
