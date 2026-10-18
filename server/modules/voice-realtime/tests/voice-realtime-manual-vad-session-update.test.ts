/**
 * gap-live-voice-manual-mode-session-update-keeps-vad-off — the manually segmented path's own
 * detector switch (`session.turn_detection: null`) must survive every FULL `session.update` that
 * follows it.
 *
 * WHY THIS FILE EXISTS. On 2026-10-12 (journal `ef9daacd`) a real segmented session went wrong in a
 * way the journal could not show. `seq0` was delivered, then the first state injection re-stated the
 * whole session body — `turn_detection: server_vad` included — and switched the endpoint's OWN VAD
 * back on. From ~100 ms after every manual commit the endpoint reported `speech_started` and never
 * `speech_stopped`; the next segment's `commit` landed on top of that open utterance and was refused
 * with `buffer too small, or have no audio`, and the `response.create` that followed produced no
 * `response.created`. Two spoken things were heard, transcribed, and never relayed.
 *
 * HOW IT RUNS. The REAL proxy (`handleVoiceRealtimeConnection`) over the REAL transport
 * (`createDashscopeTransport`) over the SCRIPTED stand-in (`createScriptedUpstream`) — the three
 * pieces the shipping wire is made of — with `apiKey: ''` and the stand-in's own socket factory, so
 * nothing here can dial out. What is asserted is the WIRE: the raw `session.update` bodies the
 * stand-in actually received (`upstream.clientFrames`), never a bridge return value.
 *
 * WHERE THE INJECTION COMES FROM. The proxy's `advertiseInstructions` is the ONE path a re-stated
 * session body takes, shared by the C2 context pack (driven here, as a browser `context` frame) and
 * the S-A execution-status line. Driving that path is what makes the frame under test the frame
 * production sent. The detector's parameters are a NON-default resolution, so "the resolved value"
 * and "the shipped literal" cannot be confused for one another.
 *
 * THE FIRST GROUP IS THE FALSE FORM (AC1). The shipping transport is copied beside itself with the
 * switch's line REMOVED — the pre-2026-10-12 shape — and the same scenario is run through both, so
 * the reading the rest of this file asserts on is shown to go red rather than being green for a
 * reason of its own.
 *
 * Consumers: the quay worker's AC state for
 * `gap-live-voice-manual-mode-session-update-keeps-vad-off`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS } from 'ws';

import {
  createDashscopeTransport,
  DEFAULT_SESSION_DEFAULTS,
  resolveTurnDetection,
  VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV,
  VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV,
  type DashscopeTransport,
  type DashscopeTransportOptions,
  type RealtimeToolExecutor,
} from '../index.js';
import { summarizeWireObservation } from '../voice-realtime-diagnose.service.js';
import { VOICE_REALTIME_MODE_ENV, resolveVoiceRealtimeMode } from '../voice-realtime-mode.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
} from '../voice-realtime-ws-proxy.service.js';

import { waitFor } from './realtime-bridge-harness.js';
import { createScriptedUpstream, SCRIPTED_ENDPOINT_URL, type ScriptedUpstream } from './voice-realtime-scripted-upstream.js';

// ── the deployment under test ─────────────────────────────────────────────────────────────────

/**
 * The detector a deployment resolved: `server_vad`, but with NON-default parameters. Every reading
 * below can therefore tell "the value the deployment resolved" from "the literal the transport
 * ships" — which is what makes AC3 an assertion about the assembled body rather than about a
 * constant that would be on the wire either way.
 */
const RESOLVED_TURN_DETECTION = resolveTurnDetection({
  [VOICE_REALTIME_TURN_DETECTION_THRESHOLD_ENV]: '0.7',
  [VOICE_REALTIME_TURN_DETECTION_SILENCE_MS_ENV]: '900',
}).turnDetection;

