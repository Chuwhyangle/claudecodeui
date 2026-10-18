/**
 * The live relay journal store and recorder, on their own.
 *
 * WHAT THIS FILE OWNS. The relay journal has two halves that fail in different ways, and this file
 * drives each of them where a failure is cheap to read:
 *
 *  - the STORE — the bytes, the permissions, the ceiling and the clear. Everything here is asserted
 *    against a temp directory, so the criteria never touch (and never depend on) a real deployment's
 *    journal. The permission bits, the oldest-first eviction and the "a clear that cleared nothing is
 *    a clear that succeeded" answer are all this half's;
 *  - the RECORDER — the classification of the proxy's log lines into structured readings, and the
 *    FAIL-OPEN contract: a store that cannot be written must not cost the caller the call it was
 *    describing, and must say so exactly once.
 *
 * WHY THE EVICTION CASE WRITES N CONNECTIONS. One journal file per connection is the store's shape, so
 * the "oldest is evicted" claim is only observable across files: N connections written in order, a
 * ceiling that holds a few of them, and the oldest gone while the newest stays. (Within one
 * connection the file itself is never a deletion candidate — see `evictToLimit` — so a single busy
 * connection cannot have its own record trimmed out from under it.)
 *
 * Fully offline, no upstream, no sockets.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES,
  MIN_VOICE_REALTIME_LOG_MAX_BYTES,
  VOICE_REALTIME_LOG_MAX_BYTES_ENV,
  createVoiceRealtimeLogStore,
  createVoiceRealtimeRecorder,
  resolveVoiceRealtimeLogDir,
  resolveVoiceRealtimeLogMaxBytes,
  voiceRealtimeLogDirStartupLine,
  type VoiceRealtimeLogEntry,
  type VoiceRealtimeLogStore,
} from '../voice-realtime-log.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** The entries in one connection's journal, in the order they were written. */
function readEntries(directory: string, connectionId: string): VoiceRealtimeLogEntry[] {
  const raw = readFileSync(path.join(directory, `${connectionId}.jsonl`), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as VoiceRealtimeLogEntry);
}

/** The bytes of every file directly under the directory. */
function totalBytes(directory: string): number {
  return readdirSync(directory).reduce((sum, name) => sum + statSync(path.join(directory, name)).size, 0);
}

test('the directory resolver takes an explicit override, else sits beside the database', () => {
  assert.equal(resolveVoiceRealtimeLogDir('/tmp/elsewhere', '/home/u/.cloudcli/auth.db'), '/tmp/elsewhere');
  assert.equal(resolveVoiceRealtimeLogDir('  /tmp/padded  ', '/home/u/.cloudcli/auth.db'), '/tmp/padded');
  // Beside the database, the same shape `resolveVoiceDataDir` uses — its own leaf, its own name.
  assert.equal(
    resolveVoiceRealtimeLogDir(undefined, '/home/u/.cloudcli/auth.db'),
    path.join('/home/u/.cloudcli', 'voice-realtime-log'),
  );
  // A blank database path falls back to the shipped home location rather than to a relative path.
  assert.equal(
    resolveVoiceRealtimeLogDir('', '   '),
    path.join(homedir(), '.cloudcli', 'voice-realtime-log'),
  );
  assert.equal(voiceRealtimeLogDirStartupLine('/tmp/x'), 'voice.realtime.log dir=/tmp/x');
});

test('the ceiling resolver honours a usable value and falls back to the default for one it cannot act on', () => {
  assert.equal(resolveVoiceRealtimeLogMaxBytes(undefined), DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES);
  assert.equal(resolveVoiceRealtimeLogMaxBytes(''), DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES);
  assert.equal(resolveVoiceRealtimeLogMaxBytes('8192'), 8192);
  assert.equal(resolveVoiceRealtimeLogMaxBytes('8192.9'), 8192, 'the ceiling stays an integer number of bytes');
  // Below the floor, or not a number at all: the DEFAULT, never "unbounded" — a malformed cap must not
  // be the one that lets the directory grow without a limit.
  assert.equal(resolveVoiceRealtimeLogMaxBytes(String(MIN_VOICE_REALTIME_LOG_MAX_BYTES - 1)), DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES);
  assert.equal(resolveVoiceRealtimeLogMaxBytes('not-a-number'), DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES);
  assert.equal(resolveVoiceRealtimeLogMaxBytes('-1'), DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES);
  assert.equal(resolveVoiceRealtimeLogMaxBytes('Infinity'), DEFAULT_VOICE_REALTIME_LOG_MAX_BYTES);
});

