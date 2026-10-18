/**
 * The HTTP-layer Live Voice diagnosis, offline: a fake DashScope upstream behind the REAL
 * transport and the REAL proxy, and the route mounted on a real express app.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import {
  DEFAULT_SESSION_DEFAULTS,
  DEFAULT_TURN_DETECTION,
  createDashscopeTransport,
  resolveTurnDetection,
  type DashscopeWireObserver,
  type RealtimeToolExecutor,
  type TurnDetectionOverride,
} from '../index.js';
import { parseWavPcm16, runVoiceRealtimeDiagnosis, summarizeWireObservation } from '../voice-realtime-diagnose.service.js';
import { VOICE_REALTIME_INSTRUCTIONS } from '../voice-realtime-ws-proxy.service.js';
import { createVoiceRealtimeRouter } from '../voice-realtime.routes.js';

import { createFakeDashscopeServer } from './voice-realtime-dashscope-harness.js';

/** A mono 16 kHz PCM16 WAV of `seconds` of a tone. */
function makeWav(seconds: number, overrides: { sampleRate?: number; channels?: number } = {}): Buffer {
  const sampleRate = overrides.sampleRate ?? 16_000;
  const channels = overrides.channels ?? 1;
  const samples = Math.floor(sampleRate * seconds) * channels;
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(index / 8) * 8000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A fake upstream that, on the first audio frame, transcribes then calls `session_send` with no session. */
function seamsFor(upstream: ReturnType<typeof createFakeDashscopeServer>, sends: Array<Record<string, unknown>>) {
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push(args);
      return { runId: 'r', queued: false };
    },
  };
  return {
    buildSeams: (observe: DashscopeWireObserver) => ({
      createTransport: (reportError: (error: { code: string } & Record<string, unknown>) => void) =>
        createDashscopeTransport({ apiKey: 'sk-test', socketFactory: upstream.socketFactory, onError: reportError, observer: observe }),
      createExecutor: () => executor,
      instructions: VOICE_REALTIME_INSTRUCTIONS,
    }),
  };
}

const INPUT = { boundSessionId: 'sess', speed: 8, quietMs: 600, maxMs: 15_000 };

/**
 * The AC2 seam builder: it does exactly what `server/index.ts`'s assembly point does — resolves the run
 * override with the SAME resolver the environment is read with, and splices the result into the
 * transport's session defaults — so a value that is refused there lands as the default here, on the real
 * frame, rather than being applied.
 */
function seamsForTurnDetection(
  upstream: ReturnType<typeof createFakeDashscopeServer>,
  sends: Array<Record<string, unknown>> = [],
) {
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => {
      sends.push(args);
      return { runId: 'r', queued: false };
    },
  };
  return {
    buildSeams: (observe: DashscopeWireObserver, turnDetection?: TurnDetectionOverride) => ({
      createTransport: (reportError: (error: { code: string } & Record<string, unknown>) => void) =>
        createDashscopeTransport({
          apiKey: 'sk-test',
          socketFactory: upstream.socketFactory,
          onError: reportError,
          observer: observe,
          sessionDefaults: { ...DEFAULT_SESSION_DEFAULTS, turn_detection: resolveTurnDetection(process.env, turnDetection).turnDetection },
        }),
      createExecutor: () => executor,
      instructions: VOICE_REALTIME_INSTRUCTIONS,
    }),
  };
}

/** The `turn_detection` of the first `session.update` the transport emitted upstream, or null. */
function turnDetectionUpstream(upstream: ReturnType<typeof createFakeDashscopeServer>): Record<string, unknown> | null {
  const update = upstream.sent.find((frame) => frame.type === 'session.update');
  const session = update?.session as Record<string, unknown> | undefined;
  return (session?.turn_detection as Record<string, unknown>) ?? null;
}

test('a heard and answered run reports ok, with the transcription and the wire timeline', async () => {
  const upstream = createFakeDashscopeServer({
    toolName: 'session_send',
    toolArguments: JSON.stringify({ message: 'do the thing' }),
  });
  const sends: Array<Record<string, unknown>> = [];
  const original = upstream.socketFactory;
  // Interleave a transcription before the call, as the real endpoint does.
  const withTranscript: typeof original = (url, headers) => {
    const socket = original(url, headers);
    const send = socket.send.bind(socket);
    let spoke = false;
    socket.send = (data: string) => {
      send(data);
      if (!spoke && (JSON.parse(data) as { type: string }).type === 'input_audio_buffer.append') {
        spoke = true;
        upstream.peerSend({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'hello there' });
      }
    };
    return socket;
  };
  const report = await runVoiceRealtimeDiagnosis(
    { ...INPUT, pcm16: (parseWavPcm16(makeWav(1)) as { pcm16: Buffer }).pcm16 },
    seamsFor({ ...upstream, socketFactory: withTranscript } as typeof upstream, sends),
  );
  assert.equal(report.heard, true);
  assert.equal(report.answered, true);
  assert.equal(report.ok, true);
  assert.deepEqual(report.captions, ['hello there']);
  assert.deepEqual(sends.map((args) => args.message), ['do the thing']);
  assert.ok(report.wire.some((entry) => entry.summary.startsWith('session.update voice=Tina')));
  assert.ok(report.wire.some((entry) => entry.summary.startsWith('function_call session_send')));
});

