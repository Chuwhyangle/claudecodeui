import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const HERE='/data/home/yale/work/claudecodeui/experiments/voice-now-priority';
const LABELS=JSON.parse(readFileSync(path.join(HERE,'x3-labels.json'),'utf8'));
const CANDS=JSON.parse(readFileSync(path.join(HERE,'traces','x3-candidates.json'),'utf8'));
const pair=(l)=>CANDS.find(c=>{const d=c.pieces.filter(p=>p.tool==='session_send'&&p.text.trim()!==''&&!p.text.trim().startsWith('{')).map(p=>p.text);
  return c.id.startsWith(l.id)&&d.length===l.pieces.length&&d.every((t,i)=>t===l.pieces[i].text);});
const INT=new Set(LABELS.map(l=>pair(l)?.id).filter(Boolean));
const DIRS=['x3-2026-10-15T06-32-18-235Z','x3-2026-10-15T06-55-16-240Z','x3-2026-10-15T07-03-03-822Z'].map(d=>path.join(HERE,'traces',d));
const runs=[]; for(const d of DIRS) for(const f of readdirSync(d)){ if(!f.endsWith('.json')||f==='summary.json')continue;
  let r;try{r=JSON.parse(readFileSync(path.join(d,f),'utf8'));}catch{continue;} if(r.error||!INT.has(r.episode))continue; runs.push(r);}
const strict=(l)=>/^(REMARK|NOISE|DUP)/.test(l), frag=(l)=>/-frag$/.test(l);
const per={}, rows=[];
for(const r of runs){ const E=r.events, ds=E.filter(e=>e.ev==='DELIVER');
  per[r.arm] ??= {runs:0,sD:0,sTool:0,fD:0,fTool:0}; per[r.arm].runs++;
  for(let i=0;i<ds.length;i++){ const d=ds[i],parts=d.parts??[]; if(!parts.length)continue;
    const labels=parts.map(p=>String(p).split(':')[0]);
    const until=ds[i+1]?.t??Infinity, span=E.filter(e=>e.t>d.t&&e.t<until);
    const tool=span.find(e=>e.ev==='TOOL');
    if(labels.every(strict)){ per[r.arm].sD++; if(tool)per[r.arm].sTool++; }
    if(labels.every(frag)){ per[r.arm].fD++; if(tool)per[r.arm].fTool++; }
    if(labels.every(strict)&&tool) rows.push(`${r.arm} ${r.episode.slice(0,8)} r${r.rep} t=${(d.t/1000).toFixed(1)}s [${labels.join('+')}] 说了"${String(d.text).slice(0,40)}" -> ${tool.name}${tool.bg?'[BG]':''}: ${String(tool.input).slice(0,90)}`);
  }}
console.log('臂 | runs | [严格噪声 REMARK/NOISE/DUP] 投递 / 之后有工具调用 / 比率 | [碎片 *-frag] 投递 / 之后有工具调用 / 比率');
for(const a of ['A','B','C','D','E']){const p=per[a]; if(!p)continue;
  console.log(`${a} | ${p.runs} | ${p.sD} / ${p.sTool} / ${p.sD?Math.round(100*p.sTool/p.sD):0}% | ${p.fD} / ${p.fTool} / ${p.fD?Math.round(100*p.fTool/p.fD):0}%`);}
writeFileSync(path.join(HERE,'traces','analysis-74of80','noise-tool-detail.txt'), rows.join('\n')+'\n');
console.log('\ndetail rows:', rows.length, '->', path.join(HERE,'traces','analysis-74of80','noise-tool-detail.txt'));
