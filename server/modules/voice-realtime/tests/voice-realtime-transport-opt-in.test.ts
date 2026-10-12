/**
 * The per-connection transport opt-in — GOAL-044 / AC-374 (decision doc §12.7).
 *
 * WHAT THIS FILE IS FOR. Until this task the transport was a DEPLOYMENT switch: `VOICE_REALTIME_MODE`
 * was read once per process, so a browser could not take the continuous wire without a server change
 * affecting everyone. The opt-in adds the other axis — ONE browser asks, on ONE connection, for the
 * transport it wants, and that choice overrides the deployment for that connection alone.
 *
 * FOUR FACTS, and each is checked where it actually runs:
 *
 *   · PARSING — `parseVoiceRealtimeTransport` reads the connection URL's value, and every value that
 *     is not a known transport reads as "asked for nothing" so a typo can only fall back, never blank
 *     the relay.
 *   · OVERRIDING — a choice WINS over the resolved environment for the connection it was made on.
 *   · THE HANDSHAKE — a connection wired with `transport: 'continuous'` is answered with silence and
 *     the log NAMES the reason (this connection asked), told apart from the deployment's own switch.
 *   · turn_detection — the continuous wire's `session.update` ALWAYS carries an explicit, valid
 *     `turn_detection`. This is the invariant the opt-in rests on: with the browser no longer cutting
 *     utterances, the endpoint's own VAD is the only thing that can, so it may never be omitted and
 *     may never be `null`. The last block proves the assertion is not vacuous by running it against
 *     the two shapes it must reject (omitted and `null`).
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-transport-opt-in.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  DEFAULT_SESSION_DEFAULTS,
  SEGMENTED_RELAY_PROTOCOL,
  VOICE_REALTIME_MODE_ENV,
  VOICE_REALTIME_TRANSPORT_PARAM,
  VOICE_REALTIME_TURN_DETECTION_ENV,
  applyVoiceRealtimeTransport,
  parseVoiceRealtimeTransport,
  resolveTurnDetection,
  resolveVoiceRealtimeMode,
  toDashscopeFrames,
  type RealtimeClientMessage,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
  type VoiceRealtimeTransport,
} from '../index.js';
import { handleVoiceRealtimeConnection } from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The composition root whose per-connection wiring this file pins as source text. */
const SERVER_INDEX = path.resolve(HERE, '../../../index.ts');

/** One macrotask tick: lets a `void`-started async step settle before a synchronous reading. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── the fake browser socket (the same minimal surface the segmented-default file drives) ─────────

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

  receive(frame: VoiceRealtimeInboundFrame | Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

type Handler = typeof handleVoiceRealtimeConnection;

/**
 * Wires one proxy connection with an explicit per-connection `transport` (or none), and NO
 * `segmentedRelay` seam — so the connection resolves the deployment's mode from the environment
 * itself, exactly as a deployment that set nothing would.
 */
function wire(transport?: VoiceRealtimeTransport): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  logs: string[];
} {
  const socket = new FakeBrowserSocket();
  const fakeTransport = createFakeTransport();
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => fakeTransport,
    createExecutor: () => ({ session_send: async () => ({ accepted: true }) }),
    instructions: 'test instructions',
    log: (line) => logs.push(line),
    ...(transport === undefined ? {} : { transport }),
  };
  handleVoiceRealtimeConnection(socket as unknown as Parameters<Handler>[0], 'session-under-test', seams);
  return { socket, transport: fakeTransport, logs };
}

/** Waits until one connection is open and usable — the upstream handshake done AND the browser told. */
async function openSocket(socket: FakeBrowserSocket, transport: FakeTransport): Promise<void> {
  await waitFor(() => transport.openCalls >= 1);
  await waitFor(() => socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
}

/** Runs `body` with `VOICE_REALTIME_MODE` set to `value` (or deleted, for `null`), restoring it after. */
async function withVoiceMode<T>(value: string | null, body: () => T | Promise<T>): Promise<T> {
  const previous = process.env[VOICE_REALTIME_MODE_ENV];
  if (value === null) {
    delete process.env[VOICE_REALTIME_MODE_ENV];
  } else {
    process.env[VOICE_REALTIME_MODE_ENV] = value;
  }
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env[VOICE_REALTIME_MODE_ENV];
    } else {
      process.env[VOICE_REALTIME_MODE_ENV] = previous;
    }
  }
}

