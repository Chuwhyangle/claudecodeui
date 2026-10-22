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

import type { RealtimeSegmentCommitMode } from './voice-realtime-bridge.service.js';
import type { DashscopeWireObserver } from './voice-realtime-dashscope-transport.js';
import type { TurnDetectionOverride } from './voice-realtime-turn-detection.js';
import type { UpstreamPoolRotation } from './voice-realtime-upstream-pool.js';
import type {
  VoiceRealtimeOutboundFrame,
  VoiceRealtimeProxySeams,
} from './voice-realtime-contract.js';

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
  /**
   * A segmented script: these clips are spoken in order on ONE connection as SEGMENTS of
   * the relay protocol (SPEC §C1) rather than as continuous audio — `segment_start`,
   * `audio{seq}` frames, `segment_end` — so the manual-commit path is exercised through
   * this service exactly as the browser drives it. Overrides `pcm16`/`turns`.
   *
   * The clips are already cut: this service does not segment. The browser-side segmenter
   * (`src/modules/chat/utils/voiceLiveSegmenter.ts`) is a frontend module the server
   * cannot import — `server/tsconfig.json` excludes `../src` — so the cutting happens in
   * `scripts/voice-realtime-diagnose.mjs` and arrives here as data.
   */
  segments?: ReadonlyArray<{ pcm16: Buffer; durationMs: number; reason?: 'gap' | 'max' | 'end' }>;
  /**
   * Which protocol a `turns` script is spoken with, when the caller wants the segmented one.
   *
   * Set it and `turns` becomes a segment script; leave it unset and `turns` keeps its
   * continuous meaning — the server is normally told by {@link resolveSegmentSelection},
   * and this is the per-run override a criterion uses to pin the protocol it is asserting on.
   */
  segmentCommit?: RealtimeSegmentCommitMode;
  /**
   * A per-run override of the upstream turn detector's parameters.
   *
   * Routed to the SAME resolver the deployment's environment is read with
   * (`resolveTurnDetection`), so a value that is out of range or names no detector is refused and
   * reported rather than applied — the rules a criterion asserts on the env knob are the rules this
   * override follows, and a run that passes nothing inherits the deployment's own resolution.
   */
  turnDetection?: TurnDetectionOverride;
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

/** What became of one segment of a segmented run (SPEC §C1 / the diagnosis report). */
export type VoiceRealtimeSegmentReport = {
  /** The segment's number, as the browser cut it — the idempotency key the path keys on. */
  seq: number;
  durationMs: number;
  /** Why the browser ended it: a pause, the max length, or the end of the stream. */
  reason: 'gap' | 'max' | 'end';
  /**
   * How the segment was closed upstream. `manual` is one `input_audio_buffer.commit` plus
   * one `response.create`; `server-vad` is the fallback's real silence.
   */
  commit: 'manual' | 'server-vad';
  /** How many `input_audio_buffer.commit` frames this segment produced upstream. */
  commits: number;
  /** Audio seconds THIS segment wrote to the upstream socket. */
  audioSeconds: number;
  /** The `segment_ack` the page received: `committed`, `dropped`, or `pending` if none did. */
  ack: 'committed' | 'dropped' | 'pending';
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
  /**
   * Audio SECONDS actually written to the upstream socket — summed from the bytes of every
   * `input_audio_buffer.append` the transport put on the wire, so it counts what the
   * endpoint was billed for rather than what the browser offered. A segmented run reports
   * the segments' own audio here; the same recording sent continuously reports all of it.
   */
  audioSecondsUpstream: number;
  /** Per-segment readings; empty for a run that did not use the segment protocol. */
  segments: VoiceRealtimeSegmentReport[];
  /**
   * Every idle rotation the upstream session pool performed (SPEC §C3), oldest first, each
   * with the measured switch time. Empty when the run did not use a pool, or used one and
   * never went idle — both are normal: a rotation is a deployment's background behaviour,
   * not something a diagnosis asks for. A run that wants to SEE one shrinks the threshold
   * with `VOICE_REALTIME_IDLE_ROTATE_MS`.
   */
  rotations: UpstreamPoolRotation[];
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
 * One `session.update` body's `turn_detection`, as the single token the journal line carries.
 *
 * Three readings, deliberately distinguishable: `null` is the segmented path's switch (the
 * endpoint's own VAD off), `absent` is a body that never carried the field (the deployment left the
 * endpoint on its own default), and anything else prints the live detector's own three fields. A
 * reader who cannot tell "off" from "on" from "never said" is exactly who the 2026-10-12 defect
 * (journal `ef9daacd`) was invisible to.
 */
