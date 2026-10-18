import fs from 'node:fs';

const DIR = '/home/yale/.cloudcli/voice-realtime-log';
const P = { text: 0.0015, audio: 0.006, out: 0.0045 };
const IDs = ['86559798', 'b33412ea', '1b3011d1', 'a175e6cd'];
const BILL = { '86559798': 0.1113015, b33412ea: 0.0758940, '1b3011d1': 0.0068670, a175e6cd: 0.1276020 };
const cost = (t, a, o) => (t * P.text + a * P.audio + o * P.out) / 1000;
const clamp = (v, cap) => Math.min(v, cap);

// EVERY constant below is a measurement from experiments/voice-realtime-prefix-history-pruning:
const TOK_PER_INSTR_CHAR = 0.217; // prefix arm: 800/2400/4000 chars -> 461/808/1156 tokens
const PLUMBING_KEEP_FRACTION = 0.891; // plumbing arm, 12 utterances: 8714 / 9774 input tokens
const AUDIO_TWIN_REMOVES_HISTORY = true; // audio arm: audio 70 -> 0 after the delete-and-replace

const load = (id) => {
  const file = fs.readdirSync(DIR).find((f) => f.startsWith(id));
  const e = fs.readFileSync(DIR + '/' + file, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { prefix: e.find((x) => x.kind === 'prefix') || {}, resp: e.filter((x) => x.kind === 'response') };
};
const deltas = (resp, key) => resp.map((r, i) => (i === 0 ? 0 : Math.max(0, r[key] - resp[i - 1][key])));

const run = (resp, { instrTrim = 0, toolSlim = 0, plumbing = false, audioTwin = false }) => {
  const baseT = Math.max(100, resp[0].textTokens - instrTrim * TOK_PER_INSTR_CHAR - toolSlim);
  const dt = deltas(resp, 'textTokens');
  const da = deltas(resp, 'audioTokens');
  let c = 0;
  for (let i = 0; i < resp.length; i++) {
    const r = resp[i];
    const turn = Math.floor(i / 2);
    let growth = 0;
    for (let k = 0; k <= turn; k++) growth += dt[2 * k] + (dt[2 * k + 1] || 0);
    let text = baseT + growth * (plumbing ? PLUMBING_KEEP_FRACTION : 1);
    // The twin retires every PRIOR utterance's audio; the current turn's audio is still in context.
    let audio = r.audioTokens;
    if (audioTwin) {
      audio = da[2 * turn] + (da[2 * turn + 1] || 0);
    }
    c += cost(clamp(r.textTokens, text), Math.min(r.audioTokens, audio), r.outputTokens);
  }
  return c;
};

const SCENARIOS = [
  ['账单现状', {}],
  ['x 音频替身（语义上被证伪，仅列代价）', { audioTwin: true }],
  ['⑤-1 工具 schema 只瘦 session_send（−202 tok）', { toolSlim: 202 }],
  ['⑤-1+2 两个工具都瘦（−460 tok）', { toolSlim: 460 }],
  ['⑤-1+2+3 再剪 1000 字 instructions', { toolSlim: 460, instrTrim: 1000 }],
];

const rows = [];
for (const id of IDs) {
  const { resp } = load(id);
  rows.push({ id, bill: BILL[id], resp, values: SCENARIOS.map(([, o]) => run(resp, o)) });
}
const pad = (s, w) => String(s).padStart(w);
const W = 22;
const head = ['账单现状（实测复算）', ...SCENARIOS.slice(1).map(([n]) => n)];
console.log('conn        n ' + head.map((h) => h.slice(0, W - 2).padStart(W)).join(''));
for (const r of rows) {
  console.log(r.id.padEnd(9) + pad(r.resp.length, 3) + r.values.map((v) => v.toFixed(4).padStart(W)).join(''));
}
const totals = SCENARIOS.map((_, i) => rows.reduce((a, r) => a + r.values[i], 0));
console.log('TOTAL'.padEnd(12) + totals.map((t) => t.toFixed(4).padStart(W)).join(''));
console.log('');
console.log('账单原值 ¥0.3217 · 复算 ¥' + totals[0].toFixed(4) + '（应当一致）');
for (let i = 1; i < SCENARIOS.length; i++) {
  console.log(SCENARIOS[i][0].padEnd(44) + ' CNY ' + totals[i].toFixed(4) + '   ' +
    ((totals[i] / totals[0]) * 100).toFixed(0).padStart(3) + '% of bill   (saves ' + ((1 - totals[i] / totals[0]) * 100).toFixed(0) + '%)');
}
