/**
 * When a segment stays on the device, and when it leaves — and how the user is told.
 *
 * WHAT IS UNDER TEST. `routeClientAsrSegment` is the whole policy: it asks the `sensevoice-wasm`
 * adapter for one clip and then decides whether to keep the answer or hand the segment to the server.
 * The probe's readings (`docs/experiments/2026-10-06-voice-client-asr-probe.md` §0.7, §现场) are why the
 * policy has exactly two exits — a device that cannot run the model at all, and one segment whose
 * realtime factor came out over 1.0 — and both are cases below.
 *
 * WHY THE PER-SEGMENT CASE IS THE ONE THAT MATTERS. The probe measured both real devices dropping to
 * four-to-nine times real time on consecutive segments (a screen off, a background tab) while their
 * AVERAGE stayed around 0.30 and 0.45. A policy that judged the average would keep every one of those
 * clips on a device that had stopped keeping up, and the queue would never drain. So the slow case
 * below runs three segments through the same engine: two comfortably under real time and one over it,
 * and asserts that the two stayed and the one left. An average-based policy cannot pass that case.
 *
 * THE NEGATIVE CONTROLS ARE THE POINT OF THE REST. A routing test that only showed "this one falls
 * back" would stay green for a policy that fell back on everything, so the same file also pins the
 * three readings that must NOT leave the device: a fast success, a client-side refusal
 * (`NO_SPEECH_DETECTED` — an answer about this clip, not a broken engine), and a container the engine
 * rejects. Each of those asserts zero events, which is the same assertion as "the audio did not go
 * anywhere".
 *
 * THE ENGINE IS A FAKE, AND THAT IS THE HONEST SHAPE. A real onnxruntime-web session needs a 239 MB
 * checkpoint, WASM SIMD and a worker; none of those is what this file is about, and the seam exists
 * precisely so the policy can be judged without them. What is real is everything the policy reads: the
 * registered adapter, the capability declaration it guards with, the error vocabulary, and the
 * `window` event.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listProviders } from '@shared/asr/asrRegistry';
import type { AsrInvocation, AsrRequest, AsrRuntimeStatus, AsrToken } from '@shared/asr/asrRegistry';
import {
  NO_ENGINE_REASON,
  installWasmEngine,
  type WasmEngineAnswer,
  type WasmEngineErrorCode,
  type WasmEnginePort,
  type WasmEngineRequest,
} from '@shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider';
import { parseTranscriptionResponse } from '@shared/asr/transcriptionWire';
import {
  CLIENT_ASR_FALLBACK_EVENT,
  VOICE_CLIENT_MODEL_BYTES,
  VOICE_CLIENT_READINESS_GRACE_MS,
  VOICE_CLIENT_RTF_THRESHOLD,
  createVoiceClientAsrEngine,
  routeClientAsrSegment,
  startVoiceClientAsrWorker,
  type VoiceClientEngineDeps,
  type VoiceClientFallbackDetail,
  type VoiceClientWorkerHandle,
  type VoiceClientWorkerReply,
  type VoiceClientWorkerRequest,
  type VoiceClientWorkerScope,
} from '@/shared/voiceClientAsrWorker';
import type { VoiceModelProgress } from '@/shared/voiceModelCache';
import { resolveVoiceFallbackProvider, setVoiceProviderProfile, setVoiceProviderRows, transcribeVoice } from '@/shared/api';
import type { VoiceClientReadiness, VoiceProviderRow } from '@/shared/types';
import { VOICE_FALLBACK_STORAGE_KEY } from '@/shared/voiceConfig';
import { voiceClientAssetPaths } from '@/shared/utils';

/** The build identity a fake engine reports; the routing forwards it without reading it. */
const BUILD_ID = 'ort-web 1.30.0 | sensevoice-small-int8-2024-07-17 | probe-v1 | sha256:c71f0ce00bec95b0';

/** The words a fast fake engine returns, with the token shape the declaration promises. */
const SPOKEN_TEXT = '检查 web server 进';

function spokenTokens(): AsrToken[] {
  return [
    { text: '检查', confidence: 0.94, startMs: 240 },
    { text: 'web', confidence: 0.91, startMs: 900 },
    { text: 'server', confidence: 0.88, startMs: 1200 },
    { text: '进', confidence: 0.9, startMs: 1800 },
  ];
}

