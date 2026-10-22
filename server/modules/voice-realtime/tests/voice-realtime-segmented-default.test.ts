/**
 * The relay switch — SPEC `docs/proposals/voice-realtime-segmented-relay-SPEC.md` §分期 P4,
 * GOAL-034 / AC-322; default flipped by the 2026-10-13 experience-first ruling, GOAL-044 / AC-374.
 *
 * WHAT THIS FILE IS FOR. Until P4 the server could RECEIVE the segmented frames
 * (`voice-realtime-segmented-protocol.test.ts` proves that) but never ANSWERED the browser's
 * `hello`, so a real page stayed on continuous frames and the segmented path existed only in tests.
 * P4 then made segmented the default. The 2026-10-13 ruling reversed THAT: segmentation is now the
 * OPT-OUT, and a connection that asks for nothing stays on continuous frames. This file pins the
 * current shape: the connection must stay silent under the `continuous` default, must declare
 * `segmented-v1` under the `segmented` escape hatch, and must fall back to the default (now
 * continuous) on a misconfigured value.
 *
 * WHY THE SEAMS ARE PASSED NOTHING. The rollout switch has one production reader — the pure
 * `resolveVoiceRealtimeMode` — and one production caller, `buildVoiceRealtimeSeams` in `server/index.ts`.
 * `server/index.ts` cannot be imported by a test (it calls `startServer()` at module scope and would
 * dial the database and the listening socket), so the repo's established reading of it is SOURCE TEXT
 * (`mcp-gateway-wiring.test.ts` does exactly this). This file does both halves, and neither re-declares
 * the default:
 *
 *   · BEHAVIOUR — `wire()` passes NO `segmentedRelay` seam, so the connection resolves the mode itself
 *     from the environment, exactly as a deployment that set nothing would. The default under test is
 *     therefore the shipped one, not a value the test typed in.
 *   · WIRING — a source-text pin asserts `server/index.ts` calls the same resolver at the assembly
 *     point and hands the answer to the seams, so "the composition root decides" is a checked fact and
 *     not a convention.
 *
 * WHAT THE FALSE FORM PINS. The last block writes a mutated copy of the shipping proxy BESIDE it
 * (`__criterion-falsify-<label>-<pid>.ts`, excluded from `server/tsconfig.json` by name, removed in a
 * `finally`) whose `hello` branch is short-circuited to `if (false)`: declaring the relay under the
 * EXPLICIT segmented escape hatch must still redden when the declare branch is cut. The false form
 * runs under `VOICE_REALTIME_MODE=segmented` rather than the (now silent) default, because a case that
 * never declares in the first place cannot show a mutation that stops it from declaring.
 *
 * THE BROWSER HALF IS THE REAL MODULE. AC2 requires the frames to come from the browser's own protocol
 * module rather than hand-built fixtures, so the client side of both end-to-end cases is loaded from
 * `src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts`. It is loaded through a dynamic
 * file-URL import (a structural cast), not a static one: `server/tsconfig.json` excludes `../src`, so
 * a static specifier is a type error, while the RUNTIME module only needs `btoa` and is otherwise
 * dependency-free (its one import is type-only and erased).
 *
 * Run with this repo's TS-ESM test runner (source imports use `.js` specifiers that resolve to
 * same-named `.ts` files):
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  SEGMENTED_RELAY_PROTOCOL,
  VOICE_REALTIME_MODE_ENV,
  resolveVoiceRealtimeMode,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../index.js';
import { handleVoiceRealtimeConnection } from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The shipping proxy module — the file the false form loads. */
const SHIPPING_PROXY_MODULE = path.resolve(HERE, '../voice-realtime-ws-proxy.service.ts');
/**
 * The sibling file the `hello` branch now lives in.
 *
 * The frame bodies moved out of the proxy into the inbound-frame registry's handler
 * set (`gap-voice-realtime-ws-proxy-frame-extension-point`), so a false form mutates
 * the handler and rewires the proxy copy to import that mutant. The criterion is the
 * same reading — a proxy that never declares must fail the escape hatch.
 */
