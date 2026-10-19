/**
 * The local speech gate must not interrupt the narrator.
 *
 * THE DEFECT THIS FILE PINS (live connection 56278c8d, 2026-10-19 20:14:46–20:15:38). Five
 * announcements went out over that connection and the person heard none of them. Each one was
 * cleared by a `narrator_stop` whose moment matched no upstream `input_audio_buffer.speech_started`
 * — the only remaining source was this side's local speech gate, whose `started` boundary the proxy
 * handed to `interrupt('user-spoke')`. Replaying the connection's own uplink capture through
 * `createLocalSpeechGate()` reproduced every stop, at frames reading 300–470 RMS: ambient noise, not
 * a voice (speech in the same capture reads 1000–10000).
 *
 * WHY THE GATE MUST NOT DECIDE THIS. `voice-realtime-local-speech.ts` says it in its own header: it
 * "is not a VAD and must not become one", it "deliberately coarse", it answers the watchdog's
 * "has speech been seen at all?" — not "is this person speaking now". Feeding that reading into a
 * droppable output means a loud room mutes the narrator. The narrator's interrupt now reads only the
 * two PRECISE boundaries: the endpoint's `speech_started` and the browser's `segment_start`.
 *
 * WHAT THIS FILE PINS:
 *   · THE NOISE LEG — while a narration plays, 25 frames (20 ms each, 16 kHz PCM16) of ambient
 *     noise at 300–470 RMS reach the connection. No `narrator_stop` is sent, the queue is untouched,
 *     and the utterance's pacing can still finish (the narration queued behind it plays on ack).
 *   · THE REAL SPEECH LEG — after the same noise, the endpoint's own `speech_started` arrives:
 *     exactly one `narrator_stop` reaches the page, for the utterance standing now, with
 *     `reason: 'user-spoke'`, and everything queued behind it is cleared.
 *   · THE FALSE FORM (`false-form` in the name) — with the seam `narratorInterruptsOnLocalSpeech`
 *     set to `true` (the pre-fix wiring), the SAME noise must produce a `narrator_stop`. That is
 *     what proves the line the fix removed was load-bearing rather than incidental.
 *
 * Driven through `handleVoiceRealtimeConnection` — the real proxy, offline — over the same fake
 * browser socket and fake transport the AC-406 suite uses.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-narrator-local-gate.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeServerMessage, RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeNarratorQueue,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/**
 * A minimal stand-in for the browser's `ws.WebSocket`, satisfying exactly the surface
 * `handleVoiceRealtimeConnection` uses. Mirrors the AC-406 suite's fake — both drive the same
 * handler over the same socket.
 */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  /** Delivers one inbound frame, as the real socket's `'message'` event would. */
  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

type SpeakFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'narrator_speak' }>;
type StopFrame = Extract<VoiceRealtimeOutboundFrame, { type: 'narrator_stop' }>;

const speakFrames = (socket: FakeBrowserSocket): SpeakFrame[] =>
  socket.outbound.filter((frame): frame is SpeakFrame => frame.type === 'narrator_speak');
const stopFrames = (socket: FakeBrowserSocket): StopFrame[] =>
  socket.outbound.filter((frame): frame is StopFrame => frame.type === 'narrator_stop');

/** A session that starts the run now, so a relayed instruction answers `sent` at once. */
function createStartedExecutor(): RealtimeToolExecutor {
  return {
    session_send: async () => ({ ok: true, queued: false, runId: 'run-1', queuedMessageUuid: null }),
  };
}

type Harness = {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  /** The queue the connection handed the composition root through `narrator.attach`. */
  queue: VoiceRealtimeNarratorQueue;
};

/**
 * One connection with the narrator seam wired.
 *
 * `narratorInterruptsOnLocalSpeech` is the seam the false-form leg turns ON; omitted is the shipped
 * rule (the local gate never interrupts the narrator).
 */
function wire(options: { narratorInterruptsOnLocalSpeech?: boolean } = {}): Harness {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  let queue: VoiceRealtimeNarratorQueue | null = null;

  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: createStartedExecutor,
    instructions: 'test instructions',
    narrator: {
      attach: (attached: VoiceRealtimeNarratorQueue) => {
        queue = attached;
      },
      ...(options.narratorInterruptsOnLocalSpeech === undefined
        ? {}
        : { narratorInterruptsOnLocalSpeech: options.narratorInterruptsOnLocalSpeech }),
    },
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  assert.ok(queue !== null, 'the connection must hand the narrator queue to the composition root');
  return { socket, transport, queue };
}

/** Waits until the upstream session is open (the proxy sends `state: open`). */
async function open(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/**
 * One 20 ms frame of 16 kHz mono PCM16 whose RMS is `rms`.
 *
 * A 220 Hz tone is used only because it is a cheap, deterministic way to place a frame's RMS at an
 * exact value; nothing here depends on its spectral content. `Math.SQRT2` is the sine's crest
 * factor (RMS = amplitude / √2), so the produced frame measures `rms` under the same definition the
 * gate uses.
 */
function noiseFrame(rms: number, phase: number): string {
  const samples = 320; // 20 ms at 16 kHz
  const amplitude = rms * Math.SQRT2;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000 + phase));
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return pcm.toString('base64');
}

