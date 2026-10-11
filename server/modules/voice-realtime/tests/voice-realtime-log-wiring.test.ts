/**
 * The relay journal as the APPLICATION writes it — driven by the real proxy over the real transport.
 *
 * WHY THIS FILE EXISTS, SEPARATELY FROM `voice-realtime-log.test.ts`. The unit criterion proves the
 * store and the classifier behave; it cannot prove the journal is FILLED BY A RUNNING CONNECTION. This
 * one drives the shipped `/voice-realtime` handler (`handleVoiceRealtimeConnection`) over the REAL
 * DashScope transport — a fake upstream stands in for the endpoint's socket, exactly as
 * `voice-realtime-ws-proxy.real-transport.test.ts` does, so everything between the browser and the
 * wire is production code — and reads the journal the recorder wrote. The three claims that need a
 * real run are all here:
 *
 *  - AC1: after one connection the journal exists and carries the connection and its mode, each
 *    segment's `seq`/duration/frames, each response's tokens with the text/audio split and the
 *    estimate, each `session_send`'s latency and outcome, and a rotation reading — with the directory
 *    at 0700 and the file at 0600 (`stat -c %a`, the same reading an operator would take);
 *  - AC5: the per-response token entries SUM to exactly the `connection total input=… output=…` line
 *    the recorder printed on stdout — read from both places rather than trusted from one;
 *  - AC6: the record is the application's own. No stdout redirect is set, nothing named `server.log`
 *    appears, and the non-realtime store's directory under the same root gains ZERO files.
 *
 * HOW THE ROTATION READING IS PRODUCED. Through the real pool (`createUpstreamPool`), wired the one
 * way the proxy wires it: `log` is the recorder's own, so the SPEC §C3 `upstream-pool rotate …` line
 * lands in the same journal as everything else. It is driven directly rather than through a second
 * proxied connection because the shared fake upstream answers only the LAST socket it dialled, and a
 * pool holds two — a proxied rotation would send this criterion's frames to the standby. The pool
 * itself is the shipped one, so what is being asserted (the line, its fields, and that the recorder
 * files it under `rotation`) is the production path.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { WebSocket as WS } from 'ws';

import { createDashscopeTransport, createUpstreamPool, connect, VOICE_REALTIME_TOOLS, type RealtimeToolExecutor } from '../index.js';
import { handleVoiceRealtimeConnection, VOICE_REALTIME_INSTRUCTIONS, type VoiceRealtimeOutboundFrame } from '../voice-realtime-ws-proxy.service.js';
import { createVoiceRealtimeRouter } from '../voice-realtime.routes.js';
import {
  createVoiceRealtimeLogStore,
  createVoiceRealtimeRecorder,
  resolveVoiceRealtimeLogDir,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeLogRecorder,
} from '../voice-realtime-log.js';
import { resolveVoiceDataDir } from '../../voice/index.js';

import { createFakeTransport, waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

const TEST_KEY = 'sk-test-not-a-real-key';
const BOUND_SESSION = 'session-under-test';
const CONNECTION_ID = 'connection-under-test';

/** The slice of the browser socket the proxy touches — plus `receive`, the browser's side. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  /** One browser→server frame, as JSON over the socket. */
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

