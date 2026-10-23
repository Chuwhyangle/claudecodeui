import json, collections, re, statistics, datetime
R=[json.loads(l) for l in open('prompts.jsonl')]
pref=collections.defaultdict(set)
for r in R: pref[r['text'][:40]].add(r['sess'])
def auto(r):
    t=r['text'].lstrip()
    if t.startswith(('<task-notification','<command','UTTERANCE','WORKSPACE:','Reply with exactly','你是 quay-fleet')): return True
    if len(pref[r['text'][:40]])>=3 and r['len']>200: return True
    if re.match(r'(You are|Your task|# |## |\[quay|SYSTEM|Task:|Execute)',t) and r['len']>300: return True
    return False
H=sorted([r for r in R if not auto(r)], key=lambda r:r['ts'])
def norm(t): return re.sub(r'[\s。.!！?？,，、~～]+$','',t.strip()).lower()
for r in H: r['n']=norm(r['text'])
print('human prompts',len(H),'sessions',len({r['sess'] for r in H}),'projects',len({r['proj'] for r in H}))
days=collections.Counter(r['ts'][:10] for r in H); print('per day',sorted(days.items()))
L=sorted(r['len'] for r in H); q=lambda p:L[int(len(L)*p)]
print('len pctl p10/25/50/75/90/95',[q(p) for p in (.1,.25,.5,.75,.9,.95)])
print('<=4 chars',sum(l<=4 for l in L)/len(L),' <=10',sum(l<=10 for l in L)/len(L),' <=30',sum(l<=30 for l in L)/len(L))
# first-in-session
first=[r for r in H if 'a_len' not in r]; print('no preceding assistant (cold start) share',len(first)/len(H))
# top repeated
cnt=collections.Counter(r['n'] for r in H)
print('distinct normalized',len(cnt),' prompts that are repeats of an earlier one:',sum(1 for i,r in enumerate(H) if r['n'] in {x['n'] for x in H[:i]})/len(H) if False else '')
seen=set(); rep=0; rep_proj=0; seenp=set()
for r in H:
    if r['n'] in seen: rep+=1
    seen.add(r['n'])
    k=(r['proj'],r['n'])
    if k in seenp: rep_proj+=1
    seenp.add(k)
print('exact repeat of earlier prompt (global): %.3f ; same-project: %.3f'%(rep/len(H),rep_proj/len(H)))
print('top phrases:'); 
for p,c in cnt.most_common(30):
    if len(p)<=40: print('  ',c,repr(p))
