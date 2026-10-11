/**
 * The uplink audio capture as a RUNNING CONNECTION produces it — the real proxy over the real
 * transport, with a fake upstream standing in for the endpoint's socket (the same shape
 * `voice-realtime-log-wiring.test.ts` uses). Two claims need a live connection rather than a store
 * driven directly:
 *
 *  - AC2: capture ON, one connection produces EXACTLY ONE WAV whose header records the connection's
 *    first frame's rate (not a later frame's, and never a guess) and whose duration equals the frames
 *    received — with the directory at 0700 and the files at 0600;
 *  - AC6: the capture is WIRE-NEUTRAL. The same connection is driven twice — once with no capture seam
 *    and once with capture ON — and the frames the upstream received are byte-for-byte the same list.
 *    A side channel that changed what crossed the wire would be a relay change wearing a capture's
 *    name, and this is what rules that out rather than asserting it.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, type RealtimeToolExecutor } from '../index.js';
import {
  createVoiceRealtimeCaptureRecorder,
  createVoiceRealtimeCaptureStore,
  type VoiceRealtimeCaptureEvent,
} from '../voice-realtime-audio-capture.js';
import { handleVoiceRealtimeConnection, VOICE_REALTIME_INSTRUCTIONS, type VoiceRealtimeOutboundFrame } from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

const TEST_KEY = 'sk-test-not-a-real-key';
const BOUND_SESSION = 'session-under-test';
const CONNECTION_ID = 'connection-under-test';

/** 20 ms of mono PCM16 at 24 kHz: 480 samples, 960 bytes. The rate this criterion declares on the wire. */
const DECLARED_RATE = 24_000;
const FRAME_BYTES = Math.round((DECLARED_RATE * 0.02) * 2);
const FRAME_COUNT = 50;

/** The slice of the browser socket the proxy touches — plus `receive`, the browser's side. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  receive(frame: unknown): void {
    this.emit('message', JSON.stringify(frame));
  }

  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }
}

const opened = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function statMode(target: string): string {
  return (statSync(target).mode & 0o777).toString(8);
}

function names(directory: string): string[] {
  return readdirSync(directory).sort();
}

/** One 960-byte PCM16 frame, base64 — the payload the upstream should receive unchanged. */
function frameOf(bytes: number): string {
  return Buffer.alloc(bytes, 11).toString('base64');
}

/** The WAV header fields, from the canonical offsets. */
function wavHeader(file: string): { sampleRate: number; channels: number; dataBytes: number } {
  const buffer = readFileSync(file);
  return { channels: buffer.readUInt16LE(22), sampleRate: buffer.readUInt32LE(24), dataBytes: buffer.readUInt32LE(40) };
}

/**
 * Drives one continuous connection through the shipped handler.
 *
 * `capture` is the only difference between the two AC6 runs: `null` leaves `seams.audioCapture`
 * undefined (the shipped shape for a deployment with the switch off), while a recorder turns it on.
 * Everything else — the transport, the executor, the instructions — is identical, so any difference in
 * what the upstream received is attributable to the capture and nothing else.
 */
async function runConnection(options: {
  capture: ReturnType<typeof createVoiceRealtimeCaptureRecorder> | null;
  frames: Array<{ audio: string; sourceRate?: number }>;
  onTimeline?: (event: VoiceRealtimeCaptureEvent) => void;
}): Promise<{ sent: Array<Record<string, unknown>>; socket: FakeBrowserSocket }> {
  const socket = new FakeBrowserSocket();
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const executor: RealtimeToolExecutor = { session_send: async () => ({ runId: 'run-1' }) };

  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
    createTransport: (report) =>
      createDashscopeTransport({
        apiKey: TEST_KEY,
        socketFactory: upstream.socketFactory,
        onError: report,
        // The composition root tees BOTH recorders here; the capture is the same stream the journal sees.
        ...(options.capture === null ? {} : { observer: (observation) => options.capture?.observe(observation) }),
      }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    // The continuous path: no `hello`, so the proxy never declares the segmented relay and every audio
    // frame carries no `seq`. This is the microphone stream the capture exists for.
    segmentedRelay: false,
    ...(options.capture === null ? {} : { audioCapture: options.capture }),
  });

  await waitFor(() => opened(socket));
  for (const frame of options.frames) {
    socket.receive({ type: 'audio', ...frame });
  }
  // Let the bridge hand every frame to the fake upstream before the connection is torn down.
  await waitFor(() => upstream.sent.filter((frame) => frame.type === 'input_audio_buffer.append').length >= options.frames.length);
  socket.close();
  await waitFor(() => socket.readyState === WS.CLOSED);

  return { sent: upstream.sent, socket };
}

