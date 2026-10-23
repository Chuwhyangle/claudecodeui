import json, collections, re, random, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
exec(open('analysis2.py').read().split("AFF=")[0])
Hs=sorted(H,key=lambda r:r['ts'])
bysess=collections.defaultdict(list)
for r in Hs: bysess[r['sess']].append(r)
cand=[i for i,r in enumerate(Hs) if 'a_len' in r and r['a_len']>0 and i>=50]
random.seed(7); pick=sorted(random.sample(cand,40))
def run(prompt, system):
    p=subprocess.run(['claude','-p','--model','haiku','--output-format','json','--tools','','--no-session-persistence','--setting-sources','','--system-prompt',system],input=prompt,capture_output=True,text=True,timeout=170)
    o=json.loads(p.stdout); u=o['usage']
    return o['result'], dict(cost=o['total_cost_usd'], inp=u['input_tokens']+u['cache_creation_input_tokens']+u['cache_read_input_tokens'], out=u['output_tokens'], ms=o['duration_ms'])
GEN_SYS="You predict what a developer will type next into a coding-assistant chat box. Output ONLY a JSON array of exactly 3 strings: the 3 most likely next messages, ranked, written in the user's own language and terse style. Prefer short, directly usable messages."
JUDGE_SYS="You judge whether a suggested chat message could replace what the user actually typed. Output ONLY a JSON array of 3 booleans, one per candidate. true = the candidate expresses the same request/decision and could be sent as-is with the same effect; false otherwise."
def case(i):
    r=Hs[i]; hist=Hs[:i]
    prior=[h['text'][:150].replace('\n',' ') for h in bysess[r['sess']] if h['ts']<r['ts']][-3:]
    cnt=collections.Counter(h['n'] for h in hist if h['len']<=15)
    ex=[p for p,_ in cnt.most_common(8)]
    prompt=f"Project: {r['proj'].replace('-data-home-yale-work-','')}\nUser's recent messages in this chat:\n"+"\n".join('- '+p for p in prior)+f"\n\nAssistant's last reply (tail):\n{r['a_tail'][-1000:]}\n\nShort messages this user often sends: {ex}\n\nNext user message candidates (JSON array of 3):"
    try:
        out,u=run(prompt,GEN_SYS)
        m=re.search(r'\[.*\]',out,re.S); c=json.loads(m.group(0))[:3]
        jp=f"Actual message typed by the user:\n{r['text'][:400]}\n\nCandidates:\n"+"\n".join(f"{k+1}. {x}" for k,x in enumerate(c))
        jo,ju=run(jp,JUDGE_SYS); v=json.loads(re.search(r'\[.*\]',jo,re.S).group(0))
        return dict(i=i,len=r['len'],actual=r['text'][:120],cands=c,verdict=v,gen=u,judge=ju)
    except Exception as e:
        return dict(i=i,err=str(e)[:200])
with ThreadPoolExecutor(4) as ex: res=list(ex.map(case,pick))
json.dump(res,open('llm_results.json','w'),ensure_ascii=False,indent=1)
ok=[x for x in res if 'err' not in x]; print('ok',len(ok),'err',len(res)-len(ok))
