/**
 * Step 2: per-item claims under the CURRENT trigger regime (the endpoint starts the responses).
 *
 * This probe plays the relay: it numbers items at `committed`, keeps a ledger, rewrites a ROSTER into the
 * instructions after each change, applies a response's claim only if the response COMPLETED with a
 * `session_send`, and finally "fills" (delivers the recogniser text of) whatever no claim resolved.
 * Everything is graded against KNOWN text: per clip, how many times did its content reach the session
 * (0 = lost, 1 = right, 2+ = duplicated), and where did each loss/duplicate come from.
 *
 *   E   roster with recogniser text; per-item statuses (carried/merged/skipped) + roster version echo.
 *   EN  same, roster WITHOUT recogniser text (number + time span only).
 *   EA  E + `anchors`: first words of each carried item, as written in the message (self-consistency check).
 *   EO  no roster: the model numbers its own un-relayed items; the relay maps ordinals to its pending list.
 *
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-relay-ledger/run.mts --arms E,EN,EA,EO --reps 2
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
const BUDGET_CNY = 0.25;
const CONCURRENCY = 8;
const GAP_MS = 1000;
const DRAIN_MS = 8_000;

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};

type Clip = { file: string; reference: string; anchor: string };
const CLIPS: Record<string, Clip> = {
  d01: { file: 'd01-o65.wav', reference: '把 server 里的 voice.service.ts 的超时改成三十秒', anchor: 'voice.service.ts' },
  d03: { file: 'd03-o65.wav', reference: '看一下 useVoiceInput 这个 hook 是怎么处理 recording 的', anchor: 'usevoiceinput' },
  d04: { file: 'd04-o65.wav', reference: '不要动 voice.service.ts，只改 voice.module.ts', anchor: 'voice.module.ts' },
  d08: { file: 'd08-o65.wav', reference: '把默认模型换成 whisper large，啊不，是 whisper turbo', anchor: 'whisper' },
};
const SPANS: Array<{ id: string; clips: string[] }> = [
  { id: 'S5', clips: ['d01', 'd03', 'd04', 'd08'] },
  { id: 'S6', clips: ['d04', 'd08', 'd01', 'd03'] },
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
const rms = (f: Buffer): number => { let s = 0; for (let i = 0; i < 320; i += 1) { const v = f.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / 320); };
const compress = (pcm: Buffer): Buffer => {
  const out: Buffer[] = [];
  let gap = 0;
  let started = false;
  for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
    const f = pcm.subarray(i, i + FRAME_BYTES);
    if (rms(f) >= 300) { out.push(f); started = true; gap = 0; } else if (started && gap < 10) { out.push(f); gap += 1; }
  }
  return Buffer.concat(out);
};
const msOf = (b: Buffer): number => Math.round((b.length / 2 / 16_000) * 1000);

type Truth = { idx: number; id: string; startMs: number; endMs: number };
function buildFeed(clips: string[]): { feed: Buffer; truth: Truth[] } {
  const parts: Buffer[] = [Buffer.alloc(Math.round(0.6 * 16_000) * 2)];
  const truth: Truth[] = [];
  let at = 600;
  clips.forEach((id, idx) => {
    const speech = compress(readWav(path.join(FIXTURES, CLIPS[id]!.file)));
    truth.push({ idx, id, startMs: at, endMs: at + msOf(speech) });
    parts.push(speech, Buffer.alloc(Math.round((GAP_MS / 1000) * 16_000) * 2));
    at += msOf(speech) + GAP_MS;
  });
  parts.push(Buffer.alloc(Math.round(1.6 * 16_000) * 2));
  return { feed: Buffer.concat(parts), truth };
}

// ── scoring helpers ─────────────────────────────────────────────────────────────────────────────
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
const asJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return undefined; }
};

// ── prompts ─────────────────────────────────────────────────────────────────────────────────────
type Arm = 'E' | 'EN' | 'EA' | 'EO' | 'Ereq';
const STATUSES =
  '"carried" = its content is in your `message`; "merged" = it repeats or is absorbed by another item already in your `message`; ' +
  '"skipped" = drop it entirely (pure noise or filler). A number you leave out is forwarded to the session separately as raw recogniser text. ' +
  'Every item you mark "carried" must really be in your `message`.';
const CLAUSE: Record<Arm, string> = {
  E:
    'ROSTER: the user\'s speech not yet relayed is listed under ROSTER below, each entry a number, its time span in the conversation audio and ' +
    'the speech recogniser\'s rough transcript (it can be wrong; you hear the audio itself). When you call `session_send`, set `roster` to the ROSTER ' +
    'version shown (e.g. "v3"), and set `items` (JSON text, e.g. {"1":"carried","2":"merged"}) giving EVERY roster number exactly one status: ' + STATUSES,
  EN:
    'ROSTER: the user\'s speech not yet relayed is listed under ROSTER below, each entry a number and its time span in the conversation audio. ' +
    'When you call `session_send`, set `roster` to the ROSTER version shown (e.g. "v3"), and set `items` (JSON text, e.g. {"1":"carried","2":"merged"}) ' +
    'giving EVERY roster number exactly one status: ' + STATUSES,
  EA:
    'ROSTER: the user\'s speech not yet relayed is listed under ROSTER below, each entry a number, its time span in the conversation audio and ' +
    'the speech recogniser\'s rough transcript (it can be wrong; you hear the audio itself). When you call `session_send`, set `roster` to the ROSTER ' +
    'version shown (e.g. "v3"), set `items` (JSON text, e.g. {"1":"carried","2":"merged"}) giving EVERY roster number exactly one status: ' + STATUSES +
    ' Also set `anchors` (JSON text, e.g. {"1":"把server"}): for each item you mark "carried", its first few words exactly as they appear in your `message`.',
  EO:
    'Number the user\'s audio items that you have not yet relayed with `session_send`, oldest first: 1, 2, 3 … When you call `session_send`, set `items` ' +
    '(JSON text, e.g. {"1":"carried","2":"merged"}) giving EVERY such number exactly one status: ' + STATUSES,
};
CLAUSE.Ereq = CLAUSE.E;
const sendToolFor = (arm: Arm) => ({
  name: 'session_send',
  description: 'Send a message to the Claude Code session.',
  inputSchema:
    arm === 'Ereq'
      ? { message: z.string(), roster: z.string(), items: z.string() }
      : { message: z.string(), roster: z.string().optional(), items: z.string().optional(), anchors: z.string().optional() },
});

// ── the relay's ledger ──────────────────────────────────────────────────────────────────────────
type It = { id: string; seq: number | null; start: number | null; end: number | null; text: string; resolved: 'claimed' | 'skipped' | null; offered: boolean };
type RespState = { seenAcked: number; pending: number[]; committed: Set<number>; calls: Array<Record<string, unknown>> };
type Applied = { message: string; claimed: number[]; skipped: number[]; anchorFail: number[]; valid: boolean; raw?: Record<string, unknown>; seenAcked?: number };

const runOne = async (run: ReturnType<typeof createRun>, spanId: string, clipIds: string[], arm: Arm, rep: number) => {
  const { feed, truth } = buildFeed(clipIds);
  const items = new Map<string, It>();
  const bySeq = new Map<number, It>();
  let seqCounter = 0;
  const touch = (id: string): It => {
    if (!items.has(id)) items.set(id, { id, seq: null, start: null, end: null, text: '', resolved: null, offered: false });
    return items.get(id)!;
  };
  const pending = (): It[] => [...bySeq.values()].filter((x) => x.resolved === null).sort((a, b) => a.seq! - b.seq!);

  const base = `${VOICE_REALTIME_INSTRUCTIONS} ${CLAUSE[arm]}`;
  let session: P0Session | null = null;
  let version = 0;
  const sentVersions: number[] = [0];
  let ackIdx = -1;
  let ackedVersion = -1;
  const resp = new Map<string, RespState>();
  const applied: Applied[] = [];
  const diag = { cancelled: 0, completedNoCall: 0, invalid: 0, outOfRange: 0, doubleClaim: 0, stale: 0, noEcho: 0, anchorMissing: 0, updates: 0 };
  const sec = (ms: number | null): string => (ms === null ? '?' : (ms / 1000).toFixed(1));

  const pushRoster = (): void => {
    if (arm === 'EO' || session === null) return;
    const pend = pending();
    version += 1;
    sentVersions.push(version);
    diag.updates += 1;
    const lines = pend.map((x) => `[${x.seq}] ${sec(x.start)}–${sec(x.end)}s${arm !== 'EN' && x.text ? `  "${x.text}"` : ''}`);
    session.setInstructions(`${base}\n\nROSTER v${version}\n${lines.length ? lines.join('\n') : '(none)'}`);
  };

  const apply = (rs: RespState, call: Record<string, unknown>): void => {
    const message = String(call.message ?? '');
    const statuses = asJson(call.items);
    if (statuses === undefined || statuses === null || typeof statuses !== 'object' || Array.isArray(statuses)) {
      diag.invalid += 1;
      applied.push({ message, claimed: [], skipped: [], anchorFail: [], valid: false, raw: call, seenAcked: rs.seenAcked });
      return;
    }
    if (arm !== 'EO') {
      const m = /(\d+)/.exec(String(call.roster ?? ''));
      if (!m) diag.noEcho += 1;
      else if (Number(m[1]) < rs.seenAcked) diag.stale += 1;
    }
    const anchors = (asJson(call.anchors) ?? {}) as Record<string, string>;
    const claimed: number[] = [];
    const skipped: number[] = [];
    const anchorFail: number[] = [];
    for (const [k, v] of Object.entries(statuses as Record<string, unknown>)) {
      const seq = arm === 'EO' ? rs.pending[Number(k) - 1] : Number(k);
      if (seq === undefined || !rs.committed.has(seq)) { diag.outOfRange += 1; continue; }
      const it = bySeq.get(seq)!;
      if (it.resolved !== null) { diag.doubleClaim += 1; continue; }
      const status = String(v);
      if (status === 'carried' || status === 'merged') {
        it.resolved = 'claimed';
        claimed.push(seq);
        if (arm === 'EA' && status === 'carried') {
          const a = anchors[k];
          if (typeof a !== 'string' || a === '') diag.anchorMissing += 1;
          else if (!norm(message).includes(norm(a))) anchorFail.push(seq);
        }
      } else if (status === 'skipped') {
        it.resolved = 'skipped';
        skipped.push(seq);
      }
    }
    applied.push({ message, claimed, skipped, anchorFail, valid: true, raw: call, seenAcked: rs.seenAcked });
  };

  const onEvent = (event: ProbeEvent): void => {
    if (event.direction !== 'received') return;
    const w = event.wire as Record<string, unknown>;
    const t = String(w.type ?? '');
    const id = typeof w.item_id === 'string' ? w.item_id : '';
    if (t === 'input_audio_buffer.speech_started' && id) touch(id).start = Number(w.audio_start_ms);
    else if (t === 'input_audio_buffer.speech_stopped' && id) touch(id).end = Number(w.audio_end_ms);
    else if (t === 'input_audio_buffer.committed' && id) {
      const it = touch(id);
      if (it.seq === null) { seqCounter += 1; it.seq = seqCounter; bySeq.set(it.seq, it); }
      if (arm === 'EN') pushRoster();
    } else if (t === 'conversation.item.input_audio_transcription.completed' && id) {
      touch(id).text = String(w.transcript ?? '').trim();
      if (arm === 'E' || arm === 'EA' || arm === 'Ereq') pushRoster();
    } else if (t === 'session.updated') {
      ackIdx += 1;
      ackedVersion = sentVersions[ackIdx] ?? ackedVersion;
    } else if (t === 'response.created') {
      const rid = String((w.response as Record<string, unknown> | undefined)?.id ?? '');
      resp.set(rid, { seenAcked: ackedVersion, pending: pending().map((x) => x.seq!), committed: new Set(bySeq.keys()), calls: [] });
    } else if (t === 'response.function_call_arguments.done' && w.name === 'session_send') {
      const rs = resp.get(String(w.response_id ?? ''));
      if (!rs) return;
      try { rs.calls.push(JSON.parse(String(w.arguments ?? '{}')) as Record<string, unknown>); } catch { rs.calls.push({ _raw: String(w.arguments) }); }
    } else if (t === 'response.done') {
      const r = (w.response ?? {}) as Record<string, unknown>;
      const rs = resp.get(String(r.id ?? ''));
      if (!rs) return;
      if (r.status === 'completed' && rs.calls.length > 0) {
        const dedup = new Map<string, Record<string, unknown>>();
        for (const c of rs.calls) dedup.set(JSON.stringify(c), c);
        for (const seq of rs.committed) bySeq.get(seq)!.offered = true;
        for (const c of dedup.values()) apply(rs, c);
        pushRoster();
      } else if (r.status === 'cancelled') diag.cancelled += 1;
      else diag.completedNoCall += 1;
    }
  };

  session = await openSession({
    run,
    label: `${spanId}-${arm}-${rep}`,
    instructions: base,
    sessionDefaults: sessionBody({ turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 } }),
    tools: [sendToolFor(arm), ...VOICE_REALTIME_TOOLS.filter((x) => x.name === 'session_interrupt')] as never,
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
  await sleep(DRAIN_MS);
  const spend = session.spendCny;
  await session.close().catch(() => undefined);

  // ── grading against known text ──
  const ordered = [...bySeq.values()].sort((a, b) => a.seq! - b.seq!);
  const overlapOf = (x: It, c: Truth): number => Math.max(0, Math.min(x.end ?? 0, c.endMs) - Math.max(x.start ?? 0, c.startMs));
  const clipOf = (x: It): { clip: Truth | null; mixed: boolean } => {
    const ovs = truth.map((c) => ({ c, ov: overlapOf(x, c) })).sort((a, b) => b.ov - a.ov);
    const dur = Math.max(1, (x.end ?? 0) - (x.start ?? 0));
    return { clip: ovs[0] && ovs[0].ov > 0 ? ovs[0].c : null, mixed: !!ovs[1] && ovs[1].ov / dur >= 0.25 };
  };
  const failSeqs = new Set(applied.flatMap((a) => a.anchorFail));
  const out = { clips: 0, ok: 0, lost: 0, dup: 0, lostCheck: 0, dupCheck: 0, falseClaim: 0, underClaim: 0, lostBySkip: 0, anchorTrueCatch: 0, anchorFalseAlarm: 0, flagged: 0, neverOffered: 0 };
  const perClip: Array<Record<string, unknown>> = [];
  for (const c of truth) {
    const its = ordered.filter((x) => clipOf(x).clip?.idx === c.idx);
    if (its.length !== 1 || clipOf(its[0]!).mixed) { out.flagged += 1; perClip.push({ clip: c.id, flagged: true, items: its.length }); continue; }
    const it = its[0]!;
    out.clips += 1;
    const inMsgs = applied.filter((a) => present(c.id, a.message)).length;
    const filled = it.resolved === null;
    const filledCheck = filled || failSeqs.has(it.seq!);
    const deliveries = inMsgs + (filled ? 1 : 0);
    const deliveriesCheck = inMsgs + (filledCheck ? 1 : 0);
    if (deliveries === 0) out.lost += 1; else if (deliveries === 1) out.ok += 1; else out.dup += 1;
    if (deliveriesCheck === 0) out.lostCheck += 1; else if (deliveriesCheck >= 2) out.dupCheck += 1;
    if (!it.offered) out.neverOffered += 1;
    if (filled && inMsgs >= 1) out.underClaim += 1;
    if (it.resolved === 'skipped' && inMsgs === 0) out.lostBySkip += 1;
    for (const a of applied) {
      if (a.claimed.includes(it.seq!) && !present(c.id, a.message)) out.falseClaim += 1;
      if (a.anchorFail.includes(it.seq!)) { if (present(c.id, a.message)) out.anchorFalseAlarm += 1; else out.anchorTrueCatch += 1; }
    }
    perClip.push({ clip: c.id, seq: it.seq, offered: it.offered, resolved: it.resolved, inMsgs, deliveries });
  }
  return { span: spanId, arm, rep, spendCny: spend, ...out, diag, perClip, applied, roster: ordered.map((x) => ({ seq: x.seq, start: x.start, end: x.end, text: x.text })) };
};

const main = async (): Promise<void> => {
  const arms = arg('arms', 'E,EN,EA,EO').split(',') as Arm[];
  const reps = Number(arg('reps', '2'));
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} · arms ${arms.join(',')} · reps ${reps} · gap ${GAP_MS}ms · endpoint-triggered responses · uplink gate OFF`);
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
