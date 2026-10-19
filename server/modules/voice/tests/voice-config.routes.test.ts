import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

import type { VoiceService } from '@/shared/types.js';

/**
 * The Voice settings HTTP surface: `GET`/`PUT /api/voice/config`.
 *
 * These endpoints are the reason the settings could move off localStorage, so
 * the tests here are about the contract a browser depends on — who may read and
 * write, what a save reads back as, what is refused — plus the one thing that
 * must never happen: the API key ending up in the preferences document that the
 * server broadcasts on every start-up.
 */

const TEST_JWT_SECRET = 'voice-config-routes-test-secret';

// `auth.middleware.ts` resolves `JWT_SECRET` at module-load time and falls back
// to `appConfigDb.getOrCreateJwtSecret()`, which would read and create the
// developer's real `~/.cloudcli/auth.db`; `shared/utils.ts` likewise freezes
// `IS_PLATFORM` (which would replace token checks with "the first database
// user"). Both are evaluated on first import and static imports are hoisted
// above this code, so the environment is set first and the aliased modules come
// in dynamically.
process.env.JWT_SECRET = TEST_JWT_SECRET;
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, voiceSettingsDb } = await import('@/modules/database/index.js');
const { createVoiceRouter } = await import('@/modules/voice/voice.routes.js');
const { createVoiceSettingsService } = await import('@/modules/voice/voice.service.js');
const { userRoutes } = await import('@/modules/user/index.js');
const { authenticateToken } = await import('@/modules/auth/index.js');
const { AppError } = await import('@/shared/utils.js');

const USER_ID = 1;

// The document is exhaustive over `VoiceSettings`, so a field added to the shape has to be added
// here as well: the assertions below compare whole documents with `deepEqual`, and a literal that
// omitted a field would let the comparison pass while the response carried a key nobody named.
const SAMPLE_SETTINGS = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'sk-sentinel-voice-backend-key',
  sttModel: 'whisper-large-v3',
  ttsModel: 'playai-tts',
  ttsVoice: 'Arista-PlayAI',
  ttsFormat: 'mp3',
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
  liveVoiceDashscopeApiKey: '',
};

const EMPTY_SETTINGS = {
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
  liveVoiceDashscopeApiKey: '',
};

/** Distinct from `SAMPLE_SETTINGS.apiKey`, so a leak from either path is attributable. */
const PREFERENCE_SENTINEL_KEY = 'sk-sentinel-must-not-reach-preferences';

/**
 * The value of the credential the SERVER holds for a proxy-only provider.
 *
 * Distinct from both sentinels above, because the three travel different routes and a failure has to
 * name which one leaked: this one is stored in the clear, presented upstream, and masked on every
 * readback — so a response carrying it, or carrying the mask where it should carry the empty string,
 * says which of those three faces went wrong.
 */
const DASHSCOPE_SENTINEL_KEY = 'sk-dashscope-must-not-be-returned';

/**
 * The settings endpoints must never consult the transcription service — that is
 * the proxy path this whole feature exists to keep out of. A stub that throws
 * makes an accidental call a failing test rather than a silent pass.
 */
const unusedVoiceService: VoiceService = {
  getHealth: () => {
    throw new Error('the settings endpoints must not consult the transcription service');
  },
  transcribe: async () => {
    throw new Error('the settings endpoints must not transcribe');
  },
  synthesizeSpeech: async () => {
    throw new Error('the settings endpoints must not synthesize');
  },
  // The raw-corpus half of the service, throwing for the same reason the two above do: a settings
  // request that reached either would be a routing mistake, not a call this surface should serve.
  captureRaw: () => {
    throw new Error('the settings endpoints must not capture raw audio');
  },
  captureState: () => {
    throw new Error('the settings endpoints must not read the raw capture state');
  },
};

type ServerContext = {
  baseUrl: string;
  token: string;
};

/**
 * Mints the artifact the login endpoint hands the browser: an HS256 JWT signed
 * with the secret `auth.middleware.ts` was loaded with.
 *
 * Built here rather than with the `jsonwebtoken` package, which ships no type
 * declarations — the middleware that consumes it imports it under `@ts-nocheck`,
 * and a test file is not the place to start doing the same. If the encoding did
 * not match what `jwt.verify` accepts, every authenticated request below would
 * read as a 401 rather than as a pass.
 */