/** One clip's worth of request; the engine is a fake, so the bytes only have to be accepted. */
function clip(): AsrRequest {
  return { audio: { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), mimeType: 'audio/wav', fileName: 'segment.wav' } };
}

/** A stand-in invocation: a client recogniser reaches no address, so only the deadline is read. */
function invocation(timeoutMs = 30_000): AsrInvocation {
  return { baseUrl: '', apiKey: '', model: '', timeoutMs, fetchImpl: (...args) => fetch(...args) };
}

type EngineOptions = {
  /** Whether the runtime says it can serve requests at all. */
  available?: boolean;
  /** The sentence an unavailable or failing engine gives. */
  reason?: string;
  /** What one request answers; the default is a fast success. */
  answer?: (request: WasmEngineRequest, index: number) => WasmEngineAnswer;
};

/** A scriptable `WasmEnginePort` plus the requests it was handed, which the cases assert on. */
function fakeEngine(options: EngineOptions = {}): { port: WasmEnginePort; calls: WasmEngineRequest[] } {
  const available = options.available ?? true;
  const status: AsrRuntimeStatus = available
    ? { available: true, state: 'ready', buildId: BUILD_ID }
    : { available: false, state: 'unavailable', reason: options.reason ?? 'the runtime did not start' };
  const calls: WasmEngineRequest[] = [];

  return {
    calls,
    port: {
      status: () => status,
      ensureReady: async () => status,
      transcribe: async (request) => {
        const index = calls.length;
        calls.push(request);
        if (options.answer !== undefined) return options.answer(request, index);
        return { ok: true, text: SPOKEN_TEXT, tokens: spokenTokens(), buildId: BUILD_ID, latencyMs: 300 };
      },
    },
  };
}

/** Every fallback announced on `window` during a case, in order. */
let announced: VoiceClientFallbackDetail[];
const listen = (event: Event) => announced.push((event as CustomEvent<VoiceClientFallbackDetail>).detail);

beforeEach(() => {
  announced = [];
  window.addEventListener(CLIENT_ASR_FALLBACK_EVENT, listen);
});

