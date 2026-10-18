/**
 * B vs Q, end to end, on known text.
 *
 *   B  the status quo as the relay runs it today: the ENDPOINT starts the responses; a model `session_send` consumes
 *      the whole span of transcribed items; a 2.5 s settle timer delivers the recogniser text of a span nobody
 *      answered (re-armed while the endpoint's turn is open, re-counted from the turn's close).
 *   Q  the proposed design: responses are started by the RELAY (create_response:false), only when the endpoint has
 *      committed all the speech the LOCAL silero VAD has heard and the local VAD is quiet; a ROSTER of pending items
 *      is written into the instructions first; the call must carry a per-item claim; an item that was offered to a
 *      completed response and not claimed is filled at once; a 5 s deadline fills what could not be asked.
 *
 * Grading is against KNOWN text, per clip: how many times did its content reach the session (0 lost, 1 right,
 * 2+ duplicated), when did the first delivery land, and what each step produced (kept in the trace as a timeline).
 *
 *   set -a; . ./.env.test; set +a
 *   npx tsx --tsconfig=server/tsconfig.json experiments/voice-relay-qb/run.mts --patterns P1,P2 --arms B,Q --reps 2
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { createRun, openSession, readApiKey, sleep, sessionBody, type P0Session, type ProbeEvent } from '../voice-realtime-segmented/p0/probe-lib.mts';
import { voiceRealtimeInstructionsFor, VOICE_REALTIME_TOOLS } from '../../server/modules/voice-realtime/index.js';
import { createUplinkVadClassifier } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FIXTURES = path.join(REPO, 'experiments/voice-provider-paired-quality/fixtures');
const WEIGHTS = '/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx';
const BUDGET_CNY = Number(process.env.QB_BUDGET_CNY ?? 0.15);
const CONCURRENCY = Number(process.env.QB_CONCURRENCY ?? 4);
const DRAIN_MS = 11_000;
// B
const SETTLE_MS = 2_500;
// Q
const QLOC_BY_ARM: Record<string, number> = { Q: 240, Q12: 1_200, Q12N: 1_200 }; // the local VAD must have been quiet this long before an ask
const UNCOMMITTED_SLACK_MS = 500; // local speech beyond the last committed item's end by more than this = speech not yet committed
const ASR_WAIT_MS = 600;
const UPDATE_WAIT_MS = 1_500;
const ASK_WATCHDOG_MS = 3_000; // an ask that gets no response.created in this long is treated as swallowed
const DEADLINE_MS = 8_000; // raw recogniser text is delivered for what still could not be asked (> cap + response latency)

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
type Pattern = { id: string; clips: string[]; gaps: number[] };
const PATTERNS: Pattern[] = [
  { id: 'P1', clips: ['d01', 'd03', 'd04', 'd08'], gaps: [900, 1500, 1100] },
  { id: 'P2', clips: ['d04', 'd08', 'd01', 'd03'], gaps: [1100, 900, 3000] },
  { id: 'P3', clips: ['d03', 'd01', 'd08', 'd04'], gaps: [1500, 3000, 900] },
  { id: 'P4', clips: ['d08', 'd04', 'd03', 'd01'], gaps: [900, 900, 1500] },
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
const rmsOf = (f: Buffer): number => { let s = 0; for (let i = 0; i < 320; i += 1) { const v = f.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / 320); };
const compress = (pcm: Buffer): Buffer => {
  const out: Buffer[] = [];
  let gap = 0;
  let started = false;
  for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
    const f = pcm.subarray(i, i + FRAME_BYTES);
    if (rmsOf(f) >= 300) { out.push(f); started = true; gap = 0; } else if (started && gap < 10) { out.push(f); gap += 1; }
  }
  return Buffer.concat(out);
};
const msOf = (b: Buffer): number => Math.round((b.length / 2 / 16_000) * 1000);
const silence = (ms: number): Buffer => Buffer.alloc(Math.round((ms / 1000) * 16_000) * 2);

type Truth = { idx: number; id: string; startMs: number; endMs: number };
function buildFeed(p: Pattern): { feed: Buffer; truth: Truth[] } {
  const parts: Buffer[] = [silence(600)];
  const truth: Truth[] = [];
  let at = 600;
  p.clips.forEach((id, idx) => {
    const speech = compress(readWav(path.join(FIXTURES, CLIPS[id]!.file)));
    truth.push({ idx, id, startMs: at, endMs: at + msOf(speech) });
    parts.push(speech);
    at += msOf(speech);
    if (idx < p.clips.length - 1) { parts.push(silence(p.gaps[idx]!)); at += p.gaps[idx]!; }
  });
  parts.push(silence(1_800));
  return { feed: Buffer.concat(parts), truth };
}

// The local VAD is computed BEFORE any session starts and read back at the time its verdict would exist (2 frames after
// the frame): running silero inside a live session slowed that process's socket writes and made the endpoint's events lag.
const vadCache = new Map<string, boolean[]>();
async function localFlags(p: Pattern): Promise<boolean[]> {
  if (vadCache.has(p.id)) return vadCache.get(p.id)!;
  const { feed } = buildFeed(p);
  const clf = await createUplinkVadClassifier({ backend: 'silero', weightsPath: WEIGHTS });
  const n = Math.floor(feed.length / FRAME_BYTES);
  const flags: boolean[] = new Array(n).fill(false);
  const take = (v: { frameIndex: number; speech: boolean; bypassed: boolean } | null): void => { if (v && v.frameIndex < n) flags[v.frameIndex] = v.bypassed ? true : v.speech; };
  for (let i = 0; i < n; i += 1) take(await clf.classify(feed.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)));
  for (const v of await clf.flush()) take(v);
  await clf.close();
  vadCache.set(p.id, flags);
  return flags;
}

// ── known-text grading helpers ──────────────────────────────────────────────────────────────────
const norm = (s: string): string => s.toLowerCase().replace(/[\s，。！？、,.!?"“”'’：:；;（）()\-]/g, '');
const grams = (s: string): Set<string> => { const c = s.replace(/\s/g, ''); const o = new Set<string>(); for (let i = 0; i + 4 <= c.length; i += 1) o.add(c.slice(i, i + 4)); return o; };
const present = (clipId: string, text: string): boolean => {
  const c = CLIPS[clipId]!;
  if (norm(text).includes(norm(c.anchor))) return true;
  const a = grams(norm(c.reference));
  const b = grams(norm(text));
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return a.size > 0 && hit / a.size >= 0.5;
};
const asJson = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return undefined; } };

// ── prompts / tools ─────────────────────────────────────────────────────────────────────────────
const BASE = voiceRealtimeInstructionsFor('silent');
const Q_CLAUSE =
  'ROSTER: the user\'s speech not yet relayed is listed under ROSTER below, each entry a number, its time span in the conversation audio and ' +
  'the speech recogniser\'s rough transcript (it can be wrong; you hear the audio itself). Call `session_send` ONCE with a `message` that carries ' +
  'all of it, in the user\'s own words, joining the fragments of one sentence. Also set `roster` to the ROSTER version shown (e.g. "v3") and set ' +
  '`items` (JSON text, e.g. {"1":"carried","2":"merged:1"}) giving EVERY roster number exactly one status: "carried" = its content is in your ' +
  '`message`; "merged:N" = it repeats or is absorbed by item N, which you mark "carried". A number you leave out is forwarded to the session ' +
  'separately as raw recogniser text, which is often garbled, so list every number. Every item you mark "carried" must really be in your `message`. Items listed under ALREADY FORWARDED have been delivered already: do not repeat them.';
const sendToolB = { name: 'session_send', description: 'Send a message to the Claude Code session.', inputSchema: { message: z.string() } };
const sendToolQ = { name: 'session_send', description: 'Send a message to the Claude Code session.', inputSchema: { message: z.string(), roster: z.string(), items: z.string() } };
const interruptTool = VOICE_REALTIME_TOOLS.filter((x) => x.name === 'session_interrupt');

// ── one session ─────────────────────────────────────────────────────────────────────────────────
type It = { id: string; seq: number | null; start: number | null; end: number | null; text: string; commitAt: number; resolved: null | 'model' | 'claimed' | 'filled' };
type Piece = { t: number; kind: 'model' | 'fill'; text: string; seqs: number[]; claimed?: number[]; reason?: string };

type Arm = 'B' | 'BN' | 'Q' | 'Q12' | 'Q12N';
const runOne = async (run: ReturnType<typeof createRun>, pat: Pattern, arm: Arm, rep: number) => {
  const isQ = arm !== 'B' && arm !== 'BN';
  const isB = !isQ;
  const qloc = QLOC_BY_ARM[arm] ?? 240;
  const { feed, truth } = buildFeed(pat);
  const items = new Map<string, It>();
  const bySeq = new Map<number, It>();
  let seqC = 0;
  const log: Array<Record<string, unknown>> = [];
  const pieces: Piece[] = [];
  let t0 = Date.now();
  const nowMs = (): number => Date.now() - t0;
  const L = (kind: string, d: Record<string, unknown> = {}): void => { log.push({ t: nowMs(), kind, ...d }); };
  const touch = (id: string): It => { if (!items.has(id)) items.set(id, { id, seq: null, start: null, end: null, text: '', commitAt: 0, resolved: null }); return items.get(id)!; };
  const diag = { claimVoided: 0, textReplyFills: 0, asks: 0, askDropped: 0, askAborted: 0, cancelled: 0, completedNoCall: 0, claimInvalid: 0, claimOutOfRange: 0, calls: 0, filledOffered: 0, filledDeadline: 0, filledEnd: 0, settleFires: 0, settleRearms: 0, updates: 0 };

  let upstreamTalking = false;
  let respCreated = 0;
  let callSeenInResp = false;

  // ---- fills (shared) ----
  const fill = (seqs: number[], reason: string): void => {
    const its = seqs.map((s) => bySeq.get(s)!).filter((x) => x && x.resolved === null);
    if (its.length === 0) return;
    for (const it of its) it.resolved = 'filled';
    const text = its.map((x) => x.text).filter((x) => x !== '').join(' ');
    pieces.push({ t: nowMs(), kind: 'fill', text, seqs: its.map((x) => x.seq!), reason });
    L('fill', { reason, seqs: its.map((x) => x.seq), text });
  };

  // ---- B: settle ----
  let span: number[] = [];
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const coveredByResponse = new Set<number>();
  const armSettle = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (span.length === 0) return;
      if (upstreamTalking) { diag.settleRearms += 1; L('settle-rearm', { why: 'endpoint turn open' }); armSettle(); return; }
      diag.settleFires += 1;
      const s = span; span = [];
      fill(s, 'settle');
    }, SETTLE_MS);
  };
  const onFinalB = (it: It): void => {
    if (coveredByResponse.has(it.seq!)) { it.resolved = 'model'; L('asr-consumed-by-earlier-response', { seq: it.seq }); return; }
    if (it.text === '') return;
    span.push(it.seq!);
    armSettle();
  };

  // ---- Q: local VAD, roster, ask ----
  let lastLocalSpeechEnd = 0;
  let localSpeaking = false;
  let version = 0;
  let updatedCount = 0;
  let askBusy = false;
  let inFlight = false;
  let inFlightSince = 0;
  let currentAsk: { version: number; offered: number[]; carried: Set<number>; local: number[]; stale: boolean } | null = null;
  let askAt = 0;
  let respSeenForAsk = false;
  const pending = (): It[] => [...bySeq.values()].filter((x) => x.resolved === null).sort((a, b) => a.seq! - b.seq!);
  const latestCommittedEnd = (): number => Math.max(0, ...[...bySeq.values()].map((x) => x.end ?? 0));
  const guardOK = (): { ok: boolean; why: string } => {
    refreshLocal();
    const pend = pending();
    if (pend.length === 0) return { ok: false, why: 'nothing pending' };
    const now = nowMs();
    if (now - lastLocalSpeechEnd < qloc || localSpeaking) return { ok: false, why: 'local VAD hears speech' };
    if (lastLocalSpeechEnd > latestCommittedEnd() + UNCOMMITTED_SLACK_MS) return { ok: false, why: 'speech heard locally not yet committed' };
    return { ok: true, why: 'quiet and committed' };
  };
  const flags = isQ ? await localFlags(pat) : null;
  let lp = 0;
  const refreshLocal = (): void => {
    if (!flags) return;
    const visible = Math.min(flags.length, Math.floor(nowMs() / 20) - 1);
    while (lp < visible) {
      if (flags[lp]) {
        lastLocalSpeechEnd = Math.max(lastLocalSpeechEnd, (lp + 1) * 20);
        if (!localSpeaking) { localSpeaking = true; L('local-vad-speech', { fromMs: lp * 20 }); }
      }
      lp += 1;
    }
    if (localSpeaking && nowMs() - lastLocalSpeechEnd > Math.min(qloc, 240)) { localSpeaking = false; L('local-vad-quiet', { lastSpeechEnd: lastLocalSpeechEnd }); }
  };
  let session: P0Session | null = null;
  const maybeAsk = async (): Promise<void> => {
    if (!isQ || askBusy || inFlight || session === null) return;
    if (!guardOK().ok) return;
    askBusy = true;
    try {
      const first = pending();
      await session.waitFor(() => first.every((x) => x.text !== ''), ASR_WAIT_MS);
      const snap = pending().map((x) => x.seq!);
      if (snap.length === 0) return;
      version += 1;
      const lines = pending().map((x, i) => `[${i + 1}] ${((x.start ?? 0) / 1000).toFixed(1)}–${((x.end ?? 0) / 1000).toFixed(1)}s  "${x.text || '(transcribing)'}"`);
      const forwarded = [...bySeq.values()].filter((x) => x.resolved === 'filled' && x.text !== '').sort((a, b) => a.seq! - b.seq!).slice(-6)
        .map((x, i) => `[F${i + 1}] "${x.text}"`);
      const rosterText = `ROSTER v${version}\n${lines.join('\n')}` +
        (forwarded.length ? `\n\nALREADY FORWARDED to the session as raw recogniser text (do not repeat their content in your \`message\`, and do not list them in \`items\`):\n${forwarded.join('\n')}` : '');
      const before = updatedCount;
      diag.updates += 1;
      L('roster-sent', { version, seqs: snap, text: rosterText });
      session.setInstructions(`${BASE} ${Q_CLAUSE}\n\n${rosterText}`);
      const acked = await session.waitFor(() => updatedCount > before, UPDATE_WAIT_MS);
      const now = pending().map((x) => x.seq!);
      const g = guardOK();
      if (!acked) L('roster-ack-timeout', { version });
      if (now.join() !== snap.join() || !g.ok) { diag.askAborted += 1; L('ask-aborted', { why: now.join() !== snap.join() ? 'pending set changed during roster update' : g.why }); return; }
      currentAsk = { version, offered: snap, carried: new Set(), local: snap, stale: false };
      askAt = nowMs();
      respSeenForAsk = false;
      inFlight = true;
      inFlightSince = nowMs();
      diag.asks += 1;
      L('ask', { version, offered: snap, guard: g.why });
      session.sendRaw({ type: 'response.create' });
    } finally {
      askBusy = false;
    }
  };

  const applyCallQ = (args: Record<string, unknown>): void => {
    diag.calls += 1;
    const message = String(args.message ?? '');
    const claims = asJson(args.items);
    const carried: number[] = [];
    callSeenInResp = true;
    if (currentAsk?.stale) { diag.claimVoided += 1; L('claim-voided', { why: 'items were committed after the roster and before the response existed' }); }
    else if (currentAsk && claims && typeof claims === 'object' && !Array.isArray(claims)) {
      const entries = Object.entries(claims as Record<string, unknown>);
      for (const [k, v] of entries) if (String(v) === 'carried') { const sq = currentAsk.local[Number(k) - 1]; if (sq !== undefined) currentAsk.carried.add(sq); }
      for (const [k, v] of entries) {
        const seq = currentAsk.local[Number(k) - 1] as number;
        const it = bySeq.get(seq);
        if (!it || !currentAsk.offered.includes(seq)) { diag.claimOutOfRange += 1; continue; }
        const s = String(v);
        const m = /^merged:(\d+)$/.exec(s);
        const ok = s === 'carried' || (m !== null && currentAsk.carried.has(currentAsk.local[Number(m[1]) - 1] as number));
        if (ok && it.resolved === null) { it.resolved = 'claimed'; carried.push(seq); }
      }
    } else diag.claimInvalid += 1;
    pieces.push({ t: nowMs(), kind: 'model', text: message, seqs: [], claimed: carried });
    L('call', { message, roster: args.roster, items: args.items, claimed: carried, offeredSeqs: currentAsk?.local });
  };

  const onDoneQ = (status: string): void => {
    inFlight = false;
    if (!currentAsk) return;
    if (status === 'completed') {
      const unresolved = currentAsk.offered.filter((s) => bySeq.get(s)!.resolved === null);
      if (unresolved.length) { diag.filledOffered += unresolved.length; fill(unresolved, 'offered-not-claimed'); }
    } else { diag.cancelled += 1; L('ask-cancelled'); }
    currentAsk = null;
    void maybeAsk();
  };

  const onEvent = (ev: ProbeEvent): void => {
    if (ev.direction !== 'received') return;
    const w = ev.wire as Record<string, unknown>;
    const t = String(w.type ?? '');
    const id = typeof w.item_id === 'string' ? w.item_id : '';
    if (t === 'input_audio_buffer.speech_started' && id) {
      touch(id).start = Number(w.audio_start_ms); upstreamTalking = true; L('endpoint-speech-started', { at: touch(id).start });
    } else if (t === 'input_audio_buffer.speech_stopped' && id) {
      touch(id).end = Number(w.audio_end_ms); upstreamTalking = false; L('endpoint-speech-stopped', { at: touch(id).end });
      if (isB && (settleTimer !== null || span.length > 0)) armSettle();
    } else if (t === 'input_audio_buffer.committed' && id) {
      const it = touch(id);
      if (it.seq === null) { seqC += 1; it.seq = seqC; it.commitAt = nowMs(); bySeq.set(it.seq, it); }
      upstreamTalking = false;
      L('commit', { seq: it.seq, span: [it.start, it.end] });
      if (isB && it.text !== '') onFinalB(it);
      if (isQ) void maybeAsk();
    } else if (t === 'conversation.item.input_audio_transcription.completed' && id) {
      const it = touch(id);
      it.text = String(w.transcript ?? '').trim();
      L('asr', { seq: it.seq, text: it.text });
      if (it.seq !== null) { if (arm === 'B') onFinalB(it); else void maybeAsk(); }
    } else if (t === 'session.updated') {
      updatedCount += 1;
    } else if (t === 'response.created') {
      respCreated += 1; respSeenForAsk = true; L('response.created');
      callSeenInResp = false;
      if (currentAsk) {
        const newer = [...bySeq.values()].filter((x) => !currentAsk!.offered.includes(x.seq!) && x.commitAt >= askAt);
        if (newer.length) { currentAsk.stale = true; L('roster-stale-at-response', { newerThanRoster: newer.map((x) => x.seq) }); }
      }
    } else if (t === 'response.done') {
      const resp = (w.response ?? {}) as Record<string, unknown>;
      const status = String(resp.status ?? '?');
      const outputs = (Array.isArray(resp.output) ? resp.output : []).map((o: any) => {
        if (o?.type === 'function_call') return { fn: o.name, args: String(o.arguments ?? '').slice(0, 400) };
        const text = (Array.isArray(o?.content) ? o.content : []).map((c: any) => c?.text ?? c?.transcript ?? '').join('');
        return { type: o?.type, text: String(text).slice(0, 300) };
      });
      L('response.done', { status, outputs, statusDetails: resp.status_details ?? undefined });
      if (isQ) onDoneQ(status);
      else if (status === 'completed' && !callSeenInResp && span.length > 0) {
        // production (MODEL_TEXT_REPLY): the model ended a turn in text with heard items unanswered → they go verbatim
        diag.textReplyFills += span.length;
        const sp = span; span = [];
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        for (const it of bySeq.values()) if (it.text === '' && it.resolved === null) coveredByResponse.add(it.seq!);
        fill(sp, 'model-text-reply');
      }
    }
  };

  const executor = {
    session_send: (args: Record<string, unknown>) => {
      if (isB) {
        // production: the call consumes the span, cancels the settle timer and claims committed-but-untranscribed items
        callSeenInResp = true;
        pieces.push({ t: nowMs(), kind: 'model', text: String(args.message ?? ''), seqs: [...span] });
        L('call', { message: String(args.message ?? ''), consumedSpan: [...span] });
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        for (const s of span) { const it = bySeq.get(s); if (it && it.resolved === null) it.resolved = 'model'; }
        span = [];
        for (const it of bySeq.values()) if (it.text === '' && it.resolved === null) coveredByResponse.add(it.seq!);
      } else applyCallQ(args);
      return { accepted: true };
    },
    session_interrupt: () => ({ aborted: true, runId: 'replay-run', triggerSeq: null, queuedStillPending: 0 }),
  };

  session = await openSession({
    run,
    label: `${pat.id}-${arm}-${rep}`,
    instructions: isB ? BASE : `${BASE} ${Q_CLAUSE}`,
    sessionDefaults: sessionBody({
      turn_detection: isB && !process.env.QB_B_NOCREATE
        ? { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800, ...(arm === 'BN' ? { interrupt_response: false } : {}) }
        : { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800, create_response: false, ...(arm === 'Q12N' ? { interrupt_response: false } : {}) },
    }),
    tools: [isB ? sendToolB : sendToolQ, ...interruptTool] as never,
    respondToToolOutputs: false,
    executor: executor as never,
    onEvent,
  });

  t0 = Date.now();
  const frames = Math.floor(feed.length / FRAME_BYTES);
  const lateness: number[] = [];
  const ticker = setInterval(() => {
    if (!isQ) return;
    refreshLocal();
    if (inFlight && !respSeenForAsk && nowMs() - askAt > ASK_WATCHDOG_MS) { inFlight = false; currentAsk = null; diag.askDropped += 1; L('ask-dropped', { why: `no response.created within ${ASK_WATCHDOG_MS} ms (the endpoint swallowed it)` }); }
    if (inFlight && nowMs() - inFlightSince > 12_000) { inFlight = false; L('inflight-timeout'); }
    const dead = pending().filter((x) => nowMs() - x.commitAt > DEADLINE_MS);
    if (dead.length && !inFlight && !askBusy) { diag.filledDeadline += dead.length; fill(dead.map((x) => x.seq!), 'deadline'); }
    void maybeAsk();
  }, 50);
  for (let i = 0; i < frames; i += 1) {
    const frame = feed.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
    session.sendAudioBase64(frame.toString('base64'));
    const wait = t0 + (i + 1) * 20 - Date.now();
    if (wait > 0) await sleep(wait); else lateness.push(-wait);
  }
  const drainUntil = Date.now() + DRAIN_MS;
  while (Date.now() < drainUntil) {
    await sleep(50);
  }
  clearInterval(ticker);
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  const leftover = [...bySeq.values()].filter((x) => x.resolved === null && x.text !== '').map((x) => x.seq!);
  if (leftover.length) { diag.filledEnd += leftover.length; fill(leftover, 'end-of-run'); }
  const spend = session.spendCny;
  const respN = respCreated;
  await session.close().catch(() => undefined);

  // ── grading against the known text ──
  const ordered = [...bySeq.values()].sort((a, b) => a.seq! - b.seq!);
  const perClip = truth.map((c) => {
    const dur = Math.max(1, c.endMs - c.startMs);
    const its = ordered.filter((x) => Math.max(0, Math.min(x.end ?? 0, c.endMs) - Math.max(x.start ?? 0, c.startMs)) / dur >= 0.3);
    const itsSeqs = new Set(its.map((x) => x.seq!));
    const deliveries = pieces
      .filter((p) => (p.kind === 'model' ? present(c.id, p.text) : p.seqs.some((s) => itsSeqs.has(s))))
      .map((p) => ({ t: p.t, kind: p.kind }));
    const firstAt = deliveries.length ? Math.min(...deliveries.map((d) => d.t)) : null;
    const fillAsr = its.map((x) => x.text).join(' ');
    return {
      clip: c.id, itemSeqs: [...itsSeqs], deliveries: deliveries.length, kinds: deliveries.map((d) => d.kind),
      latencyMs: firstAt === null ? null : firstAt - c.endMs, endMs: c.endMs, asr: fillAsr, asrOk: fillAsr ? present(c.id, fillAsr) : false,
    };
  });
  const late = [...lateness].sort((a, b) => a - b);
  const drift = { lateFrames: late.length, of: frames, maxMs: late.length ? late[late.length - 1] : 0, p90Ms: late.length ? late[Math.floor(late.length * 0.9)] : 0 };
  return { pattern: pat.id, arm, rep, spendCny: spend, responses: respN, drift, diag, perClip, pieces, log, items: ordered.map((x) => ({ seq: x.seq, start: x.start, end: x.end, text: x.text, resolved: x.resolved })) };
};

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  const pats = arg('patterns', 'P1,P2').split(',').filter(Boolean);
  const arms = arg('arms', 'B,Q,Q12,Q12N').split(',').filter(Boolean) as Arm[];
  const reps = Number(arg('reps', '2'));
  if (arms.some((a) => a !== 'B')) for (const pid of pats) await localFlags(PATTERNS.find((x) => x.id === pid)!);
  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} · patterns ${pats} · arms ${arms} · reps ${reps} · endpoint VAD 800ms · uplink gate OFF`);
  const jobs: Array<() => Promise<Record<string, unknown>>> = [];
  for (const pid of pats) for (const arm of arms) for (let r = 0; r < reps; r += 1) jobs.push(() => runOne(run, PATTERNS.find((x) => x.id === pid)!, arm, r));
  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const settled = await Promise.allSettled(jobs.slice(i, i + CONCURRENCY).map((f) => f()));
    results.push(...settled.map((s) => (s.status === 'fulfilled' ? s.value : { error: String((s as PromiseRejectedResult).reason?.stack ?? (s as PromiseRejectedResult).reason) })));
    console.log(`progress ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length} · spend ¥${run.spendCny.toFixed(4)}`);
  }
  mkdirSync(path.join(HERE, 'traces'), { recursive: true });
  const file = path.join(HERE, 'traces', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify({ ranAt: new Date().toISOString(), spendCny: Number(run.spendCny.toFixed(6)), guardTriggered: run.guardTriggered, results }, null, 2)}\n`);
  for (const r of results) if ('error' in r) console.log('ERROR', String(r.error).slice(0, 400));
  console.log(`spend ¥${run.spendCny.toFixed(6)} of ¥${BUDGET_CNY} · guard=${run.guardTriggered}\ntrace: ${file}`);
  process.exit(0);
};
void main();
