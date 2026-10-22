/**
 * The spend guard: a connection that is spending at a runaway rate is ended, and one behaving normally
 * is never touched. The numbers come from the owner's October 2026 bill and from recorded sessions.
 *
 * As of 2026-10-23 the guard's WINDOW threshold defaults to ¥0.05/30 s
 * (`DEFAULT_SPEND_WINDOW_LIMIT_CNY`); a deployment may override it through
 * `VOICE_REALTIME_MAX_CNY_PER_30S`, and the HTTP diagnosis route passes its own ¥0.05. A refused
 * value is reported but resolves to the default, so a typo cannot silently disarm the guard. The
 * criterion for that change lives here too, in the "AC1…AC4" cases, because no new test file may be
 * added (`scripts/test.sh` pins the server test file count).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  DEFAULT_SPEND_WINDOW_LIMIT_CNY,
  VOICE_REALTIME_MAX_CNY_PER_30S_ENV,
  createDashscopeTransport,
  describeSpendWindowLimit,
  estimateRealtimeCostCny,
  resolveSpendWindowLimit,
  type DashscopeWireObserver,
  type RealtimeToolExecutor,
} from '../index.js';
import { handleVoiceRealtimeConnection, VOICE_REALTIME_INSTRUCTIONS, type VoiceRealtimeOutboundFrame } from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const usage = (input: number, audio: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  input_tokens_details: { text_tokens: input - audio, audio_tokens: audio },
});

test('the estimate reproduces the owner’s invoice lines', () => {
  // 07:09 — the runaway loop: 294.269k text + 5.852k audio input, 2.648k output = ¥0.4414 + ¥0.0351 + ¥0.0119.
  const loop = estimateRealtimeCostCny(usage(300_121, 5_852, 2_648));
  assert.ok(Math.abs(loop - 0.4885) < 0.001, `loop estimated at ${loop}`);
  // 07:43 — five utterances in one connection: 5.814k + 0.546k input, 0.146k output ≈ ¥0.0127.
  const session = estimateRealtimeCostCny(usage(6_360, 546, 146));
  assert.ok(Math.abs(session - 0.0127) < 0.0005, `session estimated at ${session}`);
  // Unknown shapes cost nothing: the guard must never fire on data it cannot read.
  assert.equal(estimateRealtimeCostCny(undefined), 0);
  assert.equal(estimateRealtimeCostCny({ input_tokens: 'many' }), 0);
});

test('real sessions sit well below the window limit: the recorded one, and the current build’s', () => {
  const recording = JSON.parse(
    readFileSync(path.join(HERE, 'fixtures/real-run-qwen38-four-utterances.json'), 'utf8'),
  ) as Array<{ wire: { type: string; response?: { usage?: unknown } } }>;
  const costs = recording.filter((entry) => entry.wire.type === 'response.done').map((entry) => estimateRealtimeCostCny(entry.wire.response?.usage));
  assert.ok(costs.length >= 8);
  // One response of the OLD six-tool context costs at most about ¥0.003.
  assert.ok(Math.max(...costs) < 0.0035, `one response costs at most ${Math.max(...costs)}`);
  // The same recorded session (old context, ¥0.020 over ~14 s) is exactly what the one-tool build cut.
  // The current build's measured run — 3,686 input (259 audio) / 91 output for the same 12 s clip:
  const current = estimateRealtimeCostCny(usage(3_686, 259, 91));
  assert.ok(current < 0.008, `the current build spends about ¥${current.toFixed(4)} on that clip`);
  assert.ok(current < DEFAULT_SPEND_WINDOW_LIMIT_CNY, 'and that is inside the default window limit with a wide margin');
});

function build(
  spendGuard: { maxCnyPerWindow?: number; windowMs?: number; maxCnyTotal?: number },
  observer?: DashscopeWireObserver,
) {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const socket = new FakeBrowserSocket();
  const executor: RealtimeToolExecutor = { session_send: async () => ({ ok: true }) };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0], 'bound', {
    createTransport: (report) =>
      createDashscopeTransport({
        apiKey: 'sk-test',
        socketFactory: upstream.socketFactory,
        onError: report,
        spendGuard,
        ...(observer === undefined ? {} : { observer }),
      }),
    createExecutor: () => executor,
    instructions: VOICE_REALTIME_INSTRUCTIONS,
  });
  return { upstream, socket };
}
const opened = (socket: FakeBrowserSocket) => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');
const responseDone = (upstream: ReturnType<typeof createFakeDashscopeServer>, u: unknown, id: string) =>
  upstream.peerSend({ type: 'response.done', response: { id, status: 'completed', usage: u } });

test('a runaway rate ends the session within a few responses, and tells the person why', async () => {
  const { upstream, socket } = build({ windowMs: 30_000, maxCnyPerWindow: DEFAULT_SPEND_WINDOW_LIMIT_CNY });
  await waitFor(() => opened(socket));
  // The observed loop: ~5.6k-token responses, one every 0.65 s (≈¥0.0090 each). Seven of them
  // cross the ¥0.05 default (≈¥0.0629); the first five (≈¥0.0449) deliberately do not.
  for (let index = 0; index < 7; index += 1) {
    responseDone(upstream, usage(5_600, 100, 30), `r${index}`);
  }
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT'));
  const trip = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT');
  assert.ok(trip && trip.type === 'error');
  assert.equal(trip.recoverable, undefined, 'a runaway connection is not "recoverable"');
  assert.match(trip.message, /spending guard/i);
  assert.match(trip.message, /¥0\.0\d\d/);
  await waitFor(() => socket.readyState === WS.CLOSED);
  assert.equal(socket.outbound.filter((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT').length, 1, 'reported once');
});

test('ordinary use, however long, is not touched', async () => {
  const { upstream, socket } = build({ windowMs: 200, maxCnyPerWindow: DEFAULT_SPEND_WINDOW_LIMIT_CNY });
  await waitFor(() => opened(socket));
  // Ten responses of ~0.8k tokens (¥0.0013 each), spread out so no window holds more than a few.
  for (let index = 0; index < 10; index += 1) {
    responseDone(upstream, usage(800, 20, 30), `n${index}`);
    await sleep(60);
  }
  await sleep(100);
  assert.equal(socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT'), false);
  assert.notEqual(socket.readyState, WS.CLOSED);
  socket.close();
});

test('the whole-connection total is a backstop for a slow leak', async () => {
  const { upstream, socket } = build({ windowMs: 100, maxCnyPerWindow: 1, maxCnyTotal: 0.01 });
  await waitFor(() => opened(socket));
  for (let index = 0; index < 8; index += 1) {
    responseDone(upstream, usage(1_500, 0, 20), `t${index}`);
    await sleep(150); // each in its own window: only the total can see this
  }
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT'));
  const trip = socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT');
  assert.ok(trip && trip.type === 'error' && /in total/.test(trip.message));
});

// ---------------------------------------------------------------------------
// AC1–AC4: the window cap is resolved, refused-not-swallowed, assembled with no
// production default, and — read from the OTHER side — really absent. The
// environment and the override are fed as ARGUMENTS here, never through
// `process.env`, which is the whole reason the resolution is a pure function.
// ---------------------------------------------------------------------------

test('AC1 the window cap resolves from an override, or the environment, or the ¥0.05 default', () => {
  const fromNothing = resolveSpendWindowLimit({}, undefined);
  const fromOverride = resolveSpendWindowLimit({}, 0.07);
  const fromEnv = resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' }, undefined);
  const fromBoth = resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' }, 0.07);

  console.log(
    `AC1 (a) env={} override=undefined  => maxCnyPerWindow=${fromNothing.maxCnyPerWindow} invalid=${JSON.stringify(fromNothing.invalid)}`,
  );
  console.log(`AC1 (b) env={} override=0.07       => maxCnyPerWindow=${fromOverride.maxCnyPerWindow}`);
  console.log(`AC1 (c) env={'0.02'} override=undefined => maxCnyPerWindow=${fromEnv.maxCnyPerWindow}`);
  console.log(`AC1 (d) env={'0.02'} override=0.07 => maxCnyPerWindow=${fromBoth.maxCnyPerWindow} (the override wins)`);

  // (a) is the shipped production state: the default cap applies, and saying nothing is not a
  // misconfiguration.
  assert.equal(fromNothing.maxCnyPerWindow, DEFAULT_SPEND_WINDOW_LIMIT_CNY);
  assert.equal(fromNothing.maxCnyPerWindow, 0.05);
  assert.equal(fromNothing.invalid, null, 'saying nothing is not a misconfiguration');
  assert.equal(fromOverride.maxCnyPerWindow, 0.07);
  assert.equal(fromEnv.maxCnyPerWindow, 0.02);
  // (d) the override is the authority for its run — the diagnosis route's value must not be
  // overridden BY the deployment's own variable.
  assert.equal(fromBoth.maxCnyPerWindow, 0.07);
  assert.notEqual(fromBoth.maxCnyPerWindow, fromEnv.maxCnyPerWindow, 'if these matched, (d) would be vacuous');
  // Purity, stated as a reading: the same arguments give the same answer, and the env is not
  // consulted for anything but this ONE variable.
  assert.deepEqual(resolveSpendWindowLimit({}, undefined), fromNothing);
  assert.equal(
    resolveSpendWindowLimit({ SOME_OTHER_VAR: '0.02' }, undefined).maxCnyPerWindow,
    DEFAULT_SPEND_WINDOW_LIMIT_CNY,
  );
});

test('AC2 a mistyped window cap is refused AND reported, while the ¥0.05 default stays armed', () => {
  for (const raw of ['abc', '0', '-1', '  ']) {
    const resolution = resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: raw }, undefined);
    const report = describeSpendWindowLimit(resolution);
    console.log(
      `AC2 env=${JSON.stringify(raw)} => maxCnyPerWindow=${resolution.maxCnyPerWindow} invalid=${JSON.stringify(resolution.invalid)} report=${JSON.stringify(report)}`,
    );
    assert.equal(resolution.maxCnyPerWindow, DEFAULT_SPEND_WINDOW_LIMIT_CNY, `${JSON.stringify(raw)} must not become a cap, but the default stays`);
    assert.ok(
      resolution.invalid !== null && resolution.invalid.length > 0,
      `${JSON.stringify(raw)} was refused, so the resolution must carry a printable report`,
    );
    assert.ok(report !== null && report.length > 0, 'describeSpendWindowLimit must render that report');
    assert.match(report, /spend window limit/);
    assert.match(report, /default applies/);
  }
  // WHY the reporting matters, made executable: `Number('abc')` is NaN and a comparison against NaN
  // is false for EVERY spend, so an unvalidated typo produces a guard that can never fire. With the
  // default in place the guard still fires at ¥0.05; the report is how the operator learns their
  // intended value was not applied.
  assert.equal(Number('abc') > DEFAULT_SPEND_WINDOW_LIMIT_CNY, false, 'NaN compares false, so the default is what keeps the guard armed');
  assert.equal(0.5 > Number('abc'), false, 'and it does so on the wrong side too');
  // A refused override does not silently fall through to the environment either: substituting one
  // explicit cap for another would hide the misconfiguration. It lands on the default instead.
  const refusedOverride = resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' }, 0);
  console.log(`AC2 override=0 with env={'0.02'} => maxCnyPerWindow=${refusedOverride.maxCnyPerWindow} invalid=${JSON.stringify(refusedOverride.invalid)}`);
  assert.equal(refusedOverride.maxCnyPerWindow, DEFAULT_SPEND_WINDOW_LIMIT_CNY);
  assert.ok(refusedOverride.invalid !== null);
});

/** The substring of `source` from `marker` (which ends in the literal's `{`) through its closing brace. */
function objectLiteralAt(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} is not in the source`);
  let depth = 0;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

test('AC3 the assembly point carries the default window cap, calls the resolver exactly once, and leaves the diagnosis route and the total opt-in alone', () => {
  // Source reading, the house's established way of pinning a composition-root decision: the seams
  // are assembled at boot inside a function no unit test can call (it needs the whole MCP surface),
  // so the assertion is on the source the process actually runs.
  const source = readFileSync(path.join(HERE, '../../../index.ts'), 'utf8');
  const spendGuard = objectLiteralAt(source, 'spendGuard: {');

  const literalGone = !/\b0\.015\b/.test(spendGuard);
  const literalGoneFileWide = !/\b0\.015\b/.test(source);
  // Word-boundary CALL count: the import mention has no `(` after it, so this counts call sites —
  // and `\b` keeps a future `resolveSpendWindowLimitFor…` from being counted as this one.
  const resolverCalls = (source.match(/\bresolveSpendWindowLimit\s*\(/g) ?? []).length;
  const resolverMentions = (source.match(/\bresolveSpendWindowLimit\b/g) ?? []).length;
  const overridePlumbed = /\bresolveSpendWindowLimit\(\s*process\.env\s*,\s*input\.spendWindowLimitCny\s*,/.test(source);
  // The file source is the third argument and must be THIS connection's reading, while the default
  // window travels with the cap from the same resolution.
  const filePlumbed = /\bresolveSpendWindowLimit\(\s*process\.env\s*,\s*input\.spendWindowLimitCny\s*,\s*voiceRealtimeSettings\.spendGuard\s*,?\s*\)/.test(source);
  const windowFromResolution = /\bwindowMs:\s*spendWindowLimit\.windowMs\b/.test(spendGuard);
  const barrelImport = source
    .split('\n')
    .find((line) => line.includes("from './modules/voice-realtime/index.js'"));
  const diagnoseLimit = /spendWindowLimitCny:\s*([\d.]+)/.exec(source)?.[1];
  // The assembled guard is unconditionally armed: `maxCnyPerWindow` appears exactly once and is the
  // resolver's number, not a conditional spread. `maxCnyTotal` remains the sole opt-in.
  const windowMentions = (spendGuard.match(/maxCnyPerWindow\s*:/g) ?? []).length;
  const defaultPlumbed = /\bmaxCnyPerWindow:\s*spendWindowLimit\.maxCnyPerWindow\b/.test(spendGuard);
  const totalMentions = (spendGuard.match(/maxCnyTotal/g) ?? []).length;
  const totalOptIn = /\.\.\.\(\s*process\.env\.VOICE_REALTIME_MAX_CNY_PER_CONNECTION\b[\s\S]*?maxCnyTotal/.test(spendGuard) && totalMentions === 1;

  console.log(
    `AC3 literalGone=${literalGone} resolverCalls=${resolverCalls} diagnoseLimit=${diagnoseLimit} defaultPlumbed=${defaultPlumbed} filePlumbed=${filePlumbed} windowFromResolution=${windowFromResolution} totalOptIn=${totalOptIn}`,
  );
  console.log(
    `AC3 (extras) literalGoneFileWide=${literalGoneFileWide} resolverMentions=${resolverMentions} overridePlumbed=${overridePlumbed} barrelImport=${barrelImport?.includes('resolveSpendWindowLimit') === true} windowMentions=${windowMentions} totalMentions=${totalMentions}`,
  );

  // (a) the old ¥0.015 default cannot come back through the assembled guard.
  assert.ok(literalGone, 'the spendGuard literal must not carry the removed ¥0.015 default');
  assert.ok(literalGoneFileWide, 'and nothing else in server/index.ts should carry it either');
  // (b) exactly ONE call site, and it is the assembly point's, reading the environment, the
  // route's override and THIS connection's settings reading — resolved once, not per knob.
  assert.equal(resolverCalls, 1);
  assert.ok(overridePlumbed, 'the resolver must be called with (process.env, input.spendWindowLimitCny, …)');
  assert.ok(filePlumbed, 'the resolver must be handed this connection\'s settings reading as the file source');
  assert.ok(resolverMentions >= 2, 'the single call must also be imported');
  assert.ok(barrelImport?.includes('resolveSpendWindowLimit') === true, 'and imported through the module barrel');
  // (c) the guard is armed by default: the resolver's numeric answer is passed unconditionally, and
  // the window comes from the same resolution (so a file can change both together).
  assert.equal(windowMentions, 1);
  assert.ok(defaultPlumbed, 'maxCnyPerWindow must be the resolver\'s value, not a conditional spread');
  assert.ok(windowFromResolution, 'windowMs must come from the resolution, not a hard-coded 30_000');
  // (d) the HTTP diagnosis route's own window is untouched.
  assert.equal(diagnoseLimit, '0.05');
  // (e) the whole-connection total is still an explicit opt-in.
  assert.ok(totalOptIn, 'maxCnyTotal must stay gated on VOICE_REALTIME_MAX_CNY_PER_CONNECTION');
});

test('AC4 the ¥0.05 default leaves a five-response burst alone and ends a seven-response one', async () => {
  // The observed runaway string: ~5.6k-token responses (the loop's own shape, one every 0.65 s).
  const perResponse = estimateRealtimeCostCny(usage(5_600, 100, 30));
  const normal = perResponse * 5;
  const runaway = perResponse * 7;
  const defaultCap = resolveSpendWindowLimit({}, undefined).maxCnyPerWindow;
  console.log(
    `AC4 per-response=¥${perResponse.toFixed(4)}; 5 responses=¥${normal.toFixed(4)}; 7 responses=¥${runaway.toFixed(4)}; default cap=¥${defaultCap}`,
  );
  assert.equal(defaultCap, DEFAULT_SPEND_WINDOW_LIMIT_CNY);
  assert.ok(normal < defaultCap, 'five responses must sit below the default, or (i) proves nothing');
  assert.ok(runaway > defaultCap, 'seven responses must exceed it, or (ii) proves nothing');

  // (i) Five responses — the old ¥0.015 default ended this string; the new ¥0.05 default does not.
  let seen = 0;
  const under = build({ windowMs: 30_000, maxCnyPerWindow: defaultCap }, (observation) => {
    if (observation.direction === 'received' && (observation.wire as { type?: string }).type === 'response.done') seen += 1;
  });
  await waitFor(() => opened(under.socket));
  for (let index = 0; index < 5; index += 1) responseDone(under.upstream, usage(5_600, 100, 30), `u${index}`);
  // A POSITIVE signal that all five were charged, rather than a blind sleep: the transport observes
  // each received frame immediately before it charges the guard, so 5 seen + a tick means 5 charged.
  await waitFor(() => seen === 5);
  await sleep(50);
  const underTrip = under.socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT');
  console.log(
    `AC4 (i) 5 responses under the ¥${defaultCap} default: charged=${seen}, SPEND_LIMIT=${underTrip !== undefined}, readyState=${under.socket.readyState} (OPEN=${WS.OPEN} CLOSED=${WS.CLOSED})`,
  );
  assert.equal(underTrip, undefined, 'the default must not end a five-response burst');
  assert.notEqual(under.socket.readyState, WS.CLOSED, 'and the connection stays open');
  under.socket.close();

  // (ii) Seven responses — the same shape, one more than the old five-response runaway witness,
  // crosses the default and must end the session. This is the positive control: (i) is "the default
  // is wide enough", not "the guard is broken".
  const over = build({ windowMs: 30_000, maxCnyPerWindow: defaultCap });
  await waitFor(() => opened(over.socket));
  for (let index = 0; index < 7; index += 1) responseDone(over.upstream, usage(5_600, 100, 30), `c${index}`);
  await waitFor(() => over.socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT'));
  const overTrip = over.socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT');
  assert.ok(overTrip && overTrip.type === 'error');
  const spentAtTrip = Number(/used about ¥([\d.]+)/.exec(overTrip.message)?.[1]);
  console.log(
    `AC4 (ii) 7 responses under the ¥${defaultCap} default: SPEND_LIMIT cny=¥${spentAtTrip.toFixed(4)} message=${JSON.stringify(overTrip.message)}`,
  );
  assert.ok(Number.isFinite(spentAtTrip), 'the frame must name the spend that tripped it');
  assert.ok(spentAtTrip > defaultCap && spentAtTrip <= runaway, 'it tripped inside the seven-response string');
  await waitFor(() => over.socket.readyState === WS.CLOSED);
});

// ---------------------------------------------------------------------------
// The settings-file source and its precedence: override > environment > file > default. The file
// block is fed as an ARGUMENT (the resolver is pure), so this leg reads the same function the
// assembly point calls rather than a copy of its rules.
// ---------------------------------------------------------------------------

test('AC2 the file is a source; override > environment > file > default, and windowMs comes from the file', () => {
  const fromFile = resolveSpendWindowLimit({}, undefined, { maxCnyPerWindow: 0.1, windowMs: 45_000 });
  console.log(
    `AC2 file=0.1 => maxCnyPerWindow=${fromFile.maxCnyPerWindow} windowMs=${fromFile.windowMs} source=${fromFile.source}`,
  );
  assert.equal(fromFile.maxCnyPerWindow, 0.1, 'file=0.1 must reach the resolution');
  assert.equal(fromFile.source, 'file');
  assert.equal(fromFile.windowMs, 45_000, 'windowMs comes from the file');

  const envOverFile = resolveSpendWindowLimit(
    { [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' },
    undefined,
    { maxCnyPerWindow: 0.1, windowMs: 45_000 },
  );
  console.log(
    `AC2 env=0.02 压过 file=0.1 => maxCnyPerWindow=${envOverFile.maxCnyPerWindow} windowMs=${envOverFile.windowMs} source=${envOverFile.source}`,
  );
  assert.equal(envOverFile.maxCnyPerWindow, 0.02, 'the environment escape hatch wins over the file');
  assert.equal(envOverFile.windowMs, 45_000, 'the file still decides the window it named');
  assert.equal(envOverFile.source, 'environment');

  const overrideOverBoth = resolveSpendWindowLimit(
    { [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' },
    0.07,
    { maxCnyPerWindow: 0.1, windowMs: 45_000 },
  );
  console.log(
    `AC2 override=0.07 压过 env/file => maxCnyPerWindow=${overrideOverBoth.maxCnyPerWindow} windowMs=${overrideOverBoth.windowMs} source=${overrideOverBoth.source}`,
  );
  assert.equal(overrideOverBoth.maxCnyPerWindow, 0.07, 'the per-run override is the authority');
  assert.equal(overrideOverBoth.source, 'override');

  const invalidFile = resolveSpendWindowLimit({}, undefined, { maxCnyPerWindow: 'abc' as unknown as number });
  console.log(
    `AC2 invalid file -> 0.05 + invalid report => maxCnyPerWindow=${invalidFile.maxCnyPerWindow} invalid=${JSON.stringify(invalidFile.invalid)}`,
  );
  assert.equal(invalidFile.maxCnyPerWindow, DEFAULT_SPEND_WINDOW_LIMIT_CNY, 'a refused file value keeps the default armed');
  assert.equal(invalidFile.maxCnyPerWindow, 0.05);
  assert.ok(invalidFile.invalid !== null && invalidFile.invalid.includes('settings file'), 'the report names the file source');
  assert.equal(invalidFile.windowMs, 30_000, 'no usable window in the block keeps the default window');

  // A refused WINDOW is reported while the file's cap still applies: one bad field must not discard
  // the other, and it must never disarm the guard.
  const invalidWindow = resolveSpendWindowLimit({}, undefined, { maxCnyPerWindow: 0.1, windowMs: 100 });
  console.log(
    `AC2 invalid windowMs=100 => maxCnyPerWindow=${invalidWindow.maxCnyPerWindow} windowMs=${invalidWindow.windowMs} invalid=${JSON.stringify(invalidWindow.invalid)}`,
  );
  assert.equal(invalidWindow.maxCnyPerWindow, 0.1);
  assert.equal(invalidWindow.windowMs, 30_000);
  assert.ok(invalidWindow.invalid !== null && invalidWindow.invalid.includes('windowMs'));

  // No file block at all is the shipped state, not an error.
  const noFile = resolveSpendWindowLimit({}, undefined, null);
  assert.equal(noFile.maxCnyPerWindow, 0.05);
  assert.equal(noFile.windowMs, 30_000);
  assert.equal(noFile.source, 'default');
  assert.equal(noFile.invalid, null);
});
