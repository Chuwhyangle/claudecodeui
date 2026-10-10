/**
 * HTTP-layer Live Voice diagnosis: push an audio file through the SAME
 * `/voice-realtime` proxy a browser microphone uses, and report what happened.
 *
 * WHY THIS EXISTS. Live Voice failed in production while every offline test was green,
 * and the only way to look was a human with a microphone. Three layers hid it: the
 * proxy suite used a fake transport, the e2e stand-in answered with a hand-written
 * call, and the server logged nothing about what the upstream said. This service is
 * the direct, scriptable path: it drives `handleVoiceRealtimeConnection` itself (not a
 * re-implementation of it), with an in-process stand-in for the browser socket, the
 * real upstream transport, and the real executor — so a result here is a result for the
 * microphone path too. The three mechanisms are therefore: the live microphone, the
 * UI's hidden upload seam (browser, e2e) and this (HTTP, no browser at all).
 *
 * It answers the two questions a "no reasoning output" report needs separated:
 *   - `heard`:    did the upstream transcribe the audio (a final caption arrived)?
 *   - `answered`: did the model act on it (a `session_send` went out)?
 * and, when not, lists why (`problems`) from the frames and the wire timeline.
 *
 * Consumers: `voice-realtime.routes.ts` (the HTTP route) and `server/index.ts` (which
 * also reuses {@link summarizeWireObservation} for the always-on upstream log).
 */
import { EventEmitter } from 'node:events';

import { WebSocket as WS } from 'ws';

import type { DashscopeWireObserver } from './voice-realtime-dashscope-transport.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from './voice-realtime-ws-proxy.service.js';

/** The sample rate the Realtime session's `pcm16` input expects. */
const PCM_SAMPLE_RATE = 16_000;
/** Audio is streamed in chunks this long, like the browser's worklet frames. */
const CHUNK_MS = 100;
/** Silence appended after the audio so the server VAD can close the last utterance. */
const TRAILING_SILENCE_MS = 1_500;
const OPEN_TIMEOUT_MS = 20_000;

/** One diagnosis request, already parsed and validated by the route. */
export type VoiceRealtimeDiagnosisInput = {
  /** The session the connection is bound to — the only one a `session_send` can reach. */
  boundSessionId: string;
  /** Mono 16 kHz little-endian PCM16, no container header. */
  pcm16: Buffer;
  /** Playback speed multiplier. 1 streams in real time like a microphone; larger is faster. */
  speed: number;
  /** After the audio is sent, stop once the upstream has been quiet this long. */
  quietMs: number;
  /** Hard ceiling for the whole run. */
  maxMs: number;
  /**
   * A multi-turn script: these clips are spoken in order on ONE connection, each followed by
   * `gapMs` of silence and a wait for the upstream to go quiet, which is how a person actually
   * uses it (several things said over minutes, Claude answering in between). When present,
   * `pcm16` is ignored.
   */
  turns?: ReadonlyArray<{ pcm16: Buffer; gapMs: number }>;
};

/** What happened during ONE turn of a script, read from the frames and wire that arrived in it. */
export type VoiceRealtimeTurnReport = {
  index: number;
  heard: boolean;
  answered: boolean;
  /** Final caption texts of this turn. */
  captions: string[];
  /** What the model asked `session_send` to carry, when the run was a dry run (it records the call). */
  sentMessages: string[];
  /** Text the model produced instead of (or besides) a call. */
  modelText: string[];
  /** Error frames of this turn, as `CODE: message`, fatal ones marked. */
  errors: string[];
};

/** One upstream wire frame, reduced to what a human needs to read the timeline. */
export type VoiceRealtimeWireEntry = {
  atMs: number;
  direction: 'sent' | 'received';
  summary: string;
};

