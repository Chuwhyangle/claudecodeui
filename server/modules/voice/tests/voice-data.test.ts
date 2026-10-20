import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import type { VoiceSettings } from '@/shared/types.js';

import { listProviders, type AsrAdapter } from '../../../../shared/asr/asrRegistry.js';
import { createVoiceDataStore } from '../voice-data.js';
import { createVoiceRouter } from '../voice.routes.js';
import { createVoiceService, createVoiceSettingsService } from '../voice.service.js';

/**
 * D1's user-data store: the local-only recordings, default ON.
 *
 * THE READINGS ARE TAKEN ON REAL BYTES ON A REAL DIRECTORY. Every case drives the SHIPPING service
 * (`createVoiceService`) with the SHIPPING store (`createVoiceDataStore`) pointed at a throwaway
 * directory, so "a transcription wrote a record" is a fact about the filesystem rather than about a
 * private function: the record's own JSON is read back, the audio file beside it is stat'ed, and the
 * modes are read off the files themselves. The store is a separate module from the diagnostic
 * capture (`voice-capture.ts`), and nothing here sets `VOICE_CAPTURE` — that the two coexist without
 * changing each other is the isolation criterion's reading, which lives with the capture tests.
 *
 * THE SERVICE IS DRIVEN DIRECTLY rather than through the router for the write cases, and the ONE
 * route reading (the `DELETE`) goes through a real express app so "the route answers with a count"
 * is a real HTTP answer. `voice.capture` is never wired, so a case that accidentally depended on the
 * diagnostic seam would fail rather than pass quietly.
 *
 * THE CONFIDENCE AXIS NEEDS AN ADAPTER NOBODY SHIPPED. Every recogniser in the registry declares
 * `tokens.confidence: false`, so "a declaring recogniser writes `flagStats`" is unreachable through
 * the shipping declarations alone — the criterion would pass on a registry that could never produce
 * the reading it claims to test. The last case therefore registers a stand-in that declares the
 * capability and answers tokens carrying confidence, drives the SHIPPING service through it, and
 * removes it again; the paired undeclared reading is the shipping openai-compatible recogniser,
 * whose declaration is the reason its record has no `flagStats` at all.
 */

const defaults = {
  baseUrl: 'https://voice.example/v1',
  apiKey: 'server-key',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** A user who has never saved anything: no key, so recording takes the default (ON). */
const EMPTY_SETTINGS: VoiceSettings = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
};

/** A sentinel credential, so a leak into a record's bytes is attributable rather than imagined. */
const SENTINEL_API_KEY = 'sk-sentinel-must-not-be-stored';

/** The one audio buffer every write case transcribes; a small but non-empty body. */
const AUDIO = Buffer.from('RIFF....WAVEfmt ');

/** A temporary parent, removed by the caller when the case ends. */
function makeTempParent(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'voice-data-criterion-'));
}

/** The directory the store uses under a temp parent — resolved but not created until a write. */
function dataDir(parent: string): string {
  return path.join(parent, 'voice-data');
}

/**
 * The one transcription body every case answers with.
 *
 * It carries `tokens`, so the record's own token passthrough is exercised rather than assumed: the
 * service's envelope forwards whatever the recogniser produced, and the store keeps it verbatim.
 */
