/**
 * GOAL-046 / AC-402 — the omission-fill parameters belong to `server/` and ship with the build.
 *
 * WHAT THIS FILE PINS, and why the wiring test (`voice-realtime-omission-fill-wiring.test.ts`) cannot
 * say it. That file proves the producer is wired; this one proves WHERE ITS NUMBERS COME FROM:
 *
 *  (a) A ws-proxy connection started in a working directory that has no `experiments/` tree — with
 *      the old `experiments/voice-relay-qb/omission-fill-params.json` path made unreadable — still
 *      logs the parameters from `server/modules/voice-realtime/omission-fill-params.json` and keeps
 *      the producer ON. The revert this guards against is the old `findApplicationRoot` +
 *      `readFileSync('experiments/…')` reader: the fs seam below throws for exactly that file, so a
 *      reverted reader disables the producer and the assertion goes red.
 *  (b) The settings file's optional `omissionFill` key overrides the compiled-in values for the NEXT
 *      connection only; a live connection keeps the values it logged, and a malformed override (wrong
 *      type, unknown `numeral_mode`, out-of-range H or G) falls back to the shipped values with the
 *      reason in the connection log.
 *  (c) The replay tool reads the SAME `chosen` block: `--print-chosen` prints it item for item, and
 *      the two replay gates still pass.
 *  (d) tsc really emits the JSON with the build: the server tsconfig's own `resolveJsonModule`
 *      option, driven over a virtual module that imports the shipping file, writes a copy beside the
 *      compiled output (`dist-server.next/server/modules/voice-realtime/…`, mirrored here into a
 *      temp outDir).
 *
 * The server JSON is the ONLY expected-value source in this file — nothing falls back to
 * `experiments/`, which is what makes deleting the server file a red rather than a pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import nodeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { WebSocket as WS } from 'ws';

import type { OmissionFillParams, RealtimeToolExecutor } from '../index.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, type FakeTransport } from './realtime-bridge-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const SERVER_PARAMS_FILE = path.join(REPO_ROOT, 'server', 'modules', 'voice-realtime', 'omission-fill-params.json');
const REPLAY_RULE = path.join(REPO_ROOT, 'experiments', 'voice-relay-qb', 'replay_rule.py');

/** The shape the shipped file must carry (the `chosen` block the task locked). */
type ShippedChosen = {
  readonly h_ms: number;
  readonly g_ms: number;
  readonly score_t: number;
  readonly w_min: number;
  readonly w_hallu: number;
  readonly dom_n: number;
  readonly lookback_ms: number;
  readonly len_min: number;
  readonly numeral_mode: string;
  readonly silence_ms: number | null;
};

const SHIPPED = JSON.parse(readFileSync(SERVER_PARAMS_FILE, 'utf8')) as { chosen: ShippedChosen };
const SHIPPED_CHOSEN = SHIPPED.chosen;

/** What a connection's `omission_fill params` line must say when nothing overrides the shipped file. */
const SHIPPED_PARAMS: OmissionFillParams = {
  hMs: SHIPPED_CHOSEN.h_ms,
  gMs: SHIPPED_CHOSEN.g_ms,
  scoreT: SHIPPED_CHOSEN.score_t,
  wMin: SHIPPED_CHOSEN.w_min,
  wHallu: SHIPPED_CHOSEN.w_hallu,
  domN: SHIPPED_CHOSEN.dom_n,
  lookbackMs: SHIPPED_CHOSEN.lookback_ms,
  silenceMs: SHIPPED_CHOSEN.silence_ms,
  numeralMode: SHIPPED_CHOSEN.numeral_mode as OmissionFillParams['numeralMode'],
};

/** A fixed epoch: every `dueAt` below is absolute and reproducible. */
const B = 1_760_000_000_000;

/** A minimal stand-in for the browser's `ws.WebSocket` (the surface the proxy uses). */
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
}

type RecordedSend = { args: Record<string, unknown> };

