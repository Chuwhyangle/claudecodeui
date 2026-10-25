#!/usr/bin/env python3
"""Enumerate audible LIVE Voice utterances with 1:1 ASR->delivered pairs, endpoint-buffer cuts,
and a verified context pack. Prints candidates; writes nothing yet."""
import json, os, re, wave, struct, math, datetime, collections
ROOT=os.path.dirname(os.path.abspath(__file__)); HOME=os.path.expanduser('~')
LOG=os.path.join(HOME,'.cloudcli/voice-realtime-log'); CAP=os.path.join(HOME,'.cloudcli/voice-realtime-capture')
HIST=os.path.join(ROOT,'out/history'); TMP=os.path.join(ROOT,'out/tmp-audible'); os.makedirs(TMP,exist_ok=True)
def ts(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
def rel_time(t,n):
    at=datetime.datetime.fromisoformat(t.replace('Z','+00:00')).timestamp()*1000; m=int(max(0,n-at)//60000)
    return '刚刚' if m<1 else (f'{m} 分钟前' if m<60 else (f'{m//60} 小时前' if m//60<24 else f'{m//1440} 天前'))
def elide(t,cap):
    if len(t)<=cap:return t
    if cap<=1:return t[:max(cap,0)]
    h=int(cap*0.7); return t[:h]+'…'+t[-(cap-h-1):]
def build_pack(messages,cut):
    now=datetime.datetime.fromisoformat(cut.replace('Z','+00:00')).timestamp()*1000
    rows=[m for m in messages if (m.get('timestamp') or '')<=cut and m.get('role') in ('user','assistant') and (m.get('content') or '').strip() and m.get('kind') not in ('tool_use','tool_result','thinking','task_notification','error','compaction') and not m.get('compact')]
    taken=[]; chars=0
    for m in reversed(rows):
        label='用户' if m['role']=='user' else '助手'
        line=elide(f'{label}（{rel_time(m["timestamp"],now)}）：{(m["content"] or "").strip()}',600)
        add=len(line)+(1 if taken else 0)
        if chars+add>2000: break
        taken.append(line); chars+=add
    taken.reverse(); return '\n'.join(taken),chars,len(taken)
def journal(cid):
    conn=None; ctx=None; trans=[]; sends=[]
    for line in open(os.path.join(LOG,cid+'.jsonl'),errors='replace'):
        try:o=json.loads(line)
        except:continue
        if o.get('kind')=='connection': conn=o
        elif o.get('kind')=='log':
            m=re.search(r'context received chars=(\d+) rows=(\d+)',o.get('line',''))
            if m and ctx is None: ctx=(int(m.group(1)),int(m.group(2)))
            m=re.search(r'transcription\.completed "(.*)"$',o.get('line',''))
            if m: trans.append((o['at'],m.group(1)))
        elif o.get('kind')=='session_send' and o.get('message'): sends.append((o['at'],o['message']))
    # Keep EVERY transcription so the list index is the interval index. A transcription with no
    # delivered send stays with relay=None and is skipped later; dropping it would shift every
    # following utterance onto the wrong speech interval.
    pairs=[]; used=set()
    for t,text in trans:
        cand=[(j,s,m) for j,(s,m) in enumerate(sends) if j not in used and ts(s)>=ts(t) and ts(s)-ts(t)<=10]
        if cand:
            j,s,m=cand[0]; used.add(j); pairs.append({'at':t,'asr':text,'sentAt':s,'relay':m})
        else:
            pairs.append({'at':t,'asr':text,'sentAt':None,'relay':''})
    return conn,ctx,pairs
def intervals(cid):
    path=os.path.join(CAP,cid+'.timeline.jsonl')
    if not os.path.exists(path):return []
    ev=[]
    for line in open(path):
        o=json.loads(line)
        if o.get('kind') in ('speech_started','speech_stopped','committed'):ev.append(o)
    out=[]; starts=[]
    for o in ev:
        if o.get('kind')=='speech_started':starts.append(o)
        elif o.get('kind')=='committed' and starts:
            s=starts.pop(0); out.append({'start':s['offsetMs'],'end':o['offsetMs']})
    return out
def cut(cid,start,end,dest):
    with wave.open(os.path.join(CAP,cid+'.wav'),'rb') as w:
        rate=w.getframerate(); n=w.getnframes(); a=max(0,int((start-300)*rate//1000)); b=min(n,int(end*rate//1000))
        w.setpos(a); frames=w.readframes(b-a)
        with wave.open(dest,'wb') as o:o.setnchannels(1);o.setsampwidth(2);o.setframerate(rate);o.writeframes(frames)
    data=open(dest,'rb').read()
    with wave.open(dest,'rb') as w: s=struct.unpack('<%dh'%(w.getnframes()*w.getnchannels()),w.readframes(w.getnframes()))
    rms=math.sqrt(sum(x*x for x in s)/max(1,len(s))); peak=max(map(abs,s)) if s else 0
    return (b-a)/rate,rms,peak
cands=[]
for jp in sorted(os.listdir(LOG)):
    if not jp.endswith('.jsonl'):continue
    cid=jp[:-6]; conn,ctx,pairs=journal(cid)
    if not conn or not ctx:continue
    ivs=intervals(cid)
    if len(pairs)!=len(ivs):continue
    hp=os.path.join(HIST,f'hist-{conn["sessionId"]}.json')
    if not os.path.exists(hp):continue
    pack,chars,rows=build_pack(json.load(open(hp)),conn['at'])
    if (chars,rows)!=ctx:continue
    for i,(p,iv) in enumerate(zip(pairs,ivs)):
        key=f'{cid[:8]}-{i}'
        if (cid[:8],i) in {('711e54cc',2),('b8360029',0)}:continue
        if not p['relay'].strip():continue
        prev=ivs[i-1]['end'] if i>0 else 0; nxt=ivs[i+1]['start'] if i+1<len(ivs) else 10**9
        gp=iv['start']-prev; gn=nxt-iv['end']; dur=(iv['end']-iv['start'])/1000
        adjacent_ok = key in {'e8df1709-0','e8df1709-1','262537d7-2','262537d7-3'}
        if i>0 and gp<300 and not adjacent_ok:continue
        if gn<300 and not adjacent_ok:continue
        if not(1<=dur<=30):continue
        if len(p['asr'].strip())<2 or len(p['relay'].strip())<2:continue
        tmp=os.path.join(TMP,key+'.wav'); sec,rms,peak=cut(cid,iv['start'],iv['end'],tmp)
        if rms<100 or peak<1000:continue
        cands.append({**p,'key':key,'cid':cid,'sessionId':conn['sessionId'],'at':conn['at'],'ctx':pack,'ctxChars':chars,'ctxRows':rows,'start':iv['start'],'end':iv['end'],'sec':round(sec,2),'rms':round(rms,1),'peak':peak,'gp':gp,'gn':gn})
print('audible candidates',len(cands))
print('by session',dict(collections.Counter(c['sessionId'][:8] for c in cands)))
for c in cands:
    print(f"{c['key']:18s} {c['sec']:5.2f}s rms={c['rms']:7.1f} peak={c['peak']:6d} gp={c['gp']} gn={c['gn']} ASR={c['asr'][:55]!r} -> {c['relay'][:55]!r}")


# ── final 30: all audible candidates; the four explicitly-allowed adjacent items are already in,
# because adjacent_ok only relaxes the gap gate. Copy the temp cuts to audio30b/ and write fixtures.
import shutil
FINAL = os.path.join(ROOT,'out/fixtures-30b.json'); ADIR = os.path.join(ROOT,'out/audio30b')
os.makedirs(ADIR, exist_ok=True)
items=[]
for c in cands:
    dest=os.path.join(ADIR,c['key']+'.wav'); shutil.copyfile(os.path.join(TMP,c['key']+'.wav'),dest)
    items.append({'key':c['key'],'connectionId':c['cid'],'sessionId':c['sessionId'],'connectionAt':c['at'],
                  'context':c['ctx'],'contextChars':c['ctxChars'],'contextRows':c['ctxRows'],
                  'asr':c['asr'],'relay':c['relay'],'startMs':c['start'],'endMs':c['end'],
                  'audioSeconds':c['sec'],'audio':dest,'rms':c['rms'],'peak':c['peak'],'gapPrev':c['gp'],'gapNext':c['gn']})
json.dump({'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'items':items},
          open(FINAL,'w'),ensure_ascii=False,indent=1)
print('FINAL',len(items),'->',FINAL)
