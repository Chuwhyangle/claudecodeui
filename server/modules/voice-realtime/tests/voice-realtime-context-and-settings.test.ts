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
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';

import { truncateRenderedVoiceContext } from '@shared/voice/voiceContextTruncation.js';

import { createVoiceService } from '../../voice/index.js';

import {
  DEFAULT_SESSION_DEFAULTS,
  createDashscopeTransport,
  type RealtimeClientMessage,
  type RealtimeToolExecutor,
} from '../index.js';
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
  SPEAKER_TRACKING_MODEL_DIR_DEFAULT,
  SPEAKER_TRACKING_MODEL_FILE_DEFAULT,
  SPEAKER_TRACKING_QUALITY_DEFAULTS,
  SPEAKER_TRACKING_THRESHOLD_DEFAULTS,
  resolveSpeakerTrackingSettings,
  type SpeakerTrackingSettingsBlock,
} from '../voice-speaker-tracking-arm.js';
import {
  DEFAULT_TURN_DETECTION,
  VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV,
  describeSilenceDurationSource,
  describeTurnDetection,
  resolveTurnDetection,
  type TurnDetectionValues,
} from '../voice-realtime-turn-detection.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';
import { SCRIPTED_ENDPOINT_URL, createScriptedUpstream } from './voice-realtime-scripted-upstream.js';

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
  /**
   * The per-connection detector reading the proxy handed the transport seam, in call order.
   *
   * A reading of `undefined` means the proxy opened the wire without telling it what this
   * connection's settings file asked for — the exact gap the 2026-10-20 live session showed as
   * "the log says 1500 ms, the `session.update` says 800 ms".
   */
  settingsTurnDetection: Array<TurnDetectionValues | undefined>;
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const logs: string[] = [];
  const settingsTurnDetection: Array<TurnDetectionValues | undefined> = [];
  const executor: RealtimeToolExecutor = { session_send: async () => ({ ok: true }) };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: (_reportError, turnDetection) => {
      settingsTurnDetection.push(turnDetection);
      return transport;
    },
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
  return { socket, transport, logs, settingsTurnDetection };
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