const SHIPPING_HANDLERS_MODULE = path.resolve(HERE, '../voice-realtime-frame-handlers.ts');
/** The proxy's single import of the handler set, retargeted so the mutant proxy drives the mutant handlers. */
const HANDLERS_IMPORT_SPECIFIER = "'./voice-realtime-frame-handlers.js'";
/** The browser's protocol module: the AC2 client half, loaded as a real module. */
const BROWSER_PROTOCOL_MODULE = path.resolve(HERE, '../../../../src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts');
/** The composition root whose wiring AC1 pins as source text. */
const SERVER_INDEX = path.resolve(HERE, '../../../index.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
const ownCopy = (label: string): string => path.resolve(HERE, `../${TEMP_PREFIX}${label}-${process.pid}.ts`);

/** Bytes in one 100 ms mono 16-bit frame at 16 kHz — the capture cadence the real page uses. */
const PCM_RATE = 16_000;
const FRAME_BYTES = ((PCM_RATE * 100) / 1000) * 2;

/** One macrotask tick: lets a `void`-started async step settle before a synchronous reading. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── the fake browser socket ───────────────────────────────────────────────────────────────────

/** The minimal `ws.WebSocket` surface the proxy uses, driven over an EventEmitter. */
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

  /** Delivers one inbound frame, as the real socket's `'message'` event would. */
  receive(frame: VoiceRealtimeInboundFrame | Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }

  /** Delivers one inbound frame as the EXACT bytes a real module produced, with no re-encoding. */
  receiveRaw(raw: string): void {
    this.emit('message', Buffer.from(raw, 'utf8'));
  }
}

type Handler = typeof handleVoiceRealtimeConnection;

/**
 * Wires one proxy connection, passing NO `segmentedRelay` seam — so the connection resolves the
 * rollout mode from the environment itself, which is what makes the default under test the shipped one.
 */
function wire(handle: Handler = handleVoiceRealtimeConnection): {
  socket: FakeBrowserSocket;
  transport: FakeTransport;
  logs: string[];
} {
  const socket = new FakeBrowserSocket();
  const transport = createFakeTransport();
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => transport,
    createExecutor: () => ({ session_send: async () => ({ accepted: true }) }),
    instructions: 'test instructions',
    log: (line) => logs.push(line),
  };
  handle(socket as unknown as Parameters<Handler>[0], 'session-under-test', seams);
  return { socket, transport, logs };
}

/**
 * Waits until one connection is open and usable — the upstream handshake done AND the browser told
 * so. Only then is an inbound frame handled by a live connection rather than by a bridge still
 * dialing (the `@` segment frames are dropped until `open`).
 */
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

/** Seconds of audio actually handed upstream, from the base64 appends' decoded length. */
function upstreamSeconds(transport: FakeTransport): number {
  let bytes = 0;
  for (const message of transport.sent) {
    if (message.type === 'input_audio_buffer.append') {
      bytes += Buffer.from(message.audio, 'base64').length;
    }
  }
  return bytes / 2 / PCM_RATE;
}

/** The base64 payloads of every appended frame, in order. */
const appendedAudio = (transport: FakeTransport): string[] =>
  transport.sent.flatMap((message) => (message.type === 'input_audio_buffer.append' ? [message.audio] : []));

// ── the browser's own protocol module, loaded as a real module ────────────────────────────────

/** The slice of `voiceRealtimeProtocol.ts` this suite drives — the browser's wire vocabulary. */
type BrowserProtocolModule = {
  SEGMENTED_RELAY_PROTOCOL: string;
  segmentedRelayOffer(): { type: 'hello'; protocol: string };
  declaresSegmentedRelay(frame: { type?: string; protocol?: string }): boolean;
  segmentFrames(
    segment: { wav: Uint8Array; startSec: number; endSec: number; durationSec?: number; reason?: string },
    seq: number,
    startedAtMs: number,
  ): string[];
};