function transcriptionResponse(): Response {
  return new Response(
    JSON.stringify({
      text: '你好世界',
      tokens: [
        { text: '你好', confidence: 0.91 },
        { text: '世界', confidence: 0.88 },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * The shipping service with the shipping store, driven against one temp parent.
 *
 * `settings` is what `createVoiceService`'s `transcribe` lets the store see, so the recording gate
 * and the capacity ceiling are read from the same document the route would pass.
 */
function makeService(parent: string, directory = dataDir(parent)) {
  const store = createVoiceDataStore({ directory });
  const service = createVoiceService({
    defaults,
    timeoutMs: 1_000,
    fetchBackend: async () => transcriptionResponse(),
    voiceData: store,
  });
  return { service, store, directory };
}

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

const filesWith = (directory: string, extension: string): string[] =>
  readdirSync(directory).filter((name) => name.endsWith(extension)).sort();

/**
 * The bytes of every regular file under the directory, the figure the ceiling bounds.
 *
 * Deliberately NOT `directoryBytes` from `server/shared/fs-bytes.ts`: this is the test's own
 * independent oracle, so a bug in the shipping helper cannot make the ceiling assertion agree
 * with itself.
 */
function regularFileBytes(directory: string): number {
  return readdirSync(directory).reduce((total, name) => {
    const stats = statSync(path.join(directory, name));
    return stats.isFile() ? total + stats.size : total;
  }, 0);
}

test('a default-settings transcription writes one record and its segment audio, 0700/0600', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);

    const result = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, apiKey: SENTINEL_API_KEY },
    });

    assert.equal(result.ok, true, 'the transcription itself must succeed');
    assert.ok(result.ok && typeof result.value.recordId === 'string' && result.value.recordId.length > 0,
      'the response carries the record id a later task writes the final text back with');

    // The directory and both files exist, with the modes D1 promises — read off the files, not the
    // umask the test process happens to run under (the store chmods explicitly).
    assert.equal(statSync(directory).mode & 0o777, 0o700, 'the directory is 0700');
    const records = filesWith(directory, '.json');
    const audio = filesWith(directory, '.wav');
    assert.equal(records.length, 1, 'exactly one record');
    assert.equal(audio.length, 1, 'exactly one segment audio file');
    assert.equal(statSync(path.join(directory, records[0])).mode & 0o777, 0o600, 'the record is 0600');
    assert.equal(statSync(path.join(directory, audio[0])).mode & 0o777, 0o600, 'the audio is 0600');

    // The record is the shape the later tasks read: an id, a timestamp, the provider, and one
    // segment naming the audio file beside it.
    const record = readJson(path.join(directory, records[0]));
    assert.equal(record.recordId, result.ok ? result.value.recordId : null);
    assert.equal(typeof record.ts, 'number');
    assert.equal(typeof record.providerId, 'string');
    assert.ok((record.providerId as string).length > 0);
    const segments = record.segments as Array<Record<string, unknown>>;
    assert.equal(segments.length, 1);
    assert.equal(segments[0].index, 0);
    assert.equal(segments[0].audioFile, audio[0]);
    assert.equal(segments[0].text, '你好世界');
    // Whatever the recogniser produced is what was kept — no second reading, no dropped envelope.
    // The seam's richer `tokens` rides beyond the wire's declared `{ text, recordId }`, so it is
    // read through a narrow cast rather than widened on the shared type for this one test's sake.
    const returnedTokens = result.ok ? ((result.value as { tokens?: unknown }).tokens ?? null) : null;
    assert.deepEqual(segments[0].tokens ?? null, returnedTokens);

    // The reserved keys belong to later tasks and are NOT written here.
    assert.ok(!('finalText' in record), 'finalText is reserved, not written by this task');
    assert.ok(!('labels' in record), 'labels is reserved, not written by this task');
    // `flagStats` is NOT reserved: the shipping recogniser this case selects declares no per-token
    // confidence, so there is nothing to count and the key is left off rather than written empty.
    // (The declaring-recogniser case below is the other half — the same key IS written there.)
    assert.ok(!('flagStats' in record), 'the openai-compatible recogniser declares no confidence');

    // The credential never becomes a record's bytes: the sentinel key was on the settings document
    // and nowhere on disk. (The audio/text are the user's own; the key is not.)
    assert.ok(!readFileSync(path.join(directory, records[0]), 'utf8').includes(SENTINEL_API_KEY));
    assert.ok(!readFileSync(path.join(directory, audio[0]), 'latin1').includes(SENTINEL_API_KEY));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('recording off writes nothing; the same user turning it on writes (paired negative control)', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);

    const off = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, voiceDataRecording: false },
    });
    assert.equal(off.ok, true, 'turning recording off must not fail the transcription');
    assert.equal(off.ok && off.value.recordId, undefined, 'no record id when nothing was kept');
    assert.equal(existsSync(directory), false, 'no directory and no files for an off user');

    // The SAME service and the SAME directory: the only thing that changed is the setting, so the
    // write below is attributable to it rather than to a fresh fixture.
    const on = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, voiceDataRecording: true },
    });
    assert.equal(on.ok, true);
    assert.ok(on.ok && typeof on.value.recordId === 'string', 'the same user with recording on keeps a record');
    assert.equal(filesWith(directory, '.json').length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearVoiceData removes every record and answers the count; a missing directory answers 0', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);
    for (let index = 0; index < 3; index += 1) {
      await service.transcribe({
        audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: `segment-${index + 1}.wav` },
        overrides: {},
        settings: EMPTY_SETTINGS,
      });
    }
    assert.equal(filesWith(directory, '.json').length, 3);

    const cleared = service.clearVoiceData?.();
    assert.deepEqual(cleared, { deleted: 3 }, 'the count is the records, not the files');
    assert.deepEqual(readdirSync(directory), [], 'no record and no audio is left behind');

    // A directory that was never created — a user who turned recording off — clears to zero rather
    // than failing: "nothing here to clear" is a clear that succeeded.
    const never = makeService(parent, path.join(parent, 'never-created'));
    assert.deepEqual(never.service.clearVoiceData?.(), { deleted: 0 });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the capacity ceiling trims the OLDEST records, and the directory ends within the bound', async () => {
  const parent = makeTempParent();
  try {
    const CAP_BYTES = 50 * 1024;
    const { service, directory } = makeService(parent);
    // ~20 KiB of audio per record, so three records (~60 KiB) overrun the 50 KiB ceiling.
    const bigAudio = Buffer.alloc(20 * 1024, 7);

    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      // A few milliseconds apart, so each record's `ts` is distinct and "oldest" is a fact about the
      // records rather than a tie the eviction order would have to break by mtime.
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const result = await service.transcribe({
        audio: { bytes: bigAudio, mimeType: 'audio/wav', fileName: `segment-${index + 1}.wav` },
        overrides: {},
        settings: { ...EMPTY_SETTINGS, voiceDataMaxBytes: CAP_BYTES },
      });
      assert.equal(result.ok, true);
      assert.ok(result.ok && typeof result.value.recordId === 'string');
      ids.push(result.ok ? result.value.recordId : '');
    }

    assert.ok(regularFileBytes(directory) <= CAP_BYTES, 'the directory is within its ceiling');
    const remaining = new Set(filesWith(directory, '.json'));
    // The oldest records are the ones that went; the newest — the one just written — is still there.
    assert.ok(!remaining.has(`${ids[0]}.json`), 'the oldest record was evicted first');
    assert.ok(remaining.has(`${ids[2]}.json`), 'the newest record survives the trim');
    assert.ok(filesWith(directory, '.wav').length < 3, 'audio went with the evicted record');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('DELETE /api/voice/data answers the deleted count over HTTP, and 200/0 for no directory', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);

    await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: EMPTY_SETTINGS,
    });
    assert.equal(filesWith(directory, '.json').length, 1);

    // The settings service is the shipping one over a tiny in-memory store: the DELETE route does
    // not read settings, but the router needs a real one and a fake would not prove the route.
    const settingsStore = {
      getSettings: () => EMPTY_SETTINGS,
      saveSettings: () => undefined,
    };
    const app = express();
    app.use(createVoiceRouter({
      voiceService: service,
      voiceSettingsService: createVoiceSettingsService(settingsStore),
      lexiconService: {
        observeSentText: () => undefined,
        importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
        list: () => [],
        clear: () => undefined,
      },
      parseAudioUpload: (_request, _response, next) => next(),
      parseRawAudioUpload: (_request, _response, next) => next(),
    }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = (address as { port: number }).port;

    const call = (): Promise<{ status: number; body: unknown }> => new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/data', method: 'DELETE' }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        });
      });
      request.on('error', reject);
      request.end();
    });

    try {
      const first = await call();
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, { deleted: 1 });
      assert.deepEqual(readdirSync(directory), []);

      // The directory is now gone; a second clear — the "nothing to clear" case — is still a 200
      // with a zero count rather than an error.
      const second = await call();
      assert.equal(second.status, 200);
      assert.deepEqual(second.body, { deleted: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a confidence-declaring recogniser writes flagStats; the shipping one does not (paired)', async () => {
  const parent = makeTempParent();
  // The registry hands out its own module-private array (typed `readonly`, mutable at runtime);
  // pushing here is what makes a declaration the shipped set does not contain testable. The pop in
  // `finally` is the leak guard: node:test runs this file's cases sequentially in one process, so no
  // other case can observe the stand-in, and none is left behind for the next one either.
  const registry = listProviders() as AsrAdapter[];
  const FAKE_ID = 'criterion-confidence-fake';
  const declaring: AsrAdapter = {
    id: FAKE_ID,
    capabilities: {
      acceptsMime: ['audio/wav'],
      maxInlineRequestBytes: 25 * 1024 * 1024,
      oversize: 'reject',
      honors: { prompt: false, language: false, context: false },
      billing: 'audio-seconds',
      pauseCues: 'neutral',
      style: 'verbatim',
      oneShot: true,
      transport: 'direct',
      // The one declaration the shipped registry has nowhere: per-token confidence.
      tokens: { confidence: true, timestamps: false },
      locality: 'local-server',
    },
    transcribe: async () => ({
      ok: true,
      text: '你好 API',
      style: 'verbatim',
      transformations: [],
      providerId: FAKE_ID,
      // One high token and one low, adjacent: the low one is the Latin half of the text.
      tokens: [
        { text: '你好', confidence: 0.91 },
        { text: '▁API', confidence: 0.42 },
      ],
    }),
  };

  registry.push(declaring);
  try {
    const { service, directory } = makeService(parent);

    const declared = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, providerId: FAKE_ID },
    });
    assert.equal(declared.ok, true, 'a confidence-declaring recogniser still transcribes');
    assert.ok(declared.ok && typeof declared.value.recordId === 'string', 'and still writes a record');

    const records = filesWith(directory, '.json');
    assert.equal(records.length, 1);
    const flagStats = readJson(path.join(directory, records[0])).flagStats as
      | { chars: number; byTheta: Array<Record<string, number>> }
      | undefined;
    assert.ok(flagStats, 'the record carries flagStats for a confidence-declaring recogniser');
    assert.equal(flagStats.chars, '你好 API'.length);
    assert.equal(flagStats.byTheta.length, 4, 'one row per default threshold');

    // Known answer, at the integration level: `▁API` is the only token below every threshold, it
    // slices to ` API` (Latin), and the text is six characters — so one merged Latin mark and a rate
    // of 100/6 at each of the four thresholds. A count that could never be anything but zero would
    // make "flagStats exists" vacuous, so the values are read out and not just the key.
    assert.deepEqual(flagStats.byTheta.map((row) => row.theta), [0.5, 0.6, 0.7, 0.8]);
    assert.deepEqual(flagStats.byTheta.map((row) => row.flags), [1, 1, 1, 1]);
    assert.deepEqual(flagStats.byTheta.map((row) => row.flagsLatin), [1, 1, 1, 1]);
    assert.equal(flagStats.byTheta[0].flagsPer100Chars, 100 / 6);

    // The PAIRED undeclared reading: the SAME service and directory, with the settings naming no
    // provider so the first registered recogniser — the shipping openai-compatible one, which
    // declares no confidence — is selected. Its write path is identical, and it produces no key.
    const undeclared = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-2.wav' },
      overrides: {},
      settings: EMPTY_SETTINGS,
    });
    assert.equal(undeclared.ok, true, 'the undeclared recogniser transcribes too');
    const second = filesWith(directory, '.json').filter((name) => name !== records[0]);
    assert.equal(second.length, 1);
    assert.ok(
      !('flagStats' in readJson(path.join(directory, second[0]))),
      'a recogniser that declared no confidence leaves the key off',
    );
  } finally {
    assert.equal(registry.pop(), declaring, 'the stand-in is removed so it cannot leak to another case');
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a send writes finalText and labels onto the record the transcription wrote', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);

    const result = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, apiKey: SENTINEL_API_KEY },
    });
    assert.ok(result.ok && typeof result.value.recordId === 'string');
    const recordId = result.value.recordId;
    const recordPath = path.join(directory, `${recordId}.json`);
    const before = readJson(recordPath);

    const labels = [{ segmentIndex: 0, heard: 'key', final: 'quay', op: 'replace' }];
    const write = service.labelVoiceData?.({ recordId, finalText: 'send the quay', labels });
    assert.equal(write?.ok, true, 'the shipping service implements the write-back');

    const after = readJson(recordPath);
    assert.equal(after.finalText, 'send the quay');
    assert.deepEqual(after.labels, labels);
    // The pair is the WHOLE point of the record, so both halves are read back: what the user sent,
    // and what it was heard as. A write that overwrote `segments` would lose the second half.
    assert.deepEqual(after.segments, before.segments, 'the recognised text stays beside the sent one');
    assert.equal(after.ts, before.ts, 'a correction does not make an old recording new');

    // The sentinel credential is nowhere in the rewritten bytes. Re-read rather than assumed,
    // because this is the one path that rewrites a document the settings could have leaked into.
    assert.ok(!readFileSync(recordPath, 'utf8').includes(SENTINEL_API_KEY));
    // The audio the labels are about is untouched, and the document kept its mode through the
    // rewrite (the write is a fresh inode under this process's umask).
    assert.equal(filesWith(directory, '.wav').length, 1);
    assert.equal(statSync(path.join(directory, `${recordId}-0.wav`)).mode & 0o777, 0o600);
    assert.equal(statSync(recordPath).mode & 0o777, 0o600);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('labelling a record that is not there is a 404, and creates nothing', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);
    await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: EMPTY_SETTINGS,
    });

    const before = readdirSync(directory).sort();
    const result = service.labelVoiceData?.({ recordId: 'no-such-record', finalText: 'x', labels: [] });
    assert.ok(result !== undefined && !result.ok);
    assert.equal(result.status, 404);
    // A MISS MUST NOT MANUFACTURE A RECORD. Writing one here would accumulate audio-less documents
    // for every edit to a listen whose audio the ceiling already evicted.
    assert.deepEqual(readdirSync(directory).sort(), before);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a service with no store answers the same 404 rather than failing', () => {
  // The optional member's own contract: a deployment (or a leaf double) that wired no store has no
  // records to label, which is the answer a vanished record gets. A throw here would make the
  // route's fallback unreachable rather than exercised.
  const service = createVoiceService({
    defaults,
    timeoutMs: 1_000,
    fetchBackend: async () => transcriptionResponse(),
  });

  const result = service.labelVoiceData?.({ recordId: 'anything', finalText: 'x', labels: [] });
  assert.ok(result !== undefined && !result.ok);
  assert.equal(result.status, 404);
});