test('字符预算硬上限: an over-cap frame is trimmed to the connection reading, never forwarded whole', async () => {
  const { socket, transport, logs } = wire();
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => instructionsSent(transport).length >= 1);

  // No row boundaries: the server treats it as one row and elides it to the shipped 600-char row
  // cap, so the frame is USABLE rather than refused — the reading this connection resolved is what
  // decides, not the client's size.
  const oversized = '字'.repeat(VOICE_REALTIME_CONTEXT_MAX_CHARS + 1);
  socket.receive(contextFrame(oversized));
  await waitFor(() => logs.some((line) => line.includes('context truncated from=')));
  assert.equal(
    instructionsSent(transport).some((text) => text.includes(oversized)),
    false,
    'the over-cap frame must not reach the upstream whole',
  );
  const injected = instructionsSent(transport).find((text) => text.includes('字'))!;
  assert.ok(injected !== undefined, 'the trimmed pack must still reach the upstream');
  assert.ok(
    injected.length < oversized.length,
    `the forwarded instructions are ${injected.length} chars, not shorter than the ${oversized.length}-char frame`,
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

test('the settings file\'s turnDetection is handed to the transport seam for THIS connection', async () => {
  // THE READER THIS CLOSES (2026-10-20 live session): the log said `1500ms — silence from the
  // settings file` while the very same connection's `session.update` carried `silence=800ms`,
  // because the proxy resolved the file for its gate/log and the transport was built from the
  // assembly point's file-less resolution. The seam is where the two readings meet: whatever the
  // proxy read from THIS connection's file must be what the transport opens with.
  const dir = mkdtempSync(join(tmpdir(), 'voice-turn-detection-seam-'));
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ turnDetection: { silence_duration_ms: 1500 } }), 'utf8');
    const live = wire({ settingsPath: file });
    await waitFor(() => live.transport.openCalls >= 1);
    assert.deepEqual(
      live.settingsTurnDetection.at(-1),
      { silence_duration_ms: 1500 },
      'the proxy read this connection\'s file; that reading must travel to the transport that opens the wire',
    );

    // A connection with no file hands an EMPTY reading, not the shipped 800: the resolver keeps
    // precedence (override > env > file > default) only when "the file said nothing" stays legible.
    // The deployment's own `VOICE_REALTIME_SETTINGS_PATH` is cleared for this reading: a developer
    // shell that exports the repo's config file would otherwise make "no file" mean "the repo file".
    const ambientSettingsPath = process.env.VOICE_REALTIME_SETTINGS_PATH;
    delete process.env.VOICE_REALTIME_SETTINGS_PATH;
    try {
      const plain = wire();
      await waitFor(() => plain.transport.openCalls >= 1);
      assert.deepEqual(plain.settingsTurnDetection.at(-1), {});
    } finally {
      if (ambientSettingsPath !== undefined) {
        process.env.VOICE_REALTIME_SETTINGS_PATH = ambientSettingsPath;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wire: the upstream session.update carries the settings file\'s silence window', async () => {
  // ITEM 2 OF THE 2026-10-20 FIX: the criterion reads the FRAME, not the log line. A settings file
  // naming 1500 ms must produce an upstream `session.update` whose `turn_detection.
  // silence_duration_ms` is 1500 — the reading a journal alone could not prove, because the
  // journal's detector line is written before the transport composes its session body.
  const dir = mkdtempSync(join(tmpdir(), 'voice-turn-detection-wire-'));
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ turnDetection: { silence_duration_ms: 1500 } }), 'utf8');

    const upstream = createScriptedUpstream();
    const socket = new FakeBrowserSocket();
    const executor: RealtimeToolExecutor = { session_send: async () => ({ ok: true }) };
    handleVoiceRealtimeConnection(
      socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
      'session-under-test',
      {
        // The same composition `server/index.ts` performs for one connection: the proxy's reading
        // is resolved (file < env < override; this test names no env or override) and spread into
        // the transport's session defaults. The real transport then composes the real frame.
        createTransport: (reportError, settingsTurnDetection) =>
          createDashscopeTransport({
            apiKey: '',
            endpoint: SCRIPTED_ENDPOINT_URL,
            socketFactory: upstream.socketFactory,
            onError: reportError,
            sessionDefaults: {
              ...DEFAULT_SESSION_DEFAULTS,
              turn_detection: resolveTurnDetection({}, {}, settingsTurnDetection ?? {}).turnDetection,
            },
          }),
        createExecutor: () => executor,
        instructions: 'BASE-PROMPT',
        settingsPath: file,
      },
    );

    await waitFor(() => upstream.clientFrames.some((frame) => frame.type === 'session.update'));
    const update = upstream.clientFrames.find((frame) => frame.type === 'session.update') as
      | { session?: { turn_detection?: { silence_duration_ms?: number } } }
      | undefined;
    assert.equal(
      update?.session?.turn_detection?.silence_duration_ms,
      1500,
      `the frame the endpoint receives must carry the file's window; saw ${JSON.stringify(update)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the settings file's `speakerTracking`: Phase 1's observer as a deployment knob (AC1) ──────────
//
// The block is the NORMAL entry for speaker tracking; the two `VOICE_SPEAKER_*` variables are escape
// hatches resolved per connection by `resolveSpeakerTrackingSettings` (see the AC2/AC8 legs in
// `voice-realtime-speaker-tracker.test.ts`). These readings are taken through the REAL loader, so a
// block that would half-apply is caught here rather than at the seam.

test('speakerTracking: a valid block is validated, default-filled and model path resolved', () => {
  const loaded = readSettings(
    {
      speakerTracking: {
        mode: 'shadow',
        modelDir: 'models/custom',
        modelFile: 'campplus.onnx',
        thresholds: { track: 0.31, bankSize: 3 },
        quality: { windowSeconds: 2.5 },
      },
    },
    (settings) => settings,
  );
  assert.deepEqual(loaded.problems, [], 'a valid block must not be refused');
  assert.equal(loaded.source, 'file');
  const block = loaded.speakerTracking;
  assert.ok(block !== null, 'the file named a block, so the reading carries one');
  assert.equal(block.mode, 'shadow');
  assert.equal(block.modelPath, join('models/custom', 'campplus.onnx'), 'join(modelDir, modelFile)');
  assert.equal(block.thresholds.track, 0.31, 'the file value wins over the default');
  assert.equal(block.thresholds.bankSize, 3);
  assert.equal(block.thresholds.matchFast, SPEAKER_TRACKING_THRESHOLD_DEFAULTS.matchFast, 'unset keeps the default');
  assert.equal(block.quality.windowSeconds, 2.5);
  assert.equal(block.quality.sampleSeconds, SPEAKER_TRACKING_QUALITY_DEFAULTS.sampleSeconds);
  assert.deepEqual([...block.named.thresholds].sort(), ['bankSize', 'track'], 'only the named keys are marked');
  assert.deepEqual(block.named.quality, ['windowSeconds']);
  assert.equal(block.named.mode, true);
  assert.equal(block.named.modelPath, true);
});

test('speakerTracking: an explicit modelPath wins over modelDir/modelFile', () => {
  const loaded = readSettings(
    {
      speakerTracking: {
        modelDir: 'models/ignored',
        modelFile: 'ignored.onnx',
        modelPath: ' /abs/campplus.onnx ',
      },
    },
    (settings) => settings,
  );
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.speakerTracking?.modelPath, '/abs/campplus.onnx', 'surrounding whitespace is trimmed');
});

test('speakerTracking: a shadow block with no model keys resolves the default models/speaker file', () => {
  const loaded = readSettings({ speakerTracking: { mode: 'shadow' } }, (settings) => settings);
  assert.deepEqual(loaded.problems, []);
  assert.equal(
    loaded.speakerTracking?.modelPath,
    join(SPEAKER_TRACKING_MODEL_DIR_DEFAULT, SPEAKER_TRACKING_MODEL_FILE_DEFAULT),
    'the shipped model location is the default, not a missing path',
  );
});

test('speakerTracking: no key means null — the file said nothing', () => {
  const loaded = readSettings({}, (settings) => settings);
  assert.deepEqual(loaded.problems, []);
  assert.equal(loaded.speakerTracking, null, 'null is what lets the environment escape hatch decide');
});

test('speakerTracking: unknown sub-keys are ignored, not refused', () => {
  const loaded = readSettings(
    {
      speakerTracking: {
        mode: 'off',
        futureKnob: true,
        thresholds: { track: 0.32, unknownThreshold: 9 },
        quality: { speechRatioMin: 0.65, unknownQuality: 'x' },
      },
    },
    (settings) => settings,
  );
  assert.deepEqual(loaded.problems, [], 'an unknown sub-key is the forward-compatibility surface');
  assert.equal(loaded.speakerTracking?.thresholds.track, 0.32);
  assert.equal(loaded.speakerTracking?.quality.speechRatioMin, 0.65);
});

test('speakerTracking: every invalid shape refuses the WHOLE block and falls back to defaults', () => {
  const invalidBlocks: unknown[] = [
    42,
    [],
    'shadow',
    { mode: 'gate' },
    { mode: 'shadow', modelDir: '' },
    { thresholds: { track: 2 } },
    { thresholds: { bankSize: 4.5 } },
    { quality: { speechRatioMin: 1.5 } },
    { quality: { windowSeconds: '2' } },
    { thresholds: 3 },
    { quality: null },
  ];
  for (const speakerTracking of invalidBlocks) {
    const loaded = readSettings({ speakerTracking }, (settings) => settings);
    assert.equal(
      loaded.speakerTracking,
      null,
      `${JSON.stringify(speakerTracking)} must not half-apply`,
    );
    assert.equal(loaded.source, 'default', 'a refused block refuses the reading, as every shape error here does');
    assert.equal(loaded.problems.length > 0, true, 'the refusal must reach the deployment through `problems`');
    assert.match(
      loaded.problems.join('; '),
      /speakerTracking/,
      `the reason must NAME the block it refused: ${loaded.problems.join('; ')}`,
    );
  }
});

test('speakerTracking: an out-of-range value names the exact nested key', () => {
  const loaded = readSettings({ speakerTracking: { thresholds: { track: 2 } } }, (settings) => settings);
  assert.match(loaded.problems.join('; '), /speakerTracking\.thresholds\.track/);
});

test('AC5: the shipped example settings file parses and configures speakerTracking', () => {
  // The DoD says the example must be usable as-is. Reading it through the REAL loader pins that:
  // an example that refuses itself (an unknown template variable, a bad threshold) would be a trap
  // for the operator the file exists for.
  const examplePath = fileURLToPath(
    new URL('../../../../config/voice-realtime.settings.example.json', import.meta.url),
  );
  const loaded = loadVoiceRealtimeSettings({ baseInstructions: BASE, settingsPath: examplePath });
  assert.deepEqual(loaded.problems, [], 'the shipped example must load cleanly');
  assert.equal(loaded.source, 'file');
  const block: SpeakerTrackingSettingsBlock | null = loaded.speakerTracking;
  assert.ok(block !== null, 'the example documents the speakerTracking block');
  assert.equal(block.mode, 'shadow');
  assert.match(block.modelPath, /campplus/, 'the example names the frozen CAM++ weights');
});

test('AC2: the environment escape hatch over the file is reported per effective value', () => {
  const block: SpeakerTrackingSettingsBlock = {
    mode: 'off',
    modelDir: 'models/file',
    modelFile: 'file.onnx',
    modelPath: join('models/file', 'file.onnx'),
    thresholds: { ...SPEAKER_TRACKING_THRESHOLD_DEFAULTS, track: 0.4 },
    quality: SPEAKER_TRACKING_QUALITY_DEFAULTS,
    named: {
      mode: true,
      modelPath: true,
      thresholds: ['track'],
      quality: [],
    },
  };
  const lines: string[] = [];
  const resolution = resolveSpeakerTrackingSettings({
    env: { VOICE_SPEAKER_TRACKING: 'shadow', VOICE_SPEAKER_MODEL_PATH: '/env/campplus.onnx' },
    settings: block,
    log: (line) => lines.push(line),
  });
  assert.equal(resolution.mode, 'shadow', 'the environment mode wins over the file');
  assert.equal(resolution.modelPath, '/env/campplus.onnx', 'the environment path wins over the file');
  assert.equal(resolution.sources.mode, 'environment');
  assert.equal(resolution.sources.modelPath, 'environment');
  assert.equal(resolution.sources.thresholds.track, 'settings file', 'the file named this threshold');
  assert.equal(resolution.sources.thresholds.matchFast, 'default', 'the file left this one alone');
  assert.ok(
    lines.some((line) => line.includes('mode=shadow') && line.includes('source=environment')),
    `the mode line must name its source: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((line) => line.includes('thresholds.track=0.4') && line.includes('source=settings file')),
    `a file-named threshold must say so: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((line) => line.includes('thresholds.matchFast=0.35') && line.includes('source=default')),
    `an unset threshold must say default: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((line) => line.includes('quality.sampleSeconds=3.5') && line.includes('source=default')),
    `the quality block is logged too: ${JSON.stringify(lines)}`,
  );
});

