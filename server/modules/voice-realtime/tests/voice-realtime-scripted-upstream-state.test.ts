/**
 * gap-live-voice-scripted-upstream-protocol-state-machine — the OPTIONAL protocol state machine the
 * shared scripted stand-in gains ({@link createScriptedProtocolState} in
 * `./voice-realtime-scripted-upstream.ts`).
 *
 * WHY THIS FILE EXISTS. The stand-in could SAY any frame a scenario named, but it could not REACT,
 * and the endpoint's reactions are where the incidents were. The 2026-10-12 journal (`ef9daacd`)
 * shows an endpoint refusing a commit because its OWN detector was holding the audio, announcing
 * `speech_started`, and creating the item itself — all in response to what the app had just sent. A
 * hand-written script cannot tell you whether the CLIENT caused that; it can only tell you that the
 * person who wrote the script believed it did. So the machine's every reaction below is a function of
 * the session's CURRENT `turn_detection`, and the first group is the FALSE FORM that takes that
 * reading away.
 *
 * HOW IT RUNS. Three layers, each answering a different question:
 *
 *   · the machine DIRECTLY (`createScriptedProtocolState`), for the exhaustive per-behaviour matrix —
 *     deterministic, no socket, no clock;
 *   · a REAL `ws.WebSocketServer` hosting one machine per connection, driven by a real `ws` client,
 *     for "the answers travel as JSON over a socket, in order";
 *   · the in-process stand-in (`createScriptedUpstream({ protocol })`) at its own socket seam, for
 *     the fault paths (`drop`, a refused dial) and for the DISARMED wire staying what it was.
 *
 * THE FIRST GROUP IS THE FALSE FORM (AC1): the shipping module is copied beside itself with the one
 * line that reads `turn_detection` off `session.update` REMOVED — the shape a stand-in that ignored
 * the client's detector switch would have — and the same scenario is run through both, so the
 * reading every later group depends on is shown to go RED rather than being green for a reason of
 * its own.
 *
 * THE FAULT PLAN (F1–F6) IS SELF-TESTED HERE TOO. The machine makes the endpoint REACT; the plan
 * (see {@link ScriptedFaultPlan}) makes it FAIL — drop on the nth commit, on a replay, 206 ms later,
 * or take an event and lose it. Each fault gets one test that fires it and one FALSE FORM that
 * disarms that single fault and shows the reading change, including F6's: the e2e scripted upstream
 * reads the SAME plan and fires none of it.
 *
 * Consumers: the quay worker's AC state for
 * `gap-live-voice-scripted-upstream-protocol-state-machine`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket as WS, WebSocketServer } from 'ws';

import {
  createScriptedFaultClock,
  createScriptedProtocolState,
  createScriptedUpstream,
  SCRIPTED_ENDPOINT_URL,
  type ScriptedProtocolState,
} from './voice-realtime-scripted-upstream.js';

// ── readings off a frame list ─────────────────────────────────────────────────────────────────

/** The `type` of every frame, in order — the shape most assertions below are about. */
const types = (frames: Array<Record<string, unknown>>): string[] => frames.map((frame) => String(frame.type));

/** The item id a frame names, whichever of the two fields carries it. */
const itemIdOf = (frame: Record<string, unknown>): unknown =>
  frame.item_id ?? (frame.item as { id?: unknown } | undefined)?.id;

/** The single frame of `type`, or a loud failure (never a silent `undefined`). */
function only(frames: Array<Record<string, unknown>>, type: string): Record<string, unknown> {
  const found = frames.filter((frame) => frame.type === type);
  assert.equal(found.length, 1, `expected exactly one ${type}: ${JSON.stringify(frames)}`);
  return found[0]!;
}

/** The `session.update` body the transport writes for `session.turn_detection` (a FULL body). */
const turnDetectionUpdate = (turnDetection: unknown): Record<string, unknown> => ({
  type: 'session.update',
  session: { voice: 'Tina', turn_detection: turnDetection },
});

const DETECTOR_ON = { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 };

// ── AC1: the false form — the reading can go red ──────────────────────────────────────────────

/** Where the module and its shipping source are, for the falsify copy. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIPPING_MODULE = path.join(HERE, 'voice-realtime-scripted-upstream.ts');

/** The prefix every falsify copy carries, so this process's own copies are identifiable. */
const TEMP_PREFIX = '__criterion-falsify-';
const ownCopy = (label: string): string => path.join(HERE, `${TEMP_PREFIX}${label}-${process.pid}.ts`);

/**
 * THE LINE THAT TURNS THE CLIENT'S DETECTOR SWITCH INTO THE ENDPOINT'S BEHAVIOUR. Removing it
 * leaves a stand-in that is deaf to every `session.update`: it keeps whatever detector it started
 * with, no matter how many times the app tells it the session is manual.
 */
const SWITCH_READ_ANCHOR = "          turnDetection = detectorIsOn(session.turn_detection) ? 'server_vad' : null;\n";

type CreateState = (options?: Parameters<typeof createScriptedProtocolState>[0]) => ScriptedProtocolState;

/** The scenario every reading in this file is a function of: a switch to manual, then one commit. */
function switchedCommit(state: ScriptedProtocolState): Array<Record<string, unknown>> {
  state.receive(turnDetectionUpdate(null)); // the segmented path's own `session.turn_detection: null`
  return state.receive({ type: 'input_audio_buffer.commit' });
}

