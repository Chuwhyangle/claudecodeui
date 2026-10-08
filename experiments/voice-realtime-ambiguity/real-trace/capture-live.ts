/**
 * Manual live capture for AC-308's real half.
 *
 * This is NOT a test and NOT part of any criterion. It is the one-time runner a
 * human executes, with a real credential in the environment, to preserve a REAL
 * DashScope exchange into this directory. Everything it records crosses a real
 * socket to `wss://dashscope.aliyuncs.com`, so nothing here can run in CI and
 * nothing here is re-executed by the criterion — the criterion replays the
 * preserved JSON instead.
 *
 * The capture drives the SHIPPING transport (`createDashscopeTransport`) under
 * the real bridge (`connect`), through a recording `socketFactory`, so the trace
 * it writes is the transport's own framed traffic — not a hand-rolled probe's.
 * The one thing the bridge cannot express is the text turn that deterministically
 * triggers a tool call, so that single frame pair is appended raw; both frames are
 * recorded exactly like the transport's own.
 *
 * Run (from the repo root, on a machine with network egress and a live key):
 *
 *     set -a; source /data/home/yale/work/claudecodeui/.env.test; set +a
 *     npx tsx experiments/voice-realtime-ambiguity/real-trace/capture-live.ts \
 *         --model qwen3.5-omni-flash-realtime --out function-call-trace.json
 *
 * `--model` defaults to the tool-capable sibling. The GOAL-030 task names
 * `qwen3-omni-flash-realtime`; capture that model too (with `--out
 * named-model-connect.json`) to record its accepted connection + audio
 * transcription and its dropped `session.tools`. See README.md.
 *
 * Credential hygiene: the key travels in the `Authorization` HEADER only (never
 * the URL, never a frame), and the writer scrubs any accidental occurrence of it
 * from the serialized trace before writing. Headers are never recorded at all.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import {
  DASHSCOPE_REALTIME_ENDPOINT,
  connect,
  createDashscopeTransport,
  REALTIME_TOOLS,
  type DashscopeSocket,
  type RealtimeToolExecutor,
} from '../../../server/modules/voice-realtime/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

type ExchangeEntry = {
  direction: 'sent' | 'received';
  atMs: number;
  sinceOpenMs: number;
  wire: Record<string, unknown>;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads `--flag value` pairs off argv. */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    out[token.slice(2)] = argv[index + 1] ?? '';
    index += 1;
  }
  return out;
}