test('AC2: a file with no environment override runs at the file values, and says so', () => {
  const block: SpeakerTrackingSettingsBlock = {
    mode: 'shadow',
    modelDir: 'models/file',
    modelFile: 'file.onnx',
    modelPath: join('models/file', 'file.onnx'),
    thresholds: SPEAKER_TRACKING_THRESHOLD_DEFAULTS,
    quality: SPEAKER_TRACKING_QUALITY_DEFAULTS,
    named: { mode: true, modelPath: true, thresholds: [], quality: [] },
  };
  const lines: string[] = [];
  const resolution = resolveSpeakerTrackingSettings({
    env: {},
    settings: block,
    log: (line) => lines.push(line),
  });
  assert.equal(resolution.mode, 'shadow');
  assert.equal(resolution.modelPath, block.modelPath);
  assert.equal(resolution.sources.mode, 'settings file');
  assert.equal(resolution.sources.modelPath, 'settings file');
  assert.equal(resolution.sources.thresholds.track, 'default');
  assert.ok(lines.some((line) => line.includes('source=settings file')));
});

// ── the runtime knobs: contextPack + spendGuard in the settings file ─────────────────────────────
//
// `contextPack` sizes the C2 pack on BOTH voice entries; `spendGuard` is the per-window spend cap.
// The readings below go through the REAL loader, so what is pinned is the path a deployment's file
// actually travels: defaults, file values, refusal of a bad KNOWN key, and unknown-key tolerance.