function signToken(payload: { userId: number; username: string }): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, iat: issuedAt, exp: issuedAt + 3600 });
  const signature = createHmac('sha256', TEST_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function addUser(id: number, username: string): string {
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(id, username, 'hash');
  return signToken({ userId: id, username });
}

async function withServer(run: (context: ServerContext) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'voice-config-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const token = addUser(USER_ID, 'tester');

  const app = express();
  app.use(express.json());
  // Mounted exactly as `server/index.ts` mounts them, auth middleware included,
  // so the 401 assertions below come from the production middleware.
  app.use('/api/voice', authenticateToken, createVoiceRouter({
    voiceService: unusedVoiceService,
    voiceSettingsService: createVoiceSettingsService(voiceSettingsDb),
    // The lexicon endpoints are not this file's subject; an inert service names
    // the dependency without giving it a store or a history source.
    lexiconService: {
      observeSentText: () => {},
      importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
      list: () => [],
      clear: () => {},
    },
    // Only the two settings endpoints are under test; the build-in upload parser
    // is never reached, so a pass-through stub keeps this file off multer.
    parseAudioUpload: (_request, _response, next) => next(),
    // Likewise for the raw-corpus endpoint's own parser: this surface serves neither upload route.
    parseRawAudioUpload: (_request, _response, next) => next(),
  }));
  app.use('/api/user', authenticateToken, userRoutes);
  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    // Mirrors the production handler in `server/index.ts`.
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    response.status(500).json({ success: false });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    await run({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Sends a request as the given token. `token: null` sends no Authorization
 * header at all, which is what an unauthenticated browser does.
 */
function send(
  context: ServerContext,
  method: string,
  route: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<globalThis.Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const token = options.token === undefined ? context.token : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;

  return fetch(`${context.baseUrl}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/**
 * The JSON body as the loose record the endpoints return.
 *
 * `fetch`'s own `json()` is typed `unknown`, and every assertion here is about
 * named fields of what came back.
 */
async function readJson(response: globalThis.Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Every table whose rows contain `value`.
 *
 * Used to state "the key is in `user_voice_settings` and nowhere else" as an
 * assertion rather than as a comment: a save that also wrote the key into
 * `user_preferences` — the document the server ships to the browser on every
 * start-up — shows up here as a second table name.
 */
function tablesContaining(value: string): string[] {
  const connection = getConnection();
  const tables = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];

  const matches: string[] = [];
  for (const { name } of tables) {
    if (name.startsWith('sqlite_')) continue;

    const columns = connection.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    const condition = columns.map((column) => `CAST("${column.name}" AS TEXT) LIKE ?`).join(' OR ');
    if (!condition) continue;

    const row = connection
      .prepare(`SELECT COUNT(*) AS count FROM "${name}" WHERE ${condition}`)
      .get(...columns.map(() => `%${value}%`)) as { count: number };
    if (row.count > 0) matches.push(name);
  }
  return matches;
}

test('without a token neither reading nor writing the settings is allowed', async () => {
  await withServer(async (context) => {
    const anonymousRead = await send(context, 'GET', '/api/voice/config', { token: null });
    assert.equal(anonymousRead.status, 401);

    const anonymousWrite = await send(context, 'PUT', '/api/voice/config', {
      body: SAMPLE_SETTINGS,
      token: null,
    });
    assert.equal(anonymousWrite.status, 401);

    const forgedToken = await send(context, 'GET', '/api/voice/config', { token: 'not.a.jwt' });
    assert.equal(forgedToken.status, 401);

    // The rejected write must not have stored anything: a 401 that still saved
    // would leave the next authenticated read looking like a successful save.
    const read = await send(context, 'GET', '/api/voice/config');
    assert.equal(read.status, 200);
    assert.deepEqual(await readJson(read), EMPTY_SETTINGS);
  });
});

test('a saved configuration reads back field for field', async () => {
  await withServer(async (context) => {
    const save = await send(context, 'PUT', '/api/voice/config', { body: SAMPLE_SETTINGS });
    assert.equal(save.status, 200);
    assert.deepEqual(await readJson(save), SAMPLE_SETTINGS);

    const read = await send(context, 'GET', '/api/voice/config');
    assert.equal(read.status, 200);
    assert.deepEqual(await readJson(read), SAMPLE_SETTINGS);

    // An empty string is the explicit "clear this field", and it is written as a
    // whole document, so the fields the user did not touch keep their values.
    const cleared = await send(context, 'PUT', '/api/voice/config', {
      body: { ...SAMPLE_SETTINGS, apiKey: '', ttsFormat: '' },
    });
    assert.equal(cleared.status, 200);

    const afterClearing = await send(context, 'GET', '/api/voice/config');
    assert.deepEqual(await readJson(afterClearing), { ...SAMPLE_SETTINGS, apiKey: '', ttsFormat: '' });
  });
});

test('a user who never saved anything reads back all-empty defaults', async () => {
  await withServer(async (context) => {
    const read = await send(context, 'GET', '/api/voice/config');
    assert.equal(read.status, 200);
    assert.deepEqual(await readJson(read), EMPTY_SETTINGS);

    // Settings belong to the user, not to the installation.
    await send(context, 'PUT', '/api/voice/config', { body: SAMPLE_SETTINGS });

    const secondToken = addUser(2, 'someone-else');
    const secondRead = await send(context, 'GET', '/api/voice/config', { token: secondToken });
    assert.equal(secondRead.status, 200);
    assert.deepEqual(await readJson(secondRead), EMPTY_SETTINGS);

    const firstRead = await send(context, 'GET', '/api/voice/config');
    assert.deepEqual(await readJson(firstRead), SAMPLE_SETTINGS);
  });
});

test('an unusable base URL or an over-long field is refused without touching the stored settings', async () => {
  await withServer(async (context) => {
    assert.equal(
      (await send(context, 'PUT', '/api/voice/config', { body: SAMPLE_SETTINGS })).status,
      200,
    );

    const rejected: { why: string; body: Record<string, unknown> | unknown[] }[] = [
      { why: 'not a URL at all', body: { ...SAMPLE_SETTINGS, baseUrl: 'api.groq.com/openai/v1' } },
      { why: 'a scheme the browser would not fetch over HTTP', body: { ...SAMPLE_SETTINGS, baseUrl: 'ftp://example.com/v1' } },
      { why: 'a javascript: URL', body: { ...SAMPLE_SETTINGS, baseUrl: 'javascript:alert(1)' } },
      { why: 'protocol-relative', body: { ...SAMPLE_SETTINGS, baseUrl: '//example.com/v1' } },
      {
        why: 'the cloud metadata address',
        body: { ...SAMPLE_SETTINGS, baseUrl: 'http://169.254.169.254/latest/meta-data' },
      },
      {
        why: 'a base URL past the stored length',
        body: { ...SAMPLE_SETTINGS, baseUrl: `https://example.com/${'a'.repeat(2048)}` },
      },
      {
        why: 'an API key past the stored length',
        body: { ...SAMPLE_SETTINGS, apiKey: `sk-${'a'.repeat(4096)}` },
      },
      { why: 'a model name past the stored length', body: { ...SAMPLE_SETTINGS, sttModel: 'a'.repeat(257) } },
      { why: 'a voice name past the stored length', body: { ...SAMPLE_SETTINGS, ttsVoice: 'a'.repeat(257) } },
      { why: 'a format past the stored length', body: { ...SAMPLE_SETTINGS, ttsFormat: 'a'.repeat(65) } },
      { why: 'a non-string field', body: { ...SAMPLE_SETTINGS, apiKey: 1234 } },
      // An array is the one non-object JSON body `express.json` will hand to a
      // handler rather than reject itself.
      { why: 'a settings document that is not an object', body: [SAMPLE_SETTINGS] },
    ];

    for (const { why, body } of rejected) {
      const response = await send(context, 'PUT', '/api/voice/config', { body });
      assert.equal(response.status, 400, `expected 400 for ${why}`);
    }

    // A refused save must not be a partial save.
    const read = await send(context, 'GET', '/api/voice/config');
    assert.deepEqual(await readJson(read), SAMPLE_SETTINGS);

    // The check is about the scheme and the address, not about reachability: a
    // backend on the user's own machine is a supported configuration.
    const local = await send(context, 'PUT', '/api/voice/config', {
      body: { ...SAMPLE_SETTINGS, baseUrl: 'http://127.0.0.1:8000/v1' },
    });
    assert.equal(local.status, 200);
    assert.equal(
      (await readJson(await send(context, 'GET', '/api/voice/config'))).baseUrl,
      'http://127.0.0.1:8000/v1',
    );
  });
});

