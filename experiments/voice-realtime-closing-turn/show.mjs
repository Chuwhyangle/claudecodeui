// Prints each run as an ordered timeline so it can be READ: what the endpoint heard (ASR), what the
// relay handed to Claude Code (CALL), and any text the model produced instead (TEXT), with which kind
// of response produced it. Counting is only the index; the verdict is read off these lines.
//
//   node experiments/voice-realtime-closing-turn/show.mjs [trace.json ...] [--brief]
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const brief = args.includes('--brief');
const files = args.filter((a) => !a.startsWith('--'));
const traces = files.length > 0 ? files : fs.readdirSync(path.join(HERE, 'traces')).sort().map((f) => path.join(HERE, 'traces', f));

const totals = {};
for (const file of traces) {
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\n######## ${path.basename(file)}  spend ¥${t.spendCny}  guard=${t.guardTriggered}`);
  for (const r of t.results) {
    if (r.error) {
      console.log(`  ERROR ${r.error}`);
      continue;
    }
    let trigger = null;
    let textVad = 0;
    let textClosing = 0;
    let sends = 0;
    let interrupts = 0;
    let asr = 0;
    for (const e of r.timeline) {
      if (e.kind === 'RESP') trigger = e.trigger;
      if (e.kind === 'TEXT' && String(e.text ?? '').trim() !== '') {
        if (trigger === 'closing') textClosing += 1;
        else textVad += 1;
      }
      if (e.kind === 'CALL' && e.tool === 'session_send') sends += 1;
      if (e.kind === 'CALL' && e.tool === 'session_interrupt') interrupts += 1;
      if (e.kind === 'ASR') asr += 1;
    }
    const key = r.arm;
    totals[key] ??= { runs: 0, cny: 0, responses: 0, sends: 0, interrupts: 0, textVad: 0, textClosing: 0 };
    Object.assign(totals[key], {
      runs: totals[key].runs + 1,
      cny: totals[key].cny + r.spendCny,
      responses: totals[key].responses + r.responses,
      sends: totals[key].sends + sends,
      interrupts: totals[key].interrupts + interrupts,
      textVad: totals[key].textVad + textVad,
      textClosing: totals[key].textClosing + textClosing,
    });
    console.log(
      `\n  === ${r.window}/${r.arm}#${r.rep}  ¥${r.spendCny}  responses ${r.responses}  ASR ${asr}  send ${sends}  interrupt ${interrupts}  ` +
        `text-to-user ${textVad}  text-closing ${textClosing}  insertedOk ${r.insertedOk}  drift ${r.driftMs}ms` +
        (r.errors.length ? `  errors ${r.errors.length}` : ''),
    );
    if (brief) continue;
    let resp = null;
    for (const e of r.timeline) {
      const at = `${(e.at / 1000).toFixed(1).padStart(5)}s`;
      if (e.kind === 'RESP') resp = e.trigger;
      if (e.kind === 'ASR') console.log(`    ${at} 听到  ${JSON.stringify(e.text)}`);
      else if (e.kind === 'CALL') console.log(`    ${at} ${e.tool === 'session_interrupt' ? '打断' : '交付'}  ${JSON.stringify(e.message)}${e.intent ? `  intent=${JSON.stringify(e.intent)}` : ''}`);
      else if (e.kind === 'TEXT' && String(e.text ?? '').trim() !== '') console.log(`    ${at} 文本  ${JSON.stringify(e.text)}  [${resp === 'closing' ? '收尾轮' : '回应用户语音'}]`);
      else if (e.kind === 'STATUS') console.log(`    ${at} 状态  ${e.phase}${e.queued ? ` queued=${e.queued}` : ''}`);
      else if (e.kind === 'ERROR') console.log(`    ${at} 错误  ${e.error}`);
      else if (e.kind === 'DONE' && e.status !== 'completed') console.log(`    ${at} 响应${e.status}  ${JSON.stringify(e.details).slice(0, 120)}`);
    }
    for (const err of r.errors) console.log(`    transport error ${err}`);
  }
}
console.log('\n======== by arm');
for (const [arm, T] of Object.entries(totals)) {
  console.log(
    `  ${arm.padEnd(3)} runs ${T.runs}  ¥${T.cny.toFixed(4)} (¥${(T.cny / T.runs).toFixed(4)}/run)  responses ${T.responses}  ` +
      `send ${T.sends}  interrupt ${T.interrupts}  text-to-user ${T.textVad}  text-closing ${T.textClosing}`,
  );
}