/** The `ready` frames the server sent, in order. */
const readyFrames = (socket: FakeBrowserSocket): VoiceRealtimeOutboundFrame[] =>
  socket.outbound.filter((frame) => frame.type === 'ready');

// ── parsing and overriding: the pure half ───────────────────────────────────────────────────────

test('AC1 parse: only the two known transports are a choice; every other value asks for nothing', () => {
  assert.equal(parseVoiceRealtimeTransport('continuous'), 'continuous');
  assert.equal(parseVoiceRealtimeTransport('segmented'), 'segmented');
  assert.equal(parseVoiceRealtimeTransport('  continuous  '), 'continuous', 'surrounding space is tolerated');
  // "Asked for nothing" — absent, empty, and every unknown spelling. None of these may silently
  // disable the relay; each falls back to the deployment's own resolution instead.
  for (const value of [null, undefined, '', '   ', 'banana', 'CONTINUOUS', 'segmented-v2']) {
    assert.equal(parseVoiceRealtimeTransport(value), null, `${JSON.stringify(value)} must be "no choice"`);
  }
});

test('AC1 override: a per-connection choice wins over the resolved environment', () => {
  // The environment resolves first, and its own answer is untouched by applying (or not applying) a
  // choice — so a deployment's resolution is still readable for the connections that carry none.
  const env = resolveVoiceRealtimeMode({ [VOICE_REALTIME_MODE_ENV]: 'segmented' });
  assert.deepEqual(applyVoiceRealtimeTransport(env, null), { mode: 'segmented', invalid: null }, 'no choice == the environment');
  assert.deepEqual(
    applyVoiceRealtimeTransport(env, 'continuous'),
    { mode: 'continuous', invalid: null },
    'a choice overrides a segmented deployment for its own connection',
  );

  // And the other way: a browser may ask for the segmented relay ON a deployment defaulting to
  // continuous — which is the rollback path for a deployment that adopted continuous process-wide.
  const continuousEnv = resolveVoiceRealtimeMode({ [VOICE_REALTIME_MODE_ENV]: 'continuous' });
  assert.deepEqual(applyVoiceRealtimeTransport(continuousEnv, 'segmented'), { mode: 'segmented', invalid: null });

  // A refused environment value AND a choice: the connection follows the choice, and the environment's
  // note is dropped with it, because that value decided nothing for this connection.
  const typo = resolveVoiceRealtimeMode({ [VOICE_REALTIME_MODE_ENV]: 'banana' });
  assert.equal(typo.invalid, 'banana');
  assert.deepEqual(applyVoiceRealtimeTransport(typo, 'continuous'), { mode: 'continuous', invalid: null });
});

// ── the handshake: the choice reaches the wire ──────────────────────────────────────────────────

test('AC1 handshake: a connection that asked for continuous is answered with silence, and the log says why', async () => {
  await withVoiceMode(null, async () => {
    const { socket, transport, logs } = wire('continuous');
    await openSocket(socket, transport);
    socket.receive({ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL });
    await settle();

    assert.deepEqual(readyFrames(socket), [], 'a continuous connection must not declare the relay it asked not to have');
    // The reason is NAMED, and it is the per-connection one — not the deployment's variable, which is
    // unset here and would send an operator looking at a correct configuration.
    assert.ok(
      logs.some((line) => line.startsWith('hello: not declaring') && line.includes('continuous transport requested for this connection')),
      `the per-connection reason must be logged, got: ${JSON.stringify(logs)}`,
    );
  });
});

test('AC1 handshake: a browser may ask for segmented on a deployment defaulting to continuous', async () => {
  await withVoiceMode('continuous', async () => {
    const { socket, transport } = wire('segmented');
    await openSocket(socket, transport);
    socket.receive({ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL });
    await waitFor(() => readyFrames(socket).length === 1);

    assert.deepEqual(readyFrames(socket), [{ type: 'ready', protocol: SEGMENTED_RELAY_PROTOCOL }]);
  });
});

test('AC3 unselected: a connection wired with NO transport follows the environment, byte for byte', async () => {
  await withVoiceMode(null, async () => {
    const { socket, transport, logs } = wire();
    await openSocket(socket, transport);
    socket.receive({ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL });
    await waitFor(() => readyFrames(socket).length === 1);

    assert.deepEqual(readyFrames(socket), [{ type: 'ready', protocol: SEGMENTED_RELAY_PROTOCOL }]);
    assert.equal(
      logs.some((line) => line.includes('continuous transport requested for this connection')),
      false,
      'a connection that asked for nothing must not be reported as having asked',
    );
  });
});

