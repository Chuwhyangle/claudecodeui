/**
 * ⑤'s validation: keep the WORDS, drop the AUDIO, and prune the history — does the relay survive it?
 *
 * WHERE THIS SITS. The 2026-10-15 bill reconciliation (`~/.cloudcli/voice-realtime-log/*.jsonl`
 * against four DashScope rows) priced the four billed connections at ¥0.3217 and split it as:
 * prefix re-read 45%, audio context re-read 30%, history growth 22%, output 2%. ⑤ is the arm that
 * attacks the last two without touching the turn structure — the turn structure (the closing turn
 * after every tool result) was already tried and reverted once (server/index.ts:701), so the only
 * cheap ground left is "the context does not have to keep growing".
 *
 * WHAT IS ALREADY SETTLED, and therefore NOT re-measured here.
 *   - `conversation.item.delete` exists and is EFFECTIVE. P0's S5 (2026-10-10, ¥0.001929) deleted a
 *     long TEXT item and watched `input_tokens` fall 643 → 481. Note that
 *     `voice-realtime-dashscope-transport.ts` (the `TOOL_OUTPUT_MAX_CHARS` header) still claims
 *     "no `conversation.item.delete`/`truncate` exists on this wire" — that comment is contradicted
 *     by the recorded S5 trace and should be treated as stale.
 *   - There is NO prompt caching to exploit: P0's S6 measured `cacheFieldPresent=false`,
 *     `discountObserved=false`. The prefix really is re-billed at full price every response.
 *
 * WHAT S5 DID NOT COVER, and what this probe exists to answer.
 *   1. PREFIX SLOPE. ⑤'s projection rests on an empirical ~0.5 tokens per instruction character,
 *      read off two cross-connection differentials in the production journals (2341→2695 chars gave
 *      0.497; 2695→3960 gave 0.493). Two pairs is thin. Three text-only sessions with a controlled
 *      instructions length turn that into a direct measurement.
 *   2. AUDIO. S5 deleted a text item. The 30% audio term is only prunable if an audio-bearing
 *      conversation item can be dropped — and only SAFELY prunable if the transcript survives it.
 *      The audio arm injects a known duration of PCM, reads the item the endpoint creates from it
 *      (shape included, so we learn whether audio and transcript share one item or two), deletes it,
 *      and compares the audio token count before and after.
 *   3. BEHAVIOUR. ① died not on cost but on forwarding: with the post-tool closing turn removed, the
 *      model answered "No response requested." in text instead of calling `session_send`, and 3 of 5
 *      utterances were heard, transcribed, and never relayed. A pruned history is the same class of
 *      intervention, so it needs the same reading: utterances that produced a `session_send` call,
 *      prune arm against keep arm, same utterances, same instructions.
 *
 * READING DISCIPLINE (inherited from P0, and the reason S5 read tokens rather than frames): the
 * endpoint echoes a success-shaped frame for a delete of an id that never existed, so `deleted`
 * alone proves nothing. Every arm here reads a DISCRIMINATING number — input tokens, or the count
 * of forwarded utterances.
 *
 *     npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-prefix-history-pruning/probe.mts [arm...]
 *
 * Arms: prefix | audio | behaviour | all (default). The budget guard is shared by every arm and
 * closes every open socket on the tick it trips.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SESSION_SEND_TOOL,
  createRun,
  estimateRealtimeCostCny,
  openSession,
  readApiKey,
  sessionBody,
  sleep,
  type P0Session,
} from '../voice-realtime-segmented/p0/probe-lib.mts';
import { VOICE_REALTIME_INSTRUCTIONS, VOICE_REALTIME_TOOLS } from '../../server/modules/voice-realtime/index.js';
import { createUplinkVadClassifier } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad.js';
import { createUplinkVadGate } from '../../server/modules/voice-realtime/voice-realtime-uplink-vad-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACES_DIR = path.join(HERE, 'traces');

/** Tier 1's ceiling. Sized for the three arms with room to spare; the guard is the real cap. */
const BUDGET_CNY = Number(process.env.PROBE_BUDGET_CNY ?? 0.12);
/** How long one response window may take before the arm gives up on it. */
const RESPONSE_WINDOW_MS = 45_000;
/** After a `response.done`, how long to let the bridge's tool round-trip (output + resume) play out. */
const TURN_SETTLE_MS = 2_500;

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────

type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { audio_tokens?: number; text_tokens?: number } };

const usageOf = (session: P0Session, index: number): Usage =>
  (session.responses[index]?.usage ?? {}) as Usage;

/** `input_tokens_details` split as the bill's three lines: text in, audio in, text out. */
const read = (session: P0Session, index: number) => {
  const u = usageOf(session, index);
  const audio = u.input_tokens_details?.audio_tokens ?? 0;
  const text = u.input_tokens_details?.text_tokens ?? 0;
  return {
    input: u.input_tokens ?? 0,
    text,
    audio,
    output: u.output_tokens ?? 0,
    cny: session.responses[index]?.spendCny ?? 0,
  };
};

const createUserText = (session: P0Session, text: string, previousItemId?: string): void => {
  session.sendRaw({
    type: 'conversation.item.create',
    ...(previousItemId === undefined ? {} : { previous_item_id: previousItemId }),
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
};

/** Every item id this session has seen created, in the order the endpoint announced them. */
const itemOrder = (session: P0Session): string[] =>
  session.events
    .filter((e) => e.direction === 'received' && e.wire.type === 'conversation.item.created')
    .map((e) => (e.wire.item as { id?: unknown } | undefined)?.id)
    .filter((id): id is string => typeof id === 'string');

const ask = async (session: P0Session, timeoutMs = RESPONSE_WINDOW_MS): Promise<boolean> => {
  const before = session.responses.length;
  session.sendRaw({ type: 'response.create' });
  return session.waitFor(() => session.responses.length > before, timeoutMs);
};

/** Every `conversation.item.created` the endpoint announced after `fromEvent`, with its raw item. */
const itemsCreatedSince = (session: P0Session, fromEvent: number): Array<{ id: string; item: unknown }> => {
  const out: Array<{ id: string; item: unknown }> = [];
  for (const event of session.events.slice(fromEvent)) {
    if (event.direction !== 'received' || event.wire.type !== 'conversation.item.created') continue;
    const item = event.wire.item as { id?: unknown } | undefined;
    if (item && typeof item.id === 'string') out.push({ id: item.id, item });
  }
  return out;
};

const deleteItem = async (session: P0Session, itemId: string): Promise<'deleted' | 'refused' | 'silent'> => {
  const from = session.events.length;
  session.sendRaw({ type: 'conversation.item.delete', item_id: itemId });
  await session.waitFor(
    () =>
      session.events.slice(from).some(
        (e) => e.wire.type === 'conversation.item.deleted' || e.wire.type === 'error',
      ),
    5_000,
  );
  const slice = session.events.slice(from);
  if (slice.some((e) => e.wire.type === 'conversation.item.deleted')) return 'deleted';
  if (slice.some((e) => e.wire.type === 'error')) return 'refused';
  return 'silent';
};

// ── arm 1: the prefix slope ──────────────────────────────────────────────────────────────────────

/**
 * Three sessions, three instructions lengths, ONE response each. One session per length rather than
 * three `session.update`s inside one session: a session's own prior turns would grow its context
 * between the readings, and the whole point is to isolate the length term.
 */
const PREFIX_LENGTHS = [800, 2_400, 4_000] as const;
const PREFIX_FILLER =
  'When you hear the user, pass their words on unchanged. Do not answer, do not comment, and do not decide whether something is worth passing on. ';

const instructionsOfLength = (chars: number): string => {
  const head = 'You are a voice relay for one session. Always call session_send. ';
  const body = PREFIX_FILLER.repeat(Math.ceil(chars / PREFIX_FILLER.length));
  return (head + body).slice(0, chars);
};

const armPrefix = async (run: ReturnType<typeof createRun>): Promise<Record<string, unknown>> => {
  const sessions = await Promise.all(
    PREFIX_LENGTHS.map((chars) =>
      openSession({
        run,
        label: `prefix-${chars}`,
        instructions: instructionsOfLength(chars),
        sessionDefaults: sessionBody({ turn_detection: null }),
      }),
    ),
  );
  const readings = [];
  for (const session of sessions) {
    createUserText(session, '把这句话转过去。');
    await ask(session);
    const r = read(session, 0);
    readings.push({ instructionsChars: session.instructions.length, ...r });
  }
  await Promise.all(sessions.map((s) => s.close()));

  // Least squares over the three points: tokens per instruction character, and the intercept the
  // non-instruction part of the context (tool schema, formats, the user item itself) sits at.
  const n = readings.length;
  const mx = readings.reduce((a, r) => a + r.instructionsChars, 0) / n;
  const my = readings.reduce((a, r) => a + r.text, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const r of readings) {
    sxy += (r.instructionsChars - mx) * (r.text - my);
    sxx += (r.instructionsChars - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return { readings, tokensPerChar: Number(slope.toFixed(4)), interceptTokens: Number((my - slope * mx).toFixed(1)) };
};

// ── arm 4: what the tool schemas themselves cost ─────────────────────────────────────────────────

/**
 * The prefix arm's fitted intercept (287 tokens at ZERO instructions) is not zero, and production's
 * base is higher still: 2341 chars of instructions fit to 795 tokens, yet the journals measure 1258
 * for that same 2341-char template. The gap is the two production tool schemas, which ride in the
 * session body and are re-read by every response exactly like the prompt is.
 *
 * Three sessions, ONE instructions length, differing only in the tool set: the probe's minimal
 * single-tool descriptor, the shipping `session_send` alone, and the shipping pair. The differences
 * are the tool term, isolated.
 */
const TOOLS_INSTRUCTIONS_CHARS = 2_400;

const armTools = async (run: ReturnType<typeof createRun>): Promise<Record<string, unknown>> => {
  const variants: Array<[string, readonly unknown[]]> = [
    ['probe-single', [SESSION_SEND_TOOL]],
    ['shipping-send', [VOICE_REALTIME_TOOLS[0]]],
    ['shipping-pair', VOICE_REALTIME_TOOLS],
  ];
  const sessions = await Promise.all(
    variants.map(([label, tools]) =>
      openSession({
        run,
        label: `tools-${label}`,
        instructions: instructionsOfLength(TOOLS_INSTRUCTIONS_CHARS),
        sessionDefaults: sessionBody({ turn_detection: null }),
        tools: tools as never,
      }),
    ),
  );
  const readings = [];
  for (let i = 0; i < sessions.length; i++) {
    createUserText(sessions[i], '把这句话转过去。');
    await ask(sessions[i]);
    readings.push({ variant: variants[i][0], tools: variants[i][1].length, ...read(sessions[i], 0) });
  }
  await Promise.all(sessions.map((s) => s.close()));
  const [probe, send, pair] = readings;
  return {
    instructionsChars: TOOLS_INSTRUCTIONS_CHARS,
    readings,
    shippingSendOverProbeMinimal: send.text - probe.text,
    shippingPairOverShippingSend: pair.text - send.text,
    shippingPairOverProbeMinimal: pair.text - probe.text,
  };
};

// ── arm 2: the audio item ────────────────────────────────────────────────────────────────────────

/**
 * A speech-shaped tone rather than a recording: the question is TOKEN ACCOUNTING, not recognition,
 * and a synthetic buffer has a known duration at the endpoint's own assumed rate (PCM16 @ 24 kHz)
 * with no resampling question in between. Its amplitude envelope keeps it closer to speech than a
 * flat sine, in case the endpoint gates on energy.
 */
const syntheticPcm16 = (seconds: number, rate = 24_000): Buffer => {
  const samples = Math.round(seconds * rate);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const envelope = 0.35 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3.1 * t));
    const value = envelope * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 320 * t));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  return buf;
};

