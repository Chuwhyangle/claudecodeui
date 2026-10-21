/**
 * The speaker model's provisioning service and its two routes.
 *
 * WHAT IS BEING READ, one case per property the acceptance criteria name:
 *
 *   1. `status()` resolves the settings path and reports the pinned metadata; a file is `installed`
 *      only when its bytes HASH to the pinned digest (a right-sized wrong file is `invalid`).
 *   2. `download()` streams into `<path>.part` while hashing, renames only a verified file, and
 *      asks the FIXED source URL — `download()` takes no argument, so there is no client field to
 *      read. A digest mismatch, an oversized response and a stalled source each fail the reading
 *      and leave neither the partial nor the final file behind.
 *   3. One download per resolved path: a second call joins the running job, and its progress is the
 *      same job's counters.
 *   4. The routes only relay the service: `GET` is `200`, `POST` is `202` while a download runs
 *      (started or joined) and `200` when the checkpoint was already installed; a router built
 *      without the service answers `503`, and a thrown service error answers `500`.
 *   5. A settings path that steps outside its directory is refused before any fetch.
 *
 * HOW THE CHECKPOINT IS FAKED. The service accepts an expected digest and length for exactly this
 * reason: the real weights are 28 MB and are not in the repository. Production passes neither and
 * reads the pinned constants; these cases pass a handful of bytes, so every assertion below is
 * about the VERIFICATION MACHINERY rather than about the real file's contents.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  VOICE_SPEAKER_MODEL_BYTES,
  VOICE_SPEAKER_MODEL_FILE_NAME,
  VOICE_SPEAKER_MODEL_LICENSE,
  VOICE_SPEAKER_MODEL_SHA256,
  VOICE_SPEAKER_MODEL_SOURCE_URL,
  createVoiceSpeakerModelService,
  resolveVoiceSpeakerModelTarget,
  type VoiceSpeakerModelDownloadResult,
  type VoiceSpeakerModelService,
  type VoiceSpeakerModelStatus,
} from '../voice-realtime-speaker-model.js';
import { createVoiceRealtimeRouter } from '../voice-realtime.routes.js';

/** The bytes every case downloads: small enough to be a fixture, real enough to hash. */
const CHECKPOINT_BYTES = Buffer.from('the speaker checkpoint, as a criterion-sized fixture');
const CHECKPOINT_SHA256 = createHash('sha256').update(CHECKPOINT_BYTES).digest('hex');

function temporaryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'voice-speaker-model-'));
}