test('audio that is heard but never acted on is reported as exactly that', async () => {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const original = upstream.socketFactory;
  const talkOnly: typeof original = (url, headers) => {
    const socket = original(url, headers);
    const send = socket.send.bind(socket);
    let spoke = false;
    socket.send = (data: string) => {
      send(data);
      if (!spoke && (JSON.parse(data) as { type: string }).type === 'input_audio_buffer.append') {
        spoke = true;
        upstream.peerSend({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: '把。' });
      }
    };
    return socket;
  };
  const report = await runVoiceRealtimeDiagnosis(
    { ...INPUT, pcm16: (parseWavPcm16(makeWav(1)) as { pcm16: Buffer }).pcm16 },
    seamsFor({ ...upstream, socketFactory: talkOnly } as typeof upstream, []),
  );
  assert.equal(report.heard, true);
  assert.equal(report.answered, false);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => /never called session_send/.test(problem)), report.problems.join('|'));
});

test('silence from the upstream is reported as not heard', async () => {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const report = await runVoiceRealtimeDiagnosis(
    { ...INPUT, pcm16: (parseWavPcm16(makeWav(1)) as { pcm16: Buffer }).pcm16 },
    seamsFor(upstream, []),
  );
  assert.equal(report.heard, false);
  assert.ok(report.problems.some((problem) => /no final transcription/.test(problem)));
});

test('parseWavPcm16 refuses what the session cannot take, naming why', () => {
  assert.ok('pcm16' in parseWavPcm16(makeWav(0.2)));
  assert.match((parseWavPcm16(makeWav(0.2, { sampleRate: 44_100 })) as { error: string }).error, /44100 Hz/);
  assert.match((parseWavPcm16(makeWav(0.2, { channels: 2 })) as { error: string }).error, /2 ch/);
  assert.match((parseWavPcm16(Buffer.from('not a wav at all, definitely not, no sir not at all ok')) as { error: string }).error, /RIFF/);
});

test('summarizeWireObservation drops audio and interim deltas and keeps the facts', () => {
  assert.equal(summarizeWireObservation({ direction: 'sent', wire: { type: 'input_audio_buffer.append', audio: 'AAAA' } }), null);
  assert.equal(
    summarizeWireObservation({ direction: 'received', wire: { type: 'conversation.item.input_audio_transcription.delta', stash: 'x' } }),
    null,
  );
  assert.match(
    summarizeWireObservation({ direction: 'received', wire: { type: 'error', error: { message: "Voice 'Chelsie' is not supported." } } }) ?? '',
    /ERROR .*Chelsie/,
  );
  assert.match(
    summarizeWireObservation({ direction: 'received', wire: { type: 'response.done', response: { status: 'failed', status_details: { type: 'failed' } } } }) ?? '',
    /status=failed/,
  );
});

// AC5 (this task): the item/response lifecycles and the audio-token reading, so a no-audio
// `conversation.item.created` can be named. Provenance: the 2026-10-11 duplicate-send journal
// (57279cc1) recorded the repeat only as a bare `conversation.item.created`, with nothing to say
// which item it was, which response carried it, or that its `audioTokens` (259) proved no new audio.
test('AC5: item/response ids and the audio-token reading are surfaced on the wire summary', () => {
  const item = summarizeWireObservation({
    direction: 'received',
    wire: {
      type: 'conversation.item.created',
      previous_item_id: 'item-0',
      item: { id: 'item-1', type: 'message', role: 'assistant', call_id: 'call-9' },
    },
  });
  assert.ok(item);
  assert.match(item, /item\.id=item-1/);
  assert.match(item, /item\.type=message/);
  assert.match(item, /item\.role=assistant/);
  assert.match(item, /item\.call_id=call-9/);
  assert.match(item, /previous_item_id=item-0/);

  const created = summarizeWireObservation({ direction: 'received', wire: { type: 'response.created', response: { id: 'resp-1' } } });
  assert.ok(created);
  assert.match(created, /response\.id=resp-1/);

  const done = summarizeWireObservation({
    direction: 'received',
    wire: {
      type: 'response.done',
      response: { status: 'completed', usage: { input_tokens: 300, output_tokens: 12, input_tokens_details: { audio_tokens: 259 } } },
    },
  });
  assert.ok(done);
  assert.match(done, /in=300/);
  assert.match(done, /out=12/);
  assert.match(done, /audio=259/);
});