const AUDIO_SECONDS = 4;
/** 100 ms per frame: 30 frames for the 4 s buffer, rather than the browser's 20 ms (200 frames). */
const AUDIO_FRAME_MS = 100;

const armAudio = async (run: ReturnType<typeof createRun>): Promise<Record<string, unknown>> => {
  const session = await openSession({
    run,
    label: 'audio-item',
    instructions: 'You are a voice relay for one session. Always call session_send.',
    sessionDefaults: sessionBody({ turn_detection: null }),
  });

  const pcm = syntheticPcm16(AUDIO_SECONDS);
  const bytesPerFrame = (24_000 * 2 * AUDIO_FRAME_MS) / 1_000;
  const framesAt = session.events.length;
  for (let offset = 0; offset < pcm.length; offset += bytesPerFrame) {
    session.sendAudioBase64(pcm.subarray(offset, offset + bytesPerFrame).toString('base64'));
  }
  // With the endpoint's own VAD off, the commit is what closes the buffer AND creates the item.
  session.sendRaw({ type: 'input_audio_buffer.commit' });
  await session.waitFor(
    () => itemsCreatedSince(session, framesAt).length > 0,
    15_000,
  );
  const before = itemsCreatedSince(session, framesAt);

  await ask(session);
  const withAudio = read(session, 0);

  const deletions = [];
  for (const created of before) {
    const outcome = await deleteItem(session, created.id);
    deletions.push({ id: created.id, outcome, item: created.item });
  }

  await ask(session);
  const afterDelete = read(session, 1);

  await session.close();
  return {
    audioSeconds: AUDIO_SECONDS,
    audioBytes: pcm.length,
    itemsCreated: before.map((b) => b.item),
    withAudio,
    afterDelete,
    audioTokenDrop: withAudio.audio - afterDelete.audio,
    textTokenDrop: withAudio.text - afterDelete.text,
    inputTokenDrop: withAudio.input - afterDelete.input,
    deletions,
  };
};

// ── arm 3: does a pruned history still relay? ────────────────────────────────────────────────────

/**
 * The SHIPPING tool result, verbatim (`voice-realtime-ws-proxy.service.ts`, the `session_send`
 * handler). Tier 1's plumbing arm returned `{accepted: true}` — 17 characters — and therefore
 * measured the plumbing as worth ~9 tokens a turn, against a production journal where the same item
 * is ~180 characters that every later response re-reads. The arm was measuring the probe's own
 * executor, not the relay's.
 *
 * It is also the reason the closing turn exists at all: the text literally instructs the model to
 * "Reply with the single word OK", which is what the suppressed `OK` responses are complying with.
 */
const SESSION_SEND_RESULT = {
  accepted: true,
  instruction:
    'The message was accepted and will reach the session. Do not call session_send again for it. Reply with the single word OK.',
};

const UTTERANCES = [
  '把这句话转给会话。',
  '再加一句，今晚继续测。',
  '这句话也要转过去。',
  '顺便说一句，日志我看过了。',
  '最后一句，先到这里。',
];

/**
 * One arm of the behaviour pair. `prune` deletes every conversation item the turn created as soon as
 * the turn has settled — user item, the model's `function_call` item, and the tool result — which is
 * the aggressive end of ③ (a one-turn window). The keep arm runs the identical utterance list with
 * no deletion, so the pair differs in exactly one thing.
 */
const oneBehaviourArm = async (
  run: ReturnType<typeof createRun>,
  label: string,
  prune: boolean,
  options: { utterances?: readonly string[]; keepUserItems?: boolean } = {},
): Promise<Record<string, unknown>> => {
  const utterances = options.utterances ?? UTTERANCES;
  const session = await openSession({
    run,
    label,
    instructions: 'You are a voice relay. Pass on everything the user says by calling session_send. Never reply in text.',
    sessionDefaults: sessionBody({ turn_detection: null }),
    tools: [SESSION_SEND_TOOL],
    executor: { session_send: () => SESSION_SEND_RESULT },
  });

  const turns = [];
  for (const utterance of utterances) {
    const fromEvent = session.events.length;
    const callsBefore = session.functionCalls.length;
    const replies: string[] = [];

    createUserText(session, utterance);
    await ask(session);
    await sleep(TURN_SETTLE_MS);
    replies.push(...responseTexts(session, fromEvent));

    const calls = session.functionCalls.slice(callsBefore).map((c) => ({ name: c.name, arguments: c.arguments }));
    let deletions: Array<{ id: string; kind?: string; outcome: string }> = [];
    if (prune) {
      for (const created of itemsCreatedSince(session, fromEvent)) {
        // A user `message` item IS the utterance. Keeping it is what makes this arm "plumbing only"
        // rather than tier 1's cut, which took the words with everything else.
        const item = created.item as { type?: unknown; role?: unknown };
        if (options.keepUserItems && item.type === 'message' && item.role === 'user') continue;
        // The outcome and the item KIND are the readings that say whether a small context delta is
        // "the plumbing is cheap" or "the delete was refused / inert".
        deletions.push({
          id: created.id,
          kind: `${String(item.type)}/${String(item.role)}`,
          outcome: await deleteItem(session, created.id),
        });
      }
    }
    turns.push({
      utterance,
      forwarded: calls.length > 0,
      calls,
      replies,
      deleted: deletions.length,
      deletions,
      inputTokens: read(session, session.responses.length - 1).input,
    });
  }

  const readings = session.responses.map((_, i) => read(session, i));
  await session.close();
  return {
    prune,
    utterances: utterances.length,
    forwarded: turns.filter((t) => t.forwarded).length,
    turns,
    contextGrowth: {
      firstInputTokens: readings[0]?.input ?? 0,
      lastInputTokens: readings[readings.length - 1]?.input ?? 0,
      responses: readings.length,
    },
  };
};

/**
 * The assistant TEXT each response produced, read off the wire.
 *
 * `response.text.done` is the frame the shipping diagnose service reads for its "model text (not
 * shown to the user)" line, so this is the same reading the production journal carries — and the
 * one that names the failure ① died of ("No response requested." in place of a `session_send`).
 */
const responseTexts = (session: P0Session, fromEvent: number): string[] => {
  const out: string[] = [];
  for (const event of session.events.slice(fromEvent)) {
    if (event.wire.type !== 'response.text.done') continue;
    if (typeof event.wire.text === 'string') out.push(event.wire.text);
  }
  return out;
};

// ── arm 5 (tier 2): does the WORDS survive deleting the audio item? ──────────────────────────────

/**
 * Tier 1 proved two things that point in opposite directions: deleting the item that carries an
 * utterance stops the relay and makes the model invent messages (behaviour arm, 3/5 with four
 * fabricated `session_send` calls), and deleting an AUDIO item does remove its tokens (audio arm,
 * audio 42 → 0). The plan ⑤ actually describes — drop the audio, keep the words — is only available
 * if those are separable, which the synthetic buffer could not show: a tone transcribes to nothing,
 * so tier 1's `content: [{type: 'input_audio'}]` item was pure audio with only 6 tokens of anything
 * else on it.
 *
 * So this arm sends REAL speech and reads the item the endpoint builds from it. Two readings decide
 * it: whether the transcription lands in the SAME item (in which case deleting it takes the words
 * too, and ② is dead), and what `text_tokens` does across the delete (the number that says whether
 * the words are still there rather than the frame that says the delete was accepted).
 *
 * The audio is a slice of a real captured session, already at this endpoint by construction, cut to
 * its loudest three seconds so the transcript is not empty. It is 16 kHz and the session declares
 * PCM16, which this endpoint reads at 24 kHz, so it is resampled — otherwise the model hears the
 * person at 1.5x and the transcript is the thing under test.
 */
