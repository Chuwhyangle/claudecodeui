#!/usr/bin/env python3
"""Energy-based boundary refinement for the 30-item set.

The endpoint's speech_started/speech_stopped/committed are VAD EVENTS, not sentence boundaries:
a cut at `committed` can still be inside speech, and two segments can be one sentence split 3 ms
apart. This script scans the source capture with 20 ms RMS frames, finds the actual speech onset
and offset around the endpoint buffer, flags split/truncated pairs, and writes refined WAVs.
"""
import json, os, wave, struct, math, glob, array
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
CAP=os.path.join(os.path.expanduser('~'),'.cloudcli/voice-realtime-capture')
AUD=os.path.join(OUT,'audio-refined'); os.makedirs(AUD,exist_ok=True)
items=json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']
def read(p):
    with wave.open(p,'rb') as w:
        rate=w.getframerate(); data=w.readframes(w.getnframes())
    return rate,struct.unpack('<%dh'%(len(data)//2),data)
def frames(s,rate,ms=20):
    n=int(rate*ms/1000); out=[]
    for i in range(0,len(s)-n+1,n):
        seg=s[i:i+n]; out.append((i/rate, (i+n)/rate, math.sqrt(sum(x*x for x in seg)/n)))
    return out
def rms_between(s,rate,a,b):
    i=max(0,int(a*rate)); j=min(len(s),int(b*rate)); seg=s[i:j]
    return math.sqrt(sum(x*x for x in seg)/max(1,len(seg))) if seg else 0
def cut(src,rate,s,a,b,dest):
    i=max(0,int(a*rate)); j=min(len(s),int(b*rate))
    if j<=i: j=min(len(s),i+int(0.2*rate))
    with wave.open(dest,'wb') as o:
        o.setnchannels(1); o.setsampwidth(2); o.setframerate(rate)
        o.writeframes(array.array('h',s[i:j]).tobytes())
    return (j-i)/rate
print('| key | old | refined | Δstart | Δend | start100 | end100 | flags |')
print('|---|---|---|---|---|---|---|---|')
for f in items:
    src=glob.glob(os.path.join(CAP,f['connectionId']+'.wav'))[0]
    rate,s=read(src); dur=len(s)/rate
    fr=frames(s,rate); vals=sorted(x[2] for x in fr)
    noise=vals[max(0,int(len(vals)*0.10))] if vals else 0
    thr=max(3*noise,400)
    start0=max(0,f['startMs']/1000-0.3); end0=f['endMs']/1000
    prev_commit=max(0,(f['startMs']-f.get('gapPrev',f['startMs']))/1000)
    next_start=min(dur,(f['endMs']+f.get('gapNext',dur))/1000) if f.get('gapNext',10**9)<10**7 else dur
    # start: first frame above threshold in the window ending at start0
    lo=max(0,start0-2.0,prev_commit+0.1)
    cand=[x for x in fr if lo<=x[0]<start0 and x[2]>thr]
    start_ref=max(0,cand[0][0]-0.2) if cand else start0
    # end: last frame above threshold in the window starting at end0
    hi=min(dur,end0+2.0,next_start+0.1)
    cand2=[x for x in fr if end0<=x[1]<=hi and x[2]>thr]
    end_ref=min(dur,cand2[-1][1]+0.2) if cand2 else end0
    flags=[]
    if f.get('gapPrev',10**9)<300 and rms_between(s,rate,max(0,start0-0.1),start0)>thr: flags.append('PREV-SPLIT')
    if f.get('gapNext',10**9)<300 and rms_between(s,rate,end0,min(dur,end0+0.1))>thr: flags.append('NEXT-SPLIT')
    if end_ref>=dur-0.05 and rms_between(s,rate,max(0,dur-0.1),dur)>thr: flags.append('CAPTURE-END')
    if start_ref>=end_ref:
        start_ref=start0; end_ref=max(start0+0.2,end0)
    dest=os.path.join(AUD,f['key']+'.wav'); sec=cut(src,rate,s,start_ref,end_ref,dest)
    # post-cut edge energy in the refined file
    rr,ss=read(dest); n=len(ss)
    s100=rms_between(ss,rr,0,0.1); e100=rms_between(ss,rr,max(0,n/rr-0.1),n/rr)
    print(f"| {f['key']} | {start0:.2f}–{end0:.2f} | {start_ref:.2f}–{end_ref:.2f} | {(start_ref-start0)*1000:+.0f} | {(end_ref-end0)*1000:+.0f} | {int(s100)} | {int(e100)} | {','.join(flags) or '—'} |")