test('saving an API key leaves the user-preferences response free of it', async () => {
  await withServer(async (context) => {
    const save = await send(context, 'PUT', '/api/voice/config', {
      body: { ...SAMPLE_SETTINGS, apiKey: PREFERENCE_SENTINEL_KEY },
    });
    assert.equal(save.status, 200);

    // Control: the key really did reach storage, so "not in the preferences
    // response" below cannot pass because the save was a no-op.
    const stored = await send(context, 'GET', '/api/voice/config');
    assert.equal((await readJson(stored)).apiKey, PREFERENCE_SENTINEL_KEY);

    // The preferences document is handed to the browser whole on every
    // start-up, so the key must not be anywhere in it.
    const preferences = await send(context, 'GET', '/api/user/preferences');
    assert.equal(preferences.status, 200);
    const preferencesText = await preferences.text();
    assert.ok(
      !preferencesText.includes(PREFERENCE_SENTINEL_KEY),
      'the preferences response must not carry the voice API key',
    );

    // The same statement at the storage layer: the key is in the voice settings
    // table and in no other table.
    assert.deepEqual(tablesContaining(PREFERENCE_SENTINEL_KEY), ['user_voice_settings']);
  });
});

// ── the readback face, when the credential is the SERVER's to present ─────────────────────────