/** Polls `predicate` until it is true or the deadline passes. Returns whether it became true. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const model = args.model ?? 'qwen3.5-omni-flash-realtime';
  const outName = args.out ?? 'function-call-trace.json';
  const audioRel = args.audio ?? 'experiments/voice-provider-paired-quality/fixtures/d05-o65.wav';
  const audioPath = path.resolve(REPO_ROOT, audioRel);

  const key = process.env.DASHSCOPE_API_KEY ?? '';
  if (key === '') {
    console.error('DASHSCOPE_API_KEY is not set; source .env.test with `set -a` first.');
    process.exit(2);
  }

  /**
   * The response frame type(s) each request frame is answered by. A latency is
   * only recorded when a request meets ITS OWN response type — pairing on frame
   * order instead would mis-pair an unsolicited echo and record a fake 0 ms.
   */
  const RESPONSE_TYPES: Readonly<Record<string, readonly string[]>> = {
    'session.update': ['session.updated', 'session.created'],
    'input_audio_buffer.append': ['input_audio_buffer.committed', 'conversation.item.input_audio_transcription.completed'],
    'conversation.item.create': ['conversation.item.created'],
    'response.create': ['response.created'],
  };

  /** A monotonic microsecond clock, so two events never share a timestamp and a real RTT is never 0. */
  const hrMs = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;

  // ── the recording seam ───────────────────────────────────────────────────────────────────────
  const exchange: ExchangeEntry[] = [];
  const latenciesMs: number[] = [];
  /** Sent request timestamps, queued per expected response type. */
  const pendingByResponseType = new Map<string, number[]>();
  let openedAt = 0;
  let rawSocket: WebSocket | null = null;
  let observedSessionId: string | null = null;
  let observedConversationId: string | null = null;

  /** Queues a sent request's timestamp under each response type it expects. */
  function noteRequest(type: string): void {
    for (const responseType of RESPONSE_TYPES[type] ?? []) {
      const queue = pendingByResponseType.get(responseType) ?? [];
      queue.push(hrMs());
      pendingByResponseType.set(responseType, queue);
    }
  }

  /** Pairs an arriving response with the oldest matching request and records the real round trip. */
  function noteResponse(type: string): void {
    const queue = pendingByResponseType.get(type);
    if (queue === undefined || queue.length === 0) return;
    const sentAt = queue.shift() as number;
    latenciesMs.push(Number((hrMs() - sentAt).toFixed(3)));
  }

  function observeWire(entry: ExchangeEntry): void {
    exchange.push(entry);
    const { wire } = entry;
    if (wire.type === 'session.created' || wire.type === 'session.updated') {
      const session = wire.session as Record<string, unknown> | undefined;
      if (typeof session?.id === 'string') observedSessionId = session.id;
      if (typeof session?.conversation_id === 'string') observedConversationId = session.conversation_id;
    }
    if (typeof wire.conversation_id === 'string') observedConversationId = wire.conversation_id;
    const response = wire.response as Record<string, unknown> | undefined;
    if (typeof response?.conversation_id === 'string') observedConversationId = response.conversation_id;
  }

  /** Records and sends one raw wire frame — used for the frames the bridge cannot express. */
  function sendRawWire(wire: unknown, label: string): void {
    const now = Date.now();
    observeWire({ direction: 'sent', atMs: now, sinceOpenMs: now - openedAt, wire: wire as Record<string, unknown> });
    noteRequest((wire as { type: string }).type);
    console.log(`>> [${label}]`, JSON.stringify(wire).slice(0, 200));
    rawSocket?.send(JSON.stringify(wire));
  }

  const recordingFactory = (url: string, headers: Readonly<Record<string, string>>): DashscopeSocket => {
    const ws = new WebSocket(url, { headers });
    rawSocket = ws;
    const socket: DashscopeSocket = {
      send(data: string) {
        const now = Date.now();
        const wire = JSON.parse(data) as Record<string, unknown>;
        observeWire({ direction: 'sent', atMs: now, sinceOpenMs: now - openedAt, wire });
        noteRequest(String(wire.type));
        ws.send(data);
      },
      close(code?: number, reason?: string) {
        ws.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    ws.on('open', () => {
      openedAt = Date.now();
      socket.onopen?.({});
    });
    ws.on('message', (data) => {
      const now = Date.now();
      const text = data.toString();
      let wire: Record<string, unknown>;
      try {
        wire = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      observeWire({ direction: 'received', atMs: now, sinceOpenMs: now - openedAt, wire });
      // The real round trip for the oldest request awaiting THIS response type.
      noteResponse(String(wire.type));
      console.log('<<', now - openedAt, wire.type, JSON.stringify(wire).slice(0, 300));
      socket.onmessage?.({ data: text });
    });
    ws.on('error', (error) => {
      console.error('!! socket error', error instanceof Error ? error.message : String(error));
      socket.onerror?.(error);
    });
    ws.on('close', (code, reason) => {
      socket.onclose?.({ code, reason: String(reason) });
    });
    return socket;
  };

  // ── the capture ──────────────────────────────────────────────────────────────────────────────
  const ran: string[] = [];
  const executor: RealtimeToolExecutor = {
    ui_visible_context: () => {
      ran.push('ui_visible_context');
      return { devices: [{ client: 'capture-browser', title: 'live capture', url: 'https://example.invalid/' }] };
    },
  };

  const transport = createDashscopeTransport({
    model,
    socketFactory: recordingFactory,
    onError: (error) => console.error('!! transport error', JSON.stringify(error)),
  });
  const bridge = connect(transport, REALTIME_TOOLS, executor, { maxConnectAttempts: 1 });
  await bridge.whenConnected();
  console.log('connected:', transport.url);

  bridge.sendSessionUpdate(
    'You are a voice UI controller for a coding workspace. You cannot answer directly: whenever the user asks anything about the screen or the session, you MUST call the ui_visible_context tool instead of replying in text.',
  );
  await sleep(1500);

  // Real speech (16 kHz mono PCM16, WAV header stripped) — the server VAD can turn on this.
  const wav = readFileSync(audioPath);
  const pcm = wav.subarray(44);
  console.log(`audio: ${pcm.length} bytes (${(pcm.length / 2 / 16000).toFixed(2)}s)`);
  bridge.sendAudioFrame(pcm.toString('base64'));
  await sleep(800);

  // A text turn — the deterministic trigger for a model-initiated tool call.
  sendRawWire(
    {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '现在屏幕上有什么？请调用工具查看。' }] },
    },
    'text-turn',
  );
  sendRawWire({ type: 'response.create' }, 'response.create');

  const gotCall = await waitUntil(() => ran.length > 0, 25000);
  console.log(gotCall ? 'model issued a function call' : 'NO function call within the window');
  if (gotCall) {
    // Let the bridge send the function_call_output and the resumed turn complete.
    await waitUntil(() => exchange.some((entry) => entry.direction === 'sent' && entry.wire.type === 'conversation.item.create'), 5000);
    await sleep(2500);
  }

  await bridge.close();
  await sleep(300);

  // ── the trace ────────────────────────────────────────────────────────────────────────────────
  const audioSha = createHash('sha256').update(wav).digest('hex');
  const audioDir = path.join(HERE, 'audio');
  mkdirSync(audioDir, { recursive: true });
  copyFileSync(audioPath, path.join(audioDir, path.basename(audioPath)));

  const functionCalls: Array<{ callId: string; name: string; arguments: string; source: string; atMs: number }> = [];
  for (const entry of exchange) {
    if (entry.direction !== 'received') continue;
    const wire = entry.wire;
    if (wire.type === 'response.function_call_arguments.done' && typeof wire.call_id === 'string') {
      functionCalls.push({
        callId: wire.call_id,
        name: String(wire.name ?? ''),
        arguments: String(wire.arguments ?? ''),
        source: 'model',
        atMs: entry.atMs,
      });
    }
    if (wire.type === 'response.output_item.done') {
      const item = wire.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call' && typeof item.call_id === 'string' && !functionCalls.some((call) => call.callId === item.call_id)) {
        functionCalls.push({
          callId: item.call_id,
          name: String(item.name ?? ''),
          arguments: String(item.arguments ?? ''),
          source: 'model',
          atMs: entry.atMs,
        });
      }
    }
  }

  // The audio frame is ~320 kB of base64 and would dwarf everything else. Its
  // exact bytes are preserved as `audio/d05-o65.wav`, so the frame keeps its
  // type and its byte count and drops only the payload — `audioBytes` is the
  // decoded PCM length, and the file is the payload.
  for (const entry of exchange) {
    if (entry.wire.type === 'input_audio_buffer.append' && typeof entry.wire.audio === 'string') {
      entry.wire = {
        ...entry.wire,
        audioBytes: Math.floor((entry.wire.audio as string).length * 0.75),
        audio: '<elided: see audio/ file; decoded PCM bytes are audioBytes>',
      };
    }
  }

  const trace = {
    schema: 'voice-realtime-dashscope-trace/1',
    generatedAt: new Date().toISOString(),
    endpoint: DASHSCOPE_REALTIME_ENDPOINT,
    model,
    session: { id: observedSessionId, conversationId: observedConversationId },
    audio: {
      file: path.posix.join('audio', path.basename(audioPath)),
      sha256: audioSha,
      durationSeconds: Number((pcm.length / 2 / 16000).toFixed(3)),
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    },
    exchange,
    latenciesMs,
    functionCalls,
  };

  // Sanitise: never let the credential reach disk, even if a frame echoed it.
  let serialized = JSON.stringify(trace, null, 2);
  let scrubbed = 0;
  if (key !== '') {
    scrubbed = serialized.split(key).length - 1;
    serialized = serialized.split(key).join('<redacted>');
  }
  if (serialized.includes('Authorization')) {
    throw new Error('refusing to write a trace that carries an Authorization header');
  }

  const outPath = path.join(HERE, outName);
  writeFileSync(outPath, `${serialized}\n`, 'utf8');
  console.log(`wrote ${outPath}`);
  console.log(`  model=${model} session=${observedSessionId} frames=${exchange.length} calls=${functionCalls.length} latencies=${latenciesMs.length} scrubbed=${scrubbed}`);
  if (functionCalls.length === 0) {
    console.error('  WARNING: no model-initiated function call was captured — this trace cannot satisfy AC-308 AC3.');
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error('capture failed:', error);
  process.exit(1);
});