test('the route validates its input and defaults to a dry run', async () => {
  const seen: Array<{ dryRun: boolean; sessionId: string; bytes: number }> = [];
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    '/api/voice-realtime',
    createVoiceRealtimeRouter({
      diagnose: async (input, options) => {
        seen.push({ dryRun: options.dryRun, sessionId: input.boundSessionId, bytes: input.pcm16.length });
        return { ok: true, heard: true, answered: true, elapsedMs: 1, captions: [], interimCaptionCount: 0, audioChunksSent: 0, audioFramesUpstream: 0, audioSecondsUpstream: 0, segments: [], rotations: [], usage: { responses: 0, inputTokens: 0, outputTokens: 0 }, turns: [], frames: [], wire: [], problems: [] };
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  // `node:http`, not `fetch`: an ephemeral port can land on one undici refuses ("bad port").
  const post = (body: unknown): Promise<{ status: number }> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/api/voice-realtime/diagnose', method: 'POST', headers: { 'content-type': 'application/json' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode ?? 0 }));
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
  try {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ sessionId: 's' })).status, 400);
    assert.equal((await post({ sessionId: 's', audioBase64: Buffer.from('garbage').toString('base64') })).status, 400);
    const good = await post({ sessionId: 's', audioBase64: makeWav(0.5).toString('base64') });
    assert.equal(good.status, 200);
    assert.deepEqual(seen, [{ dryRun: true, sessionId: 's', bytes: 16_000 }]);
    await post({ sessionId: 's', audioBase64: makeWav(0.5).toString('base64'), dryRun: false });
    assert.equal(seen[1]!.dryRun, false);
  } finally {
    server.close();
  }
});

/** A scripted upstream for a multi-turn run: every `period` audio frames it transcribes and calls session_send. */
function scriptedTurnsUpstream(period: number, texts: string[], options: { silentTurn?: number } = {}) {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const original = upstream.socketFactory;
  let frames = 0;
  const factory: typeof original = (url, headers) => {
    const socket = original(url, headers);
    const send = socket.send.bind(socket);
    socket.send = (data: string) => {
      send(data);
      if ((JSON.parse(data) as { type: string }).type !== 'input_audio_buffer.append') return;
      frames += 1;
      if (frames % period !== 5) return;
      const turn = Math.floor(frames / period);
      if (turn === options.silentTurn) return;
      const text = texts[turn] ?? `turn ${turn}`;
      upstream.peerSend({ type: 'conversation.item.input_audio_transcription.completed', item_id: `i${turn}`, transcript: text });
      upstream.peerSend({
        type: 'response.function_call_arguments.done',
        call_id: `call-${turn}`,
        name: 'session_send',
        arguments: JSON.stringify({ message: text }),
      });
    };
    return socket;
  };
  return { ...upstream, socketFactory: factory } as typeof upstream;
}

