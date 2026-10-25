#!/usr/bin/env python3
"""Final 30: replace the two low-energy 262537d7 segments with the audible b8360029-3/4."""
import json,os,wave,struct,math,re,datetime
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
CAP=os.path.join(os.path.expanduser('~'),'.cloudcli/voice-realtime-capture')
LOG=os.path.join(os.path.expanduser('~'),'.cloudcli/voice-realtime-log')
items=json.load(open(os.path.join(OUT,'fixtures-30b.json')))['items']
items=[i for i in items if i['key'] not in ('262537d7-0','262537d7-3')]
base=next(i for i in items if i['key']=='b8360029-1')
cid=base['connectionId']
# intervals for b836
ev=[]
for line in open(os.path.join(CAP,cid+'.timeline.jsonl')):
    o=json.loads(line)
    if o.get('kind') in ('speech_started','committed'): ev.append(o)
ivs=[]; starts=[]
for o in ev:
    if o.get('kind')=='speech_started': starts.append(o)
    elif o.get('kind')=='committed' and starts:
        s=starts.pop(0); ivs.append((s['offsetMs'],o['offsetMs']))
# transcriptions/sends for b836
trans=[]; sends=[]
for line in open(os.path.join(LOG,cid+'.jsonl')):
    o=json.loads(line)
    if o.get('kind')=='log':
        m=re.search(r'transcription\.completed "(.*)"$',o.get('line',''))
        if m: trans.append(m.group(1))
    if o.get('kind')=='session_send' and o.get('message'): sends.append(o['message'])
def ts(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
adir=os.path.join(OUT,'audio30c'); os.makedirs(adir,exist_ok=True)
for idx in (3,4):
    start,end=ivs[idx]
    dest=os.path.join(adir,f'b8360029-{idx}.wav')
    with wave.open(os.path.join(CAP,cid+'.wav'),'rb') as w:
        rate=w.getframerate(); n=w.getnframes(); a=max(0,int((start-300)*rate//1000)); b=min(n,int(end*rate//1000))
        w.setpos(a); frames=w.readframes(b-a)
        with wave.open(dest,'wb') as o:o.setnchannels(1);o.setsampwidth(2);o.setframerate(rate);o.writeframes(frames)
    with wave.open(dest,'rb') as w: data=w.readframes(w.getnframes())
    s=struct.unpack('<%dh'%(len(data)//2),data); rms=math.sqrt(sum(x*x for x in s)/max(1,len(s))); peak=max(map(abs,s))
    items.append({**base,'key':f'b8360029-{idx}','audio':dest,'audioSeconds':round((b-a)/rate,3),
                  'asr':trans[idx],'relay':sends[idx],'startMs':start,'endMs':end,'rms':round(rms,1),'peak':peak,
                  'gapPrev':start-ivs[idx-1][1],'gapNext':ivs[idx+1][0]-end})
items.sort(key=lambda i:i['key'])
print('n',len(items))
for i in items: print(i['key'],i['audioSeconds'],'rms',i['rms'])
json.dump({'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'items':items},
          open(os.path.join(OUT,'fixtures-30c.json'),'w'),ensure_ascii=False,indent=1)
print('wrote fixtures-30c.json')
