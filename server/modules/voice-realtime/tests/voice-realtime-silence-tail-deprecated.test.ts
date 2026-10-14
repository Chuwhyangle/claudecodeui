/**
 * Silence Tail Suppression, RETIRED FROM PRODUCTION — the disconnect, read where it actually binds.
 *
 * WHAT THIS FILE IS FOR. The 2026-10-14 ruling 「STS 已证实无效，取消生产调用」 takes
 * `createSilenceTailGate` off the production path: `server/index.ts`'s assembly point
 * (`buildVoiceRealtimeSeams`) NEVER hands a `silenceTail` seam to the proxy — on any path, for any
 * `VOICE_REALTIME_SILENCE_TAIL` value — so the continuous wire forwards every captured frame exactly
 * as it did before STS existed. The MODULE, its tests and its probe docs are KEPT: they still prove
 * the state machine was behaviourally correct in isolation; only the production call site is gone.
 *
 * FOUR READINGS, each against the fact it pins:
 *
 *   · AC1 — THE SEAM KEY IS GONE FROM THE ASSEMBLY POINT. `buildVoiceRealtimeSeams` is a local,
 *     unexported const in `server/index.ts`, so the composition root is read as SOURCE TEXT (the
 *     repository's established form for this file — see `voice-realtime-transport-opt-in.test.ts`).
 *     The region is sliced from `const buildVoiceRealtimeSeams` to `function resolveIdleRotateMs`,
 *     its locatability is asserted first (so a failed slice is a red, never a vacuous green), and the
 *     `silenceTail:` property KEY must not occur inside it.
 *   · AC2 — THE OLD SWITCH IS REPORTED AS DEPRECATED/IGNORED, AND ONLY WHEN IT IS ON. The deprecation
 *     line sits behind the `silenceTail.enabled` guard in the same region; an unset switch resolves to
 *     `enabled:false` (asserted here against the real resolver), so nothing is logged — silence means
 *     "unconfigured", exactly as before.
 *   · AC3 — THE SWITCH IS BYTE-FOR-BYTE INERT ON THE WIRE. The REAL proxy is driven, over the SAME
 *     fake-transport harness the suppression criterion uses, with a PRODUCTION-SHAPED seam (no
 *     `silenceTail`), once with the switch on and once with it unset: the frames handed to
 *     `bridge.sendAudioFrame` are identical, and equal the browser's own frames. The control — the
 *     SAME harness with the seam actually filled (the pre-disconnect wiring) — DIVERGES, so the
 *     identity reading is one that could have gone the other way.
 *   · AC4 — NEITHER UPLINK GATE CAN BE IN PLAY IN PRODUCTION. With the STS seam never filled (AC1)
 *     and the uplink-VAD seam having no arm point at all in `server/index.ts`, the proxy's
 *     "STS wins over uplinkVad" exclusion branch (`uplinkVadRequested && silenceTail !== null`) can
 *     never run in production. This task does NOT remove that branch — it is read as still present.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts
 *
 * Consumers: the quay worker's AC state for `gap-live-voice-sts-production-disconnect`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  SILENCE_TAIL_ENV,
  resolveSilenceTail,
  type SilenceTailOptions,
} from '../voice-realtime-silence-tail.js';
import { handleVoiceRealtimeConnection } from '../voice-realtime-ws-proxy.service.js';
import type {
  VoiceRealtimeInboundFrame,
  VoiceRealtimeOutboundFrame,
  VoiceRealtimeProxySeams,
} from '../index.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The composition root whose per-connection wiring this file pins as source text. */
const SERVER_INDEX = path.resolve(HERE, '../../../index.ts');
/** The relay whose uplink-gate exclusion branch AC4 reads. */
const WS_PROXY = path.resolve(HERE, '../voice-realtime-ws-proxy.service.ts');

/**
 * The builder's own source region in `server/index.ts`: from the assembly point to the next top-level
 * function. Both markers are asserted to exist, and the region to be non-empty, so a marker rename
 * fails LOUD here rather than slicing an empty string and passing every "absent key" check vacuously.
 */