test('AC1: contextPack and spendGuard load from the file, default, and refuse invalid values', () => {
  const defaults = readSettings({}, (loaded) => ({
    contextPack: loaded.contextPack,
    spend: loaded.spendGuard,
    problems: loaded.problems,
  }));
  console.log(
    `defaults maxRows=${defaults.contextPack.maxRows} budgetChars=${defaults.contextPack.budgetChars} rowCapChars=${defaults.contextPack.rowCapChars} spend=${defaults.spend.maxCnyPerWindow}`,
  );
  assert.deepEqual(defaults.problems, []);
  assert.deepEqual(defaults.contextPack, { maxRows: 4, budgetChars: 1200, rowCapChars: 600 });
  assert.equal(defaults.spend.maxCnyPerWindow, 0.05);
  assert.equal(defaults.spend.windowMs, 30_000);

  const file = readSettings(
    {
      contextPack: { maxRows: 2, budgetChars: 400, rowCapChars: 300 },
      spendGuard: { maxCnyPerWindow: 0.1, windowMs: 45_000 },
    },
    (loaded) => ({ contextPack: loaded.contextPack, spend: loaded.spendGuard, problems: loaded.problems, source: loaded.source }),
  );
  console.log(
    `file maxRows=${file.contextPack.maxRows} budgetChars=${file.contextPack.budgetChars} rowCapChars=${file.contextPack.rowCapChars} spend=${file.spend.maxCnyPerWindow}`,
  );
  assert.deepEqual(file.problems, []);
  assert.equal(file.source, 'file');
  assert.deepEqual(file.contextPack, { maxRows: 2, budgetChars: 400, rowCapChars: 300 });
  assert.deepEqual(file.spend, { maxCnyPerWindow: 0.1, windowMs: 45_000 });

  const invalid = readSettings(
    {
      contextPack: { maxRows: 0, budgetChars: 99999 },
      spendGuard: { maxCnyPerWindow: 'abc' },
    },
    (loaded) => ({
      contextPack: loaded.contextPack,
      spend: loaded.spendGuard,
      problems: loaded.problems,
      source: loaded.source,
    }),
  );
  console.log('invalid maxRows=0 budgetChars=99999 spend=abc -> default + problem');
  assert.deepEqual(invalid.contextPack, { maxRows: 4, budgetChars: 1200, rowCapChars: 600 });
  assert.equal(invalid.spend.maxCnyPerWindow, 0.05);
  assert.equal(invalid.source, 'default', 'a refused known key refuses the reading, as every shape error here does');
  assert.match(invalid.problems.join('; '), /contextPack\.maxRows/);
  assert.match(invalid.problems.join('; '), /contextPack\.budgetChars/);
  assert.match(invalid.problems.join('; '), /spendGuard\.maxCnyPerWindow/);

  // Unknown sub-keys are the forward-compatibility surface: ignored, never a refusal.
  const unknown = readSettings(
    {
      contextPack: { maxRows: 2, futureKnob: true },
      spendGuard: { windowMs: 30_000, futureKnob: 'x' },
    },
    (loaded) => ({ contextPack: loaded.contextPack, spend: loaded.spendGuard, problems: loaded.problems }),
  );
  assert.deepEqual(unknown.problems, [], 'unknown sub-keys must be ignored');
  assert.equal(unknown.contextPack.maxRows, 2);
  assert.equal(unknown.contextPack.budgetChars, 1200, 'an omitted field keeps the default');
  assert.equal(unknown.spend.maxCnyPerWindow, 0.05);

  // The deployment-level reader applies `environment > file > default` and reports a refused
  // environment spelling instead of silently ignoring it.
  const runtime = readSettings({ contextPack: { maxRows: 2, budgetChars: 400 } }, (loaded) => loaded.contextPack);
  assert.deepEqual(runtime, { maxRows: 2, budgetChars: 400, rowCapChars: 600 });
});

