/**
 * The server→upstream audio heartbeat: a periodic, dated reading of what the relay has actually
 * pushed onto the upstream socket — and how much of it the socket has NOT managed to write yet.
 *
 * WHY THIS FILE EXISTS. On 2026-10-12 an operator's Live Voice session lost ~50 seconds: the
 * journal showed 118.4 s of complete upstream silence, and the browser-side heartbeat proved the
 * audio arrived, steadily and in real time, the whole way. What could NOT be settled was the
 * decisive question — did the relay push that audio out at the moment it arrived (so the delay
 * was upstream), or did it sit in the socket's own send buffer (so the delay was ours)? The
 * journal could not answer it, because its line formatter drops `input_audio_buffer.append`
 * outright: nothing on disk recorded WHEN audio crossed the server→upstream wire. The relay's
 * two records could not be joined by time, and the investigation ended in "not decidable".
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS THE ASSERTION THAT MATTERS:
 *
 *  - AC1: a line appears EXACTLY at the heartbeat cadence (250 frames = 5.00 s of 20 ms audio,
 *    the same cadence the browser-side `from-browser audio frames=` line uses, so the two are
 *    directly comparable). A criterion that only checked "a line appeared" would pass a heartbeat
 *    that fired on every frame and drowned the journal.
 *  - AC2: `buffered=` is the socket's OWN reading at the instant of the heartbeat. This is the
 *    reading that decides the question above: a buffer that grows across heartbeats is audio the
 *    relay accepted and had not delivered.
 *  - AC2 negative control: a socket that cannot report a buffer says `n/a`. A fabricated `0`
 *    would be indistinguishable from a healthy empty buffer — the exact confusion this line
 *    exists to remove.
 *  - AC3: the readings are CUMULATIVE, so two heartbeats describe the whole connection rather
 *    than the last 5 seconds, and a gap between them is visible as a jump.
 *  - AC4: `bytes=` counts DECODED PCM, not the base64 text. base64 is 4/3 the size, so reporting
 *    the encoded length would overstate every reading by a third — and the whole point is to
 *    compare against what the endpoint was sent.
 *  - AC5: only audio is counted. A heartbeat that counted every outbound frame would move on
 *    `session.update`/`response.create` traffic and stop describing audio at all.
 *  - AC5 fail-open: with no `log` seam the transport still sends and nothing throws. The journal
 *    is a passenger; a transport that cannot record must not stop relaying.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDashscopeTransport, type DashscopeSocket, type DashscopeSocketFactory } from '../index.js';

const TEST_KEY = 'sk-test-heartbeat';

/** 20 ms of 16 kHz mono PCM16, base64 — the same frame the browser sends. */
function audioFrame(): string {
  return Buffer.alloc(640, 7).toString('base64');
}

/** A socket that records what it was handed and reports a buffer the test controls. */
function fakeSocket(options: { withBufferedAmount: boolean }) {
  const state: { buffered: number; socket: DashscopeSocket | null } = { buffered: 0, socket: null };
  const factory: DashscopeSocketFactory = () => {
    const socket: DashscopeSocket = {
      send: () => {},
      close: () => {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    if (options.withBufferedAmount) {
      Object.defineProperty(socket, 'bufferedAmount', { get: () => state.buffered, configurable: true });
    }
    state.socket = socket;
    queueMicrotask(() => socket.onopen?.({}));
    return socket;
  };
  return { factory, state };
}

async function openTransport(seams: { log?: (line: string) => void; withBufferedAmount?: boolean }) {
  const { factory, state } = fakeSocket({ withBufferedAmount: seams.withBufferedAmount ?? true });
  const errors: unknown[] = [];
  const transport = createDashscopeTransport({
    apiKey: TEST_KEY,
    socketFactory: factory,
    onError: (error) => void errors.push(error),
    ...(seams.log === undefined ? {} : { log: seams.log }),
  });
  await transport.open();
  return { transport, state, errors };
}

/** Sends `count` audio frames through the real transport, exactly as the relay's forward does. */
function sendFrames(transport: { send: (message: { type: 'input_audio_buffer.append'; audio: string }) => void }, count: number): void {
  const audio = audioFrame();
  for (let i = 0; i < count; i += 1) transport.send({ type: 'input_audio_buffer.append', audio });
}

test('AC1: the heartbeat fires exactly on the 250-frame cadence, and not before', async () => {
  const lines: string[] = [];
  const { transport } = await openTransport({ log: (line) => void lines.push(line) });

  sendFrames(transport, 249);
  assert.deepEqual(lines, [], 'the heartbeat must not fire before its cadence');

  sendFrames(transport, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^to-upstream audio frames=250 bytes=\d+ buffered=/);
});

test('AC2: buffered= reports the socket\'s own reading at the instant of the heartbeat', async () => {
  const lines: string[] = [];
  const { transport, state } = await openTransport({ log: (line) => void lines.push(line) });

  sendFrames(transport, 250);
  assert.ok(lines[0].endsWith('buffered=0'), `expected an empty buffer reading: ${lines[0]}`);

  state.buffered = 1_638_400;
  sendFrames(transport, 250);
  assert.ok(
    lines[1].endsWith('buffered=1638400'),
    `the backlog reading is the whole point of the line: ${lines[1]}`,
  );
});

test('AC2 negative control: a socket that cannot report a buffer says n/a, never a fabricated 0', async () => {
  const lines: string[] = [];
  const { transport } = await openTransport({ log: (line) => void lines.push(line), withBufferedAmount: false });

  sendFrames(transport, 250);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('buffered=n/a'), `unknown must not read as healthy: ${lines[0]}`);
});

test('AC3: frames and bytes are cumulative across heartbeats', async () => {
  const lines: string[] = [];
  const { transport } = await openTransport({ log: (line) => void lines.push(line) });

  sendFrames(transport, 500);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /frames=250 /);
  assert.match(lines[1], /frames=500 /);
});

test('AC4: bytes= counts decoded PCM, not the base64 text length', async () => {
  const lines: string[] = [];
  const { transport } = await openTransport({ log: (line) => void lines.push(line) });
  const frame = audioFrame();

  sendFrames(transport, 250);
  const decodedPerFrame = Buffer.from(frame, 'base64').length;
  assert.equal(decodedPerFrame, 640);
  assert.ok(
    lines[0].includes(`bytes=${decodedPerFrame * 250}`),
    `expected decoded PCM (${decodedPerFrame * 250}), got: ${lines[0]}`,
  );
});

test('AC5: non-audio traffic does not move the heartbeat', async () => {
  const lines: string[] = [];
  const { transport } = await openTransport({ log: (line) => void lines.push(line) });

  for (let i = 0; i < 300; i += 1) {
    transport.send({ type: 'session.update', session: { instructions: 'x', tools: [] } });
  }
  assert.deepEqual(lines, []);

  sendFrames(transport, 250);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /frames=250 /);
});

test('AC5 fail-open: with no log seam the audio still goes out and nothing throws', async () => {
  const { transport, errors } = await openTransport({});
  sendFrames(transport, 260);
  assert.deepEqual(errors, []);
});
