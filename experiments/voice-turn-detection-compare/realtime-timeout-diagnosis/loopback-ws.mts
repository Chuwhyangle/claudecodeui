/**
 * A LOCAL, ZERO-COST fake DashScope Realtime endpoint — the gate that must pass before any paid
 * session in this task is allowed to open a socket to the real endpoint.
 *
 * WHY THIS EXISTS. `diagnose.mts` turns a real session into a full event log (WS lifecycle, every
 * sent frame, every received frame, the deadline, the attribution decision). Every one of those
 * readings is only trustworthy if it is TRUE on a session whose outcome is already known — otherwise
 * a paid timeout is attributed by the very instrument that might be mis-reading it. This server plays
 * five ground-truth scenarios (a clean endpoint, a late fire, an endpoint that never speaks, one that
 * dies mid-stream with a close code, and one whose fire is rejected by the attribution window), and
 * `loopback.test.mts` drives `runDiagnosedSession` against each and asserts the classification.
 *
 * IT SPEAKS THE REAL WIRE, NOT A BESPOKE ONE. The frames it emits are the exact `type`-tagged JSON
 * the shipping transport normalises (`session.created`, `input_audio_buffer.speech_started`, …), so
 * the client under test is `createDashscopeTransport` + `connect` — the same code a paid session
 * runs — reached through `endpoint`, not a mock of it.
 *
 * AUDIO-END IS INFERRED FROM QUIESCENCE, NOT SIGNALLED. The real endpoint has no "the client stopped
 * sending" frame; it decides silence has run out from the audio itself. This server reproduces that
 * by resetting a short quiet timer on every `input_audio_buffer.append`: when the appends stop, the
 * audio is over and the scenario's post-audio timeline starts. That is what makes the scenarios
 * timing-honest — a late fire is late relative to the audio the client actually sent.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/** The five ground-truth scenarios AC1 requires, each a distinct timeout/attribution category. */
export type LoopbackScenarioName =
  | 'normal'
  | 'late'
  | 'zero-event'
  | 'abnormal-close'
  | 'attribution-rejected';

export type LoopbackOptions = {
  scenario: LoopbackScenarioName;
  /** `late`: ms AFTER the audio ends to emit `speech_stopped` (must exceed the harness deadline). */
  stopDelayMs?: number;
  /** `abnormal-close`: ms after the first append to close the socket. */
  closeAfterMs?: number;
  /** `abnormal-close`: the close code (default 1011 — "internal error", a real upstream failure). */
  closeCode?: number;
  /** `abnormal-close`: the close reason string. */
  closeReason?: string;
  /** Quiescence (ms with no append) after which the server treats the audio as ended. */
  audioEndQuietMs?: number;
  /** `attribution-rejected`: the span onset (ms) the client will use — the resume is placed after it. */
  onsetMs?: number;
};

/** One frame the server emitted, with its own wall clock, so a test can assert what was sent when. */
export type LoopbackSentEvent = { atMs: number; event: string; detail?: unknown };

export type LoopbackServer = {
  url: string;
  port: number;
  /** Every frame this server emitted across all connections, in order. */
  log: LoopbackSentEvent[];
  /** How many sockets have connected. */
  connections: () => number;
  /** The `session.update` instructions the client sent (proves the client warmed correctly). */
  instructions: () => string | null;
  close: () => Promise<void>;
};

const DEFAULT_AUDIO_END_QUIET_MS = 150;

/**
 * Start the fake endpoint on an ephemeral port. The returned `url` is the exact value to pass as
 * `createDashscopeTransport`'s `endpoint` option (the transport appends its own `?model=`).
 */
