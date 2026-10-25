#!/usr/bin/env python3
"""Verbatim content guard for the one-shot relay text.

The relay text T is aligned against a verbatim transcript V (the same omni model asked to
transcribe without rewriting; the fixture's realtime ASR is also run as an oracle upper bound).
Pure DELETIONS from V are restored; pure INSERTIONS not present in the context are removed.
REPLACEMENTS are kept, because that is where context fixes live (RTX TM -> architecture tab,
外界 -> live voice, Live -> Live Voice). A replacement whose V side is a Latin term present in
the context and whose T side is Chinese is repaired to the Latin term (pack -> 派克 -> pack).
"""
import json, os, re, difflib, collections

ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
fixtures={i['key']:i for i in json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']}
results=[json.loads(l) for l in open(os.path.join(OUT,'results-30c.jsonl')) if l.strip()]
n1=collections.defaultdict(dict)
for r in results:
    if r['arm']=='N1': n1[r['key']][r['rep']]=r.get('text','')
verb={json.loads(l)['key']:json.loads(l).get('text','') for l in open(os.path.join(OUT,'verbatim30.jsonl')) if l.strip()}

def norm_map(s):
    chars=[]; idx=[]
    for i,ch in enumerate(s):
        if ch.isspace(): continue
        if re.match(r'[0-9A-Za-z一-鿿]', ch):
            chars.append(ch.lower() if ch.isascii() else ch); idx.append(i)
    return ''.join(chars), idx

def point(idx, length, p): return idx[p] if p < len(idx) else length
def span(idx, s, a, b): return '' if a>=b else s[idx[a]:idx[b-1]+1]
def norm_txt(s): return re.sub(r'[^0-9a-z一-鿿]+','',s.lower())
def substantive(s):
    c=re.sub(r'[\s，。！？、；：,.!?;:（）()\[\]{}"“”‘’…\-—]', '', s)
    return len(c)>=2

def guard(v, t, ctx):
    vn,vi=norm_map(v); tn,ti=norm_map(t); ctxn=norm_txt(ctx)
    sm=difflib.SequenceMatcher(None,vn,tn,autojunk=False)
    edits=[]; log=[]
    for tag,i1,i2,j1,j2 in sm.get_opcodes():
        if tag=='insert':
            s=span(ti,t,j1,j2)
            if substantive(s) and norm_txt(s) not in ctxn:
                edits.append((point(ti,len(t),j1),point(ti,len(t),j2),''))
                log.append(['remove-added',s])
        elif tag=='delete':
            s=span(vi,v,i1,i2)
            if substantive(s):
                p=point(ti,len(t),j1)
                edits.append((p,p,s)); log.append(['restore-dropped',s])
        elif tag=='replace':
            vs=span(vi,v,i1,i2); ts=span(ti,t,j1,j2)
            if re.fullmatch(r'[A-Za-z][A-Za-z0-9_.\-]*', vs.strip()) and re.search(r'[一-鿿]',ts) and norm_txt(vs) in ctxn:
                edits.append((point(ti,len(t),j1),point(ti,len(t),j2),vs)); log.append(['term-repair',f'{ts}->{vs}'])
            else:
                log.append(['keep-replace',f'{vs}->{ts}'])
    out=t
    for a,b,rep in sorted(edits,key=lambda e:(e[0],e[1]),reverse=True):
        out=out[:a]+rep+out[b:]
    out=re.sub(r'[ \t]+',' ',out)
    out=re.sub(r'\s+([，。！？、；：,.!?;:])',r'\1',out)
    out=re.sub(r'([，。！？、；：,.!?;:])\1+',r'\1',out)
    return out.strip(), log

# Guard each N1 rep against the realistic verbatim and the oracle ASR.
out=[]
for key,f in fixtures.items():
    for rep in (0,1):
        t=n1.get(key,{}).get(rep)
        if t is None: continue
        for arm,v in (('N1-guard',verb.get(key,'')),('N1-guard-oracle',f['asr'])):
            if not v.strip(): continue
            g,log=guard(v,t,f['context'])
            out.append({'arm':arm,'key':key,'rep':rep,'status':200,'ms':0,'text':g,'verbatim':v,'actions':log})
open(os.path.join(OUT,'results-guard.jsonl'),'w').write(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in out))
print('guarded',len(out),'-> results-guard.jsonl')
# print a compact before/after for rep0
for key,f in fixtures.items():
    t=n1.get(key,{}).get(0)
    if t is None: continue
    g=next((r for r in out if r['arm']=='N1-guard' and r['key']==key and r['rep']==0),None)
    if g:
        print(f'\n## {key}\nN1 : {t}\nG  : {g["text"]}\nACT: {g["actions"]}')
