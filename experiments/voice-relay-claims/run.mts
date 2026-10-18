/**
 * Claims probe: can the relay model say WHICH spoken items a `session_send` covers?
 *
 * The scheme under test: the model's response carries a claim of the input it covers; the application
 * server only fills (with the recogniser's text) what no response claimed. This probe measures how HONEST and how
 * COMPLETE the claim is, against known-text ground truth — not whether the model rewords well.
 *
 *   T0     no help: the model is asked for [from_s,to_s] windows of the conversation audio it covers.
 *   R-time the model is given a roster (number, time span, rough recogniser text) and returns windows.
 *   R-ids  same roster; the model returns `covers` (item numbers) and `skipped` (numbers it drops on purpose).
 *
 * The uplink gate is NOT used (the upstream audio clock then equals the feed clock, so time claims can be graded).
 * Responses are not auto-created: all items are pending, then ONE ask is made — the hardest multi-item case.
 *
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-relay-claims/run.mts --arms T0,R-time,R-ids --reps 2
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { createRun, openSession, readApiKey, sleep, sessionBody, type P0Session, type ProbeEvent } from '../voice-realtime-segmented/p0/probe-lib.mts';
import { VOICE_REALTIME_INSTRUCTIONS, VOICE_REALTIME_TOOLS } from '../../server/modules/voice-realtime/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FIXTURES = path.join(REPO, 'experiments/voice-provider-paired-quality/fixtures');
const BUDGET_CNY = 0.2;
const CONCURRENCY = 6;
const GAP_MS = 1000;

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

type Clip = { file: string; reference: string; anchor: string };
const CLIPS: Record<string, Clip> = {
  d01: { file: 'd01-o65.wav', reference: '把 server 里的 voice.service.ts 的超时改成三十秒', anchor: 'voice.service.ts' },
  d03: { file: 'd03-o65.wav', reference: '看一下 useVoiceInput 这个 hook 是怎么处理 recording 的', anchor: 'usevoiceinput' },
  d08: { file: 'd08-o65.wav', reference: '把默认模型换成 whisper large，啊不，是 whisper turbo', anchor: 'whisper' },
};
const SPANS: Array<{ id: string; clips: string[] }> = [
  { id: 'S1', clips: ['d01', 'd03'] },
  { id: 'S3', clips: ['d01', 'd03', 'd08'] },
  // the user says the same sentence twice: a model that merges the repeat is deleting redundancy ON PURPOSE
  { id: 'S4', clips: ['d01', 'd01'] },
];

// ── audio ───────────────────────────────────────────────────────────────────────────────────────
const FRAME_BYTES = 640;
const readWav = (file: string): Buffer => {
  const buf = readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
};
const rms = (f: Buffer): number => {
  let s = 0;
  for (let i = 0; i < 320; i += 1) { const v = f.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / 320);
};
const compress = (pcm: Buffer): Buffer => {
  const out: Buffer[] = [];
  let gap = 0;
  let started = false;
  for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
    const f = pcm.subarray(i, i + FRAME_BYTES);
    if (rms(f) >= 300) { out.push(f); started = true; gap = 0; }
    else if (started && gap < 10) { out.push(f); gap += 1; }
  }
  return Buffer.concat(out);
};
const msOf = (b: Buffer): number => Math.round((b.length / 2 / 16_000) * 1000);

function buildFeed(clips: string[]): { feed: Buffer; truth: Array<{ id: string; startMs: number; endMs: number }> } {
  const parts: Buffer[] = [Buffer.alloc(600 * 32 / 2 * 1)];
  parts[0] = Buffer.alloc(Math.round(0.6 * 16_000) * 2);
  const truth: Array<{ id: string; startMs: number; endMs: number }> = [];
  let at = 600;
  for (const id of clips) {
    const speech = compress(readWav(path.join(FIXTURES, CLIPS[id]!.file)));
    truth.push({ id, startMs: at, endMs: at + msOf(speech) });
    parts.push(speech, Buffer.alloc(Math.round((GAP_MS / 1000) * 16_000) * 2));
    at += msOf(speech) + GAP_MS;
  }
  parts.push(Buffer.alloc(Math.round(1.6 * 16_000) * 2));
  return { feed: Buffer.concat(parts), truth };
}

// ── scoring ─────────────────────────────────────────────────────────────────────────────────────
const norm = (s: string): string => s.toLowerCase().replace(/[\s，。！？、,.!?"“”'’：:；;（）()\-]/g, '');
const grams = (s: string): Set<string> => { const c = s.replace(/\s/g, ''); const o = new Set<string>(); for (let i = 0; i + 4 <= c.length; i += 1) o.add(c.slice(i, i + 4)); return o; };
const present = (clipId: string, message: string): boolean => {
  const c = CLIPS[clipId]!;
  if (norm(message).includes(norm(c.anchor))) return true;
  const a = grams(norm(c.reference));
  const b = grams(norm(message));
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return a.size > 0 && hit / a.size >= 0.5;
};

// ── prompts ─────────────────────────────────────────────────────────────────────────────────────
type Arm = 'T0' | 'R-time' | 'R-ids' | 'R-enum';
const CLAUSE: Record<Arm, string> = {
  T0:
    'When you call `session_send`, also set `windows` (JSON text, e.g. "[[0.5,6.2],[7.0,12.1]]") to a list of [from_s, to_s] spans: the start and end, in seconds since the first ' +
    'audio of this conversation, of the user speech your `message` carries. Speech outside your windows will be forwarded to the session ' +
    'separately as raw recogniser text.',
  'R-time':
    'The user\'s recent speech is listed below as numbered items with their time spans (seconds into the conversation audio) and the speech ' +
    'recogniser\'s rough transcript (it can be wrong; you hear the audio itself). When you call `session_send`, also set `windows` (JSON text, ' +
    'e.g. "[[0.5,6.2],[7.0,12.1]]") to a list of [from_s, to_s] spans of the user speech your `message` carries. Speech outside your windows will be forwarded to the session ' +
    'separately as raw recogniser text.',
  'R-enum':
    'The user\'s recent speech is listed below as numbered items with their time spans and the speech recogniser\'s rough transcript (it can ' +
    'be wrong; you hear the audio itself). When you call `session_send`, also set `items` (JSON text, e.g. {"1":"carried","2":"merged","3":"skipped"}) ' +
    'and give EVERY listed number exactly one status: "carried" = its content is in your `message`; "merged" = it repeats or is absorbed by another ' +
    'item already in your `message`; "skipped" = drop it entirely (pure noise or filler). Any number you leave out is forwarded to the session ' +
    'separately as raw recogniser text.',
  'R-ids':
    'The user\'s recent speech is listed below as numbered items with their time spans and the speech recogniser\'s rough transcript (it can ' +
    'be wrong; you hear the audio itself). When you call `session_send`, also set `covers` (JSON text, e.g. "[1,2]") to the numbers of the items whose content your ' +
    '`message` carries. Any item you do not list will be forwarded to the session separately as raw recogniser text. List in `skipped` (JSON text, e.g. "[3]") only ' +
    'items that should be dropped entirely (pure noise, filler, or an exact repetition you already merged).',
};

const sendTool = (arm: Arm) => ({
  name: 'session_send',
  description: 'Send a message to the Claude Code session.',
  inputSchema:
    arm === 'R-ids'
      ? { message: z.string(), covers: z.string().optional(), skipped: z.string().optional() }
      : arm === 'R-enum'
        ? { message: z.string(), items: z.string().optional() }
        : { message: z.string(), windows: z.string().optional() },
});

const asJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return undefined; }
};

// ── one run ─────────────────────────────────────────────────────────────────────────────────────
type Item = { id: string; start: number | null; end: number | null; text: string; committed: boolean };

const runOne = async (run: ReturnType<typeof createRun>, spanId: string, clipIds: string[], arm: Arm, rep: number) => {
  const { feed, truth } = buildFeed(clipIds);
  const items = new Map<string, Item>();
  const touch = (id: string): Item => {
    if (!items.has(id)) items.set(id, { id, start: null, end: null, text: '', committed: false });
    return items.get(id)!;
  };
  const calls: Array<Record<string, unknown>> = [];
  const seenCalls = new Set<string>();
  let doneCount = 0;
  let updatedCount = 0;

  const onEvent = (event: ProbeEvent): void => {
    if (event.direction !== 'received') return;
    const w = event.wire as Record<string, unknown>;
    const t = String(w.type ?? '');
    const id = typeof w.item_id === 'string' ? w.item_id : '';
    if (t === 'input_audio_buffer.speech_started' && id) touch(id).start = Number(w.audio_start_ms);
    else if (t === 'input_audio_buffer.speech_stopped' && id) touch(id).end = Number(w.audio_end_ms);
    else if (t === 'input_audio_buffer.committed' && id) touch(id).committed = true;
    else if (t === 'conversation.item.input_audio_transcription.completed' && id) touch(id).text = String(w.transcript ?? '').trim();
    else if (t === 'session.updated') updatedCount += 1;
    else if (t === 'response.done') doneCount += 1;
    else if (t === 'response.function_call_arguments.done' && w.name === 'session_send') {
      const callId = String(w.call_id ?? '');
      if (callId && seenCalls.has(callId)) return;
      seenCalls.add(callId);
      try { calls.push(JSON.parse(String(w.arguments ?? '{}')) as Record<string, unknown>); } catch { calls.push({ _raw: String(w.arguments) }); }
    }
  };

  const base = `${VOICE_REALTIME_INSTRUCTIONS} ${CLAUSE[arm]}`;
  const session: P0Session = await openSession({
    run,
    label: `${spanId}-${arm}-${rep}`,
    instructions: base,
    sessionDefaults: sessionBody({ turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800, create_response: false } }),
    tools: [sendTool(arm), ...VOICE_REALTIME_TOOLS.filter((x) => x.name === 'session_interrupt')] as never,
    respondToToolOutputs: false,
    executor: {
      session_send: () => ({ accepted: true }),
      session_interrupt: () => ({ aborted: true, runId: 'replay-run', triggerSeq: null, queuedStillPending: 0 }),
    },
    onEvent,
  });

  const t0 = Date.now();
  const frames = Math.floor(feed.length / FRAME_BYTES);
  for (let i = 0; i < frames; i += 1) {
    session.sendAudioBase64(feed.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES).toString('base64'));
    const wait = t0 + (i + 1) * 20 - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await session.waitFor(() => { const all = [...items.values()]; return all.length > 0 && all.every((x) => x.committed && x.text !== ''); }, 8_000);
  await sleep(300);

  const ordered = [...items.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const sec = (ms: number | null): string => (ms === null ? '?' : (ms / 1000).toFixed(1));
  if (arm !== 'T0') {
    const roster = ordered.map((x, i) => `[${i + 1}] ${sec(x.start)}–${sec(x.end)}s  "${x.text}"`).join('\n');
    const before = updatedCount;
    session.setInstructions(`${base}\n\nPENDING ITEMS:\n${roster}`);
    await session.waitFor(() => updatedCount > before, 3_000);
  }
  const doneBefore = doneCount;
  session.sendRaw({ type: 'response.create' });
  await session.waitFor(() => doneCount > doneBefore, 20_000);
  await sleep(400);
  await session.close().catch(() => undefined);

  // ground truth: each upstream item → the clip it overlaps most
  const clipOf = (x: Item): { id: string; startMs: number; endMs: number } | null => {
    let best: { id: string; startMs: number; endMs: number } | null = null;
    let bestOv = 0;
    for (const c of truth) {
      const ov = Math.max(0, Math.min(x.end ?? 0, c.endMs) - Math.max(x.start ?? 0, c.startMs));
      if (ov > bestOv) { bestOv = ov; best = c; }
    }
    return best;
  };
  const message = calls.map((c) => String(c.message ?? '')).join(' ');
  const arr = (v: unknown): unknown[] => { const j = asJson(v); return Array.isArray(j) ? j : []; };
  const windows: number[][] = calls.flatMap((c) => arr(c.windows).filter(Array.isArray).map((w) => (w as unknown[]).map(Number)));
  const covers = new Set<number>(calls.flatMap((c) => arr(c.covers).map(Number)));
  const skipped = new Set<number>(calls.flatMap((c) => arr(c.skipped).map(Number)));
  const dispo: Record<string, string> = {};
  for (const c of calls) { const j = asJson(c.items); if (j && typeof j === 'object' && !Array.isArray(j)) Object.assign(dispo, j as Record<string, string>); }
  const field = (c: Record<string, unknown>): unknown => (arm === 'R-ids' ? c.covers : arm === 'R-enum' ? c.items : c.windows);
  const unparsable = calls.filter((c) => field(c) !== undefined && asJson(field(c)) === undefined).length;

  const rows = ordered.map((x, i) => {
    const clip = clipOf(x);
    const isPresent = clip ? present(clip.id, message) : false;
    let claimed = false;
    if (arm === 'R-ids') claimed = covers.has(i + 1);
    else if (arm === 'R-enum') claimed = ['carried', 'merged'].includes(String(dispo[String(i + 1)] ?? ''));
    else {
      const dur = Math.max(1, (x.end ?? 0) - (x.start ?? 0));
      let ov = 0;
      for (const [a, b] of windows) ov += Math.max(0, Math.min((x.end ?? 0), (b ?? 0) * 1000) - Math.max(x.start ?? 0, (a ?? 0) * 1000));
      claimed = ov / dur >= 0.5;
    }
    const isSkipped = arm === 'R-enum' ? String(dispo[String(i + 1)] ?? '') === 'skipped' : skipped.has(i + 1);
    return { n: i + 1, clip: clip?.id ?? '?', text: x.text, present: isPresent, claimed, skipped: isSkipped };
  });
  // timestamp accuracy (window arms): nearest window per ground-truth clip
  const tsErr: number[] = [];
  if (arm !== 'R-ids') {
    for (const c of truth) {
      let best: number[] | null = null;
      let bestOv = -1;
      for (const w of windows) {
        const ov = Math.min(c.endMs, (w[1] ?? 0) * 1000) - Math.max(c.startMs, (w[0] ?? 0) * 1000);
        if (ov > bestOv) { bestOv = ov; best = w; }
      }
      if (best) tsErr.push(Math.abs((best[0] ?? 0) * 1000 - c.startMs), Math.abs((best[1] ?? 0) * 1000 - c.endMs));
    }
  }
  return {
    span: spanId, arm, rep, spendCny: session.spendCny, items: ordered.length, nCalls: calls.length, unparsable,
    errors: session.errors.map((e) => String((e.wire as Record<string, unknown>).code ?? (e.wire as Record<string, unknown>).type ?? 'err')),
    rosterSize: ordered.length,
    fieldMissing: calls.length === 0 || calls.every((c) => field(c) === undefined),
    message, calls, rows,
    falseClaim: rows.filter((r) => r.claimed && !r.present).length,
    okClaim: rows.filter((r) => r.claimed && r.present).length,
    missedClaim: rows.filter((r) => !r.claimed && !r.skipped && r.present).length,
    fillSaves: rows.filter((r) => !r.claimed && !r.skipped && !r.present).length,
    skippedPresent: rows.filter((r) => r.skipped && r.present).length,
    skippedAbsent: rows.filter((r) => r.skipped && !r.present).length,
    tsErrMedianMs: tsErr.length ? tsErr.sort((a, b) => a - b)[Math.floor(tsErr.length / 2)] : null,
    truth, itemSpans: ordered.map((x) => [x.start, x.end]),
  };
};

const main = async (): Promise<void> => {
  const arms = arg('arms', 'T0,R-time,R-ids').split(',') as Arm[];
  const reps = Number(arg('reps', '2'));
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} · arms ${arms.join(',')} · reps ${reps} · gap ${GAP_MS}ms · uplink gate OFF`);
  const jobs: Array<() => Promise<Record<string, unknown>>> = [];
  const only = arg('spans', '').split(',').filter(Boolean);
  for (const sp of SPANS.filter((x) => only.length === 0 || only.includes(x.id))) for (const arm of arms) for (let r = 0; r < reps; r += 1) jobs.push(() => runOne(run, sp.id, sp.clips, arm, r));
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const settled = await Promise.allSettled(jobs.slice(i, i + CONCURRENCY).map((f) => f()));
    results.push(...settled.map((s) => (s.status === 'fulfilled' ? s.value : { error: String(s.reason) })));
    console.log(`progress ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length} · spend ¥${run.spendCny.toFixed(4)}`);
  }
  mkdirSync(path.join(HERE, 'traces'), { recursive: true });
  const file = path.join(HERE, 'traces', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify({ ranAt: new Date().toISOString(), spendCny: Number(run.spendCny.toFixed(6)), guardTriggered: run.guardTriggered, results }, null, 2)}\n`);
  console.log(`spend ¥${run.spendCny.toFixed(6)} of ¥${BUDGET_CNY} · guard=${run.guardTriggered}\ntrace: ${file}`);
  process.exit(0);
};
void main();
