#!/usr/bin/env python3
"""Stricter verbatim guard: pure drops/inserts are handled as in guard.py, and a REPLACEMENT
that is not itself present in the context is replaced by the verbatim span. Context terms
(architecture tab, Live Voice, live voice) are kept, so referent fixes survive."""
import json, os, re, difflib, collections
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
fixtures={i['key']:i for i in json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']}
results=[json.loads(l) for l in open(os.path.join(OUT,'results-30c.jsonl')) if l.strip()]
n1=collections.defaultdict(dict)
for r in results:
    if r['arm']=='N1': n1[r['key']][r['rep']]=r.get('text','')
verb={json.loads(l)['key']:json.loads(l).get('text','') for l in open(os.path.join(OUT,'verbatim30.jsonl')) if l.strip()}
def norm_map(s):
    chars=[];idx=[]
    for i,ch in enumerate(s):
        if ch.isspace():continue
        if re.match(r'[0-9A-Za-z一-鿿]',ch):
            chars.append(ch.lower() if ch.isascii() else ch);idx.append(i)
    return ''.join(chars),idx
def point(idx,n,p):return idx[p] if p<len(idx) else n
def span(idx,s,a,b):return '' if a>=b else s[idx[a]:idx[b-1]+1]
def norm_txt(s):return re.sub(r'[^0-9a-z一-鿿]+','',s.lower())
def substantive(s):
    c=re.sub(r'[\s，。！？、；：,.!?;:（）()\[\]{}"“”‘’…\-—]','',s);return len(c)>=2
def guard(v,t,ctx):
    vn,vi=norm_map(v);tn,ti=norm_map(t);ctxn=norm_txt(ctx)
    sm=difflib.SequenceMatcher(None,vn,tn,autojunk=False);edits=[];log=[]
    for tag,i1,i2,j1,j2 in sm.get_opcodes():
        if tag=='insert':
            s=span(ti,t,j1,j2)
            if substantive(s) and norm_txt(s) not in ctxn:
                edits.append((point(ti,len(t),j1),point(ti,len(t),j2),''));log.append(['remove-added',s])
        elif tag=='delete':
            s=span(vi,v,i1,i2)
            if substantive(s):
                p=point(ti,len(t),j1);edits.append((p,p,s));log.append(['restore-dropped',s])
        elif tag=='replace':
            vs=span(vi,v,i1,i2);ts=span(ti,t,j1,j2)
            # NEVER touch a T span that contains Latin letters: that is where the context terms
            # (architecture tab, live voice, Live Voice) live, and the character-level alignment
            # can split them across blocks. Chinese-only replacements are where the word-level
            # drops/additions/mishearings live; restore the verbatim side there.
            if re.search(r'[A-Za-z]', ts):
                log.append(['keep-latin',f'{vs}->{ts}'])
            elif substantive(vs) or substantive(ts):
                edits.append((point(ti,len(t),j1),point(ti,len(t),j2),vs));log.append(['restore-replace',f'{ts}->{vs}'])
            else:
                log.append(['keep-small',f'{vs}->{ts}'])
    out=t
    for a,b,rep in sorted(edits,key=lambda e:(e[0],e[1]),reverse=True):out=out[:a]+rep+out[b:]
    out=re.sub(r'[ \t]+',' ',out);out=re.sub(r'\s+([，。！？、；：,.!?;:])',r'\1',out);out=re.sub(r'([，。！？、；：,.!?;:])\1+',r'\1',out)
    return out.strip(),log
out=[]
for key,f in fixtures.items():
    for rep in (0,1):
        t=n1.get(key,{}).get(rep)
        if t is None:continue
        for arm,v in (('N1-guard-strict',verb.get(key,'')),('N1-guard-oracle-strict',f['asr'])):
            if not v.strip():continue
            g,log=guard(v,t,f['context'])
            out.append({'arm':arm,'key':key,'rep':rep,'status':200,'ms':0,'text':g,'verbatim':v,'actions':log})
open(os.path.join(OUT,'results-guard-strict.jsonl'),'w').write(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in out))
print('guarded',len(out))
for key,f in fixtures.items():
    t=n1.get(key,{}).get(0)
    g=next((r for r in out if r['arm']=='N1-guard-oracle-strict' and r['key']==key and r['rep']==0),None)
    if t is not None and g:
        print(f'\n## {key}\nN1 : {t}\nG  : {g["text"]}\nACT: {g["actions"]}')