test('AC5: the rendered-pack truncation keeps the newest rows inside rows/chars', () => {
  const rows = Array.from({ length: 6 }, (_, index) =>
    `${index % 2 === 0 ? '用户' : '助手'}（刚刚）：ROW-${index} ${'甲'.repeat(320)}`,
  );
  const pack = rows.join('\n');
  console.log(`truncate input rows=${rows.length} chars=${pack.length}`);
  const truncated = truncateRenderedVoiceContext(pack, { maxRows: 2, budgetChars: 400, rowCapChars: 190 });
  console.log(
    `truncate 2/400/190 -> rows=${truncated.rows} chars=${truncated.chars} sourceRows=${truncated.sourceRows} sourceChars=${truncated.sourceChars} truncated=${truncated.truncated}`,
  );
  assert.ok(truncated.rows <= 2, `row cap overshot: ${truncated.rows}`);
  assert.ok(truncated.chars <= 400, `budget overshot: ${truncated.chars}`);
  assert.equal(truncated.text.includes('ROW-5'), true, 'the newest row is kept');
  assert.equal(truncated.text.includes('ROW-0'), false, 'the oldest row is dropped');

  // A pack already inside the limits is returned byte-for-byte and does NOT claim a truncation.
  const small = '用户（刚刚）：短\n助手（刚刚）：也短';
  const untouched = truncateRenderedVoiceContext(small, { maxRows: 4, budgetChars: 1200, rowCapChars: 600 });
  assert.equal(untouched.text, small);
  assert.equal(untouched.truncated, false);
});