const wavPcm = (file: string): { sampleRate: number; pcm: Buffer } => {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${file} is not a RIFF/WAVE file`);
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (data === null || sampleRate === 0) throw new Error(`${file} has no fmt/data chunk`);
  if (channels !== 1 || bits !== 16) throw new Error(`${file} is ${channels}ch/${bits}bit — expected mono 16-bit`);
  return { sampleRate, pcm: data };
};

/** Linear-interpolation resample of PCM16 — enough for an ASR input, and no dependency. */
const resamplePcm16 = (pcm: Buffer, from: number, to: number): Buffer => {
  if (from === to) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor((inSamples * to) / from);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const position = (i * from) / to;
    const left = Math.min(inSamples - 1, Math.floor(position));
    const right = Math.min(inSamples - 1, left + 1);
    const weight = position - left;
    const value = pcm.readInt16LE(left * 2) * (1 - weight) + pcm.readInt16LE(right * 2) * weight;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }
  return out;
};

/** The loudest `seconds`-long window, so the slice has speech in it rather than the lead-in silence. */
const loudestWindow = (pcm: Buffer, sampleRate: number, seconds: number): Buffer => {
  const window = sampleRate * seconds;
  const total = Math.floor(pcm.length / 2);
  if (total <= window) return pcm;
  const step = Math.floor(sampleRate / 4);
  let bestAt = 0;
  let best = -1;
  for (let start = 0; start + window <= total; start += step) {
    let energy = 0;
    for (let i = start; i < start + window; i += 16) energy += Math.abs(pcm.readInt16LE(i * 2));
    if (energy > best) {
      best = energy;
      bestAt = start;
    }
  }
  return pcm.subarray(bestAt * 2, (bestAt + window) * 2);
};

const CAPTURE_WAV = path.join(
  process.env.HOME ?? '',
  '.cloudcli/voice-realtime-capture/1b3011d1-15e9-4d42-b8f3-92bc08559a77.wav',
);

const armAudioTranscript = async (run: ReturnType<typeof createRun>): Promise<Record<string, unknown>> => {
  const session = await openSession({
    run,
    label: 'audio-transcript',
    instructions: 'You are a voice relay for one session. Always call session_send.',
    sessionDefaults: sessionBody({ turn_detection: null }),
  });

  const { sampleRate, pcm } = wavPcm(CAPTURE_WAV);
  const slice = resamplePcm16(loudestWindow(pcm, sampleRate, 4), sampleRate, 24_000);
  const fromEvent = session.events.length;
  const bytesPerFrame = (24_000 * 2 * AUDIO_FRAME_MS) / 1_000;
  for (let offset = 0; offset < slice.length; offset += bytesPerFrame) {
    session.sendAudioBase64(slice.subarray(offset, offset + bytesPerFrame).toString('base64'));
  }
  session.sendRaw({ type: 'input_audio_buffer.commit' });
  await session.waitFor(
    () => session.events.slice(fromEvent).some((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed'),
    20_000,
  );
  const transcript = session.events
    .slice(fromEvent)
    .filter((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed')
    .map((e) => e.wire.transcript);

  const created = itemsCreatedSince(session, fromEvent);
  await ask(session);
  const withAudio = read(session, 0);
  const deletions = [];
  for (const item of created) deletions.push({ id: item.id, outcome: await deleteItem(session, item.id) });
  await ask(session);
  const afterDelete = read(session, 1);

  await session.close();
  return {
    sourceWav: path.basename(CAPTURE_WAV),
    sourceSampleRate: sampleRate,
    sentSeconds: 4,
    transcript,
    itemsCreated: created.map((c) => c.item),
    withAudio,
    afterDelete,
    audioTokenDrop: withAudio.audio - afterDelete.audio,
    textTokenDrop: withAudio.text - afterDelete.text,
    deletions,
  };
};

// ── arm 6 (tier 2): the plan's prune — plumbing only, the words stay ─────────────────────────────

/**
 * The narrow half of ⑤, and the one the plan actually describes: after a turn has settled, delete
 * the tool PLUMBING (the model's `function_call` item, the `function_call_output` item, and the
 * closing assistant message) and leave every user item in place. Tier 1's behaviour arm deleted the
 * user items too — a stricter cut than anything ⑤ proposes — and that is the arm that broke.
 *
 * This runs the same utterance list as that arm, with the same settle window, so the pair
 * `behaviour-keep` vs `plumbing-prune` differs in exactly one thing: whether the plumbing is
 * dropped. More utterances than tier 1, because this is the reading the plan stands or falls on.
 */
const PLUMBING_UTTERANCES = [
  ...UTTERANCES,
  '这条也一并转过去。',
  '补一句，明天再看结果。',
  '再补一句，先不要动线上。',
];

const PLUMBING_LONG = [
  ...PLUMBING_UTTERANCES,
  '再补一句，日志里有异常。',
  '这句也转过去，注意时序。',
  '顺带提一下，缓存那条已经确认了。',
  '最后再补一句，明天继续。',
];

const armPlumbing = async (
  run: ReturnType<typeof createRun>,
  prune: boolean,
  utterances: readonly string[] = PLUMBING_UTTERANCES,
  label = 'plumbing',
): Promise<Record<string, unknown>> =>
  oneBehaviourArm(run, `${label}-${prune ? 'prune' : 'keep'}`, prune, { utterances, keepUserItems: true });

// ── arm 7 (tier 2b): the recipe ⑤ actually needs — delete the audio, keep the words ─────────────

/**
 * Tier 2a showed the audio item carries the utterance and the transcript leaves with it (audio 42 →
 * 0 AND text −6). Tier 1's behaviour arm showed what happens when the words leave the conversation:
 * forwarding collapses and the model starts inventing messages. So "drop the audio history" cannot
 * mean "delete the item" — it has to mean DELETE AND REPLACE: retire the audio item, then re-create
 * the same utterance as a text-only user item, so the model keeps reading the words at a quarter of
 * the price and the 4x-priced audio stops being re-read by every later response.
 *
 * Two arms, same audio turn, same three follow-up utterances: `twin` performs the replace, `keep`
 * leaves the conversation alone. The readings are the audio/text tokens of the first response AFTER
 * the mutation (did the audio actually leave, did the words actually stay) and how many of the three
 * follow-ups still produce a `session_send`.
 */
const TWIN_FOLLOW_UPS = ['接着转这一句。', '再转一句，明天见。', '最后一句，收工。'];

const armAudioTwin = async (
  run: ReturnType<typeof createRun>,
  mode: 'twin' | 'keep',
  options: { seconds?: number; followUps?: readonly string[]; memoryProbe?: boolean } = {},
): Promise<Record<string, unknown>> => {
  const session = await openSession({
    run,
    label: `audio-${mode}`,
    instructions: 'You are a voice relay. Pass on everything the user says by calling session_send. Never reply in text.',
    sessionDefaults: sessionBody({ turn_detection: null }),
    tools: [SESSION_SEND_TOOL],
    executor: { session_send: () => SESSION_SEND_RESULT },
  });

  const { sampleRate, pcm } = wavPcm(CAPTURE_WAV);
  const slice = resamplePcm16(loudestWindow(pcm, sampleRate, options.seconds ?? 3), sampleRate, 24_000);
  const audioTurn = session.events.length;
  const bytesPerFrame = (24_000 * 2 * AUDIO_FRAME_MS) / 1_000;
  for (let offset = 0; offset < slice.length; offset += bytesPerFrame) {
    session.sendAudioBase64(slice.subarray(offset, offset + bytesPerFrame).toString('base64'));
  }
  session.sendRaw({ type: 'input_audio_buffer.commit' });
  await session.waitFor(
    () => session.events.slice(audioTurn).some((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed'),
    20_000,
  );
  const transcript = String(
    session.events
      .slice(audioTurn)
      .filter((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed')
      .map((e) => e.wire.transcript)[0] ?? '',
  );
  const audioItems = itemsCreatedSince(session, audioTurn);
  await ask(session);
  await sleep(TURN_SETTLE_MS);
  const audioTurnReading = read(session, 0);

  let mutation: Record<string, unknown> = { mode };
  if (mode === 'twin') {
    const deletions = [];
    for (const item of audioItems) deletions.push({ id: item.id, outcome: await deleteItem(session, item.id) });
    if (transcript !== '') {
      session.sendRaw({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: transcript }] },
      });
    }
    mutation = { mode, deletions, recreated: transcript };
  }

  const settledAt = session.responses.length;
  await ask(session);
  const afterMutation = read(session, settledAt);

  // THE SEMANTIC READING. Token counts say the words are still IN the context; they do not say the
  // model can still READ them. Asking for the previous utterance back verbatim is the one follow-up
  // whose answer is wrong-shaped if the swap lost them — and it is scored against the transcript the
  // endpoint itself produced, so the arm does not depend on what a human thinks was said.
  let memory: Record<string, unknown> | null = null;
  if (options.memoryProbe) {
    const before = session.functionCalls.length;
    createUserText(session, '把刚才那一句原样再转一次，不要改动。');
    await ask(session);
    await sleep(TURN_SETTLE_MS);
    memory = {
      asked: '把刚才那一句原样再转一次，不要改动。',
      calls: session.functionCalls.slice(before).map((c) => c.arguments),
      transcript,
    };
  }

  const followUpStart = session.functionCalls.length;
  for (const utterance of options.followUps ?? TWIN_FOLLOW_UPS) {
    createUserText(session, utterance);
    await ask(session);
    await sleep(TURN_SETTLE_MS);
  }
  const followUpsForwarded = session.functionCalls.length - followUpStart;

  await session.close();
  return {
    mode,
    transcript,
    audioTurnReading,
    afterMutation,
    audioTokenDelta: audioTurnReading.audio - afterMutation.audio,
    textTokenDelta: audioTurnReading.text - afterMutation.text,
    mutation,
    followUps: (options.followUps ?? TWIN_FOLLOW_UPS).length,
    followUpsForwarded,
    memory,
  };
};

// ── tier 4: the SEMANTIC reading — what actually reaches Claude Code ─────────────────────────────

/**
 * Everything above this line reads TOKENS. Tokens are not the deliverable: what reaches Claude Code
 * is the `message` the model puts in `session_send`, and an arm that saves 25% while quietly
 * changing, dropping, or inventing that text is not a cheaper relay, it is a different one.
 *
 * Two failure shapes are specific to the twin recipe and neither is visible in a token count:
 *
 *   ECHO     the re-created `role: user` text item is read back as a NEW utterance, so an old
 *            sentence is delivered to Claude Code a second time, as if the person had just said it;
 *   FOREIGN  any delivered message that is not the utterance the person just spoke.
 *
 * Both are detected against the endpoint's own transcriptions of the SAME audio, which is the only
 * reference that does not require knowing the recording by ear. Transcript-level differences between
 * arms are acceptable and are NOT scored: the model relays what it heard, and the ASR is the
 * endpoint's, not the arm's.
 */
const SEMANTIC_WINDOWS = 4;

/** The top-`count` non-overlapping `seconds` windows, so each utterance carries real speech. */
const loudestWindows = (pcm: Buffer, sampleRate: number, seconds: number, count: number): Buffer[] => {
  const window = sampleRate * seconds;
  const total = Math.floor(pcm.length / 2);
  const step = Math.floor(sampleRate / 4);
  const scored: Array<{ at: number; energy: number }> = [];
  for (let start = 0; start + window <= total; start += step) {
    let energy = 0;
    for (let i = start; i < start + window; i += 16) energy += Math.abs(pcm.readInt16LE(i * 2));
    scored.push({ at: start, energy });
  }
  scored.sort((a, b) => b.energy - a.energy);
  const chosen: number[] = [];
  for (const candidate of scored) {
    if (chosen.length >= count) break;
    if (chosen.every((at) => Math.abs(at - candidate.at) >= window)) chosen.push(candidate.at);
  }
  return chosen.sort((a, b) => a - b).map((at) => pcm.subarray(at * 2, (at + window) * 2));
};

const armAudioSemantic = async (
  run: ReturnType<typeof createRun>,
  mode: 'twin' | 'keep',
): Promise<Record<string, unknown>> => {
  const session = await openSession({
    run,
    label: `semantic-${mode}`,
    instructions: 'You are a voice relay. Pass on everything the user says by calling session_send. Never reply in text.',
    sessionDefaults: sessionBody({ turn_detection: null }),
    tools: [SESSION_SEND_TOOL],
    executor: { session_send: () => SESSION_SEND_RESULT },
  });

  const { sampleRate, pcm } = wavPcm(CAPTURE_WAV);
  const windows = loudestWindows(pcm, sampleRate, 4, SEMANTIC_WINDOWS);
  const bytesPerFrame = (24_000 * 2 * AUDIO_FRAME_MS) / 1_000;
  const turns = [];

  for (let index = 0; index < windows.length; index++) {
    const slice = resamplePcm16(windows[index], sampleRate, 24_000);
    const fromEvent = session.events.length;
    const callsBefore = session.functionCalls.length;
    for (let offset = 0; offset < slice.length; offset += bytesPerFrame) {
      session.sendAudioBase64(slice.subarray(offset, offset + bytesPerFrame).toString('base64'));
    }
    session.sendRaw({ type: 'input_audio_buffer.commit' });
    await session.waitFor(
      () => session.events.slice(fromEvent).some((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed'),
      20_000,
    );
    const transcript = String(
      session.events.slice(fromEvent)
        .filter((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed')
        .map((e) => e.wire.transcript)[0] ?? '',
    );
    const audioItems = itemsCreatedSince(session, fromEvent);
    await ask(session);
    await sleep(TURN_SETTLE_MS);

    const delivered = session.functionCalls.slice(callsBefore).map((c) => {
      try {
        return (JSON.parse(c.arguments) as { message?: string }).message ?? c.arguments;
      } catch {
        return c.arguments;
      }
    });
    let deletions: Array<{ id: string; outcome: string }> = [];
    if (mode === 'twin') {
      for (const item of audioItems) deletions.push({ id: item.id, outcome: await deleteItem(session, item.id) });
      if (transcript !== '') createUserText(session, transcript);
    }
    turns.push({ index, transcript, delivered, deletions, replies: responseTexts(session, fromEvent) });
  }

  await session.close();

  // ECHO: a delivery on turn i that repeats what an EARLIER turn heard. FOREIGN: a delivery that is
  // neither this turn's transcription nor a repeat of one — the aggressive-prune arm's fabrication.
  const echoes: Array<Record<string, unknown>> = [];
  const foreign: Array<Record<string, unknown>> = [];
  turns.forEach((turn, i) => {
    for (const message of turn.delivered) {
      const earlier = turns.slice(0, i).some((t) => t.transcript !== '' && normalize(message) === normalize(t.transcript));
      if (earlier) echoes.push({ turn: i, message, repeats: turns.slice(0, i).find((t) => normalize(t.transcript) === normalize(message))?.transcript });
      else if (turn.transcript === '' || normalize(message) !== normalize(turn.transcript)) {
        const sameAsOwn = normalize(message) === normalize(turn.transcript);
        if (!sameAsOwn) foreign.push({ turn: i, message, transcript: turn.transcript });
      }
    }
  });

  return {
    mode,
    utterances: windows.length,
    turns,
    deliveredTotal: turns.reduce((a, t) => a + t.delivered.length, 0),
    turnsWithDelivery: turns.filter((t) => t.delivered.length > 0).length,
    echoes,
    foreign,
  };
};

const normalize = (text: string): string => text.replace(/[\s，。！？、,.!?]/g, '');

// ── tier 5: the two failure shapes the twin recipe can actually cause ────────────────────────────

/**
 * Tier 4 was meant to be the semantic arm and instead measured my own window picker: the recording
 * holds ONE utterance (speech 627–4743 ms of a 20.4 s capture) and "the four loudest windows" chose
 * three stretches of silence. That accident did produce the cleanest reading in the whole experiment,
 * so it is kept and made deliberate here.
 *
 * WHY THE TIER-4 FOREIGN DETECTOR IS NOT REUSED. It scored "the model's message differs from the
 * endpoint's transcription" as foreign. That is exactly the difference the owner ruled acceptable —
 * in the same capture the ASR heard "Live Voice第四十次" while the model delivered "Live Voice 第四次
 * 测试", and the delivered text is the more faithful one. Scoring ASR disagreement would penalise the
 * model for hearing better than the transcriber. Two shapes survive that objection, because neither
 * depends on the transcription being right:
 *
 *   ECHO       on a turn where the person said nothing new, the model delivers an old sentence. The
 *              reference is an EARLIER turn's own words, not a transcription of this one.
 *   SILENCE    the person said nothing at all, and the model delivers something anyway.
 *
 * Both are tested directly. A: text-only, where the ground truth is exact and the swap is the twin's
 * mechanism with the audio removed. B: audio, real silence from the same capture, both arms.
 */
const ECHO_UTTERANCES = ['把这句话转给会话。', '再加一句，今晚继续测。', '这句话也要转过去。'];

const armEcho = async (
  run: ReturnType<typeof createRun>,
  mode: 'swap' | 'plain' | 'inplace',
  labeling: { label?: string; tools?: readonly unknown[] } = {},
): Promise<Record<string, unknown>> => {
  const session = await openSession({
    run,
    label: labeling.label ?? `echo-${mode}`,
    instructions: 'You are a voice relay. Pass on everything the user says by calling session_send. Never reply in text.',
    sessionDefaults: sessionBody({ turn_detection: null }),
    tools: (labeling.tools ?? [SESSION_SEND_TOOL]) as never,
    executor: { session_send: () => SESSION_SEND_RESULT },
  });

  const turns = [];
  for (const utterance of ECHO_UTTERANCES) {
    const fromEvent = session.events.length;
    const callsBefore = session.functionCalls.length;
    createUserText(session, utterance);
    await ask(session);
    await sleep(TURN_SETTLE_MS);
    const delivered = session.functionCalls.slice(callsBefore).map((c) => {
      try {
        return (JSON.parse(c.arguments) as { message?: string }).message ?? c.arguments;
      } catch {
        return c.arguments;
      }
    });
    let swapped = false;
    if (mode !== 'plain') {
      // The twin's mechanism with the audio taken out: retire the utterance item and put the same
      // words back as a fresh `role: user` item. `swap` appends it, which is what the recipe as
      // written does; `inplace` re-inserts it AFTER the item that preceded it, so the conversation
      // keeps its original order and no user message is left dangling at the end.
      const own = itemsCreatedSince(session, fromEvent).filter((c) => {
        const item = c.item as { type?: unknown; role?: unknown };
        return item.type === 'message' && item.role === 'user';
      });
      const order = itemOrder(session);
      const anchorIndex = own.length > 0 ? order.indexOf(own[0].id) - 1 : -1;
      const anchor = anchorIndex >= 0 ? order[anchorIndex] : undefined;
      for (const item of own) await deleteItem(session, item.id);
      createUserText(session, utterance, mode === 'inplace' ? anchor : undefined);
      swapped = true;
    }
    turns.push({ utterance, delivered, swapped });
  }

  // THE QUIET TURN. No new user item, no audio — only `response.create`. Anything delivered here is
  // a delivery of something the person did not just say.
  const beforeQuiet = session.functionCalls.length;
  await ask(session);
  await sleep(TURN_SETTLE_MS);
  const quietDelivered = session.functionCalls.slice(beforeQuiet).map((c) => {
    try {
      return (JSON.parse(c.arguments) as { message?: string }).message ?? c.arguments;
    } catch {
      return c.arguments;
    }
  });

  await session.close();
  const flat = turns.flatMap((t) => t.delivered);
  return {
    mode,
    turns,
    quietDelivered,
    faithful: turns.filter((t) => t.delivered.includes(t.utterance)).length,
    deliveredTotal: flat.length,
    duplicated: flat.length - new Set(flat).size,
    echoes: turns.flatMap((t, i) => t.delivered.filter((m) => m !== t.utterance && turns.slice(0, i).some((p) => p.utterance === m)).map((m) => ({ turn: i, message: m }))),
  };
};

const armSilence = async (run: ReturnType<typeof createRun>, mode: 'twin' | 'keep'): Promise<Record<string, unknown>> => {
  const session = await openSession({
    run,
    label: `silence-${mode}`,
    instructions: 'You are a voice relay. Pass on everything the user says by calling session_send. Never reply in text.',
    sessionDefaults: sessionBody({ turn_detection: null }),
    tools: [SESSION_SEND_TOOL],
    executor: { session_send: () => SESSION_SEND_RESULT },
  });

  // Real silence from the same capture: speech ends at 4743 ms and the file runs to 20.4 s, so these
  // four seconds are the person NOT talking.
  const { sampleRate, pcm } = wavPcm(CAPTURE_WAV);
  const silent = pcm.subarray(Math.floor(sampleRate * 8) * 2, Math.floor(sampleRate * 12) * 2);
  const slice = resamplePcm16(silent, sampleRate, 24_000);
  const bytesPerFrame = (24_000 * 2 * AUDIO_FRAME_MS) / 1_000;
  const turns = [];

  for (let i = 0; i < 3; i++) {
    const fromEvent = session.events.length;
    const callsBefore = session.functionCalls.length;
    for (let offset = 0; offset < slice.length; offset += bytesPerFrame) {
      session.sendAudioBase64(slice.subarray(offset, offset + bytesPerFrame).toString('base64'));
    }
    session.sendRaw({ type: 'input_audio_buffer.commit' });
    await sleep(3_000);
    const transcript = String(
      session.events.slice(fromEvent)
        .filter((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed')
        .map((e) => e.wire.transcript)[0] ?? '',
    );
    await ask(session);
    await sleep(TURN_SETTLE_MS);
    const delivered = session.functionCalls.slice(callsBefore).map((c) => {
      try {
        return (JSON.parse(c.arguments) as { message?: string }).message ?? c.arguments;
      } catch {
        return c.arguments;
      }
    });
    if (mode === 'twin') {
      for (const item of itemsCreatedSince(session, fromEvent)) await deleteItem(session, item.id);
    }
    turns.push({ i, transcript, delivered });
  }

  await session.close();
  return {
    mode,
    turns,
    deliveredOnSilence: turns.reduce((a, t) => a + t.delivered.length, 0),
    quietTurns: turns.filter((t) => t.delivered.length === 0).length,
  };
};

// ── arm 9: what sample rate does this endpoint read `pcm16` at? ───────────────────────────────────

/**
 * The production browser sends 16 kHz PCM16 (`capture` timeline: `"sampleRate":16000`) under a session
 * body that declares `input_audio_format: 'pcm16'` with no rate on it. Every audio arm in THIS
 * experiment resampled that source UP to 24 kHz first, on the assumption that the endpoint reads
 * `pcm16` at 24 kHz. If that assumption is wrong the endpoint received every probe utterance at
 * 16/24 = 0.67x speed and the transcriptions were degraded by it — which is one candidate explanation
 * for why the probes heard "来我写第四十车" where the live session heard "Live Voice第四十次".
 *
 * Decisive, and cheap: the SAME four seconds, sent one way then the other, against the sentence the
 * live session actually recorded. Whichever rendering the endpoint transcribes correctly is the rate
 * it reads; the audio-token counts say the same thing a second way, because a stream the endpoint
 * plays 1.5x slow occupies 1.5x the audio.
 */
const RATE_SOURCE_SECONDS = 4;

const armRate = async (run: ReturnType<typeof createRun>): Promise<Record<string, unknown>> => {
  const session = await openSession({
    run,
    label: 'rate',
    instructions: 'You are a voice relay. Pass on everything the user says by calling session_send. Never reply in text.',
    sessionDefaults: sessionBody({ turn_detection: null }),
    tools: [SESSION_SEND_TOOL],
    executor: { session_send: () => SESSION_SEND_RESULT },
  });

  const { sampleRate, pcm } = wavPcm(CAPTURE_WAV);
  const window = loudestWindow(pcm, sampleRate, RATE_SOURCE_SECONDS);
  const variants: Array<[string, Buffer, number]> = [
    ['as-recorded', window, sampleRate],
    ['resampled-24k', resamplePcm16(window, sampleRate, 24_000), 24_000],
  ];

  const readings = [];
  for (const [label, buffer, rate] of variants) {
    const fromEvent = session.events.length;
    const callsBefore = session.functionCalls.length;
    const bytesPerFrame = (rate * 2 * AUDIO_FRAME_MS) / 1_000;
    for (let offset = 0; offset < buffer.length; offset += bytesPerFrame) {
      session.sendAudioBase64(buffer.subarray(offset, offset + bytesPerFrame).toString('base64'));
    }
    session.sendRaw({ type: 'input_audio_buffer.commit' });
    await session.waitFor(
      () => session.events.slice(fromEvent).some((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed'),
      20_000,
    );
    await ask(session);
    await sleep(TURN_SETTLE_MS);
    const usage = read(session, session.responses.length - 1);
    readings.push({
      label,
      sentSampleRate: rate,
      sentSeconds: RATE_SOURCE_SECONDS,
      transcript: String(
        session.events.slice(fromEvent)
          .filter((e) => e.wire.type === 'conversation.item.input_audio_transcription.completed')
          .map((e) => e.wire.transcript)[0] ?? '',
      ),
      delivered: session.functionCalls.slice(callsBefore).map((c) => {
        try {
          return (JSON.parse(c.arguments) as { message?: string }).message ?? c.arguments;
        } catch {
          return c.arguments;
        }
      }),
      audioTokens: usage.audio,
      textTokens: usage.text,
    });
  }

  await session.close();
  return { sourceSampleRate: sampleRate, liveSessionHeard: '现在是十月十五日，Live Voice第四十次。', readings };
};

// ── arm 10: the production-shaped re-verification ────────────────────────────────────────────────

/**
 * Everything above ran with the upstream turn detector OFF, at the wrong sample rate, with every frame
 * of audio reaching the endpoint. Production is none of those things:
 *
 *   - upstream `server_vad` (threshold 0.5, silence 400 ms) decides the turns, so no `response.create`
 *     is sent by anyone — the ENDPOINT starts the response when it hears the person stop;
 *   - 16 kHz PCM16 (`capture` timeline: `"sampleRate":16000`) — measured directly in the `rate` arm,
 *     where 16 kHz transcribed correctly and produced the same 28 audio tokens the live journal shows;
 *   - the silero UPLINK VAD gate drops 86.6% of frames before they leave the server
 *     (`browserFrames=24434 sent=3273` on connection 86559798), keeping only speech plus the 620 ms
 *     head window that the upstream needs to close its own turn.
 *
 * This arm reproduces all three: the REAL gate (the shipping classifier and gate modules, silero
 * weights, `silenceDurationMs: 400`), 20 ms frames paced on a wall-clock deadline, and the production
 * session body with `server_vad` intact. The audio is a real stretch of a real session — 18.0–30.5 s of
 * `164c3087`, three utterances with ~1.7 s gaps — so the endpoint does the segmenting, not the probe.
 *
 * WHAT IT IS FOR. The echo/desync finding and the aggressive-prune fabrication were both measured on a
 * conversation shape production never has. If the desync survives here, it is real; if the endpoint's
 * own VAD answers the dangling item before the next utterance, the finding does not transfer.
 */
const CAPTURE_LONG = path.join(
  process.env.HOME ?? '',
  '.cloudcli/voice-realtime-capture/164c3087-5830-46b5-8a3b-998897a92488.wav',
);
const PRODUCTION_SPAN = { startMs: 18_000, endMs: 30_500 };
/**
 * Spans are chosen by MEASURED ENERGY, not by the capture's own timeline.
 *
 * The first cut of this arm took the spans from `164c3087`'s `.timeline.jsonl`, which records the
 * endpoint's `speech_started` offsets. That map does not describe the `.wav` beside it: the timeline
 * puts a 9.7 s utterance at 44.8 s where the audio's mean amplitude is 40–70 out of 32768 — silence —
 * and the real speech in that neighbourhood starts at 55 s, ten seconds later. `spanB` was chosen from
 * the timeline, every one of its 573 frames was judged non-speech by the gate, and the arm spent ¥
 * measuring nothing. A span picker that trusts a map over the territory cannot tell that apart from
 * "the model said nothing".
 */
const SPAN_SECONDS = 25;
const SPAN_COUNT = 4;

/** The top-`count` non-overlapping `seconds`-long windows of the recording, ranked by mean amplitude. */
const loudestSpans = (
  pcm: Buffer,
  sampleRate: number,
  count: number,
  seconds: number,
): Array<{ name: string; startMs: number; endMs: number }> => {
  const perSecond: number[] = [];
  for (let s = 0; s * sampleRate * 2 < pcm.length; s++) {
    const from = s * sampleRate * 2;
    const to = Math.min(from + sampleRate * 2, pcm.length);
    let energy = 0;
    for (let i = from; i < to; i += 2) energy += Math.abs(pcm.readInt16LE(i));
    perSecond.push(energy / ((to - from) / 2));
  }
  const scored = perSecond.map((_, s) => ({
    startSec: s,
    score: perSecond.slice(s, s + seconds).reduce((a, b) => a + b, 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const chosen: number[] = [];
  for (const candidate of scored) {
    if (chosen.length >= count) break;
    if (candidate.startSec + seconds > perSecond.length) continue;
    if (chosen.every((s) => Math.abs(s - candidate.startSec) >= seconds)) chosen.push(candidate.startSec);
  }
  return chosen
    .sort((a, b) => a - b)
    .map((startSec, i) => ({ name: `span${String.fromCharCode(65 + i)}`, startMs: startSec * 1_000, endMs: (startSec + seconds) * 1_000 }));
};

const UPLINK_VAD_WEIGHTS =
  process.env.VOICE_REALTIME_UPLINK_VAD_WEIGHTS_PATH ??
  path.join(process.env.HOME ?? '', 'work/voice-vad-engines/silero/silero_vad.onnx');

/** Resolved once per run, from the recording's own energy — see {@link loudestSpans}. */
let resolvedSpans: Array<{ name: string; startMs: number; endMs: number }> | null = null;
const productionSpans = (_run: ReturnType<typeof createRun>): Array<{ name: string; startMs: number; endMs: number }> => {
  if (resolvedSpans === null) {
    const { sampleRate, pcm } = wavPcm(CAPTURE_LONG);
    resolvedSpans = loudestSpans(pcm, sampleRate, SPAN_COUNT, SPAN_SECONDS);
    process.stdout.write(`spans by energy: ${resolvedSpans.map((s) => `${s.name} ${s.startMs / 1000}-${s.endMs / 1000}s`).join(', ')}\n`);
  }
  return resolvedSpans;
};

const armProduction = async (
  run: ReturnType<typeof createRun>,
  mode: 'twin' | 'keep' | 'aggressive',
  rep = 0,
  spanSpec: { name: string; startMs: number; endMs: number } = PRODUCTION_SPAN,
): Promise<Record<string, unknown>> => {
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: UPLINK_VAD_WEIGHTS });
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: 400 });

  const session = await openSession({
    run,
    label: `production-${mode}-${rep}-${spanSpec.name}`,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    // NO override: this is `sessionBody()`'s shipped `server_vad` / 0.5 / 400 — the production value.
    sessionDefaults: sessionBody(),
    tools: [SESSION_SEND_TOOL],
    executor: { session_send: () => SESSION_SEND_RESULT },
  });

  const { sampleRate, pcm } = wavPcm(CAPTURE_LONG);
  const span = pcm.subarray(
    Math.floor((sampleRate * spanSpec.startMs) / 1_000) * 2,
    Math.floor((sampleRate * spanSpec.endMs) / 1_000) * 2,
  );
  const frames: string[] = [];
  for (let offset = 0; offset + 640 <= span.length; offset += 640) {
    frames.push(span.subarray(offset, offset + 640).toString('base64'));
  }

  type Turn = {
    index: number;
    transcript: string;
    audioItemIds: string[];
    delivered: string[];
    replies: string[];
    swapped: string[];
    itemShape?: unknown;
  };
  const turns: Turn[] = [];
  const retired = new Set<string>();
  let current: Turn | null = null;
  let eventCursor = session.events.length;
  let callCursor = 0;
  let responseCursor = 0;
  let lastStats: Record<string, number> = {};
  let driftMs = 0;
  const startedAt = Date.now();

  /** Everything the endpoint has said and the model has done since the last cursor. */
  const absorb = async (allowSwap: boolean): Promise<void> => {
    const fresh = session.events.slice(eventCursor);
    for (const event of fresh) {
      if (event.direction !== 'received') continue;
      const type = event.wire.type;
      // The proxy mirrors the upstream's own turn state into the gate. Without this the gate is
      // reading a turn that never opens.
      if (type === 'input_audio_buffer.speech_started') gate.noteUpstreamTurn(true);
      if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.committed') gate.noteUpstreamTurn(false);
      // A commit is a new utterance: the endpoint decided where the boundary is, not this probe.
      if (type === 'conversation.item.input_audio_transcription.completed') {
        // THIS turn's utterance item — and ONLY it. The endpoint creates the user item when its own
        // VAD commits, so the k-th commit owns the k-th user `message` in creation order. An earlier
        // cut of this arm claimed every unclaimed item instead, which quietly turned the twin recipe
        // into the aggressive prune (it deleted the assistant's `function_call` and tool-output items
        // as well) and made the arm measure a different intervention than the one under test.
        // …and it must be an AUDIO item. Selecting "the k-th user message" instead lets this arm's own
        // re-inserted `input_text` twins occupy the index, so the swap deletes a twin while the audio
        // items accumulate — which is a different intervention from the one under test, and it is what
        // the previous run of this arm measured without saying so.
        const audioItems = itemsCreatedSince(session, 0).filter((c) => {
          const item = c.item as { type?: unknown; role?: unknown; content?: Array<{ type?: unknown }> };
          return item.type === 'message' && item.role === 'user' && item.content?.[0]?.type === 'input_audio';
        });
        const mine = audioItems[turns.length];
        current = {
          index: turns.length,
          transcript: String(event.wire.transcript ?? ''),
          audioItemIds: mine === undefined ? [] : [mine.id],
          itemShape: mine === undefined ? null : mine.item,
          delivered: [],
          replies: [],
          swapped: [],
        };
        turns.push(current);
      }
    }
    eventCursor = session.events.length;

    if (current !== null) {
      for (const call of session.functionCalls.slice(callCursor)) {
        try {
          current.delivered.push((JSON.parse(call.arguments) as { message?: string }).message ?? call.arguments);
        } catch {
          current.delivered.push(call.arguments);
        }
      }
      current.replies.push(...responseTexts(session, 0).slice(current.replies.length));
    }
    callCursor = session.functionCalls.length;

    // The turn is settled once its response(s) have landed and the tool round-trip has played out.
    const settled = session.responses.length > responseCursor;
    responseCursor = session.responses.length;
    if (allowSwap && mode !== 'keep' && current !== null && settled && current.swapped.length === 0) {
      // `twin` retires the utterance's AUDIO item and re-creates the words as text; `aggressive`
      // retires everything the turn created — the cut that fabricated messages in the synthetic arm.
      const doomed = mode === 'aggressive'
        ? itemsCreatedSince(session, 0).map((c) => c.id).filter((id) => !retired.has(id))
        : current.audioItemIds;
      for (const id of doomed) {
        retired.add(id);
        current.swapped.push(await deleteItem(session, id));
      }
      if (mode === 'twin' && current.transcript !== '') createUserText(session, current.transcript);
    }
  };

  for (let i = 0; i < frames.length; i++) {
    const decision = await gate.observe(frames[i]);
    lastStats = {
      sent: decision.sent,
      headKept: decision.headKept,
      heldOpen: decision.heldOpen,
      dropped: decision.dropped,
      bypassed: decision.bypassed,
      preRoll: decision.preRoll,
    };
    for (const frame of decision.frames) session.sendAudioBase64(frame);
    if (decision.closeTurn) session.sendRaw({ type: 'input_audio_buffer.commit' });
    await absorb(true);

    const deadline = startedAt + (i + 1) * 20;
    const wait = deadline - Date.now();
    if (wait > 0) await sleep(wait);
    else driftMs = Math.max(driftMs, -wait);
  }

  // Drain: the endpoint still owes the tail of whatever the last frames committed.
  await sleep(8_000);
  await absorb(false);
  const reads = session.responses.map((_, i) => read(session, i));

  await gate.close();
  await session.close();
  return {
    mode,
    span: spanSpec,
    upstreamTurnDetection: 'server_vad 0.5/400 — this probe never sends response.create',
    gate: { aFrames: gate.aFrames, preRollFrames: gate.preRollFrames, stats: lastStats },
    streamedFrames: frames.length,
    streamedSeconds: (frames.length * 20) / 1_000,
    realtimeDriftMs: driftMs,
    turns,
    readings: reads,
    transcripts: turns.map((t) => t.transcript),
  };
};

// ── arm 11: does the delivered text come out in the order the person spoke? ─────────────────────

/**
 * ONE spanB twin run delivered `[1]。[0]，[2]` in a single `session_send` — the person's sentences in
 * the wrong order. Merging fragments into one message is fine (the relay is told to join the pieces
 * of one sentence); reordering them is not, because Claude Code reads the order as the order things
 * were said.
 *
 * HYPOTHESIS (to be confirmed or refuted by this arm, not assumed): the twin recipe APPENDS the text
 * stand-in to the end of the conversation. When the person keeps talking, the NEXT utterance's audio
 * item already exists by the time the stand-in is appended, so the conversation reads
 * `audio[1], text[0]` and the model relays it in that order.
 *
 * So this arm records the conversation itself, not only the deliveries: a mirror of the live items
 * (built from the endpoint's own `conversation.item.created` / `previous_item_id` / `deleted` frames,
 * so it shows where the endpoint actually put an item rather than where the probe asked for it), and
 * a snapshot of the user items' order at every `response.created`. Each delivered message is kept
 * with the snapshot of the response that produced it, so an inverted delivery can be checked against
 * an inverted context directly.
 *
 * Three arms, identical trigger: `keep` (production today), `twin-append` (the recipe exactly as the
 * anomalous run executed it), and `twin-inplace` (stand-in inserted right after the audio item via
 * `previous_item_id`, then the audio deleted — the stand-in takes the audio's own slot).
 *
 * Analysis is OFFLINE (`analyze-order.mjs`) from the raw record, so the scoring can be revised without
 * paying for the audio again.
 */
type OrderMode = 'keep' | 'twin-append' | 'twin-inplace';

const armOrder = async (
  run: ReturnType<typeof createRun>,
  mode: OrderMode,
  rep: number,
  spanSpec: { name: string; startMs: number; endMs: number },
  capture: string = CAPTURE_LONG,
): Promise<Record<string, unknown>> => {
  const classifier = await createUplinkVadClassifier({ backend: 'silero', weightsPath: UPLINK_VAD_WEIGHTS });
  const gate = createUplinkVadGate({ classifier, silenceDurationMs: 400 });
  const session = await openSession({
    run,
    label: `order-${mode}-${spanSpec.name}-${rep}`,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    sessionDefaults: sessionBody(),
    tools: [SESSION_SEND_TOOL],
    executor: { session_send: () => SESSION_SEND_RESULT },
  });

  const { sampleRate, pcm } = wavPcm(capture);
  const span = pcm.subarray(
    Math.floor((sampleRate * spanSpec.startMs) / 1_000) * 2,
    Math.floor((sampleRate * spanSpec.endMs) / 1_000) * 2,
  );
  const frames: string[] = [];
  for (let offset = 0; offset + 640 <= span.length; offset += 640) {
    frames.push(span.subarray(offset, offset + 640).toString('base64'));
  }

  // ---- the conversation mirror ----
  const live: string[] = [];
  const kindOf = new Map<string, { kind: 'audio' | 'text' | 'other'; turn: number | null; role: string; type: string }>();
  const itemsLog: Array<Record<string, unknown>> = [];
  const pendingTwinTurns: number[] = [];
  let audioCount = 0;
  const transcripts: Array<{ turn: number; itemId: string; text: string; atMs: number }> = [];
  const responses: Array<{ id: string; startedAtMs: number; doneAtMs: number | null; context: string[]; calls: string[]; text: string[] }> = [];
  let inFlight: (typeof responses)[number] | null = null;
  const seenCalls = new Set<string>();
  const orphanCalls: string[] = [];
  const swapLog: Array<Record<string, unknown>> = [];
  let current: number | null = null;
  const swapped = new Set<number>();
  let responsesDone = 0;
  let responsesSeen = 0;
  let cursor = 0;
  let driftMs = 0;
  let lastStats: Record<string, number> = {};
  const t0 = Date.now();

  const label = (id: string): string | null => {
    const k = kindOf.get(id);
    if (k === undefined || k.kind === 'other') return null;
    return `${k.kind === 'audio' ? 'A' : 'T'}${k.turn ?? '?'}`;
  };
  const messageOf = (args: unknown): string => {
    try {
      return String((JSON.parse(String(args)) as { message?: unknown }).message ?? args);
    } catch {
      return String(args);
    }
  };

  const absorbEvents = (): void => {
    for (const event of session.events.slice(cursor)) {
      if (event.direction !== 'received') continue;
      const w = event.wire as Record<string, unknown>;
      const type = w.type;
      if (type === 'input_audio_buffer.speech_started') gate.noteUpstreamTurn(true);
      if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.committed') gate.noteUpstreamTurn(false);
      if (type === 'conversation.item.created') {
        const item = (w.item ?? {}) as { id?: string; type?: string; role?: string; content?: Array<{ type?: string; text?: string }> };
        if (typeof item.id !== 'string') continue;
        const prev = w.previous_item_id;
        const at = typeof prev === 'string' && live.includes(prev) ? live.indexOf(prev) + 1 : live.length;
        live.splice(at, 0, item.id);
        const contentType = item.content?.[0]?.type;
        let kind: 'audio' | 'text' | 'other' = 'other';
        let turn: number | null = null;
        if (item.type === 'message' && item.role === 'user' && contentType === 'input_audio') {
          kind = 'audio';
          turn = audioCount++;
        } else if (item.type === 'message' && item.role === 'user' && contentType === 'input_text') {
          kind = 'text';
          turn = pendingTwinTurns.shift() ?? null;
        }
        kindOf.set(item.id, { kind, turn, role: String(item.role ?? ''), type: String(item.type ?? '') });
        itemsLog.push({
          atMs: Date.now() - t0,
          event: 'created',
          id: item.id,
          label: label(item.id),
          type: item.type,
          role: item.role ?? null,
          previous_item_id: prev ?? null,
          placedAfter: at === 0 ? null : live[at - 1],
          appended: at === live.length - 1,
        });
      }
      if (type === 'conversation.item.deleted' && typeof w.item_id === 'string') {
        const i = live.indexOf(w.item_id);
        if (i >= 0) live.splice(i, 1);
        itemsLog.push({ atMs: Date.now() - t0, event: 'deleted', id: w.item_id, label: label(w.item_id), wasLive: i >= 0 });
      }
      if (type === 'conversation.item.input_audio_transcription.completed') {
        const itemId = typeof w.item_id === 'string' ? w.item_id : '';
        const k = kindOf.get(itemId);
        const turn = k?.kind === 'audio' && k.turn !== null ? k.turn : transcripts.length;
        transcripts.push({ turn, itemId, text: String(w.transcript ?? ''), atMs: Date.now() - t0 });
        current = turn;
      }
      if (type === 'response.created') {
        const r = (w.response ?? {}) as { id?: string };
        responsesSeen += 1;
        inFlight = {
          id: String(r.id ?? ''),
          startedAtMs: Date.now() - t0,
          doneAtMs: null,
          context: live.map(label).filter((x): x is string => x !== null),
          calls: [],
          text: [],
        };
        responses.push(inFlight);
      }
      const callId =
        type === 'response.function_call_arguments.done'
          ? String(w.call_id ?? '')
          : type === 'response.output_item.done' && (w.item as { type?: string } | undefined)?.type === 'function_call'
            ? String((w.item as { call_id?: string }).call_id ?? '')
            : null;
      if (callId !== null && callId !== '' && !seenCalls.has(callId)) {
        seenCalls.add(callId);
        const args = type === 'response.function_call_arguments.done' ? w.arguments : (w.item as { arguments?: unknown }).arguments;
        const message = messageOf(args);
        if (inFlight !== null) inFlight.calls.push(message);
        else orphanCalls.push(message);
      }
      if (type === 'response.text.done' && typeof w.text === 'string' && inFlight !== null) inFlight.text.push(w.text);
      if (type === 'response.done') {
        if (inFlight !== null) inFlight.doneAtMs = Date.now() - t0;
        inFlight = null;
        responsesDone += 1;
      }
    }
    cursor = session.events.length;
  };

  let swapCheckedAt = 0;
  const maybeSwap = async (): Promise<void> => {
    // SAME TRIGGER as the anomalous run (`armProduction`): when a response has finished since the last
    // check, the latest transcribed turn is swapped — once. Identical across both twin arms, so the
    // only thing that differs between them is where the stand-in goes.
    if (responsesDone <= swapCheckedAt) return;
    swapCheckedAt = responsesDone;
    if (mode === 'keep' || current === null || swapped.has(current)) return;
    const turn = current;
    const t = transcripts.find((x) => x.turn === turn);
    const audioId = t?.itemId && kindOf.get(t.itemId)?.kind === 'audio' ? t.itemId : [...kindOf.entries()].find(([, v]) => v.kind === 'audio' && v.turn === turn)?.[0];
    swapped.add(turn);
    if (audioId === undefined || t === undefined || t.text === '') {
      swapLog.push({ turn, skipped: true, reason: audioId === undefined ? 'no audio item' : 'empty transcript' });
      return;
    }
    const before = live.map(label).filter((x): x is string => x !== null);
    if (mode === 'twin-inplace') {
      pendingTwinTurns.push(turn);
      createUserText(session, t.text, audioId);
      const outcome = await deleteItem(session, audioId);
      swapLog.push({ turn, atMs: Date.now() - t0, outcome, before });
    } else {
      const outcome = await deleteItem(session, audioId);
      pendingTwinTurns.push(turn);
      createUserText(session, t.text);
      swapLog.push({ turn, atMs: Date.now() - t0, outcome, before });
    }
  };

  for (let i = 0; i < frames.length; i++) {
    const decision = await gate.observe(frames[i]);
    lastStats = { sent: decision.sent, dropped: decision.dropped, headKept: decision.headKept, heldOpen: decision.heldOpen };
    for (const frame of decision.frames) session.sendAudioBase64(frame);
    if (decision.closeTurn) session.sendRaw({ type: 'input_audio_buffer.commit' });
    absorbEvents();
    await maybeSwap();
    absorbEvents();
    const wait = t0 + (i + 1) * 20 - Date.now();
    if (wait > 0) await sleep(wait);
    else driftMs = Math.max(driftMs, -wait);
  }
  // Drain, still absorbing, so a late swap and its response are recorded on the same terms.
  const drainUntil = Date.now() + 9_000;
  while (Date.now() < drainUntil) {
    absorbEvents();
    await maybeSwap();
    await sleep(50);
  }
  absorbEvents();

  await gate.close();
  await session.close();
  return {
    mode,
    rep,
    span: spanSpec,
    capture: path.basename(capture),
    gate: lastStats,
    realtimeDriftMs: driftMs,
    responsesSeen,
    transcripts,
    responses,
    orphanCalls,
    swapLog,
    itemsLog,
    finalContext: live.map(label).filter((x): x is string => x !== null),
  };
};

// ── arm 8: the control for the unexplained text term ─────────────────────────────────────────────

/**
 * Both twin arms read ~45 text tokens LOWER than their keep counterpart, and the audio item's own
 * text footprint was measured at 6 (tier 2a: 302 → 296 across a bare delete). So the audio column
 * does not account for it, and an unexplained number in a cost model is a number nobody can bank.
 *
 * This control removes every confound the twin arms carried: no audio, no model reply in between, no
 * difference in what the two arms were asked. Both sessions receive the SAME text item and the same
 * `response.create`; only the second one deletes the item and re-creates it verbatim. The text delta
 * between the two readings is then the delete-and-reinsert cost itself, and nothing else.
 */
const CONTROL_TEXT = '现在是十月十五日，来我写第四十车。';

const armControl = async (run: ReturnType<typeof createRun>): Promise<Record<string, unknown>> => {
  const sessions = await Promise.all(
    ['control-plain', 'control-swap'].map((label) =>
      openSession({
        run,
        label,
        instructions: 'You are a voice relay. Pass on everything the user says by calling session_send. Never reply in text.',
        sessionDefaults: sessionBody({ turn_detection: null }),
        tools: [SESSION_SEND_TOOL],
        executor: { session_send: () => SESSION_SEND_RESULT },
      }),
    ),
  );
  const [plain, swap] = sessions;
  const readings: Record<string, unknown> = {};

  for (const session of sessions) {
    createUserText(session, CONTROL_TEXT);
    await ask(session);
  }
  // The `swap` arm's item is the one just created by its own item.create; find it on the wire.
  const created = itemsCreatedSince(swap, 0).filter((c) => {
    const item = c.item as { type?: unknown; role?: unknown };
    return item.type === 'message' && item.role === 'user';
  });
  const last = created[created.length - 1];
  const outcome = last ? await deleteItem(swap, last.id) : 'none';
  if (last) createUserText(swap, CONTROL_TEXT);

  for (const session of sessions) await ask(session);

  readings.plain = { deleteOutcome: 'n/a', reading: read(plain, 1) };
  readings.swap = { deleteOutcome: outcome, reading: read(swap, 1) };
  await Promise.all(sessions.map((s) => s.close()));
  return {
    text: CONTROL_TEXT,
    ...readings,
    textDelta: (readings.plain as { reading: { text: number } }).reading.text - (readings.swap as { reading: { text: number } }).reading.text,
    audioDelta: (readings.plain as { reading: { audio: number } }).reading.audio - (readings.swap as { reading: { audio: number } }).reading.audio,
  };
};

// ── the run ──────────────────────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const arms =
    wanted.length === 0 || wanted.includes('all')
      ? ['prefix', 'tools', 'audio', 'behaviour', 'tier2', 'tier2b', 'tier3', 'tier4', 'tier5', 'tier6', 'tier7', 'rate', 'production', 'order', 'control']
      : wanted;

  const run = createRun({ budgetCny: BUDGET_CNY, apiKey: readApiKey() });
  console.log(`budget ¥${BUDGET_CNY} · arms: ${arms.join(', ')}`);

  const results: Record<string, unknown> = {};
  const started = Date.now();

  // Every arm runs CONCURRENTLY — they are independent sockets and the run's budget is shared, so a
  // runaway in one arm closes them all rather than being discovered after the others have finished.
  const pending: Array<Promise<void>> = [];
  if (arms.includes('prefix')) pending.push(armPrefix(run).then((r) => { results.prefix = r; }));
  if (arms.includes('tools')) pending.push(armTools(run).then((r) => { results.tools = r; }));
  if (arms.includes('audio')) pending.push(armAudio(run).then((r) => { results.audio = r; }));
  if (arms.includes('behaviour')) {
    pending.push(
      Promise.all([oneBehaviourArm(run, 'behaviour-keep', false), oneBehaviourArm(run, 'behaviour-prune', true)]).then(
        ([keep, prune]) => {
          results.behaviour = { keep, prune };
        },
      ),
    );
  }
  if (arms.includes('tier2')) {
    pending.push(
      Promise.all([armAudioTranscript(run), armPlumbing(run, false), armPlumbing(run, true)]).then(
        ([transcriptSurvival, plumbingKeep, plumbingPrune]) => {
          results.tier2 = { transcriptSurvival, plumbingKeep, plumbingPrune };
        },
      ),
    );
  }
  if (arms.includes('tier2b')) {
    pending.push(
      Promise.all([armAudioTwin(run, 'twin'), armAudioTwin(run, 'keep'), armPlumbing(run, true), armPlumbing(run, false)]).then(
        ([twin, keep, plumbingPrune, plumbingKeep]) => {
          results.tier2b = { twin, keep, plumbingPrune, plumbingKeep };
        },
      ),
    );
  }
  if (arms.includes('tier3')) {
    const longFollowUps = ['接着转这一句。', '再转一句，明天见。', '最后一句，收工。', '补一句，先别动线上。', '再说一句，缓存那条看过了。'];
    pending.push(
      Promise.all([
        armAudioTwin(run, 'twin', { seconds: 6, followUps: longFollowUps, memoryProbe: true }),
        armAudioTwin(run, 'keep', { seconds: 6, followUps: longFollowUps, memoryProbe: true }),
        armPlumbing(run, true, PLUMBING_LONG, 'plumbing12'),
        armPlumbing(run, false, PLUMBING_LONG, 'plumbing12'),
      ]).then(([twin, keep, plumbingPrune, plumbingKeep]) => {
        results.tier3 = { twin, keep, plumbingPrune, plumbingKeep };
      }),
    );
  }
  if (arms.includes('tier4')) {
    pending.push(
      Promise.all([armAudioSemantic(run, 'twin'), armAudioSemantic(run, 'keep')]).then(([twin, keep]) => {
        results.tier4 = { twin, keep };
      }),
    );
  }
  if (arms.includes('tier7')) {
    // Same count, different SET: the 12-utterance pair came out 6/12 vs 6/12, but `keep` delivered
    // utterances 1-6 in a row while `prune` delivered 1,2,4,5,7,8 — skipping two the other arm sent.
    // A count is not a delivery, so this repeats the pair at a horizon where neither arm collapses,
    // twice, to say whether the mid-stream skip reproduces.
    const SHORT = PLUMBING_UTTERANCES.slice(0, 8);
    pending.push(
      Promise.all([
        armPlumbing(run, false, SHORT, 'rep1'),
        armPlumbing(run, true, SHORT, 'rep1'),
        armPlumbing(run, false, SHORT, 'rep2'),
        armPlumbing(run, true, SHORT, 'rep2'),
      ]).then(([keep1, prune1, keep2, prune2]) => {
        results.tier7 = { keep1, prune1, keep2, prune2 };
      }),
    );
  }
  if (arms.includes('production')) {
    pending.push(
      Promise.all(
        productionSpans(run).flatMap((spanSpec: { name: string; startMs: number; endMs: number }) => [
          armProduction(run, 'keep', 0, spanSpec),
          armProduction(run, 'twin', 0, spanSpec),
        ]),
      ).then((armsRun) => {
        results.production = Object.fromEntries(
          armsRun.map((arm) => [`${String((arm.span as { name: string }).name)}-${String(arm.mode)}`, arm]),
        );
      }),
    );
  }
  if (arms.includes('order')) {
    const spanNames = (process.env.ORDER_SPANS ?? 'spanB').split(',');
    const reps = Number(process.env.ORDER_REPS ?? 3);
    const modes = (process.env.ORDER_MODES ?? 'keep,twin-append,twin-inplace').split(',') as OrderMode[];
    const spans = productionSpans(run).filter((s) => spanNames.includes(s.name));
    const jobs: Array<Promise<Record<string, unknown>>> = [];
    for (const spanSpec of spans) {
      for (const mode of modes) {
        const modeReps = Number(process.env[`ORDER_REPS_${mode.replace('-', '_')}`] ?? reps);
        for (let rep = 0; rep < modeReps; rep++) jobs.push(armOrder(run, mode, rep, spanSpec));
      }
    }
    pending.push(
      Promise.allSettled(jobs).then((settled) => {
        results.order = settled.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason) }));
      }),
    );
  }
  if (arms.includes('rate')) pending.push(armRate(run).then((r) => { results.rate = r; }));
  if (arms.includes('tier6')) {
    // The surviving half of ⑤, tested on the axis that matters: does the relay still deliver the
    // user's words when the tool schema is the probe's minimal one instead of the shipping pair?
    // No prose is invented here — the instructions are byte-identical between the two arms, so the
    // only difference is 460 tokens of schema.
    pending.push(
      Promise.all([
        armEcho(run, 'plain', { label: 'schema-shipping', tools: VOICE_REALTIME_TOOLS }),
        armEcho(run, 'plain', { label: 'schema-minimal', tools: [SESSION_SEND_TOOL] }),
      ]).then(([shipping, minimal]) => {
        results.tier6 = { shipping, minimal };
      }),
    );
  }
  if (arms.includes('tier5')) {
    pending.push(
      Promise.all([
        armEcho(run, 'swap'),
        armEcho(run, 'plain'),
        armEcho(run, 'inplace'),
        armSilence(run, 'twin'),
        armSilence(run, 'keep'),
      ]).then(([echoSwap, echoPlain, echoInplace, silenceTwin, silenceKeep]) => {
        results.tier5 = { echoSwap, echoPlain, echoInplace, silenceTwin, silenceKeep };
      }),
    );
  }
  if (arms.includes('control')) pending.push(armControl(run).then((r) => { results.control = r; }));
  await Promise.allSettled(pending);

  const payload = {
    schema: 'voice-realtime-prefix-history-pruning/1',
    ranAt: new Date().toISOString(),
    budgetCny: BUDGET_CNY,
    spendCny: Number(run.spendCny.toFixed(6)),
    guardTriggered: run.guardTriggered,
    guardClosedSessions: run.guardClosedSessions,
    elapsedMs: Date.now() - started,
    estimatorCheck: estimateRealtimeCostCny({ input_tokens: 1258, output_tokens: 30, input_tokens_details: { text_tokens: 1230, audio_tokens: 28 } }),
    results,
  };

  mkdirSync(TRACES_DIR, { recursive: true });
  // UNIQUE PER RUN. The production arm was invoked five times and wrote the same name each time, so
  // four runs of delivered text survived only in the terminal. A trace that a re-run can overwrite is
  // not evidence.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(TRACES_DIR, `tier1-${arms.join('-')}-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\nspend ¥${payload.spendCny} of ¥${BUDGET_CNY} · guard=${payload.guardTriggered} · ${payload.elapsedMs} ms`);
  console.log(`trace: ${file}`);
  console.log(JSON.stringify(results, null, 2));
  // The socket's own close is the process's exit condition; nothing else keeps the loop alive.
  process.exit(0);
};

void main();