function readEntries(directory: string, connectionId: string): VoiceRealtimeLogEntry[] {
  const file = path.join(directory, `${connectionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as VoiceRealtimeLogEntry);
}

/** `stat -c %a` — the mode as its octal string, read the way the criterion names it. */
function statMode(target: string): string {
  return (statSync(target).mode & 0o777).toString(8);
}

/** Every file under `root`, recursively — for the "nothing else was written" checks. */
function walk(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, name.name);
    if (name.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

/** Builds a connection recorder over a fresh temp directory and the fake upstream it dials. */
function harness(): {
  socket: FakeBrowserSocket;
  upstream: ReturnType<typeof createFakeDashscopeServer>;
  stdout: string[];
  directory: string;
  store: ReturnType<typeof createVoiceRealtimeLogStore>;
  recorder: VoiceRealtimeLogRecorder;
  sends: Array<Record<string, unknown>>;
  root: string;
} {
  const root = tempDir('voice-realtime-log-wiring-');
  const directory = resolveVoiceRealtimeLogDir(undefined, path.join(root, '.cloudcli', 'auth.db'));
  const store = createVoiceRealtimeLogStore({ directory });
  const stdout: string[] = [];
  const recorder = createVoiceRealtimeRecorder({
    store,
    connectionId: CONNECTION_ID,
    sessionId: BOUND_SESSION,
    tag: 'session-',
    mode: 'segmented',
    stdout: (line) => stdout.push(line),
  });

  const socket = new FakeBrowserSocket();
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const sends: Array<Record<string, unknown>> = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push(args);
      return { runId: 'run-1', queued: false };
    },
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
    // The composition root's construction, minus the pool: the REAL transport over a fake socket, with
    // the recorder where `server/index.ts` puts it (`observer` inside the transport, `log` on the seams).
    createTransport: (report) =>
      createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: upstream.socketFactory, onError: report, observer: recorder.observe }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
    segmentedRelay: true,
    log: recorder.log,
  });
  return { socket, upstream, stdout, directory, store, recorder, sends, root };
}

test('AC1 + AC5: one live connection leaves a journal with its readings, and the per-response tokens sum to the usage line', async () => {
  const h = harness();
  try {
    await waitFor(() => opened(h.socket));

    // The segmented relay handshake, then one utterance cut into two frames.
    h.socket.receive({ type: 'hello', protocol: 'segmented-v1' });
    await waitFor(() => h.socket.outbound.some((frame) => frame.type === 'ready'));
    h.socket.receive({ type: 'segment_start', seq: 1, startedAtMs: 1_000 });
    h.socket.receive({ type: 'audio', seq: 1, audio: 'AAAA' });
    h.socket.receive({ type: 'audio', seq: 1, audio: 'AAAA' });
    h.socket.receive({ type: 'segment_end', seq: 1, durationMs: 412, reason: 'gap' });
    await waitFor(() => readEntries(h.directory, CONNECTION_ID).some((entry) => entry.kind === 'segment'));

    // A spoken instruction the model relays, and two answered responses with per-response usage.
    h.upstream.peerSend({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'session_send',
      arguments: JSON.stringify({ message: '把超时改成三十秒' }),
    });
    await waitFor(() => readEntries(h.directory, CONNECTION_ID).some((entry) => entry.kind === 'session_send'));

    h.upstream.peerSend({
      type: 'response.done',
      response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 9_230, output_tokens: 120, input_tokens_details: { text_tokens: 9_000, audio_tokens: 230 } } },
    });
    h.upstream.peerSend({
      type: 'response.done',
      response: { id: 'resp_2', status: 'completed', usage: { input_tokens: 5_000, output_tokens: 60, input_tokens_details: { text_tokens: 4_100, audio_tokens: 900 } } },
    });
    await waitFor(() => readEntries(h.directory, CONNECTION_ID).filter((entry) => entry.kind === 'response').length === 2);

    // The rotation reading, produced by the real pool wired the way the proxy wires it.
    const pool = createUpstreamPool({
      createSession: (hooks) => connect(createFakeTransport(), VOICE_REALTIME_TOOLS, executorForPool(), { hooks }),
      idleRotateMs: 20,
      log: h.recorder.log,
    });
    try {
      await pool.whenConnected();
      await waitFor(() => readEntries(h.directory, CONNECTION_ID).some((entry) => entry.kind === 'rotation'), 5_000);
    } finally {
      await pool.close();
    }

    h.socket.close();

    const entries = readEntries(h.directory, CONNECTION_ID);
    const connection = entries[0] as Extract<VoiceRealtimeLogEntry, { kind: 'connection' }>;
    assert.equal(connection.kind, 'connection');
    assert.equal(connection.connectionId, CONNECTION_ID);
    assert.equal(connection.sessionId, BOUND_SESSION);
    assert.equal(connection.mode, 'segmented');

    const segment = entries.find((entry) => entry.kind === 'segment') as Extract<VoiceRealtimeLogEntry, { kind: 'segment' }>;
    assert.equal(segment.seq, 1);
    assert.equal(segment.durationMs, 412);
    assert.equal(segment.frames, 2, 'two audio frames carried this segment');

    const send = entries.find((entry) => entry.kind === 'session_send') as Extract<VoiceRealtimeLogEntry, { kind: 'session_send' }>;
    assert.equal(send.outcome, 'delivered');
    assert.equal(typeof send.latencyMs, 'number');
    assert.ok(send.latencyMs >= 0);
    assert.equal(send.message, '把超时改成三十秒', 'the journal names WHICH text was delivered');
    assert.deepEqual(h.sends.map((args) => args.message), ['把超时改成三十秒']);

    // The fixed prefix — the instructions plus the tool declarations the session was opened with — is
    // what a per-component cost breakdown reads against. It is recorded once, from the real
    // `session.update` the transport put on the wire.
    const prefix = entries.find((entry) => entry.kind === 'prefix') as Extract<VoiceRealtimeLogEntry, { kind: 'prefix' }>;
    assert.ok(prefix !== undefined, 'the fixed prefix is recorded');
    assert.equal(prefix.tools, 3, 'the voice plane advertises session_send, session_interrupt and session_status');
    assert.ok(prefix.instructionsChars > 0, 'the instruction size is recorded');

    const responses = entries.filter((entry) => entry.kind === 'response') as Array<Extract<VoiceRealtimeLogEntry, { kind: 'response' }>>;
    assert.equal(responses.length, 2);
    assert.equal(responses[0]!.textTokens, 9_000);
    assert.equal(responses[0]!.audioTokens, 230);
    assert.ok(responses[0]!.costCny > 0, 'the estimate is recorded, not left to arithmetic');

    const rotation = entries.find((entry) => entry.kind === 'rotation') as Extract<VoiceRealtimeLogEntry, { kind: 'rotation' }>;
    assert.equal(rotation.from, 1);
    assert.equal(rotation.to, 2);
    assert.equal(typeof rotation.switchMs, 'number');
    assert.ok(rotation.switchMs >= 0);

    // AC5: the record's own sums, against the line the same run printed on stdout.
    const usageLines = h.stdout.map((line) => /usage connection total input=(\d+) output=(\d+) cost~CNY([\d.]+)/.exec(line)).filter((m) => m !== null);
    assert.ok(usageLines.length >= 1, 'the usage line was printed');
    const last = usageLines[usageLines.length - 1]!;
    const recordedInput = responses.reduce((sum, entry) => sum + entry.inputTokens, 0);
    const recordedOutput = responses.reduce((sum, entry) => sum + entry.outputTokens, 0);
    assert.equal(String(recordedInput), last[1], 'per-response input sums to the printed connection total');
    assert.equal(String(recordedOutput), last[2], 'per-response output sums to the printed connection total');
    assert.equal(recordedInput, 14_230);
    assert.equal(recordedOutput, 180);

    // AC1's permissions, read the way the criterion names them.
    assert.equal(statMode(h.directory), '700');
    assert.equal(statMode(path.join(h.directory, `${CONNECTION_ID}.jsonl`)), '600');
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('AC3: the journal is clearable from OUTSIDE, through the module route', async () => {
  const root = tempDir('voice-realtime-log-route-');
  try {
    const store = createVoiceRealtimeLogStore({ directory: path.join(root, 'journal') });
    store.append({ at: '2026-10-10T00:00:00.000Z', kind: 'connection', connectionId: 'a', sessionId: 's', tag: 's', mode: 'segmented' });
    store.append({ at: '2026-10-10T00:00:00.000Z', kind: 'connection', connectionId: 'b', sessionId: 's', tag: 's', mode: 'segmented' });

    const app = express();
    app.use(
      '/api/voice-realtime',
      createVoiceRealtimeRouter({
        // Never called by this criterion: the route under test is the DELETE.
        diagnose: async () => {
          throw new Error('diagnose is not part of this criterion');
        },
        clearLog: () => store.clear(),
      }),
    );
    await withApp(app, async (port) => {
      const cleared = await request(port, 'DELETE', '/api/voice-realtime/log');
      assert.equal(cleared.status, 200);
      assert.deepEqual(cleared.body, { deleted: 2 });
      assert.deepEqual(readdirSync(path.join(root, 'journal')), [], 'the records are gone');

      // A second clear has nothing to remove.
      const again = await request(port, 'DELETE', '/api/voice-realtime/log');
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, { deleted: 0 });
    });

    // A deployment with no store wired still answers the same shape rather than 404.
    const bare = express();
    bare.use(
      '/api/voice-realtime',
      createVoiceRealtimeRouter({
        diagnose: async () => {
          throw new Error('diagnose is not part of this criterion');
        },
      }),
    );
    await withApp(bare, async (port) => {
      const unconfigured = await request(port, 'DELETE', '/api/voice-realtime/log');
      assert.equal(unconfigured.status, 200);
      assert.deepEqual(unconfigured.body, { deleted: 0 });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC6: the record is the application\'s own — no redirect, and the non-realtime store gains nothing', async () => {
  const root = tempDir('voice-realtime-log-own-');
  try {
    // Both stores resolved from the SAME database path, so "the sibling store" is unambiguous.
    const databasePath = path.join(root, '.cloudcli', 'auth.db');
    const relayDir = resolveVoiceRealtimeLogDir(undefined, databasePath);
    const voiceDataDir = resolveVoiceDataDir(undefined, databasePath);
    assert.notEqual(relayDir, voiceDataDir, 'the two stores are separate directories');

    const store = createVoiceRealtimeLogStore({ directory: relayDir });
    const recorder = createVoiceRealtimeRecorder({
      store,
      connectionId: CONNECTION_ID,
      sessionId: BOUND_SESSION,
      tag: 'session-',
      mode: 'segmented',
      stdout: () => {},
    });
    const socket = new FakeBrowserSocket();
    const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
    handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], BOUND_SESSION, {
      createTransport: (report) =>
        createDashscopeTransport({ apiKey: TEST_KEY, socketFactory: upstream.socketFactory, onError: report, observer: recorder.observe }),
      createExecutor: () => ({ session_send: async () => ({ runId: 'r' }) }),
      instructions: VOICE_REALTIME_INSTRUCTIONS,
      segmentedRelay: true,
      log: recorder.log,
    });
    await waitFor(() => opened(socket));
    socket.receive({ type: 'hello', protocol: 'segmented-v1' });
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'ready'));
    socket.close();

    // The record appeared with NO stdout redirect: nothing spawned this process with its output
    // appended anywhere, and the only copy is the one the application wrote itself.
    assert.ok(existsSync(path.join(relayDir, `${CONNECTION_ID}.jsonl`)), 'the record exists without a redirect');
    assert.ok(readEntries(relayDir, CONNECTION_ID).length > 0);

    // The non-realtime store's directory has ZERO new files: the relay did not quietly write into it.
    assert.equal(existsSync(voiceDataDir), false, `the non-realtime store directory must not appear (${voiceDataDir})`);

    // And nothing named `server.log` was produced anywhere under the root.
    const logs = walk(root).filter((file) => path.basename(file) === 'server.log');
    assert.deepEqual(logs, [], 'no stdout redirect artifact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A minimal executor for the pool's sessions (the pool never asks it to do anything here). */
function executorForPool(): RealtimeToolExecutor {
  return { session_send: async () => ({ runId: 'pool' }) };
}

/** Binds `app` on an ephemeral port, runs `fn`, and always closes the server. */
async function withApp<T>(app: express.Express, fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(app as unknown as http.RequestListener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** One HTTP request against a locally-bound express app. */
function request(port: number, method: string, pathname: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += String(chunk);
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