test('AC1 false form: removing the turn_detection read puts the endpoint`s refusal back on the wire', async () => {
  const source = readFileSync(SHIPPING_MODULE, 'utf8');
  assert.equal(
    source.split(SWITCH_READ_ANCHOR).length - 1,
    1,
    'the turn_detection read must occur exactly once, or the mutation below is not the one this form means',
  );
  const mutated = source.replace(SWITCH_READ_ANCHOR, '');
  assert.notEqual(mutated, source, 'the mutation must actually change the source');

  const basePath = ownCopy('state-base');
  const mutPath = ownCopy('state-mut');
  writeFileSync(basePath, source, 'utf8');
  writeFileSync(mutPath, mutated, 'utf8');
  const load = async (file: string): Promise<CreateState> =>
    ((await import(pathToFileURL(file).href)) as { createScriptedProtocolState: CreateState })
      .createScriptedProtocolState;
  const base = await load(basePath);
  const mutant = await load(mutPath);

  try {
    // The SHIPPING machine: the switch turned the detector off, so the commit is a manual one —
    // the endpoint accepts it and never says `error`.
    const shipped = switchedCommit(base({ initialTurnDetection: 'server_vad' }));
    assert.deepEqual(
      types(shipped),
      ['input_audio_buffer.committed', 'conversation.item.created'],
      `a manual-mode commit must be accepted: ${JSON.stringify(shipped)}`,
    );

    // The MUTANT, same scenario: deaf to the switch, it is still holding its own detector and
    // refuses the commit — the exact frame the assertion above would catch.
    const broken = switchedCommit(mutant({ initialTurnDetection: 'server_vad' }));
    assert.ok(
      types(broken).includes('error'),
      `the mutant must reproduce the endpoint's refusal: ${JSON.stringify(broken)}`,
    );
    assert.equal(
      (only(broken, 'error').error as { type?: unknown }).type,
      'invalid_request_error',
      `the refusal must be the real upstream's error type: ${JSON.stringify(broken)}`,
    );
  } finally {
    rmSync(basePath, { force: true });
    rmSync(mutPath, { force: true });
  }
});

// ── AC2: the protocol's behaviours, one reading each ──────────────────────────────────────────