test('a multi-turn script is read turn by turn: what each was heard as and what it sent', async () => {
  const upstream = scriptedTurnsUpstream(25, ['一', '二', '三']);
  const executor: RealtimeToolExecutor = {
    session_send: async (args: Record<string, unknown>) => ({ runId: 'dry-run', wouldSend: args }),
  };
  const clip = (parseWavPcm16(makeWav(1)) as { pcm16: Buffer }).pcm16;
  const report = await runVoiceRealtimeDiagnosis(
    { ...INPUT, pcm16: clip, turns: [clip, clip, clip].map((pcm16) => ({ pcm16, gapMs: 50 })) },
    {
      buildSeams: (observe) => ({
        createTransport: (reportError) => createDashscopeTransport({ apiKey: 'sk-test', socketFactory: upstream.socketFactory, onError: reportError, observer: observe }),
        createExecutor: () => executor,
        instructions: VOICE_REALTIME_INSTRUCTIONS,
      }),
    },
  );
  assert.equal(report.turns.length, 3);
  assert.deepEqual(report.turns.map((turn) => turn.captions), [['一'], ['二'], ['三']]);
  assert.deepEqual(report.turns.map((turn) => turn.sentMessages), [['一'], ['二'], ['三']]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
});

test('a script names the turn that went silent instead of failing the whole run vaguely', async () => {
  const upstream = scriptedTurnsUpstream(25, ['一', '二', '三'], { silentTurn: 1 });
  const executor: RealtimeToolExecutor = { session_send: async (args: Record<string, unknown>) => ({ wouldSend: args }) };
  const clip = (parseWavPcm16(makeWav(1)) as { pcm16: Buffer }).pcm16;
  const report = await runVoiceRealtimeDiagnosis(
    { ...INPUT, pcm16: clip, turns: [clip, clip, clip].map((pcm16) => ({ pcm16, gapMs: 50 })) },
    {
      buildSeams: (observe) => ({
        createTransport: (reportError) => createDashscopeTransport({ apiKey: 'sk-test', socketFactory: upstream.socketFactory, onError: reportError, observer: observe }),
        createExecutor: () => executor,
        instructions: VOICE_REALTIME_INSTRUCTIONS,
      }),
    },
  );
  assert.equal(report.ok, false);
  assert.deepEqual(report.turns.map((turn) => turn.heard), [true, false, true]);
  assert.ok(report.problems.some((problem) => /turn 2: not transcribed/.test(problem)), report.problems.join('|'));
});

test('the route accepts a turns script and refuses a malformed one', async () => {
  const seen: Array<number> = [];
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    '/api/voice-realtime',
    createVoiceRealtimeRouter({
      diagnose: async (input) => {
        seen.push(input.turns?.length ?? 0);
        return { ok: true, heard: true, answered: true, elapsedMs: 1, captions: [], interimCaptionCount: 0, audioChunksSent: 0, audioFramesUpstream: 0, audioSecondsUpstream: 0, segments: [], rotations: [], usage: { responses: 0, inputTokens: 0, outputTokens: 0 }, turns: [], frames: [], wire: [], problems: [] };
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const post = (body: unknown): Promise<number> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/api/voice-realtime/diagnose', method: 'POST', headers: { 'content-type': 'application/json' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
  const wav = makeWav(0.5).toString('base64');
  try {
    assert.equal(await post({ sessionId: 's', turns: [] }), 400);
    assert.equal(await post({ sessionId: 's', turns: Array.from({ length: 9 }, () => ({ audioBase64: wav })) }), 400);
    assert.equal(await post({ sessionId: 's', turns: [{ audioBase64: Buffer.from('nope').toString('base64') }] }), 400);
    assert.equal(await post({ sessionId: 's', turns: [{ audioBase64: wav }, { audioBase64: wav, gapMs: 200 }] }), 200);
    assert.deepEqual(seen, [2]);
  } finally {
    server.close();
  }
});

// ── AC2: the per-run turnDetection override reaches the upstream session.update frame ─────────────

test('AC2: a per-run turnDetection override lands on the upstream session.update frame', async () => {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const report = await runVoiceRealtimeDiagnosis(
    {
      ...INPUT,
      pcm16: (parseWavPcm16(makeWav(1)) as { pcm16: Buffer }).pcm16,
      turnDetection: { type: 'semantic_vad', silenceMs: 800, threshold: 0.7 },
    },
    seamsForTurnDetection(upstream),
  );
  assert.deepEqual(turnDetectionUpstream(upstream), {
    type: 'semantic_vad',
    threshold: 0.7,
    silence_duration_ms: 800,
    // The transport's composer appends this to every session.update (GOAL-046).
    interrupt_response: false,
  });
  // The override did not disturb the rest of the session body.
  assert.ok(report.wire.some((entry) => entry.summary.startsWith('session.update voice=Tina')));
});

test('AC2: an out-of-range override falls back to the deployment default, by the same rules as the env knob', async () => {
  const upstream = createFakeDashscopeServer({ functionCallAfterAudioFrames: 1_000_000 });
  const override: TurnDetectionOverride = { silenceMs: 999_999 };
  await runVoiceRealtimeDiagnosis(
    { ...INPUT, pcm16: (parseWavPcm16(makeWav(1)) as { pcm16: Buffer }).pcm16, turnDetection: override },
    seamsForTurnDetection(upstream),
  );
  // Never applied — refused down to the shipped default on the real frame...
  assert.deepEqual(turnDetectionUpstream(upstream), { ...DEFAULT_TURN_DETECTION, interrupt_response: false });
  // ...and reported by the very resolver the assembly point uses.
  assert.notEqual(resolveTurnDetection(process.env, override).invalid, null);
});