/**
 * The 25-frame ambient-noise run measured on the live capture: 500 ms, every frame inside the
 * 300–470 RMS band, none of it speech (the same connection's speech reads 1000–10000). Three
 * consecutive frames clear the gate's entry run, so this fixture opens a local `started` boundary
 * exactly as the live noise did — the false-form leg below is what keeps that claim honest.
 */
const NOISE_RMS = [300, 340, 380, 420, 470, 440, 400, 360, 320, 310, 330, 370, 410, 450, 430, 390, 350, 315, 305, 325, 365, 405, 445, 425, 385];

function feedNoise(socket: FakeBrowserSocket): void {
  NOISE_RMS.forEach((rms, index) => {
    socket.receive({ type: 'audio', audio: noiseFrame(rms, index / 3) });
  });
}

/** Asserts the narration queue to the reading the criterion expects (kept in one place). */
function assertReading(queue: VoiceRealtimeNarratorQueue, expected: { current: string | null; queued: number; dropped: number }): void {
  assert.deepEqual(queue.reading(), expected);
}

// ── AC-1: ambient noise alone does NOT stop the narration, and pacing still completes ───────────

test('AC: ambient noise during playback sends no narrator_stop and the narration pacing still completes', async () => {
  const h = wire();
  await open(h.socket, h.transport);

  // A narration is playing and a second one waits behind it — the paced, server-held queue.
  h.queue.enqueue({ utteranceId: 'n-1', text: '工作总结：已经改好了。' });
  h.queue.enqueue({ utteranceId: 'n-2', text: '等你确认下一步。' });
  assert.deepEqual(
    speakFrames(h.socket).map((frame) => frame.utteranceId),
    ['n-1'],
    'exactly the playing narration was sent; the queued one waits for the page’s narrator_done',
  );
  assertReading(h.queue, { current: 'n-1', queued: 1, dropped: 0 });

  // THE LIVE DEFECT'S INPUT: half a second of ambient noise, every frame in the 300–470 band.
  feedNoise(h.socket);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(
    stopFrames(h.socket),
    [],
    'ambient noise is not a person speaking: the narration must NOT be stopped',
  );
  assertReading(h.queue, { current: 'n-1', queued: 1, dropped: 0 });

  // The utterance's pacing still completes: the page acks, and the narration behind it plays.
  h.socket.receive({ type: 'narrator_done', utteranceId: 'n-1' });
  await waitFor(() => speakFrames(h.socket).length === 2);
  assert.deepEqual(
    speakFrames(h.socket).map((frame) => frame.utteranceId),
    ['n-1', 'n-2'],
    'the queue advanced normally — nothing on the noise path interfered with pacing',
  );

  h.socket.close();
});

// ── AC-2: the endpoint's own speech_started still stops the narrator, exactly once ──────────────

test('AC: after the same noise, the endpoint’s speech_started sends exactly one narrator_stop and clears what was queued', async () => {
  const h = wire();
  await open(h.socket, h.transport);

  h.queue.enqueue({ utteranceId: 'n-1', text: '工作总结：已经改好了。' });
  h.queue.enqueue({ utteranceId: 'n-2', text: '等你确认下一步。' });

  // The noise run first — it must leave the narration alone (see the leg above)…
  feedNoise(h.socket);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(stopFrames(h.socket), [], 'the noise alone stops nothing');

  // …then the PRECISE boundary the deployed `server_vad` always fires.
  h.transport.peerSend({ type: 'input_audio_buffer.speech_started' } as RealtimeServerMessage);
  await waitFor(() => stopFrames(h.socket).length === 1);

  assert.deepEqual(
    stopFrames(h.socket),
    [{ type: 'narrator_stop', utteranceId: 'n-1', reason: 'user-spoke' }],
    'exactly one stop, for the narration standing now, with the reason the page needs',
  );
  assertReading(h.queue, { current: null, queued: 0, dropped: 2 });
  assert.deepEqual(
    speakFrames(h.socket).map((frame) => frame.utteranceId),
    ['n-1'],
    'the narration queued behind the stopped one was cleared, never sent',
  );

  // A late ack cannot resurrect the cleared queue.
  h.socket.receive({ type: 'narrator_done', utteranceId: 'n-1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    speakFrames(h.socket).map((frame) => frame.utteranceId),
    ['n-1'],
    'the queued narration stays cleared after the person spoke',
  );

  h.socket.close();
});

// ── AC-3 (false form): the removed wiring is load-bearing — same noise, stop goes out ───────────

test('false-form: with narratorInterruptsOnLocalSpeech=true the same ambient noise DOES stop the narration', async () => {
  const h = wire({ narratorInterruptsOnLocalSpeech: true });
  await open(h.socket, h.transport);

  h.queue.enqueue({ utteranceId: 'n-1', text: '工作总结：已经改好了。' });
  h.queue.enqueue({ utteranceId: 'n-2', text: '等你确认下一步。' });

  feedNoise(h.socket);
  await waitFor(() => stopFrames(h.socket).length === 1);

  assert.deepEqual(
    stopFrames(h.socket),
    [{ type: 'narrator_stop', utteranceId: 'n-1', reason: 'user-spoke' }],
    'with the old wiring restored, the SAME noise mutes the announcement — the red this fix removes',
  );
  assertReading(h.queue, { current: null, queued: 0, dropped: 2 });

  h.socket.close();
});