/**
 * The marker a server-held credential reads back as.
 *
 * Spelled out rather than imported, because it is the wire's value and not an implementation
 * detail: a client compares this string to decide "something is stored here", so a criterion that
 * took the constant from the module it is checking would still pass if the value changed to the key
 * itself. (The marker carries no character of any value — that is what makes "the response does not
 * contain the key" structural — so naming it here discloses nothing.)
 */
const CREDENTIAL_MASK = '••••••••';

/** A legal DashScope workspace address: the shape that provider's own rule accepts. */
const DASHSCOPE_ENDPOINT = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com';

test('a server-held credential is masked on the readback while the browser-held key is not', async () => {
  await withServer(async (context) => {
    const stored = {
      ...SAMPLE_SETTINGS,
      dashscopeEndpoint: DASHSCOPE_ENDPOINT,
      dashscopeApiKey: DASHSCOPE_SENTINEL_KEY,
      dashscopeModel: 'qwen3.8-omni-flash',
    };

    const save = await send(context, 'PUT', '/api/voice/config', { body: stored });
    assert.equal(save.status, 200);
    const saved = await readJson(save);

    // The distinguishing pair, on ONE response: the credential the server presents upstream comes
    // back as a mask, and the key the browser keeps for its own direct path comes back verbatim.
    // A blanket "mask every key-shaped field" would fail the second assertion, and a missing mask
    // would fail the first — so the reading cannot pass by masking everything or nothing.
    assert.equal(saved.dashscopeApiKey, CREDENTIAL_MASK);
    assert.notEqual(saved.dashscopeApiKey, DASHSCOPE_SENTINEL_KEY);
    assert.equal(saved.apiKey, SAMPLE_SETTINGS.apiKey, 'the browser-held key is not the server\'s to hide');

    // Everything that is not a credential travels verbatim, address and model included: masking is
    // about the secret, not about the provider's fields.
    assert.equal(saved.dashscopeEndpoint, DASHSCOPE_ENDPOINT);
    assert.equal(saved.dashscopeModel, 'qwen3.8-omni-flash');

    const read = await send(context, 'GET', '/api/voice/config');
    assert.equal(read.status, 200);
    const reread = await readJson(read);
    assert.equal(reread.dashscopeApiKey, CREDENTIAL_MASK);
    assert.equal(reread.dashscopeEndpoint, DASHSCOPE_ENDPOINT);

    // The mask is a READBACK face and not a filter on the way in: the storage row holds the value
    // the user typed, which is what the transcription path presents upstream.
    const row = getConnection()
      .prepare('SELECT settings_json FROM user_voice_settings WHERE user_id = ?')
      .get(USER_ID) as { settings_json: string } | undefined;
    assert.ok(row, 'the save must have written the user\'s row');
    assert.equal(
      (JSON.parse(row.settings_json) as Record<string, unknown>).dashscopeApiKey,
      DASHSCOPE_SENTINEL_KEY,
      'storage keeps the credential in the clear; only the readback masks it',
    );

    // A user who never filled the field reads back the empty string rather than a mask: "not
    // filled" must stay distinguishable from "filled and hidden", or the settings tab could never
    // clear it.
    const cleared = await send(context, 'PUT', '/api/voice/config', {
      body: { ...stored, dashscopeApiKey: '' },
    });
    assert.equal(cleared.status, 200);
    assert.equal((await readJson(cleared)).dashscopeApiKey, '');
  });
});