/** Wires one proxy connection; `settingsPath` is the per-connection settings file, when the case has one. */
function wireConnection(options: {
  settingsPath?: string;
  log?: (line: string) => void;
}): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  calls: RecordedSend[];
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const calls: RecordedSend[] = [];
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      calls.push({ args });
      return { ok: true, echoedMessage: args.message };
    },
  };
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => executor,
    instructions: 'test instructions',
    coalesceMs: 0,
    stallMs: 0,
    statusRateMs: 60_000,
    browserKeepaliveMs: 0,
    ...(options.settingsPath === undefined ? {} : { settingsPath: options.settingsPath }),
    ...(options.log === undefined ? {} : { log: options.log }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transport, calls };
}

/** Lets every microtask and every already-resolved promise run (no timer involved). */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Delivers one final transcription from the endpoint. */
function deliverFinal(transport: FakeTransport, itemId: string, text: string): void {
  transport.peerSend({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
  });
}

/** The parameters a connection logged, or null when it logged no parameters line. */
function loggedParams(logs: readonly string[]): OmissionFillParams | null {
  const line = logs.find((entry) => entry.startsWith('omission_fill params '));
  return line === undefined
    ? null
    : (JSON.parse(line.slice('omission_fill params '.length)) as OmissionFillParams);
}

/** The first line carrying `needle`, for an assertion message that shows the whole log. */
function logLine(logs: readonly string[], needle: string): string | undefined {
  return logs.find((line) => line.includes(needle));
}

/** One temp directory this file owns; removed by the caller. */
function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * (a) The parameters travel with the server, not with the checkout's `experiments/` tree.
 *
 * The fs seam replaces `node:fs`'s `readFileSync` for the duration of the connection and throws for
 * ANY path naming `omission-fill-params.json` — the file the reverted reader used to open. The new
 * reader never opens a file (the JSON is a module import evaluated at load time), so the producer
 * stays on and its parameters are the server file's.
 */
