#!/usr/bin/env python3
"""Silence-valley boundary refinement.

A segment's true start/end is the nearest SILENCE run (>=120 ms below the speech threshold),
not the first/last frame above it. If there is no silence between this segment and the previous
commit / next speech_started, the two VAD segments are one continuous utterance: flag SPLIT.
"""
import json, os, wave, struct, math, glob, array
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
CAP=os.path.join(os.path.expanduser('~'),'.cloudcli/voice-realtime-capture')
AUD=os.path.join(OUT,'audio-refined2'); os.makedirs(AUD,exist_ok=True)
items=json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']
def read(p):
    with wave.open(p,'rb') as w: rate=w.getframerate(); data=w.readframes(w.getnframes())
    return rate,struct.unpack('<%dh'%(len(data)//2),data)
def frame_rms(s,rate,ms=20):
    n=int(rate*ms/1000); return [(i/rate,(i+n)/rate,math.sqrt(sum(x*x for x in s[i:i+n])/n)) for i in range(0,len(s)-n+1,n)]
def rms_between(s,rate,a,b):
    i=max(0,int(a*rate)); j=min(len(s),int(b*rate)); seg=s[i:j]
    return math.sqrt(sum(x*x for x in seg)/max(1,len(seg))) if seg else 0
def silences(fr,thr,min_ms=120):
    out=[]; cur=None
    for a,b,r in fr:
        if r<=thr:
            if cur is None: cur=[a,b]
            else: cur[1]=b
        else:
            if cur and (cur[1]-cur[0])*1000>=min_ms: out.append(tuple(cur))
            cur=None
    if cur and (cur[1]-cur[0])*1000>=min_ms: out.append(tuple(cur))
    return out
def cut(src,rate,s,a,b,dest):
    i=max(0,int(a*rate)); j=min(len(s),int(b*rate))
    if j<=i: j=min(len(s),i+int(0.2*rate))
    with wave.open(dest,'wb') as o:
        o.setnchannels(1); o.setsampwidth(2); o.setframerate(rate); o.writeframes(array.array('h',s[i:j]).tobytes())
    return (j-i)/rate
print('| key | endpoint | refined | Δstart | Δend | start100 | end100 | flags |')
print('|---|---|---|---|---|---|---|---|')
for f in items:
    src=glob.glob(os.path.join(CAP,f['connectionId']+'.wav'))[0]
    rate,s=read(src); dur=len(s)/rate
    fr=frame_rms(s,rate); vals=sorted(x[2] for x in fr)
    noise=vals[max(0,int(len(vals)*0.10))] if vals else 0
    thr=max(3*noise,400); sil=silences(fr,thr)
    start0=max(0,f['startMs']/1000-0.3); end0=f['endMs']/1000
    prev_commit=max(0,(f['startMs']-f.get('gapPrev',f['startMs']))/1000)
    next_start=min(dur,(f['endMs']+f.get('gapNext',dur))/1000) if f.get('gapNext',10**9)<10**7 else dur
    # last silence ending at/before start0, within [prev_commit-0.3, start0]
    before=[x for x in sil if x[1]<=start0+0.01 and x[0]>=prev_commit-0.3 and x[0]>=start0-3.0]
    start_ref=(before[-1][1]+0.1) if before else start0
    # first silence starting at/after end0, within [end0, next_start+0.3]
    after=[x for x in sil if x[0]>=end0-0.01 and x[1]<=next_start+0.3 and x[1]<=end0+3.0]
    end_ref=(after[0][0]+0.1) if after else end0
    flags=[]
    if not before and start0-prev_commit<1.0 and rms_between(s,rate,start0-0.1,start0)>thr: flags.append('PREV-SPLIT')
    if not after and next_start-end0<1.0 and rms_between(s,rate,end0,min(dur,end0+0.1))>thr: flags.append('NEXT-SPLIT')
    if not after and next_start>=dur-0.01 and rms_between(s,rate,max(0,dur-0.1),dur)>thr: flags.append('CAPTURE-END')
    if start_ref>=end_ref: start_ref=start0; end_ref=end0
    dest=os.path.join(AUD,f['key']+'.wav'); cut(src,rate,s,start_ref,end_ref,dest)
    rr,ss=read(dest); n=len(ss)
    s100=rms_between(ss,rr,0,0.1); e100=rms_between(ss,rr,max(0,n/rr-0.1),n/rr)
    print(f"| {f['key']} | {start0:.2f}–{end0:.2f} | {start_ref:.2f}–{end_ref:.2f} | {(start_ref-start0)*1000:+.0f} | {(end_ref-end0)*1000:+.0f} | {int(s100)} | {int(e100)} | {','.join(flags) or '—'} |")