export async function startLoopbackServer(opts: LoopbackOptions): Promise<LoopbackServer> {
  const audioEndQuietMs = opts.audioEndQuietMs ?? DEFAULT_AUDIO_END_QUIET_MS;
  const log: LoopbackSentEvent[] = [];
  let connections = 0;
  let instructions: string | null = null;
  const timers = new Set<NodeJS.Timeout>();
  const sockets = new Set<WebSocket>();

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', (err) => reject(err));
  });
  const port = (wss.address() as AddressInfo).port;

  /** Emit one server frame and record it. */
  const emit = (ws: WebSocket, event: string, extra: Record<string, unknown> = {}): void => {
    if (ws.readyState !== ws.OPEN) return;
    log.push({ atMs: Date.now(), event, detail: extra.session ?? extra.transcript ?? null });
    ws.send(JSON.stringify({ type: event, ...extra }));
  };

  /** A timer bound to a socket; every one is cleared on close/shutdown so a test never hangs. */
  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  wss.on('connection', (ws: WebSocket) => {
    connections += 1;
    sockets.add(ws);
    const sessionId = `sess_loopback_${connections}`;
    let firstAppendAt: number | null = null;
    let quietTimer: NodeJS.Timeout | null = null;
    let audioEnded = false;

    const clearQuiet = (): void => {
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
        timers.delete(quietTimer);
        quietTimer = null;
      }
    };

    // Every scenario starts from a warm session — the one difference is what happens after.
    emit(ws, 'session.created', { session: { id: sessionId, object: 'realtime.session' } });

    const onAudioEnded = (): void => {
      if (audioEnded) return;
      audioEnded = true;
      switch (opts.scenario) {
        case 'normal':
          emit(ws, 'input_audio_buffer.speech_stopped');
          emit(ws, 'input_audio_buffer.committed');
          emit(ws, 'conversation.item.input_audio_transcription.completed', { transcript: 'loopback utterance' });
          break;
        case 'late':
          later(() => {
            emit(ws, 'input_audio_buffer.speech_stopped');
            emit(ws, 'input_audio_buffer.committed');
          }, opts.stopDelayMs ?? 3_000);
          break;
        case 'zero-event':
          // The endpoint never narrates the utterance at all: no speech_started, no speech_stopped.
          break;
        case 'abnormal-close':
          // Scheduled from the FIRST append (see the handler below), so the socket dies MID-STREAM —
          // the client is cut off part-way through sending, which is what makes the recorded
          // `framesSent` a shorter number than the span's frame count. Nothing more to do here.
          break;
        case 'attribution-rejected':
          // The SECOND speech_started (the interrupt that rejects the fire) is scheduled from the
          // first append — see the handler below — and lands between the onset and this fire. The
          // fire itself is a perfectly normal `speech_stopped` at the end of the audio.
          emit(ws, 'input_audio_buffer.speech_stopped');
          emit(ws, 'input_audio_buffer.committed');
          break;
      }
    };

    ws.on('message', (data) => {
      let frame: { type?: unknown; session?: { instructions?: unknown } };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type === 'session.update') {
        if (typeof frame.session?.instructions === 'string') instructions = frame.session.instructions;
        emit(ws, 'session.updated', { session: { id: sessionId } });
        return;
      }
      if (frame.type === 'input_audio_buffer.append') {
        if (firstAppendAt === null) {
          firstAppendAt = Date.now();
          if (opts.scenario !== 'zero-event') emit(ws, 'input_audio_buffer.speech_started');
          if (opts.scenario === 'attribution-rejected') {
            // A resume AFTER the candidate's onset and BEFORE the fire: the shipping attribution
            // rule reads that as "the silence was interrupted, so this fire belongs to a later run"
            // and rejects the stop — the exact shape of zh-d01-o85#0@800 in P0.7.
            const onsetMs = opts.onsetMs ?? 1_000;
            later(() => emit(ws, 'input_audio_buffer.speech_started'), onsetMs + 100);
          }
          if (opts.scenario === 'abnormal-close') {
            // Cut the socket off while the client is still sending, so the stream is genuinely short.
            later(() => {
              if (ws.readyState === ws.OPEN) ws.close(opts.closeCode ?? 1011, opts.closeReason ?? 'loopback upstream failure');
            }, opts.closeAfterMs ?? 250);
          }
        }
        clearQuiet();
        quietTimer = setTimeout(() => {
          timers.delete(quietTimer as NodeJS.Timeout);
          quietTimer = null;
          onAudioEnded();
        }, audioEndQuietMs);
        timers.add(quietTimer);
      }
    });

    ws.on('close', () => {
      clearQuiet();
      sockets.delete(ws);
    });
    ws.on('error', () => {
      clearQuiet();
      sockets.delete(ws);
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/api-ws/v1/realtime`,
    port,
    log,
    connections: () => connections,
    instructions: () => instructions,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const ws of sockets) {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * A deterministic in-memory span for the loopback scenarios. It is NOT corpus audio (the loopback
 * must be runnable with no fetched dataset and no spend): a quiet ramp long enough that the client's
 * pacing sends real frames at the real 100 ms cadence, with `onsetMs` placed inside it.
 */
export function buildLoopbackSpan(onsetMs = 1_000, audioMs = 2_000, sampleRate = 16_000): {
  sampleId: string;
  spanIndex: number;
  onsetMs: number;
  audio: Float32Array;
  sampleRate: number;
  appendedTailMs: number;
} {
  const n = Math.round((audioMs / 1000) * sampleRate);
  // A low-amplitude tone: not digital silence, so it has no bearing on the client's VAD (the server
  // decides the events here), but it is real PCM that base64s to non-trivial frames.
  const samples = Float32Array.from({ length: n }, (_, i) => 0.01 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  return { sampleId: 'loopback', spanIndex: 0, onsetMs, audio: samples, sampleRate, appendedTailMs: 0 };
}
