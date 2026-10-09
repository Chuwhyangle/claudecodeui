/**
 * Test-only harness for the DashScope realtime transport criteria.
 *
 * THREE PIECES, all seam-shaped on purpose:
 *
 *  - {@link createFakeDashscopeServer} is the fake WS server the transport is
 *    driven over. It implements {@link DashscopeSocketFactory}, records every
 *    client frame it was handed, and answers with the DashScope dialect's real
 *    event shapes (`session.created`, `response.function_call_arguments.done`,
 *    `response.done`) so the transport's translation is exercised. It never
 *    touches a socket, so the whole round trip is offline.
 *  - {@link replayTraceThroughFixture} feeds a preserved REAL trace's client
 *    frames through the SAME fixture and returns what the fixture produced. That
 *    is AC-308's non-determinism check: a fixture is a deterministic stand-in, so
 *    its output must differ from the real endpoint's on a real-only field.
 *  - {@link readRealtimeTrace} reads a preserved live trace from
 *    `experiments/voice-realtime-ambiguity/real-trace/`.
 *
 * Not a `*.test.ts` on purpose: it is a helper both criteria import, and it must
 * not move the suite's test-file count.
 *
 * Consumers: `voice-realtime-dashscope-transport.test.ts` (AC1's round trip) and
 * `voice-realtime-dashscope-transport.false-forms.test.ts` (AC4's replay form).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DashscopeSocket, DashscopeSocketFactory } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `<repo>/experiments/voice-realtime-ambiguity/real-trace` — the preserved live traces. */
export const REAL_TRACE_DIR = path.resolve(HERE, '../../../../experiments/voice-realtime-ambiguity/real-trace');

/** The fixture's knobs. Every one is a constant, which is exactly what makes it a stand-in. */
export type FakeDashscopeServerOptions = {
  /** The session id the fixture claims. Deliberately not `sess_`-real-shaped beyond the prefix. */
  sessionId?: string;
  /** The call id the fixture announces. */
  callId?: string;
  /** The tool name the fixture claims the model chose. */
  toolName?: string;
  /** The arguments the fixture claims the model produced. */
  toolArguments?: string;
  /** How many audio frames to accept before announcing the function call. Default 1. */
  functionCallAfterAudioFrames?: number;
  /** Refuse the first N `open()`s, so the bridge's reconnect path can be driven. */
  failOpens?: number;
};

/** What the fake server exposes: the factory the transport dials, plus the two traffic logs. */
export type FakeDashscopeServer = {
  /** Inject this as `socketFactory`. */
  readonly socketFactory: DashscopeSocketFactory;
  /** Every client frame (parsed), in order. */
  readonly sent: Array<Record<string, unknown>>;
  /** Every server frame the fixture emitted, in order. */
  readonly emitted: Array<Record<string, unknown>>;
  /** How many sockets the transport has dialled. */
  readonly openCalls: number;
  /** Feed one client frame as if the transport had sent it (used for trace replay). */
  receiveFromClient(wire: unknown): void;
  /** Deliver one server frame to the connected socket, as the peer would. */
  peerSend(wire: unknown): void;
  /** Deliver one RAW payload to the connected socket — for malformed-frame checks. */
  peerSendRaw(text: string): void;
  /** Drop the socket (an UNEXPECTED close — the bridge's reconnect trigger). */
  drop(): void;
  /** The headers the transport dialled with, credential included. */
  readonly dialedHeaders: Readonly<Record<string, string>> | null;
  /** The URL the transport dialled. */
  readonly dialedUrl: string | null;
};

const DEFAULT_FIXTURE_SESSION_ID = 'sess_fixture_00000000000000000000';

/**
 * Builds the fake WS server.
 *
 * The fixture reacts to the three client frames the transport emits — the same
 * reaction for the same input every time, which is the property AC-308's fourth
 * false form exploits.
 */