test('AC2 manual commit: the endpoint accepts it as an input item and transcribes it', () => {
  const state = createScriptedProtocolState({
    initialTurnDetection: 'server_vad',
    commits: [{ itemId: 'item_m', transcript: { kind: 'on-time', text: '第一句话' } }],
  });
  state.receive(turnDetectionUpdate(null));
  assert.deepEqual(state.receive({ type: 'input_audio_buffer.append', audio: 'AAAA' }), [], 'appending says nothing');

  const frames = state.receive({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(types(frames), [
    'input_audio_buffer.committed',
    'conversation.item.created',
    'conversation.item.input_audio_transcription.completed',
  ]);
  assert.equal(itemIdOf(only(frames, 'input_audio_buffer.committed')), 'item_m');
  assert.equal(itemIdOf(only(frames, 'conversation.item.created')), 'item_m');
  assert.equal(only(frames, 'conversation.item.input_audio_transcription.completed').transcript, '第一句话');
  assert.equal(state.committed, 1);
  assert.deepEqual(state.items, ['item_m']);
});

test('AC2 server_vad empty buffer: the refusal carries the real upstream`s error.type', () => {
  // No switch at all: the session's own detector is on, and the client commits onto its buffer.
  const state = createScriptedProtocolState({ initialTurnDetection: 'server_vad' });
  assert.equal(state.turnDetection, 'server_vad');

  const frames = state.receive({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(types(frames), ['error', 'input_audio_buffer.speech_started', 'conversation.item.created']);

  const error = only(frames, 'error').error as { type?: unknown; code?: unknown; message?: unknown };
  assert.equal(error.type, 'invalid_request_error', 'the KIND travels in `type`, as the real upstream writes it');
  assert.equal(error.code, undefined, 'the real frame carries no `code` — a stand-in that invents one proves nothing');
  assert.match(String(error.message), /buffer too small, or have no audio/, 'the refusal is the journal`s, verbatim');
  // The frame is JSON-clean: what a real socket would carry is what the assertion above read.
  assert.deepEqual(JSON.parse(JSON.stringify(frames[0]!)), only(frames, 'error'));
});

test('AC2 speech_started self-created item: an item the client never asked for', () => {
  const state = createScriptedProtocolState({ initialTurnDetection: 'server_vad', commits: [{ itemId: 'item_vad' }] });
  state.receive({ type: 'input_audio_buffer.append', audio: 'AAAA' });
  const frames = state.receive({ type: 'input_audio_buffer.commit' });

  // The endpoint's OWN detector took the audio: it announces speech and creates the item itself.
  assert.deepEqual(types(frames), ['error', 'input_audio_buffer.speech_started', 'conversation.item.created']);
  assert.equal(itemIdOf(only(frames, 'input_audio_buffer.speech_started')), 'item_vad');
  assert.equal(itemIdOf(only(frames, 'conversation.item.created')), 'item_vad');
  // The client sent exactly one frame that could create an item; the machine created one anyway.
  assert.deepEqual(state.items, ['item_vad']);
});

test('AC2 transcription `after`: a delayed transcript lands with a LATER commit`s answer', () => {
  const state = createScriptedProtocolState({
    initialTurnDetection: null,
    commits: [
      { itemId: 'item_0', transcript: { kind: 'after', commits: 2, text: 'delayed' } },
      { itemId: 'item_1', transcript: { kind: 'on-time', text: 'on time' } },
      { itemId: 'item_2' },
    ],
  });
  assert.deepEqual(types(state.receive({ type: 'input_audio_buffer.commit' })), [
    'input_audio_buffer.committed',
    'conversation.item.created',
  ], 'the first item is not transcribed yet — its plan parked the transcript two commits ahead');
  // The SECOND commit's own item IS transcribed on time; the delayed one must not ride along.
  const second = state.receive({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(types(second), [
    'input_audio_buffer.committed',
    'conversation.item.created',
    'conversation.item.input_audio_transcription.completed',
  ]);
  assert.equal(itemIdOf(only(second, 'conversation.item.input_audio_transcription.completed')), 'item_1');

  const third = state.receive({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(types(third), [
    'input_audio_buffer.committed',
    'conversation.item.created',
    'conversation.item.input_audio_transcription.completed',
  ]);
  const completed = only(third, 'conversation.item.input_audio_transcription.completed');
  assert.equal(itemIdOf(completed), 'item_0', 'the transcript belongs to the item created two commits ago');
  assert.equal(completed.transcript, 'delayed');
});

test('AC2 transcription out-of-order: an earlier item`s transcript arrives AFTER a later item`s', () => {
  const state = createScriptedProtocolState({
    initialTurnDetection: null,
    commits: [
      { itemId: 'item_C', transcript: { kind: 'at-commit', ordinal: 1, text: '第三句话' } },
      { itemId: 'item_D', transcript: { kind: 'on-time', text: '第四句话' } },
    ],
  });
  state.receive({ type: 'input_audio_buffer.commit' });
  const second = state.receive({ type: 'input_audio_buffer.commit' });

  assert.deepEqual(types(second), [
    'input_audio_buffer.committed',
    'conversation.item.created',
    'conversation.item.input_audio_transcription.completed',
    'conversation.item.input_audio_transcription.completed',
  ]);
  const transcripts = second.filter((frame) => frame.type === 'conversation.item.input_audio_transcription.completed');
  assert.deepEqual(
    transcripts.map((frame) => [itemIdOf(frame), frame.transcript]),
    [
      ['item_D', '第四句话'],
      ['item_C', '第三句话'],
    ],
    'the LATER item is transcribed first — the relay order the journal shows',
  );
});

test('AC2 transcription `never` and `failed`: silence, and the endpoint`s own failure report', () => {
  const never = createScriptedProtocolState({
    initialTurnDetection: null,
    commits: [{ itemId: 'item_never', transcript: { kind: 'never' } }],
  });
  assert.deepEqual(types(never.receive({ type: 'input_audio_buffer.commit' })), [
    'input_audio_buffer.committed',
    'conversation.item.created',
  ]);

  const failed = createScriptedProtocolState({
    initialTurnDetection: null,
    commits: [{ itemId: 'item_failed', transcript: { kind: 'failed', message: 'audio too short' } }],
  });
  const frames = failed.receive({ type: 'input_audio_buffer.commit' });
  const report = only(frames, 'conversation.item.input_audio_transcription.failed');
  assert.equal(itemIdOf(report), 'item_failed');
  assert.equal((report.error as { message?: unknown }).message, 'audio too short');
});

test('AC2 response answer: a tool call, an in-text reply, and a bare acknowledgement', () => {
  const call = createScriptedProtocolState({
    initialTurnDetection: null,
    commits: [{ itemId: 'i', answer: { kind: 'function_call', name: 'session_send', args: { message: '先说的' } } }],
  });
  call.receive({ type: 'input_audio_buffer.commit' });
  const callFrames = call.receive({ type: 'response.create' });
  assert.deepEqual(types(callFrames), ['response.created', 'response.function_call_arguments.done', 'response.done']);
  const callEvent = only(callFrames, 'response.function_call_arguments.done');
  assert.equal(callEvent.name, 'session_send');
  assert.equal(typeof callEvent.arguments, 'string', '`arguments` is a JSON STRING on the wire');
  assert.deepEqual(JSON.parse(String(callEvent.arguments)), { message: '先说的' });

  const text = createScriptedProtocolState({
    initialTurnDetection: null,
    commits: [{ itemId: 'i', answer: { kind: 'text', text: 'OK' } }],
  });
  text.receive({ type: 'input_audio_buffer.commit' });
  const textFrames = text.receive({ type: 'response.create' });
  assert.deepEqual(types(textFrames), ['response.created', 'response.text.done', 'response.done']);
  assert.equal(only(textFrames, 'response.text.done').text, 'OK');

  const none = createScriptedProtocolState({ initialTurnDetection: null, commits: [{ itemId: 'i' }] });
  none.receive({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(types(none.receive({ type: 'response.create' })), ['response.created', 'response.done']);
});

test('AC2 response withhold and swallow-under-vad: the create is answered with nothing at all', () => {
  const withheld = createScriptedProtocolState({
    initialTurnDetection: null,
    commits: [{ itemId: 'i', response: 'withhold' }],
  });
  withheld.receive({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(withheld.receive({ type: 'response.create' }), [], 'a withheld response says nothing');

  // The journal's swallowed create: the endpoint's own detector is ON, so the response the client
  // asked for never comes. Turn the detector off and the SAME plan is answered — the swallow is a
  // function of the session's detector, not of the plan.
  const state = createScriptedProtocolState({
    initialTurnDetection: 'server_vad',
    refuseEmptyBufferUnderVad: false,
    commits: [{ itemId: 'i', response: 'swallow-under-vad' }],
  });
  state.receive({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(state.receive({ type: 'response.create' }), [], 'swallowed while the detector is on');

  state.receive(turnDetectionUpdate(null));
  state.receive({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(types(state.receive({ type: 'response.create' })), ['response.created', 'response.done']);
});

test('AC2 response.done carries usage when the plan gives it', () => {
  const state = createScriptedProtocolState({
    initialTurnDetection: null,
    commits: [{ itemId: 'i' }],
    responseUsage: { total_tokens: 42, input_tokens: 40, output_tokens: 2 },
  });
  state.receive({ type: 'input_audio_buffer.commit' });
  const done = only(state.receive({ type: 'response.create' }), 'response.done');
  assert.deepEqual((done.response as { usage?: unknown }).usage, { total_tokens: 42, input_tokens: 40, output_tokens: 2 });
});

test('AC2 the tool result`s synthesized resume is answered without the model speaking', () => {
  const state = createScriptedProtocolState({ initialTurnDetection: null, commits: [{ itemId: 'i' }] });
  state.receive({ type: 'input_audio_buffer.commit' });
  state.receive({ type: 'response.create' });

  // The app returns the tool result, then resumes the turn — the two frames, in that order.
  state.receive({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: 'ok' } });
  const resume = state.receive({ type: 'response.create' });
  assert.deepEqual(types(resume), ['response.created', 'response.done']);
  assert.equal(
    resume.some((frame) => frame.type === 'response.text.done'),
    false,
    'the default resume says nothing — the journal`s "OK" is MODEL_TEXT_REPLY, and a scenario must ask for it',
  );
});

test('AC2 response.cancel: the endpoint acknowledges the stop with `response.cancelled`', () => {
  const state = createScriptedProtocolState({ initialTurnDetection: null, commits: [{ itemId: 'i' }] });
  state.receive({ type: 'input_audio_buffer.commit' });
  const opened = state.receive({ type: 'response.create' });
  const openedId = (only(opened, 'response.created').response as { id?: unknown }).id;

  const cancelled = state.receive({ type: 'response.cancel' });
  assert.deepEqual(types(cancelled), ['response.cancelled']);
  assert.equal((cancelled[0]!.response as { id?: unknown }).id, openedId, 'it names the response it stopped');
});

test('AC2 a session that never says `turn_detection` keeps the detector it started with', () => {
  // A partial `session.update` with no `turn_detection` field must NOT be read as "off": the real
  // transport only ever writes the field it means, and guessing would silently disable the detector.
  const state = createScriptedProtocolState({ initialTurnDetection: 'server_vad' });
  state.receive({ type: 'session.update', session: { voice: 'Tina' } });
  assert.equal(state.turnDetection, 'server_vad');
  assert.ok(types(state.receive({ type: 'input_audio_buffer.commit' })).includes('error'));
});

test('AC2 the detector switch is read from the session body the transport actually writes', () => {
  const state = createScriptedProtocolState({ initialTurnDetection: 'server_vad' });
  state.receive(turnDetectionUpdate(DETECTOR_ON));
  assert.equal(state.turnDetection, 'server_vad');
  state.receive(turnDetectionUpdate(null));
  assert.equal(state.turnDetection, null);
});

// ── a REAL ws client: the answers travel as JSON over a socket, in order ───────────────────────

type WsHarness = {
  readonly received: Array<Record<string, unknown>>;
  /** Sends one frame and resolves with the frames the endpoint said back, in order. */
  exchange(frame: Record<string, unknown>, expected: number, timeoutMs?: number): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
};

/**
 * Hosts the machine on a REAL socket: one `ws.WebSocketServer` on a loopback ephemeral port, one
 * machine per connection, with a real `ws` client driving it.
 */
async function connectProtocolHost(createState: () => ScriptedProtocolState): Promise<WsHarness> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (error) => reject(error));
  });
  const received: Array<Record<string, unknown>> = [];
  server.on('connection', (socket) => {
    const state = createState();
    socket.on('message', (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      for (const answer of state.receive(frame)) socket.send(JSON.stringify(answer));
    });
  });
  const port = (server.address() as AddressInfo).port;
  const client = new WS(`ws://127.0.0.1:${port}`);
  client.on('message', (raw) => received.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', (error) => reject(error));
  });
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    received,
    async exchange(frame, expected, timeoutMs = 4_000) {
      const from = received.length;
      client.send(JSON.stringify(frame));
      const deadline = Date.now() + timeoutMs;
      while (received.length - from < expected && Date.now() < deadline) await settle(5);
      // Even a frame that expects no answer needs one boundary, so a stray frame would be seen.
      if (expected === 0) await settle(40);
      return received.slice(from);
    },
    close: () =>
      new Promise<void>((done) => {
        client.terminate();
        server.close(() => done());
      }),
  };
}

test('over a real socket: a manual commit answers with the item, its transcript and its response, in order', async () => {
  const host = await connectProtocolHost(() =>
    createScriptedProtocolState({
      initialTurnDetection: 'server_vad',
      commits: [{ itemId: 'item_socket', transcript: { kind: 'on-time', text: '从套接字来的' }, answer: { kind: 'function_call', name: 'session_send', args: { message: '从套接字来的' } } }],
    }),
  );
  try {
    await host.exchange(turnDetectionUpdate(null), 0);
    await host.exchange({ type: 'input_audio_buffer.append', audio: 'AAAA' }, 0);

    const commit = await host.exchange({ type: 'input_audio_buffer.commit' }, 3);
    assert.deepEqual(types(commit), [
      'input_audio_buffer.committed',
      'conversation.item.created',
      'conversation.item.input_audio_transcription.completed',
    ]);

    const response = await host.exchange({ type: 'response.create' }, 3);
    assert.deepEqual(types(response), ['response.created', 'response.function_call_arguments.done', 'response.done']);
    assert.equal(only(response, 'response.function_call_arguments.done').name, 'session_send');
  } finally {
    await host.close();
  }
});

test('over a real socket: a commit made while the detector is on is refused, and says why', async () => {
  const host = await connectProtocolHost(() => createScriptedProtocolState({ initialTurnDetection: 'server_vad' }));
  try {
    const frames = await host.exchange({ type: 'input_audio_buffer.commit' }, 3);
    assert.deepEqual(types(frames), ['error', 'input_audio_buffer.speech_started', 'conversation.item.created']);
    assert.equal((only(frames, 'error').error as { type?: unknown }).type, 'invalid_request_error');
  } finally {
    await host.close();
  }
});

// ── the in-process stand-in: the machine armed, the faults, and the DISARMED wire ─────────────

/** Drives `createScriptedUpstream` at its own socket seam — no proxy, no transport. */
function openStandIn(options: Parameters<typeof createScriptedUpstream>[0]): {
  upstream: ReturnType<typeof createScriptedUpstream>;
  /** The socket the dial returned; a test that re-dials keeps both to drive them apart. */
  socket: ReturnType<ReturnType<typeof createScriptedUpstream>['socketFactory']>;
  send(frame: Record<string, unknown>): void;
  /** The endpoint frames said since the last read. */
  take(): Array<Record<string, unknown>>;
} {
  const upstream = createScriptedUpstream(options);
  const socket = upstream.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let seen = 0;
  return {
    upstream,
    socket,
    send: (frame) => socket.send(JSON.stringify(frame)),
    take: () => {
      const fresh = upstream.endpointFrames.slice(seen);
      seen = upstream.endpointFrames.length;
      return fresh;
    },
  };
}

test('the shared stand-in arms the machine per connection: a dial after a drop starts a clean session', () => {
  // The config's `initialTurnDetection: 'server_vad'` is what makes the reading below distinctive:
  // connection 1 switches the detector OFF, so if connection 2 INHERITED anything it would accept
  // its first commit — a fresh machine is still holding its own detector and refuses it.
  const standIn = openStandIn({
    protocol: { initialTurnDetection: 'server_vad', commits: [{ itemId: 'item_1', transcript: { kind: 'on-time', text: '一' } }] },
  });
  standIn.send(turnDetectionUpdate(null));
  standIn.send({ type: 'input_audio_buffer.commit' });
  assert.ok(standIn.take().some((frame) => frame.type === 'conversation.item.created'));
  assert.equal(standIn.upstream.protocol?.committed, 1, 'the armed machine is readable off the stand-in');

  // The endpoint drops mid-session — the socket's `onclose` is what the transport would see.
  let closed = 0;
  standIn.socket.onclose = () => {
    closed += 1;
  };
  standIn.upstream.drop();
  assert.equal(closed, 1, '`drop` really ends the connection');

  // The transport re-dials, and the NEW connection gets its OWN machine.
  const second = standIn.upstream.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  assert.equal(standIn.upstream.protocol?.committed, 0, 'a new connection starts from a clean session');

  // Fresh means fresh: the replayed `session.update` is what its commits are read against, so the
  // FIRST commit — before any switch — is refused, exactly as connection 1's was.
  standIn.take(); // drop the handshake frames the previous connection left unread
  second.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  const beforeSwitch = standIn.take();
  assert.ok(beforeSwitch.some((frame) => frame.type === 'error'), JSON.stringify(beforeSwitch));

  second.send(JSON.stringify(turnDetectionUpdate(null)));
  second.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  const after = standIn.take();
  assert.ok(after.some((frame) => frame.type === 'input_audio_buffer.committed'), JSON.stringify(after));
});

test('a refused dial cannot arm anything: the next dial is the one the session runs on', () => {
  const standIn = openStandIn({ failOpens: 1, protocol: { initialTurnDetection: null } });
  assert.equal(standIn.upstream.protocol, null, 'a refused dial leaves no machine behind');
  const live = standIn.upstream.socketFactory('ws://scripted.invalid/api-ws/v1/realtime', {});
  assert.notEqual(standIn.upstream.protocol, null, 'the dial that opened is armed');
  live.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  assert.ok(standIn.take().some((frame) => frame.type === 'conversation.item.created'));
});

test('DISARMED, the stand-in`s wire is exactly what it was before the machine existed', () => {
  const standIn = openStandIn({});
  assert.equal(standIn.upstream.protocol, null, 'no `protocol` option, no machine');

  standIn.send({ type: 'session.update', session: { voice: 'Tina' } });
  assert.deepEqual(types(standIn.take()), ['session.created', 'session.updated'], 'the open handshake is untouched');

  standIn.send({ type: 'input_audio_buffer.commit' });
  assert.deepEqual(standIn.take(), [], 'a commit is answered by the SCENARIO, as it always was');

  standIn.send({ type: 'response.create' });
  assert.deepEqual(standIn.take(), [], 'a response.create likewise');

  standIn.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: 'ok' } });
  assert.deepEqual(types(standIn.take()), ['response.done'], 'a tool result is still acknowledged with `response.done`');
});

// ── F1–F6: the fault plan, one self-test per fault, each with its own false form ─────────────
//
// WHY THESE EXIST. A fault plan is only worth arming if its parts are shown to FIRE — and if each
// reading is shown to be a function of the fault rather than of the scenario around it. So every
// test below takes its reading twice: once with the fault armed, and once with the SAME scenario
// and that one fault disarmed (or armed on something it does not name). The second reading is the
// false form: it is the shape a plan that silently did nothing would produce, and it must differ.

/** The frames an armed stand-in said, minus the open handshake every dial says. */
const said = (upstream: ReturnType<typeof createScriptedUpstream>): Array<Record<string, unknown>> =>
  upstream.endpointFrames.filter((frame) => frame.type !== 'session.created' && frame.type !== 'session.updated');

/** The `session.update` a transport writes on every dial — what turns the endpoint's detector off. */
const HANDSHAKE: Record<string, unknown> = { type: 'session.update', session: { voice: 'Tina', turn_detection: null } };

const COMMIT: Record<string, unknown> = { type: 'input_audio_buffer.commit' };

/** One `append` carrying exactly `bytes` bytes of audio — the F4/F2(b) unit. */
const audioOf = (bytes: number): Record<string, unknown> => ({
  type: 'input_audio_buffer.append',
  audio: Buffer.alloc(bytes, 7).toString('base64'),
});

test('F1 the plan decides each dial: accepted, refused, and accepted-then-dropped', async () => {
  const upstream = createScriptedUpstream({
    protocol: { initialTurnDetection: null },
    faults: {
      dials: [
        { disposition: { action: 'refuse' } },
        { disposition: { action: 'accept-then-drop', afterMs: 500 } },
        {},
      ],
    },
  });

  // Dial #1 — refused: the transport sees an error on the next tick, and nothing is armed behind it.
  const refused = upstream.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  const errors: string[] = [];
  refused.onerror = (event) => errors.push((event as Error).message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['scripted endpoint: dial refused']);
  assert.equal(upstream.protocol, null, 'a refused dial arms nothing');

  // Dial #2 — accepted, then dropped 500 ms later ON THE INJECTED CLOCK.
  const timed = upstream.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let closed = 0;
  timed.onclose = () => {
    closed += 1;
  };
  assert.ok(upstream.protocol !== null, 'the dial that opened is armed');
  upstream.tick(499);
  assert.equal(closed, 0, 'the drop is not due yet');
  upstream.tick(500);
  assert.equal(closed, 1, 'the plan drops it at its own reading');

  // Dial #3 — the plan`s `{}`: accepted, and left alone no matter how far the clock is moved.
  const plain = upstream.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let plainClosed = 0;
  plain.onclose = () => {
    plainClosed += 1;
  };
  upstream.tick(60_000);
  assert.equal(plainClosed, 0, 'a dial the plan does not mention is never dropped');

  assert.equal(upstream.faults.dials(), 3, 'every dial is counted, refused or not');
  assert.deepEqual(
    upstream.faults.fired().map((record) => `${record.dial}:${record.reason}`),
    ['1:the plan refused this dial', '2:the dial was dropped 500 ms after it opened'],
  );

  // THE FALSE FORM: with no plan at all, the same dial is neither refused nor dropped — so the two
  // readings above are the plan`s, not something a stand-in does on its own.
  const unplanned = createScriptedUpstream({ protocol: { initialTurnDetection: null } });
  const ordinary = unplanned.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let ordinaryErrors = 0;
  let ordinaryClosed = 0;
  ordinary.onerror = () => {
    ordinaryErrors += 1;
  };
  ordinary.onclose = () => {
    ordinaryClosed += 1;
  };
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ordinaryErrors, 0, 'an unplanned dial is not refused');
  unplanned.tick(60_000);
  assert.equal(ordinaryClosed, 0, 'and no clock drops it');
  assert.equal(unplanned.faults.plan(), null);
  assert.deepEqual(unplanned.faults.fired(), []);
});

test('F2 the plan`s drop triggers: the nth commit, a replay, and an interval', () => {
  // (a) the Nth COMMIT — dropped before it is answered, so no `committed` is ever said for it.
  const byCommit = createScriptedUpstream({
    protocol: { initialTurnDetection: null, commits: [{ itemId: 'item_a' }, { itemId: 'item_b' }] },
    faults: { dials: [{ dropBeforeCommit: 2 }] },
  });
  const socket = byCommit.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let closed = 0;
  socket.onclose = () => {
    closed += 1;
  };
  socket.send(JSON.stringify(HANDSHAKE));
  socket.send(JSON.stringify(COMMIT));
  const afterFirst = said(byCommit).filter((frame) => frame.type === 'input_audio_buffer.committed').length;
  assert.equal(afterFirst, 1, 'commit #1 was answered as usual');
  socket.send(JSON.stringify(COMMIT));
  assert.equal(closed, 1, 'commit #2 dropped the connection instead of being answered');
  assert.equal(
    said(byCommit).filter((frame) => frame.type === 'input_audio_buffer.committed').length,
    afterFirst,
    'and it was never answered — that is the whole point of dropping BEFORE the answer',
  );
  assert.equal(byCommit.protocol?.committed, 1, 'the endpoint`s own count never advanced for it');

  // (b) a REPLAY — audio this endpoint already answered on an earlier dial, committed again.
  const byReplay = createScriptedUpstream({
    protocol: { initialTurnDetection: null },
    faults: { dials: [{}, { dropOnReplay: true }] },
  });
  const original = byReplay.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  original.send(JSON.stringify(HANDSHAKE));
  original.send(JSON.stringify(audioOf(8)));
  original.send(JSON.stringify(COMMIT));
  assert.deepEqual(byReplay.faults.fired(), [], 'the first dial has nothing to drop');

  const replayed = byReplay.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let replayClosed = 0;
  replayed.onclose = () => {
    replayClosed += 1;
  };
  replayed.send(JSON.stringify(HANDSHAKE));
  replayed.send(JSON.stringify(audioOf(8)));
  assert.equal(replayClosed, 0, 'the replayed audio alone is not the trigger — the COMMIT is');
  replayed.send(JSON.stringify(COMMIT));
  assert.equal(replayClosed, 1, 'the replay`s commit dropped the connection');

  // (c) an INTERVAL on the injected clock — the 206 ms of the double-drop journal.
  const byTime = createScriptedUpstream({
    protocol: { initialTurnDetection: null },
    faults: { dials: [{ dropAfterCommitMs: { ordinal: 1, ms: 206 } }] },
  });
  const timed = byTime.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let timedClosed = 0;
  timed.onclose = () => {
    timedClosed += 1;
  };
  timed.send(JSON.stringify(HANDSHAKE));
  timed.send(JSON.stringify(COMMIT));
  assert.equal(timedClosed, 0, 'the commit itself is answered, not dropped');
  byTime.tick(205);
  assert.equal(timedClosed, 0, '205 ms in, nothing has happened');
  byTime.tick(206);
  assert.equal(timedClosed, 1, 'at 206 ms the endpoint is gone');

  // FALSE FORMS — each reading above is a function of the fault the plan names, not of "a commit
  // happened" or "a second dial happened":
  const wrongOrdinal = createScriptedUpstream({
    protocol: { initialTurnDetection: null },
    faults: { dials: [{ dropAfterCommitMs: { ordinal: 2, ms: 206 } }] },
  });
  const notTheCommit = wrongOrdinal.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let wrongClosed = 0;
  notTheCommit.onclose = () => {
    wrongClosed += 1;
  };
  notTheCommit.send(JSON.stringify(HANDSHAKE));
  notTheCommit.send(JSON.stringify(COMMIT));
  wrongOrdinal.tick(60_000);
  assert.equal(wrongClosed, 0, '(c) fired on commit #1 when the plan names commit #2 — so it did not fire');

  const notAReplay = createScriptedUpstream({
    protocol: { initialTurnDetection: null },
    faults: { dials: [{}, { dropOnReplay: true }] },
  });
  const one = notAReplay.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  one.send(JSON.stringify(HANDSHAKE));
  one.send(JSON.stringify(audioOf(8)));
  one.send(JSON.stringify(COMMIT));
  const two = notAReplay.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let notReplayClosed = 0;
  two.onclose = () => {
    notReplayClosed += 1;
  };
  two.send(JSON.stringify(HANDSHAKE));
  two.send(JSON.stringify(audioOf(9)));
  two.send(JSON.stringify(COMMIT));
  assert.equal(notReplayClosed, 0, '(b) new audio on the second dial is not a replay');
});

test('F3 the plan can lose events the endpoint already processed', () => {
  // (a) the commit is TAKEN and nothing is said about it — no `committed`, no item, no transcript —
  //     while the endpoint`s own state says the item exists. This is the "processed, then lost"
  //     window the double-drop journal`s second dial sat in.
  const lost = createScriptedUpstream({
    protocol: {
      initialTurnDetection: null,
      commits: [{ itemId: 'item_ghost', transcript: { kind: 'on-time', text: '听不见的' } }],
    },
    faults: { dials: [{ loseEventsOfCommit: 1 }] },
  });
  const ghost = lost.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  ghost.send(JSON.stringify(HANDSHAKE));
  ghost.send(JSON.stringify(COMMIT));
  assert.deepEqual(said(lost), [], 'the endpoint said nothing at all about the commit it took');
  assert.equal(lost.protocol?.committed, 1, 'and yet it took it');
  assert.deepEqual(lost.protocol?.items, ['item_ghost'], 'the item exists — on the endpoint`s side of the socket');

  // (b) the second shape: the model`s call goes out, and `response.done` — everything after it — is
  //     lost with the connection. This is what leaves a bridge replaying a segment whose tool call
  //     the session has already made.
  const calling: Record<string, unknown> = {
    initialTurnDetection: null,
    commits: [{ itemId: 'i', answer: { kind: 'function_call', name: 'session_send', args: { message: '已说过' } } }],
  };
  const cut = createScriptedUpstream({ protocol: calling, faults: { dials: [{ dropAfterFunctionCall: true }] } });
  const interrupted = cut.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let cutClosed = 0;
  interrupted.onclose = () => {
    cutClosed += 1;
  };
  interrupted.send(JSON.stringify(HANDSHAKE));
  interrupted.send(JSON.stringify(COMMIT));
  interrupted.send(JSON.stringify({ type: 'response.create' }));
  const cutTypes = said(cut).map((frame) => String(frame.type));
  assert.equal(cutTypes.includes('response.function_call_arguments.done'), true, 'the model`s call reached the client');
  assert.equal(cutTypes.includes('response.done'), false, '`response.done` is the event the loss took');
  assert.equal(cutClosed, 1, 'and the connection is what took it');

  // FALSE FORMS — the SAME two scenarios with that one fault pointed somewhere it does not belong:
  const otherOrdinal = createScriptedUpstream({
    protocol: { initialTurnDetection: null, commits: [{ itemId: 'item_ghost' }] },
    faults: { dials: [{ loseEventsOfCommit: 2 }] },
  });
  const kept = otherOrdinal.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  kept.send(JSON.stringify(HANDSHAKE));
  kept.send(JSON.stringify(COMMIT));
  assert.ok(
    said(otherOrdinal).some((frame) => frame.type === 'input_audio_buffer.committed'),
    '(a) commit #1 is answered when the plan names commit #2',
  );

  const whole = createScriptedUpstream({ protocol: calling });
  const plain = whole.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let plainClosed = 0;
  plain.onclose = () => {
    plainClosed += 1;
  };
  plain.send(JSON.stringify(HANDSHAKE));
  plain.send(JSON.stringify(COMMIT));
  plain.send(JSON.stringify({ type: 'response.create' }));
  assert.equal(
    said(whole).some((frame) => frame.type === 'response.done'),
    true,
    '(b) with no plan the `response.done` arrives as it always did',
  );
  assert.equal(plainClosed, 0, '(b) and nothing takes the connection');
});

test('F4 the plan can drop a single oversized append', () => {
  const armed = createScriptedUpstream({
    protocol: { initialTurnDetection: null },
    faults: { dials: [{ dropOnAppendBytesOver: 4 }] },
  });
  const socket = armed.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let closed = 0;
  socket.onclose = () => {
    closed += 1;
  };
  socket.send(JSON.stringify(HANDSHAKE));
  socket.send(JSON.stringify(audioOf(4)));
  assert.equal(closed, 0, 'exactly the ceiling is still accepted');
  socket.send(JSON.stringify(audioOf(5)));
  assert.equal(closed, 1, 'one byte over it ends the connection');
  assert.match(
    armed.faults.fired()[0]!.reason,
    /one append of 5 bytes is over the 4-byte ceiling/,
    'the fault names the size it refused, so a report can be read without re-measuring',
  );

  // THE FALSE FORM: the SAME two appends under a ceiling above both — the reading is a function of
  // the threshold, not of "a big append".
  const higher = createScriptedUpstream({
    protocol: { initialTurnDetection: null },
    faults: { dials: [{ dropOnAppendBytesOver: 64 }] },
  });
  const roomy = higher.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let roomyClosed = 0;
  roomy.onclose = () => {
    roomyClosed += 1;
  };
  roomy.send(JSON.stringify(HANDSHAKE));
  roomy.send(JSON.stringify(audioOf(4)));
  roomy.send(JSON.stringify(audioOf(5)));
  assert.equal(roomyClosed, 0, 'under the ceiling, both appends travel');
  assert.deepEqual(higher.faults.fired(), []);
});

test('F5 the plan`s clock is injected, never the wall clock', async () => {
  const clock = createScriptedFaultClock(1_000);
  const armed = createScriptedUpstream({
    protocol: { initialTurnDetection: null },
    faults: { clock, dials: [{ dropAfterCommitMs: { ordinal: 1, ms: 206 } }] },
  });
  const socket = armed.socketFactory(SCRIPTED_ENDPOINT_URL, {});
  let closed = 0;
  socket.onclose = () => {
    closed += 1;
  };
  socket.send(JSON.stringify(HANDSHAKE));
  socket.send(JSON.stringify(COMMIT));

  // THE FALSE FORM FIRST: real time passes and the interval — measured on the injected clock — does
  // not move. A plan wired to `Date.now()` would have dropped the connection during this wait, which
  // is exactly the flake this clock exists to remove.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(closed, 0, 'no wall clock reaches the plan');
  assert.equal(clock.now(), 1_000, 'the shared clock still reads the origin the scenario gave it');

  armed.tick(1_205);
  assert.equal(closed, 0, '205 ms on the injected clock is not 206');
  armed.tick(1_206);
  assert.equal(closed, 1, 'the plan fires at exactly its own reading');
  assert.equal(clock.now(), 1_206, 'and the scenario`s own clock is where it fired');
  assert.deepEqual(
    armed.faults.fired().map((record) => record.reason),
    ['commit #1 plus 206 ms'],
  );
});

type E2EScriptedServer = {
  armFaults(plan: unknown): void;
  faults(): unknown;
  dialFaults(): unknown;
  port(): number;
  close(): Promise<void>;
};

test('F6 the e2e server reads the same plan, and fires none of it', async () => {
  // An OPAQUE dynamic import: `e2e/` belongs to no typecheck program, and a static import here would
  // pull it into the server's. The module is loaded by url, so TypeScript never sees it.
  const e2ePath = path.resolve(HERE, '..', '..', '..', '..', 'e2e', 'voiceRealtimeScriptedUpstream.ts');
  const module = (await import(pathToFileURL(e2ePath).href)) as {
    startScriptedUpstream(port: number): Promise<E2EScriptedServer>;
  };
  const server = await module.startScriptedUpstream(0);
  try {
    assert.equal(server.faults(), null, 'nothing is armed until a scenario arms it');

    const plan = { dials: [{ disposition: { action: 'refuse' } }, { dropBeforeCommit: 1 }] };
    server.armFaults(plan);
    assert.deepEqual(server.faults(), plan, 'the e2e server reads the SAME plan an in-process criterion runs on');

    // A REAL dial, over the port it actually bound. Dial #1 must OPEN: the plan says `refuse`, and a
    // server that FIRED the plan would have terminated it before `open` — which is the false form.
    let opened = false;
    const first = new WS(`ws://127.0.0.1:${server.port()}`);
    await new Promise<void>((resolve, reject) => {
      first.once('open', () => {
        opened = true;
        resolve();
      });
      first.once('error', reject);
    });
    assert.equal(opened, true, 'the e2e server RECORDS the plan and never fires it');
    assert.deepEqual(server.dialFaults(), { disposition: { action: 'refuse' } }, 'dial #1 reads its own entry');

    const second = new WS(`ws://127.0.0.1:${server.port()}`);
    await new Promise<void>((resolve, reject) => {
      second.once('open', () => resolve());
      second.once('error', reject);
    });
    assert.deepEqual(server.dialFaults(), { dropBeforeCommit: 1 }, 'and dial #2 reads its own');
    assert.ok(second.readyState === WS.OPEN, 'a `dropBeforeCommit` dial is still open — nothing fired it');
    first.terminate();
    second.terminate();
  } finally {
    await server.close();
  }
});

// ── residue ─────────────────────────────────────────────────────────────────────────────────

test('the AC1 false form leaves none of this process`s copies behind', () => {
  const leftovers = readdirSync(HERE).filter(
    (name) => name.startsWith(TEMP_PREFIX) && name.endsWith(`-${process.pid}.ts`),
  );
  assert.deepEqual(leftovers, []);
});
