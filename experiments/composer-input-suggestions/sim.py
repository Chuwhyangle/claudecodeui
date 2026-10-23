import json, collections, re, math
exec(open('analysis2.py').read().split("AFF=")[0])
def bg(s):
    s=re.sub(r'\s+','',s.lower()); return collections.Counter(s[i:i+2] for i in range(len(s)-1))
def cos(a,b):
    if not a or not b: return 0.0
    d=sum(v*b.get(k,0) for k,v in a.items()); 
    return d/(math.sqrt(sum(v*v for v in a.values()))*math.sqrt(sum(v*v for v in b.values())))
def dice(a,b):
    if not a or not b: return 0.0
    i=sum((a&b).values()); return 2*i/(sum(a.values())+sum(b.values()))
Hs=sorted(H,key=lambda r:r['ts'])
for r in Hs: r['bg']=bg(r['n']); r['abg']=bg(r.get('a_tail',''))
MAXLEN=60   # only candidates short enough to be a one-click chip
res=collections.defaultdict(lambda:[0,0,0,0])   # strat -> [exact_hit, fuzzy_hit, n, ...]
groups={'all':lambda r:True,'short<=30':lambda r:r['len']<=30,'short<=15':lambda r:r['len']<=15,'cont-with-prev':lambda r:'a_len' in r}
def evaluate(name,cands_fn):
    out={}
    for g,pred in groups.items():
        n=ex=fz=0
        for i,r in enumerate(Hs):
            if not pred(r) or i<50: continue
            hist=Hs[:i]
            cands=cands_fn(r,hist)[:3]
            n+=1
            if any(c['n']==r['n'] for c in cands): ex+=1
            if any(dice(c['bg'],r['bg'])>=0.6 for c in cands): fz+=1
        out[g]=(n,ex/n,fz/n)
    return out
def s_global(r,hist):
    c=collections.Counter(h['n'] for h in hist if h['len']<=MAXLEN)
    top=[p for p,_ in c.most_common(3)]; ix={h['n']:h for h in hist}
    return [ix[p] for p in top]
def s_project(r,hist):
    c=collections.Counter(h['n'] for h in hist if h['len']<=MAXLEN and h['proj']==r['proj'])
    ix={h['n']:h for h in hist}; return [ix[p] for p,_ in c.most_common(3)]
def s_context(r,hist):
    # earlier short prompts, scored by similarity of the assistant tail that preceded them to our assistant tail, + frequency prior
    if 'a_len' not in r: return s_project(r,hist)
    cnt=collections.Counter(h['n'] for h in hist if h['len']<=MAXLEN)
    best={}
    for h in hist:
        if h['len']>MAXLEN or 'a_len' not in h: continue
        sc=cos(r['abg'],h['abg'])*(1+math.log1p(cnt[h['n']]))
        if h['n'] not in best or sc>best[h['n']][0]: best[h['n']]=(sc,h)
    return [h for _,h in sorted(best.values(),key=lambda x:-x[0])]
def s_ctx_same_session_first(r,hist):
    # prompts from the SAME session first (the user repeats themself within a conversation), then context
    same=[h for h in reversed(hist) if h['sess']==r['sess'] and h['len']<=MAXLEN]
    seen=set(); out=[]
    for h in same:
        if h['n'] not in seen: seen.add(h['n']); out.append(h)
    return out[:1]+s_project(r,hist)  # 1 slot recency + project freq
for name,fn in [('A global-freq top3',s_global),('B project-freq top3',s_project),('C context-sim top3',s_context),('D 1 recency + project-freq',s_ctx_same_session_first)]:
    print(name)
    for g,(n,e,f) in evaluate(name,fn).items(): print('   %-16s n=%4d  exact@3=%.1f%%  near(dice>=.6)@3=%.1f%%'%(g,n,100*e,100*f))