// ── turn_detection: the invariant the continuous wire rests on ───────────────────────────────────

/** Whether one outbound `session.update` frame carries an explicit, valid `turn_detection`. */
function hasExplicitTurnDetection(frame: { session?: Record<string, unknown> }): boolean {
  const detection = frame.session?.turn_detection;
  if (typeof detection !== 'object' || detection === null) return false;
  const type = (detection as { type?: unknown }).type;
  return type === 'server_vad' || type === 'semantic_vad';
}

/** The single `session.update` frame the transport emits for one browser `session.update`. */
function sessionUpdateFrame(defaults: Readonly<Record<string, unknown>>): { session?: Record<string, unknown> } {
  const message: RealtimeClientMessage = { type: 'session.update', session: { instructions: 'x', tools: [] } };
  const [frame] = toDashscopeFrames(message, defaults);
  assert.ok(frame, 'the transport must emit a frame for a session.update');
  return frame as { session?: Record<string, unknown> };
}

test('AC1 turn_detection: the continuous wire keeps an explicit, valid detector on every session.update', () => {
  // The session body a continuous connection opens with. With the browser no longer cutting
  // utterances, the endpoint's own detector is the only thing that can, so it must be on the wire:
  // an explicit object naming a detector type, never omitted, never `null`.
  assert.ok(
    hasExplicitTurnDetection(sessionUpdateFrame(DEFAULT_SESSION_DEFAULTS)),
    'the shipped session defaults must put an explicit turn_detection on the wire',
  );

  // AND THE RESOLUTION THE ASSEMBLY POINT SPLICES IN IS NEVER NULL — for the environment that spells
  // nothing (a deployment that merely opted in) and for one that names `semantic_vad`. This is the
  // half that rules out the two forbidden shapes at their source (decision doc P-1: omitted ==
  // detector on by default, `null` == no trigger at all): `resolveTurnDetection` is total.
  const envs: Array<{ label: string; env: Record<string, string | undefined> }> = [
    { label: 'unconfigured', env: {} },
    { label: 'semantic_vad', env: { [VOICE_REALTIME_TURN_DETECTION_ENV]: 'semantic_vad' } },
  ];
  for (const { label, env } of envs) {
    const { turnDetection } = resolveTurnDetection(env);
    assert.ok(
      turnDetection !== null && (turnDetection.type === 'server_vad' || turnDetection.type === 'semantic_vad'),
      `${label}: the resolved detector must be an explicit valid one, got ${JSON.stringify(turnDetection)}`,
    );
  }
});

test('AC1 false form: the same check REJECTS a session whose turn_detection is omitted or null', () => {
  // The false form of the assertion above. If the continuous session ever shipped without a detector —
  // the exact defect this criterion exists to catch — the check must go false rather than pass.
  const withoutKey: Record<string, unknown> = { ...DEFAULT_SESSION_DEFAULTS };
  delete withoutKey.turn_detection;
  assert.equal(
    hasExplicitTurnDetection(sessionUpdateFrame(withoutKey)),
    false,
    'an OMITTED turn_detection must be rejected',
  );

  const nulled: Record<string, unknown> = { ...DEFAULT_SESSION_DEFAULTS, turn_detection: null };
  assert.equal(
    hasExplicitTurnDetection(sessionUpdateFrame(nulled)),
    false,
    'a NULL turn_detection must be rejected',
  );
});

// ── wiring: the composition root resolves the choice per connection ──────────────────────────────

test('AC1 wiring: server/index.ts reads the transport off the connection URL and resolves it per connection', () => {
  const source = readFileSync(SERVER_INDEX, 'utf8');

  // The parameter is read from the URL of the SAME connection the seams are built for.
  assert.match(
    source,
    /url\.searchParams\.get\(VOICE_REALTIME_TRANSPORT_PARAM\)/,
    'the handler must read the transport from the connection URL',
  );
  // It is parsed and applied to the environment resolution inside the seams builder — the assembly
  // point — so the choice reaches `segmentedRelay` and the proxy before the connection opens.
  assert.match(source, /parseVoiceRealtimeTransport\(/, 'the raw value must be parsed, not used raw');
  assert.match(
    source,
    /applyVoiceRealtimeTransport\(envRelayMode, transportChoice\)/,
    'the choice must be applied over the resolved environment in the seams builder',
  );
  // And it is handed to the seams, so the handshake branch can name it.
  assert.match(source, /transport: transportChoice/, 'the seams builder must be given the per-connection choice');
});