function seamsBuilderRegion(source: string): string {
  const start = source.indexOf('const buildVoiceRealtimeSeams');
  assert.ok(start >= 0, '`const buildVoiceRealtimeSeams` must be locatable in server/index.ts');
  const end = source.indexOf('function resolveIdleRotateMs', start);
  assert.ok(end > start, '`function resolveIdleRotateMs` must follow the assembly point, or the slice is hollow');
  const region = source.slice(start, end);
  assert.ok(region.length > 0, 'the sliced assembly-point region must not be empty');
  return region;
}

/**
 * Whether a builder region hands a `silenceTail` SEAM OBJECT to the proxy — i.e. carries the retired
 * `silenceTail:` property key. `resolveSilenceTail(` / `describeSilenceTail(` are CALLS (capitalised,
 * no colon) and are deliberately NOT hits: reading the switch is what the disconnect keeps.
 */
const fillsSilenceTailSeam = (region: string): boolean => region.includes('silenceTail:');

// ── AC1: the assembly point no longer fills the seam ─────────────────────────────────────────────

test('AC1 — the assembly point fills no `silenceTail` seam key, for any switch value', () => {
  const source = readFileSync(SERVER_INDEX, 'utf8');
  const region = seamsBuilderRegion(source);

  // NON-HOLLOWNESS FIRST: the region is the builder itself, shown by what it still contains. The
  // switch read is what this task KEEPS, so its presence is proof the slice is the assembly point and
  // the absence asserted next is the KEY's absence, not the block's disappearance.
  assert.ok(region.includes('resolveSilenceTail('), 'the region must still read the switch, or the slice is not the builder');
  assert.ok(region.includes('describeSilenceTail('), 'the region must still explain the switch');

  // THE CRITERION: no `silenceTail:` key on any path. A source read is switch-value-independent by
  // construction — there is no branch left that could fill the key under some environment.
  assert.equal(
    fillsSilenceTailSeam(region),
    false,
    'the assembly point must never fill the `silenceTail` seam key (any VOICE_REALTIME_SILENCE_TAIL value)',
  );

  // FALSE FORM — restoring the retired branch (server/index.ts:820-836, the conditional spread that
  // built the seam) MUST trip the very predicate asserted false above, or the reading proves nothing.
  const restored = [
    '        ...(silenceTail.enabled && transportChoice !== \'continuous\'',
    '            ? {',
    '                  silenceTail: {',
    '                      tailMs: silenceTail.tailMs,',
    '                      prerollMs: silenceTail.prerollMs,',
    '                      keepaliveMs: silenceTail.keepaliveMs,',
    '                  },',
    '              }',
    '            : {}),',
  ].join('\n');
  assert.equal(
    fillsSilenceTailSeam(restored),
    true,
    'the retired branch must trip the predicate, so the AC1 assertion above is a reading and not a tautology',
  );
  // …and the calls the disconnect KEEPS must NOT trip it, which is the AC's own carve-out made explicit.
  assert.equal(
    fillsSilenceTailSeam('const silenceTail = resolveSilenceTail(process.env); const n = describeSilenceTail(silenceTail);'),
    false,
    'switch reads are not seam fills: the carve-out for resolveSilenceTail(/describeSilenceTail( must hold',
  );
});

// ── AC2: the retired switch is reported, and only when on ────────────────────────────────────────

