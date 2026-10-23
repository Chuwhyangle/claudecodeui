import json, collections, re, itertools, random
exec(open('stats.py').read().split("print('human prompts'")[0])   # reuse loader/filter
H=[r for r in H if not r['n'].startswith('[request interrupted')]
N=len(H); print('N human typed prompts',N)
AFF=re.compile(r'^(好|好的|对|是|是的|嗯|ok|okay|同意|可以|行|执行|继续|开始|确认|提交|重启|没问题|按你的建议|就这样)')
Q=re.compile(r'(\?|？|要不要|是否|需要我|你觉得|你希望|你看|如何选择|请确认|请选择|你来定|选哪)')
def cls(r):
    t=r['n']
    if AFF.match(t) and len(t)<=14: return 'affirm/continue (short)'
    if re.match(r'^检查(进展|重启|是否)',t): return 'status-check'
    if re.match(r'^(但|可是|不过|不|不对|不是|其实)',t): return 'pushback'
    if re.search(r'(上面|刚才|前面|这个|该|它|那个|上述|这段|这条|这些)',t) and r['len']<80: return 'deictic/refers-back'
    if r['len']<=15: return 'other-short'
    return 'new-content'
c=collections.Counter(cls(r) for r in H)
for k,v in c.most_common(): print('  %-26s %4d  %.1f%%'%(k,v,100*v/N))
# prior assistant ended with question?
withprev=[r for r in H if 'a_len' in r]
q=[r for r in withprev if Q.search(r['a_tail'][-160:])]
print('prior assistant tail asks/offers (heuristic):',len(q),'/',len(withprev),'= %.1f%%'%(100*len(q)/len(withprev)))
print('  reply class when assistant asked:',collections.Counter(cls(r) for r in q).most_common())
print('  reply class when not asked      :',collections.Counter(cls(r) for r in withprev if r not in q).most_common())
# prior assistant ended on tool call / empty text?
print('prior assistant text len==0:',sum(1 for r in withprev if r['a_len']==0),' ended w/ tool:',sum(1 for r in withprev if r['a_tool']))
print('prior stop_reason',collections.Counter(r.get('a_stop') for r in withprev).most_common(5))
# gap between assistant end and user prompt unknown; use per-session inter-prompt time
bysess=collections.defaultdict(list)
for r in H: bysess[r['sess']].append(r)
gaps=[]
for s,rs in bysess.items():
    rs.sort(key=lambda r:r['ts'])
    for a,b in zip(rs,rs[1:]):
        from datetime import datetime
        f=lambda x:datetime.fromisoformat(x.replace('Z','+00:00'))
        gaps.append((f(b['ts'])-f(a['ts'])).total_seconds())
gaps.sort(); print('inter-prompt gap sec p10/50/90',[gaps[int(len(gaps)*p)] for p in (.1,.5,.9)])
print('prompts per session p50/p90/max',sorted(len(v) for v in bysess.values())[len(bysess)//2],sorted(len(v) for v in bysess.values())[int(len(bysess)*.9)],max(len(v) for v in bysess.values()))