test('PATCH /api/voice/data/:recordId writes, 404s an unknown id, and 400s a broken body', async () => {
  const parent = makeTempParent();
  try {
    const { service, directory } = makeService(parent);
    const transcribed = await service.transcribe({
      audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'segment-1.wav' },
      overrides: {},
      settings: { ...EMPTY_SETTINGS, apiKey: SENTINEL_API_KEY },
    });
    // The id is the seam's optional field, so it is asserted rather than assumed: a case that
    // PATCHes "the record the listen wrote" has to have one, or every assertion below would be
    // reading an undefined against an undefined.
    assert.ok(transcribed.ok && typeof transcribed.value.recordId === 'string');
    const recordId = transcribed.value.recordId;

    const app = express();
    // The label body is JSON, so the app needs the parser the real composition root mounts. The
    // DELETE case above does not, which is why this one does not share its app.
    app.use(express.json());
    app.use(createVoiceRouter({
      voiceService: service,
      voiceSettingsService: createVoiceSettingsService({
        getSettings: () => EMPTY_SETTINGS,
        saveSettings: () => undefined,
      }),
      lexiconService: {
        observeSentText: () => undefined,
        importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
        list: () => [],
        clear: () => undefined,
      },
      parseAudioUpload: (_request, _response, next) => next(),
      parseRawAudioUpload: (_request, _response, next) => next(),
    }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = (address as { port: number }).port;

    const patch = (id: string, body: unknown): Promise<{ status: number; body: unknown }> => {
      const payload = JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const request = http.request(
          {
            host: '127.0.0.1',
            port,
            path: `/data/${encodeURIComponent(id)}`,
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
            });
          },
        );
        request.on('error', reject);
        request.end(payload);
      });
    };

    try {
      const labels = [{ segmentIndex: 0, heard: 'key', final: 'quay', op: 'replace' }];
      const written = await patch(recordId, { finalText: 'send the quay', labels });
      assert.equal(written.status, 200);
      assert.deepEqual(written.body, { recordId });

      const record = readJson(path.join(directory, `${recordId}.json`));
      assert.equal(record.finalText, 'send the quay');
      assert.deepEqual(record.labels, labels);
      assert.ok(!readFileSync(path.join(directory, `${recordId}.json`), 'utf8').includes(SENTINEL_API_KEY));

      const missing = await patch('no-such-record', { finalText: 'x', labels: [] });
      assert.equal(missing.status, 404, 'an id no record carries is a 404, not a create');

      // The two malformed bodies: no `finalText` at all, and an array whose entry is not a label.
      // Both are refusals rather than silent partial writes, because what lands on disk is what the
      // route let through.
      assert.equal((await patch(recordId, { labels: [] })).status, 400);
      assert.equal((await patch(recordId, { finalText: 'x', labels: [{ heard: 'a' }] })).status, 400);
      // And neither refusal touched the record it was aimed at.
      assert.equal(readJson(path.join(directory, `${recordId}.json`)).finalText, 'send the quay');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the store module carries no transport import: nothing here leaves the machine', () => {
  // Read the SHIPPING module's own source and require the transport vocabulary to be absent. This
  // is the "does not leave this machine" half of D1 as a reading rather than a promise, and it is
  // scoped to the one file so it cannot match this test's own text.
  const source = readFileSync(new URL('../voice-data.ts', import.meta.url), 'utf8');
  const forbidden = /fetch\(|https?\.request|axios|undici/;
  assert.equal(forbidden.test(source), false, 'voice-data.ts must not name a transport');
  // The positive control: the same predicate DOES match a file that does, so the reading is not
  // vacuous on a pattern that could never match anything.
  assert.equal(forbidden.test("await fetch('https://example.test')"), true);
  // A second control: the module's own imports are the node builtins it is allowed to have.
  assert.ok(source.includes("from 'node:fs'"));
  assert.ok(source.includes("from 'node:crypto'"));
});
