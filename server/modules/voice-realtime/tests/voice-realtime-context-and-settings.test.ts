/**
 * AC-320's own entry point for the server half: the `context` frame in, the session's instructions
 * out, and the settings file read once per connection so an edit is hot for the NEXT one only.
 *
 * WHY A SECOND SUITE. `voice-realtime-context-injection.test.ts` is the deeper one (parser
 * edge cases, the refusal's log line, the fallback reason). This file is the criterion AC-320
 * names, and it reads the three properties the criterion states, each end-to-end over a real
 * `handleVoiceRealtimeConnection`: 如实标注 (the pack arrives under the honest "这是当前 Claude Code
 * 会话的上下文" lead-in and carries no usage rules of its own), 字符预算硬上限 (the proxy re-checks the
 * frame against its own cap and refuses an over-cap pack whole), and 热修改 (a connection keeps the
 * settings it read at connect time; the next connection reads the edited file — no restart).
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import type { RealtimeClientMessage, RealtimeToolExecutor } from '../index.js';
import {
  VOICE_REALTIME_CONTEXT_MAX_CHARS,
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';
import { ANNOUNCE_PHRASES } from '../voice-realtime-announce-phrases.js';
import { VOICE_REALTIME_CONTEXT_HEADER, loadVoiceRealtimeSettings } from '../voice-realtime-settings.js';
import {
  DEFAULT_TURN_DETECTION,
  VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV,
  describeSilenceDurationSource,
  describeTurnDetection,
  resolveTurnDetection,
} from '../voice-realtime-turn-detection.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

/** The browser's socket, as far as `handleVoiceRealtimeConnection` uses it. */
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

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

const instructionsSent = (transport: FakeTransport): string[] =>
  transport.sent
    .filter(
      (message): message is Extract<RealtimeClientMessage, { type: 'session.update' }> =>
        message.type === 'session.update',
    )
    .map((message) => message.session.instructions);

function wire(options: { settingsPath?: string } = {}): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  logs: string[];
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const logs: string[] = [];
  const executor: RealtimeToolExecutor = { session_send: async () => ({ ok: true }) };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'BASE-PROMPT',
    ...(options.settingsPath === undefined ? {} : { settingsPath: options.settingsPath }),
    log: (line: string) => logs.push(line),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport, logs };
}

const contextFrame = (text: string, rows = 1): VoiceRealtimeInboundFrame => ({
  type: 'context',
  text,
  chars: text.length,
  rows,
});

test('如实标注: the pack reaches upstream under the honest lead-in, with no usage rules added', async () => {
  const { socket, transport, logs } = wire();
  await waitFor(() => transport.openCalls >= 1);
  const pack = '用户（1 分钟前）：把超时改成五十秒\n助手（刚刚）：已改。';
  socket.receive(contextFrame(pack, 2));

  await waitFor(() => instructionsSent(transport).some((text) => text.includes(pack)));
  const composed = instructionsSent(transport).find((text) => text.includes(pack))!;
  assert.equal(composed, `BASE-PROMPT\n\n${VOICE_REALTIME_CONTEXT_HEADER}\n\n${pack}`);
  assert.ok(
    composed.indexOf(VOICE_REALTIME_CONTEXT_HEADER) < composed.indexOf(pack),
    'the lead-in must come BEFORE the pack, so the model reads it as what follows',
  );
  assert.equal(logs.some((line) => line.includes(pack)), false, 'the body is the conversation; it is not logged');
});

test('a session that was sent no pack opens with the base prompt, byte for byte', async () => {
  const { transport } = wire();
  await waitFor(() => instructionsSent(transport).length >= 1);
  assert.deepEqual(instructionsSent(transport), ['BASE-PROMPT']);
});

test('字符预算硬上限: the proxy re-checks the frame and refuses an over-cap pack whole', async () => {
  const { socket, transport, logs } = wire();
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => instructionsSent(transport).length >= 1);

  const oversized = '字'.repeat(VOICE_REALTIME_CONTEXT_MAX_CHARS + 1);
  socket.receive(contextFrame(oversized));
  await waitFor(() => logs.some((line) => line.includes('context refused')));
  assert.equal(
    instructionsSent(transport).some((text) => text.includes(oversized)),
    false,
    'the cap is re-checked server-side; an over-cap pack must not reach the upstream',
  );
});

