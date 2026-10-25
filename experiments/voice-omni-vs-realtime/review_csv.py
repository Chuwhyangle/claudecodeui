#!/usr/bin/env python3
import json,os,csv
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
fixtures=json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']
def load(n): return [json.loads(l) for l in open(os.path.join(OUT,n)) if l.strip()]
res={}
for f in ['results-30c.jsonl','results-guard.jsonl','results-guard-strict.jsonl','results-guard-hybrid.jsonl']:
    for r in load(f): res[(r['arm'],r['key'],r['rep'])]=r
verb={r['key']:r.get('text','') for r in load('verbatim30.jsonl')}
judge={}
for f in ['judge30c.jsonl','judge-guard.jsonl','judge-guard-strict.jsonl']:
    for r in load(f): judge[(r['arm'],r['key'],r['rep'])]=r
human={}
for f in ['judge-human.jsonl','judge-human-hybrid.jsonl']:
    for r in load(f): human[(r['arm'],r['key'],r['rep'])]=r
arms=['N0','N1','N1-guard','N1-guard-oracle','N1-guard-strict','N1-guard-oracle-strict','N1-guard-hybrid']
rows=[]
for f in fixtures:
    k=f['key']; src='~/.cloudcli/voice-realtime-capture/'+f['connectionId']+'.wav'
    meta={'key':k,'audio':os.path.relpath(f['audio'],ROOT),'source':src,'buffer_start_ms':f['startMs'],'buffer_end_ms':f['endMs'],
          'cut_start_ms':max(0,f['startMs']-300),'duration_s':f['audioSeconds'],'rms':f.get('rms'),'peak':f.get('peak'),
          'context_chars':f['contextChars'],'context_rows':f['contextRows']}
    for label,text in [('ASR',f['asr']),('R',f['relay']),('Verb',verb.get(k,''))]:
        rows.append({**meta,'arm':label,'rep':'','text':text,'judge':'' ,'judge_reason':'','human_score':'','human_reason':''})
    for arm in arms:
        for rep in (0,1):
            r=res.get((arm,k,rep))
            if not r: continue
            j=judge.get((arm,k,rep),{})
            h=human.get((arm,k,rep),{})
            rows.append({**meta,'arm':arm,'rep':rep,'text':r.get('text',''),'judge':j.get('score',''),'judge_reason':j.get('reason',''),'human_score':h.get('score',''),'human_reason':h.get('reason','')})
cols=['key','arm','rep','text','judge','judge_reason','human_score','human_reason','audio','source','buffer_start_ms','buffer_end_ms','cut_start_ms','duration_s','rms','peak','context_chars','context_rows']
with open(os.path.join(OUT,'MANUAL-REVIEW.csv'),'w',newline='') as fh:
    w=csv.DictWriter(fh,fieldnames=cols); w.writeheader(); w.writerows(rows)
print('wrote',os.path.join(OUT,'MANUAL-REVIEW.csv'),'rows',len(rows))