/** What a diagnosis run found. */
export type VoiceRealtimeDiagnosisReport = {
  /** `heard && answered && no fatal error`. */
  ok: boolean;
  /** The upstream produced a final transcription of the audio. */
  heard: boolean;
  /** The model's `session_send` reached the executor (a `sent` frame went to the browser). */
  answered: boolean;
  elapsedMs: number;
  /** Final caption texts, in order. */
  captions: string[];
  /** How many interim (not yet final) caption frames arrived — the upstream is transcribing even if nothing finalises. */
  interimCaptionCount: number;
  /** How many audio chunks were fed to the proxy. */
  audioChunksSent: number;
  /** How many of them the transport actually wrote to the upstream socket. */
  audioFramesUpstream: number;
  /** Token usage the upstream reported across the run: what the bill is made of. */
  usage: { responses: number; inputTokens: number; outputTokens: number };
  /** Per-turn readings; one entry for a single-clip run. */
  turns: VoiceRealtimeTurnReport[];
  /** Every non-caption frame the browser would have received. */
  frames: VoiceRealtimeOutboundFrame[];
  /** The upstream conversation, in order, with audio and interim deltas left out. */
  wire: VoiceRealtimeWireEntry[];
  /** Plain-language reasons `ok` is false. Empty when ok. */
  problems: string[];
};

/**
 * Reduces one wire observation to a single readable line, or `null` for traffic that
 * would only be noise (audio chunks, interim transcription deltas, argument deltas).
 *
 * Consumers: this service (the report timeline) and `server/index.ts` (the always-on
 * upstream log). Credentials never appear on the wire, and audio payloads are dropped
 * here, so the line is safe to log.
 */
export function summarizeWireObservation(observation: { direction: 'sent' | 'received'; wire: unknown }): string | null {
  const wire = observation.wire as Record<string, unknown> | null;
  if (wire === null || typeof wire !== 'object') {
    return null;
  }
  const type = String(wire.type);
  if (
    type === 'input_audio_buffer.append' ||
    type === 'conversation.item.input_audio_transcription.delta' ||
    type === 'response.function_call_arguments.delta' ||
    type === 'response.audio.delta' ||
    type === 'response.audio_transcript.delta' ||
    type === 'response.text.delta'
  ) {
    return null;
  }
  const clip = (value: unknown): string => String(value ?? '').slice(0, 300);
  switch (type) {
    case 'session.update': {
      const session = (wire.session ?? {}) as Record<string, unknown>;
      const tools = Array.isArray(session.tools) ? session.tools.length : 0;
      return `session.update voice=${clip(session.voice)} tools=${tools}`;
    }
    case 'conversation.item.input_audio_transcription.completed':
      return `transcription.completed ${JSON.stringify(clip(wire.transcript))}`;
    case 'response.function_call_arguments.done':
      return `function_call ${clip(wire.name)} ${clip(wire.arguments)}`;
    case 'response.text.done':
      // Text from the model is never shown to the user. The remark that follows a tool result is
      // expected; text in answer to the user's own words is what the bridge reports as an error.
      return `model text (not shown to the user) ${JSON.stringify(clip(wire.text))}`;
    case 'response.done': {
      const response = (wire.response ?? {}) as Record<string, unknown>;
      const details = response.status_details ? ` ${clip(JSON.stringify(response.status_details))}` : '';
      const usage = (response.usage ?? {}) as Record<string, unknown>;
      const tokens = typeof usage.input_tokens === 'number' ? ` in=${usage.input_tokens} out=${String(usage.output_tokens ?? 0)}` : '';
      return `response.done status=${clip(response.status)}${tokens}${details}`;
    }
    case 'error':
      return `ERROR ${clip(JSON.stringify(wire.error ?? wire))}`;
    default:
      return type;
  }
}

/**
 * Parses a RIFF/WAVE buffer into raw mono 16 kHz PCM16.
 *
 * Returns the PCM, or a human-readable reason it was refused. The chunk walk (rather
 * than "skip 44 bytes") is deliberate: encoders add LIST/fact chunks, and a fixed
 * offset would feed their bytes to the recogniser as audio.
 *
 * Consumers: `voice-realtime.routes.ts`, which turns a refusal into a 400.
 */