test('AC2 — a spelled-on switch is logged as DEPRECATED/IGNORED; unset logs nothing', () => {
  const region = seamsBuilderRegion(readFileSync(SERVER_INDEX, 'utf8'));

  // THE GUARD: the deprecation line fires ONLY behind `silenceTail.enabled`, pinned as one unit so
  // "the line exists" and "it only fires when the switch is on" are a single reading.
  assert.match(
    region,
    /if \(silenceTail\.enabled\) \{\s*input\.log\?\.\(/,
    'the deprecation line must sit behind the `silenceTail.enabled` guard',
  );

  // WHAT IT SAYS: deprecated/ignored, and that the forwarded bytes are unaffected.
  const deprecationBlock = region.slice(region.indexOf('if (silenceTail.enabled)'));
  assert.match(deprecationBlock, /DEPRECATED and IGNORED/, 'the enabled line must name the deprecation');
  assert.match(
    deprecationBlock,
    /forwards every captured frame unchanged/,
    'the enabled line must say the forwarding is unaffected',
  );

  // THE OLD "ENABLED" SHAPE IS GONE: the region carries no `tailMs=`/`prerollMs=` report line.
  assert.equal(region.includes('tailMs='), false, 'the retired enabled-style report must not reappear');
  assert.equal(region.includes('prerollMs='), false, 'the retired enabled-style report must not reappear');

  // AND THE GUARD'S OWN READING, against the real resolver: unset is off (so the guard cannot fire and
  // nothing is logged), and a spelled-on value is on. This is the "silence means unconfigured" half.
  assert.equal(resolveSilenceTail({}).enabled, false, 'an unset switch must resolve to off');
  assert.equal(resolveSilenceTail({ [SILENCE_TAIL_ENV]: '1' }).enabled, true, 'a spelled-on switch must resolve on');
});

// ── AC3: the switch is byte-for-byte inert on the forwarded wire ─────────────────────────────────

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1_000;
/** Room tone, below every threshold either uplink gate can hold. */
const SILENCE_RMS = 12;
/** The corpus's speech — far above the STS detector's ceiling (~RMS 33). */
const SPEECH_RMS = 500;

/**
 * One PCM16 square-wave frame at `amplitude`, with `index` written into its first four samples so
 * every frame's payload is unique: byte-for-byte identity is still a claim about THE frame that was
 * spoken, not about some frame of the right amplitude.
 */
function pcmFrame(amplitude: number, index = -1): string {
  const pcm = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
    pcm.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
  if (index >= 0) {
    for (let slot = 0; slot < 4; slot += 1) {
      const step = (Math.floor(index / 8 ** slot) % 8) + 1;
      pcm.writeInt16LE((slot % 2 === 0 ? 1 : -1) * (amplitude + step), slot * 2);
    }
  }
  return pcm.toString('base64');
}

/**
 * The corpus the wire is fed: room tone, one utterance, then a long quiet stretch long enough that an
 * STS gate WOULD open a suppression inside it — so the control below has something to withhold.
 */
function corpus(): string[] {
  const frames: string[] = [];
  const push = (amplitude: number, count: number): void => {
    for (let n = 0; n < count; n += 1) {
      frames.push(pcmFrame(amplitude, frames.length));
    }
  };
  push(SILENCE_RMS, 5);
  push(SPEECH_RMS, 5);
  push(SILENCE_RMS, 50);
  return frames;
}

/** The slice of the browser socket the proxy touches — the same shape the sibling suites use. */
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

type Wired = { socket: FakeBrowserSocket; transports: FakeTransport[]; logs: string[] };

/**
 * One continuous-mode proxy connection over a fake browser socket and fake upstreams.
 *
 * `silenceTail` is passed ONLY by the control arm that reproduces the PRE-DISCONNECT wiring: the
 * production-shaped arms pass none, exactly as `buildVoiceRealtimeSeams` now returns (AC1).
 */
function wire(options: { silenceTail?: SilenceTailOptions } = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => {
      const transport = createFakeTransport();
      transports.push(transport);
      return transport;
    },
    createExecutor: () => ({ session_send: async () => ({ accepted: true }) }),
    instructions: 'test instructions',
    // Pinned rather than inherited: the ambient `VOICE_REALTIME_MODE` must not make this a segmented
    // connection, which carries no bare `audio` frames at all.
    segmentedRelay: false,
    log: (line) => logs.push(line),
    ...(options.silenceTail === undefined ? {} : { silenceTail: options.silenceTail }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transports, logs };
}

const opened = (socket: FakeBrowserSocket): boolean =>
  socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open');

/** Every audio payload the ACTIVE upstream was handed, in order. */
const appends = (wired: Wired): string[] =>
  (wired.transports[0]?.sent ?? [])
    .filter((message) => message.type === 'input_audio_buffer.append')
    .map((message) => (message as { audio: string }).audio);

/** Wires one connection, feeds `frames`, and returns what reached the upstream. */
async function capture(frames: readonly string[], options: { silenceTail?: SilenceTailOptions } = {}): Promise<string[]> {
  const wired = wire(options);
  await waitFor(() => opened(wired.socket));
  for (const audio of frames) {
    wired.socket.receive({ type: 'audio', audio });
  }
  // The continuous audio branch forwards synchronously, but yield once so any `void`-started step
  // settles before the reading.
  await new Promise((resolve) => setImmediate(resolve));
  return appends(wired);
}

/** Runs `body` with `VOICE_REALTIME_SILENCE_TAIL` set to `value` (`null` deletes it), restoring after. */
async function withSilenceTail<T>(value: string | null, body: () => Promise<T>): Promise<T> {
  const previous = process.env[SILENCE_TAIL_ENV];
  if (value === null) {
    delete process.env[SILENCE_TAIL_ENV];
  } else {
    process.env[SILENCE_TAIL_ENV] = value;
  }
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env[SILENCE_TAIL_ENV];
    } else {
      process.env[SILENCE_TAIL_ENV] = previous;
    }
  }
}