afterEach(() => {
  window.removeEventListener(CLIENT_ASR_FALLBACK_EVENT, listen);
  // The adapter holds the installed engine in a module-level slot, which is exactly what makes the
  // routing testable — and exactly what has to be cleared between cases.
  installWasmEngine(null);
  // The shared API module keeps the published rows and the effective profile in the same kind of
  // slot, and the fallback resolver reads the first of them. Both are cleared, so a case that
  // published a deployment cannot decide a later case's answer.
  setVoiceProviderRows([]);
  setVoiceProviderProfile(null);
  localStorage.removeItem(VOICE_FALLBACK_STORAGE_KEY);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the client ASR routing policy', () => {
  it('keeps a fast segment on the device, with its tokens and build identity', async () => {
    installWasmEngine(fakeEngine().port);

    const route = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });

    expect(route.to).toBe('client');
    if (route.to !== 'client' || !route.result.ok) throw new Error('expected a client-side success');
    expect(route.result.text).toBe(SPOKEN_TEXT);
    expect(route.result.providerId).toBe('sensevoice-wasm');
    // The token list and the build id are the two things the probe required of every recognition
    // record, so they are what this assertion holds the pass-through to.
    expect(route.result.tokens?.map((token) => [token.text, token.startMs])).toEqual([
      ['检查', 240],
      ['web', 900],
      ['server', 1200],
      ['进', 1800],
    ]);
    expect(route.result.meta?.buildId).toBe(BUILD_ID);
    expect(announced).toEqual([]);
  });

  it('falls back, out loud, when no engine is installed in this tab', async () => {
    // Nothing installed: the adapter's own fail-closed answer, which is the state of every deployment
    // that has not configured the client path.
    const route = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });

    expect(route).toMatchObject({ to: 'server', reason: 'engine-unavailable' });
    expect(announced).toHaveLength(1);
    expect(announced[0].reason).toBe('engine-unavailable');
    expect(announced[0].providerId).toBe('sensevoice-wasm');
    expect(announced[0].message).toContain('no on-device recogniser engine is installed');
    expect(NO_ENGINE_REASON).toContain('no on-device recogniser engine is installed');
  });

  it('falls back when the runtime says it cannot serve, and when a run fails on the device', async () => {
    // Two ways the engine is unavailable with one installed: it knows it cannot start, and it starts
    // but the run itself fails (the load paid inside `run`, a runtime that threw).
    installWasmEngine(fakeEngine({ available: false, reason: 'the browser refused the WASM runtime' }).port);
    const refused = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });
    expect(refused).toMatchObject({ to: 'server', reason: 'engine-unavailable' });

    installWasmEngine(
      fakeEngine({
        answer: () => ({ ok: false, code: 'ENGINE_UNAVAILABLE', message: 'the on-device runtime failed: boom' }),
      }).port,
    );
    const failed = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });
    expect(failed).toMatchObject({ to: 'server', reason: 'engine-unavailable' });

    expect(announced.map((detail) => detail.reason)).toEqual(['engine-unavailable', 'engine-unavailable']);
  });

  it('falls back for ONE slow segment while its neighbours stay, judged per segment and not on average', async () => {
    // The probe's real-device shape: two ordinary segments and one that took four times its length.
    // The three average to a realtime factor well under the threshold, so a policy that looked at the
    // average would keep the slow one — which is the behaviour this case exists to forbid.
    const latencies = [400, 4600, 500];
    const durations = [4, 2, 4];
    installWasmEngine(fakeEngine({ answer: (_request, index) => ({
      ok: true,
      text: SPOKEN_TEXT,
      tokens: spokenTokens(),
      buildId: BUILD_ID,
      latencyMs: latencies[index],
    }) }).port);
    const averageRtf = 4600 / 2000 / 3 + 400 / 4000 / 3 + 500 / 4000 / 3;
    expect(averageRtf).toBeLessThan(VOICE_CLIENT_RTF_THRESHOLD);

    const routes = [];
    for (let index = 0; index < latencies.length; index++) {
      routes.push(
        await routeClientAsrSegment({
          request: clip(),
          invocation: invocation(),
          durationSec: durations[index],
          segmentIndex: index,
        }),
      );
    }

    expect(routes.map((route) => route.to)).toEqual(['client', 'server', 'client']);
    expect(routes[1]).toMatchObject({ to: 'server', reason: 'segment-too-slow' });
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ reason: 'segment-too-slow', segmentIndex: 1, durationSec: 2, latencyMs: 4600 });
    // The sentence names the measurement, so the log says what tripped the threshold rather than only
    // that something did.
    expect(announced[0].message).toContain('4600 ms');
  });

  it('keeps a client-side refusal on the device instead of re-asking a server', async () => {
    // "Nothing was said" is an answer about the clip. Re-asking would spend a request on a question
    // that already has one — and would upload audio the user chose to keep here.
    installWasmEngine(
      fakeEngine({ answer: () => ({ ok: false, code: 'NO_SPEECH_DETECTED', message: 'no speech was recognised' }) }).port,
    );

    const route = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });

    expect(route.to).toBe('client');
    if (route.to !== 'client') throw new Error('expected the refusal to stay on the client');
    expect(route.result.ok).toBe(false);
    expect(announced).toEqual([]);
  });

  it('keeps the guard refusals on the device too: an unaccepted container never reaches the engine', async () => {
    // The seam's container guard runs before the engine, so a container this provider does not accept
    // produces no engine call at all and no fallback — the answer is this clip's, and the server would
    // refuse the same bytes.
    const engine = fakeEngine();
    installWasmEngine(engine.port);

    const route = await routeClientAsrSegment({
      request: { audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf', fileName: 'notes.pdf' } },
      invocation: invocation(),
      durationSec: 3,
    });

    expect(route).toMatchObject({ to: 'client', result: { ok: false, code: 'UNSUPPORTED_MIME' } });
    expect(engine.calls).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("does not call a segment slow when the engine reports no latency at all", async () => {
    // An engine that answers without a latency is not evidence of slowness; treating a missing
    // reading as a slow one would send every clip to the server on a runtime that simply omits it.
    installWasmEngine(
      fakeEngine({ answer: () => ({ ok: true, text: SPOKEN_TEXT, tokens: spokenTokens(), buildId: BUILD_ID }) }).port,
    );

    const route = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 0.5 });

    expect(route.to).toBe('client');
    expect(announced).toEqual([]);
  });

  it('carries the engine\'s own error code through when the engine is a subset it may report', async () => {
    // The port's failure codes are a subset of the seam's; whichever one the engine picks is what the
    // caller sees, unrewritten. `AUDIO_REJECTED` here is the "these bytes are not audio" answer.
    const code: WasmEngineErrorCode = 'AUDIO_REJECTED';
    installWasmEngine(fakeEngine({ answer: () => ({ ok: false, code, message: 'the clip is 48000 Hz' }) }).port);

    const route = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });

    expect(route).toMatchObject({ to: 'client', result: { ok: false, code: 'AUDIO_REJECTED' } });
    expect(announced).toEqual([]);
  });
});

