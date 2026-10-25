#!/usr/bin/env python3
"""Clean set: drop b836 (user) and 529 (duplicate R); refine the remaining edge-touching cuts."""
import json,os,wave,struct,array,glob
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
CAP=os.path.join(os.path.expanduser('~'),'.cloudcli/voice-realtime-capture')
ADIR=os.path.join(OUT,'audio-clean'); os.makedirs(ADIR,exist_ok=True)
items=json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']
DROP={'529f93f4-0'}
REFINED={
 '6c76e1cf-0':(0.0,13.414), '6c76e1cf-1':(13.414,16.92),
 '711e54cc-0':(0.1,6.01), '711e54cc-1':(19.627,24.591), '711e54cc-4':(44.786,49.626),
 '4eea7875-3':(257.297,264.578), 'e8df1709-0':(1.207,19.429), 'acf7fc73-0':(0.1,8.28),
}
def read(p):
    with wave.open(p,'rb') as w: rate=w.getframerate(); data=w.readframes(w.getnframes())
    return rate,struct.unpack('<%dh'%(len(data)//2),data)
def cut(src,rate,s,a,b,dest):
    with wave.open(dest,'wb') as o:
        o.setnchannels(1);o.setsampwidth(2);o.setframerate(rate)
        o.writeframes(array.array('h',s[int(a*rate):int(b*rate)]).tobytes())
    return (b-a)
out=[]
for f in items:
    if f['key'].startswith('b8360029') or f['key'] in DROP: continue
    if f['key'] in REFINED:
        src=glob.glob(os.path.join(CAP,f['connectionId']+'.wav'))[0]
        rate,s=read(src); a,b=REFINED[f['key']]
        dest=os.path.join(ADIR,f['key']+'.wav'); sec=cut(src,rate,s,a,b,dest)
        f={**f,'audio':dest,'audioSeconds':round(sec,3),'refined':True}
    out.append(f)
json.dump({'createdAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
           'note':'b836 removed (low SNR/atypical); 529 removed (duplicate R); edge-touching cuts refined',
           'items':out},open(os.path.join(OUT,'fixtures-clean.json'),'w'),ensure_ascii=False,indent=1)
print('clean items',len(out))
for f in out: print(f"{f['key']:18s} {f['audioSeconds']}s {'REFINED' if f.get('refined') else ''}")