test('热修改: an edit reaches the next connection while the live one keeps its reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-context-and-settings-'));
  const file = join(dir, 'settings.json');
  try {
    writeFileSync(
      file,
      JSON.stringify({ version: 'v1', instructions: 'RELAY-V1', contextTemplate: 'LEAD-V1\n\n{{context}}' }),
    );
    const live = wire({ settingsPath: file });
    await waitFor(() => instructionsSent(live.transport).length >= 1);
    assert.equal(instructionsSent(live.transport).at(-1), 'RELAY-V1');

    writeFileSync(
      file,
      JSON.stringify({ version: 'v2', instructions: 'RELAY-V2', contextTemplate: 'LEAD-V2\n\n{{context}}' }),
    );

    // The live connection composes from the reading it took at connect time — the pack arrives only
    // after the edit, so this can only come out under v1 if the reading really is held.
    live.socket.receive(contextFrame('LIVE'));
    await waitFor(() => instructionsSent(live.transport).some((text) => text.includes('LIVE')));
    assert.equal(instructionsSent(live.transport).find((text) => text.includes('LIVE')), 'RELAY-V1\n\nLEAD-V1\n\nLIVE');

    const next = wire({ settingsPath: file });
    await waitFor(() => instructionsSent(next.transport).length >= 1);
    assert.equal(
      instructionsSent(next.transport).at(-1),
      'RELAY-V2',
      'a connection opened after the edit must read the new file, with no restart',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the settings file's `turnDetection`: the deployment's tuning surface for the upstream detector ──
//
// AC1–AC4 of `gap-live-voice-turn-detection-silence-in-settings-file-default-800`. The readings are taken
// through the REAL loader and the REAL resolver — the two production calls a connection makes — rather
// than against a re-implementation, so what is pinned is the path a deployment's file actually travels.
// The environment is passed as a VALUE (the resolver is pure), so no leg has to mutate `process.env`.

/** The prompt the loader is handed; the shipped default when the file names no `instructions`. */
const BASE = 'BASE-PROMPT';

/** Writes one settings JSON into a fresh temp dir, reads it through the loader, and cleans up. */
function readSettings<T>(settings: Record<string, unknown>, read: (loaded: ReturnType<typeof loadVoiceRealtimeSettings>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'voice-turn-detection-settings-'));
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify(settings));
    return read(loadVoiceRealtimeSettings({ baseInstructions: BASE, settingsPath: file }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The silence window a file resolves to, through the loader and the resolver, for one environment. */
function silenceFromFile(
  settings: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): { silenceMs: number; problems: string[] } {
  return readSettings(settings, (loaded) => {
    const resolved = resolveTurnDetection(env, {}, loaded.turnDetection);
    return { silenceMs: resolved.turnDetection.silence_duration_ms, problems: loaded.problems };
  });
}

test('AC1: a `turnDetection.silence_duration_ms` in the settings file is what the resolver returns', () => {
  const { silenceMs, problems } = silenceFromFile({ turnDetection: { silence_duration_ms: 600 } });
  assert.deepEqual(problems, [], 'a file naming one valid value must not be refused');
  assert.equal(silenceMs, 600, 'the file is a SOURCE the resolver reads, not a decoration');
});

test('AC2: a file naming no `turnDetection` — or one without the silence key — resolves to the shipped 800', () => {
  // The DEFAULT is read from the shipping constant, not typed in here, so this leg moves with it.
  const withoutObject = silenceFromFile({});
  assert.deepEqual(withoutObject.problems, []);
  assert.equal(withoutObject.silenceMs, DEFAULT_TURN_DETECTION.silence_duration_ms);
  assert.equal(withoutObject.silenceMs, 800, 'the shipped window is the 800 the probe measured');

  const withoutSilence = silenceFromFile({ turnDetection: { type: 'server_vad', threshold: 0.5 } });
  assert.deepEqual(withoutSilence.problems, [], 'naming only PART of the object is not a refusal');
  assert.equal(withoutSilence.silenceMs, 800, 'a field the file left out falls through to the shipped default');
});

test('AC3: the environment outranks the file, which outranks the shipped default', () => {
  const env = { [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '500' };
  assert.equal(
    silenceFromFile({ turnDetection: { silence_duration_ms: 600 } }, env).silenceMs,
    500,
    'the deployment escape hatch wins over the file it ships beside',
  );
  assert.equal(silenceFromFile({ turnDetection: { silence_duration_ms: 600 } }).silenceMs, 600, 'file, with no env');
  assert.equal(silenceFromFile({}).silenceMs, 800, 'neither source named it — the shipped default stands');
});

test('AC4: an out-of-range file value falls back to the default AND is reported, never thrown', () => {
  const { silenceMs, problems } = silenceFromFile({ turnDetection: { silence_duration_ms: 100 } });
  assert.equal(silenceMs, 800, 'the refused field must not be half-applied: the default stands');
  assert.equal(problems.length > 0, true, 'the refusal must reach the deployment through `problems`');
  assert.match(problems.join('; '), /silence_duration_ms/, 'the reason must NAME the key it refused');
  console.log(`AC4 problems: ${JSON.stringify(problems)}`);
});

// ── the settings file's `announcePhrases`: the announce table as a deployment knob ──────────────────

test('announcePhrases: a settings file replaces the shipped announce table', () => {
  const table = ['甲收到', '乙在办', '丙明白'];
  const loaded = readSettings({ announcePhrases: table.join(' | ') }, (settings) => settings);
  assert.deepEqual(loaded.problems, [], 'a valid table must not be refused');
  assert.equal(loaded.source, 'file', 'the reading comes from the file, not the fallback');
  assert.deepEqual(loaded.announcePhrases, table, 'the file\'s phrases are the table the connection reads');
});

test('announcePhrases: no key keeps the shipped table, byte for byte', () => {
  const loaded = readSettings({}, (settings) => settings);
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.announcePhrases, ANNOUNCE_PHRASES, 'omitting the key is not an override');
  for (const phrase of loaded.announcePhrases) {
    assert.ok(phrase.length >= 2, `${JSON.stringify(phrase)} is below the default table's two-character floor`);
  }
});

test('announcePhrases: an invalid value falls back to the shipped table and is reported', () => {
  for (const invalid of ['好的|收到', '好的||收到|明白', `好的|收到|${'长'.repeat(16)}`]) {
    const loaded = readSettings({ announcePhrases: invalid }, (settings) => settings);
    assert.deepEqual(loaded.announcePhrases, ANNOUNCE_PHRASES, `${invalid} must not half-apply`);
    assert.equal(loaded.source, 'default', 'a refused value refuses the reading, as every shape error here does');
    assert.equal(loaded.problems.length > 0, true, 'the refusal must reach the deployment through `problems`');
    assert.match(loaded.problems.join('; '), /announcePhrases/, 'the reason must NAME the key it refused');
  }
});

// ── the settings file's `runEndAck` and `summaryModel`: the run-end knobs as deployment config ────
//
// The second batch of the env-to-file migration. The environment names stay (they are the escape
// hatch, and `voice-realtime-run-end-summary.test.ts` still pins those arms); these readings pin what
// the FILE contributes — the values the assembly point merges as `env > file > default`.

test('runEndAck: a settings file names the confirmation table, split on `|`', () => {
  const loaded = readSettings({ runEndAck: ' 甲收到 | 乙在办 |' }, (settings) => settings);
  assert.deepEqual(loaded.problems, [], 'a valid table must not be refused');
  assert.equal(loaded.source, 'file', 'the reading comes from the file, not the fallback');
  assert.deepEqual(loaded.runEndAck, ['甲收到', '乙在办'], 'the file\'s candidates are the table the transition speaks');
});

test('runEndAck: no key — or a blank table — means "the file said nothing"', () => {
  const missing = readSettings({}, (settings) => settings);
  assert.deepEqual(missing.problems, [], 'omitting the key is not a refusal');
  assert.deepEqual(missing.runEndAck, [], 'omitting the key is not an override either');

  const blank = readSettings({ runEndAck: '  |  | ' }, (settings) => settings);
  assert.deepEqual(blank.problems, [], 'a blank table is "said nothing", not a shape error');
  assert.deepEqual(blank.runEndAck, [], 'no candidate means the assembly point falls through to no ack');
});

test('runEndAck: a non-string value is refused and the reading falls back', () => {
  for (const invalid of [42, ['好的', '收到'], { candidates: '好的' }]) {
    const loaded = readSettings({ runEndAck: invalid }, (settings) => settings);
    assert.deepEqual(loaded.runEndAck, [], `${JSON.stringify(invalid)} must not half-apply`);
    assert.equal(loaded.source, 'default', 'a refused value refuses the reading, as every shape error here does');
    assert.match(loaded.problems.join('; '), /runEndAck/, 'the reason must NAME the key it refused');
  }
});

test('summaryModel: a settings file names the side text model', () => {
  const loaded = readSettings({ summaryModel: '  qwen-flash  ' }, (settings) => settings);
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.source, 'file');
  assert.equal(loaded.summaryModel, 'qwen-flash', 'surrounding whitespace is not part of a model id');
});

test('summaryModel: no key means null — the file said nothing, not "no model"', () => {
  const loaded = readSettings({}, (settings) => settings);
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.summaryModel, null, 'null is what lets the environment (then the stand-in) decide');
});

test('summaryModel: a blank or non-string value is refused and reported', () => {
  for (const invalid of ['', '   ', 7, null, ['qwen-flash']]) {
    const loaded = readSettings({ summaryModel: invalid }, (settings) => settings);
    assert.equal(loaded.summaryModel, null, `${JSON.stringify(invalid)} must not half-apply`);
    assert.equal(loaded.source, 'default', 'a refused value refuses the reading');
    assert.match(loaded.problems.join('; '), /summaryModel/, 'the reason must NAME the key it refused');
  }
});

test('the resolution is logged with the source it came from', () => {
  // The DoD's line: not just the number, but WHICH of the three sources set it — "800" means something
  // different shipped, tuned in a file, or exported for one run.
  const fromFile = readSettings({ turnDetection: { silence_duration_ms: 600 } }, (loaded) => {
    const resolution = resolveTurnDetection({}, {}, loaded.turnDetection);
    return describeTurnDetection(resolution, describeSilenceDurationSource({}, {}, loaded.turnDetection));
  });
  assert.equal(fromFile, 'turn detection: server_vad/0.5/600ms — silence from the settings file');

  const fromEnv = resolveTurnDetection({ [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '500' });
  assert.equal(
    describeTurnDetection(fromEnv, describeSilenceDurationSource({ [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '500' })),
    'turn detection: server_vad/0.5/500ms — silence from the environment',
  );

  const shipped = resolveTurnDetection({});
  assert.equal(
    describeTurnDetection(shipped, describeSilenceDurationSource({})),
    'turn detection: server_vad/0.5/800ms — silence from the shipped default',
  );
  // WITHOUT an origin it keeps its original contract: a clean resolution reads no line at all.
  assert.equal(describeTurnDetection(shipped), null);
});

test('a connection logs the detector its settings file asked for — edit 600 in, read 600 out', async () => {
  // The DoD's real-session reading, on the REAL connection path: the operator edits the file and looks at
  // the journal. A file that names a detector parameter gets one line saying the resolved values AND where
  // they came from; a file that names none stays silent, so "no line" keeps meaning "nothing configured".
  const dir = mkdtempSync(join(tmpdir(), 'voice-turn-detection-log-'));
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ turnDetection: { silence_duration_ms: 600 } }), 'utf8');
    const live = wire({ settingsPath: file });
    await waitFor(() => instructionsSent(live.transport).length >= 1);
    assert.ok(
      live.logs.includes('turn detection: server_vad/0.5/600ms — silence from the settings file'),
      `the connection must say what it resolved and where from, saw ${JSON.stringify(live.logs)}`,
    );

    writeFileSync(file, JSON.stringify({}), 'utf8');
    const silent = wire({ settingsPath: file });
    await waitFor(() => instructionsSent(silent.transport).length >= 1);
    assert.equal(
      silent.logs.filter((line) => line.startsWith('turn detection:')).length,
      0,
      'a file that names no detector parameter reads no detector line — the shipped default is not news',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