test('the store writes one journal per connection, 0700/0600, as parseable JSONL', () => {
  const root = tempDir('voice-realtime-log-unit-');
  try {
    const directory = path.join(root, 'voice-realtime-log');
    const store = createVoiceRealtimeLogStore({ directory });
    assert.equal(store.directory(), directory);

    store.append({ at: '2026-10-10T00:00:00.000Z', kind: 'connection', connectionId: 'conn-a', sessionId: 's1', tag: 's1', mode: 'segmented' });
    store.append({ at: '2026-10-10T00:00:01.000Z', kind: 'log', connectionId: 'conn-a', line: 'hello: declaring segmented-v1' });
    store.append({ at: '2026-10-10T00:00:02.000Z', kind: 'log', connectionId: 'conn-b', line: 'other connection' });

    assert.deepEqual(readdirSync(directory).sort(), ['conn-a.jsonl', 'conn-b.jsonl']);
    const entries = readEntries(directory, 'conn-a');
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.kind, 'connection');

    // The explicit chmod defeats this process's umask, which is the whole point of doing it explicitly.
    assert.equal(statSync(directory).mode & 0o777, 0o700, 'the directory is 0700');
    assert.equal(statSync(path.join(directory, 'conn-a.jsonl')).mode & 0o777, 0o600, 'the journal file is 0600');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC2: the ceiling names the byte bound, and the OLDEST connection is evicted while the newest stays', () => {
  const root = tempDir('voice-realtime-log-cap-');
  try {
    // The cap comes from the deployment's variable — read here exactly as the composition root reads
    // it (the variable's value into the pure resolver), so the criterion is tied to the NAME too.
    process.env[VOICE_REALTIME_LOG_MAX_BYTES_ENV] = '8192';
    const store = createVoiceRealtimeLogStore({
      directory: path.join(root, 'journal'),
      maxBytes: resolveVoiceRealtimeLogMaxBytes(process.env[VOICE_REALTIME_LOG_MAX_BYTES_ENV]),
    });
    delete process.env[VOICE_REALTIME_LOG_MAX_BYTES_ENV];

    const names: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      // Zero-padded so the file names sort in insertion order, which keeps "oldest first" a property
      // of the name as well as of the mtime — the tie-break `evictToLimit` uses.
      const connectionId = `conn-${String(index).padStart(3, '0')}`;
      names.push(connectionId);
      store.append({
        at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
        kind: 'log',
        connectionId,
        line: `segment seq=${index} dur=${index}ms reason=gap frames=${index}`,
      });
    }

    const directory = path.join(root, 'journal');
    assert.ok(totalBytes(directory) <= 8192, `the directory must stay within the cap (was ${totalBytes(directory)})`);
    assert.ok(existsSync(path.join(directory, `${names[names.length - 1]}.jsonl`)), 'the newest connection stays');
    assert.equal(existsSync(path.join(directory, `${names[0]}.jsonl`)), false, 'the oldest connection is evicted');
    assert.ok(readdirSync(directory).length < names.length, 'some records were actually removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clear() removes the records and answers how many; a directory that does not exist is 0, not an error', () => {
  const root = tempDir('voice-realtime-log-clear-');
  try {
    const directory = path.join(root, 'journal');
    const store = createVoiceRealtimeLogStore({ directory });

    // Nothing has been written, so the directory does not exist yet — the success case of a clear.
    assert.deepEqual(store.clear(), { deleted: 0 });

    store.append({ at: '2026-10-10T00:00:00.000Z', kind: 'connection', connectionId: 'one', sessionId: 's', tag: 's', mode: 'continuous' });
    store.append({ at: '2026-10-10T00:00:00.000Z', kind: 'connection', connectionId: 'two', sessionId: 's', tag: 's', mode: 'continuous' });
    assert.deepEqual(store.clear(), { deleted: 2 });
    assert.deepEqual(readdirSync(directory), [], 'the directory is emptied');
    assert.deepEqual(store.clear(), { deleted: 0 }, 'clearing again is not an error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the recorder turns the proxy\'s lines into structured readings', () => {
  const root = tempDir('voice-realtime-log-classify-');
  try {
    const directory = path.join(root, 'journal');
    const store = createVoiceRealtimeLogStore({ directory });
    const stdout: string[] = [];
    const recorder = createVoiceRealtimeRecorder({
      store,
      connectionId: 'conn-shape',
      sessionId: 'session-under-test',
      tag: 'session-',
      mode: 'segmented',
      stdout: (line) => stdout.push(line),
    });

    recorder.log('segment seq=3 dur=412ms reason=gap frames=17 at=2026-10-10T00:00:00.000Z');
    recorder.log('session_send start {"message":"把超时改成三十秒"}');
    recorder.log('session_send delivered in 42 ms');
    recorder.log('session_send start {"message":"second"}');
    recorder.log('session_send failed after 7 ms: upstream refused');
    recorder.log('upstream-pool rotate from=1 to=2 idleMs=90000 standbyAgeMs=512 switchMs=13');
    recorder.log(
      'omission_fill params {"hMs":12000,"gMs":1000,"scoreT":0.25,"wMin":7,"wHallu":12,"domN":10,"lookbackMs":1000,"silenceMs":3000,"numeralMode":"runs2"}',
    );
    recorder.log('omission_fill {"i":2,"dueAt":1760000011000,"coverage":0.125,"reason":"fill"}');
    recorder.log('omission_fill {"i":3,"reason":"covered"}');
    recorder.log('a line the classifier does not know');

    const entries = readEntries(directory, 'conn-shape');
    const byKind = (kind: VoiceRealtimeLogEntry['kind']) => entries.filter((entry) => entry.kind === kind);

    assert.equal(byKind('connection').length, 1, 'the header is first, once');
    assert.equal(entries[0]!.kind, 'connection');

    const segment = byKind('segment')[0] as Extract<VoiceRealtimeLogEntry, { kind: 'segment' }>;
    assert.equal(segment.seq, 3);
    assert.equal(segment.durationMs, 412);
    assert.equal(segment.frames, 17);
    assert.equal(segment.reason, 'gap');

    const sends = byKind('session_send') as Array<Extract<VoiceRealtimeLogEntry, { kind: 'session_send' }>>;
    assert.equal(sends.length, 2, 'the start line is not its own entry: one send is one entry');
    assert.equal(sends[0]!.outcome, 'delivered');
    assert.equal(sends[0]!.latencyMs, 42);
    assert.equal(sends[0]!.message, '把超时改成三十秒');
    assert.equal(sends[1]!.outcome, 'failed');
    assert.equal(sends[1]!.latencyMs, 7);
    assert.equal(sends[1]!.error, 'upstream refused');

    const fillParams = byKind('omission_fill_params')[0] as Extract<VoiceRealtimeLogEntry, { kind: 'omission_fill_params' }>;
    assert.equal(fillParams.params.hMs, 12000, 'the parameters are readable as fields, not only prose');
    const fills = byKind('omission_fill') as Array<Extract<VoiceRealtimeLogEntry, { kind: 'omission_fill' }>>;
    assert.equal(fills.length, 2, 'one decision per candidate line');
    assert.equal(fills[0]!.index, 2);
    assert.equal(fills[0]!.reason, 'fill');
    assert.equal(fills[0]!.dueAt, 1760000011000);
    assert.equal(fills[0]!.coverage, 0.125);
    assert.equal(fills[1]!.index, 3);
    assert.equal(fills[1]!.reason, 'covered');
    assert.equal(fills[1]!.dueAt, undefined, 'a skip carries no decision time');

    const rotation = byKind('rotation')[0] as Extract<VoiceRealtimeLogEntry, { kind: 'rotation' }>;
    assert.equal(rotation.from, 1);
    assert.equal(rotation.to, 2);
    assert.equal(rotation.idleMs, 90_000);
    assert.equal(rotation.standbyAgeMs, 512);
    assert.equal(rotation.switchMs, 13);

    // An unrecognised line is kept verbatim rather than dropped: the journal is a superset of the
    // stdout record, not a summary that discarded what it did not classify.
    const raw = byKind('log') as Array<Extract<VoiceRealtimeLogEntry, { kind: 'log' }>>;
    assert.ok(raw.some((entry) => entry.line === 'a line the classifier does not know'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the recorder records the fixed prefix once and every response with its text/audio split and cost', () => {
  const root = tempDir('voice-realtime-log-observe-');
  try {
    const directory = path.join(root, 'journal');
    const store = createVoiceRealtimeLogStore({ directory });
    const recorder = createVoiceRealtimeRecorder({
      store,
      connectionId: 'conn-usage',
      sessionId: 's',
      tag: 's',
      mode: 'segmented',
      stdout: () => {},
    });

    const sessionUpdate = { type: 'session.update', session: { instructions: 'x'.repeat(120), tools: [{}, {}] } };
    recorder.observe({ direction: 'sent', atMs: 0, wire: sessionUpdate });
    // A second update (the pool re-advertises) must not add a second prefix entry.
    recorder.observe({ direction: 'sent', atMs: 1, wire: sessionUpdate });

    const usage = { input_tokens: 9_230, output_tokens: 120, input_tokens_details: { text_tokens: 9_000, audio_tokens: 230 } };
    recorder.observe({ direction: 'received', atMs: 2, wire: { type: 'response.done', response: { id: 'r1', status: 'completed', usage } } });

    const entries = readEntries(directory, 'conn-usage');
    const prefixes = entries.filter((entry) => entry.kind === 'prefix') as Array<Extract<VoiceRealtimeLogEntry, { kind: 'prefix' }>>;
    assert.equal(prefixes.length, 1, 'the fixed prefix is recorded once');
    assert.equal(prefixes[0]!.tools, 2);
    assert.equal(prefixes[0]!.instructionsChars, 120);

    const responses = entries.filter((entry) => entry.kind === 'response') as Array<Extract<VoiceRealtimeLogEntry, { kind: 'response' }>>;
    assert.equal(responses.length, 1);
    assert.equal(responses[0]!.inputTokens, 9_230);
    assert.equal(responses[0]!.outputTokens, 120);
    assert.equal(responses[0]!.textTokens, 9_000);
    assert.equal(responses[0]!.audioTokens, 230);
    // The estimate is the module's own: text 9000 @ ¥0.0015/1k + audio 230 @ ¥0.006/1k + out 120 @ ¥0.0045/1k.
    const expected = (9_000 * 0.0015 + 230 * 0.006 + 120 * 0.0045) / 1_000;
    assert.ok(Math.abs(responses[0]!.costCny - expected) < 1e-9, `cost ${responses[0]!.costCny} vs ${expected}`);

    const totals = entries.filter((entry) => entry.kind === 'usage') as Array<Extract<VoiceRealtimeLogEntry, { kind: 'usage' }>>;
    assert.equal(totals.length, 1);
    assert.equal(totals[0]!.responses, 1);
    assert.equal(totals[0]!.inputTokens, 9_230);
    assert.equal(totals[0]!.outputTokens, 120);

    // A frame with no usage is noted (as a summary line) but must not invent a zero-token response.
    recorder.observe({ direction: 'received', atMs: 3, wire: { type: 'response.done', response: { id: 'r2', status: 'completed' } } });
    assert.equal(readEntries(directory, 'conn-usage').filter((entry) => entry.kind === 'response').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC4: a store that always fails never throws to the caller, and says so exactly once', () => {
  const root = tempDir('voice-realtime-log-failopen-');
  try {
    let appendCalls = 0;
    const failingStore: VoiceRealtimeLogStore = {
      append() {
        appendCalls += 1;
        throw new Error('disk is full');
      },
      clear: () => ({ deleted: 0 }),
      directory: () => path.join(root, 'never'),
    };

    const stdout: string[] = [];
    const recorder = createVoiceRealtimeRecorder({
      store: failingStore,
      connectionId: 'conn-fail',
      sessionId: 's',
      tag: 's',
      mode: 'continuous',
      stdout: (line) => stdout.push(line),
    });

    // The calls the connection makes next must complete: the journal is a bystander, not a dependency.
    assert.doesNotThrow(() => recorder.log('segment seq=1 dur=5ms reason=gap frames=2'));
    assert.doesNotThrow(() => recorder.log('session_send start {"message":"hi"}'));
    assert.doesNotThrow(() => recorder.log('session_send delivered in 3 ms'));
    assert.doesNotThrow(() =>
      recorder.observe({ direction: 'received', atMs: 0, wire: { type: 'response.done', response: { usage: { input_tokens: 5, output_tokens: 1 } } } }),
    );

    assert.ok(appendCalls >= 5, 'it kept trying — fail-open, not fail-silent');
    const failures = stdout.filter((line) => line.includes('journal write failed'));
    assert.equal(failures.length, 1, `exactly one report, no matter how many writes failed (got ${failures.length})`);
    assert.match(failures[0]!, /disk is full/, 'the report carries why');
    // Reporting the failure did not silence the ordinary stream: the human lines still went out.
    assert.ok(stdout.some((line) => line.includes('session_send delivered in 3 ms')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