test('AC3 — against a production-shaped assembly the switch is byte-for-byte inert on the forwarded frames', async () => {
  const frames = corpus();

  // The SAME browser frames, the SAME production-shaped seam (no `silenceTail`), differing only in the
  // switch. Byte for byte, frame for frame, the two wires are identical — and equal the browser's own
  // frames, i.e. the identity relay.
  const switchedOn = await withSilenceTail('1', () => capture(frames));
  const switchedOff = await withSilenceTail(null, () => capture(frames));

  assert.deepEqual(switchedOn, switchedOff, 'VOICE_REALTIME_SILENCE_TAIL must not change a single forwarded byte');
  assert.deepEqual(switchedOn, frames, 'the production assembly is the identity relay: every frame crosses, unchanged');

  // NON-VACUITY / CONTROL: the SAME harness with the seam actually filled — the pre-disconnect wiring —
  // DOES withhold frames. Without this, "identical" could be a harness that captured nothing at all.
  const legacy = await capture(frames, { silenceTail: { tailMs: 40, prerollMs: 20, keepaliveMs: 0 } });
  assert.notDeepEqual(legacy, frames, 'a filled seam must gate, so the identity reading above is meaningful');
  assert.ok(legacy.length < frames.length, 'the legacy gate withholds frames, which is what the disconnect removed');
});

// ── AC4: neither uplink gate seam is reachable in production ─────────────────────────────────────

test('AC4 — no production path arms both uplink gates, so the proxy exclusion branch cannot run', () => {
  const source = readFileSync(SERVER_INDEX, 'utf8');
  const region = seamsBuilderRegion(source);

  // (a) THE STS SEAM IS NEVER FILLED — AC1's reading, restated as the first half of the exclusion.
  assert.equal(fillsSilenceTailSeam(region), false, 'the STS seam is not filled, so its gate is always null');

  // (b) THE UPLINK-VAD SEAM HAS NO ARM POINT: the composition root never mentions it at all
  // (`grep -rn 'uplinkVad' server/index.ts` is empty; `seams.uplinkVad` is constructed only in tests).
  assert.equal(source.includes('uplinkVad'), false, 'server/index.ts must not arm the uplink-VAD seam');

  // ⇒ The proxy's exclusion branch needs BOTH non-null (`uplinkVadRequested && silenceTail !== null`).
  // With the STS gate always null in production, the branch is dead regardless of the VAD. This task
  // does NOT remove the branch — it is read as still present, so the claim is "unreachable", not "gone".
  const proxy = readFileSync(WS_PROXY, 'utf8');
  assert.match(
    proxy,
    /uplinkVadRequested && silenceTail !== null/,
    'the proxy must still carry the exclusion branch (this task retires the STS call site, not the branch)',
  );
});