let cachedBrowserModule: BrowserProtocolModule | null = null;

/**
 * Loads the browser protocol module once. A dynamic file-URL import keeps the `server/` program free
 * of a static `../src` specifier (which `server/tsconfig.json` excludes), and the cast is structural
 * because the two halves deliberately do not share a type.
 */
async function browserProtocol(): Promise<BrowserProtocolModule> {
  if (cachedBrowserModule === null) {
    cachedBrowserModule = (await import(pathToFileURL(BROWSER_PROTOCOL_MODULE).href)) as BrowserProtocolModule;
  }
  return cachedBrowserModule;
}

/** One segment the browser's own `segmentFrames` will cut: a 44-byte WAV header plus `seconds` of PCM. */
function segmentOf(seconds: number, fill: number): {
  wav: Uint8Array;
  startSec: number;
  endSec: number;
  durationSec: number;
  reason: string;
} {
  const wav = Buffer.concat([Buffer.alloc(44), Buffer.alloc(Math.round(seconds * PCM_RATE) * 2, fill)]);
  return { wav, startSec: 0, endSec: seconds, durationSec: seconds, reason: 'gap' };
}

// ── AC1: the default, the fallback, the misconfiguration, and the wiring ─────────────────────

test('AC1 default: with VOICE_REALTIME_MODE unset the connection answers the offer with silence', async () => {
  await withVoiceMode(null, async () => {
    // The default is READ from the resolver `server/index.ts` calls, not typed in here.
    assert.deepEqual(resolveVoiceRealtimeMode(process.env), { mode: 'continuous', invalid: null });

    const { socket, transport, logs } = wire();
    await openSocket(socket, transport);
    socket.receive({ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL });
    await settle();

    assert.deepEqual(readyFrames(socket), [], 'the default must not declare the protocol');
    assert.ok(
      logs.some((line) => line.startsWith('hello: not declaring')),
      `the default must say it stayed continuous, logged: ${JSON.stringify(logs)}`,
    );
  });
});

test('AC1 escape hatch: VOICE_REALTIME_MODE=segmented answers the offer with ready{segmented-v1}', async () => {
  await withVoiceMode('segmented', async () => {
    assert.deepEqual(resolveVoiceRealtimeMode(process.env), { mode: 'segmented', invalid: null });

    const { socket, transport } = wire();
    await openSocket(socket, transport);
    socket.receive({ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL });
    await waitFor(() => readyFrames(socket).length === 1);

    assert.deepEqual(readyFrames(socket), [{ type: 'ready', protocol: SEGMENTED_RELAY_PROTOCOL }]);
    // A second offer is answered again (idempotent), never more than one `ready` per offer.
    socket.receive({ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL });
    await waitFor(() => readyFrames(socket).length === 2);
    assert.equal(socket.outbound.filter((frame) => frame.type === 'ready').length, 2);
  });
});

test('AC1 invalid: an unknown VOICE_REALTIME_MODE resolves to the default and is reported', async () => {
  await withVoiceMode('banana', async () => {
    const resolution = resolveVoiceRealtimeMode(process.env);
    assert.equal(resolution.mode, 'continuous', 'an unknown value must resolve to the default, not enable the relay');
    assert.equal(resolution.invalid, 'banana');

    const { socket, transport, logs } = wire();
    await openSocket(socket, transport);
    socket.receive({ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL });
    await settle();

    assert.deepEqual(readyFrames(socket), [], 'a misconfigured value must fall back to the default, not declare');
    assert.ok(
      logs.some((line) => line.includes('"banana"') && line.includes('not a known mode')),
      `a misconfigured value must be logged, logged: ${JSON.stringify(logs)}`,
    );
  });
});

