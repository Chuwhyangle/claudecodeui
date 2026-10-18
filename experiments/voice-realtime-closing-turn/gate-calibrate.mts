/**
 * Calibrates the mechanical gate against the human-read verdicts of the 2026-10-15 run (¥0).
 *
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-realtime-closing-turn/gate-calibrate.mts
 *
 * The README read every delivered text by hand. A gate that cannot reproduce those readings has no
 * business deciding whether the next stage spends money.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, type RunRecord } from './gate.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(HERE, 'traces');

// window → arm → the best record seen (one that carries a timeline and no error).
const index = new Map<string, Map<string, RunRecord>>();
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const trace = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as { results: Array<RunRecord & { arm?: string }> };
  for (const r of trace.results) {
    if (r.error !== undefined || r.window === undefined || r.arm === undefined || (r.timeline ?? []).length === 0) continue;
    const arms = index.get(r.window) ?? new Map<string, RunRecord>();
    arms.set(r.arm, r);
    index.set(r.window, arms);
  }
}

/** What the README's hand reading concluded, per (window, arm) — `lost` = a real unit did not arrive. */
const HUMAN: Record<string, 'ok' | 'lost' | 'shared-defect'> = {
  'W1/N1': 'ok',
  'W1/N0': 'ok',
  'W2/N1': 'ok',
  'W2/N0': 'ok',
  'W2/N2': 'lost', // "先处理现在的这请求。" became the text "OK"
  'W1/N2': 'ok',
  'W2/S': 'ok',
  'W1/S': 'ok',
  'W3/S': 'shared-defect', // 1 loss on a truncated call both arms share; K merged it back by luck
  'W4/S': 'ok',
  'W4/N2': 'ok',
};

let agree = 0;
let disagree = 0;
for (const [window, arms] of [...index.entries()].sort()) {
  const k = arms.get('K');
  if (k === undefined) continue;
  for (const [arm, record] of [...arms.entries()].sort()) {
    if (arm === 'K') continue;
    const g = evaluate(k, record);
    const human = HUMAN[`${window}/${arm}`];
    const gateSaysLost = g.verdict === 'FAIL' && g.lostUnits.length > 0;
    const verdictMatches =
      human === undefined ? null : human === 'lost' ? gateSaysLost : human === 'ok' ? g.lostUnits.length === 0 : true;
    if (verdictMatches === true) agree += 1;
    if (verdictMatches === false) disagree += 1;
    console.log(
      `${window}/${arm.padEnd(3)} gate=${g.verdict.padEnd(6)} lost=${g.lostUnits.length} int=${g.interruptsCandidate}/${g.interruptsK}` +
        ` text=${g.textRepliesCandidate}/${g.textRepliesK} cost=${g.costRatio === null ? '-' : (g.costRatio * 100).toFixed(0) + '%'}` +
        `  human=${human ?? '(unread)'}  ${verdictMatches === null ? '' : verdictMatches ? '✔' : '✘ DISAGREES'}`,
    );
    for (const reason of g.reasons) console.log(`        · ${reason}`);
  }
}
console.log(`\nagree ${agree} · disagree ${disagree}`);
process.exit(disagree === 0 ? 0 : 1);
