/**
 * The uplink audio capture's own criteria — the store, its switch, its bound, and its fail-open
 * wrapper. Driven DIRECTLY, so the claims about what lands on disk are read off a temp directory
 * rather than inferred from a live connection (the live path is `…-wiring.test.ts`).
 *
 *  - AC1: with the switch off, ONE recorder run delivers nothing to the sink it was handed and
 *    creates no directory, and the non-realtime store's directory under the same deployment root
 *    gains no file either;
 *  - AC4: the directory is bounded, the connection evicted is the OLDEST WHOLE ONE (audio and
 *    timeline together), the newest survives, and one clear removes the rest and answers how many —
 *    including through the module's real `DELETE /api/voice-realtime/capture` route;
 *  - AC5: a sink that throws is swallowed at the call site and reported exactly ONCE.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { resolveVoiceDataDir } from '../../voice/index.js';
import {
  DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES,
  MIN_VOICE_REALTIME_CAPTURE_MAX_BYTES,
  VOICE_REALTIME_CAPTURE_DEFAULT_SAMPLE_RATE,
  clearVoiceRealtimeCaptureDir,
  createVoiceRealtimeCaptureRecorder,
  createVoiceRealtimeCaptureStore,
  resolveVoiceRealtimeCaptureDir,
  resolveVoiceRealtimeCaptureMaxBytes,
  resolveVoiceRealtimeCaptureMode,
  voiceRealtimeCaptureStartupLine,
  voiceRealtimeCaptureWarningLine,
  type VoiceRealtimeCaptureStore,
} from '../voice-realtime-audio-capture.js';
import { createVoiceRealtimeRouter } from '../voice-realtime.routes.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Every file under `root`, recursively — for the "nothing else was written" check. */
function walk(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

/** `stat -c %a` — the mode as its octal string, read the way the criterion names it. */
function statMode(target: string): string {
  return (statSync(target).mode & 0o777).toString(8);
}

/** Every file directly under `directory`. */
function names(directory: string): string[] {
  return readdirSync(directory).sort();
}

/** The total size of every file directly under `directory`. */
function totalBytes(directory: string): number {
  return names(directory).reduce((sum, name) => sum + statSync(path.join(directory, name)).size, 0);
}

/** One base64 frame of exactly `bytes` PCM bytes, filled with a constant so the audio is recognisable. */
function frameOf(bytes: number, fill = 7): string {
  return Buffer.alloc(bytes, fill).toString('base64');
}

/** The WAV header fields this criterion reads, from the canonical offsets. */
function wavHeader(file: string): { sampleRate: number; channels: number; dataBytes: number; riffBytes: number } {
  const buffer = readFileSync(file);
  return {
    riffBytes: buffer.readUInt32LE(4),
    channels: buffer.readUInt16LE(22),
    sampleRate: buffer.readUInt32LE(24),
    dataBytes: buffer.readUInt32LE(40),
  };
}

test('AC1: an OFF runner delivers nothing to its sink and leaves no trace on disk', () => {
  const root = tempDir('voice-capture-off-');
  try {
    const databasePath = path.join(root, '.cloudcli', 'auth.db');
    const directory = resolveVoiceRealtimeCaptureDir(undefined, databasePath);
    assert.equal(path.basename(directory), 'voice-realtime-capture', 'the default directory sits beside the database');

    // A sink that WOULD record every call. If the OFF recorder ever reaches it, this list is non-empty.
    const delivered: string[] = [];
    const spy: VoiceRealtimeCaptureStore = {
      appendFrame: (base64) => delivered.push(`frame:${base64}`),
      timeline: (event) => delivered.push(`timeline:${event.kind}`),
      finalize: () => delivered.push('finalize'),
      clear: () => ({ deleted: 0 }),
      directory: () => directory,
    };
    const recorder = createVoiceRealtimeCaptureRecorder({
      store: spy,
      connectionId: 'conn-off',
      enabled: false,
      // An OFF recorder must not even reach the error channel; a log here would be a bug, not a fallback.
      stdout: (line) => delivered.push(`stdout:${line}`),
    });

    // The whole life of a connection, through the recorder.
    recorder.frame(frameOf(4_096), VOICE_REALTIME_CAPTURE_DEFAULT_SAMPLE_RATE, 1_000);
    recorder.timeline({ kind: 'speech_started', atMs: 1_000 });
    recorder.observe({ direction: 'received', atMs: 1_000, wire: { type: 'input_audio_buffer.speech_started' } });
    recorder.observe({ direction: 'sent', atMs: 1_000, wire: { type: 'input_audio_buffer.append', audio: 'AAAA' } });
    recorder.finalize();

    assert.deepEqual(delivered, [], 'an OFF recorder delivers nothing to its store — not a byte, not a line');
    assert.equal(existsSync(directory), false, `no capture directory may appear for an OFF deployment (${directory})`);

    // The NON-REALTIME store's directory is a DIFFERENT one, and it gains nothing either: the capture
    // writes where it says it writes, and nowhere a sibling already owns.
    const voiceDataDir = resolveVoiceDataDir(undefined, databasePath);
    assert.notEqual(directory, voiceDataDir, 'the capture and the recordings store are separate directories');
    assert.equal(existsSync(voiceDataDir), false);

    // Nothing at all was written under the deployment root — the strongest form of "no directory".
    assert.deepEqual(walk(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC1: the switch and the ceiling resolve off a raw reading, and a typo is reported, never silent', () => {
  assert.deepEqual(resolveVoiceRealtimeCaptureMode(undefined), { enabled: false, warning: null });
  assert.deepEqual(resolveVoiceRealtimeCaptureMode(''), { enabled: false, warning: null });
  assert.deepEqual(resolveVoiceRealtimeCaptureMode('  off '), { enabled: false, warning: null });
  assert.deepEqual(resolveVoiceRealtimeCaptureMode('on'), { enabled: true, warning: null });
  assert.deepEqual(resolveVoiceRealtimeCaptureMode('audio'), { enabled: true, warning: null });

  // Unrecognised: OFF, and it SAYS which value it refused — a typo must not read as "asked for nothing".
  const typo = resolveVoiceRealtimeCaptureMode('yes');
  assert.equal(typo.enabled, false);
  assert.equal(typo.warning, voiceRealtimeCaptureWarningLine('yes'));
  assert.match(typo.warning ?? '', /"yes"/);

  assert.equal(resolveVoiceRealtimeCaptureMaxBytes(undefined), DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES);
  assert.equal(resolveVoiceRealtimeCaptureMaxBytes('65536'), 65_536);
  // A cap the store cannot act on falls back to the default rather than to "unbounded".
  assert.equal(resolveVoiceRealtimeCaptureMaxBytes('0'), DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES);
  assert.equal(resolveVoiceRealtimeCaptureMaxBytes(String(MIN_VOICE_REALTIME_CAPTURE_MAX_BYTES - 1)), DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES);
  assert.equal(resolveVoiceRealtimeCaptureMaxBytes('nonsense'), DEFAULT_VOICE_REALTIME_CAPTURE_MAX_BYTES);

  assert.equal(voiceRealtimeCaptureStartupLine('/tmp/capture', true), 'voice.realtime.capture dir=/tmp/capture mode=on');
  assert.equal(voiceRealtimeCaptureStartupLine('/tmp/capture', false), 'voice.realtime.capture dir=/tmp/capture mode=off');
});

test('AC4: the directory is bounded, whole-connection oldest first, and the newest survives', () => {
  const root = tempDir('voice-capture-bound-');
  try {
    const directory = path.join(root, 'capture');
    const maxBytes = 64 * 1024;
    const ids = ['conn-a', 'conn-b', 'conn-c', 'conn-d'];

    // Four connections, ~20.5 KiB each — comfortably more than the 64 KiB ceiling once all four land.
    for (const id of ids) {
      const store = createVoiceRealtimeCaptureStore({ directory, connectionId: id, maxBytes });
      for (let index = 0; index < 5; index += 1) {
        store.appendFrame(frameOf(4_096), 16_000, 1_000 + index * 20);
      }
      store.finalize();
    }

    const remaining = names(directory);
    assert.ok(totalBytes(directory) <= maxBytes, `the directory must stay within its ceiling (${totalBytes(directory)} > ${maxBytes})`);
    assert.ok(remaining.length > 0, 'the newest capture is never the one evicted');

    // The OLDEST connection went, and it went WHOLE: its audio and its timeline sidecar together.
    for (const name of names(directory)) {
      assert.ok(!name.startsWith('conn-a'), `the oldest connection must be the one evicted, found ${name}`);
    }
    assert.equal(existsSync(path.join(directory, 'conn-a.wav')), false);
    assert.equal(existsSync(path.join(directory, 'conn-a.timeline.jsonl')), false);
    assert.ok(existsSync(path.join(directory, 'conn-d.wav')), 'the newest connection is still there');

    // The newest capture is INTACT, not truncated: five frames of 4096 bytes each, at its own rate.
    const header = wavHeader(path.join(directory, 'conn-d.wav'));
    assert.equal(header.dataBytes, 5 * 4_096);
    assert.equal(header.riffBytes, 36 + 5 * 4_096, 'the RIFF size field agrees with the payload');
    assert.equal(header.channels, 1);
    assert.equal(header.sampleRate, 16_000);

    // A clear removes the rest and answers how many CONNECTIONS went (one WAV each).
    const survivors = remaining.filter((name) => name.endsWith('.wav')).length;
    assert.deepEqual(createVoiceRealtimeCaptureStore({ directory, connectionId: 'conn-z', maxBytes }).clear(), { deleted: survivors });
    assert.deepEqual(names(directory), [], 'the directory is empty after a clear');

    // A clear with nothing to clear is a success, not an error — including for a directory that is not there.
    assert.deepEqual(clearVoiceRealtimeCaptureDir(directory), { deleted: 0 });
    assert.deepEqual(clearVoiceRealtimeCaptureDir(path.join(root, 'never-existed')), { deleted: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC4: the capture is clearable from OUTSIDE, through the module route', async () => {
  const root = tempDir('voice-capture-route-');
  try {
    const directory = path.join(root, 'capture');
    const store = createVoiceRealtimeCaptureStore({ directory, connectionId: 'conn-a', maxBytes: 64 * 1024 });
    store.appendFrame(frameOf(4_096), 16_000, 1_000);
    store.finalize();

    // AC2's permissions, taken the way an operator would: mode 0700 on the directory, 0600 on the file.
    assert.equal(statMode(directory), '700');
    assert.equal(statMode(path.join(directory, 'conn-a.wav')), '600');
    assert.equal(statMode(path.join(directory, 'conn-a.timeline.jsonl')), '600');

    const app = express();
    app.use(
      '/api/voice-realtime',
      createVoiceRealtimeRouter({
        diagnose: async () => {
          throw new Error('diagnose is not part of this criterion');
        },
        clearCapture: () => clearVoiceRealtimeCaptureDir(directory),
      }),
    );
    await withApp(app, async (port) => {
      const cleared = await request(port, 'DELETE', '/api/voice-realtime/capture');
      assert.equal(cleared.status, 200);
      assert.deepEqual(cleared.body, { deleted: 1 });
      assert.deepEqual(names(directory), [], 'the capture is gone');

      const again = await request(port, 'DELETE', '/api/voice-realtime/capture');
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, { deleted: 0 });
    });

    // A deployment that wired no capture still answers the same shape rather than 404.
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
      const unconfigured = await request(port, 'DELETE', '/api/voice-realtime/capture');
      assert.equal(unconfigured.status, 200);
      assert.deepEqual(unconfigured.body, { deleted: 0 });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC5: a sink that throws is swallowed at the call site and reported exactly once', () => {
  const store: VoiceRealtimeCaptureStore = {
    appendFrame: () => {
      throw new Error('disk is full');
    },
    timeline: () => {
      throw new Error('disk is full');
    },
    finalize: () => {
      throw new Error('disk is full');
    },
    clear: () => ({ deleted: 0 }),
    directory: () => '/nowhere',
  };
  const stdout: string[] = [];
  const recorder = createVoiceRealtimeCaptureRecorder({
    store,
    connectionId: 'conn-failing',
    enabled: true,
    stdout: (line) => stdout.push(line),
  });

  // Every entry point completes: the capture is a passenger on the call, and a passenger that cannot be
  // recorded must not end it.
  assert.doesNotThrow(() => recorder.frame(frameOf(4_096), 16_000, 1_000));
  assert.doesNotThrow(() => recorder.frame(frameOf(4_096), 16_000, 1_020));
  assert.doesNotThrow(() => recorder.timeline({ kind: 'speech_stopped', atMs: 1_040 }));
  assert.doesNotThrow(() => recorder.observe({ direction: 'received', atMs: 1_040, wire: { type: 'input_audio_buffer.speech_stopped' } }));
  assert.doesNotThrow(() => recorder.finalize());

  // …and it says so ONCE, with the reason — a failure repeated per frame would drown the server log.
  const errors = stdout.filter((line) => line.includes('audio capture write failed'));
  assert.equal(errors.length, 1, `exactly one error line, got ${errors.length}: ${stdout.join(' | ')}`);
  assert.match(errors[0] ?? '', /disk is full/);

  // An OFF recorder never even reaches the failing sink (and so never errors).
  const quiet: string[] = [];
  const off = createVoiceRealtimeCaptureRecorder({ store, connectionId: 'conn-off', enabled: false, stdout: (line) => quiet.push(line) });
  assert.doesNotThrow(() => off.frame(frameOf(4_096), 16_000, 1_000));
  assert.deepEqual(quiet, []);
});

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