test('AC2: one connection yields exactly one WAV, its header carrying the FIRST frame\'s rate and a matching duration', async () => {
  const root = tempDir('voice-capture-wiring-');
  try {
    const directory = path.join(root, 'capture');
    const store = createVoiceRealtimeCaptureStore({ directory, connectionId: CONNECTION_ID, maxBytes: 8 * 1024 * 1024 });
    const stdout: string[] = [];
    const capture = createVoiceRealtimeCaptureRecorder({ store, connectionId: CONNECTION_ID, enabled: true, stdout: (line) => stdout.push(line) });

    // The first frame declares 24 kHz; a LATER frame declares 48 kHz. Only the first may reach the header.
    const frames = Array.from({ length: FRAME_COUNT }, (_unused, index) => ({
      audio: frameOf(FRAME_BYTES),
      ...(index === 0 ? { sourceRate: DECLARED_RATE } : index === 25 ? { sourceRate: 48_000 } : {}),
    }));

    await runConnection({ capture, frames });

    // EXACTLY ONE audio file for the connection — no per-frame file, no second connection's.
    const audios = names(directory).filter((name) => name.endsWith('.wav'));
    assert.deepEqual(audios, [`${CONNECTION_ID}.wav`]);

    const header = wavHeader(path.join(directory, `${CONNECTION_ID}.wav`));
    assert.equal(header.sampleRate, DECLARED_RATE, 'the header records the FIRST frame\'s rate, not a later frame\'s');
    assert.equal(header.channels, 1);
    assert.equal(header.dataBytes, FRAME_COUNT * FRAME_BYTES, 'every frame reached the file');

    // The duration the header implies equals what the frames carried: 50 frames × 20 ms = 1 s.
    const durationMs = (header.dataBytes / 2 / header.sampleRate) * 1_000;
    assert.equal(durationMs, FRAME_COUNT * 20);

    // The judgement timeline is beside it, and its origin is the first frame's rate — the same reading.
    const timeline = readFileSync(path.join(directory, `${CONNECTION_ID}.timeline.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const origin = timeline.find((entry) => entry.kind === 'origin');
    assert.ok(origin !== undefined, 'the capture records its shared origin');
    assert.equal(origin.sampleRate, DECLARED_RATE);
    assert.equal(origin.channels, 1);
    const final = timeline.find((entry) => entry.kind === 'final');
    assert.equal(final?.frames, FRAME_COUNT);
    assert.equal(final?.dataBytes, FRAME_COUNT * FRAME_BYTES);

    // The permissions an operator reads: directory 0700, both files 0600.
    assert.equal(statMode(directory), '700');
    assert.equal(statMode(path.join(directory, `${CONNECTION_ID}.wav`)), '600');
    assert.equal(statMode(path.join(directory, `${CONNECTION_ID}.timeline.jsonl`)), '600');

    // Nothing complained: a capture that works prints nothing on the error channel.
    assert.deepEqual(stdout, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC6: capture ON changes nothing on the wire — the upstream receives the same frames, in order', async () => {
  const root = tempDir('voice-capture-neutral-');
  try {
    const frames = Array.from({ length: 12 }, () => ({ audio: frameOf(FRAME_BYTES) }));
    const expectedAppendCount = frames.length;

    // Run 1: the shipped shape for a deployment with the switch off — no capture seam at all.
    const withoutCapture = await runConnection({ capture: null, frames });

    // Run 2: the same connection, capture ON.
    const directory = path.join(root, 'capture');
    const capture = createVoiceRealtimeCaptureRecorder({
      store: createVoiceRealtimeCaptureStore({ directory, connectionId: CONNECTION_ID, maxBytes: 8 * 1024 * 1024 }),
      connectionId: CONNECTION_ID,
      enabled: true,
      stdout: () => {},
    });
    const withCapture = await runConnection({ capture, frames });

    // The capture must have actually run, or the comparison below proves nothing.
    assert.ok(existsSync(path.join(directory, `${CONNECTION_ID}.wav`)), 'capture ON actually wrote a capture');

    const appends = (sent: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      sent.filter((frame) => frame.type === 'input_audio_buffer.append');
    assert.equal(appends(withoutCapture.sent).length, expectedAppendCount, 'the OFF run forwarded every frame');
    assert.equal(appends(withCapture.sent).length, expectedAppendCount, 'the ON run forwarded every frame');
    assert.deepEqual(appends(withCapture.sent), appends(withoutCapture.sent), 'the frames are identical, byte for byte');

    // And not just the audio: the ENTIRE client→upstream traffic is identical with the capture on.
    assert.deepEqual(withCapture.sent, withoutCapture.sent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