/**
 * The detector as it reaches the wire: the transport's composer appends `interrupt_response:false`
 * to every non-null `turn_detection` (GOAL-046), so a reading of the assembled body contains it.
 */
const RESOLVED_TURN_DETECTION_ON_WIRE = { ...RESOLVED_TURN_DETECTION, interrupt_response: false };

/** Exactly what `server/index.ts` hands `createDashscopeTransport`: the defaults, detector replaced. */
const SESSION_DEFAULTS: Readonly<Record<string, unknown>> = {
  ...DEFAULT_SESSION_DEFAULTS,
  turn_detection: RESOLVED_TURN_DETECTION,
};

/** One 100 ms frame at 16 kHz, distinct per segment so an ordering reading names its own audio. */
const frame = (byte: number): string => Buffer.alloc(3_200, byte).toString('base64');

// ── the browser end of the socket, driven directly ────────────────────────────────────────────

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
  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

// ── one wired connection ──────────────────────────────────────────────────────────────────────

/** The transport factory the proxy dials, so a mutant copy can be handed in where the shipping one goes. */
type CreateTransportFn = (options?: DashscopeTransportOptions) => DashscopeTransport;

type Session = {
  readonly upstream: ScriptedUpstream;
  readonly socket: FakeBrowserSocket;
  /** Every client frame the stand-in received, in order — the wire, which is what is asserted on. */
  readonly wire: Array<Record<string, unknown>>;
};

/**
 * Boots one connection: the real proxy, the real transport over the scripted stand-in, a browser
 * socket driven by hand.
 *
 * `createTransport` is a seam so the AC1 false form can run the SAME scenario through a mutated
 * transport copy; everything else is constant between the two runs.
 */
function startSession(input: { createTransport?: CreateTransportFn; segmentedRelay: boolean }): Session {
  const upstream = createScriptedUpstream();
  const buildTransport = input.createTransport ?? createDashscopeTransport;
  const socket = new FakeBrowserSocket();
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'manual-vad-session',
    {
      createTransport: (report) =>
        buildTransport({
          apiKey: '',
          endpoint: SCRIPTED_ENDPOINT_URL,
          socketFactory: upstream.socketFactory,
          onError: report,
          sessionDefaults: SESSION_DEFAULTS,
        }),
      createExecutor: () => ({}) as RealtimeToolExecutor,
      instructions: 'manual-vad session instructions',
      segmentedRelay: input.segmentedRelay,
    },
  );
  return { upstream, socket, wire: upstream.clientFrames };
}

/** Resolves once the connection has dialled and the page has been told the session is open. */
const openSession = (session: Session): Promise<void> =>
  waitFor(() => session.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));

/** One whole segment, as the page's relay speaks it: open, frames, close. */
function speakSegment(session: Session, seq: number, bytes: number[]): void {
  session.socket.receive({ type: 'segment_start', seq });
  for (const byte of bytes) session.socket.receive({ type: 'audio', audio: frame(byte), seq });
  session.socket.receive({ type: 'segment_end', seq, durationMs: 300, reason: 'gap' });
}

/**
 * One state injection, as the C2 pack (and the S-A status line beside it) reaches the upstream: the
 * browser hands the proxy context, the proxy re-composes the instructions and re-states the session.
 */
function injectState(session: Session, text: string): void {
  session.socket.receive({ type: 'context', text, chars: text.length, rows: 1 });
}

// ── readings off the wire ────────────────────────────────────────────────────────────────────

/** The `session` body of every `session.update` the stand-in received, in order. */
const updateBodies = (session: Session): Array<Record<string, unknown>> =>
  session.wire
    .filter((wire) => wire.type === 'session.update')
    .map((wire) => (wire.session ?? {}) as Record<string, unknown>);