describe('the client ASR deployment paths and readiness gate', () => {
  it('derives the same-origin asset paths from BASE_URL, prefix and all', () => {
    expect(voiceClientAssetPaths('/sub/')).toEqual({
      modelUrl: '/sub/voice-client/model/model.int8.onnx',
      tokensUrl: '/sub/voice-client/model/tokens.txt',
      ortScriptUrl: '/sub/voice-client/ort/ort.wasm.min.mjs',
      ortWasmPaths: '/sub/voice-client/ort/',
    });
    // The site-root deployment is the other shape `BASE_URL` takes; neither may come out
    // protocol-relative or with a doubled slash.
    expect(voiceClientAssetPaths('/').modelUrl).toBe('/voice-client/model/model.int8.onnx');
    expect(voiceClientAssetPaths(undefined).tokensUrl).toBe('/voice-client/model/tokens.txt');
  });

  it('refuses an unconfigured deployment as ENGINE_UNAVAILABLE, and fetches no model at all', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('the readiness gate must not start a download'));
    try {
      installWasmEngine(
        createVoiceClientAsrEngine({
          probe: async () => ({
            configured: false,
            directory: null,
            source: null,
            model: { name: 'model.int8.onnx', present: false, bytes: null, expectedBytes: VOICE_CLIENT_MODEL_BYTES },
            tokens: { name: 'tokens.txt', present: false, bytes: null, expectedBytes: null },
            ready: false,
          }),
        }),
      );

      const route = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });

      expect(route).toMatchObject({ to: 'server', reason: 'engine-unavailable' });
      if (route.to !== 'server') throw new Error('expected a server fallback');
      // The reason has to be actionable: the directory variable to set, and where the files come from.
      expect(route.message).toContain('VOICE_CLIENT_MODEL_DIR');
      expect(route.message).toContain('docs/operations/voice-client-asr-deployment.md');
      // The whole point of asking the server first: not one byte of `/voice-client/model/` is fetched.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses a directory missing a file, naming the file and the documentation, still fetching nothing', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('the readiness gate must not start a download'));
    const missingTokens: VoiceClientReadiness = {
      configured: true,
      directory: '/opt/sensevoice-model',
      source: 'VOICE_CLIENT_MODEL_DIR',
      model: {
        name: 'model.int8.onnx',
        present: true,
        bytes: VOICE_CLIENT_MODEL_BYTES,
        expectedBytes: VOICE_CLIENT_MODEL_BYTES,
      },
      tokens: { name: 'tokens.txt', present: false, bytes: null, expectedBytes: null },
      ready: false,
    };
    try {
      installWasmEngine(createVoiceClientAsrEngine({ probe: async () => missingTokens }));

      const route = await routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });

      expect(route).toMatchObject({ to: 'server', reason: 'engine-unavailable' });
      if (route.to !== 'server') throw new Error('expected a server fallback');
      expect(route.message).toContain('tokens.txt');
      expect(route.message).toContain('SENSEVOICE_MODEL_DIR');
      expect(route.message).toContain('docs/operations/voice-client-asr-deployment.md');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ── the first load, and the recogniser a given-up clip is handed to ───────────────────────────

/** The reading a provisioned deployment answers the readiness probe with. */
const READY_READING: VoiceClientReadiness = {
  configured: true,
  directory: '/opt/sensevoice-model',
  source: 'VOICE_CLIENT_MODEL_DIR',
  model: {
    name: 'model.int8.onnx',
    present: true,
    bytes: VOICE_CLIENT_MODEL_BYTES,
    expectedBytes: VOICE_CLIENT_MODEL_BYTES,
  },
  tokens: { name: 'tokens.txt', present: true, bytes: 1024, expectedBytes: null },
  ready: true,
};