export function parseWavPcm16(buffer: Buffer): { pcm16: Buffer } | { error: string } {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { error: 'not a RIFF/WAVE file' };
  }
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number; tag: number } | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        tag: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (format === null) {
        return { error: 'data chunk before fmt chunk' };
      }
      if (format.tag !== 1 || format.channels !== 1 || format.bits !== 16 || format.sampleRate !== PCM_SAMPLE_RATE) {
        return {
          error: `need mono 16-bit PCM at ${PCM_SAMPLE_RATE} Hz; got ${format.channels} ch, ${format.bits}-bit, ${format.sampleRate} Hz (tag ${format.tag})`,
        };
      }
      return { pcm16: buffer.subarray(body, Math.min(buffer.length, body + size)) };
    }
    offset = body + size + (size % 2);
  }
  return { error: 'no data chunk' };
}

/**
 * The slice of the browser's `ws.WebSocket` the proxy touches, backed by an array.
 * Same surface as the proxy suites' stand-in; kept private because a second consumer
 * would mean moving it to `server/shared`.
 */
class RecordingBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];
  /** Wall-clock time each outbound frame arrived, parallel to `outbound`. */
  readonly arrivedAt: number[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
    this.arrivedAt.push(Date.now());
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  receiveAudio(audio: string): void {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'audio', audio }), 'utf8'));
  }
}