test('AC1 token: a protocol this proxy does not speak is answered with silence even when the relay is on', async () => {
  await withVoiceMode('segmented', async () => {
    const { socket, transport } = wire();
    await openSocket(socket, transport);
    socket.receive({ type: 'hello', protocol: 'segmented-v2' });
    await settle();
    assert.deepEqual(readyFrames(socket), [], 'the server echoes only the token it implements');
  });
});

test('AC1 wiring: server/index.ts resolves the mode at the assembly point and passes the seam', () => {
  const source = readFileSync(SERVER_INDEX, 'utf8');
  // The resolver is imported from the module barrel — not re-implemented in index.ts.
  assert.match(source, /from '\.\/modules\/voice-realtime\/index\.js'/, 'index.ts must reach the module through its barrel');
  assert.match(source, /resolveVoiceRealtimeMode\(process\.env\)/, 'the mode must be resolved from the environment');
  assert.match(
    source,
    /segmentedRelay:\s*relayMode\.mode === 'segmented'/,
    'the resolved mode must be handed to the seams as `segmentedRelay`',
  );
  // And the resolution lives INSIDE buildVoiceRealtimeSeams — the assembly point — not at module scope,
  // where it would be read once at boot instead of at each connection's assembly.
  const fnStart = source.indexOf('const buildVoiceRealtimeSeams');
  const fnEnd = source.indexOf('function resolveIdleRotateMs');
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'the assembly function must be findable in index.ts');
  const body = source.slice(fnStart, fnEnd);
  assert.match(body, /resolveVoiceRealtimeMode\(process\.env\)/, 'the resolution must sit in the seams builder');
  assert.match(body, /segmentedRelay: relayMode\.mode === 'segmented'/, 'the seam must be set in the seams builder');
});

test('AC1 token: the server and the browser spell the relay token identically', () => {
  const source = readFileSync(BROWSER_PROTOCOL_MODULE, 'utf8');
  const match = /export const SEGMENTED_RELAY_PROTOCOL = '([^']+)'/.exec(source);
  assert.ok(match, 'the browser module must export SEGMENTED_RELAY_PROTOCOL as a single-quoted literal');
  assert.equal(
    match[1],
    SEGMENTED_RELAY_PROTOCOL,
    'a divergent token breaks the handshake silently, so the two literals must be equal',
  );
});

// ── AC2: the end-to-end walk, driven by the browser's own protocol module ─────────────────────

test('AC2 escape hatch: the browser protocol module walks the segmented uplink and sends <= 25% of the recording', async () => {
  await withVoiceMode('segmented', async () => {
    const browser = await browserProtocol();
    const { socket, transport } = wire();
    await openSocket(socket, transport);

    // 1. The page makes its REAL offer.
    socket.receiveRaw(JSON.stringify(browser.segmentedRelayOffer()));
    await waitFor(() => socket.outbound.some((frame) => frame.type === 'ready'));

    // 2. It switches ONLY because a real server frame declared the protocol — the browser's own predicate.
    const declaration = socket.outbound.find((frame) => frame.type === 'ready');
    assert.ok(declaration, 'the server must have answered');
    assert.equal(
      browser.declaresSegmentedRelay(declaration),
      true,
      'the page switches on this frame and on nothing else',
    );

    // 3. Four sentences over a 200 s recording, serialized by the browser's own `segmentFrames`.
    const sentences = 4;
    const sentenceSeconds = 4;
    for (let seq = 0; seq < sentences; seq += 1) {
      for (const raw of browser.segmentFrames(segmentOf(sentenceSeconds, 0x11 + seq), seq, seq * 100)) {
        socket.receiveRaw(raw);
      }
    }

    const seconds = upstreamSeconds(transport);
    assert.equal(seconds, sentences * sentenceSeconds, 'manual mode forwards exactly the speech');
    assert.ok(
      seconds <= 200 * 0.25,
      `upstream received ${seconds.toFixed(1)} s of a 200 s recording (must be <= 25%)`,
    );
    // The frames really were segment-shaped: each `audio` frame carried a `seq`.
    assert.equal(
      transport.sent.filter((message) => message.type === 'input_audio_buffer.append').length,
      sentences,
      'one appended frame per sentence — the whole segment, in one frame',
    );
  });
});