/** One download reading, as the worker posts it while the model arrives. */
const DOWNLOAD_READING: VoiceModelProgress = {
  receivedBytes: 12_000_000,
  totalBytes: VOICE_CLIENT_MODEL_BYTES,
  bytesPerSec: 102_400,
  remainingMs: 2_040_000,
};

/**
 * The deployment's published recognisers, taken from the registry the build really ships.
 *
 * NEITHER ID IS WRITTEN IN THIS FILE, and that is what makes "not the on-device recogniser" a
 * reading about the registry rather than about a string this test invented: the case asserts the
 * upload is addressed to the local-`server` row, so a rename or a second local engine moves the
 * case with it instead of leaving it green against a payload nobody serves.
 */
function publishedRows(): { client: VoiceProviderRow; server: VoiceProviderRow } {
  const adapters = listProviders();
  const clientAdapter = adapters.find((adapter) => adapter.capabilities.locality === 'local-client');
  const serverAdapter = adapters.find((adapter) => adapter.capabilities.locality === 'local-server');
  if (!clientAdapter || !serverAdapter) {
    throw new Error('the registry no longer declares one recogniser of each local locality');
  }
  return {
    client: {
      id: clientAdapter.id,
      label: clientAdapter.id,
      configured: true,
      capabilities: clientAdapter.capabilities,
      // The on-device row is exactly the row that cannot take an upload: it is the recogniser that
      // gives up, so it must never be selected as where the sound goes instead.
      runtime: { available: false, state: 'unavailable', reason: 'this browser refused the WASM runtime' },
    },
    server: {
      id: serverAdapter.id,
      label: serverAdapter.id,
      configured: true,
      capabilities: serverAdapter.capabilities,
      // The reading a PROVISIONED deployment publishes: this is the row whose own engine has said it
      // can run. It is written out rather than read off `serverAdapter.runtime()`, because that
      // accessor answers about the engine installed in THIS process — none here — and the resolver
      // rightly refuses a row whose runtime says it cannot serve.
      runtime: { available: true, state: 'ready', buildId: 'fallback-build' },
    },
  };
}

type UploadCall = { url: string; headers: Record<string, string>; body: FormData };

/**
 * The network, doubled: the settings read the config module performs on first use, and the proxy
 * upload. Every upload is recorded with its headers, because the header is where the recogniser id
 * travels (`x-voice-provider`) — which is the whole reading these cases take.
 */
function stubVoiceNetwork(answerText: string): { uploads: UploadCall[] } {
  const uploads: UploadCall[] = [];
  const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/voice/config') {
      return new Response(
        JSON.stringify({ baseUrl: '', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    uploads.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as FormData,
    });
    return new Response(JSON.stringify({ text: answerText }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchStub);
  return { uploads };
}

/** The clip a segment carries; only its bytes and base type matter to the routing. */
function segmentBlob(): Blob {
  return new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'audio/wav' });
}

describe('the fallback a given-up segment is uploaded to', () => {
  it('addresses the upload to the deployment\'s server-side recogniser — never the on-device one — and reads its text back', async () => {
    const { client, server } = publishedRows();
    setVoiceProviderRows([client, server]);
    const { uploads } = stubVoiceNetwork('recognised by the fallback recogniser');

    // The deployment's own answer: the local-server recogniser, and pointedly not the browser one.
    expect(resolveVoiceFallbackProvider()).toBe(server.id);
    expect(resolveVoiceFallbackProvider()).not.toBe(client.id);

    const response = await transcribeVoice(segmentBlob(), 'segment-1.wav', 'listen-1', {
      kind: 'client-fallback',
      giveUpMessage: 'the on-device recogniser is still loading its model',
    });

    expect(uploads.map((call) => call.url)).toEqual(['/api/voice/transcribe']);
    expect(uploads[0].headers['x-voice-provider']).toBe(server.id);
    expect(uploads[0].headers['x-voice-provider']).not.toBe(client.id);
    // The text the fallback returned, read through the shipping parse rather than off the fixture.
    expect(await parseTranscriptionResponse(response, 'strict')).toBe('recognised by the fallback recogniser');
  });

  it('uploads NOTHING when the deployment publishes no recogniser that can take the clip', async () => {
    // Only the on-device recogniser is published — the deployment this defect was reported against.
    const { client } = publishedRows();
    setVoiceProviderRows([client]);
    const { uploads } = stubVoiceNetwork('this answer must never be reached');

    expect(resolveVoiceFallbackProvider()).toBeNull();

    const response = await transcribeVoice(segmentBlob(), 'segment-1.wav', 'listen-1', {
      kind: 'client-fallback',
      giveUpMessage: 'the on-device recogniser is still loading its model',
    });

    // The reading the criterion names: no transcription request at all. The audio stayed here.
    expect(uploads.filter((call) => call.url === '/api/voice/transcribe')).toEqual([]);
    expect(uploads).toEqual([]);
    // And the caller is told why rather than handed a silent empty answer.
    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });
});