function describeWireTurnDetection(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  const detector = value as Record<string, unknown>;
  const threshold = detector.threshold === undefined ? '?' : String(detector.threshold);
  const silence = detector.silence_duration_ms === undefined ? '?' : String(detector.silence_duration_ms);
  return `${String(detector.type ?? '?')} threshold=${threshold} silence=${silence}ms`;
}

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
      // `turn_detection=` IS THE FIELD THAT COST THE 2026-10-12 SESSION (journal `ef9daacd`): a
      // status injection re-stated the session body and quietly re-opened the endpoint's own VAD
      // mid-segmented-run, and this line — `voice=` and a tool count — could not show it, so the
      // journal read exactly like a healthy run. `null` is the segmented path's switch OFF;
      // `absent` is a body that never carried the field at all; anything else is the live detector.
      return `session.update voice=${clip(session.voice)} tools=${tools} turn_detection=${describeWireTurnDetection(session.turn_detection)}`;
    }
    case 'conversation.item.input_audio_transcription.completed':
      return `transcription.completed ${JSON.stringify(clip(wire.transcript))}`;
    case 'response.function_call_arguments.done':
      return `function_call ${clip(wire.name)} ${clip(wire.arguments)}`;
    // The item and response lifecycles. Recorded with their IDS so an operator can name the exact
    // item a no-audio `conversation.item.created` produced and the response that carried it — the
    // 2026-10-11 duplicate-send defect (journal 57279cc1) was only visible as a bare
    // `conversation.item.created` with nothing to correlate it against.
    case 'conversation.item.created': {
      const item = (wire.item ?? {}) as Record<string, unknown>;
      return (
        `conversation.item.created item.id=${clip(item.id)} item.type=${clip(item.type)}` +
        ` item.role=${clip(item.role)} item.call_id=${clip(item.call_id)}` +
        ` previous_item_id=${clip(wire.previous_item_id)}`
      );
    }
    case 'response.created': {
      const response = (wire.response ?? {}) as Record<string, unknown>;
      return `response.created response.id=${clip(response.id)}`;
    }
    case 'response.text.done':
      // Text from the model is never shown to the user. The remark that follows a tool result is
      // expected; text in answer to the user's own words is what the bridge reports as an error.
      return `model text (not shown to the user) ${JSON.stringify(clip(wire.text))}`;
    case 'response.done': {
      const response = (wire.response ?? {}) as Record<string, unknown>;
      const details = response.status_details ? ` ${clip(JSON.stringify(response.status_details))}` : '';
      const usage = (response.usage ?? {}) as Record<string, unknown>;
      // `audio=` is the reading that names a no-new-audio response: the model answering without any
      // fresh input audio reports the same `audio_tokens` as the turn before (259 in the 2026-10-11
      // duplicate-send journal), so a line WITHOUT it could not tell that repeat apart from real speech.
      const audioTokens = (usage.input_tokens_details as { audio_tokens?: unknown } | undefined)?.audio_tokens;
      const tokens =
        typeof usage.input_tokens === 'number'
          ? ` in=${usage.input_tokens} out=${String(usage.output_tokens ?? 0)}` +
            (typeof audioTokens === 'number' ? ` audio=${audioTokens}` : '')
          : '';
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

  /** Feeds any inbound frame — the segmented path's `segment_start` / `segment_end` included. */
  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

/** What {@link runVoiceRealtimeDiagnosis} needs from the composition root. */
export type VoiceRealtimeDiagnosisSeams = {
  /**
   * Builds the proxy seams exactly as the live socket does, but reporting wire traffic to `observe`.
   *
   * `turnDetection` is the run's UNTRUSTED override, passed through unresolved: the composition root
   * owns the one resolver (env → default) and would otherwise have to duplicate it here. A builder that
   * ignores the argument keeps the deployment's own value, which is exactly the behaviour a run that
   * passes no override wants.
   */
  buildSeams(observe: DashscopeWireObserver, turnDetection?: TurnDetectionOverride): VoiceRealtimeProxySeams;
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
  // The connection handler is the god file this leaf used to statically import for its whole
  // module graph; the wire contract it needs lives in `voice-realtime-contract.js`, and the handler
  // itself is loaded lazily here, at the one place that drives a connection. The static import edge
  // is gone, so a leaf that only speaks the wire contract does not pull the handler in.
  const { handleVoiceRealtimeConnection, resolveSegmentSelection } = await import(
    './voice-realtime-ws-proxy.service.js'
  );
  const startedAt = Date.now();
  const wire: VoiceRealtimeWireEntry[] = [];
  let lastActivityAt = startedAt;
  let audioFramesUpstream = 0;
  /** PCM16 bytes the transport actually appended upstream. Second-of-audio = bytes / 2 / rate. */
  let audioBytesUpstream = 0;
  const observe: DashscopeWireObserver = (observation) => {
    const outbound = observation.wire as { type?: unknown; audio?: unknown } | null;
    if (observation.direction === 'sent' && outbound?.type === 'input_audio_buffer.append') {
      audioFramesUpstream += 1;
      if (typeof outbound.audio === 'string') {
        audioBytesUpstream += Buffer.from(outbound.audio, 'base64').length;
      }
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
  const builtSeams = seams.buildSeams(observe, input.turnDetection);
  // The protocol is resolved ONCE, here, and pinned onto the seams the proxy is handed:
  // left to resolve it itself the proxy would read the same seam/env pair, and a caller
  // that named a mode must not be able to disagree with the connection it drives.
  const selection = input.segmentCommit === undefined ? resolveSegmentSelection(builtSeams) : { mode: input.segmentCommit, explicit: true };
  // The pool is built by the proxy from this seam, so its rotations are collected here as
  // they happen; the report is a reading of the connection, and the pool is part of it.
  const rotations: UpstreamPoolRotation[] = [];
  const poolSeam = builtSeams.upstreamPool;
  const proxySeams: VoiceRealtimeProxySeams = {
    ...builtSeams,
    segmentCommit: selection.mode,
    ...(poolSeam === undefined
      ? {}
      : { upstreamPool: { ...poolSeam, onRotate: (rotation: UpstreamPoolRotation) => {
          rotations.push(rotation);
          poolSeam.onRotate?.(rotation);
        } } }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    input.boundSessionId,
    proxySeams,
  );

  /**
   * The segment script to speak, when there is one.
   *
   * Three ways in, in this order: clips the caller already cut (`input.segments`, what the
   * criteria use), a `turns` script from an operator who ASKED for the segmented path
   * (`--segments`, or the env switch — see {@link resolveSegmentSelection}), and otherwise
   * none, which leaves `turns` meaning what it always has: continuous audio on ONE
   * connection, which is how a person actually talks to Live Voice.
   */
  const segmentScript =
    input.segments ??
    (input.turns === undefined || !selection.explicit
      ? undefined
      : input.turns.map((turn) => ({
          pcm16: turn.pcm16,
          durationMs: Math.round((turn.pcm16.length / 2 / PCM_SAMPLE_RATE) * 1000),
          reason: 'gap' as const,
        })));
  /** PCM16 bytes each segment wrote upstream, so the report can price them per segment. */
  const segmentBytes = new Map<number, number>();

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
  if (opened() && segmentScript !== undefined) {
    for (const [index, segment] of segmentScript.entries()) {
      const frameStart = socket.outbound.length;
      const wireStart = wire.length;
      const bytesBefore = audioBytesUpstream;
      socket.receive({ type: 'segment_start', seq: index, startedAtMs: 0 });
      for (let offset = 0; offset < segment.pcm16.length && Date.now() < deadline; offset += chunkBytes) {
        socket.receive({
          type: 'audio',
          audio: segment.pcm16.subarray(offset, offset + chunkBytes).toString('base64'),
          seq: index,
        });
        audioChunksSent += 1;
        await sleep(CHUNK_MS / input.speed);
      }
      // No trailing silence is appended here: the segment's close is the protocol's own
      // business (a manual commit, or the fallback's real silence) and adding more would
      // be the diagnosis measuring its own invention rather than the pipeline's.
      socket.receive({
        type: 'segment_end',
        seq: index,
        durationMs: segment.durationMs,
        reason: segment.reason ?? 'gap',
      });
      lastActivityAt = Date.now();
      while (Date.now() < deadline && Date.now() - lastActivityAt < input.quietMs) {
        await sleep(100);
      }
      bounds.push({ frameStart, frameEnd: socket.outbound.length, wireStart, wireEnd: wire.length });
      segmentBytes.set(index, audioBytesUpstream - bytesBefore);
    }
  } else if (opened()) {
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

  // Per-segment readings. The commit count is read off the wire the same way everything
  // else here is — the diagnosis never re-implements the pipeline, it reads what it did.
  const segments: VoiceRealtimeSegmentReport[] = (segmentScript ?? []).map((segment, index) => {
    const bound = bounds[index];
    const wireSlice = bound === undefined ? [] : wire.slice(bound.wireStart, bound.wireEnd);
    const acks = socket.outbound.filter(
      (frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'segment_ack' }> =>
        frame.type === 'segment_ack' && frame.seq === index,
    );
    return {
      seq: index,
      durationMs: segment.durationMs,
      reason: segment.reason ?? 'gap',
      commit: selection.mode,
      commits: wireSlice.filter((entry) => entry.summary === 'input_audio_buffer.commit').length,
      audioSeconds: (segmentBytes.get(index) ?? 0) / 2 / PCM_SAMPLE_RATE,
      ack: acks.some((frame) => frame.state === 'committed') ? 'committed' : acks.length > 0 ? 'dropped' : 'pending',
    };
  });

  return {
    ok: turns.length > 1 ? turns.every((turn) => turn.heard && turn.answered) && fatal.length === 0 : heard && answered && fatal.length === 0,
    heard,
    answered,
    elapsedMs: Date.now() - startedAt,
    captions,
    interimCaptionCount,
    audioChunksSent,
    audioFramesUpstream,
    audioSecondsUpstream: audioBytesUpstream / 2 / PCM_SAMPLE_RATE,
    segments,
    rotations,
    usage,
    turns,
    frames,
    wire,
    problems,
  };
}