test('AC5/AC6: the proxy trims a context frame to THIS connection reading, and an edit reaches only the next connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-runtime-pack-'));
  const file = join(dir, 'settings.json');
  const packFor = (tag: string): string =>
    Array.from({ length: 6 }, (_, index) =>
      `${index % 2 === 0 ? '用户' : '助手'}（刚刚）：${tag}-${index} ${'乙'.repeat(200)}`,
    ).join('\n');
  try {
    writeFileSync(
      file,
      JSON.stringify({ contextPack: { maxRows: 4, budgetChars: 1200, rowCapChars: 600 } }),
      'utf8',
    );
    const live = wire({ settingsPath: file });
    await waitFor(() => instructionsSent(live.transport).length >= 1);
    live.socket.receive(contextFrame(packFor('A'), 6));
    await waitFor(() => live.logs.some((line) => line.startsWith('context truncated from=')));
    const firstTrim = live.logs.find((line) => line.startsWith('context truncated from='))!;
    console.log(`AC6 connection A ${firstTrim}`);
    assert.match(firstTrim, /^context truncated from=6 rows\/\d+ chars to=4 rows\/\d+ chars$/, 'AC6: A reads 4 rows');

    // The edit lands while A is live; A keeps the reading it connected with.
    writeFileSync(
      file,
      JSON.stringify({ contextPack: { maxRows: 2, budgetChars: 400, rowCapChars: 190 } }),
      'utf8',
    );
    const next = wire({ settingsPath: file });
    await waitFor(() => instructionsSent(next.transport).length >= 1);
    next.socket.receive(contextFrame(packFor('B'), 6));
    await waitFor(() => next.logs.some((line) => line.startsWith('context truncated from=')));
    const nextTrim = next.logs.find((line) => line.startsWith('context truncated from='))!;
    console.log(`AC6 connection B ${nextTrim}`);
    assert.match(nextTrim, /^context truncated from=6 rows\/\d+ chars to=2 rows\/\d+ chars$/, 'AC6: B reads 2 rows');
    assert.ok(Number(/to=\d+ rows\/(\d+) chars/.exec(nextTrim)![1]) <= 400, 'B is inside its 400-char budget');

    // A different pack, so the proxy does not answer from its frame dedup: A's reading is unchanged.
    live.socket.receive(contextFrame(packFor('C'), 6));
    await waitFor(() => live.logs.filter((line) => line.startsWith('context truncated from=')).length >= 2);
    const secondTrim = live.logs.filter((line) => line.startsWith('context truncated from=')).at(-1)!;
    console.log(`AC6 connection A after the edit ${secondTrim}`);
    assert.match(secondTrim, /to=4 rows\//, 'A must keep its connect-time reading (no mid-session swap)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC5: the one-shot path trims hints.context to the same reading, and the fetch recorder sees the trimmed body', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => `用户（刚刚）：SHOT-${index} ${'丙'.repeat(320)}`).join('\n');
  const bodies: string[] = [];
  const logs: string[] = [];
  const service = createVoiceService({
    defaults: { baseUrl: '', apiKey: '', sttModel: 'whisper-1', ttsModel: 'tts-1', ttsVoice: 'alloy', providerId: '' },
    timeoutMs: 1_000,
    fetchBackend: async (_url, init) => {
      bodies.push(String(init.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"transcript":"k","instruction":"k"}' } }] }),
        { status: 200 },
      );
    },
    runtimeConfig: () => ({ contextPack: { maxRows: 2, budgetChars: 400, rowCapChars: 190 } }),
    logger: { info: (line: string) => logs.push(line) },
  });

  const result = await service.transcribe({
    audio: { bytes: Buffer.alloc(16, 0x6b), mimeType: 'audio/webm', fileName: 'clip.webm' },
    overrides: {},
    settings: {
      baseUrl: '',
      apiKey: '',
      sttModel: 'whisper-1',
      ttsModel: '',
      ttsVoice: '',
      ttsFormat: '',
      providerId: 'dashscope-omni-relay',
      dashscopeEndpoint: 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com',
      dashscopeApiKey: 'sk-test',
      dashscopeModel: '',
    },
    hints: { context: rows },
  });
  assert.equal(result.ok, true, 'the one-shot request must reach the recorder');
  assert.equal(bodies.length, 1);
  const body = JSON.parse(bodies[0]!) as { messages: Array<{ content: unknown }> };
  const system = String(body.messages[0]?.content ?? '');
  console.log(`one-shot recorder body chars=${bodies[0]!.length} containsNewest=${system.includes('SHOT-5')} containsOldest=${system.includes('SHOT-0')}`);
  assert.equal(system.includes('SHOT-5'), true, 'the newest row survives the trim');
  assert.equal(system.includes('SHOT-0'), false, 'the oldest row was dropped before the wire');
  assert.ok(
    logs.some((line) => line.startsWith('context truncated from=')),
    `the one-shot path must log the trim, saw ${JSON.stringify(logs)}`,
  );
});