describe('the relay context field on a proxy upload', () => {
  it('travels when the addressed recogniser declares that it honors context', async () => {
    const relay = listProviders().find((adapter) => adapter.id === 'dashscope-omni-relay');
    if (!relay) throw new Error('the relay recogniser is not registered');
    setVoiceProviderProfile({ id: relay.id, capabilities: relay.capabilities });
    const { uploads } = stubVoiceNetwork('整理后的文字');

    await transcribeVoice(
      segmentBlob(),
      'segment-1.wav',
      'listen-1',
      { kind: 'stored' },
      '用户：architecture tab 的节点看不出继承关系。',
    );

    expect(uploads).toHaveLength(1);
    expect(uploads[0].headers['x-voice-provider']).toBe(relay.id);
    expect(uploads[0].body.get('context')).toBe('用户：architecture tab 的节点看不出继承关系。');
  });

  it('is absent when the addressed recogniser does not acknowledge context', async () => {
    const ordinary = listProviders().find(
      (adapter) => adapter.capabilities.locality === 'remote' && !adapter.capabilities.honors.context,
    );
    if (!ordinary) throw new Error('the registry no longer declares a remote recogniser without context');
    setVoiceProviderProfile({ id: ordinary.id, capabilities: ordinary.capabilities });
    const { uploads } = stubVoiceNetwork('ordinary transcript');

    await transcribeVoice(
      segmentBlob(),
      'segment-1.wav',
      'listen-1',
      { kind: 'stored' },
      'this context must not be sent',
    );

    expect(uploads).toHaveLength(1);
    expect(uploads[0].body.get('context')).toBeNull();
  });
});

describe('a segment that arrives while the model is still downloading', () => {
  it('leaves the device inside the readiness grace — not after the 30 s segment timeout — and is recognised by the fallback', async () => {
    vi.useFakeTimers();

    // A worker that answers `init` with a download reading and then nothing at all: the model is
    // still arriving, which is the state the real worker is in for the whole of a 239 MB download.
    const posted: VoiceClientWorkerRequest[] = [];
    const listeners: ((event: { data: VoiceClientWorkerReply }) => void)[] = [];
    const handle: VoiceClientWorkerHandle = {
      postMessage: (message) => {
        posted.push(message);
        if (message.kind === 'init') {
          for (const listener of listeners) {
            listener({ data: { kind: 'progress', requestId: message.requestId, progress: DOWNLOAD_READING } });
          }
        }
      },
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
    };
    installWasmEngine(createVoiceClientAsrEngine({ probe: async () => READY_READING, spawn: () => handle }));

    const startedAt = Date.now();
    const routing = routeClientAsrSegment({ request: clip(), invocation: invocation(), durationSec: 3 });
    // Exactly the grace, and NOTHING more: the download never finishes, so the only thing that can
    // settle this segment is the grace expiring.
    await vi.advanceTimersByTimeAsync(VOICE_CLIENT_READINESS_GRACE_MS);
    const route = await routing;

    expect(route).toMatchObject({ to: 'server', reason: 'engine-unavailable' });
    if (route.to !== 'server') throw new Error('expected the segment to leave the device');
    // Under a second, asserted against the fake clock rather than by waiting one out — the whole
    // point being that the old behaviour spent the segment timeout (30 s) here.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // The reason says the model is being LOADED/DOWNLOADED, and carries the figures a user can act
    // on, rather than a bare state word.
    expect(route.message).toMatch(/loading its model|downloaded/);
    expect(route.message).toContain('12.0 MB');
    expect(route.message).toContain('239.2 MB');
    expect(route.message).toContain('100 KB/s');
    // Nothing was ever run on the device: the clip left before the engine was asked to transcribe.
    expect(posted.filter((message) => message.kind === 'run')).toEqual([]);

    // AND THE CLIP IS STILL RECOGNISED: the give-up is a hand-off, so the same segment is uploaded
    // to the fallback and its text is what the caller gets.
    vi.useRealTimers();
    const { client, server } = publishedRows();
    setVoiceProviderRows([client, server]);
    const { uploads } = stubVoiceNetwork('recognised by the fallback recogniser');
    const response = await transcribeVoice(segmentBlob(), 'segment-1.wav', 'listen-1', {
      kind: 'client-fallback',
      giveUpMessage: route.message,
    });
    expect(uploads[0].headers['x-voice-provider']).toBe(server.id);
    expect(await parseTranscriptionResponse(response, 'strict')).toBe('recognised by the fallback recogniser');
  });
});