/**
 * The `session.update` bodies written AFTER the segmented path took the utterance boundaries over —
 * i.e. from the switch itself onwards. A body before it is the honest pre-switch session and is not
 * what this criterion is about.
 *
 * Empty until the switch has actually gone out. That matters because this is read inside
 * `waitFor` predicates, where a throw is a failed wait rather than a failed reading:
 * {@link assertSwitchOnTheWire} is where "the switch happened at all" is asserted, once the wait is
 * over.
 */
function updatesAfterSwitch(session: Session): Array<Record<string, unknown>> {
  const bodies = updateBodies(session);
  const switchAt = bodies.findIndex((body) => body.turn_detection === null);
  return switchAt === -1 ? [] : bodies.slice(switchAt);
}

/** The segmented path must have turned the endpoint`s own detector off, or every reading below is about nothing. */
function assertSwitchOnTheWire(session: Session): void {
  assert.ok(
    updateBodies(session).some((body) => body.turn_detection === null),
    `the segmented path must have switched the endpoint's own detector off: ${JSON.stringify(updateBodies(session))}`,
  );
}

/** The index of the first frame of a type on the wire, or -1. */
const firstIndexOf = (session: Session, type: string): number => session.wire.findIndex((wire) => wire.type === type);

// ── AC1: the false form — the reading can go red ──────────────────────────────────────────────

/** Where the module's directory and the shipping transport are, for the falsify copy. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.resolve(HERE, '..');
const SHIPPING_TRANSPORT_MODULE = path.join(MODULE_DIR, 'voice-realtime-dashscope-transport.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
const ownCopy = (label: string): string => path.join(MODULE_DIR, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/**
 * THE LINE THAT MAKES THE SWITCH OUTRANK THE DEFAULTS. Removing it restores the pre-2026-10-12
 * behaviour exactly: every full update re-states `sessionDefaults.turn_detection` and re-opens the
 * endpoint's detector behind the segmented path's back.
 */
const SWITCH_SPREAD_ANCHOR = '        ...(switchedTurnDetection === undefined ? {} : { turn_detection: switchedTurnDetection }),\n';