test('AC2 default: under the unset default the same offer is answered with silence and the wire is frame for frame', async () => {
  await withVoiceMode(null, async () => {
    const browser = await browserProtocol();
    const { socket, transport } = wire();
    await openSocket(socket, transport);

    socket.receiveRaw(JSON.stringify(browser.segmentedRelayOffer()));
    await settle();
    assert.equal(
      socket.outbound.some((frame) => frame.type === 'ready'),
      false,
      'no declaration, so the page never switches — the continuous wire stands',
    );

    // The continuous path, exactly as a non-segmenting page sends it: every frame, no `seq`.
    const frames = Array.from({ length: 2000 }, (_, index) => Buffer.alloc(FRAME_BYTES, index % 251).toString('base64'));
    for (const audio of frames) {
      socket.receive({ type: 'audio', audio });
    }
    assert.deepEqual(appendedAudio(transport), frames, 'every legacy frame reaches the upstream, in order');
    assert.equal(upstreamSeconds(transport), 200, 'the continuous path still streams the whole recording');
    assert.equal(
      transport.sent.filter((message) => message.type === 'input_audio_buffer.commit').length,
      0,
      'the continuous default never commits a segment',
    );
  });
});

// ── AC6 false form: the default declaration removed must redden the default case ──────────────

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Whether one connection, wired with `handle` under the explicit segmented escape hatch, answers an offer with `ready`. */
async function declares(handle: Handler): Promise<boolean> {
  return withVoiceMode('segmented', async () => {
    const { socket, transport } = wire(handle);
    await openSocket(socket, transport);
    socket.receive({ type: 'hello', protocol: SEGMENTED_RELAY_PROTOCOL });
    await settle();
    return readyFrames(socket).length > 0;
  });
}

test('AC6 false form: refusing to declare makes the escape-hatch case red', async () => {
  const DECLARE_GATE = 'if (context.segmentedRelay && frame.protocol === SEGMENTED_RELAY_PROTOCOL) {';
  const handlersSource = readFileSync(SHIPPING_HANDLERS_MODULE, 'utf8');
  assert.equal(countOccurrences(handlersSource, DECLARE_GATE), 1, 'the declare anchor must occur exactly once');
  const proxySource = readFileSync(SHIPPING_PROXY_MODULE, 'utf8');
  assert.equal(
    countOccurrences(proxySource, HANDLERS_IMPORT_SPECIFIER),
    1,
    'the proxy must import the handler set exactly once, so the mutation copy can retarget it',
  );

  const handlersMutPath = ownCopy('declare-handlers-mut');
  const basePath = ownCopy('declare-base');
  const mutPath = ownCopy('declare-mut');
  try {
    writeFileSync(handlersMutPath, handlersSource.replace(DECLARE_GATE, 'if (false) {'), 'utf8');
    writeFileSync(basePath, proxySource, 'utf8');
    writeFileSync(
      mutPath,
      proxySource.replace(
        HANDLERS_IMPORT_SPECIFIER,
        `'./${path.basename(handlersMutPath, '.ts')}.js'`,
      ),
      'utf8',
    );

    const base = (await import(pathToFileURL(basePath).href)) as { handleVoiceRealtimeConnection: Handler };
    const mutant = (await import(pathToFileURL(mutPath).href)) as { handleVoiceRealtimeConnection: Handler };

    assert.equal(await declares(base.handleVoiceRealtimeConnection), true, 'unmutated: the escape hatch declares');
    assert.equal(await declares(mutant.handleVoiceRealtimeConnection), false, 'never declaring must redden the escape hatch');
  } finally {
    rmSync(handlersMutPath, { force: true });
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

test('AC6: the false form leaves none of this process`s copies behind', () => {
  const moduleDir = path.resolve(HERE, '..');
  const leftovers = readdirSync(moduleDir).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
