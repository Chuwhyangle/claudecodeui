#!/usr/bin/env python3
import json, os, re, collections, difflib
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
fixtures=json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']
results=[json.loads(l) for l in open(os.path.join(OUT,'results-30c.jsonl')) if l.strip()]
by={}
for r in results: by.setdefault((r['arm'],r['key']),[]).append(r)
for v in by.values(): v.sort(key=lambda r:r['rep'])
judge={}
jp=os.path.join(OUT,'judge30c.jsonl')
if os.path.exists(jp):
    for l in open(jp):
        r=json.loads(l); judge[(r['arm'],r['key'],r['rep'])]=r
def norm(s): return re.sub(r'[^一-鿿A-Za-z0-9]','',s or '').lower()
def cer(a,b):
    x,y=norm(a),norm(b)
    if not x and not y: return 0.0
    dp=list(range(len(y)+1))
    for i in range(1,len(x)+1):
        prev=dp[0]; dp[0]=i
        for j in range(1,len(y)+1):
            cur=dp[j]; dp[j]=min(dp[j]+1,dp[j-1]+1,prev+(x[i-1]!=y[j-1])); prev=cur
    return dp[len(y)]/max(len(x),len(y))
print('items',len(fixtures),'results',len(results),'judge',len(judge))
for f in fixtures:
    print('\n##',f['key'],f'{f["audioSeconds"]}s','ctx',f['contextChars'],'/',f['contextRows'])
    print('ASR :',f['asr'])
    print('R   :',f['relay'])
    for arm in ['N0','N1']:
        for r in by.get((arm,f['key']),[]):
            j=judge.get((arm,f['key'],r['rep']))
            print(f'{arm} r{r["rep"]} cerR={cer(r.get("text",""),f["relay"]):.3f} judge={j.get("score") if j else "-"} {("| "+j.get("reason","")) if j else ""}')
            print('   ',r.get('text',''))
print('\n## summary')
for arm in ['N1','N0']:
    sc=[judge[(arm,f['key'],r['rep'])]['score'] for f in fixtures for r in by.get((arm,f['key']),[]) if (arm,f['key'],r['rep']) in judge]
    print(arm,'n',len(sc),dict(collections.Counter(sc)))
