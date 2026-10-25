#!/usr/bin/env python3
"""Hybrid guard: A (independent ASR) supplies content coverage; V (same-model verbatim) supplies
domain terms when V and A disagree and V is the more specific phrase. T is kept when V and A agree
(the relay's domain correction, e.g. 丢词, may be better than both)."""
import json, os, re, difflib, collections
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
fixtures={i['key']:i for i in json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']}
results=[json.loads(l) for l in open(os.path.join(OUT,'results-30c.jsonl')) if l.strip()]
n1=collections.defaultdict(dict)
for r in results:
    if r['arm']=='N1': n1[r['key']][r['rep']]=r.get('text','')
verb={json.loads(l)['key']:json.loads(l).get('text','') for l in open(os.path.join(OUT,'verbatim30.jsonl')) if l.strip()}
def nm(s):
    chars=[];idx=[]
    for i,ch in enumerate(s):
        if ch.isspace():continue
        if re.match(r'[0-9A-Za-z一-鿿]',ch):
            chars.append(ch.lower() if ch.isascii() else ch);idx.append(i)
    return ''.join(chars),idx
def point(idx,n,p):return idx[p] if p<len(idx) else n
def span(idx,s,a,b):return '' if a>=b else s[idx[a]:idx[b-1]+1]
def nt(s):return re.sub(r'[^0-9a-z一-鿿]+','',s.lower())
def subst(s):return len(re.sub(r'[\s，。！？、；：,.!?;:（）()\[\]{}"“”‘’…\-—]','',s))>=2
STOP={'如果','我们平时','那么','就是','在办公室的时候'}
def has_latin(s):return bool(re.search(r'[A-Za-z0-9]',s))
def edit_ratio(a,b):
    x,y=nm(a)[0],nm(b)[0]
    if not x and not y:return 0.0
    dp=list(range(len(y)+1))
    for i in range(1,len(x)+1):
        prev=dp[0];dp[0]=i
        for j in range(1,len(y)+1):
            cur=dp[j];dp[j]=min(dp[j]+1,dp[j-1]+1,prev+(x[i-1]!=y[j-1]));prev=cur
    return dp[len(y)]/max(len(x),len(y))
def a_guard(t,a,ctx):
    """Content coverage from the independent ASR: restore drops, remove non-term insertions."""
    tn,ti=nm(t); an,ai=nm(a); ctxn=nt(ctx); edits=[]
    for tag,i1,i2,j1,j2 in difflib.SequenceMatcher(None,tn,an,autojunk=False).get_opcodes():
        # SequenceMatcher(None, tn, an): i indexes T, j indexes A.
        if tag=='insert':  # A has, T lacks -> restore the A span at T's position i1
            s=span(ai,a,j1,j2)
            if subst(s): edits.append((point(ti,len(t),i1),point(ti,len(t),i1),s))
        elif tag=='delete':  # T has, A lacks -> remove unless Latin/digit context term
            s=span(ti,t,i1,i2)
            if subst(s) and not (has_latin(s) and nt(s) in ctxn):
                edits.append((point(ti,len(t),i1),point(ti,len(t),i2),''))
    out=t
    for p,q,rep in sorted(edits,key=lambda e:(e[0],e[1]),reverse=True):out=out[:p]+rep+out[q:]
    return out
def v_hybrid(t,v,a,ctx):
    """Domain-term replacement from V only when V and A disagree and V is more specific."""
    tn,ti=nm(t); vn,vi=nm(v); an,ai=nm(a); ctxn=nt(ctx)
    va=list(difflib.SequenceMatcher(None,vn,an,autojunk=False).get_opcodes())
    edits=[]; log=[]
    for tag,i1,i2,j1,j2 in difflib.SequenceMatcher(None,tn,vn,autojunk=False).get_opcodes():
        if tag!='replace': continue
        ts=span(ti,t,i1,i2); vs=span(vi,v,j1,j2)
        if has_latin(ts) or nt(ts) in ctxn:  # protect relay/context terms and Latin
            log.append(['keep-protected',f'{ts}->{vs}']); continue
        # the A counterpart for this V span: find the A opcode overlapping [i1,i2)
        a_parts=[]
        for at,ai1,ai2,aj1,aj2 in va:
            if ai1 < i2 and ai2 > i1: a_parts.append(span(ai,a,aj1,aj2))
        as_= ''.join(a_parts)
        if not vs.strip() or not as_.strip(): continue
        if nt(vs)==nt(as_):  # V and A agree: keep the relay's term (e.g. 丢词)
            log.append(['keep-consensus',f'{ts}->{vs}']); continue
        # A has the Latin term and T/V have a Chinese transliteration (pack -> 派克): use A.
        a_latin=re.findall(r'[A-Za-z][A-Za-z0-9_.\-]*',as_)
        if a_latin and not has_latin(vs) and not has_latin(ts) and any(nt(x) in ctxn for x in a_latin):
            edits.append((point(ti,len(t),i1),point(ti,len(t),i2),as_)); log.append(['use-asr-term',f'{ts}->{as_}']); continue
        if vs in STOP or any(stop in vs for stop in STOP):
            log.append(['skip-function',f'{ts}->{vs}']); continue
        # V and A disagree on a non-function span: prefer the same-model domain phrase.
        edits.append((point(ti,len(t),i1),point(ti,len(t),i2),vs)); log.append(['use-domain',f'{ts}->{vs}'])
    # Latin term repair: V and A agree on a Latin token; T has Chinese -> use the Latin token
    for tag,i1,i2,j1,j2 in difflib.SequenceMatcher(None,tn,vn,autojunk=False).get_opcodes():
        if tag!='replace': continue
        ts=span(ti,t,i1,i2); vs=span(vi,v,j1,j2)
        if has_latin(vs) and not has_latin(ts) and nt(vs) and nt(vs) in ctxn:
            edits.append((point(ti,len(t),i1),point(ti,len(t),i2),vs)); log.append(['latin-repair',f'{ts}->{vs}'])
    out=t
    for p,q,rep in sorted(edits,key=lambda e:(e[0],e[1]),reverse=True):out=out[:p]+rep+out[q:]
    out=re.sub(r'[ \t]+',' ',out);out=re.sub(r'\s+([，。！？、；：,.!?;:])',r'\1',out);out=re.sub(r'([，。！？、；：,.!?;:])\1+',r'\1',out)
    return out.strip(),log
out=[]
for key,f in fixtures.items():
    for rep in (0,1):
        t=n1.get(key,{}).get(rep)
        if t is None:continue
        t1=a_guard(t,f['asr'],f['context'])
        ratio=edit_ratio(verb.get(key,''),f['asr'])
        if ratio<=0.3:
            # V and A are near-identical: the relay T is a domain-corrected version of the same
            # transcript (e.g. 丢词 vs 丢死/丢失); keep T rather than let a character block overwrite it.
            g,log=t1,[['consensus-keep',f'V≈A {ratio:.2f}']]
        else:
            g,log=v_hybrid(t1,verb.get(key,''),f['asr'],f['context'])
        out.append({'arm':'N1-guard-hybrid','key':key,'rep':rep,'status':200,'ms':0,'text':g,'actions':log,'after_a':t1})
open(os.path.join(OUT,'results-guard-hybrid.jsonl'),'w').write(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in out))
print('guarded',len(out))
for key in ['6c76e1cf-0','b8360029-5','262537d7-1','262537d7-2','b8360029-1','bf517472-0','4eea7875-3','b8360029-4']:
    r=next((x for x in out if x['key']==key and x['rep']==0),None)
    if r: print(f'\n## {key}\nT : {n1[key][0]}\nA1: {r["after_a"]}\nG : {r["text"]}\nACT: {r["actions"]}')
