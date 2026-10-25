#!/usr/bin/env python3
"""Audit every cut: does it start/end inside speech? Uses the cut WAV and the source capture."""
import json,os,wave,struct,math,glob
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
CAP=os.path.join(os.path.expanduser('~'),'.cloudcli/voice-realtime-capture')
items=json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']
def read(p):
    with wave.open(p,'rb') as w:
        rate=w.getframerate(); data=w.readframes(w.getnframes())
    return rate,struct.unpack('<%dh'%(len(data)//2),data)
def rms(s,a,b):
    a=max(0,a); b=min(len(s),b); seg=s[a:b]
    return math.sqrt(sum(x*x for x in seg)/max(1,len(seg))) if seg else 0
def med(xs):return sorted(xs)[len(xs)//2] if xs else 0
print('| key | dur | start100 | end100 | speechMed | post300(src) | pre300(src) | nextGap | flag |')
print('|---|---|---|---|---|---|---|---|---|')
for f in items:
    rate,s=read(f['audio']); n=len(s)
    start100=rms(s,0,int(0.1*rate)); end100=rms(s,n-int(0.1*rate),n)
    # median over 100ms windows (speech-ish reference)
    vals=[rms(s,i,i+int(0.1*rate)) for i in range(0,n,int(0.1*rate)) if i+int(0.1*rate)<=n]
    speech_med=med(vals)
    src=glob.glob(os.path.join(CAP,f['connectionId']+'.wav'))[0]
    srate,ss=read(src)
    cut_start=max(0,f['startMs']-300); cut_end=f['endMs']
    pre300=rms(ss,int((cut_start-300)*srate/1000),int(cut_start*srate/1000))
    post300=rms(ss,int(cut_end*srate/1000),int((cut_end+300)*srate/1000))
    next_gap=f.get('gapNext',10**9)
    flags=[]
    # speech-level end/start: above 500 and not mostly a decay of a quiet tail
    if end100>500 and next_gap<800: flags.append('END-IN-SPEECH+ADJACENT')
    elif end100>800: flags.append('END-IN-SPEECH')
    if start100>500 and f.get('gapPrev',10**9)<800: flags.append('START-IN-SPEECH+ADJACENT')
    elif start100>800: flags.append('START-IN-SPEECH')
    if post300>800 and next_gap<800: flags.append('POST-SPEECH')
    print(f"| {f['key']} | {f['audioSeconds']}s | {int(start100)} | {int(end100)} | {int(speech_med)} | {int(post300)} | {int(pre300)} | {next_gap} | {','.join(flags) or '—'} |")