test('(a) a connection with no experiments/ tree and that file unreadable still runs on the server JSON', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const workdir = tempDir('omission-source-cwd-');
  const previousCwd = process.cwd();
  const originalReadFileSync = nodeFs.readFileSync;
  const logs: string[] = [];
  let socket: FakeBrowserSocket | null = null;
  try {
    // Arm the seam BEFORE the connection can read anything. `syncBuiltinESMExports` is what makes a
    // module's already-bound `import { readFileSync }` see this replacement.
    nodeFs.readFileSync = ((file: unknown, ...rest: unknown[]) => {
      if (String(file).includes('omission-fill-params.json')) {
        throw new Error('EACCES: experiments/ is unreadable in this criterion');
      }
      return (originalReadFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof nodeFs.readFileSync;
    syncBuiltinESMExports();

    process.chdir(workdir);
    assert.equal(existsSync(path.join(workdir, 'experiments')), false, 'the working directory must have no experiments/');

    const fresh = wireConnection({ log: (line) => logs.push(line) });
    socket = fresh.socket;
    await flush();
    assert.ok(fresh.transport.openCalls >= 1, 'the upstream must be dialled before events are delivered');

    const params = loggedParams(logs);
    assert.ok(params !== null, `the connection must log its parameters: ${logs.join(' | ')}`);
    assert.deepEqual(params, SHIPPED_PARAMS, 'the parameters must be the server JSON`s chosen block');
    assert.equal(
      logLine(logs, 'omission_fill disabled'),
      undefined,
      `a missing/unreadable experiments/ file must NOT disable the producer: ${logs.join(' | ')}`,
    );

    // The producer is genuinely ON, not merely logged: a weight >= 7 final with a silent model is
    // delivered verbatim at t + S.
    deliverFinal(fresh.transport, 'item-source', '服务器一直连接不上');
    await flush();
    t.mock.timers.tick(SHIPPED_CHOSEN.silence_ms ?? SHIPPED_CHOSEN.h_ms);
    await flush();
    assert.deepEqual(
      fresh.calls.map((call) => call.args.message),
      ['服务器一直连接不上'],
      'the omission producer must still deliver at its confirmation time',
    );
  } finally {
    process.chdir(previousCwd);
    nodeFs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
    socket?.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

/**
 * (b1) A legal partial override reaches the NEXT connection and leaves the live one alone.
 */
test('(b1) omissionFill overrides the shipped values per connection; an established connection keeps its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(B);

  const dir = tempDir('omission-settings-');
  const settingsPath = path.join(dir, 'settings.json');
  const logsA: string[] = [];
  const logsB: string[] = [];
  try {
    writeFileSync(settingsPath, JSON.stringify({ omissionFill: { silence_ms: 2_000, numeral_mode: 'all' } }));

    const a = wireConnection({ settingsPath, log: (line) => logsA.push(line) });
    await flush();
    deliverFinal(a.transport, 'item-a', '服务器一直连接不上');
    await flush();

    // The next connection reads the REWRITTEN file; connection A must not.
    writeFileSync(settingsPath, JSON.stringify({ omissionFill: { silence_ms: 5_000 } }));
    const b = wireConnection({ settingsPath, log: (line) => logsB.push(line) });
    await flush();
    deliverFinal(b.transport, 'item-b', '麻烦你再看一下日志');
    await flush();

    const paramsA = loggedParams(logsA);
    const paramsB = loggedParams(logsB);
    assert.ok(paramsA !== null && paramsB !== null, `both connections must log parameters: ${logsA.join(' | ')} // ${logsB.join(' | ')}`);
    assert.equal(paramsA.silenceMs, 2_000, 'the first connection keeps the value it read');
    assert.equal(paramsA.numeralMode, 'all', 'a named override replaces only that field');
    assert.equal(paramsA.hMs, SHIPPED_CHOSEN.h_ms, 'unnamed fields keep the shipped values');
    assert.equal(paramsB.silenceMs, 5_000, 'the next connection reads the rewritten file');
    assert.equal(paramsB.numeralMode, SHIPPED_CHOSEN.numeral_mode, 'the rewrite dropped the earlier override');

    // The behaviour follows each connection's own snapshot: A confirms at t+2000, B at t+5000.
    t.mock.timers.tick(1_999);
    await flush();
    assert.equal(a.calls.length, 0, 'A must not deliver before its own S');
    assert.equal(b.calls.length, 0, 'B must not deliver before its own S');

    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(a.calls.map((call) => call.args.message), ['服务器一直连接不上'], 'A delivers at its own t+2000');
    assert.equal(b.calls.length, 0, 'B is still waiting — the rewrite did not reach the live connection');

    t.mock.timers.tick(3_000);
    await flush();
    assert.deepEqual(b.calls.map((call) => call.args.message), ['麻烦你再看一下日志'], 'B delivers at its own t+5000');

    a.socket.close();
    b.socket.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * (b2) Every illegal shape refuses the override and leaves the shipped values, with the reason logged.
 */
test('(b2) a malformed omissionFill falls back to the shipped values and records why', async () => {
  const dir = tempDir('omission-settings-bad-');
  try {
    const cases: Array<{ name: string; omissionFill: Record<string, unknown>; reason: string }> = [
      { name: 'wrong type', omissionFill: { h_ms: '12000' }, reason: 'omissionFill.h_ms' },
      { name: 'unknown numeral_mode', omissionFill: { numeral_mode: 'digits' }, reason: 'omissionFill.numeral_mode' },
      { name: 'H below its bound', omissionFill: { h_ms: 500 }, reason: 'omissionFill.h_ms' },
      { name: 'G above its bound', omissionFill: { g_ms: 60_001 }, reason: 'omissionFill.g_ms' },
    ];

    for (const [index, testCase] of cases.entries()) {
      const settingsPath = path.join(dir, `settings-${index}.json`);
      writeFileSync(settingsPath, JSON.stringify({ omissionFill: testCase.omissionFill }));
      const logs: string[] = [];
      const { socket } = wireConnection({ settingsPath, log: (line) => logs.push(line) });
      await flush();
      try {
        assert.deepEqual(
          loggedParams(logs),
          SHIPPED_PARAMS,
          `${testCase.name}: the connection must run on the shipped values: ${logs.join(' | ')}`,
        );
        assert.ok(
          logLine(logs, testCase.reason) !== undefined,
          `${testCase.name}: the refusal reason must reach the connection log: ${logs.join(' | ')}`,
        );
      } finally {
        socket.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * (c) The replay tool reads the SERVER file — and the gates still pass on the frozen corpus.
 */
test('(c) replay_rule.py --print-chosen is the server chosen block, and both gates stay green', () => {
  const run = (args: string[]): { status: number | null; stdout: string; stderr: string } =>
    spawnSync('python3', ['-I', REPLAY_RULE, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });

  const printed = run(['--print-chosen']);
  assert.equal(printed.status, 0, `--print-chosen must succeed: ${printed.stderr}`);
  const parsed = JSON.parse(printed.stdout) as Record<string, unknown>;
  assert.deepEqual(parsed, SHIPPED_CHOSEN as unknown as Record<string, unknown>, 'the replay must print the server JSON`s chosen block');

  for (const gate of [['--check'], ['--check-labels']]) {
    const result = run(gate);
    assert.equal(result.status, 0, `${gate.join(' ')} must stay green: ${result.stderr}`);
  }
});

/**
 * (d) tsc emits the JSON with the build: the real server tsconfig's options, a virtual module that
 * imports the shipping file, and a temp outDir that mirrors `dist-server.next`.
 */
test('(d) the server tsconfig emits omission-fill-params.json beside the compiled module', () => {
  const configPath = path.join(REPO_ROOT, 'server', 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, `server/tsconfig.json must parse: ${String(config.error?.messageText)}`);
  const parsed = ts.parseJsonConfigFileContent(
    { ...(config.config as Record<string, unknown>), files: [], include: [] },
    ts.sys,
    path.dirname(configPath),
  );
  const outDir = tempDir('omission-emit-');
  try {
    const options: ts.CompilerOptions = {
      ...parsed.options,
      outDir,
      rootDir: REPO_ROOT,
      noEmitOnError: true,
    };
    assert.equal(options.resolveJsonModule, true, 'the server build must enable resolveJsonModule');

    const virtualRoot = path.join(REPO_ROOT, '__omission-fill-emit-probe.ts');
    const source =
      "import params from './server/modules/voice-realtime/omission-fill-params.json' with { type: 'json' };\n" +
      'export default params;\n';
    const host = ts.createCompilerHost(options, true);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    const originalFileExists = host.fileExists.bind(host);
    const originalReadFile = host.readFile.bind(host);
    host.fileExists = (file) => file === virtualRoot || originalFileExists(file);
    host.readFile = (file) => (file === virtualRoot ? source : originalReadFile(file));
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
      file === virtualRoot
        ? ts.createSourceFile(file, source, languageVersion, true)
        : originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);

    const program = ts.createProgram([virtualRoot], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(
      diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      [],
      'the emit probe must typecheck cleanly',
    );
    const emitted = program.emit();
    assert.equal(emitted.emitSkipped, false, 'emit must not be skipped');

    const emittedParams = path.join(outDir, 'server', 'modules', 'voice-realtime', 'omission-fill-params.json');
    assert.ok(existsSync(emittedParams), 'tsc must copy the imported JSON into the build output');
    assert.deepEqual(
      JSON.parse(readFileSync(emittedParams, 'utf8')),
      JSON.parse(readFileSync(SERVER_PARAMS_FILE, 'utf8')),
      'the emitted copy must be the shipping file',
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