/** What {@link runVoiceRealtimeDiagnosis} needs from the composition root. */
export type VoiceRealtimeDiagnosisSeams = {
  /** Builds the proxy seams exactly as the live socket does, but reporting wire traffic to `observe`. */
  buildSeams(observe: DashscopeWireObserver): VoiceRealtimeProxySeams;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one diagnosis: connects through the real proxy, streams `pcm16` at `speed`×
 * real time followed by trailing silence, waits for the upstream to go quiet, and
 * returns the report.
 *
 * Consumers: `voice-realtime.routes.ts`.
 */
export async function runVoiceRealtimeDiagnosis(
  input: VoiceRealtimeDiagnosisInput,
  seams: VoiceRealtimeDiagnosisSeams,
): Promise<VoiceRealtimeDiagnosisReport> {
  const startedAt = Date.now();
  const wire: VoiceRealtimeWireEntry[] = [];
  let lastActivityAt = startedAt;
  let audioFramesUpstream = 0;
  const observe: DashscopeWireObserver = (observation) => {
    if (observation.direction === 'sent' && (observation.wire as { type?: unknown } | null)?.type === 'input_audio_buffer.append') {
      audioFramesUpstream += 1;
    }
    const summary = summarizeWireObservation(observation);
    // Any traffic but pure audio counts as the upstream still talking.
    if (observation.direction === 'received') {
      lastActivityAt = Date.now();
    }
    if (summary !== null) {
      wire.push({ atMs: Date.now() - startedAt, direction: observation.direction, summary });
    }
  };

  const socket = new RecordingBrowserSocket();
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    input.boundSessionId,
    seams.buildSeams(observe),
  );

  const deadline = startedAt + input.maxMs;
  const opened = (): boolean => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');
  const openDeadline = Math.min(deadline, startedAt + OPEN_TIMEOUT_MS);
  while (!opened() && Date.now() < openDeadline && !socket.outbound.some((frame) => frame.type === 'error')) {
    await sleep(50);
  }

  let audioChunksSent = 0;
  const script = input.turns ?? [{ pcm16: input.pcm16, gapMs: 0 }];
  const bounds: Array<{ frameStart: number; frameEnd: number; wireStart: number; wireEnd: number }> = [];
  const chunkBytes = (PCM_SAMPLE_RATE * CHUNK_MS) / 1000 * 2;
  const silence = Buffer.alloc((PCM_SAMPLE_RATE * TRAILING_SILENCE_MS) / 1000 * 2);
  if (opened()) {
    for (const turn of script) {
      const frameStart = socket.outbound.length;
      const wireStart = wire.length;
      const audio = Buffer.concat([turn.pcm16, silence]);
      for (let offset = 0; offset < audio.length && Date.now() < deadline; offset += chunkBytes) {
        socket.receiveAudio(audio.subarray(offset, offset + chunkBytes).toString('base64'));
        audioChunksSent += 1;
        await sleep(CHUNK_MS / input.speed);
      }
      lastActivityAt = Date.now();
      while (Date.now() < deadline && Date.now() - lastActivityAt < input.quietMs) {
        await sleep(100);
      }
      bounds.push({ frameStart, frameEnd: socket.outbound.length, wireStart, wireEnd: wire.length });
      // The person pauses before speaking again; Claude may be answering meanwhile.
      const gapEnd = Date.now() + turn.gapMs;
      while (Date.now() < Math.min(gapEnd, deadline)) {
        await sleep(100);
      }
    }
  }

  socket.close();

  const frames = socket.outbound.filter((frame) => frame.type !== 'caption');
  const captions: string[] = [];
  for (const frame of socket.outbound) {
    if (frame.type === 'caption' && frame.final) {
      captions.push(frame.text);
    }
  }
  const interimCaptionCount = socket.outbound.filter((frame) => frame.type === 'caption' && !frame.final).length;
  const heard = captions.length > 0;
  const answered = frames.some((frame) => frame.type === 'sent');
  const fatal = frames.filter((frame) => frame.type === 'error' && frame.recoverable !== true);
  const problems: string[] = [];
  if (!opened()) {
    problems.push('the upstream never reached the open state');
  }
  if (opened() && !heard) {
    problems.push('the upstream produced no final transcription (audio not recognised as speech, or the session stalled)');
  }
  const called = wire.some((entry) => entry.summary.startsWith('function_call session_send'));
  if (heard && !answered) {
    problems.push(
      called
        ? 'the model called session_send but it was not delivered before the run ended (the session may still be busy; see the errors below)'
        : 'the audio was transcribed but the model never called session_send',
    );
  }
  for (const frame of frames) {
    if (frame.type === 'error') {
      problems.push(`${frame.recoverable === true ? 'recoverable' : 'FATAL'} ${frame.code}: ${frame.message}`);
    }
  }

  const turns: VoiceRealtimeTurnReport[] = bounds.map((bound, index) => {
    const slice = socket.outbound.slice(bound.frameStart, bound.frameEnd);
    const wireSlice = wire.slice(bound.wireStart, bound.wireEnd);
    const turnCaptions = slice.filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }> => frame.type === 'caption' && frame.final).map((frame) => frame.text);
    const sentMessages = slice
      .filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'sent' }> => frame.type === 'sent')
      .map((frame) => {
        const would = (frame.result as { wouldSend?: { message?: unknown } } | null)?.wouldSend;
        return typeof would?.message === 'string' ? would.message : '(delivered)';
      });
    return {
      index,
      heard: turnCaptions.length > 0,
      answered: sentMessages.length > 0,
      captions: turnCaptions,
      sentMessages,
      modelText: wireSlice.filter((entry) => entry.summary.startsWith('model text')).map((entry) => entry.summary),
      errors: slice
        .filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'error' }> => frame.type === 'error')
        .map((frame) => `${frame.recoverable === true ? '' : 'FATAL '}${frame.code}: ${frame.message}`),
    };
  });
  if (turns.length > 1) {
    for (const turn of turns) {
      if (!turn.heard) problems.push(`turn ${turn.index + 1}: not transcribed`);
      else if (!turn.answered) problems.push(`turn ${turn.index + 1}: transcribed but nothing was sent to the session`);
    }
  }

  const usage = { responses: 0, inputTokens: 0, outputTokens: 0 };
  for (const entry of wire) {
    const match = /^response\.done .*?in=(\d+) out=(\d+)/.exec(entry.summary);
    if (match) {
      usage.responses += 1;
      usage.inputTokens += Number(match[1]);
      usage.outputTokens += Number(match[2]);
    }
  }

  return {
    ok: turns.length > 1 ? turns.every((turn) => turn.heard && turn.answered) && fatal.length === 0 : heard && answered && fatal.length === 0,
    heard,
    answered,
    elapsedMs: Date.now() - startedAt,
    captions,
    interimCaptionCount,
    audioChunksSent,
    audioFramesUpstream,
    usage,
    turns,
    frames,
    wire,
    problems,
  };
}