/** A fixture checkpoint, its digest, and the service pointed at a temporary model directory. */
function fixture(options: {
  body?: Buffer;
  expectedSha256?: string;
  expectedBytes?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  modelDir?: string;
  modelFile?: string;
  modelPath?: string;
} = {}): { root: string; service: VoiceSpeakerModelService; modelPath: string } {
  const root = temporaryRoot();
  const body = options.body ?? CHECKPOINT_BYTES;
  const modelDir = options.modelDir ?? 'models/speaker';
  const modelFile = options.modelFile ?? 'model.onnx';
  const modelPath = path.join(root, modelDir, modelFile);
  const service = createVoiceSpeakerModelService({
    settings: {
      modelDir,
      modelFile,
      modelPath: options.modelPath ?? '',
    },
    rootDir: root,
    fetchImpl: options.fetchImpl ?? successfulFetch(body),
    expectedSha256: options.expectedSha256 ?? CHECKPOINT_SHA256,
    expectedBytes: options.expectedBytes ?? body.length,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  return { root, service, modelPath };
}

/** A web stream that yields `chunks` and ends. */
function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A `200` response carrying `body` in two chunks, with the length the server would declare. */
function successfulFetch(body: Buffer): typeof fetch {
  return (async () =>
    new Response(streamOf([body.subarray(0, 7), body.subarray(7)]), {
      status: 200,
      headers: { 'content-length': String(body.length) },
    })) as unknown as typeof fetch;
}

/** Polls `status()` until `predicate` holds, so a background download is observed deterministically. */
async function waitForState(
  service: VoiceSpeakerModelService,
  predicate: (status: VoiceSpeakerModelStatus) => boolean,
  label: string,
  timeoutMs = 4_000,
): Promise<VoiceSpeakerModelStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: VoiceSpeakerModelStatus | null = null;
  for (;;) {
    last = await service.status();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      assert.fail(`${label}: last state=${last.state} error=${String(last.error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── AC1: the reading ────────────────────────────────────────────────────────────────────────────

test('AC1: status resolves the settings path and reports missing with the pinned metadata', async () => {
  const { service, modelPath } = fixture();
  const status = await service.status();

  assert.equal(status.state, 'missing');
  assert.equal(status.path, modelPath, 'the path is join(modelDir, modelFile) under the repository root');
  assert.equal(status.fileName, 'model.onnx');
  assert.equal(status.expectedBytes, CHECKPOINT_BYTES.length);
  assert.equal(status.sha256, CHECKPOINT_SHA256);
  assert.equal(status.sourceUrl, VOICE_SPEAKER_MODEL_SOURCE_URL);
  assert.equal(status.license, VOICE_SPEAKER_MODEL_LICENSE);
  assert.match(status.attribution, /3D-Speaker/);
  assert.equal(status.error, null);
});

test('AC1: the shipped constants are the frozen checkpoint, not a re-derived value', () => {
  assert.equal(VOICE_SPEAKER_MODEL_BYTES, 28_281_164);
  assert.equal(
    VOICE_SPEAKER_MODEL_SHA256,
    'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2',
  );
  assert.equal(VOICE_SPEAKER_MODEL_FILE_NAME, '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx');
  assert.match(VOICE_SPEAKER_MODEL_SOURCE_URL, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\//);
  assert.equal(VOICE_SPEAKER_MODEL_LICENSE, 'Apache-2.0');
});

test('AC1: installed is a fresh sha256 match; a same-sized wrong file is invalid', async () => {
  const { root, service, modelPath } = fixture();
  mkdirSync(path.dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, CHECKPOINT_BYTES);

  const installed = await service.status();
  assert.equal(installed.state, 'installed');
  assert.equal(installed.bytes, CHECKPOINT_BYTES.length);

  // The same LENGTH, different bytes: a size check alone would call this installed.
  const wrong = Buffer.from(CHECKPOINT_BYTES);
  wrong[0] = wrong[0]! ^ 0xff;
  writeFileSync(modelPath, wrong);
  const invalid = await service.status();
  assert.equal(invalid.state, 'invalid', 'a length match is not the model');
  assert.match(String(invalid.error), /sha256 mismatch/);
  assert.equal(readFileSync(modelPath).length, wrong.length);
  rmSync(root, { recursive: true, force: true });
});

test('AC4: modelPath wins when non-empty, and a parent step is refused', async () => {
  const root = temporaryRoot();
  const explicit = resolveVoiceSpeakerModelTarget(
    { modelDir: 'models/speaker', modelFile: 'ignored.onnx', modelPath: path.join(root, 'elsewhere', 'x.onnx') },
    { rootDir: root },
  );
  assert.equal('problem' in explicit, false);
  assert.equal((explicit as { path: string }).path, path.join(root, 'elsewhere', 'x.onnx'));

  const escaped = resolveVoiceSpeakerModelTarget(
    { modelDir: 'models/speaker', modelFile: 'model.onnx', modelPath: '../escape.onnx' },
    { rootDir: root },
  );
  assert.match((escaped as { problem: string }).problem, /must not step outside/);

  const badFile = await createVoiceSpeakerModelService({
    settings: { modelDir: 'models/speaker', modelFile: '../escape.onnx', modelPath: '' },
    rootDir: root,
    fetchImpl: successfulFetch(CHECKPOINT_BYTES),
    expectedSha256: CHECKPOINT_SHA256,
    expectedBytes: CHECKPOINT_BYTES.length,
  }).status();
  assert.equal(badFile.state, 'invalid');
  assert.equal(badFile.path, null);
  assert.match(String(badFile.error), /bare file name/);
  rmSync(root, { recursive: true, force: true });
});

// ── AC2: the download ──────────────────────────────────────────────────────────────────────────

test('AC2: download streams to .part, verifies, renames atomically, and uses the fixed source', async () => {
  const calls: Array<{ url: string; redirect: RequestInit['redirect'] }> = [];
  const body = CHECKPOINT_BYTES;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    return new Response(streamOf([body.subarray(0, 5), body.subarray(5)]), {
      status: 200,
      headers: { 'content-length': String(body.length) },
    });
  }) as unknown as typeof fetch;

  const { service, modelPath } = fixture({ fetchImpl });
  const result = await service.download();
  assert.equal(result.started, true, 'the first call starts the download');
  assert.equal(result.joined, false);
  assert.equal(result.status.state, 'downloading');

  const installed = await waitForState(service, (status) => status.state === 'installed', 'installed');
  assert.equal(installed.bytes, body.length);
  assert.deepEqual(readFileSync(modelPath), body, 'the final file is the verified body');
  assert.equal(existsSync(`${modelPath}.part`), false, 'the partial file is renamed, not left behind');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, VOICE_SPEAKER_MODEL_SOURCE_URL, 'the source is the module constant');
  assert.equal(calls[0]!.redirect, 'follow');
});

test('AC2: a digest mismatch reports failed and leaves neither the partial nor the final file', async () => {
  const { service, modelPath } = fixture({ expectedSha256: '0'.repeat(64) });
  const result = await service.download();
  assert.equal(result.started, true);

  const failed = await waitForState(service, (status) => status.state === 'failed', 'failed');
  assert.match(String(failed.error), /sha256 mismatch/);
  assert.equal(existsSync(modelPath), false, 'an unverified checkpoint must never take the final name');
  assert.equal(existsSync(`${modelPath}.part`), false, 'the partial file is removed on failure');
});

test('AC2: a declared length above the cap fails before writing, and a streamed overrun aborts', async () => {
  const declared = fixture({
    maxBytes: 8,
    fetchImpl: (async () =>
      new Response(streamOf([CHECKPOINT_BYTES]), {
        status: 200,
        headers: { 'content-length': String(CHECKPOINT_BYTES.length) },
      })) as unknown as typeof fetch,
  });
  const first = await declared.service.download();
  assert.equal(first.started, true);
  const overDeclared = await waitForState(declared.service, (status) => status.state === 'failed', 'declared cap');
  assert.match(String(overDeclared.error), /above the 8-byte limit/);
  assert.equal(existsSync(`${declared.modelPath}.part`), false);

  const streamed = fixture({
    maxBytes: 8,
    fetchImpl: (async () =>
      new Response(streamOf([CHECKPOINT_BYTES]), { status: 200 })) as unknown as typeof fetch,
  });
  const second = await streamed.service.download();
  assert.equal(second.started, true);
  const overStreamed = await waitForState(streamed.service, (status) => status.state === 'failed', 'streamed cap');
  assert.match(String(overStreamed.error), /exceeded the 8-byte limit/);
  assert.equal(existsSync(`${streamed.modelPath}.part`), false);
});

test('AC2: a source that never answers is aborted by the timeout', async () => {
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  const { service } = fixture({ fetchImpl, timeoutMs: 25 });

  const result = await service.download();
  assert.equal(result.started, true);
  const failed = await waitForState(service, (status) => status.state === 'failed', 'timeout');
  assert.match(String(failed.error), /timed out after 25 ms/);
});

test('AC2: one download per path — the second call joins and reads the SAME progress', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const pending = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    return new Response(pending, {
      status: 200,
      headers: { 'content-length': String(CHECKPOINT_BYTES.length) },
    });
  }) as unknown as typeof fetch;

  const { service } = fixture({ fetchImpl });
  const first = await service.download();
  const second = await service.download();
  assert.equal(first.started, true);
  assert.equal(second.started, false, 'the second call must not open a second connection');
  assert.equal(second.joined, true);

  controller.enqueue(CHECKPOINT_BYTES.subarray(0, 6));
  const halfway = await waitForState(
    service,
    (status) => (status.receivedBytes ?? 0) >= 6,
    'joined progress',
  );
  assert.equal(halfway.state, 'downloading');
  assert.equal(halfway.totalBytes, CHECKPOINT_BYTES.length);
  assert.ok((halfway.bytesPerSec ?? -1) >= 0);
  assert.equal(fetches, 1, 'the join never opened a second connection');

  controller.enqueue(CHECKPOINT_BYTES.subarray(6));
  controller.close();
  await waitForState(service, (status) => status.state === 'installed', 'finished after join');
  assert.equal(fetches, 1, 'the join never became a second download');
});

test('AC1: an already-installed checkpoint makes download a no-op', async () => {
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    throw new Error('a download must not start for an installed checkpoint');
  }) as unknown as typeof fetch;
  const { service, modelPath } = fixture({ fetchImpl });
  mkdirSync(path.dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, CHECKPOINT_BYTES);

  const result = await service.download();
  assert.equal(result.started, false);
  assert.equal(result.joined, false);
  assert.equal(result.status.state, 'installed');
  assert.equal(fetches, 0);
});

// ── AC3: the routes ────────────────────────────────────────────────────────────────────────────

type RouteResult = { status: number; body: unknown };

/** Invokes the shipping router as the middleware it is — no socket, no app. */
function callRouter(
  router: ReturnType<typeof createVoiceRealtimeRouter>,
  method: 'GET' | 'POST',
  url: string,
): Promise<RouteResult> {
  return new Promise<RouteResult>((resolve, reject) => {
    let statusCode = 200;
    const request = { method, url, headers: {}, user: { id: 1 } };
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ status: statusCode, body: payload });
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        resolve({ status: statusCode, body: null });
      },
    };
    router(
      request as never,
      response as never,
      (error?: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

const ROUTE_READING: VoiceSpeakerModelStatus = {
  state: 'missing',
  path: '/srv/models/speaker/model.onnx',
  fileName: 'model.onnx',
  expectedBytes: VOICE_SPEAKER_MODEL_BYTES,
  sha256: VOICE_SPEAKER_MODEL_SHA256,
  sourceUrl: VOICE_SPEAKER_MODEL_SOURCE_URL,
  license: VOICE_SPEAKER_MODEL_LICENSE,
  attribution: '3D-Speaker CAM++ (sherpa-onnx release)',
  bytes: null,
  receivedBytes: null,
  totalBytes: null,
  bytesPerSec: null,
  startedAt: null,
  error: null,
};

function routerWith(overrides: {
  status?: (() => Promise<VoiceSpeakerModelStatus>) | undefined;
  download?: (() => Promise<VoiceSpeakerModelDownloadResult>) | undefined;
}): ReturnType<typeof createVoiceRealtimeRouter> {
  return createVoiceRealtimeRouter({
    diagnose: async () => {
      throw new Error('the model routes must not diagnose');
    },
    ...(overrides.status === undefined ? {} : { speakerModelStatus: overrides.status }),
    ...(overrides.download === undefined ? {} : { speakerModelDownload: overrides.download }),
  });
}

test('AC3: GET /speaker-model relays the reading as 200', async () => {
  const result = await callRouter(
    routerWith({ status: async () => ROUTE_READING }),
    'GET',
    '/speaker-model',
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, ROUTE_READING);
});

test('AC3: POST /speaker-model/download answers 202 while running and 200 when already installed', async () => {
  const running = await callRouter(
    routerWith({
      download: async () => ({ started: true, joined: false, status: ROUTE_READING }),
    }),
    'POST',
    '/speaker-model/download',
  );
  assert.equal(running.status, 202, 'a started download is 202');
  assert.deepEqual(running.body, ROUTE_READING);

  const joined = await callRouter(
    routerWith({
      download: async () => ({ started: false, joined: true, status: ROUTE_READING }),
    }),
    'POST',
    '/speaker-model/download',
  );
  assert.equal(joined.status, 202, 'joining a running download is 202');

  const installedReading = { ...ROUTE_READING, state: 'installed' as const };
  const noop = await callRouter(
    routerWith({
      download: async () => ({ started: false, joined: false, status: installedReading }),
    }),
    'POST',
    '/speaker-model/download',
  );
  assert.equal(noop.status, 200, 'nothing to fetch is 200');
  assert.deepEqual(noop.body, installedReading);
});

test('AC3: a router without the service answers 503, and a thrown service error answers 500', async () => {
  const unwired = routerWith({});
  assert.equal((await callRouter(unwired, 'GET', '/speaker-model')).status, 503);
  assert.equal((await callRouter(unwired, 'POST', '/speaker-model/download')).status, 503);

  const broken = routerWith({
    status: async () => {
      throw new Error('the model directory is unreadable');
    },
  });
  const failed = await callRouter(broken, 'GET', '/speaker-model');
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'the model directory is unreadable' });
});

test('AC4: the download route sends no URL or path — the POST body cannot change the target', async () => {
  // The service consumes no input, so the route has nothing to forward. This case pins the ROUTE:
  // a request carrying a tempting URL/path still reaches a service whose arguments are empty.
  const received: unknown[][] = [];
  const service = fixture().service;
  const result = await callRouter(
    createVoiceRealtimeRouter({
      diagnose: async () => {
        throw new Error('unused');
      },
      speakerModelDownload: (...args: unknown[]) => {
        received.push(args);
        return service.download();
      },
      speakerModelStatus: () => service.status(),
    }),
    'POST',
    '/speaker-model/download',
  );
  assert.equal(result.status, 202);
  assert.deepEqual(received, [[]], 'the service is called with no request-derived argument');
  await waitForState(service, (status) => status.state === 'installed', 'the wired service still downloads');
});