describe('the worker reporting a first download', () => {
  /** The two ends of the worker channel, wired to each other in this thread. */
  function loopbackWorker(deps: VoiceClientEngineDeps): {
    handle: VoiceClientWorkerHandle;
    posted: VoiceClientWorkerRequest[];
  } {
    const toWorker: ((event: { data: VoiceClientWorkerRequest }) => void)[] = [];
    const toMain: ((event: { data: VoiceClientWorkerReply }) => void)[] = [];
    const posted: VoiceClientWorkerRequest[] = [];
    const handle: VoiceClientWorkerHandle = {
      postMessage: (message) => {
        posted.push(message);
        for (const listener of [...toWorker]) listener({ data: message });
      },
      addEventListener: (_type, listener) => {
        toMain.push(listener);
      },
    };
    const scope: VoiceClientWorkerScope = {
      postMessage: (reply) => {
        for (const listener of [...toMain]) listener({ data: reply });
      },
      addEventListener: (_type, listener) => {
        toWorker.push(listener);
      },
    };
    // The REAL worker body, driven over this channel: the protocol is exercised on both ends.
    startVoiceClientAsrWorker(scope, deps);
    return { handle, posted };
  }

  /** A `fetch` that streams the model in chunks, so the download loop reports more than once. */
  function streamingModelFetch(chunks: number, chunkBytes: number): typeof fetch {
    let index = 0;
    return (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        getReader: () => ({
          read: async () => {
            // THE COUNTER MUST ADVANCE, or the download loop reads forever and takes the process with
            // it: `read` is the only thing that can say "no more", and a stub that always answers
            // `done: false` is an unbounded stream rather than a download of `chunks` chunks.
            if (index >= chunks) return { done: true, value: undefined };
            index += 1;
            return { done: false, value: new Uint8Array(chunkBytes) };
          },
        }),
      },
    })) as unknown as typeof fetch;
  }

  it('posts a progress message per chunk during init, and the subscriber never sees the reading walk backwards', async () => {
    const readings: VoiceModelProgress[] = [];
    const { handle, posted } = loopbackWorker({
      cacheEnv: { fetchImpl: streamingModelFetch(3, 64 * 1024), cachesImpl: null },
    });
    const engine = createVoiceClientAsrEngine({
      spawn: () => handle,
      probe: async () => READY_READING,
      onProgress: (reading) => readings.push(reading),
    });

    // One init, and the download it starts. (The placeholder bytes are not the 239 MB checkpoint, so
    // the load itself ends in the length check — the readings taken on the way are the subject here.)
    await engine.ensureReady();

    expect(posted.filter((message) => message.kind === 'init')).toHaveLength(1);
    expect(readings.length).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < readings.length; index++) {
      expect(readings[index].totalBytes).toBe(VOICE_CLIENT_MODEL_BYTES);
      if (index > 0) {
        expect(readings[index].receivedBytes).toBeGreaterThanOrEqual(readings[index - 1].receivedBytes);
      }
    }
  });
});

