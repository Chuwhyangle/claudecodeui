/**
 * Stage R — a RECORDED real upstream session replayed through the proxy.
 *
 * Hand-written fake upstreams only ever say what their author thought of; the real endpoint
 * said `session.updated` (killed every session), `transcription.failed`, its own `error`
 * events and fragment-by-fragment function calls, none of which a stand-in produced. This
 * replays an actual capture (`fixtures/real-run-qwen38-four-utterances.json`, see its README)
 * through the real transport and the real proxy, with the executor stubbed, and asserts what
 * the BROWSER would have been told. The assertion that matters most is the first: a healthy
 * real session produces zero error frames — the whole event vocabulary of the real endpoint
 * is understood.
 *
 * Re-recording: feed a WAV through `createDashscopeTransport({ observer })` under `connect()`
 * with the real key, keep every `received` wire with its offset, write the JSON array.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, type RealtimeToolExecutor } from '../index.js';
import { handleVoiceRealtimeConnection, VOICE_REALTIME_INSTRUCTIONS, type VoiceRealtimeOutboundFrame } from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

type Recorded = { atMs: number; wire: Record<string, unknown> };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDING: Recorded[] = JSON.parse(
  readFileSync(path.join(HERE, 'fixtures/real-run-qwen38-four-utterances.json'), 'utf8'),
) as Recorded[];

/** The recording is ~14 s of wall clock; replaying it 30× faster keeps the order and the overlap. */
const TIME_SCALE = 30;

class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];
  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }
  close(): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close');
  }
  audio(audio: string): void {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'audio', audio }), 'utf8'));
  }
}

const recordedFinals = RECORDING.filter((entry) => entry.wire.type === 'conversation.item.input_audio_transcription.completed').map(
  (entry) => String(entry.wire.transcript),
);
const recordedSends = RECORDING.filter(
  (entry) => entry.wire.type === 'response.function_call_arguments.done' && entry.wire.name === 'session_send',
).map((entry) => (JSON.parse(String(entry.wire.arguments)) as { message: string }).message);

test('replaying a real session: the browser is told exactly what was heard and sent, and never an error', async () => {
  assert.ok(recordedFinals.length >= 4 && recordedSends.length >= 3, 'the fixture must keep its shape');

  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const delivered: string[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      delivered.push(String(args.message));
      return { runId: 'r', queued: false };
    },
  };
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: (report) => createDashscopeTransport({ apiKey: 'sk-test', socketFactory: upstream.socketFactory, onError: report }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
  });
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

  // The fake upstream already answered our session.update with its own created/updated; the
  // recording's copies are skipped so the session is not announced twice.
  for (const entry of RECORDING) {
    if (entry.wire.type === 'session.created' || entry.wire.type === 'session.updated') continue;
    setTimeout(() => upstream.peerSend(entry.wire), entry.atMs / TIME_SCALE);
  }
  const lastAt = RECORDING[RECORDING.length - 1]!.atMs / TIME_SCALE;

  await waitFor(() => socket.outbound.filter((frame) => frame.type === 'sent').length === recordedSends.length, lastAt + 5_000);

  const errors = socket.outbound.filter((frame) => frame.type === 'error');
  assert.deepEqual(errors, [], 'a healthy real session must produce no error frames');

  const finals = socket.outbound
    .filter((frame): frame is Extract<VoiceRealtimeOutboundFrame, { type: 'caption' }> => frame.type === 'caption' && frame.final)
    .map((frame) => frame.text);
  assert.deepEqual(finals, recordedFinals);
  assert.deepEqual(delivered, recordedSends, 'every call the model made reached the executor, in order');

  // Each call was answered upstream, so the model is not left waiting.
  const outputs = upstream.sent.filter((frame) => frame.type === 'conversation.item.create');
  assert.equal(outputs.length, recordedSends.length);
  socket.close();
});
