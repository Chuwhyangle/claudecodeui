/**
 * The spend guard: a connection that is spending at a runaway rate is ended, and one behaving normally
 * is never touched. The numbers come from the owner's October 2026 bill and from recorded sessions.
 *
 * As of 2026-10-11 the guard's WINDOW threshold is no longer defaulted on the production path: it
 * exists only when a deployment names one (`VOICE_REALTIME_MAX_CNY_PER_30S`) or a caller passes an
 * override (the HTTP diagnosis route's ¥0.05). The criterion for that change lives here too, in the
 * "AC1…AC4" cases, because no new test file may be added (`scripts/test.sh` pins the server test
 * file count).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
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
  assert.ok(current < 0.015, 'and that is inside the window limit with a wide margin');
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
  const { upstream, socket } = build({ windowMs: 30_000, maxCnyPerWindow: 0.015 });
  await waitFor(() => opened(socket));
  // The observed loop: ~5.6k-token responses, one every 0.65 s (¥0.0084 each).
  for (let index = 0; index < 5; index += 1) {
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
  const { upstream, socket } = build({ windowMs: 200, maxCnyPerWindow: 0.015 });
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

test('AC1 the window cap resolves from an override, or the environment, or neither — and never a default', () => {
  const fromNothing = resolveSpendWindowLimit({}, undefined);
  const fromOverride = resolveSpendWindowLimit({}, 0.05);
  const fromEnv = resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' }, undefined);
  const fromBoth = resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' }, 0.05);

  console.log(
    `AC1 (a) env={} override=undefined  => maxCnyPerWindow=${fromNothing.maxCnyPerWindow} invalid=${JSON.stringify(fromNothing.invalid)}`,
  );
  console.log(`AC1 (b) env={} override=0.05       => maxCnyPerWindow=${fromOverride.maxCnyPerWindow}`);
  console.log(`AC1 (c) env={'0.02'} override=undefined => maxCnyPerWindow=${fromEnv.maxCnyPerWindow}`);
  console.log(`AC1 (d) env={'0.02'} override=0.05 => maxCnyPerWindow=${fromBoth.maxCnyPerWindow} (the override wins)`);

  // (a) is the shipped production state: nothing named a cap, so there ISN'T one — not a fallback.
  assert.equal(fromNothing.maxCnyPerWindow, undefined);
  assert.equal(fromNothing.invalid, null, 'saying nothing is not a misconfiguration');
  assert.equal(fromOverride.maxCnyPerWindow, 0.05);
  assert.equal(fromEnv.maxCnyPerWindow, 0.02);
  // (d) the override is the authority for its run — the diagnosis route's 0.05 must not be
  // overridden BY the deployment's own variable.
  assert.equal(fromBoth.maxCnyPerWindow, 0.05);
  assert.notEqual(fromBoth.maxCnyPerWindow, fromEnv.maxCnyPerWindow, 'if these matched, (d) would be vacuous');
  // Purity, stated as a reading: the same arguments give the same answer, and the env is not
  // consulted for anything but this ONE variable.
  assert.deepEqual(resolveSpendWindowLimit({}, undefined), fromNothing);
  assert.equal(resolveSpendWindowLimit({ SOME_OTHER_VAR: '0.02' }, undefined).maxCnyPerWindow, undefined);
});

test('AC2 a mistyped window cap is refused AND reported, never silently turned into "no cap"', () => {
  for (const raw of ['abc', '0', '-1', '  ']) {
    const resolution = resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: raw }, undefined);
    const report = describeSpendWindowLimit(resolution);
    console.log(
      `AC2 env=${JSON.stringify(raw)} => maxCnyPerWindow=${resolution.maxCnyPerWindow} invalid=${JSON.stringify(resolution.invalid)} report=${JSON.stringify(report)}`,
    );
    assert.equal(resolution.maxCnyPerWindow, undefined, `${JSON.stringify(raw)} must not become a cap`);
    assert.ok(
      resolution.invalid !== null && resolution.invalid.length > 0,
      `${JSON.stringify(raw)} was refused, so the resolution must carry a printable report`,
    );
    assert.ok(report !== null && report.length > 0, 'describeSpendWindowLimit must render that report');
    assert.match(report, /spend window limit/);
  }
  // WHY the reporting matters, made executable: `Number('abc')` is NaN and a comparison against NaN
  // is false for EVERY spend, so an unvalidated typo produces a guard that can never fire — the same
  // behaviour as a deliberately-unset cap, with nothing in the log to tell them apart.
  assert.equal(Number('abc') > 0.015, false, 'NaN compares false: a typo would silently disarm the guard');
  assert.equal(0.5 > Number('abc'), false, 'and it does so on the wrong side too');
  // A refused override does not silently fall through to the environment either: substituting one cap
  // for another would hide the misconfiguration.
  const refusedOverride = resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' }, 0);
  console.log(`AC2 override=0 with env={'0.02'} => maxCnyPerWindow=${refusedOverride.maxCnyPerWindow} invalid=${JSON.stringify(refusedOverride.invalid)}`);
  assert.equal(refusedOverride.maxCnyPerWindow, undefined);
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

test('AC3 the assembly point carries no default window cap, calls the resolver exactly once, and leaves the diagnosis route and the total opt-in alone', () => {
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
  const overridePlumbed = /\bresolveSpendWindowLimit\(\s*process\.env\s*,\s*input\.spendWindowLimitCny\s*\)/.test(source);
  const barrelImport = source
    .split('\n')
    .find((line) => line.includes("from './modules/voice-realtime/index.js'"));
  const diagnoseLimit = /spendWindowLimitCny:\s*([\d.]+)/.exec(source)?.[1];
  // `maxCnyTotal` appears exactly once, inside the `...(process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION
  // ? { maxCnyTotal: … } : {})` spread — i.e. still reachable only when that variable is set.
  const totalMentions = (spendGuard.match(/maxCnyTotal/g) ?? []).length;
  const totalOptIn = /\.\.\.\(\s*process\.env\.VOICE_REALTIME_MAX_CNY_PER_CONNECTION\b[\s\S]*?maxCnyTotal/.test(spendGuard) && totalMentions === 1;

  console.log(
    `AC3 literalGone=${literalGone} resolverCalls=${resolverCalls} diagnoseLimit=${diagnoseLimit} totalOptIn=${totalOptIn}`,
  );
  console.log(
    `AC3 (extras) literalGoneFileWide=${literalGoneFileWide} resolverMentions=${resolverMentions} overridePlumbed=${overridePlumbed} barrelImport=${barrelImport?.includes('resolveSpendWindowLimit') === true} totalMentions=${totalMentions}`,
  );

  // (a) the removed production default cannot come back through the assembled guard.
  assert.ok(literalGone, 'the spendGuard literal must not carry the removed ¥0.015 default');
  assert.ok(literalGoneFileWide, 'and nothing else in server/index.ts should carry it either');
  // (b) exactly ONE call site, and it is the assembly point's, reading the environment and the
  // route's override — resolved once, not per connection.
  assert.equal(resolverCalls, 1);
  assert.ok(overridePlumbed, 'the resolver must be called with (process.env, input.spendWindowLimitCny)');
  assert.ok(resolverMentions >= 2, 'the single call must also be imported');
  assert.ok(barrelImport?.includes('resolveSpendWindowLimit') === true, 'and imported through the module barrel');
  // (c) the HTTP diagnosis route's own window is untouched.
  assert.equal(diagnoseLimit, '0.05');
  // (d) the whole-connection total is still an explicit opt-in.
  assert.ok(totalOptIn, 'maxCnyTotal must stay gated on VOICE_REALTIME_MAX_CNY_PER_CONNECTION');
});

test('AC4 with NO window cap the same runaway string is not ended — and with one it still is', async () => {
  // The observed runaway string: five ~5.6k-token responses (the loop's own shape, one every 0.65 s).
  const perResponse = estimateRealtimeCostCny(usage(5_600, 100, 30));
  const total = perResponse * 5;
  console.log(
    `AC4 Σcost of usage(5600,100,30) × 5 = ¥${total.toFixed(4)} (¥${perResponse.toFixed(4)} each), vs the removed default ¥0.015`,
  );
  assert.ok(total > 0.015, 'the string has to exceed the removed default or the positive control proves nothing');

  // (i) NO `maxCnyPerWindow` key at all — the shape the production path now assembles.
  let seen = 0;
  const uncapped = build({ windowMs: 30_000 }, (observation) => {
    if (observation.direction === 'received' && (observation.wire as { type?: string }).type === 'response.done') seen += 1;
  });
  await waitFor(() => opened(uncapped.socket));
  for (let index = 0; index < 5; index += 1) responseDone(uncapped.upstream, usage(5_600, 100, 30), `u${index}`);
  // A POSITIVE signal that all five were charged, rather than a blind sleep: the transport observes
  // each received frame immediately before it charges the guard, so 5 seen + a tick means 5 charged.
  await waitFor(() => seen === 5);
  await sleep(50);
  const uncappedTrip = uncapped.socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT');
  console.log(
    `AC4 (i) spendGuard={windowMs:30000} (no maxCnyPerWindow): charged=${seen}, SPEND_LIMIT=${uncappedTrip !== undefined}, readyState=${uncapped.socket.readyState} (OPEN=${WS.OPEN} CLOSED=${WS.CLOSED})`,
  );
  assert.equal(uncappedTrip, undefined, 'no configured cap means no SPEND_LIMIT frame');
  assert.notEqual(uncapped.socket.readyState, WS.CLOSED, 'and the connection stays open');
  uncapped.socket.close();

  // (ii) Positive control — the SAME string under a cap that is below its total must end the session,
  // so (i) is "the default is gone", not "the guard is broken". The contrast arm takes its number from
  // the resolver (no hand-copied literal that could drift): ¥0.015 was the removed production default.
  const removedDefault = resolveSpendWindowLimit({}, 0.015).maxCnyPerWindow ?? 0;
  assert.equal(removedDefault, 0.015, 'the contrast arm must be the literal the production path used to carry');
  console.log(
    `AC4 (ii) contrast arm uses the removed default ¥${removedDefault} (AC1(d)'s override resolves to ¥${resolveSpendWindowLimit({ [VOICE_REALTIME_MAX_CNY_PER_30S_ENV]: '0.02' }, 0.05).maxCnyPerWindow}, which is ABOVE this string's ¥${total.toFixed(4)} and so cannot serve as the contrast arm)`,
  );
  const capped = build({ windowMs: 30_000, maxCnyPerWindow: removedDefault });
  await waitFor(() => opened(capped.socket));
  for (let index = 0; index < 5; index += 1) responseDone(capped.upstream, usage(5_600, 100, 30), `c${index}`);
  await waitFor(() => capped.socket.outbound.some((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT'));
  const cappedTrip = capped.socket.outbound.find((frame) => frame.type === 'error' && frame.code === 'SPEND_LIMIT');
  assert.ok(cappedTrip && cappedTrip.type === 'error');
  const spentAtTrip = Number(/used about ¥([\d.]+)/.exec(cappedTrip.message)?.[1]);
  console.log(
    `AC4 (ii) same string with maxCnyPerWindow=¥${removedDefault}: SPEND_LIMIT cny=¥${spentAtTrip.toFixed(4)} message=${JSON.stringify(cappedTrip.message)}`,
  );
  assert.ok(Number.isFinite(spentAtTrip), 'the frame must name the spend that tripped it');
  assert.ok(spentAtTrip > removedDefault && spentAtTrip <= total, 'it tripped inside the string, part-way through');
  await waitFor(() => capped.socket.readyState === WS.CLOSED);
});
