#!/usr/bin/env python3
"""Human-review packet: every audio file, every arm's text, both reps, with judge scores."""
import json, os, collections
ROOT=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(ROOT,'out')
fixtures=json.load(open(os.path.join(OUT,'fixtures-30c.json')))['items']
def load(name):
    p=os.path.join(OUT,name)
    return [json.loads(l) for l in open(p) if l.strip()]
res={}
for f in ['results-30c.jsonl','results-guard.jsonl','results-guard-strict.jsonl','results-guard-hybrid.jsonl']:
    for r in load(f): res[(r['arm'],r['key'],r['rep'])]=r
verb={r['key']:r.get('text','') for r in load('verbatim30.jsonl')}
judge={}
for f in ['judge30c.jsonl','judge-guard.jsonl','judge-guard-strict.jsonl']:
    for r in load(f): judge[(r['arm'],r['key'],r['rep'])]=r
human={}
for f in ['judge-human.jsonl','judge-human-hybrid.jsonl']:
    for r in load(f): human[(r['arm'],r['key'],r['rep'])]=r
ARMS=['N0','N1','N1-guard','N1-guard-oracle','N1-guard-strict','N1-guard-oracle-strict','N1-guard-hybrid']
NOTES={
 '262537d7-1':'低能量（RMS 966）；N1 丢首句',
 '262537d7-2':'与下一句相邻 154ms；buffer 含下一句起音',
 '6c76e1cf-0':'上下文指代组；N1 多「六层」；strict 把「继承关系」还原成「集成」',
 '529f93f4-0':'R 重复了同一句（投递/配对伪影）',
 'b8360029-3':'R 本身误听（为什么走 → 为什么总是被）',
 'b8360029-6':'R 本身误听（具体没有什么 → 确实没有怎么）',
 '711e54cc-3':'R 被截断成「两」',
 'bf517472-0':'术语 pack；同模型逐字稿也说「派克」',
 'e8df1709-0':'与下一句相邻 95ms（能量分离）',
 'e8df1709-1':'与上一句相邻 95ms（能量分离）',
 'b8360029-1':'低能量（RMS 464）；N1 多「如果」',
 'b8360029-4':'与下一句相邻 428ms；N1 多「我们平时」',
}
def note(f):
    bits=[]
    if f['key'] in NOTES: bits.append(NOTES[f['key']])
    if f.get('rms',0)<800: bits.append(f'低能量 RMS {f["rms"]}')
    if f.get('gapPrev',10**9)<500 and f.get('startMs',0)>1000: bits.append(f'前一语音间隔 {f["gapPrev"]}ms')
    if f.get('gapNext',10**9)<500: bits.append(f'后一语音间隔 {f["gapNext"]}ms')
    return '；'.join(dict.fromkeys(bits)) or '—'
def arm_text(arm,key,rep):
    r=res.get((arm,key,rep)); return r.get('text','') if r else '（无）'
def jline(arm,key,rep):
    out=[]
    j=judge.get((arm,key,rep))
    if j: out.append(f"[R-judge {j.get('score')}: {j.get('reason','')[:120]}]")
    h=human.get((arm,key,rep))
    if h: out.append(f"[human {h.get('score')}: {h.get('reason','')[:120]}]")
    return ('  ' + ' '.join(out)) if out else ''

lines=[]
lines.append('# 人工检查包：30 条 live voice 音频 × 各臂输出\n')
lines.append('日期：2026-10-22。音频来自 `~/.cloudcli/voice-realtime-capture/<connectionId>.wav`；'
             '每条按端点 buffer 切出：`start = speech_started - 300ms`（端点 `prefix_padding_ms=300`），'
             '`end = input_audio_buffer.committed`。切出的 WAV 在 `out/audio30b/`（28 条）与 `out/audio30c/`（2 条）。\n')
lines.append('臂：N0=无上下文；N1=正确 C2 上下文；N1-guard=逐字稿护栏（同一 omni 的逐字稿）；'
             'N1-guard-oracle=护栏（独立 ASR = realtime endpoint 的 ASR）；strict 版对中文替换也做还原。'
             'judge 是 `qwen3.8-flash`，2=同义，1=部分，0=不同。\n')
# inventory
lines.append('## 1. 音频清单\n')
lines.append('| # | key | 切出文件 | 源捕获 | 端点 buffer (ms) | 实际切点 (ms) | 时长 | RMS / peak | 备注 |')
lines.append('|---|---|---|---|---|---|---|---|---|')
for n,f in enumerate(fixtures,1):
    src='~/.cloudcli/voice-realtime-capture/'+f['connectionId']+'.wav'
    cut=f'{max(0,f["startMs"]-300)}–{f["endMs"]}'
    buf=f'{f["startMs"]}–{f["endMs"]}'
    rel=os.path.relpath(f['audio'],ROOT)
    lines.append(f'| {n} | `{f["key"]}` | `{rel}` | `{src}` | {buf} | {cut} | {f["audioSeconds"]}s | {f.get("rms","?")} / {f.get("peak","?")} | {note(f)} |')
lines.append('\n源捕获文件绝对路径前缀：`/data/home/yale/.cloudcli/voice-realtime-capture/`。'
             '每条 fixture 还带 `connectionAt`、`sessionId`、`contextChars/contextRows`（上下文已与 journal 对账）。\n')
# summary
lines.append('## 2. judge 计数\n')
lines.append('| 臂 | rep0 | rep1 |')
lines.append('|---|---|---|')
for arm in ARMS:
    cells=[]
    for rep in (0,1):
        sc=[judge[(arm,k,rep)]['score'] for k in [f['key'] for f in fixtures] if (arm,k,rep) in judge]
        cells.append(str(dict(collections.Counter(sc))) if sc else '—')
    lines.append(f'| `{arm}` | {cells[0]} | {cells[1]} |')
lines.append('')
# per item
lines.append('## 3. 逐条文本（rep0 / rep1）\n')
for n,f in enumerate(fixtures,1):
    k=f['key']
    lines.append(f'### {n:02d}. `{k}` — {f["audioSeconds"]}s — {note(f)}\n')
    lines.append(f'- 音频：`{os.path.relpath(f["audio"],ROOT)}`')
    lines.append(f'- 源：`~/.cloudcli/voice-realtime-capture/{f["connectionId"]}.wav`，buffer {f["startMs"]}–{f["endMs"]} ms，实际切 {max(0,f["startMs"]-300)}–{f["endMs"]} ms')
    lines.append(f'- 上下文：{f["contextChars"]} chars / {f["contextRows"]} rows')
    lines.append(f'- **ASR（realtime endpoint）**：{f["asr"]}')
    lines.append(f'- **R（realtime delivered）**：{f["relay"]}')
    lines.append(f'- **Verb（同一 omni 逐字稿）**：{verb.get(k,"（无）")}')
    lines.append('')
    for arm in ARMS:
        for rep in (0,1):
            lines.append(f'- **{arm} rep{rep}**：{arm_text(arm,k,rep)}{jline(arm,k,rep)}')
        lines.append('')
    # guard actions for the strict oracle (what changed)
    for arm in ['N1-guard-oracle','N1-guard-oracle-strict','N1-guard-hybrid']:
        r=res.get((arm,k,0))
        if r and r.get('actions'):
            lines.append(f'- `{arm}` actions(rep0)：`{json.dumps(r["actions"],ensure_ascii=False)}`')
    lines.append('')
open(os.path.join(OUT,'MANUAL-REVIEW.md'),'w').write('\n'.join(lines))
print('wrote', os.path.join(OUT,'MANUAL-REVIEW.md'), len(lines), 'lines')