export function createFakeDashscopeServer(options: FakeDashscopeServerOptions = {}): FakeDashscopeServer {
  const sessionId = options.sessionId ?? DEFAULT_FIXTURE_SESSION_ID;
  const callId = options.callId ?? 'call_fixture_0000';
  const toolName = options.toolName ?? 'ui_visible_context';
  const toolArguments = options.toolArguments ?? '{"client":"fixture"}';
  const callAfterFrames = options.functionCallAfterAudioFrames ?? 1;

  const sent: Array<Record<string, unknown>> = [];
  const emitted: Array<Record<string, unknown>> = [];
  let openCalls = 0;
  let remainingFailingOpens = options.failOpens ?? 0;
  let audioFrames = 0;
  let createdAnnounced = false;
  let callAnnounced = false;
  let socket: DashscopeSocket | null = null;
  let dialedHeaders: Readonly<Record<string, string>> | null = null;
  let dialedUrl: string | null = null;

  /** Emits one server frame to the connected socket (and onto the log). */
  function emit(wire: Record<string, unknown>): void {
    emitted.push(wire);
    socket?.onmessage?.({ data: JSON.stringify(wire) });
  }

  /** The fixture's deterministic answer to one client frame. */
  function react(wire: Record<string, unknown>): void {
    if (wire.type === 'session.update') {
      if (!createdAnnounced) {
        createdAnnounced = true;
        emit({
          type: 'session.created',
          session: { id: sessionId, object: 'realtime.session', model: 'fixture-model', modalities: ['text'] },
        });
      }
      emit({ type: 'session.updated', session: { id: sessionId, object: 'realtime.session', modalities: ['text'] } });
      return;
    }
    if (wire.type === 'input_audio_buffer.append') {
      audioFrames += 1;
      if (audioFrames < callAfterFrames || callAnnounced) return;
      callAnnounced = true;
      emit({ type: 'response.created', response: { id: 'resp_fixture_0000', status: 'in_progress' } });
      emit({ type: 'response.function_call_arguments.done', call_id: callId, name: toolName, arguments: toolArguments });
      return;
    }
    if (wire.type === 'conversation.item.create') {
      const item = wire.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call_output') {
        emit({ type: 'response.done', response: { id: 'resp_fixture_0000', status: 'completed' } });
      }
    }
  }

  const socketFactory: DashscopeSocketFactory = (url, headers) => {
    openCalls += 1;
    dialedUrl = url;
    dialedHeaders = headers;
    if (remainingFailingOpens > 0) {
      remainingFailingOpens -= 1;
      // A refused dial: the socket reports the failure on the next tick.
      const refused: DashscopeSocket = {
        send() {},
        close() {},
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      queueMicrotask(() => refused.onerror?.(new Error(`fake DashScope server: open #${openCalls} refused`)));
      return refused;
    }
    const active: DashscopeSocket = {
      send(data: string) {
        // Record the transport's OWN frames, then answer them: `sent` is the
        // wire log of what the transport emitted, which is what the criteria read.
        const frame = JSON.parse(data) as Record<string, unknown>;
        sent.push(frame);
        react(frame);
      },
      close() {
        active.onclose?.({ code: 1000, reason: 'client closed' });
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    socket = active;
    // The transport assigns its handlers synchronously after the factory returns,
    // so opening on the next microtask is after they are attached.
    queueMicrotask(() => active.onopen?.({}));
    return active;
  };

  return {
    socketFactory,
    sent,
    emitted,
    get openCalls(): number {
      return openCalls;
    },
    get dialedHeaders(): Readonly<Record<string, string>> | null {
      return dialedHeaders;
    },
    get dialedUrl(): string | null {
      return dialedUrl;
    },
    receiveFromClient(wire: unknown): void {
      const frame = wire as Record<string, unknown>;
      sent.push(frame);
      react(frame);
    },
    peerSend(wire: unknown): void {
      emit(wire as Record<string, unknown>);
    },
    peerSendRaw(text: string): void {
      socket?.onmessage?.({ data: text });
    },
    drop(): void {
      socket?.onclose?.({ code: 1006, reason: 'fixture dropped the socket' });
    },
  };
}

/** One preserved live trace. See `experiments/voice-realtime-ambiguity/real-trace/README.md`. */
export type RealtimeTrace = {
  schema: string;
  generatedAt: string;
  endpoint: string;
  model: string;
  /** The session `voice` the connection used; `null`/absent when the endpoint default was kept. */
  voice?: string | null;
  session: { id: string; conversationId: string | null };
  audio: {
    file: string;
    sha256: string;
    durationSeconds: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
  };
  exchange: Array<{ direction: 'sent' | 'received'; atMs: number; sinceOpenMs: number; wire: Record<string, unknown> }>;
  /** Real network round trips, one per answered request. Non-zero and varied by construction. */
  latenciesMs: number[];
  /** The tool calls the MODEL decided to make (source `model`, never a harness script). */
  functionCalls: Array<{ callId: string; name: string; arguments: string; source: string; atMs: number }>;
};

/** Reads one preserved trace by file name. */
export function readRealtimeTrace(fileName: string): RealtimeTrace {
  const raw = readFileSync(path.join(REAL_TRACE_DIR, fileName), 'utf8');
  return JSON.parse(raw) as RealtimeTrace;
}

/**
 * AC-308's non-determinism check, made mechanical: replay a trace's client
 * frames through the SAME fake fixture and return what the fixture produced.
 *
 * The fixture answers deterministically, so if its output equalled the real
 * endpoint's on every real-only field, the "real" trace would be a stand-in.
 */
export function replayTraceThroughFixture(
  trace: RealtimeTrace,
  options: FakeDashscopeServerOptions = {},
): { emitted: Array<Record<string, unknown>>; latenciesMs: number[] } {
  const fake = createFakeDashscopeServer({ sessionId: DEFAULT_FIXTURE_SESSION_ID, ...options });
  // The fixture answers IN PROCESS, so every "round trip" it can measure is the
  // time to hand a frame to the next function call — no socket, no network. A
  // real endpoint's latencies (ms over the wire) cannot be reproduced by it.
  const latenciesMs: number[] = [];
  const clock = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;
  for (const entry of trace.exchange) {
    if (entry.direction !== 'sent') continue;
    const startedAt = clock();
    const before = fake.emitted.length;
    fake.receiveFromClient(entry.wire);
    if (fake.emitted.length > before) latenciesMs.push(Number((clock() - startedAt).toFixed(6)));
  }
  return { emitted: fake.emitted, latenciesMs };
}

/** The `session.created` session id in a log of server frames, or `null` when absent. */
export function sessionIdIn(frames: Array<Record<string, unknown>>): string | null {
  for (const frame of frames) {
    if (frame.type !== 'session.created') continue;
    const session = frame.session as Record<string, unknown> | undefined;
    if (session !== undefined && typeof session.id === 'string') return session.id;
  }
  return null;
}