test('AC1 false form: removing the switch spread from the transport puts `server_vad` back on the wire', async () => {
  const source = readFileSync(SHIPPING_TRANSPORT_MODULE, 'utf8');
  assert.equal(
    source.split(SWITCH_SPREAD_ANCHOR).length - 1,
    1,
    'the switch spread must occur exactly once, or the mutation below is not the one this form means',
  );
  const mutated = source.replace(SWITCH_SPREAD_ANCHOR, '');
  assert.notEqual(mutated, source, 'the mutation must actually change the source');

  const basePath = ownCopy('manual-vad-base');
  const mutPath = ownCopy('manual-vad-mut');
  writeFileSync(basePath, source, 'utf8');
  writeFileSync(mutPath, mutated, 'utf8');
  const load = async (file: string): Promise<CreateTransportFn> =>
    ((await import(pathToFileURL(file).href)) as { createDashscopeTransport: CreateTransportFn })
      .createDashscopeTransport;
  const base = await load(basePath);
  const mutant = await load(mutPath);

  try {
    /** Segments once, injects once, and returns the post-switch update bodies the wire carries. */
    const postSwitchBodies = async (createTransport: CreateTransportFn): Promise<Array<Record<string, unknown>>> => {
      const session = startSession({ createTransport, segmentedRelay: true });
      await openSession(session);
      speakSegment(session, 0, [0x0a]);
      await waitFor(() => firstIndexOf(session, 'input_audio_buffer.commit') !== -1);
      assertSwitchOnTheWire(session);
      injectState(session, 'AC1 false form');
      await waitFor(() => updatesAfterSwitch(session).some((body) => Array.isArray(body.tools)));
      const after = updatesAfterSwitch(session);
      session.socket.close();
      return after;
    };

    // Unmutated: the switch outranks the defaults, so no post-switch body carries a live detector.
    const shipped = await postSwitchBodies(base);
    assert.ok(
      shipped.some((body) => Array.isArray(body.tools)),
      `non-vacuity: the injection must have reached the wire after the switch: ${JSON.stringify(shipped)}`,
    );
    assert.deepEqual(
      shipped.filter((body) => body.turn_detection !== null).map((body) => body.turn_detection),
      [],
      `the shipping transport must re-state the switch, not the default: ${JSON.stringify(shipped)}`,
    );

    // Mutated: the very same scenario carries the deployment's detector on the injected body, which
    // is what the assertion above would catch. Without this the reading above could be green for a
    // reason of its own (an injection that never happened, a body that never carried the field).
    const broken = await postSwitchBodies(mutant);
    const liveDetectors = broken.filter((body) => Array.isArray(body.tools)).map((body) => body.turn_detection);
    assert.ok(liveDetectors.length > 0, `the mutant must still inject a body: ${JSON.stringify(broken)}`);
    assert.deepEqual(
      liveDetectors[0],
      RESOLVED_TURN_DETECTION_ON_WIRE,
      `restoring the plain spread must put the deployment's own detector back on the wire: ${JSON.stringify(broken)}`,
    );
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── AC2: the segmented path's switch survives every later full update ─────────────────────────

test('AC2: no session.update after a segment has started re-opens the endpoint`s own detector', async () => {
  const session = startSession({ segmentedRelay: true });
  await openSession(session);

  speakSegment(session, 0, [0x0a, 0x0b]);
  await waitFor(() => firstIndexOf(session, 'input_audio_buffer.commit') !== -1);
  assertSwitchOnTheWire(session);

  // The defect's own sequence: the first segment is delivered, THEN state is injected, THEN the
  // next segment is spoken. On 2026-10-12 the injection is what re-opened the detector, so the
  // commit that followed was refused.
  injectState(session, 'seq0 delivered');
  await waitFor(() => updatesAfterSwitch(session).some((body) => Array.isArray(body.tools)));
  speakSegment(session, 1, [0x0c]);
  await waitFor(() => firstIndexOf(session, 'input_audio_buffer.commit') !== -1 && session.wire.filter((w) => w.type === 'input_audio_buffer.commit').length >= 2);

  const after = updatesAfterSwitch(session);
  assert.ok(
    after.some((body) => Array.isArray(body.tools) && (body.tools as unknown[]).length > 0),
    `non-vacuity: the state injection must have re-advertised the tools after the switch: ${JSON.stringify(after)}`,
  );
  assert.deepEqual(
    after.filter((body) => body.turn_detection !== null).map((body) => body.turn_detection),
    [],
    `a session.update after segments started re-enabled the endpoint's detector: ${JSON.stringify(after)}`,
  );

  session.socket.close();
});

test('AC2: a reconnect re-establishes the session with the detector still off, before the replayed segment', async () => {
  const session = startSession({ segmentedRelay: true });
  await openSession(session);

  speakSegment(session, 0, [0x0a]);
  await waitFor(() => firstIndexOf(session, 'input_audio_buffer.commit') !== -1);
  assertSwitchOnTheWire(session);
  injectState(session, 'before the drop');
  await waitFor(() => updatesAfterSwitch(session).some((body) => Array.isArray(body.tools)));

  // The endpoint drops the socket. The bridge re-dials on its own and re-establishes the session.
  const beforeDrop = session.wire.length;
  session.upstream.drop();
  await waitFor(() =>
    session.wire
      .slice(beforeDrop)
      .some((wire) => wire.type === 'input_audio_buffer.commit'),
  );
  const afterDrop = session.wire.slice(beforeDrop);

  const bodies = afterDrop
    .filter((wire) => wire.type === 'session.update')
    .map((wire) => (wire.session ?? {}) as Record<string, unknown>);
  assert.ok(bodies.length > 0, 'the new socket must be told what the session is');
  assert.deepEqual(
    bodies.filter((body) => body.turn_detection !== null).map((body) => body.turn_detection),
    [],
    `the reconnect's own re-advertisement re-enabled the endpoint's detector: ${JSON.stringify(bodies)}`,
  );
  // The bridge still sends its own switch frame after a reconnect, and it still goes out BEFORE the
  // replayed audio — otherwise the segment would be written onto a socket whose detector is watching.
  assert.ok(
    bodies.some((body) => body.tools === undefined),
    `the post-reconnect switch frame must still be sent: ${JSON.stringify(bodies)}`,
  );
  assert.ok(
    afterDrop.findIndex((wire) => wire.type === 'session.update') < afterDrop.findIndex((wire) => wire.type === 'input_audio_buffer.append'),
    `the detector must be off on the new socket before the segment is replayed: ${JSON.stringify(afterDrop.map((w) => w.type))}`,
  );

  session.socket.close();
});

// ── AC3: continuous mode is unchanged ────────────────────────────────────────────────────────

test('AC3: with the relay off (`VOICE_REALTIME_MODE=continuous`) an update still carries the resolved detector', async () => {
  const continuous = resolveVoiceRealtimeMode({ [VOICE_REALTIME_MODE_ENV]: 'continuous' });
  assert.equal(continuous.mode, 'continuous', 'the escape hatch must resolve to the pre-P4 wire');

  // `false` is exactly what `server/index.ts` hands the proxy for that resolution: the relay switch is
  // the mode, resolved once at the assembly point.
  const session = startSession({ segmentedRelay: false });
  await openSession(session);

  // A browser that never segments — the continuous page — and state injected anyway.
  session.socket.receive({ type: 'audio', audio: frame(0x0a) });
  injectState(session, 'continuous session');
  await waitFor(() => updateBodies(session).length >= 2);
  const bodies = updateBodies(session);
  session.socket.close();

  assert.ok(bodies.length >= 2, `both the open and the injection must reach the wire: ${JSON.stringify(bodies)}`);
  for (const body of bodies) {
    assert.deepEqual(
      body.turn_detection,
      RESOLVED_TURN_DETECTION_ON_WIRE,
      `a continuous session advertises the resolved detector on every update: ${JSON.stringify(body)}`,
    );
  }
});

// ── AC4: the journal line names the detector ─────────────────────────────────────────────────

test('AC4: the journal`s session.update line carries the turn_detection reading', async () => {
  const session = startSession({ segmentedRelay: true });
  await openSession(session);
  speakSegment(session, 0, [0x0a]);
  await waitFor(() => firstIndexOf(session, 'input_audio_buffer.commit') !== -1);
  assertSwitchOnTheWire(session);
  injectState(session, 'journal reading');
  await waitFor(() => updatesAfterSwitch(session).some((body) => Array.isArray(body.tools)));

  const lines = session.wire
    .filter((wire) => wire.type === 'session.update')
    .map((wire) => summarizeWireObservation({ direction: 'sent', wire }));
  session.socket.close();

  assert.ok(lines.length >= 2, `the session must have been updated at least twice: ${JSON.stringify(lines)}`);
  assert.ok(
    lines.some((line) => line?.includes('turn_detection=null')),
    `the switch must be readable in the journal: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((line) => line?.includes('turn_detection=server_vad threshold=0.7 silence=900ms')),
    `the resolved detector's own parameters must be readable in the journal: ${JSON.stringify(lines)}`,
  );
  // The three readings are distinguishable: a body that never carried the field says `absent`, and
  // neither of the other two words can be mistaken for it.
  assert.equal(
    summarizeWireObservation({ direction: 'sent', wire: { type: 'session.update', session: { voice: 'Tina' } } }),
    'session.update voice=Tina tools=0 turn_detection=absent',
  );
});

// ── residue ─────────────────────────────────────────────────────────────────────────────────

test('the AC1 false form leaves none of this process`s copies behind', () => {
  const leftovers = readdirSync(MODULE_DIR).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
