// Offline scorer for the `order` arm (probe.mts, arm 11). Reads one or more traces, never spends.
//
//   node experiments/voice-realtime-prefix-history-pruning/analyze-order.mjs [trace.json ...] [--full]
//
// THE READING. What reaches Claude Code is each `session_send` message, in delivery order. Merging
// several spoken pieces into one message is fine; what this scores is ORDER: whether the pieces
// appear in the order the endpoint committed them (= the order the person spoke).
//
// HOW A PIECE IS LOCATED. The delivered text is NOT the transcript — the relay corrects obvious ASR
// slips ("蓝外"→"Live Voice") — so a piece is located by its longest common substring with the
// message, and counts only when that run covers at least half of the transcript and at least 3
// characters. Shorter transcripts ("是。", "花了。") cannot be located reliably and are left out of
// the scoring (they are still printed). Every flagged case is printed in full, because the screen is
// a screen: the verdict is read off the text, not off this number.
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const full = args.includes('--full');
const files = args.filter((a) => !a.startsWith('--'));
const traces = files.length > 0
  ? files
  : fs.readdirSync(path.join(HERE, 'traces')).filter((f) => f.startsWith('tier1-order-')).sort().map((f) => path.join(HERE, 'traces', f));

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s，。！？、,.!?“”"'：:；;（）()…—-]/g, '');

const lcsUnused = (a, b) => {
  // longest common substring: [length, start in b]
  let best = 0;
  let at = -1;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) {
        best = prev[j];
        at = j - prev[j];
      }
      diag = keep;
    }
  }
  return [best, at];
};

// Local alignment (Smith–Waterman: match +2, mismatch −1, gap −1) rather than an exact common
// substring: the relay corrects words inside a sentence (刚刚→刚才, 它→他), and one corrected
// character split the exact-substring reading in half, so whole sentences went unlocated and an
// inversion involving them would have been invisible.
const align = (t, m) => {
  const H = Array.from({ length: t.length + 1 }, () => new Int32Array(m.length + 1));
  let best = 0;
  let bi = 0;
  let bj = 0;
  for (let i = 1; i <= t.length; i++) {
    for (let j = 1; j <= m.length; j++) {
      const v = Math.max(0, H[i - 1][j - 1] + (t[i - 1] === m[j - 1] ? 2 : -1), H[i - 1][j] - 1, H[i][j - 1] - 1);
      H[i][j] = v;
      if (v > best) {
        best = v;
        bi = i;
        bj = j;
      }
    }
  }
  let i = bi;
  let j = bj;
  let matches = 0;
  while (i > 0 && j > 0 && H[i][j] > 0) {
    if (t[i - 1] === m[j - 1] && H[i][j] === H[i - 1][j - 1] + 2) {
      matches += 1;
      i -= 1;
      j -= 1;
    } else if (H[i][j] === H[i - 1][j - 1] - 1) {
      i -= 1;
      j -= 1;
    } else if (H[i][j] === H[i - 1][j] - 1) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return { matches, at: j };
};

const locate = (message, transcripts) => {
  const m = norm(message);
  const hits = [];
  for (const t of transcripts) {
    const n = norm(t.text);
    if (n.length < 3) continue;
    const { matches, at } = align(n, m);
    if (matches >= Math.max(3, Math.ceil(n.length * 0.5))) hits.push({ turn: t.turn, at, matches });
  }
  return hits.sort((x, y) => x.at - y.at);
};

const inverted = (seq) => seq.some((v, i) => i > 0 && v < seq[i - 1]);
const turnOf = (labelText) => Number(String(labelText).slice(1));

let totals = {};
for (const file of traces) {
  const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
  const runs = trace.results?.order ?? [];
  console.log(`\n######## ${path.basename(file)}  spend ¥${trace.spendCny}  runs=${runs.length}`);
  for (const r of runs) {
    if (r.error) {
      console.log(`  ERROR ${r.error}`);
      continue;
    }
    const tag = `${r.span.name}/${r.mode}#${r.rep}`;
    const deliveries = [];
    r.responses.forEach((resp, ri) => resp.calls.forEach((msg) => deliveries.push({ msg, ri, context: resp.context })));
    for (const msg of r.orphanCalls ?? []) deliveries.push({ msg, ri: -1, context: [] });

    let within = 0;
    let across = 0;
    let ctxInv = 0;
    let ctxInvWithDelivery = 0;
    const flagged = [];
    const firstDelivered = new Set();
    let maxDelivered = -1;
    for (const d of deliveries) {
      const hits = locate(d.msg, r.transcripts);
      const seq = hits.map((h) => h.turn);
      const ctxSeq = d.context.map(turnOf).filter((n) => Number.isFinite(n));
      const w = inverted(seq);
      const fresh = seq.filter((t) => !firstDelivered.has(t));
      const a = fresh.length > 0 && Math.min(...fresh) < maxDelivered;
      if (w) within += 1;
      if (a) across += 1;
      if (w || a) flagged.push({ ...d, seq, ctxSeq, ctxInverted: inverted(ctxSeq), kind: w ? 'within' : 'across' });
      for (const t of seq) firstDelivered.add(t);
      if (seq.length > 0) maxDelivered = Math.max(maxDelivered, ...seq);
    }
    for (const resp of r.responses) {
      const ctxSeq = resp.context.map(turnOf).filter((n) => Number.isFinite(n));
      if (inverted(ctxSeq)) {
        ctxInv += 1;
        if (resp.calls.length > 0) ctxInvWithDelivery += 1;
      }
    }
    const key = r.mode;
    totals[key] ??= { runs: 0, deliveries: 0, within: 0, across: 0, runsWithInversion: 0, ctxInv: 0, responses: 0 };
    const T = totals[key];
    T.runs += 1;
    T.deliveries += deliveries.length;
    T.within += within;
    T.across += across;
    T.runsWithInversion += within + across > 0 ? 1 : 0;
    T.ctxInv += ctxInv;
    T.responses += r.responses.length;

    console.log(
      `  ${tag.padEnd(26)} commits ${String(r.transcripts.length).padStart(2)}  deliveries ${String(deliveries.length).padStart(2)}  ` +
        `within-inv ${within}  across-inv ${across}  ctx-inverted ${ctxInv}/${r.responses.length} (with delivery ${ctxInvWithDelivery})  ` +
        `drift ${r.realtimeDriftMs}ms  final ctx [${r.finalContext.join(' ')}]`,
    );
    if (full || flagged.length > 0) {
      for (const t of r.transcripts) console.log(`      commit[${t.turn}] ${JSON.stringify(t.text)}`);
      for (const d of deliveries) {
        const f = flagged.find((x) => x === d || x.msg === d.msg);
        console.log(`      ${f ? '>>' : '  '} r${d.ri} ctx[${d.context.join(' ')}]  ${JSON.stringify(d.msg)}  pieces=${JSON.stringify(locate(d.msg, r.transcripts).map((h) => h.turn))}`);
      }
      if (r.swapLog?.length) console.log(`      swaps: ${r.swapLog.map((s) => `${s.turn}:${s.outcome ?? 'skip'}`).join(' ')}`);
    }
  }
}
console.log('\n======== totals by mode');
for (const [mode, T] of Object.entries(totals)) {
  console.log(
    `  ${mode.padEnd(13)} runs ${T.runs}  runs-with-inversion ${T.runsWithInversion}  deliveries ${T.deliveries}  ` +
      `within ${T.within}  across ${T.across}  ctx-inverted responses ${T.ctxInv}/${T.responses}`,
  );
}
