#!/usr/bin/env python3
"""Strict verbatim guard on the 23-item clean set (b836/529 removed, edge cuts refined)."""
import json,os,re,difflib,collections
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
fixtures={i['key']:i for i in json.load(open(os.path.join(OUT,'fixtures-clean.json')))['items']}
res=[json.loads(l) for l in open(os.path.join(OUT,'results-clean.jsonl'))]
n1=collections.defaultdict(dict)
for r in res:
    if r['arm']=='N1': n1[r['key']][r['rep']]=r.get('text','')
verb={json.loads(l)['key']:json.loads(l).get('text','') for l in open(os.path.join(OUT,'verbatim-clean.jsonl'))}
def nm(s):
    chars=[];idx=[]
    for i,ch in enumerate(s):
        if ch.isspace():continue
        if re.match(r'[0-9A-Za-z一-鿿]',ch):chars.append(ch.lower() if ch.isascii() else ch);idx.append(i)
    return ''.join(chars),idx
def point(idx,n,p):return idx[p] if p<len(idx) else n
def span(idx,s,a,b):return '' if a>=b else s[idx[a]:idx[b-1]+1]
def nt(s):return re.sub(r'[^0-9a-z一-鿿]+','',s.lower())
def subst(s):return len(re.sub(r'[\s，。！？、；：,.!?;:（）()\[\]{}"“”‘’…\-—]','',s))>=2
def guard(v,t,ctx):
    vn,vi=nm(v);tn,ti=nm(t);ctxn=nt(ctx);edits=[];log=[]
    for tag,i1,i2,j1,j2 in difflib.SequenceMatcher(None,vn,tn,autojunk=False).get_opcodes():
        if tag=='insert':
            s=span(ti,t,j1,j2)
            if subst(s) and not (re.search(r'[A-Za-z0-9]',s) and nt(s) in ctxn):
                edits.append((point(ti,len(t),j1),point(ti,len(t),j2),''));log.append(['remove-added',s])
        elif tag=='delete':
            s=span(vi,v,i1,i2)
            if subst(s): edits.append((point(ti,len(t),j1),point(ti,len(t),j1),s));log.append(['restore-dropped',s])
        elif tag=='replace':
            vs=span(vi,v,i1,i2);ts=span(ti,t,j1,j2)
            if re.search(r'[A-Za-z]',ts): log.append(['keep-latin',f'{vs}->{ts}'])
            elif subst(vs) or subst(ts): edits.append((point(ti,len(t),j1),point(ti,len(t),j2),vs));log.append(['restore-replace',f'{ts}->{vs}'])
            else: log.append(['keep-small',f'{vs}->{ts}'])
    out=t
    for a,b,rep in sorted(edits,key=lambda e:(e[0],e[1]),reverse=True):out=out[:a]+rep+out[b:]
    out=re.sub(r'[ \t]+',' ',out);out=re.sub(r'\s+([，。！？、；：,.!?;:])',r'\1',out);out=re.sub(r'([，。！？、；：,.!?;:])\1+',r'\1',out)
    return out.strip(),log
out=[]
for k,f in fixtures.items():
    for rep in (0,1):
        t=n1.get(k,{}).get(rep)
        if t is None:continue
        for arm,v in (('N1-guard-strict',verb.get(k,'')),('N1-guard-oracle-strict',f['asr'])):
            if not v.strip():continue
            g,log=guard(v,t,f['context'])
            out.append({'arm':arm,'key':k,'rep':rep,'status':200,'ms':0,'text':g,'actions':log})
open(os.path.join(OUT,'results-guard-clean.jsonl'),'w').write(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in out))
print('guarded',len(out))
for k in ['6c76e1cf-0','711e54cc-0','711e54cc-1','bf517472-0','e8df1709-0','4eea7875-3']:
    print('\n##',k,'T=',n1.get(k,{}).get(0))
    for arm in ['N1-guard-strict','N1-guard-oracle-strict']:
        r=next((x for x in out if x['arm']==arm and x['key']==k and x['rep']==0),None)
        if r:print(arm,':',r['text'],'|',r['actions'])
